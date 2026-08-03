import { createReadStream, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { PathGuard, Workspace } from "../guard.js";
import {
  TASK_REPORT_LIMITS,
  sanitizeTaskReportEventV1,
  taskReportProgressFingerprint,
  validateTaskReportEventV1,
  type TaskReportEventV1,
  type TaskReportStageSummaryV1,
  type TaskReportSummaryV1
} from "./taskReportTypes.js";
import {
  isTaskReportProjectionMetaV1,
  isTaskReportSummaryV1,
  projectTaskReportEvents,
  type TaskReportProjectionMetaV1,
  type TaskReportProjectionV1
} from "./taskReportProjection.js";

const SAFE_TASK_ID = /^(?!.*\.\.)(?!.*%2e)[A-Za-z0-9._-]{1,200}$/i;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 10;
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 100;
const MAX_SUMMARY_CACHE_ENTRIES = 2_048;
const MAX_SCAN_CACHE_ENTRIES = 256;

interface SummaryCacheEntry {
  summary: TaskReportSummaryV1;
  cachedAt: number;
}

const summaryCache = new Map<string, SummaryCacheEntry>();

interface ScanCacheEntry {
  scan: ScanResult;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
}

const scanCache = new Map<string, ScanCacheEntry>();

function cacheSummary(key: string, summary: TaskReportSummaryV1): void {
  summaryCache.delete(key);
  summaryCache.set(key, { summary: structuredClone(summary), cachedAt: Date.now() });
  if (summaryCache.size <= MAX_SUMMARY_CACHE_ENTRIES) return;
  const oldest = summaryCache.keys().next().value;
  if (typeof oldest === "string") summaryCache.delete(oldest);
}

function sameScanSource(entry: ScanCacheEntry, stat: Stats): boolean {
  return entry.size === stat.size
    && entry.mtimeMs === stat.mtimeMs
    && entry.ctimeMs === stat.ctimeMs
    && entry.ino === stat.ino
    && entry.dev === stat.dev;
}

function cacheScan(key: string, stat: Stats, scan: ScanResult): void {
  scanCache.delete(key);
  scanCache.set(key, {
    scan,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino,
    dev: stat.dev
  });
  if (scanCache.size <= MAX_SCAN_CACHE_ENTRIES) return;
  const oldest = scanCache.keys().next().value;
  if (typeof oldest === "string") scanCache.delete(oldest);
}

export type TaskReportEventInputV1 = Omit<TaskReportEventV1, "version" | "event_id" | "sequence" | "created_at"> & {
  version?: 1;
  event_id?: string;
  created_at?: string;
};

export interface TaskReportAppendResultV1 {
  event: TaskReportEventV1;
  appended: boolean;
  reason: "appended" | "idempotent" | "unchanged_progress";
  summary: TaskReportSummaryV1;
  stages: TaskReportStageSummaryV1[];
}

export interface TaskReportReadOptions {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export interface TaskReportReadResultV1 {
  events: TaskReportEventV1[];
  latest_sequence: number;
  has_more: boolean;
  next_after_sequence: number;
  invalid_line_count: number;
  incomplete_tail: boolean;
  summary: TaskReportSummaryV1;
}

interface ScanResult {
  events: TaskReportEventV1[];
  invalidLineCount: number;
  incompleteTail: boolean;
  eventBytes: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertTaskId(taskId: string): string {
  if (taskId === "." || !SAFE_TASK_ID.test(taskId)) throw new Error(`Invalid task report task_id: ${taskId}`);
  return taskId;
}

function positiveSequence(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
  return value;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READ_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_READ_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_READ_LIMIT}.`);
  }
  return value;
}

export class TaskReportEventStore {
  constructor(readonly guard: PathGuard, readonly workspace: Workspace) {}

  taskRoot(taskId: string): string {
    return `.codexpro/task-reports/${assertTaskId(taskId)}`;
  }

  eventsPath(taskId: string): string {
    return `${this.taskRoot(taskId)}/events.jsonl`;
  }

  summaryPath(taskId: string): string {
    return `${this.taskRoot(taskId)}/summary.json`;
  }

  projectionMetaPath(taskId: string): string {
    return `${this.taskRoot(taskId)}/projection-meta.json`;
  }

  private summaryCacheKey(taskId: string): string {
    return this.guard.resolve(this.workspace, this.summaryPath(taskId)).absPath;
  }

  private lockPath(taskId: string): string {
    return `${this.taskRoot(taskId)}/writer.lock`;
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const lock = this.guard.resolve(this.workspace, this.lockPath(taskId), { forWrite: true });
    await fsp.mkdir(path.dirname(lock.absPath), { recursive: true, mode: 0o700 });
    const token = `${process.pid}-${randomUUID()}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await fsp.mkdir(lock.absPath, { mode: 0o700 });
        await fsp.writeFile(path.join(lock.absPath, "owner.json"), `${JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() })}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fsp.stat(lock.absPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          const stale = `${lock.absPath}.stale-${randomUUID().slice(0, 8)}`;
          await fsp.rename(lock.absPath, stale).then(
            () => fsp.rm(stale, { recursive: true, force: true }),
            () => undefined
          ).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Task report writer lock timed out: ${taskId}`);
        await sleep(LOCK_POLL_MS);
      }
    }
    try {
      return await operation();
    } finally {
      const owner = await fsp.readFile(path.join(lock.absPath, "owner.json"), "utf8")
        .then((text) => JSON.parse(text) as { token?: string })
        .catch(() => undefined);
      if (owner?.token === token) await fsp.rm(lock.absPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async atomicWriteJson(relativePath: string, value: unknown): Promise<void> {
    const target = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
    const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fsp.rename(temporary, target.absPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readJson(relativePath: string): Promise<unknown | undefined> {
    const target = this.guard.resolve(this.workspace, relativePath);
    try {
      return JSON.parse(await fsp.readFile(target.absPath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  private async scan(taskId: string, retry = 0): Promise<ScanResult> {
    const target = this.guard.resolve(this.workspace, this.eventsPath(taskId));
    const stat = await fsp.stat(target.absPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      scanCache.delete(target.absPath);
      return { events: [], invalidLineCount: 0, incompleteTail: false, eventBytes: 0 };
    }
    if (!stat.isFile()) throw new Error(`Task report event path is not a file: ${this.eventsPath(taskId)}`);
    const cached = scanCache.get(target.absPath);
    if (cached && sameScanSource(cached, stat)) return cached.scan;

    let endsWithNewline = stat.size === 0;
    if (stat.size > 0) {
      const handle = await fsp.open(target.absPath, "r");
      try {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, stat.size - 1);
        endsWithNewline = tail[0] === 0x0a;
      } finally {
        await handle.close();
      }
    }

    const events: TaskReportEventV1[] = [];
    const seenSequences = new Set<number>();
    const seenEventIds = new Set<string>();
    const seenIdempotencyKeys = new Set<string>();
    let projectId: string | undefined;
    const input = createReadStream(target.absPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let invalidLineCount = 0;
    let lineNumber = 0;
    for await (const rawLine of lines) {
      lineNumber += 1;
      const line = rawLine.trim();
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
        invalidLineCount += 1;
        continue;
      }
      try {
        const parsed = JSON.parse(line) as TaskReportEventV1;
        const issues = validateTaskReportEventV1(parsed);
        let unsafeEvidence = false;
        if (issues.length === 0) {
          try {
            for (const evidencePath of parsed.evidence_paths) {
              this.guard.resolve(this.workspace, evidencePath, { forWrite: true });
            }
          } catch {
            unsafeEvidence = true;
          }
        }
        if (
          issues.length > 0
          || unsafeEvidence
          || parsed.task_id !== taskId
          || (projectId !== undefined && parsed.project_id !== projectId)
          || seenSequences.has(parsed.sequence)
          || seenEventIds.has(parsed.event_id)
          || seenIdempotencyKeys.has(parsed.idempotency_key)
        ) {
          invalidLineCount += 1;
          continue;
        }
        projectId = parsed.project_id;
        seenSequences.add(parsed.sequence);
        seenEventIds.add(parsed.event_id);
        seenIdempotencyKeys.add(parsed.idempotency_key);
        events.push(parsed);
      } catch {
        invalidLineCount += 1;
      }
    }
    events.sort((left, right) => left.sequence - right.sequence);
    const result = {
      events,
      invalidLineCount,
      incompleteTail: stat.size > 0 && !endsWithNewline,
      eventBytes: stat.size
    };
    const endingStat = await fsp.stat(target.absPath).catch(() => undefined);
    if (endingStat && !sameScanSource({
      scan: result,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      dev: stat.dev
    }, endingStat)) {
      if (retry < 2) return await this.scan(taskId, retry + 1);
      return result;
    }
    if (endingStat) cacheScan(target.absPath, endingStat, result);
    return result;
  }

  private async appendLine(taskId: string, event: TaskReportEventV1): Promise<void> {
    const target = this.guard.resolve(this.workspace, this.eventsPath(taskId), { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error(`Task report event exceeds ${MAX_EVENT_LINE_BYTES} bytes.`);
    }
    const handle = await fsp.open(target.absPath, "a+", 0o600);
    try {
      const stat = await handle.stat();
      if (stat.size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, stat.size - 1);
        if (tail[0] !== 0x0a) await handle.write("\n", null, "utf8");
      }
      await handle.write(line, null, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private projectionFromScan(taskId: string, scan: ScanResult, backfillVersion?: number | null): TaskReportProjectionV1 {
    return projectTaskReportEvents(taskId, scan.events, {
      invalidLineCount: scan.invalidLineCount,
      incompleteTail: scan.incompleteTail,
      eventBytes: scan.eventBytes,
      backfillVersion
    });
  }

  private async writeProjection(taskId: string, projection: TaskReportProjectionV1): Promise<void> {
    await this.atomicWriteJson(this.summaryPath(taskId), projection.summary);
    await this.atomicWriteJson(this.projectionMetaPath(taskId), projection.meta);
    cacheSummary(this.summaryCacheKey(taskId), projection.summary);
  }

  private projectionMatchesScan(
    summary: TaskReportSummaryV1,
    meta: TaskReportProjectionMetaV1,
    projection: TaskReportProjectionV1
  ): boolean {
    return summary.latest_sequence === projection.summary.latest_sequence
      && summary.event_count === projection.summary.event_count
      && meta.latest_sequence === projection.meta.latest_sequence
      && meta.valid_event_count === projection.meta.valid_event_count
      && meta.invalid_line_count === projection.meta.invalid_line_count
      && meta.incomplete_tail === projection.meta.incomplete_tail
      && meta.source_summary.event_digest === projection.meta.source_summary.event_digest
      && meta.source_summary.event_bytes === projection.meta.source_summary.event_bytes;
  }

  private async ensureProjection(taskId: string, initialScan?: ScanResult): Promise<{ scan: ScanResult; projection: TaskReportProjectionV1 }> {
    const scan = initialScan ?? await this.scan(taskId);
    const expected = this.projectionFromScan(taskId, scan);
    const currentSummary = await this.readJson(this.summaryPath(taskId));
    const currentMeta = await this.readJson(this.projectionMetaPath(taskId));
    if (
      isTaskReportSummaryV1(currentSummary, taskId)
      && isTaskReportProjectionMetaV1(currentMeta, taskId)
      && this.projectionMatchesScan(currentSummary, currentMeta, expected)
    ) return { scan, projection: { summary: currentSummary, meta: currentMeta } };

    return await this.withTaskLock(taskId, async () => {
      const refreshed = await this.scan(taskId);
      const previousMeta = await this.readJson(this.projectionMetaPath(taskId));
      const backfillVersion = isTaskReportProjectionMetaV1(previousMeta, taskId) ? previousMeta.backfill_version : null;
      const projection = this.projectionFromScan(taskId, refreshed, backfillVersion);
      await this.writeProjection(taskId, projection);
      return { scan: refreshed, projection };
    });
  }

  async append(input: TaskReportEventInputV1): Promise<TaskReportAppendResultV1> {
    const taskId = assertTaskId(input.task_id);
    return await this.withTaskLock(taskId, async () => {
      const before = await this.scan(taskId);
      const idempotent = before.events.find((event) => event.idempotency_key === input.idempotency_key);
      if (idempotent) {
        const projection = this.projectionFromScan(taskId, before);
        await this.writeProjection(taskId, projection);
        return { event: idempotent, appended: false, reason: "idempotent", summary: projection.summary, stages: projection.meta.stages };
      }
      const existingProjectId = before.events[0]?.project_id;
      if (existingProjectId && existingProjectId !== input.project_id) {
        throw new Error(`Task report project mismatch: expected ${existingProjectId}, received ${input.project_id}`);
      }

      if (input.title.length > TASK_REPORT_LIMITS.title_chars) {
        throw new Error(`Task report title exceeds ${TASK_REPORT_LIMITS.title_chars} characters.`);
      }
      if (input.summary.length > TASK_REPORT_LIMITS.summary_chars) {
        throw new Error(`Task report summary exceeds ${TASK_REPORT_LIMITS.summary_chars} characters.`);
      }
      if ((input.detail_markdown?.length ?? 0) > TASK_REPORT_LIMITS.detail_markdown_chars) {
        throw new Error(`Task report detail_markdown exceeds ${TASK_REPORT_LIMITS.detail_markdown_chars} characters.`);
      }
      if (input.evidence_paths.length > TASK_REPORT_LIMITS.evidence_paths) {
        throw new Error(`Task report evidence_paths exceeds ${TASK_REPORT_LIMITS.evidence_paths} entries.`);
      }

      const nextSequence = Math.max(0, ...before.events.map((event) => event.sequence)) + 1;
      const now = new Date().toISOString();
      const event = sanitizeTaskReportEventV1({
        ...input,
        version: 1,
        event_id: input.event_id ?? `event-${randomUUID()}`,
        sequence: nextSequence,
        created_at: input.created_at ?? now
      });
      if (before.events.some((candidate) => candidate.event_id === event.event_id)) {
        throw new Error(`Duplicate task report event_id: ${event.event_id}`);
      }
      for (const evidencePath of event.evidence_paths) {
        this.guard.resolve(this.workspace, evidencePath, { forWrite: true });
      }
      const issues = validateTaskReportEventV1(event);
      if (issues.length > 0) {
        throw new Error(`Invalid task report event: ${issues.map((issue) => `${issue.field}:${issue.code}`).join(", ")}`);
      }

      if (event.event_kind === "progress") {
        const previousProgress = [...before.events].reverse().find((candidate) =>
          candidate.event_kind === "progress"
          && candidate.stage_key === event.stage_key
          && candidate.source_kind === event.source_kind
        );
        if (previousProgress && taskReportProgressFingerprint(previousProgress) === taskReportProgressFingerprint(event)) {
          const projection = this.projectionFromScan(taskId, before);
          await this.writeProjection(taskId, projection);
          return {
            event: previousProgress,
            appended: false,
            reason: "unchanged_progress",
            summary: projection.summary,
            stages: projection.meta.stages
          };
        }
      }

      await this.appendLine(taskId, event);
      const after = await this.scan(taskId);
      const projection = this.projectionFromScan(taskId, after);
      await this.writeProjection(taskId, projection);
      return { event, appended: true, reason: "appended", summary: projection.summary, stages: projection.meta.stages };
    });
  }

  async readEvents(taskIdInput: string, options: TaskReportReadOptions = {}): Promise<TaskReportReadResultV1> {
    const taskId = assertTaskId(taskIdInput);
    const after = positiveSequence(options.afterSequence, "afterSequence");
    const before = positiveSequence(options.beforeSequence, "beforeSequence");
    if (after !== undefined && before !== undefined) throw new Error("afterSequence and beforeSequence cannot be combined.");
    const limit = boundedLimit(options.limit);
    const ensured = await this.ensureProjection(taskId);
    let candidates = ensured.scan.events;
    let selected: TaskReportEventV1[];
    if (before !== undefined) {
      candidates = candidates.filter((event) => event.sequence < before);
      selected = candidates.slice(Math.max(0, candidates.length - limit));
    } else {
      candidates = candidates.filter((event) => event.sequence > (after ?? 0));
      selected = candidates.slice(0, limit);
    }
    return {
      events: selected,
      latest_sequence: ensured.projection.summary.latest_sequence,
      has_more: candidates.length > selected.length,
      next_after_sequence: selected.at(-1)?.sequence ?? after ?? 0,
      invalid_line_count: ensured.scan.invalidLineCount,
      incomplete_tail: ensured.scan.incompleteTail,
      summary: ensured.projection.summary
    };
  }

  async readSummary(taskIdInput: string): Promise<TaskReportSummaryV1> {
    return (await this.ensureProjection(assertTaskId(taskIdInput))).projection.summary;
  }

  async readCachedSummary(taskIdInput: string, options: { maxAgeMs?: number } = {}): Promise<TaskReportSummaryV1 | null> {
    const taskId = assertTaskId(taskIdInput);
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 0));
    const cacheKey = this.summaryCacheKey(taskId);
    const cached = summaryCache.get(cacheKey);
    if (maxAgeMs > 0 && cached && Date.now() - cached.cachedAt <= maxAgeMs) {
      return structuredClone(cached.summary);
    }
    const value = await this.readJson(this.summaryPath(taskId));
    if (!isTaskReportSummaryV1(value, taskId)) return null;
    cacheSummary(cacheKey, value);
    return value;
  }

  async readStages(taskIdInput: string): Promise<TaskReportStageSummaryV1[]> {
    return (await this.ensureProjection(assertTaskId(taskIdInput))).projection.meta.stages;
  }

  async rebuild(taskIdInput: string, backfillVersion: number | null = null): Promise<TaskReportProjectionV1> {
    const taskId = assertTaskId(taskIdInput);
    return await this.withTaskLock(taskId, async () => {
      const scan = await this.scan(taskId);
      const projection = this.projectionFromScan(taskId, scan, backfillVersion);
      await this.writeProjection(taskId, projection);
      return projection;
    });
  }
}
