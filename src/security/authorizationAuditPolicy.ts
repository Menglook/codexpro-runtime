import type { CodexProConfig } from "../config.js";
import type { ToolContractMetadataV1 } from "../tools/toolContract.js";
import {
  appendAuthorizationAuditEntry,
  createAuthorizationAuditEntry,
  type AuthorizationAuditOutcome,
  type AuthorizationAuditPhase
} from "./authorizationAuditStore.js";
import type { AuthorizationPayloadBindingV1 } from "./authorizationIntegrity.js";
import type { MonotonicPermissionDecision } from "./permissionDecision.js";
import type { UnifiedRiskDecision } from "./riskGate.js";

export type AuthorizationAuditDeliveryStatus = "skipped" | "queued" | "persisted" | "degraded";

export interface AuthorizationAuditPersistencePolicyV1 {
  version: 1;
  enabled: boolean;
  fail_closed: boolean;
  reason_code: string;
}

export interface AuthorizationAuditPersistenceReceiptV1 {
  version: 1;
  correlation_id: string;
  phase: AuthorizationAuditPhase;
  status: AuthorizationAuditDeliveryStatus;
  fail_closed: boolean;
  reason_code: string;
  error_code: string | null;
}

export interface AuthorizationAuditPersistenceInput {
  phase: AuthorizationAuditPhase;
  correlationId: string;
  taskId?: string;
  tool: string;
  risk: UnifiedRiskDecision;
  binding: AuthorizationPayloadBindingV1;
  permission: MonotonicPermissionDecision;
  outcome: AuthorizationAuditOutcome;
  durationMs?: number;
}

export type AuthorizationAuditWriter = (
  config: Pick<CodexProConfig, "defaultRoot" | "contextDir">,
  entry: ReturnType<typeof createAuthorizationAuditEntry>
) => Promise<string>;

const deliveryReceipts = new Map<string, AuthorizationAuditPersistenceReceiptV1>();

function receiptKey(correlationId: string, phase: AuthorizationAuditPhase): string {
  return `${correlationId}:${phase}`;
}

function strictAuditMode(): boolean {
  return String(process.env.CODEXPRO_AUTHORIZATION_AUDIT_MODE ?? "").trim().toLowerCase() === "strict";
}

function hasFailClosedSideEffect(risk: UnifiedRiskDecision): boolean {
  return risk.side_effects.some((effect) =>
    effect.reversibility === "irreversible"
    || effect.scope === "production"
    || effect.scope === "business_critical"
    || [
      "git_remote_update",
      "database_write",
      "external_write",
      "deployment",
      "business_critical",
      "destructive"
    ].includes(effect.action)
  );
}

export function authorizationAuditPersistencePolicy(
  contract: ToolContractMetadataV1,
  risk: UnifiedRiskDecision
): AuthorizationAuditPersistencePolicyV1 {
  if (risk.level === "L0") {
    return { version: 1, enabled: false, fail_closed: false, reason_code: "audit_not_required_for_l0" };
  }
  if (strictAuditMode()) {
    return { version: 1, enabled: true, fail_closed: true, reason_code: "explicit_strict_audit_mode" };
  }
  const explicitHighImpactTool = ["git_finalize", "git_push", "git_push_only"].includes(contract.tool_name);
  const failClosed = risk.level === "L3"
    || risk.execution_mode === "high_risk_delivery"
    || contract.side_effect_level === "network_write"
    || contract.side_effect_level === "configuration"
    || explicitHighImpactTool
    || hasFailClosedSideEffect(risk);
  return {
    version: 1,
    enabled: true,
    fail_closed: failClosed,
    reason_code: failClosed ? "high_impact_audit_required" : "ordinary_local_audit_async"
  };
}

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return code.trim() || "authorization_audit_write_failed";
}

function setReceipt(receipt: AuthorizationAuditPersistenceReceiptV1): AuthorizationAuditPersistenceReceiptV1 {
  deliveryReceipts.set(receiptKey(receipt.correlation_id, receipt.phase), receipt);
  return receipt;
}

export async function persistAuthorizationAuditWithPolicy(
  config: Pick<CodexProConfig, "defaultRoot" | "contextDir">,
  input: AuthorizationAuditPersistenceInput,
  policy: AuthorizationAuditPersistencePolicyV1,
  writer: AuthorizationAuditWriter = appendAuthorizationAuditEntry
): Promise<AuthorizationAuditPersistenceReceiptV1> {
  if (!policy.enabled) {
    return setReceipt({
      version: 1,
      correlation_id: input.correlationId,
      phase: input.phase,
      status: "skipped",
      fail_closed: false,
      reason_code: policy.reason_code,
      error_code: null
    });
  }
  const entry = createAuthorizationAuditEntry(input);
  if (policy.fail_closed) {
    try {
      await writer(config, entry);
      return setReceipt({
        version: 1,
        correlation_id: input.correlationId,
        phase: input.phase,
        status: "persisted",
        fail_closed: true,
        reason_code: policy.reason_code,
        error_code: null
      });
    } catch (error) {
      const receipt = setReceipt({
        version: 1,
        correlation_id: input.correlationId,
        phase: input.phase,
        status: "degraded",
        fail_closed: true,
        reason_code: policy.reason_code,
        error_code: errorCode(error)
      });
      throw Object.assign(new Error(
        `Authorization audit persistence failed before ${input.tool} execution (${receipt.error_code}).`
      ), { code: receipt.error_code });
    }
  }

  const receipt = setReceipt({
    version: 1,
    correlation_id: input.correlationId,
    phase: input.phase,
    status: "queued",
    fail_closed: false,
    reason_code: policy.reason_code,
    error_code: null
  });
  void writer(config, entry).then(
    () => {
      receipt.status = "persisted";
      receipt.error_code = null;
      setReceipt(receipt);
    },
    (error) => {
      receipt.status = "degraded";
      receipt.error_code = errorCode(error);
      setReceipt(receipt);
    }
  );
  return receipt;
}

export function authorizationAuditDeliveryReceipts(correlationId: string): AuthorizationAuditPersistenceReceiptV1[] {
  return [...deliveryReceipts.values()]
    .filter((receipt) => receipt.correlation_id === correlationId)
    .map((receipt) => ({ ...receipt }));
}

export async function waitForAuthorizationAuditDelivery(
  correlationId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<AuthorizationAuditPersistenceReceiptV1[]> {
  const timeoutMs = Math.max(10, options.timeoutMs ?? 2_000);
  const pollMs = Math.max(5, options.pollMs ?? 10);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const receipts = authorizationAuditDeliveryReceipts(correlationId);
    if (receipts.length > 0 && receipts.every((receipt) => receipt.status !== "queued")) return receipts;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return authorizationAuditDeliveryReceipts(correlationId);
}

export function clearAuthorizationAuditDeliveryReceipts(): void {
  deliveryReceipts.clear();
}
