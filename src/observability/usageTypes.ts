export type UsageComponent =
  | "model"
  | "process"
  | "tool"
  | "worker"
  | "acceptance"
  | "review"
  | "message"
  | "agent"
  | "browser";

export type TokenMeasurement = "measured" | "estimated" | "unavailable";
export type UsageAvailability = "available" | "unavailable";

export type UsageExternalCallState =
  | "not_sent"
  | "sending"
  | "acknowledged"
  | "executing"
  | "completed"
  | "failed"
  | "delivery_unknown";

export interface UsageExternalCallLink {
  external_call_id?: string | null;
  external_call_domain?: string | null;
  external_call_state?: UsageExternalCallState | null;
  external_call_attempt?: number | null;
  external_call_idempotency_key?: string | null;
}

export interface UsageEntryV1 extends UsageExternalCallLink {
  version: 1;
  usage_id: string;
  dedupe_key: string;
  source_event_id: string | null;
  task_id: string | null;
  run_id: string | null;
  execution_id: string | null;
  agent_id: string | null;
  step_id: string | null;
  component: UsageComponent;
  provider: string | null;
  model: string | null;
  tool: string | null;
  started_at: string;
  finished_at: string;
  wall_duration_ms: number;
  queue_duration_ms: number | null;
  active_duration_ms: number | null;
  silent_duration_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  token_measurement: TokenMeasurement;
  input_bytes: number | null;
  output_bytes: number | null;
  process_count: number;
  retry_count: number;
  cache_hit: boolean | null;
  outcome: string;
  verified_completion: boolean;
  skill_id: string | null;
  refresh_count: number | null;
  rebind_count: number | null;
  reconnect_count: number | null;
  recovery_count: number | null;
  human_wait_ms: number | null;
  review_duration_ms: number | null;
  evidence_hash: string;
  written_at: string;
}

export interface UsageLedgerSummaryV1 {
  version: 1;
  availability: UsageAvailability;
  entry_count: number;
  total_wall_duration_ms: number;
  queue_duration_ms: number | null;
  active_duration_ms: number | null;
  silent_duration_ms: number | null;
  acceptance_duration_ms: number;
  human_wait_ms: number | null;
  review_duration_ms: number | null;
  token_measurement: {
    measured: number;
    estimated: number;
    unavailable: number;
  };
  tokens: {
    input: number;
    cached_input: number;
    output: number;
    reasoning_output: number;
  } | null;
  process_count: number;
  retry_count: number;
  verified_completion_count: number;
  verified_completion_efficiency: number | null;
  cache: {
    hit: number;
    miss: number;
    unavailable: number;
  };
  browser: {
    success: number;
    failed: number;
    unknown: number;
    refresh_count: number;
    rebind_count: number;
    reconnect_count: number;
    recovery_count: number;
  };
  warning_count: number;
  generated_at: string;
}

export const USAGE_ENTRY_V1_FIELDS = [
  "version",
  "usage_id",
  "dedupe_key",
  "source_event_id",
  "task_id",
  "run_id",
  "execution_id",
  "agent_id",
  "step_id",
  "component",
  "provider",
  "model",
  "tool",
  "started_at",
  "finished_at",
  "wall_duration_ms",
  "queue_duration_ms",
  "active_duration_ms",
  "silent_duration_ms",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "token_measurement",
  "input_bytes",
  "output_bytes",
  "process_count",
  "retry_count",
  "cache_hit",
  "outcome",
  "verified_completion",
  "skill_id",
  "refresh_count",
  "rebind_count",
  "reconnect_count",
  "recovery_count",
  "human_wait_ms",
  "review_duration_ms",
  "evidence_hash",
  "written_at"
] as const satisfies readonly (keyof UsageEntryV1)[];
