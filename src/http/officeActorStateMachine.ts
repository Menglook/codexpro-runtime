import { OFFICE_SCENE_STATIONS, type OfficeActorPose } from "./officeSceneLayout.js";
import type {
  OfficeActorSnapshotV1,
  OfficeProjectVisualSnapshotV1,
  OfficeVisualDeviceSnapshotV1,
  OfficeVisualZoneV1
} from "./officeVisualProjection.js";

export interface OfficeActorRuntimeV1 {
  actor: OfficeActorSnapshotV1;
  pose: OfficeActorPose;
  station_id: string;
  zone_id: OfficeVisualZoneV1;
  controlled_loop: boolean;
}

export interface OfficeDeviceRuntimeV1 {
  device: OfficeVisualDeviceSnapshotV1;
  active: boolean;
}

export interface OfficeSceneRegistryV1 {
  version: 1;
  project_id: string | null;
  projection_revision: string | null;
  actors: Record<string, OfficeActorRuntimeV1>;
  executors: Record<string, string>;
  occupancy: Record<string, string>;
  devices: Record<string, OfficeDeviceRuntimeV1>;
}

export interface OfficeSceneReconcileResultV1 {
  state: OfficeSceneRegistryV1;
  actor_created: string[];
  actor_updated: string[];
  actor_destroyed: string[];
  device_created: string[];
  device_updated: string[];
  device_destroyed: string[];
  conflicts: string[];
  project_reset: boolean;
}

const LOOP_POSES = new Set<OfficeActorPose>(["typing", "browsing", "validating", "hand_raised", "recovering", "delivering", "idle"]);

export function officePoseUsesControlledLoop(pose: OfficeActorPose): boolean {
  return LOOP_POSES.has(pose);
}

export function emptyOfficeSceneRegistry(): OfficeSceneRegistryV1 {
  return {
    version: 1,
    project_id: null,
    projection_revision: null,
    actors: {},
    executors: {},
    occupancy: {},
    devices: {}
  };
}

function safePose(actor: OfficeActorSnapshotV1): OfficeActorPose {
  if (actor.zone_id === "waiting_user") return "hand_raised";
  if (actor.zone_id === "incident") return "incident";
  if (actor.zone_id === "recovering") return "recovering";
  if (actor.zone_id === "validation") return "validating";
  if (actor.zone_id === "browser") return "browsing";
  if (actor.zone_id === "writer" || actor.zone_id === "development") return "typing";
  if (actor.zone_id === "writer_queue") return "waiting";
  if (actor.zone_id === "delivery") return "delivering";
  if (actor.zone_id === "dispatch") return "standing";
  return "idle";
}

function actorChanged(previous: OfficeActorRuntimeV1, next: OfficeActorRuntimeV1): boolean {
  return previous.station_id !== next.station_id
    || previous.zone_id !== next.zone_id
    || previous.pose !== next.pose
    || previous.actor.action !== next.actor.action
    || previous.actor.label !== next.actor.label
    || previous.actor.browser_active !== next.actor.browser_active
    || previous.actor.validation_active !== next.actor.validation_active
    || previous.actor.writer_active !== next.actor.writer_active;
}

function deviceChanged(previous: OfficeDeviceRuntimeV1, next: OfficeDeviceRuntimeV1): boolean {
  return previous.active !== next.active
    || previous.device.state !== next.device.state
    || previous.device.details !== next.device.details
    || previous.device.actor_ids.join("\0") !== next.device.actor_ids.join("\0");
}

export function reconcileOfficeSceneRegistry(
  previous: OfficeSceneRegistryV1,
  snapshot: OfficeProjectVisualSnapshotV1 | null
): OfficeSceneReconcileResultV1 {
  const projectReset = !snapshot || previous.project_id !== snapshot.project_id;
  const base = projectReset ? emptyOfficeSceneRegistry() : previous;
  const actors: Record<string, OfficeActorRuntimeV1> = {};
  const executors: Record<string, string> = {};
  const occupancy: Record<string, string> = {};
  const devices: Record<string, OfficeDeviceRuntimeV1> = {};
  const conflicts: string[] = [];
  const actorCreated: string[] = [];
  const actorUpdated: string[] = [];
  const deviceCreated: string[] = [];
  const deviceUpdated: string[] = [];

  if (snapshot) {
    for (const actor of snapshot.actors) {
      const station = OFFICE_SCENE_STATIONS.find((item) => item.station_id === actor.station_id);
      if (!station || station.zone_id !== actor.zone_id) {
        conflicts.push(`actor ${actor.actor_id} has invalid station ${actor.station_id}`);
        continue;
      }
      if (actors[actor.actor_id]) {
        conflicts.push(`duplicate actor ${actor.actor_id}`);
        continue;
      }
      if (executors[actor.executor_id]) {
        conflicts.push(`executor ${actor.executor_id} already owns actor ${executors[actor.executor_id]}`);
        continue;
      }
      if (occupancy[actor.station_id]) {
        conflicts.push(`station ${actor.station_id} already occupied by ${occupancy[actor.station_id]}`);
        continue;
      }
      const pose = safePose(actor);
      const runtime: OfficeActorRuntimeV1 = {
        actor: pose === actor.pose ? actor : { ...actor, pose },
        pose,
        station_id: actor.station_id,
        zone_id: actor.zone_id,
        controlled_loop: officePoseUsesControlledLoop(pose)
      };
      actors[actor.actor_id] = runtime;
      executors[actor.executor_id] = actor.actor_id;
      occupancy[actor.station_id] = actor.actor_id;
      if (!base.actors[actor.actor_id]) actorCreated.push(actor.actor_id);
      else if (actorChanged(base.actors[actor.actor_id], runtime)) actorUpdated.push(actor.actor_id);
    }
    for (const device of snapshot.devices) {
      if (devices[device.device_id]) {
        conflicts.push(`duplicate device ${device.device_id}`);
        continue;
      }
      const runtime: OfficeDeviceRuntimeV1 = { device, active: device.state === "active" };
      devices[device.device_id] = runtime;
      if (!base.devices[device.device_id]) deviceCreated.push(device.device_id);
      else if (deviceChanged(base.devices[device.device_id], runtime)) deviceUpdated.push(device.device_id);
    }
  }

  const destroyedSource = projectReset ? previous : base;
  const actorDestroyed = Object.keys(destroyedSource.actors).filter((actorId) => !actors[actorId]);
  const deviceDestroyed = Object.keys(destroyedSource.devices).filter((deviceId) => !devices[deviceId]);
  return {
    state: {
      version: 1,
      project_id: snapshot?.project_id ?? null,
      projection_revision: snapshot?.projection_revision ?? null,
      actors,
      executors,
      occupancy,
      devices
    },
    actor_created: actorCreated,
    actor_updated: actorUpdated,
    actor_destroyed: actorDestroyed,
    device_created: deviceCreated,
    device_updated: deviceUpdated,
    device_destroyed: deviceDestroyed,
    conflicts,
    project_reset: projectReset
  };
}
