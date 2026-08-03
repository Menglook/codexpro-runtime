import type { AttentionQueryResponse, ConsoleAttentionItemRecord } from "./attentionService.js";
import type { ObjectiveProjectionV1 } from "../tasks/objectiveProjectionService.js";
import type { TaskProjectionListObservability, TaskStatusProjection } from "../tasks/types.js";

export interface DurationDistributionV1 {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
}

export interface ControlCenterEffectMetricsV1 {
  version: 1;
  generated_at: string;
  project: string;
  sampling: {
    task_projection_duration_ms: number;
    attention_projection_duration_ms: number;
    total_duration_ms: number;
    task_count: number;
    objective_count: number;
    unresolved_attention_count: number;
    diagnostic_event_count: number;
  };
  observability: {
    bounded_timing_available: boolean;
    invocation_counts_available: boolean;
    task_projection_bounded: boolean | null;
    attention_projection_bounded: boolean | null;
    task_projection_invocations: Record<string, number>;
    attention_projection_invocations: Record<string, number>;
  };
  status_truth: {
    status_ready_ms: number;
    max_projection_age_ms: number | null;
    terminal_projection_delay: DurationDistributionV1;
    terminal_sync_target_ms: number;
    terminal_sync_target_met: boolean | null;
  };
  attention_accuracy: {
    actionable_count: number;
    valid_actionable_count: number;
    false_urgent_count: number;
    precision: number | null;
  };
  completion_proof: {
    delivered_objectives: number;
    proven_delivered_objectives: number;
    coverage: number | null;
  };
  recovery: {
    attempted_tasks: number;
    recovered_tasks: number;
    success_rate: number | null;
  };
  human_intervention: {
    total_interventions: number;
    objective_count: number;
    interventions_per_objective: number;
  };
  console_comprehension: {
    metric: "status_ready_proxy";
    status_ready_ms: number;
    human_understanding_observed: false;
    limitation: string;
  };
  cc6_d_decision: {
    transport_upgrade_triggered: boolean;
    reason_code: "projection_compute_bottleneck" | "transport_latency_dominant" | "insufficient_transport_evidence";
    reason: string;
  };
}

export interface BuildControlCenterEffectMetricsInput {
  project: string;
  generatedAt?: string;
  tasks: TaskStatusProjection[];
  objectives: ObjectiveProjectionV1[];
  attention: AttentionQueryResponse;
  taskProjectionObservability?: TaskProjectionListObservability | null;
  taskProjectionDurationMs: number;
  attentionProjectionDurationMs: number;
  totalDurationMs: number;
  transportWaitMs?: number | null;
  terminalSyncTargetMs?: number;
}

const HUMAN_ACTION_TYPES = new Set<ConsoleAttentionItemRecord["type"]>([
  "approval_required",
  "browser_authorization",
  "decision_required"
]);

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function distribution(values: number[]): DurationDistributionV1 {
  const sorted = values.map(finiteNonNegative).sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    max_ms: sorted.at(-1) ?? null
  };
}

function validHumanAttention(item: ConsoleAttentionItemRecord): boolean {
  return item.resolved_at === null
    && item.requires_human === true
    && HUMAN_ACTION_TYPES.has(item.type)
    && Boolean(item.action_code?.trim())
    && Boolean(item.objective_key?.trim())
    && Boolean(item.attempt_id?.trim());
}

function terminalTask(task: TaskStatusProjection): boolean {
  return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}

function proofVerified(task: TaskStatusProjection | undefined): boolean {
  if (!task) return false;
  if (task.completion_proof?.verified === true) return true;
  return task.acceptance.status === "passed" && task.evidence_paths.length > 0;
}

export function buildControlCenterEffectMetrics(input: BuildControlCenterEffectMetricsInput): ControlCenterEffectMetricsV1 {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedAtMs = timestamp(generatedAt) ?? Date.now();
  const taskProjectionDurationMs = finiteNonNegative(input.taskProjectionDurationMs);
  const attentionProjectionDurationMs = finiteNonNegative(input.attentionProjectionDurationMs);
  const totalDurationMs = finiteNonNegative(input.totalDurationMs);
  const targetMs = Math.max(1, Math.floor(input.terminalSyncTargetMs ?? 100));
  const taskById = new Map(input.tasks.map((task) => [task.identity.task_id, task]));

  const ages = input.tasks
    .map((task) => timestamp(task.updated_at))
    .filter((value): value is number => value !== null)
    .map((value) => Math.max(0, generatedAtMs - value));
  const terminalDelays = input.tasks
    .filter(terminalTask)
    .map((task) => {
      const completedAt = timestamp(task.execution?.core_execution_completed_at ?? task.execution?.finished_at);
      const persistedAt = timestamp(task.execution?.terminal_persisted_at);
      return completedAt === null || persistedAt === null ? null : Math.max(0, persistedAt - completedAt);
    })
    .filter((value): value is number => value !== null);
  const terminalDistribution = distribution(terminalDelays);

  const actionable = input.attention.attention.filter((item) => item.resolved_at === null);
  const validActionable = actionable.filter(validHumanAttention);
  const falseUrgentCount = Math.max(0, actionable.length - validActionable.length);

  const deliveredObjectives = input.objectives.filter((objective) => objective.status === "delivered");
  const provenDeliveredObjectives = deliveredObjectives.filter((objective) =>
    objective.attempts.some((attempt) => attempt.status === "completed" && proofVerified(taskById.get(attempt.attempt_id)))
  );

  const recoveryAttempts = input.tasks.filter((task) =>
    finiteNonNegative(task.execution?.recovery_count) > 0
    || finiteNonNegative(task.execution?.resume_count) > 0
    || Boolean(task.execution?.recovery_from_run_id)
  );
  const recoveredTasks = recoveryAttempts.filter((task) => task.status === "completed");
  const totalInterventions = input.tasks.reduce(
    (sum, task) => sum + finiteNonNegative(task.execution?.manual_intervention_count),
    0
  );

  const transportWaitMs = input.transportWaitMs === undefined || input.transportWaitMs === null
    ? null
    : finiteNonNegative(input.transportWaitMs);
  const projectionComputeBottleneck = taskProjectionDurationMs >= 1_000
    && (transportWaitMs === null || taskProjectionDurationMs >= transportWaitMs);
  const transportUpgradeTriggered = transportWaitMs !== null
    && transportWaitMs > Math.max(1_000, taskProjectionDurationMs * 2);
  const reasonCode = transportUpgradeTriggered
    ? "transport_latency_dominant"
    : projectionComputeBottleneck
      ? "projection_compute_bottleneck"
      : "insufficient_transport_evidence";
  const reason = transportUpgradeTriggered
    ? "Measured transport wait dominates projection computation; CC6-D transport work is justified."
    : projectionComputeBottleneck
      ? "Task projection computation already dominates status readiness; SSE or PWA would not remove the measured bottleneck."
      : "No measured transport-dominant latency exists, so CC6-D remains untriggered."

  return {
    version: 1,
    generated_at: generatedAt,
    project: input.project,
    sampling: {
      task_projection_duration_ms: taskProjectionDurationMs,
      attention_projection_duration_ms: attentionProjectionDurationMs,
      total_duration_ms: totalDurationMs,
      task_count: input.tasks.length,
      objective_count: input.objectives.length,
      unresolved_attention_count: input.attention.summary.unresolved_count,
      diagnostic_event_count: input.attention.summary.event_count
    },
    observability: {
      bounded_timing_available: Boolean(input.taskProjectionObservability || input.attention.projection_observability),
      invocation_counts_available: Boolean(input.taskProjectionObservability?.invocation_counts || input.attention.projection_observability?.invocation_counts),
      task_projection_bounded: input.taskProjectionObservability?.bounded ?? null,
      attention_projection_bounded: input.attention.projection_observability?.bounded ?? null,
      task_projection_invocations: input.taskProjectionObservability?.invocation_counts ?? {},
      attention_projection_invocations: input.attention.projection_observability?.invocation_counts ?? {}
    },
    status_truth: {
      status_ready_ms: taskProjectionDurationMs,
      max_projection_age_ms: ages.length ? Math.max(...ages) : null,
      terminal_projection_delay: terminalDistribution,
      terminal_sync_target_ms: targetMs,
      terminal_sync_target_met: terminalDistribution.max_ms === null ? null : terminalDistribution.max_ms <= targetMs
    },
    attention_accuracy: {
      actionable_count: actionable.length,
      valid_actionable_count: validActionable.length,
      false_urgent_count: falseUrgentCount,
      precision: ratio(validActionable.length, actionable.length)
    },
    completion_proof: {
      delivered_objectives: deliveredObjectives.length,
      proven_delivered_objectives: provenDeliveredObjectives.length,
      coverage: ratio(provenDeliveredObjectives.length, deliveredObjectives.length)
    },
    recovery: {
      attempted_tasks: recoveryAttempts.length,
      recovered_tasks: recoveredTasks.length,
      success_rate: ratio(recoveredTasks.length, recoveryAttempts.length)
    },
    human_intervention: {
      total_interventions: totalInterventions,
      objective_count: input.objectives.length,
      interventions_per_objective: input.objectives.length > 0
        ? Number((totalInterventions / input.objectives.length).toFixed(4))
        : 0
    },
    console_comprehension: {
      metric: "status_ready_proxy",
      status_ready_ms: taskProjectionDurationMs,
      human_understanding_observed: false,
      limitation: "This measures when authoritative status data becomes available, not a human cognition or usability-study result."
    },
    cc6_d_decision: {
      transport_upgrade_triggered: transportUpgradeTriggered,
      reason_code: reasonCode,
      reason
    }
  };
}
