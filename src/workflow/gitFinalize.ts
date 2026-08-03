import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, PathGuard, type Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { deriveGitDeliveryStatus, type TaskDeliveryStatus } from "../runtime/taskOutcome.js";
import { publishGitRetryStarted } from "../tasks/taskReportPublishers.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import { detectGitIntent } from "../security/gitIntent.js";
import { commitSubject } from "./gitWorkflow.js";
import { SECURITY_RULE_SET_VERSION } from "./securityAudit.js";
import { runReleaseSafetyDecisionGate } from "./securityReleaseGate.js";
import {
  sealLatestSecurityReleaseReceiptForCommit,
  validateLatestSecurityReleaseReceipt
} from "./securityReleaseReceipt.js";
import {
  acceptanceReceiptHasSensitivePaths,
  readLatestAcceptanceReceipt,
  validateLatestAcceptanceReceipt
} from "./acceptanceReceipt.js";
import {
  detectGitRemoteProtocol,
  executeGitPush,
  type GitPushCommandResult,
  type GitPushErrorCode,
  type GitPushExecutionResult,
  type GitPushTransport,
  type GitRemoteProtocol
} from "./gitPushTransport.js";
import {
  readLatestGitFinalizationRecord,
  writeLatestGitFinalizationRecord,
  type GitFinalizationAcceptanceStatus,
  type GitFinalizationImplementationStatus
} from "./gitFinalizationState.js";

export type GitCommitStatus = "not_started" | "completed" | "failed";
export type GitPushStatus = "not_requested" | "waiting_security_baseline" | "already_synced" | "completed" | "failed";
export type GitFinalizationStatus = "completed" | "waiting" | "blocked" | "failed";

export interface GitFinalizeReleaseSafetySummary {
  mode: "targeted" | "incremental" | "full";
  verdict: "allow" | "block" | "proposal";
  status: "pass" | "warn" | "fail";
  scan_complete: boolean;
  reason_codes: string[];
  receipt_path?: string;
  receipt_id?: string;
  receipt_valid: boolean;
  receipt_validation_reasons: string[];
}

export interface GitFinalizeResult {
  ok: boolean;
  status: GitFinalizationStatus;
  reason_code: string;
  reasons: string[];
  branch?: string;
  changed_files: string[];
  commit_status: GitCommitStatus;
  push_status: GitPushStatus;
  delivery_status: TaskDeliveryStatus;
  local_commit_sha?: string;
  remote_commit_sha?: string;
  commit_message?: string;
  expected_paths?: string[];
  missing_paths?: string[];
  unexpected_paths?: string[];
  push_attempts: number;
  push_transport?: GitPushTransport;
  push_error_code?: GitPushErrorCode;
  push_started_at?: string;
  git_process_exited_at?: string;
  tool_returned_at?: string;
  push_duration_ms?: number;
  release_safety?: GitFinalizeReleaseSafetySummary;
  duration_ms: number;
  text: string;
}

type GitFinalizeResultInput = Omit<GitFinalizeResult, "text" | "delivery_status"> & {
  delivery_status?: TaskDeliveryStatus;
};

function gitProcessMetadata(args: string[]): { sideEffectLevel: "local_read" | "local_write" | "external_write"; riskLevel: "low" | "medium" | "high" } {
  const operation = args[0] ?? "git";
  if (operation === "push") return { sideEffectLevel: "external_write", riskLevel: "high" };
  if (["add", "commit", "checkout", "switch", "reset", "restore", "merge", "rebase", "tag", "branch", "worktree"].includes(operation)) {
    return { sideEffectLevel: "local_write", riskLevel: "medium" };
  }
  return { sideEffectLevel: "local_read", riskLevel: "low" };
}

function runGit(
  config: CodexProConfig,
  workspace: Workspace,
  args: string[],
  timeoutMs = 60_000,
  env: NodeJS.ProcessEnv = process.env
): GitPushCommandResult {
  const metadata = gitProcessMetadata(args);
  const result = runProcessSync("git", args, {
    cwd: workspace.root,
    env: { ...env, NO_COLOR: "1" },
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    domain: "git",
    operation: args[0] ?? "git",
    sideEffectLevel: metadata.sideEffectLevel,
    riskLevel: metadata.riskLevel
  });
  const stdout = redactSensitiveText(result.stdout?.trim() || "");
  const stderr = redactSensitiveText(result.stderr?.trim() || "");
  return {
    ok: !result.spawnError && result.exitCode === 0,
    status: result.exitCode,
    stdout,
    stderr,
    ...(result.spawnError ? { error: redactSensitiveText(result.stderr || result.errorClass || "git spawn failed") } : {})
  };
}

function gitFailure(result: GitPushCommandResult): string {
  return result.stderr || result.stdout || result.error || `git exited with status ${result.status ?? "unknown"}`;
}

interface TemporaryIndexCommitResult {
  ok: boolean;
  commit_created: boolean;
  reason_code?: "git_index_init_failed" | "git_add_failed" | "staged_diff_check_failed" | "temporary_index_paths_mismatch" | "no_staged_changes" | "git_commit_failed" | "real_index_sync_failed";
  result?: GitPushCommandResult;
  staged_paths: string[];
}

async function commitWithTemporaryIndex(
  config: CodexProConfig,
  workspace: Workspace,
  files: string[],
  message: string
): Promise<TemporaryIndexCommitResult> {
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-git-index-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    let initialized = runGit(config, workspace, ["read-tree", "HEAD"], 30_000, env);
    if (!initialized.ok) initialized = runGit(config, workspace, ["read-tree", "--empty"], 30_000, env);
    if (!initialized.ok) return { ok: false, commit_created: false, reason_code: "git_index_init_failed", result: initialized, staged_paths: [] };

    const added = runGit(config, workspace, ["add", "--all", "--", ...files], 60_000, env);
    if (!added.ok) return { ok: false, commit_created: false, reason_code: "git_add_failed", result: added, staged_paths: [] };

    const stagedNames = runGit(config, workspace, ["diff", "--cached", "--name-only", "-z"], 30_000, env);
    if (!stagedNames.ok) return { ok: false, commit_created: false, reason_code: "staged_diff_check_failed", result: stagedNames, staged_paths: [] };
    const stagedPaths = nulSeparatedPaths(stagedNames.stdout);
    if (!samePaths(stagedPaths, files)) {
      return { ok: false, commit_created: false, reason_code: "temporary_index_paths_mismatch", result: stagedNames, staged_paths: stagedPaths };
    }

    const staged = runGit(config, workspace, ["diff", "--cached", "--quiet", "--exit-code"], 30_000, env);
    if (staged.status === 0) return { ok: false, commit_created: false, reason_code: "no_staged_changes", result: staged, staged_paths: stagedPaths };
    if (staged.status !== 1) return { ok: false, commit_created: false, reason_code: "staged_diff_check_failed", result: staged, staged_paths: stagedPaths };

    const committed = runGit(config, workspace, ["commit", "-m", message], 120_000, env);
    if (!committed.ok) return { ok: false, commit_created: false, reason_code: "git_commit_failed", result: committed, staged_paths: stagedPaths };
    const synchronized = runGit(config, workspace, ["reset", "--quiet", "HEAD", "--", ...files], 30_000);
    return synchronized.ok
      ? { ok: true, commit_created: true, result: committed, staged_paths: stagedPaths }
      : { ok: false, commit_created: true, reason_code: "real_index_sync_failed", result: synchronized, staged_paths: stagedPaths };
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function securityBaselineUnavailable(reasonCodes: string[]): boolean {
  return reasonCodes.some((code) => /(?:git_)?baseline_(?:unavailable|missing|invalid)|git_(?:upstream|merge_base)_unavailable/.test(code));
}

function remoteBranchSha(
  config: CodexProConfig,
  workspace: Workspace,
  remote: string,
  branch: string
): string | undefined {
  const result = runGit(config, workspace, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 30_000);
  if (!result.ok) return undefined;
  return result.stdout.trim().split(/\s+/)[0] || undefined;
}

function gitValue(config: CodexProConfig, workspace: Workspace, args: string[]): string | undefined {
  const result = runGit(config, workspace, args, 15_000);
  const value = result.stdout.trim();
  return result.ok && value ? value : undefined;
}

function configuredPushRemote(config: CodexProConfig, workspace: Workspace, branch: string | undefined): string {
  if (!branch) return "origin";
  const remote = gitValue(config, workspace, ["config", "--get", `branch.${branch}.remote`]);
  return remote && remote !== "." ? remote : "origin";
}

function pushRemoteProtocol(config: CodexProConfig, workspace: Workspace, remote: string): GitRemoteProtocol {
  const remoteUrl = gitValue(config, workspace, ["remote", "get-url", "--push", remote]);
  return detectGitRemoteProtocol(remoteUrl);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._/@:+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function pushExactCommit(
  config: CodexProConfig,
  workspace: Workspace,
  branch: string,
  commitSha: string
): { execution: GitPushExecutionResult; remote: string; manualCommand: string } {
  const remote = configuredPushRemote(config, workspace, branch);
  const refspec = `${commitSha}:refs/heads/${branch}`;
  const args = ["push", "--porcelain", remote, refspec];
  const execution = executeGitPush({
    protocol: pushRemoteProtocol(config, workspace, remote),
    sourceEnv: process.env,
    args,
    run: (gitArgs, options) => runGit(config, workspace, gitArgs, options.timeoutMs, options.env)
  });
  return {
    execution,
    remote,
    manualCommand: `git ${args.map(shellQuote).join(" ")}`
  };
}

function exactCommitMessage(value: string | undefined, files: string[]): string {
  return value === undefined ? commitSubject(files) : value;
}

function currentChangedFiles(status: string): string[] {
  return [...new Set(status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim())
    .flatMap((file) => file.includes(" -> ") ? file.split(" -> ") : [file])
    .map((file) => file.trim().replace(/^\.\//, ""))
    .filter(Boolean))].sort();
}

interface GitStatusEntry {
  path: string;
  status: string;
  untracked: boolean;
}

const LOCAL_EVIDENCE_PREFIXES = [
  ".ai-bridge/",
  ".codexpro/",
  "benchmarks/gold-tasks/v1/reports/evidence/",
  "benchmarks/gold-tasks/v1/reports/runs/"
];

const VERSIONED_CODEXPRO_PATHS = [
  ".codexpro/acceptance.yml",
  ".codexpro/security-policy.json",
  ".codexpro/security-baseline.json",
  ".codexpro/browser-skills/"
];

function gitStatusEntries(status: string): GitStatusEntry[] {
  const tokens = status.split("\0").filter(Boolean);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 3) continue;
    const leadingWorktreeSpaceWasTrimmed = token[1] === " " && token[2] !== " ";
    const code = leadingWorktreeSpaceWasTrimmed ? ` ${token[0]}` : token.slice(0, 2);
    const file = token.slice(leadingWorktreeSpaceWasTrimmed ? 2 : 3).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!file) continue;
    entries.push({ path: file, status: code, untracked: code === "??" });
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return entries;
}

function normalizeRequestedPaths(workspace: Workspace, values: string[] | undefined, label: string): string[] | undefined {
  if (values === undefined) return undefined;
  const normalized = values.map((value) => {
    const absolute = path.resolve(workspace.root, value);
    const relative = path.relative(workspace.root, absolute).replace(/\\/g, "/");
    if (!relative || relative === "." || relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new CodexProError(`${label} contains a path outside the workspace: ${value}`);
    }
    return relative.replace(/\/$/, "");
  });
  return [...new Set(normalized)].sort();
}

function matchesSelected(file: string, selected: string[]): boolean {
  return selected.some((candidate) => file === candidate || file.startsWith(`${candidate}/`));
}

function isLocalEvidencePath(file: string): boolean {
  const normalized = file.replace(/^\.\//, "");
  if (VERSIONED_CODEXPRO_PATHS.some((allowed) => normalized === allowed || normalized.startsWith(allowed))) return false;
  return LOCAL_EVIDENCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function nulSeparatedPaths(value: string): string[] {
  return [...new Set(value.split("\0").map((file) => file.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean))].sort();
}

function samePaths(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatResult(result: Omit<GitFinalizeResult, "text">): string {
  return [
    "# Git Finalization",
    "",
    `Status: ${result.status}`,
    `Reason code: ${result.reason_code}`,
    `Branch: ${result.branch ?? "unknown"}`,
    `Commit: ${result.commit_status}`,
    `Push: ${result.push_status}`,
    `Delivery: ${result.delivery_status}`,
    `Local SHA: ${result.local_commit_sha ?? "none"}`,
    `Remote SHA: ${result.remote_commit_sha ?? "none"}`,
    `Changed files: ${result.changed_files.length ? result.changed_files.join(", ") : "none"}`,
    `Expected paths: ${result.expected_paths?.length ? result.expected_paths.join(", ") : "none"}`,
    `Missing paths: ${result.missing_paths?.length ? result.missing_paths.join(", ") : "none"}`,
    `Unexpected paths: ${result.unexpected_paths?.length ? result.unexpected_paths.join(", ") : "none"}`,
    `Push attempts: ${result.push_attempts}`,
    `Push transport: ${result.push_transport ?? "none"}`,
    `Push error code: ${result.push_error_code ?? "none"}`,
    `Push started at: ${result.push_started_at ?? "none"}`,
    `Git process exited at: ${result.git_process_exited_at ?? "none"}`,
    `Tool returned at: ${result.tool_returned_at ?? "none"}`,
    `Push duration: ${result.push_duration_ms ?? 0} ms`,
    `Duration: ${result.duration_ms} ms`,
    "",
    "## Reasons",
    ...(result.reasons.length ? result.reasons.map((reason) => `- ${reason}`) : ["- none"])
  ].join("\n");
}

function finish(result: GitFinalizeResultInput): GitFinalizeResult {
  const completed = {
    ...result,
    delivery_status: deriveGitDeliveryStatus({
      commit_status: result.commit_status,
      push_status: result.push_status,
      reason_code: result.reason_code,
      push_error_code: result.push_error_code
    }),
    tool_returned_at: new Date().toISOString()
  };
  return { ...completed, text: formatResult(completed) };
}

interface GitFinalizationStateContext {
  source_run_id?: string | null;
  acceptance_report_path?: string | null;
  implementation_status?: GitFinalizationImplementationStatus;
  acceptance_status?: GitFinalizationAcceptanceStatus;
  last_action: "git_finalize" | "git_push_only";
}

async function finishPersisted(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  resultInput: GitFinalizeResultInput,
  context: GitFinalizationStateContext
): Promise<GitFinalizeResult> {
  const result = finish(resultInput);
  try {
    await writeLatestGitFinalizationRecord(config, guard, workspace, {
      ...context,
      branch: result.branch ?? null,
      changed_files: result.changed_files,
      commit_status: result.commit_status,
      push_status: result.push_status,
      delivery_status: result.delivery_status,
      local_commit_sha: result.local_commit_sha ?? null,
      remote_commit_sha: result.remote_commit_sha ?? null,
      commit_message: result.commit_message ?? null,
      push_transport: result.push_transport ?? null,
      push_attempts: result.push_attempts,
      push_error_code: result.push_error_code ?? null,
      push_started_at: result.push_started_at ?? null,
      git_process_exited_at: result.git_process_exited_at ?? null,
      tool_returned_at: result.tool_returned_at ?? null,
      push_duration_ms: result.push_duration_ms ?? null,
      reason_code: result.reason_code,
      reason: result.reasons[0] ?? null
    });
  } catch {
    // Git finalization remains authoritative even when the optional console projection cannot be persisted.
  }
  return result;
}

function baseResult(started: number): GitFinalizeResultInput {
  return {
    ok: false,
    status: "blocked",
    reason_code: "git_finalization_blocked",
    reasons: [],
    changed_files: [],
    commit_status: "not_started",
    push_status: "not_requested",
    delivery_status: "not_ready",
    push_attempts: 0,
    duration_ms: Math.max(0, Date.now() - started)
  };
}

export async function gitFinalize(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    userIntent: string;
    selectedPaths?: string[];
    includeUntracked?: boolean;
    commitMessage?: string;
    expectedPaths?: string[];
    includePush?: boolean;
    securityMode?: "incremental" | "full";
  }
): Promise<GitFinalizeResult> {
  const started = Date.now();
  const intent = detectGitIntent(options.userIntent);
  const pushRequested = options.includePush ?? intent.actions.includes("push");
  if (intent.negated || !intent.actions.includes("commit")) {
    return finish({
      ...baseResult(started),
      reason_code: intent.negated ? "git_intent_negated" : "commit_intent_required",
      reasons: [intent.negated ? "The user instruction explicitly negated Git finalization." : "git_finalize requires explicit commit intent in user_intent."],
      duration_ms: Date.now() - started
    });
  }
  if (pushRequested && !intent.actions.includes("push")) {
    return finish({
      ...baseResult(started),
      reason_code: "push_intent_required",
      reasons: ["include_push=true requires explicit push intent in user_intent."],
      duration_ms: Date.now() - started
    });
  }
  const selectedPaths = normalizeRequestedPaths(workspace, options.selectedPaths, "selected_paths");
  const requestedExpectedPaths = normalizeRequestedPaths(workspace, options.expectedPaths, "expected_paths");
  const combinedScopePaths = [...new Set([...(selectedPaths ?? []), ...(requestedExpectedPaths ?? [])])].sort();
  const explicitScopePaths = combinedScopePaths.length ? combinedScopePaths : undefined;
  const status = runGit(config, workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 15_000);
  if (!status.ok) {
    return finish({
      ...baseResult(started),
      status: "failed",
      reason_code: "git_status_failed",
      reasons: [gitFailure(status)],
      duration_ms: Date.now() - started
    });
  }

  const entries = gitStatusEntries(status.stdout);
  const selectedEntries = entries.filter((entry) => {
    if (isLocalEvidencePath(entry.path)) return false;
    if (explicitScopePaths && !matchesSelected(entry.path, explicitScopePaths)) return false;
    if (!entry.untracked) return true;
    return Boolean(explicitScopePaths?.length) && matchesSelected(entry.path, explicitScopePaths ?? []);
  });
  const files = [...new Set(selectedEntries.map((entry) => entry.path))].sort();
  const branch = gitValue(config, workspace, ["branch", "--show-current"]);
  const message = exactCommitMessage(options.commitMessage, files);
  const stateContext: GitFinalizationStateContext = {
    source_run_id: null,
    acceptance_report_path: null,
    implementation_status: "completed",
    acceptance_status: "unknown",
    last_action: "git_finalize"
  };
  const selectedEvidence = explicitScopePaths?.filter(isLocalEvidencePath) ?? [];
  if (selectedEvidence.length) {
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: "local_evidence_paths_blocked",
      reasons: [`Local evidence paths cannot be committed: ${selectedEvidence.join(", ")}`],
      branch,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  if (selectedPaths && !requestedExpectedPaths) {
    const unmatched = selectedPaths.filter((selected) => !entries.some((entry) => matchesSelected(entry.path, [selected])));
    if (unmatched.length) {
      return await finishPersisted(config, guard, workspace, {
        ...baseResult(started),
        reason_code: "selected_paths_not_changed",
        reasons: [`selected_paths are not currently changed: ${unmatched.join(", ")}`],
        branch,
        missing_paths: unmatched,
        duration_ms: Date.now() - started
      }, stateContext);
    }
  }
  const expectedPaths = requestedExpectedPaths ?? files;
  if (!samePaths(files, expectedPaths)) {
    const missingPaths = expectedPaths.filter((file) => !files.includes(file));
    const unexpectedPaths = files.filter((file) => !expectedPaths.includes(file));
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: "precommit_paths_mismatch",
      reasons: [`Commit path verification failed before creating a local commit. Missing: ${missingPaths.join(", ") || "none"}; unexpected: ${unexpectedPaths.join(", ") || "none"}.`],
      branch,
      changed_files: files,
      expected_paths: expectedPaths,
      missing_paths: missingPaths,
      unexpected_paths: unexpectedPaths,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  if (!files.length) {
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: "no_changes",
      reasons: ["There are no eligible local changes to commit. Untracked files are excluded unless explicitly named in selected_paths or expected_paths."],
      branch,
      duration_ms: Date.now() - started
    }, stateContext);
  }

  if (acceptanceReceiptHasSensitivePaths(files)) {
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: "sensitive_paths_blocked",
      reasons: ["Sensitive paths cannot be committed by git_finalize."],
      branch,
      changed_files: files,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const requestedSecurityMode = options.securityMode === "full" ? "full" : "incremental";
  const securityResult = await runReleaseSafetyDecisionGate(config, guard, workspace, {
    mode: requestedSecurityMode,
    candidate_paths: files,
    write_receipt: true
  });
  let releaseSafety: GitFinalizeReleaseSafetySummary = {
    mode: requestedSecurityMode,
    verdict: securityResult.decision.verdict,
    status: securityResult.status,
    scan_complete: securityResult.scan_complete,
    reason_codes: [...securityResult.decision.reason_codes],
    ...(securityResult.receipt?.path ? { receipt_path: securityResult.receipt.path } : {}),
    ...(securityResult.receipt?.receipt_id ? { receipt_id: securityResult.receipt.receipt_id } : {}),
    receipt_valid: false,
    receipt_validation_reasons: []
  };
  const securityBaselineWaiting = requestedSecurityMode === "incremental"
    && securityBaselineUnavailable(securityResult.decision.reason_codes);
  if (!securityBaselineWaiting
    && (!securityResult.ok || securityResult.decision.verdict !== "allow" || !securityResult.scan_complete || securityResult.receipt?.status !== "written")) {
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: requestedSecurityMode === "full" ? "release_safety_check_blocked" : "candidate_security_scan_blocked",
      reasons: [`The single ${requestedSecurityMode} security pass blocked Git finalization: ${securityResult.decision.reason_codes.join(", ") || securityResult.status}.`],
      branch,
      changed_files: files,
      release_safety: releaseSafety,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  let acceptanceEvidenceReason = "The bounded candidate-path security scan passed; build, tests, browser validation, and formal Acceptance were not rerun.";
  const receipt = await readLatestAcceptanceReceipt(config, guard, workspace);
  if (receipt) {
    const validation = await validateLatestAcceptanceReceipt(config, guard, workspace);
    stateContext.source_run_id = receipt.run_id;
    stateContext.acceptance_report_path = receipt.report_path;
    stateContext.acceptance_status = validation.valid ? receipt.validation_status : "unknown";
    acceptanceEvidenceReason = validation.valid
      ? "Existing task Acceptance evidence was reused; build, tests, browser validation, and formal certification were not rerun."
      : "Existing Acceptance evidence was stale and treated as advisory; Git finalization continued with scoped Git checks and did not rerun validation.";
  }

  const temporaryCommit = await commitWithTemporaryIndex(config, workspace, files, message);
  if (!temporaryCommit.ok) {
    const reasonCode = temporaryCommit.reason_code ?? "git_commit_failed";
    const pathDetail = reasonCode === "temporary_index_paths_mismatch"
      ? ` Temporary index contained: ${temporaryCommit.staged_paths.join(", ") || "none"}.`
      : "";
    const committedSha = temporaryCommit.commit_created ? gitValue(config, workspace, ["rev-parse", "HEAD"]) : undefined;
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      status: reasonCode === "no_staged_changes" ? "blocked" : "failed",
      reason_code: reasonCode,
      reasons: [`${temporaryCommit.result ? gitFailure(temporaryCommit.result) : "Temporary index commit failed."}${pathDetail}`],
      branch,
      changed_files: files,
      commit_status: temporaryCommit.commit_created ? "completed" : reasonCode === "no_staged_changes" ? "not_started" : "failed",
      push_status: temporaryCommit.commit_created && pushRequested ? "failed" : "not_requested",
      local_commit_sha: committedSha,
      commit_message: message,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const localSha = gitValue(config, workspace, ["rev-parse", "HEAD"]);
  if (!localSha) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: "git_head_read_failed",
      reasons: ["The commit completed, but CodexPro could not read its commit SHA. No push was attempted."],
      branch,
      changed_files: files,
      commit_status: "completed",
      push_status: "failed",
      commit_message: message,
      push_attempts: 0,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const committed = runGit(config, workspace, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", localSha], 15_000);
  if (!committed.ok) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: "committed_paths_read_failed",
      reasons: [gitFailure(committed)],
      branch,
      changed_files: files,
      commit_status: "completed",
      push_status: pushRequested ? "failed" : "not_requested",
      local_commit_sha: localSha,
      commit_message: message,
      push_attempts: 0,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const actualCommittedPaths = nulSeparatedPaths(committed.stdout);
  if (!samePaths(actualCommittedPaths, expectedPaths)) {
    const missingPaths = expectedPaths.filter((file) => !actualCommittedPaths.includes(file));
    const unexpectedPaths = actualCommittedPaths.filter((file) => !expectedPaths.includes(file));
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "blocked",
      reason_code: "committed_paths_mismatch",
      reasons: [`Local commit path verification failed; push was blocked. Missing: ${missingPaths.join(", ") || "none"}; unexpected: ${unexpectedPaths.join(", ") || "none"}.`],
      branch,
      changed_files: actualCommittedPaths,
      expected_paths: expectedPaths,
      missing_paths: missingPaths,
      unexpected_paths: unexpectedPaths,
      commit_status: "completed",
      push_status: pushRequested ? "failed" : "not_requested",
      local_commit_sha: localSha,
      commit_message: message,
      push_attempts: 0,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  if (securityBaselineWaiting) {
    if (pushRequested) {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "waiting",
        reason_code: "push_waiting_security_baseline",
        reasons: ["The local commit completed, but push is waiting for an incremental Git security baseline. No full scan or push was attempted."],
        release_safety: releaseSafety,
        branch,
        changed_files: actualCommittedPaths,
        expected_paths: expectedPaths,
        commit_status: "completed",
        push_status: "waiting_security_baseline",
        local_commit_sha: localSha,
        commit_message: message,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
  } else {
    const sealedReceipt = await sealLatestSecurityReleaseReceiptForCommit(config, guard, workspace, {
      expected_paths: actualCommittedPaths,
      commit_sha: localSha,
      rule_set_version: SECURITY_RULE_SET_VERSION
    });
    releaseSafety.receipt_valid = sealedReceipt.valid;
    releaseSafety.receipt_validation_reasons = [...sealedReceipt.reasons];
    if (!sealedReceipt.valid) {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "blocked",
        reason_code: "push_security_receipt_invalid",
        reasons: [`The local commit completed, but the candidate security receipt could not be sealed to its exact Git blobs: ${sealedReceipt.reasons.join(", ")}.`],
        release_safety: releaseSafety,
        branch,
        changed_files: actualCommittedPaths,
        expected_paths: expectedPaths,
        commit_status: "completed",
        push_status: pushRequested ? "failed" : "not_requested",
        local_commit_sha: localSha,
        commit_message: message,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
  }
  if (!pushRequested) {
    return await finishPersisted(config, guard, workspace, {
      ok: true,
      status: "completed",
      reason_code: "git_commit_completed",
      reasons: ["The selected path set was committed through an isolated temporary index and verified. Push was not requested.", acceptanceEvidenceReason],
      release_safety: releaseSafety,
      branch,
      changed_files: actualCommittedPaths,
      expected_paths: expectedPaths,
      commit_status: "completed",
      push_status: "not_requested",
      local_commit_sha: localSha,
      commit_message: message,
      push_attempts: 0,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  if (!branch) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: "git_branch_missing",
      reasons: ["The commit completed, but CodexPro could not determine the target branch. No push was attempted."],
      changed_files: actualCommittedPaths,
      expected_paths: expectedPaths,
      commit_status: "completed",
      push_status: "failed",
      local_commit_sha: localSha,
      commit_message: message,
      push_attempts: 0,
      duration_ms: Date.now() - started
    }, stateContext);
  }

  const exactPush = pushExactCommit(config, workspace, branch, localSha);
  const push = exactPush.execution;
  if (!push.ok) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: push.error_code ?? "failed_unknown",
      reasons: [
        gitFailure(push.final_result),
        `${push.attempts > 1 ? "One controlled retry was attempted" : "No automatic retry was attempted"}. Run manually: ${exactPush.manualCommand}`
      ],
      branch,
      changed_files: actualCommittedPaths,
      expected_paths: expectedPaths,
      commit_status: "completed",
      push_status: "failed",
      local_commit_sha: localSha,
      commit_message: message,
      push_attempts: push.attempts,
      push_transport: push.transport,
      push_error_code: push.error_code,
      push_started_at: push.push_started_at,
      git_process_exited_at: push.git_process_exited_at,
      push_duration_ms: push.push_duration_ms,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const verifiedRemoteSha = remoteBranchSha(config, workspace, exactPush.remote, branch);
  if (verifiedRemoteSha !== localSha) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: "push_delivery_unknown_remote_verification_failed",
      reasons: ["Git reported push success, but the remote branch could not be verified at the exact local commit SHA."],
      release_safety: releaseSafety,
      branch,
      changed_files: actualCommittedPaths,
      expected_paths: expectedPaths,
      commit_status: "completed",
      push_status: "failed",
      local_commit_sha: localSha,
      remote_commit_sha: verifiedRemoteSha,
      commit_message: message,
      push_attempts: push.attempts,
      push_transport: push.transport,
      push_started_at: push.push_started_at,
      git_process_exited_at: push.git_process_exited_at,
      push_duration_ms: push.push_duration_ms,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  return await finishPersisted(config, guard, workspace, {
    ok: true,
    status: "completed",
    reason_code: "git_finalize_completed",
    reasons: ["Commit completed and the exact commit SHA was pushed and verified on the remote branch.", acceptanceEvidenceReason],
    release_safety: releaseSafety,
    branch,
    changed_files: actualCommittedPaths,
    expected_paths: expectedPaths,
    commit_status: "completed",
    push_status: "completed",
    local_commit_sha: localSha,
    remote_commit_sha: verifiedRemoteSha,
    commit_message: message,
    push_attempts: push.attempts,
    push_transport: push.transport,
    push_started_at: push.push_started_at,
    git_process_exited_at: push.git_process_exited_at,
    push_duration_ms: push.push_duration_ms,
    duration_ms: Date.now() - started
  }, stateContext);
}

export async function gitPushOnly(
  config: CodexProConfig,
  workspace: Workspace,
  options: { userIntent: string },
  guard: PathGuard = new PathGuard(config)
): Promise<GitFinalizeResult> {
  const started = Date.now();
  const intent = detectGitIntent(options.userIntent);
  if (intent.negated || !intent.actions.includes("push")) {
    return finish({
      ...baseResult(started),
      reason_code: intent.negated ? "git_intent_negated" : "push_intent_required",
      reasons: [intent.negated ? "The user instruction explicitly negated Git push." : "git_push_only requires explicit push intent in user_intent."],
      duration_ms: Date.now() - started
    });
  }
  const previous = await readLatestGitFinalizationRecord(config, guard, workspace);
  const stateContext: GitFinalizationStateContext = {
    source_run_id: previous?.source_run_id ?? null,
    acceptance_report_path: previous?.acceptance_report_path ?? null,
    implementation_status: previous?.implementation_status ?? "unknown",
    acceptance_status: previous?.acceptance_status ?? "unknown",
    last_action: "git_push_only"
  };
  const branch = gitValue(config, workspace, ["branch", "--show-current"]);
  const localSha = gitValue(config, workspace, ["rev-parse", "HEAD"]);
  if (!branch || !localSha) {
    return finish({
      ...baseResult(started),
      reason_code: !branch ? "git_branch_missing" : "git_head_read_failed",
      reasons: [!branch ? "CodexPro could not determine the target branch." : "CodexPro could not determine the commit SHA to push."],
      branch,
      local_commit_sha: localSha,
      duration_ms: Date.now() - started
    });
  }
  const previousMatchesHead = previous?.local_commit_sha === localSha;
  const changedFiles = previousMatchesHead && previous?.changed_files.length
    ? previous.changed_files
    : nulSeparatedPaths(runGit(config, workspace, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", localSha], 15_000).stdout);
  const commitMessage = previousMatchesHead
    ? previous?.commit_message ?? undefined
    : gitValue(config, workspace, ["log", "-1", "--format=%s", localSha]);
  if (!changedFiles.length) {
    return await finishPersisted(config, guard, workspace, {
      ...baseResult(started),
      reason_code: "push_security_scope_missing",
      reasons: ["git_push_only could not derive an exact changed-file scope for the current HEAD."],
      branch,
      local_commit_sha: localSha,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const configuredRemote = configuredPushRemote(config, workspace, branch);
  const currentRemoteSha = remoteBranchSha(config, workspace, configuredRemote, branch);
  if (currentRemoteSha === localSha) {
    return await finishPersisted(config, guard, workspace, {
      ok: true,
      status: "completed",
      reason_code: "git_push_already_synced",
      reasons: ["The remote branch already points to the exact local commit SHA. No security scan or push process was required."],
      branch,
      changed_files: changedFiles,
      commit_status: "completed",
      push_status: "already_synced",
      local_commit_sha: localSha,
      remote_commit_sha: currentRemoteSha,
      commit_message: commitMessage,
      push_attempts: 0,
      push_transport: "local",
      duration_ms: Date.now() - started
    }, stateContext);
  }
  let securityReceipt = await validateLatestSecurityReleaseReceipt(config, guard, workspace, {
    expected_paths: changedFiles,
    expected_commit_sha: localSha,
    rule_set_version: SECURITY_RULE_SET_VERSION
  });
  let releaseSafety: GitFinalizeReleaseSafetySummary;
  if (securityReceipt.valid && securityReceipt.receipt) {
    releaseSafety = {
      mode: securityReceipt.receipt.mode,
      verdict: "allow",
      status: "pass",
      scan_complete: true,
      reason_codes: ["security_receipt_reused"],
      receipt_path: securityReceipt.path,
      receipt_id: securityReceipt.receipt.receipt_id,
      receipt_valid: true,
      receipt_validation_reasons: []
    };
  } else {
    if (previous) await publishGitRetryStarted(config, guard, workspace, previous);
    const incrementalResult = await runReleaseSafetyDecisionGate(config, guard, workspace, {
      mode: "incremental",
      candidate_paths: changedFiles,
      write_receipt: true
    });
    releaseSafety = {
      mode: "incremental",
      verdict: incrementalResult.decision.verdict,
      status: incrementalResult.status,
      scan_complete: incrementalResult.scan_complete,
      reason_codes: [...incrementalResult.decision.reason_codes],
      ...(incrementalResult.receipt?.path ? { receipt_path: incrementalResult.receipt.path } : {}),
      ...(incrementalResult.receipt?.receipt_id ? { receipt_id: incrementalResult.receipt.receipt_id } : {}),
      receipt_valid: false,
      receipt_validation_reasons: [...securityReceipt.reasons]
    };
    if (securityBaselineUnavailable(incrementalResult.decision.reason_codes)) {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "waiting",
        reason_code: "push_waiting_security_baseline",
        reasons: ["Push remains queued because the incremental Git security baseline is unavailable. No full scan or push was attempted."],
        release_safety: releaseSafety,
        branch,
        changed_files: changedFiles,
        commit_status: "completed",
        push_status: "waiting_security_baseline",
        local_commit_sha: localSha,
        commit_message: commitMessage,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
    if (!incrementalResult.ok || incrementalResult.decision.verdict !== "allow" || !incrementalResult.scan_complete || incrementalResult.receipt?.status !== "written") {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "blocked",
        reason_code: "push_security_evidence_blocked",
        reasons: [`Push security evidence was not valid: ${incrementalResult.decision.reason_codes.join(", ") || incrementalResult.status}.`],
        release_safety: releaseSafety,
        branch,
        changed_files: changedFiles,
        commit_status: "completed",
        push_status: "failed",
        local_commit_sha: localSha,
        commit_message: commitMessage,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
    const sealedReceipt = await sealLatestSecurityReleaseReceiptForCommit(config, guard, workspace, {
      expected_paths: changedFiles,
      commit_sha: localSha,
      rule_set_version: SECURITY_RULE_SET_VERSION
    });
    releaseSafety.receipt_valid = sealedReceipt.valid;
    releaseSafety.receipt_validation_reasons = [...sealedReceipt.reasons];
    if (!sealedReceipt.valid) {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "blocked",
        reason_code: "push_security_receipt_invalid",
        reasons: [`Push security receipt could not be sealed to the current commit: ${sealedReceipt.reasons.join(", ")}.`],
        release_safety: releaseSafety,
        branch,
        changed_files: changedFiles,
        commit_status: "completed",
        push_status: "failed",
        local_commit_sha: localSha,
        commit_message: commitMessage,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
    securityReceipt = await validateLatestSecurityReleaseReceipt(config, guard, workspace, {
      expected_paths: changedFiles,
      expected_commit_sha: localSha,
      rule_set_version: SECURITY_RULE_SET_VERSION
    });
    releaseSafety.receipt_valid = securityReceipt.valid;
    releaseSafety.receipt_validation_reasons = [...securityReceipt.reasons];
    if (!securityReceipt.valid) {
      return await finishPersisted(config, guard, workspace, {
        ok: false,
        status: "blocked",
        reason_code: "push_security_receipt_invalid",
        reasons: [`Push security receipt is invalid for the current commit: ${securityReceipt.reasons.join(", ")}.`],
        release_safety: releaseSafety,
        branch,
        changed_files: changedFiles,
        commit_status: "completed",
        push_status: "failed",
        local_commit_sha: localSha,
        commit_message: commitMessage,
        push_attempts: 0,
        duration_ms: Date.now() - started
      }, stateContext);
    }
  }
  const exactPush = pushExactCommit(config, workspace, branch, localSha);
  const push = exactPush.execution;
  if (!push.ok) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: push.error_code ?? "failed_unknown",
      reasons: [
        gitFailure(push.final_result),
        `${push.attempts > 1 ? "One controlled retry was attempted" : "No automatic retry was attempted"}. Run manually: ${exactPush.manualCommand}`
      ],
      branch,
      changed_files: changedFiles,
      commit_status: "completed",
      push_status: "failed",
      local_commit_sha: localSha,
      commit_message: commitMessage,
      push_attempts: push.attempts,
      push_transport: push.transport,
      push_error_code: push.error_code,
      push_started_at: push.push_started_at,
      git_process_exited_at: push.git_process_exited_at,
      push_duration_ms: push.push_duration_ms,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  const verifiedRemoteSha = remoteBranchSha(config, workspace, exactPush.remote, branch);
  if (verifiedRemoteSha !== localSha) {
    return await finishPersisted(config, guard, workspace, {
      ok: false,
      status: "failed",
      reason_code: "push_delivery_unknown_remote_verification_failed",
      reasons: ["Git reported push success, but the remote branch could not be verified at the exact local commit SHA."],
      release_safety: releaseSafety,
      branch,
      changed_files: changedFiles,
      commit_status: "completed",
      push_status: "failed",
      local_commit_sha: localSha,
      remote_commit_sha: verifiedRemoteSha,
      commit_message: commitMessage,
      push_attempts: push.attempts,
      push_transport: push.transport,
      push_started_at: push.push_started_at,
      git_process_exited_at: push.git_process_exited_at,
      push_duration_ms: push.push_duration_ms,
      duration_ms: Date.now() - started
    }, stateContext);
  }
  return await finishPersisted(config, guard, workspace, {
    ok: true,
    status: "completed",
    reason_code: "git_push_completed",
    reasons: ["The exact commit SHA was pushed and verified on the remote branch."],
    release_safety: releaseSafety,
    branch,
    changed_files: changedFiles,
    commit_status: "completed",
    push_status: "completed",
    local_commit_sha: localSha,
    remote_commit_sha: verifiedRemoteSha,
    commit_message: commitMessage,
    push_attempts: push.attempts,
    push_transport: push.transport,
    push_started_at: push.push_started_at,
    git_process_exited_at: push.git_process_exited_at,
    push_duration_ms: push.push_duration_ms,
    duration_ms: Date.now() - started
  }, stateContext);
}
