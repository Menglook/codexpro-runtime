export type CodexAdapterMode = "off" | "auto" | "sdk" | "exec" | "mock";
export type CodexProviderId = "sdk" | "exec" | "mock";

export type CodexRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type CodexNormalizedEventType =
  | "task.started"
  | "task.output"
  | "task.tool_called"
  | "task.waiting_input"
  | "task.waiting_approval"
  | "task.checkpointed"
  | "task.succeeded"
  | "task.failed"
  | "task.cancelled";

export type CodexSandboxMode = "read-only" | "workspace-write";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CodexNormalizedEvent {
  sequence: number;
  type: CodexNormalizedEventType;
  run_id: string;
  thread_id?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface CodexEventDraft {
  type: CodexNormalizedEventType;
  thread_id?: string;
  data?: Record<string, unknown>;
}

export interface CodexTaskInput {
  prompt: string;
  working_directory: string;
  sandbox_mode?: CodexSandboxMode;
  approval_policy?: CodexApprovalPolicy;
  model?: string;
  preferred_provider?: CodexProviderId;
  forced_provider?: CodexProviderId;
  reasoning_effort?: CodexReasoningEffort;
  network_access_enabled?: boolean;
  skip_git_repo_check?: boolean;
}

export interface CodexResumeInput {
  run_id?: string;
  thread_id?: string;
  prompt: string;
  working_directory?: string;
  sandbox_mode?: CodexSandboxMode;
  approval_policy?: CodexApprovalPolicy;
  model?: string;
  preferred_provider?: CodexProviderId;
  forced_provider?: CodexProviderId;
  reasoning_effort?: CodexReasoningEffort;
  network_access_enabled?: boolean;
  skip_git_repo_check?: boolean;
}

export interface CodexRun {
  run_id: string;
  provider: CodexProviderId;
  parent_run_id?: string;
  thread_id?: string;
  working_directory: string;
  sandbox_mode: CodexSandboxMode;
  status: CodexRunStatus;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  final_response?: string;
  error_code?: "auth_required" | "cancelled" | "provider_unavailable" | "resource_wait_timeout" | "no_progress_timeout" | "step_timeout" | "execution_hard_limit" | "cancel_grace_expired" | "heartbeat_persistence_failed" | "termination_failed" | "execution_failed";
  error_message?: string;
  cancel_requested: boolean;
  event_count: number;
  /**
   * Optional liveness hints emitted by adapters. Semantics:
   * host/supervisor pid = CodexPro process supervising the provider;
   * provider pid = in-process provider owner when distinct from the executor;
   * executor pid = managed Codex child process when one exists;
   * owner pid = canonical live owner to display, normally executor_pid ?? provider_pid.
   */
  host_pid?: number;
  supervisor_pid?: number;
  provider_pid?: number;
  executor_pid?: number;
  owner_pid?: number;
  owner_token?: string;
  fencing_token?: number;
  resource_scheduler?: "resource_governor" | "legacy_exec_slot";
  resource_lease_id?: string;
  resource_request_id?: string;
  resource_run_id?: string;
  resource_task_id?: string;
  resource_pools?: string[];
  watcher_pid?: number;
  heartbeat_at?: string;
  heartbeat_lease_ms?: number;
  heartbeat_write_failures?: number;
  last_output_at?: string;
  last_progress_at?: string;
  step_deadline?: string;
  no_progress_deadline?: string;
  hard_deadline?: string;
  termination_reason?:
    | "spawn_unavailable"
    | "permission_denied"
    | "invalid_command"
    | "no_progress_timeout"
    | "step_timeout"
    | "execution_hard_limit"
    | "explicit_cancel"
    | "cancel_grace_expired"
    | "heartbeat_persistence_failed"
    | "spawn_hook_failed"
    | "process_tree_termination_failed"
    | "termination_failed";
  termination_requested_at?: string;
  termination_force_used?: boolean;
}

export interface CodexCapabilities {
  provider: CodexProviderId;
  available: boolean;
  sdk_available: boolean;
  sdk_version?: string;
  cli_available: boolean;
  cli_version?: string;
  authentication: "authenticated" | "auth_required" | "unknown";
  authentication_method?: "chatgpt" | "api_key" | "unknown";
  exec_available: boolean;
  mcp_server_available: boolean;
  supports: {
    start: boolean;
    resume: boolean;
    cancel: boolean;
    streaming: boolean;
    read_only: boolean;
    workspace_write: boolean;
  };
  notes: string[];
}

export interface CodexEventStreamOptions {
  after_sequence?: number;
  follow?: boolean;
}

export interface CodexAdapter {
  readonly provider: CodexProviderId;
  capabilities(): Promise<CodexCapabilities>;
  startTask(input: CodexTaskInput): Promise<CodexRun>;
  resumeTask(input: CodexResumeInput): Promise<CodexRun>;
  cancelTask(runId: string): Promise<CodexRun>;
  getRun(runId: string): Promise<CodexRun>;
  streamEvents(runId: string, options?: CodexEventStreamOptions): AsyncIterable<CodexNormalizedEvent>;
}

export class CodexAdapterError extends Error {
  readonly code: "auth_required" | "run_not_found" | "run_not_resumable" | "provider_unavailable" | "resource_wait_timeout" | "invalid_input";

  constructor(
    code: CodexAdapterError["code"],
    message: string
  ) {
    super(message);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}
