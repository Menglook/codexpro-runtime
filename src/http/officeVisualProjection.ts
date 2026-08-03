import { createHash } from "node:crypto";
import type { RuntimeActivityState } from "../runtime/activityEvents.js";
import type { OfficeExecutionRelationKind, OfficeRouteSource } from "./officeGraphSemantics.js";
import { officeAgentIdentity, type OfficeAgentIdentityV1 } from "./officeSceneAgentIdentity.js";
import { plainCurrentWork, plainExecutorName } from "./officePlainLanguage.js";
import {
  OFFICE_SCENE_STATIONS,
  deterministicStation,
  type OfficeActorPose,
  type OfficeSceneStationV1
} from "./officeSceneLayout.js";
import {
  OFFICE_ZONES,
  type OfficeActivityState,
  type OfficeDeviceV1,
  type OfficeExecutorV1,
  type OfficeObjectiveV1,
  type OfficeProjectFloorV1,
  type OfficeProjectionV1,
  type OfficeZone
} from "./officeProjectionService.js";

export type OfficeVisualZoneV1 = OfficeZone | "writer_queue" | "writer";

export interface OfficeActorSnapshotV1 {
  version: 1;
  actor_id: string;
  persona_id: string;
  identity: OfficeAgentIdentityV1;
  project_id: string;
  objective_key: string;
  task_id: string;
  executor_id: string;
  label: string;
  zone_id: OfficeVisualZoneV1;
  station_id: string;
  x: number;
  y: number;
  z_index: number;
  pose: OfficeActorPose;
  action: string | null;
  recent_activity_action: string | null;
  recent_activity_completed_at: string | null;
  recent_activity_until: string | null;
  activity_state: RuntimeActivityState;
  browser_active: boolean;
  validation_active: boolean;
  writer_active: boolean;
  evidence_ref: string | null;
}

export interface OfficeVisualDeviceSnapshotV1 {
  version: 1;
  device_id: string;
  project_id: string;
  objective_key: string;
  task_id: string;
  device_kind: OfficeDeviceV1["device_kind"];
  label: string;
  state: OfficeActivityState;
  actor_ids: string[];
  evidence_source: string;
  evidence_ref: string | null;
  details: string;
}

export type OfficeVisualRelationKindV1 = OfficeExecutionRelationKind | "parent_child";

export interface OfficeVisualRelationSnapshotV1 {
  version: 1;
  relation_id: string;
  project_id: string;
  objective_key: string;
  from_actor_id: string;
  to_actor_id: string;
  relation_kind: OfficeVisualRelationKindV1;
  relation_group: string | null;
  route_source: OfficeRouteSource;
  transition_reason: string | null;
  dependency_satisfied: boolean | null;
  evidence_refs: string[];
  state_authority_changed: false;
}

export interface OfficeProjectVisualSnapshotV1 {
  version: 1;
  project_id: string;
  project_name: string;
  projection_revision: string;
  actors: OfficeActorSnapshotV1[];
  devices: OfficeVisualDeviceSnapshotV1[];
  relations: OfficeVisualRelationSnapshotV1[];
  folded_actor_counts: Partial<Record<OfficeVisualZoneV1, number>>;
}

export interface OfficeVisualSnapshotV1 {
  version: 1;
  generated_at: string;
  projection_revision: string;
  projection_id: string;
  source: "office_projection_derived";
  projects: OfficeProjectVisualSnapshotV1[];
}

export interface OfficeVisualProjectionOptions {
  actor_limit?: number;
  zone_actor_limit?: number;
}

interface ActorCandidate {
  actor_id: string;
  persona_id: string;
  identity: OfficeAgentIdentityV1;
  project: OfficeProjectFloorV1;
  objective: OfficeObjectiveV1;
  executor: OfficeExecutorV1;
  zone_id: OfficeVisualZoneV1;
  pose: OfficeActorPose;
  task_id: string;
}

const VISUAL_ZONE_PRIORITY: Record<OfficeVisualZoneV1, number> = {
  waiting_user: 0,
  incident: 1,
  recovering: 2,
  validation: 3,
  browser: 4,
  writer: 5,
  writer_queue: 6,
  development: 7,
  delivery: 8,
  dispatch: 9,
  archive: 10
};

const TERMINAL_ATTEMPTS = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_LIVENESS = new Set(["terminal", "stopped"]);

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function cleanSceneText(value: unknown, max: number): string | null {
  const normalized = String(value ?? "")
    .replace(/[`*_>#\[\]()]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, max) : null;
}

const INTERNAL_ACTOR_LABEL = /(?:worker|direct-tool|tool_process):|\b(?:objective|attempt|owner|managed_pid|agent\s+run)\b/iu;

function actorDisplayLabel(executor: OfficeExecutorV1): string {
  const explicitLabel = cleanSceneText(executor.label, 60);
  if (explicitLabel && /[\u3400-\u9fff]/u.test(explicitLabel) && !INTERNAL_ACTOR_LABEL.test(explicitLabel)) {
    return explicitLabel;
  }
  const executorKind = cleanSceneText(executor.kind || executor.worker_type || executor.executor_id.split(":", 1)[0], 40);
  return plainExecutorName(executorKind);
}

function stableIdentity(projectId: string, executorId: string): { actor_id: string; persona_id: string; identity: OfficeAgentIdentityV1 } {
  const digest = createHash("sha256").update(projectId).update("\0").update(executorId).digest("hex");
  const identity = officeAgentIdentity(projectId, executorId);
  return { actor_id: `actor:${digest.slice(0, 20)}`, persona_id: identity.persona_id, identity };
}

function attemptIsCurrentAndVisible(objective: OfficeObjectiveV1): objective is OfficeObjectiveV1 & { current_attempt: NonNullable<OfficeObjectiveV1["current_attempt"]> } {
  const attempt = objective.current_attempt;
  if (!attempt || !objective.current_attempt_id || objective.current_attempt_id !== attempt.task_id) return false;
  if (attempt.actor_role === "observer") return false;
  if (objective.zone === "archive") return objective.objective_status === "delivered" && attempt.status === "completed";
  if (["delivered", "cancelled"].includes(objective.objective_status)) return false;
  if (TERMINAL_ATTEMPTS.has(attempt.status) || TERMINAL_LIVENESS.has(attempt.liveness)) return false;
  return true;
}

function activeDevice(objective: OfficeObjectiveV1, kind: OfficeDeviceV1["device_kind"]): boolean {
  return objective.devices.some((device) => device.device_kind === kind && device.state === "active");
}

function visualZone(objective: OfficeObjectiveV1, executor: OfficeExecutorV1): OfficeVisualZoneV1 {
  if (objective.zone === "archive") return "archive";
  if (["waiting_user", "incident", "recovering"].includes(objective.zone)) return objective.zone as OfficeVisualZoneV1;
  if (objective.zone === "validation" || executor.validation || activeDevice(objective, "acceptance")) return "validation";
  if (objective.zone === "browser" || executor.browser || activeDevice(objective, "browser")) return "browser";
  if (objective.writer_lease.state === "active" && objective.writer_lease.holder_task_id === objective.current_attempt?.task_id && executor.writer) return "writer";
  if (objective.writer_lease.state === "queued" && executor.read_write_mode !== "read_only") return "writer_queue";
  return objective.zone;
}

function visualPose(zone: OfficeVisualZoneV1): OfficeActorPose {
  if (zone === "waiting_user") return "hand_raised";
  if (zone === "incident") return "incident";
  if (zone === "recovering") return "recovering";
  if (zone === "validation") return "validating";
  if (zone === "browser") return "browsing";
  if (zone === "writer" || zone === "development") return "typing";
  if (zone === "writer_queue") return "waiting";
  if (zone === "delivery") return "delivering";
  if (zone === "dispatch") return "standing";
  return "idle";
}

function actorCandidates(project: OfficeProjectFloorV1): ActorCandidate[] {
  const candidates = new Map<string, ActorCandidate>();
  for (const zone of OFFICE_ZONES) {
    for (const objective of project.zones[zone]) {
      if (!attemptIsCurrentAndVisible(objective)) continue;
      for (const executor of objective.executors) {
        if (!executor.executor_id) continue;
        const archivedCompletion = objective.zone === "archive" && objective.objective_status === "delivered";
        if (!archivedCompletion && (executor.state === "terminal" || executor.activity_state === "terminal")) continue;
        const identity = stableIdentity(project.project_id, executor.executor_id);
        const zoneId = visualZone(objective, executor);
        const candidate: ActorCandidate = {
          ...identity,
          project,
          objective,
          executor,
          zone_id: zoneId,
          pose: visualPose(zoneId),
          task_id: objective.current_attempt.task_id
        };
        const current = candidates.get(identity.actor_id);
        if (!current || VISUAL_ZONE_PRIORITY[candidate.zone_id] < VISUAL_ZONE_PRIORITY[current.zone_id]
          || (VISUAL_ZONE_PRIORITY[candidate.zone_id] === VISUAL_ZONE_PRIORITY[current.zone_id]
            && candidate.objective.stable_key.localeCompare(current.objective.stable_key) < 0)) {
          candidates.set(identity.actor_id, candidate);
        }
      }
    }
  }
  return [...candidates.values()].sort((left, right) => VISUAL_ZONE_PRIORITY[left.zone_id] - VISUAL_ZONE_PRIORITY[right.zone_id]
    || left.actor_id.localeCompare(right.actor_id));
}

function actorSnapshot(candidate: ActorCandidate, station: OfficeSceneStationV1): OfficeActorSnapshotV1 {
  return {
    version: 1,
    actor_id: candidate.actor_id,
    persona_id: candidate.persona_id,
    identity: candidate.identity,
    project_id: candidate.project.project_id,
    objective_key: candidate.objective.stable_key,
    task_id: candidate.task_id,
    executor_id: candidate.executor.executor_id,
    label: actorDisplayLabel(candidate.executor),
    zone_id: candidate.zone_id,
    station_id: station.station_id,
    x: station.x,
    y: station.y,
    z_index: station.z_index,
    pose: candidate.pose,
    action: cleanSceneText(plainCurrentWork(candidate.executor.recent_activity_action || candidate.executor.current_action || candidate.objective.current_attempt?.action, candidate.zone_id), 120),
    recent_activity_action: cleanSceneText(candidate.executor.recent_activity_action, 120),
    recent_activity_completed_at: candidate.executor.recent_activity_completed_at,
    recent_activity_until: candidate.executor.recent_activity_until,
    activity_state: candidate.executor.activity_state,
    browser_active: candidate.executor.browser || activeDevice(candidate.objective, "browser"),
    validation_active: candidate.executor.validation || activeDevice(candidate.objective, "acceptance"),
    writer_active: candidate.zone_id === "writer",
    evidence_ref: candidate.executor.evidence_ref
  };
}

function uniqueEvidence(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())).map((value) => value.trim()))].sort();
}

export function officeVisualRelationSnapshots(project: OfficeProjectFloorV1, actors: readonly OfficeActorSnapshotV1[]): OfficeVisualRelationSnapshotV1[] {
  const actorByExecutor = new Map(actors.map((actor) => [actor.executor_id, actor.actor_id]));
  const relations = new Map<string, OfficeVisualRelationSnapshotV1>();
  const add = (objectiveKey: string, kind: OfficeVisualRelationKindV1, fromExecutorIds: readonly string[], toExecutorIds: readonly string[], options: {
    relation_id: string;
    relation_group?: string | null;
    route_source: OfficeRouteSource;
    transition_reason?: string | null;
    dependency_satisfied?: boolean | null;
    evidence_refs: readonly (string | null | undefined)[];
  }): void => {
    const evidenceRefs = uniqueEvidence(options.evidence_refs);
    if (!evidenceRefs.length) return;
    for (const fromExecutorId of fromExecutorIds) {
      const fromActorId = actorByExecutor.get(fromExecutorId);
      if (!fromActorId) continue;
      for (const toExecutorId of toExecutorIds) {
        const toActorId = actorByExecutor.get(toExecutorId);
        if (!toActorId || fromActorId === toActorId) continue;
        const relationId = `${options.relation_id}:${fromActorId}:${toActorId}`;
        relations.set(relationId, {
          version: 1,
          relation_id: relationId,
          project_id: project.project_id,
          objective_key: objectiveKey,
          from_actor_id: fromActorId,
          to_actor_id: toActorId,
          relation_kind: kind,
          relation_group: options.relation_group ?? null,
          route_source: options.route_source,
          transition_reason: options.transition_reason ?? null,
          dependency_satisfied: options.dependency_satisfied ?? null,
          evidence_refs: evidenceRefs,
          state_authority_changed: false
        });
      }
    }
  };

  for (const zone of OFFICE_ZONES) {
    for (const objective of project.zones[zone]) {
      if (!attemptIsCurrentAndVisible(objective)) continue;
      const nodes = new Map(objective.execution_graph.nodes.map((node) => [node.node_id, node]));
      const runNodes = new Map<string, typeof objective.execution_graph.nodes>();
      for (const node of objective.execution_graph.nodes) {
        if (!node.run_id) continue;
        runNodes.set(node.run_id, [...(runNodes.get(node.run_id) ?? []), node]);
      }
      for (const edge of objective.execution_graph.edges) {
        if (edge.edge_class !== "execution" || edge.degraded_reason) continue;
        const fromNode = nodes.get(edge.from_node_id);
        const toNode = nodes.get(edge.to_node_id);
        if (!fromNode || !toNode) continue;
        add(objective.stable_key, edge.edge_kind as OfficeExecutionRelationKind, fromNode.executor_ids, toNode.executor_ids, {
          relation_id: `${objective.stable_key}:${edge.edge_id}`,
          relation_group: edge.relation_group,
          route_source: edge.route_source,
          transition_reason: edge.transition_reason,
          dependency_satisfied: edge.dependency_satisfied,
          evidence_refs: [edge.evidence_ref, ...edge.evidence_refs]
        });
      }
      for (const child of objective.execution_graph.nodes) {
        if (!child.parent_hint) continue;
        const parents = runNodes.get(child.parent_hint) ?? [];
        if (parents.length !== 1) continue;
        const parent = parents[0]!;
        add(objective.stable_key, "parent_child", parent.executor_ids, child.executor_ids, {
          relation_id: `${objective.stable_key}:parent:${parent.node_id}:${child.node_id}`,
          route_source: child.route_source,
          transition_reason: child.transition_reason ?? "parent_run_id",
          evidence_refs: [parent.evidence_ref, ...parent.evidence_refs, child.evidence_ref, ...child.evidence_refs]
        });
      }
    }
  }
  return [...relations.values()].sort((left, right) => left.relation_id.localeCompare(right.relation_id));
}

function deviceSnapshots(project: OfficeProjectFloorV1, actors: OfficeActorSnapshotV1[]): OfficeVisualDeviceSnapshotV1[] {
  const actorByExecutor = new Map(actors.map((actor) => [actor.executor_id, actor.actor_id]));
  const devices: OfficeVisualDeviceSnapshotV1[] = [];
  for (const zone of OFFICE_ZONES) {
    for (const objective of project.zones[zone]) {
      if (!attemptIsCurrentAndVisible(objective)) continue;
      for (const device of objective.devices) {
        const display = device.device_kind === "browser"
          ? { label: "浏览器操作屏", details: objective.plain_summary.current_work }
          : device.device_kind === "acceptance"
            ? { label: "测试验收屏", details: objective.plain_summary.validation_status }
            : device.device_kind === "writer_lease"
              ? { label: "文件写入台", details: objective.writer_lease.state === "queued" ? "正在等待文件写入权" : "正在使用文件写入权" }
              : { label: "后台执行设备", details: objective.plain_summary.current_work };
        devices.push({
          version: 1,
          device_id: `${project.project_id}:${device.device_id}`,
          project_id: project.project_id,
          objective_key: objective.stable_key,
          task_id: objective.current_attempt.task_id,
          device_kind: device.device_kind,
          label: display.label,
          state: device.state,
          actor_ids: [...new Set(device.executor_ids.map((executorId) => actorByExecutor.get(executorId)).filter((value): value is string => Boolean(value)))],
          evidence_source: device.evidence_source,
          evidence_ref: device.evidence_ref,
          details: display.details
        });
      }
    }
  }
  return devices.sort((left, right) => left.device_id.localeCompare(right.device_id));
}

export function projectOfficeVisualSnapshot(
  projection: OfficeProjectionV1,
  options: OfficeVisualProjectionOptions = {}
): OfficeVisualSnapshotV1 {
  const actorLimit = boundedInteger(options.actor_limit, 12, 1, 12);
  const zoneActorLimit = boundedInteger(options.zone_actor_limit, 3, 1, 3);
  const projects = projection.projects.map((project): OfficeProjectVisualSnapshotV1 => {
    const occupied = new Set<string>();
    const zoneCounts = new Map<OfficeVisualZoneV1, number>();
    const folded: Partial<Record<OfficeVisualZoneV1, number>> = {};
    const actors: OfficeActorSnapshotV1[] = [];
    let writerOccupied = false;
    for (const candidate of actorCandidates(project)) {
      const zoneCount = zoneCounts.get(candidate.zone_id) ?? 0;
      if (actors.length >= actorLimit || zoneCount >= zoneActorLimit || (candidate.zone_id === "writer" && writerOccupied)) {
        folded[candidate.zone_id] = (folded[candidate.zone_id] ?? 0) + 1;
        continue;
      }
      const station = deterministicStation(candidate.zone_id, candidate.actor_id, occupied);
      if (!station) {
        folded[candidate.zone_id] = (folded[candidate.zone_id] ?? 0) + 1;
        continue;
      }
      occupied.add(station.station_id);
      zoneCounts.set(candidate.zone_id, zoneCount + 1);
      if (candidate.zone_id === "writer") writerOccupied = true;
      actors.push(actorSnapshot(candidate, station));
    }
    return {
      version: 1,
      project_id: project.project_id,
      project_name: project.name,
      projection_revision: projection.revision,
      actors,
      devices: deviceSnapshots(project, actors),
      relations: officeVisualRelationSnapshots(project, actors),
      folded_actor_counts: folded
    };
  });
  return {
    version: 1,
    generated_at: projection.generated_at,
    projection_revision: projection.revision,
    projection_id: projection.projection_id,
    source: "office_projection_derived",
    projects
  };
}

export function officeVisualStationInventory(): readonly OfficeSceneStationV1[] {
  return OFFICE_SCENE_STATIONS;
}
