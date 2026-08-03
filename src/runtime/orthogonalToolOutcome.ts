export const TOOL_SECURITY_STATUSES = ["allowed", "confirmation_required", "denied", "unknown"] as const;
export type ToolSecurityStatus = typeof TOOL_SECURITY_STATUSES[number];

export const TOOL_RESOURCE_STATUSES = [
  "not_required", "admitted", "waiting_resources", "resource_wait_timeout", "lease_lost", "released", "unknown"
] as const;
export type ToolResourceStatus = typeof TOOL_RESOURCE_STATUSES[number];

export const TOOL_EXECUTION_STATUSES = ["not_started", "queued", "running", "completed", "failed", "cancelled"] as const;
export type ToolExecutionStatus = typeof TOOL_EXECUTION_STATUSES[number];

export const TOOL_RECOVERY_STATUSES = ["not_required", "retryable", "recovering", "recovery_required", "not_recoverable"] as const;
export type ToolRecoveryStatus = typeof TOOL_RECOVERY_STATUSES[number];

export const TOOL_VALIDATION_STATUSES = ["not_requested", "pending", "passed", "failed", "incomplete", "skipped"] as const;
export type ToolValidationStatus = typeof TOOL_VALIDATION_STATUSES[number];

export const TOOL_DELIVERY_STATUSES = [
  "not_requested", "not_ready", "ready", "committed", "push_waiting_security_baseline", "pushed", "failed", "delivery_unknown"
] as const;
export type ToolDeliveryStatus = typeof TOOL_DELIVERY_STATUSES[number];

export const CANONICAL_STATE_AUTHORITIES = ["handler_explicit", "authoritative_receipt", "legacy_inference", "default"] as const;
export type CanonicalStateAuthority = typeof CANONICAL_STATE_AUTHORITIES[number];

export interface CanonicalToolOutcomeV1 {
  security_status: ToolSecurityStatus;
  resource_status: ToolResourceStatus;
  execution_status: ToolExecutionStatus;
  recovery_status: ToolRecoveryStatus;
  validation_status: ToolValidationStatus;
  delivery_status: ToolDeliveryStatus;
  permission_decision_id: string | null;
  effective_side_effect_level: string | null;
  resource_lease_id: string | null;
  workspace_baseline_id: string | null;
  confirmation_receipt_id: string | null;
  tool_schema_digest: string | null;
  retryable: boolean;
  reason_code: string | null;
  state_authority: CanonicalStateAuthority;
}

export type OrthogonalToolOutcomeV1 = CanonicalToolOutcomeV1;

export interface DeriveOrthogonalToolOutcomeInput {
  outcome: "ok" | "error";
  result?: unknown;
  operation_type?: string | null;
  tool_category?: string | null;
  handler_invoked?: boolean;
  permission_decision_id?: string | null;
  permission_final_decision?: string | null;
  effective_side_effect_level?: string | null;
  confirmation_receipt_id?: string | null;
  tool_schema_digest?: string | null;
  retryable?: boolean;
  reason_code?: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structuredResult(value: unknown): { outer: Record<string, unknown>; data: Record<string, unknown> } {
  const outer = record(value);
  const structured = record(outer.structuredContent);
  return { outer, data: Object.keys(structured).length ? structured : outer };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function lower(value: unknown): string {
  return text(value)?.toLowerCase() ?? "";
}

function nested(data: Record<string, unknown>, key: string, child: string): unknown {
  return record(data[key])[child];
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return null;
}

function explicitStatus<T extends readonly string[]>(allowed: T, value: unknown): T[number] | null {
  const candidate = lower(value);
  return (allowed as readonly string[]).includes(candidate) ? candidate as T[number] : null;
}

function normalizedResourceStatus(value: unknown): ToolResourceStatus | null {
  const candidate = lower(value);
  if ((TOOL_RESOURCE_STATUSES as readonly string[]).includes(candidate)) return candidate as ToolResourceStatus;
  if (["queued", "waiting", "queued_by_resource_policy", "waiting_for_resources"].includes(candidate)) return "waiting_resources";
  if (["timed_out", "timeout"].includes(candidate)) return "resource_wait_timeout";
  return null;
}

function normalizedDeliveryStatus(value: unknown): ToolDeliveryStatus | null {
  const candidate = lower(value);
  if ((TOOL_DELIVERY_STATUSES as readonly string[]).includes(candidate)) return candidate as ToolDeliveryStatus;
  if (["already_synced", "synced", "push_succeeded"].includes(candidate)) return "pushed";
  if (["commit_created", "committed_local", "local_commit_created"].includes(candidate)) return "committed";
  if (["waiting_security_baseline", "push_waiting_for_security_baseline"].includes(candidate)) return "push_waiting_security_baseline";
  return null;
}

export function deriveOrthogonalToolOutcome(input: DeriveOrthogonalToolOutcomeInput): CanonicalToolOutcomeV1 {
  const { outer, data } = structuredResult(input.result);
  const domainStatus = lower(data.status);
  const explicitReasonCode = firstText(data.reason_code, data.error_code, data.risk_reason_code, nested(data, "error", "code"), input.reason_code);
  const reasonText = [explicitReasonCode, text(data.error), text(data.reason), text(data.message)].filter(Boolean).join(" ").toLowerCase();
  const workspaceConflict = /office\.workspace_conflict|conversation workspace mismatch|stale workspace generation|immutable task workspace binding/.test(reasonText);
  const reasonCode = workspaceConflict ? "workspace_conflict" : explicitReasonCode;
  const permissionFinal = lower(input.permission_final_decision ?? nested(data, "permission_decision", "final_decision") ?? data.permission_final_decision);

  const explicitSecurity = explicitStatus(TOOL_SECURITY_STATUSES, data.security_status);
  const securityStatus: ToolSecurityStatus = explicitSecurity
    ?? (permissionFinal === "ask" ? "confirmation_required"
      : permissionFinal === "deny" ? "denied"
        : permissionFinal === "allow" ? "allowed"
          : (/(?:permission|security|safety|risk gate).*(?:blocked|denied)|(?:blocked|denied).*(?:permission|security|safety)/.test(reasonText)
            ? "denied"
            : "allowed"));

  const resourceLeaseId = firstText(
    data.resource_lease_id,
    data.lease_id,
    nested(data, "resource", "lease_id"),
    nested(data, "resource_plan", "parent_lease_id")
  );
  const explicitResource = normalizedResourceStatus(data.resource_status);
  const resourceStatus: ToolResourceStatus = explicitResource
    ?? (data.resource_wait_timed_out === true || domainStatus === "resource_wait_timeout" || reasonCode === "resource_wait_timeout"
      ? "resource_wait_timeout"
      : domainStatus === "resource_parent_lease_lost" || reasonCode === "resource_parent_lease_lost"
        ? "lease_lost"
        : ["queued_by_resource_policy", "waiting_for_resources"].includes(domainStatus)
          ? "waiting_resources"
          : resourceLeaseId ? "admitted" : "not_required");

  const explicitExecution = explicitStatus(TOOL_EXECUTION_STATUSES, data.execution_status);
  const exitCode = Number(data.exitCode ?? data.exit_code);
  const failed = input.outcome === "error" || outer.isError === true || data.success === false || data.passed === false
    || ["failed", "error"].includes(domainStatus) || (Number.isFinite(exitCode) && exitCode !== 0);
  const executionStatus: ToolExecutionStatus = explicitExecution
    ?? (workspaceConflict || securityStatus === "confirmation_required" || securityStatus === "denied" || ["waiting_resources", "resource_wait_timeout", "lease_lost"].includes(resourceStatus)
      ? "not_started"
      : ["queued", "pending", "claiming"].includes(domainStatus) ? "queued"
        : ["running", "working", "recovering"].includes(domainStatus) ? "running"
          : ["cancelled", "canceled"].includes(domainStatus) ? "cancelled"
            : failed ? "failed" : "completed");

  const explicitRetryable = typeof input.retryable === "boolean" ? input.retryable
    : typeof data.retryable === "boolean" ? data.retryable
    : typeof nested(data, "error", "retryable") === "boolean" ? nested(data, "error", "retryable") as boolean
      : undefined;
  const retryable = explicitRetryable
    ?? (["waiting_resources", "resource_wait_timeout"].includes(resourceStatus) || domainStatus === "recovery_required");

  const explicitRecovery = explicitStatus(TOOL_RECOVERY_STATUSES, data.recovery_status);
  const recoveryStatus: ToolRecoveryStatus = explicitRecovery
    ?? (["recovering"].includes(domainStatus) ? "recovering"
      : domainStatus === "recovery_required" ? "recovery_required"
        : retryable ? "retryable"
          : executionStatus === "failed" ? "not_recoverable" : "not_required");

  const operation = lower(input.operation_type);
  const category = lower(input.tool_category);
  const validationRequested = operation === "validate" || category === "validation";
  const explicitValidation = explicitStatus(TOOL_VALIDATION_STATUSES, data.validation_status);
  const validationStatus: ToolValidationStatus = explicitValidation
    ?? (!validationRequested ? "not_requested"
      : domainStatus === "incomplete" ? "incomplete"
        : domainStatus === "skipped" ? "skipped"
          : ["queued", "pending", "running", "claiming"].includes(domainStatus) ? "pending"
            : data.passed === true || data.success === true ? "passed"
              : executionStatus === "failed" ? "failed"
                : executionStatus === "completed" ? "passed" : "pending");

  const explicitDelivery = normalizedDeliveryStatus(data.delivery_status ?? data.push_status ?? data.commit_status);
  const deliveryStatus: ToolDeliveryStatus = explicitDelivery
    ?? (domainStatus === "push_waiting_security_baseline" ? "push_waiting_security_baseline"
      : ["pushed", "already_synced"].includes(domainStatus) ? "pushed"
        : ["committed", "commit_created"].includes(domainStatus) ? "committed"
          : category === "git" && executionStatus === "failed" ? "failed" : "not_requested");

  const hasExplicitStructuredState = [
    data.security_status, data.resource_status, data.execution_status, data.recovery_status,
    data.validation_status, data.delivery_status, data.reason_code, data.retryable
  ].some((value) => value !== undefined && value !== null);
  const hasAuthoritativeReceipt = Boolean(
    input.permission_decision_id || input.permission_final_decision || input.confirmation_receipt_id
      || data.permission_decision_id || data.confirmation_receipt_id || data.resource_lease_id || data.workspace_baseline_id
  );
  const hasLegacyInference = Boolean(domainStatus || data.success !== undefined || data.passed !== undefined || data.exit_code !== undefined || data.exitCode !== undefined);
  const stateAuthority: CanonicalStateAuthority = hasExplicitStructuredState
    ? "handler_explicit"
    : hasAuthoritativeReceipt ? "authoritative_receipt"
      : hasLegacyInference ? "legacy_inference" : "default";

  return Object.freeze({
    security_status: securityStatus,
    resource_status: resourceStatus,
    execution_status: executionStatus,
    recovery_status: recoveryStatus,
    validation_status: validationStatus,
    delivery_status: deliveryStatus,
    permission_decision_id: firstText(input.permission_decision_id, data.permission_decision_id, nested(data, "permission_decision", "decision_id")),
    effective_side_effect_level: firstText(input.effective_side_effect_level, data.effective_side_effect_level),
    resource_lease_id: resourceLeaseId,
    workspace_baseline_id: firstText(data.workspace_baseline_id, data.baseline_id, nested(data, "workspace_baseline", "baseline_id")),
    confirmation_receipt_id: firstText(input.confirmation_receipt_id, data.confirmation_receipt_id, nested(data, "confirmation_receipt", "receipt_id")),
    tool_schema_digest: firstText(input.tool_schema_digest, data.tool_schema_digest),
    retryable,
    reason_code: reasonCode,
    state_authority: stateAuthority
  });
}

export function publicStatusFromOrthogonal(outcome: OrthogonalToolOutcomeV1): "completed" | "failed" | "blocked" | "degraded" {
  if (outcome.security_status === "denied" || outcome.reason_code === "workspace_conflict") return "blocked";
  if (outcome.execution_status === "failed" || outcome.execution_status === "cancelled"
    || outcome.validation_status === "failed" || outcome.validation_status === "incomplete"
    || outcome.delivery_status === "failed") return "failed";
  if (outcome.security_status === "confirmation_required"
    || ["waiting_resources", "resource_wait_timeout", "lease_lost"].includes(outcome.resource_status)
    || ["retryable", "recovering", "recovery_required"].includes(outcome.recovery_status)
    || outcome.validation_status === "pending"
    || outcome.delivery_status === "push_waiting_security_baseline") return "degraded";
  return "completed";
}

export function toolStatusFromOrthogonal(outcome: OrthogonalToolOutcomeV1): "queued" | "running" | "waiting_approval" | "blocked" | "stalled" | "completed" | "failed" | "cancelled" {
  if (outcome.security_status === "confirmation_required") return "waiting_approval";
  if (outcome.security_status === "denied" || outcome.reason_code === "workspace_conflict") return "blocked";
  if (outcome.execution_status === "queued" || outcome.resource_status === "waiting_resources") return "queued";
  if (outcome.execution_status === "running" || outcome.recovery_status === "recovering") return "running";
  if (["resource_wait_timeout", "lease_lost"].includes(outcome.resource_status) || outcome.recovery_status === "recovery_required") return "stalled";
  if (outcome.execution_status === "cancelled") return "cancelled";
  if (publicStatusFromOrthogonal(outcome) === "failed") return "failed";
  return "completed";
}

export function hasOrthogonalToolOutcome(value: unknown): value is OrthogonalToolOutcomeV1 {
  const item = record(value);
  return (TOOL_SECURITY_STATUSES as readonly unknown[]).includes(item.security_status)
    && (TOOL_RESOURCE_STATUSES as readonly unknown[]).includes(item.resource_status)
    && (TOOL_EXECUTION_STATUSES as readonly unknown[]).includes(item.execution_status)
    && (TOOL_RECOVERY_STATUSES as readonly unknown[]).includes(item.recovery_status)
    && (TOOL_VALIDATION_STATUSES as readonly unknown[]).includes(item.validation_status)
    && (TOOL_DELIVERY_STATUSES as readonly unknown[]).includes(item.delivery_status)
    && typeof item.retryable === "boolean"
    && (item.state_authority === undefined || (CANONICAL_STATE_AUTHORITIES as readonly unknown[]).includes(item.state_authority));
}

export const deriveCanonicalToolOutcome = deriveOrthogonalToolOutcome;
export const hasCanonicalToolOutcome = hasOrthogonalToolOutcome;
