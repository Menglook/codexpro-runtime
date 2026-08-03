import type { RuntimeUserActionRequiredV1 } from "../runtime/activityEvents.js";
import type { TaskObjectiveMetadataV1, TaskStatusProjection, UnifiedTaskStatus } from "./types.js";

export type ObjectiveStatus =
  | "not_started"
  | "running"
  | "waiting_user"
  | "recovering"
  | "blocked"
  | "failed"
  | "delivered"
  | "incomplete"
  | "cancelled";

export type ObjectiveAttemptSupersession = "current" | "superseded" | "historical";

export interface ObjectiveAttemptProjectionV1 {
  version: 1;
  attempt_id: string;
  objective_key: string;
  status: UnifiedTaskStatus;
  liveness: TaskStatusProjection["liveness"]["state"];
  previous_attempt_id: string | null;
  supersession: ObjectiveAttemptSupersession;
  superseded_by_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ObjectiveProjectionV1 {
  version: 1;
  objective_key: string;
  project_root: string;
  title: string;
  stage_key: string | null;
  source: TaskObjectiveMetadataV1["source"];
  status: ObjectiveStatus;
  reason_code: string;
  current_attempt_id: string | null;
  attempts: ObjectiveAttemptProjectionV1[];
  requires_human: boolean;
  user_action_required: RuntimeUserActionRequiredV1 | null;
  system_next_action: string | null;
  last_progress_at: string | null;
  created_at: string;
  updated_at: string;
}

function metadataFor(task: TaskStatusProjection): TaskObjectiveMetadataV1 {
  return task.identity.objective ?? {
    version: 1,
    objective_key: `legacy:${task.identity.kind}:${task.identity.domain_id}`,
    stage_key: null,
    previous_attempt_id: null,
    source: "legacy_single_attempt"
  };
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeLivenessTrusted(task: TaskStatusProjection): boolean {
  if (!["running", "validating", "recovering"].includes(task.status)) return false;
  if (task.liveness.state === "working") return true;
  return task.liveness.state === "silent"
    && (task.liveness.owner_alive === true || task.liveness.lease_active === true);
}

function currentAttemptPriority(task: TaskStatusProjection): number {
  if (activeLivenessTrusted(task)) {
    if (task.status === "running") return 110;
    if (task.status === "validating") return 108;
    return 106;
  }
  if (task.status === "waiting") return 104;
  if (task.status === "implemented_not_verified") return 102;
  if (task.status === "recovering") return 100;
  if (task.status === "interrupted") return 98;
  if (task.status === "blocked") return 97;
  if (task.status === "assigned") return 96;
  if (task.status === "queued") return 94;
  if (task.status === "created") return 92;
  if (task.status === "completed") return 80;
  if (task.status === "failed") return 40;
  if (task.status === "cancelled") return 20;
  return 0;
}

function compareCurrentAttempts(left: TaskStatusProjection, right: TaskStatusProjection): number {
  return currentAttemptPriority(right) - currentAttemptPriority(left)
    || timestamp(right.updated_at) - timestamp(left.updated_at)
    || timestamp(right.identity.created_at) - timestamp(left.identity.created_at)
    || left.identity.task_id.localeCompare(right.identity.task_id);
}

function explicitUserAction(task: TaskStatusProjection): RuntimeUserActionRequiredV1 | null {
  if (task.progress.user_action_required?.required === true) return task.progress.user_action_required;
  const domainStatus = String(task.domain_status ?? "").toLowerCase();
  if (!["waiting_input", "waiting_approval", "waiting_user", "awaiting_input", "awaiting_approval"].includes(domainStatus)) return null;
  const approval = domainStatus.includes("approval");
  const since = task.progress.last_meaningful_progress_at ?? task.progress.progress_at ?? task.updated_at;
  return {
    version: 1,
    required: true,
    action_type: approval ? "approve" : "provide_input",
    label: approval ? "批准或拒绝" : "补充信息",
    prompt: approval ? "任务明确等待用户批准" : "任务明确等待用户补充信息",
    since,
    evidence_ref: task.progress.last_evidence ?? null
  };
}

function humanWaitEvidence(task: TaskStatusProjection): boolean {
  return explicitUserAction(task) !== null;
}

function currentAttemptCandidates(tasks: TaskStatusProjection[]): TaskStatusProjection[] {
  const explicitlySuperseded = new Set(tasks
    .map((task) => metadataFor(task).previous_attempt_id)
    .filter((value): value is string => Boolean(value)));
  const heads = tasks.filter((task) => !explicitlySuperseded.has(task.identity.task_id));
  return heads.length ? heads : tasks;
}

function deriveObjectiveState(tasks: TaskStatusProjection[], current: TaskStatusProjection | undefined): Pick<
  ObjectiveProjectionV1,
  "status" | "reason_code" | "requires_human" | "user_action_required" | "system_next_action"
> {
  if (!current) {
    return {
      status: "not_started",
      reason_code: "no_attempt",
      requires_human: false,
      user_action_required: null,
      system_next_action: null
    };
  }
  if (current.status === "completed") {
    return {
      status: "delivered",
      reason_code: "current_attempt_delivered",
      requires_human: false,
      user_action_required: null,
      system_next_action: null
    };
  }
  if (current.status === "blocked" && humanWaitEvidence(current)) {
    return {
      status: "waiting_user",
      reason_code: "current_attempt_blocked_waiting_user",
      requires_human: true,
      user_action_required: explicitUserAction(current),
      system_next_action: null
    };
  }
  if (current.status === "blocked") {
    return {
      status: "blocked",
      reason_code: "current_attempt_blocked",
      requires_human: false,
      user_action_required: null,
      system_next_action: current.outcome.recoverable ? "evaluate_recovery" : null
    };
  }
  if (current.status === "waiting" && humanWaitEvidence(current)) {
    return {
      status: "waiting_user",
      reason_code: "current_attempt_waiting_user",
      requires_human: true,
      user_action_required: explicitUserAction(current),
      system_next_action: null
    };
  }
  if (current.status === "waiting") {
    return {
      status: "not_started",
      reason_code: "current_attempt_waiting_system",
      requires_human: false,
      user_action_required: null,
      system_next_action: "wait_for_system_or_resource"
    };
  }
  if (current.status === "implemented_not_verified") {
    return {
      status: "running",
      reason_code: "implementation_waiting_validation",
      requires_human: false,
      user_action_required: null,
      system_next_action: "run_acceptance"
    };
  }
  const previousAttemptId = metadataFor(current).previous_attempt_id;
  const previousAttempt = previousAttemptId ? tasks.find((task) => task.identity.task_id === previousAttemptId) : undefined;
  const recoveryAttempt = Boolean(previousAttempt && ["failed", "blocked", "interrupted"].includes(previousAttempt.status));
  if (recoveryAttempt && ["created", "queued", "assigned", "running", "recovering", "validating"].includes(current.status)) {
    return {
      status: "recovering",
      reason_code: "replacement_attempt_recovering",
      requires_human: false,
      user_action_required: null,
      system_next_action: null
    };
  }
  if (activeLivenessTrusted(current)) {
    return {
      status: "running",
      reason_code: "attempt_live",
      requires_human: false,
      user_action_required: null,
      system_next_action: null
    };
  }
  if (current.status === "recovering" || current.status === "interrupted") {
    return {
      status: "recovering",
      reason_code: current.status === "recovering" ? "attempt_recovering" : "attempt_interrupted",
      requires_human: false,
      user_action_required: null,
      system_next_action: "evaluate_recovery"
    };
  }
  if (current.status === "queued" || current.status === "assigned" || current.status === "created") {
    return {
      status: "not_started",
      reason_code: "attempt_queued",
      requires_human: false,
      user_action_required: null,
      system_next_action: "start_or_wait_for_executor"
    };
  }
  if (current.status === "cancelled" || tasks.every((task) => task.status === "cancelled")) {
    return {
      status: "cancelled",
      reason_code: "current_attempt_cancelled",
      requires_human: false,
      user_action_required: null,
      system_next_action: null
    };
  }
  if (current.status === "failed") {
    return {
      status: "failed",
      reason_code: "current_attempt_failed",
      requires_human: false,
      user_action_required: null,
      system_next_action: current.outcome.recoverable ? "start_recovery_attempt" : null
    };
  }
  return {
    status: "incomplete",
    reason_code: "attempts_exhausted",
    requires_human: false,
    user_action_required: null,
    system_next_action: null
  };
}

function sourcePriority(source: TaskObjectiveMetadataV1["source"]): number {
  if (source === "explicit") return 3;
  if (source === "structured_task") return 2;
  return 1;
}

function lastProgressAt(tasks: TaskStatusProjection[]): string | null {
  const values = tasks.flatMap((task) => {
    const components = task.execution_components
      ? [...Object.values(task.execution_components.model_stream), ...Object.values(task.execution_components.tool_processes), ...Object.values(task.execution_components.workers)]
      : [];
    return [
      task.progress.last_meaningful_progress_at,
      task.progress.progress_at,
      task.execution?.last_progress_at,
      ...components.map((component) => component.last_meaningful_progress_at ?? component.last_progress_at)
    ];
  }).filter((value): value is string => Boolean(value));
  return values.sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
}

export function projectObjectives(tasks: TaskStatusProjection[]): ObjectiveProjectionV1[] {
  const groups = new Map<string, TaskStatusProjection[]>();
  for (const task of tasks) {
    if (task.identity.actor?.role === "observer") continue;
    const metadata = metadataFor(task);
    const groupKey = `${task.identity.project_root}\u0000${metadata.objective_key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(task);
    groups.set(groupKey, group);
  }

  const projections: ObjectiveProjectionV1[] = [];
  for (const group of groups.values()) {
    const ranked = currentAttemptCandidates(group).sort(compareCurrentAttempts);
    const current = ranked[0];
    const chronological = [...group].sort((left, right) =>
      timestamp(left.identity.created_at) - timestamp(right.identity.created_at)
      || left.identity.task_id.localeCompare(right.identity.task_id));
    const currentMetadata = metadataFor(current);
    const metadata = chronological
      .map((task) => metadataFor(task))
      .sort((left, right) => sourcePriority(right.source) - sourcePriority(left.source))[0] ?? currentMetadata;
    const explicitSuccessor = new Map<string, string>();
    for (const task of chronological) {
      const previous = metadataFor(task).previous_attempt_id;
      if (previous) explicitSuccessor.set(previous, task.identity.task_id);
    }
    const state = deriveObjectiveState(group, current);
    const attempts = chronological.map<ObjectiveAttemptProjectionV1>((task) => {
      const isCurrent = task.identity.task_id === current.identity.task_id;
      const explicit = explicitSuccessor.get(task.identity.task_id) ?? null;
      const supersededBy = isCurrent ? null : explicit ?? current.identity.task_id;
      return {
        version: 1,
        attempt_id: task.identity.task_id,
        objective_key: metadataFor(task).objective_key,
        status: task.status,
        liveness: task.liveness.state,
        previous_attempt_id: metadataFor(task).previous_attempt_id,
        supersession: isCurrent ? "current" : supersededBy ? "superseded" : "historical",
        superseded_by_attempt_id: supersededBy,
        created_at: task.identity.created_at,
        updated_at: task.updated_at
      };
    });
    projections.push({
      version: 1,
      objective_key: currentMetadata.objective_key,
      project_root: current.identity.project_root,
      title: current.identity.title,
      stage_key: metadata.stage_key,
      source: metadata.source,
      ...state,
      current_attempt_id: current.identity.task_id,
      attempts,
      last_progress_at: lastProgressAt([current]),
      created_at: chronological[0]?.identity.created_at ?? current.identity.created_at,
      updated_at: current.updated_at
    });
  }

  return projections.sort((left, right) => objectivePriority(right) - objectivePriority(left)
    || timestamp(right.updated_at) - timestamp(left.updated_at)
    || left.objective_key.localeCompare(right.objective_key));
}

export function objectivePriority(objective: ObjectiveProjectionV1): number {
  if (objective.status === "waiting_user") return 100;
  if (objective.status === "running") return 95;
  if (objective.status === "recovering") return 90;
  if (objective.status === "blocked") return 88;
  if (objective.status === "failed") return 86;
  if (objective.status === "not_started") return 80;
  if (objective.status === "incomplete" || objective.status === "delivered") return 40;
  if (objective.status === "cancelled") return 20;
  return 10;
}

export function chooseCurrentObjective<T extends ObjectiveProjectionV1>(objectives: T[]): T | null {
  return [...objectives].sort((left, right) => objectivePriority(right) - objectivePriority(left)
    || timestamp(right.updated_at) - timestamp(left.updated_at)
    || left.objective_key.localeCompare(right.objective_key))[0] ?? null;
}
