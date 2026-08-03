import { routeBetweenStations, type OfficeRouteNodeV1 } from "./officeSceneLayout.js";
import type { OfficeActorSnapshotV1, OfficeProjectVisualSnapshotV1, OfficeVisualZoneV1 } from "./officeVisualProjection.js";

export interface OfficeActorMovementV1 {
  version: 1;
  movement_id: string;
  actor_id: string;
  from_station_id: string;
  target_station_id: string;
  target_zone_id: OfficeVisualZoneV1;
  target_pose: OfficeActorSnapshotV1["pose"];
  route: OfficeRouteNodeV1[];
  duration_ms: number;
}

export interface OfficeMovementPlanV1 {
  version: 1;
  project_id: string | null;
  movements: OfficeActorMovementV1[];
  direct_actor_ids: string[];
  unchanged_actor_ids: string[];
  removed_actor_ids: string[];
}

export interface OfficeMovementPlanOptions {
  direct?: boolean;
  mobile?: boolean;
  max_simultaneous?: number;
}

const MOVEMENT_ZONE_PRIORITY: Record<OfficeVisualZoneV1, number> = {
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

function movementDuration(routeLength: number): number {
  return Math.min(1_600, Math.max(420, 260 + routeLength * 150));
}

export function planOfficeActorMovements(
  previous: OfficeProjectVisualSnapshotV1 | null,
  next: OfficeProjectVisualSnapshotV1 | null,
  options: OfficeMovementPlanOptions = {}
): OfficeMovementPlanV1 {
  if (!next) {
    return {
      version: 1,
      project_id: null,
      movements: [],
      direct_actor_ids: [],
      unchanged_actor_ids: [],
      removed_actor_ids: previous?.actors.map((actor) => actor.actor_id) ?? []
    };
  }
  const previousActors = new Map(previous?.actors.map((actor) => [actor.actor_id, actor]) ?? []);
  const nextActors = new Map(next.actors.map((actor) => [actor.actor_id, actor]));
  const reset = options.direct === true || !previous || previous.project_id !== next.project_id;
  const candidates: OfficeActorMovementV1[] = [];
  const directActorIds: string[] = [];
  const unchangedActorIds: string[] = [];
  for (const actor of next.actors) {
    const before = previousActors.get(actor.actor_id);
    if (!before || reset) {
      directActorIds.push(actor.actor_id);
      continue;
    }
    if (before.station_id === actor.station_id) {
      unchangedActorIds.push(actor.actor_id);
      continue;
    }
    const route = routeBetweenStations(before.station_id, actor.station_id);
    if (route.length < 2) {
      directActorIds.push(actor.actor_id);
      continue;
    }
    candidates.push({
      version: 1,
      movement_id: `${actor.actor_id}:${actor.station_id}:${next.projection_revision}`,
      actor_id: actor.actor_id,
      from_station_id: before.station_id,
      target_station_id: actor.station_id,
      target_zone_id: actor.zone_id,
      target_pose: actor.pose,
      route,
      duration_ms: movementDuration(route.length)
    });
  }
  candidates.sort((left, right) => MOVEMENT_ZONE_PRIORITY[left.target_zone_id] - MOVEMENT_ZONE_PRIORITY[right.target_zone_id]
    || left.actor_id.localeCompare(right.actor_id));
  const fallbackLimit = options.mobile ? 2 : 6;
  const limit = Math.max(0, Math.min(fallbackLimit, Math.floor(options.max_simultaneous ?? fallbackLimit)));
  const movements = candidates.slice(0, limit);
  directActorIds.push(...candidates.slice(limit).map((movement) => movement.actor_id));
  return {
    version: 1,
    project_id: next.project_id,
    movements,
    direct_actor_ids: directActorIds,
    unchanged_actor_ids: unchangedActorIds,
    removed_actor_ids: [...previousActors.keys()].filter((actorId) => !nextActors.has(actorId))
  };
}

export function coalesceOfficeActorMovement(
  active: OfficeActorMovementV1 | null,
  incoming: OfficeActorMovementV1
): { action: "start" | "keep" | "replace"; movement: OfficeActorMovementV1 } {
  if (!active) return { action: "start", movement: incoming };
  if (active.target_station_id === incoming.target_station_id) return { action: "keep", movement: active };
  return { action: "replace", movement: incoming };
}
