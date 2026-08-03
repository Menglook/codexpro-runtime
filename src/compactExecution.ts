import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  acquireWorkspaceLeaseSync,
  heartbeatWorkspaceLeaseSync,
  releaseWorkspaceLeaseSync,
  type WorkspaceLease
} from "../shared/execution-kernel.mjs";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { editTextFile, readTextFile, writeTextFile } from "./fsOps.js";
import {
  classifySearchFailure,
  SearchOperationError,
  searchWorkspaceMany,
  type SearchMatch
} from "./searchOps.js";
import { runBash, type BashResult } from "./bashOps.js";
import { budgetExceededAdvice, loadContextBudget, type ContextBudgetOverrides, type ResolvedContextBudget } from "./contextBudget.js";
import { gitStatus } from "./gitOps.js";
import { buildBossModeReport } from "./workflow/bossReport.js";
import { compileCommandBatchPlan, evaluateCommandBatchSafetyFromPlans, formatCommandSafetyBlock, type CommandBatchPlan, type CommandExecutionPlan, type CommandSafetyDecision } from "./workflow/commandSafetyPolicy.js";
import type { ExecutionLane } from "./workflow/executionLane.js";
import { classifyAggregateExecutionArgs } from "./workflow/aggregateExecutionMode.js";
import { withProcessTrackingSuppressed } from "./runtime/processWrapper.js";
import {
  enforceGoldTaskFrozenValidation,
  enforceGoldTaskPatchLoopBudget,
  goldTaskProgressSnapshot,
  releaseGoldTaskPatchLoopReservation
} from "./evaluation/goldTaskSession.js";
import { decideReportPolicy, type ReportPolicyDecision, type ReportTerminalStatus } from "./workflow/reportPolicy.js";
import { classifyTask } from "./workflow/taskRouter.js";
import {
  buildChangeFootprint,
  compileMinimalChangeContract,
  formatMinimalChangeSummary,
  reviewMinimalSufficiency,
  type MinimalChangeContractInput,
  type MinimalChangePathReason
} from "./workflow/minimalChange.js";
import { statusChangedFiles } from "./workflow/dirtyGuard.js";
import { redactSensitiveText } from "./redact.js";
import { readUsageSummary } from "./observability/usageLedger.js";
import type { UsageLedgerSummaryV1 } from "./observability/usageTypes.js";
import type { ActiveSkillRecord } from "./skills/types.js";
import { TOOL_LIMITS } from "./tools/toolLimits.js";
import { assertActiveSkillCurrent } from "./skills/skillUsage.js";
import { assertSkillExecutionPolicy, skillExecutionPolicy } from "./skills/skillPolicy.js";
import { compareNeatFreakTaskPlan, prepareNeatFreakTaskPlan } from "./skills/skillPlan.js";
import type { SkillTaskPlanInput } from "./skills/types.js";
import type { TaskActorIdentityV1, TaskObjectiveMetadataV1, TaskWorkspaceBindingV1 } from "./tasks/types.js";
import { isResourceWaitTimeoutError, requestForWorkspaceTask, ResourceGovernor, type ResourcePriority, type ResourcePoolName } from "./resources/resourceGovernor.js";
import {
  formatTestImpactPlan,
  nextTestImpactState,
  planImpactedTests,
  reusablePassedNodeIds,
  type TestImpactLevel,
  type TestImpactNode,
  type TestImpactPlan,
  type TestImpactResultRecord,
  type TestImpactState
} from "./testing/testImpactGraph.js";

export type CompactOutputMode = "compact" | "full";

export interface ReadManyFileInput {
  path: string;
  start_line?: number;
  end_line?: number;
  max_bytes?: number;
}

export interface CompactResult {
  text: string;
  data: Record<string, unknown>;
}

export interface PatchBundleOperation {
  operation_id?: string;
  operation: "write" | "replace";
  path: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  create_dirs?: boolean;
  overwrite?: boolean;
  replace_all?: boolean;
  expected_replacements?: number;
}

export interface RunValidationOptions {
  commands?: string[];
  cwd?: string;
  timeout_ms?: number;
  session_id?: string;
  output_mode?: CompactOutputMode;
  tail_lines?: number;
  run_id?: string;
  save_full_logs?: boolean;
  persistence_mode?: import("./workflow/reportPolicy.js").ReportPersistenceMode;
  signal?: AbortSignal;
  changed_files?: string[];
  test_level?: TestImpactLevel;
  execution_lane?: ExecutionLane;
  repair_count?: number;
  escalated?: boolean;
  debug?: boolean;
  unknown_external_state?: boolean;
  command_plans?: CommandExecutionPlan[];
}

export interface DurableTaskIdentityContextV1 {
  parent_task_id?: string;
  objective?: TaskObjectiveMetadataV1;
  workspace_binding?: TaskWorkspaceBindingV1;
  actor?: TaskActorIdentityV1;
}

export interface RunTaskOptions extends RunValidationOptions {
  title?: string;
  goal?: string;
  task_identity?: DurableTaskIdentityContextV1;
  read_files?: ReadManyFileInput[];
  search_queries?: string[];
  search_path?: string;
  search_glob?: string;
  search_include_hidden?: boolean;
  patches?: PatchBundleOperation[];
  max_chars_per_file?: number;
  max_results_per_query?: number;
  max_files_per_task?: number;
  max_lines_per_file?: number;
  max_total_chars?: number;
  allow_long_task?: boolean;
  minimal_change_contract?: MinimalChangeContractInput;
  path_reasons?: Record<string, string | MinimalChangePathReason>;
  preserved_boundaries?: string[];
  active_skill?: ActiveSkillRecord;
  skill_plan?: SkillTaskPlanInput;
  unresolved_gaps?: string[];
}

export const MAX_AGGREGATE_SEARCH_QUERIES = TOOL_LIMITS.aggregate_execution.max_search_queries;
export const MAX_AGGREGATE_RESULTS_PER_QUERY = TOOL_LIMITS.aggregate_execution.max_results_per_query;
export const MAX_AGGREGATE_READ_FILES = TOOL_LIMITS.aggregate_execution.max_read_files;
export const MAX_AGGREGATE_PATCHES = TOOL_LIMITS.aggregate_execution.max_patches;
export const MAX_AGGREGATE_COMMANDS = TOOL_LIMITS.aggregate_execution.max_commands;

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function slug(value: string, fallback = "run"): string {
  const out = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return out || fallback;
}

function runId(input: string | undefined, title: string): string {
  return input?.trim() ? slug(input) : `${stamp()}-${slug(title)}`;
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`;
}

function tail(value: string, maxLines: number): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return value;
  return [`...[showing last ${maxLines} lines]`, ...lines.slice(-maxLines)].join("\n");
}

function normalizeCommands(commands?: string[], fallback: string[] = []): string[] {
  const source = commands?.length ? commands : fallback;
  return source.map((command) => command.trim()).filter(Boolean).slice(0, TOOL_LIMITS.validation.max_commands);
}

export function resolveValidationCommands(
  config: CodexProConfig,
  workspace: Workspace,
  options: Pick<RunValidationOptions, "commands" | "changed_files" | "test_level"> = {}
): string[] {
  const explicitCommands = normalizeCommands(options.commands);
  if (explicitCommands.length) return explicitCommands;
  return planImpactedTests(
    options.changed_files ?? statusChangedFiles(gitStatus(config, workspace)),
    { level: options.test_level ?? "targeted" }
  ).commands;
}

function assertAggregateTaskShape(options: RunTaskOptions): void {
  if (options.allow_long_task) return;
  const searchCount = options.search_queries?.map((query) => query.trim()).filter(Boolean).length ?? 0;
  if (searchCount > MAX_AGGREGATE_SEARCH_QUERIES) {
    throw new CodexProError(`run_task/run_stage accepts at most ${MAX_AGGREGATE_SEARCH_QUERIES} search queries. Narrow the scope or use start_run_task for a long task.`);
  }

  const readCount = options.read_files?.filter((file) => Boolean(file?.path?.trim())).length ?? 0;
  if (readCount > MAX_AGGREGATE_READ_FILES) {
    throw new CodexProError(`run_task/run_stage accepts at most ${MAX_AGGREGATE_READ_FILES} read files. Narrow the scope or use start_run_task for a long task.`);
  }

  const patchCount = options.patches?.filter((patch) => Boolean(patch?.path?.trim())).length ?? 0;
  if (patchCount > MAX_AGGREGATE_PATCHES) {
    throw new CodexProError(`run_task/run_stage accepts at most ${MAX_AGGREGATE_PATCHES} patch operations. Split the change or use start_run_task for a long task.`);
  }

  const commandCount = options.commands?.map((command) => command.trim()).filter(Boolean).length ?? 0;
  if (commandCount > MAX_AGGREGATE_COMMANDS) {
    throw new CodexProError(`run_task/run_stage accepts at most ${MAX_AGGREGATE_COMMANDS} targeted validation commands. Use run_validation separately or start_run_task for a long task.`);
  }
}

function compactSearchData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    status: data.status,
    query_count: data.query_count,
    search_backend: data.search_backend,
    duration_ms: data.duration_ms,
    search_process_count: data.search_process_count,
    filesystem_walk_count: data.filesystem_walk_count,
    files_scanned: data.files_scanned,
    files_read: data.files_read,
    bytes_scanned: data.bytes_scanned,
    degraded_reason: data.degraded_reason,
    failure_code: data.failure_code,
    budget: data.budget,
    budget_exceeded: data.budget_exceeded,
    total_chars: data.total_chars
  };
}

function compactReadData(data: Record<string, unknown>): Record<string, unknown> {
  return {
    file_count: data.file_count,
    skipped: data.skipped,
    budget: data.budget,
    budget_exceeded: data.budget_exceeded,
    total_chars: data.total_chars
  };
}

function budgetOverridesFromOptions(options: { max_files_per_task?: number; max_lines_per_file?: number; max_total_chars?: number } = {}): ContextBudgetOverrides {
  return {
    maxFilesPerTask: options.max_files_per_task,
    maxLinesPerFile: options.max_lines_per_file,
    maxTotalChars: options.max_total_chars
  };
}

function budgetMetadata(budget: ResolvedContextBudget): Record<string, unknown> {
  return {
    max_files_per_task: budget.maxFilesPerTask,
    max_lines_per_file: budget.maxLinesPerFile,
    max_total_chars: budget.maxTotalChars,
    source: budget.source
  };
}

function appendBudgetHeader(sections: string[], budget: ResolvedContextBudget): void {
  sections.push(`Budget: max_files_per_task=${budget.maxFilesPerTask}, max_lines_per_file=${budget.maxLinesPerFile}, max_total_chars=${budget.maxTotalChars} (${budget.source})`, "");
}

function usageDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unavailable";
  return `${Math.max(0, Math.round(value))}ms`;
}

function usageReportLines(summary: UsageLedgerSummaryV1): string[] {
  if (summary.availability !== "available") {
    return ["Usage Ledger: unavailable; no verified terminal usage entries are available for this run."];
  }
  const measurement = summary.token_measurement;
  const modelTotals = summary.tokens;
  return [
    `Usage Ledger entries: ${summary.entry_count}; warnings: ${summary.warning_count}.`,
    `Durations: total=${usageDuration(summary.total_wall_duration_ms)}, queue=${usageDuration(summary.queue_duration_ms)}, active=${usageDuration(summary.active_duration_ms)}, silent=${usageDuration(summary.silent_duration_ms)}, acceptance=${usageDuration(summary.acceptance_duration_ms)}.`,
    `Model measurement: measured=${measurement.measured}, estimated=${measurement.estimated}, unavailable=${measurement.unavailable}${modelTotals ? `; input=${modelTotals.input}, cached_input=${modelTotals.cached_input}, output=${modelTotals.output}, reasoning_output=${modelTotals.reasoning_output}` : "; totals=unavailable"}.`,
    `Execution: processes=${summary.process_count}, retries=${summary.retry_count}, verified_completion_efficiency=${summary.verified_completion_efficiency === null ? "unavailable" : `${(summary.verified_completion_efficiency * 100).toFixed(1)}%`}.`,
    `Cache: hit=${summary.cache.hit}, miss=${summary.cache.miss}, unavailable=${summary.cache.unavailable}.`,
    `Browser: success=${summary.browser.success}, failed=${summary.browser.failed}, unknown=${summary.browser.unknown}, refresh=${summary.browser.refresh_count}, rebind=${summary.browser.rebind_count}, reconnect=${summary.browser.reconnect_count}, recovery=${summary.browser.recovery_count}.`
  ];
}

function safetyData(decision: CommandSafetyDecision): Record<string, unknown> {
  return {
    blocked: decision.blocked,
    category: decision.category,
    command: decision.command,
    commands: decision.commands,
    reason: decision.reason,
    suggestion: decision.suggestion,
    matched_rule: decision.matched_rule,
    test_files: decision.test_files,
    frontend_test_command_count: decision.frontend_test_command_count,
    checks: decision.checks,
    scope: decision.scope
  };
}

function minimalChangeData(
  data: Record<string, unknown>,
  contract: ReturnType<typeof compileMinimalChangeContract>,
  options: RunTaskOptions,
  operations: unknown[] = []
): string[] {
  const normalizedOperations = operations
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      operation: typeof item.operation === "string" ? item.operation : undefined,
      status: typeof item.status === "string" ? item.status : undefined,
      additions: typeof item.additions === "number" ? item.additions : undefined,
      deletions: typeof item.deletions === "number" ? item.deletions : undefined
    }))
    .filter((item) => item.path);
  const footprint = buildChangeFootprint({
    contract,
    operations: normalizedOperations,
    path_reasons: options.path_reasons,
    preserved_boundaries: options.preserved_boundaries,
    unresolved_gaps: options.unresolved_gaps
  });
  const review = reviewMinimalSufficiency(footprint);
  data.minimal_change_contract = contract;
  data.change_footprint = footprint;
  data.minimal_sufficiency_review = review;
  return formatMinimalChangeSummary(contract, footprint, review);
}

function clampLineRange(file: ReadManyFileInput, maxLines: number): { startLine?: number; endLine?: number; lineCapped: boolean } {
  const startLine = Math.max(1, Math.floor(file.start_line ?? 1));
  const requestedEnd = Number.isFinite(file.end_line) ? Math.max(startLine, Math.floor(file.end_line as number)) : undefined;
  const budgetEnd = startLine + maxLines - 1;
  const endLine = Math.min(requestedEnd ?? budgetEnd, budgetEnd);
  return {
    startLine,
    endLine,
    lineCapped: requestedEnd !== undefined && requestedEnd > budgetEnd
  };
}

async function writeRunLog(config: CodexProConfig, guard: PathGuard, workspace: Workspace, id: string, name: string, content: string): Promise<string> {
  const logPath = `.codexpro/runs/${slug(id)}/${slug(name, "log")}`;
  const result = await writeTextFile(config, guard, workspace, logPath, content, { createDirs: true, overwrite: true });
  return result.path;
}

async function withResourceAdmission<T>(
  config: CodexProConfig,
  workspace: Workspace,
  input: {
    requestId: string;
    runId?: string;
    taskId: string;
    title: string;
    commands?: string[];
    hasWrites?: boolean;
    priority?: ResourcePriority;
    pools?: ResourcePoolName[];
    signal?: AbortSignal;
    reason: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  const governor = new ResourceGovernor(config);
  const request = requestForWorkspaceTask(workspace, input);
  try {
    return await governor.runWithLease(request, async () => await fn(), { signal: input.signal });
  } catch (error) {
    if (!isResourceWaitTimeoutError(error)) throw error;
    const blockingReasons = error.details?.blocking_reasons?.length
      ? ` Blocking resources: ${error.details.blocking_reasons.join("; ")}.`
      : "";
    throw new CodexProError(
      `resource_wait_timeout: ${input.title} did not start within ${error.details?.waited_ms ?? config.resourceWaitTimeoutMs} ms.${blockingReasons} ` +
        "Retry after the active holder finishes, or use start_run_task so resource waiting remains visible through task_status."
    );
  }
}

async function archiveBossReport(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: {
    id: string;
    title: string;
    goal?: string | null;
    kind: "task" | "stage";
    data: Record<string, unknown>;
    technicalReportPath?: string;
  }
): Promise<string> {
  const usageSummary = input.data.usage_summary && typeof input.data.usage_summary === "object"
    ? input.data.usage_summary
    : await readUsageSummary(workspace.root, { run_id: input.id });
  const fullReport = buildBossModeReport({
    title: input.title,
    goal: input.goal,
    runId: input.id,
    kind: input.kind,
    data: { ...input.data, usage_summary: usageSummary },
    technicalReportPath: input.technicalReportPath,
    format: "full"
  });
  return await writeRunLog(config, guard, workspace, input.id, "boss-report-full.md", `${fullReport.trimEnd()}\n`);
}

function testImpactStatePath(id: string): string {
  return `.codexpro/runs/${slug(id)}/test-impact-state.json`;
}

async function readTestImpactState(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  id: string
): Promise<TestImpactState | undefined> {
  try {
    const resolved = guard.resolve(workspace, testImpactStatePath(id));
    await guard.assertTextFile(resolved.absPath, 200_000);
    const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as TestImpactState;
    if (parsed?.version !== 1 || typeof parsed.plan_hash !== "string" || !parsed.results || typeof parsed.results !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeTestImpactState(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  id: string,
  state: TestImpactState
): Promise<string> {
  const result = await writeTextFile(
    config,
    guard,
    workspace,
    testImpactStatePath(id),
    `${redactSensitiveText(JSON.stringify(state, null, 2))}\n`,
    { createDirs: true, overwrite: true }
  );
  return result.path;
}

function statusOf(result: BashResult): "passed" | "failed" | "blocked" | "cancelled" {
  if (result.blocked) return "blocked";
  if (result.cancelled) return "cancelled";
  return result.exitCode === 0 ? "passed" : "failed";
}

function validationReasonCode(result: BashResult): string {
  if (result.blocked) return result.category ? `validation_blocked_${result.category}` : "validation_blocked_policy";
  if (result.cancelled) return "validation_cancelled";
  if (result.timedOut) return "validation_timed_out";
  if (result.exitCode !== 0) return "validation_command_failed";
  return "validation_command_passed";
}

function reportPolicy(
  config: CodexProConfig,
  options: RunValidationOptions,
  status: ReportTerminalStatus,
  lane: ExecutionLane = options.execution_lane ?? "standard"
): ReportPolicyDecision {
  return decideReportPolicy({
    lane,
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
}

function bashLog(command: string, result: BashResult): string {
  return [
    `# ${command}`,
    "",
    `cwd: ${result.cwd}`,
    `exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `duration_ms: ${result.durationMs}`,
    `truncated: ${result.truncated}`,
    `cancelled: ${result.cancelled === true}`,
    `timed_out: ${result.timedOut === true}`,
    `tree_terminated: ${result.treeTerminated !== false}`,
    result.blocked ? `blocked: true` : "",
    result.category ? `category: ${result.category}` : "",
    result.reason ? `reason: ${result.reason}` : "",
    result.suggestion ? `suggestion: ${result.suggestion}` : "",
    "",
    "## stdout",
    "",
    "```text",
    result.stdout || "",
    "```",
    "",
    "## stderr",
    "",
    "```text",
    result.stderr || "",
    "```",
    ""
  ].filter((line) => line !== "").join("\n");
}

function bashSummary(command: string, result: BashResult, logPath: string | undefined, outputMode: CompactOutputMode, tailLines: number): string {
  const status = statusOf(result);
  const icon = status === "passed" ? "✅" : status === "blocked" ? "⛔" : status === "cancelled" ? "🛑" : "❌";
  const lines = [`${icon} ${command}`, `status=${status} exit=${result.exitCode}${result.signal ? ` signal=${result.signal}` : ""} duration=${result.durationMs}ms`];
  if (result.blocked) lines.push("blocked=true");
  if (result.category) lines.push(`category=${result.category}`);
  if (result.reason) lines.push(`reason=${result.reason}`);
  if (result.suggestion) lines.push(`suggestion=${result.suggestion}`);
  if (logPath) lines.push(`log=${logPath}`);
  const show = outputMode === "full" || result.exitCode !== 0 || result.blocked || Boolean(result.stderr.trim()) || result.truncated;
  if (show) {
    const out = outputMode === "compact" ? tail(result.stdout || "", tailLines) : result.stdout || "";
    const err = outputMode === "compact" ? tail(result.stderr || "", tailLines) : result.stderr || "";
    if (out.trim()) lines.push("stdout:", "```text", out, "```");
    if (err.trim()) lines.push("stderr:", "```text", err, "```");
  }
  return lines.join("\n");
}

export async function readManyFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  files: ReadManyFileInput[],
  maxCharsPerFile = 12_000,
  overrides: ContextBudgetOverrides = {}
): Promise<CompactResult> {
  const budget = await loadContextBudget(config, guard, workspace, overrides);
  const normalized = (files ?? []).filter((item) => item?.path).slice(0, 50);
  if (!normalized.length) throw new CodexProError("files must contain at least one path.");
  const selected = normalized.slice(0, budget.maxFilesPerTask);
  const skipped = normalized.slice(budget.maxFilesPerTask).map((file) => ({ path: file.path, reason: "max_files_per_task" }));
  const sections = ["# read_many_files", ""];
  appendBudgetHeader(sections, budget);
  const results: Record<string, unknown>[] = [];
  let totalChars = 0;
  let exceeded = skipped.length > 0;

  for (const file of selected) {
    const remainingChars = budget.maxTotalChars - totalChars;
    if (remainingChars <= 0) {
      exceeded = true;
      skipped.push({ path: file.path, reason: "max_total_chars" });
      continue;
    }
    try {
      const range = clampLineRange(file, budget.maxLinesPerFile);
      const result = await readTextFile(config, guard, workspace, file.path, {
        startLine: range.startLine,
        endLine: range.endLine,
        maxBytes: file.max_bytes
      });
      const perFileLimit = Math.max(500, Math.min(maxCharsPerFile, 80_000, remainingChars));
      const text = clip(result.text, perFileLimit);
      totalChars += text.length;
      const lineBudgeted = result.endLine < result.totalLines || range.lineCapped;
      if (lineBudgeted || text !== result.text) exceeded = true;
      sections.push(
        `## ${result.path}`,
        "",
        lineBudgeted ? `[budget] Previewed lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Narrow the range for more detail.` : "",
        "```text",
        text,
        "```"
      );
      results.push({
        path: result.path,
        text,
        start_line: result.startLine,
        end_line: result.endLine,
        total_lines: result.totalLines,
        bytes: result.bytes,
        truncated: result.truncated || lineBudgeted,
        clipped: text !== result.text,
        line_budgeted: lineBudgeted
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sections.push(`## ${file.path}`, "", `[error] ${message}`);
      results.push({ path: file.path, error: message });
    }
  }
  if (skipped.length) sections.push("## Budget skipped files", "", skipped.map((item) => `- ${item.path}: ${item.reason}`).join("\n"));
  if (exceeded) sections.push("", `Advice: ${budgetExceededAdvice("read_many_files", budget)}`);
  return { text: sections.join("\n"), data: { files: results, file_count: results.length, skipped, budget: budgetMetadata(budget), budget_exceeded: exceeded, total_chars: totalChars } };
}

export async function searchProject(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  queries: string[],
  options: {
    path?: string;
    glob?: string;
    include_hidden?: boolean;
    max_results_per_query?: number;
    max_files_per_task?: number;
    max_lines_per_file?: number;
    max_total_chars?: number;
    allow_long_task?: boolean;
    timeout_ms?: number;
    signal?: AbortSignal;
  } = {}
): Promise<CompactResult> {
  const selected = (queries ?? []).map((query) => query.trim()).filter(Boolean);
  if (!selected.length) throw new CodexProError("queries must contain at least one query.");
  const maxQueries = options.allow_long_task
    ? TOOL_LIMITS.search_project.max_long_task_queries
    : MAX_AGGREGATE_SEARCH_QUERIES;
  if (selected.length > maxQueries) {
    throw new SearchOperationError(
      "search_query_limit_exceeded",
      `search_project accepts at most ${maxQueries} queries${options.allow_long_task ? "" : ". Use start_run_task for a long task"}.`
    );
  }
  const budget = await loadContextBudget(config, guard, workspace, budgetOverridesFromOptions(options));
  const maxResults = Math.max(1, Math.min(
    options.max_results_per_query ?? MAX_AGGREGATE_RESULTS_PER_QUERY,
    MAX_AGGREGATE_RESULTS_PER_QUERY,
    budget.maxFilesPerTask * 5
  ));
  const sections = ["# search_project", ""];
  appendBudgetHeader(sections, budget);
  const results: Record<string, unknown>[] = [];
  let totalChars = 0;
  let exceeded = false;
  let searchResult;
  try {
    searchResult = await searchWorkspaceMany(config, guard, workspace, {
      queries: selected,
      regex: false,
      root: options.path,
      glob: options.glob,
      includeHidden: Boolean(options.include_hidden),
      maxResultsPerQuery: maxResults,
      timeoutMs: options.timeout_ms,
      signal: options.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureCode = classifySearchFailure(error);
    for (const query of selected) {
      const remainingChars = Math.max(0, budget.maxTotalChars - totalChars);
      const text = clip(`[error] ${message}`, remainingChars);
      totalChars += text.length;
      sections.push(`## ${query}`, "", text);
      results.push({ query, matches: [], error: message, failed: true, failure_code: failureCode, truncated: false, used: "error", unique_files: 0 });
    }
    return {
      text: sections.join("\n"),
      data: {
        queries: results,
        query_count: results.length,
        status: "partial",
        search_backend: "unavailable",
        duration_ms: 0,
        search_process_count: 0,
        backend_probe_count: 0,
        filesystem_walk_count: 0,
        files_scanned: null,
        files_read: 0,
        bytes_scanned: null,
        degraded_reason: null,
        failure_code: failureCode,
        budget: budgetMetadata(budget),
        budget_exceeded: false,
        total_chars: totalChars
      }
    };
  }

  for (const queryResult of searchResult.queries) {
    const query = queryResult.query;
    const remainingChars = budget.maxTotalChars - totalChars;
    if (remainingChars <= 0) {
      exceeded = true;
      results.push({ query, skipped: true, reason: "max_total_chars" });
      continue;
    }
    const allowedFiles = new Set<string>();
    const boundedMatches: SearchMatch[] = [];
    for (const match of queryResult.matches) {
      if (!allowedFiles.has(match.path) && allowedFiles.size >= budget.maxFilesPerTask) {
        exceeded = true;
        continue;
      }
      allowedFiles.add(match.path);
      boundedMatches.push(match);
    }
    const fallbackText = searchResult.error && !boundedMatches.length ? `[error] ${searchResult.error}` : "No matches.";
    const boundedText = boundedMatches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || fallbackText;
    const text = clip(boundedText, remainingChars);
    totalChars += text.length;
    const truncated = queryResult.truncated || boundedMatches.length < queryResult.matches.length || text !== boundedText;
    if (truncated) exceeded = true;
    sections.push(`## ${query}`, "", "```text", text, "```");
    results.push({
      query,
      matches: boundedMatches,
      truncated,
      used: searchResult.used,
      failure_code: searchResult.failureCode ?? null,
      unique_files: allowedFiles.size
    });
  }
  if (exceeded) sections.push("", `Advice: ${budgetExceededAdvice("search_project", budget)}`);
  const hasUsableMatches = results.some((result) =>
    Array.isArray(result.matches) && result.matches.length > 0
  );
  const repeatSearchRecommended = (exceeded || searchResult.status === "partial") && !hasUsableMatches;
  if (!repeatSearchRecommended) {
    sections.push(
      "",
      exceeded || searchResult.status === "partial"
        ? "Next action: partial results already contain usable paths. Read them with one read_many_files call before considering another search. Search again only if those files reveal a genuinely new identifier."
        : "Next action: read the returned paths with one read_many_files call. Do not search again unless those files reveal a genuinely new identifier."
    );
  }
  return {
    text: sections.join("\n"),
    data: {
      queries: results,
      query_count: results.length,
      status: searchResult.status,
      search_backend: searchResult.used,
      duration_ms: searchResult.diagnostics.durationMs,
      search_process_count: searchResult.diagnostics.searchProcessCount,
      backend_probe_count: searchResult.diagnostics.backendProbeCount,
      filesystem_walk_count: searchResult.diagnostics.filesystemWalkCount,
      files_scanned: searchResult.diagnostics.filesScanned,
      files_read: searchResult.diagnostics.filesRead,
      bytes_scanned: searchResult.diagnostics.bytesScanned,
      degraded_reason: searchResult.degradedReason ?? null,
      failure_code: searchResult.failureCode ?? null,
      efficiency_guidance: {
        batched_query_count: selected.length,
        repeat_search_recommended: repeatSearchRecommended,
        next_tool: repeatSearchRecommended ? "search_project" : "read_many_files"
      },
      budget: budgetMetadata(budget),
      budget_exceeded: exceeded,
      total_chars: totalChars
    }
  };
}

export async function applyPatchBundle(config: CodexProConfig, guard: PathGuard, workspace: Workspace, operations: PatchBundleOperation[]): Promise<CompactResult> {
  const selected = (operations ?? []).slice(0, 50);
  if (!selected.length) throw new CodexProError("operations must contain at least one operation.");
  const totalPayloadBytes = selected.reduce((sum, operation) => sum + Buffer.byteLength(operation.content ?? "") + Buffer.byteLength(operation.old_text ?? "") + Buffer.byteLength(operation.new_text ?? ""), 0);
  if (totalPayloadBytes > config.maxWriteBytes) {
    throw new CodexProError(`Patch bundle payload ${totalPayloadBytes} bytes exceeds the ${config.maxWriteBytes}-byte aggregate write limit.`);
  }
  const preflight = await Promise.all(selected.map(async (operation, index) => {
    const operationId = operation.operation_id?.trim() || `op-${createHash("sha256").update(`${index}\0${operation.operation}\0${operation.path}`).digest("hex").slice(0, 16)}`;
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(operationId)) throw new CodexProError(`operation ${index + 1}: invalid operation_id.`);
    const resolved = guard.resolve(workspace, operation.path);
    let original: Buffer | null = null;
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) throw new CodexProError(`operation ${index + 1}: target is not a regular file.`);
      if (stat.size > config.maxWriteBytes) throw new CodexProError(`operation ${index + 1}: existing file exceeds the write limit.`);
      original = await fsp.readFile(resolved.absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      operation_id: operationId,
      index: index + 1,
      operation: operation.operation,
      path: operation.path,
      target_exists: original !== null,
      original_bytes: original?.length ?? 0,
      original_sha256: original ? createHash("sha256").update(original).digest("hex") : null,
      preflight_status: "passed" as const
    };
  }));
  const patchReservation = enforceGoldTaskPatchLoopBudget(workspace.root, "workspace_mutation", selected);
  try {
    const result = await withResourceAdmission(config, workspace, {
    requestId: `patch-bundle:${stamp()}-${randomUUID().slice(0, 8)}`,
    taskId: `compact-patch-${stamp()}`,
    title: "apply_patch_bundle",
    hasWrites: true,
    priority: "normal",
    reason: "Synchronous patch bundle requires workspace write resource admission."
  }, async () => {
  const sections = ["# apply_patch_bundle", ""];
  const results: Record<string, unknown>[] = [];
  let succeeded = 0;
  let failed = 0;
  let lease: WorkspaceLease = acquireWorkspaceLeaseSync(workspace.root, {
    contextDir: config.contextDir,
    name: "write",
    kind: "mcp-patch-bundle",
    pid: process.pid,
    ttlMs: 30_000
  });

  try {
    for (const [index, op] of selected.entries()) {
      const operationPreflight = preflight[index];
      try {
        lease = heartbeatWorkspaceLeaseSync(workspace.root, lease, { contextDir: config.contextDir, name: "write" });
        if (op.operation === "write") {
          if (op.content === undefined) throw new CodexProError(`operation ${index + 1}: content is required.`);
          const result = await writeTextFile(config, guard, workspace, op.path, op.content, {
            createDirs: op.create_dirs ?? true,
            overwrite: op.overwrite ?? true,
            workspaceLease: lease
          });
          sections.push(`- ✅ write ${result.path} (+${result.diff.additions}/-${result.diff.deletions})`);
          results.push({
            operation_id: operationPreflight.operation_id,
            index: index + 1,
            operation: op.operation,
            path: result.path,
            status: "ok",
            preflight_status: operationPreflight.preflight_status,
            original_sha256: operationPreflight.original_sha256,
            modified_sha256: result.sha256,
            bytes: result.bytes,
            additions: result.diff.additions,
            deletions: result.diff.deletions,
            rollback_data: { method: operationPreflight.target_exists ? "restore_original_content" : "remove_created_file", original_sha256: operationPreflight.original_sha256, original_bytes: operationPreflight.original_bytes }
          });
          succeeded += 1;
          continue;
        }

        if (op.operation === "replace") {
          if (op.old_text === undefined || op.new_text === undefined) throw new CodexProError(`operation ${index + 1}: old_text and new_text are required.`);
          const result = await editTextFile(config, guard, workspace, op.path, op.old_text, op.new_text, {
            replaceAll: op.replace_all,
            expectedReplacements: op.expected_replacements,
            workspaceLease: lease
          });
          sections.push(`- ✅ replace ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}, +${result.diff.additions}/-${result.diff.deletions})`);
          results.push({
            operation_id: operationPreflight.operation_id,
            index: index + 1,
            operation: op.operation,
            path: result.path,
            status: "ok",
            preflight_status: operationPreflight.preflight_status,
            original_sha256: operationPreflight.original_sha256,
            modified_sha256: result.sha256,
            actual_replacements: result.replacements,
            bytes: result.bytes,
            additions: result.diff.additions,
            deletions: result.diff.deletions,
            rollback_data: { method: "restore_original_content", original_sha256: operationPreflight.original_sha256, original_bytes: operationPreflight.original_bytes }
          });
          succeeded += 1;
          continue;
        }

        throw new CodexProError(`operation ${index + 1}: unsupported operation.`);
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        sections.push(`- ❌ ${op.operation} ${op.path} — ${message}`);
        results.push({ operation_id: operationPreflight.operation_id, index: index + 1, operation: op.operation, path: op.path, status: "failed", preflight_status: operationPreflight.preflight_status, original_sha256: operationPreflight.original_sha256, error: message, rollback_data: { method: "manual_from_operation_evidence", original_sha256: operationPreflight.original_sha256, original_bytes: operationPreflight.original_bytes } });
        failed += 1;
      }
    }
  } finally {
    releaseWorkspaceLeaseSync(workspace.root, lease, { contextDir: config.contextDir, name: "write" });
  }

  const status = failed === 0 ? "ok" : succeeded === 0 ? "failed" : "partial";
  let goldTaskProgress: ReturnType<typeof goldTaskProgressSnapshot> | null = null;
  let goldTaskProgressError: string | null = null;
  try {
    goldTaskProgress = goldTaskProgressSnapshot(workspace.root);
  } catch (error) {
    goldTaskProgressError = redactSensitiveText(error instanceof Error ? error.message : String(error));
  }
  sections.push("", `Status: ${status}; succeeded=${succeeded}; failed=${failed}`);
  if (goldTaskProgress?.active) {
    sections.push(
      "",
      "## Gold Task file progress",
      "",
      `Completed expected files: ${goldTaskProgress.completed_file_count}/${goldTaskProgress.expected_changed_paths.length}`,
      `Remaining: ${goldTaskProgress.remaining_expected_paths.join(", ") || "none"}`,
      `Unexpected: ${goldTaskProgress.unexpected_changed_paths.join(", ") || "none"}`,
      "Run the validation bound to this file group before expanding the modification scope."
    );
  }
  return {
    text: sections.join("\n"),
    data: {
      status,
      operations: results,
      operation_count: results.length,
      succeeded_operations: succeeded,
      failed_operations: failed,
      preflight,
      limits: { max_files: 50, max_total_payload_bytes: config.maxWriteBytes, actual_total_payload_bytes: totalPayloadBytes },
      atomicity: { strategy: "preflight_all_then_best_effort_per_operation", automatic_rollback: false, partial_failure_preserves_completed_operations: true },
      ...(goldTaskProgress?.active ? { gold_task_progress: goldTaskProgress } : {}),
      ...(goldTaskProgressError ? { gold_task_progress_error: goldTaskProgressError } : {})
    }
  };
  });
    if (Number(result.data.succeeded_operations ?? 0) === 0) {
      releaseGoldTaskPatchLoopReservation(patchReservation);
    }
    return result;
  } catch (error) {
    releaseGoldTaskPatchLoopReservation(patchReservation, "patch_bundle_aborted");
    throw error;
  }
}

export async function runValidation(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: RunValidationOptions = {}): Promise<CompactResult> {
  const explicitCommands = normalizeCommands(options.commands);
  const impactPlan = explicitCommands.length
    ? undefined
    : planImpactedTests(options.changed_files ?? statusChangedFiles(gitStatus(config, workspace)), { level: options.test_level ?? "targeted" });
  const commands = explicitCommands.length ? explicitCommands : impactPlan?.commands ?? [];
  if (!commands.length) throw new CodexProError("No validation commands were selected.");
  const frozenValidation = enforceGoldTaskFrozenValidation(workspace.root, commands);
  const id = runId(options.run_id, "validation");
  const outputMode = options.output_mode ?? "compact";
  const tailLines = Math.max(20, Math.min(options.tail_lines ?? 80, 400));
  const successPolicy = reportPolicy(config, options, "passed");
  const saveSuccessLogs = successPolicy.save_command_logs;
  const sections = ["# run_validation", "", `run_id: ${id}`, ""];
  if (impactPlan) sections.push("## Test Impact Plan", "", formatTestImpactPlan(impactPlan), "");
  const reusableCommandPlans = options.command_plans?.length === commands.length
    && options.command_plans.every((plan, index) => plan.command === commands[index]?.trim().replace(/\s+/g, " "))
    ? options.command_plans
    : undefined;
  const commandBatchPlan: CommandBatchPlan = reusableCommandPlans
    ? {
        version: 1,
        plans: reusableCommandPlans,
        safety: evaluateCommandBatchSafetyFromPlans(reusableCommandPlans, { scope: "run_validation" })
      }
    : compileCommandBatchPlan(commands, { scope: "run_validation" });
  const commandSafety = commandBatchPlan.safety;
  if (commandSafety.blocked) {
    const blockedPolicy = reportPolicy(config, options, "blocked");
    const reasonCode = commandSafety.matched_rule ?? commandSafety.category ?? "command_safety_policy_blocked";
    const usageSummary = await readUsageSummary(workspace.root, { run_id: id });
    sections.push(
      formatCommandSafetyBlock("command_safety_policy", commandSafety),
      "",
      "## Usage and efficiency",
      "",
      ...usageReportLines(usageSummary),
      "",
      `report_policy=${blockedPolicy.reason_code}`
    );
    const reportPath = blockedPolicy.save_technical_report
      ? await writeRunLog(config, guard, workspace, id, "summary.md", `${sections.join("\n")}\n`)
      : undefined;
    if (reportPath) sections.push(`summary=${reportPath}`);
    return {
      text: sections.join("\n"),
      data: {
        run_id: id,
        status: "blocked",
        reason_code: reasonCode,
        report_path: reportPath,
        report_policy: blockedPolicy,
        usage_summary: usageSummary,
        command_safety: safetyData(commandSafety),
        blocked: true,
        reason: commandSafety.reason,
        suggestion: commandSafety.suggestion,
        commands: commandSafety.checks ?? commands.map((command) => ({ command })),
        ...(frozenValidation.active ? {
          frozen_validation: {
            active: true,
            task_id: frozenValidation.task_id,
            command_count: commands.length,
            policy: "gold_task_session_allowlist"
          }
        } : {}),
        ...(impactPlan ? { test_impact: impactPlan } : {})
      }
    };
  }

  const perCommandTimeoutMs = Math.max(1_000, Math.min(options.timeout_ms ?? 30_000, 300_000));
  const validationDeadlineMs = perCommandTimeoutMs * Math.max(1, commands.length) + 15_000;
  const validationController = new AbortController();
  let externalAbortListener: (() => void) | undefined;
  if (options.signal) {
    externalAbortListener = () => validationController.abort(options.signal?.reason);
    if (options.signal.aborted) externalAbortListener();
    else options.signal.addEventListener("abort", externalAbortListener, { once: true });
  }
  const deadlineTimer = setTimeout(() => {
    const error = new Error(`Validation deadline exceeded after ${validationDeadlineMs} ms.`);
    error.name = "ValidationDeadlineError";
    validationController.abort(error);
  }, validationDeadlineMs);
  deadlineTimer.unref();
  const validationSignal = validationController.signal;

  try {
  return await withResourceAdmission(config, workspace, {
    requestId: `validation:${id}`,
    runId: id,
    taskId: `validation-${id}`,
    title: "run_validation",
    commands,
    hasWrites: false,
    priority: "normal",
    signal: validationSignal,
    reason: "Validation command batch requires resource admission before spawning."
  }, async () => {
  const sectionsWithResults = sections;
  if (saveSuccessLogs) {
    await writeRunLog(config, guard, workspace, id, "startup.md", [
      "# run_validation startup",
      "",
      `run_id: ${id}`,
      `started_at: ${new Date().toISOString()}`,
      `command_count: ${commands.length}`,
      `deadline_ms: ${validationDeadlineMs}`,
      "state: resource_admitted_preparing_command",
      ""
    ].join("\n"));
  }
  const results: Record<string, unknown>[] = [];
  let impactState = impactPlan ? await readTestImpactState(config, guard, workspace, id) : undefined;
  let impactStatePath: string | undefined;
  const reusableNodeIds = new Set(impactPlan ? reusablePassedNodeIds(impactPlan, impactState) : []);
  const stateResults: Record<string, TestImpactResultRecord> = impactState && impactPlan && impactState.plan_hash === impactPlan.plan_hash
    ? { ...impactState.results }
    : {};

  const persistImpactRecord = async (plan: TestImpactPlan, record: TestImpactResultRecord): Promise<void> => {
    stateResults[record.node_id] = record;
    impactState = nextTestImpactState(plan, { version: 1, plan_hash: plan.plan_hash, updated_at: new Date().toISOString(), results: stateResults }, record);
    impactStatePath = await writeTestImpactState(config, guard, workspace, id, impactState);
  };

  const executeImpactNode = async (node: TestImpactNode, index: number): Promise<{
    summary: string;
    data: Record<string, unknown>;
    record?: TestImpactResultRecord;
    failed: boolean;
  }> => {
    const previous = impactState && impactPlan && impactState.plan_hash === impactPlan.plan_hash
      ? impactState.results[node.id]
      : undefined;
    if (reusableNodeIds.has(node.id)) {
      return {
        summary: `\`${node.command}\`：PASS（复用同一计划中已通过的测试；未重复运行）`,
        data: {
          node_id: node.id,
          command: node.command,
          status: "passed",
          reason_code: "validation_test_impact_reused",
          reused: true,
          acceptance_items: node.acceptance_items,
          resource_level: node.resource_level
        },
        failed: false
      };
    }
    if (previous?.status === "failed" && node.resource_level === "cpu-heavy") {
      return {
        summary: `\`${node.command}\`：FAIL（CPU-heavy 测试此前已失败；按策略不自动重跑）`,
        data: {
          node_id: node.id,
          command: node.command,
          status: "failed",
          reason_code: "cpu_heavy_failed_no_automatic_retry",
          skipped: true,
          reason: "cpu_heavy_failed_no_automatic_retry",
          acceptance_items: node.acceptance_items,
          resource_level: node.resource_level
        },
        failed: true
      };
    }
    const result = await runBash(config, guard, workspace, node.command, {
      cwd: options.cwd,
      timeoutMs: options.timeout_ms ?? node.timeout_ms,
      sessionId: options.session_id,
      taskId: `validation-${id}`,
      runId: id,
      stepId: node.id,
      allowTargetedSmokeScript: frozenValidation.allowed_targeted_smoke_commands.includes(node.command.trim().replace(/\s+/g, " ")),
      allowFrozenValidationCommand: frozenValidation.allowed_frozen_commands.includes(node.command.trim().replace(/\s+/g, " ")),
      signal: validationSignal,
      commandPlan: commandBatchPlan.plans.find((plan) => plan.command === node.command.trim().replace(/\s+/g, " "))
    });
    const status = statusOf(result);
    const commandPolicy = reportPolicy(config, options, status);
    const logPath = saveSuccessLogs || (status !== "passed" && commandPolicy.save_command_logs)
      ? await writeRunLog(config, guard, workspace, id, `${String(index + 1).padStart(2, "0")}-${node.id}.log`, bashLog(node.command, result))
      : undefined;
    const record: TestImpactResultRecord = {
      node_id: node.id,
      command: node.command,
      status,
      finished_at: new Date().toISOString(),
      ...(logPath ? { log_path: logPath } : {}),
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      ...(node.flaky === true && status === "failed" ? { flaky_candidate: true } : {})
    };
    return {
      summary: bashSummary(node.command, result, logPath, outputMode, tailLines),
      data: {
        node_id: node.id,
        command: node.command,
        status,
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        truncated: result.truncated,
        log_path: logPath,
        blocked: result.blocked,
        cancelled: result.cancelled,
        timed_out: result.timedOut,
        tree_terminated: result.treeTerminated,
        reason: result.reason,
        suggestion: result.suggestion,
        acceptance_items: node.acceptance_items,
        resource_level: node.resource_level,
        execution: node.execution,
        flaky_candidate: record.flaky_candidate === true
      },
      record,
      failed: result.exitCode !== 0 || result.blocked === true || result.cancelled === true
    };
  };

  if (impactPlan) {
    const nodeById = new Map(impactPlan.nodes.map((node) => [node.id, node]));
    let index = 0;
    let halted = false;
    for (const layer of impactPlan.layers) {
      if (halted) break;
      const nodes = layer.map((nodeId) => nodeById.get(nodeId)).filter((node): node is TestImpactNode => Boolean(node));
      const serialNodes = nodes.filter((node) => node.execution === "serial" || node.resource_level !== "light");
      const parallelNodes = nodes.filter((node) => node.execution === "parallel" && node.resource_level === "light");
      for (const node of serialNodes) {
        const outcome = await executeImpactNode(node, index++);
        sectionsWithResults.push(outcome.summary, "");
        results.push(outcome.data);
        if (outcome.record) await persistImpactRecord(impactPlan, outcome.record);
        if (outcome.failed) {
          halted = true;
          break;
        }
      }
      if (halted || !parallelNodes.length) continue;
      for (let offset = 0; offset < parallelNodes.length; offset += 2) {
        const chunk = parallelNodes.slice(offset, offset + 2);
        const outcomes = await Promise.all(chunk.map((node, chunkIndex) => executeImpactNode(node, index + chunkIndex)));
        index += chunk.length;
        for (const outcome of outcomes) {
          sectionsWithResults.push(outcome.summary, "");
          results.push(outcome.data);
          if (outcome.record) await persistImpactRecord(impactPlan, outcome.record);
        }
        if (outcomes.some((outcome) => outcome.failed)) {
          halted = true;
          break;
        }
      }
    }
  } else {
    for (const [index, command] of commands.entries()) {
      const result = await runBash(config, guard, workspace, command, {
        cwd: options.cwd,
        timeoutMs: options.timeout_ms,
        sessionId: options.session_id,
        taskId: `validation-${id}`,
        runId: id,
        stepId: `command-${index + 1}`,
        allowTargetedSmokeScript: frozenValidation.allowed_targeted_smoke_commands.includes(command.trim().replace(/\s+/g, " ")),
        allowFrozenValidationCommand: frozenValidation.allowed_frozen_commands.includes(command.trim().replace(/\s+/g, " ")),
        signal: validationSignal,
        commandPlan: commandBatchPlan.plans[index]
      });
      const status = statusOf(result);
      const commandPolicy = reportPolicy(config, options, status);
      const logPath = saveSuccessLogs || (status !== "passed" && commandPolicy.save_command_logs)
        ? await writeRunLog(config, guard, workspace, id, `${String(index + 1).padStart(2, "0")}-${command}.log`, bashLog(command, result))
        : undefined;
      sectionsWithResults.push(bashSummary(command, result, logPath, outputMode, tailLines), "");
      results.push({
        command,
        status: statusOf(result),
        reason_code: validationReasonCode(result),
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        truncated: result.truncated,
        log_path: logPath,
        blocked: result.blocked,
        cancelled: result.cancelled,
        timed_out: result.timedOut,
        tree_terminated: result.treeTerminated,
        reason: result.reason,
        suggestion: result.suggestion
      });
      if (result.exitCode !== 0 || result.blocked || result.cancelled) break;
    }
  }
  const blocked = results.some((item) => item.status === "blocked");
  const cancelled = results.some((item) => item.status === "cancelled");
  const failed = results.some((item) => item.status === "failed");
  const status: ReportTerminalStatus = cancelled ? "cancelled" : blocked ? "blocked" : failed ? "failed" : "passed";
  const finalPolicy = reportPolicy(config, options, status);
  const matchedReasonCode = results.find((item) => item.status === status)?.reason_code;
  const reasonCode = status === "passed"
    ? "validation_passed"
    : typeof matchedReasonCode === "string" && matchedReasonCode.trim()
      ? matchedReasonCode
      : `validation_${status}`;
  const usageSummary = await readUsageSummary(workspace.root, { run_id: id });
  sectionsWithResults.push(
    "## Usage and efficiency",
    "",
    ...usageReportLines(usageSummary),
    "",
    `report_policy=${finalPolicy.reason_code}`,
    ""
  );
  const reportPath = finalPolicy.save_technical_report
    ? await writeRunLog(config, guard, workspace, id, "summary.md", `${sectionsWithResults.join("\n")}\n`)
    : undefined;
  if (reportPath) sectionsWithResults.push(`summary=${reportPath}`);
  const completionReady = status === "passed";
  if (completionReady) {
    sectionsWithResults.push(
      "",
      "Completion guidance: verification passed. If show_changes has already been reviewed and the requested scope is complete, answer the user now without another Connector call."
    );
  }
  return {
    text: sectionsWithResults.join("\n"),
    data: {
      run_id: id,
      status,
      reason_code: reasonCode,
      report_path: reportPath,
      report_policy: finalPolicy,
      usage_summary: usageSummary,
      commands: results,
      blocked,
      cancelled,
      completion_ready: completionReady,
      ...(frozenValidation.active ? {
        frozen_validation: {
          active: true,
          task_id: frozenValidation.task_id,
          command_count: commands.length,
          policy: "gold_task_session_allowlist"
        }
      } : {}),
      ...(impactPlan ? {
        test_impact: impactPlan,
        test_impact_state_path: impactStatePath ?? testImpactStatePath(id),
        reused_test_node_ids: [...reusableNodeIds]
      } : {})
    }
  };
  });
  } finally {
    clearTimeout(deadlineTimer);
    if (externalAbortListener) options.signal?.removeEventListener("abort", externalAbortListener);
  }
}

async function runAnalysisOnlyTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: RunTaskOptions,
  title: string,
  id: string
): Promise<CompactResult> {
  const sections = [`# ${title}`, "", `run_id: ${id}`, "", "mode: analysis_only"];
  const reportPolicy = decideReportPolicy({
    lane: "fast",
    status: "passed",
    output_mode: options.output_mode,
    persistence_mode: options.persistence_mode,
    save_full_logs: options.save_full_logs,
    full_logs_on_failure: config.reportFullLogsOnFailure
  });
  const persistSummary = reportPolicy.persistence_mode !== "none";
  const data: Record<string, unknown> = {
    run_id: id,
    title,
    goal: options.goal ?? null,
    mode: "analysis_only",
    status: "passed",
    reason_code: "analysis_only_completed",
    effective_side_effect_level: persistSummary ? "local_state" : "none",
    acceptance_profile: "none",
    report_policy: reportPolicy
  };
  const budgetOverrides = budgetOverridesFromOptions(options);
  await withProcessTrackingSuppressed(async () => {
    if (options.search_queries?.length) {
      const result = await searchProject(config, guard, workspace, options.search_queries, {
        path: options.search_path,
        glob: options.search_glob,
        include_hidden: options.search_include_hidden,
        max_results_per_query: options.max_results_per_query,
        max_files_per_task: options.max_files_per_task,
        max_lines_per_file: options.max_lines_per_file,
        max_total_chars: options.max_total_chars,
        allow_long_task: options.allow_long_task,
        signal: options.signal
      });
      sections.push("", result.text);
      data.search = result.data;
    }
    if (options.read_files?.length) {
      const result = await readManyFiles(config, guard, workspace, options.read_files, options.max_chars_per_file, budgetOverrides);
      sections.push("", result.text);
      data.read = result.data;
    }
  });
  const text = sections.join("\n");
  if (persistSummary) {
    const summaryPath = await writeRunLog(config, guard, workspace, id, "analysis-summary.md", `${text}\n`);
    data.summary_report_path = summaryPath;
  }
  return { text, data };
}

export async function runTask(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: RunTaskOptions = {}): Promise<CompactResult> {
  if (options.active_skill) options = { ...options, active_skill: await assertActiveSkillCurrent(config, options.active_skill) };
  assertAggregateTaskShape(options);
  const title = options.title?.trim() || "CodexPro task";
  const id = runId(options.run_id, title);
  const instruction = options.goal?.trim() || title;
  const explicitScope = [...new Set((options.patches ?? []).map((patch) => patch.path.trim()).filter(Boolean))];
  const skillPolicy = skillExecutionPolicy(options.active_skill);
  assertSkillExecutionPolicy(skillPolicy, options);
  const aggregateMode = classifyAggregateExecutionArgs(options);
  if (aggregateMode.mode === "analysis_only") {
    return await runAnalysisOnlyTask(config, guard, workspace, options, title, id);
  }
  const route = classifyTask(instruction, {
    executionLanesEnabled: config.executionLanesEnabled,
    explicitScope: explicitScope.length ? explicitScope : undefined,
    explicitAllowedPaths: skillPolicy?.allowed_write_paths,
    explicitForbiddenPaths: skillPolicy?.forbidden_write_paths,
    patchesRequested: Boolean(options.patches?.length),
    commandsRequested: Boolean(options.commands?.length)
  });
  const compiledTask = route.compiled_task;
  const executionLane = options.execution_lane ?? route.execution_lane.lane;
  const minimalChangeContract = compileMinimalChangeContract({
    ...compiledTask.minimal_change_contract,
    ...(options.minimal_change_contract ?? {}),
    ...(skillPolicy ? {
      allowed_paths: skillPolicy.allowed_write_paths,
      forbidden_paths: skillPolicy.forbidden_write_paths,
      non_goals: [
        ...(compiledTask.minimal_change_contract.non_goals ?? []),
        "No source-code, package, database, environment, Git metadata, cross-project, network, deployment, deletion, or direct memory writes."
      ]
    } : {}),
    objective: options.minimal_change_contract?.objective ?? compiledTask.minimal_change_contract.objective
  });
  const sections = [`# ${title}`, "", `run_id: ${id}`];
  const data: Record<string, unknown> = {
    run_id: id,
    title,
    goal: options.goal ?? null,
    compiled_task: compiledTask,
    execution_lane: route.execution_lane,
    minimal_change_contract: minimalChangeContract,
    unknown_external_state: options.unknown_external_state === true,
    repair_count: Math.max(0, Math.floor(options.repair_count ?? 0)),
    escalated: options.escalated === true,
    ...(options.active_skill ? { active_skill: options.active_skill } : {})
  };
  if (options.goal?.trim()) sections.push("", "## Goal", "", options.goal.trim());
  if (options.active_skill) {
    sections.push(
      "",
      "## Active Skill",
      "",
      `${options.active_skill.name} @ ${options.active_skill.source_commit}`,
      `Digest: ${options.active_skill.digest}`,
      `Loaded: ${options.active_skill.loaded_at}`
    );
  }

  const requestedCommands = normalizeCommands(options.commands);
  const preparedSkillPlan = skillPolicy && (options.patches?.length || requestedCommands.length)
    ? await prepareNeatFreakTaskPlan(config, guard, workspace, id, skillPolicy, options.active_skill, options.skill_plan, requestedCommands)
    : undefined;
  if (preparedSkillPlan) {
    data.skill_plan = {
      plan_path: preparedSkillPlan.plan_path,
      planned_files: preparedSkillPlan.plan.planned_changes.map((change) => change.path),
      planned_commands: preparedSkillPlan.plan.planned_commands,
      memory_action: preparedSkillPlan.plan.memory_action,
      cleanup_action: preparedSkillPlan.plan.cleanup_action
    };
    sections.push("", "## Skill Plan", "", `Plan: ${preparedSkillPlan.plan_path}`);
  }
  let commandBatchPlan: CommandBatchPlan | undefined;
  if (requestedCommands.length) {
    commandBatchPlan = compileCommandBatchPlan(requestedCommands, { scope: "run_task" });
    const commandSafety = commandBatchPlan.safety;
    if (commandSafety.blocked) {
      const policy = reportPolicy(config, { ...options, execution_lane: executionLane }, "blocked", executionLane);
      sections.push("", formatCommandSafetyBlock("command_safety_policy", commandSafety));
      data.status = "blocked";
      data.blocked = true;
      data.reason_code = commandSafety.matched_rule ?? commandSafety.category ?? "command_safety_policy_blocked";
      data.reason = commandSafety.reason;
      data.suggestion = commandSafety.suggestion;
      data.command_safety = safetyData(commandSafety);
      data.report_policy = policy;
      sections.push("", "## Minimal Change", "", ...minimalChangeData(data, minimalChangeContract, options));
      const technicalText = `${sections.join("\n")}\n`;
      const reportPath = policy.save_technical_report
        ? await writeRunLog(config, guard, workspace, id, "task-report.md", technicalText)
        : undefined;
      if (reportPath) {
        data.report_path = reportPath;
        data.technical_report_path = reportPath;
      }
      const bossReportPath = policy.save_full_boss_report
        ? await archiveBossReport(config, guard, workspace, {
            id,
            title,
            goal: options.goal ?? null,
            kind: "task",
            data,
            technicalReportPath: reportPath
          })
        : undefined;
      if (bossReportPath) data.boss_report_path = bossReportPath;
      if (options.output_mode === "full") {
        if (reportPath) sections.push("", `report=${reportPath}`);
        if (bossReportPath) sections.push(`boss_report=${bossReportPath}`);
        return { text: sections.join("\n"), data };
      }
      return {
        text: buildBossModeReport({
          title,
          goal: options.goal ?? null,
          runId: id,
          kind: "task",
          data,
          technicalReportPath: reportPath,
          format: "compact"
        }),
        data
      };
    }
  }

  const budgetOverrides = budgetOverridesFromOptions(options);
  let patchOperations: unknown[] = [];
  if (options.search_queries?.length) {
    const result = await searchProject(config, guard, workspace, options.search_queries, {
      path: options.search_path,
      glob: options.search_glob,
      include_hidden: options.search_include_hidden,
      max_results_per_query: options.max_results_per_query,
      max_files_per_task: options.max_files_per_task,
      max_lines_per_file: options.max_lines_per_file,
      max_total_chars: options.max_total_chars,
      allow_long_task: options.allow_long_task,
      signal: options.signal
    });
    sections.push("", result.text);
    data.search = compactSearchData(result.data);
  }
  if (options.read_files?.length) {
    const result = await readManyFiles(config, guard, workspace, options.read_files, options.max_chars_per_file, budgetOverrides);
    sections.push("", result.text);
    data.read = compactReadData(result.data);
  }
  if (options.patches?.length) {
    const result = await applyPatchBundle(config, guard, workspace, options.patches);
    sections.push("", result.text);
    data.patches = result.data;
    patchOperations = Array.isArray(result.data.operations) ? result.data.operations : [];
  }
  if (options.commands?.length) {
    const result = await runValidation(config, guard, workspace, {
      ...options,
      run_id: id,
      execution_lane: executionLane,
      command_plans: commandBatchPlan?.plans
    });
    sections.push("", result.text);
    data.validation = result.data;
    if (result.data.blocked) {
      data.status = "blocked";
      data.blocked = true;
      data.reason = result.data.reason;
      data.suggestion = result.data.suggestion;
    }
  }
  const skillPlanComparison = preparedSkillPlan
    ? await compareNeatFreakTaskPlan(config, guard, workspace, id, preparedSkillPlan, patchOperations)
    : undefined;
  if (skillPlanComparison) {
    data.skill_plan_comparison = skillPlanComparison;
    data.unexpected_files = skillPlanComparison.unexpected_files;
    sections.push(
      "",
      "## Skill Plan Comparison",
      "",
      `Status: ${skillPlanComparison.status}`,
      `Reason: ${skillPlanComparison.reason}`,
      `Planned files: ${skillPlanComparison.planned_files.join(", ") || "none"}`,
      `Changed files: ${skillPlanComparison.changed_files.join(", ") || "none"}`,
      `Unexpected files: ${skillPlanComparison.unexpected_files.join(", ") || "none"}`,
      `Missing files: ${skillPlanComparison.missing_files.join(", ") || "none"}`,
      `Deleted files: ${skillPlanComparison.deleted_files.join(", ") || "none"}`,
      `Symlink escapes: ${skillPlanComparison.symlink_escape_files.join(", ") || "none"}`,
      `Comparison: ${skillPlanComparison.comparison_path}`
    );
  }
  sections.push("", "## Minimal Change", "", ...minimalChangeData(data, minimalChangeContract, options, patchOperations));
  const patchData = data.patches && typeof data.patches === "object" && !Array.isArray(data.patches)
    ? data.patches as Record<string, unknown>
    : undefined;
  const validationData = data.validation && typeof data.validation === "object" && !Array.isArray(data.validation)
    ? data.validation as Record<string, unknown>
    : undefined;
  const validationStatus = typeof validationData?.status === "string" ? validationData.status : undefined;
  const patchStatus = typeof patchData?.status === "string" ? patchData.status : undefined;
  const skillPlanFailed = skillPlanComparison?.status === "failed";
  const taskStatus: ReportTerminalStatus = data.blocked === true || validationStatus === "blocked"
    ? "blocked"
    : validationStatus === "cancelled"
      ? "cancelled"
      : validationStatus === "failed" || patchStatus === "failed" || patchStatus === "partial" || skillPlanFailed
        ? "failed"
        : "passed";
  const policy = reportPolicy(config, { ...options, execution_lane: executionLane }, taskStatus, executionLane);
  data.status = taskStatus;
  data.reason_code = taskStatus === "passed"
    ? "task_completed"
    : skillPlanFailed
      ? skillPlanComparison?.reason ?? "skill_plan_mismatch"
      : typeof validationData?.reason_code === "string"
      ? validationData.reason_code
      : patchStatus === "partial"
        ? "task_patch_partial"
        : patchStatus === "failed"
          ? "task_patch_failed"
          : `task_${taskStatus}`;
  data.report_policy = policy;
  const technicalText = `${sections.join("\n")}\n`;
  const reportPath = policy.save_technical_report
    ? await writeRunLog(config, guard, workspace, id, "task-report.md", technicalText)
    : undefined;
  if (reportPath) {
    data.report_path = reportPath;
    data.technical_report_path = reportPath;
  }
  const bossReportPath = policy.save_full_boss_report
    ? await archiveBossReport(config, guard, workspace, {
        id,
        title,
        goal: options.goal ?? null,
        kind: "task",
        data,
        technicalReportPath: reportPath
      })
    : undefined;
  if (bossReportPath) data.boss_report_path = bossReportPath;

  if (options.output_mode === "full") {
    if (reportPath) sections.push("", `report=${reportPath}`);
    if (bossReportPath) sections.push(`boss_report=${bossReportPath}`);
    return { text: sections.join("\n"), data };
  }

  const text = buildBossModeReport({
    title,
    goal: options.goal ?? null,
    runId: id,
    kind: "task",
    data,
    technicalReportPath: reportPath,
    format: "compact"
  });
  return { text, data };
}

export async function runStage(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: RunTaskOptions = {}): Promise<CompactResult> {
  const title = options.title ?? "CodexPro stage";
  const result = await runTask(config, guard, workspace, { ...options, title });
  if (result.data.mode === "analysis_only" || options.output_mode === "full") return result;
  return {
    ...result,
    text: buildBossModeReport({
      title,
      goal: options.goal ?? null,
      runId: typeof result.data.run_id === "string" ? result.data.run_id : undefined,
      kind: "stage",
      data: result.data,
      technicalReportPath: typeof result.data.report_path === "string" ? result.data.report_path : undefined
    })
  };
}
