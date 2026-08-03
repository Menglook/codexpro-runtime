import { randomUUID } from "node:crypto";
import path from "node:path";
import { createWorkspaceExecutionComponentStore } from "../execution/componentStore.js";
import { codexProEventBus, type CodexProEventName } from "../events/eventBus.js";
import { findSecretValues, redactSensitiveText } from "../redact.js";
import type { Workspace } from "../guard.js";
import {
  classifyCommandsForResources,
  isResourceWaitTimeoutError,
  requestForWorkspaceTask,
  resourceWaitReason,
  ResourceGovernor,
  runWithinResourceLease,
  type ResourceLeaseRecord,
  type ResourcePoolName
} from "../resources/resourceGovernor.js";
import {
  applyLoopDecision,
  classifyLoopFailure,
  createLoopState,
  evaluateLoopPolicy,
  loopProgressFingerprint,
  normalizeLoopBudget,
  recordLoopProgress,
  type LoopBudget
} from "../workflow/loopPolicy.js";
import { DurableJobStore, durableHash, type DurableJobOwnership } from "./jobStore.js";
import type { ActiveSkillRecord } from "../skills/types.js";
import { TaskReportEventStore, type TaskReportAppendResultV1 } from "../tasks/taskReportEventStore.js";
import type {
  TaskReportEventKind,
  TaskReportSeverity
} from "../tasks/taskReportTypes.js";
import { TASK_REPORT_LIMITS } from "../tasks/taskReportTypes.js";
import type {
  DurableJobRecord,
  DurableJobStep,
  DurableJobStepDefinition,
  DurableJobTerminationReason,
  DurableStepOutput,
  TaskProgress
} from "./jobSteps.js";

export interface DurableJobCreateInput {
  run_id: string;
  contract_version?: number;
  loop_budget?: Partial<LoopBudget>;
  kind: "task" | "stage";
  title: string;
  workspace_id: string;
  workspace_root: string;
  input: Record<string, unknown>;
  active_skill?: ActiveSkillRecord;
  steps: DurableJobStepDefinition[];
}

export interface DurableJobExecutionContext {
  job: DurableJobRecord;
  step: DurableJobStep;
  attempt: number;
  signal: AbortSignal;
  heartbeat(action?: string, evidencePath?: string): Promise<void>;
  report(input: DurableJobReportInput): Promise<TaskReportAppendResultV1 | undefined>;
  isCancellationRequested(): Promise<boolean>;
}

export interface DurableJobReportInput {
  event_kind: "progress" | "finding" | "warning" | "waiting_user" | "blocked" | "artifact_created";
  title: string;
  summary: string;
  detail_markdown?: string;
  evidence_paths?: string[];
  idempotency_key: string;
  severity?: TaskReportSeverity;
  source_ref?: string;
  occurred_at?: string;
}

export type DurableJobStepHandler = (context: DurableJobExecutionContext) => Promise<DurableStepOutput>;
export type DurableJobStepHandlers = Record<string, DurableJobStepHandler>;

export interface DurableJobManagerOptions {
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  stepTimeoutMs?: number;
  noProgressTimeoutMs?: number;
  hardTimeoutMs?: number;
  cancelGraceMs?: number;
  heartbeatFailureThreshold?: number;
  resourceGovernor?: ResourceGovernor | null;
  deferSuccessfulTerminalReport?: boolean;
}

const activeStepControllers = new Map<string, AbortController>();

function activeControllerKey(job: Pick<DurableJobRecord, "workspace_root" | "run_id">): string {
  return `${job.workspace_root}\u0000${job.run_id}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function terminal(status: DurableJobRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

function clippedError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000);
}

function reportIdentifier(value: string, fallback: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return normalized || fallback;
}

function reportSeverity(eventKind: TaskReportEventKind): TaskReportSeverity {
  switch (eventKind) {
    case "finding":
    case "warning":
      return "warning";
    case "waiting_user":
      return "action_required";
    case "blocked":
    case "task_failed":
      return "error";
    case "recovery_completed":
    case "stage_completed":
    case "task_completed":
      return "success";
    case "task_cancelled":
      return "warning";
    default:
      return "info";
  }
}

interface AutomaticTaskReportInput {
  eventKind: TaskReportEventKind;
  title: string;
  summary: string;
  idempotencyKey: string;
  step?: DurableJobStep;
  severity?: TaskReportSeverity;
  detailMarkdown?: string;
  evidencePaths?: string[];
  sourceRef?: string;
  occurredAt?: string;
}

function durableLoopBudget(input: Partial<LoopBudget> = {}): LoopBudget {
  return normalizeLoopBudget(input, {
    max_attempts_per_step: 3,
    max_repair_rounds: 1,
    max_same_failure_repeats: 2,
    max_full_validation_runs: 1,
    max_browser_reconnects: 1,
    max_elapsed_ms: 60 * 60 * 1_000,
    max_tool_calls: 500
  });
}

function ensureLoopState(job: DurableJobRecord): DurableJobRecord {
  job.loop_budget ??= durableLoopBudget();
  job.loop_state ??= createLoopState(job.loop_budget, job.created_at);
  return job;
}

function durableProgressFingerprint(job: DurableJobRecord, step?: DurableJobStep): string {
  return loopProgressFingerprint({
    status: job.status,
    phase: step?.phase ?? job.progress.phase,
    evidence_ids: step?.evidence_paths ?? (job.progress.last_evidence ? [job.progress.last_evidence] : []),
    contract_version: job.contract_version
  });
}

function taskProgressFingerprint(
  job: DurableJobRecord,
  step: DurableJobStep,
  action: string,
  evidencePath?: string
): string {
  return loopProgressFingerprint({
    status: job.status,
    phase: `${step.phase}:${action}`,
    evidence_ids: [...(step.evidence_paths ?? []), ...(evidencePath ? [evidencePath] : [])],
    contract_version: job.contract_version
  });
}

function markProgressRecorded(job: DurableJobRecord, progressAt: string): void {
  job.first_progress_at ??= progressAt;
}

function refreshLiveness(progress: TaskProgress, at = timestamp()): TaskProgress {
  return {
    ...progress,
    heartbeat_at: at,
    liveness_at: at
  };
}

function boundedDuration(value: unknown, fallback: number, minimum = 100): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(minimum, Math.floor(numeric)) : fallback;
}

function deadlineAt(startedAt: string, durationMs: number): string {
  return new Date(Date.parse(startedAt) + durationMs).toISOString();
}

class DurableJobDeadlineError extends Error {
  constructor(readonly reason: DurableJobTerminationReason, message: string) {
    super(message);
    this.name = "DurableJobDeadlineError";
  }
}

function isDeadlineError(error: unknown): error is DurableJobDeadlineError {
  return error instanceof DurableJobDeadlineError;
}

function pidAlive(pid: unknown): boolean {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function progressFor(
  job: DurableJobRecord,
  step: DurableJobStep,
  action: string,
  executionState: TaskProgress["execution_state"],
  options: { evidencePath?: string; waitReason?: string; writerActive?: boolean; browserActive?: boolean } = {}
): TaskProgress {
  const at = timestamp();
  const fingerprint = taskProgressFingerprint(job, step, action, options.evidencePath);
  markProgressRecorded(job, at);
  return {
    phase: step.phase,
    current_step: step.index,
    total_steps: job.steps.length,
    current_action: action,
    ...(options.waitReason ? { wait_reason: options.waitReason } : {}),
    heartbeat_at: at,
    liveness_at: at,
    progress_at: at,
    progress_fingerprint: fingerprint,
    ...(options.evidencePath ? { last_evidence: options.evidencePath } : {}),
    retries: Math.max(0, step.attempts - 1),
    writer_active: options.writerActive ?? false,
    browser_active: options.browserActive ?? false,
    execution_state: executionState
  };
}

async function emitJobEvent(
  name: CodexProEventName,
  job: DurableJobRecord,
  data: Record<string, unknown> = {}
): Promise<void> {
  const stepId = typeof data.step_id === "string" ? data.step_id : job.current_step_id ?? undefined;
  try {
    await codexProEventBus.emit(
      name,
      {
        domain: "durable_job",
        run_id: job.run_id,
        kind: job.kind,
        status: job.status,
        ...data
      },
      { source: "durable_job_manager", correlation_id: job.run_id, task_id: `job-${job.run_id}`, ...(stepId ? { step_id: stepId } : {}) }
    );
  } catch {
    // Durable Job files and owner locks remain authoritative when observers fail.
  }
}

async function emitJobProgress(
  job: DurableJobRecord,
  step: DurableJobStep,
  action: string,
  evidencePath?: string
): Promise<void> {
  await emitJobEvent("progress_recorded", job, {
    step_id: step.step_id,
    phase: step.phase,
    action,
    progress_at: job.progress.progress_at ?? job.progress.heartbeat_at,
    liveness_at: job.progress.liveness_at ?? job.progress.heartbeat_at,
    progress_fingerprint: job.progress.progress_fingerprint ?? taskProgressFingerprint(job, step, action, evidencePath),
    ...(evidencePath ? { last_evidence: evidencePath } : {})
  });
}

async function emitJobTerminal(job: DurableJobRecord, outcome: string): Promise<void> {
  await emitJobEvent("task_completed", job, { outcome });
  await emitJobEvent("execution_exited", job, { outcome });
}

function resourceRequestForJob(
  job: DurableJobRecord,
  definitions: DurableJobStepDefinition[],
  workspace: Workspace,
  ownership?: DurableJobOwnership
) {
  const actions = definitions.map((definition) => definition.action);
  const classified = classifyCommandsForResources(actions);
  const pools = new Set<ResourcePoolName>(classified.pools);
  for (const definition of definitions) {
    if (definition.browser_active) pools.add("browser_live_verification");
    for (const pool of definition.resource_pools ?? []) pools.add(pool);
  }
  const hasWrites = definitions.some((definition) =>
    definition.writer_active === true
    || definition.side_effect_level === "local_write"
    || definition.side_effect_level === "external_write"
  );
  const hasHeavy = classified.category === "heavy" || pools.size > 0 || definitions.some((definition) => definition.browser_active === true);
  return requestForWorkspaceTask(
    { ...workspace, id: job.workspace_id, root: job.workspace_root, openedAt: workspace.openedAt || job.created_at },
    {
      requestId: `durable-job:${job.run_id}`,
      taskId: `job-${job.run_id}`,
      runId: job.run_id,
      ownerToken: ownership?.owner_token ?? job.owner_token ?? undefined,
      fencingToken: ownership?.fencing_token ?? job.fencing_token,
      title: job.title,
      commands: actions,
      hasWrites,
      category: definitions.find((definition) => definition.resource_category)?.resource_category
        ?? (hasHeavy ? "heavy" : hasWrites || actions.length ? "standard" : "lightweight"),
      priority: definitions.find((definition) => definition.resource_priority)?.resource_priority,
      pools: [...pools],
      reason: `Durable Job ${job.run_id} resource admission before managed execution.`
    }
  );
}

export class DurableJobManager {
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  readonly stepTimeoutMs: number;
  readonly noProgressTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly heartbeatFailureThreshold: number;
  private readonly resourceGovernor?: ResourceGovernor;
  private readonly deferSuccessfulTerminalReport: boolean;
  readonly reportStore: TaskReportEventStore;

  constructor(readonly store: DurableJobStore, options: DurableJobManagerOptions = {}) {
    this.heartbeatIntervalMs = Math.max(100, Math.min(options.heartbeatIntervalMs ?? 10_000, 60_000));
    this.staleAfterMs = Math.max(this.heartbeatIntervalMs * 2, Math.min(options.staleAfterMs ?? 90_000, 30 * 60_000));
    this.stepTimeoutMs = boundedDuration(options.stepTimeoutMs ?? process.env.CODEXPRO_DURABLE_STEP_TIMEOUT_MS, 30 * 60_000);
    this.noProgressTimeoutMs = boundedDuration(options.noProgressTimeoutMs ?? process.env.CODEXPRO_DURABLE_NO_PROGRESS_TIMEOUT_MS, 15 * 60_000);
    this.hardTimeoutMs = boundedDuration(options.hardTimeoutMs ?? process.env.CODEXPRO_DURABLE_HARD_TIMEOUT_MS, 2 * 60 * 60_000);
    this.cancelGraceMs = boundedDuration(options.cancelGraceMs ?? process.env.CODEXPRO_DURABLE_CANCEL_GRACE_MS, 5_000);
    this.heartbeatFailureThreshold = Math.max(1, Math.floor(Number(options.heartbeatFailureThreshold ?? process.env.CODEXPRO_DURABLE_HEARTBEAT_FAILURE_THRESHOLD ?? 3)));
    this.resourceGovernor = options.resourceGovernor === null
      ? undefined
      : options.resourceGovernor ?? (store.config ? new ResourceGovernor(store.config) : undefined);
    this.deferSuccessfulTerminalReport = options.deferSuccessfulTerminalReport === true;
    this.reportStore = new TaskReportEventStore(store.guard, store.workspace);
  }

  private reportProjectId(job: DurableJobRecord): string {
    return reportIdentifier(path.basename(job.workspace_root), job.workspace_id);
  }

  private async appendTaskReport(
    job: DurableJobRecord,
    input: AutomaticTaskReportInput
  ): Promise<TaskReportAppendResultV1 | undefined> {
    const taskId = `job-${job.run_id}`;
    try {
      return await this.reportStore.append({
        idempotency_key: input.idempotencyKey,
        project_id: this.reportProjectId(job),
        objective_key: `legacy:durable_job:${job.run_id}`,
        task_id: taskId,
        run_id: job.run_id,
        attempt_id: taskId,
        stage_key: input.step?.step_id ?? null,
        stage_title: input.step?.phase ?? null,
        event_kind: input.eventKind,
        severity: input.severity ?? reportSeverity(input.eventKind),
        title: input.title.slice(0, TASK_REPORT_LIMITS.title_chars),
        summary: input.summary.slice(0, TASK_REPORT_LIMITS.summary_chars),
        detail_markdown: input.detailMarkdown?.slice(0, TASK_REPORT_LIMITS.detail_markdown_chars) ?? null,
        evidence_paths: (input.evidencePaths ?? []).slice(0, TASK_REPORT_LIMITS.evidence_paths),
        source_kind: "durable_job",
        source_ref: input.sourceRef ?? (input.step ? this.store.stepPath(job.run_id, input.step.step_id) : this.store.jobPath(job.run_id)),
        occurred_at: input.occurredAt ?? timestamp()
      });
    } catch {
      // Task report persistence is an observer. Durable Job state remains authoritative.
      return undefined;
    }
  }

  private async reportTerminal(job: DurableJobRecord, step?: DurableJobStep): Promise<void> {
    const eventKind: TaskReportEventKind = job.status === "completed"
      ? "task_completed"
      : job.status === "cancelled"
        ? "task_cancelled"
        : job.status === "failed"
          ? "task_failed"
          : "blocked";
    const summary = job.result_summary?.trim()
      || job.recovery_reason?.trim()
      || job.error?.trim()
      || (job.status === "completed" ? "任务已完成全部持久步骤。" : `任务以 ${job.status} 状态结束。`);
    await this.appendTaskReport(job, {
      eventKind,
      title: job.status === "completed" ? "任务执行完成" : job.status === "cancelled" ? "任务已取消" : job.status === "failed" ? "任务执行失败" : "任务已阻断",
      summary,
      idempotencyKey: `durable:${job.run_id}:terminal:${job.status}:${job.finished_at ?? job.updated_at}`,
      step,
      evidencePaths: [...new Set([
        ...(step?.evidence_paths ?? []),
        ...(job.report_path ? [job.report_path] : [])
      ])],
      sourceRef: this.store.jobPath(job.run_id),
      occurredAt: job.finished_at ?? job.updated_at
    });
  }

  async publishTerminalReport(job: DurableJobRecord, step?: DurableJobStep): Promise<void> {
    if (!terminal(job.status) && job.status !== "recovery_required") return;
    await this.reportTerminal(job, step);
  }

  async create(input: DurableJobCreateInput): Promise<DurableJobRecord> {
    const existing = await this.store.readJob(input.run_id);
    if (existing) {
      if (existing.input_hash !== durableHash(input.input)) throw new Error(`Run id ${input.run_id} is already bound to different input.`);
      return existing;
    }
    const now = timestamp();
    const inputPath = this.store.inputPath(input.run_id);
    const serializedInput = JSON.stringify(input.input);
    const secretFindings = findSecretValues(serializedInput, { path: inputPath });
    if (secretFindings.length) {
      throw new Error(`Durable job input contains ${secretFindings.length} secret-like value(s) and cannot be persisted safely.`);
    }
    await this.store.writeJson(inputPath, input.input);
    const stepIds = input.steps.map((step) => step.step_id);
    const loopBudget = durableLoopBudget(input.loop_budget);
    const job: DurableJobRecord = {
      version: 1,
      run_id: input.run_id,
      ...(input.contract_version === undefined ? {} : { contract_version: input.contract_version }),
      kind: input.kind,
      title: input.title,
      workspace_id: input.workspace_id,
      workspace_root: input.workspace_root,
      status: "queued",
      owner_token: null,
      fencing_token: 0,
      owner_pid: null,
      owner_acquired_at: null,
      previous_owner_token: null,
      input_path: inputPath,
      input_hash: durableHash(input.input),
      ...(input.active_skill ? { active_skill: input.active_skill } : {}),
      current_step_id: stepIds[0] ?? null,
      steps: stepIds,
      loop_budget: loopBudget,
      loop_state: createLoopState(loopBudget, now),
      progress: {
        phase: input.steps[0]?.phase ?? "queued",
        current_step: input.steps.length ? 1 : 0,
        total_steps: input.steps.length,
        current_action: input.steps.length ? input.steps[0].action : "No steps",
        heartbeat_at: now,
        liveness_at: now,
        progress_at: now,
        progress_fingerprint: loopProgressFingerprint({
          status: "queued",
          phase: input.steps[0]?.phase ?? "queued",
          contract_version: input.contract_version
        }),
        retries: 0,
        writer_active: false,
        browser_active: false,
        execution_state: "queued"
      },
      cancel_requested: false,
      created_at: now,
      updated_at: now,
      step_timeout_ms: this.stepTimeoutMs,
      no_progress_timeout_ms: this.noProgressTimeoutMs,
      hard_timeout_ms: this.hardTimeoutMs,
      cancel_grace_ms: this.cancelGraceMs,
      heartbeat_write_failures: 0,
      recovery_count: 0,
      owner_change_count: 0,
      manual_intervention_count: 0
    };
    for (const [index, definition] of input.steps.entries()) {
      const step: DurableJobStep = {
        step_id: definition.step_id,
        index: index + 1,
        ...(input.contract_version === undefined ? {} : { contract_version: input.contract_version }),
        phase: definition.phase,
        status: "queued",
        input_hash: durableHash({ input_hash: job.input_hash, definition }),
        evidence_paths: [],
        fencing_token: 0,
        idempotent: definition.idempotent,
        retryable: definition.retryable,
        side_effect_level: definition.side_effect_level ?? "unknown",
        retry_policy: definition.retry_policy ?? (definition.idempotent && definition.retryable ? "automatic" : definition.retryable ? "manual" : "never"),
        ...(definition.rollback_method ? { rollback_method: definition.rollback_method } : {}),
        attempts: 0,
        previous_step: input.steps[index - 1]?.step_id,
        next_step: input.steps[index + 1]?.step_id,
        pending_operation: null
      };
      await this.store.writeStep(job.run_id, step);
    }
    await this.store.writeJob(job);
    await emitJobEvent("run_created", job);
    await emitJobEvent("task_created", job);
    return job;
  }

  async inspect(runId: string, options: { markStale?: boolean } = {}): Promise<{ job: DurableJobRecord; steps: DurableJobStep[] }> {
    const loaded = await this.store.readJob(runId);
    if (!loaded) throw new Error(`Durable job not found: ${runId}`);
    const job = ensureLoopState(loaded);
    if (options.markStale !== false && !terminal(job.status) && job.status !== "recovery_required") {
      const heartbeat = Date.parse(job.progress.heartbeat_at);
      const phaseThreshold = job.progress.browser_active
        ? this.staleAfterMs * 3
        : job.progress.writer_active
          ? this.staleAfterMs * 2
          : this.staleAfterMs;
      if (Number.isFinite(heartbeat) && Date.now() - heartbeat > phaseThreshold) {
        const owner = await this.store.readJson<{ pid?: number }>(this.store.ownerLockPath(runId)).catch(() => undefined);
        if (pidAlive(owner?.pid)) {
          job.progress = {
            ...job.progress,
            execution_state: "silent",
            wait_reason: `Owner process ${owner?.pid} is alive but no heartbeat was recorded for more than ${phaseThreshold} ms.`
          };
        } else {
          job.status = "stale";
          job.recovery_reason = `No heartbeat and no live owner process for more than ${phaseThreshold} ms.`;
          job.progress = {
            ...job.progress,
            execution_state: "stale",
            wait_reason: job.recovery_reason,
            writer_active: false,
            browser_active: false
          };
        }
        await this.store.writeJob(job);
        if (job.status === "stale") {
          await emitJobEvent("task_interrupted", job, { reason: job.recovery_reason ?? "stale" });
          await this.appendTaskReport(job, {
            eventKind: "warning",
            title: "任务心跳中断",
            summary: job.recovery_reason ?? "任务执行器已失去心跳，等待恢复判定。",
            idempotencyKey: `durable:${job.run_id}:stale:${job.progress.heartbeat_at}`,
            severity: "warning"
          });
        }
      }
    }
    return { job, steps: await this.store.readSteps(job) };
  }

  async requestCancel(runId: string): Promise<DurableJobRecord> {
    const { job, steps } = await this.inspect(runId, { markStale: false });
    if (terminal(job.status)) return job;
    const now = timestamp();
    const activeController = activeStepControllers.get(activeControllerKey(job));
    const orphanedStatus = ["stale", "recovery_required", "recovering", "running"].includes(job.status);
    if (orphanedStatus && !pidAlive(job.owner_pid) && !activeController) {
      const currentStep = steps.find((step) => step.step_id === job.current_step_id)
        ?? steps.find((step) => step.status !== "completed")
        ?? steps[0];
      if (currentStep && currentStep.status !== "completed") {
        currentStep.status = "cancelled";
        currentStep.pending_operation = null;
        currentStep.owner_token = undefined;
        currentStep.heartbeat_at = now;
        currentStep.finished_at = now;
        currentStep.termination_reason = "explicit_cancel";
        await this.store.writeStep(runId, currentStep);
      }
      job.cancel_requested = true;
      job.status = "cancelled";
      job.owner_token = null;
      job.finished_at = now;
      job.duration_ms = Math.max(0, Date.parse(now) - Date.parse(job.started_at ?? job.created_at));
      job.termination_reason = "explicit_cancel";
      job.recovery_reason = "Explicit cancellation closed an orphaned task with no live owner process.";
      if (currentStep) {
        job.current_step_id = currentStep.step_id;
        job.progress = progressFor(job, currentStep, "Cancelled orphaned task", "terminal", {
          waitReason: job.recovery_reason,
          writerActive: false,
          browserActive: false
        });
      } else {
        job.progress = {
          ...job.progress,
          current_action: "Cancelled orphaned task",
          wait_reason: job.recovery_reason,
          heartbeat_at: now,
          liveness_at: now,
          progress_at: now,
          writer_active: false,
          browser_active: false,
          execution_state: "terminal",
          termination_reason: "explicit_cancel"
        };
      }
      await this.store.writeJob(job);
      await this.resourceGovernor?.cancelQueuedRun(runId, job.workspace_root);
      await this.resourceGovernor?.releaseTaskResources(`job-${runId}`, job.workspace_root);
      if (currentStep) await emitJobProgress(job, currentStep, "Cancelled orphaned task");
      await emitJobTerminal(job, "cancelled");
      await this.reportTerminal(job, currentStep);
      return job;
    }
    job.cancel_requested = true;
    activeStepControllers.get(activeControllerKey(job))?.abort();
    job.progress = {
      ...job.progress,
      wait_reason: "Cancellation requested; waiting for the current bounded operation to stop.",
      execution_state: "waiting",
      heartbeat_at: now,
      liveness_at: now,
      progress_at: now,
      progress_fingerprint: loopProgressFingerprint({
        status: job.status,
        phase: `${job.progress.phase}:cancel_requested`,
        evidence_ids: job.progress.last_evidence ? [job.progress.last_evidence] : [],
        contract_version: job.contract_version
      })
    };
    markProgressRecorded(job, now);
    await this.store.writeJob(job);
    await emitJobEvent("progress_recorded", job, {
      action: "Cancellation requested",
      progress_at: now,
      liveness_at: now,
      progress_fingerprint: job.progress.progress_fingerprint
    });
    await emitJobEvent("task_interrupted", job, { reason: "cancellation_requested" });
    await this.appendTaskReport(job, {
      eventKind: "warning",
      title: "已登记取消请求",
      summary: "正在等待当前受控操作停止，任务尚未被报告为已取消。",
      idempotencyKey: `durable:${job.run_id}:cancel-requested`,
      severity: "warning",
      occurredAt: now
    });
    return job;
  }

  async prepareRecovery(runId: string): Promise<DurableJobRecord> {
    const ownerToken = randomUUID();
    const ownership = await this.store.acquireRunOwner(runId, ownerToken, { takeover: true, operation: "prepare_recovery" });
    if (!ownership) {
      const current = await this.store.readJob(runId);
      if (!current) throw new Error(`Durable job not found: ${runId}`);
      return current;
    }
    try {
      return await this.prepareRecoveryOwned(runId, ownership);
    } finally {
      await this.store.releaseRunOwner(ownership);
    }
  }

  private async prepareRecoveryOwned(runId: string, ownership: DurableJobOwnership): Promise<DurableJobRecord> {
    const { job, steps } = await this.inspect(runId, { markStale: false });
    if (terminal(job.status)) return job;
    const running = steps.find((step) => step.status === "running");
    const recoveryNumber = Math.max(0, job.recovery_count ?? 0) + 1;
    await this.appendTaskReport(job, {
      eventKind: "recovery_started",
      title: "开始恢复任务",
      summary: running
        ? `正在检查中断阶段 ${running.phase} 是否可以安全续跑。`
        : "正在从持久检查点恢复任务。",
      idempotencyKey: `durable:${runId}:recovery-started:${recoveryNumber}`,
      step: running,
      severity: "warning"
    });
    if (running && !running.idempotent) {
      running.status = "recovery_required";
      running.pending_operation = null;
      running.owner_token = undefined;
      running.error = "The process ended during a non-idempotent step. Automatic replay is unsafe.";
      const classification = classifyLoopFailure({
        code: "external_state_unknown",
        message: running.error,
        side_effect_level: running.side_effect_level,
        non_idempotent: true,
        external_state_unknown: true,
        evidence_refs: running.evidence_paths
      });
      running.failure_category = classification.category;
      running.failure_fingerprint = classification.fingerprint;
      running.same_failure_repeats = (running.same_failure_repeats ?? 0) + 1;
      await this.store.writeStepOwned(job.run_id, running, ownership, { takeover: true });
      job.status = "recovery_required";
      job.current_step_id = running.step_id;
      job.owner_token = null;
      job.recovery_count = Math.max(0, job.recovery_count ?? 0) + 1;
      job.recovery_reason = running.error;
      job.failure_category = classification.category;
      job.failure_fingerprint = classification.fingerprint;
      const loopDecision = evaluateLoopPolicy({
        state: job.loop_state!,
        budget: job.loop_budget!,
        classification,
        phase: running.phase,
        current_step_attempts: running.attempts
      });
      job.loop_state = applyLoopDecision(job.loop_state!, job.loop_budget!, loopDecision, {
        current_step_attempts: running.attempts,
        progress_fingerprint: durableProgressFingerprint(job, running)
      });
      job.progress = progressFor(job, running, "Manual recovery required", "blocked", {
        waitReason: running.error,
        evidencePath: running.output_path
      });
      await this.store.writeJobOwned(job, ownership);
      await emitJobProgress(job, running, "Manual recovery required", running.output_path);
      await this.reportTerminal(job, running);
      return job;
    }
    for (const step of steps) {
      if (step.status !== "running") continue;
      step.status = "queued";
      step.owner_token = undefined;
      step.pending_operation = null;
      await this.store.writeStepOwned(job.run_id, step, ownership, { takeover: true });
    }
    const next = steps.find((step) => step.status !== "completed");
    job.status = "recovering";
    job.current_step_id = next?.step_id ?? null;
    job.owner_token = null;
    job.recovery_count = Math.max(0, job.recovery_count ?? 0) + 1;
    job.recovery_reason = "Interrupted idempotent steps were returned to the queue; completed steps will be reused.";
    job.loop_state = recordLoopProgress(
      job.loop_state!,
      job.loop_budget!,
      durableProgressFingerprint(job, next),
      job.recovery_reason
    );
    if (next) {
      job.progress = progressFor(job, next, "Recovering from durable checkpoint", "recovering", {
        waitReason: job.recovery_reason
      });
    }
    await this.store.writeJobOwned(job, ownership);
    if (next) await emitJobProgress(job, next, "Recovering from durable checkpoint");
    await this.appendTaskReport(job, {
      eventKind: "recovery_completed",
      title: "恢复检查完成",
      summary: job.recovery_reason,
      idempotencyKey: `durable:${runId}:recovery-completed:${job.recovery_count ?? recoveryNumber}`,
      step: next,
      evidencePaths: next?.evidence_paths ?? []
    });
    return job;
  }

  async retryStep(runId: string, stepId: string): Promise<DurableJobRecord> {
    const ownerToken = randomUUID();
    const ownership = await this.store.acquireRunOwner(runId, ownerToken, { operation: "retry_step" });
    if (!ownership) throw new Error(`Durable job ${runId} is currently owned by another executor.`);
    try {
      const { job } = await this.inspect(runId, { markStale: false });
      await emitJobEvent("owner_acquired", job, {
        owner_token: ownerToken,
        owner_pid: process.pid,
        fencing_token: ownership.fencing_token,
        previous_owner_token: ownership.previous_owner_token,
        operation: "retry_step"
      });
      const step = await this.store.readStep(runId, stepId);
      if (!step) throw new Error(`Durable job step not found: ${stepId}`);
      if (!step.retryable) throw new Error(`Durable job step is not retryable: ${stepId}`);
      if (!step.idempotent && step.status === "recovery_required") {
        throw new Error(`Non-idempotent step ${stepId} requires explicit external reconciliation before retry.`);
      }
      const budget = job.loop_budget!;
      const exhaustedAttempts = step.attempts >= budget.max_attempts_per_step;
      const repeatedFailure = (step.same_failure_repeats ?? 0) >= budget.max_same_failure_repeats;
      if (exhaustedAttempts || repeatedFailure) {
        const classification = classifyLoopFailure({
          code: repeatedFailure ? "no_progress" : "resource_exhausted",
          message: repeatedFailure
            ? `Step ${stepId} repeated the same failure without progress.`
            : `Step ${stepId} exhausted its attempt budget.`
        });
        const loopDecision = evaluateLoopPolicy({
          state: job.loop_state!,
          budget,
          classification,
          phase: step.phase,
          current_step_attempts: step.attempts
        });
        step.status = "blocked";
        step.failure_category = classification.category;
        step.failure_fingerprint = classification.fingerprint;
        step.error = classification.reason;
        await this.store.writeStepOwned(runId, step, ownership);
        job.status = "blocked";
        job.failure_category = classification.category;
        job.failure_fingerprint = classification.fingerprint;
        job.error = classification.reason;
        job.recovery_reason = classification.reason;
        job.loop_state = applyLoopDecision(job.loop_state!, budget, loopDecision, {
          current_step_attempts: step.attempts,
          progress_fingerprint: durableProgressFingerprint(job, step)
        });
        job.progress = progressFor(job, step, "Retry blocked by Loop policy", "blocked", { waitReason: classification.reason });
        await this.store.writeJobOwned(job, ownership);
        await emitJobProgress(job, step, "Retry blocked by Loop policy");
        await this.reportTerminal(job, step);
        return job;
      }
      step.status = "queued";
      step.error = undefined;
      step.owner_token = undefined;
      step.pending_operation = null;
      await this.store.writeStepOwned(runId, step, ownership);
      job.status = "recovering";
      job.current_step_id = stepId;
      job.cancel_requested = false;
      job.recovery_reason = `Retry requested for step ${stepId}.`;
      job.progress = progressFor(job, step, `Retrying ${step.phase}`, "recovering", { waitReason: job.recovery_reason });
      await this.store.writeJobOwned(job, ownership);
      await emitJobProgress(job, step, `Retrying ${step.phase}`);
      await this.appendTaskReport(job, {
        eventKind: "recovery_started",
        title: `重试阶段：${step.phase}`,
        summary: job.recovery_reason,
        idempotencyKey: `durable:${runId}:retry:${step.step_id}:attempt:${step.attempts + 1}`,
        step,
        severity: "warning"
      });
      return job;
    } finally {
      const current = await this.store.readJob(runId).catch(() => undefined);
      if (current) await emitJobEvent("owner_released", current, {
        owner_token: ownerToken,
        owner_pid: process.pid,
        fencing_token: ownership.fencing_token,
        operation: "retry_step"
      });
      await this.store.releaseRunOwner(ownership);
    }
  }

  async execute(runId: string, handlers: DurableJobStepHandlers, definitions: DurableJobStepDefinition[]): Promise<DurableJobRecord> {
    let { job, steps } = await this.inspect(runId, { markStale: false });
    if (terminal(job.status) || job.status === "recovery_required") return job;

    const ownerToken = randomUUID();
    const ownership = await this.store.acquireRunOwner(runId, ownerToken, { operation: "execute" });
    if (!ownership) return (await this.store.readJob(runId)) ?? job;
    const componentStore = createWorkspaceExecutionComponentStore(job.workspace_root);
    const workerComponentId = `worker:durable_job:${runId}`;

    const startedMs = Date.now();
    let resourceLease: ResourceLeaseRecord | undefined;
    let resourceHeartbeatQueue: Promise<void> = Promise.resolve();
    let resourceHeartbeatTimer: NodeJS.Timeout | undefined;
    let resourceHeartbeatFailures = 0;
    let resourceHeartbeatError: Error | undefined;
    try {
      ({ job, steps } = await this.inspect(runId, { markStale: false }));
      if (terminal(job.status) || job.status === "recovery_required") return job;
      if (job.status === "stale" || job.status === "running") job = await this.prepareRecoveryOwned(runId, ownership);
      if (job.status === "recovery_required") return job;
      steps = await this.store.readSteps(job);
      job.owner_token = ownerToken;
      job.fencing_token = ownership.fencing_token;
      job.owner_pid = process.pid;
      job.owner_acquired_at = ownership.acquired_at;
      job.status = job.status === "recovering" ? "recovering" : "running";
      job.started_at ??= timestamp();
      job.step_timeout_ms ??= this.stepTimeoutMs;
      job.no_progress_timeout_ms ??= this.noProgressTimeoutMs;
      job.hard_timeout_ms ??= this.hardTimeoutMs;
      job.cancel_grace_ms ??= this.cancelGraceMs;
      job.heartbeat_write_failures ??= 0;
      job.hard_deadline ??= deadlineAt(job.started_at, job.hard_timeout_ms);
      job.progress.hard_deadline = job.hard_deadline;
      job.progress.heartbeat_write_failures = job.heartbeat_write_failures;
      await this.store.writeJobOwned(job, ownership);
      await componentStore.register({
        component_id: workerComponentId,
        kind: "worker",
        task_id: `job-${runId}`,
        run_id: runId,
        owner_id: ownerToken,
        fencing_token: ownership.fencing_token,
        state: "running",
        no_progress_deadline: job.no_progress_deadline ?? job.progress.no_progress_deadline ?? null,
        hard_deadline: job.hard_deadline ?? null,
        progress_marker: "item_claimed",
        evidence_ref: this.store.jobPath(runId)
      }).catch(() => undefined);
      await emitJobEvent("owner_acquired", job, {
        owner_token: ownerToken,
        owner_pid: process.pid,
        fencing_token: ownership.fencing_token,
        previous_owner_token: ownership.previous_owner_token,
        operation: "execute"
      });
      await emitJobEvent("task_assigned", job);
      await this.appendTaskReport(job, {
        eventKind: "task_started",
        title: "任务开始执行",
        summary: `持久任务“${job.title}”已由执行器接管。`,
        idempotencyKey: `durable:${job.run_id}:task-started`,
        occurredAt: job.started_at ?? job.updated_at
      });

      if (this.resourceGovernor) {
        const resourceRequest = resourceRequestForJob(job, definitions, this.store.workspace, ownership);
        const resourceWaitController = new AbortController();
        const resourceControllerKey = activeControllerKey(job);
        activeStepControllers.set(resourceControllerKey, resourceWaitController);
        let admission: Awaited<ReturnType<ResourceGovernor["waitForGrant"]>>;
        try {
          admission = await this.resourceGovernor.waitForGrant(resourceRequest, {
            signal: resourceWaitController.signal,
            onQueued: async (decision) => {
              const current = await this.store.readJob(runId);
              if (!current || current.owner_token !== ownerToken || Number(current.fencing_token) !== ownership.fencing_token || terminal(current.status)) return;
              const currentStep = steps.find((step) => step.step_id === current.current_step_id)
                ?? steps.find((step) => step.status !== "completed")
                ?? steps[0];
              if (current.cancel_requested) {
                const now = timestamp();
                if (currentStep && currentStep.status !== "completed") {
                  currentStep.status = "cancelled";
                  currentStep.pending_operation = null;
                  currentStep.owner_token = undefined;
                  currentStep.finished_at = now;
                  currentStep.termination_reason = "explicit_cancel";
                  await this.store.writeStepOwned(runId, currentStep, ownership);
                }
                current.status = "cancelled";
                current.current_step_id = currentStep?.step_id ?? current.current_step_id;
                current.finished_at = now;
                current.duration_ms = Date.now() - startedMs;
                current.owner_token = null;
                current.termination_reason = "explicit_cancel";
                current.progress = progressFor(current, currentStep, "Cancelled while queued by resource policy", "terminal", {
                  waitReason: "Cancellation requested while waiting for resource admission.",
                  writerActive: false,
                  browserActive: false
                });
                await this.store.writeJobOwned(current, ownership);
                if (currentStep) await emitJobProgress(current, currentStep, "Cancelled while queued by resource policy");
                await emitJobTerminal(current, "cancelled");
                await this.reportTerminal(current, currentStep);
                throw new Error("Resource admission cancelled because the Durable Job was cancelled.");
              }
              const waitReason = resourceWaitReason(decision);
              if (
                current.progress.execution_state === "waiting"
                && current.progress.current_action === "Queued by resource policy"
                && current.progress.wait_reason === waitReason
              ) {
                current.progress = refreshLiveness(current.progress);
              } else {
                current.progress = progressFor(
                  current,
                  currentStep,
                  "Queued by resource policy",
                  "waiting",
                  { waitReason, writerActive: false, browserActive: false }
                );
                await emitJobProgress(current, currentStep, "Queued by resource policy");
                await this.appendTaskReport(current, {
                  eventKind: "progress",
                  title: "等待执行资源",
                  summary: waitReason,
                  idempotencyKey: `durable:${runId}:resource-wait:${current.progress.progress_fingerprint ?? "queued"}`,
                  step: currentStep,
                  sourceRef: this.store.jobPath(runId)
                });
              }
              await this.store.writeJobOwned(current, ownership);
            }
          });
        } catch (error) {
          const cancelled = await this.store.readJob(runId);
          if (cancelled?.status === "cancelled") return cancelled;
          if (cancelled?.cancel_requested || resourceWaitController.signal.aborted) {
            const current = cancelled ?? job;
            const currentStep = steps.find((step) => step.step_id === current.current_step_id)
              ?? steps.find((step) => step.status !== "completed")
              ?? steps[0];
            const now = timestamp();
            if (currentStep && currentStep.status !== "completed") {
              currentStep.status = "cancelled";
              currentStep.pending_operation = null;
              currentStep.owner_token = undefined;
              currentStep.finished_at = now;
              currentStep.termination_reason = "explicit_cancel";
              await this.store.writeStepOwned(runId, currentStep, ownership);
            }
            current.cancel_requested = true;
            current.status = "cancelled";
            current.current_step_id = currentStep?.step_id ?? current.current_step_id;
            current.finished_at = now;
            current.duration_ms = Date.now() - startedMs;
            current.owner_token = null;
            current.termination_reason = "explicit_cancel";
            current.progress = progressFor(current, currentStep, "Cancelled while queued by resource policy", "terminal", {
              waitReason: "Cancellation requested while waiting for resource admission.",
              writerActive: false,
              browserActive: false
            });
            await this.store.writeJobOwned(current, ownership);
            if (currentStep) await emitJobProgress(current, currentStep, "Cancelled while queued by resource policy");
            await emitJobTerminal(current, "cancelled");
            await this.reportTerminal(current, currentStep);
            return current;
          }
          if (!isResourceWaitTimeoutError(error)) throw error;
          const current = cancelled ?? job;
          const currentStep = steps.find((step) => step.step_id === current.current_step_id)
            ?? steps.find((step) => step.status !== "completed")
            ?? steps[0];
          const message = clippedError(error);
          current.status = "queued";
          current.owner_token = null;
          current.error = undefined;
          current.failure_category = undefined;
          current.failure_fingerprint = undefined;
          current.finished_at = undefined;
          current.duration_ms = undefined;
          current.recovery_reason = message;
          if (currentStep) {
            if (currentStep.status !== "completed") currentStep.status = "queued";
            currentStep.error = undefined;
            currentStep.failure_category = undefined;
            currentStep.failure_fingerprint = undefined;
            currentStep.finished_at = undefined;
            currentStep.owner_token = undefined;
            currentStep.pending_operation = null;
            await this.store.writeStepOwned(runId, currentStep, ownership);
            current.current_step_id = currentStep.step_id;
            current.progress = progressFor(current, currentStep, "Resource wait timed out; queued for retry", "waiting", {
              waitReason: message,
              writerActive: false,
              browserActive: false
            });
            await emitJobProgress(current, currentStep, "Resource wait timed out; queued for retry");
          }
          await this.store.writeJobOwned(current, ownership);
          await this.appendTaskReport(current, {
            eventKind: "progress",
            title: "资源等待超时，已重新排队",
            summary: message,
            idempotencyKey: `durable:${runId}:resource-wait-timeout:${current.progress.progress_fingerprint ?? "queued"}`,
            step: currentStep,
            sourceRef: this.store.jobPath(runId)
          });
          await componentStore.transition(workerComponentId, {
            kind: "worker",
            state: "idle",
            owner_id: null,
            fencing_token: ownership.fencing_token,
            evidence_ref: this.store.jobPath(runId)
          }).catch(() => undefined);
          return current;
        } finally {
          if (activeStepControllers.get(resourceControllerKey) === resourceWaitController) {
            activeStepControllers.delete(resourceControllerKey);
          }
        }
        resourceLease = admission.lease;
        const intervalMs = Math.max(1_000, Math.min(Math.floor(resourceLease.ttl_ms / 2), 30_000));
        resourceHeartbeatTimer = setInterval(() => {
          resourceHeartbeatQueue = resourceHeartbeatQueue
            .then(async () => {
              resourceLease = await this.resourceGovernor?.heartbeat(resourceLease) ?? resourceLease;
              resourceHeartbeatFailures = 0;
              resourceHeartbeatError = undefined;
            })
            .catch(async (error) => {
              resourceHeartbeatFailures += 1;
              const message = clippedError(error);
              await emitJobEvent("execution_heartbeat", job, {
                heartbeat_error: message,
                heartbeat_source: "resource_lease",
                consecutive_failures: resourceHeartbeatFailures
              });
              if (resourceHeartbeatFailures >= this.heartbeatFailureThreshold) {
                resourceHeartbeatError = error instanceof Error ? error : new Error(message);
              }
            });
        }, intervalMs);
        resourceHeartbeatTimer.unref();
      }

      await emitJobEvent("task_started", job);
      await emitJobEvent("execution_started", job);

      for (const step of steps) {
        if (step.status === "completed") continue;
        if (job.cancel_requested || (await this.store.readJob(runId))?.cancel_requested) {
          step.status = "cancelled";
          step.owner_token = undefined;
          step.finished_at = timestamp();
          await this.store.writeStepOwned(runId, step, ownership);
          job.status = "cancelled";
          job.current_step_id = step.step_id;
          job.finished_at = timestamp();
          job.duration_ms = Date.now() - startedMs;
          job.owner_token = null;
          job.progress = progressFor(job, step, "Cancelled", "terminal", { waitReason: "Cancellation requested." });
          await this.store.writeJobOwned(job, ownership);
          await emitJobProgress(job, step, "Cancelled");
          await emitJobTerminal(job, "cancelled");
          await this.reportTerminal(job, step);
          return job;
        }
        const definition = definitions.find((candidate) => candidate.step_id === step.step_id);
        const handler = handlers[step.step_id];
        if (!definition || !handler) throw new Error(`No durable step handler is registered for ${step.step_id}.`);
        const loopBudget = job.loop_budget!;
        if (step.attempts >= loopBudget.max_attempts_per_step) {
          const classification = classifyLoopFailure({
            code: "resource_exhausted",
            message: `Step ${step.step_id} exhausted its attempt budget.`
          });
          const loopDecision = evaluateLoopPolicy({
            state: job.loop_state!,
            budget: loopBudget,
            classification,
            phase: step.phase,
            current_step_attempts: step.attempts
          });
          step.status = "blocked";
          step.failure_category = classification.category;
          step.failure_fingerprint = classification.fingerprint;
          step.error = classification.reason;
          step.finished_at = timestamp();
          await this.store.writeStepOwned(runId, step, ownership);
          job.status = "blocked";
          job.failure_category = classification.category;
          job.failure_fingerprint = classification.fingerprint;
          job.error = classification.reason;
          job.owner_token = null;
          job.finished_at = timestamp();
          job.loop_state = applyLoopDecision(job.loop_state!, loopBudget, loopDecision, {
            current_step_attempts: step.attempts,
            progress_fingerprint: durableProgressFingerprint(job, step)
          });
          job.progress = progressFor(job, step, "Step attempt budget exhausted", "blocked", { waitReason: classification.reason });
          await this.store.writeJobOwned(job, ownership);
          await emitJobProgress(job, step, "Step attempt budget exhausted");
          await emitJobTerminal(job, "blocked");
          await this.reportTerminal(job, step);
          return job;
        }
        step.status = "running";
        step.attempts += 1;
        step.owner_token = ownerToken;
        step.fencing_token = ownership.fencing_token;
        step.heartbeat_at = timestamp();
        step.started_at ??= timestamp();
        const stepTimeoutMs = boundedDuration(definition.step_timeout_ms, job.step_timeout_ms ?? this.stepTimeoutMs);
        const noProgressTimeoutMs = boundedDuration(definition.no_progress_timeout_ms, job.no_progress_timeout_ms ?? this.noProgressTimeoutMs);
        step.step_deadline = deadlineAt(step.started_at, stepTimeoutMs);
        step.no_progress_deadline = deadlineAt(job.progress.progress_at ?? step.started_at, noProgressTimeoutMs);
        step.heartbeat_write_failures = 0;
        job.step_deadline = step.step_deadline;
        job.no_progress_deadline = step.no_progress_deadline;
        job.progress.step_deadline = step.step_deadline;
        job.progress.no_progress_deadline = step.no_progress_deadline;
        job.progress.hard_deadline = job.hard_deadline;
        job.progress.heartbeat_write_failures = job.heartbeat_write_failures ?? 0;
        step.pending_operation = definition.action;
        await this.store.writeStepOwned(runId, step, ownership);
        job.status = job.status === "recovering" ? "recovering" : "running";
        job.current_step_id = step.step_id;
        job.progress = progressFor(job, step, definition.action, job.status === "recovering" ? "recovering" : "working", {
          writerActive: Boolean(definition.writer_active),
          browserActive: Boolean(definition.browser_active)
        });
        const startDecision = evaluateLoopPolicy({
          state: job.loop_state!,
          budget: loopBudget,
          phase: step.phase,
          current_step_attempts: Math.max(0, step.attempts - 1)
        });
        job.loop_state = applyLoopDecision(job.loop_state!, loopBudget, startDecision, {
          tool_calls_delta: 1,
          current_step_attempts: step.attempts,
          progress_fingerprint: durableProgressFingerprint(job, step)
        });
        await this.store.writeJobOwned(job, ownership);
        await emitJobProgress(job, step, definition.action);
        await componentStore.progress(workerComponentId, {
          kind: "worker",
          owner_id: ownerToken,
          fencing_token: ownership.fencing_token,
          marker: `step_started:${step.step_id}`,
          evidence_ref: this.store.stepPath(runId, step.step_id),
          no_progress_deadline: step.no_progress_deadline ?? null
        }).catch(() => undefined);
        await emitJobEvent("step_started", job, {
          step_id: step.step_id,
          phase: step.phase,
          attempt: step.attempts,
          action: definition.action
        });
        await this.appendTaskReport(job, {
          eventKind: "stage_started",
          title: `开始阶段：${step.phase}`,
          summary: definition.action,
          idempotencyKey: `durable:${runId}:stage-started:${step.step_id}:attempt:${step.attempts}`,
          step,
          occurredAt: step.started_at ?? step.heartbeat_at
        });

        let stepFinished = false;
        let heartbeatQueue: Promise<void> = Promise.resolve();
        const stepController = new AbortController();
        const controllerKey = activeControllerKey(job);
        activeStepControllers.set(controllerKey, stepController);
        let heartbeatWriteFailures = job.heartbeat_write_failures ?? 0;
        let heartbeatFailure: Error | undefined;
        let lastProgressMs = Date.parse(job.progress.progress_at ?? step.started_at ?? timestamp());
        const runHeartbeat = async (action: string, evidencePath: string | undefined, recordProgress: boolean): Promise<void> => {
          if (stepFinished) return;
          const currentJob = await this.store.readJob(runId);
          const currentStep = await this.store.readStep(runId, step.step_id);
          if (stepFinished || !currentJob || !currentStep) return;
          if (
            currentJob.owner_token !== ownerToken
            || Number(currentJob.fencing_token) !== ownership.fencing_token
            || currentStep.owner_token !== ownerToken
            || Number(currentStep.fencing_token) !== ownership.fencing_token
            || currentStep.status !== "running"
          ) return;
          const now = timestamp();
          currentStep.heartbeat_at = now;
          if (recordProgress) {
            lastProgressMs = Date.parse(now);
            currentStep.no_progress_deadline = deadlineAt(now, noProgressTimeoutMs);
            currentJob.no_progress_deadline = currentStep.no_progress_deadline;
          }
          currentStep.heartbeat_write_failures = 0;
          await this.store.writeStepOwned(runId, currentStep, ownership);
          if (stepFinished) return;
          let progressChanged = false;
          if (recordProgress) {
            const previous = currentJob.progress;
            const next = progressFor(currentJob, currentStep, action, "silent", {
              evidencePath,
              writerActive: Boolean(definition.writer_active),
              browserActive: Boolean(definition.browser_active)
            });
            if (
              previous.current_action === next.current_action
              && previous.last_evidence === next.last_evidence
              && previous.progress_fingerprint === next.progress_fingerprint
            ) {
              currentJob.progress = refreshLiveness(previous, now);
            } else {
              currentJob.progress = next;
              progressChanged = true;
            }
            currentJob.progress.no_progress_deadline = currentStep.no_progress_deadline;
          } else {
            currentJob.progress = refreshLiveness(currentJob.progress, now);
          }
          heartbeatWriteFailures = 0;
          currentJob.heartbeat_write_failures = 0;
          currentJob.progress.heartbeat_write_failures = 0;
          await this.store.writeJobOwned(currentJob, ownership);
          await emitJobEvent("execution_heartbeat", currentJob, {
            step_id: currentStep.step_id,
            phase: currentStep.phase,
            action,
            liveness_at: currentJob.progress.liveness_at ?? currentJob.progress.heartbeat_at,
            ...(recordProgress ? {
              progress_at: currentJob.progress.progress_at ?? currentJob.progress.heartbeat_at,
              progress_fingerprint: currentJob.progress.progress_fingerprint ?? taskProgressFingerprint(currentJob, currentStep, action, evidencePath)
            } : {})
          });
          if (recordProgress) {
            await componentStore.progress(workerComponentId, {
              kind: "worker",
              owner_id: ownerToken,
              fencing_token: ownership.fencing_token,
              at: now,
              marker: `step_progress:${currentStep.step_id}:${action}`,
              evidence_ref: evidencePath ?? this.store.stepPath(runId, currentStep.step_id),
              no_progress_deadline: currentStep.no_progress_deadline ?? null
            }).catch(() => undefined);
          } else {
            await componentStore.heartbeat(workerComponentId, {
              kind: "worker",
              owner_id: ownerToken,
              fencing_token: ownership.fencing_token,
              at: now
            }).catch(() => undefined);
          }
          if (recordProgress) await emitJobProgress(currentJob, currentStep, action, evidencePath);
          if (recordProgress && progressChanged) {
            await this.appendTaskReport(currentJob, {
              eventKind: "progress",
              title: `阶段进展：${currentStep.phase}`,
              summary: action,
              idempotencyKey: `durable:${runId}:progress:${currentJob.progress.progress_fingerprint ?? taskProgressFingerprint(currentJob, currentStep, action, evidencePath)}`,
              step: currentStep,
              evidencePaths: evidencePath ? [evidencePath] : [],
              occurredAt: currentJob.progress.progress_at ?? now
            });
          }
        };
        const heartbeat = (action?: string, evidencePath?: string): Promise<void> => {
          const requestedAction = action ?? definition.action;
          const recordProgress = action !== undefined || evidencePath !== undefined;
          heartbeatQueue = heartbeatQueue
            .then(() => runHeartbeat(requestedAction, evidencePath, recordProgress))
            .catch(async (error) => {
              heartbeatWriteFailures += 1;
              const message = clippedError(error);
              await emitJobEvent("execution_heartbeat", job, {
                step_id: step.step_id,
                phase: step.phase,
                heartbeat_error: message,
                consecutive_failures: heartbeatWriteFailures
              });
              if (heartbeatWriteFailures >= this.heartbeatFailureThreshold) {
                heartbeatFailure = error instanceof Error ? error : new Error(message);
              }
            });
          return heartbeatQueue;
        };
        const timer = setInterval(() => {
          void heartbeat();
        }, this.heartbeatIntervalMs);
        timer.unref();
        let watchdogTimer: NodeJS.Timeout | undefined;
        let deadlineReason: DurableJobTerminationReason | undefined;
        let deadlineTriggeredAt = 0;
        const triggerDeadline = (reason: DurableJobTerminationReason): void => {
          if (deadlineReason) return;
          deadlineReason = reason;
          deadlineTriggeredAt = Date.now();
          stepController.abort();
        };
        const deadlineMessage = (reason: DurableJobTerminationReason): string => {
          if (reason === "no_progress_timeout") return "Durable Job step made no real progress before its no-progress deadline.";
          if (reason === "step_timeout") return "Durable Job step exceeded its step deadline.";
          if (reason === "execution_hard_limit") return "Durable Job exceeded its execution hard deadline.";
          if (reason === "heartbeat_persistence_failed") return "Durable Job heartbeat persistence failed repeatedly.";
          return "Durable Job termination grace period expired.";
        };
        const deadlinePromise = new Promise<never>((_resolve, reject) => {
          const pollMs = Math.max(25, Math.min(this.heartbeatIntervalMs, 250));
          watchdogTimer = setInterval(() => {
            if (stepFinished) return;
            const now = Date.now();
            if (heartbeatFailure || resourceHeartbeatError) triggerDeadline("heartbeat_persistence_failed");
            else if (job.hard_deadline && now >= Date.parse(job.hard_deadline)) triggerDeadline("execution_hard_limit");
            else if (step.step_deadline && now >= Date.parse(step.step_deadline)) triggerDeadline("step_timeout");
            else if (Number.isFinite(lastProgressMs) && now - lastProgressMs >= noProgressTimeoutMs) triggerDeadline("no_progress_timeout");
            if (deadlineReason && now - deadlineTriggeredAt >= (job.cancel_grace_ms ?? this.cancelGraceMs)) {
              reject(new DurableJobDeadlineError(deadlineReason, deadlineMessage(deadlineReason)));
            }
          }, pollMs);
        });
        const handlerPromise = runWithinResourceLease(resourceLease, async () => await handler({
          job,
          step,
          attempt: step.attempts,
          signal: stepController.signal,
          heartbeat,
          report: async (input) => await this.appendTaskReport(job, {
            eventKind: input.event_kind,
            title: input.title,
            summary: input.summary,
            idempotencyKey: `durable:${runId}:explicit:${input.idempotency_key}`,
            step,
            severity: input.severity,
            detailMarkdown: input.detail_markdown,
            evidencePaths: input.evidence_paths,
            sourceRef: input.source_ref,
            occurredAt: input.occurred_at
          }),
          isCancellationRequested: async () => Boolean((await this.store.readJob(runId))?.cancel_requested)
        })).then((output) => {
          if (deadlineReason) throw new DurableJobDeadlineError(deadlineReason, deadlineMessage(deadlineReason));
          return output;
        }).catch((error) => {
          if (deadlineReason && !isDeadlineError(error)) {
            throw new DurableJobDeadlineError(deadlineReason, deadlineMessage(deadlineReason));
          }
          throw error;
        });
        try {
          const output = await Promise.race([handlerPromise, deadlinePromise]);
          stepFinished = true;
          clearInterval(timer);
          await heartbeatQueue;
          const outputPath = await this.store.writeStepOutputOwned(runId, step.step_id, output.data ?? { summary: output.summary }, ownership);
          step.status = "completed";
          step.termination_reason = undefined;
          step.output_summary = output.summary.slice(0, 8_000);
          step.output_path = outputPath;
          step.evidence_paths = [...new Set([...(output.evidence_paths ?? []), outputPath])];
          step.pending_operation = null;
          step.owner_token = undefined;
          step.finished_at = timestamp();
          step.heartbeat_at = step.finished_at;
          step.failure_category = undefined;
          step.failure_fingerprint = undefined;
          step.same_failure_repeats = 0;
          await this.store.writeStepOwned(runId, step, ownership);
          const latestJob = await this.store.readJob(runId);
          if (latestJob?.cancel_requested) job.cancel_requested = true;
          job.progress = progressFor(job, step, `Completed ${step.phase}`, "working", {
            evidencePath: step.evidence_paths.at(-1),
            writerActive: false,
            browserActive: false
          });
          job.failure_category = undefined;
          job.failure_fingerprint = undefined;
          job.termination_reason = undefined;
          job.loop_state = recordLoopProgress(
            job.loop_state!,
            job.loop_budget!,
            durableProgressFingerprint(job, step),
            `Step ${step.step_id} completed with new evidence.`
          );
          await this.store.writeJobOwned(job, ownership);
          await emitJobProgress(job, step, `Completed ${step.phase}`, step.evidence_paths.at(-1));
          await componentStore.progress(workerComponentId, {
            kind: "worker",
            owner_id: ownerToken,
            fencing_token: ownership.fencing_token,
            marker: `step_completed:${step.step_id}`,
            evidence_ref: step.evidence_paths.at(-1) ?? this.store.stepPath(runId, step.step_id)
          }).catch(() => undefined);
          await emitJobEvent("step_completed", job, {
            step_id: step.step_id,
            phase: step.phase,
            attempt: step.attempts,
            evidence_count: step.evidence_paths.length
          });
          await this.appendTaskReport(job, {
            eventKind: "stage_completed",
            title: `阶段完成：${step.phase}`,
            summary: step.output_summary,
            idempotencyKey: `durable:${runId}:stage-completed:${step.step_id}:attempt:${step.attempts}`,
            step,
            evidencePaths: step.evidence_paths,
            sourceRef: step.output_path,
            occurredAt: step.finished_at
          });
        } catch (error) {
          stepFinished = true;
          clearInterval(timer);
          await heartbeatQueue;
          const deadlineError = isDeadlineError(error) ? error : undefined;
          const latestJob = await this.store.readJob(runId);
          const cancellationRequested = !deadlineError && Boolean(latestJob?.cancel_requested);
          if (cancellationRequested) {
            const cancelledAt = timestamp();
            step.status = "cancelled";
            step.error = undefined;
            step.termination_reason = "explicit_cancel";
            step.pending_operation = null;
            step.owner_token = undefined;
            step.finished_at = cancelledAt;
            step.heartbeat_at = cancelledAt;
            await this.store.writeStepOwned(runId, step, ownership);
            job = latestJob ?? job;
            job.status = "cancelled";
            job.cancel_requested = true;
            job.error = undefined;
            job.termination_reason = "explicit_cancel";
            job.current_step_id = step.step_id;
            job.owner_token = null;
            job.finished_at = cancelledAt;
            job.duration_ms = Date.now() - startedMs;
            job.progress = progressFor(job, step, "Cancelled", "terminal", {
              waitReason: "Cancellation requested; the managed process tree was terminated.",
              writerActive: false,
              browserActive: false
            });
            job.progress.termination_reason = "explicit_cancel";
            await this.store.writeJobOwned(job, ownership);
            await emitJobProgress(job, step, "Cancelled");
            await emitJobTerminal(job, "cancelled");
            await this.reportTerminal(job, step);
            return job;
          }
          const message = clippedError(error);
          const classification = classifyLoopFailure({
            code: deadlineError?.reason === "no_progress_timeout" ? "no_progress" : deadlineError ? "resource_exhausted" : "durable_step_failed",
            message,
            side_effect_level: step.side_effect_level,
            non_idempotent: !step.idempotent,
            evidence_refs: step.evidence_paths
          });
          const previousFingerprint = step.failure_fingerprint;
          step.same_failure_repeats = previousFingerprint === classification.fingerprint
            ? (step.same_failure_repeats ?? 0) + 1
            : 1;
          const loopDecision = evaluateLoopPolicy({
            state: job.loop_state!,
            budget: job.loop_budget!,
            classification,
            phase: step.phase,
            current_step_attempts: step.attempts,
            progress_fingerprint: durableProgressFingerprint(job, step)
          });
          const effectiveCategory = loopDecision.category ?? classification.category;
          const needsReconciliation = effectiveCategory === "external_state_unknown";
          const policyStopped = ["policy_denied", "no_progress", "contract_changed", "resource_exhausted", "environment_error", "authorization_required"].includes(effectiveCategory);
          step.status = deadlineError ? "blocked" : needsReconciliation ? "recovery_required" : policyStopped ? "blocked" : "failed";
          step.error = message;
          if (deadlineError) step.termination_reason = deadlineError.reason;
          step.failure_category = effectiveCategory;
          step.failure_fingerprint = classification.fingerprint;
          step.pending_operation = null;
          step.owner_token = undefined;
          step.finished_at = timestamp();
          step.heartbeat_at = step.finished_at;
          await this.store.writeStepOwned(runId, step, ownership);
          job.status = deadlineError ? "blocked" : needsReconciliation ? "recovery_required" : policyStopped ? "blocked" : "failed";
          job.error = message;
          if (deadlineError) job.termination_reason = deadlineError.reason;
          job.failure_category = effectiveCategory;
          job.failure_fingerprint = classification.fingerprint;
          job.current_step_id = step.step_id;
          job.owner_token = null;
          job.finished_at = timestamp();
          job.duration_ms = Date.now() - startedMs;
          job.recovery_reason = needsReconciliation ? classification.reason : policyStopped ? loopDecision.reason : undefined;
          job.loop_state = applyLoopDecision(job.loop_state!, job.loop_budget!, loopDecision, {
            current_step_attempts: step.attempts,
            progress_fingerprint: durableProgressFingerprint(job, step)
          });
          job.progress = progressFor(job, step, `Failed ${step.phase}`, deadlineError || needsReconciliation || policyStopped ? "blocked" : "terminal", {
            waitReason: job.recovery_reason ?? message
          });
          if (deadlineError) job.progress.termination_reason = deadlineError.reason;
          job.progress.heartbeat_write_failures = heartbeatWriteFailures;
          await this.store.writeJobOwned(job, ownership);
          await emitJobProgress(job, step, `Failed ${step.phase}`);
          await componentStore.transition(workerComponentId, {
            kind: "worker",
            owner_id: ownerToken,
            fencing_token: ownership.fencing_token,
            state: deadlineError ? "terminating" : "terminal",
            evidence_ref: this.store.stepPath(runId, step.step_id)
          }).catch(() => undefined);
          await emitJobEvent("step_failed", job, {
            step_id: step.step_id,
            phase: step.phase,
            attempt: step.attempts,
            failure_category: effectiveCategory,
            failure_fingerprint: classification.fingerprint,
            loop_action: loopDecision.action
          });
          await emitJobTerminal(job, job.status);
          await this.reportTerminal(job, step);
          return job;
        } finally {
          stepFinished = true;
          clearInterval(timer);
          if (watchdogTimer) clearInterval(watchdogTimer);
          await heartbeatQueue;
          if (activeStepControllers.get(controllerKey) === stepController) activeStepControllers.delete(controllerKey);
        }
        job = (await this.store.readJob(runId)) ?? job;
      }

      job.status = "completed";
      job.owner_token = null;
      job.current_step_id = null;
      const completedAt = timestamp();
      job.finished_at = completedAt;
      job.duration_ms = Date.now() - startedMs;
      const completedFingerprint = loopProgressFingerprint({
        status: "completed",
        phase: "completed",
        evidence_ids: job.progress.last_evidence ? [job.progress.last_evidence] : [],
        contract_version: job.contract_version
      });
      job.progress = {
        ...job.progress,
        phase: "completed",
        current_step: job.steps.length,
        current_action: "Completed",
        heartbeat_at: completedAt,
        liveness_at: completedAt,
        progress_at: completedAt,
        progress_fingerprint: completedFingerprint,
        writer_active: false,
        browser_active: false,
        execution_state: "terminal"
      };
      markProgressRecorded(job, completedAt);
      job.failure_category = undefined;
      job.failure_fingerprint = undefined;
      const completeDecision = evaluateLoopPolicy({
        state: job.loop_state!,
        budget: job.loop_budget!,
        phase: "completed",
        verification_passed: true
      });
      job.loop_state = applyLoopDecision(job.loop_state!, job.loop_budget!, completeDecision, {
        progress_fingerprint: durableProgressFingerprint(job)
      });
      await this.store.writeJobOwned(job, ownership);
      await emitJobEvent("progress_recorded", job, {
        action: "Completed",
        progress_at: completedAt,
        liveness_at: completedAt,
        progress_fingerprint: completedFingerprint
      });
      await emitJobTerminal(job, "completed");
      if (!this.deferSuccessfulTerminalReport) await this.reportTerminal(job);
      await componentStore.terminal(workerComponentId, {
        kind: "worker",
        owner_id: ownerToken,
        fencing_token: ownership.fencing_token,
        reason: "durable_job_completed",
        evidence_ref: this.store.jobPath(runId)
      }).catch(() => undefined);
      return job;
    } finally {
      if (resourceHeartbeatTimer) clearInterval(resourceHeartbeatTimer);
      await resourceHeartbeatQueue;
      await this.resourceGovernor?.release(resourceLease);
      const current = await this.store.readJob(runId).catch(() => undefined);
      if (current) await emitJobEvent("owner_released", current, {
        owner_token: ownerToken,
        owner_pid: process.pid,
        fencing_token: ownership.fencing_token,
        operation: "execute"
      });
      if (current && terminal(current.status)) {
        await componentStore.terminal(workerComponentId, {
          kind: "worker",
          owner_id: ownerToken,
          fencing_token: ownership.fencing_token,
          reason: `durable_job_${current.status}`,
          evidence_ref: this.store.jobPath(runId)
        }).catch(() => undefined);
      }
      await this.store.releaseRunOwner(ownership);
    }
  }
}
