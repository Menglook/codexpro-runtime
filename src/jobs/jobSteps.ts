import type { GoalLatencyBreakdown } from "../goals/types.js";
import type { LoopBudget, LoopFailureCategory, LoopState } from "../workflow/loopPolicy.js";
import type { ActiveSkillRecord } from "../skills/types.js";
import type { ResourceCategory, ResourcePoolName, ResourcePriority } from "../resources/resourceGovernor.js";
import type { RuntimeActivityEventV1, RuntimeActivityState, RuntimeUserActionRequiredV1 } from "../runtime/activityEvents.js";

export type DurableJobStatus =
  | "queued"
  | "running"
  | "recovering"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "recovery_required"
  | "stale";

export type DurableJobSideEffectLevel = "read_only" | "local_write" | "external_write" | "unknown";
export type DurableJobRetryPolicy = "automatic" | "manual" | "never";
export type DurableJobTerminationReason =
  | "no_progress_timeout"
  | "step_timeout"
  | "execution_hard_limit"
  | "explicit_cancel"
  | "cancel_grace_expired"
  | "heartbeat_persistence_failed"
  | "process_exit"
  | "resource_limit"
  | "termination_failed"
  | "unknown_timeout";

export type DurableJobStepStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "recovery_required";

export interface TaskProgress {
  phase: string;
  current_step: number;
  total_steps?: number;
  current_action: string;
  wait_reason?: string;
  heartbeat_at: string;
  liveness_at?: string;
  progress_at?: string;
  last_meaningful_progress_at?: string;
  activity_state?: RuntimeActivityState;
  safe_progress_summary?: string;
  user_action_required?: RuntimeUserActionRequiredV1 | null;
  last_activity_event?: RuntimeActivityEventV1;
  progress_fingerprint?: string;
  step_deadline?: string;
  no_progress_deadline?: string;
  hard_deadline?: string;
  termination_reason?: DurableJobTerminationReason;
  heartbeat_write_failures?: number;
  last_evidence?: string;
  retries: number;
  estimated_remaining_ms?: number;
  writer_active: boolean;
  browser_active: boolean;
  latency_breakdown?: GoalLatencyBreakdown;
  execution_state: "queued" | "working" | "silent" | "waiting" | "blocked" | "recovering" | "stale" | "terminal";
}

export interface DurableJobStep {
  step_id: string;
  index: number;
  contract_version?: number;
  phase: string;
  status: DurableJobStepStatus;
  input_hash: string;
  output_summary?: string;
  output_path?: string;
  evidence_paths: string[];
  owner_token?: string;
  fencing_token?: number;
  heartbeat_at?: string;
  step_deadline?: string;
  no_progress_deadline?: string;
  termination_reason?: DurableJobTerminationReason;
  heartbeat_write_failures?: number;
  idempotent: boolean;
  retryable: boolean;
  side_effect_level?: DurableJobSideEffectLevel;
  retry_policy?: DurableJobRetryPolicy;
  rollback_method?: string;
  attempts: number;
  previous_step?: string;
  next_step?: string;
  pending_operation?: string | null;
  started_at?: string;
  finished_at?: string;
  error?: string;
  failure_category?: LoopFailureCategory;
  failure_fingerprint?: string;
  same_failure_repeats?: number;
}

export interface DurableJobRecord {
  version: 1;
  run_id: string;
  contract_version?: number;
  kind: "task" | "stage";
  title: string;
  workspace_id: string;
  workspace_root: string;
  status: DurableJobStatus;
  owner_token: string | null;
  fencing_token?: number;
  owner_pid?: number | null;
  owner_acquired_at?: string | null;
  previous_owner_token?: string | null;
  input_path: string;
  input_hash: string;
  current_step_id: string | null;
  steps: string[];
  loop_budget?: LoopBudget;
  loop_state?: LoopState;
  failure_category?: LoopFailureCategory;
  failure_fingerprint?: string;
  progress: TaskProgress;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  status_transition_at?: string;
  status_transition_status?: DurableJobStatus;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  step_timeout_ms?: number;
  no_progress_timeout_ms?: number;
  hard_timeout_ms?: number;
  cancel_grace_ms?: number;
  step_deadline?: string;
  no_progress_deadline?: string;
  hard_deadline?: string;
  termination_reason?: DurableJobTerminationReason;
  heartbeat_write_failures?: number;
  first_progress_at?: string;
  recovery_count?: number;
  owner_change_count?: number;
  manual_intervention_count?: number;
  report_path?: string;
  result_summary?: string;
  active_skill?: ActiveSkillRecord;
  error?: string;
  recovery_reason?: string;
}

export interface DurableStepOutput {
  summary: string;
  data?: Record<string, unknown>;
  evidence_paths?: string[];
}

export interface DurableJobStepDefinition {
  step_id: string;
  phase: string;
  action: string;
  idempotent: boolean;
  retryable: boolean;
  side_effect_level?: DurableJobSideEffectLevel;
  retry_policy?: DurableJobRetryPolicy;
  rollback_method?: string;
  step_timeout_ms?: number;
  no_progress_timeout_ms?: number;
  writer_active?: boolean;
  browser_active?: boolean;
  resource_category?: ResourceCategory;
  resource_priority?: ResourcePriority;
  resource_pools?: ResourcePoolName[];
}
