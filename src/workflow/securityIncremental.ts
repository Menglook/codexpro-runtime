import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, isSubpath, normalizeRelPath, type PathGuard, type Workspace } from "../guard.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import {
  runSecurityAudit,
  type SecurityCategory,
  type SecurityFindingV2,
  type SecuritySeverity
} from "./securityAudit.js";
import {
  DEFAULT_SECURITY_BASELINE_PATH,
  DEFAULT_SECURITY_POLICY_PATH,
  applySecurityBaseline,
  loadSecurityBaselineFile,
  loadSecurityPolicyFile,
  type SecurityBaselineEntry,
  type SecurityBaselineFile,
  type SecurityPolicyFile
} from "./securityBaseline.js";

export type SecurityIncrementalChangeSource = "committed" | "staged" | "worktree" | "untracked";
export type SecurityIncrementalChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unmerged"
  | "unknown";
export type SecurityIncrementalLifecycle = "new" | "existing" | "resolved" | "expired" | "stale";

export interface SecurityIncrementalChange {
  source: SecurityIncrementalChangeSource;
  status: SecurityIncrementalChangeStatus;
  path: string;
  old_path?: string;
  similarity?: number;
}

export interface SecurityIncrementalScanIssue {
  path?: string;
  phase: "git" | "current_scan" | "base_scan" | "baseline";
  code: string;
  message: string;
}

export interface SecurityIncrementalFileScan {
  path: string;
  snapshot: "current" | "git_base";
  size_bytes: number;
  scanned_files: number;
  skipped_files: number;
  finding_count: number;
  complete: boolean;
}

export interface SecurityIncrementalFindingRecord {
  lifecycle: SecurityIncrementalLifecycle;
  source: "current" | "git_base" | "baseline";
  reason_code:
    | "new_change_finding"
    | "git_base_exact_match"
    | "baseline_exact_match"
    | "baseline_expired"
    | "baseline_stale"
    | "removed_from_candidate"
    | "deleted_baseline_entry";
  path: string;
  rule: string;
  rule_version: string;
  fingerprint: string;
  severity: SecuritySeverity;
  category: SecurityCategory;
  change_sources: SecurityIncrementalChangeSource[];
  finding?: SecurityFindingV2;
  baseline_entry_id?: string;
}

export interface SecurityIncrementalCounts {
  new: number;
  existing: number;
  resolved: number;
  expired: number;
  stale: number;
}

export interface SecurityIncrementalResult {
  ok: boolean;
  status: "pass" | "warn" | "fail";
  scan_type: "git_incremental_security_check";
  root: string;
  head_sha: string;
  upstream_ref: string;
  upstream_sha: string;
  merge_base_sha: string;
  changes: SecurityIncrementalChange[];
  changed_files: string[];
  deleted_files: string[];
  renamed_files: Array<{ from: string; to: string }>;
  untracked_files: string[];
  file_scans: SecurityIncrementalFileScan[];
  issues: SecurityIncrementalScanIssue[];
  counts: SecurityIncrementalCounts;
  findings: SecurityIncrementalFindingRecord[];
  text: string;
}

export interface SecurityIncrementalOptions {
  base_ref?: string;
  upstream_ref?: string;
  policy_path?: string;
  baseline_path?: string;
  large_file_bytes?: number;
  max_changed_file_bytes?: number;
  fail_on_warnings?: boolean;
  cache_enabled?: boolean;
  candidate_paths?: string[];
  now?: Date;
}

export type SecurityIncrementalErrorCode =
  | "git_unavailable"
  | "git_not_repository"
  | "git_upstream_unavailable"
  | "git_merge_base_unavailable"
  | "git_diff_unavailable"
  | "git_blob_unavailable"
  | "baseline_unavailable"
  | "changed_file_too_large"
  | "changed_file_scan_incomplete";

export class SecurityIncrementalError extends CodexProError {
  readonly code: SecurityIncrementalErrorCode;

  constructor(code: SecurityIncrementalErrorCode, message: string) {
    super(message);
    this.name = "SecurityIncrementalError";
    this.code = code;
  }
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  errorClass?: string;
}

const DEFAULT_MAX_CHANGED_FILE_BYTES = 25_000_000;
const HARD_MAX_CHANGED_FILE_BYTES = 200_000_000;
const GIT_METADATA_OUTPUT_BYTES = 20_000_000;

function normalizedPath(value: string): string {
  const normalized = normalizeRelPath(value.trim().replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new SecurityIncrementalError("git_diff_unavailable", `Git returned an unsafe repository path: ${value}`);
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function filterCandidateChanges(
  changes: SecurityIncrementalChange[],
  candidatePaths: string[] | undefined
): SecurityIncrementalChange[] {
  if (!candidatePaths?.length) return changes;
  const selected = new Set(candidatePaths.map(normalizedPath));
  const filtered = changes.filter((change) => selected.has(change.path) || Boolean(change.old_path && selected.has(change.old_path)));
  const represented = new Set(filtered.flatMap((change) => [change.path, ...(change.old_path ? [change.old_path] : [])]));
  const missing = [...selected].filter((candidate) => !represented.has(candidate));
  if (missing.length) {
    throw new SecurityIncrementalError(
      "git_diff_unavailable",
      `Requested release candidate paths are not present in the current Git change set: ${missing.join(", ")}`
    );
  }
  return filtered;
}

function runGitRaw(
  workspace: Workspace,
  args: string[],
  maxOutputBytes = GIT_METADATA_OUTPUT_BYTES
): GitCommandResult {
  const result = runProcessSync("git", args, {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: 30_000,
    maxOutputBytes,
    domain: "git",
    operation: args[0] ?? "git",
    sideEffectLevel: "local_read",
    riskLevel: "low",
    returnRawStdout: true,
    returnRawStderr: false,
    componentTracking: false,
    lifecycleTracking: false,
    recordTracking: false,
    usageTracking: false
  });
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    exitCode: result.exitCode,
    truncated: Boolean(result.truncated),
    ...(result.errorClass ? { errorClass: result.errorClass } : {})
  };
}

function requireGitText(
  workspace: Workspace,
  args: string[],
  code: SecurityIncrementalErrorCode,
  label: string
): string {
  const result = runGitRaw(workspace, args);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.errorClass || `exit ${result.exitCode ?? "unknown"}`;
    throw new SecurityIncrementalError(code, `${label} failed: ${reason}`);
  }
  if (result.truncated) throw new SecurityIncrementalError(code, `${label} output exceeded the bounded Git read limit`);
  const text = result.stdout.trim();
  if (!text) throw new SecurityIncrementalError(code, `${label} returned no result`);
  return text;
}

function statusFromCode(code: string): { status: SecurityIncrementalChangeStatus; similarity?: number } {
  const kind = code[0] ?? "";
  const similarityText = code.slice(1);
  const similarity = similarityText ? Number.parseInt(similarityText, 10) : undefined;
  if (kind === "A") return { status: "added" };
  if (kind === "M") return { status: "modified" };
  if (kind === "D") return { status: "deleted" };
  if (kind === "R") return { status: "renamed", ...(Number.isFinite(similarity) ? { similarity } : {}) };
  if (kind === "C") return { status: "copied", ...(Number.isFinite(similarity) ? { similarity } : {}) };
  if (kind === "T") return { status: "type_changed" };
  if (kind === "U") return { status: "unmerged" };
  return { status: "unknown" };
}

function parseNameStatusZ(value: string, source: SecurityIncrementalChangeSource): SecurityIncrementalChange[] {
  const tokens = value.split("\0").filter(Boolean);
  const changes: SecurityIncrementalChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index++] ?? "";
    const decoded = statusFromCode(code);
    if (decoded.status === "renamed" || decoded.status === "copied") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        throw new SecurityIncrementalError("git_diff_unavailable", `Malformed Git ${source} rename record`);
      }
      changes.push({
        source,
        status: decoded.status,
        old_path: normalizedPath(oldPath),
        path: normalizedPath(newPath),
        ...(decoded.similarity !== undefined ? { similarity: decoded.similarity } : {})
      });
      continue;
    }
    const filePath = tokens[index++];
    if (!filePath) throw new SecurityIncrementalError("git_diff_unavailable", `Malformed Git ${source} change record`);
    changes.push({ source, status: decoded.status, path: normalizedPath(filePath) });
  }
  return changes;
}

function readDiffChanges(
  workspace: Workspace,
  args: string[],
  source: SecurityIncrementalChangeSource
): SecurityIncrementalChange[] {
  const result = runGitRaw(workspace, args);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.errorClass || `exit ${result.exitCode ?? "unknown"}`;
    throw new SecurityIncrementalError("git_diff_unavailable", `Git ${source} diff failed: ${reason}`);
  }
  if (result.truncated) {
    throw new SecurityIncrementalError("git_diff_unavailable", `Git ${source} diff output exceeded the bounded read limit`);
  }
  return parseNameStatusZ(result.stdout, source);
}

function readUntrackedChanges(workspace: Workspace): SecurityIncrementalChange[] {
  const result = runGitRaw(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.errorClass || `exit ${result.exitCode ?? "unknown"}`;
    throw new SecurityIncrementalError("git_diff_unavailable", `Git untracked file discovery failed: ${reason}`);
  }
  if (result.truncated) {
    throw new SecurityIncrementalError("git_diff_unavailable", "Git untracked file output exceeded the bounded read limit");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ source: "untracked" as const, status: "added" as const, path: normalizedPath(file) }));
}

function sourcesForPath(changes: SecurityIncrementalChange[], filePath: string, historical = false): SecurityIncrementalChangeSource[] {
  return uniqueStrings(changes
    .filter((change) => historical ? (change.old_path ?? change.path) === filePath : change.path === filePath)
    .map((change) => change.source)) as SecurityIncrementalChangeSource[];
}

function currentCandidatePaths(changes: SecurityIncrementalChange[]): string[] {
  return uniqueStrings(changes
    .filter((change) => change.status !== "deleted")
    .map((change) => change.path));
}

function readGitBasePaths(workspace: Workspace, mergeBaseSha: string): Set<string> {
  const result = runGitRaw(workspace, ["ls-tree", "-r", "-z", "--name-only", mergeBaseSha]);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.errorClass || `exit ${result.exitCode ?? "unknown"}`;
    throw new SecurityIncrementalError("git_diff_unavailable", `Git-base path discovery failed: ${reason}`);
  }
  if (result.truncated) {
    throw new SecurityIncrementalError("git_diff_unavailable", "Git-base path output exceeded the bounded read limit");
  }
  return new Set(result.stdout.split("\0").filter(Boolean).map((filePath) => normalizedPath(filePath)));
}

function baseCandidatePaths(changes: SecurityIncrementalChange[], basePaths: Set<string>): string[] {
  const candidates = changes.flatMap((change) => {
    if (change.status === "renamed") return [change.old_path, change.path].filter(Boolean) as string[];
    if (change.status === "copied") return [change.path];
    return [change.path];
  });
  return uniqueStrings(candidates).filter((filePath) => basePaths.has(filePath));
}

function deletedPaths(changes: SecurityIncrementalChange[]): string[] {
  return uniqueStrings(changes.flatMap((change) => {
    if (change.status === "deleted") return [change.path];
    if (change.status === "renamed") return change.old_path ? [change.old_path] : [];
    return [];
  }));
}

function scanConfig(config: CodexProConfig): CodexProConfig {
  return { ...config, blockedGlobs: [] };
}

function changedFileLimit(options: SecurityIncrementalOptions): number {
  const requested = options.max_changed_file_bytes;
  if (!Number.isFinite(requested)) return DEFAULT_MAX_CHANGED_FILE_BYTES;
  return Math.max(1_000, Math.min(Math.floor(requested as number), HARD_MAX_CHANGED_FILE_BYTES));
}

async function scanCurrentFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  paths: string[],
  options: SecurityIncrementalOptions
): Promise<{ findings: SecurityFindingV2[]; scans: SecurityIncrementalFileScan[]; issues: SecurityIncrementalScanIssue[] }> {
  const findings: SecurityFindingV2[] = [];
  const scans: SecurityIncrementalFileScan[] = [];
  const issues: SecurityIncrementalScanIssue[] = [];
  const maximum = changedFileLimit(options);
  const fullScanConfig = scanConfig(config);

  for (const filePath of paths) {
    const absolute = path.resolve(workspace.root, filePath);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(absolute);
    } catch {
      issues.push({ path: filePath, phase: "current_scan", code: "changed_file_missing", message: "Changed file disappeared before scanning" });
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      issues.push({ path: filePath, phase: "current_scan", code: "changed_path_not_file", message: "Changed path is not a regular file" });
      continue;
    }
    if (stat.size > maximum) {
      issues.push({
        path: filePath,
        phase: "current_scan",
        code: "changed_file_too_large",
        message: `Changed file is ${stat.size} bytes, above the explicit ${maximum}-byte incremental scan limit`
      });
      scans.push({ path: filePath, snapshot: "current", size_bytes: stat.size, scanned_files: 0, skipped_files: 1, finding_count: 0, complete: false });
      continue;
    }
    const result = await runSecurityAudit(fullScanConfig, guard, workspace, {
      path: filePath,
      max_files: 1,
      max_file_bytes: Math.max(1_000, stat.size + 1),
      large_file_bytes: options.large_file_bytes,
      include_generated: true,
      cache_enabled: options.cache_enabled
    });
    const complete = result.scanned_files === 1 || result.findings.some((finding) => finding.rule === "sensitive_file_path");
    scans.push({
      path: filePath,
      snapshot: "current",
      size_bytes: stat.size,
      scanned_files: result.scanned_files,
      skipped_files: result.skipped_files,
      finding_count: result.findings.length,
      complete
    });
    findings.push(...result.findings);
    if (!complete) {
      issues.push({
        path: filePath,
        phase: "current_scan",
        code: "changed_file_scan_incomplete",
        message: "Changed file was not fully scanned; binary or unsupported content requires explicit review"
      });
    }
  }
  return { findings: deduplicateFindings(findings), scans, issues };
}

async function readGitBlob(workspace: Workspace, revision: string, filePath: string, maximum: number): Promise<string> {
  const result = runGitRaw(workspace, ["show", `${revision}:${filePath}`], maximum + 1_000_000);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.errorClass || `exit ${result.exitCode ?? "unknown"}`;
    throw new SecurityIncrementalError("git_blob_unavailable", `Cannot read Git-base file ${filePath}: ${reason}`);
  }
  if (result.truncated) {
    throw new SecurityIncrementalError("git_blob_unavailable", `Git-base file ${filePath} output was truncated`);
  }
  if (Buffer.byteLength(result.stdout, "utf8") > maximum) {
    throw new SecurityIncrementalError(
      "changed_file_too_large",
      `Git-base file ${filePath} exceeds the explicit ${maximum}-byte incremental scan limit`
    );
  }
  return result.stdout;
}

async function scanBaseFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  mergeBaseSha: string,
  paths: string[],
  options: SecurityIncrementalOptions
): Promise<{ findings: SecurityFindingV2[]; scans: SecurityIncrementalFileScan[]; issues: SecurityIncrementalScanIssue[] }> {
  const findings: SecurityFindingV2[] = [];
  const scans: SecurityIncrementalFileScan[] = [];
  const issues: SecurityIncrementalScanIssue[] = [];
  const maximum = changedFileLimit(options);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-security-git-base-"));
  const tempWorkspace: Workspace = {
    id: `git-base-${mergeBaseSha.slice(0, 12)}`,
    root: tempRoot,
    openedAt: new Date().toISOString()
  };
  const fullScanConfig = scanConfig(config);

  try {
    for (const filePath of paths) {
      let raw: string;
      try {
        raw = await readGitBlob(workspace, mergeBaseSha, filePath, maximum);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push({ path: filePath, phase: "base_scan", code: "git_blob_unavailable", message });
        continue;
      }
      const target = path.resolve(tempRoot, filePath);
      const relative = path.relative(tempRoot, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new SecurityIncrementalError("git_blob_unavailable", `Git-base path escapes temporary scan root: ${filePath}`);
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, raw, "utf8");
      const size = Buffer.byteLength(raw, "utf8");
      const result = await runSecurityAudit(fullScanConfig, guard, tempWorkspace, {
        path: filePath,
        max_files: 1,
        max_file_bytes: Math.max(1_000, size + 1),
        large_file_bytes: options.large_file_bytes,
        include_generated: true,
        cache_enabled: options.cache_enabled
      });
      const complete = result.scanned_files === 1 || result.findings.some((finding) => finding.rule === "sensitive_file_path");
      scans.push({
        path: filePath,
        snapshot: "git_base",
        size_bytes: size,
        scanned_files: result.scanned_files,
        skipped_files: result.skipped_files,
        finding_count: result.findings.length,
        complete
      });
      findings.push(...result.findings);
      if (!complete) {
        issues.push({
          path: filePath,
          phase: "base_scan",
          code: "git_base_file_scan_incomplete",
          message: "Git-base file was not fully scanned; historical comparison is incomplete"
        });
      }
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
  return { findings: deduplicateFindings(findings), scans, issues };
}

function deduplicateFindings(findings: SecurityFindingV2[]): SecurityFindingV2[] {
  const byFingerprint = new Map<string, SecurityFindingV2>();
  for (const finding of findings) byFingerprint.set(finding.fingerprint, finding);
  return [...byFingerprint.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule) || left.fingerprint.localeCompare(right.fingerprint)
  ));
}

async function workspaceFileExists(workspaceRoot: string, relativePath: string): Promise<boolean> {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  if (!isSubpath(absolutePath, workspaceRoot)) {
    throw new SecurityIncrementalError(
      "baseline_unavailable",
      `Security policy or baseline path escapes the workspace: ${relativePath}`
    );
  }
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function loadOptionalBaseline(
  workspace: Workspace,
  options: SecurityIncrementalOptions
): Promise<{ policy?: SecurityPolicyFile; baseline?: SecurityBaselineFile }> {
  const policyPath = options.policy_path?.trim() || DEFAULT_SECURITY_POLICY_PATH;
  const explicitBaselinePath = options.baseline_path?.trim();
  const policyExists = await workspaceFileExists(workspace.root, policyPath);
  const defaultBaselineExists = await workspaceFileExists(
    workspace.root,
    explicitBaselinePath || DEFAULT_SECURITY_BASELINE_PATH
  );
  const explicitlyRequested = Boolean(options.policy_path?.trim() || explicitBaselinePath);
  if (!policyExists && !defaultBaselineExists && !explicitlyRequested) return {};
  if (!policyExists) {
    throw new SecurityIncrementalError(
      "baseline_unavailable",
      `Security baseline comparison requires policy file ${policyPath}`
    );
  }
  const policy = await loadSecurityPolicyFile(workspace.root, policyPath);
  const baselinePath = explicitBaselinePath || policy.baseline.default_path;
  if (!(await workspaceFileExists(workspace.root, baselinePath))) {
    throw new SecurityIncrementalError(
      "baseline_unavailable",
      `Security baseline comparison requires baseline file ${baselinePath}`
    );
  }
  const baseline = await loadSecurityBaselineFile(workspace.root, baselinePath, policy);
  return { policy, baseline };
}

function resolvedBaselineRecords(
  baseline: SecurityBaselineFile | undefined,
  removedPaths: Set<string>,
  existingFingerprints: Set<string>,
  changes: SecurityIncrementalChange[]
): SecurityIncrementalFindingRecord[] {
  if (!baseline) return [];
  const records: SecurityIncrementalFindingRecord[] = [];
  for (const entry of baseline.entries) {
    if (!removedPaths.has(entry.finding.path) || existingFingerprints.has(entry.finding.fingerprint)) continue;
    records.push(recordFromBaselineEntry(entry, changes));
  }
  return records;
}

function recordFromBaselineEntry(entry: SecurityBaselineEntry, changes: SecurityIncrementalChange[]): SecurityIncrementalFindingRecord {
  return {
    lifecycle: "resolved",
    source: "baseline",
    reason_code: "deleted_baseline_entry",
    path: entry.finding.path,
    rule: entry.finding.rule,
    rule_version: entry.finding.rule_version,
    fingerprint: entry.finding.fingerprint,
    severity: "info",
    category: "scan",
    change_sources: sourcesForPath(changes, entry.finding.path, true),
    baseline_entry_id: entry.entry_id
  };
}

function classifyFindings(
  current: SecurityFindingV2[],
  base: SecurityFindingV2[],
  baseline: SecurityBaselineFile | undefined,
  changes: SecurityIncrementalChange[]
): SecurityIncrementalFindingRecord[] {
  const baseFingerprints = new Set(base.map((finding) => finding.fingerprint));
  const currentFingerprints = new Set(current.map((finding) => finding.fingerprint));
  const stalePathRule = new Set(current
    .filter((finding) => finding.baseline_status === "stale")
    .map((finding) => `${finding.path}\0${finding.rule}`));
  const records: SecurityIncrementalFindingRecord[] = [];

  for (const finding of current) {
    let lifecycle: SecurityIncrementalLifecycle;
    let reasonCode: SecurityIncrementalFindingRecord["reason_code"];
    if (finding.baseline_status === "expired") {
      lifecycle = "expired";
      reasonCode = "baseline_expired";
    } else if (finding.baseline_status === "stale") {
      lifecycle = "stale";
      reasonCode = "baseline_stale";
    } else if (finding.baseline_status === "matched") {
      lifecycle = "existing";
      reasonCode = "baseline_exact_match";
    } else if (baseFingerprints.has(finding.fingerprint)) {
      lifecycle = "existing";
      reasonCode = "git_base_exact_match";
    } else {
      lifecycle = "new";
      reasonCode = "new_change_finding";
    }
    records.push({
      lifecycle,
      source: "current",
      reason_code: reasonCode,
      path: finding.path,
      rule: finding.rule,
      rule_version: finding.rule_version,
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      category: finding.category,
      change_sources: sourcesForPath(changes, finding.path),
      finding
    });
  }

  for (const finding of base) {
    if (currentFingerprints.has(finding.fingerprint)) continue;
    if (stalePathRule.has(`${finding.path}\0${finding.rule}`)) continue;
    records.push({
      lifecycle: "resolved",
      source: "git_base",
      reason_code: "removed_from_candidate",
      path: finding.path,
      rule: finding.rule,
      rule_version: finding.rule_version,
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      category: finding.category,
      change_sources: sourcesForPath(changes, finding.path, true),
      finding
    });
  }

  const removed = new Set(deletedPaths(changes));
  records.push(...resolvedBaselineRecords(baseline, removed, new Set(records.map((record) => record.fingerprint)), changes));
  return records.sort((left, right) => (
    lifecycleRank(left.lifecycle) - lifecycleRank(right.lifecycle)
    || left.path.localeCompare(right.path)
    || left.rule.localeCompare(right.rule)
  ));
}

function lifecycleRank(value: SecurityIncrementalLifecycle): number {
  return ({ new: 0, expired: 1, stale: 2, existing: 3, resolved: 4 })[value];
}

function countLifecycle(records: SecurityIncrementalFindingRecord[]): SecurityIncrementalCounts {
  const counts: SecurityIncrementalCounts = { new: 0, existing: 0, resolved: 0, expired: 0, stale: 0 };
  for (const record of records) counts[record.lifecycle] += 1;
  return counts;
}

function formatIncrementalText(result: Omit<SecurityIncrementalResult, "text">): string {
  const shown = result.findings.slice(0, 100);
  const lines = [
    "# Git Incremental Security Check",
    "",
    `Status: ${result.status.toUpperCase()}`,
    `Upstream: ${result.upstream_ref} (${result.upstream_sha})`,
    `Merge base: ${result.merge_base_sha}`,
    `Head: ${result.head_sha}`,
    `Changed files: ${result.changed_files.length}`,
    `Untracked files: ${result.untracked_files.length}`,
    `Renames: ${result.renamed_files.length}`,
    `Lifecycle: new=${result.counts.new}, existing=${result.counts.existing}, resolved=${result.counts.resolved}, expired=${result.counts.expired}, stale=${result.counts.stale}`,
    `Scan issues: ${result.issues.length}`,
    "Values: matched values are never printed.",
    "",
    "## Findings",
    ""
  ];
  if (!shown.length) lines.push("- none");
  for (const record of shown) {
    lines.push(`- ${record.lifecycle.toUpperCase()} ${record.severity.toUpperCase()} ${record.category}/${record.rule} ${record.path} sources=${record.change_sources.join(",") || "none"} reason=${record.reason_code}`);
  }
  if (result.findings.length > shown.length) lines.push("", `Output truncated: showing ${shown.length} of ${result.findings.length} lifecycle records.`);
  if (result.issues.length) {
    lines.push("", "## Incomplete checks", "");
    for (const issue of result.issues.slice(0, 50)) lines.push(`- ${issue.code} ${issue.path ?? "repository"} — ${issue.message}`);
  }
  return lines.join("\n");
}

function deriveStatus(
  records: SecurityIncrementalFindingRecord[],
  issues: SecurityIncrementalScanIssue[],
  failOnWarnings: boolean
): { ok: boolean; status: SecurityIncrementalResult["status"] } {
  if (issues.length) return { ok: false, status: "fail" };
  const actionable = records.filter((record) => record.lifecycle === "new" || record.lifecycle === "expired" || record.lifecycle === "stale");
  if (actionable.some((record) => record.severity === "error")) return { ok: false, status: "fail" };
  if (actionable.some((record) => record.severity === "warn")) return { ok: !failOnWarnings, status: "warn" };
  return { ok: true, status: "pass" };
}

export async function runGitIncrementalSecurityCheck(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SecurityIncrementalOptions = {}
): Promise<SecurityIncrementalResult> {
  const repositoryRoot = requireGitText(workspace, ["rev-parse", "--show-toplevel"], "git_not_repository", "Git repository discovery");
  if (path.resolve(repositoryRoot) !== path.resolve(workspace.root)) {
    throw new SecurityIncrementalError("git_not_repository", "Workspace root must be the Git repository root for incremental security checks");
  }
  const headSha = requireGitText(workspace, ["rev-parse", "--verify", "HEAD"], "git_unavailable", "Git HEAD resolution");
  const upstreamRef = options.base_ref?.trim() || options.upstream_ref?.trim() || "@{upstream}";
  const upstreamSha = requireGitText(
    workspace,
    ["rev-parse", "--verify", upstreamRef],
    "git_upstream_unavailable",
    `Git upstream resolution for ${upstreamRef}`
  );
  const mergeBaseSha = requireGitText(
    workspace,
    ["merge-base", headSha, upstreamSha],
    "git_merge_base_unavailable",
    "Git merge-base resolution"
  );

  const changes = filterCandidateChanges([
    ...readDiffChanges(workspace, ["diff", "--name-status", "-z", "--find-renames=50%", mergeBaseSha, headSha], "committed"),
    ...readDiffChanges(workspace, ["diff", "--cached", "--name-status", "-z", "--find-renames=50%"], "staged"),
    ...readDiffChanges(workspace, ["diff", "--name-status", "-z", "--find-renames=50%"], "worktree"),
    ...readUntrackedChanges(workspace)
  ], options.candidate_paths);
  const basePaths = readGitBasePaths(workspace, mergeBaseSha);
  const currentPaths = currentCandidatePaths(changes);
  const historicalPaths = baseCandidatePaths(changes, basePaths);
  const currentScan = await scanCurrentFiles(config, guard, workspace, currentPaths, options);
  const baseScan = await scanBaseFiles(config, guard, workspace, mergeBaseSha, historicalPaths, options);
  const loaded = await loadOptionalBaseline(workspace, options);
  const currentFindings = loaded.policy && loaded.baseline
    ? applySecurityBaseline(currentScan.findings, loaded.baseline, loaded.policy, options.now ?? new Date()).findings
    : currentScan.findings;
  const records = classifyFindings(currentFindings, baseScan.findings, loaded.baseline, changes);
  const issues = [...currentScan.issues, ...baseScan.issues];
  const status = deriveStatus(records, issues, Boolean(options.fail_on_warnings));
  const counts = countLifecycle(records);
  const data: Omit<SecurityIncrementalResult, "text"> = {
    ok: status.ok,
    status: status.status,
    scan_type: "git_incremental_security_check",
    root: workspace.root,
    head_sha: headSha,
    upstream_ref: upstreamRef,
    upstream_sha: upstreamSha,
    merge_base_sha: mergeBaseSha,
    changes,
    changed_files: currentPaths,
    deleted_files: deletedPaths(changes),
    renamed_files: changes
      .filter((change) => change.status === "renamed" && change.old_path)
      .map((change) => ({ from: change.old_path as string, to: change.path })),
    untracked_files: uniqueStrings(changes.filter((change) => change.source === "untracked").map((change) => change.path)),
    file_scans: [...currentScan.scans, ...baseScan.scans],
    issues,
    counts,
    findings: records
  };
  return { ...data, text: formatIncrementalText(data) };
}
