export type OfficeActorPose =
  | "standing"
  | "walking"
  | "sitting"
  | "typing"
  | "browsing"
  | "validating"
  | "hand_raised"
  | "waiting"
  | "incident"
  | "recovering"
  | "delivering"
  | "idle";

export interface OfficeSceneRectV1 {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OfficeSceneZoneV1 extends OfficeSceneRectV1 {
  zone_id: string;
  label: string;
}

export interface OfficeSceneStationV1 {
  station_id: string;
  zone_id: string;
  x: number;
  y: number;
  z_index: number;
  capacity: number;
  route_node_id: string;
  allowed_poses: OfficeActorPose[];
}

export interface OfficeRouteNodeV1 {
  node_id: string;
  x: number;
  y: number;
  neighbors: string[];
}

export interface OfficeSceneFurnitureV1 extends OfficeSceneRectV1 {
  furniture_id: string;
  kind: "desk" | "browser" | "acceptance" | "writer" | "diagnostic" | "recovery" | "dispatch" | "delivery" | "archive" | "queue" | "plant";
}

export const OFFICE_SCENE_WIDTH = 1000;
export const OFFICE_SCENE_HEIGHT = 700;

export const OFFICE_SCENE_ZONES: OfficeSceneZoneV1[] = [
  { zone_id: "waiting_user", label: "等待老板", x: 20, y: 30, width: 180, height: 170 },
  { zone_id: "incident", label: "故障处理室", x: 20, y: 220, width: 180, height: 160 },
  { zone_id: "recovering", label: "恢复处理区", x: 20, y: 400, width: 180, height: 270 },
  { zone_id: "development", label: "开发工作区", x: 230, y: 30, width: 410, height: 360 },
  { zone_id: "browser", label: "浏览器操作室", x: 670, y: 30, width: 310, height: 170 },
  { zone_id: "validation", label: "测试验收室", x: 670, y: 220, width: 310, height: 160 },
  { zone_id: "dispatch", label: "任务分派台", x: 230, y: 500, width: 150, height: 170 },
  { zone_id: "writer_queue", label: "等待写入区", x: 400, y: 500, width: 100, height: 170 },
  { zone_id: "writer", label: "文件写入台", x: 520, y: 500, width: 130, height: 170 },
  { zone_id: "delivery", label: "提交交付区", x: 670, y: 500, width: 150, height: 170 },
  { zone_id: "archive", label: "已完成归档区", x: 840, y: 500, width: 140, height: 170 }
];

const station = (
  station_id: string,
  zone_id: string,
  x: number,
  y: number,
  route_node_id: string,
  allowed_poses: OfficeActorPose[],
  capacity = 1
): OfficeSceneStationV1 => ({ station_id, zone_id, x, y, z_index: 20 + Math.floor(y / 10), capacity, route_node_id, allowed_poses });

export const OFFICE_SCENE_STATIONS: OfficeSceneStationV1[] = [
  station("waiting-1", "waiting_user", 85, 145, "waiting-1", ["hand_raised", "waiting"]),
  station("waiting-2", "waiting_user", 145, 175, "waiting-2", ["hand_raised", "waiting"]),
  station("incident-1", "incident", 85, 315, "incident-1", ["incident"]),
  station("incident-2", "incident", 150, 345, "incident-2", ["incident"]),
  station("recovering-1", "recovering", 85, 500, "recovering-1", ["recovering"]),
  station("recovering-2", "recovering", 145, 590, "recovering-2", ["recovering"]),
  station("development-1", "development", 315, 220, "dev-1", ["sitting", "typing"]),
  station("development-2", "development", 525, 220, "dev-2", ["sitting", "typing"]),
  station("development-3", "development", 315, 360, "dev-3", ["sitting", "typing"]),
  station("development-4", "development", 525, 360, "dev-4", ["sitting", "typing"]),
  station("browser-1", "browser", 760, 170, "browser-1", ["browsing", "sitting"]),
  station("browser-2", "browser", 900, 170, "browser-2", ["browsing", "sitting"]),
  station("validation-1", "validation", 760, 350, "validation-1", ["validating", "standing"]),
  station("validation-2", "validation", 900, 350, "validation-2", ["validating", "standing"]),
  station("dispatch-1", "dispatch", 285, 600, "dispatch-1", ["standing", "idle"]),
  station("dispatch-2", "dispatch", 350, 635, "dispatch-2", ["standing", "idle"]),
  station("writer-queue-1", "writer_queue", 430, 570, "writer-queue-1", ["waiting", "standing"]),
  station("writer-queue-2", "writer_queue", 470, 625, "writer-queue-2", ["waiting", "standing"]),
  station("writer-1", "writer", 585, 620, "writer-1", ["typing", "sitting"]),
  station("delivery-1", "delivery", 720, 595, "delivery-1", ["delivering", "standing"]),
  station("delivery-2", "delivery", 785, 635, "delivery-2", ["delivering", "standing"]),
  station("archive-1", "archive", 880, 585, "archive-1", ["idle", "standing"]),
  station("archive-2", "archive", 945, 635, "archive-2", ["idle", "standing"])
];

export const OFFICE_SCENE_ROUTE_NODES: OfficeRouteNodeV1[] = [
  { node_id: "hub-left", x: 210, y: 450, neighbors: ["hub-dev", "waiting-entry", "incident-entry", "recovering-entry"] },
  { node_id: "hub-dev", x: 435, y: 450, neighbors: ["hub-left", "hub-right", "dev-entry", "dispatch-entry", "writer-queue-entry"] },
  { node_id: "hub-right", x: 660, y: 450, neighbors: ["hub-dev", "hub-far", "browser-entry", "validation-entry", "writer-entry"] },
  { node_id: "hub-far", x: 830, y: 450, neighbors: ["hub-right", "delivery-entry", "archive-entry"] },
  { node_id: "waiting-entry", x: 210, y: 145, neighbors: ["hub-left", "waiting-1", "waiting-2"] },
  { node_id: "waiting-1", x: 85, y: 145, neighbors: ["waiting-entry"] },
  { node_id: "waiting-2", x: 145, y: 175, neighbors: ["waiting-entry"] },
  { node_id: "incident-entry", x: 210, y: 315, neighbors: ["hub-left", "incident-1", "incident-2"] },
  { node_id: "incident-1", x: 85, y: 315, neighbors: ["incident-entry"] },
  { node_id: "incident-2", x: 150, y: 345, neighbors: ["incident-entry"] },
  { node_id: "recovering-entry", x: 210, y: 550, neighbors: ["hub-left", "recovering-1", "recovering-2"] },
  { node_id: "recovering-1", x: 85, y: 500, neighbors: ["recovering-entry"] },
  { node_id: "recovering-2", x: 145, y: 590, neighbors: ["recovering-entry"] },
  { node_id: "dev-entry", x: 435, y: 410, neighbors: ["hub-dev", "dev-row-1", "dev-row-2"] },
  { node_id: "dev-row-1", x: 435, y: 220, neighbors: ["dev-entry", "dev-1", "dev-2"] },
  { node_id: "dev-row-2", x: 435, y: 360, neighbors: ["dev-entry", "dev-3", "dev-4"] },
  { node_id: "dev-1", x: 315, y: 220, neighbors: ["dev-row-1"] },
  { node_id: "dev-2", x: 525, y: 220, neighbors: ["dev-row-1"] },
  { node_id: "dev-3", x: 315, y: 360, neighbors: ["dev-row-2"] },
  { node_id: "dev-4", x: 525, y: 360, neighbors: ["dev-row-2"] },
  { node_id: "browser-entry", x: 660, y: 170, neighbors: ["hub-right", "browser-1", "browser-2"] },
  { node_id: "browser-1", x: 760, y: 170, neighbors: ["browser-entry"] },
  { node_id: "browser-2", x: 900, y: 170, neighbors: ["browser-entry"] },
  { node_id: "validation-entry", x: 660, y: 350, neighbors: ["hub-right", "validation-1", "validation-2"] },
  { node_id: "validation-1", x: 760, y: 350, neighbors: ["validation-entry"] },
  { node_id: "validation-2", x: 900, y: 350, neighbors: ["validation-entry"] },
  { node_id: "dispatch-entry", x: 310, y: 490, neighbors: ["hub-dev", "dispatch-1", "dispatch-2"] },
  { node_id: "dispatch-1", x: 285, y: 600, neighbors: ["dispatch-entry"] },
  { node_id: "dispatch-2", x: 350, y: 635, neighbors: ["dispatch-entry"] },
  { node_id: "writer-queue-entry", x: 455, y: 490, neighbors: ["hub-dev", "writer-queue-1", "writer-queue-2"] },
  { node_id: "writer-queue-1", x: 430, y: 570, neighbors: ["writer-queue-entry"] },
  { node_id: "writer-queue-2", x: 470, y: 625, neighbors: ["writer-queue-entry"] },
  { node_id: "writer-entry", x: 520, y: 490, neighbors: ["hub-right", "writer-turn"] },
  { node_id: "writer-turn", x: 520, y: 620, neighbors: ["writer-entry", "writer-1"] },
  { node_id: "writer-1", x: 585, y: 620, neighbors: ["writer-turn"] },
  { node_id: "delivery-entry", x: 745, y: 490, neighbors: ["hub-far", "delivery-1", "delivery-2"] },
  { node_id: "delivery-1", x: 720, y: 595, neighbors: ["delivery-entry"] },
  { node_id: "delivery-2", x: 785, y: 635, neighbors: ["delivery-entry"] },
  { node_id: "archive-entry", x: 910, y: 490, neighbors: ["hub-far", "archive-1", "archive-2"] },
  { node_id: "archive-1", x: 880, y: 585, neighbors: ["archive-entry"] },
  { node_id: "archive-2", x: 945, y: 635, neighbors: ["archive-entry"] }
];

export const OFFICE_SCENE_FURNITURE: OfficeSceneFurnitureV1[] = [
  { furniture_id: "desk-1", kind: "desk", x: 270, y: 105, width: 88, height: 45 },
  { furniture_id: "desk-2", kind: "desk", x: 480, y: 105, width: 88, height: 45 },
  { furniture_id: "desk-3", kind: "desk", x: 270, y: 245, width: 88, height: 45 },
  { furniture_id: "desk-4", kind: "desk", x: 480, y: 245, width: 88, height: 45 },
  { furniture_id: "browser-device", kind: "browser", x: 735, y: 85, width: 44, height: 36 },
  { furniture_id: "acceptance-device", kind: "acceptance", x: 735, y: 265, width: 44, height: 36 },
  { furniture_id: "writer-device", kind: "writer", x: 555, y: 525, width: 44, height: 36 },
  { furniture_id: "diagnostic-device", kind: "diagnostic", x: 30, y: 250, width: 44, height: 36 },
  { furniture_id: "recovery-device", kind: "recovery", x: 30, y: 440, width: 44, height: 36 },
  { furniture_id: "dispatch-device", kind: "dispatch", x: 235, y: 505, width: 44, height: 36 },
  { furniture_id: "queue-device", kind: "queue", x: 405, y: 570, width: 44, height: 36 },
  { furniture_id: "delivery-device", kind: "delivery", x: 675, y: 505, width: 44, height: 36 },
  { furniture_id: "archive-device", kind: "archive", x: 925, y: 505, width: 44, height: 36 },
  { furniture_id: "plant-1", kind: "plant", x: 625, y: 380, width: 34, height: 54 },
  { furniture_id: "plant-2", kind: "plant", x: 930, y: 405, width: 34, height: 54 }
];

export const OFFICE_SCENE_LAYOUT = Object.freeze({
  version: 1 as const,
  width: OFFICE_SCENE_WIDTH,
  height: OFFICE_SCENE_HEIGHT,
  zones: OFFICE_SCENE_ZONES,
  stations: OFFICE_SCENE_STATIONS,
  route_nodes: OFFICE_SCENE_ROUTE_NODES,
  furniture: OFFICE_SCENE_FURNITURE
});

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicStation(zoneId: string, stableKey: string, occupied: ReadonlySet<string> = new Set()): OfficeSceneStationV1 | null {
  const candidates = OFFICE_SCENE_STATIONS.filter((item) => item.zone_id === zoneId && !occupied.has(item.station_id));
  if (!candidates.length) return null;
  return candidates[stableHash(`${zoneId}\0${stableKey}`) % candidates.length] ?? null;
}

export function routeBetweenStations(fromStationId: string, toStationId: string): OfficeRouteNodeV1[] {
  const from = OFFICE_SCENE_STATIONS.find((item) => item.station_id === fromStationId);
  const to = OFFICE_SCENE_STATIONS.find((item) => item.station_id === toStationId);
  if (!from || !to) return [];
  const nodes = new Map(OFFICE_SCENE_ROUTE_NODES.map((item) => [item.node_id, item]));
  const queue = [from.route_node_id];
  const previous = new Map<string, string | null>([[from.route_node_id, null]]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current === to.route_node_id) break;
    for (const next of nodes.get(current)?.neighbors ?? []) {
      if (!previous.has(next) && nodes.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  if (!previous.has(to.route_node_id)) return [];
  const route: OfficeRouteNodeV1[] = [];
  let cursor: string | null = to.route_node_id;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) return [];
    route.unshift(node);
    cursor = previous.get(cursor) ?? null;
  }
  return route;
}

const percent = (value: number, total: number) => `${Number(((value / total) * 100).toFixed(3))}%`;

export const OFFICE_SCENE_LAYOUT_LITERAL = JSON.stringify(OFFICE_SCENE_LAYOUT).replace(/</g, "\\u003c");

const OFFICE_SCENE_DEVICE_KINDS = new Set(["browser", "acceptance", "writer", "diagnostic", "recovery", "dispatch", "delivery", "archive", "queue"]);

export const OFFICE_SCENE_LAYOUT_HTML = [
  ...OFFICE_SCENE_ZONES.map((zone) => `<div class="scene-zone" data-zone="${zone.zone_id}" style="left:${percent(zone.x, OFFICE_SCENE_WIDTH)};top:${percent(zone.y, OFFICE_SCENE_HEIGHT)};width:${percent(zone.width, OFFICE_SCENE_WIDTH)};height:${percent(zone.height, OFFICE_SCENE_HEIGHT)}"><strong>${zone.label}</strong></div>`),
  `<svg class="scene-route-layer" viewBox="0 0 ${OFFICE_SCENE_WIDTH} ${OFFICE_SCENE_HEIGHT}" aria-hidden="true">${OFFICE_SCENE_ROUTE_NODES.flatMap((node) => node.neighbors.filter((neighbor) => node.node_id.localeCompare(neighbor) < 0).map((neighbor) => {
    const next = OFFICE_SCENE_ROUTE_NODES.find((item) => item.node_id === neighbor)!;
    return `<line x1="${node.x}" y1="${node.y}" x2="${next.x}" y2="${next.y}" />`;
  })).join("")}</svg>`,
  ...OFFICE_SCENE_FURNITURE.map((item) => `<div class="scene-${OFFICE_SCENE_DEVICE_KINDS.has(item.kind) ? `device ${item.kind}` : item.kind}" data-furniture-id="${item.furniture_id}" data-device-kind="${item.kind}"${OFFICE_SCENE_DEVICE_KINDS.has(item.kind) ? ` aria-label="${item.kind} 状态设备"` : ""} style="left:${percent(item.x, OFFICE_SCENE_WIDTH)};top:${percent(item.y, OFFICE_SCENE_HEIGHT)}"></div>`)
].join("");
