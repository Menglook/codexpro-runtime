import type { OfficeObjectiveV1, OfficeZone } from "./officeProjectionService.js";

export type OfficeZoneDensityMode = "regular" | "compact" | "grouped";
export type OfficeTeamGroupAxis = "permission" | "phase";
export type OfficeTeamPermission = "read_only" | "unknown";

export interface OfficeTeamGroupV1 {
  version: 1;
  group_id: string;
  zone: OfficeZone;
  axis: OfficeTeamGroupAxis;
  axis_value: string;
  label: string;
  objective_keys: string[];
  objective_count: number;
  active_executor_count: number;
  writer_count: number;
  reader_count: number;
  incident_count: number;
  waiting_count: number;
  evidence_refs: string[];
}

export interface OfficeZoneLayoutV1 {
  version: 1;
  zone: OfficeZone;
  mode: OfficeZoneDensityMode;
  objective_count: number;
  pinned_objective_keys: string[];
  groups: OfficeTeamGroupV1[];
  collapsed_objective_count: number;
}

function clean(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function permissionFor(objective: OfficeObjectiveV1): "writer" | OfficeTeamPermission {
  const hasWriter = objective.executors.some((executor) => executor.read_write_mode === "writer")
    || objective.current_attempt?.resource?.execution_mode === "write"
    || (objective.writer_lease.state === "active" && objective.writer_lease.holder_task_id === objective.current_attempt_id);
  if (hasWriter) return "writer";
  const hasReadOnly = objective.executors.some((executor) => executor.read_write_mode === "read_only")
    || objective.current_attempt?.resource?.execution_mode === "read";
  return hasReadOnly ? "read_only" : "unknown";
}

function protectedObjective(objective: OfficeObjectiveV1): boolean {
  return objective.requires_human
    || objective.attention
    || objective.zone === "waiting_user"
    || objective.zone === "incident"
    || objective.writer_lease.state === "active"
    || objective.writer_lease.state === "queued"
    || objective.writer_lease.stale
    || objective.current_attempt?.resource?.status === "queued";
}

function groupDescriptor(objective: OfficeObjectiveV1): {
  axis: OfficeTeamGroupAxis;
  value: string;
  label: string;
} {
  const permission = permissionFor(objective);
  if (permission === "read_only") {
    return { axis: "permission", value: "read_only", label: "只读执行" };
  }
  const phase = objective.current_attempt?.phase || objective.zone;
  return { axis: "phase", value: clean(phase), label: `阶段 ${phase}` };
}

function evidenceRefs(objectives: OfficeObjectiveV1[]): string[] {
  const refs: string[] = [];
  for (const objective of objectives) {
    refs.push(...objective.executors.map((item) => item.evidence_ref ?? ""));
    refs.push(...objective.components.map((item) => item.evidence_ref ?? ""));
    refs.push(...objective.devices.map((item) => item.evidence_ref ?? ""));
    for (const node of objective.execution_graph.nodes) refs.push(...node.evidence_refs);
    for (const edge of objective.execution_graph.edges) refs.push(...edge.evidence_refs);
  }
  return [...new Set(refs.filter(Boolean))].sort().slice(0, 30);
}

function teamGroup(zone: OfficeZone, descriptor: ReturnType<typeof groupDescriptor>, objectives: OfficeObjectiveV1[]): OfficeTeamGroupV1 {
  const executorIds = new Set<string>();
  const writerIds = new Set<string>();
  const readerIds = new Set<string>();
  for (const objective of objectives) for (const executor of objective.executors) {
    if (executor.active) executorIds.add(executor.executor_id);
    if (executor.read_write_mode === "writer") writerIds.add(executor.executor_id);
    if (executor.read_write_mode === "read_only") readerIds.add(executor.executor_id);
  }
  const objectiveKeys = objectives.map((objective) => objective.stable_key).sort();
  return {
    version: 1,
    group_id: `team:${zone}:${descriptor.axis}:${clean(descriptor.value)}`,
    zone,
    axis: descriptor.axis,
    axis_value: descriptor.value,
    label: descriptor.label,
    objective_keys: objectiveKeys,
    objective_count: objectiveKeys.length,
    active_executor_count: executorIds.size,
    writer_count: writerIds.size,
    reader_count: readerIds.size,
    incident_count: objectives.filter((objective) => objective.attention || objective.zone === "incident").length,
    waiting_count: objectives.filter((objective) => objective.requires_human
      || objective.zone === "waiting_user"
      || objective.current_attempt?.resource?.status === "queued").length,
    evidence_refs: evidenceRefs(objectives)
  };
}

export function officeZoneLayout(zone: OfficeZone, objectives: OfficeObjectiveV1[]): OfficeZoneLayoutV1 {
  const objectiveCount = objectives.length;
  if (objectiveCount <= 6) {
    return { version: 1, zone, mode: "regular", objective_count: objectiveCount, pinned_objective_keys: [], groups: [], collapsed_objective_count: 0 };
  }
  if (objectiveCount <= 12) {
    return { version: 1, zone, mode: "compact", objective_count: objectiveCount, pinned_objective_keys: [], groups: [], collapsed_objective_count: 0 };
  }

  const pinned = objectives.filter(protectedObjective);
  const groupable = objectives.filter((objective) => !protectedObjective(objective));
  const grouped = new Map<string, { descriptor: ReturnType<typeof groupDescriptor>; objectives: OfficeObjectiveV1[] }>();
  for (const objective of groupable) {
    const descriptor = groupDescriptor(objective);
    const key = `${descriptor.axis}:${descriptor.value}`;
    const current = grouped.get(key) ?? { descriptor, objectives: [] };
    current.objectives.push(objective);
    grouped.set(key, current);
  }
  const groups = [...grouped.values()]
    .map((item) => teamGroup(zone, item.descriptor, item.objectives))
    .sort((left, right) => right.objective_count - left.objective_count || left.group_id.localeCompare(right.group_id));
  return {
    version: 1,
    zone,
    mode: "grouped",
    objective_count: objectiveCount,
    pinned_objective_keys: pinned.map((objective) => objective.stable_key).sort(),
    groups,
    collapsed_objective_count: groups.reduce((sum, group) => sum + group.objective_count, 0)
  };
}

export function officeZoneLayouts(zones: Record<OfficeZone, OfficeObjectiveV1[]>): Record<OfficeZone, OfficeZoneLayoutV1> {
  return Object.fromEntries(Object.entries(zones).map(([zone, objectives]) => [zone, officeZoneLayout(zone as OfficeZone, objectives)])) as Record<OfficeZone, OfficeZoneLayoutV1>;
}
