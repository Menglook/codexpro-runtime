import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendUsageEntrySync } from "../observability/usageLedger.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import type { ExecutionOriginReceiptV1 } from "../runtime/executionOrigin.js";

export const GOLD_TASK_SESSION_DIR_ENV = "CODEXPRO_GOLD_TASK_SESSION_DIR";
export const GOLD_TASK_SESSION_ID_ENV = "CODEXPRO_GOLD_TASK_SESSION_ID";
export const GOLD_TASK_ID_ENV = "CODEXPRO_GOLD_TASK_ID";
export const RUNTIME_PREFLIGHT_IDENTITY_FILE_ENV = "CODEXPRO_RUNTIME_PREFLIGHT_IDENTITY_FILE";
export const RUNTIME_HANDOFF_DIR_ENV = "CODEXPRO_RUNTIME_HANDOFF_DIR";
export const GOLD_TASK_EXPLORATION_FAILURE_CODE = "gold_task_exploration_budget_exhausted";
export const GOLD_TASK_PATCH_LOOP_FAILURE_CODE = "gold_task_patch_loop_exhausted";
export const GOLD_TASK_PATCH_REJECTION_CIRCUIT_CODE = "gold_task_patch_rejection_circuit_open";
export const GOLD_TASK_INTERNAL_FORWARDING_FAILURE_CODE = "gold_task_internal_forwarding_budget_exhausted";
export const MAX_GOLD_TASK_EXPLORATION_REQUESTS = 8;
export const MAX_GOLD_TASK_SEARCH_REQUESTS = 3;
export const MAX_GOLD_TASK_SEARCH_REQUESTS_AFTER_READ = 2;
export const MAX_GOLD_TASK_INTERNAL_FORWARD_REQUESTS = 2;
export const MAX_GOLD_TASK_PATCH_REQUESTS = 11;
export const MAX_GOLD_TASK_GENERAL_PATCH_REQUESTS = 10;
export const MAX_GOLD_TASK_REVIEWED_PATCH_CYCLES = 5;
const DEFAULT_GOLD_TASK_GENERAL_PATCH_REQUESTS = 5;

export interface GoldTaskSessionDescriptorV1 {
  version: 1;
  suite_run_id: string;
  suite_id: string;
  task_id: string;
  measurement_phase: "baseline" | "candidate";
  runtime_version: string;
  runtime_git_sha: string;
  runtime_dirty: boolean;
  baseline_commit: string;
  control_root: string;
  control_tree_fingerprint: string;
  control_tree_status?: string;
  control_tree_entries?: Record<string, string>;
  control_runtime_allowed_paths?: string[];
  worktree_path: string;
  max_connector_requests: number;
  max_wall_clock_ms?: number;
  evaluator_owned_paths: string[];
  change_scope_mode?: "exact" | "behavioral";
  expected_changed_paths?: string[];
  forbidden_scope?: string[];
  frozen_validation_commands: string[];
  frozen_validation_evaluators?: GoldTaskFrozenValidationEvaluator[];
  execution_groups?: GoldTaskExecutionGroup[];
  runtime_preflight_nonce?: string;
  runtime_preflight?: GoldTaskRuntimePreflight;
  prepared_at: string;
  status: "prepared" | "finalized" | "finalize_failed";
  finalized_at?: string;
  stop_reason?: string;
  supervisor_terminated?: boolean;
  tree_terminated?: boolean;
}

export interface GoldTaskExecutionGroup {
  group_id: string;
  paths: string[];
  purpose: string;
  validation_commands: string[];
}

export interface GoldTaskValidationProgress {
  command: string;
  status: "passed" | "failed" | "missing" | "stale";
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  timed_out: boolean;
}

export interface GoldTaskFileProgress {
  active: boolean;
  task_id: string | null;
  current_step: string;
  updated_at: string;
  last_real_progress_at: string | null;
  completed_file_count: number;
  remaining_file_count: number;
  completion_ratio: number;
  expected_changed_paths: string[];
  actual_changed_paths: string[];
  completed_expected_paths: string[];
  remaining_expected_paths: string[];
  unexpected_changed_paths: string[];
  forbidden_changed_paths: string[];
  staged_changed_paths: string[];
  git_head_unchanged: boolean;
  control_workspace_unchanged: boolean;
  control_changed_paths: string[];
  latest_modification_at: string | null;
  validations: GoldTaskValidationProgress[];
  latest_validation_result: GoldTaskValidationProgress | null;
  completion_ready: boolean;
  failure_classification: string | null;
  blocking_reasons: string[];
  finished_at?: string;
  stop_reason?: string;
  supervisor_terminated?: boolean;
  tree_terminated?: boolean;
}

export interface GoldTaskFrozenValidationEvaluator {
  source_path: string;
  public_path: string;
  source_sha256: string;
}

export interface GoldTaskFrozenValidationPolicy {
  active: boolean;
  task_id: string | null;
  allowed_frozen_commands: string[];
  allowed_targeted_smoke_commands: string[];
}

function sha256File(target: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`;
}

export interface GoldTaskRuntimeIdentity {
  active: boolean;
  suite_run_id: string | null;
  task_id: string | null;
  worktree_root: string;
  worktree_sha256: string;
  runtime_git_sha: string | null;
  preflight_nonce: string | null;
  runtime_pid: number;
  started_at: string;
}

export interface GoldTaskRuntimePreflight {
  verified: true;
  verified_at: string;
  health_url: string;
  suite_run_id: string;
  task_id: string;
  worktree_root: string;
  worktree_sha256: string;
  runtime_git_sha: string;
  nonce: string;
  runtime_pid: number;
  started_at: string;
}

export interface GoldTaskConnectorCallV1 {
  version: 1;
  suite_run_id: string;
  task_id: string;
  correlation_id: string;
  connector_request_id: string;
  connector_request_depth: number;
  connector_request_index: number | null;
  connector_request_limit: number | null;
  connector_request_budget_exceeded: boolean;
  tool_name: string;
  request_task_id: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  outcome: "ok" | "error";
  handler_invoked: boolean;
  handler_succeeded: boolean;
  failure_code: string | null;
  risk_level: string;
  side_effect: boolean;
  usage_entry_id: string;
  execution_origin_receipt_path: string;
}

export interface GoldTaskConnectorCallCapture {
  active: boolean;
  ok: boolean;
  session_id?: string;
  task_id?: string;
  error?: string;
}

export interface GoldTaskConnectorCallSummary {
  record_count: number;
  request_count: number;
  supertool_request_count: number;
  direct_request_count: number;
  nested_dispatch_count: number;
}

export interface GoldTaskConnectorRequestContext {
  active: boolean;
  workspace_root: string;
  request_id: string;
  request_depth: number;
  request_index: number | null;
  request_limit: number | null;
  budget_exceeded: boolean;
}

export interface GoldTaskConnectorRequestV1 {
  version: 1;
  suite_run_id: string;
  task_id: string;
  connector_request_id: string;
  request_index: number;
  request_limit: number;
  accepted: boolean;
  budget_exceeded: boolean;
  started_at: string;
}

type GoldTaskConnectorCallTiming = Pick<GoldTaskConnectorCallV1, "tool_name" | "started_at" | "finished_at">
  & Partial<Pick<GoldTaskConnectorCallV1, "connector_request_id" | "connector_request_depth">>;

const connectorRequestStorage = new AsyncLocalStorage<GoldTaskConnectorRequestContext>();
const acceptedRequestCounts = new Map<string, number>();
const runtimeProcessStartedAt = new Date().toISOString();

/**
 * The `codexpro` supertool dispatches one registered child tool inside the same
 * MCP request. Both wrappers pass through the policy/receipt recorder, so the
 * append-only evidence intentionally contains two records for that request.
 * Count the outer supertool record plus any direct tool records that are not
 * temporally enclosed by a supertool request.
 */
export function summarizeGoldTaskConnectorCalls(
  calls: readonly GoldTaskConnectorCallTiming[]
): GoldTaskConnectorCallSummary {
  const explicitlyCorrelated = calls.length > 0 && calls.every((call) =>
    typeof call.connector_request_id === "string"
    && call.connector_request_id.length > 0
    && Number.isInteger(call.connector_request_depth)
    && (call.connector_request_depth ?? -1) >= 0
  );
  if (explicitlyCorrelated) {
    const rootCalls = calls.filter((call) => call.connector_request_depth === 0);
    const requestIds = new Set(rootCalls.map((call) => call.connector_request_id));
    return {
      record_count: calls.length,
      request_count: requestIds.size,
      supertool_request_count: rootCalls.filter((call) => call.tool_name === "codexpro").length,
      direct_request_count: rootCalls.filter((call) => call.tool_name !== "codexpro").length,
      nested_dispatch_count: calls.length - rootCalls.length
    };
  }
  const supertoolCalls = calls.filter((call) => call.tool_name === "codexpro");
  const nestedDispatches = new Set<GoldTaskConnectorCallTiming>();
  for (const call of calls) {
    if (call.tool_name === "codexpro") continue;
    const startedAt = Date.parse(call.started_at);
    const finishedAt = Date.parse(call.finished_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) continue;
    if (supertoolCalls.some((wrapper) => {
      const wrapperStartedAt = Date.parse(wrapper.started_at);
      const wrapperFinishedAt = Date.parse(wrapper.finished_at);
      return Number.isFinite(wrapperStartedAt)
        && Number.isFinite(wrapperFinishedAt)
        && wrapperStartedAt <= startedAt
        && wrapperFinishedAt >= finishedAt;
    })) {
      nestedDispatches.add(call);
    }
  }
  const directRequestCount = calls.length - supertoolCalls.length - nestedDispatches.size;
  return {
    record_count: calls.length,
    request_count: supertoolCalls.length + directRequestCount,
    supertool_request_count: supertoolCalls.length,
    direct_request_count: directRequestCount,
    nested_dispatch_count: nestedDispatches.size
  };
}

function acceptedRequestCount(directory: string): number {
  const cached = acceptedRequestCounts.get(directory);
  if (cached !== undefined) return cached;
  const target = path.join(directory, "connector-requests.jsonl");
  let count = 0;
  try {
    count = fs.readFileSync(target, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Partial<GoldTaskConnectorRequestV1>)
      .filter((entry) => entry.accepted === true)
      .length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  acceptedRequestCounts.set(directory, count);
  return count;
}

export async function withGoldTaskConnectorRequest<T>(
  input: { workspace_root: string; connector_request_id: string },
  operation: (context: GoldTaskConnectorRequestContext) => Promise<T>
): Promise<T> {
  const workspaceRoot = path.resolve(input.workspace_root);
  const requestId = safeId(input.connector_request_id, "connector_request_id");
  const parent = connectorRequestStorage.getStore();
  if (parent?.active && path.resolve(parent.workspace_root) === workspaceRoot) {
    const nested = { ...parent, request_depth: parent.request_depth + 1 };
    return await connectorRequestStorage.run(nested, () => operation(nested));
  }

  const active = descriptorFromEnvironment(workspaceRoot);
  if (!active) {
    const context: GoldTaskConnectorRequestContext = {
      active: false,
      workspace_root: workspaceRoot,
      request_id: requestId,
      request_depth: 0,
      request_index: null,
      request_limit: null,
      budget_exceeded: false
    };
    return await connectorRequestStorage.run(context, () => operation(context));
  }

  const { directory, descriptor } = active;
  if (descriptor.runtime_preflight_nonce && (
    descriptor.runtime_preflight?.verified !== true
    || descriptor.runtime_preflight.nonce !== descriptor.runtime_preflight_nonce
    || descriptor.runtime_preflight.suite_run_id !== descriptor.suite_run_id
    || descriptor.runtime_preflight.task_id !== descriptor.task_id
    || path.resolve(descriptor.runtime_preflight.worktree_root) !== workspaceRoot
  )) {
    throw new Error("Gold Task Connector measurement is blocked until verify-runtime confirms the public runtime identity.");
  }
  if (!Number.isInteger(descriptor.max_connector_requests) || descriptor.max_connector_requests < 1) {
    throw new Error("Gold Task session descriptor has an invalid Connector request limit.");
  }
  const acceptedCount = acceptedRequestCount(directory);
  const accepted = acceptedCount < descriptor.max_connector_requests;
  const requestIndex = acceptedCount + 1;
  if (accepted) acceptedRequestCounts.set(directory, requestIndex);
  const event: GoldTaskConnectorRequestV1 = {
    version: 1,
    suite_run_id: descriptor.suite_run_id,
    task_id: descriptor.task_id,
    connector_request_id: requestId,
    request_index: requestIndex,
    request_limit: descriptor.max_connector_requests,
    accepted,
    budget_exceeded: !accepted,
    started_at: new Date().toISOString()
  };
  appendJsonLine(path.join(directory, "connector-requests.jsonl"), event);
  const context: GoldTaskConnectorRequestContext = {
    active: true,
    workspace_root: workspaceRoot,
    request_id: requestId,
    request_depth: 0,
    request_index: requestIndex,
    request_limit: descriptor.max_connector_requests,
    budget_exceeded: !accepted
  };
  return await connectorRequestStorage.run(context, () => operation(context));
}

function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be 1-128 safe identifier characters.`);
  }
  return normalized;
}

function atomicJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

function appendJsonLine(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function descriptorFromEnvironment(workspaceRoot: string): { directory: string; descriptor: GoldTaskSessionDescriptorV1 } | null {
  const directoryValue = process.env[GOLD_TASK_SESSION_DIR_ENV]?.trim();
  const sessionIdValue = process.env[GOLD_TASK_SESSION_ID_ENV]?.trim();
  const taskIdValue = process.env[GOLD_TASK_ID_ENV]?.trim();
  const configured = [directoryValue, sessionIdValue, taskIdValue].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 3) {
    throw new Error(`${GOLD_TASK_SESSION_DIR_ENV}, ${GOLD_TASK_SESSION_ID_ENV}, and ${GOLD_TASK_ID_ENV} must be configured together.`);
  }
  const directory = path.resolve(directoryValue!);
  if (!path.isAbsolute(directoryValue!)) throw new Error(`${GOLD_TASK_SESSION_DIR_ENV} must be an absolute path.`);
  const sessionId = safeId(sessionIdValue!, GOLD_TASK_SESSION_ID_ENV);
  const taskId = safeId(taskIdValue!, GOLD_TASK_ID_ENV);
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8")) as GoldTaskSessionDescriptorV1;
  if (descriptor.version !== 1 || descriptor.status !== "prepared") {
    throw new Error("Gold Task session descriptor is not an active v1 prepared session.");
  }
  if (descriptor.suite_run_id !== sessionId || descriptor.task_id !== taskId) {
    throw new Error("Gold Task environment does not match the session descriptor.");
  }
  if (path.resolve(descriptor.worktree_path) !== path.resolve(workspaceRoot)) {
    throw new Error("Gold Task session worktree does not match the active Connector workspace.");
  }
  return { directory, descriptor };
}

function gitText(root: string, args: string[]): string {
  const result = runProcessSync("git", args, {
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 10_000_000,
    domain: "git",
    operation: "gold_task_git_read",
    sideEffectLevel: "local_read",
    componentTracking: false,
    usageTracking: false
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited with ${String(result.exitCode)}`);
  }
  return result.stdout;
}

function controlStatusPath(line: string): string {
  const raw = line.slice(3).trim();
  const target = raw.includes(" -> ") ? raw.slice(raw.lastIndexOf(" -> ") + 4) : raw;
  return target.replaceAll("\\", "/");
}

const LEGACY_CONTROL_FINGERPRINT_IGNORED_PREFIXES = [
  ".ai-bridge/gold-task-evaluation/batches/",
  "benchmarks/gold-tasks/v1/reports/evidence/",
  "benchmarks/gold-tasks/v1/reports/runs/"
];

export function goldTaskControlStatus(controlRoot: string, allowedRuntimePaths: readonly string[] = []): string {
  const allowed = new Set(allowedRuntimePaths);
  return gitText(controlRoot, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !allowed.has(controlStatusPath(line)))
    .join("\n");
}

function controlPathDigest(controlRoot: string, relativePath: string): string {
  const target = path.resolve(controlRoot, ...relativePath.split("/"));
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      return `sha256:${createHash("sha256").update(`symlink:${fs.readlinkSync(target)}`).digest("hex")}`;
    }
    if (stat.isFile()) {
      return `sha256:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`;
    }
    return `sha256:${createHash("sha256").update(`node:${stat.mode}:${stat.size}:${stat.mtimeMs}`).digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export function goldTaskControlSnapshot(
  controlRoot: string,
  allowedRuntimePaths: readonly string[] = []
): { head: string; status: string; entries: Record<string, string>; fingerprint: string } {
  const head = gitText(controlRoot, ["rev-parse", "HEAD"]).trim();
  const status = goldTaskControlStatus(controlRoot, allowedRuntimePaths);
  const entries = Object.fromEntries(status.split(/\r?\n/).filter(Boolean).map((line) => {
    const relativePath = controlStatusPath(line);
    const digest = controlPathDigest(controlRoot, relativePath);
    const entryDigest = `sha256:${createHash("sha256").update(`${line}\0${digest}`).digest("hex")}`;
    return [relativePath, entryDigest];
  }).sort(([left], [right]) => left.localeCompare(right)));
  const material = Object.entries(entries).map(([relativePath, digest]) => `${relativePath}\0${digest}`).join("\n");
  return {
    head,
    status,
    entries,
    fingerprint: `sha256:${createHash("sha256").update(`${head}\n${material}`).digest("hex")}`
  };
}

export function goldTaskControlFingerprint(controlRoot: string, allowedRuntimePaths: readonly string[] = []): string {
  return goldTaskControlSnapshot(controlRoot, allowedRuntimePaths).fingerprint;
}

function legacyGoldTaskControlSnapshot(controlRoot: string): { head: string; status: string; fingerprint: string } {
  const head = gitText(controlRoot, ["rev-parse", "HEAD"]).trim();
  const status = gitText(controlRoot, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !LEGACY_CONTROL_FINGERPRINT_IGNORED_PREFIXES.some((prefix) => controlStatusPath(line).startsWith(prefix)))
    .join("\n");
  return {
    head,
    status,
    fingerprint: `sha256:${createHash("sha256").update(`${head}\n${status}`).digest("hex")}`
  };
}

function nulSeparated(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function candidateChangedPaths(workspaceRoot: string, baselineCommit: string): string[] {
  const tracked = nulSeparated(gitText(workspaceRoot, ["diff", "--name-only", "--no-renames", "-z", baselineCommit, "--"]));
  const untracked = nulSeparated(gitText(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function stagedCandidatePaths(workspaceRoot: string): string[] {
  return nulSeparated(gitText(workspaceRoot, ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"])).sort();
}

function completionPathMatches(target: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

interface FrozenValidationEvidence {
  command: string;
  cwd: string;
  started_at: string;
  finished_at: string;
  result?: {
    exit_code?: number | null;
    termination_reason?: string | null;
    error_class?: string | null;
    tree_terminated?: boolean;
  };
}

function recordedFrozenValidationEvidence(workspaceRoot: string): FrozenValidationEvidence[] {
  const evidenceRoot = path.join(workspaceRoot, ".ai-bridge", "execution", "process-evidence");
  let names: string[];
  try {
    names = fs.readdirSync(evidenceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const evidence: FrozenValidationEvidence[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), "utf8")) as Partial<FrozenValidationEvidence>;
      if (typeof value.command !== "string" || typeof value.cwd !== "string"
        || typeof value.started_at !== "string" || typeof value.finished_at !== "string") continue;
      if (path.resolve(value.cwd) !== workspaceRoot
        || !Number.isFinite(Date.parse(value.started_at))
        || !Number.isFinite(Date.parse(value.finished_at))) continue;
      evidence.push(value as FrozenValidationEvidence);
    } catch {
      // A partial process evidence write is ignored until the next progress check.
    }
  }
  return evidence.sort((left, right) => Date.parse(left.finished_at) - Date.parse(right.finished_at));
}

function latestChangedPathMtime(workspaceRoot: string, paths: readonly string[]): number {
  let latest = 0;
  for (const relativePath of paths) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(workspaceRoot, ...relativePath.split("/"))).mtimeMs);
    } catch {
      // A deleted changed path is represented by the recorded patch completion time instead.
    }
  }
  return latest;
}

function latestMutationTimestamp(
  workspaceRoot: string,
  actualChangedPaths: readonly string[],
  calls: readonly GoldTaskConnectorCallV1[]
): number {
  const mutationTools = new Set(["apply_patch_bundle", "write", "edit"]);
  const recorded = calls
    .filter((call) => mutationTools.has(call.tool_name) && call.handler_succeeded)
    .reduce((latest, call) => Math.max(latest, Date.parse(call.finished_at) || 0), 0);
  return Math.max(recorded, latestChangedPathMtime(workspaceRoot, actualChangedPaths));
}

function validationFailureClassification(validation: GoldTaskValidationProgress | undefined): string {
  if (!validation || validation.status === "missing" || validation.status === "stale") return "validation_missing_or_stale";
  if (validation.timed_out) return "timeout";
  if (validation.exit_code === null) return "validation_command_broken";
  if (/\bnpm\s+run\s+build\b/.test(validation.command)) return "build_failed";
  if (/smoke|targeted|acceptance/i.test(validation.command)) return "module_validation_failed";
  return "regression_failed";
}

function persistProgress(directory: string, progress: GoldTaskFileProgress): void {
  atomicJson(path.join(directory, "progress.json"), { version: 1, ...progress });
}

export function goldTaskProgressSnapshot(workspaceRoot: string): GoldTaskFileProgress {
  const resolvedRoot = path.resolve(workspaceRoot);
  const active = descriptorFromEnvironment(resolvedRoot);
  const now = new Date().toISOString();
  if (!active) {
    return {
      active: false,
      task_id: null,
      current_step: "inactive",
      updated_at: now,
      last_real_progress_at: null,
      completed_file_count: 0,
      remaining_file_count: 0,
      completion_ratio: 0,
      expected_changed_paths: [],
      actual_changed_paths: [],
      completed_expected_paths: [],
      remaining_expected_paths: [],
      unexpected_changed_paths: [],
      forbidden_changed_paths: [],
      staged_changed_paths: [],
      git_head_unchanged: true,
      control_workspace_unchanged: true,
      control_changed_paths: [],
      latest_modification_at: null,
      validations: [],
      latest_validation_result: null,
      completion_ready: false,
      failure_classification: null,
      blocking_reasons: []
    };
  }

  const { descriptor, directory } = active;
  const evaluatorOwnedPrefixes = (descriptor.evaluator_owned_paths ?? [])
    .map((item) => String(item).replaceAll("\\", "/").replace(/\/$/, ""));
  const evaluatorOwned = (item: string) => evaluatorOwnedPrefixes.some((prefix) => item === prefix || item.startsWith(`${prefix}/`));
  const observedChangedPaths = candidateChangedPaths(resolvedRoot, descriptor.baseline_commit);
  const actualChangedPaths = observedChangedPaths.filter((item) => !evaluatorOwned(item));
  const expectedChangedPaths = [...new Set(descriptor.expected_changed_paths ?? [])].sort();
  const completedExpectedPaths = expectedChangedPaths.filter((item) => actualChangedPaths.includes(item));
  const remainingExpectedPaths = expectedChangedPaths.filter((item) => !actualChangedPaths.includes(item));
  const unexpectedChangedPaths = actualChangedPaths.filter((item) => !expectedChangedPaths.includes(item));
  const forbiddenChangedPaths = actualChangedPaths.filter((item) =>
    (descriptor.forbidden_scope ?? []).some((pattern) => completionPathMatches(item, pattern))
  );
  const stagedChangedPaths = stagedCandidatePaths(resolvedRoot);
  const candidateHead = gitText(resolvedRoot, ["rev-parse", "HEAD"]).trim();
  const calls = recordedGoldTaskCalls(directory);
  const latestModificationMs = latestMutationTimestamp(resolvedRoot, actualChangedPaths, calls);
  const validationEvidence = recordedFrozenValidationEvidence(resolvedRoot);
  const validations = (descriptor.frozen_validation_commands ?? []).map((command): GoldTaskValidationProgress => {
    const normalized = normalizedFrozenCommand(command);
    const matching = validationEvidence.filter((item) => normalizedFrozenCommand(item.command) === normalized);
    const latest = matching.at(-1);
    if (!latest) return { command, status: "missing", started_at: null, finished_at: null, exit_code: null, timed_out: false };
    const startedMs = Date.parse(latest.started_at);
    const finishedMs = Date.parse(latest.finished_at);
    const timedOut = /timeout/i.test(String(latest.result?.termination_reason ?? ""))
      || /timeout/i.test(String(latest.result?.error_class ?? ""));
    const exitCode = typeof latest.result?.exit_code === "number" ? latest.result.exit_code : null;
    const passed = exitCode === 0 && latest.result?.tree_terminated !== false && !timedOut;
    return {
      command,
      status: startedMs < latestModificationMs ? "stale" : passed ? "passed" : "failed",
      started_at: latest.started_at,
      finished_at: latest.finished_at,
      exit_code: exitCode,
      timed_out: timedOut
    };
  });
  const latestValidationResult = [...validations]
    .filter((item) => item.finished_at)
    .sort((left, right) => Date.parse(left.finished_at ?? "") - Date.parse(right.finished_at ?? ""))
    .at(-1) ?? null;
  const exactScope = descriptor.change_scope_mode === "exact";
  const contentFingerprint = Boolean(descriptor.control_tree_entries);
  const controlSnapshot = contentFingerprint
    ? goldTaskControlSnapshot(descriptor.control_root, descriptor.control_runtime_allowed_paths ?? [])
    : legacyGoldTaskControlSnapshot(descriptor.control_root);
  const controlWorkspaceUnchanged = controlSnapshot.fingerprint === descriptor.control_tree_fingerprint;
  const currentControlEntries = contentFingerprint
    ? (controlSnapshot as ReturnType<typeof goldTaskControlSnapshot>).entries
    : null;
  const controlChangedPaths = descriptor.control_tree_entries && currentControlEntries
    ? [...new Set([...Object.keys(descriptor.control_tree_entries), ...Object.keys(currentControlEntries)])]
      .filter((relativePath) => descriptor.control_tree_entries?.[relativePath] !== currentControlEntries[relativePath])
      .sort()
    : controlSnapshot.status.split(/\r?\n/).filter(Boolean).map(controlStatusPath);
  if (controlSnapshot.head !== descriptor.runtime_git_sha) {
    controlChangedPaths.unshift("HEAD");
  }
  const blockingReasons: string[] = [];
  if (expectedChangedPaths.length > 0 && actualChangedPaths.length === 0) blockingReasons.push("required changes are empty");
  if (exactScope && remainingExpectedPaths.length > 0) blockingReasons.push(`missing paths: ${remainingExpectedPaths.join(", ")}`);
  if (unexpectedChangedPaths.length > 0) blockingReasons.push(`unexpected paths: ${unexpectedChangedPaths.join(", ")}`);
  if (forbiddenChangedPaths.length > 0) blockingReasons.push(`forbidden paths: ${forbiddenChangedPaths.join(", ")}`);
  const incompleteValidation = validations.find((item) => item.status !== "passed");
  if (incompleteValidation) blockingReasons.push(`validation ${incompleteValidation.status}: ${incompleteValidation.command}`);
  if (!controlWorkspaceUnchanged) blockingReasons.push(`control repository changed: ${controlChangedPaths.join(", ") || "fingerprint mismatch"}`);
  if (candidateHead !== descriptor.baseline_commit) blockingReasons.push("candidate repository contains a private commit");
  if (stagedChangedPaths.length > 0) blockingReasons.push(`staged paths: ${stagedChangedPaths.join(", ")}`);

  const lastCall = [...calls].sort((left, right) => Date.parse(left.finished_at) - Date.parse(right.finished_at)).at(-1);
  const lastRealProgressMs = Math.max(
    Date.parse(descriptor.prepared_at) || 0,
    latestModificationMs,
    ...calls.map((call) => Date.parse(call.finished_at) || 0),
    ...validationEvidence.map((item) => Date.parse(item.finished_at) || 0)
  );
  let failureClassification: string | null = null;
  if (!controlWorkspaceUnchanged) failureClassification = "control_repository_changed";
  else if (candidateHead !== descriptor.baseline_commit || stagedChangedPaths.length > 0) failureClassification = "completion_check_failed";
  else if ((expectedChangedPaths.length > 0 && actualChangedPaths.length === 0)
    || (exactScope && remainingExpectedPaths.length > 0)
    || unexpectedChangedPaths.length > 0
    || forbiddenChangedPaths.length > 0) failureClassification = "change_scope_failed";
  else if (incompleteValidation) failureClassification = validationFailureClassification(incompleteValidation);

  const progress: GoldTaskFileProgress = {
    active: true,
    task_id: descriptor.task_id,
    current_step: lastCall?.tool_name === "run_validation"
      ? "validation"
      : lastCall?.tool_name === "task_complete"
        ? "completion_check"
        : actualChangedPaths.length > 0
          ? "implementation"
          : "inspection_and_planning",
    updated_at: now,
    last_real_progress_at: lastRealProgressMs > 0 ? new Date(lastRealProgressMs).toISOString() : null,
    completed_file_count: completedExpectedPaths.length,
    remaining_file_count: remainingExpectedPaths.length,
    completion_ratio: expectedChangedPaths.length > 0
      ? Number((completedExpectedPaths.length / expectedChangedPaths.length).toFixed(4))
      : 1,
    expected_changed_paths: expectedChangedPaths,
    actual_changed_paths: actualChangedPaths,
    completed_expected_paths: completedExpectedPaths,
    remaining_expected_paths: remainingExpectedPaths,
    unexpected_changed_paths: unexpectedChangedPaths,
    forbidden_changed_paths: forbiddenChangedPaths,
    staged_changed_paths: stagedChangedPaths,
    git_head_unchanged: candidateHead === descriptor.baseline_commit,
    control_workspace_unchanged: controlWorkspaceUnchanged,
    control_changed_paths: [...new Set(controlChangedPaths)],
    latest_modification_at: latestModificationMs > 0 ? new Date(latestModificationMs).toISOString() : null,
    validations,
    latest_validation_result: latestValidationResult,
    completion_ready: blockingReasons.length === 0,
    failure_classification: failureClassification,
    blocking_reasons: blockingReasons
  };
  persistProgress(directory, progress);
  return progress;
}

export function enforceGoldTaskCompletionGate(workspaceRoot: string): GoldTaskFileProgress {
  const progress = goldTaskProgressSnapshot(workspaceRoot);
  if (!progress.active || progress.completion_ready) return progress;
  throw new Error(`尚不能完成：${progress.blocking_reasons.join("；")}。`);
}

function normalizedFrozenCommand(value: string): string {
  let normalized = value.trim().replace(/\s+/g, " ");
  const shellWrapped = normalized.match(/^(?:(?:\/usr)?\/bin\/)?(?:bash|sh)\s+-lc\s+(.+)$/);
  if (!shellWrapped) return normalized;

  let payload = shellWrapped[1]?.trim() ?? "";
  if (payload.startsWith("\"") && payload.endsWith("\"")) {
    try {
      payload = JSON.parse(payload) as string;
    } catch {
      payload = payload.slice(1, -1);
    }
  } else if (payload.startsWith("'") && payload.endsWith("'")) {
    payload = payload.slice(1, -1);
  }
  normalized = payload.trim().replace(/\s+/g, " ");
  return normalized;
}

const GOLD_TASK_EXPLORATION_TOOLS = new Set(["search_project", "read_many_files", "tree"]);

function recordedGoldTaskCalls(directory: string): GoldTaskConnectorCallV1[] {
  try {
    return fs.readFileSync(path.join(directory, "tool-calls.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GoldTaskConnectorCallV1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function uniqueRequestCount(calls: readonly GoldTaskConnectorCallV1[], tools: ReadonlySet<string>): number {
  return new Set(calls
    .filter((call) => tools.has(call.tool_name))
    .map((call) => call.connector_request_id))
    .size;
}

export function enforceGoldTaskExplorationBudget(workspaceRoot: string, toolName: string): void {
  if (!GOLD_TASK_EXPLORATION_TOOLS.has(toolName)) return;
  const active = descriptorFromEnvironment(path.resolve(workspaceRoot));
  if (!active) return;
  const calls = recordedGoldTaskCalls(active.directory);
  const explorationCount = uniqueRequestCount(calls, GOLD_TASK_EXPLORATION_TOOLS);
  const searchCount = uniqueRequestCount(calls, new Set(["search_project"]));
  const firstSuccessfulRead = calls.find((call) =>
    call.tool_name === "read_many_files" && call.handler_succeeded
  );
  const searchesAfterRead = firstSuccessfulRead
    ? uniqueRequestCount(calls.filter((call) => call.started_at > firstSuccessfulRead.started_at), new Set(["search_project"]))
    : 0;
  const limitReached = explorationCount >= MAX_GOLD_TASK_EXPLORATION_REQUESTS
    || (toolName === "search_project" && (
      searchCount >= MAX_GOLD_TASK_SEARCH_REQUESTS
      || (firstSuccessfulRead && searchesAfterRead >= MAX_GOLD_TASK_SEARCH_REQUESTS_AFTER_READ)
    ));
  if (!limitReached) return;
  throw new Error(
    `${GOLD_TASK_EXPLORATION_FAILURE_CODE}: the Gold Task already used ${explorationCount}/${MAX_GOLD_TASK_EXPLORATION_REQUESTS} `
    + `exploration requests, ${searchCount}/${MAX_GOLD_TASK_SEARCH_REQUESTS} searches, and `
    + `${searchesAfterRead}/${MAX_GOLD_TASK_SEARCH_REQUESTS_AFTER_READ} searches after the first successful read. `
    + "Further search/tree/read exploration is blocked, but apply_patch_bundle, show_changes, and run_validation remain available. "
    + "Implement from the gathered context or finish with a truthful blocked/failed outcome."
  );
}

export function enforceGoldTaskInternalForwardingBudget(workspaceRoot: string, toolName: string): void {
  if (toolName !== "codexpro") return;
  const active = descriptorFromEnvironment(path.resolve(workspaceRoot));
  if (!active) return;
  const calls = recordedGoldTaskCalls(active.directory);
  const forwardingCount = new Set(calls
    .filter((call) => call.tool_name === "codexpro" && call.connector_request_depth === 0)
    .map((call) => call.connector_request_id)).size;
  if (forwardingCount < MAX_GOLD_TASK_INTERNAL_FORWARD_REQUESTS) return;
  throw new Error(
    `${GOLD_TASK_INTERNAL_FORWARDING_FAILURE_CODE}: the Gold Task already used `
    + `${forwardingCount}/${MAX_GOLD_TASK_INTERNAL_FORWARD_REQUESTS} internal forwarding requests. `
    + "Call the already-visible specialist tool directly and explain any exceptional need for another forwarding route."
  );
}

export interface GoldTaskPatchOperation {
  operation?: unknown;
  path?: unknown;
  content?: unknown;
  old_text?: unknown;
  new_text?: unknown;
  create_dirs?: unknown;
  overwrite?: unknown;
  replace_all?: unknown;
  expected_replacements?: unknown;
}

interface GoldTaskPatchMutationV1 {
  version: 1;
  suite_run_id: string;
  task_id: string;
  connector_request_id: string | null;
  connector_request_depth: number | null;
  operations_digest: string;
  decision: "allowed" | "rejected" | "released" | "exempt";
  reservation_id?: string | null;
  patch_index: number;
  reserved: boolean;
  mutation_class?: "production" | "test" | "diagnostic" | "mixed" | "unknown";
  normalized_paths?: string[];
  general_patch_limit?: number;
  absolute_patch_limit?: number;
  failure_code: string | null;
  recorded_at: string;
}

function recordedPatchMutations(directory: string): GoldTaskPatchMutationV1[] {
  try {
    return fs.readFileSync(path.join(directory, "patch-mutations.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GoldTaskPatchMutationV1)
      .filter((entry) => entry.version === 1 && ["allowed", "rejected", "released", "exempt"].includes(entry.decision));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function activeAllowedPatchMutations(mutations: readonly GoldTaskPatchMutationV1[]): GoldTaskPatchMutationV1[] {
  const releasedReservations = new Set(mutations
    .filter((mutation) => mutation.decision === "released" && mutation.reservation_id)
    .map((mutation) => mutation.reservation_id as string));
  return mutations.filter((mutation) => mutation.decision === "allowed"
    && (!mutation.reservation_id || !releasedReservations.has(mutation.reservation_id)));
}

function patchOperationsDigest(operations: readonly GoldTaskPatchOperation[] | undefined): string {
  const valueDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
  const normalized = (operations ?? []).map((operation) => operation.operation === "write"
    ? {
        operation: "write",
        path: normalizedPatchPath(operation.path),
        content_sha256: valueDigest(operation.content),
        create_dirs: operation.create_dirs !== false,
        overwrite: operation.overwrite !== false
      }
    : {
        operation: operation.operation,
        path: normalizedPatchPath(operation.path),
        old_text_sha256: valueDigest(operation.old_text),
        new_text_sha256: valueDigest(operation.new_text),
        replace_all: operation.replace_all === true,
        expected_replacements: operation.expected_replacements ?? null
      });
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function appendPatchMutation(
  directory: string,
  descriptor: GoldTaskSessionDescriptorV1,
  input: Omit<GoldTaskPatchMutationV1, "version" | "suite_run_id" | "task_id" | "connector_request_id" | "connector_request_depth" | "recorded_at">
): void {
  const request = connectorRequestStorage.getStore();
  appendJsonLine(path.join(directory, "patch-mutations.jsonl"), {
    version: 1,
    suite_run_id: descriptor.suite_run_id,
    task_id: descriptor.task_id,
    connector_request_id: request?.request_id ?? null,
    connector_request_depth: request?.request_depth ?? null,
    ...input,
    recorded_at: new Date().toISOString()
  } satisfies GoldTaskPatchMutationV1);
}

function latestTimestamp(calls: readonly GoldTaskConnectorCallV1[], toolName: string): number {
  return calls
    .filter((call) => call.tool_name === toolName)
    .reduce((latest, call) => Math.max(latest, Date.parse(call.finished_at) || 0), 0);
}

function hasFreshFrozenValidationFailure(
  workspaceRoot: string,
  descriptor: GoldTaskSessionDescriptorV1,
  latestPatchAt: number
): boolean {
  const evaluatorCommandIntegrity = new Map<string, boolean>();
  const evaluators = Array.isArray(descriptor.frozen_validation_evaluators)
    ? descriptor.frozen_validation_evaluators
    : [];
  for (const evaluator of evaluators) {
    const publicPath = String(evaluator.public_path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
    const target = path.resolve(workspaceRoot, ...publicPath.split("/"));
    const relative = path.relative(workspaceRoot, target);
    if (!publicPath || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const command = normalizedFrozenCommand(`node ${publicPath}`);
    try {
      evaluatorCommandIntegrity.set(command, sha256File(target) === evaluator.source_sha256);
    } catch {
      evaluatorCommandIntegrity.set(command, false);
    }
  }

  const validCommands = new Set((descriptor.frozen_validation_commands ?? [])
    .map(normalizedFrozenCommand)
    .filter(Boolean)
    .filter((command) => evaluatorCommandIntegrity.get(command) !== false));
  if (!validCommands.size) return false;

  const evidenceRoot = path.join(workspaceRoot, ".ai-bridge", "execution", "process-evidence");
  let names: string[];
  try {
    names = fs.readdirSync(evidenceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return names.some((name) => {
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), "utf8")) as {
        command?: unknown;
        cwd?: unknown;
        finished_at?: unknown;
        result?: { exit_code?: unknown };
      };
      const finishedAt = typeof evidence.finished_at === "string" ? Date.parse(evidence.finished_at) : 0;
      return typeof evidence.command === "string"
        && validCommands.has(normalizedFrozenCommand(evidence.command))
        && typeof evidence.cwd === "string"
        && path.resolve(evidence.cwd) === workspaceRoot
        && typeof evidence.result?.exit_code === "number"
        && evidence.result.exit_code !== 0
        && finishedAt > latestPatchAt;
    } catch {
      return false;
    }
  });
}

function normalizedPatchPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function isTestOrSmokePath(relativePath: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/i.test(relativePath)
    || /(^|\/)[^/]+\.(test|spec)\.[^/]+$/i.test(relativePath)
    || /^scripts\/[^/]+-smoke\.mjs$/i.test(relativePath);
}

function isProductionPath(relativePath: string): boolean {
  if (isTestOrSmokePath(relativePath)) return false;
  return /^(src|app|apps|lib|packages|frontend|backend|server)\//.test(relativePath);
}

function isDiagnosticPatchPath(relativePath: string): boolean {
  return relativePath === ".ai-bridge" || relativePath.startsWith(".ai-bridge/");
}

function patchOperationProfile(operations: readonly GoldTaskPatchOperation[] | undefined): {
  mutationClass: "production" | "test" | "diagnostic" | "mixed" | "unknown";
  normalizedPaths: string[];
  diagnosticOnly: boolean;
} {
  const normalizedPaths = [...new Set((operations ?? [])
    .map((operation) => normalizedPatchPath(operation.path))
    .filter((item): item is string => Boolean(item)))].sort();
  const classes = new Set(normalizedPaths.map((relativePath) => isDiagnosticPatchPath(relativePath)
    ? "diagnostic"
    : isTestOrSmokePath(relativePath)
      ? "test"
      : isProductionPath(relativePath)
        ? "production"
        : "unknown"));
  const mutationClass = classes.size === 1
    ? [...classes][0] as "production" | "test" | "diagnostic" | "unknown"
    : classes.size > 1
      ? "mixed"
      : "unknown";
  return {
    mutationClass,
    normalizedPaths,
    diagnosticOnly: normalizedPaths.length > 0 && normalizedPaths.every(isDiagnosticPatchPath)
  };
}

function goldTaskPatchBudget(descriptor: GoldTaskSessionDescriptorV1): {
  generalLimit: number;
  absoluteLimit: number;
  complexityPathCount: number;
} {
  const complexityPaths = new Set<string>();
  for (const candidate of descriptor.expected_changed_paths ?? []) {
    const normalized = normalizedPatchPath(candidate);
    if (normalized && !isDiagnosticPatchPath(normalized)) complexityPaths.add(normalized);
  }
  for (const group of descriptor.execution_groups ?? []) {
    for (const candidate of group.paths ?? []) {
      const normalized = normalizedPatchPath(candidate);
      if (normalized && !isDiagnosticPatchPath(normalized)) complexityPaths.add(normalized);
    }
  }
  const complexityPathCount = complexityPaths.size;
  const additionalSlots = Math.ceil(Math.max(0, complexityPathCount - 2) / 2);
  const generalLimit = Math.min(
    MAX_GOLD_TASK_GENERAL_PATCH_REQUESTS,
    DEFAULT_GOLD_TASK_GENERAL_PATCH_REQUESTS + additionalSlots
  );
  return {
    generalLimit,
    absoluteLimit: Math.min(MAX_GOLD_TASK_PATCH_REQUESTS, generalLimit + 1),
    complexityPathCount
  };
}

function reservedPatchScopeAllows(
  workspaceRoot: string,
  descriptor: GoldTaskSessionDescriptorV1,
  operations: readonly GoldTaskPatchOperation[] | undefined,
  mutations: readonly GoldTaskPatchMutationV1[]
): boolean {
  if (!operations?.length) return false;
  const evaluatorOwned = new Set(descriptor.evaluator_owned_paths
    .map((item) => normalizedPatchPath(item))
    .filter((item): item is string => Boolean(item)));
  const relatedPaths = new Set<string>();
  for (const candidate of descriptor.expected_changed_paths ?? []) {
    const normalized = normalizedPatchPath(candidate);
    if (normalized) relatedPaths.add(normalized);
  }
  for (const group of descriptor.execution_groups ?? []) {
    for (const candidate of group.paths ?? []) {
      const normalized = normalizedPatchPath(candidate);
      if (normalized) relatedPaths.add(normalized);
    }
  }
  for (const mutation of activeAllowedPatchMutations(mutations)) {
    for (const candidate of mutation.normalized_paths ?? []) {
      const normalized = normalizedPatchPath(candidate);
      if (normalized) relatedPaths.add(normalized);
    }
  }
  return operations.every((operation) => {
    const relativePath = normalizedPatchPath(operation.path);
    if (!relativePath || evaluatorOwned.has(relativePath)) return false;
    if (isProductionPath(relativePath)) {
      if (relatedPaths.size > 0 && !relatedPaths.has(relativePath)) return false;
      return operation.operation === "write" || operation.operation === "replace";
    }
    if (!isTestOrSmokePath(relativePath) || operation.operation !== "replace") return false;
    try {
      return fs.statSync(path.resolve(workspaceRoot, ...relativePath.split("/"))).isFile();
    } catch {
      return false;
    }
  });
}

export interface GoldTaskPatchReservation {
  active: boolean;
  directory?: string;
  descriptor?: GoldTaskSessionDescriptorV1;
  reservation_id?: string;
  operations_digest?: string;
  patch_index?: number;
  reserved?: boolean;
  mutation_class?: "production" | "test" | "diagnostic" | "mixed" | "unknown";
  normalized_paths?: string[];
  general_patch_limit?: number;
  absolute_patch_limit?: number;
}

export function enforceGoldTaskPatchLoopBudget(
  workspaceRoot: string,
  toolName: string,
  operations?: readonly GoldTaskPatchOperation[]
): GoldTaskPatchReservation {
  if (toolName !== "workspace_mutation") return { active: false };
  const resolvedRoot = path.resolve(workspaceRoot);
  const active = descriptorFromEnvironment(resolvedRoot);
  if (!active) return { active: false };
  const profile = patchOperationProfile(operations);
  const successful = recordedGoldTaskCalls(active.directory).filter((call) => call.outcome === "ok");
  const mutations = recordedPatchMutations(active.directory);
  const firstMutationAt = mutations.reduce((earliest, mutation) => {
    const timestamp = Date.parse(mutation.recorded_at) || Number.POSITIVE_INFINITY;
    return Math.min(earliest, timestamp);
  }, Number.POSITIVE_INFINITY);
  const legacyPatchCalls = successful.filter((call) => call.tool_name === "apply_patch_bundle"
    && (Date.parse(call.finished_at) || 0) < firstMutationAt);
  const legacyPatchCount = uniqueRequestCount(legacyPatchCalls, new Set(["apply_patch_bundle"]));
  const allowedMutations = activeAllowedPatchMutations(mutations);
  const patchCount = legacyPatchCount + allowedMutations.length;
  const operationsDigest = patchOperationsDigest(operations);
  const budget = goldTaskPatchBudget(active.descriptor);
  if (profile.diagnosticOnly) {
    appendPatchMutation(active.directory, active.descriptor, {
      operations_digest: operationsDigest,
      decision: "exempt",
      reservation_id: null,
      patch_index: patchCount,
      reserved: false,
      mutation_class: profile.mutationClass,
      normalized_paths: profile.normalizedPaths,
      general_patch_limit: budget.generalLimit,
      absolute_patch_limit: budget.absoluteLimit,
      failure_code: null
    });
    return {
      active: false,
      mutation_class: profile.mutationClass,
      normalized_paths: profile.normalizedPaths,
      general_patch_limit: budget.generalLimit,
      absolute_patch_limit: budget.absoluteLimit
    };
  }
  const latestPatchAt = Math.max(
    latestTimestamp(legacyPatchCalls, "apply_patch_bundle"),
    ...allowedMutations.map((mutation) => Date.parse(mutation.recorded_at) || 0)
  );
  const reservedPatchSlotAvailable = patchCount === budget.generalLimit;
  const freshFrozenValidationFailure = reservedPatchSlotAvailable
    && hasFreshFrozenValidationFailure(resolvedRoot, active.descriptor, latestPatchAt);
  const reservedScopeAllowed = reservedPatchSlotAvailable
    && reservedPatchScopeAllows(resolvedRoot, active.descriptor, operations, mutations);
  const reservedPatchAllowed = reservedPatchSlotAvailable
    && freshFrozenValidationFailure
    && reservedScopeAllowed;
  const generalPatchAllowed = patchCount < budget.generalLimit;
  if (generalPatchAllowed || reservedPatchAllowed) {
    const reservationId = `patch:${randomUUID()}`;
    appendPatchMutation(active.directory, active.descriptor, {
      operations_digest: operationsDigest,
      decision: "allowed",
      reservation_id: reservationId,
      patch_index: patchCount + 1,
      reserved: reservedPatchAllowed,
      mutation_class: profile.mutationClass,
      normalized_paths: profile.normalizedPaths,
      general_patch_limit: budget.generalLimit,
      absolute_patch_limit: budget.absoluteLimit,
      failure_code: null
    });
    return {
      active: true,
      directory: active.directory,
      descriptor: active.descriptor,
      reservation_id: reservationId,
      operations_digest: operationsDigest,
      patch_index: patchCount + 1,
      reserved: reservedPatchAllowed,
      mutation_class: profile.mutationClass,
      normalized_paths: profile.normalizedPaths,
      general_patch_limit: budget.generalLimit,
      absolute_patch_limit: budget.absoluteLimit
    };
  }
  const latestAllowedAt = latestPatchAt;
  const repeatedRejections = mutations.filter((mutation) => mutation.decision === "rejected"
    && mutation.operations_digest === operationsDigest
    && (Date.parse(mutation.recorded_at) || 0) > latestAllowedAt).length;
  const failureCode = repeatedRejections > 0
    ? GOLD_TASK_PATCH_REJECTION_CIRCUIT_CODE
    : GOLD_TASK_PATCH_LOOP_FAILURE_CODE;
  appendPatchMutation(active.directory, active.descriptor, {
    operations_digest: operationsDigest,
    decision: "rejected",
    reservation_id: null,
    patch_index: patchCount + 1,
    reserved: false,
    mutation_class: profile.mutationClass,
    normalized_paths: profile.normalizedPaths,
    general_patch_limit: budget.generalLimit,
    absolute_patch_limit: budget.absoluteLimit,
    failure_code: failureCode
  });
  throw new Error(
    `${failureCode}: the Gold Task already used ${patchCount}/${budget.absoluteLimit} workspace mutation requests. `
    + `Reserved patch eligibility: slot_available=${reservedPatchSlotAvailable}; `
    + `fresh_frozen_validation_failure=${freshFrozenValidationFailure}; reserved_scope_allowed=${reservedScopeAllowed}. `
    + `The task complexity budget allows ${budget.generalLimit} general patches (complexity_paths=${budget.complexityPathCount}); `
    + "the final reserved patch is available only after a fresh "
    + "frozen validation failure and may change production paths or exactly replace existing test/smoke content. "
    + (failureCode === GOLD_TASK_PATCH_REJECTION_CIRCUIT_CODE
      ? "This same rejected mutation was already attempted; its rejection circuit is now open. Do not retry it through run_task, codexpro, or another write tool. "
      : "")
    + "Otherwise finish with a truthful failed/blocked outcome."
  );
}

export function releaseGoldTaskPatchLoopReservation(
  reservation: GoldTaskPatchReservation,
  failureCode = "patch_bundle_no_success"
): void {
  if (!reservation.active
    || !reservation.directory
    || !reservation.descriptor
    || !reservation.reservation_id
    || !reservation.operations_digest
    || typeof reservation.patch_index !== "number") return;
  const mutations = recordedPatchMutations(reservation.directory);
  if (mutations.some((mutation) => mutation.decision === "released"
    && mutation.reservation_id === reservation.reservation_id)) return;
  appendPatchMutation(reservation.directory, reservation.descriptor, {
    operations_digest: reservation.operations_digest,
    decision: "released",
    reservation_id: reservation.reservation_id,
    patch_index: reservation.patch_index,
    reserved: reservation.reserved === true,
    mutation_class: reservation.mutation_class,
    normalized_paths: reservation.normalized_paths,
    general_patch_limit: reservation.general_patch_limit,
    absolute_patch_limit: reservation.absolute_patch_limit,
    failure_code: failureCode
  });
}

function isTargetedSmokeCommand(command: string): boolean {
  return /^node\s+scripts\/[A-Za-z0-9._-]+-smoke\.mjs$/.test(command);
}

export function enforceGoldTaskFrozenValidation(
  workspaceRoot: string,
  commands: readonly string[]
): GoldTaskFrozenValidationPolicy {
  const active = descriptorFromEnvironment(path.resolve(workspaceRoot));
  if (!active) {
    return { active: false, task_id: null, allowed_frozen_commands: [], allowed_targeted_smoke_commands: [] };
  }
  if (!Array.isArray(active.descriptor.frozen_validation_commands)
    || active.descriptor.frozen_validation_commands.some((command) => typeof command !== "string" || !command.trim())) {
    throw new Error("Gold Task session descriptor does not contain a valid frozen validation command allowlist.");
  }
  const allowed = new Set(active.descriptor.frozen_validation_commands.map(normalizedFrozenCommand));
  const requested = commands.map(normalizedFrozenCommand).filter(Boolean);
  const rejected = requested.filter((command) => !allowed.has(command));
  if (rejected.length) {
    throw new Error(
      `Gold Task frozen validation policy blocked command(s) that were not frozen at session preparation: ${rejected.join(" | ")}.`
    );
  }
  const evaluatorFixtures = Array.isArray(active.descriptor.frozen_validation_evaluators)
    ? active.descriptor.frozen_validation_evaluators
    : [];
  for (const fixture of evaluatorFixtures) {
    const publicPath = String(fixture.public_path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
    const command = normalizedFrozenCommand(`node ${publicPath}`);
    if (!requested.includes(command)) continue;
    const target = path.resolve(workspaceRoot, ...publicPath.split("/"));
    const relative = path.relative(path.resolve(workspaceRoot), target);
    if (!publicPath || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("evaluator_owned_validation_invalid: evaluator fixture path escapes the Gold Task workspace.");
    }
    let actual: string;
    try {
      actual = sha256File(target);
    } catch {
      throw new Error(`evaluator_owned_validation_drift: missing evaluator-owned frozen validation fixture ${publicPath}.`);
    }
    if (actual !== fixture.source_sha256) {
      throw new Error(`evaluator_owned_validation_drift: evaluator-owned frozen validation fixture changed: ${publicPath}.`);
    }
  }
  return {
    active: true,
    task_id: active.descriptor.task_id,
    allowed_frozen_commands: requested,
    allowed_targeted_smoke_commands: requested.filter(isTargetedSmokeCommand)
  };
}

function runtimeWorktreeSha256(workspaceRoot: string): string {
  return `sha256:${createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex")}`;
}

function preflightRuntimeIdentity(workspaceRoot: string): GoldTaskRuntimeIdentity | null {
  const identityPath = process.env[RUNTIME_PREFLIGHT_IDENTITY_FILE_ENV]?.trim();
  if (!identityPath) return null;
  const value = JSON.parse(fs.readFileSync(path.resolve(identityPath), "utf8")) as Partial<GoldTaskRuntimeIdentity>;
  const resolvedRoot = path.resolve(workspaceRoot);
  if (value.active !== true
    || typeof value.suite_run_id !== "string"
    || typeof value.task_id !== "string"
    || typeof value.runtime_git_sha !== "string"
    || typeof value.preflight_nonce !== "string"
    || path.resolve(String(value.worktree_root ?? "")) !== resolvedRoot
    || value.worktree_sha256 !== runtimeWorktreeSha256(resolvedRoot)) {
    throw new Error("Runtime preflight identity file does not match the active workspace.");
  }
  return {
    active: true,
    suite_run_id: value.suite_run_id,
    task_id: value.task_id,
    worktree_root: resolvedRoot,
    worktree_sha256: value.worktree_sha256,
    runtime_git_sha: value.runtime_git_sha,
    preflight_nonce: value.preflight_nonce,
    runtime_pid: process.pid,
    started_at: runtimeProcessStartedAt
  };
}

export function goldTaskRuntimeIdentity(workspaceRoot: string): GoldTaskRuntimeIdentity {
  const resolvedRoot = path.resolve(workspaceRoot);
  const active = descriptorFromEnvironment(resolvedRoot);
  if (!active) {
    const preflight = preflightRuntimeIdentity(resolvedRoot);
    if (preflight) return preflight;
    return {
      active: false,
      suite_run_id: null,
      task_id: null,
      worktree_root: resolvedRoot,
      worktree_sha256: runtimeWorktreeSha256(resolvedRoot),
      runtime_git_sha: null,
      preflight_nonce: null,
      runtime_pid: process.pid,
      started_at: runtimeProcessStartedAt
    };
  }
  return {
    active: true,
    suite_run_id: active.descriptor.suite_run_id,
    task_id: active.descriptor.task_id,
    worktree_root: path.resolve(active.descriptor.worktree_path),
    worktree_sha256: runtimeWorktreeSha256(active.descriptor.worktree_path),
    runtime_git_sha: active.descriptor.runtime_git_sha,
    preflight_nonce: active.descriptor.runtime_preflight_nonce ?? null,
    runtime_pid: process.pid,
    started_at: runtimeProcessStartedAt
  };
}

export function verifyGoldTaskRuntimeHealth(
  descriptor: GoldTaskSessionDescriptorV1,
  health: unknown,
  healthUrl: string,
  verifiedAt = new Date().toISOString(),
  expectedIdentity?: GoldTaskRuntimeIdentity
): GoldTaskRuntimePreflight {
  if (typeof descriptor.runtime_preflight_nonce !== "string" || !descriptor.runtime_preflight_nonce) {
    throw new Error("Session does not contain a runtime preflight nonce.");
  }
  const value = health && typeof health === "object" && !Array.isArray(health)
    ? health as Record<string, unknown>
    : {};
  const identity = value.gold_task && typeof value.gold_task === "object" && !Array.isArray(value.gold_task)
    ? value.gold_task as Record<string, unknown>
    : {};
  const expectedRoot = path.resolve(descriptor.worktree_path);
  const mismatches: string[] = [];
  if (value.ok !== true) mismatches.push("health.ok");
  if (path.resolve(String(value.defaultRoot ?? "")) !== expectedRoot) mismatches.push("defaultRoot");
  if (identity.active !== true) mismatches.push("gold_task.active");
  if (identity.suite_run_id !== descriptor.suite_run_id) mismatches.push("suite_run_id");
  if (identity.task_id !== descriptor.task_id) mismatches.push("task_id");
  if (path.resolve(String(identity.worktree_root ?? "")) !== expectedRoot) mismatches.push("worktree_root");
  if (identity.worktree_sha256 !== runtimeWorktreeSha256(expectedRoot)) mismatches.push("worktree_sha256");
  if (identity.runtime_git_sha !== descriptor.runtime_git_sha) mismatches.push("runtime_git_sha");
  if (identity.preflight_nonce !== descriptor.runtime_preflight_nonce) mismatches.push("preflight_nonce");
  if (!Number.isInteger(identity.runtime_pid) || Number(identity.runtime_pid) < 1) mismatches.push("runtime_pid");
  if (!Number.isFinite(Date.parse(String(identity.started_at ?? "")))) mismatches.push("started_at");
  if (expectedIdentity) {
    for (const field of ["suite_run_id", "task_id", "worktree_root", "worktree_sha256", "runtime_git_sha", "preflight_nonce", "runtime_pid", "started_at"] as const) {
      if (identity[field] !== expectedIdentity[field]) mismatches.push(`local_public.${field}`);
    }
  }
  if (mismatches.length) {
    throw new Error(`Public Connector runtime ownership mismatch: ${mismatches.join(", ")}. Do not start measurement.`);
  }
  return {
    verified: true,
    verified_at: verifiedAt,
    health_url: healthUrl,
    suite_run_id: descriptor.suite_run_id,
    task_id: descriptor.task_id,
    worktree_root: expectedRoot,
    worktree_sha256: runtimeWorktreeSha256(expectedRoot),
    runtime_git_sha: descriptor.runtime_git_sha,
    nonce: descriptor.runtime_preflight_nonce,
    runtime_pid: Number(identity.runtime_pid),
    started_at: String(identity.started_at)
  };
}

function receiptFromResult(result: unknown): ExecutionOriginReceiptV1 {
  const structured = result && typeof result === "object" && !Array.isArray(result)
    ? (result as { structuredContent?: unknown }).structuredContent
    : undefined;
  const receipt = structured && typeof structured === "object" && !Array.isArray(structured)
    ? (structured as { execution_origin_receipt?: unknown }).execution_origin_receipt
    : undefined;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Connector tool result did not contain an Execution Origin Receipt.");
  }
  const value = receipt as Partial<ExecutionOriginReceiptV1>;
  if (value.version !== 1 || typeof value.intelligence_origin !== "string" || typeof value.execution_origin !== "string") {
    throw new Error("Connector tool result contained an invalid Execution Origin Receipt.");
  }
  return value as ExecutionOriginReceiptV1;
}

function recordCaptureError(directory: string | undefined, error: unknown): void {
  if (!directory) return;
  try {
    appendJsonLine(path.join(directory, "recorder-errors.jsonl"), {
      recorded_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  } catch {
    // A secondary recorder failure must not change the already-completed tool outcome.
  }
}

function runtimeHandoffDirectory(): string | null {
  const configured = process.env[RUNTIME_HANDOFF_DIR_ENV]?.trim()
    || process.env[GOLD_TASK_SESSION_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : null;
}

export function recordGoldTaskConnectorConnection(input: {
  workspace_root: string;
  method: string;
  initialize_request: boolean;
  mcp_session_id?: string | null;
}): { active: boolean; recorded: boolean } {
  const identity = goldTaskRuntimeIdentity(input.workspace_root);
  const directory = runtimeHandoffDirectory();
  if (!identity.active || !directory) return { active: false, recorded: false };
  appendJsonLine(path.join(directory, "connector-connections.jsonl"), {
    version: 1,
    suite_run_id: identity.suite_run_id,
    task_id: identity.task_id,
    runtime_pid: identity.runtime_pid,
    method: input.method,
    initialize_request: input.initialize_request,
    mcp_session_id: input.mcp_session_id?.trim() || null,
    authenticated: true,
    connected_at: new Date().toISOString()
  });
  return { active: true, recorded: true };
}

function recordRuntimeHandoffToolCall(input: {
  workspace_root: string;
  correlation_id: string;
  tool_name: string;
  outcome: "ok" | "error";
  started_at_ms: number;
  finished_at_ms: number;
}): void {
  const identity = goldTaskRuntimeIdentity(input.workspace_root);
  const directory = runtimeHandoffDirectory();
  if (!identity.active || !directory) return;
  appendJsonLine(path.join(directory, "handoff-tool-calls.jsonl"), {
    version: 1,
    suite_run_id: identity.suite_run_id,
    task_id: identity.task_id,
    runtime_pid: identity.runtime_pid,
    correlation_id: safeId(input.correlation_id, "correlation_id"),
    tool_name: input.tool_name,
    outcome: input.outcome,
    started_at: new Date(input.started_at_ms).toISOString(),
    finished_at: new Date(input.finished_at_ms).toISOString()
  });
}

function connectorFailureCode(
  toolName: string,
  outcome: "ok" | "error",
  result: unknown,
  request: GoldTaskConnectorRequestContext | undefined
): string | null {
  if (outcome === "ok") return null;
  if (request?.budget_exceeded) return "connector_request_budget_exceeded";
  let text = "";
  try {
    const structured = result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).structuredContent
      : undefined;
    text = JSON.stringify(structured ?? "").toLowerCase();
  } catch {
    text = "";
  }
  if (/repeated_search_blocked/.test(text)) return "repeated_search_blocked";
  if (/gold_task_exploration_budget_exhausted/.test(text)) return "gold_task_exploration_budget_exhausted";
  if (/gold_task_internal_forwarding_budget_exhausted/.test(text)) return "gold_task_internal_forwarding_budget_exhausted";
  if (/gold_task_patch_rejection_circuit_open/.test(text)) return "gold_task_patch_rejection_circuit_open";
  if (/gold_task_patch_loop_exhausted/.test(text)) return "gold_task_patch_loop_exhausted";
  if (/尚不能完成|completion check/.test(text)) return "completion_check_failed";
  if (/not available in the current mode|hidden specialist action|must be disclosed/.test(text)) return "progressive_action_unavailable";
  if (/cannot combine|at most one targeted command|aggregate task/.test(text)) return "aggregate_shape_invalid";
  if (/task router|not allowed for task mode|requested tool/.test(text)) return "task_route_blocked";
  if (/authorization policy|explicit authorization|permission/.test(text)) return "authorization_blocked";
  if (/expected|invalid|must contain|required|accepts at most/.test(text)) return "input_contract_invalid";
  if (/timed out|timeout/.test(text)) return "timeout";
  if (toolName === "search_project") return "search_error";
  if (toolName === "run_validation") return "validation_error";
  if (toolName === "run_task" || toolName === "run_stage") return "aggregate_execution_error";
  return "tool_error";
}

export function recordGoldTaskConnectorCall(input: {
  workspace_root: string;
  correlation_id: string;
  tool_name: string;
  request_task_id?: string | null;
  started_at_ms: number;
  finished_at_ms: number;
  outcome: "ok" | "error";
  handler_invoked: boolean;
  handler_succeeded: boolean;
  risk_level: string;
  side_effect: boolean;
  result: unknown;
}): GoldTaskConnectorCallCapture {
  let directory: string | undefined;
  try {
    recordRuntimeHandoffToolCall(input);
    const active = descriptorFromEnvironment(input.workspace_root);
    if (!active) return { active: false, ok: true };
    directory = active.directory;
    const { descriptor } = active;
    const correlationId = safeId(input.correlation_id, "correlation_id");
    const startedAt = new Date(input.started_at_ms).toISOString();
    const finishedAt = new Date(input.finished_at_ms).toISOString();
    const requestContext = connectorRequestStorage.getStore();
    const receipt = receiptFromResult(input.result);
    const receiptRelativePath = path.posix.join("execution-origin-receipts", `${correlationId}.json`);
    atomicJson(path.join(directory, ...receiptRelativePath.split("/")), receipt);
    const usage = appendUsageEntrySync(input.workspace_root, {
      source_event_id: correlationId,
      task_id: descriptor.task_id,
      run_id: descriptor.suite_run_id,
      execution_id: correlationId,
      component: "tool",
      provider: "chatgpt_connector",
      tool: input.tool_name,
      started_at: startedAt,
      finished_at: finishedAt,
      wall_duration_ms: Math.max(0, input.finished_at_ms - input.started_at_ms),
      outcome: input.outcome,
      verified_completion: false,
      token_measurement: "unavailable",
      evidence: {
        execution_origin_receipt_path: receiptRelativePath,
        handler_invoked: input.handler_invoked,
        handler_succeeded: input.handler_succeeded
      },
      dedupe_key: `gold-task-tool:${descriptor.suite_run_id}:${correlationId}`
    });
    const event: GoldTaskConnectorCallV1 = {
      version: 1,
      suite_run_id: descriptor.suite_run_id,
      task_id: descriptor.task_id,
      correlation_id: correlationId,
      connector_request_id: requestContext?.request_id ?? correlationId,
      connector_request_depth: requestContext?.request_depth ?? 0,
      connector_request_index: requestContext?.request_index ?? null,
      connector_request_limit: requestContext?.request_limit ?? null,
      connector_request_budget_exceeded: requestContext?.budget_exceeded ?? false,
      tool_name: input.tool_name,
      request_task_id: input.request_task_id?.trim() || null,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.max(0, input.finished_at_ms - input.started_at_ms),
      outcome: input.outcome,
      handler_invoked: input.handler_invoked,
      handler_succeeded: input.handler_succeeded,
      failure_code: connectorFailureCode(input.tool_name, input.outcome, input.result, requestContext),
      risk_level: input.risk_level,
      side_effect: input.side_effect,
      usage_entry_id: usage.entry.usage_id,
      execution_origin_receipt_path: receiptRelativePath
    };
    appendJsonLine(path.join(directory, "tool-calls.jsonl"), event);
    try {
      goldTaskProgressSnapshot(input.workspace_root);
    } catch (error) {
      appendJsonLine(path.join(directory, "progress-errors.jsonl"), {
        recorded_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { active: true, ok: true, session_id: descriptor.suite_run_id, task_id: descriptor.task_id };
  } catch (error) {
    recordCaptureError(directory ?? process.env[GOLD_TASK_SESSION_DIR_ENV], error);
    return {
      active: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
