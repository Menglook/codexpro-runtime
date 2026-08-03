import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { codexProEventBus } from "./events/eventBus.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard, normalizeRelPath } from "./guard.js";
import { listFiles, readTextFile, repoTree, writeTextFile, ensureAiBridge } from "./fsOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext } from "./workspaceOps.js";
import { redactSensitiveText } from "./redact.js";
import { budgetExceededAdvice, loadContextBudget, type ContextBudgetOverrides, type ResolvedContextBudget } from "./contextBudget.js";
import { fileContextNode, formatContextPlan, planContext, type ContextNode, type ContextPlannerDecision } from "./workflow/contextPlanner.js";
import { resolveContextProfile, type ContextProfile } from "./workflow/contextProfiles.js";
import { decideExecutionLane, type ExecutionLane } from "./workflow/executionLane.js";
import { compileTask, type CompiledTask } from "./workflow/taskCompiler.js";
import { queryGovernedMemory } from "./project/memoryGovernance.js";

export interface ProContextOptions {
  title?: string;
  taskInstruction?: string;
  previousTopic?: string;
  snapshotId?: string;
  selectedPaths?: string[];
  extraGlobs?: string[];
  includeImportantFiles?: boolean;
  includeChangedFiles?: boolean;
  includeDiff?: boolean;
  includeAiBridge?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxDiffBytes?: number;
  maxTotalBytes?: number;
  maxFilesPerTask?: number;
  maxLinesPerFile?: number;
  maxTotalChars?: number;
  executionLane?: ExecutionLane;
}

export interface ProContextUsage {
  context_profile: ExecutionLane;
  context_files_count: number;
  context_lines_count: number;
  context_total_chars: number;
  context_expansion_count: number;
  context_budget_exceeded: boolean;
  context_missing_reasons: string[];
}

export interface ProContextResult {
  path?: string;
  contextPlanPath?: string;
  markdown: string;
  bytes: number;
  filesIncluded: string[];
  filesSkipped: string[];
  truncated: boolean;
  budget: ResolvedContextBudget;
  contextProfile: ContextProfile;
  contextUsage: ProContextUsage;
  budgetExceeded: boolean;
  contextPlan: ContextPlannerDecision;
}

const IMPORTANT_ROOT_FILES = [
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "svelte.config.js",
  "astro.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "eslint.config.js",
  ".eslintrc.json",
  "biome.json",
  "turbo.json",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod"
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeRelPath(value).replace(/^\.\//, "")).filter(Boolean))];
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`,
    truncated: true
  };
}

function contextBudgetOverrides(options: ProContextOptions): ContextBudgetOverrides {
  return {
    maxFilesPerTask: options.maxFilesPerTask,
    maxLinesPerFile: options.maxLinesPerFile,
    maxTotalChars: options.maxTotalChars
  };
}

function budgetBlock(budget: ResolvedContextBudget, profile: ContextProfile): string {
  return [
    `Profile: ${profile.name}`,
    `Profile reason: ${profile.reason_code}`,
    `Source: ${budget.source}`,
    `max_files_per_task: ${budget.maxFilesPerTask}`,
    `max_lines_per_file: ${budget.maxLinesPerFile}`,
    `max_total_chars: ${budget.maxTotalChars}`
  ].join("\n");
}

function isRouteRelatedPath(relPath: string): boolean {
  return /(^|\/)(app|pages|routes|router|api)(\/|\.)/i.test(relPath) || /(^|\/)(route|router|controller|endpoint)s?\.[tj]sx?$/i.test(relPath);
}

function parseChangedFiles(status: string): string[] {
  const files: string[] = [];
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("##") || line.startsWith("git unavailable") || line.startsWith("fatal:")) continue;
    if (line.length < 4) continue;
    let rel = line.slice(3).trim();
    if (!rel) continue;
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop() ?? rel;
    if (rel.startsWith("\"") && rel.endsWith("\"")) rel = rel.slice(1, -1);
    files.push(rel);
  }
  return unique(files);
}

function languageForPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".toml") return "toml";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return "text";
}

function isLikelyImportantConfig(relPath: string): boolean {
  const basename = path.basename(relPath);
  return IMPORTANT_ROOT_FILES.includes(relPath) || IMPORTANT_ROOT_FILES.includes(basename);
}

function contextSourceForPath(relPath: string, selected: Set<string>, changed: Set<string>, planPath: string): "user" | "rule" | "plan" | "diff" | "test" | "file" {
  if (selected.has(relPath)) return "user";
  if (changed.has(relPath)) return "diff";
  if (relPath === planPath || relPath.startsWith("planning-local/")) return "plan";
  if (relPath === "AGENTS.md" || relPath === "CLAUDE.md" || /(^|\/)(rules?|instructions?)\.(md|txt|ya?ml)$/i.test(relPath)) return "rule";
  if (/(^|\/)(tests?|__tests__)(\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(relPath)) return "test";
  return "file";
}

async function existingImportantFiles(guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const found: string[] = [];
  for (const rel of IMPORTANT_ROOT_FILES) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (fs.existsSync(resolved.absPath) && fs.statSync(resolved.absPath).isFile()) found.push(resolved.relPath);
    } catch {
      // Ignore blocked or missing optional config files.
    }
  }
  return unique(found);
}

async function filesForGlobs(
  guard: PathGuard,
  workspace: Workspace,
  globs: string[],
  maxFiles: number
): Promise<string[]> {
  const out: string[] = [];
  for (const glob of globs) {
    if (out.length >= maxFiles) break;
    const matches = await listFiles(guard, workspace, {
      root: ".",
      glob,
      includeHidden: /(^|\/)\./.test(glob),
      maxFiles: Math.max(1, maxFiles - out.length)
    });
    out.push(...matches);
  }
  return unique(out).slice(0, maxFiles);
}

function memoryScopeForTask(task: CompiledTask): string {
  if (task.browser_required) return "browser_validation";
  if (task.capabilities.use_git) return "git";
  if (task.capabilities.read_database) return "database";
  if (task.source_write_policy === "none") return "read_only";
  return "code_change";
}

async function planProContextFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: {
    title: string;
    taskInstruction?: string;
    previousTopic?: string;
    contextDir: string;
    includeAiBridge: boolean;
    selectedPaths: string[];
    changedFiles: string[];
    extraGlobFiles: string[];
    importantFiles: string[];
    maxFiles: number;
    maxTotalBytes: number;
    compiledTask: CompiledTask;
  }
) {
  const selected = new Set(input.selectedPaths);
  const changed = new Set(input.changedFiles);
  const planPath = `${input.contextDir}/current-plan.md`;
  let includePlanPath = false;
  if (input.includeAiBridge) {
    try {
      const resolved = guard.resolve(workspace, planPath);
      includePlanPath = fs.existsSync(resolved.absPath) && fs.statSync(resolved.absPath).isFile();
    } catch {
      includePlanPath = false;
    }
  }
  const candidatePaths = unique([
    ...input.selectedPaths,
    ...input.changedFiles,
    ...input.extraGlobFiles,
    ...input.importantFiles,
    ...(includePlanPath ? [planPath] : [])
  ]).filter((relPath) => relPath !== `${input.contextDir}/pro-context.md`);
  const compiledTask = input.compiledTask;
  const governedMemory = await queryGovernedMemory(config, guard, workspace, {
    scope: memoryScopeForTask(compiledTask),
    query: compiledTask.intent,
    max_entries: Math.min(20, input.maxFiles)
  });
  const nodes: ContextNode[] = governedMemory.active_entries.map((entry) => ({
    id: `memory:${entry.id}`,
    source: "memory",
    relevance: entry.relevance,
    confidence: entry.confidence,
    freshness: entry.accepted_at,
    token_cost: Math.max(24, Math.ceil(entry.statement.length / 4) + 12),
    required: false,
    summary: entry.statement,
    tags: [...entry.scope, ...entry.tags, entry.source]
  }));
  for (const relPath of candidatePaths) {
    let bytes = 4_000;
    let freshness: string | undefined;
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) continue;
      bytes = stat.size;
      freshness = stat.mtime.toISOString();
    } catch {
      // Keep missing explicit paths visible so the planner can report uncovered context.
    }
    const source = contextSourceForPath(relPath, selected, changed, planPath);
    nodes.push(fileContextNode(relPath, {
      source,
      required: selected.has(relPath) || source === "rule",
      relevance: selected.has(relPath)
        ? 1
        : changed.has(relPath)
          ? 0.94
          : isRouteRelatedPath(relPath)
            ? 0.82
            : isLikelyImportantConfig(relPath)
              ? 0.74
              : 0.5,
      confidence: 0.95,
      freshness,
      bytes,
      summary: `${source} context from ${relPath}`,
      tags: [
        ...(selected.has(relPath) ? ["explicit-scope"] : []),
        ...(changed.has(relPath) ? ["changed-file"] : []),
        ...(isRouteRelatedPath(relPath) ? ["entry-or-route"] : []),
        ...(isLikelyImportantConfig(relPath) ? ["project-config"] : [])
      ]
    }));
  }
  const contextPlan = planContext(compiledTask, nodes, {
    max_nodes: input.maxFiles,
    max_token_cost: Math.max(100, Math.floor(input.maxTotalBytes / 4)),
    previous_topic: input.previousTopic
  });
  return {
    candidatePaths,
    contextPlan,
    governedMemory,
    selectedMemoryNodes: [...contextPlan.selected, ...contextPlan.summarized].filter((node) => node.source === "memory"),
    fullPaths: contextPlan.selected.map((node) => node.path).filter((value): value is string => Boolean(value)),
    summarizedNodes: contextPlan.summarized.filter((node) => Boolean(node.path))
  };
}

function appendSection(parts: string[], heading: string, body: string): void {
  parts.push(`## ${heading}\n\n${body.trimEnd()}`);
}

export async function buildProContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProContextOptions = {}
): Promise<ProContextResult> {
  const title = options.title?.trim() || "CodexPro Context Bundle";
  const compiledTask = compileTask(options.taskInstruction?.trim() || title, { explicitScope: options.selectedPaths });
  const inferredRouteMode = compiledTask.browser_required
    ? "browser_validation"
    : compiledTask.source_write_policy === "workspace"
      ? "large_stage"
      : compiledTask.source_write_policy === "scoped"
        ? "code_patch"
        : compiledTask.capabilities.write_artifacts
          ? "archive_report"
          : "read_only_review";
  const inferredLane = decideExecutionLane({
    compiled_task: compiledTask,
    route_mode: inferredRouteMode,
    acceptance_count: compiledTask.acceptance.length,
    explicit_review_required: compiledTask.phases.some((phase) => phase.kind === "review"),
    enabled: config.executionLanesEnabled
  }).lane;
  const contextProfile = resolveContextProfile(options.executionLane ?? inferredLane, config.contextProfilesEnabled);
  const explicitBudget = contextBudgetOverrides(options);
  const budget = await loadContextBudget(
    config,
    guard,
    workspace,
    explicitBudget,
    {
      maxFilesPerTask: contextProfile.max_files_per_task,
      maxLinesPerFile: contextProfile.max_lines_per_file,
      maxTotalChars: contextProfile.max_total_chars,
      source: "defaults"
    },
    "cap"
  );
  const maxDepth = clamp(options.maxDepth, 3, 1, 6);
  const requestedMaxFiles = clamp(options.maxFiles, 24, 1, 80);
  const maxFiles = Math.min(requestedMaxFiles, budget.maxFilesPerTask);
  const maxFileBytes = clamp(options.maxFileBytes, Math.min(config.maxReadBytes, 60_000), 1_000, Math.min(config.maxReadBytes, 250_000));
  const maxDiffBytes = clamp(options.maxDiffBytes, Math.min(config.maxOutputBytes, 80_000), 1_000, config.maxOutputBytes);
  const requestedMaxTotalBytes = clamp(
    options.maxTotalBytes,
    Math.min(config.maxWriteBytes, 700_000),
    20_000,
    Math.min(config.maxWriteBytes, 2_000_000)
  );
  const maxTotalBytes = Math.min(requestedMaxTotalBytes, budget.maxTotalChars);

  const status = gitStatus(config, workspace);
  const changedFiles = parseChangedFiles(status);
  const includeImportantFiles = options.includeImportantFiles !== false;
  const includeChangedFiles = options.includeChangedFiles !== false;
  const importantFiles = includeImportantFiles ? await existingImportantFiles(guard, workspace) : [];
  const changedFileCandidates = includeChangedFiles ? changedFiles : [];
  const selectedPaths = unique(options.selectedPaths ?? []);
  const extraGlobFiles = await filesForGlobs(guard, workspace, options.extraGlobs ?? [], maxFiles);
  const plannedFiles = await planProContextFiles(config, guard, workspace, {
    title,
    taskInstruction: options.taskInstruction,
    previousTopic: options.previousTopic,
    contextDir: config.contextDir,
    includeAiBridge: options.includeAiBridge !== false,
    selectedPaths,
    changedFiles: changedFileCandidates,
    extraGlobFiles,
    importantFiles,
    maxFiles,
    maxTotalBytes,
    compiledTask
  });
  const candidatesBeforeBudget = plannedFiles.candidatePaths;
  const contextPlan = plannedFiles.contextPlan;
  const candidates = plannedFiles.fullPaths;
  const summarizedCandidates = plannedFiles.summarizedNodes;

  let truncated = false;
  let budgetExceeded = contextPlan.skipped.length > 0
    || contextPlan.summarized.length > 0
    || contextPlan.uncovered_required.length > 0
    || requestedMaxFiles > maxFiles
    || requestedMaxTotalBytes > maxTotalBytes;
  const filesIncluded: string[] = [];
  let contextLinesCount = 0;
  let contextTotalChars = 0;
  const explicitExpansion = [
    [explicitBudget.maxFilesPerTask, contextProfile.max_files_per_task],
    [explicitBudget.maxLinesPerFile, contextProfile.max_lines_per_file],
    [explicitBudget.maxTotalChars, contextProfile.max_total_chars]
  ].some(([requested, profileValue]) => Number.isFinite(requested) && Number(requested) > Number(profileValue));
  const filesSkipped: string[] = contextPlan.skipped.map((node) => {
    const countLimited = contextPlan.selected.length + contextPlan.summarized.length >= maxFiles;
    const prefix = countLimited ? "context budget: max_files_per_task; " : "";
    return `${node.path ?? node.id} [${prefix}context planner: ${node.skip_reason}]`;
  });
  for (const node of contextPlan.uncovered_required) {
    const label = `${node.path ?? node.id} [required context uncovered]`;
    if (!filesSkipped.includes(label)) filesSkipped.push(label);
  }
  const parts: string[] = [];

  parts.push(`# ${title}`);
  parts.push(
    [
      `Generated: ${new Date().toISOString()}`,
      `Workspace: ${workspace.root}`,
      `Workspace ID: ${workspace.id}`,
      `Write mode: ${config.writeMode}`,
      `Bash mode: ${config.bashMode}`,
      `Tool mode: ${config.toolMode}`,
      "",
      "Purpose: paste this bundle into a high-context ChatGPT model when that model cannot call the CodexPro MCP tools directly.",
      "Instruction for ChatGPT: use this as repository context, produce a narrow Codex execution plan, and avoid inventing files or runtime facts not shown here."
    ].join("\n")
  );

  appendSection(parts, "Context Budget", budgetBlock(budget, contextProfile));
  appendSection(parts, "Context Planner", [
    formatContextPlan(contextPlan),
    "",
    `Task instruction: ${options.taskInstruction?.trim() || title}`,
    `Previous topic: ${options.previousTopic?.trim() || "none"}`,
    `Candidate nodes: ${candidatesBeforeBudget.length}`,
    `Deduplicated nodes: ${contextPlan.deduplicated_node_ids.length}`
  ].join("\n"));
  appendSection(parts, "Governed Memory", [
    `Selected active entries: ${plannedFiles.selectedMemoryNodes.length}`,
    `Expired entries excluded: ${plannedFiles.governedMemory.expired_ids.join(", ") || "none"}`,
    `Conflicted entries excluded: ${plannedFiles.governedMemory.conflicted_ids.join(", ") || "none"}`,
    `Deprecated entries excluded: ${plannedFiles.governedMemory.deprecated_ids.join(", ") || "none"}`,
    "",
    plannedFiles.selectedMemoryNodes.length
      ? plannedFiles.selectedMemoryNodes.map((node) => `- ${node.id}: ${node.summary ?? "summary unavailable"}`).join("\n")
      : "- none"
  ].join("\n"));

  appendSection(parts, "Repository Tree", (await repoTree(config, guard, workspace, {
    path: ".",
    maxDepth,
    includeHidden: false,
    maxEntries: 700
  })).text);

  appendSection(parts, "Git Status", `\`\`\`text\n${status}\n\`\`\``);
  appendSection(parts, "Recent Commits", `\`\`\`text\n${gitLog(config, workspace, 8)}\n\`\`\``);

  if (options.includeDiff !== false) {
    const diff = truncateText(gitDiff(config, guard, workspace), maxDiffBytes);
    truncated ||= diff.truncated;
    appendSection(parts, "Git Diff", `\`\`\`diff\n${diff.text}\n\`\`\``);
  }

  if (options.includeAiBridge !== false) {
    const ai = await readAiBridgeContext(config, guard, workspace);
    appendSection(parts, "Existing AI Bridge Context", ai.text);
  }

  appendSection(
    parts,
    "Selected Files",
    [
      `Changed files detected: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
      `Auto-include important root files: ${includeImportantFiles ? "yes" : "no"}`,
      `Auto-include changed files: ${includeChangedFiles ? "yes" : "no"}`,
      `Explicit selected paths: ${selectedPaths.length ? selectedPaths.join(", ") : "none"}`,
      `Extra globs: ${(options.extraGlobs ?? []).length ? (options.extraGlobs ?? []).join(", ") : "none"}`,
      "Priority order: required rules and explicit scope, current diff, task-related entries/tests, then lower-relevance context summarized or skipped.",
      `Files included in full: ${candidates.length ? candidates.join(", ") : "none"}`,
      `Files summarized: ${summarizedCandidates.length ? summarizedCandidates.map((node) => node.path).join(", ") : "none"}`,
      `Files skipped or uncovered: ${filesSkipped.length}`
    ].join("\n")
  );

  appendSection(
    parts,
    "Summarized Context",
    summarizedCandidates.length
      ? summarizedCandidates.map((node) => `- ${node.path}: ${node.summary ?? "summary unavailable"}`).join("\n")
      : "None."
  );

  const fileChunks: string[] = [];
  for (const rel of candidates) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) {
        filesSkipped.push(`${rel} [missing]`);
        continue;
      }
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) {
        filesSkipped.push(`${rel} [not a file]`);
        continue;
      }
      const read = await readTextFile(config, guard, workspace, rel, { endLine: budget.maxLinesPerFile, maxBytes: maxFileBytes });
      filesIncluded.push(read.path);
      contextLinesCount += Math.max(0, read.endLine - read.startLine + 1);
      contextTotalChars += read.text.length;
      const lineBudgeted = read.endLine < read.totalLines;
      if (lineBudgeted) {
        budgetExceeded = true;
        filesSkipped.push(`${read.path} [context budget: max_lines_per_file; remaining lines omitted]`);
      }
      fileChunks.push(
        [
          `### ${read.path}`,
          "",
          `Bytes: ${read.bytes}`,
          `SHA-256: ${read.sha256}`,
          `Lines: ${read.startLine}-${read.endLine} of ${read.totalLines}${lineBudgeted ? " [context budget preview]" : ""}`,
          lineBudgeted ? "Budget note: file is larger than max_lines_per_file; narrow the selected range or raise context.max_lines_per_file for more detail." : "",
          "",
          `\`\`\`${languageForPath(read.path)}`,
          read.text,
          "```"
        ].join("\n")
      );
    } catch (error) {
      filesSkipped.push(`${rel} [${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  appendSection(parts, "File Contents", fileChunks.length ? fileChunks.join("\n\n") : "No file contents selected.");
  appendSection(parts, "Skipped Files", filesSkipped.length ? filesSkipped.map((file) => `- ${file}`).join("\n") : "None.");

  if (budgetExceeded) {
    appendSection(parts, "Budget Advice", budgetExceededAdvice("export_pro_context", budget));
  }

  let markdown = `${parts.join("\n\n")}\n`;
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > maxTotalBytes) {
    const capped = truncateText(markdown, maxTotalBytes);
    markdown = capped.text;
    truncated = true;
    budgetExceeded = true;
  }

  const missingReasons = [...new Set([
    ...contextPlan.skipped.map((node) => `${node.path ?? node.id}: ${node.skip_reason}`),
    ...contextPlan.uncovered_required.map((node) => `${node.path ?? node.id}: required context uncovered`),
    ...filesSkipped
  ])];
  if (explicitExpansion) {
    try {
      await codexProEventBus.emit("context_expanded", {
        context_profile: contextProfile.name,
        max_files_per_task: budget.maxFilesPerTask,
        max_lines_per_file: budget.maxLinesPerFile,
        max_total_chars: budget.maxTotalChars,
        missing_reasons: missingReasons
      }, { source: "pro_context" });
    } catch {
      // Context observability must not block bundle creation.
    }
  }
  return {
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    filesIncluded,
    filesSkipped,
    truncated,
    budget,
    contextProfile,
    contextUsage: {
      context_profile: contextProfile.name,
      context_files_count: filesIncluded.length,
      context_lines_count: contextLinesCount,
      context_total_chars: contextTotalChars,
      context_expansion_count: explicitExpansion ? 1 : 0,
      context_budget_exceeded: budgetExceeded,
      context_missing_reasons: missingReasons
    },
    budgetExceeded,
    contextPlan
  };
}

function contextPlanSnapshotPath(config: CodexProConfig, snapshotId: string): string {
  const normalized = snapshotId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(normalized)) {
    throw new CodexProError("snapshotId must use 1-200 letters, numbers, dot, underscore, or dash characters.");
  }
  return `${config.contextDir}/task-snapshots/${normalized}/context-plan.json`;
}

export async function exportProContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProContextOptions = {}
): Promise<ProContextResult> {
  if (options.includeAiBridge !== false) {
    await ensureAiBridge(config, guard, workspace);
  }
  const built = await buildProContext(config, guard, workspace, options);
  built.markdown = redactSensitiveText(built.markdown);
  const contextDir = guard.resolve(workspace, config.contextDir, { forWrite: true });
  await fsp.mkdir(contextDir.absPath, { recursive: true, mode: 0o700 });
  const relPath = `${config.contextDir}/pro-context.md`;
  const write = await writeTextFile(config, guard, workspace, relPath, built.markdown, {
    createDirs: true,
    overwrite: true
  });
  let contextPlanPath: string | undefined;
  if (options.snapshotId) {
    const snapshotPath = contextPlanSnapshotPath(config, options.snapshotId);
    const contextPlanWrite = await writeTextFile(
      config,
      guard,
      workspace,
      snapshotPath,
      `${redactSensitiveText(JSON.stringify(built.contextPlan, null, 2))}\n`,
      { createDirs: true, overwrite: true }
    );
    contextPlanPath = contextPlanWrite.path;
  }
  return {
    ...built,
    path: write.path,
    ...(contextPlanPath ? { contextPlanPath } : {}),
    bytes: write.bytes
  };
}
