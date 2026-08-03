import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import {
  createStructuredRuntimeEventEnvelope,
  type StructuredRuntimeEventEnvelopeV1
} from "../runtime/structuredRuntimeEvents.js";
import type { AuthorizationPayloadBindingV1 } from "./authorizationIntegrity.js";
import type { MonotonicPermissionDecision } from "./permissionDecision.js";
import type { UnifiedRiskDecision } from "./riskGate.js";

export type AuthorizationAuditPhase = "evaluated" | "executing" | "completed" | "blocked" | "failed";
export type AuthorizationAuditOutcome = "pending" | "ok" | "blocked" | "error";

export interface AuthorizationAuditEntryV1 {
  version: 1;
  audit_id: string;
  recorded_at: string;
  phase: AuthorizationAuditPhase;
  correlation_id: string;
  task_id: string | null;
  tool: string;
  risk_level: string;
  risk_reason_code: string;
  payload_binding_id: string;
  raw_hash: string;
  normalized_hash: string;
  approved_payload_hash: string;
  executed_payload_hash: string | null;
  finding_codes: string[];
  permission_decision_id: string;
  permission_final_decision: string;
  permission_audit_hash: string;
  permission_sources: Array<{ source: string; decision: string }>;
  permission_constraints: string[];
  permission_reasons: string[];
  permission_evidence_refs: string[];
  outcome: AuthorizationAuditOutcome;
  duration_ms: number | null;
  structured_runtime_event?: StructuredRuntimeEventEnvelopeV1 | null;
}

export const AUTHORIZATION_AUDIT_ENTRY_V1_FIELDS = [
  "version",
  "audit_id",
  "recorded_at",
  "phase",
  "correlation_id",
  "task_id",
  "tool",
  "risk_level",
  "risk_reason_code",
  "payload_binding_id",
  "raw_hash",
  "normalized_hash",
  "approved_payload_hash",
  "executed_payload_hash",
  "finding_codes",
  "permission_decision_id",
  "permission_final_decision",
  "permission_audit_hash",
  "permission_sources",
  "permission_constraints",
  "permission_reasons",
  "permission_evidence_refs",
  "outcome",
  "duration_ms",
  "structured_runtime_event"
] as const satisfies readonly (keyof AuthorizationAuditEntryV1)[];

export const AUTHORIZATION_AUDIT_ENTRY_V1_REQUIRED_FIELDS = AUTHORIZATION_AUDIT_ENTRY_V1_FIELDS.filter(
  (field) => field !== "structured_runtime_event"
) as readonly Exclude<keyof AuthorizationAuditEntryV1, "structured_runtime_event">[];

const writeQueues = new Map<string, Promise<void>>();

function timestamp(): string {
  return new Date().toISOString();
}

function auditPath(config: Pick<CodexProConfig, "defaultRoot" | "contextDir">): string {
  return path.join(config.defaultRoot, config.contextDir, "authorization-audit.jsonl");
}

function auditId(value: Omit<AuthorizationAuditEntryV1, "audit_id">): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
  return `authaudit_${digest}_${randomUUID().slice(0, 8)}`;
}

export function createAuthorizationAuditEntry(input: {
  phase: AuthorizationAuditPhase;
  correlationId: string;
  taskId?: string;
  tool: string;
  risk: UnifiedRiskDecision;
  binding: AuthorizationPayloadBindingV1;
  permission: MonotonicPermissionDecision;
  outcome: AuthorizationAuditOutcome;
  durationMs?: number;
  recordedAt?: string;
}): AuthorizationAuditEntryV1 {
  const recordedAt = input.recordedAt ?? timestamp();
  const baseIdempotencyKey = `authorization_audit:${input.correlationId}:${input.phase}:${input.binding.binding_id}`;
  const structuredRuntimeEvent = input.phase === "evaluated"
    ? null
    : createStructuredRuntimeEventEnvelope({
        event_name: input.phase === "executing" ? "tool_started" : "tool_completed",
        authority: "authorization_audit",
        source_kind: "authorization_audit",
        goal_id: input.taskId?.startsWith("goal-") ? input.taskId.slice("goal-".length) : null,
        task_id: input.taskId ?? `tool:${input.tool}`,
        run_id: input.correlationId,
        parent_run_id: input.correlationId,
        component_id: `tool:${input.tool}:${input.binding.binding_id}`,
        sequence: 1,
        timestamp: recordedAt,
        execution_profile_version: null,
        evidence_ref: input.permission.evidence_refs[0] ?? input.binding.binding_id,
        terminal: input.phase === "completed" || input.phase === "blocked" || input.phase === "failed",
        retry_semantics: {
          policy: input.phase === "failed" ? "manual" : "not_applicable",
          replay_allowed: false,
          idempotency_key: baseIdempotencyKey,
          reason: input.phase === "executing"
            ? "Tool execution started after authorization payload and permission checks."
            : "Tool outcome is bound to the persisted authorization audit entry; retries require a new authorized call.",
          attempt: 1,
          max_attempts: 1
        },
        idempotency_key: baseIdempotencyKey
      });
  const unsigned: Omit<AuthorizationAuditEntryV1, "audit_id"> = {
    version: 1,
    recorded_at: recordedAt,
    phase: input.phase,
    correlation_id: input.correlationId,
    task_id: input.taskId ?? null,
    tool: input.tool,
    risk_level: input.risk.level,
    risk_reason_code: input.risk.reason_code,
    payload_binding_id: input.binding.binding_id,
    raw_hash: input.binding.raw_hash,
    normalized_hash: input.binding.normalized_hash,
    approved_payload_hash: input.binding.approved_payload_hash,
    executed_payload_hash: input.binding.executed_payload_hash,
    finding_codes: [...input.binding.finding_codes].sort(),
    permission_decision_id: input.permission.decision_id,
    permission_final_decision: input.permission.final_decision,
    permission_audit_hash: input.permission.audit_hash,
    permission_sources: input.permission.sources.map((source) => ({
      source: source.source,
      decision: source.decision
    })),
    permission_constraints: [...input.permission.constraints],
    permission_reasons: [...input.permission.reasons],
    permission_evidence_refs: [...input.permission.evidence_refs],
    outcome: input.outcome,
    duration_ms: Number.isFinite(input.durationMs) ? Math.max(0, Math.floor(input.durationMs ?? 0)) : null,
    structured_runtime_event: structuredRuntimeEvent
  };
  return { ...unsigned, audit_id: auditId(unsigned) };
}

export async function appendAuthorizationAuditEntry(
  config: Pick<CodexProConfig, "defaultRoot" | "contextDir">,
  entry: AuthorizationAuditEntryV1
): Promise<string> {
  const filePath = auditPath(config);
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
  writeQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
  return filePath;
}

export async function readAuthorizationAuditEntries(
  config: Pick<CodexProConfig, "defaultRoot" | "contextDir">
): Promise<AuthorizationAuditEntryV1[]> {
  try {
    const content = await fsp.readFile(auditPath(config), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuthorizationAuditEntryV1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
