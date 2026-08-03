import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createWorkspaceExecutionComponentStore } from "../execution/componentStore.js";
import { findSecretValues, redactSensitiveText } from "../redact.js";

export type DurableMessageStatus = "pending" | "claimed" | "delivered" | "acked" | "retry_wait" | "dead_letter";
export type DurableMessageAckOutcome = "applied" | "duplicate" | "rejected";

export interface DurableMessageEnvelope {
  version: 1;
  message_id: string;
  message_type: string;
  producer: string;
  consumer: string;
  task_id: string | null;
  run_id: string | null;
  dedupe_key: string;
  payload_ref: string | null;
  payload: Record<string, unknown> | null;
  payload_hash: string;
  created_at: string;
  available_at: string;
  attempt: number;
  max_attempts: number;
  owner_id: string | null;
  fencing_token: number | null;
  lease_expires_at: string | null;
  status: DurableMessageStatus;
  last_error: string | null;
  replay_of?: string | null;
  audit?: Record<string, unknown>;
}

export interface DurableMessageAck {
  version: 1;
  ack_id: string;
  message_id: string;
  message_type: string;
  consumer: string;
  dedupe_key: string;
  received_at: string;
  applied_at: string;
  outcome: DurableMessageAckOutcome;
  resulting_state_version: number | null;
  resulting_state_hash: string | null;
}

export interface DurableInboxEntry {
  version: 1;
  inbox_id: string;
  message_id: string;
  message_type: string;
  consumer: string;
  dedupe_key: string;
  status: "started" | "applied" | "rejected";
  received_at: string;
  applied_at: string | null;
  result_hash: string | null;
  error: string | null;
}

export interface DurableDeadLetterEntry {
  version: 1;
  message: DurableMessageEnvelope;
  dead_lettered_at: string;
  reason: string;
}

export interface DurableMessageState {
  version: 1;
  recovered_at: string;
  fencing_counter: number;
  messages: Record<string, DurableMessageEnvelope>;
  acks: Record<string, DurableMessageAck>;
  inbox: Record<string, DurableInboxEntry>;
  dead_letters: Record<string, DurableDeadLetterEntry>;
}

export interface AppendDurableMessageInput {
  message_type: string;
  producer: string;
  consumer: string;
  task_id?: string | null;
  run_id?: string | null;
  dedupe_key?: string;
  payload_ref?: string | null;
  payload?: Record<string, unknown> | null;
  available_at?: string;
  max_attempts?: number;
  message_id?: string;
  audit?: Record<string, unknown>;
}

export interface DurableMessageStoreOptions {
  root?: string;
  message_dir?: string;
  lease_ms?: number;
  backoff_base_ms?: number;
  backoff_max_ms?: number;
  max_payload_bytes?: number;
}

export interface MessageClaim {
  message: DurableMessageEnvelope;
  owner_id: string;
  fencing_token: number;
}

export interface DispatchResult<T = unknown> {
  message: DurableMessageEnvelope | null;
  ack: DurableMessageAck | null;
  duplicate: boolean;
  handled: boolean;
  dead_lettered: boolean;
  result?: T;
  error?: string;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64_000;

function timestamp(date = new Date()): string {
  return date.toISOString();
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function cleanId(value: string, label: string): string {
  const trimmed = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return trimmed;
}

function optionalString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function lineKey(consumer: string, dedupeKey: string): string {
  return `${consumer}\u0000${dedupeKey}`;
}

function ackKey(messageId: string, consumer: string): string {
  return `${consumer}\u0000${messageId}`;
}

function parseTime(value: string | null | undefined): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 8_000);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let text = "";
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${safeError(error)}`);
    }
  }
  return out;
}

export class DurableMessageStore {
  readonly messageDir: string;
  readonly leaseMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxPayloadBytes: number;

  constructor(options: DurableMessageStoreOptions = {}) {
    const root = path.resolve(options.root ?? process.cwd());
    this.messageDir = path.resolve(options.message_dir ?? path.join(root, ".ai-bridge", "messages"));
    this.leaseMs = Math.max(1, Math.min(options.lease_ms ?? DEFAULT_LEASE_MS, 24 * 60 * 60_000));
    this.backoffBaseMs = Math.max(10, Math.min(options.backoff_base_ms ?? DEFAULT_BACKOFF_BASE_MS, 60_000));
    this.backoffMaxMs = Math.max(this.backoffBaseMs, Math.min(options.backoff_max_ms ?? DEFAULT_BACKOFF_MAX_MS, 60 * 60_000));
    this.maxPayloadBytes = Math.max(1_000, Math.min(options.max_payload_bytes ?? DEFAULT_MAX_PAYLOAD_BYTES, 1_000_000));
  }

  outboxPath(): string {
    return path.join(this.messageDir, "outbox.jsonl");
  }

  inboxPath(): string {
    return path.join(this.messageDir, "inbox.jsonl");
  }

  acksPath(): string {
    return path.join(this.messageDir, "acks.jsonl");
  }

  deadLetterPath(): string {
    return path.join(this.messageDir, "dead-letter.jsonl");
  }

  statePath(): string {
    return path.join(this.messageDir, "state.json");
  }

  leasesDir(): string {
    return path.join(this.messageDir, "leases");
  }

  async append(input: AppendDurableMessageInput): Promise<DurableMessageEnvelope> {
    await this.ensureDirs();
    const now = timestamp();
    const payload = input.payload === undefined ? null : input.payload;
    const payloadRef = optionalString(input.payload_ref);
    if (!payload && !payloadRef) throw new Error("Durable message requires compact payload or payload_ref.");
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload ?? {}), "utf8");
    if (payloadBytes > this.maxPayloadBytes) throw new Error(`Durable message payload is too large (${payloadBytes} bytes); persist an artifact and use payload_ref.`);
    this.assertNoSecrets({ payload, payload_ref: payloadRef, audit: input.audit ?? null });

    const dedupeKey = input.dedupe_key?.trim()
      || sha256({
        message_type: input.message_type,
        producer: input.producer,
        consumer: input.consumer,
        task_id: input.task_id ?? null,
        run_id: input.run_id ?? null,
        payload_ref: payloadRef,
        payload_hash: sha256(payload ?? {})
      });
    const state = await this.recover();
    const existing = Object.values(state.messages).find((candidate) =>
      candidate.consumer === cleanId(input.consumer, "consumer")
      && candidate.dedupe_key === dedupeKey.slice(0, 500)
      && candidate.status !== "dead_letter"
    );
    if (existing) return clone(existing);
    const message: DurableMessageEnvelope = {
      version: 1,
      message_id: input.message_id?.trim() || randomUUID(),
      message_type: cleanId(input.message_type, "message_type"),
      producer: cleanId(input.producer, "producer"),
      consumer: cleanId(input.consumer, "consumer"),
      task_id: optionalString(input.task_id),
      run_id: optionalString(input.run_id),
      dedupe_key: dedupeKey.slice(0, 500),
      payload_ref: payloadRef,
      payload: payload ? clone(payload) : null,
      payload_hash: sha256(payload ?? payloadRef ?? {}),
      created_at: now,
      available_at: input.available_at ?? now,
      attempt: 0,
      max_attempts: Math.max(1, Math.min(Math.floor(input.max_attempts ?? 5), 100)),
      owner_id: null,
      fencing_token: null,
      lease_expires_at: null,
      status: "pending",
      last_error: null,
      ...(input.audit ? { audit: clone(input.audit) } : {})
    };
    this.assertNoSecrets(message);
    await this.appendJsonl(this.outboxPath(), message);
    state.messages[message.message_id] = message;
    await this.writeState(state);
    return clone(message);
  }

  async recover(options: { now?: Date } = {}): Promise<DurableMessageState> {
    await this.ensureDirs();
    const now = timestamp(options.now ?? new Date());
    const state = await this.readPersistedState(now);

    for (const message of await readJsonl<DurableMessageEnvelope>(this.outboxPath())) {
      if (!state.messages[message.message_id] && !state.dead_letters[message.message_id]) {
        state.messages[message.message_id] = this.normalizedMessage(message);
      }
      state.fencing_counter = Math.max(state.fencing_counter, Number(message.fencing_token) || 0);
    }
    for (const entry of await readJsonl<DurableInboxEntry>(this.inboxPath())) {
      state.inbox[lineKey(entry.consumer, entry.dedupe_key)] = entry;
    }
    for (const ack of await readJsonl<DurableMessageAck>(this.acksPath())) {
      state.acks[ackKey(ack.message_id, ack.consumer)] = ack;
      const message = state.messages[ack.message_id];
      if (message) {
        message.status = "acked";
        message.owner_id = null;
        message.fencing_token = null;
        message.lease_expires_at = null;
      }
    }
    for (const entry of await readJsonl<DurableDeadLetterEntry>(this.deadLetterPath())) {
      state.dead_letters[entry.message.message_id] = entry;
      delete state.messages[entry.message.message_id];
    }

    for (const message of Object.values(state.messages)) {
      if (message.status === "acked") continue;
      if (message.status === "dead_letter") {
        state.dead_letters[message.message_id] ??= {
          version: 1,
          message: clone(message),
          dead_lettered_at: now,
          reason: message.last_error ?? "message marked dead_letter during recovery"
        };
        delete state.messages[message.message_id];
        continue;
      }
      if (message.status === "claimed" && parseTime(message.lease_expires_at) <= Date.parse(now)) {
        message.status = "pending";
        message.owner_id = null;
        message.fencing_token = null;
        message.lease_expires_at = null;
      }
      if (message.status === "retry_wait" && parseTime(message.available_at) <= Date.parse(now)) {
        message.status = "pending";
        message.owner_id = null;
        message.fencing_token = null;
        message.lease_expires_at = null;
      }
      state.fencing_counter = Math.max(state.fencing_counter, Number(message.fencing_token) || 0);
    }
    state.recovered_at = now;
    await this.writeState(state);
    return clone(state);
  }

  async claimNext(consumer: string, ownerId: string, options: { now?: Date } = {}): Promise<MessageClaim | null> {
    const state = await this.recover(options);
    const nowMs = Date.parse(timestamp(options.now ?? new Date()));
    const candidates = Object.values(state.messages)
      .filter((message) =>
        message.consumer === consumer
        && (message.status === "pending" || message.status === "retry_wait")
        && parseTime(message.available_at) <= nowMs
      )
      .sort((a, b) => parseTime(a.available_at) - parseTime(b.available_at) || parseTime(a.created_at) - parseTime(b.created_at));
    for (const message of candidates) {
      if (message.attempt >= message.max_attempts) {
        await this.deadLetter(state, message, `attempt budget exhausted (${message.attempt}/${message.max_attempts})`);
        continue;
      }
      state.fencing_counter += 1;
      message.attempt += 1;
      message.owner_id = cleanId(ownerId, "owner_id");
      message.fencing_token = state.fencing_counter;
      message.lease_expires_at = new Date(nowMs + this.leaseMs).toISOString();
      message.status = "claimed";
      await this.writeLease(message);
      await this.writeState(state);
      return {
        message: clone(message),
        owner_id: message.owner_id,
        fencing_token: message.fencing_token
      };
    }
    await this.writeState(state);
    return null;
  }

  async claimById(messageId: string, consumer: string, ownerId: string, options: { now?: Date } = {}): Promise<MessageClaim | null> {
    const state = await this.recover(options);
    const message = state.messages[messageId];
    if (!message || message.consumer !== consumer) return null;
    const nowMs = Date.parse(timestamp(options.now ?? new Date()));
    if (message.status === "claimed" && parseTime(message.lease_expires_at) > nowMs) return null;
    if (message.status === "acked" || message.status === "dead_letter") return null;
    if (parseTime(message.available_at) > nowMs) message.available_at = new Date(nowMs).toISOString();
    if (message.attempt >= message.max_attempts) {
      await this.deadLetter(state, message, `attempt budget exhausted (${message.attempt}/${message.max_attempts})`);
      await this.writeState(state);
      return null;
    }
    state.fencing_counter += 1;
    message.attempt += 1;
    message.owner_id = cleanId(ownerId, "owner_id");
    message.fencing_token = state.fencing_counter;
    message.lease_expires_at = new Date(nowMs + this.leaseMs).toISOString();
    message.status = "claimed";
    await this.writeLease(message);
    await this.writeState(state);
    return {
      message: clone(message),
      owner_id: message.owner_id,
      fencing_token: message.fencing_token
    };
  }

  async ack(
    message: DurableMessageEnvelope,
    outcome: DurableMessageAckOutcome,
    options: {
      consumer?: string;
      resulting_state_version?: number | null;
      resulting_state_hash?: string | null;
      applied_at?: string;
    } = {}
  ): Promise<DurableMessageAck> {
    const consumer = cleanId(options.consumer ?? message.consumer, "consumer");
    const state = await this.recover();
    const key = ackKey(message.message_id, consumer);
    if (state.acks[key]) return clone(state.acks[key]);
    const current = state.messages[message.message_id];
    if (current && message.owner_id !== null && message.fencing_token !== null) {
      this.assertCurrentClaim(current, message.owner_id, Number(message.fencing_token));
    }
    const at = options.applied_at ?? timestamp();
    const ack: DurableMessageAck = {
      version: 1,
      ack_id: randomUUID(),
      message_id: message.message_id,
      message_type: message.message_type,
      consumer,
      dedupe_key: message.dedupe_key,
      received_at: message.created_at,
      applied_at: at,
      outcome,
      resulting_state_version: options.resulting_state_version ?? null,
      resulting_state_hash: options.resulting_state_hash ?? null
    };
    await this.appendJsonl(this.acksPath(), ack);
    state.acks[key] = ack;
    if (current) {
      current.status = "acked";
      current.owner_id = null;
      current.fencing_token = null;
      current.lease_expires_at = null;
      await this.removeLease(message.message_id);
    }
    await this.writeState(state);
    return clone(ack);
  }

  async nack(message: DurableMessageEnvelope, error: unknown): Promise<DurableMessageEnvelope> {
    const state = await this.recover();
    const current = state.messages[message.message_id];
    if (!current) return clone(message);
    if (message.owner_id !== null && message.fencing_token !== null) {
      this.assertCurrentClaim(current, message.owner_id, Number(message.fencing_token));
    }
    current.last_error = safeError(error);
    current.owner_id = null;
    current.fencing_token = null;
    current.lease_expires_at = null;
    await this.removeLease(current.message_id);
    if (current.attempt >= current.max_attempts) {
      await this.deadLetter(state, current, current.last_error ?? "message failed");
    } else {
      current.status = "retry_wait";
      current.available_at = new Date(Date.now() + this.backoffMs(current.attempt)).toISOString();
    }
    await this.writeState(state);
    return clone(current);
  }

  async dispatchOne<T>(
    consumer: string,
    handler: (message: DurableMessageEnvelope) => Promise<T> | T,
    options: { owner_id?: string; observe_component?: boolean } = {}
  ): Promise<DispatchResult<T>> {
    const ownerId = options.owner_id ?? `${consumer}:${process.pid}`;
    const workerId = `worker:message_dispatcher:${consumer}:${process.pid}`;
    const componentStore = createWorkspaceExecutionComponentStore(path.dirname(path.dirname(this.messageDir)));
    if (options.observe_component !== false) await componentStore.register({
      component_id: workerId,
      kind: "worker",
      owner_id: ownerId,
      state: "idle",
      progress_marker: "dispatcher_poll"
    }).catch(() => undefined);
    const claim = await this.claimNext(consumer, ownerId);
    if (!claim) {
      if (options.observe_component !== false) await componentStore.heartbeat(workerId, { kind: "worker", owner_id: ownerId }).catch(() => undefined);
      return { message: null, ack: null, duplicate: false, handled: false, dead_lettered: false };
    }
    const message = claim.message;
    try {
      await this.assertClaim(message, claim.owner_id, claim.fencing_token);
      if (options.observe_component !== false) await componentStore.progress(workerId, {
        kind: "worker",
        owner_id: ownerId,
        marker: `claimed:${message.message_type}`,
        evidence_ref: message.message_id
      }).catch(() => undefined);
      const inboxResult = await this.applyWithInbox(message, handler);
      await this.assertClaim(message, claim.owner_id, claim.fencing_token);
      const ack = await this.ack(message, inboxResult.duplicate ? "duplicate" : "applied", {
        resulting_state_hash: inboxResult.result_hash
      });
      if (options.observe_component !== false) await componentStore.progress(workerId, {
        kind: "worker",
        owner_id: ownerId,
        marker: `ack_persisted:${ack.outcome}`,
        evidence_ref: ack.ack_id
      }).catch(() => undefined);
      return {
        message,
        ack,
        duplicate: inboxResult.duplicate,
        handled: !inboxResult.duplicate,
        dead_lettered: false,
        result: inboxResult.result
      };
    } catch (error) {
      let updated: DurableMessageEnvelope;
      try {
        updated = await this.nack(message, error);
      } catch (staleError) {
        return {
          message,
          ack: null,
          duplicate: false,
          handled: false,
          dead_lettered: false,
          error: safeError(staleError)
        };
      }
      if (options.observe_component !== false) await componentStore.progress(workerId, {
        kind: "worker",
        owner_id: ownerId,
        marker: updated.status === "dead_letter" ? "dead_lettered" : "retry_scheduled",
        evidence_ref: message.message_id
      }).catch(() => undefined);
      return {
        message,
        ack: null,
        duplicate: false,
        handled: false,
        dead_lettered: updated.status === "dead_letter",
        error: safeError(error)
      };
    }
  }

  async dispatchById<T>(
    messageId: string,
    consumer: string,
    handler: (message: DurableMessageEnvelope) => Promise<T> | T,
    options: { owner_id?: string; observe_component?: boolean } = {}
  ): Promise<DispatchResult<T>> {
    const ownerId = options.owner_id ?? `${consumer}:${process.pid}`;
    const workerId = `worker:message_dispatcher:${consumer}:${process.pid}`;
    const componentStore = createWorkspaceExecutionComponentStore(path.dirname(path.dirname(this.messageDir)));
    if (options.observe_component !== false) await componentStore.register({
      component_id: workerId,
      kind: "worker",
      owner_id: ownerId,
      state: "running",
      progress_marker: `dispatch_by_id:${messageId}`
    }).catch(() => undefined);
    const claim = await this.claimById(messageId, consumer, ownerId);
    if (!claim) return { message: null, ack: null, duplicate: false, handled: false, dead_lettered: false };
    const message = claim.message;
    try {
      await this.assertClaim(message, claim.owner_id, claim.fencing_token);
      const inboxResult = await this.applyWithInbox(message, handler);
      await this.assertClaim(message, claim.owner_id, claim.fencing_token);
      const ack = await this.ack(message, inboxResult.duplicate ? "duplicate" : "applied", {
        resulting_state_hash: inboxResult.result_hash
      });
      if (options.observe_component !== false) await componentStore.progress(workerId, {
        kind: "worker",
        owner_id: ownerId,
        marker: `ack_persisted:${ack.outcome}`,
        evidence_ref: ack.ack_id
      }).catch(() => undefined);
      return {
        message,
        ack,
        duplicate: inboxResult.duplicate,
        handled: !inboxResult.duplicate,
        dead_lettered: false,
        result: inboxResult.result
      };
    } catch (error) {
      let updated: DurableMessageEnvelope;
      try {
        updated = await this.nack(message, error);
      } catch (staleError) {
        return {
          message,
          ack: null,
          duplicate: false,
          handled: false,
          dead_lettered: false,
          error: safeError(staleError)
        };
      }
      if (options.observe_component !== false) await componentStore.progress(workerId, {
        kind: "worker",
        owner_id: ownerId,
        marker: updated.status === "dead_letter" ? "dead_lettered" : "retry_scheduled",
        evidence_ref: message.message_id
      }).catch(() => undefined);
      return {
        message,
        ack: null,
        duplicate: false,
        handled: false,
        dead_lettered: updated.status === "dead_letter",
        error: safeError(error)
      };
    }
  }

  async applyWithInbox<T>(
    message: DurableMessageEnvelope,
    handler: (message: DurableMessageEnvelope) => Promise<T> | T
  ): Promise<{ duplicate: boolean; result?: T; result_hash: string | null }> {
    const key = lineKey(message.consumer, message.dedupe_key);
    let existing: DurableInboxEntry | undefined;
    for (const entry of await readJsonl<DurableInboxEntry>(this.inboxPath())) {
      if (lineKey(entry.consumer, entry.dedupe_key) === key) existing = entry;
    }
    if (existing?.status === "applied") {
      return { duplicate: true, result_hash: existing.result_hash };
    }
    const started: DurableInboxEntry = {
      version: 1,
      inbox_id: existing?.inbox_id ?? randomUUID(),
      message_id: message.message_id,
      message_type: message.message_type,
      consumer: message.consumer,
      dedupe_key: message.dedupe_key,
      status: "started",
      received_at: existing?.received_at ?? timestamp(),
      applied_at: null,
      result_hash: null,
      error: null
    };
    await this.appendJsonl(this.inboxPath(), started);
    const result = await handler(message);
    const resultHash = sha256(result ?? {});
    const applied: DurableInboxEntry = {
      ...started,
      status: "applied",
      applied_at: timestamp(),
      result_hash: resultHash
    };
    await this.appendJsonl(this.inboxPath(), applied);
    return { duplicate: false, result, result_hash: resultHash };
  }

  async replayDeadLetter(
    messageId: string,
    options: { producer?: string; consumer?: string; reason?: string; available_at?: string; max_attempts?: number } = {}
  ): Promise<DurableMessageEnvelope> {
    const state = await this.recover();
    const entry = state.dead_letters[messageId];
    if (!entry) throw new Error(`Dead-letter message not found: ${messageId}`);
    const original = entry.message;
    const replay = await this.append({
      message_type: original.message_type,
      producer: options.producer ?? `${original.producer}.dead_letter_replay`,
      consumer: options.consumer ?? original.consumer,
      task_id: original.task_id,
      run_id: original.run_id,
      dedupe_key: original.dedupe_key,
      payload_ref: original.payload_ref,
      payload: original.payload,
      available_at: options.available_at,
      max_attempts: options.max_attempts ?? original.max_attempts,
      audit: {
        replay_of: original.message_id,
        replayed_at: timestamp(),
        reason: options.reason ?? "manual dead-letter replay",
        previous_attempt: original.attempt,
        at_least_once: true
      }
    });
    replay.replay_of = original.message_id;
    replay.audit = {
      ...(replay.audit ?? {}),
      replay_of: original.message_id
    };
    const latest = await this.recover();
    latest.messages[replay.message_id] = replay;
    await this.writeState(latest);
    return clone(replay);
  }

  async assertClaim(message: DurableMessageEnvelope, ownerId: string, fencingToken: number): Promise<void> {
    let current: DurableMessageEnvelope;
    try {
      const lease = JSON.parse(await fsp.readFile(path.join(this.leasesDir(), `${message.message_id}.json`), "utf8")) as {
        owner_id?: string | null;
        fencing_token?: number | null;
        lease_expires_at?: string | null;
        attempt?: number;
      };
      current = {
        ...message,
        owner_id: lease.owner_id ?? null,
        fencing_token: lease.fencing_token ?? null,
        lease_expires_at: lease.lease_expires_at ?? null,
        attempt: Math.max(message.attempt, Number(lease.attempt) || 0),
        status: "claimed"
      };
    } catch {
      throw new Error(`Durable message ${message.message_id} is no longer claimable; stale delivery refused.`);
    }
    this.assertCurrentClaim(current, ownerId, fencingToken);
  }

  private assertCurrentClaim(message: DurableMessageEnvelope, ownerId: string | null, fencingToken: number | null): void {
    if (message.status !== "claimed" || message.owner_id !== ownerId || Number(message.fencing_token) !== fencingToken) {
      throw new Error(`Durable message ${message.message_id} owner/fencing mismatch; stale delivery refused.`);
    }
    if (!message.lease_expires_at || Date.parse(message.lease_expires_at) <= Date.now()) {
      throw new Error(`Durable message ${message.message_id} lease expired; stale delivery refused.`);
    }
  }

  private async deadLetter(state: DurableMessageState, message: DurableMessageEnvelope, reason: string): Promise<void> {
    const dead: DurableMessageEnvelope = {
      ...message,
      status: "dead_letter",
      owner_id: null,
      fencing_token: null,
      lease_expires_at: null,
      last_error: redactSensitiveText(reason).slice(0, 8_000)
    };
    const entry: DurableDeadLetterEntry = {
      version: 1,
      message: clone(dead),
      dead_lettered_at: timestamp(),
      reason: dead.last_error ?? "dead_letter"
    };
    Object.assign(message, dead);
    await this.appendJsonl(this.deadLetterPath(), entry);
    state.dead_letters[message.message_id] = entry;
    delete state.messages[message.message_id];
    await this.removeLease(message.message_id);
  }

  private normalizedMessage(message: DurableMessageEnvelope): DurableMessageEnvelope {
    return {
      ...message,
      version: 1,
      task_id: message.task_id ?? null,
      run_id: message.run_id ?? null,
      payload_ref: message.payload_ref ?? null,
      payload: message.payload ?? null,
      owner_id: message.owner_id ?? null,
      fencing_token: message.fencing_token ?? null,
      lease_expires_at: message.lease_expires_at ?? null,
      status: message.status ?? "pending",
      attempt: Math.max(0, Math.floor(Number(message.attempt) || 0)),
      max_attempts: Math.max(1, Math.floor(Number(message.max_attempts) || 1)),
      last_error: message.last_error ?? null,
      payload_hash: message.payload_hash || sha256(message.payload ?? message.payload_ref ?? {})
    };
  }

  private backoffMs(attempt: number): number {
    const exponent = Math.max(0, Math.min(20, attempt - 1));
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** exponent);
  }

  private async ensureDirs(): Promise<void> {
    await fsp.mkdir(this.leasesDir(), { recursive: true, mode: 0o700 });
  }

  private async appendJsonl(filePath: string, value: unknown): Promise<void> {
    this.assertNoSecrets(value);
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private async readPersistedState(now: string): Promise<DurableMessageState> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.statePath(), "utf8")) as DurableMessageState;
      if (parsed?.version === 1 && parsed.messages && parsed.acks && parsed.inbox && parsed.dead_letters) {
        return parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { version: 1, recovered_at: now, fencing_counter: 0, messages: {}, acks: {}, inbox: {}, dead_letters: {} };
  }

  private async writeState(state: DurableMessageState): Promise<void> {
    await this.ensureDirs();
    const target = this.statePath();
    const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, target);
  }

  private async writeLease(message: DurableMessageEnvelope): Promise<void> {
    const target = path.join(this.leasesDir(), `${message.message_id}.json`);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, `${JSON.stringify({
      version: 1,
      message_id: message.message_id,
      owner_id: message.owner_id,
      fencing_token: message.fencing_token,
      lease_expires_at: message.lease_expires_at,
      attempt: message.attempt
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, target);
  }

  private async removeLease(messageId: string): Promise<void> {
    await fsp.rm(path.join(this.leasesDir(), `${messageId}.json`), { force: true }).catch(() => undefined);
  }

  private assertNoSecrets(value: unknown): void {
    const serialized = JSON.stringify(value ?? {});
    const findings = findSecretValues(serialized, { path: path.join(this.messageDir, "message.json") });
    if (findings.length) {
      throw new Error(`Durable message contains ${findings.length} secret-like value(s); persist a redacted artifact reference instead.`);
    }
  }
}

export function createWorkspaceMessageStore(root: string, options: Omit<DurableMessageStoreOptions, "root"> = {}): DurableMessageStore {
  return new DurableMessageStore({ root, ...options });
}

export function appendDurableMessageSync(root: string, input: AppendDurableMessageInput): DurableMessageEnvelope {
  const store = new DurableMessageStore({ root });
  fs.mkdirSync(store.messageDir, { recursive: true, mode: 0o700 });
  const now = timestamp();
  const payload = input.payload === undefined ? null : input.payload;
  const payloadRef = optionalString(input.payload_ref);
  if (!payload && !payloadRef) throw new Error("Durable message requires compact payload or payload_ref.");
  const message: DurableMessageEnvelope = {
    version: 1,
    message_id: input.message_id?.trim() || randomUUID(),
    message_type: cleanId(input.message_type, "message_type"),
    producer: cleanId(input.producer, "producer"),
    consumer: cleanId(input.consumer, "consumer"),
    task_id: optionalString(input.task_id),
    run_id: optionalString(input.run_id),
    dedupe_key: (input.dedupe_key?.trim() || sha256(input)).slice(0, 500),
    payload_ref: payloadRef,
    payload: payload ? clone(payload) : null,
    payload_hash: sha256(payload ?? payloadRef ?? {}),
    created_at: now,
    available_at: input.available_at ?? now,
    attempt: 0,
    max_attempts: Math.max(1, Math.min(Math.floor(input.max_attempts ?? 5), 100)),
    owner_id: null,
    fencing_token: null,
    lease_expires_at: null,
    status: "pending",
    last_error: null,
    ...(input.audit ? { audit: clone(input.audit) } : {})
  };
  const findings = findSecretValues(JSON.stringify(message), { path: path.join(store.messageDir, "message.json") });
  if (findings.length) throw new Error("Durable message contains secret-like value(s).");
  fs.appendFileSync(store.outboxPath(), `${JSON.stringify(message)}\n`, { encoding: "utf8", mode: 0o600 });
  return clone(message);
}
