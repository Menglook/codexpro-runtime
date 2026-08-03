import { createHash, randomUUID } from "node:crypto";

export const EXTERNAL_CALL_DELIVERY_STATES = [
  "not_sent",
  "sending",
  "acknowledged",
  "executing",
  "completed",
  "failed",
  "delivery_unknown"
] as const;

export type ExternalCallDeliveryState = typeof EXTERNAL_CALL_DELIVERY_STATES[number];

export const EXTERNAL_CALL_CONNECTION_STATES = [
  "connected",
  "idle",
  "transport_interrupted",
  "server_restarting",
  "waking",
  "reconnecting",
  "capability_renegotiating",
  "ready",
  "unavailable"
] as const;

export type ExternalCallConnectionState = typeof EXTERNAL_CALL_CONNECTION_STATES[number];
export type ExternalCallIdempotency = "idempotent" | "non_idempotent" | "unknown";
export type ExternalCallDomain =
  | "mcp"
  | "message_store"
  | "goal_events"
  | "usage_ledger"
  | "git"
  | "browser"
  | "database"
  | (string & {});

export interface ExternalCallFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ExternalCallRecordV1 {
  version: 1;
  call_id: string;
  domain: ExternalCallDomain;
  operation: string;
  request_fingerprint: string;
  idempotency: ExternalCallIdempotency;
  idempotency_key: string | null;
  delivery_state: ExternalCallDeliveryState;
  connection_state: ExternalCallConnectionState;
  attempt: number;
  max_attempts: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  executing_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  delivery_unknown_at: string | null;
  result_ref: string | null;
  domain_fact_ref: string | null;
  failure: ExternalCallFailure | null;
  delivery_unknown_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateExternalCallInput {
  call_id?: string;
  domain: ExternalCallDomain;
  operation: string;
  request?: unknown;
  request_fingerprint?: string;
  idempotency?: ExternalCallIdempotency;
  idempotency_key?: string | null;
  connection_state?: ExternalCallConnectionState;
  max_attempts?: number | null;
  metadata?: Record<string, unknown>;
  domain_fact_ref?: string | null;
  now?: string;
}

export interface ExternalCallTransitionOptions {
  now?: string;
  connection_state?: ExternalCallConnectionState;
  result_ref?: string | null;
  domain_fact_ref?: string | null;
  failure?: ExternalCallFailure | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export type ExternalCallRetryAction =
  | "none"
  | "safe_retry"
  | "manual_intervention"
  | "wait_for_connection"
  | "attempt_limit_reached";

export interface ExternalCallRetryDecision {
  action: ExternalCallRetryAction;
  safe_to_retry: boolean;
  automatic_retry_allowed: boolean;
  reason: string;
}

const TERMINAL_STATES = new Set<ExternalCallDeliveryState>(["completed", "failed", "delivery_unknown"]);
const TRANSITIONS: Record<ExternalCallDeliveryState, ReadonlySet<ExternalCallDeliveryState>> = {
  not_sent: new Set(["sending", "failed"]),
  sending: new Set(["acknowledged", "executing", "completed", "failed", "delivery_unknown"]),
  acknowledged: new Set(["executing", "completed", "failed", "delivery_unknown"]),
  executing: new Set(["completed", "failed", "delivery_unknown"]),
  completed: new Set(),
  failed: new Set(),
  delivery_unknown: new Set()
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

export function externalCallRequestFingerprint(request: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(request ?? null))).digest("hex")}`;
}

function timestamp(value?: string): string {
  const resolved = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(resolved))) throw new Error(`Invalid external call timestamp: ${resolved}`);
  return resolved;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

export function createExternalCallRecord(input: CreateExternalCallInput): ExternalCallRecordV1 {
  const now = timestamp(input.now);
  const idempotency = input.idempotency ?? "unknown";
  const idempotencyKey = input.idempotency_key?.trim() || null;
  if (idempotency === "idempotent" && !idempotencyKey) {
    throw new Error("Idempotent external calls require an idempotency_key.");
  }
  const maxAttempts = input.max_attempts ?? null;
  if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw new Error("max_attempts must be null or a positive integer.");
  }
  return {
    version: 1,
    call_id: input.call_id?.trim() || randomUUID(),
    domain: nonEmpty(String(input.domain), "domain") as ExternalCallDomain,
    operation: nonEmpty(input.operation, "operation"),
    request_fingerprint: input.request_fingerprint?.trim() || externalCallRequestFingerprint(input.request),
    idempotency,
    idempotency_key: idempotencyKey,
    delivery_state: "not_sent",
    connection_state: input.connection_state ?? "connected",
    attempt: 1,
    max_attempts: maxAttempts,
    revision: 1,
    created_at: now,
    updated_at: now,
    sent_at: null,
    acknowledged_at: null,
    executing_at: null,
    completed_at: null,
    failed_at: null,
    delivery_unknown_at: null,
    result_ref: null,
    domain_fact_ref: input.domain_fact_ref?.trim() || null,
    failure: null,
    delivery_unknown_reason: null,
    metadata: { ...(input.metadata ?? {}) }
  };
}

export function isExternalCallTerminal(record: Pick<ExternalCallRecordV1, "delivery_state">): boolean {
  return TERMINAL_STATES.has(record.delivery_state);
}

export function transitionExternalCall(
  record: ExternalCallRecordV1,
  nextState: ExternalCallDeliveryState,
  options: ExternalCallTransitionOptions = {}
): ExternalCallRecordV1 {
  if (record.delivery_state === nextState) return record;
  if (!TRANSITIONS[record.delivery_state].has(nextState)) {
    throw new Error(`Invalid external call transition: ${record.delivery_state} -> ${nextState}.`);
  }
  const now = timestamp(options.now);
  const next: ExternalCallRecordV1 = {
    ...record,
    delivery_state: nextState,
    connection_state: options.connection_state ?? record.connection_state,
    updated_at: now,
    revision: record.revision + 1,
    result_ref: options.result_ref === undefined ? record.result_ref : options.result_ref,
    domain_fact_ref: options.domain_fact_ref === undefined ? record.domain_fact_ref : options.domain_fact_ref,
    failure: options.failure === undefined ? record.failure : options.failure,
    metadata: { ...record.metadata, ...(options.metadata ?? {}) }
  };
  if (nextState === "sending") next.sent_at = now;
  if (nextState === "acknowledged") next.acknowledged_at = now;
  if (nextState === "executing") next.executing_at = now;
  if (nextState === "completed") next.completed_at = now;
  if (nextState === "failed") {
    next.failed_at = now;
    next.failure = options.failure ?? { code: "external_call_failed", message: "External call failed.", retryable: false };
  }
  if (nextState === "delivery_unknown") {
    next.delivery_unknown_at = now;
    next.delivery_unknown_reason = options.reason?.trim() || "external_side_effect_cannot_be_proven";
  }
  return next;
}

export function updateExternalCallConnection(
  record: ExternalCallRecordV1,
  connectionState: ExternalCallConnectionState,
  options: Omit<ExternalCallTransitionOptions, "connection_state"> = {}
): ExternalCallRecordV1 {
  const now = timestamp(options.now);
  return {
    ...record,
    connection_state: connectionState,
    updated_at: now,
    revision: record.revision + 1,
    metadata: { ...record.metadata, ...(options.metadata ?? {}) }
  };
}

export function markExternalCallDeliveryUnknown(
  record: ExternalCallRecordV1,
  options: ExternalCallTransitionOptions = {}
): ExternalCallRecordV1 {
  if (record.delivery_state === "delivery_unknown") return record;
  if (record.delivery_state === "not_sent") {
    throw new Error("A call that was never sent cannot be marked delivery_unknown.");
  }
  return transitionExternalCall(record, "delivery_unknown", options);
}

export function externalCallRetryDecision(record: ExternalCallRecordV1): ExternalCallRetryDecision {
  if (["transport_interrupted", "server_restarting", "waking", "reconnecting", "capability_renegotiating", "unavailable"].includes(record.connection_state)) {
    return {
      action: "wait_for_connection",
      safe_to_retry: false,
      automatic_retry_allowed: false,
      reason: `Connection is not ready: ${record.connection_state}.`
    };
  }
  if (record.max_attempts !== null && record.attempt >= record.max_attempts) {
    return {
      action: "attempt_limit_reached",
      safe_to_retry: false,
      automatic_retry_allowed: false,
      reason: "The configured attempt limit has been reached."
    };
  }
  if (record.delivery_state === "completed") {
    return { action: "none", safe_to_retry: false, automatic_retry_allowed: false, reason: "The call already completed." };
  }
  if (record.delivery_state === "delivery_unknown") {
    if (record.idempotency === "idempotent" && record.idempotency_key) {
      return {
        action: "safe_retry",
        safe_to_retry: true,
        automatic_retry_allowed: true,
        reason: "Delivery is unknown, but the stable idempotency key makes a repeat safe."
      };
    }
    return {
      action: "manual_intervention",
      safe_to_retry: false,
      automatic_retry_allowed: false,
      reason: "Delivery is unknown and the call is not proven idempotent; automatic retry could duplicate a side effect."
    };
  }
  if (record.delivery_state === "failed") {
    const safe = record.failure?.retryable === true && record.idempotency === "idempotent" && Boolean(record.idempotency_key);
    return safe
      ? { action: "safe_retry", safe_to_retry: true, automatic_retry_allowed: true, reason: "The failure is retryable and the call is idempotent." }
      : { action: "none", safe_to_retry: false, automatic_retry_allowed: false, reason: "The failure is not safe for automatic retry." };
  }
  if (record.delivery_state === "not_sent" && record.idempotency === "idempotent" && record.idempotency_key) {
    return { action: "safe_retry", safe_to_retry: true, automatic_retry_allowed: true, reason: "The call was not sent and is idempotent." };
  }
  return { action: "none", safe_to_retry: false, automatic_retry_allowed: false, reason: "The current call state does not require recovery." };
}

export function createExternalCallRetry(record: ExternalCallRecordV1, nowValue?: string): ExternalCallRecordV1 {
  const decision = externalCallRetryDecision(record);
  if (!decision.safe_to_retry) throw new Error(`External call is not safe to retry: ${decision.reason}`);
  const now = timestamp(nowValue);
  return {
    ...record,
    delivery_state: "not_sent",
    connection_state: "ready",
    attempt: record.attempt + 1,
    revision: record.revision + 1,
    updated_at: now,
    sent_at: null,
    acknowledged_at: null,
    executing_at: null,
    completed_at: null,
    failed_at: null,
    delivery_unknown_at: null,
    result_ref: null,
    failure: null,
    delivery_unknown_reason: null,
    metadata: { ...record.metadata, recovered_from_state: record.delivery_state }
  };
}

export const createExternalCall = createExternalCallRecord;
export const advanceExternalCall = transitionExternalCall;
export const markDeliveryUnknown = markExternalCallDeliveryUnknown;
export const canSafelyRetryExternalCall = (record: ExternalCallRecordV1): boolean => externalCallRetryDecision(record).safe_to_retry;
export const retryExternalCall = createExternalCallRetry;
