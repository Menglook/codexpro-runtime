import type { AgentCompletionClass } from "../agents/completionProofTypes.js";
import type { ExecutionComponentStateFile } from "../execution/componentStore.js";
import type { TaskProgress } from "../jobs/jobSteps.js";
import type { ResourceProjection } from "../resources/resourceGovernor.js";
import type { TaskCompletionStateV1, TaskDeliveryStatus, TaskOutcomeVector } from "../runtime/taskOutcome.js";
import type { LoopBudgetRemaining, LoopDecisionAction, LoopFailureCategory } from "../workflow/loopPolicy.js";
import type { GitPushErrorCode, GitPushTransport } from "../workflow/gitPushTransport.js";

export type TaskDomainKind = "goal" | "durable_job" | "handoff";

export type UnifiedTaskStatus =
  | "created"
  | "queued"
  | "assigned"
  | "running"
  | "waiting"
  | "interrupted"
  | "recovering"
  | "implemented_not_verified"
  | "validating"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface TaskObjectiveMetadataV1 {
  version: 1;
  objective_key: string;
  stage_key: string | null;
  previous_attempt_id: string | null;
  source: "explicit" | "structured_task" | "legacy_single_attempt";
}

export interface TaskWorkspaceBindingV1 {
  version: 1;
  objective_id: string;
  project_id: string;
  workspace_id: string;
  workspace_root: string;
  workspace_generation: number;
  source_conversation_id: string;
  immutable_after_start: true;
}

export interface TaskActorIdentityV1 {
  version: 1;
  actor_id: string;
  session_id: string;
  role: "executor" | "reviewer" | "observer" | "system";
}

export interface TaskIdentity {
  version: 1;
  task_id: string;
  kind: TaskDomainKind;
  domain_id: string;
  project_root: string;
  title: string;
  parent_task_id?: string;
  objective?: TaskObjectiveMetadataV1;
  workspace_binding?: TaskWorkspaceBindingV1;
  actor?: TaskActorIdentityV1;
  identity_quality?: "authoritative" | "degraded";
  legacy_binding?: boolean;
  created_at: string;
  updated_at: string;
}

export type TaskLivenessState = "queued" | "working" | "silent" | "waiting" | "stale" | "stopped" | "unknown";

export interface TaskLeaseProjection {
  evidence: "execution_kernel" | "provider_run" | "owner_lock" | "handoff" | "none";
  active: boolean | null;
  stale: boolean | null;
  expired: boolean | null;
  holder_pid: number | null;
  managed_pid: number | null;
  run_id: string | null;
  heartbeat_at: string | null;
  ttl_ms: number | null;
}

export interface TaskLiveness {
  state: TaskLivenessState;
  execution_id: string | null;
  owner_pid: number | null;
  supervisor_pid: number | null;
  watcher_pid: number | null;
  owner_alive: boolean | null;
  lease_active: boolean | null;
  heartbeat_fresh: boolean | null;
  heartbeat_age_ms: number | null;
  heartbeat_at?: string | null;
  lease?: TaskLeaseProjection;
  step_active: boolean | null;
  last_output_at: string | null;
  observed_at: string;
  reason: string;
}

export type TaskAcceptanceStatus = "not_required" | "pending" | "running" | "passed" | "failed";

export interface TaskAcceptanceProjection {
  required: boolean;
  status: TaskAcceptanceStatus;
  profile: string;
  evidence_paths: string[];
  reason: string;
}

export interface TaskContractProjection {
  contract_version: number;
  plan_path: string | null;
  plan_sha256: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  tool_permissions: Record<string, boolean>;
  side_effect_permissions: Record<string, boolean>;
  completion_rule: string;
}

export interface TaskLoopProjection {
  iteration: number;
  repair_rounds: number;
  tool_calls: number;
  full_validation_runs: number;
  browser_reconnects: number;
  same_failure_repeats: number;
  failure_category: LoopFailureCategory | null;
  last_action: LoopDecisionAction | null;
  budget_remaining: LoopBudgetRemaining;
  stop_reason: string | null;
}

export interface TaskExecutorProjection {
  kind: TaskDomainKind | "goal_provider";
  provider: string | null;
  model: string | null;
  sandbox_mode: string | null;
  execution_id: string | null;
  source: string;
}

export type TaskGraphEvidenceSourceKind = "structured_runtime_event" | "durable_job_step" | "goal_checkpoint" | "handoff_state";
export type TaskGraphRouteSource = "code" | "ai" | "human" | "runtime" | "unknown";
export type TaskGraphRetryPolicy = "not_applicable" | "automatic" | "manual" | "never" | "unknown";
export type TaskGraphNodeType = "model_stream" | "tool_process" | "worker";
export type TaskGraphNodeState = "active" | "waiting" | "idle" | "stale" | "terminal" | "unknown";
export type TaskGraphExecutionRelationKind = "sequence" | "dependency" | "branch" | "parallel" | "join" | "retry" | "recovery" | "handoff";

export interface TaskGraphNodeEvidenceV1 {
  version: 1;
  node_id: string;
  node_type: TaskGraphNodeType;
  label: string;
  state: TaskGraphNodeState;
  task_id: string;
  run_id: string | null;
  parent_run_id: string | null;
  parent_node_id: string | null;
  component_id: string | null;
  source_kind: TaskGraphEvidenceSourceKind;
  source_ref: string;
  evidence_refs: string[];
  sequence: number | null;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  route_source: TaskGraphRouteSource;
  transition_reason: string | null;
  retry_policy: TaskGraphRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
}

export interface TaskGraphRelationEvidenceV1 {
  version: 1;
  edge_kind: TaskGraphExecutionRelationKind;
  from_node_id: string;
  to_node_id: string;
  source_kind: TaskGraphEvidenceSourceKind;
  source_ref: string;
  evidence_ref: string;
  route_source: TaskGraphRouteSource;
  transition_reason: string | null;
  condition: string | null;
  selected: boolean | null;
  relation_group: string | null;
  dependency_satisfied: boolean | null;
  retry_policy: TaskGraphRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
  idempotency_key: string | null;
}

export interface TaskExecutionGraphEvidenceV1 {
  version: 1;
  authority: "explicit" | "partial" | "unavailable";
  nodes: TaskGraphNodeEvidenceV1[];
  relations: TaskGraphRelationEvidenceV1[];
  degraded_reasons: string[];
  truncated: boolean;
}

export interface TaskExecutionObservability {
  run_id: string | null;
  owner_source: string | null;
  owner_pid: number | null;
  managed_pid: number | null;
  fencing_token: number | null;
  current_step_id: string | null;
  current_phase: string | null;
  waiting_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  core_execution_completed_at?: string | null;
  terminal_persisted_at?: string | null;
  duration_ms: number | null;
  execution_timeout_ms: number | null;
  last_output_at: string | null;
  last_liveness_at: string | null;
  last_progress_at: string | null;
  progress_fingerprint: string | null;
  step_deadline: string | null;
  no_progress_deadline: string | null;
  hard_deadline: string | null;
  termination_reason: string | null;
  heartbeat_write_failures: number | null;
  queue_duration_ms: number | null;
  time_to_first_progress_ms: number | null;
  no_progress_duration_ms: number | null;
  acceptance_duration_ms: number | null;
  recovery_count: number | null;
  owner_change_count: number | null;
  manual_intervention_count: number | null;
  timeout_reason: string | null;
  termination_signal: string | null;
  recovery_from_run_id: string | null;
  resume_count: number | null;
  latest_error: string | null;
  cancelling: boolean;
  recovering: boolean;
  owner_alive: boolean | null;
  watcher_alive: boolean | null;
}

export interface TaskCompletionProofProjection {
  status: AgentCompletionClass | "missing";
  verified: boolean;
  source: "subagents" | "review" | "combined" | "none";
  proof_paths: string[];
  invalid_reasons: string[];
}

export interface TaskGitFinalizationProjection {
  source_run_id: string | null;
  acceptance_report_path: string | null;
  implementation_status: "completed" | "unknown";
  acceptance_status: "passed" | "skipped" | "unknown";
  branch: string | null;
  changed_files: string[];
  commit_status: "not_started" | "completed" | "failed";
  push_status: "not_requested" | "waiting_security_baseline" | "already_synced" | "completed" | "failed";
  delivery_status: TaskDeliveryStatus;
  local_commit_sha: string | null;
  remote_commit_sha: string | null;
  commit_message: string | null;
  push_transport: GitPushTransport | null;
  push_attempts: number;
  push_error_code: GitPushErrorCode | null;
  reason_code: string;
  reason: string;
  retry_available: boolean;
  last_action: "git_commit" | "git_finalize" | "git_push_only";
  updated_at: string;
}

export interface TaskStatusProjection {
  identity: TaskIdentity;
  status: UnifiedTaskStatus;
  domain_status: string;
  outcome: TaskOutcomeVector;
  completion_state?: TaskCompletionStateV1;
  executor?: TaskExecutorProjection;
  progress: TaskProgress;
  liveness: TaskLiveness;
  execution?: TaskExecutionObservability;
  execution_components?: ExecutionComponentStateFile["execution_components"];
  execution_graph_evidence?: TaskExecutionGraphEvidenceV1;
  acceptance: TaskAcceptanceProjection;
  resource_policy?: ResourceProjection;
  contract?: TaskContractProjection;
  loop?: TaskLoopProjection;
  changed_files_count?: number | null;
  git_finalization?: TaskGitFinalizationProjection;
  completion_proof?: TaskCompletionProofProjection;
  evidence_paths: string[];
  updated_at: string;
}

export interface TaskProjectionListObservability {
  version: 1;
  generated_at: string;
  source: "task_projection";
  requested_limit: number;
  bounded_limit: number;
  max_limit: number;
  bounded: boolean;
  discovered_identity_count: number;
  projected_task_count: number;
  skipped_identity_count: number;
  selection_profile?: "full" | "office";
  selected_identity_count?: number;
  deferred_identity_count?: number;
  duration_ms: number;
  durations_ms: {
    identity_discovery: number;
    projection: number;
    sort_and_slice: number;
    office_index_rebuild?: number;
  };
  invocation_counts: {
    identity_store_list: number;
    goal_store_list: number;
    durable_job_store_list: number;
    durable_job_batch_read: number;
    durable_job_batch_fallback: number;
    durable_job_read: number;
    handoff_status_read: number;
    git_finalization_read: number;
    execution_component_read: number;
    project_goal: number;
    project_durable_job: number;
    project_handoff: number;
    office_identity_index_read?: number;
    office_identity_index_rebuild?: number;
    office_goal_index_read?: number;
    office_goal_index_rebuild?: number;
    office_durable_job_index_read?: number;
    office_durable_job_index_rebuild?: number;
    office_selected_goal_read?: number;
    office_selected_durable_job_read?: number;
  };
}

export interface TaskProjectionListResult {
  tasks: TaskStatusProjection[];
  observability: TaskProjectionListObservability;
}

export type TaskRecoveryMode = "none" | "automatic" | "manual" | "blocked";
export type TaskRecoveryAction =
  | "none"
  | "resume_run_task"
  | "retry_run_task_step"
  | "goal_resume"
  | "reissue_handoff"
  | "validate_only"
  | "external_reconciliation";

export interface TaskRecoveryPlan {
  task_id: string;
  kind: TaskDomainKind;
  status: UnifiedTaskStatus;
  mode: TaskRecoveryMode;
  resumable: boolean;
  automatic: boolean;
  action: TaskRecoveryAction;
  current_step_id: string | null;
  last_completed_step_id: string | null;
  next_step_id: string | null;
  idempotent: boolean | null;
  retryable: boolean | null;
  side_effect_level: "read_only" | "local_write" | "external_write" | "unknown";
  retry_policy: "automatic" | "manual" | "never";
  rollback_method: string | null;
  required_checks: string[];
  reason: string;
  generated_at: string;
  recovery_from_run_id?: string | null;
  resume_count?: number | null;
}

export interface TaskEvidenceProjection {
  task_id: string;
  kind: TaskDomainKind;
  status: UnifiedTaskStatus;
  acceptance: TaskAcceptanceProjection;
  artifact_paths: string[];
  last_evidence: string | null;
  generated_at: string;
}

export interface TaskTimelineEvent {
  sequence: number;
  timestamp: string;
  source: TaskDomainKind;
  type: string;
  status: string;
  summary?: string;
  evidence_paths?: string[];
}
