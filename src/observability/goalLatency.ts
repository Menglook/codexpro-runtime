import type { GoalLatencyBreakdown, GoalLatencyStage, GoalLatencyState } from "../goals/types.js";

const ADDITIVE_FIELDS: Array<Exclude<keyof GoalLatencyBreakdown, "model_first_event_ms" | "orchestration_overhead_ms" | "total_ms">> = [
  "queue_ms",
  "task_compile_ms",
  "lane_decision_ms",
  "provider_probe_ms",
  "snapshot_ms",
  "context_prepare_ms",
  "model_total_ms",
  "tool_execution_ms",
  "validation_ms",
  "review_ms",
  "browser_ms",
  "report_ms"
];

export const GOAL_LATENCY_STAGE_FIELD: Record<GoalLatencyStage, keyof GoalLatencyBreakdown> = {
  queue: "queue_ms",
  task_compile: "task_compile_ms",
  lane_decision: "lane_decision_ms",
  provider_probe: "provider_probe_ms",
  snapshot: "snapshot_ms",
  context_prepare: "context_prepare_ms",
  model_total: "model_total_ms",
  tool_execution: "tool_execution_ms",
  validation: "validation_ms",
  review: "review_ms",
  browser: "browser_ms",
  report: "report_ms"
};

function timestamp(value: string | undefined, fallback = Date.now()): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function emptyGoalLatencyBreakdown(): GoalLatencyBreakdown {
  return {
    queue_ms: 0,
    task_compile_ms: 0,
    lane_decision_ms: 0,
    provider_probe_ms: 0,
    snapshot_ms: 0,
    context_prepare_ms: 0,
    model_first_event_ms: 0,
    model_total_ms: 0,
    tool_execution_ms: 0,
    validation_ms: 0,
    review_ms: 0,
    browser_ms: 0,
    report_ms: 0,
    orchestration_overhead_ms: 0,
    total_ms: 0
  };
}

export function createGoalLatencyState(startedAt = new Date().toISOString()): GoalLatencyState {
  return {
    version: 1,
    wall_clock_started_at: startedAt,
    active_stage_started_at: {},
    breakdown: emptyGoalLatencyBreakdown()
  };
}

export function normalizeGoalLatencyState(
  state: GoalLatencyState | undefined,
  fallbackStartedAt = new Date().toISOString()
): GoalLatencyState {
  const source = state?.breakdown ?? emptyGoalLatencyBreakdown();
  const breakdown = emptyGoalLatencyBreakdown();
  for (const field of Object.keys(breakdown) as Array<keyof GoalLatencyBreakdown>) {
    breakdown[field] = nonNegative(source[field]);
  }
  return {
    version: 1,
    wall_clock_started_at: state?.wall_clock_started_at ?? fallbackStartedAt,
    ...(state?.wall_clock_completed_at ? { wall_clock_completed_at: state.wall_clock_completed_at } : {}),
    active_stage_started_at: { ...(state?.active_stage_started_at ?? {}) },
    breakdown
  };
}

function refreshTotals(state: GoalLatencyState, at = new Date().toISOString()): GoalLatencyState {
  const next = normalizeGoalLatencyState(state, at);
  const end = next.wall_clock_completed_at ?? at;
  const total = Math.max(0, timestamp(end) - timestamp(next.wall_clock_started_at));
  const additive = ADDITIVE_FIELDS.reduce((sum, field) => sum + nonNegative(next.breakdown[field]), 0);
  next.breakdown.total_ms = total;
  next.breakdown.orchestration_overhead_ms = Math.max(0, total - additive);
  return next;
}

export function startGoalLatencyStage(
  state: GoalLatencyState | undefined,
  stage: GoalLatencyStage,
  at = new Date().toISOString()
): GoalLatencyState {
  const next = normalizeGoalLatencyState(state, at);
  if (!next.active_stage_started_at[stage]) next.active_stage_started_at[stage] = at;
  return refreshTotals(next, at);
}

export function completeGoalLatencyStage(
  state: GoalLatencyState | undefined,
  stage: GoalLatencyStage,
  at = new Date().toISOString()
): GoalLatencyState {
  const next = normalizeGoalLatencyState(state, at);
  const startedAt = next.active_stage_started_at[stage];
  if (startedAt) {
    const field = GOAL_LATENCY_STAGE_FIELD[stage];
    next.breakdown[field] = nonNegative(next.breakdown[field]) + Math.max(0, timestamp(at) - timestamp(startedAt));
    delete next.active_stage_started_at[stage];
  }
  return refreshTotals(next, at);
}

export function markGoalModelFirstEvent(
  state: GoalLatencyState | undefined,
  at = new Date().toISOString()
): GoalLatencyState {
  const next = normalizeGoalLatencyState(state, at);
  if (next.breakdown.model_first_event_ms > 0) return refreshTotals(next, at);
  const startedAt = next.active_stage_started_at.model_total;
  if (startedAt) next.breakdown.model_first_event_ms = Math.max(0, timestamp(at) - timestamp(startedAt));
  return refreshTotals(next, at);
}

export function finalizeGoalLatency(
  state: GoalLatencyState | undefined,
  at = new Date().toISOString()
): GoalLatencyState {
  let next = normalizeGoalLatencyState(state, at);
  for (const stage of Object.keys(next.active_stage_started_at) as GoalLatencyStage[]) {
    next = completeGoalLatencyStage(next, stage, at);
  }
  next.wall_clock_completed_at = at;
  return refreshTotals(next, at);
}

export function currentGoalLatencyBreakdown(
  state: GoalLatencyState | undefined,
  at = new Date().toISOString()
): GoalLatencyBreakdown {
  let next = normalizeGoalLatencyState(state, at);
  for (const stage of Object.keys(next.active_stage_started_at) as GoalLatencyStage[]) {
    const startedAt = next.active_stage_started_at[stage];
    if (!startedAt) continue;
    const field = GOAL_LATENCY_STAGE_FIELD[stage];
    next.breakdown[field] = nonNegative(next.breakdown[field]) + Math.max(0, timestamp(at) - timestamp(startedAt));
  }
  return refreshTotals(next, at).breakdown;
}
