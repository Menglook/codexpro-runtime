import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../guard.js";
import {
  isPublicToolOutcomeV1,
  sanitizePublicToolOutcomePayload,
  upgradePublicToolOutcomeV1,
  type OfficeProjectionReceiptV1,
  type PublicToolOutcomeV1,
  type StoredPublicToolOutcomeV1
} from "./publicToolOutcome.js";

interface PublicToolOutcomeSequenceStateV1 {
  version: 1;
  next_sequence: number;
  event_count: number;
  updated_at: string;
}

export interface PublicToolOutcomeListOptions {
  after_sequence?: number;
  task_id?: string;
  actor_role?: "executor" | "reviewer" | "observer" | "system";
  limit?: number;
}

export interface PublicToolOutcomeListResultV1 {
  version: 1;
  events: StoredPublicToolOutcomeV1[];
  latest_sequence: number;
  has_more: boolean;
  next_after_sequence: number;
  revision: string;
}

export interface PublicToolOutcomeConsistencyV1 {
  version: 1;
  ok: boolean;
  event_count: number;
  latest_sequence: number;
  duplicate_event_ids: string[];
  digest_mismatches: string[];
  sequence_gaps: number[];
  invalid_files: string[];
  queued_receipts: string[];
  degraded_receipts: string[];
}

const EVENT_FILE = /^([0-9]{16})-([a-f0-9]{16})\.json$/;
const MAX_LIMIT = 200;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function safeEventKey(eventId: string): string {
  return createHash("sha256").update(eventId).digest("hex").slice(0, 32);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class PublicToolOutcomeStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: Workspace) {}

  root(): string {
    return path.join(this.workspace.root, ".codexpro", "office-tool-outcomes");
  }

  eventsDir(): string {
    return path.join(this.root(), "events");
  }

  receiptsDir(): string {
    return path.join(this.root(), "receipts");
  }

  sequencePath(): string {
    return path.join(this.root(), "sequence.json");
  }

  eventPath(sequence: number, eventId: string): string {
    return path.join(this.eventsDir(), `${String(sequence).padStart(16, "0")}-${hash(eventId).slice(0, 16)}.json`);
  }

  receiptPath(eventId: string): string {
    return path.join(this.receiptsDir(), `${safeEventKey(eventId)}.json`);
  }

  async markQueued(outcome: Pick<PublicToolOutcomeV1, "event_id" | "result_digest">): Promise<OfficeProjectionReceiptV1> {
    const existing = await this.readReceiptFile(outcome.event_id);
    if (existing) return existing;
    const queued: OfficeProjectionReceiptV1 = {
      version: 1,
      event_id: outcome.event_id,
      projection_status: "queued",
      result_digest: outcome.result_digest,
      sequence: null,
      state_authority_changed: false
    };
    await this.atomicJson(this.receiptPath(outcome.event_id), queued);
    return queued;
  }

  async append(
    input: PublicToolOutcomeV1,
    options: { projection_status?: "persisted" | "projected" } = {}
  ): Promise<{ event: StoredPublicToolOutcomeV1; appended: boolean; receipt: OfficeProjectionReceiptV1 }> {
    const write = async () => {
      const outcome = sanitizePublicToolOutcomePayload(input);
      if (!isPublicToolOutcomeV1(outcome)) throw new Error("Invalid PublicToolOutcomeV1 payload.");
      await this.ensureDirs();
      const existing = await this.readReceiptFile(outcome.event_id);
      if (existing?.sequence) {
        const event = await this.readStoredBySequence(existing.sequence);
        if (event && event.event_id === outcome.event_id) return { event, appended: false, receipt: existing };
      }
      const release = await this.acquireLock();
      try {
        const lockedExisting = await this.readReceiptFile(outcome.event_id);
        if (lockedExisting?.sequence) {
          const event = await this.readStoredBySequence(lockedExisting.sequence);
          if (event && event.event_id === outcome.event_id) return { event, appended: false, receipt: lockedExisting };
        }
        const state = await this.readSequenceState();
        const occupiedNames = (await fsp.readdir(this.eventsDir()).catch(() => [] as string[])).filter((name) => EVENT_FILE.test(name));
        const occupiedSequences = occupiedNames.map((name) => Number(name.slice(0, 16))).filter((value) => Number.isInteger(value) && value >= 1);
        const sequence = Math.max(state.next_sequence, Math.max(0, ...occupiedSequences) + 1);
        const persistedAt = new Date().toISOString();
        const event: StoredPublicToolOutcomeV1 = { ...outcome, sequence, persisted_at: persistedAt };
        await this.atomicJson(this.eventPath(sequence, outcome.event_id), event);
        const receipt: OfficeProjectionReceiptV1 = {
          version: 1,
          event_id: outcome.event_id,
          projection_status: options.projection_status ?? "persisted",
          result_digest: outcome.result_digest,
          sequence,
          state_authority_changed: false
        };
        await this.atomicJson(this.receiptPath(outcome.event_id), receipt);
        await this.atomicJson(this.sequencePath(), {
          version: 1,
          next_sequence: sequence + 1,
          event_count: state.event_count + 1,
          updated_at: persistedAt
        } satisfies PublicToolOutcomeSequenceStateV1);
        return { event, appended: true, receipt };
      } finally {
        await release();
      }
    };
    const result = this.operationQueue.then(write, write);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return clone(await result);
  }

  async markProjected(eventId: string): Promise<OfficeProjectionReceiptV1 | null> {
    const existing = await this.readReceiptFile(eventId);
    if (!existing) return null;
    if (existing.projection_status === "projected") return existing;
    const next: OfficeProjectionReceiptV1 = { ...existing, projection_status: "projected", state_authority_changed: false };
    await this.atomicJson(this.receiptPath(eventId), next);
    return next;
  }

  async markDegraded(outcome: Pick<PublicToolOutcomeV1, "event_id" | "result_digest">): Promise<OfficeProjectionReceiptV1> {
    const existing = await this.readReceiptFile(outcome.event_id);
    const next: OfficeProjectionReceiptV1 = {
      version: 1,
      event_id: outcome.event_id,
      projection_status: "degraded",
      result_digest: outcome.result_digest,
      sequence: existing?.sequence ?? null,
      state_authority_changed: false
    };
    await this.atomicJson(this.receiptPath(outcome.event_id), next);
    return next;
  }

  async receipt(eventId: string): Promise<OfficeProjectionReceiptV1 | null> {
    return clone(await this.readReceiptFile(eventId));
  }

  async list(options: PublicToolOutcomeListOptions = {}): Promise<PublicToolOutcomeListResultV1> {
    await this.ensureDirs();
    const after = Math.max(0, Math.floor(options.after_sequence ?? 0));
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit ?? 50)));
    const names = (await fsp.readdir(this.eventsDir()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })).filter((name) => EVENT_FILE.test(name)).sort();
    const events: StoredPublicToolOutcomeV1[] = [];
    let latestSequence = 0;
    let hasMore = false;
    for (const name of names) {
      const match = EVENT_FILE.exec(name);
      if (!match) continue;
      const sequence = Number(match[1]);
      latestSequence = Math.max(latestSequence, sequence);
      if (sequence <= after) continue;
      const event = await this.readStoredFile(path.join(this.eventsDir(), name));
      if (!event) continue;
      if (options.task_id && event.task_id !== options.task_id) continue;
      if (options.actor_role && event.actor_role !== options.actor_role) continue;
      if (events.length >= limit) {
        hasMore = true;
        continue;
      }
      events.push(event);
    }
    const nextAfter = events.at(-1)?.sequence ?? after;
    return {
      version: 1,
      events,
      latest_sequence: latestSequence,
      has_more: hasMore,
      next_after_sequence: nextAfter,
      revision: hash({ latest_sequence: latestSequence, selected: events.map((event) => [event.sequence, event.event_id, event.result_digest]) }).slice(0, 24)
    };
  }

  async consistency(): Promise<PublicToolOutcomeConsistencyV1> {
    await this.ensureDirs();
    const names = (await fsp.readdir(this.eventsDir()).catch(() => [] as string[])).filter((name) => EVENT_FILE.test(name)).sort();
    const seenIds = new Set<string>();
    const seenSequences = new Set<number>();
    const duplicateIds = new Set<string>();
    const digestMismatches: string[] = [];
    const invalidFiles: string[] = [];
    const queuedReceipts: string[] = [];
    const degradedReceipts: string[] = [];
    let latest = 0;
    for (const name of names) {
      const event = await this.readStoredFile(path.join(this.eventsDir(), name));
      if (!event) {
        invalidFiles.push(name);
        continue;
      }
      latest = Math.max(latest, event.sequence);
      if (seenIds.has(event.event_id)) duplicateIds.add(event.event_id);
      seenIds.add(event.event_id);
      seenSequences.add(event.sequence);
      const receipt = await this.readReceiptFile(event.event_id);
      if (!receipt || receipt.result_digest !== event.result_digest || receipt.sequence !== event.sequence) digestMismatches.push(event.event_id);
    }
    const receiptNames = (await fsp.readdir(this.receiptsDir()).catch(() => [] as string[])).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
    for (const name of receiptNames) {
      try {
        const receipt = JSON.parse(await fsp.readFile(path.join(this.receiptsDir(), name), "utf8")) as OfficeProjectionReceiptV1;
        if (receipt?.version !== 1 || typeof receipt.event_id !== "string" || receipt.state_authority_changed !== false) {
          invalidFiles.push(`receipts/${name}`);
          continue;
        }
        if (receipt.projection_status === "queued") queuedReceipts.push(receipt.event_id);
        if (receipt.projection_status === "degraded") degradedReceipts.push(receipt.event_id);
      } catch {
        invalidFiles.push(`receipts/${name}`);
      }
    }
    const gaps: number[] = [];
    for (let sequence = 1; sequence <= latest; sequence += 1) if (!seenSequences.has(sequence)) gaps.push(sequence);
    return {
      version: 1,
      ok: duplicateIds.size === 0 && digestMismatches.length === 0 && gaps.length === 0 && invalidFiles.length === 0 && queuedReceipts.length === 0 && degradedReceipts.length === 0,
      event_count: seenIds.size,
      latest_sequence: latest,
      duplicate_event_ids: [...duplicateIds],
      digest_mismatches: digestMismatches,
      sequence_gaps: gaps.slice(0, 100),
      invalid_files: invalidFiles.slice(0, 100),
      queued_receipts: queuedReceipts.slice(0, 100),
      degraded_receipts: degradedReceipts.slice(0, 100)
    };
  }

  private async readStoredBySequence(sequence: number): Promise<StoredPublicToolOutcomeV1 | null> {
    const prefix = `${String(sequence).padStart(16, "0")}-`;
    const name = (await fsp.readdir(this.eventsDir()).catch(() => [] as string[])).find((candidate) => candidate.startsWith(prefix));
    return name ? await this.readStoredFile(path.join(this.eventsDir(), name)) : null;
  }

  private async readStoredFile(filePath: string): Promise<StoredPublicToolOutcomeV1 | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as StoredPublicToolOutcomeV1;
      const upgraded = upgradePublicToolOutcomeV1(parsed);
      return upgraded && Number.isInteger(parsed.sequence) && parsed.sequence >= 1 && typeof parsed.persisted_at === "string"
        ? { ...upgraded, sequence: parsed.sequence, persisted_at: parsed.persisted_at }
        : null;
    } catch {
      return null;
    }
  }

  private async readReceiptFile(eventId: string): Promise<OfficeProjectionReceiptV1 | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.receiptPath(eventId), "utf8")) as OfficeProjectionReceiptV1;
      return parsed?.version === 1 && parsed.event_id === eventId && parsed.state_authority_changed === false ? parsed : null;
    } catch {
      return null;
    }
  }

  private async readSequenceState(): Promise<PublicToolOutcomeSequenceStateV1> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.sequencePath(), "utf8")) as Partial<PublicToolOutcomeSequenceStateV1>;
      if (parsed.version === 1 && Number.isInteger(parsed.next_sequence) && Number(parsed.next_sequence) >= 1 && Number.isInteger(parsed.event_count)) {
        return { version: 1, next_sequence: Number(parsed.next_sequence), event_count: Math.max(0, Number(parsed.event_count)), updated_at: String(parsed.updated_at ?? new Date(0).toISOString()) };
      }
    } catch {
      // Rebuild from immutable event filenames.
    }
    const names = (await fsp.readdir(this.eventsDir()).catch(() => [] as string[])).filter((name) => EVENT_FILE.test(name));
    const sequences = names.map((name) => Number(name.slice(0, 16))).filter((value) => Number.isInteger(value) && value >= 1);
    return { version: 1, next_sequence: Math.max(0, ...sequences) + 1, event_count: sequences.length, updated_at: new Date().toISOString() };
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      fsp.mkdir(this.eventsDir(), { recursive: true, mode: 0o700 }),
      fsp.mkdir(this.receiptsDir(), { recursive: true, mode: 0o700 })
    ]);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await this.ensureDirs();
    const lock = path.join(this.root(), "append.lock");
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await fsp.mkdir(lock, { mode: 0o700 });
        await fsp.writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
        return async () => { await fsp.rm(lock, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fsp.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30_000) await fsp.rm(lock, { recursive: true, force: true }).catch(() => undefined);
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the public tool outcome append lock.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async atomicJson(target: string, value: unknown): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
