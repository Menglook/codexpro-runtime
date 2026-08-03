import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { gitCurrentBranch, gitHeadSha, gitStatus } from "../gitOps.js";
import type { Workspace } from "../guard.js";
import { partitionAcceptanceChangedFiles } from "./acceptanceProfile.js";
import { statusChangedFiles } from "./dirtyGuard.js";

export interface RepositoryFileHash {
  path: string;
  sha256: string;
}

export interface RepositoryStateSnapshot {
  version: 1;
  project_root: string;
  branch: string | null;
  head_sha: string | null;
  changed_files: string[];
  changed_files_hash: string;
  file_sha256: RepositoryFileHash[];
  content_digest: string;
  captured_at: string;
}

function normalizeGitValue(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === "(no output)" || /git unavailable|not a git repository|fatal:|exited with status/i.test(normalized)) return null;
  return normalized;
}

function expandStatusPath(raw: string): string[] {
  const normalized = raw.replace(/\\/g, "/").trim();
  if (!normalized) return [];
  if (!normalized.includes(" -> ")) return [normalized];
  return normalized.split(" -> ").map((item) => item.trim()).filter(Boolean);
}

export function normalizeRepositoryChangedFiles(files: string[]): string[] {
  return [...new Set(files.flatMap(expandStatusPath).map((file) => file.replace(/^\.\//, "")).filter(Boolean))].sort();
}

async function hashFile(absPath: string): Promise<string> {
  try {
    const stat = await fsp.lstat(absPath);
    if (stat.isSymbolicLink()) return `symlink:${await fsp.readlink(absPath)}`;
    if (!stat.isFile()) return stat.isDirectory() ? "directory" : `other:${stat.mode}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absPath)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

async function fileSnapshot(workspace: Workspace, files: string[]): Promise<{
  files: string[];
  hashes: RepositoryFileHash[];
  hash: string;
}> {
  const normalized = normalizeRepositoryChangedFiles(files);
  const hashes: RepositoryFileHash[] = [];
  for (const file of normalized) {
    const absolute = path.resolve(workspace.root, file);
    const relative = path.relative(workspace.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${file}`);
    hashes.push({ path: file, sha256: await hashFile(absolute) });
  }
  return {
    files: normalized,
    hashes,
    hash: createHash("sha256").update(JSON.stringify(hashes.map((entry) => [entry.path, entry.sha256]))).digest("hex")
  };
}

export async function captureRepositoryState(
  config: CodexProConfig,
  workspace: Workspace,
  options: { changed_files?: string[] } = {}
): Promise<RepositoryStateSnapshot> {
  const changedFiles = options.changed_files ?? partitionAcceptanceChangedFiles(statusChangedFiles(gitStatus(config, workspace))).changed;
  const files = await fileSnapshot(workspace, changedFiles);
  return {
    version: 1,
    project_root: path.resolve(workspace.root),
    branch: normalizeGitValue(gitCurrentBranch(config, workspace)),
    head_sha: normalizeGitValue(gitHeadSha(config, workspace)),
    changed_files: files.files,
    changed_files_hash: files.hash,
    file_sha256: files.hashes,
    content_digest: files.hash,
    captured_at: new Date().toISOString()
  };
}
