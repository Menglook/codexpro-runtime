import type { CodexProConfig } from "../config.js";
import { type PathGuard, type Workspace, CodexProError } from "../guard.js";
import { writeTextFile } from "../fsOps.js";
import { runTask, runValidation, type CompactOutputMode, type PatchBundleOperation, type ReadManyFileInput } from "../compactExecution.js";
import { formatRuleSummary, buildRuleSummary } from "../project/ruleSummary.js";
import { readTaskTemplateConfig, type TaskTemplateDefinition } from "../project/taskTemplatesConfig.js";
import { runAcceptance } from "./acceptanceEngine.js";
import { buildBossModeReport } from "./bossReport.js";
import { buildGitPrepare } from "./gitWorkflow.js";
import { decideReportPolicy, type ReportPersistenceMode } from "./reportPolicy.js";
import { classifyTask } from "./taskRouter.js";
import { finishTaskSnapshot, startTaskSnapshot } from "./taskSnapshot.js";

export interface RunTaskTemplateOptions {
  template?: string;
  task?: string;
  title?: string;
  goal?: string;
  search_queries?: string[];
  read_files?: ReadManyFileInput[];
  patches?: PatchBundleOperation[];
  commands?: string[];
  acceptance_profile?: string;
  dry_run?: boolean;
  run_id?: string;
  output_mode?: CompactOutputMode;
  tail_lines?: number;
  save_full_logs?: boolean;
  persistence_mode?: ReportPersistenceMode;
  debug?: boolean;
  max_files_per_task?: number;
  max_lines_per_file?: number;
  max_total_chars?: number;
}

export interface RunTaskTemplateResult {
  template: string;
  task: string;
  status: "passed" | "failed" | "planned";
  report_path: string;
  snapshot_id?: string;
  text: string;
  data: Record<string, unknown>;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase();
}

function slug(value: string, fallback = "task-template"): string {
  const out = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return out || fallback;
}

function runId(input: string | undefined, templateName: string): string {
  return input?.trim() ? slug(input) : `${stamp()}-${slug(templateName)}`;
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function templateSteps(template: TaskTemplateDefinition): string[] {
  return unique(template.steps?.length ? template.steps : ["read_rules", "start_snapshot", "acceptance", "finish_snapshot", "git_prepare"]);
}

function hasStep(steps: string[], ...names: string[]): boolean {
  const normalized = new Set(steps.map((step) => step.toLowerCase().replace(/[\s-]+/g, "_")));
  return names.some((name) => normalized.has(name.toLowerCase().replace(/[\s-]+/g, "_")));
}

function mergeReadFiles(...groups: Array<ReadManyFileInput[] | undefined>): ReadManyFileInput[] {
  const out: ReadManyFileInput[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const file of group ?? []) {
      if (!file.path?.trim()) continue;
      const key = `${file.path}:${file.start_line ?? ""}:${file.end_line ?? ""}:${file.max_bytes ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

function mergePatches(...groups: Array<PatchBundleOperation[] | undefined>): PatchBundleOperation[] {
  return groups.flatMap((group) => group ?? []);
}

function commandStatus(data: unknown): "passed" | "failed" | "unknown" {
  if (!data || typeof data !== "object") return "unknown";
  const obj = data as Record<string, unknown>;
  if (obj.status === "passed") return "passed";
  if (obj.status === "failed") return "failed";
  return "unknown";
}

function formatCommandList(commands: string[]): string {
  return commands.length ? commands.map((command) => `- \`${command}\``).join("\n") : "- none";
}

async function writeReport(config: CodexProConfig, guard: PathGuard, workspace: Workspace, id: string, content: string): Promise<string> {
  const relPath = `.codexpro/runs/${slug(id)}/task-template-report.md`;
  const result = await writeTextFile(config, guard, workspace, relPath, content.endsWith("\n") ? content : `${content}\n`, { createDirs: true, overwrite: true });
  return result.path;
}

export async function runTaskTemplate(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: RunTaskTemplateOptions = {}
): Promise<RunTaskTemplateResult> {
  const load = await readTaskTemplateConfig(config, guard, workspace);
  const requested = (options.template ?? load.config.default_template ?? "bugfix").trim();
  const template = load.config.templates[requested];
  if (!template) {
    const available = Object.keys(load.config.templates).sort().join(", ");
    throw new CodexProError(`Task template not found: ${requested}. Available templates: ${available}`);
  }

  const id = runId(options.run_id, requested);
  const taskName = options.task?.trim() || options.title?.trim() || `${requested} task`;
  const title = options.title?.trim() || `Task Template: ${requested}`;
  const goal = options.goal?.trim() || options.task?.trim() || template.description || `Run ${requested} task template.`;
  const templateCommands = template.commands ?? [];
  const extraCommands = options.commands ?? [];
  const commands = unique([...templateCommands, ...extraCommands]);
  const readFiles = mergeReadFiles(template.read_files, options.read_files);
  const patches = mergePatches(template.patches, options.patches);
  const searchQueries = unique([...(template.search_queries ?? []), ...(options.search_queries ?? [])]);
  const explicitScope = [...new Set(patches.map((patch) => patch.path.trim()).filter(Boolean))];
  const route = classifyTask(goal, {
    executionLanesEnabled: config.executionLanesEnabled,
    explicitScope: explicitScope.length ? explicitScope : undefined,
    patchesRequested: patches.length > 0,
    commandsRequested: commands.length > 0
  });
  const executionLane = route.execution_lane.lane;
  const steps = templateSteps(template);
  const dryRun = Boolean(options.dry_run);
  const sections = [
    `# ${title}`,
    "",
    `run_id: ${id}`,
    `template: ${requested}`,
    `task: ${taskName}`,
    `dry_run: ${dryRun ? "yes" : "no"}`,
    `tasks_config: ${load.path} (${load.existed ? "custom file loaded" : "built-ins only"})`,
    "",
    "## Goal",
    "",
    goal,
    "",
    "## Template steps",
    "",
    steps.map((step) => `- ${step}`).join("\n")
  ];
  const data: Record<string, unknown> = {
    run_id: id,
    template: requested,
    task: taskName,
    dry_run: dryRun,
    tasks_config: { path: load.path, existed: load.existed, custom_templates: load.custom_templates },
    execution_lane: route.execution_lane,
    steps
  };

  const includeRules = template.include_rules ?? hasStep(steps, "read_rules", "rules", "preflight_rules");
  if (includeRules) {
    const ruleSummary = await buildRuleSummary(config, guard, workspace, { maxRules: 80, maxMemoryFileBytes: 20_000 });
    data.rule_summary = {
      files: ruleSummary.files,
      warning_count: ruleSummary.warnings.length,
      rule_count: ruleSummary.preflight_rules.length,
      truncated: ruleSummary.truncated
    };
    sections.push("", "## read_rules", "", formatRuleSummary(ruleSummary));
  }

  let snapshotId: string | undefined;
  const shouldStartSnapshot = template.start_snapshot ?? hasStep(steps, "start_snapshot", "snapshot");
  if (shouldStartSnapshot) {
    if (dryRun) {
      sections.push("", "## start_snapshot", "", "Skipped in dry-run mode.");
    } else {
      const started = await startTaskSnapshot(config, guard, workspace, { taskName, notes: `run_task_template ${requested}: ${goal}` });
      snapshotId = started.snapshot_id;
      data.start_snapshot = { snapshot_id: started.snapshot_id, snapshot_dir: started.snapshot_dir, files: started.files };
      sections.push("", "## start_snapshot", "", started.text);
    }
  }

  const hasImplementationStep = hasStep(steps, "fix", "implement", "debug", "patch");
  if (template.browser_before_after ?? hasStep(steps, "browser_before", "browser_after")) {
    data.browser_before_after = true;
    sections.push("", "## browser before/after", "", "Browser visual regression is included automatically via `npm run browser-visual-regression`. Configure `.codexpro/project.yml` `browser.visual_pairs` or `browser.smoke_urls` for concrete targets.");
  }
  if (hasImplementationStep && !patches.length) {
    sections.push("", "## implementation", "", "No patches were supplied to `run_task_template`; use normal CodexPro edit/write tools or pass `patches` to this tool for the implementation step.");
  }

  const executablePatches = dryRun ? [] : patches;
  const executableCommands = dryRun ? [] : commands;
  const shouldRunCompactTask = searchQueries.length > 0 || readFiles.length > 0 || executablePatches.length > 0;
  if (shouldRunCompactTask) {
    const taskResult = await runTask(config, guard, workspace, {
      title: `${title} execution`,
      goal,
      search_queries: searchQueries,
      read_files: readFiles,
      patches: executablePatches,
      commands: [],
      run_id: `${id}-execution`,
      output_mode: options.output_mode,
      tail_lines: options.tail_lines,
      persistence_mode: options.persistence_mode,
      save_full_logs: options.save_full_logs,
      execution_lane: executionLane,
      debug: options.debug,
      max_files_per_task: options.max_files_per_task,
      max_lines_per_file: options.max_lines_per_file,
      max_total_chars: options.max_total_chars
    });
    data.execution = taskResult.data;
    sections.push("", "## run_task", "", taskResult.text);
  } else {
    sections.push("", "## run_task", "", dryRun ? "Skipped search/read/patch execution in dry-run mode." : "No search/read/patch inputs were defined for this template run.");
  }

  if (executableCommands.length > 0) {
    const validationResult = await runValidation(config, guard, workspace, {
      commands: executableCommands,
      run_id: `${id}-validation`,
      output_mode: options.output_mode,
      tail_lines: options.tail_lines,
      persistence_mode: options.persistence_mode,
      save_full_logs: options.save_full_logs,
      execution_lane: executionLane
    });
    data.validation = validationResult.data;
    sections.push("", "## run_validation", "", validationResult.text);
  } else if (dryRun && commands.length > 0) {
    sections.push("", "## run_validation", "", "Dry run: would execute the template validation commands separately from search/read/patch work.", "", formatCommandList(commands));
  }

  const shouldRunAcceptance = hasStep(steps, "acceptance", "run_acceptance");
  if (shouldRunAcceptance) {
    if (dryRun) {
      sections.push("", "## acceptance", "", `Dry run: would run acceptance profile \`${options.acceptance_profile ?? template.acceptance_profile ?? "default"}\`.`);
      data.acceptance = { skipped: true, reason: "dry_run", profile: options.acceptance_profile ?? template.acceptance_profile ?? "default" };
    } else {
      const profile = options.acceptance_profile ?? template.acceptance_profile;
      const acceptance = await runAcceptance(config, guard, workspace, { profile });
      data.acceptance = {
        requested_profile: acceptance.requested_profile,
        profile: acceptance.profile,
        selection_reason: acceptance.selection_reason,
        changed_files: acceptance.changed_files,
        ignored_changed_files: acceptance.ignored_changed_files,
        ok: acceptance.ok,
        report_path: acceptance.report_path,
        commands: acceptance.commands,
        skipped_commands: acceptance.skipped_commands
      };
      sections.push(
        "",
        "## acceptance",
        "",
        `Requested profile: ${acceptance.requested_profile}`,
        `Effective profile: ${acceptance.profile}`,
        `Selection reason: ${acceptance.selection_reason}`,
        `Result: ${acceptance.ok ? "PASS" : "FAIL"}`,
        `Report: ${acceptance.report_path}`
      );
    }
  }

  const shouldFinishSnapshot = Boolean(snapshotId) && (template.finish_snapshot ?? hasStep(steps, "finish_snapshot", "snapshot"));
  if (shouldFinishSnapshot && snapshotId) {
    const finished = await finishTaskSnapshot(config, guard, workspace, { snapshotId, notes: `run_task_template ${requested} finished.` });
    data.finish_snapshot = { snapshot_id: finished.snapshot_id, snapshot_dir: finished.snapshot_dir, files: finished.files };
    sections.push("", "## finish_snapshot", "", finished.text);
  } else if ((template.finish_snapshot ?? hasStep(steps, "finish_snapshot", "snapshot")) && dryRun) {
    sections.push("", "## finish_snapshot", "", "Skipped in dry-run mode.");
  }

  const validationStatus = commandStatus(data.validation);
  const acceptanceOk = (data.acceptance as Record<string, unknown> | undefined)?.ok;
  const shouldGitPrepare = template.commit_assistant ?? hasStep(steps, "git_prepare", "commit_assistant", "commit");
  if (shouldGitPrepare) {
    if (dryRun) {
      sections.push("", "## git_prepare", "", "Dry run: would prepare approval-gated Git commands after validation.");
      data.git_prepare = { skipped: true, reason: "dry_run" };
    } else {
      const effectiveValidation = acceptanceOk === false || validationStatus === "failed"
        ? "fail"
        : acceptanceOk === true
          ? "pass"
          : validationStatus === "passed"
            ? "pass"
            : "unknown";
      const prepared = buildGitPrepare(config, guard, workspace, {
        includeUntracked: true,
        validationStatus: effectiveValidation,
        validationSummary: `template=${requested}; validation=${validationStatus}; acceptance=${String(acceptanceOk ?? "unknown")}`,
        userIntent: goal,
        includePush: true
      });
      data.git_prepare = {
        changed_files: prepared.changed_files,
        recommended_files: prepared.recommended_files,
        risk_files: prepared.risk_files,
        suggested_commands: prepared.suggested_commands,
        commit_flow_allowed: prepared.commit_flow_allowed,
        commit_flow_blockers: prepared.commit_flow_blockers,
        validation_status: prepared.validation_status,
        explicit_user_approval: prepared.explicit_user_approval
      };
      sections.push("", "## git_prepare", "", prepared.text);
    }
  }

  const executionData = data.execution && typeof data.execution === "object" && !Array.isArray(data.execution)
    ? data.execution as Record<string, unknown>
    : undefined;
  const executionStatus = typeof executionData?.status === "string" ? executionData.status : undefined;
  const failed = validationStatus === "failed" || acceptanceOk === false || executionStatus === "failed" || executionStatus === "blocked" || executionStatus === "cancelled";
  const status: "passed" | "failed" | "planned" = dryRun ? "planned" : failed ? "failed" : "passed";
  const policy = decideReportPolicy({
    lane: executionLane,
    status,
    output_mode: dryRun ? "full" : options.output_mode,
    persistence_mode: options.persistence_mode,
    save_full_logs: options.save_full_logs,
    debug: options.debug,
    lane_based_enabled: config.reportPolicyLaneBased,
    full_logs_on_failure: config.reportFullLogsOnFailure
  });
  data.status = status;
  data.reason_code = status === "planned"
    ? "task_template_planned"
    : status === "passed"
      ? "task_template_completed"
      : acceptanceOk === false
        ? "task_template_acceptance_failed"
        : typeof executionData?.reason_code === "string"
          ? executionData.reason_code
          : "task_template_failed";
  data.report_policy = policy;
  sections.push("", "## Summary", "", `Status: ${status}`, `Report policy: ${policy.reason_code}`, "", "Commands:", formatCommandList(commands));
  const bossData: Record<string, unknown> = {
    ...data,
    ...(executionData ?? {}),
    execution_lane: route.execution_lane,
    report_policy: policy,
    status,
    reason_code: data.reason_code,
    ...(data.acceptance && typeof data.acceptance === "object" ? { validation_result: data.acceptance } : {})
  };
  const compactText = buildBossModeReport({
    title,
    goal,
    runId: id,
    kind: "template",
    data: bossData,
    format: "compact"
  });
  const reportContent = dryRun || policy.archive_mode === "full" ? sections.join("\n") : compactText;
  const reportPath = await writeReport(config, guard, workspace, id, reportContent);
  data.report_path = reportPath;

  const text = dryRun || options.output_mode === "full"
    ? [...sections, "", `report=${reportPath}`].join("\n")
    : `${compactText.trimEnd()}\n\nreport=${reportPath}`;
  return {
    template: requested,
    task: taskName,
    status,
    report_path: reportPath,
    ...(snapshotId ? { snapshot_id: snapshotId } : {}),
    text,
    data
  };
}
