import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus, type CodexProEventName } from "../events/eventBus.js";
import type { Workspace } from "../guard.js";
import { runProcessSync } from "../runtime/processWrapper.js";

export type ResourceCategory = "lightweight" | "standard" | "heavy";
export type ResourcePriority = "urgent" | "normal" | "background";
export type ResourceExecutionMode = "read" | "write";
export type ResourcePoolName =
  | "global_standard"
  | "global_heavy"
  | "workspace_write"
  | "workspace_read"
  | "browser_live_verification"
  | "docker_rebuild"
  | "full_acceptance"
  | "database_maintenance";

export interface ResourcePoolLimitConfig {
  global_standard: number;
  global_heavy: number;
  workspace_write: number;
  workspace_read: number;
  browser_live_verification: number;
  docker_rebuild: number;
  full_acceptance: number;
  database_maintenance: number;
}

export interface ResourceThresholdConfig {
  heavy_cpu_load_per_core_max: number | null;
  heavy_available_memory_mb_min: number | null;
  codexpro_child_rss_mb_max: number | null;
}

export interface ResourcePolicyConfig {
  schema_version: 1;
  defaults: ResourcePoolLimitConfig;
  limits: ResourcePoolLimitConfig;
  thresholds: ResourceThresholdConfig;
  resource_wait_timeout_ms: number;
  source: {
    defaults: true;
    env: string[];
    project_config: string[];
    invalid: string[];
  };
}

export interface ResourceSnapshot {
  observed_at: string;
  cpu: {
    load_1m: number | null;
    cores: number | null;
    load_per_core: number | null;
    evidence: "os" | "unknown";
  };
  memory: {
    total_mb: number | null;
    available_mb: number | null;
    evidence: "os" | "unknown";
  };
  codexpro_process: {
    pid: number | null;
    rss_mb: number | null;
    child_rss_mb: number | null;
    evidence: "process" | "process_and_ps" | "unknown";
  };
  active: {
    builds: number | null;
    tests: number | null;
    browser_runs: number | null;
    docker_operations: number | null;
    heavy_tasks: number | null;
    evidence: "resource_governor" | "unknown";
  };
}

export interface ResourceRequest {
  request_id: string;
  run_id?: string;
  task_id: string;
  task_title: string;
  workspace_id: string;
  workspace_root: string;
  project_id?: string;
  workspace_generation?: number;
  objective_id?: string;
  attempt_id?: string;
  actor_id?: string;
  category: ResourceCategory;
  priority?: ResourcePriority;
  execution_mode: ResourceExecutionMode;
  pools?: ResourcePoolName[];
  owner_id?: string;
  owner_token?: string;
  fencing_token?: number;
  owner_pid?: number;
  managed_pid?: number | null;
  ttl_ms?: number;
  queue_deadline?: string;
  resource_wait_timeout_ms?: number;
  reason?: string;
  skip_workspace_pool?: boolean;
}

export interface ResourceLeaseRecord {
  schema_version: 1;
  lease_id: string;
  request_id: string;
  run_id?: string;
  task_id: string;
  task_title: string;
  workspace_id: string;
  workspace_root: string;
  project_id?: string;
  workspace_generation?: number;
  objective_id?: string;
  attempt_id?: string;
  actor_id?: string;
  category: ResourceCategory;
  priority: ResourcePriority;
  execution_mode: ResourceExecutionMode;
  pools: ResourcePoolName[];
  owner_id: string;
  owner_token?: string;
  fencing_token?: number;
  owner_pid: number | null;
  managed_pid: number | null;
  owner_heartbeat_at: string;
  created_at: string;
  queued_at?: string | null;
  queue_deadline?: string | null;
  resource_wait_timeout_ms?: number | null;
  acquired_at: string;
  queue_duration_ms?: number | null;
  heartbeat_at: string;
  expires_at: string;
  ttl_ms: number;
  reason: string | null;
}

export interface ResourceQueueEntry {
  schema_version: 1;
  queue_id: string;
  request_id: string;
  run_id?: string;
  task_id: string;
  task_title: string;
  workspace_id: string;
  workspace_root: string;
  project_id?: string;
  workspace_generation?: number;
  objective_id?: string;
  attempt_id?: string;
  actor_id?: string;
  category: ResourceCategory;
  priority: ResourcePriority;
  execution_mode: ResourceExecutionMode;
  pools: ResourcePoolName[];
  owner_id: string;
  owner_token?: string;
  fencing_token?: number;
  owner_pid: number | null;
  managed_pid: number | null;
  owner_heartbeat_at: string;
  queued_at: string;
  queue_deadline?: string | null;
  resource_wait_timeout_ms?: number | null;
  heartbeat_at: string;
  blocking_reasons: string[];
  resource_snapshot: ResourceSnapshot;
  reason: string | null;
}

export interface ResourcePoolOccupancy {
  pool: ResourcePoolName;
  limit: number;
  used: number;
  queued: number;
  available: number;
}

export interface ResourceGovernorState {
  schema_version: 1;
  updated_at: string;
  leases: ResourceLeaseRecord[];
  queue: ResourceQueueEntry[];
}

export interface ResourceGovernorStatus {
  schema_version: 1;
  state_path: string;
  generated_at: string;
  config: ResourcePolicyConfig;
  snapshot: ResourceSnapshot;
  occupancy: ResourcePoolOccupancy[];
  leases: ResourceLeaseRecord[];
  queue: ResourceQueueEntry[];
}

export type ResourceAcquireDecision =
  | {
      status: "admitted";
      lease: ResourceLeaseRecord;
      blocking_reasons: [];
      snapshot: ResourceSnapshot;
      occupancy: ResourcePoolOccupancy[];
    }
  | {
      status: "queued_by_resource_policy";
      queue: ResourceQueueEntry;
      blocking_reasons: string[];
      snapshot: ResourceSnapshot;
      occupancy: ResourcePoolOccupancy[];
    }
  | {
      status: "blocked_by_resource_policy";
      blocking_reasons: string[];
      snapshot: ResourceSnapshot;
      occupancy: ResourcePoolOccupancy[];
    };

export interface ResourceProjection {
  run_id: string | null;
  resource_class: ResourceCategory;
  priority: ResourcePriority;
  execution_mode: ResourceExecutionMode;
  status: "admitted" | "queued_by_resource_policy" | "blocked_by_resource_policy" | "released" | "unknown";
  pools: ResourcePoolName[];
  blocking_reasons: string[];
  queue_id: string | null;
  queue_position: number | null;
  lease_id: string | null;
  queue_duration_ms: number | null;
  policy_source: string;
  occupancy: ResourcePoolOccupancy[];
  snapshot: ResourceSnapshot | null;
  updated_at: string;
}

export const DEFAULT_RESOURCE_LIMITS: ResourcePoolLimitConfig = {
  global_standard: 2,
  global_heavy: 1,
  workspace_write: 1,
  workspace_read: 2,
  browser_live_verification: 1,
  docker_rebuild: 1,
  full_acceptance: 1,
  database_maintenance: 1
};

const RESOURCE_LIMIT_BOUNDS: Record<keyof ResourcePoolLimitConfig, { min: number; max: number }> = {
  global_standard: { min: 1, max: 8 },
  global_heavy: { min: 1, max: 3 },
  workspace_write: { min: 1, max: 1 },
  workspace_read: { min: 1, max: 8 },
  browser_live_verification: { min: 1, max: 1 },
  docker_rebuild: { min: 1, max: 1 },
  full_acceptance: { min: 1, max: 1 },
  database_maintenance: { min: 1, max: 1 }
};

const ENV_LIMITS: Record<keyof ResourcePoolLimitConfig, string> = {
  global_standard: "CODEXPRO_RESOURCE_GLOBAL_STANDARD",
  global_heavy: "CODEXPRO_RESOURCE_GLOBAL_HEAVY",
  workspace_write: "CODEXPRO_RESOURCE_WORKSPACE_WRITE",
  workspace_read: "CODEXPRO_RESOURCE_WORKSPACE_READ",
  browser_live_verification: "CODEXPRO_RESOURCE_BROWSER_LIVE",
  docker_rebuild: "CODEXPRO_RESOURCE_DOCKER_REBUILD",
  full_acceptance: "CODEXPRO_RESOURCE_FULL_ACCEPTANCE",
  database_maintenance: "CODEXPRO_RESOURCE_DATABASE_MAINTENANCE"
};

const DEFAULT_THRESHOLDS: ResourceThresholdConfig = {
  heavy_cpu_load_per_core_max: null,
  heavy_available_memory_mb_min: null,
  codexpro_child_rss_mb_max: null
};

const ENV_THRESHOLDS: Record<keyof ResourceThresholdConfig, string> = {
  heavy_cpu_load_per_core_max: "CODEXPRO_RESOURCE_HEAVY_CPU_LOAD_PER_CORE_MAX",
  heavy_available_memory_mb_min: "CODEXPRO_RESOURCE_HEAVY_AVAILABLE_MEMORY_MB_MIN",
  codexpro_child_rss_mb_max: "CODEXPRO_RESOURCE_CODEXPRO_CHILD_RSS_MB_MAX"
};

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_RESOURCE_WAIT_TIMEOUT_MS = 10_000;
const MAX_RESOURCE_WAIT_TIMEOUT_MS = 24 * 60 * 60_000;
const MIN_RESOURCE_WAIT_TIMEOUT_MS = 100;
const WAIT_POLL_MS = 250;

async function waitForResourcePoll(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const READ_ONLY_HOST_SNAPSHOT_MAX_AGE_MS = 30_000;
const PRIORITY_RANK: Record<ResourcePriority, number> = { urgent: 0, normal: 1, background: 2 };
const STATE_SCHEMA_VERSION = 1;
const RESOURCE_POOL_NAMES = new Set<ResourcePoolName>(Object.keys(DEFAULT_RESOURCE_LIMITS) as ResourcePoolName[]);

export const RESOURCE_WAIT_TIMEOUT_CODE = "resource_wait_timeout";

export class ResourceWaitTimeoutError extends Error {
  readonly code = RESOURCE_WAIT_TIMEOUT_CODE;

  constructor(
    message: string,
    readonly details: {
      request_id: string;
      run_id?: string;
      task_id: string;
      queue_id?: string;
      queue_deadline: string;
      waited_ms: number;
      blocking_reasons: string[];
    }
  ) {
    super(message);
    this.name = "ResourceWaitTimeoutError";
  }
}

export function isResourceWaitTimeoutError(error: unknown): error is ResourceWaitTimeoutError {
  return error instanceof ResourceWaitTimeoutError
    || Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === RESOURCE_WAIT_TIMEOUT_CODE);
}

interface ResourceAdmissionContext {
  workspace_id: string;
  workspace_mode: ResourceExecutionMode;
  pools: ResourcePoolName[];
  primary_lease: ResourceLeaseRecord;
}

export interface ResourceAdmissionSnapshot {
  workspace_id: string;
  workspace_mode: ResourceExecutionMode;
  pools: ResourcePoolName[];
  primary_lease: ResourceLeaseRecord;
}

export const RESOURCE_PARENT_LEASE_LOST_CODE = "resource_parent_lease_lost";

export class ResourceParentLeaseLostError extends Error {
  readonly code = RESOURCE_PARENT_LEASE_LOST_CODE;

  constructor(readonly lease: ResourceLeaseRecord) {
    super(`${RESOURCE_PARENT_LEASE_LOST_CODE}: parent resource lease ${lease.lease_id} is no longer active for ${lease.task_id}.`);
    this.name = "ResourceParentLeaseLostError";
  }
}

const resourceAdmissionContext = new AsyncLocalStorage<ResourceAdmissionContext>();

export function currentResourceAdmissionSnapshot(): ResourceAdmissionSnapshot | undefined {
  const current = resourceAdmissionContext.getStore();
  if (!current) return undefined;
  return {
    workspace_id: current.workspace_id,
    workspace_mode: current.workspace_mode,
    pools: [...current.pools],
    primary_lease: { ...current.primary_lease, pools: [...current.primary_lease.pools] }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableRunIdForRequest(request: Pick<ResourceRequest, "request_id" | "task_id">): string {
  const hash = createHash("sha256")
    .update(`${request.task_id}\0${request.request_id}`)
    .digest("hex")
    .slice(0, 24);
  return `resource-${hash}`;
}

function stableOwnerIdForRequest(request: Pick<ResourceRequest, "request_id" | "task_id" | "run_id">): string {
  const hash = createHash("sha256")
    .update(`${request.run_id ?? ""}\0${request.task_id}\0${request.request_id}`)
    .digest("hex")
    .slice(0, 24);
  return `resource-owner-${hash}`;
}

function normalizeResourceWaitTimeoutMs(value: unknown, fallback = DEFAULT_RESOURCE_WAIT_TIMEOUT_MS): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_RESOURCE_WAIT_TIMEOUT_MS, Math.min(MAX_RESOURCE_WAIT_TIMEOUT_MS, Math.floor(parsed)));
}

function resourceWaitTimeoutMsForConfig(config: CodexProConfig): number {
  return normalizeResourceWaitTimeoutMs(config.resourceWaitTimeoutMs, DEFAULT_RESOURCE_WAIT_TIMEOUT_MS);
}

function parsedTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationSince(startedAt: string | undefined | null, endedAt = nowIso()): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

async function emitResourceEvent(
  name: CodexProEventName,
  record: Pick<ResourceRequest, "task_id" | "request_id" | "workspace_id" | "workspace_root" | "category" | "execution_mode"> & {
    run_id?: string;
    queue_id?: string;
    lease_id?: string;
    pools?: ResourcePoolName[];
    blocking_reasons?: string[];
    queue_duration_ms?: number | null;
  }
): Promise<void> {
  try {
    await codexProEventBus.emit(
      name,
      {
        domain: "resource_governor",
        run_id: record.run_id ?? stableRunIdForRequest(record),
        request_id: record.request_id,
        task_id: record.task_id,
        workspace_id: record.workspace_id,
        workspace_root: record.workspace_root,
        category: record.category,
        execution_mode: record.execution_mode,
        pools: record.pools ?? [],
        ...(record.queue_id ? { queue_id: record.queue_id } : {}),
        ...(record.lease_id ? { lease_id: record.lease_id } : {}),
        ...(record.blocking_reasons ? { blocking_reasons: record.blocking_reasons } : {}),
        ...(record.queue_duration_ms !== undefined ? { queue_duration_ms: record.queue_duration_ms } : {})
      },
      {
        source: "resource_governor",
        correlation_id: record.run_id ?? stableRunIdForRequest(record),
        task_id: record.task_id
      }
    );
  } catch {
    // Resource state remains authoritative when observers fail.
  }
}

function addMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function realpathOrResolve(root: string): string {
  try {
    return fs.realpathSync(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

function statePathFor(config: CodexProConfig): string {
  return path.join(config.defaultRoot, config.contextDir, "resource-governor", "state.json");
}

function processAlive(pid: number | null | undefined): boolean | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  const procPath = `/proc/${pid}`;
  if (fs.existsSync("/proc")) return fs.existsSync(procPath);
  return null;
}

function normalizePriority(value: unknown): ResourcePriority {
  return value === "urgent" || value === "background" ? value : "normal";
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOverride(
  raw: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  label: string,
  source: "env" | "project_config",
  configSource: ResourcePolicyConfig["source"]
): number {
  const parsed = finiteNumber(raw);
  if (parsed === null) {
    if (raw !== undefined && raw !== null && raw !== "") configSource.invalid.push(`${source}:${label}`);
    return fallback;
  }
  const value = Math.floor(parsed);
  const clamped = Math.max(bounds.min, Math.min(bounds.max, value));
  if (clamped !== value) configSource.invalid.push(`${source}:${label}:clamped`);
  if (source === "env") configSource.env.push(label);
  else configSource.project_config.push(label);
  return clamped;
}

function numberOverride(
  raw: unknown,
  fallback: number | null,
  label: string,
  source: "env" | "project_config",
  configSource: ResourcePolicyConfig["source"],
  bounds: { min: number; max: number }
): number | null {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = finiteNumber(raw);
  if (parsed === null) {
    configSource.invalid.push(`${source}:${label}`);
    return fallback;
  }
  const clamped = Math.max(bounds.min, Math.min(bounds.max, parsed));
  if (clamped !== parsed) configSource.invalid.push(`${source}:${label}:clamped`);
  if (source === "env") configSource.env.push(label);
  else configSource.project_config.push(label);
  return clamped;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readProjectResourcePolicy(workspaceRoot: string): Record<string, unknown> | undefined {
  const file = path.join(workspaceRoot, ".codexpro", "project.yml");
  try {
    if (!fs.existsSync(file)) return undefined;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512_000) return undefined;
    const parsed = parse(fs.readFileSync(file, "utf8")) as unknown;
    return objectValue(objectValue(parsed)?.resource_policy);
  } catch {
    return undefined;
  }
}

function nestedPolicyNumber(policy: Record<string, unknown> | undefined, key: keyof ResourcePoolLimitConfig): unknown {
  if (!policy) return undefined;
  const direct = policy[key];
  if (direct !== undefined) return direct;
  const global = objectValue(policy.global);
  const workspace = objectValue(policy.workspace);
  const browser = objectValue(policy.browser);
  const docker = objectValue(policy.docker);
  const acceptance = objectValue(policy.acceptance);
  const database = objectValue(policy.database);
  if (key === "global_standard") return global?.standard;
  if (key === "global_heavy") return global?.heavy;
  if (key === "workspace_write") return workspace?.write;
  if (key === "workspace_read") return workspace?.read;
  if (key === "browser_live_verification") return browser?.live_verification ?? browser?.live;
  if (key === "docker_rebuild") return docker?.rebuild;
  if (key === "full_acceptance") return acceptance?.full ?? policy.full_acceptance;
  if (key === "database_maintenance") return database?.maintenance;
  return undefined;
}

function nestedThresholdNumber(policy: Record<string, unknown> | undefined, key: keyof ResourceThresholdConfig): unknown {
  if (!policy) return undefined;
  const thresholds = objectValue(policy.thresholds);
  return thresholds?.[key] ?? policy[key];
}

export function resolveResourcePolicy(config: CodexProConfig, workspaceRoot = config.defaultRoot): ResourcePolicyConfig {
  const source: ResourcePolicyConfig["source"] = { defaults: true, env: [], project_config: [], invalid: [] };
  const projectPolicy = readProjectResourcePolicy(realpathOrResolve(workspaceRoot));
  const limits: ResourcePoolLimitConfig = { ...DEFAULT_RESOURCE_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof ResourcePoolLimitConfig>) {
    const fromProject = nestedPolicyNumber(projectPolicy, key);
    if (fromProject !== undefined) {
      limits[key] = integerOverride(fromProject, limits[key], RESOURCE_LIMIT_BOUNDS[key], key, "project_config", source);
    }
    const fromEnv = process.env[ENV_LIMITS[key]];
    if (fromEnv !== undefined) {
      limits[key] = integerOverride(fromEnv, limits[key], RESOURCE_LIMIT_BOUNDS[key], key, "env", source);
    }
  }

  const thresholds: ResourceThresholdConfig = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(thresholds) as Array<keyof ResourceThresholdConfig>) {
    const fromProject = nestedThresholdNumber(projectPolicy, key);
    const bounds = key === "heavy_cpu_load_per_core_max"
      ? { min: 0.01, max: 100 }
      : { min: 1, max: 1024 * 1024 };
    if (fromProject !== undefined) {
      thresholds[key] = numberOverride(fromProject, thresholds[key], key, "project_config", source, bounds);
    }
    const fromEnv = process.env[ENV_THRESHOLDS[key]];
    if (fromEnv !== undefined) {
      thresholds[key] = numberOverride(fromEnv, thresholds[key], key, "env", source, bounds);
    }
  }

  return {
    schema_version: 1,
    defaults: { ...DEFAULT_RESOURCE_LIMITS },
    limits,
    thresholds,
    resource_wait_timeout_ms: resourceWaitTimeoutMsForConfig(config),
    source
  };
}

function legacyId(prefix: string, value: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${hash}`;
}

function stringField(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function optionalStringField(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function optionalFencingToken(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isoField(value: unknown, fallback = nowIso()): string {
  const parsed = parsedTime(value);
  return parsed === null ? fallback : new Date(parsed).toISOString();
}

function optionalIsoField(value: unknown): string | null {
  const parsed = parsedTime(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeCategoryField(value: unknown): ResourceCategory {
  return value === "lightweight" || value === "heavy" ? value : "standard";
}

function normalizeExecutionModeField(value: unknown): ResourceExecutionMode {
  return value === "write" ? "write" : "read";
}

function normalizePoolsField(value: unknown, category: ResourceCategory, executionMode: ResourceExecutionMode): ResourcePoolName[] {
  const pools = new Set<ResourcePoolName>();
  if (Array.isArray(value)) {
    for (const pool of value) {
      if (typeof pool === "string" && RESOURCE_POOL_NAMES.has(pool as ResourcePoolName)) pools.add(pool as ResourcePoolName);
    }
  }
  if (!pools.size) {
    if (category === "standard") pools.add("global_standard");
    if (category === "heavy") pools.add("global_heavy");
    pools.add(executionMode === "write" ? "workspace_write" : "workspace_read");
  }
  return [...pools];
}

function normalizeLeaseRecord(item: unknown): ResourceLeaseRecord | undefined {
  const parsed = objectValue(item);
  if (!parsed) return undefined;
  const category = normalizeCategoryField(parsed.category);
  const executionMode = normalizeExecutionModeField(parsed.execution_mode);
  const requestId = stringField(parsed.request_id, legacyId("legacy_request", parsed));
  const taskId = stringField(parsed.task_id, requestId);
  const runId = optionalStringField(parsed.run_id);
  const ttlMs = positiveNumber(parsed.ttl_ms ?? parsed.ttlMs, DEFAULT_LEASE_TTL_MS, 10_000, 60 * 60_000);
  const heartbeatAt = isoField(parsed.heartbeat_at ?? parsed.owner_heartbeat_at ?? parsed.acquired_at ?? parsed.created_at);
  const acquiredAt = isoField(parsed.acquired_at ?? parsed.created_at ?? heartbeatAt, heartbeatAt);
  const createdAt = isoField(parsed.created_at ?? acquiredAt, acquiredAt);
  const expiresAt = isoField(parsed.expires_at, new Date(Date.parse(heartbeatAt) + ttlMs).toISOString());
  const normalized: ResourceLeaseRecord = {
    schema_version: 1,
    lease_id: stringField(parsed.lease_id, legacyId("rl_legacy", { requestId, taskId, acquiredAt })),
    request_id: requestId,
    ...(runId ? { run_id: runId } : {}),
    task_id: taskId,
    task_title: stringField(parsed.task_title, taskId),
    workspace_id: stringField(parsed.workspace_id, "default"),
    workspace_root: stringField(parsed.workspace_root, "."),
    ...(optionalStringField(parsed.project_id) ? { project_id: optionalStringField(parsed.project_id) } : {}),
    ...(Number.isInteger(Number(parsed.workspace_generation)) && Number(parsed.workspace_generation) >= 1 ? { workspace_generation: Number(parsed.workspace_generation) } : {}),
    ...(optionalStringField(parsed.objective_id) ? { objective_id: optionalStringField(parsed.objective_id) } : {}),
    ...(optionalStringField(parsed.attempt_id) ? { attempt_id: optionalStringField(parsed.attempt_id) } : {}),
    ...(optionalStringField(parsed.actor_id) ? { actor_id: optionalStringField(parsed.actor_id) } : {}),
    category,
    priority: normalizePriority(parsed.priority),
    execution_mode: executionMode,
    pools: normalizePoolsField(parsed.pools, category, executionMode),
    owner_id: stringField(parsed.owner_id, stableOwnerIdForRequest({ request_id: requestId, task_id: taskId, run_id: runId })),
    ...(optionalStringField(parsed.owner_token ?? parsed.ownerToken) ? { owner_token: optionalStringField(parsed.owner_token ?? parsed.ownerToken) } : {}),
    ...(optionalFencingToken(parsed.fencing_token ?? parsed.fencingToken) !== undefined ? { fencing_token: optionalFencingToken(parsed.fencing_token ?? parsed.fencingToken) } : {}),
    owner_pid: numberOrNull(parsed.owner_pid),
    managed_pid: numberOrNull(parsed.managed_pid),
    owner_heartbeat_at: isoField(parsed.owner_heartbeat_at ?? parsed.heartbeat_at, heartbeatAt),
    created_at: createdAt,
    ...(optionalIsoField(parsed.queued_at) ? { queued_at: optionalIsoField(parsed.queued_at) } : {}),
    ...(optionalIsoField(parsed.queue_deadline) ? { queue_deadline: optionalIsoField(parsed.queue_deadline) } : {}),
    ...(parsed.resource_wait_timeout_ms !== undefined ? { resource_wait_timeout_ms: normalizeResourceWaitTimeoutMs(parsed.resource_wait_timeout_ms) } : {}),
    acquired_at: acquiredAt,
    ...(Number.isFinite(Number(parsed.queue_duration_ms)) ? { queue_duration_ms: Math.max(0, Number(parsed.queue_duration_ms)) } : {}),
    heartbeat_at: heartbeatAt,
    expires_at: expiresAt,
    ttl_ms: ttlMs,
    reason: typeof parsed.reason === "string" ? parsed.reason : null
  };
  return normalized;
}

function normalizeQueueEntry(item: unknown): ResourceQueueEntry | undefined {
  const parsed = objectValue(item);
  if (!parsed) return undefined;
  const category = normalizeCategoryField(parsed.category);
  const executionMode = normalizeExecutionModeField(parsed.execution_mode);
  const requestId = stringField(parsed.request_id, legacyId("legacy_queue_request", parsed));
  const taskId = stringField(parsed.task_id, requestId);
  const runId = optionalStringField(parsed.run_id);
  const heartbeatAt = isoField(parsed.heartbeat_at ?? parsed.queued_at);
  const snapshot = objectValue(parsed.resource_snapshot) ? parsed.resource_snapshot as ResourceSnapshot : collectResourceSnapshot({ leases: [] });
  return {
    schema_version: 1,
    queue_id: stringField(parsed.queue_id, legacyId("rq_legacy", { requestId, taskId, heartbeatAt })),
    request_id: requestId,
    ...(runId ? { run_id: runId } : {}),
    task_id: taskId,
    task_title: stringField(parsed.task_title, taskId),
    workspace_id: stringField(parsed.workspace_id, "default"),
    workspace_root: stringField(parsed.workspace_root, "."),
    ...(optionalStringField(parsed.project_id) ? { project_id: optionalStringField(parsed.project_id) } : {}),
    ...(Number.isInteger(Number(parsed.workspace_generation)) && Number(parsed.workspace_generation) >= 1 ? { workspace_generation: Number(parsed.workspace_generation) } : {}),
    ...(optionalStringField(parsed.objective_id) ? { objective_id: optionalStringField(parsed.objective_id) } : {}),
    ...(optionalStringField(parsed.attempt_id) ? { attempt_id: optionalStringField(parsed.attempt_id) } : {}),
    ...(optionalStringField(parsed.actor_id) ? { actor_id: optionalStringField(parsed.actor_id) } : {}),
    category,
    priority: normalizePriority(parsed.priority),
    execution_mode: executionMode,
    pools: normalizePoolsField(parsed.pools, category, executionMode),
    owner_id: stringField(parsed.owner_id, stableOwnerIdForRequest({ request_id: requestId, task_id: taskId, run_id: runId })),
    ...(optionalStringField(parsed.owner_token ?? parsed.ownerToken) ? { owner_token: optionalStringField(parsed.owner_token ?? parsed.ownerToken) } : {}),
    ...(optionalFencingToken(parsed.fencing_token ?? parsed.fencingToken) !== undefined ? { fencing_token: optionalFencingToken(parsed.fencing_token ?? parsed.fencingToken) } : {}),
    owner_pid: numberOrNull(parsed.owner_pid),
    managed_pid: numberOrNull(parsed.managed_pid),
    owner_heartbeat_at: isoField(parsed.owner_heartbeat_at ?? parsed.heartbeat_at, heartbeatAt),
    queued_at: isoField(parsed.queued_at, heartbeatAt),
    ...(optionalIsoField(parsed.queue_deadline) ? { queue_deadline: optionalIsoField(parsed.queue_deadline) } : {}),
    ...(parsed.resource_wait_timeout_ms !== undefined ? { resource_wait_timeout_ms: normalizeResourceWaitTimeoutMs(parsed.resource_wait_timeout_ms) } : {}),
    heartbeat_at: heartbeatAt,
    blocking_reasons: Array.isArray(parsed.blocking_reasons) ? parsed.blocking_reasons.filter((entry): entry is string => typeof entry === "string") : [],
    resource_snapshot: snapshot,
    reason: typeof parsed.reason === "string" ? parsed.reason : null
  };
}

function safeState(value: unknown): ResourceGovernorState {
  const parsed = objectValue(value);
  const leases = Array.isArray(parsed?.leases)
    ? parsed.leases.map(normalizeLeaseRecord).filter((item): item is ResourceLeaseRecord => Boolean(item))
    : [];
  const queue = Array.isArray(parsed?.queue)
    ? parsed.queue.map(normalizeQueueEntry).filter((item): item is ResourceQueueEntry => Boolean(item))
    : [];
  return {
    schema_version: 1,
    updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : nowIso(),
    leases,
    queue
  };
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

function childRssMb(): { rss: number | null; evidence: "process" | "process_and_ps" | "unknown" } {
  try {
    const ppid = process.pid;
    const output = fs.existsSync("/bin/ps")
      ? ps(["-eo", "ppid=,rss="])
      : "";
    if (!output) return { rss: null, evidence: "process" };
    let rssKb = 0;
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      if (Number(match[1]) === ppid) rssKb += Number(match[2]);
    }
    return { rss: Math.round(rssKb / 102.4) / 10, evidence: "process_and_ps" };
  } catch {
    return { rss: null, evidence: "process" };
  }
}

function ps(args: string[]): string {
  try {
    const result = runProcessSync("ps", args, {
      timeoutMs: 1000,
      maxOutputBytes: 1024 * 1024,
      domain: "probe",
      operation: "ps",
      sideEffectLevel: "none",
      riskLevel: "low"
    });
    if (result.exitCode !== 0) return "";
    return result.stdout;
  } catch {
    return "";
  }
}

let hostResourceSnapshotCache: {
  sampled_at_ms: number;
  observed_at: string;
  cpu: ResourceSnapshot["cpu"];
  memory: ResourceSnapshot["memory"];
  codexpro_process: ResourceSnapshot["codexpro_process"];
} | null = null;

function hostResourceSnapshot(maxAgeMs = 0): NonNullable<typeof hostResourceSnapshotCache> {
  const now = Date.now();
  if (hostResourceSnapshotCache && maxAgeMs > 0 && now - hostResourceSnapshotCache.sampled_at_ms < maxAgeMs) return hostResourceSnapshotCache;
  const observedAt = nowIso();
  const cpus = os.cpus();
  const cores = cpus.length || null;
  const load1 = os.loadavg?.()[0];
  const load = Number.isFinite(load1) ? load1 : null;
  const totalMem = os.totalmem?.();
  const freeMem = os.freemem?.();
  const rssMb = Math.round(process.memoryUsage().rss / 102.4 / 1024) / 10;
  const child = childRssMb();
  hostResourceSnapshotCache = {
    sampled_at_ms: now,
    observed_at: observedAt,
    cpu: {
      load_1m: load,
      cores,
      load_per_core: load !== null && cores ? Math.round((load / cores) * 1000) / 1000 : null,
      evidence: load !== null && cores ? "os" : "unknown"
    },
    memory: {
      total_mb: Number.isFinite(totalMem) ? Math.round(totalMem / 1024 / 1024) : null,
      available_mb: Number.isFinite(freeMem) ? Math.round(freeMem / 1024 / 1024) : null,
      evidence: Number.isFinite(totalMem) && Number.isFinite(freeMem) ? "os" : "unknown"
    },
    codexpro_process: {
      pid: process.pid,
      rss_mb: rssMb,
      child_rss_mb: child.rss,
      evidence: child.evidence
    }
  };
  return hostResourceSnapshotCache;
}

export function collectResourceSnapshot(
  state?: Pick<ResourceGovernorState, "leases">,
  options: { host_max_age_ms?: number } = {}
): ResourceSnapshot {
  const host = hostResourceSnapshot(Math.max(0, Math.floor(options.host_max_age_ms ?? 0)));
  const leases = state?.leases ?? [];
  const poolCount = (pool: ResourcePoolName): number => leases.filter((lease) => lease.pools.includes(pool)).length;
  return {
    observed_at: host.observed_at,
    cpu: host.cpu,
    memory: host.memory,
    codexpro_process: host.codexpro_process,
    active: {
      builds: null,
      tests: null,
      browser_runs: poolCount("browser_live_verification"),
      docker_operations: poolCount("docker_rebuild"),
      heavy_tasks: leases.filter((lease) => lease.category === "heavy").length,
      evidence: "resource_governor"
    }
  };
}

function defaultPools(request: ResourceRequest): ResourcePoolName[] {
  const pools = new Set<ResourcePoolName>();
  if (request.category === "standard") pools.add("global_standard");
  if (request.category === "heavy") pools.add("global_heavy");
  if (!request.skip_workspace_pool) {
    if (request.execution_mode === "write") pools.add("workspace_write");
    else pools.add("workspace_read");
  }
  for (const pool of request.pools ?? []) pools.add(pool);
  if (request.category === "lightweight") {
    pools.delete("global_standard");
    pools.delete("global_heavy");
  }
  return [...pools];
}

function occupancyFor(state: ResourceGovernorState, policy: ResourcePolicyConfig): ResourcePoolOccupancy[] {
  const pools = Object.keys(policy.limits) as ResourcePoolName[];
  return pools.map((pool) => {
    const used = state.leases.filter((lease) => lease.pools.includes(pool)).length;
    const queued = state.queue.filter((entry) => entry.pools.includes(pool)).length;
    const limit = policy.limits[pool];
    return { pool, limit, used, queued, available: Math.max(0, limit - used) };
  });
}

function sameWorkspacePool(pool: ResourcePoolName): boolean {
  return pool === "workspace_write" || pool === "workspace_read";
}

function requestConflictsWithLease(request: ResourceRequest, pools: ResourcePoolName[], lease: ResourceLeaseRecord, policy: ResourcePolicyConfig): string[] {
  const reasons: string[] = [];
  const sameWorkspace = lease.workspace_id === request.workspace_id;
  if (!request.skip_workspace_pool && sameWorkspace && request.execution_mode === "write" && (lease.pools.includes("workspace_write") || lease.pools.includes("workspace_read"))) {
    reasons.push(`workspace write is waiting for ${lease.execution_mode} lease held by ${lease.task_id}.`);
  }
  if (!request.skip_workspace_pool && sameWorkspace && request.execution_mode === "read" && lease.pools.includes("workspace_write")) {
    reasons.push(`workspace read is waiting for write lease held by ${lease.task_id}.`);
  }
  for (const pool of pools) {
    if (!lease.pools.includes(pool)) continue;
    if (sameWorkspacePool(pool) && lease.workspace_id !== request.workspace_id) continue;
    const limit = policy.limits[pool];
    if (limit <= 1) reasons.push(`${pool} is occupied by ${lease.task_id}`);
  }
  return reasons;
}

function priorityBefore(left: ResourceQueueEntry, right: ResourceQueueEntry): number {
  const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (rank !== 0) return rank;
  return Date.parse(left.queued_at) - Date.parse(right.queued_at);
}

function aheadQueueBlockers(
  request: ResourceRequest,
  pools: ResourcePoolName[],
  state: ResourceGovernorState,
  policy: ResourcePolicyConfig
): string[] {
  const exclusivePools = pools.filter((pool) => policy.limits[pool] <= 1);
  if (!exclusivePools.length) return [];
  const current = state.queue.find((entry) => matchRequest(entry, request));
  const comparable = state.queue
    .filter((entry) => !matchRequest(entry, request))
    .filter((entry) => entry.pools.some((pool) => exclusivePools.includes(pool)))
    .filter((entry) => {
      if (!entry.pools.some((pool) => sameWorkspacePool(pool) && exclusivePools.includes(pool))) return true;
      return entry.workspace_id === request.workspace_id || entry.pools.some((pool) => !sameWorkspacePool(pool) && exclusivePools.includes(pool));
    });
  if (!current) {
    const requested: ResourceQueueEntry = {
      schema_version: 1,
      queue_id: "candidate",
      request_id: request.request_id,
      ...(request.run_id ? { run_id: request.run_id } : {}),
      task_id: request.task_id,
      task_title: request.task_title,
      workspace_id: request.workspace_id,
      workspace_root: realpathOrResolve(request.workspace_root),
      ...(request.project_id ? { project_id: request.project_id } : {}),
      ...(request.workspace_generation ? { workspace_generation: request.workspace_generation } : {}),
      ...(request.objective_id ? { objective_id: request.objective_id } : {}),
      ...(request.attempt_id ? { attempt_id: request.attempt_id } : {}),
      ...(request.actor_id ? { actor_id: request.actor_id } : {}),
      category: request.category,
      priority: normalizePriority(request.priority),
      execution_mode: request.execution_mode,
      pools,
      owner_id: request.owner_id ?? stableOwnerIdForRequest(request),
      ...(request.owner_token ? { owner_token: request.owner_token } : {}),
      ...(request.fencing_token !== undefined ? { fencing_token: request.fencing_token } : {}),
      owner_pid: request.owner_pid ?? request.managed_pid ?? null,
      managed_pid: request.managed_pid ?? null,
      owner_heartbeat_at: nowIso(),
      queued_at: nowIso(),
      queue_deadline: request.queue_deadline ?? null,
      resource_wait_timeout_ms: request.resource_wait_timeout_ms ?? null,
      heartbeat_at: nowIso(),
      blocking_reasons: [],
      resource_snapshot: collectResourceSnapshot(state),
      reason: request.reason ?? null
    };
    comparable.push(requested);
    comparable.sort(priorityBefore);
    const index = comparable.findIndex((entry) => matchRequest(entry, request));
    return index > 0 ? [`Higher-priority or earlier queued resource request ${comparable[0].task_id} is ahead.`] : [];
  }
  const sorted = [...comparable, current].sort(priorityBefore);
  const index = sorted.findIndex((entry) => matchRequest(entry, request));
  if (index <= 0) return [];
  const ahead = sorted.slice(0, index).find((entry) => entry.pools.some((pool) => exclusivePools.includes(pool)));
  return ahead ? [`Queued resource request ${ahead.task_id} is ahead for ${ahead.pools.filter((pool) => exclusivePools.includes(pool)).join(", ")}.`] : [];
}

function resourceThresholdBlockers(request: ResourceRequest, snapshot: ResourceSnapshot, policy: ResourcePolicyConfig): string[] {
  if (request.category !== "heavy") return [];
  const blockers: string[] = [];
  const cpuLimit = policy.thresholds.heavy_cpu_load_per_core_max;
  if (cpuLimit !== null) {
    if (snapshot.cpu.load_per_core === null) blockers.push("CPU load evidence is unknown; new Heavy work cannot start.");
    else if (snapshot.cpu.load_per_core > cpuLimit) blockers.push(`CPU load per core ${snapshot.cpu.load_per_core} exceeds Heavy threshold ${cpuLimit}.`);
  }
  const memLimit = policy.thresholds.heavy_available_memory_mb_min;
  if (memLimit !== null) {
    if (snapshot.memory.available_mb === null) blockers.push("Available memory evidence is unknown; new Heavy work cannot start.");
    else if (snapshot.memory.available_mb < memLimit) blockers.push(`Available memory ${snapshot.memory.available_mb} MB is below Heavy threshold ${memLimit} MB.`);
  }
  const rssLimit = policy.thresholds.codexpro_child_rss_mb_max;
  if (rssLimit !== null) {
    if (snapshot.codexpro_process.child_rss_mb === null) blockers.push("CodexPro child RSS evidence is unknown; new Heavy work cannot start.");
    else if (snapshot.codexpro_process.child_rss_mb > rssLimit) blockers.push(`CodexPro child RSS ${snapshot.codexpro_process.child_rss_mb} MB exceeds threshold ${rssLimit} MB.`);
  }
  return blockers;
}

function poolCapacityBlockers(request: ResourceRequest, pools: ResourcePoolName[], state: ResourceGovernorState, policy: ResourcePolicyConfig): string[] {
  const blockers: string[] = [];
  const sameWorkspaceLeases = state.leases.filter((lease) => lease.workspace_id === request.workspace_id);
  if (!request.skip_workspace_pool && request.execution_mode === "write") {
    const activeWorkspace = sameWorkspaceLeases.filter((lease) => lease.pools.includes("workspace_write") || lease.pools.includes("workspace_read"));
    if (activeWorkspace.length > 0) {
      blockers.push(`workspace read/write occupancy ${activeWorkspace.length}/1 blocks ${request.task_id}.`);
    }
  }
  if (!request.skip_workspace_pool && request.execution_mode === "read") {
    const activeWriters = sameWorkspaceLeases.filter((lease) => lease.pools.includes("workspace_write"));
    if (activeWriters.length > 0) {
      blockers.push(`workspace writer occupancy ${activeWriters.length}/1 blocks ${request.task_id}.`);
    }
  }
  for (const pool of pools) {
    const relevant = state.leases.filter((lease) => lease.pools.includes(pool) && (!sameWorkspacePool(pool) || lease.workspace_id === request.workspace_id));
    const limit = policy.limits[pool];
    if (relevant.length >= limit) blockers.push(`${pool} occupancy ${relevant.length}/${limit} blocks ${request.task_id}.`);
  }
  return blockers;
}

function normalizeRequest(request: ResourceRequest): ResourceRequest {
  const runId = request.run_id?.trim() || stableRunIdForRequest(request);
  return {
    ...request,
    run_id: runId,
    workspace_root: realpathOrResolve(request.workspace_root),
    priority: normalizePriority(request.priority),
    owner_id: request.owner_id?.trim() || stableOwnerIdForRequest({ ...request, run_id: runId }),
    owner_token: request.owner_token?.trim() || undefined,
    fencing_token: optionalFencingToken(request.fencing_token),
    owner_pid: request.owner_pid ?? request.managed_pid ?? undefined,
    managed_pid: request.managed_pid ?? null,
    ttl_ms: Math.max(10_000, Math.min(request.ttl_ms ?? DEFAULT_LEASE_TTL_MS, 60 * 60_000)),
    resource_wait_timeout_ms: request.resource_wait_timeout_ms === undefined
      ? undefined
      : normalizeResourceWaitTimeoutMs(request.resource_wait_timeout_ms),
    queue_deadline: optionalIsoField(request.queue_deadline) ?? undefined
  };
}

function matchRequest(
  record: { request_id: string; run_id?: string; owner_token?: string; fencing_token?: number; owner_id?: string },
  request: ResourceRequest
): boolean {
  if (record.request_id !== request.request_id) return false;
  if (!record.run_id || !request.run_id) {
    if (record.owner_token || request.owner_token) return record.owner_token === request.owner_token;
    if (record.fencing_token !== undefined || request.fencing_token !== undefined) return record.fencing_token === request.fencing_token;
    return true;
  }
  if (record.run_id !== request.run_id) return false;
  if (record.owner_token || request.owner_token) return record.owner_token === request.owner_token;
  if (record.fencing_token !== undefined || request.fencing_token !== undefined) return record.fencing_token === request.fencing_token;
  return true;
}

function sameLeaseIdentity(candidate: ResourceLeaseRecord, lease: ResourceLeaseRecord): boolean {
  if (candidate.lease_id !== lease.lease_id) return false;
  if ((candidate.run_id ?? null) !== (lease.run_id ?? null)) return false;
  if (candidate.owner_token || lease.owner_token) return candidate.owner_token === lease.owner_token && candidate.fencing_token === lease.fencing_token;
  if (candidate.fencing_token !== undefined || lease.fencing_token !== undefined) return candidate.fencing_token === lease.fencing_token;
  return candidate.owner_id === lease.owner_id;
}

export async function runWithinResourceLease<T>(
  lease: ResourceLeaseRecord | undefined | null,
  fn: () => Promise<T>
): Promise<T> {
  if (!lease) return await fn();
  const parent = resourceAdmissionContext.getStore();
  const sameWorkspace = parent?.workspace_id === lease.workspace_id;
  const workspaceMode = sameWorkspace && parent
    ? parent.workspace_mode === "write" || lease.execution_mode === "read" ? parent.workspace_mode : lease.execution_mode
    : lease.execution_mode;
  const pools = [...new Set([...(sameWorkspace && parent ? parent.pools : []), ...lease.pools])];
  return await resourceAdmissionContext.run({
    workspace_id: lease.workspace_id,
    workspace_mode: workspaceMode,
    pools,
    primary_lease: sameWorkspace && parent ? parent.primary_lease : lease
  }, fn);
}

export class ResourceGovernor {
  readonly statePath: string;

  constructor(
    private readonly config: CodexProConfig,
    private readonly options: {
      statePath?: string;
      snapshotProvider?: (state: ResourceGovernorState) => ResourceSnapshot;
    } = {}
  ) {
    this.statePath = options.statePath ?? statePathFor(config);
  }

  policy(workspaceRoot = this.config.defaultRoot): ResourcePolicyConfig {
    return resolveResourcePolicy(this.config, workspaceRoot);
  }

  async acquire(requestInput: ResourceRequest, options: { queue?: boolean } = {}): Promise<ResourceAcquireDecision> {
    const request = normalizeRequest(requestInput);
    return await this.withStateLock(async () => {
      let state = await this.reconciledStateUnlocked();
      const policy = this.policy(request.workspace_root);
      const pools = defaultPools(request);
      const existingLease = state.leases.find((lease) => matchRequest(lease, request));
      const snapshot = this.snapshot(state);
      if (existingLease) {
        existingLease.heartbeat_at = nowIso();
        existingLease.owner_heartbeat_at = existingLease.heartbeat_at;
        existingLease.expires_at = addMs(existingLease.ttl_ms);
        state = {
          ...state,
          updated_at: nowIso(),
          queue: state.queue.filter((entry) => !matchRequest(entry, request))
        };
        await this.writeState(state);
        return {
          status: "admitted",
          lease: existingLease,
          blocking_reasons: [],
          snapshot,
          occupancy: occupancyFor(state, policy)
        };
      }
      const existingQueue = state.queue.find((entry) => matchRequest(entry, request));

      const leaseBlockers = state.leases.flatMap((lease) => requestConflictsWithLease(request, pools, lease, policy));
      const blockers = [
        ...new Set([
          ...leaseBlockers,
          ...poolCapacityBlockers(request, pools, state, policy),
          ...resourceThresholdBlockers(request, snapshot, policy),
          ...aheadQueueBlockers(request, pools, state, policy)
        ])
      ];
      if (blockers.length) {
        const queue = this.queueEntryFor(request, pools, blockers, snapshot, state);
        if (options.queue) {
          const waitStarted = !existingQueue;
          state = {
            ...state,
            updated_at: nowIso(),
            queue: [...state.queue.filter((entry) => !matchRequest(entry, request)), queue]
          };
          await this.writeState(state);
          if (waitStarted) void emitResourceEvent("resource_wait_started", queue);
          return {
            status: "queued_by_resource_policy",
            queue,
            blocking_reasons: blockers,
            snapshot,
            occupancy: occupancyFor(state, policy)
          };
        }
        return {
          status: "blocked_by_resource_policy",
          blocking_reasons: blockers,
          snapshot,
          occupancy: occupancyFor(state, policy)
        };
      }

      const lease = this.leaseFor(request, pools, existingQueue?.queued_at);
      state = {
        ...state,
        updated_at: nowIso(),
        leases: [...state.leases, lease],
        queue: state.queue.filter((entry) => !matchRequest(entry, request))
      };
      await this.writeState(state);
      void emitResourceEvent("resource_granted", lease);
      return {
        status: "admitted",
        lease,
        blocking_reasons: [],
        snapshot,
        occupancy: occupancyFor(state, policy)
      };
    });
  }

  async waitForGrant(
    request: ResourceRequest,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      queueDeadline?: string | number | Date;
      onQueued?: (decision: Extract<ResourceAcquireDecision, { status: "queued_by_resource_policy" }>) => Promise<void> | void;
    } = {}
  ): Promise<Extract<ResourceAcquireDecision, { status: "admitted" }>> {
    const started = Date.now();
    const timeoutMs = normalizeResourceWaitTimeoutMs(
      options.timeoutMs ?? request.resource_wait_timeout_ms ?? this.policy(request.workspace_root).resource_wait_timeout_ms,
      resourceWaitTimeoutMsForConfig(this.config)
    );
    const requestedDeadline = options.queueDeadline instanceof Date
      ? options.queueDeadline.getTime()
      : typeof options.queueDeadline === "number"
        ? options.queueDeadline
        : parsedTime(options.queueDeadline ?? request.queue_deadline);
    const deadlineMs = Number.isFinite(requestedDeadline) && requestedDeadline !== null
      ? Math.min(Number(requestedDeadline), started + timeoutMs)
      : started + timeoutMs;
    const queueDeadline = new Date(deadlineMs).toISOString();
    const effectiveRequest = normalizeRequest({
      ...request,
      resource_wait_timeout_ms: timeoutMs,
      queue_deadline: queueDeadline,
      owner_id: request.owner_id?.trim() || stableOwnerIdForRequest({ ...request, run_id: request.run_id?.trim() || stableRunIdForRequest(request) })
    });
    let lastQueued: Extract<ResourceAcquireDecision, { status: "queued_by_resource_policy" }> | undefined;
    while (Date.now() <= deadlineMs) {
      if (options.signal?.aborted) {
        await this.removeQueuedRequest(effectiveRequest);
        const error = new Error("Resource admission cancelled.");
        error.name = "AbortError";
        throw error;
      }
      const decision = await this.acquire(effectiveRequest, { queue: true });
      if (decision.status === "admitted") return decision;
      if (decision.status === "queued_by_resource_policy") {
        lastQueued = decision;
        try {
          await options.onQueued?.(decision);
        } catch (error) {
          await this.removeQueuedRequest(effectiveRequest);
          throw error;
        }
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      if (await waitForResourcePoll(Math.min(WAIT_POLL_MS, remainingMs), options.signal)) {
        await this.removeQueuedRequest(effectiveRequest);
        const error = new Error("Resource admission cancelled.");
        error.name = "AbortError";
        throw error;
      }
    }
    await this.removeQueuedRequest(effectiveRequest);
    const waitedMs = Math.max(0, Date.now() - started);
    throw new ResourceWaitTimeoutError(
      `${RESOURCE_WAIT_TIMEOUT_CODE}: resource admission timed out after ${waitedMs} ms for ${effectiveRequest.task_id}.`,
      {
        request_id: effectiveRequest.request_id,
        ...(effectiveRequest.run_id ? { run_id: effectiveRequest.run_id } : {}),
        task_id: effectiveRequest.task_id,
        ...(lastQueued?.queue.queue_id ? { queue_id: lastQueued.queue.queue_id } : {}),
        queue_deadline: queueDeadline,
        waited_ms: waitedMs,
        blocking_reasons: lastQueued?.blocking_reasons ?? []
      }
    );
  }

  async release(lease: ResourceLeaseRecord | undefined | null): Promise<void> {
    if (!lease) return;
    await this.withStateLock(async () => {
      const state = await this.readState();
      const existing = state.leases.find((candidate) => sameLeaseIdentity(candidate, lease));
      if (!existing) return;
      const next = {
        ...state,
        updated_at: nowIso(),
        leases: state.leases.filter((candidate) => !sameLeaseIdentity(candidate, lease))
      };
      await this.writeState(next);
      void emitResourceEvent("resource_released", existing);
    });
  }

  async releaseTaskResources(
    taskId: string,
    workspaceRoot?: string
  ): Promise<{ leases_released: number; queued_removed: number }> {
    const normalizedRoot = workspaceRoot ? realpathOrResolve(workspaceRoot) : undefined;
    const released: ResourceLeaseRecord[] = [];
    const result = await this.withStateLock(async () => {
      const state = await this.readState();
      const matches = (record: Pick<ResourceLeaseRecord | ResourceQueueEntry, "task_id" | "workspace_root">): boolean =>
        record.task_id === taskId
        && (!normalizedRoot || realpathOrResolve(record.workspace_root) === normalizedRoot);
      const leases = state.leases.filter((lease) => {
        if (!matches(lease)) return true;
        released.push(lease);
        return false;
      });
      const queue = state.queue.filter((entry) => !matches(entry));
      const leasesReleased = state.leases.length - leases.length;
      const queuedRemoved = state.queue.length - queue.length;
      if (leasesReleased === 0 && queuedRemoved === 0) {
        return { leases_released: 0, queued_removed: 0 };
      }
      await this.writeState({ ...state, updated_at: nowIso(), leases, queue });
      return { leases_released: leasesReleased, queued_removed: queuedRemoved };
    });
    for (const lease of released) void emitResourceEvent("resource_released", lease);
    return result;
  }

  private async removeQueuedRequest(request: ResourceRequest): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.readState();
      const queue = state.queue.filter((entry) => !matchRequest(entry, request));
      if (queue.length === state.queue.length) return;
      await this.writeState({ ...state, updated_at: nowIso(), queue });
    });
  }

  async cancelQueuedRun(runId: string, workspaceRoot?: string): Promise<number> {
    const normalizedRoot = workspaceRoot ? realpathOrResolve(workspaceRoot) : undefined;
    return await this.withStateLock(async () => {
      const state = await this.readState();
      const removed = state.queue.filter((entry) =>
        entry.run_id === runId && (!normalizedRoot || realpathOrResolve(entry.workspace_root) === normalizedRoot)
      );
      if (!removed.length) return 0;
      const removedIds = new Set(removed.map((entry) => entry.queue_id));
      await this.writeState({
        ...state,
        updated_at: nowIso(),
        queue: state.queue.filter((entry) => !removedIds.has(entry.queue_id))
      });
      return removed.length;
    });
  }

  async heartbeat(lease: ResourceLeaseRecord | undefined | null): Promise<ResourceLeaseRecord | undefined> {
    if (!lease) return undefined;
    return await this.withStateLock(async () => {
      const state = await this.reconciledStateUnlocked();
      const found = state.leases.find((candidate) => sameLeaseIdentity(candidate, lease));
      if (!found) return undefined;
      found.heartbeat_at = nowIso();
      found.owner_heartbeat_at = found.heartbeat_at;
      found.expires_at = addMs(found.ttl_ms);
      await this.writeState({ ...state, updated_at: nowIso() });
      return found;
    });
  }

  async status(options: { readOnly?: boolean } = {}): Promise<ResourceGovernorStatus> {
    if (options.readOnly) {
      return this.statusFromState(
        this.reconciledStateForRead(await this.readState()),
        READ_ONLY_HOST_SNAPSHOT_MAX_AGE_MS
      );
    }
    return await this.withStateLock(async () => {
      const state = await this.reconciledStateUnlocked();
      return this.statusFromState(state);
    });
  }

  async projectionFor(taskId: string): Promise<ResourceProjection | undefined> {
    const status = await this.status();
    return this.projectionFromStatus(taskId, status);
  }

  async isLeaseActive(lease: ResourceLeaseRecord): Promise<boolean> {
    const status = await this.status({ readOnly: true });
    return status.leases.some((candidate) => sameLeaseIdentity(candidate, lease));
  }

  projectionFromStatus(taskId: string, status: ResourceGovernorStatus): ResourceProjection | undefined {
    const lease = status.leases.find((candidate) => candidate.task_id === taskId || candidate.request_id === taskId);
    if (lease) {
      return {
        run_id: lease.run_id ?? null,
        resource_class: lease.category,
        priority: lease.priority,
        execution_mode: lease.execution_mode,
        status: "admitted",
        pools: lease.pools,
        blocking_reasons: [],
        queue_id: null,
        queue_position: null,
        lease_id: lease.lease_id,
        queue_duration_ms: lease.queue_duration_ms ?? durationSince(lease.queued_at ?? null, lease.acquired_at),
        policy_source: "resource_governor",
        occupancy: status.occupancy,
        snapshot: status.snapshot,
        updated_at: lease.heartbeat_at
      };
    }
    const queue = [...status.queue].sort(priorityBefore);
    const entryIndex = queue.findIndex((candidate) => candidate.task_id === taskId || candidate.request_id === taskId);
    const entry = entryIndex >= 0 ? queue[entryIndex] : undefined;
    if (!entry) return undefined;
    return {
      run_id: entry.run_id ?? null,
      resource_class: entry.category,
      priority: entry.priority,
      execution_mode: entry.execution_mode,
      status: "queued_by_resource_policy",
      pools: entry.pools,
      blocking_reasons: entry.blocking_reasons,
      queue_id: entry.queue_id,
      queue_position: entryIndex + 1,
      lease_id: null,
      queue_duration_ms: durationSince(entry.queued_at),
      policy_source: "resource_governor",
      occupancy: status.occupancy,
      snapshot: entry.resource_snapshot,
      updated_at: entry.heartbeat_at
    };
  }

  async runWithLease<T>(
    request: ResourceRequest,
    fn: (lease: ResourceLeaseRecord) => Promise<T>,
    options: { signal?: AbortSignal; onQueued?: (decision: Extract<ResourceAcquireDecision, { status: "queued_by_resource_policy" }>) => Promise<void> | void } = {}
  ): Promise<T> {
    const normalized = normalizeRequest(request);
    const parent = resourceAdmissionContext.getStore();
    let effectiveRequest = normalized;
    if (parent?.workspace_id === normalized.workspace_id) {
      if (!await this.isLeaseActive(parent.primary_lease)) throw new ResourceParentLeaseLostError(parent.primary_lease);
      if (normalized.execution_mode === "write" && parent.workspace_mode !== "write") {
        throw new Error("A nested workspace write cannot run under a read-only resource lease.");
      }
      const requestedPools = defaultPools(normalized);
      const workspaceCovered = parent.workspace_mode === "write" || normalized.execution_mode === "read";
      const missingPools = requestedPools.filter((pool) => {
        if (sameWorkspacePool(pool)) return !workspaceCovered;
        return !parent.pools.includes(pool);
      });
      if (!missingPools.length) return await fn(parent.primary_lease);
      effectiveRequest = {
        ...normalized,
        category: missingPools.includes("global_heavy")
          ? "heavy"
          : missingPools.includes("global_standard")
            ? "standard"
            : "lightweight",
        pools: missingPools.filter((pool) => pool !== "global_heavy" && pool !== "global_standard"),
        skip_workspace_pool: workspaceCovered
      };
    }

    const decision = await this.waitForGrant(effectiveRequest, options);
    let lease: ResourceLeaseRecord | undefined = decision.lease;
    let heartbeatQueue: Promise<void> = Promise.resolve();
    let heartbeatEnabled = true;
    const intervalMs = Math.max(1_000, Math.min(Math.floor(decision.lease.ttl_ms / 2), 30_000));
    const timer = setInterval(() => {
      if (!heartbeatEnabled || options.signal?.aborted) return;
      heartbeatQueue = heartbeatQueue
        .then(async () => {
          if (!heartbeatEnabled || options.signal?.aborted) return;
          lease = await this.heartbeat(lease) ?? lease;
        })
        .catch(() => undefined);
    }, intervalMs);
    timer.unref();

    let abortListener: (() => void) | undefined;
    const abortPromise = options.signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => {
            heartbeatEnabled = false;
            clearInterval(timer);
            const reason = options.signal?.reason;
            if (reason instanceof Error) reject(reason);
            else {
              const error = new Error("Resource lease execution cancelled.");
              error.name = "AbortError";
              reject(error);
            }
          };
          if (options.signal?.aborted) abortListener();
          else options.signal?.addEventListener("abort", abortListener, { once: true });
        })
      : undefined;

    const execution = runWithinResourceLease(decision.lease, async () => await fn(decision.lease));
    try {
      return await (abortPromise ? Promise.race([execution, abortPromise]) : execution);
    } finally {
      heartbeatEnabled = false;
      clearInterval(timer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      if (options.signal?.aborted) void execution.catch(() => undefined);
      await heartbeatQueue;
      await this.release(lease ?? decision.lease);
    }
  }

  private snapshot(state: ResourceGovernorState): ResourceSnapshot {
    return this.options.snapshotProvider?.(state) ?? collectResourceSnapshot(state);
  }

  private async readState(): Promise<ResourceGovernorState> {
    return safeState(await readJsonFile(this.statePath));
  }

  private async writeState(state: ResourceGovernorState): Promise<void> {
    await writeJsonFileAtomic(this.statePath, {
      ...state,
      schema_version: STATE_SCHEMA_VERSION,
      updated_at: nowIso(),
      leases: state.leases,
      queue: state.queue
    });
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockDir = `${this.statePath}.lock`;
    const ownerPath = path.join(lockDir, "owner.json");
    const started = Date.now();
    let acquired = false;
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    while (!acquired) {
      try {
        await fsp.mkdir(lockDir, { recursive: false, mode: 0o700 });
        await fsp.writeFile(ownerPath, JSON.stringify({ pid: process.pid, acquired_at: nowIso() }), { encoding: "utf8", mode: 0o600 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = objectValue(await readJsonFile(ownerPath).catch(() => undefined));
        const ownerPid = typeof owner?.pid === "number" ? owner.pid : null;
        const acquiredAt = typeof owner?.acquired_at === "string" ? Date.parse(owner.acquired_at) : Number.NaN;
        const lockStat = await fsp.stat(lockDir).catch(() => undefined);
        const lockAgeMs = lockStat ? Math.max(0, Date.now() - lockStat.mtimeMs) : 0;
        const ownerTimestampValid = Number.isFinite(acquiredAt) && acquiredAt > 0;
        const stale = ownerTimestampValid
          ? Date.now() - acquiredAt > LOCK_STALE_MS
          : lockAgeMs > LOCK_STALE_MS;
        if (stale && processAlive(ownerPid) !== true) {
          await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for ResourceGovernor state lock: ${lockDir}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async reconciledStateUnlocked(): Promise<ResourceGovernorState> {
    const state = await this.readState();
    const reconciled = this.reconciledStateForRead(state);
    if (reconciled !== state) await this.writeState(reconciled);
    return reconciled;
  }

  private reconciledStateForRead(state: ResourceGovernorState): ResourceGovernorState {
    const now = Date.now();
    const leases = state.leases.filter((lease) => {
      const managedAlive = processAlive(lease.managed_pid);
      const ownerAlive = processAlive(lease.owner_pid);
      const ownerIsCurrentServer = lease.owner_pid === process.pid;
      const expired = (parsedTime(lease.expires_at) ?? 0) <= now;
      if (managedAlive === true) return true;
      if (ownerAlive === true && !ownerIsCurrentServer) return true;
      if (!expired) return true;
      return false;
    });
    const queue = state.queue.filter((entry) => {
      const deadline = parsedTime(entry.queue_deadline);
      const timeoutMs = normalizeResourceWaitTimeoutMs(entry.resource_wait_timeout_ms, resourceWaitTimeoutMsForConfig(this.config));
      const heartbeat = parsedTime(entry.heartbeat_at) ?? 0;
      const stale = (deadline !== null && deadline <= now) || heartbeat + timeoutMs <= now;
      return !stale;
    });
    if (leases.length !== state.leases.length || queue.length !== state.queue.length) {
      return { ...state, leases, queue, updated_at: nowIso() };
    }
    return state;
  }

  private statusFromState(state: ResourceGovernorState, hostSnapshotMaxAgeMs = 0): ResourceGovernorStatus {
    const policy = this.policy();
    return {
      schema_version: 1,
      state_path: this.statePath,
      generated_at: nowIso(),
      config: policy,
      snapshot: hostSnapshotMaxAgeMs > 0 && !this.options.snapshotProvider
        ? collectResourceSnapshot(state, { host_max_age_ms: hostSnapshotMaxAgeMs })
        : this.snapshot(state),
      occupancy: occupancyFor(state, policy),
      leases: state.leases,
      queue: [...state.queue].sort(priorityBefore)
    };
  }

  private queueEntryFor(request: ResourceRequest, pools: ResourcePoolName[], blockers: string[], snapshot: ResourceSnapshot, state: ResourceGovernorState): ResourceQueueEntry {
    const existing = state.queue.find((entry) => matchRequest(entry, request));
    const heartbeatAt = nowIso();
    const ownerToken = request.owner_token ?? existing?.owner_token;
    const fencingToken = request.fencing_token ?? existing?.fencing_token;
    return {
      schema_version: 1,
      queue_id: existing?.queue_id ?? `rq_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      request_id: request.request_id,
      ...(request.run_id ? { run_id: request.run_id } : {}),
      task_id: request.task_id,
      task_title: request.task_title,
      workspace_id: request.workspace_id,
      workspace_root: request.workspace_root,
      ...(request.project_id ? { project_id: request.project_id } : {}),
      ...(request.workspace_generation ? { workspace_generation: request.workspace_generation } : {}),
      ...(request.objective_id ? { objective_id: request.objective_id } : {}),
      ...(request.attempt_id ? { attempt_id: request.attempt_id } : {}),
      ...(request.actor_id ? { actor_id: request.actor_id } : {}),
      category: request.category,
      priority: normalizePriority(request.priority),
      execution_mode: request.execution_mode,
      pools,
      owner_id: existing?.owner_id ?? request.owner_id ?? stableOwnerIdForRequest(request),
      ...(ownerToken ? { owner_token: ownerToken } : {}),
      ...(fencingToken !== undefined ? { fencing_token: fencingToken } : {}),
      owner_pid: request.owner_pid ?? request.managed_pid ?? existing?.owner_pid ?? null,
      managed_pid: request.managed_pid ?? existing?.managed_pid ?? null,
      owner_heartbeat_at: heartbeatAt,
      queued_at: existing?.queued_at ?? nowIso(),
      queue_deadline: request.queue_deadline ?? existing?.queue_deadline ?? null,
      resource_wait_timeout_ms: request.resource_wait_timeout_ms ?? existing?.resource_wait_timeout_ms ?? null,
      heartbeat_at: heartbeatAt,
      blocking_reasons: blockers,
      resource_snapshot: snapshot,
      reason: request.reason ?? null
    };
  }

  private leaseFor(request: ResourceRequest, pools: ResourcePoolName[], queuedAt?: string): ResourceLeaseRecord {
    const ttlMs = request.ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    const now = nowIso();
    return {
      schema_version: 1,
      lease_id: `rl_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      request_id: request.request_id,
      ...(request.run_id ? { run_id: request.run_id } : {}),
      task_id: request.task_id,
      task_title: request.task_title,
      workspace_id: request.workspace_id,
      workspace_root: request.workspace_root,
      ...(request.project_id ? { project_id: request.project_id } : {}),
      ...(request.workspace_generation ? { workspace_generation: request.workspace_generation } : {}),
      ...(request.objective_id ? { objective_id: request.objective_id } : {}),
      ...(request.attempt_id ? { attempt_id: request.attempt_id } : {}),
      ...(request.actor_id ? { actor_id: request.actor_id } : {}),
      category: request.category,
      priority: normalizePriority(request.priority),
      execution_mode: request.execution_mode,
      pools,
      owner_id: request.owner_id ?? stableOwnerIdForRequest(request),
      ...(request.owner_token ? { owner_token: request.owner_token } : {}),
      ...(request.fencing_token !== undefined ? { fencing_token: request.fencing_token } : {}),
      owner_pid: request.owner_pid ?? request.managed_pid ?? null,
      managed_pid: request.managed_pid ?? null,
      owner_heartbeat_at: now,
      created_at: now,
      ...(queuedAt ? { queued_at: queuedAt, queue_duration_ms: durationSince(queuedAt, now) } : {}),
      queue_deadline: request.queue_deadline ?? null,
      resource_wait_timeout_ms: request.resource_wait_timeout_ms ?? null,
      acquired_at: now,
      heartbeat_at: now,
      expires_at: addMs(ttlMs),
      ttl_ms: ttlMs,
      reason: request.reason ?? null
    };
  }
}

export function resourceWaitReason(decision: Extract<ResourceAcquireDecision, { status: "queued_by_resource_policy" | "blocked_by_resource_policy" }>): string {
  return `queued_by_resource_policy: ${decision.blocking_reasons.join(" | ")}`;
}

export function classifyCommandsForResources(commands: string[] = []): Pick<ResourceRequest, "category" | "pools"> {
  const text = commands.join("\n").toLowerCase();
  const pools: ResourcePoolName[] = [];
  const unscopedTest = /(?:^|\n)\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\s*$/m.test(text)
    || /(?:^|\n)\s*(?:pytest|python(?:3)?\s+-m\s+pytest|uv\s+run\s+pytest|cargo\s+test|go\s+test\s+\.\/\.\.\.)\s*$/m.test(text);
  const multipleTestFiles = (text.match(/\.(?:test|spec)\.[a-z0-9]+/g) ?? []).length > 1;
  const heavy = unscopedTest || multipleTestFiles || /\b(?:playwright|chrome|browser|cdp|docker\s+(?:build|compose\s+build)|npm\s+(?:run\s+)?(?:smoke|build)|pnpm\s+(?:run\s+)?(?:smoke|build)|yarn\s+(?:smoke|build)|full\s+(?:smoke|acceptance)|acceptance-full-test|database|db\s+(?:migrate|maintenance)|install|npm\s+install|pnpm\s+install)\b/.test(text);
  if (/\b(?:playwright|chrome|browser|cdp)\b/.test(text)) pools.push("browser_live_verification");
  if (/\bdocker\s+(?:build|compose\s+build)\b/.test(text)) pools.push("docker_rebuild");
  if (/\b(?:full\s+(?:smoke|acceptance)|acceptance-full-test|npm\s+run\s+smoke)\b/.test(text)) pools.push("full_acceptance");
  if (/\b(?:database|db)\s+(?:migrate|maintenance|vacuum|reindex)\b/.test(text)) pools.push("database_maintenance");
  return {
    category: heavy ? "heavy" : "standard",
    pools
  };
}

export function requestForWorkspaceTask(
  workspace: Workspace,
  input: {
    requestId: string;
    runId?: string;
    ownerToken?: string;
    fencingToken?: number;
    taskId: string;
    title: string;
    commands?: string[];
    hasWrites?: boolean;
    priority?: ResourcePriority;
    category?: ResourceCategory;
    pools?: ResourcePoolName[];
    reason?: string;
    objectiveId?: string;
    attemptId?: string;
    actorId?: string;
  }
): ResourceRequest {
  const commandClassification = classifyCommandsForResources(input.commands ?? []);
  const category = input.category ?? (input.hasWrites || (input.commands?.length ?? 0) ? commandClassification.category : "lightweight");
  const pools = [...new Set([...(commandClassification.pools ?? []), ...(input.pools ?? [])])];
  return {
    request_id: input.requestId,
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.ownerToken ? { owner_token: input.ownerToken } : {}),
    ...(input.fencingToken !== undefined ? { fencing_token: input.fencingToken } : {}),
    task_id: input.taskId,
    task_title: input.title,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    project_id: workspace.projectId ?? (path.basename(workspace.root) || "project"),
    workspace_generation: Math.max(1, Math.floor(workspace.workspaceGeneration ?? 1)),
    objective_id: input.objectiveId ?? input.taskId,
    attempt_id: input.attemptId ?? input.taskId,
    actor_id: input.actorId ?? `actor:${workspace.conversationId ?? workspace.activatedBySessionId ?? "server-default"}`,
    category,
    priority: input.priority ?? "normal",
    execution_mode: input.hasWrites ? "write" : "read",
    pools,
    owner_pid: process.pid,
    reason: input.reason
  };
}
