import type { OfficeAnimationIntentV1 } from "./officeAnimationIntent.js";

export type OfficeSceneDirectorEventKind = "started" | "completed" | "interrupted" | "dropped" | "settled";

export interface OfficeSceneDirectorEventV1 {
  version: 1;
  kind: OfficeSceneDirectorEventKind;
  actor_id: string;
  intent: OfficeAnimationIntentV1 | null;
  reason: string;
  occurred_at: string;
  state_authority_changed: false;
}

export interface OfficeSceneDirectorActorSnapshotV1 {
  version: 1;
  actor_id: string;
  active_intent_id: string | null;
  active_intent_type: OfficeAnimationIntentV1["intent_type"] | null;
  queued_intent_ids: string[];
  stable_pose: string;
  paused: boolean;
  state_authority_changed: false;
}

export interface OfficeSceneDirectorDiagnosticsV1 {
  version: 1;
  actor_count: number;
  active_count: number;
  queued_count: number;
  seen_count: number;
  dropped_count: number;
  interrupted_count: number;
  paused: boolean;
  state_authority_changed: false;
}

interface ActiveIntent {
  intent: OfficeAnimationIntentV1;
  started_at_ms: number;
  ends_at_ms: number | null;
}

interface ActorChannel {
  actor_id: string;
  active: ActiveIntent | null;
  queue: OfficeAnimationIntentV1[];
  stable_pose: string;
}

export interface OfficeSceneDirectorOptions {
  max_queue_per_actor?: number;
  max_seen_intents?: number;
  now?: () => number;
  on_event?: (event: OfficeSceneDirectorEventV1) => void;
}

const DURATION_MS = Object.freeze({ quick: 2_600, standard: 6_000, extended: 14_000 });
const INTERRUPTING_TYPES = new Set<OfficeAnimationIntentV1["intent_type"]>([
  "waiting_for_user", "incident_detected", "recovery_started", "validation_failed"
]);
const TERMINAL_TYPES = new Set<OfficeAnimationIntentV1["intent_type"]>([
  "task_completed", "task_archived", "git_pushed", "recovery_completed"
]);

function intentEndsAt(intent: OfficeAnimationIntentV1, startedAtMs: number): number | null {
  if (intent.duration_class === "persistent") return null;
  const explicit = intent.expires_at ? Date.parse(intent.expires_at) : Number.NaN;
  if (Number.isFinite(explicit) && explicit > startedAtMs) return explicit;
  return startedAtMs + DURATION_MS[intent.duration_class];
}

function stablePoseFor(intent: OfficeAnimationIntentV1): string {
  if (intent.intent_type === "waiting_for_user") return "hand_raised";
  if (intent.intent_type === "incident_detected" || intent.intent_type === "validation_failed") return "incident";
  if (intent.intent_type === "recovery_started") return "recovering";
  if (intent.intent_type === "task_completed" || intent.intent_type === "task_archived") return "idle";
  return intent.pose ?? "standing";
}

function isExpired(intent: OfficeAnimationIntentV1, nowMs: number): boolean {
  return Boolean(intent.expires_at && Date.parse(intent.expires_at) <= nowMs);
}

export class OfficeSceneDirector {
  readonly #channels = new Map<string, ActorChannel>();
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  readonly #maxQueue: number;
  readonly #maxSeen: number;
  readonly #now: () => number;
  readonly #onEvent?: (event: OfficeSceneDirectorEventV1) => void;
  #paused = false;
  #dropped = 0;
  #interrupted = 0;

  constructor(options: OfficeSceneDirectorOptions = {}) {
    this.#maxQueue = Math.max(1, Math.min(32, options.max_queue_per_actor ?? 8));
    this.#maxSeen = Math.max(32, Math.min(8_192, options.max_seen_intents ?? 2_048));
    this.#now = options.now ?? Date.now;
    this.#onEvent = options.on_event;
  }

  enqueue(intent: OfficeAnimationIntentV1): boolean {
    if (intent.state_authority_changed !== false || this.#seen.has(intent.intent_id)) return false;
    const nowMs = this.#now();
    this.#remember(intent.intent_id);
    if (isExpired(intent, nowMs)) {
      this.#drop(intent, "expired_before_enqueue", nowMs);
      return false;
    }
    const channel = this.#channel(intent.actor_id);
    const interrupting = INTERRUPTING_TYPES.has(intent.intent_type) || intent.priority >= 90;
    if (channel.active && interrupting && intent.priority >= channel.active.intent.priority) {
      this.#emit("interrupted", channel.actor_id, channel.active.intent, `interrupted_by:${intent.intent_type}`, nowMs);
      channel.active = null;
      channel.queue = channel.queue.filter((queued) => queued.priority >= intent.priority);
      this.#interrupted += 1;
    }
    const duplicateQueued = channel.queue.some((queued) => queued.event_id === intent.event_id && queued.source_sequence === intent.source_sequence);
    if (duplicateQueued) return false;
    channel.queue.push(intent);
    channel.queue.sort((left, right) => right.priority - left.priority || left.source_sequence - right.source_sequence || left.intent_id.localeCompare(right.intent_id));
    while (channel.queue.length > this.#maxQueue) {
      const dropped = channel.queue.pop();
      if (dropped) this.#drop(dropped, "queue_capacity", nowMs);
    }
    if (!this.#paused) this.tick(nowMs);
    return true;
  }

  enqueueMany(intents: readonly OfficeAnimationIntentV1[]): number {
    let accepted = 0;
    for (const intent of intents) if (this.enqueue(intent)) accepted += 1;
    return accepted;
  }

  tick(nowMs = this.#now()): OfficeSceneDirectorActorSnapshotV1[] {
    if (this.#paused) return this.snapshot();
    for (const channel of this.#channels.values()) {
      if (channel.active?.ends_at_ms !== null && channel.active && channel.active.ends_at_ms <= nowMs) {
        const completed = channel.active.intent;
        channel.stable_pose = stablePoseFor(completed);
        channel.active = null;
        this.#emit("completed", channel.actor_id, completed, "duration_complete", nowMs);
        if (TERMINAL_TYPES.has(completed.intent_type)) {
          channel.queue = channel.queue.filter((intent) => intent.priority >= 90 && !isExpired(intent, nowMs));
          this.#emit("settled", channel.actor_id, completed, "terminal_stable_pose", nowMs);
        }
      }
      channel.queue = channel.queue.filter((intent) => {
        if (!isExpired(intent, nowMs)) return true;
        this.#drop(intent, "expired_in_queue", nowMs);
        return false;
      });
      if (!channel.active) {
        const next = channel.queue.shift();
        if (next) {
          channel.active = { intent: next, started_at_ms: nowMs, ends_at_ms: intentEndsAt(next, nowMs) };
          channel.stable_pose = stablePoseFor(next);
          this.#emit("started", channel.actor_id, next, "queue_start", nowMs);
        }
      }
    }
    return this.snapshot();
  }

  pause(): void {
    this.#paused = true;
  }

  resume(options: { drop_queued?: boolean; now_ms?: number } = {}): OfficeSceneDirectorActorSnapshotV1[] {
    const nowMs = options.now_ms ?? this.#now();
    this.#paused = false;
    for (const channel of this.#channels.values()) {
      if (options.drop_queued) channel.queue = [];
      if (channel.active && (isExpired(channel.active.intent, nowMs) || channel.active.ends_at_ms !== null && channel.active.ends_at_ms <= nowMs)) {
        channel.active = null;
      }
    }
    return this.tick(nowMs);
  }

  settleActor(actorId: string, pose = "idle", reason = "snapshot_settle"): void {
    const channel = this.#channels.get(actorId);
    if (!channel) return;
    channel.active = null;
    channel.queue = [];
    channel.stable_pose = pose;
    this.#emit("settled", actorId, null, reason, this.#now());
  }

  removeActor(actorId: string): void {
    this.#channels.delete(actorId);
  }

  reset(): void {
    this.#channels.clear();
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#dropped = 0;
    this.#interrupted = 0;
    this.#paused = false;
  }

  snapshot(): OfficeSceneDirectorActorSnapshotV1[] {
    return [...this.#channels.values()].map((channel) => ({
      version: 1,
      actor_id: channel.actor_id,
      active_intent_id: channel.active?.intent.intent_id ?? null,
      active_intent_type: channel.active?.intent.intent_type ?? null,
      queued_intent_ids: channel.queue.map((intent) => intent.intent_id),
      stable_pose: channel.stable_pose,
      paused: this.#paused,
      state_authority_changed: false
    }));
  }

  diagnostics(): OfficeSceneDirectorDiagnosticsV1 {
    let active = 0;
    let queued = 0;
    for (const channel of this.#channels.values()) {
      if (channel.active) active += 1;
      queued += channel.queue.length;
    }
    return {
      version: 1,
      actor_count: this.#channels.size,
      active_count: active,
      queued_count: queued,
      seen_count: this.#seen.size,
      dropped_count: this.#dropped,
      interrupted_count: this.#interrupted,
      paused: this.#paused,
      state_authority_changed: false
    };
  }

  #channel(actorId: string): ActorChannel {
    let channel = this.#channels.get(actorId);
    if (!channel) {
      channel = { actor_id: actorId, active: null, queue: [], stable_pose: "idle" };
      this.#channels.set(actorId, channel);
    }
    return channel;
  }

  #remember(intentId: string): void {
    this.#seen.add(intentId);
    this.#seenOrder.push(intentId);
    while (this.#seenOrder.length > this.#maxSeen) {
      const removed = this.#seenOrder.shift();
      if (removed) this.#seen.delete(removed);
    }
  }

  #drop(intent: OfficeAnimationIntentV1, reason: string, nowMs: number): void {
    this.#dropped += 1;
    this.#emit("dropped", intent.actor_id, intent, reason, nowMs);
  }

  #emit(kind: OfficeSceneDirectorEventKind, actorId: string, intent: OfficeAnimationIntentV1 | null, reason: string, nowMs: number): void {
    this.#onEvent?.({
      version: 1,
      kind,
      actor_id: actorId,
      intent,
      reason,
      occurred_at: new Date(nowMs).toISOString(),
      state_authority_changed: false
    });
  }
}
