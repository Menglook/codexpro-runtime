import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { writeTextFile } from "../fsOps.js";
import { gitHeadSha } from "../gitOps.js";
import type { PathGuard, Workspace } from "../guard.js";

export interface NeatFreakCleanupCandidate {
  path: string;
  reason: string;
  sha256: string;
  size_bytes: number;
  safe_to_delete: "pending_user_confirmation";
}

export interface NeatFreakCleanupProposal {
  proposal_id: string;
  created_at: string;
  project_head: string | null;
  candidates: NeatFreakCleanupCandidate[];
  candidate_count: number;
  scanned_entry_count: number;
  scan_limit: number;
  scan_truncated: boolean;
  scan_complete: boolean;
  scan_notice: string;
  action: "proposal_only";
  deleted_files: [];
  proposal_path: string;
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".ai-bridge",
  ".codexpro",
  ".codexpro-local",
  "node_modules",
  "site-packages",
  ".venv",
  "venv",
  "__pycache__",
  "data",
  "backups",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache"
]);
const MAX_SCANNED_ENTRIES = 20_000;
const MAX_CANDIDATES = 200;

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function cleanupReason(relativePath: string): string | undefined {
  const basename = path.posix.basename(relativePath);
  if (/^(?:PLAN|TODO)(?:[-_.][^/]*)?\.md$/i.test(basename)) {
    return "一次性计划或待办文档，需由用户确认内容是否已并入正式文档。";
  }
  if (/^implementation[-_.]?notes(?:[-_.][^/]*)?\.md$/i.test(basename)) {
    return "实施过程记录，需由用户确认是否仍包含唯一有效信息。";
  }
  if (/\.(?:bak|old|backup|orig)$/i.test(basename)) {
    return "文件扩展名明确表示旧副本或备份副本，需由用户确认当前正式文件后再决定。";
  }
  return undefined;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizedHead(value: string): string | null {
  const head = value.trim();
  if (!head || head === "(no output)" || /fatal:|not a git repository|git unavailable/i.test(head)) return null;
  return head;
}

export async function createNeatFreakCleanupProposal(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string
): Promise<NeatFreakCleanupProposal> {
  const root = await fsp.realpath(workspace.root);
  const candidates: NeatFreakCleanupCandidate[] = [];
  let scannedEntries = 0;
  let scanTruncated = false;

  const visit = async (relativeDirectory: string): Promise<void> => {
    if (scanTruncated || candidates.length >= MAX_CANDIDATES) return;
    const absoluteDirectory = path.resolve(root, relativeDirectory);
    const entries = await fsp.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_ENTRIES) {
        scanTruncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(relativeDirectory, entry.name));
        if (scanTruncated || candidates.length >= MAX_CANDIDATES) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = portable(path.join(relativeDirectory, entry.name)).replace(/^\.\//, "");
      const reason = cleanupReason(relativePath);
      if (!reason) continue;
      const absolutePath = path.resolve(root, relativePath);
      const stat = await fsp.stat(absolutePath);
      candidates.push({
        path: relativePath,
        reason,
        sha256: await sha256File(absolutePath),
        size_bytes: stat.size,
        safe_to_delete: "pending_user_confirmation"
      });
      if (candidates.length >= MAX_CANDIDATES) {
        scanTruncated = true;
        return;
      }
    }
  };

  await visit(".");
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  const proposalPath = `.ai-bridge/neat-freak/cleanup-proposals/${runId}.json`;
  const proposal: NeatFreakCleanupProposal = {
    proposal_id: `nf-cleanup-${runId}`,
    created_at: new Date().toISOString(),
    project_head: normalizedHead(gitHeadSha(config, workspace)),
    candidates,
    candidate_count: candidates.length,
    scanned_entry_count: scannedEntries,
    scan_limit: MAX_SCANNED_ENTRIES,
    scan_truncated: scanTruncated,
    scan_complete: !scanTruncated,
    scan_notice: scanTruncated
      ? `扫描未完成：已达到 ${MAX_SCANNED_ENTRIES} 个目录项上限，候选清单不是整个工作区的完整结果。`
      : `扫描已完成：共检查 ${scannedEntries} 个目录项。`,
    action: "proposal_only",
    deleted_files: [],
    proposal_path: proposalPath
  };
  await writeTextFile(config, guard, workspace, proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, {
    createDirs: true,
    overwrite: true
  });
  return proposal;
}
