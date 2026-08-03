import { hashAgentValue } from "../agents/completionProof.js";

export type PermissionDecisionKind = "allow" | "constrained" | "sandbox" | "ask" | "deny";

export interface PermissionDecisionSource {
  source: string;
  decision: PermissionDecisionKind;
  reason: string;
  constraints?: string[];
  evidence_refs?: string[];
}

export interface MonotonicPermissionDecision {
  version: 1;
  decision_id: string;
  final_decision: PermissionDecisionKind;
  sources: PermissionDecisionSource[];
  constraints: string[];
  reasons: string[];
  evidence_refs: string[];
  audit_hash: string;
}

export const MONOTONIC_PERMISSION_DECISION_V1_FIELDS = [
  "version",
  "decision_id",
  "final_decision",
  "sources",
  "constraints",
  "reasons",
  "evidence_refs",
  "audit_hash"
] as const satisfies readonly (keyof MonotonicPermissionDecision)[];

const DECISION_RANK: Record<PermissionDecisionKind, number> = {
  allow: 0,
  constrained: 1,
  sandbox: 1,
  ask: 2,
  deny: 3
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSource(source: PermissionDecisionSource): PermissionDecisionSource {
  const name = String(source.source ?? "").trim();
  const reason = String(source.reason ?? "").trim();
  if (!name) throw new Error("Permission decision source must include source.");
  if (!reason) throw new Error(`Permission decision source ${name} must include reason.`);
  if (!(source.decision in DECISION_RANK)) throw new Error(`Unknown permission decision: ${String(source.decision)}.`);
  return {
    source: name,
    decision: source.decision,
    reason,
    constraints: unique(source.constraints ?? []),
    evidence_refs: unique(source.evidence_refs ?? [])
  };
}

function stricterDecision(left: PermissionDecisionKind, right: PermissionDecisionKind): PermissionDecisionKind {
  const leftRank = DECISION_RANK[left];
  const rightRank = DECISION_RANK[right];
  if (rightRank > leftRank) return right;
  if (leftRank > rightRank) return left;
  if (left === right) return left;
  // constrained and sandbox occupy the same policy tier. Sandbox wins ties because
  // it provides a concrete enforcement boundary rather than a descriptive limit.
  if (left === "sandbox" || right === "sandbox") return "sandbox";
  return "constrained";
}

export function mergePermissionDecisions(input: PermissionDecisionSource[]): MonotonicPermissionDecision {
  if (!input.length) throw new Error("At least one permission decision source is required.");
  const sources = input.map(normalizeSource);
  const finalDecision = sources.reduce<PermissionDecisionKind>(
    (current, source) => stricterDecision(current, source.decision),
    "allow"
  );
  const constraints = unique(sources.flatMap((source) => source.constraints ?? [])).sort();
  const reasons = unique(sources.map((source) => `${source.source}: ${source.reason}`));
  const evidenceRefs = unique(sources.flatMap((source) => source.evidence_refs ?? [])).sort();
  const unsigned = {
    version: 1 as const,
    final_decision: finalDecision,
    sources,
    constraints,
    reasons,
    evidence_refs: evidenceRefs
  };
  const auditHash = hashAgentValue(unsigned);
  return {
    ...unsigned,
    decision_id: `perm_${auditHash.slice("sha256:".length, "sha256:".length + 24)}`,
    audit_hash: auditHash
  };
}

export function verifyPermissionDecision(value: MonotonicPermissionDecision): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let rebuilt: MonotonicPermissionDecision | undefined;
  try {
    rebuilt = mergePermissionDecisions(value.sources);
  } catch (error) {
    return { valid: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
  if (rebuilt.final_decision !== value.final_decision) reasons.push("final_decision_mismatch");
  if (rebuilt.decision_id !== value.decision_id) reasons.push("decision_id_mismatch");
  if (rebuilt.audit_hash !== value.audit_hash) reasons.push("audit_hash_mismatch");
  if (hashAgentValue(rebuilt.constraints) !== hashAgentValue(value.constraints)) reasons.push("constraints_mismatch");
  if (hashAgentValue(rebuilt.evidence_refs) !== hashAgentValue(value.evidence_refs)) reasons.push("evidence_refs_mismatch");
  return { valid: reasons.length === 0, reasons };
}

export function permissionDecisionAllowsExecution(decision: MonotonicPermissionDecision): boolean {
  return decision.final_decision === "allow"
    || decision.final_decision === "constrained"
    || decision.final_decision === "sandbox";
}

export function assertPermissionDecisionAllowsExecution(decision: MonotonicPermissionDecision): void {
  const verification = verifyPermissionDecision(decision);
  if (!verification.valid) throw new Error(`Permission decision integrity failed: ${verification.reasons.join(", ")}.`);
  if (decision.final_decision === "ask") throw new Error(`Permission decision requires explicit approval: ${decision.reasons.join(" | ")}`);
  if (decision.final_decision === "deny") throw new Error(`Permission decision denied execution: ${decision.reasons.join(" | ")}`);
}
