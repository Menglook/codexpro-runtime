import fs from "node:fs";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";
import { runProcessSync } from "./runtime/processWrapper.js";

export type GitReadState = "ready" | "timeout" | "unavailable" | "failed";

export interface GitReadOptions {
  timeoutMs?: number;
}

export interface GitReadResult {
  text: string;
  state: GitReadState;
  durationMs: number;
  timeoutMs: number;
  exitCode: number | null;
  errorClass?: string;
}

export interface GitChangeSummary {
  changedFiles: string[];
  trackedModifiedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  deletedFiles: string[];
  ignoredFiles: string[];
  additions: number;
  deletions: number;
  binaryFiles: string[];
}

function normalizeGitTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) return 30_000;
  return Math.max(1_000, Math.min(Math.floor(timeoutMs as number), 30_000));
}

function runGitResult(
  workspace: Workspace,
  args: string[],
  maxOutputBytes: number,
  options: GitReadOptions = {}
): GitReadResult {
  const startedAt = Date.now();
  const timeoutMs = normalizeGitTimeout(options.timeoutMs);
  const result = runProcessSync("git", args, {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1" },
    maxOutputBytes,
    timeoutMs,
    domain: "git",
    operation: args[0] ?? "git",
    sideEffectLevel: "local_read",
    riskLevel: "low"
  });
  const durationMs = Math.max(0, Date.now() - startedAt);
  const errorClass = result.errorClass || undefined;
  if (errorClass === "execution_hard_limit" || errorClass === "no_progress_timeout") {
    return {
      text: `git ${args[0] ?? "command"} timed out after ${timeoutMs} ms; result deferred`,
      state: "timeout",
      durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      errorClass
    };
  }
  if (result.spawnError && result.exitCode === null) {
    return {
      text: `git unavailable or failed: ${result.stderr || errorClass || "spawn failed"}`,
      state: "unavailable",
      durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      ...(errorClass ? { errorClass } : {})
    };
  }
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return {
      text: stderr || stdout || `git exited with status ${result.exitCode}`,
      state: "failed",
      durationMs,
      timeoutMs,
      exitCode: result.exitCode,
      ...(errorClass ? { errorClass } : {})
    };
  }
  return {
    text: redactSensitiveText(result.stdout.trim() || "(no output)"),
    state: "ready",
    durationMs,
    timeoutMs,
    exitCode: result.exitCode,
    ...(errorClass ? { errorClass } : {})
  };
}

function runGit(workspace: Workspace, args: string[], maxOutputBytes: number, options: GitReadOptions = {}): string {
  return runGitResult(workspace, args, maxOutputBytes, options).text;
}

function readyGitText(workspace: Workspace, args: string[], maxOutputBytes: number): string {
  const result = runGitResult(workspace, args, maxOutputBytes);
  return result.state === "ready" && result.text !== "(no output)" ? result.text : "";
}

function nulEntries(value: string): string[] {
  return value.split("\0").map((entry) => entry.trim()).filter(Boolean);
}

function nameStatusEntries(value: string): Array<{ status: string; file: string }> {
  const tokens = nulEntries(value);
  const entries: Array<{ status: string; file: string }> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    entries.push({ status: tokens[index], file: tokens[index + 1] });
  }
  return entries;
}

function textLineCount(buffer: Buffer): number | null {
  if (buffer.includes(0)) return null;
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n");
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function gitChangeSummary(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath?: string
): GitChangeSummary {
  const pathArgs: string[] = [];
  if (filePath?.trim()) pathArgs.push("--", guard.resolve(workspace, filePath).relPath);
  const unstaged = nameStatusEntries(readyGitText(
    workspace,
    ["diff", "--name-status", "--no-renames", "-z", ...pathArgs],
    config.maxOutputBytes
  ));
  const staged = nameStatusEntries(readyGitText(
    workspace,
    ["diff", "--cached", "--name-status", "--no-renames", "-z", ...pathArgs],
    config.maxOutputBytes
  ));
  const untracked = nulEntries(readyGitText(
    workspace,
    ["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs],
    config.maxOutputBytes
  ));
  const ignored = nulEntries(readyGitText(
    workspace,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", ...pathArgs],
    config.maxOutputBytes
  ));

  let additions = 0;
  let deletions = 0;
  const binaryFiles = new Set<string>();
  for (const args of [
    ["diff", "--numstat", "--no-renames", "-z", ...pathArgs],
    ["diff", "--cached", "--numstat", "--no-renames", "-z", ...pathArgs]
  ]) {
    for (const entry of nulEntries(readyGitText(workspace, args, config.maxOutputBytes))) {
      const [added, removed, file] = entry.split("\t");
      if (!file) continue;
      if (added === "-" || removed === "-") {
        binaryFiles.add(file);
        continue;
      }
      additions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
  }
  for (const file of untracked.slice(0, 500)) {
    try {
      const target = guard.resolve(workspace, file).absPath;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > config.maxReadBytes) continue;
      const lineCount = textLineCount(fs.readFileSync(target));
      if (lineCount === null) binaryFiles.add(file);
      else additions += lineCount;
    } catch {
      // The fresh Git lists remain authoritative if a file changes during counting.
    }
  }

  const stagedFiles = staged.map((entry) => entry.file);
  const deletedFiles = [...unstaged, ...staged].filter((entry) => entry.status.includes("D")).map((entry) => entry.file);
  const trackedModifiedFiles = [...unstaged, ...staged]
    .filter((entry) => !entry.status.includes("A") && !entry.status.includes("D"))
    .map((entry) => entry.file);
  const changedFiles = [...new Set([
    ...unstaged.map((entry) => entry.file),
    ...stagedFiles,
    ...untracked
  ])].sort();
  return {
    changedFiles,
    trackedModifiedFiles: [...new Set(trackedModifiedFiles)].sort(),
    stagedFiles: [...new Set(stagedFiles)].sort(),
    untrackedFiles: [...new Set(untracked)].sort(),
    deletedFiles: [...new Set(deletedFiles)].sort(),
    ignoredFiles: [...new Set(ignored)].sort(),
    additions,
    deletions,
    binaryFiles: [...binaryFiles].sort()
  };
}

export function gitStatusResult(
  config: CodexProConfig,
  workspace: Workspace,
  guard?: PathGuard,
  filePath?: string,
  options: GitReadOptions = {}
): GitReadResult {
  const args = ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) {
      return {
        text: "path-scoped git status requires a path guard",
        state: "failed",
        durationMs: 0,
        timeoutMs: normalizeGitTimeout(options.timeoutMs),
        exitCode: null
      };
    }
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGitResult(workspace, args, config.maxOutputBytes, options);
}

export function gitStatus(
  config: CodexProConfig,
  workspace: Workspace,
  guard?: PathGuard,
  filePath?: string,
  options: GitReadOptions = {}
): string {
  return gitStatusResult(config, workspace, guard, filePath, options).text;
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitReverseDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-R"];
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitCurrentBranch(config: CodexProConfig, workspace: Workspace): string {
  return runGit(workspace, ["branch", "--show-current"], config.maxOutputBytes);
}

export function gitHeadSha(config: CodexProConfig, workspace: Workspace): string {
  return runGit(workspace, ["rev-parse", "HEAD"], config.maxOutputBytes);
}

export function gitUntrackedFiles(config: CodexProConfig, workspace: Workspace): string {
  return runGit(workspace, ["ls-files", "--others", "--exclude-standard"], config.maxOutputBytes);
}

export function gitLogResult(
  config: CodexProConfig,
  workspace: Workspace,
  maxCount = 8,
  options: GitReadOptions = {}
): GitReadResult {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGitResult(
    workspace,
    ["log", `--max-count=${count}`, "--oneline", "--decorate"],
    config.maxOutputBytes,
    options
  );
}

export function gitLog(
  config: CodexProConfig,
  workspace: Workspace,
  maxCount = 8,
  options: GitReadOptions = {}
): string {
  return gitLogResult(config, workspace, maxCount, options).text;
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
