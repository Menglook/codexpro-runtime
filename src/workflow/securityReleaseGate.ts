import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { isSubpath, type PathGuard, type Workspace } from "../guard.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import {
  SECURITY_RULE_SET_VERSION,
  runReleaseTargetScan,
  type SecurityCategory,
  type SecurityFindingV2,
  type SecurityScanCacheSummary,
  type SecurityScanOptions,
  type SecurityScanResult,
  type SecuritySeverity
} from "./securityAudit.js";
import {
  DEFAULT_SECURITY_BASELINE_PATH,
  DEFAULT_SECURITY_POLICY_PATH,
  SecurityBaselineError,
  createSecurityBaselineProposal,
  loadSecurityBaselineFile,
  loadSecurityPolicyFile,
  parseSecurityBaselineFile,
  parseSecurityPolicyFile,
  summarizeSecurityBaselineDiff,
  type SecurityBaselineApplicationSummary,
  type SecurityBaselineProposal
} from "./securityBaseline.js";
import {
  SecurityIncrementalError,
  runGitIncrementalSecurityCheck,
  type SecurityIncrementalFindingRecord,
  type SecurityIncrementalOptions,
  type SecurityIncrementalResult
} from "./securityIncremental.js";
import {
  writeSecurityReleaseReceipt,
  type SecurityReleaseReceiptSummary
} from "./securityReleaseReceipt.js";

export type ReleaseSafetyMode = "targeted" | "incremental" | "full" | "baseline_proposal";
export type ReleaseSafetyVerdict = "allow" | "block" | "proposal";

export interface ReleaseSafetyCheckOptions extends SecurityScanOptions, SecurityIncrementalOptions {
  mode?: ReleaseSafetyMode;
  write_receipt?: boolean;
}

export interface ReleaseSafetyBlocker {
  code:
    | "scan_truncated"
    | "findings_truncated"
    | "changed_file_unscanned"
    | "baseline_missing"
    | "baseline_invalid"
    | "baseline_expired"
    | "baseline_stale"
    | "new_high_risk"
    | "warning_policy"
    | "git_baseline_unavailable"
    | "release_check_failed";
  message: string;
  remediation: string;
  path?: string;
  rule?: string;
}

export interface ReleaseBaselineChangeSummary {
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
  resolved_entries: number;
  entries_added: number;
  entries_removed: number;
  entries_changed: number;
  entries_unchanged: number;
}

export interface ReleaseSafetyDecision {
  verdict: ReleaseSafetyVerdict;
  reason_codes: string[];
  blockers: ReleaseSafetyBlocker[];
  remediation_actions: string[];
  new_high_risk: number;
  modified_unconfirmed: number;
  resolved: number;
}

export interface ReleaseSafetyCheckResult {
  ok: boolean;
  status: "pass" | "warn" | "fail";
  scan_type: "release_safety_check";
  mode: ReleaseSafetyMode;
  root: string;
  target_path: string;
  scanned_files: number;
  skipped_files: number;
  unread_sensitive_files: number;
  truncated: boolean;
  scan_truncated: boolean;
  findings_truncated: boolean;
  scan_complete: boolean;
  counts: Record<SecuritySeverity, number>;
  category_counts: Record<SecurityCategory, number>;
  effective_counts: Record<SecuritySeverity, number>;
  effective_category_counts: Record<SecurityCategory, number>;
  findings: SecurityFindingV2[];
  modified_unconfirmed_findings: SecurityFindingV2[];
  baseline?: SecurityBaselineApplicationSummary;
  cache?: SecurityScanCacheSummary;
  baseline_changes: ReleaseBaselineChangeSummary;
  incremental?: SecurityIncrementalResult;
  baseline_proposal?: SecurityBaselineProposal;
  receipt?: SecurityReleaseReceiptSummary;
  decision: ReleaseSafetyDecision;
  text: string;
}

const RELEASE_REPORT_FINDING_LIMIT = 80;

function emptySeverityCounts(): Record<SecuritySeverity, number> {
  return { error: 0, warn: 0, info: 0 };
}

function emptyCategoryCounts(): Record<SecurityCategory, number> {
  return { secret: 0, command: 0, docker: 0, sql: 0, large_file: 0, debug: 0, scan: 0 };
}

function countFindings(findings: SecurityFindingV2[]): {
  counts: Record<SecuritySeverity, number>;
  categoryCounts: Record<SecurityCategory, number>;
} {
  const counts = emptySeverityCounts();
  const categoryCounts = emptyCategoryCounts();
  for (const finding of findings) {
    counts[finding.severity] += 1;
    categoryCounts[finding.category] += 1;
  }
  return { counts, categoryCounts };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function findingIsConfirmed(finding: SecurityFindingV2): boolean {
  return finding.baseline_status === "matched";
}

function findingIsHighRisk(finding: SecurityFindingV2): boolean {
  if (finding.severity === "info") return false;
  if (finding.severity === "error") return true;
  if (finding.category === "secret" && finding.confidence === "high") return true;
  const productionRole = ["runtime_entry", "production_source", "execution_script"].includes(finding.file_role);
  const executionEvidence = ["execution_sink", "database_sink", "command", "sql"].includes(finding.evidence_kind);
  return productionRole && executionEvidence && ["command", "docker", "sql"].includes(finding.category);
}

function blocker(
  code: ReleaseSafetyBlocker["code"],
  message: string,
  remediation: string,
  context: Pick<ReleaseSafetyBlocker, "path" | "rule"> = {}
): ReleaseSafetyBlocker {
  return { code, message, remediation, ...context };
}

async function workspaceFileExists(workspace: Workspace, relativePath: string): Promise<boolean> {
  const absolutePath = path.resolve(workspace.root, relativePath);
  if (!isSubpath(absolutePath, workspace.root)) {
    throw new SecurityBaselineError("path_outside_workspace", `Security path escapes workspace: ${relativePath}`);
  }
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveScanBaselineOptions(
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions,
  proposalMode = false
): Promise<{ scanOptions: SecurityScanOptions; summary: ReleaseBaselineChangeSummary }> {
  const policyPath = options.policy_path?.trim() || DEFAULT_SECURITY_POLICY_PATH;
  const explicitBaselinePath = options.baseline_path?.trim();
  const policyExists = await workspaceFileExists(workspace, policyPath);
  const defaultBaselineExists = await workspaceFileExists(workspace, explicitBaselinePath || DEFAULT_SECURITY_BASELINE_PATH);
  const explicitlyRequested = Boolean(options.policy_path?.trim() || explicitBaselinePath);
  const baseSummary: ReleaseBaselineChangeSummary = {
    status: "not_used",
    policy_path: policyPath,
    baseline_path: explicitBaselinePath || DEFAULT_SECURITY_BASELINE_PATH,
    policy_changed: false,
    baseline_changed: false,
    matched: 0,
    stale: 0,
    expired: 0,
    new: 0,
    suppressed: 0,
    unmatched_entries: 0,
    resolved_entries: 0,
    entries_added: 0,
    entries_removed: 0,
    entries_changed: 0,
    entries_unchanged: 0
  };

  if (!policyExists && !defaultBaselineExists && !explicitlyRequested) return { scanOptions: options, summary: baseSummary };
  if (!policyExists) throw new SecurityBaselineError("schema_invalid", `Security policy file is required: ${policyPath}`);
  const policy = await loadSecurityPolicyFile(workspace.root, policyPath);
  const baselinePath = explicitBaselinePath || policy.baseline.default_path;
  const baselineExists = await workspaceFileExists(workspace, baselinePath);
  const summary = { ...baseSummary, policy_path: policyPath, baseline_path: baselinePath };
  if (!baselineExists) {
    if (proposalMode) return { scanOptions: { ...options, policy_path: policyPath }, summary: { ...summary, status: "missing" } };
    throw new SecurityBaselineError("schema_invalid", `Security baseline file is required: ${baselinePath}`);
  }
  return {
    scanOptions: { ...options, policy_path: policyPath, baseline_path: baselinePath },
    summary: { ...summary, status: "valid" }
  };
}

function scanBaselineSummary(
  base: ReleaseBaselineChangeSummary,
  application: SecurityBaselineApplicationSummary | undefined
): ReleaseBaselineChangeSummary {
  if (!application) return base;
  return {
    ...base,
    status: "valid",
    matched: application.matched,
    stale: application.stale,
    expired: application.expired,
    new: application.new,
    suppressed: application.suppressed,
    unmatched_entries: application.unmatched_entries
  };
}

function changeTouchesPath(result: SecurityIncrementalResult, candidate: string): boolean {
  return result.changes.some((change) => change.path === candidate || change.old_path === candidate);
}

function readGitFileAtRef(workspace: Workspace, ref: string, relativePath: string): string | undefined {
  const result = runProcessSync("git", ["show", `${ref}:${relativePath}`], {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: 30_000,
    maxOutputBytes: 20_000_000,
    domain: "git",
    operation: "show",
    sideEffectLevel: "local_read",
    riskLevel: "low",
    returnRawStdout: true,
    returnRawStderr: false,
    componentTracking: false,
    lifecycleTracking: false,
    recordTracking: false,
    usageTracking: false
  });
  if (result.truncated) {
    throw new SecurityBaselineError("schema_invalid", `Historical security file output was truncated: ${relativePath}`);
  }
  if (result.exitCode !== 0) return undefined;
  return String(result.stdout ?? "");
}

function parseGitJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SecurityBaselineError("json_invalid", `${label} from the Git base is not valid JSON`);
  }
}

async function incrementalBaselineSummary(
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions,
  result: SecurityIncrementalResult
): Promise<ReleaseBaselineChangeSummary> {
  const policyPath = options.policy_path?.trim() || DEFAULT_SECURITY_POLICY_PATH;
  const explicitBaselinePath = options.baseline_path?.trim();
  const policyExists = await workspaceFileExists(workspace, policyPath);
  const currentPolicy = policyExists ? await loadSecurityPolicyFile(workspace.root, policyPath) : undefined;
  const baselinePath = explicitBaselinePath || currentPolicy?.baseline.default_path || DEFAULT_SECURITY_BASELINE_PATH;
  const baselineExists = await workspaceFileExists(workspace, baselinePath);
  const currentBaseline = currentPolicy && baselineExists
    ? await loadSecurityBaselineFile(workspace.root, baselinePath, currentPolicy)
    : undefined;

  const basePolicyText = readGitFileAtRef(workspace, result.merge_base_sha, policyPath);
  const basePolicy = basePolicyText ? parseSecurityPolicyFile(parseGitJson(basePolicyText, "security policy")) : undefined;
  const baseBaselinePath = explicitBaselinePath || basePolicy?.baseline.default_path || DEFAULT_SECURITY_BASELINE_PATH;
  const baseBaselineText = readGitFileAtRef(workspace, result.merge_base_sha, baseBaselinePath);
  const baseBaseline = basePolicy && baseBaselineText
    ? parseSecurityBaselineFile(parseGitJson(baseBaselineText, "security baseline"), basePolicy)
    : undefined;

  if (Boolean(basePolicy) !== Boolean(baseBaseline)) {
    throw new SecurityBaselineError("schema_invalid", "Git base contains an incomplete security policy/baseline pair");
  }

  const policyChanged = changeTouchesPath(result, policyPath);
  const baselineChanged = changeTouchesPath(result, baselinePath) || changeTouchesPath(result, baseBaselinePath);
  let status: ReleaseBaselineChangeSummary["status"];
  if (policyExists && baselineExists) status = "valid";
  else if (policyExists || baselineExists || basePolicy || baseBaseline || policyChanged || baselineChanged) status = "missing";
  else status = "not_used";

  let entriesAdded = 0;
  let entriesRemoved = 0;
  let entriesChanged = 0;
  let entriesUnchanged = 0;
  if (baseBaseline && currentBaseline) {
    const diff = summarizeSecurityBaselineDiff(baseBaseline, currentBaseline);
    entriesAdded = diff.added.length;
    entriesRemoved = diff.removed.length;
    entriesChanged = diff.changed.length;
    entriesUnchanged = diff.unchanged;
  } else if (currentBaseline) {
    entriesAdded = currentBaseline.entries.length;
  } else if (baseBaseline) {
    entriesRemoved = baseBaseline.entries.length;
  }

  const baselineRecords = result.findings.filter((record) => record.reason_code === "baseline_exact_match");
  return {
    status,
    policy_path: policyPath,
    baseline_path: baselinePath,
    policy_changed: policyChanged,
    baseline_changed: baselineChanged,
    matched: baselineRecords.length,
    stale: result.counts.stale,
    expired: result.counts.expired,
    new: result.counts.new,
    suppressed: baselineRecords.length,
    unmatched_entries: 0,
    resolved_entries: result.findings.filter((record) => record.lifecycle === "resolved" && record.source === "baseline").length,
    entries_added: entriesAdded,
    entries_removed: entriesRemoved,
    entries_changed: entriesChanged,
    entries_unchanged: entriesUnchanged
  };
}

function scanDecision(
  scan: SecurityScanResult,
  baselineChanges: ReleaseBaselineChangeSummary,
  failOnWarnings: boolean
): { blockers: ReleaseSafetyBlocker[]; unconfirmed: SecurityFindingV2[]; newHighRisk: SecurityFindingV2[] } {
  const blockers: ReleaseSafetyBlocker[] = [];
  if (scan.scan_truncated) {
    blockers.push(blocker("scan_truncated", "The candidate file scan was truncated.", "Increase max_files or narrow the targeted path, then rerun the release check."));
  }
  if (scan.findings_truncated) {
    blockers.push(blocker("findings_truncated", "The scanner reached its retained-finding limit.", "Narrow the scan scope or remediate findings, then rerun until findings_truncated=false."));
  }
  if (baselineChanges.expired > 0) {
    blockers.push(blocker("baseline_expired", `${baselineChanges.expired} accepted-risk baseline finding(s) expired.`, "Re-review each expired risk and either remediate it or create a newly approved entry with a valid expiry."));
  }
  if (baselineChanges.stale > 0) {
    blockers.push(blocker("baseline_stale", `${baselineChanges.stale} baseline confirmation(s) no longer match current evidence.`, "Re-review changed evidence; do not migrate the old approval automatically."));
  }

  const unconfirmed = scan.findings.filter((finding) => !findingIsConfirmed(finding));
  const newHighRisk = unconfirmed.filter((finding) => finding.baseline_status !== "expired" && finding.baseline_status !== "stale" && findingIsHighRisk(finding));
  for (const finding of newHighRisk) {
    blockers.push(blocker(
      "new_high_risk",
      `New high-risk finding ${finding.category}/${finding.rule} blocks release.`,
      "Remove the risky value or execution path. For a justified historical exception, create a baseline proposal and obtain manual approval.",
      { path: finding.path, rule: finding.rule }
    ));
  }
  if (failOnWarnings && unconfirmed.some((finding) => finding.severity === "warn")) {
    blockers.push(blocker("warning_policy", "Unconfirmed warning findings are configured to block release.", "Resolve the warnings or complete a manually approved baseline review."));
  }
  return { blockers, unconfirmed, newHighRisk };
}

function normalizeIncrementalFindingForRelease(finding: SecurityFindingV2): SecurityFindingV2 {
  if (finding.evidence_kind === "controlled_test_vector") {
    return {
      ...finding,
      severity: "info",
      message: finding.message.includes("controlled synthetic test vector")
        ? finding.message
        : `${finding.message}; controlled synthetic test vector`
    };
  }
  return finding;
}

function incrementalUnconfirmed(records: SecurityIncrementalFindingRecord[]): SecurityFindingV2[] {
  return records
    .filter((record) => record.source === "current" && record.finding && record.reason_code !== "baseline_exact_match")
    .map((record) => normalizeIncrementalFindingForRelease(record.finding as SecurityFindingV2));
}

function incrementalDecision(
  result: SecurityIncrementalResult,
  failOnWarnings: boolean
): { blockers: ReleaseSafetyBlocker[]; unconfirmed: SecurityFindingV2[]; newHighRisk: SecurityFindingV2[] } {
  const blockers: ReleaseSafetyBlocker[] = [];
  for (const issue of result.issues) {
    blockers.push(blocker(
      "changed_file_unscanned",
      `Changed-file scan is incomplete: ${issue.message}`,
      "Make the changed file readable and fully scannable, then rerun the incremental release check.",
      issue.path ? { path: issue.path } : {}
    ));
  }
  const stale = result.findings.filter((record) => record.lifecycle === "stale");
  const expired = result.findings.filter((record) => record.lifecycle === "expired");
  if (stale.length) {
    blockers.push(blocker("baseline_stale", `${stale.length} historical confirmation(s) were invalidated.`, "Re-review the changed evidence and create a new manually approved baseline entry only when justified."));
  }
  if (expired.length) {
    blockers.push(blocker("baseline_expired", `${expired.length} accepted-risk confirmation(s) expired.`, "Remediate or renew each accepted risk through manual approval with a new expiry."));
  }

  const newFindings = result.findings
    .filter((record) => record.lifecycle === "new" && record.finding)
    .map((record) => normalizeIncrementalFindingForRelease(record.finding as SecurityFindingV2));
  const newHighRisk = newFindings.filter(findingIsHighRisk);
  for (const finding of newHighRisk) {
    blockers.push(blocker(
      "new_high_risk",
      `New high-risk finding ${finding.category}/${finding.rule} blocks release.`,
      "Remove the risky value or production execution path before release.",
      { path: finding.path, rule: finding.rule }
    ));
  }
  if (failOnWarnings && newFindings.some((finding) => finding.severity === "warn")) {
    blockers.push(blocker("warning_policy", "New warning findings are configured to block release.", "Resolve the warnings or complete a manually approved review."));
  }
  return { blockers, unconfirmed: incrementalUnconfirmed(result.findings), newHighRisk };
}

function decisionFrom(
  mode: ReleaseSafetyMode,
  blockers: ReleaseSafetyBlocker[],
  newHighRisk: number,
  modifiedUnconfirmed: number,
  resolved: number
): ReleaseSafetyDecision {
  const verdict: ReleaseSafetyVerdict = mode === "baseline_proposal" ? "proposal" : blockers.length ? "block" : "allow";
  return {
    verdict,
    reason_codes: uniqueStrings(blockers.map((item) => item.code)),
    blockers,
    remediation_actions: uniqueStrings(blockers.map((item) => item.remediation)),
    new_high_risk: newHighRisk,
    modified_unconfirmed: modifiedUnconfirmed,
    resolved
  };
}

function statusFromDecision(
  decision: ReleaseSafetyDecision,
  findings: SecurityFindingV2[],
  proposal?: SecurityBaselineProposal
): { ok: boolean; status: ReleaseSafetyCheckResult["status"] } {
  if (decision.verdict === "block") return { ok: false, status: "fail" };
  if (proposal?.entries.length || findings.some((finding) => finding.severity === "warn")) return { ok: true, status: "warn" };
  return { ok: true, status: "pass" };
}

function formatLocation(finding: SecurityFindingV2): string {
  if (finding.line && finding.column) return `${finding.path}:${finding.line}:${finding.column}`;
  if (finding.line) return `${finding.path}:${finding.line}`;
  return finding.path;
}

function renderReleaseReport(result: Omit<ReleaseSafetyCheckResult, "text">): string {
  const lines = [
    "# Release Safety Check",
    "",
    `Mode: ${result.mode}`,
    `Decision: ${result.decision.verdict.toUpperCase()}`,
    `Status: ${result.status.toUpperCase()}`,
    `Target: ${result.target_path}`,
    `Scan complete: ${result.scan_complete}`,
    `Scanned files: ${result.scanned_files}`,
    `Changed files: ${result.incremental?.changed_files.length ?? 0}`,
    `New high risk: ${result.decision.new_high_risk}`,
    `Modified-file unconfirmed: ${result.decision.modified_unconfirmed}`,
    `Resolved: ${result.decision.resolved}`,
    `Baseline: status=${result.baseline_changes.status}, policy_changed=${result.baseline_changes.policy_changed}, baseline_changed=${result.baseline_changes.baseline_changed}, matched=${result.baseline_changes.matched}, stale=${result.baseline_changes.stale}, expired=${result.baseline_changes.expired}, new=${result.baseline_changes.new}, resolved=${result.baseline_changes.resolved_entries}, entries_added=${result.baseline_changes.entries_added}, entries_removed=${result.baseline_changes.entries_removed}, entries_changed=${result.baseline_changes.entries_changed}, entries_unchanged=${result.baseline_changes.entries_unchanged}`,
    `Receipt: status=${result.receipt?.status ?? "not_requested"}, eligible=${result.receipt?.eligible ?? false}, path=${result.receipt?.path ?? "none"}`,
    "Values: never printed; matched values, tokens, passwords, cookies, and private-key contents remain redacted.",
    "",
    "## Blocking reasons",
    ""
  ];
  if (!result.decision.blockers.length) lines.push("- none");
  for (const item of result.decision.blockers) {
    const location = item.path ? ` ${item.path}${item.rule ? ` rule=${item.rule}` : ""}` : "";
    lines.push(`- ${item.code}${location} — ${item.message}`);
    lines.push(`  Fix: ${item.remediation}`);
  }
  lines.push("", "## Modified-file unconfirmed risks", "");
  const shown = result.modified_unconfirmed_findings.slice(0, RELEASE_REPORT_FINDING_LIMIT);
  if (!shown.length) lines.push("- none");
  for (const finding of shown) {
    lines.push(`- ${finding.severity.toUpperCase()} ${finding.category}/${finding.rule} ${formatLocation(finding)} baseline=${finding.baseline_status}`);
  }
  if (result.modified_unconfirmed_findings.length > shown.length) {
    lines.push(`- report preview limited: ${shown.length} of ${result.modified_unconfirmed_findings.length} retained findings shown`);
  }
  if (result.baseline_proposal) {
    lines.push("", "## Baseline proposal", "", `- Proposal: ${result.baseline_proposal.proposal_id}`);
    lines.push(`- Candidates: ${result.baseline_proposal.entries.length}`);
    lines.push("- Manual approval is required; no baseline file was written.");
  }
  if (result.decision.remediation_actions.length) {
    lines.push("", "## Required remediation", "");
    for (const action of result.decision.remediation_actions) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

function buildResult(input: Omit<ReleaseSafetyCheckResult, "text">): ReleaseSafetyCheckResult {
  return { ...input, text: renderReleaseReport(input) };
}

function failureCode(error: unknown): ReleaseSafetyBlocker["code"] {
  if (error instanceof SecurityBaselineError) {
    return /required|missing|does not exist/i.test(error.message) ? "baseline_missing" : "baseline_invalid";
  }
  if (error instanceof SecurityIncrementalError) {
    if (error.code === "baseline_unavailable") return "baseline_missing";
    if (error.code === "changed_file_scan_incomplete" || error.code === "changed_file_too_large") return "changed_file_unscanned";
    return "git_baseline_unavailable";
  }
  return "release_check_failed";
}

function failureRemediation(code: ReleaseSafetyBlocker["code"]): string {
  if (code === "baseline_missing") return "Restore the policy and baseline pair, or explicitly run baseline_proposal to prepare candidates for manual approval.";
  if (code === "baseline_invalid") return "Repair the policy or baseline schema/integrity digest; do not bypass or regenerate approvals automatically.";
  if (code === "changed_file_unscanned") return "Make every changed file fully scannable and rerun the release check.";
  if (code === "git_baseline_unavailable") return "Restore the Git upstream/common-ancestor reference or provide an explicit base_ref, then rerun.";
  return "Inspect the release-check failure, correct the underlying issue, and rerun the same mode.";
}

function failedResult(workspace: Workspace, mode: ReleaseSafetyMode, error: unknown): ReleaseSafetyCheckResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = failureCode(error);
  const item = blocker(code, message, failureRemediation(code));
  const decision = decisionFrom(mode, [item], 0, 0, 0);
  const baselineChanges: ReleaseBaselineChangeSummary = {
    status: code === "baseline_missing" ? "missing" : code === "baseline_invalid" ? "invalid" : "not_used",
    policy_path: DEFAULT_SECURITY_POLICY_PATH,
    baseline_path: DEFAULT_SECURITY_BASELINE_PATH,
    policy_changed: false,
    baseline_changed: false,
    matched: 0,
    stale: 0,
    expired: 0,
    new: 0,
    suppressed: 0,
    unmatched_entries: 0,
    resolved_entries: 0,
    entries_added: 0,
    entries_removed: 0,
    entries_changed: 0,
    entries_unchanged: 0
  };
  return buildResult({
    ok: false,
    status: "fail",
    scan_type: "release_safety_check",
    mode,
    root: workspace.root,
    target_path: ".",
    scanned_files: 0,
    skipped_files: 0,
    unread_sensitive_files: 0,
    truncated: false,
    scan_truncated: false,
    findings_truncated: false,
    scan_complete: false,
    counts: emptySeverityCounts(),
    category_counts: emptyCategoryCounts(),
    effective_counts: emptySeverityCounts(),
    effective_category_counts: emptyCategoryCounts(),
    findings: [],
    modified_unconfirmed_findings: [],
    baseline_changes: baselineChanges,
    decision
  });
}

async function runScanMode(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions,
  mode: "targeted" | "full"
): Promise<ReleaseSafetyCheckResult> {
  const resolved = await resolveScanBaselineOptions(workspace, options);
  const scanOptions: SecurityScanOptions = { ...resolved.scanOptions, ...(mode === "full" ? { path: "." } : {}) };
  const scan = await runReleaseTargetScan(config, guard, workspace, scanOptions);
  const baselineChanges = scanBaselineSummary(resolved.summary, scan.baseline);
  const evaluated = scanDecision(scan, baselineChanges, Boolean(options.fail_on_warnings));
  const decision = decisionFrom(mode, evaluated.blockers, evaluated.newHighRisk.length, evaluated.unconfirmed.length, 0);
  const status = statusFromDecision(decision, evaluated.unconfirmed);
  return buildResult({
    ...scan,
    ...status,
    mode,
    scan_type: "release_safety_check",
    modified_unconfirmed_findings: evaluated.unconfirmed,
    baseline_changes: baselineChanges,
    decision
  });
}

async function runIncrementalMode(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions
): Promise<ReleaseSafetyCheckResult> {
  const incremental = await runGitIncrementalSecurityCheck(config, guard, workspace, options);
  const baselineChanges = await incrementalBaselineSummary(workspace, options, incremental);
  const evaluated = incrementalDecision(incremental, Boolean(options.fail_on_warnings));
  const findings = incremental.findings
    .filter((record) => record.source === "current" && record.finding)
    .map((record) => normalizeIncrementalFindingForRelease(record.finding as SecurityFindingV2));
  const currentScans = incremental.file_scans.filter((scan) => scan.snapshot === "current");
  const scannedFiles = currentScans.reduce((sum, scan) => sum + scan.scanned_files, 0);
  const skippedFiles = currentScans.reduce((sum, scan) => sum + scan.skipped_files, 0);
  const scannedPaths = new Set(currentScans.filter((scan) => scan.complete).map((scan) => scan.path));
  const missingChangedFiles = incremental.changed_files.filter((candidate) => !scannedPaths.has(candidate));
  const blockers = [...evaluated.blockers];
  if (baselineChanges.status === "missing") {
    blockers.push(blocker(
      "baseline_missing",
      "The release candidate removed or separated the security policy/baseline pair.",
      "Restore a complete, valid, manually approved policy/baseline pair before release."
    ));
  }
  if (baselineChanges.status === "invalid") {
    blockers.push(blocker(
      "baseline_invalid",
      "The changed security baseline cannot be validated.",
      "Repair the baseline schema or integrity digest and rerun the incremental release check."
    ));
  }
  for (const candidate of missingChangedFiles) {
    blockers.push(blocker("changed_file_unscanned", "A changed release candidate has no complete scan record.", "Ensure the file is a readable text candidate and rerun the incremental release check.", { path: candidate }));
  }
  const resolved = incremental.findings.filter((record) => record.lifecycle === "resolved").length;
  const decision = decisionFrom("incremental", blockers, evaluated.newHighRisk.length, evaluated.unconfirmed.length, resolved);
  const status = statusFromDecision(decision, evaluated.unconfirmed);
  const allCounts = countFindings(findings);
  const effectiveFindings = findings.filter((finding) => !findingIsConfirmed(finding));
  const effectiveCounts = countFindings(effectiveFindings);
  const scanComplete = blockers.every((item) => !["changed_file_unscanned", "scan_truncated", "findings_truncated", "git_baseline_unavailable"].includes(item.code));
  return buildResult({
    ok: status.ok,
    status: status.status,
    scan_type: "release_safety_check",
    mode: "incremental",
    root: workspace.root,
    target_path: ".",
    scanned_files: scannedFiles,
    skipped_files: skippedFiles,
    unread_sensitive_files: 0,
    truncated: !scanComplete,
    scan_truncated: false,
    findings_truncated: false,
    scan_complete: scanComplete,
    counts: allCounts.counts,
    category_counts: allCounts.categoryCounts,
    effective_counts: effectiveCounts.counts,
    effective_category_counts: effectiveCounts.categoryCounts,
    findings,
    modified_unconfirmed_findings: evaluated.unconfirmed,
    baseline_changes: baselineChanges,
    incremental,
    decision
  });
}

async function runBaselineProposalMode(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions
): Promise<ReleaseSafetyCheckResult> {
  const resolved = await resolveScanBaselineOptions(workspace, options, true);
  const policy = await loadSecurityPolicyFile(workspace.root, resolved.summary.policy_path);
  const scan = await runReleaseTargetScan(config, guard, workspace, resolved.scanOptions);
  const baselineChanges = scanBaselineSummary(resolved.summary, scan.baseline);
  const blockers: ReleaseSafetyBlocker[] = [];
  if (scan.scan_truncated) blockers.push(blocker("scan_truncated", "The candidate scan was truncated.", "Increase max_files or narrow path before creating a proposal."));
  if (scan.findings_truncated) blockers.push(blocker("findings_truncated", "The proposal candidate list was truncated.", "Narrow the scan or remediate findings before creating a complete proposal."));
  if (baselineChanges.expired > 0) blockers.push(blocker("baseline_expired", "Expired accepted risks must be re-reviewed before proposal generation is complete.", "Review expired entries and create new approvals only when justified."));
  if (baselineChanges.stale > 0) blockers.push(blocker("baseline_stale", "Stale historical confirmations require re-review.", "Review changed evidence; do not auto-migrate old approvals."));
  const candidates = scan.findings.filter((finding) => !findingIsConfirmed(finding));
  const proposal = createSecurityBaselineProposal(candidates, policy);
  const decision = decisionFrom("baseline_proposal", blockers, candidates.filter(findingIsHighRisk).length, candidates.length, 0);
  const status = blockers.length ? { ok: false, status: "fail" as const } : statusFromDecision(decision, candidates, proposal);
  return buildResult({
    ...scan,
    ...status,
    mode: "baseline_proposal",
    scan_type: "release_safety_check",
    modified_unconfirmed_findings: candidates,
    baseline_changes: baselineChanges,
    baseline_proposal: proposal,
    decision
  });
}

async function attachSecurityReceipt(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ReleaseSafetyCheckOptions,
  result: ReleaseSafetyCheckResult
): Promise<ReleaseSafetyCheckResult> {
  const eligibleMode = result.mode === "incremental" || result.mode === "full";
  if (options.write_receipt === false || !eligibleMode) {
    const receipt: SecurityReleaseReceiptSummary = {
      status: "not_eligible",
      path: `${config.contextDir}/security-receipts/latest.json`,
      eligible: false,
      reasons: [options.write_receipt === false ? "receipt_write_disabled" : "release_mode_not_eligible"]
    };
    const { text: _text, ...data } = result;
    return buildResult({ ...data, receipt });
  }
  const receipt = await writeSecurityReleaseReceipt(config, guard, workspace, {
    mode: result.mode as "incremental" | "full",
    rule_set_version: SECURITY_RULE_SET_VERSION,
    verdict: result.decision.verdict,
    scan_complete: result.scan_complete,
    ...(options.candidate_paths?.length
      ? { changed_files: options.candidate_paths }
      : result.incremental?.changed_files.length
        ? { changed_files: result.incremental.changed_files }
        : {}),
    baseline: {
      status: result.baseline_changes.status,
      policy_path: result.baseline_changes.policy_path,
      baseline_path: result.baseline_changes.baseline_path,
      policy_changed: result.baseline_changes.policy_changed,
      baseline_changed: result.baseline_changes.baseline_changed,
      matched: result.baseline_changes.matched,
      stale: result.baseline_changes.stale,
      expired: result.baseline_changes.expired,
      new: result.baseline_changes.new,
      suppressed: result.baseline_changes.suppressed,
      unmatched_entries: result.baseline_changes.unmatched_entries
    },
    ...(options.now ? { now: options.now } : {})
  });
  const { text: _text, ...data } = result;
  return buildResult({ ...data, receipt });
}

export async function runReleaseSafetyDecisionGate(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: SecurityScanOptions & Record<string, unknown> = {}
): Promise<ReleaseSafetyCheckResult> {
  const options = rawOptions as ReleaseSafetyCheckOptions;
  const mode = options.mode ?? "targeted";
  try {
    const result = mode === "incremental"
      ? await runIncrementalMode(config, guard, workspace, options)
      : mode === "full"
        ? await runScanMode(config, guard, workspace, options, "full")
        : mode === "baseline_proposal"
          ? await runBaselineProposalMode(config, guard, workspace, options)
          : await runScanMode(config, guard, workspace, options, "targeted");
    return await attachSecurityReceipt(config, guard, workspace, options, result);
  } catch (error) {
    return await attachSecurityReceipt(config, guard, workspace, options, failedResult(workspace, mode, error));
  }
}
