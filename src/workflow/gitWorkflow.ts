import { readWorkspaceLeaseSync } from "../../shared/execution-kernel.mjs";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { gitDiff, gitStatus, gitUntrackedFiles } from "../gitOps.js";
import { detectGitIntent } from "../security/gitIntent.js";
import { diffStats } from "./dirtyGuard.js";

export type GitValidationStatus = "pass" | "fail" | "unknown";

export interface GitStatusEntry {
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  path: string;
  add_paths: string[];
  risk: boolean;
}

export interface GitChangeGroups {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  risk: GitStatusEntry[];
}

export interface GitWorkflowSummary {
  branch: string;
  status: string;
  status_error?: string;
  staged_diff_stats: { additions: number; deletions: number; changed: boolean };
  unstaged_diff_stats: { additions: number; deletions: number; changed: boolean };
  groups: GitChangeGroups;
  changed_files: string[];
  recommended_files: string[];
  risk_files: string[];
  clean: boolean;
  text: string;
}

export interface GitPrepareResult extends GitWorkflowSummary {
  validation_status: GitValidationStatus;
  validation_summary: string;
  explicit_user_approval: boolean;
  git_intent_detected: boolean;
  git_intent_signals: string[];
  commit_flow_allowed: boolean;
  commit_flow_blockers: string[];
  suggested_add_paths: string[];
  suggested_add: string[];
  suggested_commit_message: string;
  suggested_commands: string[];
}

const RISK_PATH_PATTERN = /(^|\/)\.env($|\.)|(^|\/)node_modules\/|(^|\/)dist\/|(^|\/)build\/|(^|\/)\.next\/|(^|\/)coverage\/|(^|\/)\.cache\/|(^|\/)mysql($|\/)|(^|\/)mysql-data($|\/)|(^|\/)db_data($|\/)|secret|credential|private|password|token/i;

function normalizeGitOutput(value: string): string {
  return value.trim() === "(no output)" ? "" : value;
}

function looksLikeGitError(value: string): boolean {
  return /git unavailable|not a git repository|not a git repo|fatal:|exited with status/i.test(value);
}

function quotePath(file: string): string {
  return `'${file.replace(/'/g, "'\\''")}'`;
}

function uniqueStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parsePathForGit(rawPath: string): { displayPath: string; addPaths: string[] } {
  const arrow = " -> ";
  if (!rawPath.includes(arrow)) return { displayPath: rawPath, addPaths: [rawPath] };
  const [from, to] = rawPath.split(arrow).map((item) => item.trim()).filter(Boolean);
  const addPaths = uniqueStrings([from, to]);
  return { displayPath: rawPath, addPaths };
}

function parseStatus(status: string, extraUntracked: string[]): { branch: string; entries: GitStatusEntry[]; statusError?: string } {
  if (looksLikeGitError(status)) return { branch: "", entries: [], statusError: status };

  const entries: GitStatusEntry[] = [];
  let branch = "";
  const seen = new Set<string>();
  for (const rawLine of status.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("##")) {
      branch = line.replace(/^##\s*/, "").trim();
      continue;
    }
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const { displayPath, addPaths } = parsePathForGit(rawPath);
    const key = `${code}\0${displayPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = code[0] !== " " && code[0] !== "?";
    const unstaged = code[1] !== " " && code[1] !== "?";
    const untracked = code === "??";
    entries.push({ code, staged, unstaged, untracked, path: displayPath, add_paths: addPaths, risk: isRiskPath(displayPath) || addPaths.some(isRiskPath) });
  }

  for (const file of extraUntracked) {
    const key = `??\0${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ code: "??", staged: false, unstaged: false, untracked: true, path: file, add_paths: [file], risk: isRiskPath(file) });
  }

  return { branch, entries };
}

function isRiskPath(file: string): boolean {
  return RISK_PATH_PATTERN.test(file);
}

function groupEntries(entries: GitStatusEntry[]): GitChangeGroups {
  const risk = entries.filter((entry) => entry.risk);
  return {
    staged: entries.filter((entry) => entry.staged),
    unstaged: entries.filter((entry) => entry.unstaged),
    untracked: entries.filter((entry) => entry.untracked),
    risk
  };
}

function statusCode(entry: GitStatusEntry): string {
  return entry.code.replace(/ /g, ".");
}

function formatEntries(entries: GitStatusEntry[]): string {
  return entries.length ? entries.map((entry) => `- [${statusCode(entry)}] ${entry.path}${entry.risk ? "  ⚠ risk" : ""}`).join("\n") : "- none";
}

function commitScope(files: string[]): string {
  if (!files.length) return "repo";
  if (files.every((file) => file.startsWith("src/adapters/") || file.startsWith("scripts/") && file.includes("adapter"))) return "adapters";
  if (files.every((file) => file.startsWith("src/project/"))) return "project";
  if (files.every((file) => file.startsWith("src/workflow/"))) return "workflow";
  if (files.some((file) => file === "package.json" || file === "package-lock.json")) return "deps";
  if (files.some((file) => file.startsWith("docs/") || file.endsWith(".md"))) return "docs";
  if (files.some((file) => file.startsWith("src/"))) return "core";
  return "repo";
}

export function commitSubject(files: string[]): string {
  const scope = commitScope(files);
  if (scope === "adapters") return "feat(adapters): strengthen git commit workflow";
  if (scope === "project") return "feat(project): enhance project config loading";
  if (scope === "workflow") return "feat(workflow): strengthen git workflow guidance";
  if (scope === "deps") return "chore(deps): update project workflow dependencies";
  if (scope === "docs") return "docs: update CodexPro workflow docs";
  if (scope === "core") return "feat(core): expose project workflow validation tools";
  return "chore: update repository";
}

function normalizeValidationStatus(value: GitValidationStatus | string | undefined): GitValidationStatus {
  if (value === "pass" || value === "fail" || value === "unknown") return value;
  return "unknown";
}

function addPathCandidates(entries: GitStatusEntry[]): string[] {
  const candidates = uniqueStrings(entries.flatMap((entry) => entry.add_paths));
  return candidates.filter((candidate) => {
    const normalized = candidate.replace(/\\/g, "/");
    if (!normalized.endsWith("/")) return true;
    return !candidates.some((other) => other !== candidate && other.replace(/\\/g, "/").startsWith(normalized));
  });
}

function buildSummaryText(summary: Omit<GitWorkflowSummary, "text">): string {
  const branch = summary.branch || "unknown";
  const lines = [
    "# Git Summary",
    "",
    `Workspace: ${summary.status_error ? "git unavailable" : "git repository"}`,
    `Branch: ${branch}`,
    `Clean: ${summary.clean}`,
    "",
    "## Staged changes",
    formatEntries(summary.groups.staged),
    "",
    "## Unstaged changes",
    formatEntries(summary.groups.unstaged),
    "",
    "## Untracked files",
    formatEntries(summary.groups.untracked),
    "",
    "## Risk / do-not-auto-add files",
    formatEntries(summary.groups.risk),
    "",
    "## Diff stats",
    `- Staged: +${summary.staged_diff_stats.additions} -${summary.staged_diff_stats.deletions}`,
    `- Unstaged: +${summary.unstaged_diff_stats.additions} -${summary.unstaged_diff_stats.deletions}`,
    "",
    "## Git policy",
    "- CodexPro may summarize and prepare commands, but it does not run git commit or git push automatically.",
    "- `git_prepare` should emit commit/push commands only after validation passed and the user explicitly asked to submit/push.",
    "- Risk-marked paths are excluded from suggested add commands."
  ];
  if (summary.status_error) lines.splice(3, 0, `Status error: ${summary.status_error}`);
  return lines.join("\n");
}

export function buildGitSummary(config: CodexProConfig, guard: PathGuard, workspace: Workspace): GitWorkflowSummary {
  const status = gitStatus(config, workspace);
  const statusError = looksLikeGitError(status) ? status : undefined;
  const extraUntracked = statusError ? [] : parseUntracked(gitUntrackedFiles(config, workspace));
  const parsed = parseStatus(status, extraUntracked);
  const groups = groupEntries(parsed.entries);
  const unstagedDiff = statusError ? "" : normalizeGitOutput(gitDiff(config, guard, workspace, undefined, false));
  const stagedDiff = statusError ? "" : normalizeGitOutput(gitDiff(config, guard, workspace, undefined, true));
  const changedFiles = uniqueStrings(parsed.entries.map((entry) => entry.path));
  const riskFiles = uniqueStrings(parsed.entries.filter((entry) => entry.risk).map((entry) => entry.path));
  const recommendedFiles = changedFiles.filter((file) => !riskFiles.includes(file));
  const result: Omit<GitWorkflowSummary, "text"> = {
    branch: parsed.branch,
    status,
    status_error: statusError ?? parsed.statusError,
    staged_diff_stats: diffStats(stagedDiff),
    unstaged_diff_stats: diffStats(unstagedDiff),
    groups,
    changed_files: changedFiles,
    recommended_files: recommendedFiles,
    risk_files: riskFiles,
    clean: changedFiles.length === 0 && !diffStats(stagedDiff).changed && !diffStats(unstagedDiff).changed
  };
  return { ...result, text: buildSummaryText(result) };
}

export function buildGitPrepare(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    includeUntracked?: boolean;
    validationStatus?: GitValidationStatus | string;
    validationSummary?: string;
    userIntent?: string;
    includePush?: boolean;
  } = {}
): GitPrepareResult {
  const summary = buildGitSummary(config, guard, workspace);
  const validationStatus = normalizeValidationStatus(options.validationStatus);
  const validationSummary = options.validationSummary?.trim() || (validationStatus === "unknown" ? "No validation result supplied." : validationStatus);
  const gitIntent = detectGitIntent(options.userIntent);
  const explicitApproval = gitIntent.detected;
  const safeUnstaged = summary.groups.unstaged.filter((entry) => !entry.risk);
  const safeUntracked = options.includeUntracked === false ? [] : summary.groups.untracked.filter((entry) => !entry.risk);
  const suggestedAddPaths = addPathCandidates([...safeUnstaged, ...safeUntracked]);
  const suggestedAdd = suggestedAddPaths.length ? [`git add ${suggestedAddPaths.map(quotePath).join(" ")}`] : [];
  const message = commitSubject(summary.recommended_files);
  const blockers: string[] = [];
  const writer = readWorkspaceLeaseSync(workspace.root, { contextDir: ".ai-bridge", name: "write" });
  if (writer.active) {
    blockers.push(`Workspace has an active writer: kind=${writer.lease?.kind ?? "unknown"} run_id=${writer.lease?.run_id ?? "unknown"} pid=${writer.lease?.pid ?? "unknown"}.`);
  }
  if (summary.status_error) blockers.push("Git status is unavailable.");
  if (summary.clean) blockers.push("No local changes detected.");
  if (validationStatus !== "pass") blockers.push("Pre-commit validation has not passed.");
  if (!summary.recommended_files.length && summary.changed_files.length) blockers.push("Only risk-marked files were changed; review manually.");
  const commitFlowAllowed = blockers.length === 0;
  const commands = commitFlowAllowed
    ? [
        ...suggestedAdd,
        `git commit -m ${quotePath(message)}`,
        ...(options.includePush === false ? [] : ["git push"])
      ]
    : [];

  const text = [
    "# Git Prepare",
    "",
    commitFlowAllowed ? "Commit workflow is allowed by policy." : "Commit workflow is blocked by policy.",
    "",
    "## Pre-commit validation",
    `- Status: ${validationStatus}`,
    `- Summary: ${validationSummary}`,
    "",
    "## User Git intent (informational)",
    `- Git intent detected: ${explicitApproval}`,
    `- Matched signals: ${gitIntent.matched_signals.length ? gitIntent.matched_signals.join(", ") : "none"}`,
    "- User wording is recorded for observability and never blocks a validated workflow.",
    "",
    "## Staged changes",
    formatEntries(summary.groups.staged),
    "",
    "## Unstaged changes",
    formatEntries(summary.groups.unstaged),
    "",
    "## Untracked files",
    formatEntries(summary.groups.untracked),
    "",
    "## Risk / do-not-auto-add files",
    formatEntries(summary.groups.risk),
    "",
    "## Suggested commands",
    commands.length ? ["```bash", ...commands, "```"].join("\n") : "No git add / commit / push commands suggested.",
    "",
    "## Blockers",
    blockers.length ? blockers.map((blocker) => `- ${blocker}`).join("\n") : "- none",
    "",
    "## Policy",
    "- Never use `git add .`; suggested add commands must enumerate exact files.",
    "- Do not run git commit or git push automatically.",
    "- If validation failed or is unknown, do not suggest commit/push commands by default.",
    "- Never prepare commit/push commands while a workspace write lease is active."
  ].join("\n");

  return {
    ...summary,
    validation_status: validationStatus,
    validation_summary: validationSummary,
    explicit_user_approval: explicitApproval,
    git_intent_detected: explicitApproval,
    git_intent_signals: gitIntent.matched_signals,
    commit_flow_allowed: commitFlowAllowed,
    commit_flow_blockers: blockers,
    suggested_add_paths: suggestedAddPaths,
    suggested_add: suggestedAdd,
    suggested_commit_message: message,
    suggested_commands: commands,
    text
  };
}

export function parseUntracked(value: string): string[] {
  if (!value.trim() || value.trim() === "(no output)" || looksLikeGitError(value)) return [];
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
