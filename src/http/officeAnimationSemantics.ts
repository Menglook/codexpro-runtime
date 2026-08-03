import type { OfficeActorPose } from "./officeSceneLayout.js";
import type {
  OfficeAnimationDurationClass,
  OfficeAnimationIntentType,
  OfficeAnimationSourceEventV1,
  OfficeAnimationZoneV1
} from "./officeAnimationIntent.js";

export const OFFICE_ANIMATION_SIGNAL_KINDS = [
  "objective_move",
  "person_follow",
  "progress",
  "human_wait",
  "queue",
  "browser",
  "acceptance",
  "writer_lease",
  "stale",
  "recovery",
  "graph_node",
  "branch",
  "parallel",
  "join",
  "git_delivery",
  "archive"
] as const;

export type OfficeAnimationSignalKind = typeof OFFICE_ANIMATION_SIGNAL_KINDS[number];

export interface OfficeAnimationSignalV1 {
  version: 1;
  kind: OfficeAnimationSignalKind;
  objective_key: string;
  project_id: string;
  entity_id: string | null;
  from_value: string | null;
  to_value: string | null;
  evidence_refs: string[];
  writer_scoped: boolean;
}

export interface OfficeAnimationSnapshotV1 {
  objective_key: string;
  project_id: string;
  zone: string;
  requires_human?: boolean;
  current_attempt?: {
    phase?: string | null;
    action?: string | null;
    progress?: { current?: number | null; total?: number | null } | null;
    liveness?: string | null;
    validation_status?: string | null;
    delivery_status?: string | null;
    resource?: {
      status?: string | null;
      queue_position?: number | null;
      blocking_reasons?: string[] | null;
    } | null;
    git?: {
      commit_status?: string | null;
      push_status?: string | null;
      delivery_status?: string | null;
      reason_code?: string | null;
    } | null;
    observability?: {
      owner_alive?: boolean | null;
      recovering?: boolean | null;
      recovery_from_run_id?: string | null;
    } | null;
  } | null;
  writer_lease?: {
    state?: string | null;
    holder_task_id?: string | null;
    fence?: number | null;
    queue_position?: number | null;
    waiting_count?: number | null;
    stale?: boolean | null;
    evidence?: string | null;
  } | null;
  executors?: Array<{
    executor_id: string;
    state?: string | null;
    current_action?: string | null;
    read_write_mode?: string | null;
    evidence_ref?: string | null;
  }>;
  components?: Array<{
    component_id: string;
    status?: string | null;
    progress_marker?: string | null;
    evidence_ref?: string | null;
  }>;
  devices?: Array<{
    device_id: string;
    device_kind: string;
    state?: string | null;
    evidence_ref?: string | null;
    evidence_source?: string | null;
  }>;
  execution_graph?: {
    authority?: string | null;
    nodes?: Array<{
      node_id: string;
      state?: string | null;
      transition_reason?: string | null;
      attempt?: number | null;
      evidence_refs?: string[];
    }>;
    edges?: Array<{
      edge_id: string;
      edge_kind?: string | null;
      selected?: boolean | null;
      relation_group?: string | null;
      dependency_satisfied?: boolean | null;
      evidence_refs?: string[];
    }>;
  } | null;
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function cleanRefs(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].slice(0, 12);
}

function signal(
  snapshot: OfficeAnimationSnapshotV1,
  kind: OfficeAnimationSignalKind,
  entityId: string | null,
  fromValue: unknown,
  toValue: unknown,
  evidenceRefs: Array<string | null | undefined>,
  writerScoped = false
): OfficeAnimationSignalV1 {
  return {
    version: 1,
    kind,
    objective_key: snapshot.objective_key,
    project_id: snapshot.project_id,
    entity_id: entityId,
    from_value: fromValue === null || fromValue === undefined ? null : stable(fromValue),
    to_value: toValue === null || toValue === undefined ? null : stable(toValue),
    evidence_refs: cleanRefs(evidenceRefs),
    writer_scoped: writerScoped
  };
}

function byId<T extends Record<string, unknown>>(values: T[] | undefined, key: keyof T): Map<string, T> {
  const output = new Map<string, T>();
  for (const value of values ?? []) {
    const id = value[key];
    if (typeof id === "string" && id) output.set(id, value);
  }
  return output;
}

function progressSignature(snapshot: OfficeAnimationSnapshotV1): string {
  return stable({
    phase: snapshot.current_attempt?.phase ?? null,
    action: snapshot.current_attempt?.action ?? null,
    step: snapshot.current_attempt?.progress?.current ?? null,
    total_steps: snapshot.current_attempt?.progress?.total ?? null,
    components: (snapshot.components ?? []).map((item) => [item.component_id, item.status ?? null, item.progress_marker ?? null]).sort(),
    graph: (snapshot.execution_graph?.nodes ?? []).map((item) => [item.node_id, item.state ?? null, item.transition_reason ?? null, item.attempt ?? null]).sort()
  });
}

function queueSignature(snapshot: OfficeAnimationSnapshotV1): string {
  return stable({
    resource_status: snapshot.current_attempt?.resource?.status ?? null,
    queue_position: snapshot.current_attempt?.resource?.queue_position ?? snapshot.writer_lease?.queue_position ?? null,
    blocking_reasons: [...(snapshot.current_attempt?.resource?.blocking_reasons ?? [])].sort(),
    waiting_count: snapshot.writer_lease?.waiting_count ?? null
  });
}

function writerSignature(snapshot: OfficeAnimationSnapshotV1): string {
  const writer = snapshot.writer_lease;
  return stable({
    state: writer?.state ?? null,
    holder_task_id: writer?.holder_task_id ?? null,
    fence: writer?.fence ?? null,
    queue_position: writer?.queue_position ?? null,
    stale: writer?.stale ?? null
  });
}

function staleSignature(snapshot: OfficeAnimationSnapshotV1): string {
  return stable({
    owner_alive: snapshot.current_attempt?.observability?.owner_alive ?? null,
    liveness: snapshot.current_attempt?.liveness ?? null,
    stale_devices: (snapshot.devices ?? []).filter((item) => item.state === "stale").map((item) => item.device_id).sort()
  });
}

function recoverySignature(snapshot: OfficeAnimationSnapshotV1): string {
  return stable({
    zone: snapshot.zone === "recovering" ? "recovering" : null,
    recovering: snapshot.current_attempt?.observability?.recovering ?? null,
    recovery_from_run_id: snapshot.current_attempt?.observability?.recovery_from_run_id ?? null
  });
}

function gitSignature(snapshot: OfficeAnimationSnapshotV1): string {
  return stable({
    validation_status: snapshot.current_attempt?.validation_status ?? null,
    delivery_status: snapshot.current_attempt?.delivery_status ?? null,
    commit_status: snapshot.current_attempt?.git?.commit_status ?? null,
    push_status: snapshot.current_attempt?.git?.push_status ?? null,
    git_delivery_status: snapshot.current_attempt?.git?.delivery_status ?? null,
    reason_code: snapshot.current_attempt?.git?.reason_code ?? null
  });
}

function deviceSignals(
  previous: OfficeAnimationSnapshotV1,
  next: OfficeAnimationSnapshotV1,
  kind: "browser" | "acceptance"
): OfficeAnimationSignalV1[] {
  const before = byId(previous.devices as Array<Record<string, unknown>> | undefined, "device_id");
  const after = byId(next.devices as Array<Record<string, unknown>> | undefined, "device_id");
  const output: OfficeAnimationSignalV1[] = [];
  for (const [id, current] of after) {
    if (current.device_kind !== kind) continue;
    const prior = before.get(id);
    const priorState = prior?.state ?? null;
    const currentState = current.state ?? null;
    if (stable(priorState) === stable(currentState)) continue;
    output.push(signal(next, kind, id, priorState, currentState, [
      typeof current.evidence_ref === "string" ? current.evidence_ref : null,
      typeof current.evidence_source === "string" ? current.evidence_source : null
    ]));
  }
  return output;
}

function graphNodeSignals(previous: OfficeAnimationSnapshotV1, next: OfficeAnimationSnapshotV1): OfficeAnimationSignalV1[] {
  const before = byId(previous.execution_graph?.nodes as Array<Record<string, unknown>> | undefined, "node_id");
  const output: OfficeAnimationSignalV1[] = [];
  for (const current of next.execution_graph?.nodes ?? []) {
    const prior = before.get(current.node_id);
    const priorValue = prior ? [prior.state ?? null, prior.transition_reason ?? null, prior.attempt ?? null] : null;
    const currentValue = [current.state ?? null, current.transition_reason ?? null, current.attempt ?? null];
    if (stable(priorValue) === stable(currentValue)) continue;
    output.push(signal(next, "graph_node", current.node_id, priorValue, currentValue, current.evidence_refs ?? []));
  }
  return output;
}

function graphEdgeSignals(previous: OfficeAnimationSnapshotV1, next: OfficeAnimationSnapshotV1): OfficeAnimationSignalV1[] {
  const before = byId(previous.execution_graph?.edges as Array<Record<string, unknown>> | undefined, "edge_id");
  const output: OfficeAnimationSignalV1[] = [];
  for (const current of next.execution_graph?.edges ?? []) {
    const prior = before.get(current.edge_id);
    if (current.edge_kind === "branch") {
      const selectedBefore = prior?.selected === true;
      if (current.selected === true && !selectedBefore) {
        output.push(signal(next, "branch", current.edge_id, selectedBefore, true, current.evidence_refs ?? []));
      }
      continue;
    }
    if (current.edge_kind === "parallel") {
      const beforeValue = prior ? [prior.relation_group ?? null, prior.dependency_satisfied ?? null] : null;
      const currentValue = [current.relation_group ?? null, current.dependency_satisfied ?? null];
      if (stable(beforeValue) !== stable(currentValue)) output.push(signal(next, "parallel", current.edge_id, beforeValue, currentValue, current.evidence_refs ?? []));
      continue;
    }
    if (current.edge_kind === "join") {
      const beforeSatisfied = prior?.dependency_satisfied === true;
      const currentSatisfied = current.dependency_satisfied === true;
      if (beforeSatisfied !== currentSatisfied) output.push(signal(next, "join", current.edge_id, beforeSatisfied, currentSatisfied, current.evidence_refs ?? []));
    }
  }
  return output;
}

export function officeAnimationSignals(
  previous: OfficeAnimationSnapshotV1 | null,
  next: OfficeAnimationSnapshotV1
): OfficeAnimationSignalV1[] {
  if (!previous) return [];
  const output: OfficeAnimationSignalV1[] = [];
  const evidenceRefs = cleanRefs([
    next.writer_lease?.evidence,
    ...(next.executors ?? []).map((item) => item.evidence_ref),
    ...(next.components ?? []).map((item) => item.evidence_ref)
  ]);

  if (previous.zone !== next.zone) {
    output.push(signal(next, "objective_move", null, previous.zone, next.zone, evidenceRefs));
    const previousExecutors = (previous.executors ?? []).map((item) => item.executor_id).sort();
    const nextExecutors = (next.executors ?? []).map((item) => item.executor_id).sort();
    if (stable(previousExecutors) === stable(nextExecutors) && nextExecutors.length > 0) {
      output.push(signal(next, "person_follow", nextExecutors.join(","), previous.zone, next.zone, evidenceRefs));
    }
  }

  if (progressSignature(previous) !== progressSignature(next)) {
    output.push(signal(next, "progress", null, progressSignature(previous), progressSignature(next), evidenceRefs));
  }

  if (previous.requires_human !== true && next.requires_human === true) {
    output.push(signal(next, "human_wait", null, false, true, evidenceRefs));
  }

  if (queueSignature(previous) !== queueSignature(next)) {
    output.push(signal(next, "queue", null, queueSignature(previous), queueSignature(next), [next.writer_lease?.evidence]));
  }

  output.push(...deviceSignals(previous, next, "browser"));
  output.push(...deviceSignals(previous, next, "acceptance"));

  if (writerSignature(previous) !== writerSignature(next)) {
    output.push(signal(next, "writer_lease", next.writer_lease?.holder_task_id ?? null, writerSignature(previous), writerSignature(next), [next.writer_lease?.evidence], true));
  }

  if (staleSignature(previous) !== staleSignature(next)) {
    output.push(signal(next, "stale", null, staleSignature(previous), staleSignature(next), evidenceRefs));
  }

  if (recoverySignature(previous) !== recoverySignature(next)) {
    output.push(signal(next, "recovery", null, recoverySignature(previous), recoverySignature(next), evidenceRefs));
  }

  output.push(...graphNodeSignals(previous, next));
  output.push(...graphEdgeSignals(previous, next));

  if (gitSignature(previous) !== gitSignature(next)) {
    output.push(signal(next, "git_delivery", null, gitSignature(previous), gitSignature(next), evidenceRefs, true));
  }

  const delivered = ["pushed", "completed", "delivered"].includes(next.current_attempt?.git?.delivery_status ?? next.current_attempt?.delivery_status ?? "");
  if (previous.zone !== "archive" && next.zone === "archive" && delivered) {
    output.push(signal(next, "archive", null, previous.zone, "archive", evidenceRefs));
  }

  return output;
}

export type OfficeAnimationIntentDeviceV1 = "analysis" | "writer" | "browser" | "acceptance" | "git" | "diagnostic" | "recovery" | "dispatch" | "archive";
export type OfficeAnimationIntentLightV1 = "cyan" | "green" | "orange" | "red" | "purple" | "neutral";

export interface OfficeAnimationIntentSemanticV1 {
  intent_type: OfficeAnimationIntentType;
  to_zone: OfficeAnimationZoneV1 | null;
  pose: OfficeActorPose | null;
  device: OfficeAnimationIntentDeviceV1 | null;
  light_tone: OfficeAnimationIntentLightV1;
  show_bubble: boolean;
  priority: number;
  duration_class: OfficeAnimationDurationClass;
}

const intentSemantic = (
  intent_type: OfficeAnimationIntentType,
  options: Partial<Omit<OfficeAnimationIntentSemanticV1, "intent_type">> = {}
): OfficeAnimationIntentSemanticV1 => ({
  intent_type,
  to_zone: options.to_zone ?? null,
  pose: options.pose ?? null,
  device: options.device ?? null,
  light_tone: options.light_tone ?? "cyan",
  show_bubble: options.show_bubble ?? false,
  priority: options.priority ?? 40,
  duration_class: options.duration_class ?? "standard"
});

function incident(device: OfficeAnimationIntentDeviceV1 = "diagnostic", failed = true): OfficeAnimationIntentSemanticV1 {
  return intentSemantic("incident_detected", {
    to_zone: "incident", pose: "incident", device,
    light_tone: failed ? "red" : "orange", show_bubble: true,
    priority: failed ? 100 : 90, duration_class: "extended"
  });
}

function taskReportIntent(kind: string): OfficeAnimationIntentSemanticV1 | null {
  switch (kind) {
    case "task_started": return intentSemantic("task_received", { to_zone: "dispatch", pose: "standing", device: "dispatch", show_bubble: true });
    case "stage_started": return intentSemantic("analysis_started", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "progress": return intentSemantic("analysis_progress", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "assistant_progress": return intentSemantic("analysis_progress", { show_bubble: true, duration_class: "extended" });
    case "assistant_summary":
    case "finding": return intentSemantic("finding_published", { show_bubble: true, duration_class: "extended", priority: 60 });
    case "warning": return incident("diagnostic", false);
    case "waiting_user": return intentSemantic("waiting_for_user", { to_zone: "waiting_user", pose: "hand_raised", light_tone: "orange", show_bubble: true, priority: 100, duration_class: "persistent" });
    case "blocked":
    case "task_failed": return { ...incident(), duration_class: "persistent" };
    case "recovery_started": return intentSemantic("recovery_started", { to_zone: "recovering", pose: "recovering", device: "recovery", light_tone: "orange", show_bubble: true, priority: 95, duration_class: "extended" });
    case "recovery_completed": return intentSemantic("recovery_completed", { to_zone: "recovering", pose: "standing", device: "recovery", light_tone: "green", show_bubble: true, priority: 90 });
    case "stage_completed": return intentSemantic("analysis_progress", { show_bubble: true, light_tone: "green" });
    case "validation_started": return intentSemantic("validation_started", { to_zone: "validation", pose: "validating", device: "acceptance", priority: 65 });
    case "validation_passed": return intentSemantic("validation_passed", { to_zone: "validation", pose: "standing", device: "acceptance", light_tone: "green", show_bubble: true, priority: 75 });
    case "validation_failed": return { ...incident("acceptance"), intent_type: "validation_failed" };
    case "artifact_created": return intentSemantic("delivery_ready", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "purple", show_bubble: true, priority: 65 });
    case "git_committed": return intentSemantic("git_committed", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "purple", show_bubble: true, priority: 75 });
    case "git_pushed": return intentSemantic("git_pushed", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "green", show_bubble: true, priority: 85 });
    case "git_failed": return incident("git");
    case "task_completed": return intentSemantic("task_completed", { to_zone: "archive", pose: "idle", device: "archive", light_tone: "green", show_bubble: true, priority: 90 });
    case "task_cancelled": return intentSemantic("task_archived", { to_zone: "archive", pose: "idle", device: "archive", light_tone: "neutral", show_bubble: true, priority: 80 });
    default: return null;
  }
}

function runtimeIntent(kind: string): OfficeAnimationIntentSemanticV1 | null {
  switch (kind) {
    case "objective.created": return intentSemantic("task_received", { to_zone: "dispatch", pose: "standing", device: "dispatch" });
    case "attempt.started":
    case "analysis.started": return intentSemantic("analysis_started", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "edit.started": return intentSemantic("write_started", { to_zone: "writer", pose: "typing", device: "writer", priority: 70 });
    case "edit.completed": return intentSemantic("write_completed", { to_zone: "writer", pose: "standing", device: "writer", light_tone: "green", priority: 70 });
    case "validation.started": return intentSemantic("validation_started", { to_zone: "validation", pose: "validating", device: "acceptance", priority: 65 });
    case "validation.passed": return intentSemantic("validation_passed", { to_zone: "validation", pose: "standing", device: "acceptance", light_tone: "green", show_bubble: true, priority: 75 });
    case "validation.failed": return { ...incident("acceptance"), intent_type: "validation_failed" };
    case "validation.blocked": return incident("acceptance", false);
    case "office.workspace_conflict": return incident();
    case "attempt.superseded": return intentSemantic("task_archived", { to_zone: "archive", pose: "idle", device: "archive", priority: 85 });
    case "objective.completed": return intentSemantic("task_completed", { to_zone: "archive", pose: "idle", device: "archive", light_tone: "green", priority: 90 });
    default: return null;
  }
}

function structuredIntent(kind: string): OfficeAnimationIntentSemanticV1 | null {
  switch (kind) {
    case "subagent.created": return intentSemantic("parallel_started", { to_zone: "dispatch", pose: "standing", device: "dispatch", priority: 65 });
    case "subagent.started": return intentSemantic("parallel_started", { to_zone: "development", pose: "sitting", device: "analysis", priority: 65 });
    case "subagent.progress":
    case "tool_completed": return intentSemantic("analysis_progress", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "tool_started": return intentSemantic("analysis_started", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "subagent.deliverable_reported": return intentSemantic("handoff_started", { to_zone: "delivery", pose: "delivering", device: "dispatch", light_tone: "purple", show_bubble: true, priority: 75 });
    case "subagent.proof_validated": return intentSemantic("handoff_completed", { to_zone: "delivery", pose: "standing", device: "dispatch", light_tone: "green", show_bubble: true, priority: 80 });
    case "subagent.completed": return intentSemantic("merge_completed", { to_zone: "delivery", pose: "standing", device: "dispatch", light_tone: "green", show_bubble: true, priority: 80 });
    case "completed": return intentSemantic("task_completed", { to_zone: "archive", pose: "idle", device: "archive", light_tone: "green", priority: 90 });
    case "subagent.proof_rejected":
    case "subagent.failed":
    case "execution.snapshot_mismatch":
    case "failed": return incident();
    case "delivery_unknown": return incident("diagnostic", false);
    default: return null;
  }
}

function publicToolIntent(event: OfficeAnimationSourceEventV1): OfficeAnimationIntentSemanticV1 | null {
  if (event.status === "failed" || event.status === "blocked") {
    return event.tool_category === "validation" ? { ...incident("acceptance", event.status === "failed"), intent_type: "validation_failed" }
      : incident(event.tool_category === "git" ? "git" : "diagnostic", event.status === "failed");
  }
  switch (event.tool_category) {
    case "read": return intentSemantic("analysis_progress", { to_zone: "development", pose: "sitting", device: "analysis" });
    case "write": return intentSemantic("write_completed", { to_zone: "writer", pose: "typing", device: "writer", light_tone: "green", priority: 70 });
    case "browser": return intentSemantic("browser_interaction", { to_zone: "browser", pose: "browsing", device: "browser", priority: 65 });
    case "validation": return intentSemantic("validation_passed", { to_zone: "validation", pose: "standing", device: "acceptance", light_tone: "green", priority: 75 });
    case "report": return intentSemantic("finding_published", { show_bubble: true, duration_class: "extended", priority: 55 });
    case "git": {
      const phase = event.phase?.toLowerCase() ?? "";
      if (phase.includes("prepare")) return intentSemantic("git_prepare", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "purple", priority: 70 });
      if (phase.includes("push")) return intentSemantic("git_pushed", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "green", show_bubble: true, priority: 85 });
      return intentSemantic("git_committed", { to_zone: "delivery", pose: "delivering", device: "git", light_tone: "purple", show_bubble: true, priority: 75 });
    }
    default: return null;
  }
}

export function resolveOfficeAnimationIntentSemantic(event: OfficeAnimationSourceEventV1): OfficeAnimationIntentSemanticV1 | null {
  if (event.source_type === "task_report_event") return taskReportIntent(event.event_kind);
  if (event.source_type === "runtime_event") return runtimeIntent(event.event_kind);
  if (event.source_type === "structured_runtime_event") return structuredIntent(event.event_kind);
  if (event.source_type === "public_tool_outcome") return publicToolIntent(event);
  return null;
}

export const OFFICE_ANIMATION_INTENT_POLICY = Object.freeze({
  version: 1 as const,
  state_authority_changed: false as const,
  inference_policy: "explicit_event_and_category_only" as const,
  unknown_event_policy: "silent" as const,
  observer_policy: "never_create_executor_motion" as const,
  coalesce_window_ms: 4_000
});
