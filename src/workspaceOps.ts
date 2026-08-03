import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { readTextFile, repoTree, ensureAiBridge } from "./fsOps.js";
import { gitDiff, gitLogResult, gitStatus, gitStatusResult, type GitReadState } from "./gitOps.js";
import { discoverSkillInventory } from "./capabilitiesOps.js";
import type { SkillInventoryItem } from "./capabilitiesOps.js";
import { buildRuleSummary, formatRuleSummary, type RuleSummaryResult } from "./project/ruleSummary.js";

export type WorkspacePreflightState = "ready" | "deferred" | "timeout" | "failed";

export interface WorkspaceOpenTimingEvidence {
  timing_scope: "workspace_summary";
  request_received_at: string;
  request_received_at_source: "caller" | "summary_entry";
  workspace_resolved_at: string;
  workspace_resolved_at_source: "caller" | "summary_entry";
  preflight_started_at?: string;
  preflight_completed_at?: string;
  response_prepared_at: string;
  resolve_ms: number;
  preflight_ms: number;
  total_ms: number;
}

export interface WorkspaceRuleSummary extends RuleSummaryResult {
  preflight_status: WorkspacePreflightState;
  git_status_state: WorkspacePreflightState;
  git_log_state: WorkspacePreflightState;
  timing_evidence?: WorkspaceOpenTimingEvidence;
}

export interface WorkspaceSummary {
  text: string;
  workspaceId: string;
  root: string;
  agentsLoaded: boolean;
  agentsPath?: string;
  skills: string[];
  skillInventory: SkillInventoryItem[];
  skillCounts: Record<string, number>;
  tree?: string;
  gitStatus: string;
  gitStatusState: WorkspacePreflightState;
  gitLog?: string;
  gitLogState: WorkspacePreflightState;
  ruleSummary: WorkspaceRuleSummary;
  preflightStatus: WorkspacePreflightState;
  timingEvidence: WorkspaceOpenTimingEvidence;
}

export interface WorkspaceSummaryOptions {
  includeTree?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  bootstrapContext?: boolean;
  includeSkills?: boolean;
  includeGlobalSkills?: boolean;
  includePreflight?: boolean;
  gitTimeoutMs?: number;
  requestReceivedAtMs?: number;
  workspaceResolvedAtMs?: number;
}

export interface CodexContext {
  text: string;
  workspaceId: string;
  root: string;
  targetPath: string;
  agentsFiles: string[];
  aiContextFiles: string[];
  gitStatus?: string;
  gitDiff?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function discoverSkills(workspace: Workspace, options: { includeGlobal?: boolean } = {}): Promise<string[]> {
  const candidateDirs = unique([
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, "skills"),
    ...(options.includeGlobal
      ? [path.join(os.homedir(), ".codex", "skills"), path.join(os.homedir(), ".chatgpt", "skills")]
      : [])
  ]);
  const skills: string[] = [];
  for (const dir of candidateDirs) {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) skills.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return unique(skills).sort((a, b) => a.localeCompare(b));
}

function skillCounts(skills: Array<{ source?: string }>): Record<string, number> {
  const counts: Record<string, number> = { total: skills.length, workspace: 0, user: 0, plugin: 0, other: 0 };
  for (const skill of skills) {
    const source = skill.source ?? "other";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function deferredRuleSummary(
  workspace: Workspace,
  warning = "Preflight rules were deferred. Call read_rule_summary before editing or making project decisions."
): WorkspaceRuleSummary {
  return {
    workspace_id: workspace.id,
    root: workspace.root,
    generated_at: new Date().toISOString(),
    sources: [],
    effective_rules: [],
    preflight_rules: [],
    warnings: [warning],
    files: [],
    memory_existed: false,
    project_config_existed: false,
    truncated: false,
    preflight_status: "deferred",
    git_status_state: "deferred",
    git_log_state: "deferred"
  };
}

function workspaceStateFromGit(state: GitReadState): WorkspacePreflightState {
  if (state === "ready") return "ready";
  if (state === "timeout") return "timeout";
  return "failed";
}

function isoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

async function findAgentsFile(workspace: Workspace): Promise<string | undefined> {
  const [first] = await findAgentsFilesInDir(workspace, ".");
  return first;
}

function candidateAgentDirs(targetPath: string): string[] {
  const normalized = targetPath.split(path.sep).join("/").replace(/^\.\//, "");
  const parts = normalized && normalized !== "." ? normalized.split("/").filter(Boolean) : [];
  const dirs = [""];
  const directoryParts = parts.length > 0 && parts.at(-1)?.includes(".") ? parts.slice(0, -1) : parts;
  for (let i = 0; i < directoryParts.length; i += 1) {
    dirs.push(directoryParts.slice(0, i + 1).join("/"));
  }
  return [...new Set(dirs)];
}

async function findAgentsFilesInDir(workspace: Workspace, dir: string): Promise<string[]> {
  const names = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"];
  const absDir = path.join(workspace.root, dir);
  const entries = await safeReaddir(absDir);
  const files = entries.filter((entry) => entry.isFile());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const entry =
      files.find((item) => item.name === name) ??
      files.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!entry) continue;
    const rel = dir && dir !== "." ? `${dir}/${entry.name}` : entry.name;
    const real = fs.realpathSync(path.join(workspace.root, rel)).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(rel);
  }
  return out;
}

async function readAgentsChain(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  targetPath: string,
  maxBytes: number
): Promise<{ text: string; files: string[] }> {
  const chunks: string[] = [];
  const files: string[] = [];
  const seenRealPaths = new Set<string>();
  const candidates = (
    await Promise.all(candidateAgentDirs(targetPath).map((dir) => findAgentsFilesInDir(workspace, dir || ".")))
  ).flat();
  for (const rel of candidates) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) continue;
      const real = fs.realpathSync(resolved.absPath).toLowerCase();
      if (seenRealPaths.has(real)) continue;
      seenRealPaths.add(real);
      const agents = await readTextFile(config, guard, workspace, rel, { maxBytes });
      chunks.push(`--- ${rel} ---\n${agents.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
      files.push(rel);
    }
  }
  return {
    text: chunks.length ? chunks.join("\n\n") : "No AGENTS.md-style instruction files found for this target path.",
    files
  };
}

export async function workspaceSummary(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: WorkspaceSummaryOptions = {}
): Promise<WorkspaceSummary> {
  const summaryStartedAtMs = Date.now();
  const requestReceivedAtMs = options.requestReceivedAtMs ?? summaryStartedAtMs;
  const workspaceResolvedAtMs = options.workspaceResolvedAtMs ?? summaryStartedAtMs;
  const includePreflight = options.includePreflight === true;

  if (options.bootstrapContext) {
    await ensureAiBridge(config, guard, workspace);
  }

  const skillPromise: Promise<SkillInventoryItem[]> = options.includeSkills
    ? discoverSkillInventory(workspace, { includeGlobal: options.includeGlobalSkills === true, maxSkills: 120 })
    : Promise.resolve([]);
  const treePromise: Promise<string | undefined> = options.includeTree !== false
    ? repoTree(config, guard, workspace, {
        path: ".",
        maxDepth: Math.max(1, Math.min(options.maxDepth ?? 3, 8)),
        includeHidden: false,
        maxEntries: Math.max(1, Math.min(options.maxEntries ?? 500, 3000))
      }).then((tree) => tree.text)
    : Promise.resolve(undefined);
  const [skillInventory, treeText] = await Promise.all([skillPromise, treePromise]);
  const skills = skillInventory.map((skill) => skill.name);
  const counts = skillCounts(skillInventory);

  const agentsPath = await findAgentsFile(workspace);
  const agentsText = agentsPath
    ? `AGENTS.md: ${agentsPath} (read this file before editing or making project decisions).`
    : "AGENTS.md: none loaded";
  let status = "deferred; call show_changes or git_summary when Git state is needed";
  let log = "deferred; call git_summary when recent commits are needed";
  let gitStatusState: WorkspacePreflightState = "deferred";
  let gitLogState: WorkspacePreflightState = "deferred";
  let preflightStatus: WorkspacePreflightState = "deferred";
  let ruleSummary = deferredRuleSummary(workspace);
  let preflightStartedAtMs: number | undefined;
  let preflightCompletedAtMs: number | undefined;

  if (includePreflight) {
    preflightStartedAtMs = Date.now();
    const gitTimeoutMs = Math.max(1_000, Math.min(options.gitTimeoutMs ?? 1_500, 30_000));
    const statusResult = gitStatusResult(config, workspace, undefined, undefined, { timeoutMs: gitTimeoutMs });
    const logResult = gitLogResult(config, workspace, 5, { timeoutMs: gitTimeoutMs });
    status = statusResult.text;
    log = logResult.text;
    gitStatusState = workspaceStateFromGit(statusResult.state);
    gitLogState = workspaceStateFromGit(logResult.state);

    let ruleSummaryFailed = false;
    try {
      const loadedRuleSummary = await buildRuleSummary(config, guard, workspace);
      ruleSummary = {
        ...loadedRuleSummary,
        preflight_status: "ready",
        git_status_state: gitStatusState,
        git_log_state: gitLogState
      };
    } catch (error) {
      ruleSummaryFailed = true;
      ruleSummary = deferredRuleSummary(
        workspace,
        `Preflight rule loading failed and was downgraded: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (ruleSummaryFailed || gitStatusState === "failed" || gitLogState === "failed") {
      preflightStatus = "failed";
    } else if (gitStatusState === "timeout" || gitLogState === "timeout") {
      preflightStatus = "timeout";
    } else {
      preflightStatus = "ready";
    }
    ruleSummary = {
      ...ruleSummary,
      preflight_status: preflightStatus,
      git_status_state: gitStatusState,
      git_log_state: gitLogState
    };
    preflightCompletedAtMs = Date.now();
  }

  const skillText = options.includeSkills
    ? `Skills: ${counts.total} total (${counts.workspace ?? 0} workspace, ${counts.user ?? 0} user, ${counts.plugin ?? 0} plugin, ${counts.other ?? 0} other).`
    : "Skills: skipped. Pass include_skills=true if skill discovery is needed.";
  const preflightText = includePreflight
    ? `${formatRuleSummary(ruleSummary)}\n\n## Git status (${gitStatusState})\n\n${status}\n\n## Recent commits (${gitLogState})\n\n${log}`
    : "Preflight: deferred. Call read_rule_summary before editing or making project decisions.\nGit: deferred. Call show_changes or git_summary only when Git state is needed.";

  const responsePreparedAtMs = Date.now();
  const timingEvidence: WorkspaceOpenTimingEvidence = {
    timing_scope: "workspace_summary",
    request_received_at: isoTimestamp(requestReceivedAtMs),
    request_received_at_source: options.requestReceivedAtMs === undefined ? "summary_entry" : "caller",
    workspace_resolved_at: isoTimestamp(workspaceResolvedAtMs),
    workspace_resolved_at_source: options.workspaceResolvedAtMs === undefined ? "summary_entry" : "caller",
    ...(preflightStartedAtMs !== undefined ? { preflight_started_at: isoTimestamp(preflightStartedAtMs) } : {}),
    ...(preflightCompletedAtMs !== undefined ? { preflight_completed_at: isoTimestamp(preflightCompletedAtMs) } : {}),
    response_prepared_at: isoTimestamp(responsePreparedAtMs),
    resolve_ms: Math.max(0, workspaceResolvedAtMs - requestReceivedAtMs),
    preflight_ms: preflightStartedAtMs === undefined
      ? 0
      : Math.max(0, (preflightCompletedAtMs ?? responsePreparedAtMs) - preflightStartedAtMs),
    total_ms: Math.max(0, responsePreparedAtMs - requestReceivedAtMs)
  };
  ruleSummary = {
    ...ruleSummary,
    preflight_status: preflightStatus,
    git_status_state: gitStatusState,
    git_log_state: gitLogState,
    timing_evidence: timingEvidence
  };
  const timingText = [
    "## Open timing",
    "",
    `request_received_at: ${timingEvidence.request_received_at} (${timingEvidence.request_received_at_source})`,
    `workspace_resolved_at: ${timingEvidence.workspace_resolved_at} (${timingEvidence.workspace_resolved_at_source})`,
    `response_prepared_at: ${timingEvidence.response_prepared_at}`,
    `resolve_ms: ${timingEvidence.resolve_ms}`,
    `preflight_ms: ${timingEvidence.preflight_ms}`,
    `total_ms: ${timingEvidence.total_ms}`
  ].join("\n");
  const text = `# Workspace\n\nWorkspace: ${workspace.id}\nRoot: ${workspace.root}\nBash mode: ${config.bashMode}\nWrite mode: ${config.writeMode}\nTool mode: ${config.toolMode}\nPreflight status: ${preflightStatus}\n\n${agentsText}\n${skillText}\n\n${preflightText}\n\n${timingText}${treeText ? `\n\n## Files\n\n${treeText}` : ""}`;

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    agentsLoaded: Boolean(agentsPath),
    agentsPath,
    skills,
    skillInventory,
    skillCounts: counts,
    tree: treeText,
    gitStatus: status,
    gitStatusState,
    gitLog: log,
    gitLogState,
    ruleSummary,
    preflightStatus,
    timingEvidence
  };
}

export async function readAiBridgeContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { createIfMissing?: boolean } = {}
): Promise<{ text: string; files: string[] }> {
  if (options.createIfMissing) {
    await ensureAiBridge(config, guard, workspace);
  } else {
    const bridgeDir = guard.resolve(workspace, config.contextDir);
    if (!fs.existsSync(bridgeDir.absPath)) {
      return {
        text: `No ${config.contextDir} handoff context exists yet. Use handoff_to_agent or handoff_to_codex to create it when a plan is ready.`,
        files: []
      };
    }
  }
  const relFiles = [
    `${config.contextDir}/current-plan.md`,
    `${config.contextDir}/agent-status.md`,
    `${config.contextDir}/implementation-diff.patch`,
    `${config.contextDir}/codex-status.md`,
    `${config.contextDir}/decisions.md`,
    `${config.contextDir}/open-questions.md`,
    `${config.contextDir}/execution-log.jsonl`
  ];
  const chunks: string[] = [];
  const files: string[] = [];
  for (const rel of relFiles) {
    try {
      const read = await readTextFile(config, guard, workspace, rel, { maxBytes: 80_000 });
      chunks.push(`--- ${rel} ---\n${read.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return { text: chunks.join("\n\n"), files };
}

export async function readCodexContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    targetPath?: string;
    includeAiBridge?: boolean;
    includeGit?: boolean;
    includeDiff?: boolean;
    maxAgentBytes?: number;
  } = {}
): Promise<CodexContext> {
  const targetPath = options.targetPath ?? ".";
  guard.resolve(workspace, targetPath);
  const agents = await readAgentsChain(config, guard, workspace, targetPath, Math.min(options.maxAgentBytes ?? 60_000, config.maxReadBytes));
  const ai = options.includeAiBridge === false
    ? { text: "Skipped by request.", files: [] }
    : await readAiBridgeContext(config, guard, workspace);
  const status = options.includeGit === false ? undefined : gitStatus(config, workspace);
  const diff = options.includeDiff ? gitDiff(config, guard, workspace) : undefined;

  const text = [
    "# Codex Context",
    "",
    `Workspace: ${workspace.id}`,
    `Root: ${workspace.root}`,
    `Target path: ${targetPath}`,
    `Bash mode: ${config.bashMode}`,
    `Write mode: ${config.writeMode}`,
    `Tool mode: ${config.toolMode}`,
    "",
    "## AGENTS Instructions",
    "",
    agents.text,
    "",
    "## AI Bridge Context",
    "",
    ai.text,
    ...(status !== undefined ? ["", "## Git Status", "", status] : []),
    ...(diff !== undefined ? ["", "## Git Diff", "", diff] : [])
  ].join("\n");

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    targetPath,
    agentsFiles: agents.files,
    aiContextFiles: ai.files,
    gitStatus: status,
    gitDiff: diff
  };
}
