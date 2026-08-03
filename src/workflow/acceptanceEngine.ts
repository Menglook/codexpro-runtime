import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { runBash, type BashResult } from "../bashOps.js";
import { codexProEventBus } from "../events/eventBus.js";
import { gitStatus } from "../gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { readAcceptanceConfig } from "../project/projectConfig.js";
import type { ProjectCommand } from "../project/types.js";
import { appendUsageEntrySync, recordUsageLedgerWarningSync } from "../observability/usageLedger.js";
import {
  currentResourceAdmissionSnapshot,
  isResourceWaitTimeoutError,
  requestForWorkspaceTask,
  ResourceGovernor,
  type ResourcePoolName
} from "../resources/resourceGovernor.js";
import type { TestImpactPlan } from "../testing/testImpactGraph.js";
import type { ActiveSkillRecord } from "../skills/types.js";
import { assertActiveSkillCurrent } from "../skills/skillUsage.js";
import { selectAcceptanceProfile } from "./acceptanceProfile.js";
import {
  acceptanceArtifactDigest,
  validateAcceptanceReceipt,
  writeLatestAcceptanceReceipt,
  type AcceptanceReceiptWriteResult
} from "./acceptanceReceipt.js";
import { statusChangedFiles } from "./dirtyGuard.js";

export interface BrowserSmokeSummary {
  reportPath?: string;
  reachableTargets: string[];
  skippedTargets: unknown[];
  policyBlockedTargets: unknown[];
  results: unknown[];
}

export type AcceptanceRunStatus = "passed" | "skipped" | "incomplete" | "failed" | "resource_wait_timeout" | "blocked_by_bash_policy" | "blocked_by_resource_policy";

export interface AcceptanceCommandResult extends ProjectCommand {
  requestedCommand: string;
  effectiveCommand: string;
  rewriteReason?: string;
  exitCode: number | null;
  durationMs: number;
  spawnAttempted: boolean;
  processStarted: boolean;
  blockedBeforeSpawn: boolean;
  blocked: boolean;
  resourceWaitTimedOut: boolean;
  policyLayer?: "cpu_resource_policy" | "bash_allowlist";
  policyRule?: string;
  reason?: string;
  suggestion?: string;
  principal: "acceptance_verifier";
  resourceProfile: "acceptance-test" | "acceptance-full-test";
  testScope: "targeted" | "full";
  browser_smoke_summary?: BrowserSmokeSummary;
}

export interface AcceptanceSkippedCommand extends ProjectCommand {
  reason: "previous_command_failed" | "previous_command_blocked" | "previous_command_resource_wait_timeout";
}

export interface AcceptanceRunResult {
  run_id: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  acceptance_duration_ms: number;
  requested_profile: string;
  profile: string;
  selection_reason: string;
  changed_files: string[];
  ignored_changed_files: string[];
  test_impact_plan?: TestImpactPlan;
  ok: boolean;
  status: AcceptanceRunStatus;
  report_path: string;
  commands: AcceptanceCommandResult[];
  skipped_commands: AcceptanceSkippedCommand[];
  cache_hit: boolean;
  cache_key: string | null;
  artifact_digest?: string;
  skipped_reason?: "no_applicable_checks";
  acceptance_receipt?: AcceptanceReceiptWriteResult;
  acceptance_key?: string;
  input_hash?: string;
  execution_status?: "completed";
  validation_status?: AcceptanceRunStatus | "not_required";
  reused?: boolean;
  workspace_id?: string;
  workspace_generation?: number;
  active_skill?: ActiveSkillRecord;
  resource_plan?: AcceptanceResourcePlanV1;
  text: string;
}

export interface AcceptanceRunProgress {
  phase: "command_started" | "command_completed";
  command_name: string;
  command_index: number;
  command_count: number;
  exit_code?: number | null;
  blocked?: boolean;
}

export interface AcceptanceRunOptions {
  profile?: string;
  stopOnFailure?: boolean;
  sessionId?: string;
  changedFiles?: string[];
  runId?: string;
  activeSkill?: ActiveSkillRecord;
  signal?: AbortSignal;
  allowCacheReuse?: boolean;
  deferFinalization?: boolean;
  acceptanceKey?: string;
  inputHash?: string;
  onProgress?: (progress: AcceptanceRunProgress) => void | Promise<void>;
}

export interface AcceptanceInputFingerprint {
  git_tree: string;
  acceptance_config: string;
  changed_files: Array<{ path: string; digest: string }>;
  active_skill_digest?: string;
}

export type AcceptanceSelection = ReturnType<typeof selectAcceptanceProfile>;

export interface AcceptanceRunPreparation {
  selection: AcceptanceSelection;
  stop_on_failure: boolean;
  cache_key: string;
  cache_rel_path: string;
  input_fingerprint: AcceptanceInputFingerprint;
  input_changed_files: string[];
  command_count: number;
  max_command_timeout_ms: number;
}

interface PreparedAcceptanceCommand {
  requestedCommand: string;
  effectiveCommand: string;
  rewriteReason?: string;
  resourceProfile: "acceptance-test" | "acceptance-full-test";
  testScope: "targeted" | "full";
  allowFullTest: boolean;
  maxWorkers: number;
  requireNonWatchMode: boolean;
  timeoutMs: number;
}

export interface AcceptanceResourceCommandPlanV1 {
  command_index: number;
  required_pools: ResourcePoolName[];
  inherited_pools: ResourcePoolName[];
  incremental_pools: ResourcePoolName[];
}

export interface AcceptanceResourcePlanV1 {
  version: 1;
  run_id: string;
  parent_pools: ResourcePoolName[];
  command_plans: AcceptanceResourceCommandPlanV1[];
}

function uniquePools(pools: ResourcePoolName[]): ResourcePoolName[] {
  return [...new Set(pools)];
}

export function compileAcceptanceResourcePlan(
  runId: string,
  commands: Array<{
    command: ProjectCommand;
    prepared: Pick<PreparedAcceptanceCommand, "effectiveCommand" | "resourceProfile" | "testScope">;
  }>,
  inheritedPools: ResourcePoolName[] = []
): AcceptanceResourcePlanV1 {
  const requiresFull = commands.some(({ prepared }) => prepared.resourceProfile === "acceptance-full-test" || prepared.testScope === "full");
  const parentPools = inheritedPools.length || requiresFull
    ? uniquePools(["global_standard", ...(requiresFull ? ["full_acceptance" as const] : [])])
    : [];
  const availableParentPools = uniquePools([...inheritedPools, ...parentPools]);
  return {
    version: 1,
    run_id: runId,
    parent_pools: parentPools,
    command_plans: commands.map(({ command, prepared }, commandIndex) => {
      const required = new Set<ResourcePoolName>(["global_standard"]);
      if (prepared.resourceProfile === "acceptance-full-test" || prepared.testScope === "full") required.add("full_acceptance");
      if (isBrowserSmokeCommand(command) || /\b(?:playwright|chrome|browser|cdp)\b/i.test(prepared.effectiveCommand)) {
        required.add("browser_live_verification");
      }
      const requiredPools = [...required];
      const inherited = requiredPools.filter((pool) => availableParentPools.includes(pool));
      return {
        command_index: commandIndex,
        required_pools: requiredPools,
        inherited_pools: inherited,
        incremental_pools: requiredPools.filter((pool) => !inherited.includes(pool))
      };
    })
  };
}

function compactCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function packageTestManager(command: string): "npm" | "pnpm" | "yarn" | "bun" | undefined {
  const match = compactCommand(command).match(/^(npm|pnpm|yarn|bun)(?:\s+run)?\s+test(?:\s|$)/i);
  return match?.[1]?.toLowerCase() as "npm" | "pnpm" | "yarn" | "bun" | undefined;
}

function containsShellComposition(command: string): boolean {
  return /(?:&&|\|\||[;\n\r])/.test(command);
}

function runnerFromScript(script: string): "vitest" | "jest" | "playwright" | undefined {
  if (containsShellComposition(script)) return undefined;
  if (/\bvitest\b/i.test(script)) return "vitest";
  if (/\bjest\b/i.test(script)) return "jest";
  if (/\bplaywright\s+test\b/i.test(script)) return "playwright";
  return undefined;
}

function hasExplicitWatchMode(command: string): boolean {
  return /(?:^|\s)(?:watch|--watch(?:=true)?)(?:\s|$)/i.test(compactCommand(command));
}

function declaredWorkerLimit(command: string): number | undefined {
  const match = compactCommand(command).match(/--(?:maxworkers|workers)(?:=|\s+)([^\s]+)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Number.POSITIVE_INFINITY;
}

function appendPackageTestArgs(command: string, args: string[]): string {
  if (!args.length) return compactCommand(command);
  const normalized = compactCommand(command);
  const separator = /\s--(?:\s|$)/.test(normalized) ? " " : " -- ";
  return `${normalized}${separator}${args.join(" ")}`;
}

function boundedRunnerArgs(runner: "vitest" | "jest" | "playwright", command: string, maxWorkers: number): string[] {
  const normalized = compactCommand(command).toLowerCase();
  if (runner === "vitest") {
    const args: string[] = [];
    if (!/(?:^|\s)(?:--run|run)(?:\s|$)/.test(normalized)) args.push("--run");
    if (!/--maxworkers(?:=|\s)/.test(normalized)) args.push(`--maxWorkers=${maxWorkers}`);
    return args;
  }
  if (runner === "jest") {
    if (/(?:--runinband|--maxworkers(?:=|\s))/.test(normalized)) return [];
    return ["--runInBand"];
  }
  if (/--workers(?:=|\s)/.test(normalized)) return [];
  return [`--workers=${maxWorkers}`];
}

async function packageTestScript(guard: PathGuard, workspace: Workspace, command: ProjectCommand): Promise<string | undefined> {
  if (!packageTestManager(command.command)) return undefined;
  try {
    const packagePath = guard.resolve(workspace, path.posix.join(command.cwd ?? ".", "package.json")).absPath;
    const parsed = JSON.parse(await fsp.readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
    const script = parsed.scripts?.test;
    return typeof script === "string" && script.trim() ? script.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function prepareAcceptanceCommand(
  guard: PathGuard,
  workspace: Workspace,
  command: ProjectCommand
): Promise<PreparedAcceptanceCommand> {
  const requestedCommand = compactCommand(command.command);
  const timeoutMs = Math.max(1_000, Math.min(command.timeout_ms ?? 120_000, 300_000));
  const resourceProfile = command.resource_profile ?? "acceptance-test";
  const testScope = command.test_scope ?? "targeted";
  const maxWorkers = Math.max(1, Math.min(command.max_workers ?? 2, 2));
  const requireNonWatchMode = command.require_non_watch_mode ?? true;
  const fullRequested = resourceProfile === "acceptance-full-test"
    && testScope === "full"
    && command.allow_full_test === true;

  if (!fullRequested) {
    return {
      requestedCommand,
      effectiveCommand: requestedCommand,
      resourceProfile,
      testScope,
      allowFullTest: false,
      maxWorkers,
      requireNonWatchMode,
      timeoutMs
    };
  }

  const script = await packageTestScript(guard, workspace, command);
  const runner = script ? runnerFromScript(script) : undefined;
  const combinedCommand = script ? `${script} ${requestedCommand}` : requestedCommand;
  const declaredWorkers = declaredWorkerLimit(combinedCommand);
  if (!runner || hasExplicitWatchMode(combinedCommand) || (declaredWorkers !== undefined && declaredWorkers > maxWorkers)) {
    return {
      requestedCommand,
      effectiveCommand: requestedCommand,
      resourceProfile,
      testScope,
      allowFullTest: false,
      maxWorkers,
      requireNonWatchMode,
      timeoutMs
    };
  }

  const args = boundedRunnerArgs(runner, combinedCommand, maxWorkers);
  return {
    requestedCommand,
    effectiveCommand: appendPackageTestArgs(requestedCommand, args),
    rewriteReason: `bounded_full_test_${runner}`,
    resourceProfile,
    testScope,
    allowFullTest: true,
    maxWorkers: runner === "jest" && args.includes("--runInBand") ? 1 : maxWorkers,
    requireNonWatchMode,
    timeoutMs
  };
}

function acceptanceStatus(results: BashResult[], skippedCommandCount = 0): AcceptanceRunStatus {
  if (results.some((result) => result.resourceWaitTimedOut)) return "resource_wait_timeout";
  if (results.some((result) => result.blocked && result.policyLayer === "cpu_resource_policy")) return "blocked_by_resource_policy";
  if (results.some((result) => result.blocked && result.policyLayer === "bash_allowlist")) return "blocked_by_bash_policy";
  if (skippedCommandCount > 0) return "incomplete";
  if (results.some((result) => result.exitCode !== 0)) return "failed";
  return "passed";
}

function safeArtifactId(value: string, fallback: string, maxLength = 80): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLength) || fallback;
}

function reportPath(config: CodexProConfig, profile: string, runId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeProfile = safeArtifactId(profile, "default", 48);
  const safeRunId = safeArtifactId(runId, "acceptance", 64);
  return `${config.contextDir}/acceptance-reports/${stamp}-${safeProfile}-${safeRunId}.md`;
}

function attemptPath(config: CodexProConfig, runId: string): string {
  return `${config.contextDir}/acceptance-attempts/${safeArtifactId(runId, "acceptance", 80)}.json`;
}

function latestAttemptPath(config: CodexProConfig): string {
  return `${config.contextDir}/acceptance-attempts/latest-attempt.json`;
}

async function writeAtomicText(
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  content: string
): Promise<string> {
  const resolved = guard.resolve(workspace, relPath, { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  const temporary = `${resolved.absPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, resolved.absPath);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
  return resolved.relPath;
}

async function writeAtomicJson(
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  value: unknown
): Promise<string> {
  return await writeAtomicText(guard, workspace, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

function reportSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeAcceptanceAttemptState(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  state: Record<string, unknown> & { run_id: string }
): Promise<void> {
  const value = { version: 1, ...state, updated_at: new Date().toISOString() };
  await writeAtomicJson(guard, workspace, attemptPath(config, state.run_id), value);
  await writeAtomicJson(guard, workspace, latestAttemptPath(config), value);
}

async function readFingerprintFile(absPath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) return "missing";
    if (stat.size > maxBytes) return `large:${stat.size}:${stat.mtimeMs}`;
    return createHash("sha256").update(await fsp.readFile(absPath)).digest("hex");
  } catch {
    return "missing";
  }
}

async function gitTreeFingerprint(workspace: Workspace): Promise<string> {
  const headPath = path.join(workspace.root, ".git", "HEAD");
  try {
    const head = (await fsp.readFile(headPath, "utf8")).trim();
    if (!head.startsWith("ref:")) return head || "no-head";
    const ref = head.slice(4).trim();
    const value = (await fsp.readFile(path.join(workspace.root, ".git", ref), "utf8")).trim();
    return `${ref}:${value}`;
  } catch {
    return "no-git-tree";
  }
}

async function acceptanceCacheIdentity(
  config: CodexProConfig,
  workspace: Workspace,
  selection: AcceptanceSelection,
  stopOnFailure: boolean,
  activeSkill?: ActiveSkillRecord
): Promise<{ cacheKey: string; fingerprint: AcceptanceInputFingerprint }> {
  const fileDigests: Array<[string, string]> = [];
  for (const file of selection.changed_files) {
    fileDigests.push([file, await readFingerprintFile(path.resolve(workspace.root, file))]);
  }
  const gitTree = await gitTreeFingerprint(workspace);
  const acceptanceConfig = await readFingerprintFile(path.resolve(workspace.root, ".codexpro/acceptance.yml"));
  const payload = {
    git_tree: gitTree,
    acceptance_config: acceptanceConfig,
    diff: fileDigests,
    requested_profile: selection.requested_profile,
    configured_profile: selection.configured_profile,
    effective_profile: selection.effective_profile,
    commands: selection.commands,
    runtime: process.version,
    context_dir: config.contextDir,
    workspace_id: workspace.id,
    workspace_generation: workspace.workspaceGeneration ?? null,
    stop_on_failure: stopOnFailure,
    active_skill: activeSkill ?? null
  };
  return {
    cacheKey: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    fingerprint: {
      git_tree: gitTree,
      acceptance_config: acceptanceConfig,
      changed_files: fileDigests.map(([filePath, digest]) => ({ path: filePath, digest })),
      ...(activeSkill ? { active_skill_digest: activeSkill.digest } : {})
    }
  };
}

export function acceptanceCacheRelPath(config: CodexProConfig, cacheKey: string): string {
  return `${config.contextDir}/acceptance-cache/${cacheKey}.json`;
}

export async function prepareAcceptanceRun(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: AcceptanceRunOptions = {}
): Promise<AcceptanceRunPreparation> {
  const acceptance = await readAcceptanceConfig(config, guard, workspace);
  const requestedProfile = options.profile ?? acceptance.default_profile ?? "default";
  const changedFiles = options.changedFiles ?? statusChangedFiles(gitStatus(config, workspace));
  let selection: AcceptanceSelection;
  try {
    selection = selectAcceptanceProfile(acceptance, requestedProfile, changedFiles);
  } catch (error) {
    throw new CodexProError(error instanceof Error ? error.message : String(error));
  }
  const stopOnFailure = options.stopOnFailure ?? true;
  const identity = await acceptanceCacheIdentity(config, workspace, selection, stopOnFailure, options.activeSkill);
  return {
    selection,
    stop_on_failure: stopOnFailure,
    cache_key: identity.cacheKey,
    cache_rel_path: acceptanceCacheRelPath(config, identity.cacheKey),
    input_fingerprint: identity.fingerprint,
    input_changed_files: [...changedFiles],
    command_count: selection.commands.length,
    max_command_timeout_ms: selection.commands.reduce(
      (maximum, command) => Math.max(maximum, command.timeout_ms ?? 120_000),
      0
    )
  };
}

async function readAcceptanceCache(
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  expected: { cacheKey: string; acceptanceKey: string; inputHash: string }
): Promise<AcceptanceRunResult | undefined> {
  try {
    const resolved = guard.resolve(workspace, relPath);
    const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as AcceptanceRunResult;
    if (!parsed || parsed.ok !== true || parsed.status !== "passed" || !parsed.artifact_digest) return undefined;
    if (parsed.cache_key !== expected.cacheKey) return undefined;
    if ((parsed.acceptance_key ?? parsed.cache_key) !== expected.acceptanceKey) return undefined;
    if ((parsed.input_hash ?? parsed.cache_key) !== expected.inputHash) return undefined;
    if (parsed.workspace_id !== undefined && parsed.workspace_id !== workspace.id) return undefined;
    if (workspace.workspaceGeneration !== undefined && parsed.workspace_generation !== workspace.workspaceGeneration) return undefined;
    const report = guard.resolve(workspace, parsed.report_path);
    const reportText = await fsp.readFile(report.absPath, "utf8");
    const digest = acceptanceArtifactDigest({
      run_id: parsed.run_id,
      cache_key: parsed.cache_key,
      report_path: parsed.report_path,
      report_sha256: reportSha256(reportText)
    });
    if (digest !== parsed.artifact_digest) return undefined;
    const receipt = parsed.acceptance_receipt?.receipt;
    if (!receipt || receipt.run_id !== parsed.run_id || receipt.cache_key !== parsed.cache_key || receipt.artifact_digest !== digest) return undefined;
    if ((receipt.acceptance_key ?? receipt.cache_key) !== expected.acceptanceKey) return undefined;
    if ((receipt.input_hash ?? receipt.cache_key) !== expected.inputHash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeAcceptanceCache(
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  result: AcceptanceRunResult
): Promise<void> {
  if (!result.ok || result.status !== "passed" || !result.artifact_digest) return;
  const receipt = result.acceptance_receipt?.receipt;
  if (!receipt || receipt.run_id !== result.run_id || receipt.cache_key !== result.cache_key || receipt.artifact_digest !== result.artifact_digest) return;
  await writeAtomicJson(guard, workspace, relPath, result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isBrowserSmokeCommand(command: ProjectCommand): boolean {
  return command.name.toLowerCase().includes("browser-smoke") || /\bbrowser-smoke\b/.test(command.command);
}

function parseTrailingJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    if (trimmed[i] !== "{") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(i));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep scanning for the outer JSON object printed by browser-smoke.
    }
  }
  return undefined;
}

function browserResultSummary(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const key of [
    "url",
    "label",
    "opened",
    "finalUrl",
    "title",
    "urlExpectation",
    "screenshots",
    "consoleErrors",
    "networkFailures",
    "error"
  ]) {
    if (key in item) out[key] = item[key];
  }
  return out;
}

function extractBrowserSmokeSummary(command: ProjectCommand, result: BashResult): BrowserSmokeSummary | undefined {
  if (!isBrowserSmokeCommand(command)) return undefined;
  const json = parseTrailingJsonObject(result.stdout);
  if (!json) return undefined;
  return {
    reportPath: typeof json.reportPath === "string" ? json.reportPath : undefined,
    reachableTargets: asStringArray(json.reachableTargets),
    skippedTargets: asArray(json.skippedTargets),
    policyBlockedTargets: asArray(json.policyBlockedTargets),
    results: asArray(json.results).map(browserResultSummary)
  };
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function skippedCommandsMarkdown(commands: AcceptanceSkippedCommand[]): string[] {
  if (!commands.length) return [];
  return [
    "## Skipped validation commands",
    "",
    ...commands.flatMap((command) => [
      `- ${command.name}: \`${command.command}\``,
      `  - reason: ${command.reason}`
    ]),
    ""
  ];
}

function browserSmokeSummaryMarkdown(summary: BrowserSmokeSummary | undefined): string[] {
  if (!summary) return [];
  return [
    "### browser-smoke summary",
    "",
    `reportPath: ${summary.reportPath ?? ""}`,
    `reachableTargets: ${summary.reachableTargets.length}`,
    `skippedTargets: ${summary.skippedTargets.length}`,
    `policyBlockedTargets: ${summary.policyBlockedTargets.length}`,
    `results: ${summary.results.length}`,
    "",
    "#### reachableTargets",
    "```json",
    jsonBlock(summary.reachableTargets),
    "```",
    "",
    "#### skippedTargets",
    "```json",
    jsonBlock(summary.skippedTargets),
    "```",
    "",
    "#### policyBlockedTargets",
    "```json",
    jsonBlock(summary.policyBlockedTargets),
    "```",
    "",
    "#### results summary",
    "```json",
    jsonBlock(summary.results),
    "```",
    ""
  ];
}

function commandMarkdown(command: ProjectCommand, result: BashResult, browserSmokeSummary?: BrowserSmokeSummary): string {
  const exit = result.processStarted ? `${result.exitCode}${result.signal ? ` (${result.signal})` : ""}` : "not_applicable";
  return [
    `## ${command.name}`,
    "",
    `Requested command: \`${result.requestedCommand ?? command.command}\``,
    `Effective command: \`${result.effectiveCommand ?? result.command}\``,
    result.rewriteReason ? `Rewrite reason: ${result.rewriteReason}` : "",
    `CWD: ${result.cwd}`,
    `Principal: ${result.principal ?? "acceptance_verifier"}`,
    `Resource profile: ${result.resourceProfile ?? command.resource_profile ?? "acceptance-test"}`,
    `Test scope: ${result.testScope ?? command.test_scope ?? "targeted"}`,
    `Process started: ${result.processStarted}`,
    `Blocked before spawn: ${result.blockedBeforeSpawn === true}`,
    `Resource wait timed out: ${result.resourceWaitTimedOut === true}`,
    result.policyLayer ? `Policy layer: ${result.policyLayer}` : "",
    result.policyRule ? `Policy rule: ${result.policyRule}` : "",
    `Exit: ${exit}`,
    `Duration: ${result.durationMs} ms`,
    "",
    ...browserSmokeSummaryMarkdown(browserSmokeSummary),
    "### stdout",
    "```text",
    result.stdout || "",
    "```",
    "",
    "### stderr",
    "```text",
    result.stderr || "",
    "```",
    ""
  ].join("\n");
}

function acceptanceResourceWaitResult(
  command: ProjectCommand,
  prepared: PreparedAcceptanceCommand,
  error: unknown
): BashResult {
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object" ? (error as { details?: { waited_ms?: unknown } }).details : undefined;
  return {
    command: prepared.effectiveCommand,
    requestedCommand: prepared.requestedCommand,
    effectiveCommand: prepared.effectiveCommand,
    ...(prepared.rewriteReason ? { rewriteReason: prepared.rewriteReason } : {}),
    cwd: command.cwd ?? ".",
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, Number(details?.waited_ms) || 0),
    stdout: "",
    stderr: [
      "[codexpro] command did not start before resource admission timeout",
      "resource_wait_timeout=true",
      `reason=${message}`
    ].join("\n"),
    truncated: false,
    spawnAttempted: false,
    processStarted: false,
    blockedBeforeSpawn: false,
    blocked: false,
    resourceWaitTimedOut: true,
    reason: message,
    suggestion: "Retry after active resource holders complete or increase the resource wait timeout.",
    principal: "acceptance_verifier",
    resourceProfile: prepared.resourceProfile,
    testScope: prepared.testScope
  };
}

async function runAcceptanceCommandWithResourceAdmission(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: ProjectCommand,
  prepared: PreparedAcceptanceCommand,
  commandPlan: AcceptanceResourceCommandPlanV1,
  options: { sessionId?: string; allowTargetedSmokeScript: boolean; runId: string; resourceTaskId: string; commandIndex: number; signal?: AbortSignal }
): Promise<BashResult> {
  const governor = new ResourceGovernor(config);
  const incrementalPools = commandPlan.incremental_pools;
  const request = requestForWorkspaceTask(workspace, {
    requestId: `acceptance:${options.runId}:command:${options.commandIndex + 1}`,
    runId: options.runId,
    taskId: options.resourceTaskId,
    title: `Acceptance: ${command.name}`,
    commands: [prepared.effectiveCommand],
    hasWrites: false,
    priority: "normal",
    pools: incrementalPools.filter((pool) => pool !== "global_standard" && pool !== "global_heavy"),
    reason: "Acceptance command acquires only resource pools not inherited from the parent Acceptance lease."
  });
  request.category = incrementalPools.includes("global_heavy")
    ? "heavy"
    : incrementalPools.includes("global_standard")
      ? "standard"
      : "lightweight";
  request.skip_workspace_pool = true;
  request.owner_pid = process.pid;
  try {
    return await governor.runWithLease(request, async () => await runBash(config, guard, workspace, prepared.effectiveCommand, {
      cwd: command.cwd,
      timeoutMs: prepared.timeoutMs,
      sessionId: options.sessionId,
      requestedCommand: prepared.requestedCommand,
      rewriteReason: prepared.rewriteReason,
      returnPolicyBlocks: true,
      allowTargetedSmokeScript: options.allowTargetedSmokeScript,
      taskId: options.resourceTaskId,
      runId: options.runId,
      stepId: `command-${options.commandIndex + 1}`,
      signal: options.signal,
      safety: {
        scope: "acceptance",
        principal: "acceptance_verifier",
        resourceProfile: prepared.resourceProfile,
        testScope: prepared.testScope,
        allowFullTest: prepared.allowFullTest,
        timeoutMs: prepared.timeoutMs,
        maxWorkers: prepared.maxWorkers,
        requireNonWatchMode: prepared.requireNonWatchMode
      }
    }), { signal: options.signal });
  } catch (error) {
    if (!isResourceWaitTimeoutError(error)) throw error;
    return acceptanceResourceWaitResult(command, prepared, error);
  }
}

async function emitAcceptanceEvent(
  name: "acceptance_started" | "acceptance_completed" | "acceptance_cache_hit",
  runId: string,
  workspace: Workspace,
  data: Record<string, unknown>
): Promise<void> {
  try {
    await codexProEventBus.emit(
      name,
      {
        domain: "acceptance",
        run_id: runId,
        workspace_id: workspace.id,
        workspace_root: workspace.root,
        ...data
      },
      {
        source: "acceptance_engine",
        correlation_id: runId,
        task_id: `acceptance-${runId}`
      }
    );
  } catch {
    // Acceptance reports and command results remain authoritative when observers fail.
  }
}

function recordAcceptanceUsage(workspace: Workspace, result: AcceptanceRunResult): void {
  try {
    appendUsageEntrySync(workspace.root, {
      source_event_id: `acceptance:${result.run_id}`,
      task_id: `acceptance-${result.run_id}`,
      run_id: result.run_id,
      execution_id: result.run_id,
      component: "acceptance",
      provider: "acceptance_engine",
      tool: result.profile,
      started_at: result.started_at,
      finished_at: result.completed_at,
      wall_duration_ms: result.acceptance_duration_ms,
      active_duration_ms: result.acceptance_duration_ms,
      process_count: result.commands.filter((command) => command.processStarted).length,
      retry_count: 0,
      cache_hit: result.cache_hit,
      outcome: result.status,
      verified_completion: result.ok && result.acceptance_receipt?.written === true,
      evidence: {
        report_path: result.report_path,
        receipt: result.acceptance_receipt,
        cache_key: result.cache_key,
        commands: result.commands.map((command) => ({
          name: command.name,
          exit_code: command.exitCode,
          duration_ms: command.durationMs,
          process_started: command.processStarted
        }))
      }
    });
  } catch (error) {
    recordUsageLedgerWarningSync(workspace.root, "acceptance_engine", error, {
      run_id: result.run_id,
      report_path: result.report_path
    });
  }
}

export async function finalizeAcceptanceResult(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  result: AcceptanceRunResult,
  options: { acceptanceKey?: string; inputHash?: string } = {}
): Promise<AcceptanceRunResult> {
  result.acceptance_key = options.acceptanceKey ?? result.acceptance_key ?? result.cache_key ?? result.run_id;
  result.input_hash = options.inputHash ?? result.input_hash ?? result.cache_key ?? result.run_id;
  result.execution_status = "completed";
  result.validation_status = result.status;
  result.reused = false;
  result.workspace_id = workspace.id;
  if (workspace.workspaceGeneration !== undefined) result.workspace_generation = workspace.workspaceGeneration;
  result.acceptance_receipt = await writeLatestAcceptanceReceipt(config, guard, workspace, result);
  if (result.ok && result.status === "passed" && result.cache_key) {
    await writeAcceptanceCache(guard, workspace, acceptanceCacheRelPath(config, result.cache_key), result);
  }
  await writeAcceptanceAttemptState(config, guard, workspace, {
    run_id: result.run_id,
    status: "completed",
    validation_status: result.status,
    started_at: result.started_at,
    completed_at: result.completed_at,
    requested_profile: result.requested_profile,
    profile: result.profile,
    cache_key: result.cache_key,
    report_path: result.report_path,
    artifact_digest: result.artifact_digest ?? null,
    result_available: true,
    receipt_written: result.acceptance_receipt.written,
    previous_receipt_preserved: result.acceptance_receipt.preserved_previous === true
  });
  await emitAcceptanceEvent("acceptance_completed", result.run_id, workspace, {
    requested_profile: result.requested_profile,
    profile: result.profile,
    ok: result.ok,
    status: result.status,
    report_path: result.report_path,
    duration_ms: result.duration_ms,
    acceptance_duration_ms: result.acceptance_duration_ms,
    completed_at: result.completed_at,
    cache_key: result.cache_key,
    cache_hit: result.cache_hit,
    ...(result.skipped_reason ? { skipped_reason: result.skipped_reason } : {})
  });
  recordAcceptanceUsage(workspace, result);
  return result;
}

export async function runAcceptance(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: AcceptanceRunOptions = {}
): Promise<AcceptanceRunResult> {
  if (options.activeSkill) options = { ...options, activeSkill: await assertActiveSkillCurrent(config, options.activeSkill) };
  const runId = options.runId?.trim() || randomUUID();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const preparation = await prepareAcceptanceRun(config, guard, workspace, options);
  const selection = preparation.selection;
  const stopOnFailure = preparation.stop_on_failure;
  const cacheKey = preparation.cache_key;
  const cacheRelPath = preparation.cache_rel_path;
  const acceptanceKey = options.acceptanceKey ?? cacheKey;
  const inputHash = options.inputHash ?? cacheKey;

  if (!selection.commands.length) {
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedMs);
    const text = `Acceptance not required: no applicable checks for profile ${selection.effective_profile}.`;
    return {
      run_id: runId,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
      acceptance_duration_ms: 0,
      requested_profile: selection.requested_profile,
      profile: selection.effective_profile,
      selection_reason: selection.reason,
      changed_files: selection.changed_files,
      ignored_changed_files: selection.ignored_changed_files,
      ...(selection.test_impact_plan ? { test_impact_plan: selection.test_impact_plan } : {}),
      ok: true,
      status: "skipped",
      execution_status: "completed",
      validation_status: "not_required",
      reused: false,
      workspace_id: workspace.id,
      ...(workspace.workspaceGeneration !== undefined ? { workspace_generation: workspace.workspaceGeneration } : {}),
      report_path: "",
      commands: [],
      skipped_commands: [],
      cache_hit: false,
      cache_key: cacheKey,
      skipped_reason: "no_applicable_checks",
      acceptance_key: acceptanceKey,
      input_hash: inputHash,
      ...(options.activeSkill ? { active_skill: options.activeSkill } : {}),
      text
    };
  }

  const cached = options.allowCacheReuse === false
    ? undefined
    : await readAcceptanceCache(guard, workspace, cacheRelPath, { cacheKey, acceptanceKey, inputHash });
  const cachedReceipt = cached?.acceptance_receipt?.receipt ?? undefined;
  const cachedReceiptValidation = cachedReceipt
    ? await validateAcceptanceReceipt(config, guard, workspace, cachedReceipt, {
      changedFiles: cached!.changed_files,
      ...(cached!.acceptance_receipt?.path ? { receiptPath: cached!.acceptance_receipt.path } : {})
    })
    : undefined;
  if (cached && cachedReceipt && cachedReceiptValidation?.valid && cachedReceipt.run_id === cached.run_id) {
    const result: AcceptanceRunResult = {
      ...cached,
      duration_ms: 0,
      acceptance_duration_ms: 0,
      execution_status: "completed",
      validation_status: "passed",
      reused: true,
      workspace_id: workspace.id,
      ...(workspace.workspaceGeneration !== undefined ? { workspace_generation: workspace.workspaceGeneration } : {}),
      cache_hit: true,
      cache_key: cacheKey,
      acceptance_key: acceptanceKey,
      input_hash: inputHash,
      text: `${cached.text}\n\nCache reuse: ${cacheKey}\n`
    };
    result.acceptance_receipt = {
      written: false,
      path: cached.acceptance_receipt?.path ?? null,
      receipt: cachedReceipt,
      reused: true,
      reason: "reused_original_receipt"
    };
    await emitAcceptanceEvent("acceptance_cache_hit", result.run_id, workspace, {
      source_run_id: result.run_id,
      requested_run_id: runId,
      requested_profile: result.requested_profile,
      profile: result.profile,
      report_path: result.report_path,
      receipt_path: result.acceptance_receipt.path,
      cache_key: cacheKey,
      cache_hit: true,
      reused: true,
      validation_status: "passed"
    });
    return result;
  }

  await writeAcceptanceAttemptState(config, guard, workspace, {
    run_id: runId,
    status: "running",
    started_at: startedAt,
    requested_profile: selection.requested_profile,
    configured_profile: selection.configured_profile,
    profile: selection.effective_profile,
    cache_key: cacheKey,
    report_path: null,
    artifact_digest: null,
    result_available: false
  });

  await emitAcceptanceEvent("acceptance_started", runId, workspace, {
    requested_profile: selection.requested_profile,
    configured_profile: selection.configured_profile,
    profile: selection.effective_profile,
    command_count: selection.commands.length,
    changed_files_count: selection.changed_files.length,
    started_at: startedAt,
    cache_key: cacheKey,
    cache_hit: false
  });

  const results: Array<{
    command: ProjectCommand;
    prepared: PreparedAcceptanceCommand;
    result: BashResult;
    browserSmokeSummary?: BrowserSmokeSummary;
  }> = [];
  const skippedCommands: AcceptanceSkippedCommand[] = [];
  const successfulCommandCache = new Map<string, BashResult>();
  const preparedCommands = await Promise.all(selection.commands.map(async (command) => ({
    command,
    prepared: await prepareAcceptanceCommand(guard, workspace, command)
  })));
  const inheritedAdmission = currentResourceAdmissionSnapshot();
  const resourceTaskId = inheritedAdmission?.primary_lease.task_id ?? `acceptance-${runId}`;
  const resourcePlan = compileAcceptanceResourcePlan(runId, preparedCommands, inheritedAdmission?.pools ?? []);
  const executeCommandLoop = async (): Promise<void> => {
    for (let index = 0; index < preparedCommands.length; index += 1) {
      const { command, prepared } = preparedCommands[index];
      const commandPlan = resourcePlan.command_plans[index];
      await options.onProgress?.({
        phase: "command_started",
        command_name: command.name,
        command_index: index,
        command_count: selection.commands.length
      });
      const commandKey = `${command.cwd ?? "."}\u0000${prepared.effectiveCommand}\u0000${prepared.resourceProfile}\u0000${prepared.testScope}`;
      const reused = successfulCommandCache.get(commandKey);
      const result = reused
        ? { ...reused, durationMs: 0, rewriteReason: "reused_previous_command" }
        : await runAcceptanceCommandWithResourceAdmission(config, guard, workspace, command, prepared, commandPlan, {
            sessionId: options.sessionId,
            runId,
            resourceTaskId,
            commandIndex: index,
            allowTargetedSmokeScript: prepared.testScope === "targeted"
              && selection.allowed_targeted_smoke_commands.includes(prepared.requestedCommand),
            signal: options.signal
          });
      if (!reused && !result.blocked && result.exitCode === 0) successfulCommandCache.set(commandKey, result);
      results.push({ command, prepared, result, browserSmokeSummary: extractBrowserSmokeSummary(command, result) });
      await options.onProgress?.({
        phase: "command_completed",
        command_name: command.name,
        command_index: index,
        command_count: selection.commands.length,
        exit_code: result.exitCode,
        blocked: result.blocked === true
      });
      if (stopOnFailure && (result.resourceWaitTimedOut || result.blocked || result.exitCode !== 0)) {
        const reason: AcceptanceSkippedCommand["reason"] = result.resourceWaitTimedOut
          ? "previous_command_resource_wait_timeout"
          : result.blocked
            ? "previous_command_blocked"
            : "previous_command_failed";
        skippedCommands.push(...selection.commands.slice(index + 1).map((item) => ({ ...item, reason })));
        break;
      }
    }
  };
  if (resourcePlan.parent_pools.length) {
    const parentGovernor = new ResourceGovernor(config);
    const parentRequest = requestForWorkspaceTask(workspace, {
      requestId: `acceptance:${runId}:parent`,
      runId,
      taskId: resourceTaskId,
      title: `Acceptance resource plan: ${selection.effective_profile}`,
      commands: preparedCommands.map(({ prepared }) => prepared.effectiveCommand),
      hasWrites: false,
      priority: "normal",
      pools: resourcePlan.parent_pools.filter((pool) => pool !== "global_standard" && pool !== "global_heavy"),
      reason: "Acceptance acquires one parent lease for shared coarse-grained pools."
    });
    parentRequest.category = resourcePlan.parent_pools.includes("global_heavy")
      ? "heavy"
      : resourcePlan.parent_pools.includes("global_standard")
        ? "standard"
        : "lightweight";
    parentRequest.skip_workspace_pool = true;
    parentRequest.owner_pid = process.pid;
    try {
      await parentGovernor.runWithLease(parentRequest, executeCommandLoop, { signal: options.signal });
    } catch (error) {
      if (!isResourceWaitTimeoutError(error) || !preparedCommands.length) throw error;
      const { command, prepared } = preparedCommands[0];
      const result = acceptanceResourceWaitResult(command, prepared, error);
      results.push({ command, prepared, result, browserSmokeSummary: extractBrowserSmokeSummary(command, result) });
      skippedCommands.push(...selection.commands.slice(1).map((item) => ({
        ...item,
        reason: "previous_command_resource_wait_timeout" as const
      })));
    }
  } else {
    await executeCommandLoop();
  }

  const status = acceptanceStatus(results.map(({ result }) => result), skippedCommands.length);
  const ok = status === "passed";
  const path = reportPath(config, selection.effective_profile, runId);
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - startedMs);
  const content = [
    "# CodexPro Acceptance Report",
    "",
    `Generated: ${completedAt}`,
    `Run id: ${runId}`,
    `Workspace: ${workspace.root}`,
    `Requested profile: ${selection.requested_profile}`,
    `Configured profile: ${selection.configured_profile}`,
    `Effective profile: ${selection.effective_profile}`,
    `Profile selection reason: ${selection.reason}`,
    ...(options.activeSkill ? [
      `Active Skill: ${options.activeSkill.name}@${options.activeSkill.source_commit}`,
      `Active Skill digest: ${options.activeSkill.digest}`
    ] : []),
    `Changed files: ${selection.changed_files.length ? selection.changed_files.join(", ") : "none"}`,
    `Ignored generated runtime state: ${selection.ignored_changed_files.length ? selection.ignored_changed_files.join(", ") : "none"}`,
    `Fail fast: ${stopOnFailure}`,
    `Resource parent pools: ${resourcePlan.parent_pools.length ? resourcePlan.parent_pools.join(", ") : "none"}`,
    `Resource command plans: ${JSON.stringify(resourcePlan.command_plans)}`,
    `Cache key: ${cacheKey}`,
    "Cache hit: false",
    `Duration: ${durationMs} ms`,
    `Result: ${ok ? "PASS" : status === "incomplete" ? "INCOMPLETE" : "FAIL"}`,
    `Status: ${status}`,
    "",
    ...skippedCommandsMarkdown(skippedCommands),
    ...results.map(({ command, result, browserSmokeSummary }) => commandMarkdown(command, result, browserSmokeSummary))
  ].join("\n");
  const writtenReportPath = await writeAtomicText(guard, workspace, path, content);
  const artifactDigest = acceptanceArtifactDigest({
    run_id: runId,
    cache_key: cacheKey,
    report_path: writtenReportPath,
    report_sha256: reportSha256(content)
  });
  const result: AcceptanceRunResult = {
    run_id: runId,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    acceptance_duration_ms: durationMs,
    requested_profile: selection.requested_profile,
    profile: selection.effective_profile,
    selection_reason: selection.reason,
    changed_files: selection.changed_files,
    ignored_changed_files: selection.ignored_changed_files,
    ...(selection.test_impact_plan ? { test_impact_plan: selection.test_impact_plan } : {}),
    ok,
    status,
    report_path: writtenReportPath,
    commands: results.map(({ command, prepared, result, browserSmokeSummary }) => ({
      ...command,
      requestedCommand: result.requestedCommand ?? prepared.requestedCommand,
      effectiveCommand: result.effectiveCommand ?? prepared.effectiveCommand,
      ...(result.rewriteReason ? { rewriteReason: result.rewriteReason } : {}),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      spawnAttempted: result.spawnAttempted,
      processStarted: result.processStarted,
      blockedBeforeSpawn: result.blockedBeforeSpawn === true,
      blocked: result.blocked === true,
      resourceWaitTimedOut: result.resourceWaitTimedOut === true,
      ...(result.policyLayer ? { policyLayer: result.policyLayer } : {}),
      ...(result.policyRule ? { policyRule: result.policyRule } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.suggestion ? { suggestion: result.suggestion } : {}),
      principal: "acceptance_verifier",
      resourceProfile: prepared.resourceProfile,
      testScope: prepared.testScope,
      ...(browserSmokeSummary ? { browser_smoke_summary: browserSmokeSummary } : {})
    })),
    skipped_commands: skippedCommands,
    resource_plan: resourcePlan,
    cache_hit: false,
    cache_key: cacheKey,
    artifact_digest: artifactDigest,
    acceptance_key: options.acceptanceKey ?? cacheKey,
    input_hash: options.inputHash ?? cacheKey,
    ...(options.activeSkill ? { active_skill: options.activeSkill } : {}),
    text: content
  };
  if (!options.deferFinalization) {
    await finalizeAcceptanceResult(config, guard, workspace, result, {
      acceptanceKey: options.acceptanceKey ?? cacheKey,
      inputHash: options.inputHash ?? cacheKey
    });
  }
  return result;
}
