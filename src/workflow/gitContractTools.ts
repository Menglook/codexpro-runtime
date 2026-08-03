import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import { SECURITY_RULE_SET_VERSION } from "./securityAudit.js";
import { runReleaseSafetyDecisionGate } from "./securityReleaseGate.js";
import { sealLatestSecurityReleaseReceiptForCommit } from "./securityReleaseReceipt.js";
import { writeLatestGitFinalizationRecord } from "./gitFinalizationState.js";

export interface GitContractPrepareOptions {
  selectedPaths?: string[];
  validationRefs: string[];
  commitMessage?: string;
}

export interface GitContractCommitOptions extends GitContractPrepareOptions {
  selectedPaths: string[];
  expectedHeadSha: string;
  expectedBranch: string;
  commitMessage: string;
}

export interface GitContractPushOptions {
  commitSha: string;
  branch: string;
  remote: string;
  expectedRemoteSha: string | null;
}

interface GitCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface GitRemoteState {
  remote: string;
  branch: string;
  local_head_sha: string;
  remote_head_sha: string | null;
  ahead: number | null;
  behind: number | null;
  synchronized: boolean;
}

function runGit(config: CodexProConfig, workspace: Workspace, args: string[], sideEffectLevel: "local_read" | "local_write" | "external_write" = "local_read"): GitCommandResult {
  const result = runProcessSync("git", args, {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: sideEffectLevel === "external_write" ? 120_000 : 30_000,
    maxOutputBytes: config.maxOutputBytes,
    domain: "git",
    operation: args[0] ?? "git",
    sideEffectLevel,
    riskLevel: sideEffectLevel === "external_write" ? "high" : sideEffectLevel === "local_write" ? "medium" : "low",
    returnRawStdout: true,
    returnRawStderr: true
  });
  return {
    ok: !result.spawnError && result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ""),
    stderr: redactSensitiveText(String(result.stderr ?? ""))
  };
}

function requireGit(config: CodexProConfig, workspace: Workspace, args: string[], action: string, sideEffectLevel: "local_read" | "local_write" | "external_write" = "local_read"): string {
  const result = runGit(config, workspace, args, sideEffectLevel);
  if (!result.ok) throw new CodexProError(`${action} failed: ${result.stderr.trim() || redactSensitiveText(result.stdout.trim()) || `git exit ${result.exitCode ?? "unknown"}`}`);
  return result.stdout.trim();
}

function currentBranch(config: CodexProConfig, workspace: Workspace): string {
  return requireGit(config, workspace, ["branch", "--show-current"], "Read current branch") || "HEAD";
}

function currentHead(config: CodexProConfig, workspace: Workspace): string {
  return requireGit(config, workspace, ["rev-parse", "HEAD"], "Read current HEAD");
}

function normalizePath(guard: PathGuard, workspace: Workspace, value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || trimmed === ".") throw new CodexProError("Git contract tools require exact file paths; workspace-wide path '.' is not allowed.");
  return guard.resolve(workspace, trimmed).relPath.replace(/\\/g, "/");
}

function normalizePaths(guard: PathGuard, workspace: Workspace, values: string[]): string[] {
  return [...new Set(values.map((value) => normalizePath(guard, workspace, value)))].sort();
}

function statusPaths(config: CodexProConfig, workspace: Workspace): string[] {
  const result = runGit(config, workspace, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (!result.ok) throw new CodexProError(`Read Git status failed: ${result.stderr.trim() || redactSensitiveText(result.stdout.trim()) || `git exit ${result.exitCode ?? "unknown"}`}`);
  const tokens = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    paths.push(token.slice(3).replace(/\\/g, "/"));
    if (token[0] === "R" || token[0] === "C" || token[1] === "R" || token[1] === "C") index += 1;
  }
  return [...new Set(paths)].sort();
}

function nameOnly(config: CodexProConfig, workspace: Workspace, args: string[]): string[] {
  const output = requireGit(config, workspace, args, `Read ${args[1] ?? "Git paths"}`);
  return [...new Set(output.split("\0").map((item) => item.trim().replace(/\\/g, "/")).filter(Boolean))].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validationEvidence(workspace: Workspace, refs: string[]): { refs: string[]; missing: string[] } {
  const normalized = [...new Set(refs.map((item) => item.trim()).filter(Boolean))];
  const missing = normalized.filter((item) => {
    if (/^(?:sha256|validation|acceptance|browser|run|event):/i.test(item)) return false;
    const absolute = path.resolve(workspace.root, item);
    return !absolute.startsWith(`${path.resolve(workspace.root)}${path.sep}`) || !fs.existsSync(absolute);
  });
  return { refs: normalized, missing };
}

function riskPaths(paths: string[]): string[] {
  return paths.filter((item) => /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|credentials?|secrets?)(?:\/|\.|$)|\.(?:pem|key|p12|pfx)$/i.test(item));
}

function securityBaselineUnavailable(reasonCodes: string[]): boolean {
  return reasonCodes.some((code) => ["git_upstream_unavailable", "git_merge_base_unavailable", "git_baseline_unavailable"].includes(code));
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function remoteHead(config: CodexProConfig, workspace: Workspace, remote: string, branch: string): string | null {
  const result = runGit(config, workspace, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  if (!result.ok) throw new CodexProError(`Read remote state failed: ${result.stderr.trim() || redactSensitiveText(result.stdout.trim())}`);
  const sha = result.stdout.trim().split(/\s+/, 1)[0];
  return /^[a-f0-9]{40,64}$/i.test(sha) ? sha : null;
}

export function gitGetRemoteState(config: CodexProConfig, workspace: Workspace, options: { remote?: string; branch?: string } = {}): GitRemoteState {
  const branch = options.branch?.trim() || currentBranch(config, workspace);
  const remote = options.remote?.trim() || "origin";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) throw new CodexProError(`Invalid Git branch: ${branch}`);
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) throw new CodexProError(`Invalid Git remote: ${remote}`);
  const localHead = currentHead(config, workspace);
  const remoteSha = remoteHead(config, workspace, remote, branch);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (remoteSha) {
    const remoteObjectAvailable = runGit(config, workspace, ["cat-file", "-e", `${remoteSha}^{commit}`]).ok;
    if (remoteObjectAvailable) {
      const counts = requireGit(config, workspace, ["rev-list", "--left-right", "--count", `${remoteSha}...${localHead}`], "Compare local and remote").split(/\s+/).map(Number);
      if (counts.length >= 2 && counts.every(Number.isFinite)) {
        behind = counts[0];
        ahead = counts[1];
      }
    }
  }
  return {
    remote,
    branch,
    local_head_sha: localHead,
    remote_head_sha: remoteSha,
    ahead,
    behind,
    synchronized: remoteSha === localHead
  };
}

export function gitPrepareCommit(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: GitContractPrepareOptions) {
  const branch = currentBranch(config, workspace);
  const head = currentHead(config, workspace);
  const changed = statusPaths(config, workspace);
  const selected = options.selectedPaths?.length ? normalizePaths(guard, workspace, options.selectedPaths) : changed;
  const unknown = selected.filter((item) => !changed.includes(item));
  const validation = validationEvidence(workspace, options.validationRefs);
  const sensitive = riskPaths(selected);
  const blockers = [
    ...(!selected.length ? ["no_selected_changes"] : []),
    ...(unknown.length ? ["selected_paths_not_changed"] : []),
    ...(!validation.refs.length ? ["validation_refs_required"] : []),
    ...(validation.missing.length ? ["validation_refs_missing"] : []),
    ...(sensitive.length ? ["sensitive_paths_selected"] : [])
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length ? "blocked" : "completed",
    branch,
    prepared_head_sha: head,
    candidate_paths: changed,
    selected_paths: selected,
    unexpected_paths: unknown,
    validation_refs: validation.refs,
    missing_validation_refs: validation.missing,
    sensitive_paths: sensitive,
    proposed_commit_message: options.commitMessage?.trim() || null,
    blockers,
    commit_executed: false,
    push_executed: false,
    summary: blockers.length ? `Git commit preparation blocked: ${blockers.join(", ")}.` : `Prepared ${selected.length} exact path(s) at ${head.slice(0, 12)}; no commit or push executed.`
  };
}

export async function gitCommitExact(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: GitContractCommitOptions) {
  const prepared = gitPrepareCommit(config, guard, workspace, options);
  if (!prepared.ok) throw new CodexProError(prepared.summary);
  if (prepared.prepared_head_sha !== options.expectedHeadSha) throw new CodexProError(`Git HEAD changed after preparation: expected ${options.expectedHeadSha}, found ${prepared.prepared_head_sha}.`);
  if (prepared.branch !== options.expectedBranch) throw new CodexProError(`Git branch changed after preparation: expected ${options.expectedBranch}, found ${prepared.branch}.`);

  const stagedBefore = nameOnly(config, workspace, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  const unrelatedStaged = stagedBefore.filter((item) => !prepared.selected_paths.includes(item));
  if (unrelatedStaged.length) throw new CodexProError(`Unrelated staged paths block exact commit: ${unrelatedStaged.join(", ")}.`);

  const security = await runReleaseSafetyDecisionGate(config, guard, workspace, {
    mode: "incremental",
    candidate_paths: prepared.selected_paths,
    write_receipt: true,
    fail_on_warnings: true
  });
  const baselineWaiting = securityBaselineUnavailable(security.decision.reason_codes);
  if (!baselineWaiting && (!security.ok || security.decision.verdict !== "allow" || !security.scan_complete || security.receipt?.status !== "written")) {
    throw new CodexProError(`Git security gate blocked the exact commit: ${security.decision.reason_codes.join(", ") || security.status}.`);
  }
  const scans = [{
    mode: "incremental",
    paths: prepared.selected_paths,
    status: security.status,
    scan_complete: security.scan_complete,
    finding_count: security.findings.length,
    receipt_id: security.receipt?.receipt_id ?? null,
    reused_after_commit: !baselineWaiting
  }];

  requireGit(config, workspace, ["add", "--", ...prepared.selected_paths], "Stage exact Git paths", "local_write");
  const staged = nameOnly(config, workspace, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  if (!sameStrings(staged, prepared.selected_paths)) throw new CodexProError(`Exact staging verification failed; expected [${prepared.selected_paths.join(", ")}], found [${staged.join(", ")}].`);

  const parentSha = currentHead(config, workspace);
  requireGit(config, workspace, ["commit", "-m", options.commitMessage], "Create Git commit", "local_write");
  const commitSha = currentHead(config, workspace);
  const committedPaths = nameOnly(config, workspace, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", commitSha]);
  if (!sameStrings(committedPaths, prepared.selected_paths)) throw new CodexProError(`Committed path verification failed; expected [${prepared.selected_paths.join(", ")}], found [${committedPaths.join(", ")}].`);
  let securityReceiptValid = false;
  let securityReceiptReasons: string[] = [];
  if (!baselineWaiting) {
    const sealedReceipt = await sealLatestSecurityReleaseReceiptForCommit(config, guard, workspace, {
      expected_paths: committedPaths,
      commit_sha: commitSha,
      rule_set_version: SECURITY_RULE_SET_VERSION
    });
    securityReceiptValid = sealedReceipt.valid;
    securityReceiptReasons = [...sealedReceipt.reasons];
    if (!sealedReceipt.valid) throw new CodexProError(`Git security receipt could not be sealed to the exact commit blobs: ${sealedReceipt.reasons.join(", ")}.`);
  }
  await writeLatestGitFinalizationRecord(config, guard, workspace, {
    source_run_id: null,
    acceptance_report_path: null,
    implementation_status: "completed",
    acceptance_status: "unknown",
    branch: prepared.branch,
    changed_files: committedPaths,
    commit_status: "completed",
    push_status: "not_requested",
    local_commit_sha: commitSha,
    remote_commit_sha: null,
    commit_message: options.commitMessage,
    push_transport: null,
    push_attempts: 0,
    push_error_code: null,
    reason_code: baselineWaiting ? "git_commit_completed_security_baseline_pending" : "git_commit_completed",
    reason: baselineWaiting
      ? "The exact local commit completed. Push security evidence will be generated when push is requested."
      : "The exact local commit completed and its security receipt was sealed to the committed blobs.",
    last_action: "git_commit"
  });
  const remainingPaths = statusPaths(config, workspace);
  const hashes = Object.fromEntries(prepared.selected_paths.flatMap((relativePath) => {
    const absolute = path.resolve(workspace.root, relativePath);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? [[relativePath, hashFile(absolute)]] : [];
  }));
  return {
    ok: true,
    status: "completed",
    branch: prepared.branch,
    parent_sha: parentSha,
    commit_sha: commitSha,
    committed_paths: committedPaths,
    remaining_paths: remainingPaths,
    validation_refs: prepared.validation_refs,
    security_scans: scans,
    security_receipt_valid: securityReceiptValid,
    security_receipt_reasons: securityReceiptReasons,
    content_sha256: hashes,
    commit_message: options.commitMessage,
    push_executed: false,
    summary: `Created commit ${commitSha.slice(0, 12)} with ${committedPaths.length} exact path(s); push not executed.`
  };
}

export function gitPushExact(config: CodexProConfig, workspace: Workspace, options: GitContractPushOptions) {
  if (!/^[a-f0-9]{40,64}$/i.test(options.commitSha)) throw new CodexProError("git_push requires an exact full commit SHA.");
  const stateBefore = gitGetRemoteState(config, workspace, { remote: options.remote, branch: options.branch });
  if (stateBefore.local_head_sha !== options.commitSha) throw new CodexProError(`Local HEAD ${stateBefore.local_head_sha} does not match requested commit ${options.commitSha}.`);
  if (stateBefore.remote_head_sha !== options.expectedRemoteSha) {
    throw new CodexProError(`Remote advanced unexpectedly: expected ${options.expectedRemoteSha ?? "no branch"}, found ${stateBefore.remote_head_sha ?? "no branch"}.`);
  }
  if (stateBefore.remote_head_sha) {
    const ancestor = runGit(config, workspace, ["merge-base", "--is-ancestor", stateBefore.remote_head_sha, options.commitSha]);
    if (!ancestor.ok) throw new CodexProError("Remote branch is not an ancestor of the requested commit; non-fast-forward push is blocked.");
  }
  requireGit(config, workspace, ["push", "--porcelain", options.remote, `${options.commitSha}:refs/heads/${options.branch}`], "Push exact Git commit", "external_write");
  const stateAfter = gitGetRemoteState(config, workspace, { remote: options.remote, branch: options.branch });
  if (stateAfter.remote_head_sha !== options.commitSha) throw new CodexProError(`Remote verification failed: expected ${options.commitSha}, found ${stateAfter.remote_head_sha ?? "no branch"}.`);
  return {
    ok: true,
    status: "completed",
    commit_sha: options.commitSha,
    remote: options.remote,
    branch: options.branch,
    refspec: `${options.commitSha}:refs/heads/${options.branch}`,
    force_used: false,
    remote_before_sha: stateBefore.remote_head_sha,
    remote_after_sha: stateAfter.remote_head_sha,
    synchronized: stateAfter.synchronized,
    summary: `Pushed and verified ${options.commitSha.slice(0, 12)} on ${options.remote}/${options.branch} without force.`
  };
}
