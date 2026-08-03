import type { CodexNormalizedEvent, CodexRun } from "../codex/types.js";
import {
  explicitModelUserAction,
  safePublicModelActivitySummary
} from "../runtime/activityEvents.js";
import { createWorkspaceExecutionComponentStore } from "./componentStore.js";

function componentId(runId: string): string {
  return `model_stream:${runId}`;
}

function ownerId(run: CodexRun): string | null {
  return run.owner_token ?? (run.owner_pid ? `pid:${run.owner_pid}` : null);
}

function expectedSilenceUntil(): string {
  return new Date(Date.now() + 24 * 60 * 60_000).toISOString();
}

const MODEL_COMPONENT_WRITE_INTERVAL_MS = 1_000;
const lastWriteAt = new Map<string, number>();
const pendingWrites = new Map<string, { timer: NodeJS.Timeout; operation: () => Promise<unknown> }>();

function noProgressDeadline(run: CodexRun): string | null {
  return run.no_progress_deadline ?? null;
}

function hardDeadline(run: CodexRun): string | null {
  return run.hard_deadline ?? null;
}

function observe(operation: Promise<unknown>): void {
  operation.catch(() => undefined);
}

function writeKey(run: CodexRun): string {
  return `${run.working_directory}\u0000${componentId(run.run_id)}`;
}

function scheduleWrite(run: CodexRun, operation: () => Promise<unknown>): void {
  const key = writeKey(run);
  const now = Date.now();
  const elapsed = now - (lastWriteAt.get(key) ?? 0);
  const pending = pendingWrites.get(key);
  if (!pending && elapsed >= MODEL_COMPONENT_WRITE_INTERVAL_MS) {
    lastWriteAt.set(key, now);
    observe(operation());
    return;
  }
  if (pending) {
    pending.operation = operation;
    return;
  }
  const entry = {
    timer: undefined as unknown as NodeJS.Timeout,
    operation
  };
  entry.timer = setTimeout(() => {
    pendingWrites.delete(key);
    lastWriteAt.set(key, Date.now());
    observe(entry.operation());
  }, Math.max(1, MODEL_COMPONENT_WRITE_INTERVAL_MS - elapsed));
  entry.timer.unref();
  pendingWrites.set(key, entry);
}

function writeImmediately(run: CodexRun, operation: () => Promise<unknown>, terminal = false): void {
  const key = writeKey(run);
  const pending = pendingWrites.get(key);
  if (pending) clearTimeout(pending.timer);
  pendingWrites.delete(key);
  lastWriteAt.set(key, Date.now());
  observe(operation());
  if (terminal) lastWriteAt.delete(key);
}

export function registerModelStreamComponent(run: CodexRun, marker = "stream_registered"): void {
  const store = createWorkspaceExecutionComponentStore(run.working_directory);
  observe(store.register({
    component_id: componentId(run.run_id),
    kind: "model_stream",
    task_id: null,
    run_id: run.run_id,
    owner_id: ownerId(run),
    fencing_token: run.fencing_token ?? null,
    state: run.status === "queued" ? "registered" : "running",
    no_progress_deadline: noProgressDeadline(run),
    hard_deadline: hardDeadline(run),
    progress_marker: marker,
    activity_state: run.status === "queued" ? "idle_between_steps" : "model_active",
    safe_summary: run.status === "queued" ? "模型任务已登记，等待启动" : "模型响应已开始",
    evidence_ref: `${run.provider}:${run.run_id}`
  }));
}

export function recordModelProviderHeartbeat(run: CodexRun): void {
  scheduleWrite(run, async () => await createWorkspaceExecutionComponentStore(run.working_directory).heartbeat(componentId(run.run_id), {
      kind: "model_stream",
      owner_id: ownerId(run),
      fencing_token: run.fencing_token ?? null,
      at: run.heartbeat_at ?? new Date().toISOString()
    }));
}

export function recordModelStreamEvent(run: CodexRun, event: CodexNormalizedEvent): void {
  const store = createWorkspaceExecutionComponentStore(run.working_directory);
  const owner_id = ownerId(run);
  const fencing_token = run.fencing_token ?? null;
  const id = componentId(run.run_id);
  const evidenceRef = `${run.provider}:${run.run_id}:${event.sequence}`;
  const safeSummary = safePublicModelActivitySummary(event.type, event.data);
  if (event.type === "task.waiting_input" || event.type === "task.waiting_approval") {
    const userAction = explicitModelUserAction(event.type, event.data, event.timestamp, evidenceRef);
    writeImmediately(run, async () => await store.expectedSilence(id, {
      kind: "model_stream",
      owner_id,
      fencing_token,
      at: event.timestamp,
      until: expectedSilenceUntil(),
      reason: safeSummary,
      user_action_required: userAction
    }));
    return;
  }
  if (event.type === "task.succeeded" || event.type === "task.failed" || event.type === "task.cancelled") {
    writeImmediately(run, async () => await store.terminal(id, {
      kind: "model_stream",
      owner_id,
      fencing_token,
      at: event.timestamp,
      reason: safeSummary,
      evidence_ref: evidenceRef
    }), true);
    return;
  }
  if (event.type === "task.output" || event.type === "task.tool_called" || event.type === "task.checkpointed" || event.type === "task.started") {
    scheduleWrite(run, async () => await store.progress(id, {
      kind: "model_stream",
      owner_id,
      fencing_token,
      at: event.timestamp,
      marker: safeSummary,
      activity_state: "model_active",
      safe_summary: safeSummary,
      user_action_required: null,
      meaningful_progress: true,
      evidence_ref: evidenceRef,
      no_progress_deadline: noProgressDeadline(run)
    }));
    return;
  }
  scheduleWrite(run, async () => await store.heartbeat(id, {
    kind: "model_stream",
    owner_id,
    fencing_token,
    at: event.timestamp
  }));
}
