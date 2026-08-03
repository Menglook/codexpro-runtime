import type { GoalRecord } from "../goals/types.js";
import { currentGoalLatencyBreakdown } from "../observability/goalLatency.js";
import { loopProgressFingerprint } from "../workflow/loopPolicy.js";
import type { TaskProgress } from "./jobSteps.js";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function projectGoalProgress(goal: GoalRecord): TaskProgress {
  const checkpoint = goal.checkpoint ?? {};
  const phase = stringValue(checkpoint.phase) ?? goal.status;
  const pending = stringValue(checkpoint.pending_operation);
  const recovered = checkpoint.recovery_required === true || phase.includes("recover");
  const waiting = goal.status === "waiting_input" || goal.status === "waiting_approval";
  const terminal = ["succeeded", "failed", "blocked", "cancelled"].includes(goal.status);
  const route = checkpoint.task_route && typeof checkpoint.task_route === "object"
    ? checkpoint.task_route as Record<string, unknown>
    : undefined;
  const execution = checkpoint.execution_options;
  const evidencePath = goal.validation_result?.report_path
    ?? goal.review_result?.reviewer_run_id
    ?? goal.snapshot_id
    ?? undefined;
  const providerRun = goal.checkpoint?.provider_run;
  const livenessAt = providerRun?.heartbeat_at ?? goal.updated_at;
  const progressAt = providerRun?.last_output_at ?? providerRun?.last_event_at ?? goal.updated_at;
  const waitReason = stringValue(checkpoint.recovery_reason)
    ?? stringValue(checkpoint.resource_wait_reason)
    ?? (goal.status === "waiting_input" ? "Waiting for owner input."
      : goal.status === "waiting_approval" ? "Waiting for owner approval."
        : goal.failure?.message);
  const action = pending
    ? `Running ${pending}`
    : terminal
      ? `Goal ${goal.status}`
      : waiting
        ? waitReason ?? `Goal ${goal.status}`
        : `Goal ${phase}`;
  return {
    phase,
    current_step: Math.max(1, goal.last_event_sequence),
    current_action: action,
    ...(waitReason ? { wait_reason: waitReason } : {}),
    heartbeat_at: livenessAt,
    liveness_at: livenessAt,
    progress_at: progressAt,
    progress_fingerprint: loopProgressFingerprint({
      status: goal.status,
      phase,
      changed_files: goal.changed_files,
      evidence_ids: evidencePath ? [evidencePath] : [],
      contract_version: goal.goal_contract.contract_version
    }),
    ...(evidencePath ? { last_evidence: evidencePath } : {}),
    retries: Math.max(0, numberValue(checkpoint.retry_count) ?? 0),
    writer_active: !terminal && execution?.sandbox_mode === "workspace-write",
    browser_active: !terminal && route?.requires_browser === true,
    ...(checkpoint.latency ? { latency_breakdown: currentGoalLatencyBreakdown(checkpoint.latency) } : {}),
    execution_state: terminal
      ? "terminal"
      : recovered
        ? "recovering"
        : waiting
          ? "waiting"
          : "working"
  };
}

export interface HandoffProgressInput {
  watcher_online: boolean;
  watcher_reason: string;
  heartbeat_age_ms?: number;
  heartbeat_lease_ms: number;
  heartbeat_at?: string;
  run_state?: string;
  run_id?: string;
  run_dir?: string;
  iteration?: number;
  started_at?: string;
  finished_at?: string;
  last_output_at?: string;
  executor?: string;
  failure_reason?: string;
}

export function projectHandoffProgress(input: HandoffProgressInput): TaskProgress {
  const state = input.run_state ?? "queued";
  const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(state);
  const stale = state === "running" && !input.watcher_online;
  const silent = state === "running"
    && input.watcher_online
    && typeof input.heartbeat_age_ms === "number"
    && input.heartbeat_age_ms > input.heartbeat_lease_ms;
  const waitReason = stale
    ? input.watcher_reason
    : state === "failed" || state === "timed_out"
      ? input.failure_reason ?? `Handoff ended with ${state}.`
      : undefined;
  const livenessAt = input.heartbeat_at ?? undefined;
  const progressAt = input.last_output_at ?? input.finished_at ?? input.started_at;
  return {
    phase: state === "running" ? "executing" : state,
    current_step: Math.max(1, Math.floor(input.iteration ?? 1)),
    current_action: state === "running"
      ? `Running ${input.executor ?? "handoff executor"}`
      : `Handoff ${state}`,
    ...(waitReason ? { wait_reason: waitReason } : {}),
    heartbeat_at: livenessAt ?? input.finished_at ?? input.started_at ?? "unknown",
    ...(livenessAt ? { liveness_at: livenessAt } : {}),
    ...(progressAt ? {
      progress_at: progressAt,
      progress_fingerprint: loopProgressFingerprint({
        status: state,
        phase: state === "running" ? "executing" : state,
        evidence_ids: input.run_dir ? [input.run_dir] : []
      })
    } : {}),
    ...(input.run_dir ? { last_evidence: input.run_dir } : {}),
    retries: Math.max(0, Math.floor((input.iteration ?? 1) - 1)),
    writer_active: state === "running",
    browser_active: false,
    execution_state: terminal
      ? "terminal"
      : stale
        ? "stale"
        : silent
          ? "silent"
          : state === "running"
            ? "working"
            : "queued"
  };
}
