import { externalCallRetryDecision, type ExternalCallRecordV1 } from "./externalCallContract.js";

export type StructuredRuntimeEventName =
  | "subagent.created"
  | "subagent.started"
  | "subagent.progress"
  | "subagent.deliverable_reported"
  | "subagent.proof_validated"
  | "subagent.proof_rejected"
  | "subagent.delivery_unknown"
  | "subagent.failed"
  | "subagent.cancelled"
  | "subagent.completed"
  | "tool_started"
  | "tool_completed"
  | "execution.snapshot_loaded"
  | "execution.snapshot_mismatch"
  | "delivery_unknown"
  | "failed"
  | "cancelled"
  | "completed"
  | "external_call_delivery_unknown";

export type StructuredRuntimeEventSourceKind =
  | "goal_event"
  | "component_store"
  | "message_store"
  | "completion_proof"
  | "authorization_audit"
  | "execution_profile_snapshot"
  | "external_call_ledger";

export type StructuredRuntimeRetryPolicy = "not_applicable" | "automatic" | "manual" | "never";

export interface StructuredRuntimeRetrySemanticsV1 {
  policy: StructuredRuntimeRetryPolicy;
  replay_allowed: boolean;
  idempotency_key: string | null;
  reason: string;
  attempt: number | null;
  max_attempts: number | null;
}

export interface StructuredRuntimeEventEnvelopeV1 {
  version: 1;
  event_name: StructuredRuntimeEventName;
  authority: string;
  source_kind: StructuredRuntimeEventSourceKind;
  goal_id: string | null;
  task_id: string;
  run_id: string;
  parent_run_id: string | null;
  component_id: string;
  sequence: number;
  timestamp: string;
  execution_profile_version: number | null;
  evidence_ref: string | null;
  terminal: boolean;
  retry_semantics: StructuredRuntimeRetrySemanticsV1;
  idempotency_key: string;
}

export const STRUCTURED_RUNTIME_RETRY_SEMANTICS_V1_FIELDS = [
  "policy",
  "replay_allowed",
  "idempotency_key",
  "reason",
  "attempt",
  "max_attempts"
] as const satisfies readonly (keyof StructuredRuntimeRetrySemanticsV1)[];

export const STRUCTURED_RUNTIME_EVENT_V1_FIELDS = [
  "version",
  "event_name",
  "authority",
  "source_kind",
  "goal_id",
  "task_id",
  "run_id",
  "parent_run_id",
  "component_id",
  "sequence",
  "timestamp",
  "execution_profile_version",
  "evidence_ref",
  "terminal",
  "retry_semantics",
  "idempotency_key"
] as const satisfies readonly (keyof StructuredRuntimeEventEnvelopeV1)[];

export interface CreateStructuredRuntimeEventInput {
  event_name: StructuredRuntimeEventName;
  authority: string;
  source_kind: StructuredRuntimeEventSourceKind;
  goal_id?: string | null;
  task_id: string;
  run_id: string;
  parent_run_id?: string | null;
  component_id: string;
  sequence: number;
  timestamp: string;
  execution_profile_version?: number | null;
  evidence_ref?: string | null;
  terminal: boolean;
  retry_semantics?: Partial<StructuredRuntimeRetrySemanticsV1>;
  idempotency_key?: string;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "chain_of_thought",
  "chainofthought",
  "cot",
  "reasoning",
  "reasoning_text",
  "hidden_reasoning",
  "prompt",
  "prompt_dump",
  "raw_prompt",
  "system_prompt",
  "developer_prompt",
  "conversation_dump",
  "messages"
]);

function cleanText(value: unknown, max = 2_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function requiredText(value: unknown, field: string, max = 2_000): string {
  const cleaned = cleanText(value, max);
  if (!cleaned) throw new Error(`Structured runtime event ${field} is required.`);
  return cleaned;
}

function numericSequence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Structured runtime event sequence must be a positive integer.");
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function retrySemantics(
  input: Partial<StructuredRuntimeRetrySemanticsV1> | undefined,
  idempotencyKey: string
): StructuredRuntimeRetrySemanticsV1 {
  const policy = input?.policy ?? "not_applicable";
  return {
    policy,
    replay_allowed: input?.replay_allowed ?? false,
    idempotency_key: cleanText(input?.idempotency_key) ?? idempotencyKey,
    reason: cleanText(input?.reason, 1_000) ?? "No automatic replay decision is encoded by this event.",
    attempt: optionalPositiveInteger(input?.attempt),
    max_attempts: optionalPositiveInteger(input?.max_attempts)
  };
}

export function assertNoForbiddenStructuredRuntimePayload(value: unknown, path = "$"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenStructuredRuntimePayload(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
    if (FORBIDDEN_PAYLOAD_KEYS.has(normalized)) {
      throw new Error(`Structured runtime event payload contains forbidden field ${path}.${key}.`);
    }
    assertNoForbiddenStructuredRuntimePayload(item, `${path}.${key}`);
  }
}

export function createStructuredRuntimeEventEnvelope(
  input: CreateStructuredRuntimeEventInput
): StructuredRuntimeEventEnvelopeV1 {
  assertNoForbiddenStructuredRuntimePayload(input);
  const idempotencyKey = cleanText(input.idempotency_key, 500)
    ?? [
      input.event_name,
      input.goal_id ?? "no-goal",
      input.task_id,
      input.run_id,
      input.component_id,
      input.evidence_ref ?? "no-evidence"
    ].join(":");
  const envelope: StructuredRuntimeEventEnvelopeV1 = {
    version: 1,
    event_name: input.event_name,
    authority: requiredText(input.authority, "authority"),
    source_kind: input.source_kind,
    goal_id: cleanText(input.goal_id),
    task_id: requiredText(input.task_id, "task_id"),
    run_id: requiredText(input.run_id, "run_id"),
    parent_run_id: cleanText(input.parent_run_id),
    component_id: requiredText(input.component_id, "component_id"),
    sequence: numericSequence(input.sequence),
    timestamp: requiredText(input.timestamp, "timestamp"),
    execution_profile_version: optionalPositiveInteger(input.execution_profile_version),
    evidence_ref: cleanText(input.evidence_ref),
    terminal: input.terminal === true,
    retry_semantics: retrySemantics(input.retry_semantics, idempotencyKey),
    idempotency_key: idempotencyKey
  };
  assertNoForbiddenStructuredRuntimePayload(envelope);
  return envelope;
}

function goalIdFromTaskId(taskId: string | null | undefined): string | null {
  const value = cleanText(taskId, 300);
  if (!value) return null;
  if (value.startsWith("goal-") && value.length > "goal-".length) return value.slice("goal-".length);
  return null;
}

function terminalNameFromGoalEvent(type: string): StructuredRuntimeEventName | null {
  if (type === "goal.succeeded") return "completed";
  if (type === "goal.failed" || type === "goal.blocked") return "failed";
  if (type === "goal.cancelled") return "cancelled";
  return null;
}

function eventData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function structuredRuntimeEventFromGoalEvent(event: {
  type: string;
  sequence: number;
  goal_id: string;
  run_id: string;
  timestamp: string;
  data?: Record<string, unknown>;
}): StructuredRuntimeEventEnvelopeV1 | null {
  const data = eventData(event.data);
  const existing = eventData(data.structured_runtime_event);
  if (existing.version === 1 && existing.event_name) {
    return createStructuredRuntimeEventEnvelope({
      event_name: existing.event_name as StructuredRuntimeEventName,
      authority: String(existing.authority ?? "goal_events"),
      source_kind: (existing.source_kind as StructuredRuntimeEventSourceKind | undefined) ?? "goal_event",
      goal_id: cleanText(existing.goal_id) ?? event.goal_id,
      task_id: String(existing.task_id ?? `goal-${event.goal_id}`),
      run_id: String(existing.run_id ?? event.run_id),
      parent_run_id: cleanText(existing.parent_run_id),
      component_id: String(existing.component_id ?? `goal:${event.goal_id}`),
      sequence: event.sequence,
      timestamp: event.timestamp,
      execution_profile_version: existing.execution_profile_version as number | null | undefined,
      evidence_ref: cleanText(existing.evidence_ref),
      terminal: existing.terminal === true,
      retry_semantics: existing.retry_semantics as Partial<StructuredRuntimeRetrySemanticsV1> | undefined,
      idempotency_key: cleanText(existing.idempotency_key, 500) ?? undefined
    });
  }
  const terminalEventName = terminalNameFromGoalEvent(event.type);
  if (!terminalEventName) return null;
  return createStructuredRuntimeEventEnvelope({
    event_name: terminalEventName,
    authority: "goal_events",
    source_kind: "goal_event",
    goal_id: event.goal_id,
    task_id: `goal-${event.goal_id}`,
    run_id: event.run_id,
    parent_run_id: event.run_id,
    component_id: `goal:${event.goal_id}`,
    sequence: event.sequence,
    timestamp: event.timestamp,
    execution_profile_version: optionalPositiveInteger(data.execution_profile_snapshot_version),
    evidence_ref: cleanText(data.report_path) ?? cleanText(data.evidence_ref),
    terminal: true,
    retry_semantics: {
      policy: "never",
      replay_allowed: false,
      reason: "Goal terminal state is authoritative and cannot be replayed by appending another event."
    },
    idempotency_key: `${event.type}:${event.goal_id}:${event.run_id}`
  });
}

export function structuredRuntimeEventFromAuthorizationAuditEntry(
  entry: {
    recorded_at: string;
    phase: string;
    correlation_id: string;
    task_id: string | null;
    tool: string;
    payload_binding_id: string;
    permission_evidence_refs?: string[];
    outcome: string;
    duration_ms?: number | null;
    structured_runtime_event?: StructuredRuntimeEventEnvelopeV1 | null;
  },
  sequence: number
): StructuredRuntimeEventEnvelopeV1 | null {
  if (entry.structured_runtime_event) {
    return createStructuredRuntimeEventEnvelope({
      ...entry.structured_runtime_event,
      sequence,
      timestamp: entry.recorded_at
    });
  }
  if (entry.phase !== "executing" && entry.phase !== "completed" && entry.phase !== "failed" && entry.phase !== "blocked") {
    return null;
  }
  const taskId = cleanText(entry.task_id) ?? `tool:${entry.tool}`;
  const terminal = entry.phase === "completed" || entry.phase === "failed" || entry.phase === "blocked";
  return createStructuredRuntimeEventEnvelope({
    event_name: terminal ? "tool_completed" : "tool_started",
    authority: "authorization_audit",
    source_kind: "authorization_audit",
    goal_id: goalIdFromTaskId(taskId),
    task_id: taskId,
    run_id: entry.correlation_id,
    parent_run_id: entry.correlation_id,
    component_id: `tool:${entry.tool}:${entry.payload_binding_id}`,
    sequence,
    timestamp: entry.recorded_at,
    execution_profile_version: null,
    evidence_ref: entry.permission_evidence_refs?.[0] ?? entry.payload_binding_id,
    terminal,
    retry_semantics: {
      policy: terminal && entry.outcome === "error" ? "manual" : "not_applicable",
      replay_allowed: false,
      reason: terminal
        ? "Tool terminal outcome is persisted by the authorization audit entry; retries require a new authorized call."
        : "Tool execution has started under the current authorization binding."
    },
    idempotency_key: `authorization_audit:${entry.correlation_id}:${entry.phase}:${entry.payload_binding_id}`
  });
}

export function structuredRuntimeEventFromExternalCallRecord(
  record: ExternalCallRecordV1
): StructuredRuntimeEventEnvelopeV1 | null {
  if (record.delivery_state !== "delivery_unknown") return null;
  const taskId = cleanText(record.metadata.task_id) ?? `external-call:${record.call_id}`;
  const runId = cleanText(record.metadata.run_id) ?? record.call_id;
  const parentRunId = cleanText(record.metadata.parent_run_id) ?? runId;
  const retryDecision = externalCallRetryDecision(record);
  const automaticReplay = retryDecision.automatic_retry_allowed;
  return createStructuredRuntimeEventEnvelope({
    event_name: "external_call_delivery_unknown",
    authority: "external_call_ledger",
    source_kind: "external_call_ledger",
    goal_id: goalIdFromTaskId(taskId),
    task_id: taskId,
    run_id: runId,
    parent_run_id: parentRunId,
    component_id: `external_call:${record.domain}:${record.operation}:${record.call_id}`,
    sequence: record.revision,
    timestamp: record.delivery_unknown_at ?? record.updated_at,
    execution_profile_version: null,
    evidence_ref: record.domain_fact_ref ?? record.result_ref ?? record.call_id,
    terminal: true,
    retry_semantics: {
      policy: automaticReplay ? "automatic" : "never",
      replay_allowed: automaticReplay,
      idempotency_key: record.idempotency_key,
      reason: automaticReplay
        ? retryDecision.reason
        : "External call delivery is unknown; the existing ledger record is authoritative and blind replay is forbidden.",
      attempt: record.attempt,
      max_attempts: record.max_attempts
    },
    idempotency_key: `external_call_delivery_unknown:${record.call_id}`
  });
}
