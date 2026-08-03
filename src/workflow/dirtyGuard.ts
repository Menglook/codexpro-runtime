import type { CodexProConfig } from "../config.js";
import { gitDiff, gitStatus } from "../gitOps.js";
import type { PathGuard, Workspace } from "../guard.js";

export interface DirtyGuardResult {
  clean: boolean;
  changed_files: string[];
  status: string;
  diff_stats: { additions: number; deletions: number; changed: boolean };
  diff_preview?: string;
  text: string;
}

export function statusChangedFiles(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trimStart().startsWith("##"))
    .map((line) => (line.length >= 3 && /\s/.test(line[2] ?? "") ? line.slice(3).trim() : line.trim()))
    .filter(Boolean);
}

export function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim() && diff.trim() !== "(no output)") };
}

function preview(value: string, maxChars = 12000): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[preview truncated]` : value;
}

export function dirtyGuard(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: { includeDiff?: boolean } = {}): DirtyGuardResult {
  const status = gitStatus(config, workspace);
  const diff = gitDiff(config, guard, workspace);
  const changedFiles = statusChangedFiles(status);
  const stats = diffStats(diff);
  const clean = changedFiles.length === 0 && !stats.changed;
  const lines = [
    "# Dirty Guard",
    "",
    clean ? "Workspace is clean." : "Workspace has local changes.",
    "",
    "## Changed files",
    changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "## Diff stats",
    `- Additions: ${stats.additions}`,
    `- Deletions: ${stats.deletions}`,
    "",
    "## Status",
    "```text",
    status,
    "```"
  ];
  const diffPreview = options.includeDiff ? preview(diff) : undefined;
  if (diffPreview) {
    lines.push("", "## Diff preview", "```diff", diffPreview, "```");
  }
  return { clean, changed_files: changedFiles, status, diff_stats: stats, diff_preview: diffPreview, text: lines.join("\n") };
}
