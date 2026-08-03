import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  agentTaskContractHash,
  hashAgentValue,
  validateAgentCompletionProof
} from "../agents/completionProof.js";
import { ReadOnlyAgentCoordinator } from "../agents/readOnlyCoordinator.js";
import type {
  AdvisoryReviewReport,
  ReadOnlyAgentResult,
  ReadOnlyAgentTask,
  ReviewPolicyInput,
  ReviewRequest,
  SubagentBatchReport
} from "../agents/types.js";
import type { CodexProConfig } from "../config.js";
import { CodexAdapterError, type CodexAdapter, type CodexNormalizedEvent, type CodexRun } from "../codex/types.js";
import { gitCurrentBranch, gitHeadSha, gitStatus } from "../gitOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { createHookBridge, type HookBridgeLike } from "../hooks/hookBridge.js";
import { createWorkspaceMessageStore } from "../messages/messageStore.js";
import {
  completeGoalLatencyStage,
  createGoalLatencyState,
  finalizeGoalLatency,
  markGoalModelFirstEvent,
  startGoalLatencyStage
} from "../observability/goalLatency.js";
import { recordGoalModelUsage, recordGoalTerminalUsage } from "../observability/usageProducers.js";
import { createModelRegistry, selectExecutorModel, type ModelRegistry } from "../models/modelRegistry.js";
import { readAcceptanceConfig, readProjectProfile } from "../project/projectConfig.js";
import { redactSensitiveText } from "../redact.js";
import {
  requestForWorkspaceTask,
  isResourceWaitTimeoutError,
  resourceWaitReason,
  ResourceGovernor,
  type ResourceLeaseRecord,
  type ResourcePoolName
} from "../resources/resourceGovernor.js";
import { evaluateTaskRiskProfile } from "../security/riskGate.js";
import { toolDisclosureForTask } from "../server/toolRegistry.js";
import { captureSessionBindings, SessionTreeStore } from "../sessions/sessionTree.js";
import { runAcceptance, type AcceptanceRunResult } from "../workflow/acceptanceEngine.js";
import { statusChangedFiles } from "../workflow/dirtyGuard.js";
import { resolveContextProfile } from "../workflow/contextProfiles.js";
import {
  decideExecutionLane,
  escalateExecutionLane,
  shouldRunModelReview,
  type ExecutionLaneDecision
} from "../workflow/executionLane.js";
import { finishTaskSnapshot, startTaskSnapshot, type TaskSnapshotResult } from "../workflow/taskSnapshot.js";
import type { CompiledTask } from "../workflow/taskCompiler.js";
import { classifyTask, type ToolPolicy } from "../workflow/taskRouter.js";
import {
  createExecutionProfileSnapshot,
  defaultExecutionMcpProfile,
  executionOptionsFromProfile,
  executionProfileRunMismatch,
  reviseExecutionProfileSnapshot,
  upgradeExecutionProfileSnapshot,
  verifyExecutionProfileSnapshot
} from "../workflow/executionProfileSnapshot.js";
import {
  applyLoopDecision,
  classifyLoopFailure,
  evaluateLoopPolicy,
  loopBudgetRemaining,
  loopProgressFingerprint,
  normalizeLoopBudget,
  recordLoopProgress,
  type LoopFailureClassification,
  type LoopState
} from "../workflow/loopPolicy.js";
import { buildChangeFootprint, reviewMinimalSufficiency, type MinimalChangeContract } from "../workflow/minimalChange.js";
import {
  acceptanceContractFingerprint,
  compileAcceptanceContract,
  evaluateAcceptanceContract,
  linkEvidence,
  mergeEvidence,
  reviewEvidence,
  summarizeAcceptanceContract,
  unresolvedBlockingItems,
  validationEvidence
} from "./acceptanceContract.js";
import { sha256Reference, type GoalContractInput } from "./goalContract.js";
import { GoalStore } from "./goalStore.js";
import {
  GoalStoreError,
  isGoalTerminal,
  type GoalAmendmentInput,
  type GoalCheckpoint,
  type GoalExecutionOptions,
  type GoalExecutionProfileSnapshot,
  type GoalFailure,
  type GoalHookEventType,
  type GoalInspection,
  type GoalProviderRunRecord,
  type GoalRecord,
  type GoalResumeInput,
  type GoalStartInput,
  type GoalStatus,
  type GoalTerminalStatus,
  type GoalValidationResult
} from "./types.js";

export interface GoalManagerDependencies {
  startSnapshot?: (taskName: string, notes?: string) => Promise<TaskSnapshotResult>;
  finishSnapshot?: (snapshotId: string, notes?: string) => Promise<TaskSnapshotResult>;
  runAcceptance?: (options?: { profile?: string; changedFiles?: string[]; runId?: string }) => Promise<AcceptanceRunResult>;
  currentBranch?: () => string;
  currentHead?: () => string;
  changedFiles?: () => string[];
  runSubagents?: (tasks: ReadOnlyAgentTask[]) => Promise<SubagentBatchReport>;
  runReview?: (request: ReviewRequest) => Promise<AdvisoryReviewReport>;
  hookBridge?: HookBridgeLike | null;
  recoverOnStart?: boolean;
  mcpProfile?: GoalExecutionProfileSnapshot["mcp_profile"];
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000);
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function compiledTaskFingerprintInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = value as Record<string, unknown>;
  const authorization = task.authorization_decision;
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return task;
  const {
    issued_at: _volatileIssuedAt,
    payload_binding: _authorizationInstanceBinding,
    ...stableAuthorization
  } = authorization as Record<string, unknown>;
  return {
    ...task,
    authorization_decision: stableAuthorization
  };
}

function proofCleanList(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, maxItems);
}

function normalizedSubagentTask(task: ReadOnlyAgentTask, parentGoalId: string): ReadOnlyAgentTask {
  return {
    ...task,
    parent_goal_id: parentGoalId,
    task_id: task.task_id.trim(),
    objective: task.objective.trim(),
    scope: proofCleanList(task.scope, 50),
    context: proofCleanList(task.context, 50)
  };
}

function subagentTaskContract(task: ReadOnlyAgentTask, parentGoalId: string): Record<string, unknown> {
  const normalized = normalizedSubagentTask(task, parentGoalId);
  return {
    version: 1,
    parent_goal_id: parentGoalId,
    task_id: normalized.task_id,
    role: normalized.role,
    objective: normalized.objective,
    scope: normalized.scope ?? [],
    context: normalized.context ?? []
  };
}

function subagentProofOutput(result: ReadOnlyAgentResult): Record<string, unknown> {
  return {
    task_id: result.task_id,
    role: result.role,
    run_id: result.run_id,
    status: result.status,
    summary: result.summary,
    observations: result.observations,
    ...(result.error ? { error: result.error } : {}),
    started_at: result.started_at,
    completed_at: result.completed_at
  };
}

function subagentEvidenceRefs(result: ReadOnlyAgentResult): string[] {
  return result.observations.map((observation, index) =>
    `${result.task_id}:observation:${index + 1}:${observation.file ?? "no-file"}:${observation.line ?? 0}:${hashAgentValue(observation)}`
  );
}

function transientFailure(message: string): boolean {
  return /\b502\b|timeout|timed out|connection reset|econnreset|upstream|stream disconnected/i.test(message);
}

function validationResult(result: AcceptanceRunResult): GoalValidationResult {
  return {
    run_id: result.run_id,
    started_at: result.started_at,
    duration_ms: result.duration_ms,
    acceptance_duration_ms: result.acceptance_duration_ms,
    ok: result.ok,
    status: result.status,
    profile: result.profile,
    report_path: result.report_path,
    commands: result.commands.map((command) => ({
      name: command.name,
      command: command.command,
      requested_command: command.requestedCommand,
      effective_command: command.effectiveCommand,
      ...(command.rewriteReason ? { rewrite_reason: command.rewriteReason } : {}),
      exit_code: command.exitCode,
      duration_ms: command.durationMs,
      spawn_attempted: command.spawnAttempted,
      process_started: command.processStarted,
      blocked_before_spawn: command.blockedBeforeSpawn,
      blocked: command.blocked,
      resource_wait_timed_out: command.resourceWaitTimedOut,
      ...(command.policyLayer ? { policy_layer: command.policyLayer } : {}),
      ...(command.policyRule ? { policy_rule: command.policyRule } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
      ...(command.suggestion ? { suggestion: command.suggestion } : {}),
      principal: command.principal,
      resource_profile: command.resourceProfile,
      test_scope: command.testScope,
      ...(command.browser_smoke_summary ? { browser_smoke_summary: command.browser_smoke_summary as unknown as Record<string, unknown> } : {})
    })),
    completed_at: new Date().toISOString()
  };
}

function executionOptions(input: GoalStartInput): GoalExecutionOptions {
  return {
    sandbox_mode: input.sandbox_mode ?? "read-only",
    approval_policy: input.approval_policy ?? "never",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
    network_access_enabled: input.network_access_enabled ?? false,
    skip_git_repo_check: input.skip_git_repo_check ?? false
  };
}

function checkpointOf(goal: GoalRecord): GoalCheckpoint {
  return {
    ...(goal.checkpoint ?? {}),
    contract_version: goal.goal_contract.contract_version,
    plan_sha256: goal.goal_contract.plan_sha256
  };
}

function executionProfileTaskContractHash(goal: GoalRecord): string {
  return agentTaskContractHash({
    goal_contract: goal.goal_contract,
    compiled_task: goal.checkpoint?.compiled_task ?? null,
    request_fingerprint: goal.checkpoint?.request_fingerprint ?? null
  });
}

function legacyToolPolicy(goal: GoalRecord): ToolPolicy | undefined {
  const disclosure = goal.checkpoint?.tool_disclosure;
  const compiled = goal.checkpoint?.compiled_task as CompiledTask | undefined;
  const allowed = disclosure?.disclosed_tools ?? disclosure?.initial_tools ?? [];
  if (!goal.checkpoint?.execution_lane || !goal.checkpoint?.context_profile || !goal.checkpoint?.execution_options) return undefined;
  return {
    preferred_tools: [...allowed],
    allowed_tools: [...allowed],
    blocked_tools: [],
    source_writes_allowed: goal.goal_contract.tool_permissions.write_source === true,
    ...(compiled?.source_write_policy ? { source_write_policy: compiled.source_write_policy } : {}),
    artifact_writes_allowed: goal.goal_contract.tool_permissions.write_artifacts === true,
    artifact_write_paths: compiled?.artifact_write_paths ?? [],
    bash_allowed: goal.goal_contract.tool_permissions.run_bash === true,
    browser_allowed: goal.goal_contract.tool_permissions.use_browser === true,
    network_allowed: goal.goal_contract.tool_permissions.use_network === true,
    git_allowed: goal.goal_contract.tool_permissions.use_git === true,
    database_write_allowed: goal.goal_contract.database_policy !== "forbidden",
    memory_write_policy: "no",
    notes: ["Migrated from persisted Goal checkpoint fields without rerunning Task Router."]
  };
}

function sameStringList(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function executionRelevantChangedFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "").trim()).filter(Boolean))]
    .filter((file) => !/^(?:\.ai-bridge|\.codexpro\/(?:task-identities|runs|reports|final-acceptance|session-trees))(?:\/|$)/.test(file));
}

const PROVIDER_RUN_HEARTBEAT_LEASE_MS = 30_000;
const PROVIDER_RUN_HEARTBEAT_PERSIST_MS = 5_000;

function pidOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function ownerFingerprint(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token ? `sha256:${createHash("sha256").update(token).digest("hex")}` : undefined;
}

function terminalRunStatus(status: CodexRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export class GoalManager {
  readonly store: GoalStore;
  private readonly recovery: Promise<void>;
  private readonly monitors = new Map<string, Promise<void>>();
  private readonly startSnapshot: NonNullable<GoalManagerDependencies["startSnapshot"]>;
  private readonly finishSnapshot: NonNullable<GoalManagerDependencies["finishSnapshot"]>;
  private readonly acceptanceRunner: NonNullable<GoalManagerDependencies["runAcceptance"]>;
  private readonly branchReader: NonNullable<GoalManagerDependencies["currentBranch"]>;
  private readonly headReader: NonNullable<GoalManagerDependencies["currentHead"]>;
  private readonly changedFileReader: NonNullable<GoalManagerDependencies["changedFiles"]>;
  private readonly subagentRunner?: NonNullable<GoalManagerDependencies["runSubagents"]>;
  private readonly reviewRunner?: NonNullable<GoalManagerDependencies["runReview"]>;
  private readonly hookBridge?: HookBridgeLike;
  private readonly mcpProfile: GoalExecutionProfileSnapshot["mcp_profile"];
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionTree: SessionTreeStore;
  private readonly resourceGovernor: ResourceGovernor;
  private readonly resourceLeases = new Map<string, ResourceLeaseRecord>();
  private readonly resourceHeartbeatTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace,
    private readonly adapter: CodexAdapter,
    dependencies: GoalManagerDependencies = {}
  ) {
    this.store = new GoalStore(config, guard, workspace);
    this.modelRegistry = createModelRegistry(config);
    this.sessionTree = new SessionTreeStore(config, guard, workspace);
    this.resourceGovernor = new ResourceGovernor(config);
    this.startSnapshot = dependencies.startSnapshot ?? ((taskName, notes) => startTaskSnapshot(config, guard, workspace, { taskName, notes }));
    this.finishSnapshot = dependencies.finishSnapshot ?? ((snapshotId, notes) => finishTaskSnapshot(config, guard, workspace, { snapshotId, notes }));
    this.acceptanceRunner = dependencies.runAcceptance ?? ((options) => runAcceptance(config, guard, workspace, {
      ...(options?.profile ? { profile: options.profile } : {}),
      ...(options?.changedFiles ? { changedFiles: options.changedFiles } : {})
    }));
    this.branchReader = dependencies.currentBranch ?? (() => gitCurrentBranch(config, workspace));
    this.headReader = dependencies.currentHead ?? (() => gitHeadSha(config, workspace));
    this.changedFileReader = dependencies.changedFiles ?? (() => statusChangedFiles(gitStatus(config, workspace)));
    const coordinator = config.codexSubagentsEnabled || config.codexReviewEnabled
      ? new ReadOnlyAgentCoordinator(config, guard, workspace, adapter)
      : undefined;
    this.subagentRunner = dependencies.runSubagents
      ?? (config.codexSubagentsEnabled && coordinator ? (tasks) => coordinator.runAnalysis(tasks) : undefined);
    this.reviewRunner = dependencies.runReview
      ?? (config.codexReviewEnabled && coordinator ? (request) => coordinator.runReview(request) : undefined);
    this.hookBridge = dependencies.hookBridge === null
      ? undefined
      : dependencies.hookBridge ?? createHookBridge(config, workspace);
    this.mcpProfile = structuredClone(dependencies.mcpProfile ?? defaultExecutionMcpProfile(config.toolMode));
    const goalRecovery = dependencies.recoverOnStart === false ? Promise.resolve() : this.recoverPersistedGoals();
    this.recovery = goalRecovery.then(() => {
      void this.recoverHookDeliveries().catch(() => undefined);
    });
  }

  async ready(): Promise<void> {
    await this.recovery;
  }

  private executionProfileVerification(goal: GoalRecord, snapshot: GoalExecutionProfileSnapshot) {
    return verifyExecutionProfileSnapshot(snapshot, {
      goal_id: goal.goal_id,
      run_id: goal.run_id,
      working_directory: goal.project_root,
      task_contract_hash: executionProfileTaskContractHash(goal),
      mcp_profile: this.mcpProfile
    });
  }

  private requireExecutionProfile(goal: GoalRecord): GoalExecutionProfileSnapshot {
    const snapshot = goal.checkpoint?.execution_profile_snapshot;
    if (!snapshot) {
      throw new GoalStoreError("execution_profile_changed", `Goal ${goal.goal_id} has no immutable execution profile snapshot.`);
    }
    const verification = this.executionProfileVerification(goal, snapshot);
    if (!verification.valid || !verification.compatible) {
      throw new GoalStoreError(
        "execution_profile_changed",
        `Goal ${goal.goal_id} execution profile ${snapshot.snapshot_id} cannot be used: ${verification.reasons.join(", ") || "unknown mismatch"}.`
      );
    }
    return snapshot;
  }

  private async ensureExecutionProfile(goal: GoalRecord): Promise<GoalRecord> {
    if (goal.checkpoint?.execution_profile_snapshot) {
      this.requireExecutionProfile(goal);
      return goal;
    }
    const options = goal.checkpoint?.execution_options;
    const lane = goal.checkpoint?.execution_lane as ExecutionLaneDecision | undefined;
    const contextProfile = goal.checkpoint?.context_profile;
    const toolPolicy = legacyToolPolicy(goal);
    const provider = goal.checkpoint?.provider_run?.provider
      ?? goal.checkpoint?.execution_provider
      ?? options?.forced_provider
      ?? options?.preferred_provider;
    if (!options || !lane || !contextProfile || !toolPolicy || !provider) {
      throw new GoalStoreError(
        "execution_profile_changed",
        `Goal ${goal.goal_id} lacks persisted execution fields required for a safe legacy profile migration.`
      );
    }
    const modelSelection = goal.checkpoint?.model_selection as {
      selected_model?: { id?: string; model_name?: string };
    } | undefined;
    const snapshot = createExecutionProfileSnapshot({
      goal_id: goal.goal_id,
      run_id: goal.run_id,
      provider,
      model: options.model ?? null,
      model_profile_id: modelSelection?.selected_model?.id ?? null,
      model_resolution: "legacy",
      reasoning_effort: options.reasoning_effort ?? lane.reasoning_effort,
      execution_lane: lane,
      tool_policy: toolPolicy,
      goal_contract: goal.goal_contract,
      sandbox_mode: options.sandbox_mode,
      approval_policy: options.approval_policy,
      mcp_profile: {
        ...this.mcpProfile,
        tool_mode: goal.checkpoint?.tool_disclosure?.mode ?? this.mcpProfile.tool_mode
      },
      context_profile: contextProfile,
      working_directory: goal.project_root,
      inherit_env: this.config.inheritEnv,
      network_access_enabled: options.network_access_enabled,
      skip_git_repo_check: options.skip_git_repo_check,
      adapter_mode: this.config.codexAdapter,
      task_contract_hash: executionProfileTaskContractHash(goal),
      reason: "legacy_migration"
    });
    return await this.store.patch(goal.goal_id, "goal.execution_profile_migrated", (next) => {
      next.checkpoint = {
        ...checkpointOf(next),
        execution_profile_snapshot: snapshot,
        execution_profile_history: [],
        execution_options: executionOptionsFromProfile(snapshot)
      };
    }, {
      snapshot_id: snapshot.snapshot_id,
      snapshot_version: snapshot.snapshot_version,
      profile_hash: snapshot.profile_hash,
      reason: snapshot.reason
    });
  }

  private providerRunFromCodexRun(
    goal: GoalRecord,
    run: CodexRun,
    operation: GoalProviderRunRecord["operation"],
    previous?: GoalProviderRunRecord
  ): GoalProviderRunRecord {
    const now = new Date().toISOString();
    const heartbeatAt = run.heartbeat_at ?? now;
    const providerPid = pidOrNull(run.provider_pid) ?? (run.provider === "sdk" || run.provider === "exec" || run.provider === "mock" ? process.pid : null);
    const executorPid = pidOrNull(run.executor_pid);
    const ownerPid = pidOrNull(run.owner_pid) ?? executorPid ?? providerPid ?? pidOrNull(run.supervisor_pid) ?? process.pid;
    const completedAt = run.completed_at ?? (terminalRunStatus(run.status) ? now : null);
    return {
      version: 1,
      provider: run.provider,
      run_id: run.run_id,
      thread_id: run.thread_id ?? previous?.thread_id ?? null,
      operation,
      contract_version: goal.goal_contract.contract_version,
      sandbox_mode: run.sandbox_mode,
      status: run.status,
      host_pid: pidOrNull(run.host_pid) ?? process.pid,
      supervisor_pid: pidOrNull(run.supervisor_pid) ?? process.pid,
      provider_pid: providerPid,
      executor_pid: executorPid,
      owner_pid: ownerPid,
      ...(ownerFingerprint(run.owner_token) ? { owner_fingerprint: ownerFingerprint(run.owner_token) } : {}),
      ...(run.fencing_token !== undefined ? { fencing_token: run.fencing_token } : {}),
      watcher_pid: pidOrNull(run.watcher_pid),
      started_at: previous?.started_at ?? run.started_at,
      heartbeat_at: heartbeatAt,
      heartbeat_lease_ms: Math.max(1_000, Math.min(run.heartbeat_lease_ms ?? previous?.heartbeat_lease_ms ?? PROVIDER_RUN_HEARTBEAT_LEASE_MS, 30 * 60_000)),
      last_output_at: run.last_output_at ?? previous?.last_output_at ?? heartbeatAt,
      last_event_at: previous?.last_event_at ?? run.updated_at ?? heartbeatAt,
      last_event_sequence: Math.max(previous?.last_event_sequence ?? 0, run.event_count ?? 0),
      completed_at: completedAt,
      status_reason: terminalRunStatus(run.status)
        ? `Adapter reported terminal status ${run.status}.`
        : "Adapter run record is active and matched to this Goal checkpoint."
    };
  }

  private providerRunFromEvent(goal: GoalRecord, codexRunId: string, event: CodexNormalizedEvent): GoalProviderRunRecord {
    const previous = goal.checkpoint?.provider_run?.run_id === codexRunId ? goal.checkpoint.provider_run : undefined;
    const terminalStatus = event.type === "task.succeeded"
      ? "succeeded"
      : event.type === "task.failed"
        ? "failed"
        : event.type === "task.cancelled"
          ? "cancelled"
          : undefined;
    const provider = previous?.provider
      ?? goal.checkpoint?.execution_profile_snapshot?.provider
      ?? goal.checkpoint?.execution_provider
      ?? this.adapter.provider;
    const sandboxMode = previous?.sandbox_mode ?? goal.checkpoint?.execution_options?.sandbox_mode ?? "read-only";
    return {
      version: 1,
      provider,
      run_id: codexRunId,
      thread_id: event.thread_id ?? previous?.thread_id ?? goal.codex_thread_id ?? null,
      operation: previous?.operation ?? "unknown",
      contract_version: goal.goal_contract.contract_version,
      sandbox_mode: sandboxMode,
      status: terminalStatus ?? (previous?.status === "queued" || previous?.status === "unknown" ? "running" : previous?.status ?? "running"),
      host_pid: previous?.host_pid ?? process.pid,
      supervisor_pid: previous?.supervisor_pid ?? process.pid,
      provider_pid: previous?.provider_pid ?? (provider === "sdk" || provider === "exec" || provider === "mock" ? process.pid : null),
      executor_pid: previous?.executor_pid ?? null,
      owner_pid: previous?.owner_pid ?? previous?.executor_pid ?? previous?.provider_pid ?? process.pid,
      ...(previous?.owner_fingerprint ? { owner_fingerprint: previous.owner_fingerprint } : {}),
      ...(previous?.fencing_token !== undefined ? Object.fromEntries([["fencing_token", previous.fencing_token]]) : {}),
      watcher_pid: previous?.watcher_pid ?? null,
      started_at: previous?.started_at ?? event.timestamp,
      heartbeat_at: event.timestamp,
      heartbeat_lease_ms: previous?.heartbeat_lease_ms ?? PROVIDER_RUN_HEARTBEAT_LEASE_MS,
      last_output_at: event.timestamp,
      last_event_at: event.timestamp,
      last_event_sequence: Math.max(previous?.last_event_sequence ?? 0, event.sequence),
      completed_at: terminalStatus ? event.timestamp : previous?.completed_at ?? null,
      status_reason: terminalStatus
        ? `Provider event ${event.type} closed the run.`
        : `Provider event ${event.type} refreshed the run heartbeat.`
    };
  }

  private closeProviderRun(goal: GoalRecord, status: GoalTerminalStatus, timestamp = new Date().toISOString()): GoalProviderRunRecord | undefined {
    const previous = goal.checkpoint?.provider_run;
    if (!previous) return undefined;
    return {
      ...previous,
      status: status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed",
      heartbeat_at: timestamp,
      last_event_at: timestamp,
      completed_at: timestamp,
      status_reason: `Goal entered terminal status ${status}; provider run is no longer considered active.`
    };
  }

  private recoveredProviderRun(goal: GoalRecord, reason: string): GoalProviderRunRecord | undefined {
    const previous = goal.checkpoint?.provider_run;
    if (!previous) return undefined;
    return {
      ...previous,
      status: "unknown",
      status_reason: reason
    };
  }

  private async persistProviderHeartbeat(goalId: string, run: CodexRun, operation: "start" | "resume" | "unknown" = "unknown"): Promise<void> {
    const current = await this.store.loadGoal(goalId).catch(() => undefined);
    if (!current || isGoalTerminal(current.status)) return;
    if (current.checkpoint?.codex_run_id !== run.run_id) return;
    if (current.active_run_contract_version !== current.goal_contract.contract_version) return;
    const previous = current.checkpoint?.provider_run?.run_id === run.run_id ? current.checkpoint.provider_run : undefined;
    const previousHeartbeat = previous?.heartbeat_at ? Date.parse(previous.heartbeat_at) : 0;
    if (Number.isFinite(previousHeartbeat) && Date.now() - previousHeartbeat < PROVIDER_RUN_HEARTBEAT_PERSIST_MS) return;
    await this.store.patchMetadata(goalId, "goal.provider_heartbeat", (goal) => {
      goal.checkpoint = {
        ...checkpointOf(goal),
        provider_run: this.providerRunFromCodexRun(goal, run, previous?.operation === "start" || previous?.operation === "resume" ? previous.operation : operation, previous)
      };
    }, {
      codex_run_id: run.run_id,
      provider: run.provider,
      owner_pid: pidOrNull(run.owner_pid) ?? pidOrNull(run.executor_pid) ?? pidOrNull(run.provider_pid) ?? process.pid
    });
  }

  private baselineGitSha(): string {
    try {
      return this.headReader().trim() || "unknown";
    } catch {
      return "unborn";
    }
  }

  private goalResourceRequest(goal: GoalRecord, operation: "start" | "resume") {
    const checkpoint = goal.checkpoint ?? {};
    const route = checkpoint.task_route && typeof checkpoint.task_route === "object"
      ? checkpoint.task_route as Record<string, unknown>
      : undefined;
    const sandboxMode = checkpoint.execution_options?.sandbox_mode ?? "read-only";
    const executionProfile = goal.goal_contract.execution.profile.trim().toLowerCase();
    const browserRequired = route?.requires_browser === true || goal.goal_contract.execution.browser_verification === true;
    const category = browserRequired || executionProfile === "heavy" || executionProfile === "deep"
      ? "heavy"
      : sandboxMode === "workspace-write"
        ? "standard"
        : "lightweight";
    const pools: ResourcePoolName[] = browserRequired ? ["browser_live_verification"] : [];
    const resourceRunId = goal.checkpoint?.codex_run_id ?? goal.goal_id;
    return requestForWorkspaceTask(this.workspace, {
      requestId: `goal:${goal.goal_id}:${operation}:${resourceRunId}`,
      runId: resourceRunId,
      taskId: `goal-${goal.goal_id}`,
      title: goal.objective,
      hasWrites: sandboxMode === "workspace-write",
      category,
      pools,
      priority: goal.goal_contract.execution.priority,
      reason: `Goal ${goal.goal_id} ${operation} resource admission before provider execution.`
    });
  }

  private startGoalResourceHeartbeat(goalId: string, lease: ResourceLeaseRecord): void {
    const existing = this.resourceHeartbeatTimers.get(goalId);
    if (existing) clearInterval(existing);
    let currentLease = lease;
    let heartbeatQueue: Promise<void> = Promise.resolve();
    const intervalMs = Math.max(1_000, Math.min(Math.floor(lease.ttl_ms / 2), 30_000));
    const timer = setInterval(() => {
      heartbeatQueue = heartbeatQueue
        .then(async () => {
          const refreshed = await this.resourceGovernor.heartbeat(currentLease);
          if (!refreshed) {
            const activeTimer = this.resourceHeartbeatTimers.get(goalId);
            if (activeTimer) clearInterval(activeTimer);
            this.resourceHeartbeatTimers.delete(goalId);
            this.resourceLeases.delete(goalId);
            return;
          }
          currentLease = refreshed;
          this.resourceLeases.set(goalId, currentLease);
        })
        .catch(() => undefined);
    }, intervalMs);
    timer.unref();
    this.resourceHeartbeatTimers.set(goalId, timer);
  }

  private async acquireGoalResourceLease(goal: GoalRecord, operation: "start" | "resume"): Promise<ResourceLeaseRecord> {
    const existing = this.resourceLeases.get(goal.goal_id);
    if (existing) return existing;
    const request = this.goalResourceRequest(goal, operation);
    const admission = await this.resourceGovernor.waitForGrant(request, {
      onQueued: async (decision) => {
        const current = await this.store.loadGoal(goal.goal_id).catch(() => undefined);
        if (!current || isGoalTerminal(current.status)) return;
        await this.store.patch(goal.goal_id, "goal.resource_queued", (next) => {
          const checkpoint = {
            ...checkpointOf(next),
            phase: "queued_by_resource_policy",
            resource_wait_reason: resourceWaitReason(decision),
            resource_queue_id: decision.queue.queue_id,
            resource_queue_position: null
          };
          next.checkpoint = checkpoint;
        }, {
          resource_status: "queued_by_resource_policy",
          blocking_reasons: decision.blocking_reasons,
          queue_id: decision.queue.queue_id
        });
      }
    });
    this.resourceLeases.set(goal.goal_id, admission.lease);
    this.startGoalResourceHeartbeat(goal.goal_id, admission.lease);
    await this.store.patch(goal.goal_id, "goal.resource_admitted", (next) => {
      const checkpoint = { ...checkpointOf(next) };
      delete checkpoint.resource_wait_reason;
      delete checkpoint.resource_queue_id;
      delete checkpoint.resource_queue_position;
      next.checkpoint = {
        ...checkpoint,
        resource_lease: {
          lease_id: admission.lease.lease_id,
          request_id: admission.lease.request_id,
          task_id: admission.lease.task_id,
          run_id: admission.lease.run_id ?? null
        }
      };
    }, { resource_status: "admitted", lease_id: admission.lease.lease_id });
    return admission.lease;
  }

  private async releaseGoalResourceLease(goalId: string): Promise<void> {
    const timer = this.resourceHeartbeatTimers.get(goalId);
    if (timer) clearInterval(timer);
    this.resourceHeartbeatTimers.delete(goalId);
    const lease = this.resourceLeases.get(goalId);
    this.resourceLeases.delete(goalId);
    if (lease) {
      await this.resourceGovernor.release(lease);
      return;
    }
    const goal = await this.store.loadGoal(goalId).catch(() => undefined);
    const persisted = goal?.checkpoint?.resource_lease;
    if (persisted) {
      const status = await this.resourceGovernor.status();
      const recoveredLease = status.leases.find((candidate) =>
        candidate.lease_id === persisted.lease_id && candidate.task_id === persisted.task_id
      );
      await this.resourceGovernor.release(recoveredLease);
    }
  }

  private planSha256(planPath: string | null | undefined): string | null {
    const value = planPath?.trim();
    if (!value) return null;
    const resolved = this.guard.resolve(this.workspace, value);
    return sha256Reference(readFileSync(resolved.absPath, "utf8"));
  }

  private assertCurrentContract(goal: GoalRecord, expected?: { contract_version?: number; plan_sha256?: string | null }): void {
    const currentVersion = goal.goal_contract.contract_version;
    const checkpointVersion = goal.checkpoint?.contract_version;
    if (checkpointVersion !== undefined && checkpointVersion !== currentVersion) {
      throw new GoalStoreError(
        "contract_changed",
        `Goal ${goal.goal_id} checkpoint is bound to contract v${checkpointVersion}, but current contract is v${currentVersion}.`
      );
    }
    if (expected?.contract_version !== undefined && expected.contract_version !== currentVersion) {
      throw new GoalStoreError(
        "contract_changed",
        `Goal ${goal.goal_id} contract is v${currentVersion}, not requested v${expected.contract_version}.`
      );
    }
    if (expected?.plan_sha256 !== undefined && expected.plan_sha256 !== goal.goal_contract.plan_sha256) {
      throw new GoalStoreError("contract_changed", `Goal ${goal.goal_id} requested plan hash does not match the current contract.`);
    }
    if (goal.goal_contract.plan_path && goal.goal_contract.plan_sha256) {
      const actual = this.planSha256(goal.goal_contract.plan_path);
      if (actual !== goal.goal_contract.plan_sha256) {
        throw new GoalStoreError(
          "contract_changed",
          `Goal ${goal.goal_id} plan content changed after contract v${currentVersion} was created.`
        );
      }
    }
    if (
      goal.active_run_contract_version !== null
      && goal.active_run_contract_version !== undefined
      && goal.active_run_contract_version !== currentVersion
    ) {
      throw new GoalStoreError(
        "contract_changed",
        `Goal ${goal.goal_id} active execution is bound to contract v${goal.active_run_contract_version}, not current v${currentVersion}.`
      );
    }
  }

  private goalProgressFingerprint(goal: GoalRecord, changedFiles = this.changedFileReader()): string {
    return loopProgressFingerprint({
      status: goal.status,
      phase: goal.checkpoint?.phase,
      changed_files: changedFiles,
      evidence_ids: goal.evidence.map((item) => item.evidence_id),
      contract_version: goal.goal_contract.contract_version
    });
  }

  private nextLoopState(
    goal: GoalRecord,
    options: {
      classification?: LoopFailureClassification;
      phase?: string;
      verification_passed?: boolean;
      progress_fingerprint?: string;
      tool_calls_delta?: number;
      full_validation_runs_delta?: number;
      browser_reconnects_delta?: number;
      repair_rounds_delta?: number;
    } = {}
  ): LoopState {
    const budget = normalizeLoopBudget(goal.goal_contract.retry_budget);
    const progressFingerprint = options.progress_fingerprint ?? this.goalProgressFingerprint(goal);
    const loopDecision = evaluateLoopPolicy({
      state: goal.loop_state,
      budget,
      classification: options.classification,
      phase: options.phase ?? goal.checkpoint?.phase,
      verification_passed: options.verification_passed,
      progress_fingerprint: progressFingerprint
    });
    return applyLoopDecision(goal.loop_state, budget, loopDecision, {
      progress_fingerprint: progressFingerprint,
      tool_calls_delta: options.tool_calls_delta,
      full_validation_runs_delta: options.full_validation_runs_delta,
      browser_reconnects_delta: options.browser_reconnects_delta,
      repair_rounds_delta: options.repair_rounds_delta
    });
  }

  private progressLoopState(goal: GoalRecord, reason: string, options: { tool_calls_delta?: number; full_validation_runs_delta?: number } = {}): LoopState {
    const progressed = recordLoopProgress(
      goal.loop_state,
      goal.goal_contract.retry_budget,
      this.goalProgressFingerprint(goal),
      reason
    );
    if (!options.tool_calls_delta && !options.full_validation_runs_delta) return progressed;
    return {
      ...progressed,
      tool_calls: progressed.tool_calls + (options.tool_calls_delta ?? 0),
      full_validation_runs: progressed.full_validation_runs + (options.full_validation_runs_delta ?? 0),
      budget_remaining: loopBudgetRemaining(
        {
          ...progressed,
          tool_calls: progressed.tool_calls + (options.tool_calls_delta ?? 0),
          full_validation_runs: progressed.full_validation_runs + (options.full_validation_runs_delta ?? 0)
        },
        normalizeLoopBudget(goal.goal_contract.retry_budget)
      )
    };
  }

  async start(input: GoalStartInput): Promise<GoalRecord> {
    let latency = startGoalLatencyStage(createGoalLatencyState(), "queue");
    await this.ready();
    latency = completeGoalLatencyStage(latency, "queue");
    latency = startGoalLatencyStage(latency, "task_compile");
    const objective = input.objective.trim();
    if (!objective) throw new GoalStoreError("invalid_input", "Goal objective cannot be empty.");
    const acceptance = input.acceptance ?? input.acceptance_contract?.items.map((item) => item.description) ?? [];
    const acceptanceContract = compileAcceptanceContract(acceptance, input.acceptance_contract);
    const suppliedContract = input.goal_contract ?? {};
    let options = executionOptions(input);
    const requestedSubagents = input.subagents ?? [];
    if (requestedSubagents.length > 0 && (!this.config.codexSubagentsEnabled || !this.subagentRunner)) {
      throw new GoalStoreError("invalid_input", "This Goal requested read-only subagents, but the T3 subagent feature flag is disabled.");
    }
    latency = completeGoalLatencyStage(latency, "task_compile");
    latency = startGoalLatencyStage(latency, "lane_decision");
    const route = classifyTask(objective, {
      explicitAcceptance: acceptance,
      explicitConstraints: input.constraints ?? [],
      explicitScope: suppliedContract.scope?.include?.length ? suppliedContract.scope.include : suppliedContract.allowed_paths,
      patchesRequested: options.sandbox_mode === "workspace-write",
      commandsRequested: acceptance.length > 0,
      executionLanesEnabled: this.config.executionLanesEnabled,
      explicitReasoningEffort: input.reasoning_effort,
      explicitReviewRequired: acceptanceContract.items.some((item) => item.verifier === "review")
        ? true
        : undefined
    });
    options.reasoning_effort = route.execution_lane.reasoning_effort;
    const toolDisclosure = toolDisclosureForTask(this.config, route.compiled_task);
    const contextProfile = resolveContextProfile(route.execution_lane.lane, this.config.contextProfilesEnabled);
    latency = completeGoalLatencyStage(latency, "lane_decision");
    latency = startGoalLatencyStage(latency, "provider_probe");
    if (
      options.sandbox_mode === "workspace-write"
      && !route.tool_policy.source_writes_allowed
      && route.tool_policy.artifact_writes_allowed !== true
    ) {
      throw new GoalStoreError(
        "invalid_input",
        `Task Router classified this Goal as ${route.mode}, which does not allow workspace writes. Make the write intent explicit or use read-only mode.`
      );
    }
    const modelSelection = selectExecutorModel(
      this.modelRegistry,
      objective,
      input.constraints ?? [],
      acceptance,
      input.model,
      this.adapter.provider,
      route.mode,
      route.risk_level,
      options.sandbox_mode === "workspace-write"
    );
    if (!modelSelection.selected_model) {
      throw new GoalStoreError("invalid_input", `No model can execute this Goal: ${modelSelection.blockers.join(" | ")}`);
    }
    if (!options.model && modelSelection.selected_model.model_name !== "default") {
      options.model = modelSelection.selected_model.model_name;
    }
    options.preferred_provider = modelSelection.selected_model.provider;
    latency = completeGoalLatencyStage(latency, "provider_probe");
    latency = startGoalLatencyStage(latency, "task_compile");
    const planPath = suppliedContract.plan_path?.trim() || null;
    const actualPlanSha256 = planPath ? this.planSha256(planPath) : null;
    if (suppliedContract.plan_sha256 && actualPlanSha256 && suppliedContract.plan_sha256 !== actualPlanSha256) {
      throw new GoalStoreError("contract_changed", `Goal plan hash does not match current content at ${planPath}.`);
    }
    const sourceWritesAllowed = options.sandbox_mode === "workspace-write" && route.tool_policy.source_writes_allowed;
    const artifactWritesAllowed = options.sandbox_mode === "workspace-write" && route.tool_policy.artifact_writes_allowed === true;
    const instructionRef = suppliedContract.original_instruction_ref?.trim() || fingerprint({
      objective,
      constraints: input.constraints ?? [],
      acceptance,
      plan_path: planPath
    });
    const inferredPaths = route.compiled_task.minimal_change_contract.allowed_paths.length
      ? route.compiled_task.minimal_change_contract.allowed_paths
      : route.compiled_task.minimal_change_contract.likely_paths;
    const goalContractInput: GoalContractInput = {
      ...suppliedContract,
      original_instruction_ref: instructionRef,
      baseline_git_sha: suppliedContract.baseline_git_sha?.trim() || this.baselineGitSha(),
      plan_path: planPath,
      plan_sha256: suppliedContract.plan_sha256 ?? actualPlanSha256,
      allowed_paths: sourceWritesAllowed || artifactWritesAllowed
        ? suppliedContract.allowed_paths ?? inferredPaths
        : [],
      forbidden_paths: suppliedContract.forbidden_paths ?? route.compiled_task.minimal_change_contract.forbidden_paths,
      tool_permissions: {
        ...(suppliedContract.tool_permissions ?? {}),
        read_workspace: true,
        write_source: sourceWritesAllowed,
        write_artifacts: artifactWritesAllowed,
        run_bash: route.tool_policy.bash_allowed,
        use_browser: route.tool_policy.browser_allowed,
        use_network: options.network_access_enabled
      },
      side_effect_permissions: {
        ...(suppliedContract.side_effect_permissions ?? {}),
        local_write: sourceWritesAllowed || artifactWritesAllowed,
        network: options.network_access_enabled,
        external_write: options.sandbox_mode === "workspace-write"
          && suppliedContract.side_effect_permissions?.external_write === true
      },
      commit_policy: suppliedContract.commit_policy ?? "manual",
      push_policy: suppliedContract.push_policy ?? "forbidden",
      deploy_policy: suppliedContract.deploy_policy ?? "forbidden",
      database_policy: suppliedContract.database_policy ?? (route.tool_policy.database_write_allowed ? "explicit" : "forbidden"),
      stop_conditions: [
        ...(suppliedContract.stop_conditions ?? []),
        "Stop when contract version or plan hash no longer matches the active execution."
      ],
      deliverables: suppliedContract.deliverables ?? route.compiled_task.deliverables,
      completion_rule: suppliedContract.completion_rule ?? "required_acceptance_and_review_gate"
    };
    const requestFingerprint = fingerprint({
      objective,
      constraints: input.constraints ?? [],
      acceptance,
      acceptance_contract: acceptanceContractFingerprint(acceptanceContract),
      goal_contract: goalContractInput,
      subagents: requestedSubagents,
      execution_options: options,
      task_route: route.mode,
      execution_lane: route.execution_lane,
      tool_disclosure: toolDisclosure,
      context_profile: contextProfile,
      compiled_task: compiledTaskFingerprintInput(route.compiled_task)
    });
    latency = completeGoalLatencyStage(latency, "task_compile");
    latency = startGoalLatencyStage(latency, "snapshot");
    const created = await this.store.createGoal({
      goal_id: input.goal_id,
      project_root: this.workspace.root,
      base_branch: this.branchReader(),
      objective,
      constraints: input.constraints ?? [],
      acceptance,
      acceptance_contract: acceptanceContract,
      baseline_git_sha: goalContractInput.baseline_git_sha ?? this.baselineGitSha(),
      original_instruction_ref: instructionRef,
      goal_contract: goalContractInput,
      idempotency_key: input.idempotency_key,
      request_fingerprint: requestFingerprint,
      checkpoint: {
        ...(input.initial_checkpoint ?? {}),
        phase: "queued",
        latency,
        request_fingerprint: requestFingerprint,
        execution_options: options,
        execution_provider: this.adapter.provider,
        requested_model_provider: modelSelection.selected_model.provider,
        model_selection: modelSelection,
        execution_lane: route.execution_lane,
        tool_disclosure: toolDisclosure,
        context_profile: contextProfile,
        context_expansion_count: 0,
        context_missing_reasons: [],
        task_route: {
          mode: route.mode,
          execution_lane: route.execution_lane.lane,
          reviewer_mode: route.execution_lane.reviewer_mode,
          acceptance_profile: route.execution_lane.acceptance_profile,
          reasoning_effort: route.execution_lane.reasoning_effort,
          tool_mode: toolDisclosure.mode,
          initial_tool_count: toolDisclosure.initial_count,
          disclosed_tool_count: toolDisclosure.disclosed_count,
          context_profile: contextProfile.name,
          context_max_files: contextProfile.max_files_per_task,
          context_max_lines_per_file: contextProfile.max_lines_per_file,
          context_max_total_chars: contextProfile.max_total_chars,
          confidence: route.confidence,
          requires_write: route.requires_write,
          requires_bash: route.requires_bash,
          requires_browser: route.requires_browser,
          source_writes_allowed: route.tool_policy.source_writes_allowed,
          source_write_policy: route.compiled_task.source_write_policy,
          artifact_write_paths: route.compiled_task.artifact_write_paths,
          risk_level: route.risk_level,
          capabilities: route.capabilities,
          phases: route.compiled_task.phases
        },
        compiled_task: route.compiled_task,
        pending_operation: null,
        non_idempotent: options.sandbox_mode === "workspace-write",
        replay_allowed: false,
        codex_run_id: null,
        last_codex_event_sequence: 0
      }
    });
    if (!created.created) return await this.ensureExecutionProfile(created.goal);

    const selectedModel = modelSelection.selected_model;
    const executionProfile = createExecutionProfileSnapshot({
      goal_id: created.goal.goal_id,
      run_id: created.goal.run_id,
      provider: selectedModel.provider,
      model: options.model ?? null,
      model_profile_id: selectedModel.id,
      model_resolution: input.model
        ? "explicit"
        : selectedModel.model_name === "default"
          ? "provider_default"
          : "registry",
      reasoning_effort: route.execution_lane.reasoning_effort,
      execution_lane: route.execution_lane,
      tool_policy: route.tool_policy,
      goal_contract: created.goal.goal_contract,
      sandbox_mode: options.sandbox_mode,
      approval_policy: options.approval_policy,
      mcp_profile: {
        ...this.mcpProfile,
        tool_mode: toolDisclosure.mode
      },
      context_profile: contextProfile,
      working_directory: created.goal.project_root,
      inherit_env: this.config.inheritEnv,
      network_access_enabled: options.network_access_enabled,
      skip_git_repo_check: options.skip_git_repo_check,
      adapter_mode: this.config.codexAdapter,
      task_contract_hash: executionProfileTaskContractHash(created.goal)
    });
    await this.store.patch(created.goal.goal_id, "goal.execution_profile_created", (goal) => {
      goal.checkpoint = {
        ...checkpointOf(goal),
        execution_profile_snapshot: executionProfile,
        execution_profile_history: [],
        execution_options: executionOptionsFromProfile(executionProfile),
        execution_provider: executionProfile.provider
      };
    }, {
      snapshot_id: executionProfile.snapshot_id,
      snapshot_version: executionProfile.snapshot_version,
      profile_hash: executionProfile.profile_hash,
      provider: executionProfile.provider,
      model: executionProfile.model,
      reasoning_effort: executionProfile.reasoning_effort
    });
    options = executionOptionsFromProfile(executionProfile);

    let snapshot: TaskSnapshotResult;
    try {
      snapshot = await this.startSnapshot(`goal-${created.goal.goal_id}`, objective);
    } catch (error) {
      return await this.finalize(created.goal.goal_id, "failed", {
        failure: this.failure("snapshot_start_failed", safeError(error), false)
      });
    }

    let sessionRootNodeId: string;
    try {
      const tree = await this.sessionTree.ensure({
        task_id: `goal-${created.goal.goal_id}`,
        title: objective,
        summary: "Goal execution root created before the first Codex run.",
        bindings: captureSessionBindings(this.config, this.workspace, {
          task_snapshot_id: snapshot.snapshot_id,
          task_snapshot_dir: snapshot.snapshot_dir,
          goal_checkpoint_path: `${this.config.contextDir}/goals/${created.goal.goal_id}/checkpoint.json`
        })
      });
      sessionRootNodeId = tree.root_node_id;
    } catch (error) {
      return await this.finalize(created.goal.goal_id, "failed", {
        failure: this.failure("session_tree_start_failed", safeError(error), false)
      });
    }

    latency = completeGoalLatencyStage(created.goal.checkpoint?.latency, "snapshot");
    latency = startGoalLatencyStage(latency, requestedSubagents.length > 0 ? "context_prepare" : "model_total");
    const runningGoal = await this.store.transition(created.goal.goal_id, "running", "goal.running", {
      data: {
        snapshot_id: snapshot.snapshot_id,
        execution_lane: route.execution_lane.lane,
        lane_reason_codes: route.execution_lane.reason_codes,
        reasoning_effort: route.execution_lane.reasoning_effort,
        reviewer_mode: route.execution_lane.reviewer_mode,
        initial_tool_count: toolDisclosure.initial_count,
        disclosed_tool_count: toolDisclosure.disclosed_count,
        context_profile: contextProfile.name
      },
      patch: (goal) => {
        goal.snapshot_id = snapshot.snapshot_id;
        goal.checkpoint = {
          ...checkpointOf(goal),
          latency,
          phase: "starting_codex",
          pending_operation: "start",
          replay_allowed: false,
          session_tree_root_node_id: sessionRootNodeId,
          session_tree_path: this.sessionTree.treePath(`goal-${created.goal.goal_id}`)
        };
      }
    });
    await this.dispatchHook(runningGoal, "task.started", { source_event_type: "goal.running" });

    let executionPrompt = objective;
    if (requestedSubagents.length > 0) {
      const runner = this.subagentRunner;
      if (!runner) {
        return await this.finalize(created.goal.goal_id, "failed", {
          failure: this.failure("subagents_unavailable", "Read-only subagents were requested but no subagent runner is available.", false)
        });
      }
      try {
        await this.store.patch(created.goal.goal_id, "goal.subagents_started", (goal) => {
          goal.checkpoint = { ...checkpointOf(goal), phase: "subagents", pending_operation: "subagents" };
        }, { requested_tasks: requestedSubagents.length });
        const proofBoundTasks = requestedSubagents.map((task) => normalizedSubagentTask(task, created.goal.goal_id));
        const rawReport = await runner(proofBoundTasks);
        const report = await this.validateSubagentReport(created.goal.goal_id, proofBoundTasks, rawReport);
        await this.recordSubagentStructuredEvents(created.goal.goal_id, proofBoundTasks, report);
        await this.store.patch(created.goal.goal_id, "goal.subagents_completed", (goal) => {
          goal.subagent_result = report;
          const contextLatency = completeGoalLatencyStage(goal.checkpoint?.latency, "context_prepare");
          goal.checkpoint = {
            ...checkpointOf(goal),
            latency: startGoalLatencyStage(contextLatency, "model_total"),
            phase: "subagents_completed",
            pending_operation: null,
            agent_completion_proofs: {
              ...(goal.checkpoint?.agent_completion_proofs ?? {}),
              subagents: {
                status: report.proofs_valid === true ? "verified" : "invalid",
                verified: report.proofs_valid === true,
                proof_paths: report.results.map((result) => result.proof_path).filter((value): value is string => Boolean(value)),
                invalid_reasons: report.results.flatMap((result) => result.proof_invalid_reasons ?? [])
              }
            }
          };
        }, {
          ok: report.ok,
          requested_tasks: report.requested_tasks,
          peak_parallel: report.peak_parallel,
          observation_count: report.observations.length,
          proofs_valid: report.proofs_valid === true,
          invalid_proof_task_ids: report.invalid_proof_task_ids ?? []
        });
        if (!report.ok) {
          return await this.finalize(created.goal.goal_id, "failed", {
            failure: this.failure(
              "subagent_analysis_failed",
              `Read-only subagent analysis failed, changed the workspace, or produced invalid completion proof. Report ok: ${report.ok}; workspace unchanged: ${report.workspace_unchanged}; proofs valid: ${report.proofs_valid === true}; failed tasks: ${report.failed_task_ids.join(", ") || "none"}; invalid proofs: ${(report.invalid_proof_task_ids ?? []).join(", ") || "none"}.`,
              false
            )
          });
        }
        executionPrompt = this.promptWithSubagentReport(objective, report);
      } catch (error) {
        return await this.finalize(created.goal.goal_id, "failed", {
          failure: this.failure("subagent_analysis_error", safeError(error), false)
        });
      }
    }

    try {
      const providerGoal = await this.store.loadGoal(created.goal.goal_id);
      await this.acquireGoalResourceLease(providerGoal, "start");
      const admittedGoal = await this.store.loadGoal(created.goal.goal_id);
      if (isGoalTerminal(admittedGoal.status)) {
        await this.releaseGoalResourceLease(admittedGoal.goal_id);
        return admittedGoal;
      }
      const run = await this.adapter.startTask({
        prompt: executionPrompt,
        working_directory: this.workspace.root,
        sandbox_mode: options.sandbox_mode,
        approval_policy: options.approval_policy,
        model: options.model,
        preferred_provider: options.preferred_provider,
        forced_provider: options.forced_provider,
        reasoning_effort: options.reasoning_effort,
        network_access_enabled: options.network_access_enabled,
        skip_git_repo_check: options.skip_git_repo_check
      });
      const goal = await this.attachCodexRun(created.goal.goal_id, run, "start");
      this.monitor(created.goal.goal_id, run.run_id);
      return goal;
    } catch (error) {
      await this.releaseGoalResourceLease(created.goal.goal_id);
      return await this.handleLaunchFailure(created.goal.goal_id, error, options, "start");
    }
  }

  async status(goalId: string): Promise<GoalInspection> {
    await this.ready();
    return await this.store.readInspection(goalId);
  }

  async amendContract(input: GoalAmendmentInput): Promise<GoalRecord> {
    await this.ready();
    let current = await this.store.loadGoal(input.goal_id);
    current = await this.ensureExecutionProfile(current);
    const currentProfile = this.requireExecutionProfile(current);
    const changes = { ...(input.changes ?? {}) };
    const effectivePlanPath = changes.plan_path === undefined
      ? current.goal_contract.plan_path
      : changes.plan_path;
    if (effectivePlanPath) {
      const actualPlanSha256 = this.planSha256(effectivePlanPath);
      if (changes.plan_sha256 && actualPlanSha256 && changes.plan_sha256 !== actualPlanSha256) {
        throw new GoalStoreError("contract_changed", `Amendment plan hash does not match current content at ${effectivePlanPath}.`);
      }
      if (changes.plan_path !== undefined || actualPlanSha256 !== current.goal_contract.plan_sha256) {
        changes.plan_path = effectivePlanPath;
        changes.plan_sha256 = changes.plan_sha256 ?? actualPlanSha256;
      }
    }
    const amended = await this.store.amendContract(input.goal_id, {
      source: input.source,
      reason: input.reason,
      original_instruction_ref: input.original_instruction_ref,
      changes
    }, input.expected_contract_version);
    const nextProfile = reviseExecutionProfileSnapshot(currentProfile, {
      reason: "explicit_upgrade",
      permission_policy: {
        approval_policy: currentProfile.permission_policy.approval_policy,
        tool_permissions: structuredClone(amended.goal_contract.tool_permissions),
        side_effect_permissions: structuredClone(amended.goal_contract.side_effect_permissions),
        commit_policy: amended.goal_contract.commit_policy,
        push_policy: amended.goal_contract.push_policy,
        deploy_policy: amended.goal_contract.deploy_policy,
        database_policy: amended.goal_contract.database_policy
      },
      task_contract_hash: executionProfileTaskContractHash(amended)
    });
    return await this.store.patch(amended.goal_id, "goal.execution_profile_contract_upgraded", (next) => {
      const history = next.checkpoint?.execution_profile_history ?? [];
      next.checkpoint = {
        ...checkpointOf(next),
        execution_profile_snapshot: nextProfile,
        execution_profile_history: [...history, currentProfile],
        execution_options: executionOptionsFromProfile(nextProfile)
      };
    }, {
      previous_snapshot_id: currentProfile.snapshot_id,
      snapshot_id: nextProfile.snapshot_id,
      snapshot_version: nextProfile.snapshot_version,
      profile_hash: nextProfile.profile_hash,
      contract_version: amended.goal_contract.contract_version,
      reason: input.reason
    });
  }

  async replayTerminalHooks(goalId: string): Promise<GoalRecord> {
    await this.ready();
    const goal = await this.store.loadGoal(goalId);
    if (!isGoalTerminal(goal.status)) {
      throw new GoalStoreError("invalid_transition", `Goal ${goal.goal_id} is not terminal and has no terminal Hook delivery to replay.`);
    }
    if (goal.final_notification_sent) return goal;
    const hookEvent: GoalHookEventType = goal.status === "succeeded"
      ? "task.succeeded"
      : goal.status === "cancelled"
        ? "task.cancelled"
        : "task.failed";
    return await this.dispatchHook(goal, hookEvent, {
      source_event_type: `goal.${goal.status}`,
      manual_replay: true
    });
  }

  async resume(input: GoalResumeInput): Promise<GoalRecord> {
    await this.ready();
    const prompt = input.prompt.trim();
    if (!prompt) throw new GoalStoreError("invalid_input", "Goal resume prompt cannot be empty.");
    let goal = await this.store.loadGoal(input.goal_id);
    this.assertCurrentContract(goal, {
      contract_version: input.contract_version,
      plan_sha256: input.plan_sha256
    });
    if (isGoalTerminal(goal.status)) {
      throw new GoalStoreError("terminal_conflict", `Goal ${goal.goal_id} already ended with ${goal.status}.`);
    }
    if (goal.status !== "waiting_input" && goal.status !== "waiting_approval") {
      throw new GoalStoreError("invalid_transition", `Goal ${goal.goal_id} cannot resume from ${goal.status}.`);
    }
    if (goal.checkpoint?.codex_turn_terminal !== true && goal.checkpoint?.recovery_required !== true) {
      throw new GoalStoreError(
        "invalid_transition",
        `Goal ${goal.goal_id} is waiting, but the current Codex turn is still active. Retry after the turn checkpoint is durable.`
      );
    }

    goal = await this.ensureExecutionProfile(goal);
    let executionProfile = this.requireExecutionProfile(goal);
    if (input.execution_profile_upgrade) {
      const reason = input.execution_profile_upgrade.reason.trim();
      if (!reason) throw new GoalStoreError("invalid_input", "execution_profile_upgrade.reason cannot be empty.");
      if (input.execution_profile_upgrade.provider && input.execution_profile_upgrade.provider !== executionProfile.provider) {
        throw new GoalStoreError(
          "invalid_input",
          "Changing the execution provider requires a new Goal execution; an existing provider thread cannot be silently transferred."
        );
      }
      const nextProfile = upgradeExecutionProfileSnapshot(executionProfile, {
        ...input.execution_profile_upgrade,
        reason
      });
      goal = await this.store.patch(goal.goal_id, "goal.execution_profile_upgraded", (next) => {
        const history = next.checkpoint?.execution_profile_history ?? [];
        const currentLane = next.checkpoint?.execution_lane;
        next.checkpoint = {
          ...checkpointOf(next),
          execution_profile_snapshot: nextProfile,
          execution_profile_history: [...history, executionProfile],
          execution_options: executionOptionsFromProfile(nextProfile),
          execution_provider: nextProfile.provider,
          ...(currentLane ? {
            execution_lane: {
              ...currentLane,
              ...(nextProfile.reasoning_effort ? { reasoning_effort: nextProfile.reasoning_effort } : {})
            }
          } : {}),
          context_profile: nextProfile.context_profile
        };
      }, {
        previous_snapshot_id: executionProfile.snapshot_id,
        snapshot_id: nextProfile.snapshot_id,
        snapshot_version: nextProfile.snapshot_version,
        profile_hash: nextProfile.profile_hash,
        reason
      });
      executionProfile = nextProfile;
    }

    const resumeKey = this.store.hashIdempotencyKey(
      input.idempotency_key ?? `${goal.idempotency_key}:${executionProfile.snapshot_id}:${prompt}`
    );
    if (goal.checkpoint?.last_resume_idempotency_key === resumeKey) return goal;

    if (goal.checkpoint?.recovered_from_status === "validating" || goal.checkpoint?.recovered_from_status === "reviewing") {
      await this.store.transition(goal.goal_id, "validating", "goal.validation_resumed", {
        patch: (next) => {
          next.checkpoint = {
            ...checkpointOf(next),
            latency: startGoalLatencyStage(next.checkpoint?.latency, "validation"),
            phase: "validating",
            pending_operation: "validation",
            last_resume_idempotency_key: resumeKey,
            recovery_required: false
          };
        }
      });
      return await this.validate(goal.goal_id);
    }

    const options = executionOptionsFromProfile(executionProfile);
    if (!goal.codex_thread_id && goal.checkpoint?.retry_launch_operation === "start") {
      goal = await this.store.transition(goal.goal_id, "running", "goal.authorization_retrying", {
        data: { previous_operation: "start" },
        patch: (next) => {
          next.checkpoint = {
            ...checkpointOf(next),
            latency: startGoalLatencyStage(next.checkpoint?.latency, "model_total"),
            phase: "retrying_start_after_authorization",
            pending_operation: "start",
            recovery_required: false,
            replay_allowed: false,
            codex_turn_terminal: false,
            authorization_required: false
          };
        }
      });
      try {
        const executionPrompt = goal.subagent_result
          ? this.promptWithSubagentReport(goal.objective, goal.subagent_result)
          : goal.objective;
        await this.acquireGoalResourceLease(goal, "start");
        const admittedGoal = await this.store.loadGoal(goal.goal_id);
        if (isGoalTerminal(admittedGoal.status)) {
          await this.releaseGoalResourceLease(admittedGoal.goal_id);
          return admittedGoal;
        }
        const run = await this.adapter.startTask({
          prompt: executionPrompt,
          working_directory: goal.project_root,
          sandbox_mode: options.sandbox_mode,
          approval_policy: options.approval_policy,
          model: options.model,
          preferred_provider: options.preferred_provider,
          forced_provider: options.forced_provider,
          reasoning_effort: options.reasoning_effort,
          network_access_enabled: options.network_access_enabled,
          skip_git_repo_check: options.skip_git_repo_check
        });
        const updated = await this.attachCodexRun(goal.goal_id, run, "start");
        this.monitor(goal.goal_id, run.run_id);
        return updated;
      } catch (error) {
        await this.releaseGoalResourceLease(goal.goal_id);
        return await this.handleLaunchFailure(goal.goal_id, error, options, "start");
      }
    }
    if (!goal.codex_thread_id) {
      throw new GoalStoreError("invalid_input", `Goal ${goal.goal_id} has no persisted Codex thread id and cannot be resumed safely.`);
    }
    const recoveredResume = goal.checkpoint?.recovery_required === true;

    goal = await this.store.transition(goal.goal_id, "running", "goal.resuming", {
      data: {
        recovered: recoveredResume,
        execution_profile_snapshot_id: executionProfile.snapshot_id,
        execution_profile_snapshot_version: executionProfile.snapshot_version
      },
      patch: (next) => {
        next.checkpoint = {
          ...checkpointOf(next),
          latency: startGoalLatencyStage(next.checkpoint?.latency, "model_total"),
          phase: "resuming_codex",
          pending_operation: "resume",
          last_resume_idempotency_key: resumeKey,
          recovery_required: false,
          replay_allowed: false,
          codex_turn_terminal: false
        };
      }
    });

    try {
      await this.acquireGoalResourceLease(goal, "resume");
      const admittedGoal = await this.store.loadGoal(goal.goal_id);
      if (isGoalTerminal(admittedGoal.status)) {
        await this.releaseGoalResourceLease(admittedGoal.goal_id);
        return admittedGoal;
      }
      const previousRunId = recoveredResume ? undefined : goal.checkpoint?.codex_run_id;
      let run: CodexRun;
      if (previousRunId) {
        try {
          run = await this.adapter.resumeTask({
            run_id: previousRunId,
            prompt,
            working_directory: executionProfile.working_directory,
            sandbox_mode: executionProfile.sandbox_policy.sandbox_mode,
            approval_policy: executionProfile.permission_policy.approval_policy,
            model: executionProfile.model ?? undefined,
            preferred_provider: executionProfile.provider,
            forced_provider: executionProfile.provider,
            reasoning_effort: executionProfile.reasoning_effort ?? undefined,
            network_access_enabled: executionProfile.environment_policy.network_access_enabled,
            skip_git_repo_check: executionProfile.environment_policy.skip_git_repo_check
          });
        } catch (error) {
          if (!(error instanceof CodexAdapterError) || error.code !== "run_not_found") throw error;
          run = await this.resumePersistedThread(goal, prompt, executionProfile);
        }
      } else {
        run = await this.resumePersistedThread(goal, prompt, executionProfile);
      }
      const updated = await this.attachCodexRun(goal.goal_id, run, "resume");
      this.monitor(goal.goal_id, run.run_id);
      return updated;
    } catch (error) {
      await this.releaseGoalResourceLease(goal.goal_id);
      return await this.handleLaunchFailure(goal.goal_id, error, options, "resume");
    }
  }

  async cancel(goalId: string): Promise<GoalRecord> {
    await this.ready();
    const goal = await this.store.loadGoal(goalId);
    if (isGoalTerminal(goal.status)) return goal;
    const codexRunId = goal.checkpoint?.codex_run_id;
    if (codexRunId) {
      try {
        await this.adapter.cancelTask(codexRunId);
      } catch (error) {
        if (!(error instanceof CodexAdapterError) || error.code !== "run_not_found") {
          await this.store.patch(goal.goal_id, "goal.cancel_warning", (next) => {
            next.checkpoint = { ...checkpointOf(next), last_error: safeError(error) };
          });
        }
      }
    }
    return await this.finalize(goal.goal_id, "cancelled", {});
  }

  async recoverPersistedGoals(): Promise<void> {
    const goals = await this.store.listGoals();
    for (const persistedGoal of goals) {
      if (isGoalTerminal(persistedGoal.status)) continue;
      let goal = persistedGoal;
      try {
        this.assertCurrentContract(goal);
      } catch (error) {
        if (!(error instanceof GoalStoreError) || error.code !== "contract_changed") throw error;
        const reason = safeError(error);
        const classification = classifyLoopFailure({ code: "contract_changed", message: reason, contract_changed: true });
        if (["queued", "running", "validating", "reviewing"].includes(goal.status)) {
          const blocked = await this.store.transition(goal.goal_id, "waiting_input", "goal.contract_recovery_blocked", {
            data: { contract_version: goal.goal_contract.contract_version, reason },
            patch: (next) => {
              next.active_run_contract_version = null;
              next.loop_state = this.nextLoopState(next, { classification, phase: "contract_changed" });
              next.checkpoint = {
                ...checkpointOf(next),
                phase: "contract_changed",
                pending_operation: null,
                recovery_required: true,
                recovery_reason: reason,
                replay_allowed: false,
                provider_run: this.recoveredProviderRun(next, reason)
              };
            }
          });
          await this.dispatchHook(blocked, "task.waiting_input", { source_event_type: "goal.contract_recovery_blocked" });
        } else {
          await this.store.patch(goal.goal_id, "goal.contract_recovery_blocked", (next) => {
            next.active_run_contract_version = null;
            next.loop_state = this.nextLoopState(next, { classification, phase: "contract_changed" });
            next.checkpoint = {
              ...checkpointOf(next),
              phase: "contract_changed",
              pending_operation: null,
              recovery_required: true,
              recovery_reason: reason,
              replay_allowed: false,
              provider_run: this.recoveredProviderRun(next, reason)
            };
          }, { contract_version: goal.goal_contract.contract_version, reason });
        }
        continue;
      }
      try {
        goal = await this.ensureExecutionProfile(goal);
      } catch (error) {
        if (!(error instanceof GoalStoreError) || error.code !== "execution_profile_changed") throw error;
        const reason = safeError(error);
        await this.recordExecutionSnapshotStructuredEvent(goal, "execution.snapshot_mismatch", reason);
        if (["queued", "running", "validating", "reviewing"].includes(goal.status)) {
          const blocked = await this.store.transition(goal.goal_id, "waiting_input", "goal.execution_profile_recovery_blocked", {
            data: { reason, replayed: false },
            patch: (next) => {
              next.active_run_contract_version = null;
              next.checkpoint = {
                ...checkpointOf(next),
                phase: "execution_profile_changed",
                pending_operation: null,
                recovery_required: true,
                recovery_reason: reason,
                replay_allowed: false,
                provider_run: this.recoveredProviderRun(next, reason)
              };
            }
          });
          await this.dispatchHook(blocked, "task.waiting_input", { source_event_type: "goal.execution_profile_recovery_blocked" });
        } else {
          await this.store.patch(goal.goal_id, "goal.execution_profile_recovery_blocked", (next) => {
            next.active_run_contract_version = null;
            next.checkpoint = {
              ...checkpointOf(next),
              phase: "execution_profile_changed",
              pending_operation: null,
              recovery_required: true,
              recovery_reason: reason,
              replay_allowed: false,
              provider_run: this.recoveredProviderRun(next, reason)
            };
          }, { reason, replayed: false });
        }
        continue;
      }
      const executionProfile = this.requireExecutionProfile(goal);
      await this.recordExecutionSnapshotStructuredEvent(goal, "execution.snapshot_loaded", "Recovered immutable execution profile snapshot without rerouting.");
      const previousStatus = goal.status;
      if (previousStatus === "queued" || previousStatus === "running" || previousStatus === "validating" || previousStatus === "reviewing") {
        const recovered = await this.store.transition(goal.goal_id, "waiting_input", "goal.recovered", {
          data: {
            recovered_from_status: previousStatus,
            replayed: false,
            execution_profile_snapshot_id: executionProfile.snapshot_id,
            execution_profile_snapshot_version: executionProfile.snapshot_version,
            execution_profile_hash: executionProfile.profile_hash
          },
          patch: (next) => {
            next.loop_state = this.progressLoopState(next, "Process recovery restored the Goal to a durable waiting checkpoint.");
            next.checkpoint = {
              ...checkpointOf(next),
              phase: "recovery_waiting_input",
              pending_operation: null,
              recovery_required: true,
              recovered_from_status: previousStatus,
              recovery_reason: "The previous process ended before a durable terminal state. Manual resume or cancel is required.",
              replay_allowed: false,
              execution_profile_recovery: {
                snapshot_id: executionProfile.snapshot_id,
                snapshot_version: executionProfile.snapshot_version,
                recovered_at: new Date().toISOString(),
                source_status: previousStatus,
                reason: "Service restart recovered the immutable execution profile without rerouting."
              },
              provider_run: this.recoveredProviderRun(next, "Service restart recovery preserved the prior provider run as historical evidence; no replay was started.")
            };
          }
        });
        await this.dispatchHook(recovered, "task.waiting_input", { source_event_type: "goal.recovered" });
      } else {
        await this.store.patch(goal.goal_id, "goal.recovered", (next) => {
          next.loop_state = this.progressLoopState(next, "Process recovery restored the persisted Goal state without replaying work.");
          next.checkpoint = {
            ...checkpointOf(next),
            recovery_required: true,
            recovered_from_status: previousStatus,
            recovery_reason: "Goal state was restored after process restart; no Codex task was started automatically.",
            replay_allowed: false,
            execution_profile_recovery: {
              snapshot_id: executionProfile.snapshot_id,
              snapshot_version: executionProfile.snapshot_version,
              recovered_at: new Date().toISOString(),
              source_status: previousStatus,
              reason: "Service restart recovered the immutable execution profile without rerouting."
            },
            provider_run: this.recoveredProviderRun(next, "Service restart recovery preserved the prior provider run as historical evidence; no replay was started.")
          };
        }, {
          recovered_from_status: previousStatus,
          replayed: false,
          execution_profile_snapshot_id: executionProfile.snapshot_id,
          execution_profile_snapshot_version: executionProfile.snapshot_version,
          execution_profile_hash: executionProfile.profile_hash
        });
      }
    }
  }

  private async resumePersistedThread(
    goal: GoalRecord,
    prompt: string,
    executionProfile: GoalExecutionProfileSnapshot
  ): Promise<CodexRun> {
    return await this.adapter.resumeTask({
      thread_id: goal.codex_thread_id ?? undefined,
      prompt,
      working_directory: executionProfile.working_directory,
      sandbox_mode: executionProfile.sandbox_policy.sandbox_mode,
      approval_policy: executionProfile.permission_policy.approval_policy,
      model: executionProfile.model ?? undefined,
      preferred_provider: executionProfile.provider,
      forced_provider: executionProfile.provider,
      reasoning_effort: executionProfile.reasoning_effort ?? undefined,
      network_access_enabled: executionProfile.environment_policy.network_access_enabled,
      skip_git_repo_check: executionProfile.environment_policy.skip_git_repo_check
    });
  }

  private async attachCodexRun(goalId: string, run: CodexRun, phase: "start" | "resume"): Promise<GoalRecord> {
    const current = await this.store.loadGoal(goalId);
    const executionProfile = this.requireExecutionProfile(current);
    const runMismatches = executionProfileRunMismatch(executionProfile, run);
    if (runMismatches.length) {
      throw new GoalStoreError(
        "execution_profile_changed",
        `Codex run ${run.run_id} does not match execution profile ${executionProfile.snapshot_id}: ${runMismatches.join(", ")}.`
      );
    }
    const routedAdapter = this.adapter as CodexAdapter & {
      selectionForRun?: (runId: string) => Record<string, unknown> | undefined;
    };
    const providerSelection = routedAdapter.selectionForRun?.(run.run_id);
    const attached = await this.store.patch(goalId, "goal.codex_attached", (goal) => {
      if (run.thread_id) goal.codex_thread_id = run.thread_id;
      goal.active_run_contract_version = goal.goal_contract.contract_version;
      goal.loop_state = this.progressLoopState(goal, `Codex ${phase} run attached.`, { tool_calls_delta: 1 });
      goal.checkpoint = {
        ...checkpointOf(goal),
        phase: `${phase}_codex_running`,
        pending_operation: null,
        codex_run_id: run.run_id,
        last_codex_event_sequence: 0,
        replay_allowed: false,
        execution_provider: run.provider,
        provider_run: this.providerRunFromCodexRun(goal, run, phase),
        ...(providerSelection ? { provider_selection: providerSelection } : {})
      };
    }, {
      contract_version: current.goal_contract.contract_version,
      execution_profile_snapshot_id: executionProfile.snapshot_id,
      execution_profile_snapshot_version: executionProfile.snapshot_version,
      codex_run_id: run.run_id,
      thread_id: run.thread_id ?? null,
      effective_provider: run.provider,
      provider_selection: providerSelection ?? null
    });
    return await this.dispatchHook(attached, "task.checkpointed", {
      source_event_type: "goal.codex_attached"
    });
  }

  private monitor(goalId: string, codexRunId: string): void {
    if (this.monitors.has(goalId)) return;
    const promise = this.consumeCodexEvents(goalId, codexRunId)
      .catch(async (error) => {
        const goal = await this.store.loadGoal(goalId).catch(() => undefined);
        if (!goal || isGoalTerminal(goal.status)) return;
        await this.finalize(goalId, "failed", {
          failure: this.failure("codex_monitor_failed", safeError(error), false)
        });
      })
      .finally(() => this.monitors.delete(goalId));
    this.monitors.set(goalId, promise);
  }

  private async consumeCodexEvents(goalId: string, codexRunId: string): Promise<void> {
    let afterSequence = 0;
    const drainAvailable = async (): Promise<{ settled: boolean; terminalEventObserved: boolean }> => {
      let terminalEventObserved = false;
      for await (const event of this.adapter.streamEvents(codexRunId, {
        after_sequence: afterSequence,
        follow: false
      })) {
        afterSequence = Math.max(afterSequence, event.sequence);
        terminalEventObserved ||= event.type === "task.succeeded" || event.type === "task.failed" || event.type === "task.cancelled";
        await this.handleCodexEvent(goalId, codexRunId, event);
        const goal = await this.store.loadGoal(goalId);
        if (isGoalTerminal(goal.status)) return { settled: true, terminalEventObserved };
        if (
          (goal.status === "waiting_input" || goal.status === "waiting_approval") &&
          goal.checkpoint?.codex_turn_terminal === true
        ) return { settled: true, terminalEventObserved };
      }
      return { settled: false, terminalEventObserved };
    };

    while (true) {
      const firstDrain = await drainAvailable();
      if (firstDrain.settled) return;

      const goal = await this.store.loadGoal(goalId);
      if (isGoalTerminal(goal.status)) return;

      const run = await this.adapter.getRun(codexRunId);
      await this.persistProviderHeartbeat(goalId, run).catch(() => undefined);
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        // The adapter can become terminal between a non-following event read and getRun().
        // Drain once more so structured output and the real terminal event win over reconciliation.
        const terminalDrain = await drainAvailable();
        if (terminalDrain.settled || terminalDrain.terminalEventObserved) return;
      }
      if (run.status === "succeeded") {
        await this.handleCodexEvent(goalId, codexRunId, {
          sequence: Math.max(afterSequence + 1, run.event_count + 1),
          type: "task.succeeded",
          run_id: codexRunId,
          ...(run.thread_id ? { thread_id: run.thread_id } : {}),
          timestamp: new Date().toISOString(),
          data: {
            provider: run.provider,
            synthetic: true,
            reconciled_from_run_status: true,
            ...(run.final_response ? { final_response: run.final_response } : {})
          }
        });
        return;
      }
      if (run.status === "failed") {
        await this.handleCodexEvent(goalId, codexRunId, {
          sequence: Math.max(afterSequence + 1, run.event_count + 1),
          type: "task.failed",
          run_id: codexRunId,
          ...(run.thread_id ? { thread_id: run.thread_id } : {}),
          timestamp: new Date().toISOString(),
          data: {
            error_code: run.error_code ?? "execution_failed",
            message: run.error_message ?? "Codex task failed.",
            synthetic: true,
            reconciled_from_run_status: true
          }
        });
        return;
      }
      if (run.status === "cancelled") {
        await this.handleCodexEvent(goalId, codexRunId, {
          sequence: Math.max(afterSequence + 1, run.event_count + 1),
          type: "task.cancelled",
          run_id: codexRunId,
          ...(run.thread_id ? { thread_id: run.thread_id } : {}),
          timestamp: new Date().toISOString(),
          data: { synthetic: true, reconciled_from_run_status: true }
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async handleCodexEvent(goalId: string, codexRunId: string, event: CodexNormalizedEvent): Promise<void> {
    const current = await this.store.loadGoal(goalId);
    if (isGoalTerminal(current.status)) return;
    if (current.active_run_contract_version !== current.goal_contract.contract_version) return;
    if (current.checkpoint?.codex_run_id !== codexRunId) return;
    const currentProviderRun = current.checkpoint?.provider_run;
    if (
      currentProviderRun?.run_id === codexRunId
      && currentProviderRun.fencing_token !== undefined
      && event.data?.fencing_token !== undefined
      && currentProviderRun.fencing_token !== event.data.fencing_token
    ) return;
    const waitingStatus: GoalStatus | undefined = event.type === "task.waiting_input"
      ? "waiting_input"
      : event.type === "task.waiting_approval"
        ? "waiting_approval"
        : undefined;

    const updated = await this.store.record(goalId, {
      event_type: "codex.event",
      event_data: {
        codex_event_type: event.type,
        codex_event_sequence: event.sequence,
        codex_run_id: codexRunId,
        ...(event.data ? { data: event.data } : {})
      },
      mutate: (goal) => {
        if (event.thread_id) goal.codex_thread_id = event.thread_id;
        if (waitingStatus) goal.status = waitingStatus;
        if (waitingStatus === "waiting_approval") {
          goal.loop_state = this.nextLoopState(goal, {
            phase: waitingStatus,
            classification: classifyLoopFailure({
              code: "authorization_required",
              message: "The provider is waiting for explicit approval."
            })
          });
        } else if (waitingStatus === "waiting_input") {
          goal.loop_state = this.progressLoopState(goal, "The provider reached a durable waiting-input checkpoint.");
        }
        const structuredResult = event.data?.structured_result;
        const finalResponse = event.data?.final_response;
        let eventLatency = markGoalModelFirstEvent(goal.checkpoint?.latency, event.timestamp);
        if (waitingStatus || event.type === "task.succeeded" || event.type === "task.failed" || event.type === "task.cancelled") {
          eventLatency = completeGoalLatencyStage(eventLatency, "model_total", event.timestamp);
        }
        goal.checkpoint = {
          ...checkpointOf(goal),
          latency: eventLatency,
          codex_run_id: codexRunId,
          last_codex_event_sequence: event.sequence,
          provider_run: this.providerRunFromEvent(goal, codexRunId, event),
          ...(structuredResult && typeof structuredResult === "object"
            ? { structured_result: structuredResult as Record<string, unknown> }
            : {}),
          ...(typeof finalResponse === "string" ? { final_response: finalResponse } : {}),
          ...(waitingStatus ? { phase: waitingStatus, pending_operation: null } : {})
        };
      }
    });

    if (event.type === "task.succeeded" || event.type === "task.failed" || event.type === "task.cancelled") {
      recordGoalModelUsage(this.workspace.root, this.adapter.provider, updated, codexRunId, event);
    }

    if (waitingStatus) {
      await this.releaseGoalResourceLease(goalId);
      await this.dispatchHook(updated, waitingStatus === "waiting_input" ? "task.waiting_input" : "task.waiting_approval", {
        source_event_type: event.type
      });
    }

    if (event.type === "task.succeeded") {
      if (updated.status === "waiting_input" || updated.status === "waiting_approval") {
        await this.releaseGoalResourceLease(goalId);
        await this.store.patch(goalId, "goal.codex_turn_waiting", (goal) => {
          goal.checkpoint = { ...checkpointOf(goal), codex_turn_terminal: true, pending_operation: null };
        });
        return;
      }
      await this.releaseGoalResourceLease(goalId);
      await this.validate(goalId);
      return;
    }
    if (event.type === "task.failed") {
      const message = typeof event.data?.message === "string" ? event.data.message : "Codex task failed.";
      const adapterErrorCode = typeof event.data?.error_code === "string" ? event.data.error_code : undefined;
      const execTimedOut = adapterErrorCode === "timeout"
        || adapterErrorCode === "exec_timeout"
        || adapterErrorCode === "deadline_exceeded"
        || /(?:timed?\s*out|timeout|deadline\s+exceeded)/i.test(message);
      const failureCode = this.adapter.provider === "exec"
        ? execTimedOut
          ? "exec_timeout"
          : "exec_failed"
        : "codex_failed";
      const execution = updated.checkpoint?.execution_options;
      const writable = execution?.sandbox_mode === "workspace-write";
      await this.finalize(goalId, writable && transientFailure(message) ? "blocked" : "failed", {
        failure: this.failure(
          failureCode,
          message,
          false,
          this.adapter.provider === "exec" ? "runner" : "codex",
          {
            sandbox_mode: execution?.sandbox_mode,
            side_effect_level: writable ? "local_write" : "read_only",
            non_idempotent: writable,
            external_state_unknown: writable && transientFailure(message)
          }
        )
      });
      return;
    }
    if (event.type === "task.cancelled") {
      await this.finalize(goalId, "cancelled", {});
    }
  }

  private evidencePathExists(reportPath: string | undefined): boolean {
    if (!reportPath) return false;
    try {
      return existsSync(this.guard.resolve(this.workspace, reportPath).absPath);
    } catch {
      return false;
    }
  }

  private async acceptanceProfileForLane(lane: ExecutionLaneDecision | undefined): Promise<{
    requested?: string;
    effective?: string;
    fallback_reason?: string;
  }> {
    const requested = lane?.acceptance_profile;
    if (!requested) return {};
    const acceptance = await readAcceptanceConfig(this.config, this.guard, this.workspace);
    if (acceptance.profiles?.[requested]) return { requested, effective: requested };
    const fallback = acceptance.default_profile;
    if (fallback && acceptance.profiles?.[fallback]) {
      return {
        requested,
        effective: fallback,
        fallback_reason: `Lane profile ${requested} is not defined by this workspace; using configured default profile ${fallback}.`
      };
    }
    return {
      requested,
      fallback_reason: `Lane profile ${requested} is not defined and the workspace has no usable default profile.`
    };
  }

  private canReuseValidation(goal: GoalRecord, changedFiles: string[]): boolean {
    if (!goal.validation_result?.ok) return false;
    const previousChangedFiles = goal.checkpoint?.validation_changed_files;
    if (!Array.isArray(previousChangedFiles) || !previousChangedFiles.every((item): item is string => typeof item === "string")) return false;
    if (!sameStringList(previousChangedFiles, changedFiles)) return false;
    const automatedItems = goal.acceptance_contract.items.filter((item) => item.verifier !== "review" && item.verifier !== "manual");
    return automatedItems.every((item) => {
      if (item.status !== "passed") return false;
      return item.evidence_ids.some((evidenceId) => {
        const evidence = goal.evidence.find((candidate) => candidate.evidence_id === evidenceId);
        return Boolean(
          evidence?.trustworthy
          && evidence.contract_version === goal.goal_contract.contract_version
          && (!evidence.path || this.evidencePathExists(evidence.path))
        );
      });
    });
  }

  private async validate(goalId: string): Promise<GoalRecord> {
    let goal = await this.store.loadGoal(goalId);
    if (isGoalTerminal(goal.status)) return goal;
    goal = await this.ensureExecutionProfile(goal);
    let executionProfile = this.requireExecutionProfile(goal);
    if (goal.status !== "validating") {
      goal = await this.store.transition(goalId, "validating", "goal.validating", {
        patch: (next) => {
          next.checkpoint = {
            ...checkpointOf(next),
            latency: startGoalLatencyStage(next.checkpoint?.latency, "validation"),
            phase: "validating",
            pending_operation: "validation",
            replay_allowed: false,
            acceptance_started_at: next.checkpoint?.acceptance_started_at ?? new Date().toISOString(),
            acceptance_status: "running"
          };
        }
      });
    }

    try {
      const changedFiles = this.changedFileReader();
      const relevantChangedFiles = executionRelevantChangedFiles(changedFiles);
      const compiledTask = goal.checkpoint?.compiled_task as CompiledTask | undefined;
      const explicitDiffAcceptance = goal.acceptance_contract.items.some((item) => item.verifier === "diff");
      const taskChangedFiles = compiledTask
        && !compiledTask.capabilities.write_source
        && !compiledTask.capabilities.write_artifacts
        && !explicitDiffAcceptance
        ? []
        : relevantChangedFiles;
      const routeCheckpoint = goal.checkpoint?.task_route as Record<string, unknown> | undefined;
      const routeMode = typeof routeCheckpoint?.mode === "string" ? routeCheckpoint.mode : "code_patch";
      let executionLane = goal.checkpoint?.execution_lane as ExecutionLaneDecision | undefined;
      if (compiledTask) {
        const runtimeRisk = evaluateTaskRiskProfile({
          instruction: goal.objective,
          scope_paths: taskChangedFiles.length ? taskChangedFiles : compiledTask.scope,
          source_write: compiledTask.capabilities.write_source,
          artifact_write: compiledTask.capabilities.write_artifacts,
          run_bash: compiledTask.capabilities.run_bash,
          use_browser: compiledTask.capabilities.use_browser,
          use_network: compiledTask.capabilities.use_network,
          use_git: compiledTask.capabilities.use_git,
          write_database: compiledTask.capabilities.write_database,
          workspace_scope: compiledTask.source_write_policy === "workspace"
        });
        const laneTask: CompiledTask = { ...compiledTask, risk_decision: runtimeRisk };
        const explicitReviewRequired = goal.acceptance_contract.items.some((item) => item.verifier === "review")
          || compiledTask.phases.some((phase) => phase.kind === "review");
        const previousLane = executionLane ?? decideExecutionLane({
          compiled_task: laneTask,
          route_mode: routeMode,
          acceptance_count: goal.acceptance.length,
          explicit_review_required: explicitReviewRequired,
          explicit_reasoning_effort: goal.checkpoint?.execution_options?.reasoning_effort,
          enabled: false
        });
        const escalated = escalateExecutionLane({
          previous: previousLane,
          risk_decision: runtimeRisk,
          changed_files: taskChangedFiles,
          route_mode: routeMode,
          compiled_task: laneTask,
          acceptance_count: goal.acceptance.length,
          explicit_review_required: explicitReviewRequired
        });
        executionLane = escalated;
        if (fingerprint(previousLane) !== fingerprint(escalated) || !goal.checkpoint?.execution_lane) {
          const nextContextProfile = resolveContextProfile(escalated.lane, this.config.contextProfilesEnabled);
          const nextProfile = reviseExecutionProfileSnapshot(executionProfile, {
            reason: "lane_escalation",
            execution_lane: escalated,
            reasoning_effort: escalated.reasoning_effort,
            context_profile: nextContextProfile
          });
          goal = await this.store.patch(goal.goal_id, "goal.execution_lane_updated", (next) => {
            const history = next.checkpoint?.execution_profile_history ?? [];
            next.checkpoint = {
              ...checkpointOf(next),
              execution_lane: escalated,
              context_profile: nextContextProfile,
              execution_profile_snapshot: nextProfile,
              execution_profile_history: [...history, executionProfile],
              execution_options: executionOptionsFromProfile(nextProfile)
            };
          }, {
            execution_lane: escalated.lane,
            escalated_from: escalated.escalated_from ?? null,
            reason_codes: escalated.reason_codes,
            acceptance_profile: escalated.acceptance_profile,
            reviewer_mode: escalated.reviewer_mode,
            previous_snapshot_id: executionProfile.snapshot_id,
            execution_profile_snapshot_id: nextProfile.snapshot_id,
            execution_profile_snapshot_version: nextProfile.snapshot_version,
            execution_profile_hash: nextProfile.profile_hash
          });
          executionProfile = nextProfile;
        }
      }
      const reusable = this.canReuseValidation(goal, taskChangedFiles);
      const loopBudget = normalizeLoopBudget(goal.goal_contract.retry_budget);
      if (!reusable && goal.loop_state.full_validation_runs >= loopBudget.max_full_validation_runs) {
        return await this.finalize(goal.goal_id, "blocked", {
          failure: this.failure(
            "full_validation_budget_exhausted",
            "The configured full validation run budget is exhausted; existing evidence cannot be reused.",
            false,
            "infrastructure_policy"
          ),
          result: { validation_reused: false, budget_exhausted: "max_full_validation_runs" }
        });
      }
      const acceptanceSelection = await this.acceptanceProfileForLane(executionLane);
      const baseResult = reusable
        ? goal.validation_result as GoalValidationResult
        : validationResult(await this.acceptanceRunner({
            runId: goal.run_id,
            ...(acceptanceSelection.effective ? { profile: acceptanceSelection.effective } : {}),
            changedFiles: taskChangedFiles
          }));
      const acceptanceConnectorReturnedAt = new Date().toISOString();
      if (!reusable && baseResult.status === "resource_wait_timeout") {
        return await this.store.patch(goal.goal_id, "goal.validation_waiting_resources", (next) => {
          next.validation_result = baseResult;
          next.checkpoint = {
            ...checkpointOf(next),
            phase: "waiting_resources",
            pending_operation: "validation",
            replay_allowed: true,
            acceptance_connector_returned_at: acceptanceConnectorReturnedAt,
            acceptance_status: "resource_wait_timeout"
          };
          next.loop_state = this.progressLoopState(next, "Acceptance did not start before resource admission timed out; validation remains retryable.");
        }, {
          acceptance_status: baseResult.status,
          retryable: true,
          report_path: baseResult.report_path
        });
      }
      let evidence = goal.evidence;
      let linkedContract = goal.acceptance_contract;
      if (!reusable) {
        const acceptanceReportExists = this.evidencePathExists(baseResult.report_path);
        const idsFor = (verifier: "command" | "browser" | "diff" | "state") => goal.acceptance_contract.items
          .filter((item) => item.verifier === verifier)
          .map((item) => item.id);
        const evidenceRecords = [];
        const commandIds = idsFor("command");
        if (commandIds.length) {
          evidenceRecords.push(validationEvidence(baseResult, commandIds, {
            type: "command_log",
            path_exists: acceptanceReportExists
          }));
        }
        const diffIds = idsFor("diff");
        if (diffIds.length) {
          evidenceRecords.push(validationEvidence(baseResult, diffIds, {
            type: "diff",
            path_exists: acceptanceReportExists,
            summary: taskChangedFiles.length
              ? `Changed files evaluated by the diff verifier: ${taskChangedFiles.join(", ")}.`
              : "The diff verifier observed no changed files."
          }));
        }
        const stateIds = idsFor("state");
        if (stateIds.length) {
          evidenceRecords.push(validationEvidence(baseResult, stateIds, {
            type: "state",
            path_exists: acceptanceReportExists,
            summary: `Goal state was evaluated against acceptance profile ${baseResult.profile}.`
          }));
        }
        const browserIds = idsFor("browser");
        if (browserIds.length) {
          const browserSummaries = baseResult.commands
            .map((command) => command.browser_smoke_summary)
            .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
          const browserReportPaths = browserSummaries
            .map((summary) => typeof summary.reportPath === "string" ? summary.reportPath.trim() : "")
            .filter(Boolean);
          const browserReportPath = browserReportPaths.find((candidate) => this.evidencePathExists(candidate))
            ?? browserReportPaths[0]
            ?? baseResult.report_path;
          evidenceRecords.push(validationEvidence(baseResult, browserIds, {
            type: "browser_snapshot",
            path: browserReportPath,
            path_exists: this.evidencePathExists(browserReportPath),
            summary: `Browser acceptance evidence for profile ${baseResult.profile}.`,
            limitations: browserReportPaths.length ? [] : ["No dedicated browser report path was emitted; the acceptance report path was used."]
          }));
          const screenshotPaths = browserSummaries.flatMap((summary) =>
            (Array.isArray(summary.results) ? summary.results : []).flatMap((result) => {
              if (!result || typeof result !== "object") return [];
              const screenshots = (result as Record<string, unknown>).screenshots;
              return Array.isArray(screenshots)
                ? screenshots.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                : [];
            })
          );
          for (const screenshotPath of [...new Set(screenshotPaths)]) {
            evidenceRecords.push(validationEvidence(baseResult, browserIds, {
              type: "screenshot",
              path: screenshotPath,
              path_exists: this.evidencePathExists(screenshotPath),
              summary: `Browser screenshot captured for acceptance profile ${baseResult.profile}.`
            }));
          }
        }
        const versionedEvidenceRecords = evidenceRecords.map((evidenceRecord) => ({
          ...evidenceRecord,
          contract_version: goal.goal_contract.contract_version
        }));
        evidence = mergeEvidence(goal.evidence, versionedEvidenceRecords);
        for (const evidenceRecord of versionedEvidenceRecords) {
          linkedContract = linkEvidence(
            linkedContract,
            evidenceRecord,
            (item) => evidenceRecord.related_acceptance_ids.includes(item.id)
          );
        }
      }
      const evaluated = evaluateAcceptanceContract(linkedContract, {
        phase: "validation",
        validation: baseResult,
        changed_files: taskChangedFiles,
        evidence
      });
      const result: GoalValidationResult = {
        ...baseResult,
        acceptance_evaluation: evaluated.summary
      };
      await this.store.patch(goal.goal_id, reusable ? "goal.validation_reused" : "goal.validation_completed", (next) => {
        next.validation_result = result;
        next.acceptance_contract = evaluated.contract;
        next.evidence = evidence;
        next.checkpoint = {
          ...checkpointOf(next),
          latency: completeGoalLatencyStage(next.checkpoint?.latency, "validation"),
          pending_operation: null,
          phase: reusable ? "validation_reused" : "validation_completed",
          validation_changed_files: taskChangedFiles,
          ...(acceptanceSelection.requested ? { acceptance_profile_requested: acceptanceSelection.requested } : {}),
          ...(acceptanceSelection.effective ? { acceptance_profile_effective: acceptanceSelection.effective } : {}),
          ...(acceptanceSelection.fallback_reason ? { acceptance_profile_fallback_reason: acceptanceSelection.fallback_reason } : {}),
          ...(reusable ? { validation_reused_at: new Date().toISOString() } : {}),
          acceptance_connector_returned_at: acceptanceConnectorReturnedAt,
          acceptance_status: result.status
        };
        next.loop_state = this.progressLoopState(
          next,
          reusable
            ? "Existing validation evidence was reused; no full validation rerun was needed."
            : "A full validation run completed and evidence was persisted.",
          reusable ? {} : { tool_calls_delta: 1, full_validation_runs_delta: 1 }
        );
      }, {
        ok: result.ok,
        reused: reusable,
        report_path: result.report_path,
        acceptance_profile_requested: acceptanceSelection.requested ?? null,
        acceptance_profile_effective: acceptanceSelection.effective ?? result.profile,
        acceptance_profile_fallback_reason: acceptanceSelection.fallback_reason ?? null,
        acceptance_blocking_passed: evaluated.summary.blocking_passed,
        acceptance_failed_ids: evaluated.summary.blocking_failed_ids,
        acceptance_not_covered_ids: evaluated.summary.blocking_not_covered_ids
      });
      if (result.status === "blocked_by_resource_policy" || result.status === "blocked_by_bash_policy") {
        const policyName = result.status === "blocked_by_resource_policy" ? "CPU resource policy" : "Bash allowlist policy";
        return await this.finalize(goal.goal_id, "blocked", {
          failure: this.failure(
            result.status === "blocked_by_resource_policy"
              ? "acceptance_blocked_by_resource_policy"
              : "acceptance_blocked_by_bash_policy",
            `Acceptance profile ${result.profile} was blocked before process startup by ${policyName}.`,
            false,
            "infrastructure_policy"
          ),
          result: { failure_domain: "infrastructure_policy", acceptance_status: result.status }
        });
      }
      if (!result.ok) {
        return await this.finalize(goal.goal_id, "failed", {
          failure: this.failure("acceptance_failed", `Acceptance profile ${result.profile} failed.`, false, "acceptance"),
          result: { failure_domain: "acceptance", acceptance_status: result.status }
        });
      }

      const minimalChangeContract = compiledTask?.minimal_change_contract as MinimalChangeContract | undefined;
      const changeFootprint = minimalChangeContract
        ? buildChangeFootprint({ contract: minimalChangeContract, actual_paths: taskChangedFiles })
        : undefined;
      const minimalSufficiencyReview = changeFootprint
        ? reviewMinimalSufficiency(changeFootprint)
        : undefined;
      const explicitReviewItems = evaluated.contract.items.some((item) => item.verifier === "review");
      const effectiveLane = executionLane ?? (compiledTask
        ? decideExecutionLane({
            compiled_task: compiledTask,
            route_mode: routeMode,
            acceptance_count: goal.acceptance.length,
            explicit_review_required: explicitReviewItems,
            explicit_reasoning_effort: goal.checkpoint?.execution_options?.reasoning_effort,
            enabled: false
          })
        : undefined);
      const reviewRouting = effectiveLane
        ? shouldRunModelReview(effectiveLane, {
            reviewer_available: Boolean(this.reviewRunner),
            explicit_review_items: explicitReviewItems,
            minimal_change_decision: minimalSufficiencyReview?.decision,
            acceptance_blocking_passed: evaluated.summary.blocking_passed,
            changes_observed: taskChangedFiles.length > 0
              || Boolean(compiledTask?.capabilities.write_source)
              || Boolean(compiledTask?.capabilities.write_artifacts)
          })
        : this.reviewRunner
          ? { run: true, reason_code: "legacy_reviewer_enabled", reason: "Legacy Goal has no persisted lane; preserve the enabled Reviewer behavior." }
          : { run: false, reason_code: "legacy_reviewer_disabled", reason: "Legacy Goal has no persisted lane and no Reviewer is enabled." };
      await this.store.patch(goal.goal_id, "goal.review_routing_decided", (next) => {
        next.checkpoint = {
          ...checkpointOf(next),
          ...(effectiveLane ? { execution_lane: effectiveLane } : {}),
          review_routing: {
            mode: effectiveLane?.reviewer_mode ?? (reviewRouting.run ? "required" : "deterministic"),
            reason_code: reviewRouting.reason_code,
            reason: reviewRouting.reason,
            model_review_run: reviewRouting.run
          }
        };
      }, {
        execution_lane: effectiveLane?.lane ?? "legacy",
        reviewer_mode: effectiveLane?.reviewer_mode ?? "legacy",
        model_review_run: reviewRouting.run,
        reason_code: reviewRouting.reason_code
      });
      const unresolved = unresolvedBlockingItems(evaluated.contract, {
        ignorePendingReview: reviewRouting.run
      });
      const unresolvedOutsideReview = unresolved.filter((item) => item.verifier !== "review");
      if (unresolvedOutsideReview.length) {
        const failed = unresolvedOutsideReview.filter((item) => item.status === "failed" || item.status === "blocked");
        const ids = unresolvedOutsideReview.map((item) => item.id).join(", ");
        return await this.finalize(goal.goal_id, failed.length ? "failed" : "blocked", {
          failure: this.failure(
            failed.length ? "acceptance_contract_failed" : "acceptance_contract_not_covered",
            failed.length
              ? `Blocking acceptance items failed: ${ids}.`
              : `Blocking acceptance items were not covered by an automatic verifier: ${ids}.`,
            false,
            "acceptance"
          ),
          result: {
            failure_domain: "acceptance",
            acceptance_blocking_passed: false,
            unresolved_acceptance_ids: unresolvedOutsideReview.map((item) => item.id)
          }
        });
      }
      if (!reviewRouting.run && /unavailable$/.test(reviewRouting.reason_code)) {
        return await this.finalize(goal.goal_id, "blocked", {
          failure: this.failure(
            "review_required_unavailable",
            reviewRouting.reason,
            false,
            "review_gate"
          ),
          result: {
            failure_domain: "review_gate",
            execution_lane: effectiveLane?.lane ?? "legacy",
            reviewer_mode: effectiveLane?.reviewer_mode ?? "conditional",
            review_reason_code: reviewRouting.reason_code
          }
        });
      }
      if (unresolved.length) {
        const failed = unresolved.filter((item) => item.status === "failed" || item.status === "blocked");
        const ids = unresolved.map((item) => item.id).join(", ");
        return await this.finalize(goal.goal_id, failed.length ? "failed" : "blocked", {
          failure: this.failure(
            failed.length ? "acceptance_contract_failed" : "acceptance_contract_not_covered",
            failed.length
              ? `Blocking acceptance items failed: ${ids}.`
              : `Blocking acceptance items were not covered by an automatic verifier: ${ids}.`,
            false,
            "acceptance"
          ),
          result: {
            failure_domain: "acceptance",
            acceptance_blocking_passed: false,
            unresolved_acceptance_ids: unresolved.map((item) => item.id)
          }
        });
      }
      if (reviewRouting.run) return await this.review(goal.goal_id);

      const deterministicReview = {
        ok: true,
        summary: reviewRouting.reason,
        completed_at: new Date().toISOString(),
        reviewed_files: taskChangedFiles,
        uncovered_scope: [],
        workspace_unchanged: true,
        reviewer_run_id: null,
        gate_passed: true,
        findings: [],
        blocking_findings: [],
        critical_uncovered_scope: [],
        review_policy: {
          routing_mode: effectiveLane?.reviewer_mode ?? "deterministic",
          reason_code: reviewRouting.reason_code,
          model_review_run: false
        },
        acceptance_evaluation: evaluated.summary,
        ...(changeFootprint ? { change_footprint: changeFootprint } : {}),
        ...(minimalSufficiencyReview ? { minimal_sufficiency_review: minimalSufficiencyReview } : {})
      };
      await this.store.patch(goal.goal_id, "goal.deterministic_review_completed", (next) => {
        next.review_result = deterministicReview;
        next.checkpoint = {
          ...checkpointOf(next),
          phase: "deterministic_review_completed",
          pending_operation: null
        };
      }, {
        execution_lane: effectiveLane?.lane ?? "legacy",
        review_reason_code: reviewRouting.reason_code,
        model_review_run: false,
        minimal_change_decision: minimalSufficiencyReview?.decision ?? "not_available"
      });
      return await this.finalize(goal.goal_id, "succeeded", {
        result: {
          acceptance_blocking_passed: evaluated.summary.blocking_passed,
          execution_lane: effectiveLane?.lane ?? "legacy",
          reviewer_mode: effectiveLane?.reviewer_mode ?? "deterministic",
          review_reason_code: reviewRouting.reason_code,
          model_review_run: false
        }
      });
    } catch (error) {
      const acceptanceConnectorReturnedAt = new Date().toISOString();
      await this.store.patchMetadata(goal.goal_id, "goal.acceptance_connector_failed", (next) => {
        next.checkpoint = {
          ...checkpointOf(next),
          acceptance_connector_returned_at: acceptanceConnectorReturnedAt,
          acceptance_status: "failed"
        };
      }, {
        acceptance_connector_returned_at: acceptanceConnectorReturnedAt,
        raw_error: safeError(error)
      }).catch(() => undefined);
      return await this.finalize(goal.goal_id, "failed", {
        failure: this.failure("acceptance_error", safeError(error), false, "acceptance")
      });
    }
  }

  private async validateSubagentReport(
    parentGoalId: string,
    tasks: ReadOnlyAgentTask[],
    report: SubagentBatchReport
  ): Promise<SubagentBatchReport> {
    const taskMap = new Map(tasks.map((task) => [task.task_id, normalizedSubagentTask(task, parentGoalId)]));
    const results = await Promise.all(report.results.map(async (result) => {
      const task = taskMap.get(result.task_id);
      if (!task || !result.proof_path) {
        return {
          ...result,
          completion_class: "invalid" as const,
          verified: false,
          proof_valid: false,
          proof_invalid_reasons: [task ? "proof_path_missing" : "task_contract_missing"]
        };
      }
      const contract = subagentTaskContract(task, parentGoalId);
      const contractHash = agentTaskContractHash(contract);
      const structuredResult = result.status === "succeeded"
        ? { summary: result.summary, observations: result.observations }
        : { summary: result.summary, observations: result.observations, ...(result.error ? { error: result.error } : {}) };
      const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, result.proof_path, {
        parent_goal_id: parentGoalId,
        agent_id: result.task_id,
        agent_role: result.role,
        task_id: result.task_id,
        task_contract_hash: contractHash,
        ...(result.run_id ? { run_id: result.run_id } : {}),
        sandbox_mode: "read-only",
        input: contract,
        output: subagentProofOutput(result),
        structured_result: structuredResult,
        changed_files: [],
        allowed_paths: [],
        evidence_refs: subagentEvidenceRefs(result),
        require_verified: true
      });
      return {
        ...result,
        task_contract_hash: contractHash,
        completion_class: validation.proof?.completion_class ?? "invalid",
        verified: validation.verified,
        proof_valid: validation.valid,
        proof_invalid_reasons: validation.reasons
      };
    }));
    const failedTaskIds = results.filter((result) => result.status === "failed").map((result) => result.task_id);
    const invalidProofTaskIds = results.filter((result) => !result.proof_valid || !result.verified).map((result) => result.task_id);
    return {
      ...report,
      ok: report.ok && failedTaskIds.length === 0 && invalidProofTaskIds.length === 0 && report.workspace_unchanged,
      results,
      failed_task_ids: [...new Set([...report.failed_task_ids, ...failedTaskIds])],
      invalid_proof_task_ids: invalidProofTaskIds,
      proofs_valid: invalidProofTaskIds.length === 0
    };
  }

  private async recordSubagentStructuredEvents(
    parentGoalId: string,
    tasks: ReadOnlyAgentTask[],
    report: SubagentBatchReport
  ): Promise<void> {
    const goal = await this.store.loadGoal(parentGoalId);
    const executionProfileVersion = goal.checkpoint?.execution_profile_snapshot?.snapshot_version ?? null;
    const resultByTaskId = new Map(report.results.map((result) => [result.task_id, result]));
    for (const task of tasks) {
      const result = resultByTaskId.get(task.task_id);
      const contractHash = agentTaskContractHash(subagentTaskContract(task, parentGoalId));
      const runId = result?.run_id ?? `subagent-run:${goal.run_id}:${task.task_id}`;
      const componentId = `subagent:${task.task_id}`;
      const evidenceRef = result?.proof_path ?? result?.proof_hash ?? contractHash;
      const lifecycleRetry = {
        policy: "not_applicable" as const,
        replay_allowed: false,
        idempotency_key: `${goal.run_id}:${task.task_id}`,
        reason: "Subagent lifecycle observation does not authorize automatic replay.",
        attempt: 1,
        max_attempts: 1
      };
      const common = {
        task_id: task.task_id,
        run_id: runId,
        parent_run_id: goal.run_id,
        component_id: componentId,
        execution_profile_version: executionProfileVersion,
        evidence_ref: evidenceRef,
        retry_semantics: lifecycleRetry
      };
      await this.store.recordStructuredRuntimeEvent(parentGoalId, {
        event_name: "subagent.created",
        ...common,
        terminal: false,
        idempotency_key: `${goal.run_id}:${task.task_id}:created`,
        details: {
          role: task.role,
          task_contract_hash: contractHash,
          scope_count: task.scope?.length ?? 0,
          context_count: task.context?.length ?? 0
        }
      });
      await this.store.recordStructuredRuntimeEvent(parentGoalId, {
        event_name: "subagent.started",
        ...common,
        terminal: false,
        idempotency_key: `${goal.run_id}:${task.task_id}:started`,
        details: {
          role: task.role,
          started_at: result?.started_at ?? null
        }
      });
      await this.store.recordStructuredRuntimeEvent(parentGoalId, {
        event_name: "subagent.progress",
        ...common,
        terminal: false,
        idempotency_key: `${goal.run_id}:${task.task_id}:progress:${result?.completed_at ?? "missing-result"}`,
        details: {
          role: task.role,
          status: result?.status ?? "missing",
          observation_count: result?.observations.length ?? 0,
          completed_at: result?.completed_at ?? null
        }
      });
      if (result?.summary) {
        await this.store.recordStructuredRuntimeEvent(parentGoalId, {
          event_name: "subagent.deliverable_reported",
          ...common,
          terminal: false,
          idempotency_key: `${goal.run_id}:${task.task_id}:deliverable:${result.proof_hash ?? result.completed_at}`,
          details: {
            role: task.role,
            status: result.status,
            summary_hash: hashAgentValue(result.summary),
            proof_path: result.proof_path ?? null,
            proof_hash: result.proof_hash ?? null
          }
        });
      }
      const proofAccepted = result?.proof_valid === true && result.verified === true;
      await this.store.recordStructuredRuntimeEvent(parentGoalId, {
        event_name: proofAccepted ? "subagent.proof_validated" : "subagent.proof_rejected",
        ...common,
        terminal: false,
        retry_semantics: proofAccepted
          ? lifecycleRetry
          : {
              ...lifecycleRetry,
              policy: "manual",
              reason: "Rejected subagent proof requires an explicit new authorized subagent task before retry."
            },
        idempotency_key: `${goal.run_id}:${task.task_id}:${proofAccepted ? "proof_validated" : "proof_rejected"}:${result?.proof_hash ?? "no-proof"}`,
        details: {
          role: task.role,
          proof_path: result?.proof_path ?? null,
          proof_hash: result?.proof_hash ?? null,
          completion_class: result?.completion_class ?? "invalid",
          proof_invalid_reasons: result?.proof_invalid_reasons ?? (result ? [] : ["result_missing"])
        }
      });
      const completed = result?.status === "succeeded" && proofAccepted;
      await this.store.recordStructuredRuntimeEvent(parentGoalId, {
        event_name: completed ? "subagent.completed" : "subagent.failed",
        ...common,
        terminal: true,
        retry_semantics: {
          ...lifecycleRetry,
          policy: completed ? "never" : "manual",
          reason: completed
            ? "Verified subagent completion is final for this parent Goal attempt."
            : "Failed or unverified subagent output cannot be replayed automatically."
        },
        idempotency_key: `${goal.run_id}:${task.task_id}:${completed ? "completed" : "failed"}:${result?.proof_hash ?? "no-proof"}`,
        details: {
          role: task.role,
          status: result?.status ?? "missing",
          proof_valid: result?.proof_valid === true,
          verified: result?.verified === true,
          error_hash: result?.error ? hashAgentValue(result.error) : null
        }
      });
    }
  }

  private async recordExecutionSnapshotStructuredEvent(
    goal: GoalRecord,
    eventName: "execution.snapshot_loaded" | "execution.snapshot_mismatch",
    reason: string
  ): Promise<void> {
    const snapshot = goal.checkpoint?.execution_profile_snapshot;
    await this.store.recordStructuredRuntimeEvent(goal.goal_id, {
      event_name: eventName,
      task_id: `goal-${goal.goal_id}`,
      run_id: goal.run_id,
      parent_run_id: null,
      component_id: `execution_profile:${snapshot?.snapshot_id ?? goal.goal_id}`,
      execution_profile_version: snapshot?.snapshot_version ?? null,
      evidence_ref: snapshot?.snapshot_id ?? snapshot?.profile_hash ?? `${this.config.contextDir}/goals/${goal.goal_id}/checkpoint.json`,
      terminal: eventName === "execution.snapshot_mismatch",
      retry_semantics: {
        policy: "never",
        replay_allowed: false,
        idempotency_key: `${goal.run_id}:${eventName}:${snapshot?.snapshot_id ?? "missing"}`,
        reason: eventName === "execution.snapshot_loaded"
          ? "Recovered execution profile snapshot is immutable; no automatic rerouting is allowed."
          : "Snapshot mismatch blocks replay until an explicit recovery decision is made.",
        attempt: 1,
        max_attempts: 1
      },
      idempotency_key: `${goal.run_id}:${eventName}:${snapshot?.snapshot_id ?? "missing"}`,
      details: {
        snapshot_id: snapshot?.snapshot_id ?? null,
        snapshot_version: snapshot?.snapshot_version ?? null,
        profile_hash: snapshot?.profile_hash ?? null,
        status: goal.status,
        recovery_reason_hash: hashAgentValue(reason)
      }
    });
  }

  private async validateReviewReport(request: ReviewRequest, report: AdvisoryReviewReport): Promise<AdvisoryReviewReport> {
    const taskId = request.task_id?.trim();
    if (!taskId || !report.proof_path || !report.reviewer_run_id) {
      return {
        ...report,
        ok: false,
        gate_passed: false,
        completion_class: "invalid",
        verified: false,
        proof_valid: false,
        proof_invalid_reasons: [
          ...(!taskId ? ["review_task_id_missing"] : []),
          ...(!report.proof_path ? ["proof_path_missing"] : []),
          ...(!report.reviewer_run_id ? ["review_run_id_missing"] : [])
        ]
      };
    }
    const policy = request.review_policy ?? {
      mode: this.config.codexReviewMode,
      p0_confidence_threshold: this.config.codexReviewP0Threshold,
      p1_confidence_threshold: this.config.codexReviewP1Threshold,
      require_critical_scope_covered: this.config.codexReviewRequireCriticalScopeCovered
    };
    const contract = {
      version: 1,
      parent_goal_id: request.parent_goal_id ?? null,
      task_id: taskId,
      target: request.target,
      related_files: proofCleanList(request.related_files, 50),
      acceptance_result: request.acceptance_result ?? null,
      extra_context: proofCleanList(request.extra_context, 50),
      minimal_change_contract: request.minimal_change_contract ?? null,
      change_footprint: request.change_footprint ?? null,
      review_policy: policy
    };
    const output = {
      ok: report.ok,
      mode: report.mode,
      summary: report.summary,
      target: report.target,
      findings: report.findings,
      reviewed_files: report.reviewed_files,
      uncovered_scope: report.uncovered_scope,
      workspace_unchanged: report.workspace_unchanged,
      reviewer_run_id: report.reviewer_run_id,
      gate_passed: report.gate_passed,
      blocking_findings: report.blocking_findings,
      critical_uncovered_scope: report.critical_uncovered_scope,
      review_policy: report.review_policy,
      ...(report.minimal_sufficiency_review ? { minimal_sufficiency_review: report.minimal_sufficiency_review } : {}),
      ...(report.change_footprint ? { change_footprint: report.change_footprint } : {}),
      ...(report.error ? { error: report.error } : {}),
      completed_at: report.completed_at
    };
    const structuredResult = {
      summary: report.summary,
      findings: report.findings,
      reviewed_files: report.reviewed_files,
      uncovered_scope: report.uncovered_scope
    };
    const evidenceRefs = [
      ...report.findings.map((finding, index) => `${taskId}:finding:${index + 1}:${finding.file}:${finding.line ?? 0}:${hashAgentValue(finding)}`),
      ...report.reviewed_files.map((file) => `${taskId}:reviewed:${file}`)
    ];
    const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, report.proof_path, {
      parent_goal_id: request.parent_goal_id ?? null,
      agent_id: "reviewer",
      agent_role: "reviewer",
      task_id: taskId,
      task_contract_hash: agentTaskContractHash(contract),
      run_id: report.reviewer_run_id,
      provider: report.review_policy.provider,
      sandbox_mode: "read-only",
      input: contract,
      output,
      structured_result: structuredResult,
      changed_files: [],
      allowed_paths: [],
      evidence_refs: evidenceRefs,
      require_verified: true
    });
    return {
      ...report,
      ok: report.ok && validation.valid && validation.verified,
      gate_passed: report.gate_passed && validation.verified,
      task_contract_hash: agentTaskContractHash(contract),
      completion_class: validation.proof?.completion_class ?? "invalid",
      verified: validation.verified,
      proof_valid: validation.valid,
      proof_invalid_reasons: validation.reasons
    };
  }

  private promptWithSubagentReport(objective: string, report: SubagentBatchReport): string {
    const context = JSON.stringify({
      summaries: report.results.map((result) => ({
        task_id: result.task_id,
        role: result.role,
        summary: result.summary
      })),
      observations: report.observations
    }, null, 2).slice(0, 30_000);
    return [
      objective,
      "",
      "Read-only subagents completed before this primary task. Treat their output as advisory evidence, verify it independently, and remain responsible for the Goal.",
      context
    ].join("\n");
  }

  private async effectiveReviewPolicy(): Promise<ReviewPolicyInput> {
    const project = await readProjectProfile(this.config, this.guard, this.workspace);
    const review = project.config.review;
    return {
      mode: review?.mode ?? this.config.codexReviewMode,
      p0_confidence_threshold: review?.block_on?.P0 === undefined
        ? this.config.codexReviewP0Threshold
        : review.block_on.P0,
      p1_confidence_threshold: review?.block_on?.P1 === undefined
        ? this.config.codexReviewP1Threshold
        : review.block_on.P1,
      require_critical_scope_covered: review?.require_critical_scope_covered
        ?? this.config.codexReviewRequireCriticalScopeCovered,
      ...(review?.independent_provider ? { independent_provider: review.independent_provider } : {})
    };
  }

  private async review(goalId: string): Promise<GoalRecord> {
    let goal = await this.store.loadGoal(goalId);
    if (isGoalTerminal(goal.status)) return goal;
    const runner = this.reviewRunner;
    if (!runner) {
      return await this.finalize(goalId, "failed", {
        failure: this.failure("review_unavailable", "Review was enabled but no Reviewer runner is available.", false, "review_gate")
      });
    }
    if (goal.status !== "reviewing") {
      goal = await this.store.transition(goalId, "reviewing", "goal.reviewing", {
        patch: (next) => {
          next.checkpoint = {
            ...checkpointOf(next),
            latency: startGoalLatencyStage(next.checkpoint?.latency, "review"),
            phase: "reviewing",
            pending_operation: "review",
            replay_allowed: false
          };
        }
      });
    }

    try {
      const reviewPolicy = await this.effectiveReviewPolicy();
      const changedFiles = executionRelevantChangedFiles(this.changedFileReader());
      const executionLane = goal.checkpoint?.execution_lane as ExecutionLaneDecision | undefined;
      const reviewRouting = goal.checkpoint?.review_routing;
      const compiledTask = goal.checkpoint?.compiled_task as Record<string, unknown> | undefined;
      const minimalChangeContract = compiledTask?.minimal_change_contract as MinimalChangeContract | undefined;
      const changeFootprint = minimalChangeContract
        ? buildChangeFootprint({ contract: minimalChangeContract, actual_paths: changedFiles })
        : undefined;
      const minimalSufficiencyReview = changeFootprint
        ? reviewMinimalSufficiency(changeFootprint)
        : undefined;
      const extraContext = goal.subagent_result
        ? goal.subagent_result.results.map((result) => `${result.role} ${result.task_id}: ${result.summary}`)
        : [];
      if (minimalChangeContract && changeFootprint) {
        extraContext.push(`Minimal change contract: ${JSON.stringify(minimalChangeContract)}`);
        extraContext.push(`Change footprint: ${JSON.stringify(changeFootprint)}`);
      }
      if (executionLane) {
        extraContext.push(`Execution lane: ${executionLane.lane}; reasoning=${executionLane.reasoning_effort}; reviewer=${executionLane.reviewer_mode}; reasons=${executionLane.reason_codes.join(",")}`);
      }
      const reviewRequest: ReviewRequest = {
        task_id: `review-${goal.goal_id}`,
        parent_goal_id: goal.goal_id,
        target: { type: "working_tree" },
        review_policy: reviewPolicy,
        related_files: changedFiles,
        acceptance_result: goal.validation_result,
        extra_context: extraContext,
        ...(minimalChangeContract ? { minimal_change_contract: minimalChangeContract } : {}),
        ...(changeFootprint ? { change_footprint: changeFootprint } : {})
      };
      const rawReport = await runner(reviewRequest);
      const report = await this.validateReviewReport(reviewRequest, rawReport);
      const reviewAcceptanceIds = goal.acceptance_contract.items
        .filter((item) => item.verifier === "review")
        .map((item) => item.id);
      const evidenceRecord = {
        ...reviewEvidence(
          report,
          reviewAcceptanceIds,
          `${this.store.goalDir(goal.goal_id)}/review.json`
        ),
        contract_version: goal.goal_contract.contract_version
      };
      const evidence = mergeEvidence(goal.evidence, [evidenceRecord]);
      const linkedContract = linkEvidence(
        goal.acceptance_contract,
        evidenceRecord,
        (item) => item.verifier === "review"
      );
      const evaluated = evaluateAcceptanceContract(linkedContract, {
        phase: "review",
        validation: goal.validation_result,
        review: report,
        changed_files: changedFiles,
        evidence
      });
      const storedReport = {
        ...report,
        review_policy: {
          ...report.review_policy,
          routing_mode: reviewRouting?.mode ?? executionLane?.reviewer_mode ?? "required",
          routing_reason_code: reviewRouting?.reason_code ?? "review_required_by_goal",
          model_review_run: true
        },
        ...(executionLane ? { execution_lane: executionLane } : {}),
        acceptance_evaluation: evaluated.summary,
        ...(changeFootprint ? { change_footprint: changeFootprint } : {}),
        ...(minimalSufficiencyReview ? { minimal_sufficiency_review: minimalSufficiencyReview } : {})
      };
      await this.store.patch(goal.goal_id, "goal.review_completed", (next) => {
        next.review_result = storedReport;
        next.acceptance_contract = evaluated.contract;
        next.evidence = evidence;
        next.checkpoint = {
          ...checkpointOf(next),
          latency: completeGoalLatencyStage(next.checkpoint?.latency, "review"),
          phase: "review_completed",
          pending_operation: null,
          agent_completion_proofs: {
            ...(next.checkpoint?.agent_completion_proofs ?? {}),
            review: {
              status: report.completion_class ?? "invalid",
              verified: report.verified === true,
              proof_paths: report.proof_path ? [report.proof_path] : [],
              invalid_reasons: report.proof_invalid_reasons ?? []
            }
          }
        };
        next.loop_state = this.progressLoopState(next, "Independent review completed and evidence was persisted.", { tool_calls_delta: 1 });
      }, {
        ok: report.ok,
        mode: report.mode,
        gate_passed: report.gate_passed,
        finding_count: report.findings.length,
        blocking_finding_count: report.blocking_findings.length,
        workspace_unchanged: report.workspace_unchanged,
        proof_valid: report.proof_valid === true,
        completion_verified: report.verified === true,
        proof_invalid_reasons: report.proof_invalid_reasons ?? [],
        execution_lane: executionLane?.lane ?? "legacy",
        review_reason_code: reviewRouting?.reason_code ?? "review_required_by_goal",
        acceptance_blocking_passed: evaluated.summary.blocking_passed
      });
      if (!report.ok) {
        return await this.finalize(goal.goal_id, "failed", {
          failure: this.failure(
            "review_failed",
            report.error || "Reviewer did not produce a trustworthy read-only report.",
            false,
            "review_gate"
          )
        });
      }
      if (!report.gate_passed) {
        return await this.finalize(goal.goal_id, "failed", {
          failure: this.failure(
            "review_gate_failed",
            `Review gate blocked completion with ${report.blocking_findings.length} blocking finding(s) and ${report.critical_uncovered_scope.length} critical uncovered scope item(s).`,
            false,
            "review_gate"
          ),
          result: {
            failure_domain: "review_gate",
            review_mode: report.mode,
            review_gate_passed: false,
            blocking_review_findings: report.blocking_findings,
            critical_uncovered_scope: report.critical_uncovered_scope
          }
        });
      }

      const unresolved = unresolvedBlockingItems(evaluated.contract);
      if (unresolved.length) {
        const failed = unresolved.filter((item) => item.status === "failed" || item.status === "blocked");
        const ids = unresolved.map((item) => item.id).join(", ");
        return await this.finalize(goal.goal_id, failed.length ? "failed" : "blocked", {
          failure: this.failure(
            failed.length ? "acceptance_contract_failed" : "acceptance_contract_not_covered",
            failed.length
              ? `Blocking acceptance items failed after review: ${ids}.`
              : `Blocking acceptance items remain uncovered after review: ${ids}.`,
            false,
            "acceptance"
          ),
          result: {
            failure_domain: "acceptance",
            acceptance_blocking_passed: false,
            unresolved_acceptance_ids: unresolved.map((item) => item.id)
          }
        });
      }
      return await this.finalize(goal.goal_id, "succeeded", {
        result: {
          review_mode: report.mode,
          review_finding_count: report.findings.length,
          review_advisory_only: report.mode === "advisory",
          review_gate_passed: report.gate_passed,
          acceptance_blocking_passed: evaluated.summary.blocking_passed
        }
      });
    } catch (error) {
      return await this.finalize(goal.goal_id, "failed", {
        failure: this.failure("review_error", safeError(error), false, "review_gate")
      });
    }
  }

  private async handleLaunchFailure(
    goalId: string,
    error: unknown,
    options: GoalExecutionOptions,
    operation: "start" | "resume"
  ): Promise<GoalRecord> {
    const message = safeError(error);
    if (isResourceWaitTimeoutError(error)) {
      return await this.finalize(goalId, "blocked", {
        failure: this.failure(
          "resource_wait_timeout",
          message,
          false,
          "infrastructure_policy",
          {
            sandbox_mode: options.sandbox_mode,
            side_effect_level: options.sandbox_mode === "workspace-write" ? "local_write" : "read_only",
            non_idempotent: false,
            policy_layer: "resource_governor"
          }
        ),
        result: {
          replayed: false,
          automatic_retry: false,
          resource_wait_timeout: true
        }
      });
    }
    const adapterCode = error instanceof CodexAdapterError ? error.code : undefined;
    if (adapterCode === "resource_wait_timeout") {
      return await this.finalize(goalId, "blocked", {
        failure: this.failure(
          "resource_wait_timeout",
          message,
          false,
          "infrastructure_policy",
          {
            sandbox_mode: options.sandbox_mode,
            side_effect_level: options.sandbox_mode === "workspace-write" ? "local_write" : "read_only",
            non_idempotent: false,
            policy_layer: "exec_slot"
          }
        ),
        result: {
          replayed: false,
          automatic_retry: false,
          resource_wait_timeout: true
        }
      });
    }
    const launchClassification = classifyLoopFailure({
      code: adapterCode ?? `codex_${operation}_failed`,
      message,
      sandbox_mode: options.sandbox_mode,
      side_effect_level: options.sandbox_mode === "workspace-write" ? "local_write" : "read_only",
      non_idempotent: options.sandbox_mode === "workspace-write"
    });
    if (launchClassification.category === "authorization_required") {
      const waiting = await this.store.transition(goalId, "waiting_approval", "goal.authorization_required", {
        data: {
          operation,
          failure_category: launchClassification.category,
          failure_fingerprint: launchClassification.fingerprint
        },
        patch: (goal) => {
          goal.loop_state = this.nextLoopState(goal, {
            classification: launchClassification,
            phase: "waiting_approval"
          });
          goal.checkpoint = {
            ...checkpointOf(goal),
            phase: "waiting_approval",
            pending_operation: null,
            recovery_required: true,
            recovery_reason: launchClassification.reason,
            replay_allowed: false,
            codex_turn_terminal: true,
            authorization_required: true,
            retry_launch_operation: operation,
            last_error: message
          };
        }
      });
      return await this.dispatchHook(waiting, "task.waiting_approval", {
        source_event_type: "goal.authorization_required"
      });
    }
    const uncertainWrite = options.sandbox_mode === "workspace-write" && transientFailure(message);
    return await this.finalize(goalId, uncertainWrite ? "blocked" : "failed", {
      failure: this.failure(
        uncertainWrite ? "uncertain_non_idempotent_operation" : `codex_${operation}_failed`,
        message,
        false,
        this.adapter.provider === "exec" ? "runner" : "codex",
        {
          sandbox_mode: options.sandbox_mode,
          side_effect_level: options.sandbox_mode === "workspace-write" ? "local_write" : "read_only",
          non_idempotent: options.sandbox_mode === "workspace-write",
          external_state_unknown: uncertainWrite
        }
      ),
      result: {
        replayed: false,
        automatic_retry: false,
        uncertain_non_idempotent_operation: uncertainWrite
      }
    });
  }

  private async recoverHookDeliveries(): Promise<void> {
    if (!this.hookBridge?.enabled) return;
    const goals = await this.store.listGoals();
    for (const goal of goals) {
      if (
        !isGoalTerminal(goal.status)
        || goal.status === "cancelled"
        || goal.final_notification_sent
        || Boolean(goal.hook_delivery?.last_error)
      ) continue;
      const eventType: GoalHookEventType = goal.status === "succeeded" ? "task.succeeded" : "task.failed";
      await this.dispatchHook(goal, eventType, { source_event_type: `goal.${goal.status}` });
    }
  }

  private async dispatchHook(
    goal: GoalRecord,
    eventType: GoalHookEventType,
    options: { source_event_type?: string; manual_replay?: boolean } = {}
  ): Promise<GoalRecord> {
    const bridge = this.hookBridge;
    if (!bridge?.enabled) return goal;
    const terminalNotification = eventType === "task.succeeded" || eventType === "task.failed";
    if (terminalNotification && goal.final_notification_sent) return goal;

    const eventKey = `${eventType}:${goal.status}:${goal.last_event_sequence}`;
    const messageStore = createWorkspaceMessageStore(this.workspace.root);
    const message = await messageStore.append({
      message_type: "hook.delivery",
      producer: "goal_manager",
      consumer: "hook_bridge",
      task_id: goal.goal_id,
      run_id: goal.run_id,
      dedupe_key: options.manual_replay === true ? `${eventKey}:manual:${Date.now()}` : eventKey,
      payload: {
        goal_id: goal.goal_id,
        goal_status: goal.status,
        hook_event_type: eventType,
        event_key: eventKey,
        terminal_notification: terminalNotification,
        source_event_type: options.source_event_type ?? null,
        manual_replay: options.manual_replay === true
      },
      max_attempts: 1
    });
    try {
      const dispatched = await messageStore.dispatchById<GoalRecord>(message.message_id, "hook_bridge", async (durableMessage) => {
        const claim = await this.store.claimHookDelivery(goal.goal_id, eventKey, eventType, {
          terminal_notification: terminalNotification,
          allow_replay: options.manual_replay === true
        });
        if (!claim.claimed) return claim.goal;

        const result = await bridge.deliver({
          type: eventType,
          goal: claim.goal,
          ...(options.source_event_type ? { source_event_type: options.source_event_type } : {}),
          ...(options.manual_replay ? { manual_replay: true } : {})
        });
        const requiredNotificationMissing = result.notification_required && !result.notification_sent;
        const deliveryFailedWithoutNotification = !result.ok && !result.notification_sent;
        if (requiredNotificationMissing || deliveryFailedWithoutNotification) {
          await this.store.failHookDelivery(
            goal.goal_id,
            eventKey,
            eventType,
            result.errors.join(" | ") || "Hook Bridge did not send the required notification.",
            {
              notification_sent: result.notification_sent,
              task_state_updated: result.task_state_updated,
              context_card_written: result.context_card_written,
              manual_replay: options.manual_replay === true
            }
          );
          throw new Error(result.errors.join(" | ") || "Hook Bridge did not send the required notification.");
        }
        return await this.store.completeHookDelivery(goal.goal_id, eventKey, eventType, {
          notification_sent: result.notification_sent,
          task_state_updated: result.task_state_updated,
          context_card_written: result.context_card_written,
          ok: result.ok,
          errors: result.errors
        });
      });
      if (dispatched.result) return dispatched.result;
      return await this.store.loadGoal(goal.goal_id);
    } catch (error) {
      const errorMessage = safeError(error);
      try {
        return await this.store.failHookDelivery(goal.goal_id, eventKey, eventType, errorMessage, {
          durable_message_id: message.message_id,
          manual_replay: options.manual_replay === true
        });
      } catch {
        return await this.store.loadGoal(goal.goal_id).catch(() => goal);
      }
    }
  }

  private async finalize(
    goalId: string,
    requestedStatus: GoalTerminalStatus,
    details: { failure?: GoalFailure; result?: Record<string, unknown>; final_response?: string } = {}
  ): Promise<GoalRecord> {
    await this.releaseGoalResourceLease(goalId);
    let goal = await this.store.loadGoal(goalId);
    if (isGoalTerminal(goal.status)) return goal;
    let finalStatus = requestedStatus;
    let failure = details.failure;
    const checkpoint = checkpointOf(goal);

    if (goal.snapshot_id && checkpoint.snapshot_finished !== true) {
      try {
        await this.finishSnapshot(goal.snapshot_id, `Goal ${goal.goal_id} entering terminal status ${requestedStatus}.`);
        goal = await this.store.patch(goal.goal_id, "goal.snapshot_finished", (next) => {
          next.checkpoint = { ...checkpointOf(next), snapshot_finished: true };
        });
      } catch (error) {
        if (requestedStatus === "succeeded") {
          finalStatus = "failed";
          failure = this.failure("snapshot_finish_failed", safeError(error), false);
        } else {
          await this.store.patch(goal.goal_id, "goal.snapshot_finish_warning", (next) => {
            next.checkpoint = { ...checkpointOf(next), last_error: safeError(error) };
          });
        }
      }
    }

    const changedFiles = executionRelevantChangedFiles(this.changedFileReader());
    const failureClassification = failure
      ? (() => {
          const classified = classifyLoopFailure({
            code: failure.category ?? failure.code,
            message: failure.message,
            failure_domain: failure.failure_domain,
            contract_changed: failure.category === "contract_changed",
            external_state_unknown: failure.category === "external_state_unknown",
            evidence_refs: [
              ...(goal.validation_result?.report_path ? [goal.validation_result.report_path] : []),
              ...goal.evidence.map((item) => item.path).filter((item): item is string => Boolean(item))
            ]
          });
          return {
            ...classified,
            category: failure.category ?? classified.category,
            fingerprint: failure.fingerprint ?? classified.fingerprint,
            retry_disposition: (failure.retry_disposition as LoopFailureClassification["retry_disposition"] | undefined)
              ?? classified.retry_disposition,
            recommended_action: failure.recommended_action ?? classified.recommended_action
          };
        })()
      : undefined;
    const finalLoopState = this.nextLoopState(goal, {
      phase: finalStatus,
      classification: failureClassification,
      verification_passed: finalStatus === "succeeded",
      progress_fingerprint: loopProgressFingerprint({
        status: finalStatus,
        phase: finalStatus,
        changed_files: changedFiles,
        evidence_ids: goal.evidence.map((item) => item.evidence_id),
        contract_version: goal.goal_contract.contract_version
      })
    });
    let finalLatency = startGoalLatencyStage(goal.checkpoint?.latency, "report");
    const coreExecutionCompletedAt = new Date().toISOString();
    const result: Record<string, unknown> = {
      goal_id: goal.goal_id,
      run_id: goal.run_id,
      execution_provider: this.adapter.provider,
      changed_files: changedFiles,
      subagent_result: goal.subagent_result,
      validation_result: goal.validation_result,
      review_result: goal.review_result,
      acceptance_contract: goal.acceptance_contract,
      acceptance_summary: summarizeAcceptanceContract(goal.acceptance_contract),
      evidence: goal.evidence,
      structured_result: goal.checkpoint?.structured_result ?? null,
      loop_state: finalLoopState,
      failure_classification: failureClassification ?? null,
      failure: failure ?? null,
      final_response: details.final_response ?? goal.checkpoint?.final_response ?? null,
      automatic_retry: false,
      ...(details.result ?? {}),
      core_execution_completed_at: coreExecutionCompletedAt,
      final_response_ready_at: coreExecutionCompletedAt,
      completed_at: coreExecutionCompletedAt
    };

    const persistSessionTreeResult = async (): Promise<void> => {
      try {
        const tree = await this.sessionTree.load(`goal-${goal.goal_id}`);
        if (tree) {
          await this.sessionTree.addNode(`goal-${goal.goal_id}`, {
            parent_node_id: tree.active_node_id,
            kind: "result",
            label: `Goal ${finalStatus}`,
            summary: failure?.message ?? details.final_response ?? `Goal ended with status ${finalStatus}.`,
            status: finalStatus === "succeeded" ? "succeeded" : finalStatus === "cancelled" ? "abandoned" : "failed",
            tags: ["goal-result", finalStatus],
            bindings: captureSessionBindings(this.config, this.workspace, {
              changed_files: changedFiles,
              task_snapshot_id: goal.snapshot_id ?? undefined,
              acceptance_artifacts: [
                ...(goal.validation_result?.report_path ? [goal.validation_result.report_path] : []),
                ...goal.evidence.map((item) => item.path).filter((item): item is string => Boolean(item))
              ]
            })
          });
        }
      } catch {
        // Session Tree is an index over authoritative Goal/Git/Artifact state; terminal Goal status must remain durable.
      }
    };

    finalLatency = completeGoalLatencyStage(finalLatency, "report");
    finalLatency = finalizeGoalLatency(finalLatency);
    result.latency_breakdown = finalLatency.breakdown;

    const terminalEventEmittedAt = new Date().toISOString();
    const hookDeliveryStatus = this.hookBridge?.enabled ? "pending" : "disabled";
    result.terminal_event_emitted_at = terminalEventEmittedAt;
    result.goal_terminal_at = terminalEventEmittedAt;
    const finalized = await this.store.finalizeGoal(goal.goal_id, finalStatus, `goal.${finalStatus}`, result, {
      data: {
        changed_files: changedFiles,
        failure_code: failure?.code ?? null,
        failure_category: failureClassification?.category ?? null,
        loop_action: finalLoopState.last_decision?.action ?? null,
        stop_reason: finalLoopState.stop_reason
      },
      patch: (next) => {
        next.changed_files = changedFiles;
        next.failure = failure ?? null;
        next.loop_state = finalLoopState;
        next.checkpoint = {
          ...checkpointOf(next),
          latency: finalLatency,
          phase: finalStatus,
          pending_operation: null,
          replay_allowed: false,
          core_execution_completed_at: coreExecutionCompletedAt,
          final_response_ready_at: coreExecutionCompletedAt,
          goal_terminal_at: terminalEventEmittedAt,
          terminal_event_emitted_at: terminalEventEmittedAt,
          acceptance_status: next.validation_result?.status ?? next.checkpoint?.acceptance_status ?? "not_required",
          receipt_status: next.checkpoint?.receipt_status ?? "not_required",
          hook_delivery_status: hookDeliveryStatus,
          provider_run: this.closeProviderRun(next, finalStatus)
        };
      }
    });

    void persistSessionTreeResult();
    recordGoalTerminalUsage(this.workspace.root, this.adapter.provider, finalized);
    const hookEvent: GoalHookEventType = finalStatus === "succeeded"
      ? "task.succeeded"
      : finalStatus === "cancelled"
        ? "task.cancelled"
        : "task.failed";
    if (this.hookBridge?.enabled) {
      void this.dispatchHook(finalized, hookEvent, { source_event_type: `goal.${finalStatus}` }).catch(() => undefined);
    }
    return finalized;
  }

  private failure(
    code: string,
    message: string,
    retryable: boolean,
    failureDomain?: GoalFailure["failure_domain"],
    context: {
      sandbox_mode?: string;
      side_effect_level?: "read_only" | "local_write" | "external_write" | "unknown";
      non_idempotent?: boolean;
      external_state_unknown?: boolean;
      policy_layer?: string;
    } = {}
  ): GoalFailure {
    const safeMessage = redactSensitiveText(message).slice(0, 8_000);
    const classification = classifyLoopFailure({
      code,
      message: safeMessage,
      failure_domain: failureDomain,
      sandbox_mode: context.sandbox_mode,
      side_effect_level: context.side_effect_level,
      non_idempotent: context.non_idempotent,
      external_state_unknown: context.external_state_unknown,
      policy_layer: context.policy_layer
    });
    return {
      code,
      message: safeMessage,
      retryable: retryable && classification.retry_disposition === "retry_limited",
      ...(failureDomain ? { failure_domain: failureDomain } : {}),
      category: classification.category,
      fingerprint: classification.fingerprint,
      retry_disposition: classification.retry_disposition,
      recommended_action: classification.recommended_action,
      occurred_at: new Date().toISOString()
    };
  }
}
