export type HeartbeatLane = "model_stream" | "tool_process" | "worker";
export type HeartbeatState = "working" | "silent" | "waiting" | "stale" | "terminal";

export interface HeartbeatEnvelopeV1 {
  version: 1;
  heartbeat_id: string;
  task_id: string | null;
  run_id: string;
  execution_id: string;
  lane: HeartbeatLane;
  source: string;
  owner_fingerprint: string | null;
  fencing_token: number | null;
  state: HeartbeatState;
  reason: string | null;
  liveness_at: string;
  progress_at: string | null;
  output_at: string | null;
  progress_sequence: number;
  progress_fingerprint: string | null;
  expected_silence_until: string | null;
  no_progress_deadline_at: string | null;
  hard_deadline_at: string | null;
}

export const HEARTBEAT_ENVELOPE_V1_FIELDS = [
  "version",
  "heartbeat_id",
  "task_id",
  "run_id",
  "execution_id",
  "lane",
  "source",
  "owner_fingerprint",
  "fencing_token",
  "state",
  "reason",
  "liveness_at",
  "progress_at",
  "output_at",
  "progress_sequence",
  "progress_fingerprint",
  "expected_silence_until",
  "no_progress_deadline_at",
  "hard_deadline_at"
] as const satisfies readonly (keyof HeartbeatEnvelopeV1)[];
