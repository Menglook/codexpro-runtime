import type { AgentCompletionClass } from "../agents/completionProofTypes.js";
import type { AdvisoryReviewReport, ReadOnlyAgentTask, SubagentBatchReport } from "../agents/types.js";
import type { CodexAdapterMode, CodexApprovalPolicy, CodexProviderId, CodexReasoningEffort, CodexSandboxMode } from "../codex/types.js";
import type { ToolMode } from "../config.js";
import type { ToolDisclosureDecision } from "../server/toolRegistry.js";
import type { TaskOutcomeVector } from "../runtime/taskOutcome.js";
import type { ContextProfile } from "../workflow/contextProfiles.js";
import type { ToolPolicy } from "../workflow/taskRouter.js";
import type { LoopFailureCategory, LoopState } from "../workflow/loopPolicy.js";
import type { ExecutionLaneDecision, ReviewerRoutingMode } from "../workflow/executionLane.js";
import type { ChangeFootprint, MinimalSufficiencyReview } from "../workflow/minimalChange.js";
import type { GoalContractAmendment, GoalContractAmendmentInput, GoalContractInput, GoalContractV1 } from "./goalContract.js";

export type GoalStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "validating"
  | "reviewing"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type GoalTerminalStatus = Extract<GoalStatus, "succeeded" | "failed" | "blocked" | "cancelled">;

export interface GoalFailure {
  code: string;
  message: string;
  retryable: boolean;
  failure_domain?: "acceptance" | "review_gate" | "infrastructure_policy" | "runner" | "codex" | "snapshot";
  category?: LoopFailureCategory;
  fingerprint?: string;
  retry_disposition?: string;
  recommended_action?: string;
  occurred_at: string;
}

export type GoalHookEventType =
  | "task.started"
  | "task.checkpointed"
  | "task.waiting_input"
  | "task.waiting_approval"
  | "task.succeeded"
  | "task.failed"
  | "task.cancelled";

export interface GoalHookDeliveryState {
  claimed_event_keys: string[];
  delivered_event_keys: string[];
  attempts: number;
  last_event_type: GoalHookEventType | null;
  last_event_key: string | null;
  last_error: string | null;
  final_notification_claimed_at: string | null;
  final_notification_sent_at: string | null;
  updated_at: string;
}

export interface GoalExecutionOptions {
  sandbox_mode: CodexSandboxMode;
  approval_policy: CodexApprovalPolicy;
  model?: string;
  preferred_provider?: CodexProviderId;
  forced_provider?: CodexProviderId;
  reasoning_effort?: CodexReasoningEffort;
  network_access_enabled: boolean;
  skip_git_repo_check: boolean;
}

export type GoalExecutionProfileReason = "goal_start" | "legacy_migration" | "explicit_upgrade" | "lane_escalation";
export type GoalModelResolution = "explicit" | "registry" | "provider_default" | "legacy";

export interface GoalExecutionPermissionPolicy {
  approval_policy: CodexApprovalPolicy;
  tool_permissions: Record<string, boolean>;
  side_effect_permissions: Record<string, boolean>;
  commit_policy: string;
  push_policy: string;
  deploy_policy: string;
  database_policy: string;
}

export interface GoalExecutionLaneProfile {
  version: 1;
  enabled: boolean;
  lane: ExecutionLaneDecision["lane"];
  forced_deep: boolean;
  fast_eligible: boolean;
  reason_codes: string[];
  reasons: string[];
  reasoning_effort: CodexReasoningEffort;
  acceptance_profile: ExecutionLaneDecision["acceptance_profile"];
  reviewer_mode: ReviewerRoutingMode;
  scope_size: number;
  escalation_only: true;
  escalated_from?: ExecutionLaneDecision["lane"];
}

export interface GoalExecutionProfileSnapshot {
  version: 1;
  snapshot_id: string;
  snapshot_version: number;
  parent_snapshot_id: string | null;
  reason: GoalExecutionProfileReason;
  created_at: string;
  goal_id: string;
  run_id: string;
  provider: CodexProviderId;
  model: string | null;
  model_profile_id: string | null;
  model_resolution: GoalModelResolution;
  reasoning_effort: CodexReasoningEffort | null;
  execution_lane: GoalExecutionLaneProfile;
  reviewer_mode: ReviewerRoutingMode;
  tool_policy: ToolPolicy;
  permission_policy: GoalExecutionPermissionPolicy;
  sandbox_policy: {
    sandbox_mode: CodexSandboxMode;
    workspace_write: boolean;
  };
  mcp_profile: {
    profile: "v1" | "v2";
    protocol_version: string;
    tool_mode: ToolMode;
  };
  context_profile: ContextProfile;
  working_directory: string;
  environment_policy: {
    inherit_env: boolean;
    network_access_enabled: boolean;
    skip_git_repo_check: boolean;
  };
  policy_version: string;
  adapter_version: {
    contract_version: string;
    adapter_mode: CodexAdapterMode;
  };
  task_contract_hash: string;
  profile_hash: string;
}

export interface GoalExecutionProfileUpgrade {
  reason: string;
  provider?: CodexProviderId;
  model?: string | null;
  reasoning_effort?: CodexReasoningEffort;
}

export interface GoalLatencyBreakdown {
  queue_ms: number;
  task_compile_ms: number;
  lane_decision_ms: number;
  provider_probe_ms: number;
  snapshot_ms: number;
  context_prepare_ms: number;
  model_first_event_ms: number;
  model_total_ms: number;
  tool_execution_ms: number;
  validation_ms: number;
  review_ms: number;
  browser_ms: number;
  report_ms: number;
  orchestration_overhead_ms: number;
  total_ms: number;
}

export type GoalLatencyStage =
  | "queue"
  | "task_compile"
  | "lane_decision"
  | "provider_probe"
  | "snapshot"
  | "context_prepare"
  | "model_total"
  | "tool_execution"
  | "validation"
  | "review"
  | "browser"
  | "report";

export interface GoalLatencyState {
  version: 1;
  wall_clock_started_at: string;
  wall_clock_completed_at?: string;
  active_stage_started_at: Partial<Record<GoalLatencyStage, string>>;
  breakdown: GoalLatencyBreakdown;
}

export interface GoalProviderRunRecord {
  version: 1;
  provider: CodexProviderId;
  run_id: string;
  thread_id: string | null;
  operation: "start" | "resume" | "unknown";
  contract_version: number;
  sandbox_mode: CodexSandboxMode;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  host_pid: number | null;
  supervisor_pid: number | null;
  provider_pid: number | null;
  executor_pid: number | null;
  owner_pid: number | null;
  owner_fingerprint?: string;
  fencing_token?: number;
  watcher_pid: number | null;
  started_at: string;
  heartbeat_at: string | null;
  heartbeat_lease_ms: number;
  heartbeat_write_failures?: number;
  last_output_at: string | null;
  last_progress_at?: string | null;
  step_deadline?: string | null;
  no_progress_deadline?: string | null;
  hard_deadline?: string | null;
  termination_reason?: string | null;
  last_event_at: string | null;
  last_event_sequence: number;
  completed_at: string | null;
  status_reason: string;
}

export interface GoalAgentProofSummary {
  status: AgentCompletionClass | "missing";
  verified: boolean;
  proof_paths: string[];
  invalid_reasons: string[];
}

export interface GoalCheckpoint extends Record<string, unknown> {
  phase?: string;
  contract_version?: number;
  plan_sha256?: string | null;
  codex_run_id?: string | null;
  last_codex_event_sequence?: number;
  request_fingerprint?: string;
  execution_options?: GoalExecutionOptions;
  execution_profile_snapshot?: GoalExecutionProfileSnapshot;
  execution_profile_history?: GoalExecutionProfileSnapshot[];
  execution_profile_recovery?: {
    snapshot_id: string;
    snapshot_version: number;
    recovered_at: string;
    source_status: GoalStatus;
    reason: string;
  };
  pending_operation?: "start" | "resume" | "cancel" | "subagents" | "validation" | "review" | null;
  non_idempotent?: boolean;
  replay_allowed?: boolean;
  recovery_required?: boolean;
  recovered_from_status?: GoalStatus;
  recovery_reason?: string;
  resource_lease?: {
    lease_id: string;
    request_id: string;
    task_id: string;
    run_id: string | null;
  };
  last_resume_idempotency_key?: string;
  snapshot_finished?: boolean;
  codex_turn_terminal?: boolean;
  last_error?: string;
  execution_provider?: CodexProviderId;
  final_response?: string;
  structured_result?: Record<string, unknown>;
  validation_changed_files?: string[];
  validation_reused_at?: string;
  authorization_required?: boolean;
  retry_launch_operation?: "start" | "resume";
  provider_run?: GoalProviderRunRecord;
  execution_lane?: ExecutionLaneDecision;
  tool_disclosure?: ToolDisclosureDecision;
  context_profile?: ContextProfile;
  context_expansion_count?: number;
  context_missing_reasons?: string[];
  review_routing?: {
    mode: ReviewerRoutingMode;
    reason_code: string;
    reason: string;
    model_review_run: boolean;
  };
  acceptance_profile_requested?: string;
  acceptance_profile_effective?: string;
  acceptance_profile_fallback_reason?: string;
  acceptance_started_at?: string;
  acceptance_connector_returned_at?: string;
  acceptance_status?: string;
  receipt_persisted_at?: string;
  receipt_status?: string;
  core_execution_completed_at?: string;
  final_response_ready_at?: string;
  goal_terminal_at?: string;
  terminal_event_emitted_at?: string;
  runner_wait_returned_at?: string;
  hook_delivery_started_at?: string;
  hook_delivery_settled_at?: string;
  hook_delivery_status?: "disabled" | "pending" | "delivered" | "failed";
  task_outcome?: TaskOutcomeVector;
  latency?: GoalLatencyState;
  agent_completion_proofs?: {
    subagents?: GoalAgentProofSummary;
    review?: GoalAgentProofSummary;
  };
}

export type AcceptanceCategory =
  | "functional"
  | "visual"
  | "regression"
  | "security"
  | "performance"
  | "forbidden"
  | "evidence";

export type AcceptanceVerifier = "command" | "browser" | "diff" | "review" | "manual" | "state";
export type AcceptanceItemStatus = "pending" | "passed" | "failed" | "blocked" | "not_covered";

export interface AcceptanceItem {
  id: string;
  category: AcceptanceCategory;
  description: string;
  blocking: boolean;
  verifier: AcceptanceVerifier;
  verifier_config?: Record<string, unknown>;
  status: AcceptanceItemStatus;
  evidence_ids: string[];
  evidence_paths: string[];
  failure_reason?: string;
}

export interface AcceptanceContract {
  version: 1;
  items: AcceptanceItem[];
  compiled_at: string;
  source: "user" | "project" | "inferred";
}

export interface AcceptanceItemInput {
  id?: string;
  category?: AcceptanceCategory;
  description: string;
  blocking?: boolean;
  verifier?: AcceptanceVerifier;
  verifier_config?: Record<string, unknown>;
}

export interface AcceptanceContractInput {
  version: 1;
  items: AcceptanceItemInput[];
  source?: "user" | "project" | "inferred";
}

export interface AcceptanceEvaluationSummary {
  blocking_passed: boolean;
  blocking_failed_ids: string[];
  blocking_not_covered_ids: string[];
  pending_ids: string[];
  passed_ids: string[];
  evaluated_at: string;
}

export interface GoalEvidenceRecord {
  evidence_id: string;
  contract_version?: number;
  type: "command_log" | "browser_snapshot" | "screenshot" | "network" | "console" | "diff" | "review" | "state" | "manual";
  created_at: string;
  source: string;
  path?: string;
  summary: string;
  hash?: string;
  related_acceptance_ids: string[];
  trustworthy: boolean;
  limitations: string[];
}

export interface GoalValidationResult extends Record<string, unknown> {
  run_id?: string;
  started_at?: string;
  duration_ms?: number;
  acceptance_duration_ms?: number;
  ok: boolean;
  status: "passed" | "skipped" | "incomplete" | "failed" | "resource_wait_timeout" | "blocked_by_bash_policy" | "blocked_by_resource_policy";
  profile: string;
  report_path: string;
  commands: Array<{
    name: string;
    command: string;
    requested_command: string;
    effective_command: string;
    rewrite_reason?: string;
    exit_code: number | null;
    duration_ms: number;
    spawn_attempted: boolean;
    process_started: boolean;
    blocked_before_spawn: boolean;
    blocked: boolean;
    resource_wait_timed_out: boolean;
    policy_layer?: "cpu_resource_policy" | "bash_allowlist";
    policy_rule?: string;
    reason?: string;
    suggestion?: string;
    principal: "acceptance_verifier";
    resource_profile: "acceptance-test" | "acceptance-full-test";
    test_scope: "targeted" | "full";
    browser_smoke_summary?: Record<string, unknown>;
  }>;
  acceptance_evaluation?: AcceptanceEvaluationSummary;
  completed_at: string;
}

export interface GoalReviewResult extends Record<string, unknown> {
  ok: boolean;
  summary: string;
  completed_at: string;
  mode?: AdvisoryReviewReport["mode"];
  target?: AdvisoryReviewReport["target"];
  findings?: AdvisoryReviewReport["findings"];
  reviewed_files?: string[];
  uncovered_scope?: string[];
  workspace_unchanged?: boolean;
  reviewer_run_id?: string | null;
  task_contract_hash?: string;
  completion_class?: AgentCompletionClass;
  verified?: boolean;
  proof_path?: string | null;
  proof_valid?: boolean;
  proof_invalid_reasons?: string[];
  gate_passed?: boolean;
  blocking_findings?: AdvisoryReviewReport["findings"];
  critical_uncovered_scope?: string[];
  review_policy?: Record<string, unknown>;
  acceptance_evaluation?: AcceptanceEvaluationSummary;
  minimal_sufficiency_review?: MinimalSufficiencyReview;
  change_footprint?: ChangeFootprint;
  error?: string;
}

export type GoalSubagentResult = SubagentBatchReport;

export interface GoalRecord {
  goal_id: string;
  run_id: string;
  status: GoalStatus;
  project_root: string;
  base_branch: string;
  codex_thread_id: string | null;
  objective: string;
  constraints: string[];
  acceptance: string[];
  acceptance_contract: AcceptanceContract;
  goal_contract: GoalContractV1;
  contract_amendments: GoalContractAmendment[];
  active_run_contract_version: number | null;
  loop_state: LoopState;
  evidence: GoalEvidenceRecord[];
  snapshot_id: string | null;
  last_event_sequence: number;
  checkpoint: GoalCheckpoint | null;
  idempotency_key: string;
  changed_files: string[];
  subagent_result: GoalSubagentResult | null;
  validation_result: GoalValidationResult | null;
  review_result: GoalReviewResult | null;
  failure: GoalFailure | null;
  hook_delivery: GoalHookDeliveryState | null;
  final_notification_sent: boolean;
  created_at: string;
  updated_at: string;
}

export interface GoalEvent {
  sequence: number;
  goal_id: string;
  run_id: string;
  contract_version?: number;
  type: string;
  timestamp: string;
  status: GoalStatus;
  data?: Record<string, unknown>;
}

export interface GoalStartInput {
  goal_id?: string;
  objective: string;
  constraints?: string[];
  acceptance?: string[];
  acceptance_contract?: AcceptanceContractInput;
  goal_contract?: GoalContractInput;
  subagents?: ReadOnlyAgentTask[];
  initial_checkpoint?: GoalCheckpoint;
  idempotency_key: string;
  sandbox_mode?: CodexSandboxMode;
  approval_policy?: CodexApprovalPolicy;
  model?: string;
  reasoning_effort?: CodexReasoningEffort;
  network_access_enabled?: boolean;
  skip_git_repo_check?: boolean;
}

export interface GoalResumeInput {
  goal_id: string;
  prompt: string;
  idempotency_key?: string;
  contract_version?: number;
  plan_sha256?: string | null;
  execution_profile_upgrade?: GoalExecutionProfileUpgrade;
}

export interface GoalAmendmentInput extends GoalContractAmendmentInput {
  goal_id: string;
  expected_contract_version?: number;
}

export interface GoalInspection {
  goal: GoalRecord;
  events: GoalEvent[];
  validation: GoalValidationResult | null;
  review: GoalReviewResult | null;
  result: Record<string, unknown> | null;
}

export interface GoalCreateResult {
  goal: GoalRecord;
  created: boolean;
}

export class GoalStoreError extends Error {
  readonly code:
    | "goal_not_found"
    | "invalid_goal_id"
    | "invalid_transition"
    | "terminal_conflict"
    | "idempotency_conflict"
    | "contract_changed"
    | "execution_profile_changed"
    | "invalid_input";

  constructor(code: GoalStoreError["code"], message: string) {
    super(message);
    this.name = "GoalStoreError";
    this.code = code;
  }
}

export function isGoalTerminal(status: GoalStatus): status is GoalTerminalStatus {
  return status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled";
}
