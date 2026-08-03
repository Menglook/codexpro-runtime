import { hashAgentValue } from "../agents/completionProof.js";
import type { Workspace } from "../guard.js";
import type { AuthorizationPayloadIntegrityV1 } from "./authorizationIntegrity.js";
import { authorizationPayloadRawHash } from "./authorizationIntegrity.js";
import type { MonotonicPermissionDecision, PermissionDecisionKind } from "./permissionDecision.js";
import { verifyPermissionDecision } from "./permissionDecision.js";
import type { UnifiedRiskDecision } from "./riskGate.js";

export interface PreExecutionDecisionV1 {
  version: 1;
  decision_id: string;
  tool_name: string;
  payload_raw_hash: string;
  payload_normalized_hash: string;
  payload_analysis_count: 1;
  workspace_id: string | null;
  workspace_generation: number | null;
  effective_side_effect_level: string;
  effective_operations: string[];
  effective_paths: string[];
  risk_level: string;
  risk_reason_code: string;
  permission_decision_id: string;
  permission_audit_hash: string;
  final_permission: PermissionDecisionKind;
  confirmation_receipt_id: string | null;
  confirmation_applied: boolean;
  resource_plan_id: string | null;
  reason_codes: string[];
  audit_hash: string;
}

export interface CreatePreExecutionDecisionInput {
  toolName: string;
  integrity: AuthorizationPayloadIntegrityV1;
  workspaceId?: string | null;
  workspaceGeneration?: number | null;
  risk: UnifiedRiskDecision;
  permission: MonotonicPermissionDecision;
  confirmationReceiptId?: string | null;
  confirmationApplied?: boolean;
  resourcePlanId?: string | null;
  reasonCodes?: string[];
}

export interface PreExecutionBindingVerificationInput {
  payload: unknown;
  workspace: Workspace | null;
  permission: MonotonicPermissionDecision;
  confirmationReceiptId?: string | null;
}

export interface PreExecutionBindingVerification {
  valid: boolean;
  reasons: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function unsignedDecision(value: Omit<PreExecutionDecisionV1, "decision_id" | "audit_hash">): Omit<PreExecutionDecisionV1, "decision_id" | "audit_hash"> {
  return value;
}

export function createPreExecutionDecision(input: CreatePreExecutionDecisionInput): PreExecutionDecisionV1 {
  const permissionVerification = verifyPermissionDecision(input.permission);
  if (!permissionVerification.valid) {
    throw new Error(`Pre-execution permission integrity failed: ${permissionVerification.reasons.join(", ")}.`);
  }
  const workspaceGeneration = Number.isInteger(input.workspaceGeneration)
    ? Number(input.workspaceGeneration)
    : null;
  const unsigned = unsignedDecision({
    version: 1,
    tool_name: String(input.toolName ?? "").trim(),
    payload_raw_hash: input.integrity.raw_hash,
    payload_normalized_hash: input.integrity.normalized_hash,
    payload_analysis_count: 1,
    workspace_id: input.workspaceId ?? null,
    workspace_generation: workspaceGeneration && workspaceGeneration > 0 ? workspaceGeneration : null,
    effective_side_effect_level: input.risk.effective_side_effect_level,
    effective_operations: unique(input.risk.effective_operations),
    effective_paths: unique(input.risk.effective_paths),
    risk_level: input.risk.level,
    risk_reason_code: input.risk.reason_code,
    permission_decision_id: input.permission.decision_id,
    permission_audit_hash: input.permission.audit_hash,
    final_permission: input.permission.final_decision,
    confirmation_receipt_id: input.confirmationReceiptId ?? null,
    confirmation_applied: input.confirmationApplied === true,
    resource_plan_id: input.resourcePlanId ?? null,
    reason_codes: unique([
      input.risk.reason_code,
      ...input.permission.sources.map((source) => `${source.source}:${source.decision}`),
      ...(input.reasonCodes ?? [])
    ])
  });
  if (!unsigned.tool_name) throw new Error("Pre-execution decision requires a tool name.");
  const auditHash = hashAgentValue(unsigned);
  return {
    ...unsigned,
    decision_id: `preexec_${auditHash.slice("sha256:".length, "sha256:".length + 24)}`,
    audit_hash: auditHash
  };
}

export function verifyPreExecutionDecision(
  decision: PreExecutionDecisionV1,
  input: PreExecutionBindingVerificationInput
): PreExecutionBindingVerification {
  const reasons: string[] = [];
  if (decision.version !== 1) reasons.push("unsupported_decision_version");
  const { decision_id: _decisionId, audit_hash: _auditHash, ...unsigned } = decision;
  const expectedAuditHash = hashAgentValue(unsigned);
  const expectedDecisionId = `preexec_${expectedAuditHash.slice("sha256:".length, "sha256:".length + 24)}`;
  if (decision.audit_hash !== expectedAuditHash) reasons.push("decision_audit_hash_mismatch");
  if (decision.decision_id !== expectedDecisionId) reasons.push("decision_id_mismatch");
  if (authorizationPayloadRawHash(input.payload) !== decision.payload_raw_hash) reasons.push("payload_hash_mismatch");
  if ((input.workspace?.id ?? null) !== decision.workspace_id) reasons.push("workspace_id_mismatch");
  const currentGeneration = Number.isInteger(input.workspace?.workspaceGeneration)
    ? Number(input.workspace?.workspaceGeneration)
    : null;
  if ((currentGeneration && currentGeneration > 0 ? currentGeneration : null) !== decision.workspace_generation) {
    reasons.push("workspace_generation_mismatch");
  }
  const permissionVerification = verifyPermissionDecision(input.permission);
  if (!permissionVerification.valid) reasons.push(...permissionVerification.reasons.map((reason) => `permission_${reason}`));
  if (input.permission.decision_id !== decision.permission_decision_id) reasons.push("permission_decision_id_mismatch");
  if (input.permission.audit_hash !== decision.permission_audit_hash) reasons.push("permission_audit_hash_mismatch");
  if (input.permission.final_decision !== decision.final_permission) reasons.push("final_permission_mismatch");
  if ((input.confirmationReceiptId ?? null) !== decision.confirmation_receipt_id) reasons.push("confirmation_receipt_mismatch");
  return { valid: reasons.length === 0, reasons: unique(reasons) };
}

export function assertPreExecutionDecision(
  decision: PreExecutionDecisionV1,
  input: PreExecutionBindingVerificationInput
): void {
  const verification = verifyPreExecutionDecision(decision, input);
  if (!verification.valid) {
    throw new Error(`Pre-execution decision binding failed: ${verification.reasons.join(", ")}.`);
  }
}
