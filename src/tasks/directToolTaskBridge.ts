import { createHash, randomUUID } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { createWorkspaceExecutionComponentStore, type ExecutionComponentStore } from "../execution/componentStore.js";
import { PathGuard, type Workspace } from "../guard.js";
import { DurableJobStore, durableHash, type DurableJobOwnership } from "../jobs/jobStore.js";
import type { DurableJobRecord, DurableJobStep } from "../jobs/jobSteps.js";
import { ObserverEventStore } from "../observability/observerEventStore.js";
import { redactSensitiveText } from "../redact.js";
import {
  createRuntimeActivityEvent,
  type RuntimeActivityState
} from "../runtime/activityEvents.js";
import { RuntimeActivityEventStore } from "../runtime/activityEventStore.js";
import type { CanonicalToolOutcomeV1 } from "../runtime/orthogonalToolOutcome.js";
import { normalizePublicToolOutcome, type OfficeProjectionReceiptV1, type PublicToolOutcomeV1 } from "../runtime/publicToolOutcome.js";
import { ToolOutcomeProjectionPublisher } from "../runtime/toolOutcomeProjectionPublisher.js";
import { TaskProjectionService } from "./taskProjectionService.js";
import type { TaskStatusProjection } from "./types.js";

export type DirectToolActivityPhase = "analysis" | "development" | "validating" | "delivery" | "archive";
export interface DirectToolActivityPlan {
  phase: DirectToolActivityPhase;
  action: string;
  activity_state: RuntimeActivityState;
  writer: boolean;
  allow_create: boolean;
  force_new: boolean;
  terminal_on_success: boolean;
}
export interface DirectToolTaskActivityHandle {
  observer_only: false;
  call_role: "executor";
  task_id: string;
  run_id: string;
  worker_id: string;
  tool_component_id: string;
  step_id: string | null;
  synthetic: boolean;
  plan: DirectToolActivityPlan;
  correlation_id: string;
  tool_name: string;
  objective_id: string;
  actor_id: string | null;
  actor_role: "executor" | "reviewer" | "observer" | "system";
  heartbeat_timer: NodeJS.Timeout | null;
  ownership: DurableJobOwnership | null;
}

export interface DirectToolObserverActivityHandle {
  observer_only: true;
  call_role: "observer";
  observer_session_id: string;
  plan: DirectToolActivityPlan;
  correlation_id: string;
  tool_name: string;
  actor_id: string;
}

export type DirectToolActivityHandle = DirectToolTaskActivityHandle | DirectToolObserverActivityHandle;

export type DirectToolActivityBinding =
  | { observer_only: false; call_role: "executor"; task_id: string; run_id: string; phase: string; terminal: boolean }
  | { observer_only: true; call_role: "observer"; observer_session_id: string; correlation_id: string; status: "completed" | "failed" };
export interface DirectToolTaskBridgeOptions {
  heartbeat_interval_ms?: number;
  idle_archive_ms?: number;
  stale_cleanup_interval_ms?: number;
  now?: () => Date;
}

const ACTIVE_TASK_STATUSES = new Set(["created", "assigned", "queued", "running", "validating", "recovering", "waiting", "implemented_not_verified"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);
const VALIDATION_TOOL_PATTERN = /(?:^|_)(?:test|tests|lint|typecheck|healthcheck|validation|acceptance|smoke|build)(?:_|$)/i;
const VALIDATION_COMMAND_PATTERN = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|smoke)\b|\b(?:pytest|vitest|jest|tsc|eslint)\b|\bnode\s+scripts\/[\w.-]*(?:smoke|check|acceptance|test)[\w.-]*\.mjs\b/i;
const DIRECT_RUN_PREFIX = "direct-";
const LEGACY_STALE_TITLE = "Durable bash validation";
const READ_ONLY_TOOL_NAMES = new Set([
  "open_current_workspace",
  "open_workspace",
  "read_rule_summary",
  "read_project_config",
  "read_project_profile",
  "read_project_memory",
  "summarize_project_memory",
  "read_handoff",
  "read",
  "read_many_files",
  "search",
  "search_project",
  "tree",
  "detect_project",
  "dirty_guard",
  "git_summary",
  "git_prepare_commit",
  "git_get_remote_state",
  "show_changes",
  "browser_observe",
  "browser_inspect",
  "browser_console",
  "browser_network",
  "browser_status",
  "browser_tabs"
]);

function cleanText(value: unknown, fallback: string, max = 160): string {
  const text = redactSensitiveText(String(value ?? "")).replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, max);
}
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function safeSegment(value: string, fallback = "tool"): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 48);
}
function progressFingerprint(phase: string, action: string, currentStep: number): string {
  return `sha256:${createHash("sha256").update(`${phase}\0${action}\0${currentStep}`).digest("hex")}`;
}
function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
function commandFromArgs(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (hasArrayItems(args.commands)) return (args.commands as unknown[]).map(String).join("\n");
  return "";
}
function readOnlyAction(toolName: string): string {
  if (["search", "search_project"].includes(toolName)) return "正在检索项目代码";
  if (["read", "read_many_files", "read_rule_summary", "read_project_config", "read_project_profile", "read_project_memory", "summarize_project_memory", "read_handoff"].includes(toolName)) return "正在读取项目资料";
  if (["open_workspace", "open_current_workspace"].includes(toolName)) return "正在打开并核对工作区";
  if (["tree", "detect_project"].includes(toolName)) return "正在检查项目结构";
  if (["dirty_guard", "git_summary", "git_prepare_commit", "git_get_remote_state", "show_changes"].includes(toolName)) return "正在检查 Git 基线与改动";
  if (toolName.startsWith("browser_")) return "正在只读检查浏览器状态";
  return `正在执行只读工具 ${toolName}`;
}

function titleFromArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "start_task_snapshot") return cleanText(args.task_name, "Direct workspace task");
  if (typeof args.title === "string" && args.title.trim()) return cleanText(args.title, "Direct workspace task");
  const target = typeof args.path === "string" ? args.path : typeof args.cwd === "string" ? args.cwd : "workspace";
  return cleanText(`Direct workspace task · ${toolName} ${target}`, "Direct workspace task");
}
function activeProjection(projection: TaskStatusProjection | undefined, workspace: Workspace): boolean {
  return Boolean(projection
    && projection.identity.project_root === workspace.root
    && ACTIVE_TASK_STATUSES.has(projection.status)
    && !["stale", "stopped"].includes(projection.liveness.state));
}
export function retryableValidationProjection(
  projection: TaskStatusProjection | undefined,
  workspace: Workspace,
  plan: DirectToolActivityPlan
): boolean {
  if (!projection || projection.identity.project_root !== workspace.root || plan.phase !== "validating") return false;
  const failed = projection.status === "failed"
    || projection.outcome.execution_status === "failed"
    || projection.outcome.validation_status === "failed"
    || projection.acceptance.status === "failed";
  return failed && ["stale", "stopped", "terminal"].includes(projection.liveness.state);
}
function resultData(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured) ? structured as Record<string, unknown> : {};
}
function resultIndicatesFailure(result: unknown): boolean {
  if ((result as { isError?: boolean } | undefined)?.isError) return true;
  const data = resultData(result);
  const exitCode = typeof data.exitCode === "number" ? data.exitCode : typeof data.exit_code === "number" ? data.exit_code : null;
  if (exitCode !== null && exitCode !== 0) return true;
  if (data.passed === false || data.success === false) return true;
  return typeof data.status === "string" && ["failed", "error", "blocked", "cancelled"].includes(data.status.toLowerCase());
}
function resultIndicatesBlocked(result: unknown): boolean {
  const data = resultData(result);
  return typeof data.status === "string" && data.status.toLowerCase() === "blocked";
}
function resultSummary(result: unknown): string {
  const data = resultData(result);
  const exitCode = typeof data.exitCode === "number" ? data.exitCode : typeof data.exit_code === "number" ? data.exit_code : null;
  if (exitCode !== null && exitCode !== 0) return `命令执行失败，退出码 ${exitCode}`;
  for (const key of ["summary", "status", "reason_code", "message"]) {
    if (typeof data[key] === "string" && data[key]) return cleanText(data[key], "工具调用已完成", 240);
  }
  return resultIndicatesFailure(result) ? "工具调用返回错误" : "工具调用已完成";
}
function resultEvidence(result: unknown): string {
  const data = resultData(result);
  for (const key of ["report_path", "path", "evidence_path", "snapshot_id", "run_id"]) {
    if (typeof data[key] === "string" && data[key]) return cleanText(data[key], "mcp_tool_result", 500);
  }
  return "mcp_tool_result";
}
function delegatedDurableTask(result: unknown): boolean {
  const data = resultData(result);
  return data.dispatch_mode === "durable" && typeof data.task_id === "string" && typeof data.run_id === "string";
}

export function classifyDirectToolActivity(toolName: string, rawArgs: unknown): DirectToolActivityPlan | null {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  if (toolName === "start_task_snapshot") return { phase: "analysis", action: "建立当前任务与执行轮次", activity_state: "tool_reading", writer: false, allow_create: true, force_new: true, terminal_on_success: false };
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return { phase: "analysis", action: readOnlyAction(toolName), activity_state: "tool_reading", writer: false, allow_create: false, force_new: false, terminal_on_success: false };
  if (["write", "edit", "apply_patch_bundle"].includes(toolName)) return { phase: "development", action: `执行 ${toolName} 写入`, activity_state: "tool_writing", writer: true, allow_create: true, force_new: false, terminal_on_success: false };
  if (toolName === "run_task" || toolName === "run_stage") {
    if (hasArrayItems(args.patches)) return { phase: "development", action: `执行 ${toolName} 代码变更`, activity_state: "tool_writing", writer: true, allow_create: true, force_new: false, terminal_on_success: false };
    if (hasArrayItems(args.commands)) return { phase: "validating", action: `执行 ${toolName} 验证`, activity_state: "validating", writer: false, allow_create: true, force_new: false, terminal_on_success: false };
    return null;
  }
  if (toolName === "run_validation" || toolName === "run_acceptance" || VALIDATION_TOOL_PATTERN.test(toolName)) return { phase: "validating", action: `执行 ${toolName} 验证`, activity_state: "validating", writer: false, allow_create: true, force_new: false, terminal_on_success: false };
  if (toolName === "bash" && VALIDATION_COMMAND_PATTERN.test(commandFromArgs(args))) return { phase: "validating", action: "执行测试或构建命令", activity_state: "validating", writer: false, allow_create: true, force_new: false, terminal_on_success: false };
  if (toolName === "git_prepare") return { phase: "delivery", action: `准备 ${toolName} 交付`, activity_state: "delivering", writer: false, allow_create: false, force_new: false, terminal_on_success: false };
  if (["publish_task_report", "publish_task_update"].includes(toolName)) return null;
  if (["git_commit", "git_push", "git_finalize", "task_complete", "finish_task_snapshot"].includes(toolName)) return { phase: "delivery", action: `执行 ${toolName} 收口`, activity_state: "delivering", writer: false, allow_create: false, force_new: false, terminal_on_success: true };
  return null;
}

export class DirectToolTaskBridge {
  private readonly guard: PathGuard;
  private readonly jobStore: DurableJobStore;
  private readonly taskService: TaskProjectionService;
  private readonly componentStore: ExecutionComponentStore;
  private readonly runtimeEvents: RuntimeActivityEventStore;
  private readonly observerEvents: ObserverEventStore;
  private readonly toolOutcomePublisher: ToolOutcomeProjectionPublisher;
  private readonly heartbeatIntervalMs: number;
  private readonly idleArchiveMs: number;
  private readonly staleCleanupIntervalMs: number;
  private readonly now: () => Date;
  private lastStaleCleanupAt = 0;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastActivityAt = new Map<string, number>();

  constructor(private readonly config: CodexProConfig, private readonly workspace: Workspace, options: DirectToolTaskBridgeOptions = {}) {
    this.guard = new PathGuard(config);
    this.jobStore = new DurableJobStore(this.guard, workspace, config);
    this.taskService = new TaskProjectionService(config, this.guard, workspace);
    this.componentStore = createWorkspaceExecutionComponentStore(workspace.root);
    this.runtimeEvents = new RuntimeActivityEventStore(this.guard, workspace);
    this.observerEvents = new ObserverEventStore(this.guard, workspace);
    this.toolOutcomePublisher = new ToolOutcomeProjectionPublisher(config, workspace);
    this.heartbeatIntervalMs = Math.max(20, Math.floor(options.heartbeat_interval_ms ?? 5_000));
    this.idleArchiveMs = Math.max(this.heartbeatIntervalMs * 2, Math.floor(options.idle_archive_ms ?? 30 * 60_000));
    this.staleCleanupIntervalMs = Math.max(0, Math.floor(options.stale_cleanup_interval_ms ?? 60_000));
    this.now = options.now ?? (() => new Date());
  }

  async begin(toolName: string, rawArgs: unknown, correlationId: string, plan: DirectToolActivityPlan): Promise<DirectToolActivityHandle | null> {
    await this.cleanupStaleLegacyTasks();
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
    const requestedActorRole = String(args.actor_role ?? process.env.CODEXPRO_ACTOR_ROLE ?? "executor").toLowerCase();
    if (requestedActorRole === "observer") {
      const observation = await this.observerEvents.start({
        correlation_id: correlationId,
        tool_name: toolName,
        action: plan.action,
        actor_id: typeof args.actor_id === "string" ? args.actor_id : null,
        conversation_id: this.workspace.conversationId
      });
      return {
        observer_only: true,
        call_role: "observer",
        observer_session_id: observation.session.session_id,
        plan,
        correlation_id: correlationId,
        tool_name: toolName,
        actor_id: observation.session.actor_id
      };
    }
    if (plan.force_new) await this.archiveIdleCurrentSynthetic("superseded_by_new_direct_task");
    let projection = plan.force_new
      ? undefined
      : await this.taskService.getCurrentForConversation(this.workspace.conversationId).catch(() => undefined);
    if (!activeProjection(projection, this.workspace) && !retryableValidationProjection(projection, this.workspace, plan)) projection = undefined;
    if (!projection && !plan.allow_create) {
      if (!READ_ONLY_TOOL_NAMES.has(toolName)) return null;
      const observation = await this.observerEvents.start({
        correlation_id: correlationId,
        tool_name: toolName,
        action: plan.action,
        actor_id: typeof args.actor_id === "string" ? args.actor_id : null,
        conversation_id: this.workspace.conversationId
      });
      return {
        observer_only: true,
        call_role: "observer",
        observer_session_id: observation.session.session_id,
        plan,
        correlation_id: correlationId,
        tool_name: toolName,
        actor_id: observation.session.actor_id
      };
    }
    if (!projection) projection = await this.createSyntheticTask(titleFromArgs(toolName, args));
    const current = projection as TaskStatusProjection;

    const taskId = current.identity.task_id;
    const objectiveId = current.identity.objective?.objective_key ?? `legacy:${current.identity.kind}:${current.identity.domain_id}`;
    const actorId = current.identity.actor?.actor_id ?? null;
    const actorRole = current.identity.actor?.role ?? "executor";
    const runId = current.execution?.run_id ?? current.executor?.execution_id ?? current.identity.domain_id;
    const synthetic = current.identity.kind === "durable_job" && runId.startsWith(DIRECT_RUN_PREFIX);
    const workerId = `worker:direct-tool:${shortHash(`${this.workspace.root}\0${taskId}`)}`;
    const toolComponentId = `tool_process:direct:${correlationId}`;
    const now = this.now().toISOString();
    let ownership: DurableJobOwnership | null = null;
    let stepId: string | null = null;

    if (synthetic) {
      ownership = await this.acquireSyntheticOwnership(runId);
      const job = await this.jobStore.readJob(runId);
      if (!job || !ownership) return null;
      if (job.status === "recovery_required" || job.status === "stale") {
        job.status = "running";
        job.recovery_reason = undefined;
        job.error = undefined;
      }
      const stepIndex = job.steps.length + 1;
      stepId = `${String(stepIndex).padStart(3, "0")}-${safeSegment(toolName)}`.slice(0, 80);
      const previousStepId = job.steps.at(-1);
      const step = {
        step_id: stepId,
        index: stepIndex,
        phase: plan.phase,
        status: "running",
        input_hash: durableHash({ tool_name: toolName, correlation_id: correlationId }),
        evidence_paths: [],
        heartbeat_at: now,
        idempotent: false,
        retryable: true,
        side_effect_level: plan.writer ? "local_write" : "read_only",
        retry_policy: "manual",
        attempts: 1,
        previous_step: previousStepId,
        pending_operation: toolName,
        started_at: now
      } as DurableJobStep;
      Object.assign(step, ownership);
      delete (step as DurableJobStep & { run_id?: string }).run_id;
      if (previousStepId) {
        const previous = await this.jobStore.readStep(runId, previousStepId);
        if (previous && previous.fencing_token === ownership.fencing_token) {
          previous.next_step = stepId;
          await this.jobStore.writeStepOwned(runId, previous, ownership);
        }
      }
      job.steps.push(stepId);
      job.current_step_id = stepId;
      job.status = "running";
      job.started_at ??= now;
      job.first_progress_at ??= now;
      job.progress = {
        ...job.progress,
        phase: plan.phase,
        current_step: stepIndex,
        total_steps: stepIndex,
        current_action: plan.action,
        heartbeat_at: now,
        liveness_at: now,
        progress_at: now,
        last_meaningful_progress_at: now,
        activity_state: plan.activity_state,
        safe_progress_summary: plan.action,
        user_action_required: null,
        last_activity_event: createRuntimeActivityEvent({ task_id: taskId, run_id: runId, source: "tool_process", activity_state: plan.activity_state, safe_summary: plan.action, occurred_at: now, evidence_ref: this.jobStore.stepPath(runId, stepId) }),
        progress_fingerprint: progressFingerprint(plan.phase, plan.action, stepIndex),
        retries: job.progress.retries ?? 0,
        writer_active: plan.writer,
        browser_active: false,
        execution_state: "working",
        wait_reason: undefined
      };
      await this.jobStore.writeStepOwned(runId, step, ownership);
      await this.jobStore.writeJobOwned(job, ownership);
    }

    await this.componentStore.register({ component_id: workerId, kind: "worker", task_id: taskId, run_id: runId, state: "running", progress_marker: plan.action, activity_state: plan.activity_state, safe_summary: plan.action, evidence_ref: stepId ? this.jobStore.stepPath(runId, stepId) : `mcp:${toolName}`, now });
    await this.componentStore.register({ component_id: toolComponentId, kind: "tool_process", task_id: taskId, run_id: runId, owner_id: workerId, state: "running", progress_marker: plan.action, activity_state: plan.activity_state, safe_summary: plan.action, evidence_ref: stepId ? this.jobStore.stepPath(runId, stepId) : `mcp:${toolName}`, now });
    this.lastActivityAt.set(runId, this.now().getTime());
    if (synthetic) this.ensureIdleHeartbeat(runId, workerId);

    await this.runtimeEvents.append({
      kind: "tool.started",
      objective_id: objectiveId,
      attempt_id: taskId,
      run_id: runId,
      actor_id: actorId,
      actor_role: actorRole,
      occurred_at: now,
      payload: { tool_name: toolName, phase: plan.phase, correlation_id: correlationId, state_authority_changed: false }
    }).catch(() => undefined);
    const runtimeKind = plan.phase === "validating"
      ? "validation.started"
      : plan.writer
        ? "edit.started"
        : "analysis.started";
    await this.runtimeEvents.append({
      kind: runtimeKind,
      objective_id: objectiveId,
      attempt_id: taskId,
      run_id: runId,
      actor_id: actorId,
      actor_role: actorRole,
      occurred_at: now,
      payload: { tool_name: toolName, phase: plan.phase, action: plan.action }
    }).catch(() => undefined);
    if (plan.writer) {
      await this.runtimeEvents.append({
        kind: "resource.acquired",
        objective_id: objectiveId,
        attempt_id: taskId,
        run_id: runId,
        actor_id: actorId,
        actor_role: actorRole,
        occurred_at: now,
        payload: { resource_type: "writer", correlation_id: correlationId }
      }).catch(() => undefined);
    }
    const handle: DirectToolTaskActivityHandle = { observer_only: false, call_role: "executor", task_id: taskId, run_id: runId, worker_id: workerId, tool_component_id: toolComponentId, step_id: stepId, synthetic, plan, correlation_id: correlationId, tool_name: toolName, objective_id: objectiveId, actor_id: actorId, actor_role: actorRole, heartbeat_timer: null, ownership };
    const timer = setInterval(() => void this.heartbeat(handle).catch(() => undefined), this.heartbeatIntervalMs);
    timer.unref();
    handle.heartbeat_timer = timer;
    return handle;
  }

  async heartbeat(handle: DirectToolTaskActivityHandle): Promise<void> {
    const now = this.now().toISOString();
    this.lastActivityAt.set(handle.run_id, this.now().getTime());
    await Promise.all([
      this.componentStore.heartbeat(handle.worker_id, { kind: "worker", at: now }),
      this.componentStore.heartbeat(handle.tool_component_id, { kind: "tool_process", owner_id: handle.worker_id, at: now })
    ]);
    if (!handle.synthetic || !handle.ownership || !handle.step_id) return;
    const job = await this.jobStore.readJob(handle.run_id);
    const step = await this.jobStore.readStep(handle.run_id, handle.step_id);
    if (!job || !step || TERMINAL_JOB_STATUSES.has(job.status)) return;
    job.progress.heartbeat_at = now;
    job.progress.liveness_at = now;
    step.heartbeat_at = now;
    await this.jobStore.writeStepOwned(handle.run_id, step, handle.ownership);
    await this.jobStore.writeJobOwned(job, handle.ownership);
  }

  async finish(handle: DirectToolActivityHandle, input: { outcome: "ok" | "error"; result?: unknown }): Promise<DirectToolActivityBinding> {
    const now = this.now().toISOString();
    const summary = resultSummary(input.result);
    const successful = input.outcome === "ok" && !resultIndicatesFailure(input.result);
    const blocked = resultIndicatesBlocked(input.result);
    if (handle.observer_only) {
      const status = successful ? "completed" : "failed";
      await this.observerEvents.finish({
        session_id: handle.observer_session_id,
        correlation_id: handle.correlation_id,
        tool_name: handle.tool_name,
        action: handle.plan.action,
        actor_id: handle.actor_id,
        status,
        error_code: successful ? null : blocked ? "blocked" : "tool_failed",
        safe_summary: successful ? `只读观察完成：${summary}` : `只读观察失败：${summary}`,
        occurred_at: now
      }).catch(() => undefined);
      return {
        observer_only: true,
        call_role: "observer",
        observer_session_id: handle.observer_session_id,
        correlation_id: handle.correlation_id,
        status
      };
    }
    if (handle.heartbeat_timer) clearInterval(handle.heartbeat_timer);
    handle.heartbeat_timer = null;
    const evidence = resultEvidence(input.result);
    const delegated = successful && delegatedDurableTask(input.result);
    let terminal = false;
    let phase: DirectToolActivityPhase = handle.plan.phase;

    await this.componentStore.terminal(handle.tool_component_id, { kind: "tool_process", owner_id: handle.worker_id, reason: successful ? "completed" : "failed", evidence_ref: evidence, at: now }).catch(() => undefined);
    if (handle.synthetic && handle.ownership && handle.step_id) {
      const job = await this.jobStore.readJob(handle.run_id);
      const step = await this.jobStore.readStep(handle.run_id, handle.step_id);
      if (job && step) {
        step.status = successful ? "completed" : "failed";
        step.finished_at = now;
        step.heartbeat_at = now;
        step.pending_operation = null;
        step.output_summary = summary;
        step.evidence_paths = evidence === "mcp_tool_result" ? [] : [evidence];
        if (!successful) step.error = summary;
        step.output_path = await this.jobStore.writeStepOutputOwned(handle.run_id, handle.step_id, { version: 1, tool_name: handle.tool_name, correlation_id: handle.correlation_id, outcome: input.outcome, summary, evidence_ref: evidence, completed_at: now }, handle.ownership);
        await this.jobStore.writeStepOwned(handle.run_id, step, handle.ownership);

        const persistedSteps = (await Promise.all(job.steps.map((stepId) => this.jobStore.readStep(handle.run_id, stepId))))
          .filter((item): item is DurableJobStep => Boolean(item));
        const hasWorkspaceWrites = persistedSteps.some((item) => item.phase === "development" && item.side_effect_level === "local_write" && item.status === "completed");
        const validationPassed = persistedSteps.some((item) => item.phase === "validating" && item.status === "completed" && item.step_id !== handle.step_id);
        const structuredResult = resultData(input.result);
        const noWorkspaceChanges = handle.tool_name === "show_changes" && structuredResult.changed === false;
        const archiveAllowed = handle.plan.terminal_on_success && (!hasWorkspaceWrites || validationPassed || handle.plan.phase === "validating");
        terminal = successful && (delegated || archiveAllowed);
        if (!successful) {
          job.status = "recovery_required";
          job.recovery_reason = summary;
          job.error = summary;
          job.progress.execution_state = "blocked";
          job.progress.wait_reason = summary;
          job.progress.current_action = `执行失败：${summary}`;
        } else if (delegated) {
          job.status = "completed";
          job.finished_at = now;
          job.duration_ms = job.started_at ? Math.max(0, Date.parse(now) - Date.parse(job.started_at)) : undefined;
          job.result_summary = "已转交同一目标的独立验收轮次继续执行";
          phase = "validating";
          job.progress.execution_state = "terminal";
          job.progress.wait_reason = undefined;
          job.progress.current_action = "已转交同一目标的验收轮次";
        } else if (archiveAllowed) {
          job.status = "completed";
          job.finished_at = now;
          job.duration_ms = job.started_at ? Math.max(0, Date.parse(now) - Date.parse(job.started_at)) : undefined;
          job.result_summary = summary;
          phase = "archive";
          job.progress.execution_state = "terminal";
          job.progress.wait_reason = undefined;
          job.progress.current_action = "任务已完成并归档";
        } else if (handle.plan.phase === "validating") {
          job.status = "running";
          phase = "delivery";
          job.progress.execution_state = "waiting";
          job.progress.wait_reason = "验证通过，等待交付或继续修改。";
          job.progress.current_action = "验证通过，等待交付";
        } else if (hasWorkspaceWrites && !validationPassed && handle.plan.phase !== "delivery") {
          job.status = "running";
          phase = "validating";
          job.progress.execution_state = "waiting";
          job.progress.wait_reason = "实现步骤已完成，等待运行验收。";
          job.progress.current_action = "代码已完成，等待验收";
        } else if (handle.plan.phase === "delivery") {
          job.status = "running";
          phase = noWorkspaceChanges && !hasWorkspaceWrites
            ? "development"
            : hasWorkspaceWrites && !validationPassed
              ? "validating"
              : "delivery";
          job.progress.execution_state = "waiting";
          job.progress.wait_reason = noWorkspaceChanges && !hasWorkspaceWrites
            ? "当前没有待交付的工作树改动。"
            : hasWorkspaceWrites && !validationPassed
              ? "代码修改尚未通过验收。"
              : "等待最终交付。";
          job.progress.current_action = noWorkspaceChanges && !hasWorkspaceWrites
            ? "没有待交付改动，等待下一步"
            : hasWorkspaceWrites && !validationPassed
              ? "代码已完成，等待验收"
              : "交付准备完成";
        } else {
          job.status = "running";
          phase = handle.plan.phase === "analysis" ? "analysis" : "development";
          job.progress.execution_state = "waiting";
          job.progress.wait_reason = "当前工具步骤已完成，尚未要求用户操作。";
          job.progress.current_action = handle.plan.phase === "analysis" ? `已完成：${handle.plan.action}` : "本步完成，等待下一步";
        }
        job.progress.phase = phase;
        job.progress.heartbeat_at = now;
        job.progress.liveness_at = now;
        const finalActivityState: RuntimeActivityState = !successful
          ? "stalled"
          : terminal
            ? "terminal"
            : "idle_between_steps";
        job.progress.progress_at = now;
        job.progress.last_meaningful_progress_at = now;
        job.progress.activity_state = finalActivityState;
        job.progress.safe_progress_summary = job.progress.current_action;
        job.progress.user_action_required = null;
        job.progress.last_activity_event = createRuntimeActivityEvent({
          task_id: handle.task_id,
          run_id: handle.run_id,
          source: "task_runtime",
          activity_state: finalActivityState,
          safe_summary: job.progress.current_action,
          occurred_at: now,
          meaningful_progress: true,
          evidence_ref: evidence
        });
        job.progress.progress_fingerprint = progressFingerprint(phase, job.progress.current_action, job.progress.current_step);
        job.progress.writer_active = false;
        job.progress.browser_active = false;
        await this.jobStore.writeJobOwned(job, handle.ownership);
        await this.jobStore.releaseRunOwner(handle.ownership);
        handle.ownership = null;
      }
    }

    if (terminal) {
      await this.componentStore.terminal(handle.worker_id, { kind: "worker", reason: "task_completed", evidence_ref: evidence, at: now }).catch(() => undefined);
      this.stopIdleHeartbeat(handle.run_id);
    } else {
      const workerActivityState: RuntimeActivityState = successful ? "idle_between_steps" : "stalled";
      const workerSummary = successful
        ? phase === "validating"
          ? "代码已完成，等待验收"
          : handle.plan.phase === "analysis"
            ? `已完成：${handle.plan.action}`
            : phase === "delivery"
              ? "验证或交付准备已完成"
              : "等待下一步"
        : `需要处理：${summary}`;
      await this.componentStore.progress(handle.worker_id, { kind: "worker", marker: workerSummary, activity_state: workerActivityState, safe_summary: workerSummary, evidence_ref: evidence, at: now }).catch(() => undefined);
      await this.componentStore.transition(handle.worker_id, { kind: "worker", state: successful ? "idle" : "stale", activity_state: workerActivityState, safe_summary: workerSummary, user_action_required: null, evidence_ref: evidence, at: now }).catch(() => undefined);
    }
    this.lastActivityAt.set(handle.run_id, this.now().getTime());
    const terminalKind = handle.plan.phase === "validating"
      ? blocked
        ? "validation.blocked"
        : successful
          ? "validation.passed"
          : "validation.failed"
      : handle.plan.writer
        ? "edit.completed"
        : null;
    await this.runtimeEvents.append({
      kind: successful ? "tool.completed" : "tool.failed",
      objective_id: handle.objective_id,
      attempt_id: handle.task_id,
      run_id: handle.run_id,
      actor_id: handle.actor_id,
      actor_role: handle.actor_role,
      occurred_at: now,
      payload: {
        tool_name: handle.tool_name,
        correlation_id: handle.correlation_id,
        outcome: blocked ? "blocked" : successful ? "completed" : "failed",
        safe_summary: summary,
        evidence_ref: evidence,
        state_authority_changed: false
      }
    }).catch(() => undefined);
    if (terminalKind) {
      await this.runtimeEvents.append({
        kind: terminalKind,
        objective_id: handle.objective_id,
        attempt_id: handle.task_id,
        run_id: handle.run_id,
        actor_id: handle.actor_id,
        actor_role: handle.actor_role,
        occurred_at: now,
        payload: { tool_name: handle.tool_name, outcome: blocked ? "blocked" : successful ? "passed" : "failed", evidence_ref: evidence }
      }).catch(() => undefined);
    }
    if (handle.plan.writer) {
      await this.runtimeEvents.append({
        kind: "resource.released",
        objective_id: handle.objective_id,
        attempt_id: handle.task_id,
        run_id: handle.run_id,
        actor_id: handle.actor_id,
        actor_role: handle.actor_role,
        occurred_at: now,
        payload: { resource_type: "writer", correlation_id: handle.correlation_id }
      }).catch(() => undefined);
    }
    if (terminal && successful) {
      await this.runtimeEvents.append({
        kind: "objective.completed",
        objective_id: handle.objective_id,
        attempt_id: handle.task_id,
        run_id: handle.run_id,
        actor_id: handle.actor_id,
        actor_role: handle.actor_role,
        occurred_at: now,
        terminal: true,
        payload: { evidence_ref: evidence }
      }).catch(() => undefined);
    }
    return { observer_only: false, call_role: "executor", task_id: handle.task_id, run_id: handle.run_id, phase, terminal };
  }

  preparePublicToolOutcome(
    handle: DirectToolActivityHandle | null,
    binding: DirectToolActivityBinding | null,
    input: {
      tool_name: string;
      correlation_id: string;
      args?: unknown;
      outcome: "ok" | "error";
      result?: unknown;
      canonical_outcome?: CanonicalToolOutcomeV1;
      started_at: string;
      completed_at: string;
      duration_ms: number;
    }
  ): PublicToolOutcomeV1 {
    return normalizePublicToolOutcome({
      project_id: this.workspace.projectId ?? this.workspace.id,
      workspace_id: this.workspace.id,
      workspace_generation: this.workspace.workspaceGeneration ?? 1,
      conversation_id: this.workspace.conversationId,
      objective_id: handle && !handle.observer_only ? handle.objective_id : null,
      attempt_id: handle && !handle.observer_only ? handle.task_id : null,
      actor_id: handle?.actor_id ?? null,
      actor_role: handle?.observer_only ? "observer" : handle?.actor_role ?? "system",
      correlation_id: input.correlation_id,
      tool_name: input.tool_name,
      phase: binding && !binding.observer_only ? binding.phase : handle?.plan.phase,
      started_at: input.started_at,
      completed_at: input.completed_at,
      duration_ms: input.duration_ms,
      outcome: input.outcome,
      args: input.args,
      result: input.result,
      canonical_outcome: input.canonical_outcome,
      binding
    });
  }

  queuedPublicToolOutcomeReceipt(outcome: PublicToolOutcomeV1): OfficeProjectionReceiptV1 {
    return {
      version: 1,
      event_id: outcome.event_id,
      projection_status: "queued",
      result_digest: outcome.result_digest,
      sequence: null,
      state_authority_changed: false
    };
  }

  async publishPreparedPublicToolOutcome(outcome: PublicToolOutcomeV1): Promise<OfficeProjectionReceiptV1> {
    return await this.toolOutcomePublisher.publish(outcome);
  }

  async projectPublicToolOutcome(
    handle: DirectToolActivityHandle | null,
    binding: DirectToolActivityBinding | null,
    input: {
      tool_name: string;
      correlation_id: string;
      args?: unknown;
      outcome: "ok" | "error";
      result?: unknown;
      started_at: string;
      completed_at: string;
      duration_ms: number;
    }
  ): Promise<OfficeProjectionReceiptV1> {
    return await this.publishPreparedPublicToolOutcome(this.preparePublicToolOutcome(handle, binding, input));
  }

  async cleanupStaleLegacyTasks(): Promise<number> {
    const cleanupAt = this.now().getTime();
    if (this.lastStaleCleanupAt > 0 && cleanupAt - this.lastStaleCleanupAt < this.staleCleanupIntervalMs) return 0;
    const jobs = await this.jobStore.readJobs(await this.jobStore.listJobIds());
    let cleaned = 0;
    for (const job of jobs) {
      const legacyValidation = job.title === LEGACY_STALE_TITLE;
      const syntheticDirectTask = job.run_id.startsWith(DIRECT_RUN_PREFIX);
      if ((!legacyValidation && !syntheticDirectTask) || TERMINAL_JOB_STATUSES.has(job.status)) continue;
      let stale = ["stale", "recovery_required"].includes(job.status) || job.progress.execution_state === "stale";
      if (!stale) {
        try {
          const identity = await this.taskService.ensureDurableJob({
            run_id: job.run_id,
            title: job.title,
            workspace_root: job.workspace_root,
            created_at: job.created_at,
            updated_at: job.updated_at
          });
          const projection = await this.taskService.getStatus(identity.task_id);
          stale = projection.liveness.state === "stale" && projection.liveness.owner_alive !== true;
        } catch {
          stale = false;
        }
      }
      if (!stale) continue;
      await this.archiveJob(job, legacyValidation ? "archived_stale_legacy_validation" : "archived_stale_direct_tool_task");
      cleaned += 1;
    }
    this.lastStaleCleanupAt = cleanupAt;
    return cleaned;
  }

  private async createSyntheticTask(title: string): Promise<TaskStatusProjection> {
    const now = this.now().toISOString();
    const runId = `${DIRECT_RUN_PREFIX}${now.replace(/[-:.TZ]/g, "").toLowerCase().slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const input = { version: 1, source: "direct_tool_task_bridge", title, workspace_id: this.workspace.id, workspace_root: this.workspace.root, created_at: now };
    const job = {
      version: 1,
      run_id: runId,
      kind: "task",
      title,
      workspace_id: this.workspace.id,
      workspace_root: this.workspace.root,
      status: "running",
      input_path: this.jobStore.inputPath(runId),
      input_hash: durableHash(input),
      current_step_id: null,
      steps: [],
      progress: {
        phase: "development",
        current_step: 0,
        total_steps: 0,
        current_action: "已建立当前任务，等待直接工具操作",
        heartbeat_at: now,
        liveness_at: now,
        progress_at: now,
        last_meaningful_progress_at: now,
        activity_state: "idle_between_steps",
        safe_progress_summary: "已建立当前任务，等待直接工具操作",
        user_action_required: null,
        last_activity_event: createRuntimeActivityEvent({ task_id: `job-${runId}`, run_id: runId, source: "task_runtime", activity_state: "idle_between_steps", safe_summary: "已建立当前任务，等待直接工具操作", occurred_at: now }),
        progress_fingerprint: progressFingerprint("development", "已建立当前任务，等待直接工具操作", 0),
        retries: 0,
        writer_active: false,
        browser_active: false,
        execution_state: "working"
      },
      cancel_requested: false,
      created_at: now,
      updated_at: now,
      started_at: now,
      first_progress_at: now,
      recovery_count: 0,
      owner_change_count: 0,
      manual_intervention_count: 0
    } as unknown as DurableJobRecord;
    Object.assign(job, { ["owner_" + "token"]: null });
    await this.jobStore.writeJson(job.input_path, input);
    await this.jobStore.writeJob(job);
    const identity = await this.taskService.ensureDurableJob({ run_id: runId, title, workspace_root: this.workspace.root, created_at: now, updated_at: now });
    return await this.taskService.getStatus(identity.task_id);
  }

  private async acquireSyntheticOwnership(runId: string): Promise<DurableJobOwnership | null> {
    const claimId = `direct-tool-bridge:${process.pid}:${runId}`;
    const job = await this.jobStore.readJob(runId);
    if (!job) return null;
    const takeover = Boolean(job.owner_token && job.owner_token !== claimId);
    return await this.jobStore.acquireRunOwner(runId, claimId, { takeover, operation: "direct_tool_call" }) ?? null;
  }

  private ensureIdleHeartbeat(runId: string, workerId: string): void {
    if (this.idleTimers.has(runId)) return;
    const timer = setInterval(() => {
      void (async () => {
        const job = await this.jobStore.readJob(runId);
        if (!job || TERMINAL_JOB_STATUSES.has(job.status)) {
          this.stopIdleHeartbeat(runId);
          return;
        }
        const lastActivity = this.lastActivityAt.get(runId) ?? Date.parse(job.updated_at);
        if (this.now().getTime() - lastActivity >= this.idleArchiveMs) {
          await this.archiveJob(job, "direct_task_idle_timeout");
          await this.componentStore.terminal(workerId, { kind: "worker", reason: "idle_timeout", evidence_ref: this.jobStore.jobPath(runId), at: this.now().toISOString() }).catch(() => undefined);
          this.stopIdleHeartbeat(runId);
          return;
        }
        // Idle tasks remain discoverable through their persisted conversation binding,
        // but must not retain or renew an execution Owner between tool calls.
      })().catch(() => undefined);
    }, Math.max(this.heartbeatIntervalMs, 15_000));
    timer.unref();
    this.idleTimers.set(runId, timer);
  }

  private stopIdleHeartbeat(runId: string): void {
    const timer = this.idleTimers.get(runId);
    if (timer) clearInterval(timer);
    this.idleTimers.delete(runId);
    this.lastActivityAt.delete(runId);
  }

  private async archiveIdleCurrentSynthetic(reason: string): Promise<void> {
    const current = await this.taskService.getCurrentForConversation(this.workspace.conversationId).catch(() => undefined);
    if (!current || current.identity.kind !== "durable_job" || !current.identity.domain_id.startsWith(DIRECT_RUN_PREFIX)) return;
    if (current.liveness.step_active || current.progress.execution_state === "working") return;
    const job = await this.jobStore.readJob(current.identity.domain_id);
    if (job && !TERMINAL_JOB_STATUSES.has(job.status)) await this.archiveJob(job, reason);
  }

  private async archiveJob(job: DurableJobRecord, reason: string): Promise<void> {
    const now = this.now().toISOString();
    for (const stepId of job.steps) {
      const step = await this.jobStore.readStep(job.run_id, stepId);
      if (!step || step.status !== "running") continue;
      step.status = "cancelled";
      step.finished_at = now;
      step.heartbeat_at = now;
      step.pending_operation = null;
      step.error = reason;
      await this.jobStore.writeStep(job.run_id, step);
    }
    job.status = "cancelled";
    job.finished_at = now;
    job.duration_ms = job.started_at ? Math.max(0, Date.parse(now) - Date.parse(job.started_at)) : undefined;
    job.result_summary = `Archived: ${reason}`;
    job.progress.phase = "archive";
    job.progress.current_action = "失活旧任务已归档";
    job.progress.heartbeat_at = now;
    job.progress.liveness_at = now;
    job.progress.progress_at = now;
    job.progress.last_meaningful_progress_at = now;
    job.progress.activity_state = "terminal";
    job.progress.safe_progress_summary = job.progress.current_action;
    job.progress.user_action_required = null;
    job.progress.last_activity_event = createRuntimeActivityEvent({ task_id: `job-${job.run_id}`, run_id: job.run_id, source: "task_runtime", activity_state: "terminal", safe_summary: job.progress.current_action, occurred_at: now, evidence_ref: this.jobStore.jobPath(job.run_id) });
    job.progress.progress_fingerprint = progressFingerprint("archive", job.progress.current_action, job.progress.current_step);
    job.progress.execution_state = "terminal";
    job.progress.writer_active = false;
    job.progress.browser_active = false;
    job.progress.wait_reason = undefined;
    await this.jobStore.writeJob(job);
    if (job.owner_token) await this.jobStore.releaseOwner(job.run_id, job.owner_token).catch(() => undefined);
    this.stopIdleHeartbeat(job.run_id);
  }
}
