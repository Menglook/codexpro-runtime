import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import { captureRepositoryState, normalizeRepositoryChangedFiles, type RepositoryFileHash } from "./repositoryState.js";

export type SecurityReleaseReceiptMode = "incremental" | "full";
export type SecurityReleaseReceiptWriteStatus = "written" | "not_eligible" | "blocked" | "write_failed";

export interface SecurityReleaseReceiptBaselineSummary {
  status: "not_used" | "valid" | "missing" | "invalid";
  policy_path: string;
  baseline_path: string;
  policy_changed: boolean;
  baseline_changed: boolean;
  matched: number;
  stale: number;
  expired: number;
  new: number;
  suppressed: number;
  unmatched_entries: number;
}

export interface SecurityReleaseBlobHash {
  path: string;
  blob_sha: string;
}

export interface SecurityReleaseReceipt {
  version: 2;
  receipt_id: string;
  project_root: string;
  workspace_id: string;
  workspace_generation: number;
  branch: string;
  head_sha: string;
  commit_sha: string | null;
  mode: SecurityReleaseReceiptMode;
  rule_set_version: string;
  verdict: "allow";
  scan_complete: true;
  changed_files: string[];
  changed_files_hash: string;
  file_sha256: RepositoryFileHash[];
  blob_sha: SecurityReleaseBlobHash[];
  content_digest: string;
  policy_path: string;
  policy_sha256: string;
  baseline_path: string;
  baseline_sha256: string;
  baseline: SecurityReleaseReceiptBaselineSummary;
  created_at: string;
  expires_at: string;
  integrity_sha256: string;
}

export interface SecurityReleaseReceiptSummary {
  status: SecurityReleaseReceiptWriteStatus;
  path: string;
  eligible: boolean;
  receipt_id?: string;
  mode?: SecurityReleaseReceiptMode;
  changed_files_hash?: string;
  created_at?: string;
  expires_at?: string;
  reasons: string[];
}

export interface SecurityReleaseReceiptValidationResult {
  valid: boolean;
  path: string;
  reasons: string[];
  receipt?: SecurityReleaseReceipt;
  current_changed_files: string[];
  current_changed_files_hash?: string;
}

export interface SecurityReleaseReceiptWriteInput {
  mode: SecurityReleaseReceiptMode;
  rule_set_version: string;
  verdict: "allow" | "block" | "proposal";
  scan_complete: boolean;
  changed_files?: string[];
  baseline: SecurityReleaseReceiptBaselineSummary;
  now?: Date;
}

export interface SecurityReleaseReceiptSealInput {
  expected_paths: string[];
  commit_sha: string;
  rule_set_version: string;
}

const RECEIPT_TTL_MS = 2 * 60 * 60 * 1_000;

function receiptRelPath(config: CodexProConfig): string {
  return `${config.contextDir}/security-receipts/latest.json`;
}

function historyRelPath(config: CodexProConfig, receiptId: string): string {
  return `${config.contextDir}/security-receipts/history/${receiptId}.json`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptIntegrity(receipt: Omit<SecurityReleaseReceipt, "integrity_sha256">): string {
  return sha256(JSON.stringify(receipt));
}

async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const temporary = `${absPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, absPath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function persistReceipt(config: CodexProConfig, guard: PathGuard, workspace: Workspace, receipt: SecurityReleaseReceipt): Promise<void> {
  const latest = guard.resolve(workspace, receiptRelPath(config), { forWrite: true });
  const history = guard.resolve(workspace, historyRelPath(config, receipt.receipt_id), { forWrite: true });
  await writeJsonAtomic(history.absPath, receipt);
  await writeJsonAtomic(latest.absPath, receipt);
}

async function workspaceFileHash(guard: PathGuard, workspace: Workspace, relPath: string): Promise<string> {
  try {
    const resolved = guard.resolve(workspace, relPath);
    const bytes = await fsp.readFile(resolved.absPath);
    return sha256(bytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "missing" : "unreadable";
  }
}

function gitText(config: CodexProConfig, workspace: Workspace, args: string[]): string | undefined {
  const result = runProcessSync("git", args, {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 30_000,
    maxOutputBytes: config.maxOutputBytes,
    domain: "git",
    operation: args[0] ?? "git",
    sideEffectLevel: "local_read",
    riskLevel: "low",
    returnRawStdout: true,
    returnRawStderr: true
  });
  if (result.spawnError || result.exitCode !== 0) return undefined;
  return String(result.stdout ?? "").trim();
}

async function candidateBlobHashes(config: CodexProConfig, workspace: Workspace, files: string[]): Promise<SecurityReleaseBlobHash[]> {
  const hashes: SecurityReleaseBlobHash[] = [];
  for (const file of normalizeRepositoryChangedFiles(files)) {
    try {
      await fsp.lstat(path.resolve(workspace.root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hashes.push({ path: file, blob_sha: "deleted" });
        continue;
      }
      hashes.push({ path: file, blob_sha: "unreadable" });
      continue;
    }
    const blob = gitText(config, workspace, ["hash-object", `--path=${file}`, "--", file]);
    hashes.push({ path: file, blob_sha: blob && /^[a-f0-9]{40,64}$/i.test(blob) ? blob : "unreadable" });
  }
  return hashes;
}

function commitBlobHashes(config: CodexProConfig, workspace: Workspace, commitSha: string, files: string[]): SecurityReleaseBlobHash[] | undefined {
  const normalized = normalizeRepositoryChangedFiles(files);
  const output = gitText(config, workspace, ["ls-tree", "-r", "-z", commitSha, "--", ...normalized]);
  if (output === undefined) return undefined;
  const found = new Map<string, string>();
  for (const token of output.split("\0").filter(Boolean)) {
    const match = token.match(/^\d+\s+blob\s+([a-f0-9]{40,64})\t(.+)$/i);
    if (match) found.set(match[2].replace(/\\/g, "/"), match[1]);
  }
  return normalized.map((file) => ({ path: file, blob_sha: found.get(file) ?? "deleted" }));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isBlobHashes(value: unknown): value is SecurityReleaseBlobHash[] {
  return Array.isArray(value) && value.every((entry) => Boolean(entry)
    && typeof entry === "object"
    && typeof (entry as SecurityReleaseBlobHash).path === "string"
    && typeof (entry as SecurityReleaseBlobHash).blob_sha === "string");
}

function isReceipt(value: unknown): value is SecurityReleaseReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<SecurityReleaseReceipt>;
  return receipt.version === 2
    && typeof receipt.receipt_id === "string"
    && typeof receipt.project_root === "string"
    && typeof receipt.workspace_id === "string"
    && Number.isInteger(receipt.workspace_generation)
    && typeof receipt.branch === "string"
    && typeof receipt.head_sha === "string"
    && (receipt.commit_sha === null || typeof receipt.commit_sha === "string")
    && (receipt.mode === "incremental" || receipt.mode === "full")
    && typeof receipt.rule_set_version === "string"
    && receipt.verdict === "allow"
    && receipt.scan_complete === true
    && Array.isArray(receipt.changed_files)
    && typeof receipt.changed_files_hash === "string"
    && Array.isArray(receipt.file_sha256)
    && isBlobHashes(receipt.blob_sha)
    && typeof receipt.content_digest === "string"
    && typeof receipt.policy_path === "string"
    && typeof receipt.policy_sha256 === "string"
    && typeof receipt.baseline_path === "string"
    && typeof receipt.baseline_sha256 === "string"
    && Boolean(receipt.baseline && typeof receipt.baseline === "object")
    && typeof receipt.created_at === "string"
    && typeof receipt.expires_at === "string"
    && typeof receipt.integrity_sha256 === "string";
}

export async function readLatestSecurityReleaseReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<SecurityReleaseReceipt | undefined> {
  try {
    const resolved = guard.resolve(workspace, receiptRelPath(config));
    const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as unknown;
    return isReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSecurityReleaseReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: SecurityReleaseReceiptWriteInput
): Promise<SecurityReleaseReceiptSummary> {
  const relPath = receiptRelPath(config);
  const eligible = input.verdict === "allow" && input.scan_complete;
  if (!eligible) {
    return {
      status: input.verdict === "block" ? "blocked" : "not_eligible",
      path: relPath,
      eligible: false,
      reasons: [input.verdict === "block" ? "release_decision_blocked" : "release_mode_not_eligible"]
    };
  }

  try {
    const repository = await captureRepositoryState(config, workspace, {
      ...(input.changed_files ? { changed_files: input.changed_files } : {})
    });
    if (!repository.branch || !repository.head_sha) {
      return { status: "write_failed", path: relPath, eligible: true, reasons: ["repository_identity_unavailable"] };
    }
    const now = input.now ?? new Date();
    const receiptId = `security_${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const policySha = await workspaceFileHash(guard, workspace, input.baseline.policy_path);
    const baselineSha = await workspaceFileHash(guard, workspace, input.baseline.baseline_path);
    const unsigned: Omit<SecurityReleaseReceipt, "integrity_sha256"> = {
      version: 2,
      receipt_id: receiptId,
      project_root: path.resolve(workspace.root),
      workspace_id: workspace.id,
      workspace_generation: Math.max(1, Math.floor(workspace.workspaceGeneration ?? 1)),
      branch: repository.branch,
      head_sha: repository.head_sha,
      commit_sha: null,
      mode: input.mode,
      rule_set_version: input.rule_set_version,
      verdict: "allow",
      scan_complete: true,
      changed_files: repository.changed_files,
      changed_files_hash: repository.changed_files_hash,
      file_sha256: repository.file_sha256,
      blob_sha: await candidateBlobHashes(config, workspace, repository.changed_files),
      content_digest: repository.content_digest,
      policy_path: input.baseline.policy_path,
      policy_sha256: policySha,
      baseline_path: input.baseline.baseline_path,
      baseline_sha256: baselineSha,
      baseline: { ...input.baseline },
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString()
    };
    const receipt: SecurityReleaseReceipt = { ...unsigned, integrity_sha256: receiptIntegrity(unsigned) };
    await persistReceipt(config, guard, workspace, receipt);
    return {
      status: "written",
      path: relPath,
      eligible: true,
      receipt_id: receipt.receipt_id,
      mode: receipt.mode,
      changed_files_hash: receipt.changed_files_hash,
      created_at: receipt.created_at,
      expires_at: receipt.expires_at,
      reasons: []
    };
  } catch {
    return { status: "write_failed", path: relPath, eligible: true, reasons: ["receipt_write_failed"] };
  }
}

export async function sealLatestSecurityReleaseReceiptForCommit(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: SecurityReleaseReceiptSealInput
): Promise<SecurityReleaseReceiptValidationResult> {
  const relPath = receiptRelPath(config);
  const receipt = await readLatestSecurityReleaseReceipt(config, guard, workspace);
  const expectedPaths = normalizeRepositoryChangedFiles(input.expected_paths);
  if (!receipt) return { valid: false, path: relPath, reasons: ["security_receipt_missing_or_invalid"], current_changed_files: expectedPaths };

  const reasons: string[] = [];
  const { integrity_sha256: _integrity, ...unsigned } = receipt;
  if (receipt.integrity_sha256 !== receiptIntegrity(unsigned)) reasons.push("security_receipt_integrity_mismatch");
  if (path.resolve(workspace.root) !== path.resolve(receipt.project_root)) reasons.push("project_root_mismatch");
  if (receipt.workspace_id !== workspace.id) reasons.push("workspace_id_mismatch");
  if (receipt.workspace_generation !== Math.max(1, Math.floor(workspace.workspaceGeneration ?? 1))) reasons.push("workspace_generation_mismatch");
  if (receipt.rule_set_version !== input.rule_set_version) reasons.push("rule_set_version_mismatch");
  if (!sameJson(receipt.changed_files, expectedPaths)) reasons.push("changed_files_mismatch");
  const currentHead = gitText(config, workspace, ["rev-parse", "HEAD"]);
  if (currentHead !== input.commit_sha) reasons.push("head_sha_mismatch");
  const parentSha = gitText(config, workspace, ["rev-parse", `${input.commit_sha}^`]);
  if (receipt.head_sha !== input.commit_sha && receipt.head_sha !== parentSha) reasons.push("commit_parent_mismatch");
  const committedBlobs = commitBlobHashes(config, workspace, input.commit_sha, expectedPaths);
  if (!committedBlobs) reasons.push("commit_blob_identity_unavailable");
  else if (!sameJson(receipt.blob_sha, committedBlobs)) reasons.push("commit_blob_sha_mismatch");
  if (reasons.length) return { valid: false, path: relPath, reasons, receipt, current_changed_files: expectedPaths };

  const sealedUnsigned: Omit<SecurityReleaseReceipt, "integrity_sha256"> = {
    ...unsigned,
    commit_sha: input.commit_sha,
    blob_sha: committedBlobs as SecurityReleaseBlobHash[]
  };
  const sealed: SecurityReleaseReceipt = { ...sealedUnsigned, integrity_sha256: receiptIntegrity(sealedUnsigned) };
  try {
    await persistReceipt(config, guard, workspace, sealed);
  } catch {
    return { valid: false, path: relPath, reasons: ["receipt_write_failed"], receipt, current_changed_files: expectedPaths };
  }
  return {
    valid: true,
    path: relPath,
    reasons: [],
    receipt: sealed,
    current_changed_files: expectedPaths,
    current_changed_files_hash: sealed.changed_files_hash
  };
}

export async function validateLatestSecurityReleaseReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { expected_paths: string[]; rule_set_version: string; expected_commit_sha?: string; now?: Date }
): Promise<SecurityReleaseReceiptValidationResult> {
  const relPath = receiptRelPath(config);
  const receipt = await readLatestSecurityReleaseReceipt(config, guard, workspace);
  const expectedPaths = normalizeRepositoryChangedFiles(options.expected_paths);
  if (!receipt) {
    return { valid: false, path: relPath, reasons: ["security_receipt_missing_or_invalid"], current_changed_files: expectedPaths };
  }

  const reasons: string[] = [];
  const { integrity_sha256: _integrity, ...unsigned } = receipt;
  if (receipt.integrity_sha256 !== receiptIntegrity(unsigned)) reasons.push("security_receipt_integrity_mismatch");
  if (path.resolve(workspace.root) !== path.resolve(receipt.project_root)) reasons.push("project_root_mismatch");
  if (receipt.workspace_id !== workspace.id) reasons.push("workspace_id_mismatch");
  if (receipt.workspace_generation !== Math.max(1, Math.floor(workspace.workspaceGeneration ?? 1))) reasons.push("workspace_generation_mismatch");
  if (receipt.rule_set_version !== options.rule_set_version) reasons.push("rule_set_version_mismatch");
  const now = options.now ?? new Date();
  const expiresAt = Date.parse(receipt.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) reasons.push("security_receipt_expired");
  if (!sameJson(receipt.changed_files, expectedPaths)) reasons.push("changed_files_mismatch");

  let currentChangedFiles = expectedPaths;
  let currentChangedFilesHash = receipt.changed_files_hash;
  if (options.expected_commit_sha) {
    if (receipt.commit_sha !== options.expected_commit_sha) reasons.push("commit_sha_mismatch");
    const currentHead = gitText(config, workspace, ["rev-parse", "HEAD"]);
    if (currentHead !== options.expected_commit_sha) reasons.push("head_sha_mismatch");
    const committedBlobs = commitBlobHashes(config, workspace, options.expected_commit_sha, expectedPaths);
    if (!committedBlobs) reasons.push("commit_blob_identity_unavailable");
    else if (!sameJson(receipt.blob_sha, committedBlobs)) reasons.push("commit_blob_sha_mismatch");
  } else {
    const repository = await captureRepositoryState(config, workspace, { changed_files: expectedPaths });
    currentChangedFiles = repository.changed_files;
    currentChangedFilesHash = repository.changed_files_hash;
    if (!repository.branch || repository.branch !== receipt.branch) reasons.push("branch_mismatch");
    if (!repository.head_sha || repository.head_sha !== receipt.head_sha) reasons.push("head_sha_mismatch");
    if (!sameJson(repository.changed_files, receipt.changed_files)) reasons.push("changed_files_mismatch");
    if (repository.changed_files_hash !== receipt.changed_files_hash) reasons.push("changed_files_hash_mismatch");
    if (!sameJson(repository.file_sha256, receipt.file_sha256)) reasons.push("file_sha256_mismatch");
    if (repository.content_digest !== receipt.content_digest) reasons.push("content_digest_mismatch");
    const currentBlobs = await candidateBlobHashes(config, workspace, expectedPaths);
    if (!sameJson(currentBlobs, receipt.blob_sha)) reasons.push("candidate_blob_sha_mismatch");
  }
  if (gitText(config, workspace, ["branch", "--show-current"]) !== receipt.branch) reasons.push("branch_mismatch");
  if (await workspaceFileHash(guard, workspace, receipt.policy_path) !== receipt.policy_sha256) reasons.push("policy_digest_mismatch");
  if (await workspaceFileHash(guard, workspace, receipt.baseline_path) !== receipt.baseline_sha256) reasons.push("baseline_digest_mismatch");
  if (receipt.baseline.status === "missing" || receipt.baseline.status === "invalid") reasons.push("baseline_not_valid");
  if (receipt.baseline.expired > 0) reasons.push("baseline_expired");
  if (receipt.baseline.stale > 0) reasons.push("baseline_stale");

  return {
    valid: reasons.length === 0,
    path: relPath,
    reasons,
    receipt,
    current_changed_files: currentChangedFiles,
    current_changed_files_hash: currentChangedFilesHash
  };
}
