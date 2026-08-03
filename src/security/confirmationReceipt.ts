import { hashAgentValue } from "../agents/completionProof.js";
import {
  mergePermissionDecisions,
  type MonotonicPermissionDecision,
  type PermissionDecisionSource
} from "./permissionDecision.js";

export interface PermissionConfirmationScopeV1 {
  tool: string;
  arguments: Record<string, unknown>;
  actor_id?: string;
  conversation_id?: string;
  workspace_id?: string;
  workspace_generation?: number;
  authorization_payload_hash?: string;
  permission_decision_hash?: string;
}

export interface PermissionConfirmationReceiptV1 {
  version: 1;
  receipt_id: string;
  source: "mcp_request_state";
  scope_hash: string;
  confirmed_at: string;
  request_state_nonce_hash: string;
  single_use: true;
}

export interface PermissionConfirmationVerification {
  valid: boolean;
  reasons: string[];
}

export interface PermissionConfirmationResolution {
  decision: MonotonicPermissionDecision;
  receipt_valid: boolean;
  receipt_applied: boolean;
  reasons: string[];
}

function normalizedScope(scope: PermissionConfirmationScopeV1): PermissionConfirmationScopeV1 {
  const tool = String(scope.tool ?? "").trim();
  if (!tool) throw new Error("Confirmation scope requires a tool name.");
  return {
    tool,
    arguments: scope.arguments && typeof scope.arguments === "object" && !Array.isArray(scope.arguments)
      ? scope.arguments
      : {},
    ...(scope.actor_id ? { actor_id: String(scope.actor_id).trim() } : {}),
    ...(scope.conversation_id ? { conversation_id: String(scope.conversation_id).trim() } : {}),
    ...(scope.workspace_id ? { workspace_id: String(scope.workspace_id).trim() } : {}),
    ...(Number.isInteger(scope.workspace_generation) && Number(scope.workspace_generation) > 0
      ? { workspace_generation: Number(scope.workspace_generation) }
      : {}),
    ...(scope.authorization_payload_hash
      ? { authorization_payload_hash: String(scope.authorization_payload_hash).trim() }
      : {}),
    ...(scope.permission_decision_hash
      ? { permission_decision_hash: String(scope.permission_decision_hash).trim() }
      : {})
  };
}

export function permissionConfirmationScopeHash(scope: PermissionConfirmationScopeV1): string {
  return hashAgentValue(normalizedScope(scope));
}

export function createPermissionConfirmationReceipt(
  scope: PermissionConfirmationScopeV1,
  options: { requestStateNonce: string; confirmedAt?: string }
): PermissionConfirmationReceiptV1 {
  const requestStateNonce = String(options.requestStateNonce ?? "").trim();
  if (!requestStateNonce) throw new Error("Confirmation receipt requires a consumed request-state nonce.");
  const unsigned = {
    version: 1 as const,
    source: "mcp_request_state" as const,
    scope_hash: permissionConfirmationScopeHash(scope),
    confirmed_at: options.confirmedAt ?? new Date().toISOString(),
    request_state_nonce_hash: hashAgentValue(requestStateNonce),
    single_use: true as const
  };
  const receiptHash = hashAgentValue(unsigned);
  return {
    ...unsigned,
    receipt_id: `confirm_${receiptHash.slice("sha256:".length, "sha256:".length + 24)}`
  };
}

export function verifyPermissionConfirmationReceipt(
  receipt: PermissionConfirmationReceiptV1,
  scope: PermissionConfirmationScopeV1
): PermissionConfirmationVerification {
  const reasons: string[] = [];
  if (receipt.version !== 1) reasons.push("unsupported_receipt_version");
  if (receipt.source !== "mcp_request_state") reasons.push("unsupported_receipt_source");
  if (receipt.single_use !== true) reasons.push("single_use_required");
  if (receipt.scope_hash !== permissionConfirmationScopeHash(scope)) reasons.push("scope_hash_mismatch");
  if (!receipt.request_state_nonce_hash) reasons.push("request_state_nonce_hash_missing");
  if (!receipt.confirmed_at || Number.isNaN(Date.parse(receipt.confirmed_at))) reasons.push("confirmed_at_invalid");
  const { receipt_id: _receiptId, ...unsigned } = receipt;
  const receiptHash = hashAgentValue(unsigned);
  const expectedId = `confirm_${receiptHash.slice("sha256:".length, "sha256:".length + 24)}`;
  if (receipt.receipt_id !== expectedId) reasons.push("receipt_id_mismatch");
  return { valid: reasons.length === 0, reasons };
}

export function resolvePermissionConfirmation(
  decision: MonotonicPermissionDecision,
  receipt: PermissionConfirmationReceiptV1 | undefined,
  scope: PermissionConfirmationScopeV1
): PermissionConfirmationResolution {
  if (!receipt) {
    return { decision, receipt_valid: true, receipt_applied: false, reasons: [] };
  }
  const verification = verifyPermissionConfirmationReceipt(receipt, scope);
  if (!verification.valid) {
    return {
      decision,
      receipt_valid: false,
      receipt_applied: false,
      reasons: verification.reasons
    };
  }
  if (decision.final_decision !== "ask") {
    return { decision, receipt_valid: true, receipt_applied: false, reasons: [] };
  }
  const sources: PermissionDecisionSource[] = decision.sources.map((source) => source.decision === "ask"
    ? {
        ...source,
        decision: "constrained",
        reason: `${source.reason} Confirmed for this exact one-time request-state scope.`,
        evidence_refs: [...new Set([...(source.evidence_refs ?? []), receipt.receipt_id])]
      }
    : source);
  return {
    decision: mergePermissionDecisions(sources),
    receipt_valid: true,
    receipt_applied: true,
    reasons: []
  };
}
