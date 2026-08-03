import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "../redact.js";
import { workspaceRuntimeStatePath } from "../runtime/workspaceState.js";
import {
  createRuntimeActivityEvent,
  type RuntimeActivityEventV1,
  type RuntimeActivityState,
  type RuntimeUserActionRequiredV1
} from "../runtime/activityEvents.js";

export type ExecutionComponentKind = "model_stream" | "tool_process" | "worker";
export type ExecutionComponentState =
  | "registered"
  | "idle"
  | "running"
  | "expected_silence"
  | "stale"
  | "terminating"
  | "terminal";

export interface ExecutionComponentRecord {
  version: 1;
  component_id: string;
  kind: ExecutionComponentKind;
  task_id: string | null;
  run_id: string | null;
  owner_id: string | null;
  fencing_token: number | null;
  registered_at: string;
  last_liveness_at: string | null;
  last_progress_at: string | null;
  last_meaningful_progress_at?: string | null;
  activity_state?: RuntimeActivityState;
  safe_summary?: string | null;
  user_action_required?: RuntimeUserActionRequiredV1 | null;
  last_activity_event?: RuntimeActivityEventV1 | null;
  last_transition_at: string;
  expected_silence_until: string | null;
  no_progress_deadline: string | null;
  hard_deadline: string | null;
  state: ExecutionComponentState;
  progress_marker: string | null;
  terminal_reason: string | null;
  evidence_ref: string | null;
}

export interface ExecutionComponentStateFile {
  version: 1;
  updated_at: string;
  execution_components: {
    model_stream: Record<string, ExecutionComponentRecord>;
    tool_processes: Record<string, ExecutionComponentRecord>;
    workers: Record<string, ExecutionComponentRecord>;
  };
}

export interface RegisterExecutionComponentInput {
  component_id?: string;
  kind: ExecutionComponentKind;
  task_id?: string | null;
  run_id?: string | null;
  owner_id?: string | null;
  fencing_token?: number | null;
  state?: ExecutionComponentState;
  expected_silence_until?: string | null;
  no_progress_deadline?: string | null;
  hard_deadline?: string | null;
  progress_marker?: string | null;
  activity_state?: RuntimeActivityState;
  safe_summary?: string | null;
  user_action_required?: RuntimeUserActionRequiredV1 | null;
  meaningful_progress?: boolean;
  evidence_ref?: string | null;
  now?: string;
}

export interface ExecutionComponentStoreOptions {
  root?: string;
  state_path?: string;
  max_records?: number;
  max_state_bytes?: number;
  inactive_retention_ms?: number;
  lock_timeout_ms?: number;
}

const DEFAULT_MAX_RECORDS = 2_000;
const DEFAULT_MAX_STATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_INACTIVE_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;
const mutationQueues = new Map<string, Promise<void>>();

function timestamp(date = new Date()): string {
  return date.toISOString();
}

function bucketFor(kind: ExecutionComponentKind): keyof ExecutionComponentStateFile["execution_components"] {
  if (kind === "model_stream") return "model_stream";
  if (kind === "tool_process") return "tool_processes";
  return "workers";
}

function optionalString(value: unknown, max = 500): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? redactSensitiveText(trimmed).slice(0, max) : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function boundedNumber(value: unknown, fallback: number, minimum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.floor(numeric)) : fallback;
}

function safeComponentId(kind: ExecutionComponentKind, value?: string): string {
  const raw = value?.trim() || `${kind}:${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,240}$/.test(raw)) {
    return `${kind}:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
  }
  return raw;
}

function defaultState(now: string): ExecutionComponentStateFile {
  return {
    version: 1,
    updated_at: now,
    execution_components: {
      model_stream: {},
      tool_processes: {},
      workers: {}
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parsedTime(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordActivityTime(record: ExecutionComponentRecord): number {
  return Math.max(
    parsedTime(record.last_transition_at),
    parsedTime(record.last_progress_at),
    parsedTime(record.last_liveness_at),
    parsedTime(record.registered_at)
  );
}

function inactive(record: ExecutionComponentRecord): boolean {
  return record.state === "terminal" || record.state === "stale" || record.state === "terminating";
}

function processAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function applyDeadlines(state: ExecutionComponentStateFile, now: string): boolean {
  const nowMs = Date.parse(now);
  let changed = false;
  for (const bucket of Object.values(state.execution_components)) {
    for (const record of Object.values(bucket)) {
      if (record.state === "terminal") continue;
      if (record.hard_deadline && Date.parse(record.hard_deadline) <= nowMs) {
        if (record.state !== "terminating" || record.terminal_reason !== "hard_deadline_exceeded") {
          record.state = "terminating";
          record.terminal_reason = "hard_deadline_exceeded";
          record.last_transition_at = now;
          changed = true;
        }
        continue;
      }
      if (record.expected_silence_until && Date.parse(record.expected_silence_until) > nowMs) {
        if (record.state !== "expected_silence") {
          record.state = "expected_silence";
          record.last_transition_at = now;
          changed = true;
        }
        continue;
      }
      if (record.no_progress_deadline && Date.parse(record.no_progress_deadline) <= nowMs) {
        if (record.state !== "stale" || record.terminal_reason !== "no_progress_deadline_exceeded") {
          record.state = "stale";
          record.terminal_reason = "no_progress_deadline_exceeded";
          record.last_transition_at = now;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export class ExecutionComponentStore {
  readonly statePath: string;
  private readonly maxRecords: number;
  private readonly maxStateBytes: number;
  private readonly inactiveRetentionMs: number;
  private readonly lockTimeoutMs: number;

  constructor(options: ExecutionComponentStoreOptions = {}) {
    const root = path.resolve(options.root ?? process.cwd());
    this.statePath = path.resolve(options.state_path ?? path.join(root, ".ai-bridge", "execution-components", "state.json"));
    this.maxRecords = boundedNumber(options.max_records ?? process.env.CODEXPRO_EXECUTION_COMPONENT_MAX_RECORDS, DEFAULT_MAX_RECORDS, 1);
    this.maxStateBytes = boundedNumber(options.max_state_bytes ?? process.env.CODEXPRO_EXECUTION_COMPONENT_MAX_BYTES, DEFAULT_MAX_STATE_BYTES, 1_024);
    this.inactiveRetentionMs = boundedNumber(options.inactive_retention_ms ?? process.env.CODEXPRO_EXECUTION_COMPONENT_RETENTION_MS, DEFAULT_INACTIVE_RETENTION_MS, 0);
    this.lockTimeoutMs = boundedNumber(options.lock_timeout_ms, DEFAULT_LOCK_TIMEOUT_MS, 100);
  }

  async register(input: RegisterExecutionComponentInput): Promise<ExecutionComponentRecord> {
    const now = input.now ?? timestamp();
    const componentId = safeComponentId(input.kind, input.component_id);
    const bucketName = bucketFor(input.kind);
    const state = await this.mutateState((current) => {
      const bucket = current.execution_components[bucketName];
      const existing = bucket[componentId];
      if (existing) {
        this.assertOwner(existing, input.owner_id, input.fencing_token);
        bucket[componentId] = {
          ...existing,
          task_id: optionalString(input.task_id ?? existing.task_id),
          run_id: optionalString(input.run_id ?? existing.run_id),
          owner_id: optionalString(input.owner_id ?? existing.owner_id),
          fencing_token: numberOrNull(input.fencing_token ?? existing.fencing_token),
          last_transition_at: now,
          expected_silence_until: optionalString(input.expected_silence_until ?? existing.expected_silence_until),
          no_progress_deadline: optionalString(input.no_progress_deadline ?? existing.no_progress_deadline),
          hard_deadline: optionalString(input.hard_deadline ?? existing.hard_deadline),
          state: input.state ?? existing.state,
          progress_marker: optionalString(input.progress_marker ?? existing.progress_marker, 2_000),
          activity_state: input.activity_state ?? existing.activity_state,
          safe_summary: optionalString(input.safe_summary ?? input.progress_marker ?? existing.safe_summary, 2_000),
          user_action_required: input.user_action_required === undefined ? existing.user_action_required : input.user_action_required,
          last_meaningful_progress_at: input.meaningful_progress === false ? existing.last_meaningful_progress_at : (input.progress_marker || input.safe_summary ? now : existing.last_meaningful_progress_at),
          last_activity_event: input.activity_state ? createRuntimeActivityEvent({
            task_id: optionalString(input.task_id ?? existing.task_id),
            run_id: optionalString(input.run_id ?? existing.run_id),
            source: input.kind,
            activity_state: input.activity_state,
            safe_summary: input.safe_summary ?? input.progress_marker ?? existing.safe_summary ?? existing.progress_marker ?? input.activity_state,
            occurred_at: now,
            meaningful_progress: input.meaningful_progress !== false,
            evidence_ref: optionalString(input.evidence_ref ?? existing.evidence_ref, 2_000),
            user_action_required: input.user_action_required ?? null
          }) : existing.last_activity_event,
          evidence_ref: optionalString(input.evidence_ref ?? existing.evidence_ref, 2_000)
        };
        return true;
      }
      bucket[componentId] = {
        version: 1,
        component_id: componentId,
        kind: input.kind,
        task_id: optionalString(input.task_id),
        run_id: optionalString(input.run_id),
        owner_id: optionalString(input.owner_id),
        fencing_token: numberOrNull(input.fencing_token),
        registered_at: now,
        last_liveness_at: null,
        last_progress_at: input.progress_marker || input.safe_summary ? now : null,
        last_meaningful_progress_at: input.meaningful_progress === false ? null : (input.progress_marker || input.safe_summary ? now : null),
        activity_state: input.activity_state,
        safe_summary: optionalString(input.safe_summary ?? input.progress_marker, 2_000),
        user_action_required: input.user_action_required ?? null,
        last_activity_event: input.activity_state ? createRuntimeActivityEvent({
          task_id: optionalString(input.task_id),
          run_id: optionalString(input.run_id),
          source: input.kind,
          activity_state: input.activity_state,
          safe_summary: input.safe_summary ?? input.progress_marker ?? input.activity_state,
          occurred_at: now,
          meaningful_progress: input.meaningful_progress !== false,
          evidence_ref: optionalString(input.evidence_ref, 2_000),
          user_action_required: input.user_action_required ?? null
        }) : null,
        last_transition_at: now,
        expected_silence_until: optionalString(input.expected_silence_until),
        no_progress_deadline: optionalString(input.no_progress_deadline),
        hard_deadline: optionalString(input.hard_deadline),
        state: input.state ?? "registered",
        progress_marker: optionalString(input.progress_marker, 2_000),
        terminal_reason: null,
        evidence_ref: optionalString(input.evidence_ref, 2_000)
      };
      return true;
    }, now);
    return clone(state.execution_components[bucketName][componentId]);
  }

  async heartbeat(
    componentId: string,
    options: { kind: ExecutionComponentKind; owner_id?: string | null; fencing_token?: number | null; at?: string; expected_silence_until?: string | null }
  ): Promise<ExecutionComponentRecord | null> {
    return await this.patch(options.kind, componentId, options.owner_id, options.fencing_token, (record) => {
      const at = options.at ?? timestamp();
      record.last_liveness_at = at;
      record.expected_silence_until = optionalString(options.expected_silence_until ?? record.expected_silence_until);
      if (record.state === "registered" || record.state === "stale") record.state = "running";
      if (record.expected_silence_until && Date.parse(record.expected_silence_until) > Date.parse(at)) {
        record.state = "expected_silence";
      } else if (record.state === "expected_silence") {
        record.state = "running";
      }
      record.last_transition_at = at;
    }, options.at);
  }

  async progress(
    componentId: string,
    options: {
      kind: ExecutionComponentKind;
      owner_id?: string | null;
      fencing_token?: number | null;
      at?: string;
      marker?: string | null;
      evidence_ref?: string | null;
      no_progress_deadline?: string | null;
      activity_state?: RuntimeActivityState;
      safe_summary?: string | null;
      user_action_required?: RuntimeUserActionRequiredV1 | null;
      meaningful_progress?: boolean;
    }
  ): Promise<ExecutionComponentRecord | null> {
    return await this.patch(options.kind, componentId, options.owner_id, options.fencing_token, (record) => {
      const at = options.at ?? timestamp();
      record.last_liveness_at = at;
      record.last_progress_at = at;
      if (options.meaningful_progress !== false) record.last_meaningful_progress_at = at;
      record.progress_marker = optionalString(options.marker ?? record.progress_marker, 2_000);
      record.activity_state = options.activity_state ?? record.activity_state;
      record.safe_summary = optionalString(options.safe_summary ?? options.marker ?? record.safe_summary, 2_000);
      record.user_action_required = options.user_action_required === undefined ? record.user_action_required : options.user_action_required;
      if (record.activity_state) {
        record.last_activity_event = createRuntimeActivityEvent({
          task_id: record.task_id,
          run_id: record.run_id,
          source: record.kind,
          activity_state: record.activity_state,
          safe_summary: record.safe_summary ?? record.progress_marker ?? record.activity_state,
          occurred_at: at,
          meaningful_progress: options.meaningful_progress !== false,
          evidence_ref: options.evidence_ref ?? record.evidence_ref,
          user_action_required: record.user_action_required ?? null
        });
      }
      record.evidence_ref = optionalString(options.evidence_ref ?? record.evidence_ref, 2_000);
      record.no_progress_deadline = optionalString(options.no_progress_deadline ?? record.no_progress_deadline);
      record.state = "running";
      record.last_transition_at = at;
    }, options.at);
  }

  async expectedSilence(
    componentId: string,
    options: { kind: ExecutionComponentKind; until: string; owner_id?: string | null; fencing_token?: number | null; at?: string; reason?: string; user_action_required?: RuntimeUserActionRequiredV1 | null }
  ): Promise<ExecutionComponentRecord | null> {
    return await this.patch(options.kind, componentId, options.owner_id, options.fencing_token, (record) => {
      const at = options.at ?? timestamp();
      record.last_liveness_at = at;
      record.expected_silence_until = options.until;
      record.progress_marker = optionalString(options.reason ?? record.progress_marker, 2_000);
      record.activity_state = options.user_action_required ? "waiting_user" : "idle_between_steps";
      record.safe_summary = optionalString(options.reason ?? record.safe_summary, 2_000);
      record.user_action_required = options.user_action_required ?? null;
      record.last_activity_event = createRuntimeActivityEvent({
        task_id: record.task_id,
        run_id: record.run_id,
        source: record.kind,
        activity_state: record.activity_state,
        safe_summary: record.safe_summary ?? record.activity_state,
        occurred_at: at,
        meaningful_progress: true,
        evidence_ref: record.evidence_ref,
        user_action_required: record.user_action_required
      });
      record.last_meaningful_progress_at = at;
      record.state = "expected_silence";
      record.last_transition_at = at;
    }, options.at);
  }

  async transition(
    componentId: string,
    options: { kind: ExecutionComponentKind; state: ExecutionComponentState; owner_id?: string | null; fencing_token?: number | null; at?: string; evidence_ref?: string | null; activity_state?: RuntimeActivityState; safe_summary?: string | null; user_action_required?: RuntimeUserActionRequiredV1 | null }
  ): Promise<ExecutionComponentRecord | null> {
    return await this.patch(options.kind, componentId, options.owner_id, options.fencing_token, (record) => {
      const at = options.at ?? timestamp();
      record.state = options.state;
      record.activity_state = options.activity_state ?? record.activity_state;
      record.safe_summary = optionalString(options.safe_summary ?? record.safe_summary, 2_000);
      record.user_action_required = options.user_action_required === undefined ? record.user_action_required : options.user_action_required;
      record.last_transition_at = at;
      record.evidence_ref = optionalString(options.evidence_ref ?? record.evidence_ref, 2_000);
      if (record.activity_state && (options.activity_state || options.safe_summary || options.user_action_required !== undefined)) {
        record.last_activity_event = createRuntimeActivityEvent({
          task_id: record.task_id,
          run_id: record.run_id,
          source: record.kind,
          activity_state: record.activity_state,
          safe_summary: record.safe_summary ?? record.activity_state,
          occurred_at: at,
          meaningful_progress: true,
          evidence_ref: record.evidence_ref,
          user_action_required: record.user_action_required ?? null
        });
        record.last_meaningful_progress_at = at;
      }
    }, options.at);
  }

  async terminal(
    componentId: string,
    options: { kind: ExecutionComponentKind; reason: string; evidence_ref: string; owner_id?: string | null; fencing_token?: number | null; at?: string }
  ): Promise<ExecutionComponentRecord | null> {
    return await this.patch(options.kind, componentId, options.owner_id, options.fencing_token, (record) => {
      const at = options.at ?? timestamp();
      record.last_liveness_at = at;
      record.last_transition_at = at;
      record.state = "terminal";
      record.activity_state = "terminal";
      record.safe_summary = optionalString(options.reason, 2_000);
      record.user_action_required = null;
      record.terminal_reason = optionalString(options.reason, 2_000);
      record.evidence_ref = optionalString(options.evidence_ref, 2_000);
      record.last_meaningful_progress_at = at;
      record.last_activity_event = createRuntimeActivityEvent({
        task_id: record.task_id,
        run_id: record.run_id,
        source: record.kind,
        activity_state: "terminal",
        safe_summary: record.safe_summary ?? "组件已结束",
        occurred_at: at,
        meaningful_progress: true,
        evidence_ref: record.evidence_ref
      });
    }, options.at);
  }

  async evaluateDeadlines(options: { now?: string } = {}): Promise<ExecutionComponentStateFile> {
    const now = options.now ?? timestamp();
    return clone(await this.mutateState((state) => applyDeadlines(state, now), now));
  }

  async readProjection(): Promise<ExecutionComponentStateFile["execution_components"]> {
    const state = await this.readState();
    const now = timestamp();
    applyDeadlines(state, now);
    this.compactState(state, now);
    return clone(state.execution_components);
  }

  async readState(): Promise<ExecutionComponentStateFile> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.statePath, "utf8")) as ExecutionComponentStateFile;
      if (parsed?.version === 1 && parsed.execution_components) return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return defaultState(timestamp());
  }

  private async patch(
    kind: ExecutionComponentKind,
    componentId: string,
    ownerId: string | null | undefined,
    fencingToken: number | null | undefined,
    mutate: (record: ExecutionComponentRecord) => void,
    compactAt?: string
  ): Promise<ExecutionComponentRecord | null> {
    const bucketName = bucketFor(kind);
    let found = false;
    const state = await this.mutateState((current) => {
      const record = current.execution_components[bucketName][componentId];
      if (!record) return false;
      found = true;
      this.assertOwner(record, ownerId, fencingToken);
      mutate(record);
      return true;
    }, compactAt ?? timestamp());
    return found ? clone(state.execution_components[bucketName][componentId]) : null;
  }

  private assertOwner(record: ExecutionComponentRecord, ownerId: string | null | undefined, fencingToken: number | null | undefined): void {
    if (record.owner_id !== null && ownerId !== record.owner_id) {
      throw new Error(`Execution component ${record.component_id} owner mismatch; stale update refused.`);
    }
    if (record.fencing_token !== null && numberOrNull(fencingToken) !== record.fencing_token) {
      throw new Error(`Execution component ${record.component_id} fencing mismatch; stale update refused.`);
    }
  }

  private async mutateState(
    mutator: (state: ExecutionComponentStateFile) => boolean,
    compactAt = timestamp()
  ): Promise<ExecutionComponentStateFile> {
    return await this.enqueueMutation(async () => await this.withStateLock(async () => {
      await this.cleanupTemporaryFiles();
      const state = await this.readState();
      const changed = mutator(state);
      const compacted = this.compactState(state, compactAt);
      if (changed || compacted) await this.writeStateUnlocked(state);
      return state;
    }));
  }

  private compactState(state: ExecutionComponentStateFile, now: string): boolean {
    type Entry = {
      bucket: keyof ExecutionComponentStateFile["execution_components"];
      key: string;
      record: ExecutionComponentRecord;
      activity: number;
      bytes: number;
    };
    const nowMs = Date.parse(now);
    const active: Entry[] = [];
    const retainedCandidates: Entry[] = [];
    let changed = false;
    for (const [bucketName, bucket] of Object.entries(state.execution_components) as Array<[
      keyof ExecutionComponentStateFile["execution_components"],
      Record<string, ExecutionComponentRecord>
    ]>) {
      for (const [key, record] of Object.entries(bucket)) {
        const activity = recordActivityTime(record);
        const entry = {
          bucket: bucketName,
          key,
          record,
          activity,
          bytes: Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(record), "utf8") + 8
        };
        if (!inactive(record)) {
          active.push(entry);
        } else if (nowMs - activity <= this.inactiveRetentionMs) {
          retainedCandidates.push(entry);
        } else {
          delete bucket[key];
          changed = true;
        }
      }
    }
    retainedCandidates.sort((left, right) => right.activity - left.activity || left.key.localeCompare(right.key));
    let retainedCount = active.length;
    let retainedBytes = 256 + active.reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of retainedCandidates) {
      const keep = retainedCount < this.maxRecords && retainedBytes + entry.bytes <= this.maxStateBytes;
      if (keep) {
        retainedCount += 1;
        retainedBytes += entry.bytes;
      } else {
        delete state.execution_components[entry.bucket][entry.key];
        changed = true;
      }
    }
    return changed;
  }

  private async enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.statePath) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const marker = run.then(() => undefined, () => undefined);
    mutationQueues.set(this.statePath, marker);
    try {
      return await run;
    } finally {
      if (mutationQueues.get(this.statePath) === marker) mutationQueues.delete(this.statePath);
    }
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockDir = `${this.statePath}.lock`;
    const ownerPath = path.join(lockDir, "owner.json");
    const startedAt = Date.now();
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        await fsp.mkdir(lockDir, { mode: 0o700 });
        await fsp.writeFile(ownerPath, JSON.stringify({ pid: process.pid, acquired_at: timestamp() }), { encoding: "utf8", mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: { pid?: number; acquired_at?: string } | undefined;
        try {
          owner = JSON.parse(await fsp.readFile(ownerPath, "utf8"));
        } catch {
          owner = undefined;
        }
        const acquiredAt = parsedTime(owner?.acquired_at);
        let lockAgeMs = acquiredAt > 0 ? Date.now() - acquiredAt : 0;
        if (acquiredAt <= 0) {
          try {
            const stat = await fsp.stat(lockDir);
            lockAgeMs = Math.max(0, Date.now() - stat.mtimeMs);
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw statError;
          }
        }
        const staleOwner = acquiredAt > 0 && lockAgeMs > LOCK_STALE_MS && !processAlive(owner?.pid ?? null);
        const staleOwnerlessLock = acquiredAt <= 0 && lockAgeMs > LOCK_STALE_MS;
        if (staleOwner || staleOwnerlessLock) {
          await fsp.rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out waiting for execution component state lock: ${lockDir}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await operation();
    } finally {
      await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async cleanupTemporaryFiles(): Promise<void> {
    const dir = path.dirname(this.statePath);
    const prefix = `${path.basename(this.statePath)}.tmp-`;
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.filter((name) => name.startsWith(prefix)).map((name) => fsp.rm(path.join(dir, name), { force: true })));
  }

  private async writeStateUnlocked(state: ExecutionComponentStateFile): Promise<void> {
    state.updated_at = timestamp();
    await fsp.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, this.statePath);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function createWorkspaceExecutionComponentStore(root: string): ExecutionComponentStore {
  return new ExecutionComponentStore({
    state_path: workspaceRuntimeStatePath(root, ".ai-bridge", "execution-components", "state.json")
  });
}
