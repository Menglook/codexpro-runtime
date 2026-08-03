import { randomUUID } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import {
  applyPatchBundle,
  readManyFiles,
  runValidation,
  searchProject,
  type CompactResult,
  type RunTaskOptions
} from "./compactExecution.js";
import { DurableJobManager, type DurableJobStepHandlers } from "./jobs/jobManager.js";
import { scanDurableJobs } from "./jobs/jobRecovery.js";
import { DurableJobStore } from "./jobs/jobStore.js";
import type { DurableJobRecord, DurableJobStep, DurableJobStepDefinition, TaskProgress } from "./jobs/jobSteps.js";
import { redactSensitiveText } from "./redact.js";
import { assertActiveSkillCurrent } from "./skills/skillUsage.js";
import type { ActiveSkillRecord } from "./skills/types.js";
import { TaskProjectionService } from "./tasks/taskProjectionService.js";
import { buildBossModeReport } from "./workflow/bossReport.js";
import { classifyCommand } from "./workflow/commandSafetyPolicy.js";
import { decideReportPolicy, type ReportTerminalStatus } from "./workflow/reportPolicy.js";
import { classifyTask } from "./workflow/taskRouter.js";
import { buildChangeFootprint, compileMinimalChangeContract, reviewMinimalSufficiency } from "./workflow/minimalChange.js";

export type AsyncCompactTaskKind = "task" | "stage";
export type AsyncCompactTaskStatus = DurableJobRecord["status"];
export type CommandExecutionMode = "auto" | "sync" | "async";

export interface AsyncCompactTaskState {
  run_id: string;
  kind: AsyncCompactTaskKind;
  title: string;
  status: AsyncCompactTaskStatus;
  workspace_id: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  report_path?: string;
  result_summary?: string;
  error?: string;
  recovery_reason?: string;
  active_skill?: ActiveSkillRecord;
  current_step_id: string | null;
  progress: TaskProgress;
  steps: DurableJobStep[];
  cancel_requested: boolean;
}

interface PersistedAsyncInput {
  kind: AsyncCompactTaskKind;
  options: RunTaskOptions;
}

interface StepPayload {
  text?: string;
  data?: Record<string, unknown>;
  report_path?: string;
  result_summary?: string;
  combined_data?: Record<string, unknown>;
}

const activeTasks = new Map<string, Promise<void>>();
const RESULT_SUMMARY_MAX_CHARS = 8_000;
const RESULT_READ_MAX_CHARS = 60_000;
const LONG_PACKAGE_SCRIPT_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[^\s]*(?:build|test|smoke|typecheck|lint|verify|validate|validation|acceptance|release)[^\s]*(?:\s|$)/i;
const LONG_DIRECT_VALIDATION_PATTERN = /(?:^|\s)(?:pytest|playwright|vitest|jest|mocha|go\s+test|cargo\s+(?:test|check|clippy)|tsc|eslint)(?:\s|$)/i;

export function shouldStartAsyncValidation(
  commands: string[],
  mode: CommandExecutionMode = "auto",
  timeoutMs?: number
): boolean {
  if (mode === "async") return true;
  if (mode === "sync") return false;
  const normalized = commands.map((command) => command.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (normalized.length > 1) return true;
  if (!normalized.length) return false;
  if (timeoutMs !== undefined && timeoutMs > 30_000) return true;
  const command = normalized[0];
  const category = classifyCommand(command);
  return category === "build"
    || category === "frontend_test"
    || category === "backend_test"
    || LONG_PACKAGE_SCRIPT_PATTERN.test(command)
    || LONG_DIRECT_VALIDATION_PATTERN.test(command);
}

function taskKey(workspace: Workspace, runId: string): string {
  return `${workspace.root}\u0000${runId}`;
}

function safeRunId(input?: string): string {
  const requested = input?.trim();
  const generated = `async-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "z")}-${randomUUID().slice(0, 8)}`;
  const normalized = (requested || generated)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!normalized) throw new CodexProError("Invalid asynchronous run id.");
  return normalized;
}

function clip(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`;
}

function managerFor(config: CodexProConfig | undefined, guard: PathGuard, workspace: Workspace): DurableJobManager {
  return new DurableJobManager(new DurableJobStore(guard, workspace, config), {
    deferSuccessfulTerminalReport: true
  });
}

export function classifyAsyncCommandReplayPolicy(commands: string[]): Pick<DurableJobStepDefinition, "idempotent" | "retryable" | "side_effect_level" | "retry_policy" | "rollback_method"> {
  const categories = commands.map((command) => classifyCommand(command));
  if (categories.some((category) => category === "unknown")) {
    return {
      idempotent: false,
      retryable: false,
      side_effect_level: "unknown",
      retry_policy: "never",
      rollback_method: "Inspect command-specific external state and evidence before any manual replay."
    };
  }
  const hasBuild = categories.some((category) => category === "build");
  return {
    idempotent: true,
    retryable: true,
    side_effect_level: hasBuild ? "local_write" : "read_only",
    retry_policy: "automatic",
    ...(hasBuild ? { rollback_method: "Discard generated build artifacts if the validation must be reset." } : {})
  };
}

export function buildAsyncCompactStepDefinitions(options: RunTaskOptions): DurableJobStepDefinition[] {
  const steps: DurableJobStepDefinition[] = [
    {
      step_id: "01-planning",
      phase: "planning",
      action: "Compile the durable execution plan",
      idempotent: true,
      retryable: true,
      side_effect_level: "read_only",
      retry_policy: "automatic"
    }
  ];
  if (options.search_queries?.length || options.read_files?.length) {
    steps.push({
      step_id: "02-context-collecting",
      phase: "context_collecting",
      action: "Collect bounded project context",
      idempotent: true,
      retryable: true,
      side_effect_level: "read_only",
      retry_policy: "automatic"
    });
  }
  if (options.patches?.length) {
    steps.push({
      step_id: "03-executing",
      phase: "executing",
      action: "Apply scoped workspace changes",
      idempotent: false,
      retryable: false,
      side_effect_level: "local_write",
      retry_policy: "never",
      rollback_method: "Inspect the current Git diff and either continue from the partial patch or restore the affected files explicitly.",
      writer_active: true
    });
  }
  if (options.commands?.length) {
    const replay = classifyAsyncCommandReplayPolicy(options.commands);
    steps.push({
      step_id: "04-validating",
      phase: "validating",
      action: "Run bounded validation commands",
      ...replay,
      browser_active: options.commands.some((command) => /browser|playwright|chrome|cdp/i.test(command))
    });
  }
  steps.push({
    step_id: "05-reporting",
    phase: "reporting",
    action: "Assemble the evidence report",
    idempotent: true,
    retryable: true,
    side_effect_level: "local_write",
    retry_policy: "automatic",
    rollback_method: "Regenerate the report from persisted step outputs."
  });
  return steps;
}

async function readStepPayload(manager: DurableJobManager, runId: string, stepId: string): Promise<StepPayload | undefined> {
  return await manager.store.readStepOutput<StepPayload>(runId, stepId);
}

function buildHandlers(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  manager: DurableJobManager,
  kind: AsyncCompactTaskKind,
  options: RunTaskOptions
): DurableJobStepHandlers {
  const title = options.title?.trim() || (kind === "stage" ? "CodexPro stage" : "CodexPro task");
  const instruction = options.goal?.trim() || title;
  const explicitScope = [...new Set((options.patches ?? []).map((patch) => patch.path.trim()).filter(Boolean))];
  const route = classifyTask(instruction, {
    executionLanesEnabled: config.executionLanesEnabled,
    explicitScope: explicitScope.length ? explicitScope : undefined,
    patchesRequested: Boolean(options.patches?.length),
    commandsRequested: Boolean(options.commands?.length)
  });
  const compiledTask = route.compiled_task;
  const executionLane = options.execution_lane ?? route.execution_lane.lane;
  const handlers: DurableJobStepHandlers = {
    "01-planning": async ({ job, heartbeat }) => {
      await heartbeat("Durable plan compiled", job.input_path);
      return {
        summary: `Prepared ${job.steps.length} durable step(s).`,
        data: {
          run_id: job.run_id,
          kind,
          title,
          goal: options.goal ?? null,
          step_ids: job.steps,
          input_hash: job.input_hash
        },
        evidence_paths: [job.input_path]
      };
    },
    "05-reporting": async ({ job, heartbeat, report }) => {
      const context = await readStepPayload(manager, job.run_id, "02-context-collecting");
      const execution = await readStepPayload(manager, job.run_id, "03-executing");
      const validation = await readStepPayload(manager, job.run_id, "04-validating");
      const minimalChangeContract = compileMinimalChangeContract({
        ...compiledTask.minimal_change_contract,
        ...(options.minimal_change_contract ?? {})
      });
      const operations = Array.isArray(execution?.data?.operations)
        ? execution.data.operations as Array<Record<string, unknown>>
        : [];
      const changeFootprint = buildChangeFootprint({
        contract: minimalChangeContract,
        operations: operations.map((item) => ({
          path: typeof item.path === "string" ? item.path : "",
          operation: typeof item.operation === "string" ? item.operation : undefined,
          status: typeof item.status === "string" ? item.status : undefined,
          additions: typeof item.additions === "number" ? item.additions : undefined,
          deletions: typeof item.deletions === "number" ? item.deletions : undefined
        })).filter((item) => item.path),
        path_reasons: options.path_reasons,
        preserved_boundaries: options.preserved_boundaries,
        unresolved_gaps: options.unresolved_gaps
      });
      const minimalSufficiencyReview = reviewMinimalSufficiency(changeFootprint);
      const data: Record<string, unknown> = {
        run_id: job.run_id,
        title,
        goal: options.goal ?? null,
        compiled_task: compiledTask,
        execution_lane: route.execution_lane,
        minimal_change_contract: minimalChangeContract,
        change_footprint: changeFootprint,
        minimal_sufficiency_review: minimalSufficiencyReview,
        job: {
          run_id: job.run_id,
          status: job.status,
          current_step_id: job.current_step_id,
          progress: job.progress,
          recovery_reason: job.recovery_reason ?? null,
          steps: job.steps
        },
        ...(context?.data ?? {}),
        ...(execution?.data ? { patches: execution.data } : {}),
        ...(validation?.data ? { validation: validation.data } : {}),
        ...(options.active_skill ? { active_skill: options.active_skill } : {})
      };
      const patchStatus = typeof execution?.data?.status === "string" ? execution.data.status : undefined;
      const validationStatus = typeof validation?.data?.status === "string" ? validation.data.status : undefined;
      const status: ReportTerminalStatus = validationStatus === "blocked"
        ? "blocked"
        : validationStatus === "cancelled"
          ? "cancelled"
          : validationStatus === "failed" || patchStatus === "failed" || patchStatus === "partial"
            ? "failed"
            : "passed";
      const policy = decideReportPolicy({
        lane: executionLane,
        status,
        output_mode: options.output_mode,
        persistence_mode: options.persistence_mode,
        save_full_logs: options.save_full_logs,
        repair_count: options.repair_count,
        escalated: options.escalated,
        debug: options.debug,
        unknown_external_state: options.unknown_external_state,
        lane_based_enabled: config.reportPolicyLaneBased,
        full_logs_on_failure: config.reportFullLogsOnFailure
      });
      data.status = status;
      data.reason_code = status === "passed"
        ? "async_task_completed"
        : typeof validation?.data?.reason_code === "string"
          ? validation.data.reason_code
          : patchStatus === "partial"
            ? "async_task_patch_partial"
            : patchStatus === "failed"
              ? "async_task_patch_failed"
              : `async_task_${status}`;
      data.report_policy = policy;
      data.unknown_external_state = options.unknown_external_state === true;
      const reportPath = policy.save_technical_report ? `${manager.store.runRoot(job.run_id)}/task-report.md` : undefined;
      const bossReportPath = policy.save_full_boss_report ? `${manager.store.runRoot(job.run_id)}/boss-report-full.md` : undefined;
      const technicalSections = [
        `# ${title}`,
        "",
        `run_id: ${job.run_id}`,
        options.goal?.trim() ? `\n## Goal\n\n${options.goal.trim()}` : "",
        context?.text ? `\n${context.text}` : "",
        execution?.text ? `\n${execution.text}` : "",
        validation?.text ? `\n${validation.text}` : "",
        options.active_skill ? `\n## Active Skill\n\n${options.active_skill.name} @ ${options.active_skill.source_commit}\n\nDigest: ${options.active_skill.digest}` : ""
      ].filter(Boolean);
      if (reportPath) {
        await manager.store.writeText(reportPath, `${technicalSections.join("\n")}\n`);
        data.report_path = reportPath;
        data.technical_report_path = reportPath;
        await report({
          event_kind: "artifact_created",
          title: "技术报告已生成",
          summary: `技术报告已保存至 ${reportPath}。`,
          evidence_paths: [reportPath],
          idempotency_key: `technical-report:${reportPath}`
        });
      }
      if (bossReportPath) {
        data.boss_report_path = bossReportPath;
        const fullReport = buildBossModeReport({
          title,
          goal: options.goal ?? null,
          runId: job.run_id,
          kind,
          data,
          technicalReportPath: reportPath,
          format: "full"
        });
        await manager.store.writeText(bossReportPath, `${fullReport.trimEnd()}\n`);
        await report({
          event_kind: "artifact_created",
          title: "老板报告已生成",
          summary: `老板报告已保存至 ${bossReportPath}。`,
          evidence_paths: [bossReportPath],
          idempotency_key: `boss-report:${bossReportPath}`
        });
      }
      const resultSummary = buildBossModeReport({
        title,
        goal: options.goal ?? null,
        runId: job.run_id,
        kind,
        data,
        technicalReportPath: reportPath,
        format: "compact"
      });
      await heartbeat(policy.archive_mode === "full" ? "Full evidence reports persisted" : "Compact result summary persisted", bossReportPath ?? reportPath ?? job.input_path);
      const evidencePaths = [reportPath, bossReportPath].filter((value): value is string => Boolean(value));
      return {
        summary: resultSummary,
        data: {
          ...(reportPath ? { report_path: reportPath } : {}),
          ...(bossReportPath ? { boss_report_path: bossReportPath } : {}),
          result_summary: resultSummary,
          combined_data: data
        },
        evidence_paths: evidencePaths
      };
    }
  };

  if (options.search_queries?.length || options.read_files?.length) {
    handlers["02-context-collecting"] = async ({ heartbeat, isCancellationRequested }) => {
      const texts: string[] = [];
      const data: Record<string, unknown> = {};
      if (options.search_queries?.length) {
        if (await isCancellationRequested()) throw new Error("Task cancelled before project search.");
        await heartbeat("Searching bounded project scope");
        const result = await searchProject(config, guard, workspace, options.search_queries, {
          path: options.search_path,
          glob: options.search_glob,
          include_hidden: options.search_include_hidden,
          max_results_per_query: options.max_results_per_query,
          max_files_per_task: options.max_files_per_task,
          max_lines_per_file: options.max_lines_per_file,
          max_total_chars: options.max_total_chars,
          allow_long_task: options.allow_long_task
        });
        texts.push(result.text);
        data.search = result.data;
      }
      if (options.read_files?.length) {
        if (await isCancellationRequested()) throw new Error("Task cancelled before project reads.");
        await heartbeat("Reading bounded project files");
        const result = await readManyFiles(config, guard, workspace, options.read_files, options.max_chars_per_file, {
          maxFilesPerTask: options.max_files_per_task,
          maxLinesPerFile: options.max_lines_per_file,
          maxTotalChars: options.max_total_chars
        });
        texts.push(result.text);
        data.read = result.data;
      }
      return {
        summary: `Context collection completed with ${options.search_queries?.length ?? 0} search query(s) and ${options.read_files?.length ?? 0} file read(s).`,
        data: { text: texts.join("\n\n"), data }
      };
    };
  }

  if (options.patches?.length) {
    handlers["03-executing"] = async ({ heartbeat, isCancellationRequested }) => {
      if (await isCancellationRequested()) throw new Error("Task cancelled before workspace changes.");
      await heartbeat("Applying scoped workspace changes");
      const result = await applyPatchBundle(config, guard, workspace, options.patches ?? []);
      return {
        summary: `Workspace change step finished with status ${String(result.data.status)}.`,
        data: { text: result.text, data: result.data }
      };
    };
  }

  if (options.commands?.length) {
    handlers["04-validating"] = async ({ heartbeat, isCancellationRequested, signal }) => {
      if (await isCancellationRequested()) throw new Error("Task cancelled before validation.");
      await heartbeat("Running bounded validation");
      const result = await runValidation(config, guard, workspace, {
        commands: options.commands,
        cwd: options.cwd,
        timeout_ms: options.timeout_ms,
        session_id: options.session_id,
        output_mode: options.output_mode,
        tail_lines: options.tail_lines,
        run_id: options.run_id,
        persistence_mode: options.persistence_mode,
        save_full_logs: options.save_full_logs,
        execution_lane: executionLane,
        repair_count: options.repair_count,
        escalated: options.escalated,
        debug: options.debug,
        unknown_external_state: options.unknown_external_state,
        signal
      });
      const evidencePaths = typeof result.data.report_path === "string" ? [result.data.report_path] : [];
      return {
        summary: `Validation completed with status ${String(result.data.status)}.`,
        data: { text: result.text, data: result.data },
        evidence_paths: evidencePaths
      };
    };
  }
  return handlers;
}

async function stateFrom(manager: DurableJobManager, runId: string): Promise<AsyncCompactTaskState> {
  const { job, steps } = await manager.inspect(runId);
  return {
    run_id: job.run_id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    workspace_id: job.workspace_id,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    duration_ms: job.duration_ms,
    report_path: job.report_path,
    result_summary: job.result_summary,
    error: job.error,
    recovery_reason: job.recovery_reason,
    active_skill: job.active_skill,
    current_step_id: job.current_step_id,
    progress: job.progress,
    steps,
    cancel_requested: job.cancel_requested
  };
}

async function executeDurableAsyncTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  kind: AsyncCompactTaskKind,
  options: RunTaskOptions,
  runId: string
): Promise<void> {
  const manager = managerFor(config, guard, workspace);
  const definitions = buildAsyncCompactStepDefinitions(options);
  const handlers = buildHandlers(config, guard, workspace, manager, kind, options);
  let job = await manager.execute(runId, handlers, definitions);
  const execution = await readStepPayload(manager, runId, "03-executing");
  const validation = await readStepPayload(manager, runId, "04-validating");
  const reporting = await readStepPayload(manager, runId, "05-reporting");
  if (reporting?.report_path || reporting?.result_summary) {
    job.report_path = reporting.report_path;
    job.result_summary = reporting.result_summary
      ? clip(redactSensitiveText(reporting.result_summary), RESULT_SUMMARY_MAX_CHARS)
      : undefined;
  }
  const patchStatus = execution?.data?.status;
  const validationStatus = validation?.data?.status;
  const terminalFailure = patchStatus === "failed"
    ? { status: "failed" as const, phase: "failed", action: "Workspace changes failed", reason: "One or more scoped workspace changes failed. See the persisted report." }
    : validationStatus === "blocked"
      ? { status: "blocked" as const, phase: "blocked", action: "Validation blocked", reason: `Validation was blocked: ${String(validation?.data?.reason ?? "policy")}.` }
      : validationStatus === "failed"
        ? { status: "failed" as const, phase: "failed", action: "Validation failed", reason: "Validation failed. See the persisted report." }
        : null;
  if (terminalFailure && job.status === "completed") {
    const now = new Date().toISOString();
    job.status = terminalFailure.status;
    job.error = terminalFailure.reason;
    job.current_step_id = validationStatus === "blocked" || validationStatus === "failed" ? "04-validating" : "03-executing";
    job.progress = {
      ...job.progress,
      phase: terminalFailure.phase,
      current_action: terminalFailure.action,
      wait_reason: terminalFailure.reason,
      heartbeat_at: now,
      liveness_at: now,
      progress_at: now,
      progress_fingerprint: `${terminalFailure.status}:${terminalFailure.phase}:${terminalFailure.action}`,
      writer_active: false,
      browser_active: false,
      execution_state: "terminal"
    };
    job.first_progress_at ??= now;
  }
  await manager.store.writeJob(job);
  await manager.publishTerminalReport(job);
}

function scheduleExecution(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  kind: AsyncCompactTaskKind,
  options: RunTaskOptions,
  runId: string
): void {
  const key = taskKey(workspace, runId);
  if (activeTasks.has(key)) return;
  const promise = executeDurableAsyncTask(config, guard, workspace, kind, options, runId)
    .catch((error) => {
      console.error(`[CodexPro] durable asynchronous task ${runId} failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    })
    .finally(() => activeTasks.delete(key));
  activeTasks.set(key, promise);
}

async function markSkillRecoveryRequired(
  manager: DurableJobManager,
  runId: string,
  error: unknown
): Promise<AsyncCompactTaskState> {
  const job = await manager.store.readJob(runId);
  if (!job) throw new CodexProError(`Durable asynchronous task not found: ${runId}`);
  const now = new Date().toISOString();
  job.status = "recovery_required";
  job.recovery_reason = error instanceof Error ? error.message : String(error);
  job.progress = {
    ...job.progress,
    phase: "skill_verification",
    current_action: "Waiting for the approved Skill version to be restored or reloaded",
    wait_reason: job.recovery_reason,
    heartbeat_at: now,
    liveness_at: now,
    progress_at: now,
    writer_active: false,
    browser_active: false,
    execution_state: "blocked"
  };
  await manager.store.writeJob(job);
  return await stateFrom(manager, runId);
}

async function verifyDurableActiveSkill(
  config: CodexProConfig,
  manager: DurableJobManager,
  runId: string,
  activeSkill: ActiveSkillRecord | undefined
): Promise<AsyncCompactTaskState | undefined> {
  if (!activeSkill) return undefined;
  try {
    await assertActiveSkillCurrent(config, activeSkill);
    return undefined;
  } catch (error) {
    return await markSkillRecoveryRequired(manager, runId, error);
  }
}

export async function startAsyncCompactTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  kind: AsyncCompactTaskKind,
  options: RunTaskOptions
): Promise<AsyncCompactTaskState> {
  const runId = safeRunId(options.run_id);
  const activeSkill = options.active_skill ? await assertActiveSkillCurrent(config, options.active_skill) : undefined;
  const normalizedOptions = { ...options, ...(activeSkill ? { active_skill: activeSkill } : {}), run_id: runId, allow_long_task: true };
  const manager = managerFor(config, guard, workspace);
  const input: PersistedAsyncInput = { kind, options: normalizedOptions };
  const job = await manager.create({
    run_id: runId,
    kind,
    title: options.title?.trim() || (kind === "stage" ? "CodexPro stage" : "CodexPro task"),
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    input: input as unknown as Record<string, unknown>,
    ...(activeSkill ? { active_skill: activeSkill } : {}),
    steps: buildAsyncCompactStepDefinitions(normalizedOptions)
  });
  const taskService = new TaskProjectionService(config, guard, workspace);
  await taskService.ensureDurableJob({
    run_id: job.run_id,
    title: job.title,
    workspace_root: job.workspace_root,
    ...(options.task_identity?.parent_task_id ? { parent_task_id: options.task_identity.parent_task_id } : {}),
    ...(options.task_identity?.objective ? { objective: options.task_identity.objective } : {}),
    ...(options.task_identity?.workspace_binding ? { workspace_binding: options.task_identity.workspace_binding } : {}),
    ...(options.task_identity?.actor ? { actor: options.task_identity.actor } : {}),
    created_at: job.created_at,
    updated_at: job.updated_at
  });
  if (!["completed", "failed", "blocked", "cancelled", "recovery_required"].includes(job.status)) {
    scheduleExecution(config, guard, workspace, kind, normalizedOptions, runId);
  }
  return await stateFrom(manager, runId);
}

export async function resumeAsyncCompactTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string
): Promise<AsyncCompactTaskState> {
  const runId = safeRunId(runIdInput);
  const manager = managerFor(config, guard, workspace);
  const input = await manager.store.readJson<PersistedAsyncInput>(manager.store.inputPath(runId));
  if (!input) throw new CodexProError(`Durable asynchronous task input not found: ${runId}`);
  const blocked = await verifyDurableActiveSkill(config, manager, runId, input.options.active_skill);
  if (blocked) return blocked;
  const prepared = await manager.prepareRecovery(runId);
  if (prepared.status !== "recovery_required" && !["completed", "failed", "blocked", "cancelled"].includes(prepared.status)) {
    scheduleExecution(config, guard, workspace, input.kind, input.options, runId);
  }
  return await stateFrom(manager, runId);
}

export async function retryAsyncCompactTaskStep(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string,
  stepId: string
): Promise<AsyncCompactTaskState> {
  const runId = safeRunId(runIdInput);
  const manager = managerFor(config, guard, workspace);
  const input = await manager.store.readJson<PersistedAsyncInput>(manager.store.inputPath(runId));
  if (!input) throw new CodexProError(`Durable asynchronous task input not found: ${runId}`);
  const blocked = await verifyDurableActiveSkill(config, manager, runId, input.options.active_skill);
  if (blocked) return blocked;
  await manager.retryStep(runId, stepId);
  scheduleExecution(config, guard, workspace, input.kind, input.options, runId);
  return await stateFrom(manager, runId);
}

export async function cancelAsyncCompactTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string
): Promise<AsyncCompactTaskState> {
  const runId = safeRunId(runIdInput);
  const manager = managerFor(config, guard, workspace);
  await manager.requestCancel(runId);
  return await stateFrom(manager, runId);
}

export async function recoverAsyncCompactTasks(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<{ scanned: number; resumed: string[]; recovery_required: string[]; stale: string[] }> {
  const manager = managerFor(config, guard, workspace);
  const report = await scanDurableJobs(manager);
  const resumed: string[] = [];
  const recoveryRequired = new Set(report.recovery_required);
  for (const runId of report.recoverable) {
    const input = await manager.store.readJson<PersistedAsyncInput>(manager.store.inputPath(runId));
    if (!input) continue;
    const blocked = await verifyDurableActiveSkill(config, manager, runId, input.options.active_skill);
    if (blocked) {
      recoveryRequired.add(runId);
      continue;
    }
    const prepared = await manager.prepareRecovery(runId);
    if (prepared.status === "recovery_required") {
      recoveryRequired.add(runId);
      continue;
    }
    scheduleExecution(config, guard, workspace, input.kind, input.options, runId);
    resumed.push(runId);
  }
  return {
    scanned: report.scanned,
    resumed,
    recovery_required: [...recoveryRequired].sort(),
    stale: report.stale
  };
}

export async function getAsyncCompactTaskStatus(
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string
): Promise<AsyncCompactTaskState> {
  const runId = safeRunId(runIdInput);
  const manager = managerFor(undefined, guard, workspace);
  try {
    return await stateFrom(manager, runId);
  } catch (error) {
    if (/not found/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CodexProError(`Asynchronous task not found: ${runId}`);
    }
    throw error;
  }
}

export async function readAsyncCompactTaskResult(
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string,
  maxChars = RESULT_READ_MAX_CHARS
): Promise<{ state: AsyncCompactTaskState; text?: string }> {
  const state = await getAsyncCompactTaskStatus(guard, workspace, runIdInput);
  if (!["completed", "failed", "blocked", "cancelled"].includes(state.status)) return { state };
  const manager = managerFor(undefined, guard, workspace);
  const reporting = await manager.store.readStepOutput<StepPayload>(state.run_id, "05-reporting");
  const hydratedState: AsyncCompactTaskState = {
    ...state,
    ...(state.report_path ? {} : reporting?.report_path ? { report_path: reporting.report_path } : {}),
    ...(state.result_summary ? {} : reporting?.result_summary ? { result_summary: reporting.result_summary } : {})
  };
  if (!hydratedState.report_path) return { state: hydratedState, text: hydratedState.result_summary };
  const expectedPrefix = `.codexpro/runs/${hydratedState.run_id}/`;
  if (!hydratedState.report_path.startsWith(expectedPrefix)) throw new CodexProError("Asynchronous task report path is outside its run directory.");
  const raw = redactSensitiveText(await manager.store.readText(hydratedState.report_path) ?? "");
  return { state: hydratedState, text: clip(raw, Math.max(1_000, Math.min(maxChars, RESULT_READ_MAX_CHARS))) };
}

export async function runDurableTaskForTesting(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  kind: AsyncCompactTaskKind,
  options: RunTaskOptions
): Promise<AsyncCompactTaskState> {
  const started = await startAsyncCompactTask(config, guard, workspace, kind, options);
  const key = taskKey(workspace, started.run_id);
  await activeTasks.get(key);
  return await getAsyncCompactTaskStatus(guard, workspace, started.run_id);
}

export type { CompactResult };
