export type ProcessExecutionDomain =
  | "shell"
  | "git"
  | "model"
  | "worker"
  | "hook"
  | "notification"
  | "adapter"
  | "probe"
  | "server";

export type ProcessSideEffectLevel =
  | "none"
  | "local_read"
  | "local_write"
  | "external_write";

export interface ProcessExecutionRecordV1 {
  version: 1;
  execution_id: string;
  correlation_id: string | null;
  task_id: string | null;
  run_id: string | null;
  step_id: string | null;
  domain: ProcessExecutionDomain;
  operation: string;
  command_fingerprint: string;
  cwd: string;
  side_effect_level: ProcessSideEffectLevel;
  risk_level: string;
  owner_fingerprint: string | null;
  fencing_token: number | null;
  pid: number | null;
  started_at: string;
  last_heartbeat_at: string | null;
  last_progress_at: string | null;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  termination_reason: string | null;
  tree_terminated: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  output_truncated: boolean;
  stdout_hash: string;
  stderr_hash: string;
  error_class: string | null;
  retry_count: number;
  evidence_path: string;
}

export const PROCESS_EXECUTION_RECORD_V1_FIELDS = [
  "version",
  "execution_id",
  "correlation_id",
  "task_id",
  "run_id",
  "step_id",
  "domain",
  "operation",
  "command_fingerprint",
  "cwd",
  "side_effect_level",
  "risk_level",
  "owner_fingerprint",
  "fencing_token",
  "pid",
  "started_at",
  "last_heartbeat_at",
  "last_progress_at",
  "finished_at",
  "duration_ms",
  "exit_code",
  "signal",
  "termination_reason",
  "tree_terminated",
  "stdout_bytes",
  "stderr_bytes",
  "output_truncated",
  "stdout_hash",
  "stderr_hash",
  "error_class",
  "retry_count",
  "evidence_path"
] as const satisfies readonly (keyof ProcessExecutionRecordV1)[];
