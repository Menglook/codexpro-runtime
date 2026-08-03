import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "./config.js";
import { sha256 } from "./fsOps.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { projectHandoffProgress } from "./jobs/progressProjection.js";
import type { TaskProgress } from "./jobs/jobSteps.js";
import {
  readProjectHandoffExecutionTimeoutConfig,
  resolveHandoffExecutionTimeoutMs
} from "../shared/handoff-timeout-config.mjs";
import { isProcessAlive, readWorkspaceLeaseSync } from "../shared/execution-kernel.mjs";
import { startProcess } from "./runtime/processWrapper.js";

export const HANDOFF_WATCHER_HEARTBEAT_FILE = "watch-handoff-heartbeat.json";
export const HANDOFF_RUN_STATE_FILE = "handoff-run-state.json";
export const HANDOFF_PLAN_FILE = "current-plan.md";

const DEFAULT_HEARTBEAT_LEASE_MS = 15_000;
const SCAFFOLDED_PLAN = "# Current Plan\n\nNo plan written yet.";

type JsonRecord = Record<string, unknown>;
type WatcherProcessSource = "stack_registry" | "heartbeat_pid" | "proc_cache";
type ProcessWatcher = { pid: number; agent?: string; model?: string; command: string; source: WatcherProcessSource };
export type HandoffTerminationReason =
  | "execution_hard_limit"
  | "no_progress_timeout"
  | "explicit_cancel"
  | "cancel_grace_expired"
  | "heartbeat_persistence_failed"
  | "process_exit"
  | "resource_limit"
  | "termination_failed"
  | "unknown_timeout";

export interface HandoffStatusResult {
  workspace_id: string;
  root: string;
  context_dir: string;
  heartbeat_path: string;
  run_state_path: string;
  current_plan_path: string;
  watcher_online: boolean;
  watcher_state: string;
  watcher_reason: string;
  watcher_source?: WatcherProcessSource;
  watcher_pid?: number;
  watcher_agent?: string;
  watcher_model?: string;
  watcher_process_alive: boolean;
  watcher_lease_active: boolean;
  watcher_health_probe_at?: string;
  watcher_health_probe_age_ms?: number;
  watcher_fencing_token?: number;
  heartbeat_age_ms?: number;
  heartbeat_lease_ms: number;
  current_plan_exists: boolean;
  current_plan_scaffold: boolean;
  current_plan_hash?: string;
  run_state?: string;
  run_id?: string;
  run_dir?: string;
  executor_pid?: number;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  execution_timeout_ms?: number;
  last_output_at?: string;
  timeout_reason?: HandoffTerminationReason;
  termination_signal?: string;
  recovery_from_run_id?: string;
  resume_count?: number;
  executor?: string;
  executor_id?: string;
  owner?: string;
  plan_hash?: string;
  iteration?: number;
  phase?: string;
  current_action?: string;
  last_progress_at?: string;
  heartbeat_at?: string;
  diff_summary?: string;
  test_summary?: string;
  terminal_reason?: string;
  run_plan_hash?: string;
  run_matches_current_plan: boolean;
  execution_acknowledged: boolean;
  execution_ready: boolean;
  fallback_allowed: boolean;
  must_not_fallback: boolean;
  blocked_reason?: string;
  takeover_deadline?: string;
  no_progress_deadline?: string;
  restart_count?: number;
  same_failure_repeats?: number;
  max_auto_restarts?: number;
  max_same_failure_repeats?: number;
  recovery_action: string;
  progress: TaskProgress;
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminationReasonField(value: unknown): HandoffTerminationReason | undefined {
  const text = stringField(value);
  if (!text) return undefined;
  if ([
    "execution_hard_limit",
    "no_progress_timeout",
    "explicit_cancel",
    "cancel_grace_expired",
    "heartbeat_persistence_failed",
    "process_exit",
    "resource_limit",
    "termination_failed",
    "unknown_timeout"
  ].includes(text)) return text as HandoffTerminationReason;
  return undefined;
}

function samePath(left: unknown, right: string): boolean {
  return typeof left === "string" && Boolean(left.trim()) && path.resolve(left) === path.resolve(right);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return args.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function readJson(absPath: string, maxBytes: number): Promise<JsonRecord | undefined> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return record(JSON.parse(await fsp.readFile(absPath, "utf8")));
  } catch {
    return undefined;
  }
}

async function readPlan(absPath: string, maxBytes: number): Promise<{ exists: boolean; scaffold: boolean; hash?: string }> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile() || stat.size > maxBytes) return { exists: false, scaffold: false };
    const text = await fsp.readFile(absPath, "utf8");
    return { exists: true, scaffold: text.trim() === SCAFFOLDED_PLAN, hash: sha256(text) };
  } catch {
    return { exists: false, scaffold: false };
  }
}

const WATCHER_PROCESS_CACHE_MS = 5_000;
const watcherProcessCache = new Map<string, { expires_at: number; watcher?: ProcessWatcher }>();

async function stackRegistryWatcher(workspaceRoot: string): Promise<ProcessWatcher | undefined> {
  const statePath = process.env.CODEXPRO_STACK_STATE ?? path.join(os.homedir(), ".codexpro", "stack", "state.json");
  const state = await readJson(statePath, 2 * 1024 * 1024);
  const watchers = Array.isArray(state?.watchers) ? state.watchers : [];
  for (const candidate of watchers) {
    const watcher = record(candidate);
    const pid = finiteNumberField(watcher?.pid);
    if (!pid || !samePath(watcher?.root, workspaceRoot) || !isProcessAlive(pid)) continue;
    return {
      pid,
      agent: stringField(watcher?.agent),
      model: stringField(watcher?.model),
      command: stringField(watcher?.command) ?? "stack-registry watch-handoff",
      source: "stack_registry"
    };
  }
  return undefined;
}

async function scanWatcherProcess(workspaceRoot: string, contextDir: string): Promise<ProcessWatcher | undefined> {
  if (process.platform !== "linux") return undefined;
  let entries: string[];
  try {
    entries = await fsp.readdir("/proc");
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await fsp.readFile(`/proc/${entry}/cmdline`, "utf8");
      const args = raw.split("\0").filter(Boolean);
      if (!args.includes("watch-handoff")) continue;
      const rootArg = argValue(args, "--root");
      if (!rootArg || !samePath(rootArg, workspaceRoot)) continue;
      const contextArg = argValue(args, "--context-dir") ?? ".ai-bridge";
      if (contextArg !== contextDir) continue;
      const pid = Number(entry);
      if (!isProcessAlive(pid)) continue;
      return {
        pid,
        agent: argValue(args, "--agent"),
        model: argValue(args, "--model"),
        command: args.join(" "),
        source: "proc_cache"
      };
    } catch {
      // Process exited or is unreadable.
    }
  }
  return undefined;
}

async function findWatcherProcess(
  workspaceRoot: string,
  contextDir: string,
  heartbeat?: JsonRecord
): Promise<ProcessWatcher | undefined> {
  const registry = await stackRegistryWatcher(workspaceRoot);
  if (registry) return registry;
  const heartbeatPid = finiteNumberField(heartbeat?.pid);
  if (heartbeatPid && isProcessAlive(heartbeatPid)) {
    return {
      pid: heartbeatPid,
      agent: stringField(heartbeat?.agent),
      model: stringField(heartbeat?.model),
      command: "watch-handoff heartbeat owner",
      source: "heartbeat_pid"
    };
  }
  const cacheKey = `${path.resolve(workspaceRoot)}\0${contextDir}`;
  const cached = watcherProcessCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.watcher;
  const watcher = await scanWatcherProcess(workspaceRoot, contextDir);
  watcherProcessCache.set(cacheKey, { expires_at: Date.now() + WATCHER_PROCESS_CACHE_MS, ...(watcher ? { watcher } : {}) });
  return watcher;
}

export async function readHandoffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<HandoffStatusResult> {
  const heartbeatPath = `${config.contextDir}/${HANDOFF_WATCHER_HEARTBEAT_FILE}`;
  const runStatePath = `${config.contextDir}/${HANDOFF_RUN_STATE_FILE}`;
  const currentPlanPath = `${config.contextDir}/${HANDOFF_PLAN_FILE}`;
  const heartbeatResolved = guard.resolve(workspace, heartbeatPath);
  const runStateResolved = guard.resolve(workspace, runStatePath);
  const planResolved = guard.resolve(workspace, currentPlanPath);
  const [heartbeat, runState, plan] = await Promise.all([
    readJson(heartbeatResolved.absPath, config.maxReadBytes),
    readJson(runStateResolved.absPath, config.maxReadBytes),
    readPlan(planResolved.absPath, config.maxReadBytes)
  ]);
  const processWatcher = await findWatcherProcess(workspace.root, config.contextDir, heartbeat);
  const watcherLease = readWorkspaceLeaseSync(workspace.root, { contextDir: config.contextDir, name: "watcher" });

  const lease = Math.max(5_000, Math.min(300_000, Number(heartbeat?.lease_timeout_ms) || DEFAULT_HEARTBEAT_LEASE_MS));
  const updatedAt = stringField(heartbeat?.updated_at);
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const age = Number.isFinite(updatedMs) ? Math.max(0, Date.now() - updatedMs) : undefined;
  const heartbeatState = stringField(heartbeat?.state) ?? "missing";
  const heartbeatFresh = Boolean(
    heartbeat && samePath(heartbeat.root, workspace.root) && heartbeat.context_dir === config.contextDir
    && !["stopped", "stopping", "failed"].includes(heartbeatState)
    && age !== undefined && age <= lease
  );
  const watcherPid = processWatcher?.pid ?? finiteNumberField(heartbeat?.pid);
  const watcherProcessAlive = Boolean(watcherPid && isProcessAlive(watcherPid));
  const heartbeatVersion = finiteNumberField(heartbeat?.version) ?? 1;
  const healthProbeAt = stringField(heartbeat?.health_probe_at) ?? (heartbeatVersion < 3 ? updatedAt : undefined);
  const healthProbeMs = healthProbeAt ? Date.parse(healthProbeAt) : Number.NaN;
  const healthProbeAge = Number.isFinite(healthProbeMs) ? Math.max(0, Date.now() - healthProbeMs) : undefined;
  const healthProbeHealthy = Boolean(
    healthProbeAt
    && healthProbeAge !== undefined
    && healthProbeAge <= lease
    && (heartbeatVersion < 3 || heartbeat?.health_probe_status === "ok")
  );
  const heartbeatFence = finiteNumberField(heartbeat?.fencing_token);
  const leaseFence = finiteNumberField(watcherLease.lease?.fencing_token);
  const leasePid = finiteNumberField(watcherLease.lease?.pid);
  const watcherLeaseActive = Boolean(
    watcherLease.active
    && (!watcherPid || !leasePid || watcherPid === leasePid)
    && (heartbeatFence === undefined || leaseFence === undefined || heartbeatFence === leaseFence)
  );
  const legacyLeaseCompatible = heartbeatVersion < 3 && !watcherLease.lease;
  const watcherOnline = heartbeatFresh && watcherProcessAlive && healthProbeHealthy && (watcherLeaseActive || legacyLeaseCompatible);
  const watcherState = watcherOnline ? "watching" : heartbeatState === "blocked" ? "blocked" : "unhealthy";
  const watcherReason = watcherOnline
    ? "watcher process, heartbeat, health probe, and lease are healthy"
    : !heartbeatFresh
      ? "watcher heartbeat is missing, stale, stopped, or belongs to another workspace"
      : !watcherProcessAlive
        ? "watcher heartbeat is fresh but its process is not alive"
        : !healthProbeHealthy
          ? "watcher process exists but its health probe is stale or degraded"
          : "watcher process and heartbeat exist but the watcher lease/fencing evidence is invalid";

  const rawRunState = stringField(runState?.state);
  const executorPid = finiteNumberField(runState?.pid);
  const executorAlive = Boolean(executorPid && isProcessAlive(executorPid));
  const startedAt = stringField(runState?.started_at);
  const lastOutputAt = stringField(runState?.last_output_at);
  const hardDeadline = stringField(runState?.hard_deadline)
    ?? (startedAt && finiteNumberField(runState?.execution_timeout_ms) !== undefined
      ? new Date(Date.parse(startedAt) + Number(runState?.execution_timeout_ms)).toISOString()
      : undefined);
  const noProgressDeadline = stringField(runState?.no_progress_deadline)
    ?? ((lastOutputAt ?? startedAt) && finiteNumberField(runState?.no_progress_timeout_ms) !== undefined
      ? new Date(Date.parse(lastOutputAt ?? startedAt!) + Number(runState?.no_progress_timeout_ms)).toISOString()
      : undefined);
  const hardExpired = Boolean(hardDeadline && Date.now() >= Date.parse(hardDeadline));
  const noProgressExpired = Boolean(noProgressDeadline && Date.now() >= Date.parse(noProgressDeadline));
  const rawRunning = rawRunState === "running" || rawRunState === "recovering";
  const orphaned = rawRunning && !executorAlive && !watcherLeaseActive;
  const stalled = rawRunning && executorAlive && noProgressExpired;
  const boundedBlocked = rawRunning && (!executorAlive || hardExpired || noProgressExpired);
  const runStateName = orphaned ? "orphaned" : stalled ? "stalled" : boundedBlocked ? "blocked" : rawRunState;
  const projectedTimeoutReason: HandoffTerminationReason | undefined = boundedBlocked
    ? hardExpired ? "execution_hard_limit" : noProgressExpired ? "no_progress_timeout" : "process_exit"
    : terminationReasonField(runState?.timeout_reason);
  const blockedReason = stringField(runState?.blocked_reason)
    ?? (boundedBlocked
      ? hardExpired
        ? "Handoff exceeded its hard deadline."
        : noProgressExpired
          ? "Handoff exceeded its no-progress deadline."
          : "Handoff executor is no longer alive; automatic replay requires reconciliation."
      : stringField(heartbeat?.blocked_reason));
  const runPlanHash = stringField(runState?.plan_hash);
  const executorId = stringField(runState?.executor_id) ?? stringField(runState?.executor);
  const owner = stringField(runState?.owner) ?? stringField(runState?.executor);
  const runMatchesCurrentPlan = Boolean(plan.hash && runPlanHash === plan.hash);
  const executionAcknowledged = Boolean(runMatchesCurrentPlan && runStateName && ["running", "recovering", "completed", "failed", "timed_out", "cancelled", "blocked", "stalled", "orphaned"].includes(runStateName));
  const activeUncertain = rawRunning && boundedBlocked;
  const fallbackAllowed = !watcherOnline && !activeUncertain && !rawRunning;
  const mustNotFallback = activeUncertain;
  const failureReason = blockedReason
    ?? stringField(runState?.error)
    ?? stringField(runState?.failure_reason)
    ?? (projectedTimeoutReason ? `Handoff termination reason: ${projectedTimeoutReason}` : undefined);
  const progress = projectHandoffProgress({
    watcher_online: watcherOnline,
    watcher_reason: watcherReason,
    ...(age !== undefined ? { heartbeat_age_ms: age } : {}),
    heartbeat_lease_ms: lease,
    ...(updatedAt ? { heartbeat_at: updatedAt } : {}),
    ...(runStateName ? { run_state: runStateName } : {}),
    ...(stringField(runState?.run_id) ? { run_id: stringField(runState?.run_id) } : {}),
    ...(stringField(runState?.run_dir) ? { run_dir: stringField(runState?.run_dir) } : {}),
    ...(finiteNumberField(runState?.iteration) !== undefined ? { iteration: finiteNumberField(runState?.iteration) } : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(stringField(runState?.finished_at) ? { finished_at: stringField(runState?.finished_at) } : {}),
    ...(lastOutputAt ? { last_output_at: lastOutputAt } : {}),
    ...(stringField(runState?.executor) ? { executor: stringField(runState?.executor) } : {}),
    ...(failureReason ? { failure_reason: failureReason } : {})
  });
  if (hardDeadline) progress.hard_deadline = hardDeadline;
  if (noProgressDeadline) progress.no_progress_deadline = noProgressDeadline;
  if (projectedTimeoutReason) progress.termination_reason = projectedTimeoutReason;

  return {
    workspace_id: workspace.id,
    root: workspace.root,
    context_dir: config.contextDir,
    heartbeat_path: heartbeatPath,
    run_state_path: runStatePath,
    current_plan_path: currentPlanPath,
    watcher_online: watcherOnline,
    watcher_state: watcherState,
    watcher_reason: watcherReason,
    ...(processWatcher?.source ? { watcher_source: processWatcher.source } : {}),
    ...(watcherPid ? { watcher_pid: watcherPid } : {}),
    ...(processWatcher?.agent ?? stringField(heartbeat?.agent) ? { watcher_agent: processWatcher?.agent ?? stringField(heartbeat?.agent) } : {}),
    ...(processWatcher?.model ?? stringField(heartbeat?.model) ? { watcher_model: processWatcher?.model ?? stringField(heartbeat?.model) } : {}),
    watcher_process_alive: watcherProcessAlive,
    watcher_lease_active: watcherLeaseActive,
    ...(healthProbeAt ? { watcher_health_probe_at: healthProbeAt } : {}),
    ...(healthProbeAge !== undefined ? { watcher_health_probe_age_ms: healthProbeAge } : {}),
    ...(heartbeatFence !== undefined ? { watcher_fencing_token: heartbeatFence } : {}),
    ...(age !== undefined ? { heartbeat_age_ms: age } : {}),
    heartbeat_lease_ms: lease,
    current_plan_exists: plan.exists,
    current_plan_scaffold: plan.scaffold,
    ...(plan.hash ? { current_plan_hash: plan.hash } : {}),
    ...(runStateName ? { run_state: runStateName } : {}),
    ...(stringField(runState?.run_id) ? { run_id: stringField(runState?.run_id) } : {}),
    ...(stringField(runState?.run_dir) ? { run_dir: stringField(runState?.run_dir) } : {}),
    ...(executorPid ? { executor_pid: executorPid } : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(stringField(runState?.finished_at) ? { finished_at: stringField(runState?.finished_at) } : {}),
    ...(finiteNumberField(runState?.duration_ms) !== undefined ? { duration_ms: finiteNumberField(runState?.duration_ms) } : {}),
    ...(finiteNumberField(runState?.execution_timeout_ms) !== undefined ? { execution_timeout_ms: finiteNumberField(runState?.execution_timeout_ms) } : {}),
    ...(lastOutputAt ? { last_output_at: lastOutputAt } : {}),
    ...(projectedTimeoutReason ? { timeout_reason: projectedTimeoutReason } : {}),
    ...(stringField(runState?.termination_signal) ? { termination_signal: stringField(runState?.termination_signal) } : {}),
    ...(stringField(runState?.recovery_from_run_id) ? { recovery_from_run_id: stringField(runState?.recovery_from_run_id) } : {}),
    ...(finiteNumberField(runState?.resume_count) !== undefined ? { resume_count: finiteNumberField(runState?.resume_count) } : {}),
    ...(stringField(runState?.executor) ? { executor: stringField(runState?.executor) } : {}),
    ...(executorId ? { executor_id: executorId } : {}),
    ...(owner ? { owner } : {}),
    ...((runPlanHash ?? plan.hash) ? { plan_hash: runPlanHash ?? plan.hash } : {}),
    ...(finiteNumberField(runState?.iteration) !== undefined ? { iteration: finiteNumberField(runState?.iteration) } : {}),
    phase: stringField(runState?.phase) ?? progress.phase,
    current_action: stringField(runState?.current_action) ?? progress.current_action,
    ...((lastOutputAt ?? progress.progress_at) ? { last_progress_at: lastOutputAt ?? progress.progress_at } : {}),
    ...(updatedAt ? { heartbeat_at: updatedAt } : {}),
    ...(stringField(runState?.diff_summary) ? { diff_summary: stringField(runState?.diff_summary) } : {}),
    ...(stringField(runState?.test_summary) ? { test_summary: stringField(runState?.test_summary) } : {}),
    ...(failureReason ? { terminal_reason: failureReason } : {}),
    ...(runPlanHash ? { run_plan_hash: runPlanHash } : {}),
    run_matches_current_plan: runMatchesCurrentPlan,
    execution_acknowledged: executionAcknowledged,
    execution_ready: watcherOnline || fallbackAllowed,
    fallback_allowed: fallbackAllowed,
    must_not_fallback: mustNotFallback,
    ...(blockedReason ? { blocked_reason: blockedReason } : {}),
    ...(stringField(runState?.takeover_deadline) ? { takeover_deadline: stringField(runState?.takeover_deadline) } : {}),
    ...(noProgressDeadline ? { no_progress_deadline: noProgressDeadline } : {}),
    ...(finiteNumberField(runState?.restart_count) !== undefined ? { restart_count: finiteNumberField(runState?.restart_count) } : {}),
    ...(finiteNumberField(runState?.same_failure_repeats) !== undefined ? { same_failure_repeats: finiteNumberField(runState?.same_failure_repeats) } : {}),
    ...(finiteNumberField(runState?.max_auto_restarts) !== undefined ? { max_auto_restarts: finiteNumberField(runState?.max_auto_restarts) } : {}),
    ...(finiteNumberField(runState?.max_same_failure_repeats) !== undefined ? { max_same_failure_repeats: finiteNumberField(runState?.max_same_failure_repeats) } : {}),
    recovery_action: watcherOnline
      ? "Write the handoff plan and wait for the matching plan hash to be acknowledged."
      : activeUncertain
        ? "Reconcile the interrupted Handoff state before retrying or switching executors."
        : "Watcher infrastructure is unavailable; a safe fallback executor may be used for a new idempotent task.",
    progress
  };
}

export async function ensureHandoffWatcher(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { agent?: string; model?: string; waitMs?: number } = {}
): Promise<HandoffStatusResult> {
  let status = await readHandoffStatus(config, guard, workspace);
  if (status.watcher_online) return status;

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = path.join(packageRoot, "scripts", "codexpro.mjs");
  const timeoutResolution = resolveHandoffExecutionTimeoutMs({
    configValue: readProjectHandoffExecutionTimeoutConfig(workspace.root),
    configSource: ".codexpro/project.yml",
    env: process.env
  });
  const args = [
    scriptPath,
    "watch-handoff",
    "--root",
    workspace.root,
    "--context-dir",
    config.contextDir,
    "--agent",
    options.agent ?? "codex",
    "--timeout-ms",
    String(timeoutResolution.timeoutMs),
    "--yes"
  ];
  if (options.model) args.push("--model", options.model);
  const started = startProcess(process.execPath, args, {
    cwd: packageRoot,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CODEXPRO_ROOT: workspace.root },
    domain: "worker",
    operation: "watch_handoff",
    sideEffectLevel: "local_write",
    riskLevel: "medium",
    recordRoot: workspace.root,
    contextDir: config.contextDir
  });
  started.child?.unref?.();

  const deadline = Date.now() + Math.max(1_000, Math.min(10_000, options.waitMs ?? 5_000));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await readHandoffStatus(config, guard, workspace);
    if (status.watcher_online) return status;
  }
  throw new CodexProError(`Failed to auto-start the local handoff watcher for ${workspace.root}. ${status.watcher_reason}`);
}
