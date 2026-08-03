import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { captureRepositoryState, normalizeRepositoryChangedFiles } from "./repositoryState.js";

export type AcceptanceReceiptStatus = "passed" | "skipped";

export interface AcceptanceReceiptFileHash {
  path: string;
  sha256: string;
}

export interface AcceptanceReceiptReportSummary {
  path: string;
  sha256: string;
  size_bytes: number;
  validation_status: AcceptanceReceiptStatus;
  run_id: string | null;
  content_digest: string;
}

export interface AcceptanceReceipt {
  version: 1;
  run_id: string;
  workspace_id?: string;
  workspace_generation?: number;
  project_root: string;
  branch: string;
  head_sha: string;
  validation_status: AcceptanceReceiptStatus;
  report_path: string;
  cache_key: string | null;
  changed_files: string[];
  changed_files_hash: string;
  validated_tree_hash: string;
  file_sha256: AcceptanceReceiptFileHash[];
  content_digest: string;
  report_summary: AcceptanceReceiptReportSummary;
  artifact_digest?: string;
  acceptance_key?: string;
  input_hash?: string;
  receipt_key?: string;
  finished_at: string;
  written_at: string;
}

export interface AcceptanceReceiptWriteResult {
  written: boolean;
  path: string | null;
  reason?: string;
  receipt: AcceptanceReceipt | null;
  reused: boolean;
  preserved_previous?: boolean;
}

export interface AcceptanceReceiptValidationResult {
  valid: boolean;
  path: string;
  reasons: string[];
  receipt?: AcceptanceReceipt;
  current_branch?: string;
  current_head_sha?: string;
  current_changed_files: string[];
  current_changed_files_hash?: string;
}

export interface AcceptanceReceiptSource {
  run_id: string;
  completed_at: string;
  ok: boolean;
  status: string;
  report_path: string;
  changed_files: string[];
  cache_key: string | null;
  artifact_digest?: string;
  acceptance_key?: string;
  input_hash?: string;
}

const GENERATED_OR_DATA_PATH_PATTERN = /(^|\/)(?:node_modules|dist|build|\.next|coverage|\.cache|mysql|mysql-data|db_data)(?:\/|$)/i;
const SENSITIVE_DIRECTORY_PATTERN = /(^|\/)(?:secrets?|credentials?|private-config|tokens?|api-keys?)(?:\/|$)/i;
const SENSITIVE_FILE_PATTERN = /(^|\/)\.env(?:$|\.)|(^|\/)[^/]+\.(?:key|pem|p12|pfx)(?:$|\.)|(^|\/)(?:token|secret|password|credentials?)(?:\.(?:json|txt|ya?ml|env))?$|(^|\/)[^/]*(?:client-secret|api-key|access-token|refresh-token|private-key)[^/]*\.(?:json|txt|ya?ml|env)$/i;

function receiptRelPath(config: CodexProConfig): string {
  return `${config.contextDir}/acceptance-receipts/latest.json`;
}

function receiptHistoryRelPath(config: CodexProConfig, runId: string): string {
  const safeRunId = runId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "acceptance";
  return `${config.contextDir}/acceptance-receipts/history/${safeRunId}.json`;
}

function acceptanceReceiptKey(source: AcceptanceReceiptSource): string {
  return sha256(JSON.stringify([
    source.acceptance_key ?? source.cache_key ?? source.run_id,
    source.input_hash ?? source.cache_key ?? source.run_id
  ]));
}

function finalReceiptRelPath(config: CodexProConfig, receiptKey: string): string {
  return `${config.contextDir}/acceptance-receipts/final/${receiptKey}.json`;
}

export function normalizeAcceptanceChangedFiles(files: string[]): string[] {
  return normalizeRepositoryChangedFiles(files);
}

export function acceptanceReceiptHasSensitivePaths(files: string[]): boolean {
  return files.some((file) => {
    const normalized = file.replace(/\\/g, "/");
    return GENERATED_OR_DATA_PATH_PATTERN.test(normalized)
      || SENSITIVE_DIRECTORY_PATTERN.test(normalized)
      || SENSITIVE_FILE_PATTERN.test(normalized);
  });
}

function validatedTreeHash(branch: string, headSha: string, changedFilesHash: string): string {
  return createHash("sha256").update(JSON.stringify({ branch, head_sha: headSha, changed_files_hash: changedFilesHash })).digest("hex");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function acceptanceArtifactDigest(input: {
  run_id: string;
  cache_key: string | null;
  report_path: string;
  report_sha256: string;
}): string {
  return sha256(JSON.stringify({
    run_id: input.run_id,
    cache_key: input.cache_key,
    report_path: input.report_path,
    report_sha256: input.report_sha256
  }));
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

async function writeJsonExclusive(absPath: string, value: unknown): Promise<boolean> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const temporary = `${absPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await fsp.link(temporary, absPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readReceiptAt(absPath: string): Promise<AcceptanceReceipt | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(absPath, "utf8"));
    return isAcceptanceReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function reportRunId(report: string): string | null {
  return report.match(/(?:^|\n)\s*(?:[-*]\s*)?run[_\s-]*id\s*:\s*`?([^`\n]+?)`?\s*(?:\n|$)/i)?.[1]?.trim() || null;
}

async function summarizeReport(
  guard: PathGuard,
  workspace: Workspace,
  reportPath: string,
  expectedStatus: AcceptanceReceiptStatus
): Promise<AcceptanceReceiptReportSummary | undefined> {
  try {
    const resolved = guard.resolve(workspace, reportPath);
    const report = await fsp.readFile(resolved.absPath, "utf8");
    if (!report.trim()) return undefined;
    const explicit = report.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:validation[_\s-]*|overall\s+)?status\s*:\s*(passed|skipped)\b/i)?.[1]?.toLowerCase();
    if (explicit && explicit !== expectedStatus) return undefined;
    if (!explicit && expectedStatus === "passed" && !/(?:^|\n)\s*(?:result\s*:\s*)?pass(?:ed)?\s*(?:\n|$)/i.test(report)) return undefined;
    const relativePath = path.relative(workspace.root, resolved.absPath).replace(/\\/g, "/");
    const reportSha = sha256(report);
    const sizeBytes = Buffer.byteLength(report, "utf8");
    const runId = reportRunId(report);
    return {
      path: relativePath,
      sha256: reportSha,
      size_bytes: sizeBytes,
      validation_status: expectedStatus,
      run_id: runId,
      content_digest: sha256(JSON.stringify([relativePath, reportSha, sizeBytes, expectedStatus, runId]))
    };
  } catch {
    return undefined;
  }
}

function isAcceptanceReceipt(value: unknown): value is AcceptanceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.version === 1
    && typeof receipt.run_id === "string"
    && (receipt.workspace_id === undefined || typeof receipt.workspace_id === "string")
    && (receipt.workspace_generation === undefined || (typeof receipt.workspace_generation === "number" && Number.isInteger(receipt.workspace_generation)))
    && typeof receipt.project_root === "string"
    && typeof receipt.branch === "string"
    && typeof receipt.head_sha === "string"
    && (receipt.validation_status === "passed" || receipt.validation_status === "skipped")
    && typeof receipt.report_path === "string"
    && Array.isArray(receipt.changed_files)
    && receipt.changed_files.every((item) => typeof item === "string")
    && typeof receipt.changed_files_hash === "string"
    && typeof receipt.validated_tree_hash === "string"
    && Array.isArray(receipt.file_sha256)
    && receipt.file_sha256.every((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).sha256 === "string")
    && typeof receipt.content_digest === "string"
    && Boolean(receipt.report_summary && typeof receipt.report_summary === "object")
    && typeof receipt.finished_at === "string"
    && typeof receipt.written_at === "string";
}

export async function invalidateLatestAcceptanceReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<void> {
  const resolved = guard.resolve(workspace, receiptRelPath(config));
  try {
    await fsp.unlink(resolved.absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function readLatestAcceptanceReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<AcceptanceReceipt | undefined> {
  try {
    const resolved = guard.resolve(workspace, receiptRelPath(config));
    const parsed: unknown = JSON.parse(await fsp.readFile(resolved.absPath, "utf8"));
    return isAcceptanceReceipt(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLatestAcceptanceReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  source: AcceptanceReceiptSource
): Promise<AcceptanceReceiptWriteResult> {
  const relPath = receiptRelPath(config);
  if (!source.ok || source.status !== "passed") {
    const previous = await readLatestAcceptanceReceipt(config, guard, workspace);
    return {
      written: false,
      path: previous ? relPath : null,
      receipt: null,
      reused: false,
      preserved_previous: Boolean(previous),
      reason: source.status === "skipped" ? "acceptance_not_passed" : "acceptance_not_successful"
    };
  }
  const normalizedFiles = normalizeAcceptanceChangedFiles(source.changed_files);
  if (acceptanceReceiptHasSensitivePaths(normalizedFiles)) {
    const previous = await readLatestAcceptanceReceipt(config, guard, workspace);
    return { written: false, path: previous ? relPath : null, receipt: null, reused: false, preserved_previous: Boolean(previous), reason: "sensitive_changed_files" };
  }
  const reportSummary = await summarizeReport(guard, workspace, source.report_path, source.status);
  if (!reportSummary || (reportSummary.run_id && reportSummary.run_id !== source.run_id)) {
    const previous = await readLatestAcceptanceReceipt(config, guard, workspace);
    return { written: false, path: previous ? relPath : null, receipt: null, reused: false, preserved_previous: Boolean(previous), reason: "invalid_acceptance_report" };
  }
  const artifactDigest = acceptanceArtifactDigest({
    run_id: source.run_id,
    cache_key: source.cache_key,
    report_path: reportSummary.path,
    report_sha256: reportSummary.sha256
  });
  if (source.artifact_digest && source.artifact_digest !== artifactDigest) {
    const previous = await readLatestAcceptanceReceipt(config, guard, workspace);
    return { written: false, path: previous ? relPath : null, receipt: null, reused: false, preserved_previous: Boolean(previous), reason: "artifact_digest_mismatch" };
  }
  const repository = await captureRepositoryState(config, workspace, { changed_files: normalizedFiles });
  const branch = repository.branch ?? "HEAD";
  const headSha = repository.head_sha ?? "unknown";

  const receiptKey = acceptanceReceiptKey(source);
  const receipt: AcceptanceReceipt = {
    version: 1,
    run_id: source.run_id,
    workspace_id: workspace.id,
    ...(workspace.workspaceGeneration !== undefined ? { workspace_generation: workspace.workspaceGeneration } : {}),
    acceptance_key: source.acceptance_key ?? source.cache_key ?? source.run_id,
    input_hash: source.input_hash ?? source.cache_key ?? source.run_id,
    receipt_key: receiptKey,
    project_root: path.resolve(workspace.root),
    branch,
    head_sha: headSha,
    validation_status: source.status,
    report_path: source.report_path,
    cache_key: source.cache_key,
    changed_files: repository.changed_files,
    changed_files_hash: repository.changed_files_hash,
    validated_tree_hash: validatedTreeHash(branch, headSha, repository.changed_files_hash),
    file_sha256: repository.file_sha256,
    content_digest: repository.content_digest,
    report_summary: reportSummary,
    artifact_digest: artifactDigest,
    finished_at: source.completed_at,
    written_at: new Date().toISOString()
  };

  try {
    const resolved = guard.resolve(workspace, relPath, { forWrite: true });
    const final = guard.resolve(workspace, finalReceiptRelPath(config, receiptKey), { forWrite: true });
    const won = await writeJsonExclusive(final.absPath, receipt);
    const authoritative = won ? receipt : await readReceiptAt(final.absPath);
    if (!authoritative) return { written: false, path: null, receipt: null, reused: false, reason: "write_failed" };
    if (won) {
      const history = guard.resolve(workspace, receiptHistoryRelPath(config, authoritative.run_id), { forWrite: true });
      await writeJsonAtomic(history.absPath, authoritative);
    }
    await writeJsonAtomic(resolved.absPath, authoritative);
    return {
      written: won,
      path: relPath,
      receipt: authoritative,
      reused: !won,
      reason: won ? "written" : "reused_final_receipt"
    };
  } catch {
    return { written: false, path: null, receipt: null, reused: false, reason: "write_failed" };
  }
}

export async function validateAcceptanceReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  receipt: AcceptanceReceipt,
  options: { changedFiles?: string[]; receiptPath?: string } = {}
): Promise<AcceptanceReceiptValidationResult> {
  const relPath = options.receiptPath ?? receiptRelPath(config);
  const reasons: string[] = [];
  const repository = await captureRepositoryState(
    config,
    workspace,
    options.changedFiles ? { changed_files: options.changedFiles } : {}
  );
  const currentBranch = repository.branch ?? undefined;
  const currentHeadSha = repository.head_sha ?? undefined;
  const currentChangedFiles = repository.changed_files;

  if (receipt.workspace_id !== undefined && receipt.workspace_id !== workspace.id) reasons.push("workspace_id_mismatch");
  if (workspace.workspaceGeneration !== undefined && receipt.workspace_generation !== workspace.workspaceGeneration) reasons.push("workspace_generation_mismatch");
  if (path.resolve(workspace.root) !== path.resolve(receipt.project_root)) reasons.push("project_root_mismatch");
  if (!currentBranch || currentBranch !== receipt.branch) reasons.push("branch_mismatch");
  if (!currentHeadSha || currentHeadSha !== receipt.head_sha) reasons.push("head_sha_mismatch");
  if (acceptanceReceiptHasSensitivePaths(currentChangedFiles)) reasons.push("sensitive_changed_files");
  if (JSON.stringify(currentChangedFiles) !== JSON.stringify(receipt.changed_files)) reasons.push("changed_files_mismatch");
  if (repository.changed_files_hash !== receipt.changed_files_hash) reasons.push("changed_files_hash_mismatch");
  if (JSON.stringify(repository.file_sha256) !== JSON.stringify(receipt.file_sha256)) reasons.push("file_sha256_mismatch");
  if (repository.content_digest !== receipt.content_digest) reasons.push("content_digest_mismatch");
  const reportSummary = await summarizeReport(guard, workspace, receipt.report_path, receipt.validation_status);
  if (!reportSummary) reasons.push("report_missing");
  else {
    if (JSON.stringify(reportSummary) !== JSON.stringify(receipt.report_summary)) reasons.push("report_digest_mismatch");
    if (receipt.artifact_digest && receipt.artifact_digest !== acceptanceArtifactDigest({
      run_id: receipt.run_id,
      cache_key: receipt.cache_key,
      report_path: reportSummary.path,
      report_sha256: reportSummary.sha256
    })) reasons.push("artifact_digest_mismatch");
  }
  if (currentBranch && currentHeadSha && validatedTreeHash(currentBranch, currentHeadSha, repository.changed_files_hash) !== receipt.validated_tree_hash) {
    reasons.push("validated_tree_hash_mismatch");
  }

  return {
    valid: reasons.length === 0,
    path: relPath,
    reasons,
    receipt,
    ...(currentBranch ? { current_branch: currentBranch } : {}),
    ...(currentHeadSha ? { current_head_sha: currentHeadSha } : {}),
    current_changed_files: currentChangedFiles,
    current_changed_files_hash: repository.changed_files_hash
  };
}

export async function validateLatestAcceptanceReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { changedFiles?: string[] } = {}
): Promise<AcceptanceReceiptValidationResult> {
  const relPath = receiptRelPath(config);
  const receipt = await readLatestAcceptanceReceipt(config, guard, workspace);
  if (!receipt) return { valid: false, path: relPath, reasons: ["receipt_missing_or_invalid"], current_changed_files: [] };
  return await validateAcceptanceReceipt(config, guard, workspace, receipt, { ...options, receiptPath: relPath });
}
