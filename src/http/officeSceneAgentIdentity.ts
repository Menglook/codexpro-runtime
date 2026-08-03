import { createHash } from "node:crypto";

export const OFFICE_AGENT_PERSONA_VERSION = 1;

export const OFFICE_AGENT_PROTOTYPES = [
  "developer",
  "browser",
  "validator",
  "writer",
  "diagnostic",
  "recovery",
  "delivery",
  "hologram"
] as const;

export type OfficeAgentPrototype = typeof OFFICE_AGENT_PROTOTYPES[number];

export interface OfficeAgentIdentityV1 {
  version: 1;
  persona_version: number;
  persona_id: string;
  prototype: OfficeAgentPrototype;
  chassis_number: string;
  head_type: number;
  shoulder_type: number;
  core_color: string;
  sensor_color: string;
  tool_module: string;
  badge: string;
  facing: "left" | "right";
  motion_offset_ms: number;
}

const CORE_COLORS = ["#35d7ff", "#7cf7ce", "#ffb44a", "#ff667a", "#a98bff", "#f8e36a", "#48a8ff", "#d7f8ff"] as const;
const SENSOR_COLORS = ["#9af4ff", "#58e7ff", "#b7ffcc", "#ff8b94", "#c7a8ff", "#ffd676", "#55bbff", "#eefcff"] as const;
const TOOL_MODULES = ["代码矩阵", "网页视窗", "验收环", "写入锁", "诊断仪", "恢复核心", "交付舱", "远程投影"] as const;

function badgeFor(executorId: string, digest: string): string {
  const readable = executorId
    .split(/[:/._-]+/u)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 4)
    .toUpperCase();
  return readable || `A${digest.slice(0, 3).toUpperCase()}`;
}

export function officeAgentIdentity(projectId: string, executorId: string, personaVersion = OFFICE_AGENT_PERSONA_VERSION): OfficeAgentIdentityV1 {
  const digest = createHash("sha256")
    .update(String(projectId))
    .update("\0")
    .update(String(executorId))
    .update("\0")
    .update(String(personaVersion))
    .digest("hex");
  const prototypeIndex = Number.parseInt(digest.slice(0, 2), 16) % OFFICE_AGENT_PROTOTYPES.length;
  return {
    version: 1,
    persona_version: personaVersion,
    persona_id: `persona:v${personaVersion}:${digest.slice(0, 12)}`,
    prototype: OFFICE_AGENT_PROTOTYPES[prototypeIndex],
    chassis_number: `CP-${digest.slice(2, 8).toUpperCase()}`,
    head_type: Number.parseInt(digest.slice(8, 10), 16) % 4,
    shoulder_type: Number.parseInt(digest.slice(10, 12), 16) % 4,
    core_color: CORE_COLORS[Number.parseInt(digest.slice(12, 14), 16) % CORE_COLORS.length],
    sensor_color: SENSOR_COLORS[Number.parseInt(digest.slice(14, 16), 16) % SENSOR_COLORS.length],
    tool_module: TOOL_MODULES[prototypeIndex],
    badge: badgeFor(executorId, digest),
    facing: Number.parseInt(digest.slice(16, 18), 16) % 2 === 0 ? "left" : "right",
    motion_offset_ms: Number.parseInt(digest.slice(18, 22), 16) % 701
  };
}
