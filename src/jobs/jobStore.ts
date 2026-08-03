import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import {
  ensureOfficeProjectionIndex,
  readOfficeProjectionIndex,
  replaceOfficeProjectionIndex,
  upsertOfficeProjectionIndex,
  type OfficeProjectionIndexLoadResult
} from "../tasks/officeProjectionIndex.js";
import type { DurableJobRecord, DurableJobStep } from "./jobSteps.js";

const SAFE_RUN_ID = /^[a-z0-9._-]{1,80}$/;
const SAFE_STEP_ID = /^[a-z0-9._-]{1,80}$/;
const OWNER_LOCK_STALE_MS = 30_000;
const OWNER_LOCK_POLL_MS = 25;
const OWNER_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_JOB_READ_BATCH_SIZE = 32;
const MAX_JOB_READ_BATCH_SIZE = 128;
const MAX_JSON_READ_CACHE_ENTRIES = 2_048;

interface JsonReadCacheEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  value: unknown;
}

const jsonReadCache = new Map<string, JsonReadCacheEntry>();

function sameJsonStat(entry: JsonReadCacheEntry, stat: { mtimeMs: number; ctimeMs: number; size: number }): boolean {
  return entry.mtime_ms === stat.mtimeMs && entry.ctime_ms === stat.ctimeMs && entry.size === stat.size;
}

function cacheJson(filePath: string, stat: { mtimeMs: number; ctimeMs: number; size: number }, value: unknown): void {
  jsonReadCache.delete(filePath);
  jsonReadCache.set(filePath, { mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, size: stat.size, value: clone(value) });
  while (jsonReadCache.size > MAX_JSON_READ_CACHE_ENTRIES) {
    const oldest = jsonReadCache.keys().next().value;
    if (typeof oldest !== "string") break;
    jsonReadCache.delete(oldest);
  }
}

export interface DurableJobOfficeIndexEntry {
  run_id: string;
  title: string;
  workspace_root: string;
  status: DurableJobRecord["status"];
  recoverable: boolean;
  created_at: string;
  updated_at: string;
}

export interface DurableJobOwnership {
  run_id: string;
  owner_token: string;
  fencing_token: number;
  owner_pid: number;
  acquired_at: string;
  previous_owner_token: string | null;
}

export class DurableJobOwnershipError extends Error {
  readonly code = "durable_job_owner_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "DurableJobOwnershipError";
  }
}

export function durableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertRunId(value: string): string {
  if (!SAFE_RUN_ID.test(value)) throw new Error(`Invalid durable job run id: ${value}`);
  return value;
}

function assertStepId(value: string): string {
  if (!SAFE_STEP_ID.test(value)) throw new Error(`Invalid durable job step id: ${value}`);
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function terminal(status: DurableJobRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function durableJobOfficeIndexEntry(job: DurableJobRecord): DurableJobOfficeIndexEntry {
  return {
    run_id: job.run_id,
    title: job.title,
    workspace_root: job.workspace_root,
    status: job.status,
    recoverable: ["recovering", "recovery_required", "stale"].includes(job.status) || Boolean(job.recovery_reason?.trim()),
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

function isDurableJobOfficeIndexEntry(key: string, value: unknown): value is DurableJobOfficeIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<DurableJobOfficeIndexEntry>;
  return candidate.run_id === key
    && SAFE_RUN_ID.test(key)
    && typeof candidate.title === "string"
    && typeof candidate.workspace_root === "string"
    && ["queued", "running", "recovering", "completed", "failed", "blocked", "cancelled", "recovery_required", "stale"].includes(candidate.status ?? "")
    && typeof candidate.recoverable === "boolean"
    && typeof candidate.created_at === "string"
    && Number.isFinite(Date.parse(candidate.created_at))
    && typeof candidate.updated_at === "string"
    && Number.isFinite(Date.parse(candidate.updated_at));
}

export class DurableJobStore {
  constructor(
    readonly guard: PathGuard,
    readonly workspace: Workspace,
    readonly config?: CodexProConfig
  ) {}

  runRoot(runId: string): string {
    return `.codexpro/runs/${assertRunId(runId)}`;
  }

  jobPath(runId: string): string {
    return `${this.runRoot(runId)}/job.json`;
  }

  inputPath(runId: string): string {
    return `${this.runRoot(runId)}/input.json`;
  }

  stepDir(runId: string, stepId: string): string {
    return `${this.runRoot(runId)}/steps/${assertStepId(stepId)}`;
  }

  stepPath(runId: string, stepId: string): string {
    return `${this.stepDir(runId, stepId)}/step.json`;
  }

  stepOutputPath(runId: string, stepId: string): string {
    return `${this.stepDir(runId, stepId)}/output.json`;
  }

  ownerLockPath(runId: string): string {
    return `${this.runRoot(runId)}/owner.lock`;
  }

  ownerFenceLockPath(runId: string): string {
    return `${this.runRoot(runId)}/owner.fence.lock`;
  }

  async acquireOwner(runId: string, ownerToken: string): Promise<boolean> {
    return Boolean(await this.acquireRunOwner(runId, ownerToken));
  }

  async acquireRunOwner(
    runId: string,
    ownerToken: string,
    options: { takeover?: boolean; operation?: string } = {}
  ): Promise<DurableJobOwnership | undefined> {
    return await this.withRunOwnerLock(runId, async () => {
      const job = await this.readJob(runId);
      if (!job) throw new Error(`Durable job not found: ${runId}`);
      const terminalRetry = options.operation === "retry_step" && (job.status === "failed" || job.status === "blocked");
      if (terminal(job.status) && !terminalRetry) return undefined;
      const lock = await this.readJson<Record<string, unknown>>(this.ownerLockPath(runId)).catch(() => undefined);
      const lockOwner = typeof lock?.owner_token === "string" ? lock.owner_token : undefined;
      const lockFence = positiveInteger(lock?.fencing_token);
      const jobOwner = typeof job.owner_token === "string" ? job.owner_token : undefined;
      if (jobOwner && jobOwner !== ownerToken && options.takeover !== true) return undefined;
      if (lockOwner && lockOwner !== ownerToken && options.takeover !== true) return undefined;
      if (lockOwner === ownerToken && lockFence !== undefined) {
        return {
          run_id: runId,
          owner_token: ownerToken,
          fencing_token: lockFence,
          owner_pid: Number(lock?.owner_pid ?? lock?.pid ?? process.pid),
          acquired_at: typeof lock?.acquired_at === "string" ? lock.acquired_at : new Date().toISOString(),
          previous_owner_token: typeof job.previous_owner_token === "string" ? job.previous_owner_token : null
        };
      }
      if (lockOwner && lockFence === undefined && options.takeover !== true) return undefined;

      const now = new Date().toISOString();
      const previousOwner = job.owner_token ?? lockOwner ?? null;
      const fencingToken = Math.max(
        0,
        positiveInteger(job.fencing_token) ?? 0,
        lockFence ?? 0,
        positiveInteger(lock?.generation) ?? 0
      ) + 1;
      const claim: DurableJobOwnership = {
        run_id: runId,
        owner_token: ownerToken,
        fencing_token: fencingToken,
        owner_pid: process.pid,
        acquired_at: now,
        previous_owner_token: previousOwner
      };
      const updated: DurableJobRecord = {
        ...job,
        owner_token: ownerToken,
        fencing_token: fencingToken,
        owner_pid: process.pid,
        owner_acquired_at: now,
        previous_owner_token: previousOwner,
        owner_change_count: Math.max(0, job.owner_change_count ?? 0) + (previousOwner === ownerToken ? 0 : 1),
        updated_at: now
      };
      await this.writeJson(this.ownerLockPath(runId), {
        version: 2,
        run_id: runId,
        owner_token: ownerToken,
        fencing_token: fencingToken,
        owner_pid: process.pid,
        pid: process.pid,
        previous_owner_token: previousOwner,
        acquired_at: now,
        operation: options.operation ?? null
      });
      await this.writeJson(this.jobPath(runId), updated);
      await upsertOfficeProjectionIndex(
        this.guard,
        this.workspace,
        "durable-jobs",
        updated.run_id,
        durableJobOfficeIndexEntry(updated)
      ).catch(() => undefined);
      return claim;
    });
  }

  async releaseOwner(runId: string, ownerToken: string): Promise<void> {
    await this.withRunOwnerLock(runId, async () => {
      const existing = await this.readJson<{ owner_token?: string }>(this.ownerLockPath(runId)).catch(() => undefined);
      if (existing?.owner_token !== ownerToken) return;
      await this.clearReleasedOwner(runId, ownerToken);
      const resolved = this.guard.resolve(this.workspace, this.ownerLockPath(runId), { forWrite: true });
      await fsp.rm(resolved.absPath, { force: true });
    });
  }

  async releaseRunOwner(claim: DurableJobOwnership | undefined): Promise<void> {
    if (!claim) return;
    await this.withRunOwnerLock(claim.run_id, async () => {
      const existing = await this.readJson<Record<string, unknown>>(this.ownerLockPath(claim.run_id)).catch(() => undefined);
      if (!this.sameOwnership(existing, claim)) return;
      await this.clearReleasedOwner(claim.run_id, claim.owner_token, claim.fencing_token);
      const resolved = this.guard.resolve(this.workspace, this.ownerLockPath(claim.run_id), { forWrite: true });
      await fsp.rm(resolved.absPath, { force: true });
    });
  }

  async assertRunOwner(runId: string, claim: DurableJobOwnership): Promise<DurableJobRecord> {
    if (claim.run_id !== runId) throw new DurableJobOwnershipError(`Ownership claim belongs to ${claim.run_id}, not ${runId}.`);
    const current = await this.readJob(runId);
    if (!current) throw new Error(`Durable job not found: ${runId}`);
    if (current.owner_token !== claim.owner_token || Number(current.fencing_token) !== claim.fencing_token) {
      throw new DurableJobOwnershipError(`Durable job ${runId} ownership changed; stale writer refused.`);
    }
    return current;
  }

  async writeJobOwned(job: DurableJobRecord, claim: DurableJobOwnership): Promise<void> {
    await this.assertRunOwner(job.run_id, claim);
    if (job.owner_token !== null && job.owner_token !== claim.owner_token) {
      throw new DurableJobOwnershipError(`Durable job ${job.run_id} cannot be assigned to a different owner by the current writer.`);
    }
    if (job.owner_token === claim.owner_token) {
      job.fencing_token = claim.fencing_token;
      job.owner_pid = claim.owner_pid;
      job.owner_acquired_at = claim.acquired_at;
    }
    await this.writeJob(job);
  }

  async writeStepOwned(
    runId: string,
    step: DurableJobStep,
    claim: DurableJobOwnership,
    options: { takeover?: boolean } = {}
  ): Promise<void> {
    await this.assertRunOwner(runId, claim);
    const currentStep = await this.readStep(runId, step.step_id);
    if (
      options.takeover !== true
      && currentStep?.owner_token
      && currentStep.owner_token === claim.owner_token
      && Number(currentStep.fencing_token) !== claim.fencing_token
    ) {
      throw new DurableJobOwnershipError(`Durable job step ${step.step_id} fencing changed; stale writer refused.`);
    }
    if (
      options.takeover !== true
      && currentStep?.owner_token
      && currentStep.owner_token !== claim.owner_token
    ) {
      throw new DurableJobOwnershipError(`Durable job step ${step.step_id} ownership changed; stale writer refused.`);
    }
    if (step.owner_token === claim.owner_token) step.fencing_token = claim.fencing_token;
    await this.writeStep(runId, step);
  }

  async writeStepOutputOwned(runId: string, stepId: string, output: unknown, claim: DurableJobOwnership): Promise<string> {
    await this.assertRunOwner(runId, claim);
    return await this.writeStepOutput(runId, stepId, output);
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    const resolved = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const temporary = `${resolved.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, resolved.absPath);
    cacheJson(resolved.absPath, await fsp.stat(resolved.absPath), value);
    return relativePath;
  }

  async writeText(relativePath: string, text: string): Promise<string> {
    const resolved = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const temporary = `${resolved.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, text, "utf8");
    await fsp.rename(temporary, resolved.absPath);
    jsonReadCache.delete(resolved.absPath);
    return relativePath;
  }

  async readJson<T>(relativePath: string): Promise<T | undefined> {
    const resolved = this.guard.resolve(this.workspace, relativePath);
    try {
      const before = await fsp.stat(resolved.absPath);
      const cached = jsonReadCache.get(resolved.absPath);
      if (cached && sameJsonStat(cached, before)) {
        jsonReadCache.delete(resolved.absPath);
        jsonReadCache.set(resolved.absPath, cached);
        return clone(cached.value as T);
      }
      const value = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as T;
      const after = await fsp.stat(resolved.absPath);
      if (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size) {
        cacheJson(resolved.absPath, after, value);
      }
      return clone(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        jsonReadCache.delete(resolved.absPath);
        return undefined;
      }
      throw error;
    }
  }

  async readText(relativePath: string): Promise<string | undefined> {
    const resolved = this.guard.resolve(this.workspace, relativePath);
    try {
      return await fsp.readFile(resolved.absPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listJobIds(): Promise<string[]> {
    const resolved = this.guard.resolve(this.workspace, ".codexpro/runs");
    try {
      const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async writeJob(job: DurableJobRecord): Promise<void> {
    const now = new Date().toISOString();
    const statusChanged = job.status_transition_status !== job.status;
    if (statusChanged) {
      job.status_transition_status = job.status;
      job.status_transition_at = now;
    }
    job.updated_at = now;
    await this.writeJson(this.jobPath(job.run_id), job);
    await upsertOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "durable-jobs",
      job.run_id,
      durableJobOfficeIndexEntry(job)
    ).catch(() => undefined);
  }

  async listOfficeIndex(): Promise<DurableJobOfficeIndexEntry[] | null> {
    const indexed = await readOfficeProjectionIndex<DurableJobOfficeIndexEntry>(
      this.guard,
      this.workspace,
      "durable-jobs",
      isDurableJobOfficeIndexEntry
    );
    if (!indexed) return null;
    return [...indexed.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }

  async ensureOfficeIndex(): Promise<OfficeProjectionIndexLoadResult<DurableJobOfficeIndexEntry>> {
    return await ensureOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "durable-jobs",
      async () => {
        const jobs = await this.readJobs(await this.listJobIds());
        return jobs.map((job) => [job.run_id, durableJobOfficeIndexEntry(job)] as const);
      },
      isDurableJobOfficeIndexEntry
    );
  }

  async replaceOfficeIndex(jobs: DurableJobRecord[]): Promise<void> {
    await replaceOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "durable-jobs",
      jobs.map((job) => [job.run_id, durableJobOfficeIndexEntry(job)] as const)
    );
  }

  async readJobs(runIds: string[], options: { batchSize?: number } = {}): Promise<DurableJobRecord[]> {
    const uniqueRunIds = [...new Set(runIds.map(assertRunId))];
    const requestedBatchSize = Number(options.batchSize ?? DEFAULT_JOB_READ_BATCH_SIZE);
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(Math.floor(requestedBatchSize), MAX_JOB_READ_BATCH_SIZE))
      : DEFAULT_JOB_READ_BATCH_SIZE;
    const jobs: DurableJobRecord[] = [];
    for (let index = 0; index < uniqueRunIds.length; index += batchSize) {
      const batch = await Promise.all(
        uniqueRunIds.slice(index, index + batchSize).map((runId) => this.readJob(runId))
      );
      for (const job of batch) {
        if (job) jobs.push(job);
      }
    }
    return jobs;
  }

  async readJob(runId: string): Promise<DurableJobRecord | undefined> {
    return await this.readJson<DurableJobRecord>(this.jobPath(runId));
  }

  async writeStep(runId: string, step: DurableJobStep): Promise<void> {
    await this.writeJson(this.stepPath(runId, step.step_id), step);
  }

  async readStep(runId: string, stepId: string): Promise<DurableJobStep | undefined> {
    return await this.readJson<DurableJobStep>(this.stepPath(runId, stepId));
  }

  async readSteps(job: DurableJobRecord): Promise<DurableJobStep[]> {
    const steps = await Promise.all(job.steps.map((stepId) => this.readStep(job.run_id, stepId)));
    return steps
      .filter((step): step is DurableJobStep => Boolean(step))
      .sort((a, b) => a.index - b.index);
  }

  async writeStepOutput(runId: string, stepId: string, output: unknown): Promise<string> {
    const outputPath = this.stepOutputPath(runId, stepId);
    await this.writeJson(outputPath, output);
    return outputPath;
  }

  async readStepOutput<T>(runId: string, stepId: string): Promise<T | undefined> {
    return await this.readJson<T>(this.stepOutputPath(runId, stepId));
  }

  private sameOwnership(value: Record<string, unknown> | undefined, claim: DurableJobOwnership): boolean {
    return value?.run_id === claim.run_id
      && value.owner_token === claim.owner_token
      && Number(value.fencing_token) === claim.fencing_token;
  }

  private async clearReleasedOwner(runId: string, ownerToken: string, fencingToken?: number): Promise<void> {
    const job = await this.readJob(runId).catch(() => undefined);
    if (!job || job.owner_token !== ownerToken) return;
    if (fencingToken !== undefined && Number(job.fencing_token) !== fencingToken) return;
    job.owner_token = null;
    job.owner_pid = null;
    job.owner_acquired_at = null;
    job.updated_at = new Date().toISOString();
    await this.writeJson(this.jobPath(runId), job);
    await upsertOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "durable-jobs",
      job.run_id,
      durableJobOfficeIndexEntry(job)
    ).catch(() => undefined);
  }

  private async withRunOwnerLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockDir = this.guard.resolve(this.workspace, this.ownerFenceLockPath(runId), { forWrite: true });
    const ownerPath = path.join(lockDir.absPath, "owner.json");
    const started = Date.now();
    await fsp.mkdir(path.dirname(lockDir.absPath), { recursive: true });
    while (true) {
      try {
        await fsp.mkdir(lockDir.absPath, { recursive: false, mode: 0o700 });
        await fsp.writeFile(ownerPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), "utf8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await this.readJson<{ pid?: number; acquired_at?: string }>(`${this.ownerFenceLockPath(runId)}/owner.json`).catch(() => undefined);
        const acquiredAt = typeof owner?.acquired_at === "string" ? Date.parse(owner.acquired_at) : 0;
        const stale = Number.isFinite(acquiredAt) && Date.now() - acquiredAt > OWNER_LOCK_STALE_MS;
        if (stale) {
          await fsp.rm(lockDir.absPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() - started > OWNER_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for durable job owner fence lock: ${runId}`);
        await new Promise((resolve) => setTimeout(resolve, OWNER_LOCK_POLL_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await fsp.rm(lockDir.absPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
