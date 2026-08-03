export type ExecutionControlMode = "runtime" | "benchmark" | "high_risk_delivery";

export type TaskExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type TaskValidationStatus =
  | "not_requested"
  | "pending"
  | "passed"
  | "failed"
  | "skipped";

export type TaskDeliveryStatus =
  | "not_requested"
  | "not_ready"
  | "ready"
  | "committed"
  | "push_waiting_security_baseline"
  | "pushed"
  | "failed"
  | "delivery_unknown";

export type TaskEvidenceStatus =
  | "not_required"
  | "pending"
  | "complete"
  | "partial"
  | "unavailable";

export interface TaskOutcomeVector {
  version: 1;
  execution_status: TaskExecutionStatus;
  validation_status: TaskValidationStatus;
  delivery_status: TaskDeliveryStatus;
  evidence_status: TaskEvidenceStatus;
  primary_reason_code: string | null;
  blocked_capability: string | null;
  recoverable: boolean;
  updated_at: string;
}

export type TaskCompletionStatus =
  | "not_requested"
  | "pending"
  | "running"
  | "completed"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface TaskCompletionStateV1 {
  version: 1;
  analysis_status: TaskCompletionStatus;
  implementation_status: TaskCompletionStatus;
  validation_status: TaskCompletionStatus;
  browser_acceptance_status: TaskCompletionStatus;
  git_prepare_status: TaskCompletionStatus;
  git_commit_status: TaskCompletionStatus;
  git_push_status: TaskCompletionStatus;
  deployment_status: TaskCompletionStatus;
  post_deploy_check_status: TaskCompletionStatus;
  completion_level: string;
  closure_ready: boolean;
  required_gates: string[];
  unsatisfied_gates: string[];
  terminal_reason: string | null;
}

export interface DeriveTaskCompletionStateInput {
  outcome: TaskOutcomeVector;
  browser_acceptance_status?: TaskCompletionStatus;
  git_prepare_status?: TaskCompletionStatus;
  git_commit_status?: TaskCompletionStatus;
  git_push_status?: TaskCompletionStatus;
  deployment_status?: TaskCompletionStatus;
  post_deploy_check_status?: TaskCompletionStatus;
  required_gates?: Array<keyof Omit<TaskCompletionStateV1, "version" | "completion_level" | "closure_ready" | "required_gates" | "unsatisfied_gates" | "terminal_reason">>;
  terminal_reason?: string | null;
}

function completionSatisfied(value: TaskCompletionStatus): boolean {
  return value === "completed" || value === "passed" || value === "skipped";
}

export function deriveTaskCompletionState(input: DeriveTaskCompletionStateInput): TaskCompletionStateV1 {
  const execution = input.outcome.execution_status;
  const analysis: TaskCompletionStatus = execution === "pending" ? "pending" : "completed";
  const implementation: TaskCompletionStatus = execution;
  const validation: TaskCompletionStatus = input.outcome.validation_status;
  const state = {
    analysis_status: analysis,
    implementation_status: implementation,
    validation_status: validation,
    browser_acceptance_status: input.browser_acceptance_status ?? "not_requested",
    git_prepare_status: input.git_prepare_status ?? "not_requested",
    git_commit_status: input.git_commit_status ?? "not_requested",
    git_push_status: input.git_push_status ?? "not_requested",
    deployment_status: input.deployment_status ?? "not_requested",
    post_deploy_check_status: input.post_deploy_check_status ?? "not_requested"
  };
  const required = [...new Set(input.required_gates ?? [])];
  const unsatisfied = required.filter((gate) => !completionSatisfied(state[gate]));
  let level = "已分析";
  if (["failed", "blocked", "cancelled"].includes(state.implementation_status)) level = state.implementation_status === "failed" ? "实现失败" : state.implementation_status === "blocked" ? "实现受阻" : "已取消";
  else if (state.validation_status === "failed") level = "已实现，验证失败";
  else if (state.browser_acceptance_status === "failed") level = "代码检查通过，浏览器验收失败";
  else if (state.git_commit_status === "failed") level = "验收通过，提交失败";
  else if (state.git_push_status === "failed") level = "已提交，推送失败";
  else if (completionSatisfied(state.post_deploy_check_status)) level = "发布后检查通过";
  else if (completionSatisfied(state.deployment_status)) level = "已部署";
  else if (completionSatisfied(state.git_push_status)) level = "已推送";
  else if (completionSatisfied(state.git_commit_status)) level = "已提交";
  else if (completionSatisfied(state.browser_acceptance_status)) level = "浏览器验收通过";
  else if (completionSatisfied(state.validation_status)) level = "代码检查通过";
  else if (state.implementation_status === "completed") level = "已实现未验证";
  else if (state.implementation_status === "running") level = "正在实现";
  const closureReady = required.length > 0 && unsatisfied.length === 0;
  return {
    version: 1,
    ...state,
    completion_level: closureReady ? "已结案" : level,
    closure_ready: closureReady,
    required_gates: required,
    unsatisfied_gates: unsatisfied,
    terminal_reason: input.terminal_reason?.trim() || (closureReady ? "all_required_gates_satisfied" : null)
  };
}

export interface DeriveTaskOutcomeInput {
  domain_status: string;
  validation_status?: string | null;
  validation_ok?: boolean | null;
  failure_domain?: string | null;
  failure_code?: string | null;
  failure_retryable?: boolean | null;
  receipt_status?: string | null;
  hook_delivery_status?: string | null;
  has_evidence?: boolean;
  delivery_status?: TaskDeliveryStatus;
  blocked_capability?: string | null;
  updated_at?: string;
}

function validationStatusFrom(input: DeriveTaskOutcomeInput): TaskValidationStatus {
  const status = input.validation_status?.trim().toLowerCase();
  if (status === "passed") return "passed";
  if (status === "skipped") return "skipped";
  if (status === "running" || status === "pending" || status === "resource_wait_timeout") return "pending";
  if (status === "failed" || status === "blocked" || status === "blocked_by_bash_policy" || status === "blocked_by_resource_policy") {
    return "failed";
  }
  if (input.validation_ok === true) return "passed";
  if (input.validation_ok === false) return "failed";
  return "not_requested";
}

function executionStatusFrom(input: DeriveTaskOutcomeInput): TaskExecutionStatus {
  const status = input.domain_status.trim().toLowerCase();
  if (status === "queued" || status === "created") return "pending";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "validating" || status === "reviewing" || status === "succeeded" || status === "completed" || status === "implemented_not_verified") {
    return "completed";
  }
  if (status === "failed") {
    return ["acceptance", "review_gate", "infrastructure_policy"].includes(input.failure_domain ?? "")
      ? "completed"
      : "failed";
  }
  if (status === "blocked") {
    return ["acceptance", "review_gate", "infrastructure_policy"].includes(input.failure_domain ?? "")
      ? "completed"
      : "blocked";
  }
  return "running";
}

function evidenceStatusFrom(input: DeriveTaskOutcomeInput, validation: TaskValidationStatus, execution: TaskExecutionStatus): TaskEvidenceStatus {
  if (input.receipt_status === "failed" || input.receipt_status === "invalid" || input.hook_delivery_status === "failed") return "partial";
  if (input.has_evidence || validation === "passed" || validation === "failed" || validation === "skipped") return "complete";
  if (validation === "pending" || execution === "pending" || execution === "running") return "pending";
  if (validation === "not_requested") return "not_required";
  return "unavailable";
}

export function deriveTaskOutcome(input: DeriveTaskOutcomeInput): TaskOutcomeVector {
  const validation = validationStatusFrom(input);
  const execution = executionStatusFrom(input);
  return {
    version: 1,
    execution_status: execution,
    validation_status: validation,
    delivery_status: input.delivery_status ?? "not_requested",
    evidence_status: evidenceStatusFrom(input, validation, execution),
    primary_reason_code: input.failure_code?.trim() || null,
    blocked_capability: input.blocked_capability?.trim() || null,
    recoverable: input.failure_retryable === true || validation === "pending" || execution === "pending" || execution === "running",
    updated_at: input.updated_at ?? new Date().toISOString()
  };
}

export interface DeriveGitDeliveryStatusInput {
  commit_status: "not_started" | "completed" | "failed";
  push_status: "not_requested" | "waiting_security_baseline" | "already_synced" | "completed" | "failed";
  reason_code?: string | null;
  push_error_code?: string | null;
}

export function deriveGitDeliveryStatus(input: DeriveGitDeliveryStatusInput): TaskDeliveryStatus {
  if (input.push_status === "completed" || input.push_status === "already_synced") return "pushed";
  if (input.push_status === "waiting_security_baseline") return "push_waiting_security_baseline";
  if (input.push_status === "failed") {
    const code = `${input.reason_code ?? ""} ${input.push_error_code ?? ""}`.toLowerCase();
    return code.includes("delivery_unknown") || code.includes("result_unknown") ? "delivery_unknown" : "failed";
  }
  if (input.commit_status === "completed") return "committed";
  if (input.commit_status === "failed") return "failed";
  return "not_ready";
}

export function mergeTaskOutcomeDelivery(
  current: TaskOutcomeVector,
  deliveryStatus: TaskDeliveryStatus,
  options: { reason_code?: string | null; updated_at?: string } = {}
): TaskOutcomeVector {
  return {
    ...current,
    delivery_status: deliveryStatus,
    primary_reason_code: options.reason_code?.trim() || current.primary_reason_code,
    recoverable: deliveryStatus === "not_ready" || deliveryStatus === "push_waiting_security_baseline" || deliveryStatus === "failed" || current.recoverable,
    updated_at: options.updated_at ?? new Date().toISOString()
  };
}
