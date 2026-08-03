import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import {
  AUTHORITATIVE_RUNTIME_EVENT_KINDS,
  type AuthoritativeRuntimeEventKind,
  type RuntimeActivityEventV2,
  type RuntimeActivityReplayStateV2
} from "./activityEvents.js";

interface RuntimeEventSequenceStateV1 {
  version: 1;
  next_sequence: number;
  event_count: number;
  updated_at: string;
}

export interface AppendRuntimeActivityEventInput {
  event_id?: string;
  occurred_at?: string;
  project_id?: string;
  workspace_id?: string;
  workspace_generation?: number;
  objective_id?: string | null;
  attempt_id?: string | null;
  run_id?: string | null;
  actor_id?: string | null;
  actor_role?: RuntimeActivityEventV2["actor_role"];
  kind: AuthoritativeRuntimeEventKind;
  terminal?: boolean;
  payload?: Record<string, unknown>;
}

const EVENT_KIND_SET = new Set<string>(AUTHORITATIVE_RUNTIME_EVENT_KINDS);
const TERMINAL_EVENT_KINDS = new Set<AuthoritativeRuntimeEventKind>([
  "objective.completed"
]);

function clean(value: unknown, fallback: string, max = 500): string {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, max);
}

function eventId(input: AppendRuntimeActivityEventInput, occurredAt: string): string {
  if (input.event_id?.trim()) return clean(input.event_id, "runtime-event", 300);
  const material = [
    input.kind,
    input.project_id ?? "",
    input.workspace_id ?? "",
    input.objective_id ?? "",
    input.attempt_id ?? "",
    input.run_id ?? "",
    occurredAt,
    randomUUID()
  ].join("\0");
  return `runtime:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function validEvent(value: unknown): value is RuntimeActivityEventV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<RuntimeActivityEventV2>;
  return event.version === 2
    && typeof event.event_id === "string"
    && Number.isInteger(event.sequence)
    && Number(event.sequence) >= 1
    && typeof event.occurred_at === "string"
    && Number.isFinite(Date.parse(event.occurred_at))
    && typeof event.project_id === "string"
    && typeof event.workspace_id === "string"
    && Number.isInteger(event.workspace_generation)
    && Number(event.workspace_generation) >= 1
    && EVENT_KIND_SET.has(event.kind ?? "")
    && typeof event.payload === "object"
    && event.payload !== null
    && !Array.isArray(event.payload);
}

function sanitizePayload(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const payload = value ?? {};
  const forbidden = new Set(["chain_of_thought", "reasoning", "prompt", "messages", "system_prompt", "developer_prompt"]);
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 6) return "[truncated]";
    if (Array.isArray(input)) return input.slice(0, 100).map((item) => walk(item, depth + 1));
    if (!input || typeof input !== "object") {
      return typeof input === "string" ? clean(input, "", 2_000) : input;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>).slice(0, 100)) {
      if (forbidden.has(key.toLowerCase().replace(/[-\s]/g, "_"))) continue;
      out[clean(key, "field", 120)] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(payload, 0) as Record<string, unknown>;
}

export class RuntimeActivityEventStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly guard: PathGuard, private readonly workspace: Workspace) {}

  root(): string {
    return ".codexpro/runtime-activity-events";
  }

  eventPath(sequence: number, id: string): string {
    const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
    return `${this.root()}/events/${String(sequence).padStart(16, "0")}-${digest}.json`;
  }

  async append(input: AppendRuntimeActivityEventInput): Promise<RuntimeActivityEventV2> {
    const write = async (): Promise<RuntimeActivityEventV2> => {
      const release = await this.acquireLock();
      try {
        const state = await this.readSequenceState();
        const eventsRoot = this.guard.resolve(this.workspace, `${this.root()}/events`);
        const occupiedNames = await fsp.readdir(eventsRoot.absPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [] as string[];
          throw error;
        });
        const occupiedSequences = occupiedNames
          .filter((name) => /^\d{16}-[a-f0-9]{16}\.json$/.test(name))
          .map((name) => Number(name.slice(0, 16)))
          .filter((value) => Number.isInteger(value) && value >= 1);
        const sequence = Math.max(state.next_sequence, Math.max(0, ...occupiedSequences) + 1);
        const occurredAt = input.occurred_at ?? new Date().toISOString();
        const kind = input.kind;
        if (!EVENT_KIND_SET.has(kind)) throw new Error(`Unsupported authoritative runtime event kind: ${kind}`);
        const event: RuntimeActivityEventV2 = {
          version: 2,
          event_id: eventId(input, occurredAt),
          sequence,
          occurred_at: occurredAt,
          project_id: clean(input.project_id ?? this.workspace.projectId, path.basename(this.workspace.root) || "project", 240),
          workspace_id: clean(input.workspace_id ?? this.workspace.id, this.workspace.id, 240),
          workspace_generation: Math.max(1, Math.floor(input.workspace_generation ?? this.workspace.workspaceGeneration ?? 1)),
          objective_id: input.objective_id ? clean(input.objective_id, "objective", 500) : null,
          attempt_id: input.attempt_id ? clean(input.attempt_id, "attempt", 300) : null,
          run_id: input.run_id ? clean(input.run_id, "run", 300) : null,
          actor_id: input.actor_id ? clean(input.actor_id, "actor", 300) : null,
          actor_role: input.actor_role ?? "system",
          kind,
          terminal: input.terminal === true || TERMINAL_EVENT_KINDS.has(kind),
          payload: sanitizePayload(input.payload)
        };
        // The lock plus the occupied filename scan prevents sequence reuse.
        // If the process exits after the immutable event write but before the
        // sequence state update, the next append advances from the event file.
        await this.atomicJson(this.eventPath(sequence, event.event_id), event);
        await this.atomicJson(`${this.root()}/sequence.json`, {
          version: 1,
          next_sequence: sequence + 1,
          event_count: state.event_count + 1,
          updated_at: occurredAt
        } satisfies RuntimeEventSequenceStateV1);
        return event;
      } finally {
        await release();
      }
    };
    const result = this.operationQueue.then(write, write);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return structuredClone(await result);
  }

  async list(options: { after_sequence?: number; objective_id?: string; limit?: number } = {}): Promise<RuntimeActivityEventV2[]> {
    const root = this.guard.resolve(this.workspace, `${this.root()}/events`);
    let names: string[];
    try {
      names = (await fsp.readdir(root.absPath)).filter((name) => /^\d{16}-[a-f0-9]{16}\.json$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const after = Math.max(0, Math.floor(options.after_sequence ?? 0));
    const limit = Math.max(1, Math.min(10_000, Math.floor(options.limit ?? 1_000)));
    const events: RuntimeActivityEventV2[] = [];
    for (const name of names) {
      const sequence = Number(name.slice(0, 16));
      if (sequence <= after) continue;
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(root.absPath, name), "utf8"));
        if (!validEvent(parsed)) continue;
        if (options.objective_id && parsed.objective_id !== options.objective_id) continue;
        events.push(parsed);
        if (events.length >= limit) break;
      } catch {
        // Corrupt event files remain preserved but do not participate in replay.
      }
    }
    return events;
  }

  async replay(objectiveId: string): Promise<RuntimeActivityReplayStateV2 | null> {
    return reduceRuntimeActivityEvents(await this.list({ objective_id: objectiveId, limit: 10_000 }), objectiveId);
  }

  private async readSequenceState(): Promise<RuntimeEventSequenceStateV1> {
    const target = this.guard.resolve(this.workspace, `${this.root()}/sequence.json`);
    try {
      const parsed = JSON.parse(await fsp.readFile(target.absPath, "utf8")) as Partial<RuntimeEventSequenceStateV1>;
      if (
        parsed.version === 1
        && Number.isInteger(parsed.next_sequence)
        && Number(parsed.next_sequence) >= 1
        && Number.isInteger(parsed.event_count)
        && Number(parsed.event_count) >= 0
      ) {
        return {
          version: 1,
          next_sequence: Number(parsed.next_sequence),
          event_count: Number(parsed.event_count),
          updated_at: String(parsed.updated_at ?? new Date(0).toISOString())
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Rebuild the sequence from immutable event filenames.
      }
    }
    const eventsRoot = this.guard.resolve(this.workspace, `${this.root()}/events`);
    const names = await fsp.readdir(eventsRoot.absPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const occupiedSequences = names
      .filter((name) => /^\d{16}-[a-f0-9]{16}\.json$/.test(name))
      .map((name) => Number(name.slice(0, 16)))
      .filter((sequence) => Number.isInteger(sequence) && sequence >= 1);
    return {
      version: 1,
      next_sequence: Math.max(0, ...occupiedSequences) + 1,
      event_count: occupiedSequences.length,
      updated_at: new Date().toISOString()
    };
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const target = this.guard.resolve(this.workspace, `${this.root()}/append.lock`, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await fsp.mkdir(target.absPath);
        await fsp.writeFile(path.join(target.absPath, "owner.json"), `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
        return async () => { await fsp.rm(target.absPath, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(target.absPath);
          if (Date.now() - stat.mtimeMs > 30_000) await fsp.rm(target.absPath, { recursive: true, force: true });
        } catch { /* retry */ }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the runtime activity event append lock.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async atomicJson(relativePath: string, value: unknown): Promise<void> {
    const target = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
    const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, target.absPath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function reduceRuntimeActivityEvents(
  events: readonly RuntimeActivityEventV2[],
  objectiveId?: string
): RuntimeActivityReplayStateV2 | null {
  const ordered = [...events]
    .filter((event) => !objectiveId || event.objective_id === objectiveId)
    .sort((left, right) => left.sequence - right.sequence || left.event_id.localeCompare(right.event_id));
  const first = ordered[0];
  if (!first?.objective_id) return null;
  let state: RuntimeActivityReplayStateV2 = {
    version: 2,
    objective_id: first.objective_id,
    latest_sequence: first.sequence,
    terminal_sequence: first.terminal ? first.sequence : null,
    terminal_kind: first.terminal ? first.kind : null,
    current_attempt_id: first.attempt_id,
    latest_kind: first.kind,
    updated_at: first.occurred_at
  };
  const seen = new Set<string>([first.event_id]);
  for (const event of ordered.slice(1)) {
    if (seen.has(event.event_id) || event.objective_id !== state.objective_id) continue;
    seen.add(event.event_id);
    if (event.sequence <= state.latest_sequence) continue;
    if (state.terminal_sequence !== null && !event.terminal) continue;
    state = {
      ...state,
      latest_sequence: event.sequence,
      terminal_sequence: event.terminal ? event.sequence : state.terminal_sequence,
      terminal_kind: event.terminal ? event.kind : state.terminal_kind,
      current_attempt_id: event.attempt_id ?? state.current_attempt_id,
      latest_kind: event.kind,
      updated_at: event.occurred_at
    };
  }
  return state;
}
