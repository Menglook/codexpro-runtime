import { createHash } from "node:crypto";
import { redactSensitiveText } from "../redact.js";
import { resolveOfficeAnimationIntentSemantic, OFFICE_ANIMATION_INTENT_POLICY } from "./officeAnimationSemantics.js";

export const OFFICE_ANIMATION_INTENT_TYPES = [
  "task_received", "analysis_started", "analysis_progress", "finding_published",
  "write_started", "write_completed", "browser_started", "browser_interaction", "browser_completed",
  "validation_started", "validation_passed", "validation_failed",
  "git_prepare", "git_committed", "git_pushing", "git_pushed",
  "waiting_for_user", "incident_detected", "recovery_started", "recovery_completed",
  "handoff_started", "handoff_completed", "parallel_started", "merge_completed",
  "delivery_ready", "task_completed", "task_archived"
] as const;

export type OfficeAnimationIntentType = typeof OFFICE_ANIMATION_INTENT_TYPES[number];
export type OfficeAnimationSourceType = "runtime_event" | "public_tool_outcome" | "task_report_event" | "structured_runtime_event";
export type OfficeAnimationDurationClass = "quick" | "standard" | "extended" | "persistent";
export type OfficeAnimationZoneV1 = "waiting_user" | "incident" | "recovering" | "development" | "browser" | "validation" | "dispatch" | "writer_queue" | "writer" | "delivery" | "archive";
export type OfficeAnimationActorRole = "executor" | "reviewer" | "observer" | "system";
export type OfficeAnimationToolCategory = "read" | "write" | "validation" | "browser" | "git" | "report" | "other";

export interface OfficeAnimationSourceEventV1 {
  version: 1;
  source_type: OfficeAnimationSourceType;
  event_id: string;
  project_id: string;
  workspace_id: string | null;
  workspace_generation: number;
  task_id: string;
  actor_id: string | null;
  actor_role: OfficeAnimationActorRole;
  source_sequence: number;
  event_kind: string;
  phase: string | null;
  status: string | null;
  tool_category: OfficeAnimationToolCategory | null;
  from_zone: OfficeAnimationZoneV1 | null;
  safe_summary: string;
  evidence_refs: string[];
  occurred_at: string;
  historical: boolean;
  run_id: string | null;
  parent_run_id: string | null;
  related_actor_id: string | null;
  dependency_task_ids: string[];
}

export interface OfficeAnimationIntentV1 {
  version: 1;
  intent_id: string;
  event_id: string;
  project_id: string;
  task_id: string;
  actor_id: string;
  intent_type: OfficeAnimationIntentType;
  source_type: OfficeAnimationSourceType;
  source_sequence: number;
  source_event_ids: string[];
  from_zone: OfficeAnimationZoneV1 | null;
  to_zone: OfficeAnimationZoneV1 | null;
  station: string | null;
  pose: string | null;
  device: string | null;
  light_tone: "cyan" | "green" | "orange" | "red" | "purple" | "neutral";
  show_bubble: boolean;
  priority: number;
  duration_class: OfficeAnimationDurationClass;
  summary: string;
  evidence_refs: string[];
  aggregation_count: number;
  run_id: string | null;
  parent_run_id: string | null;
  related_actor_id: string | null;
  dependency_task_ids: string[];
  created_at: string;
  expires_at: string | null;
  state_authority_changed: false;
}

export interface OfficeAnimationCompileCursorV1 {
  version: 1;
  seen_keys: string[];
  latest_sequences: Record<string, number>;
}

export interface OfficeAnimationCompileContextV1 {
  project_id: string;
  workspace_generation: number;
  history_mode?: boolean;
  cursor?: OfficeAnimationCompileCursorV1;
}

export interface OfficeAnimationCompileDiagnosticsV1 {
  version: 1;
  accepted: number;
  deduplicated: number;
  coalesced: number;
  rejected_project: number;
  rejected_generation: number;
  rejected_historical: number;
  rejected_observer: number;
  rejected_invalid: number;
  ignored_unknown: number;
}

export interface OfficeAnimationCompileResultV1 {
  version: 1;
  intents: OfficeAnimationIntentV1[];
  cursor: OfficeAnimationCompileCursorV1;
  diagnostics: OfficeAnimationCompileDiagnosticsV1;
  state_authority_changed: false;
}

export const OFFICE_ANIMATION_INTENT_V1_FIELDS = [
  "version", "intent_id", "event_id", "project_id", "task_id", "actor_id", "intent_type", "source_type",
  "source_sequence", "source_event_ids", "from_zone", "to_zone", "station", "pose", "device", "light_tone",
  "show_bubble", "priority", "duration_class", "summary", "evidence_refs", "aggregation_count", "run_id",
  "parent_run_id", "related_actor_id", "dependency_task_ids", "created_at", "expires_at", "state_authority_changed"
] as const satisfies readonly (keyof OfficeAnimationIntentV1)[];

const INTENT_SET = new Set<string>(OFFICE_ANIMATION_INTENT_TYPES);
const SOURCE_SET = new Set<string>(["runtime_event", "public_tool_outcome", "task_report_event", "structured_runtime_event"]);
const DURATION_MS = Object.freeze({ quick: 4_000, standard: 10_000, extended: 24_000 });

function cleanText(value: unknown, max = 180): string {
  return redactSensitiveText(String(value ?? ""))
    .replace(/[`*_>#\[\]()]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanId(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, "").slice(0, 240);
}

function cleanRefs(values: readonly unknown[], limit = 12): string[] {
  return [...new Set(values.map((value) => cleanText(value, 500)).filter(Boolean))].slice(0, limit);
}

function eventKey(event: OfficeAnimationSourceEventV1): string {
  return `${event.project_id}\u0000${event.task_id}\u0000${event.event_id}\u0000${event.source_sequence}`;
}

function sequenceKey(event: OfficeAnimationSourceEventV1): string {
  return `${event.project_id}\u0000${event.actor_id ?? "no-actor"}\u0000${event.source_type}`;
}

function validEvent(event: OfficeAnimationSourceEventV1): boolean {
  return event?.version === 1
    && SOURCE_SET.has(event.source_type)
    && Boolean(cleanId(event.event_id))
    && Boolean(cleanId(event.project_id))
    && Number.isInteger(event.workspace_generation)
    && event.workspace_generation >= 1
    && Boolean(cleanId(event.task_id))
    && Number.isInteger(event.source_sequence)
    && event.source_sequence >= 1
    && Boolean(cleanId(event.event_kind))
    && Number.isFinite(Date.parse(event.occurred_at));
}

function expiry(createdAt: string, durationClass: OfficeAnimationDurationClass): string | null {
  if (durationClass === "persistent") return null;
  return new Date(Date.parse(createdAt) + DURATION_MS[durationClass]).toISOString();
}

function makeIntent(event: OfficeAnimationSourceEventV1): OfficeAnimationIntentV1 | null {
  const semantic = resolveOfficeAnimationIntentSemantic(event);
  if (!semantic || !event.actor_id) return null;
  const createdAt = new Date(event.occurred_at).toISOString();
  const material = [event.project_id, event.task_id, event.actor_id, event.event_id, event.source_sequence, semantic.intent_type].join("\u0000");
  return {
    version: 1,
    intent_id: `office-intent:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`,
    event_id: cleanId(event.event_id),
    project_id: cleanId(event.project_id),
    task_id: cleanId(event.task_id),
    actor_id: cleanId(event.actor_id),
    intent_type: semantic.intent_type,
    source_type: event.source_type,
    source_sequence: event.source_sequence,
    source_event_ids: [cleanId(event.event_id)],
    from_zone: event.from_zone,
    to_zone: semantic.to_zone,
    station: null,
    pose: semantic.pose,
    device: semantic.device,
    light_tone: semantic.light_tone,
    show_bubble: semantic.show_bubble,
    priority: Math.max(0, Math.min(100, Math.floor(semantic.priority))),
    duration_class: semantic.duration_class,
    summary: cleanText(event.safe_summary) || semantic.intent_type.replaceAll("_", " "),
    evidence_refs: cleanRefs(event.evidence_refs),
    aggregation_count: 1,
    run_id: event.run_id ? cleanId(event.run_id) : null,
    parent_run_id: event.parent_run_id ? cleanId(event.parent_run_id) : null,
    related_actor_id: event.related_actor_id ? cleanId(event.related_actor_id) : null,
    dependency_task_ids: cleanRefs(event.dependency_task_ids, 20).map(cleanId).filter(Boolean),
    created_at: createdAt,
    expires_at: expiry(createdAt, semantic.duration_class),
    state_authority_changed: false
  };
}

function intentGroup(intent: OfficeAnimationIntentV1): string | null {
  if (["analysis_started", "analysis_progress"].includes(intent.intent_type)) return "analysis";
  if (intent.intent_type.startsWith("browser_")) return "browser";
  if (intent.intent_type.startsWith("validation_")) return "validation";
  return intent.intent_type === "finding_published" ? "progress" : null;
}

function merge(previous: OfficeAnimationIntentV1, next: OfficeAnimationIntentV1): OfficeAnimationIntentV1 {
  return {
    ...previous,
    event_id: next.event_id,
    intent_type: next.intent_type,
    source_sequence: Math.max(previous.source_sequence, next.source_sequence),
    source_event_ids: [...new Set([...previous.source_event_ids, ...next.source_event_ids])].slice(-12),
    to_zone: next.to_zone ?? previous.to_zone,
    pose: next.pose ?? previous.pose,
    device: next.device ?? previous.device,
    light_tone: next.light_tone,
    show_bubble: previous.show_bubble || next.show_bubble,
    priority: Math.max(previous.priority, next.priority),
    duration_class: next.duration_class,
    summary: next.summary,
    evidence_refs: [...new Set([...previous.evidence_refs, ...next.evidence_refs])].slice(-12),
    aggregation_count: previous.aggregation_count + 1,
    created_at: next.created_at,
    expires_at: next.expires_at,
    state_authority_changed: false
  };
}

export function emptyOfficeAnimationCompileCursor(): OfficeAnimationCompileCursorV1 {
  return { version: 1, seen_keys: [], latest_sequences: {} };
}

export function assertOfficeAnimationIntentV1(value: unknown): asserts value is OfficeAnimationIntentV1 {
  if (!value || typeof value !== "object") throw new Error("Office animation intent must be an object.");
  const item = value as Partial<OfficeAnimationIntentV1>;
  if (item.version !== 1 || item.state_authority_changed !== false) throw new Error("Office animation intent authority contract is invalid.");
  if (!item.intent_type || !INTENT_SET.has(item.intent_type)) throw new Error("Office animation intent type is invalid.");
  if (!item.source_type || !SOURCE_SET.has(item.source_type)) throw new Error("Office animation intent source is invalid.");
  if (!item.intent_id || !item.event_id || !item.project_id || !item.task_id || !item.actor_id) throw new Error("Office animation intent identity is incomplete.");
  if (!Number.isInteger(item.source_sequence) || Number(item.source_sequence) < 1) throw new Error("Office animation intent sequence is invalid.");
  if (!Array.isArray(item.evidence_refs) || !Array.isArray(item.source_event_ids)) throw new Error("Office animation intent evidence fields are invalid.");
}

export function compileOfficeAnimationIntents(
  events: readonly OfficeAnimationSourceEventV1[],
  context: OfficeAnimationCompileContextV1
): OfficeAnimationCompileResultV1 {
  const base = context.cursor ?? emptyOfficeAnimationCompileCursor();
  const seen = new Set(base.seen_keys);
  const latestSequences = { ...base.latest_sequences };
  const intents: OfficeAnimationIntentV1[] = [];
  const diagnostics: OfficeAnimationCompileDiagnosticsV1 = {
    version: 1, accepted: 0, deduplicated: 0, coalesced: 0, rejected_project: 0,
    rejected_generation: 0, rejected_historical: 0, rejected_observer: 0,
    rejected_invalid: 0, ignored_unknown: 0
  };
  const ordered = [...events].sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || left.source_sequence - right.source_sequence || left.event_id.localeCompare(right.event_id));
  for (const event of ordered) {
    if (!validEvent(event)) { diagnostics.rejected_invalid += 1; continue; }
    if (event.project_id !== context.project_id) { diagnostics.rejected_project += 1; continue; }
    if (event.workspace_generation !== context.workspace_generation) { diagnostics.rejected_generation += 1; continue; }
    if (event.historical && context.history_mode !== true) { diagnostics.rejected_historical += 1; continue; }
    if (event.actor_role === "observer" || event.actor_role === "system") { diagnostics.rejected_observer += 1; continue; }
    const key = eventKey(event);
    if (seen.has(key)) { diagnostics.deduplicated += 1; continue; }
    seen.add(key);
    latestSequences[sequenceKey(event)] = Math.max(latestSequences[sequenceKey(event)] ?? 0, event.source_sequence);
    const intent = makeIntent(event);
    if (!intent) { diagnostics.ignored_unknown += 1; continue; }
    const previous = intents.at(-1);
    const group = intentGroup(intent);
    if (previous && group && group === intentGroup(previous) && previous.actor_id === intent.actor_id
      && Date.parse(intent.created_at) - Date.parse(previous.created_at) <= OFFICE_ANIMATION_INTENT_POLICY.coalesce_window_ms) {
      intents[intents.length - 1] = merge(previous, intent);
      diagnostics.coalesced += 1;
    } else {
      intents.push(intent);
    }
    diagnostics.accepted += 1;
  }
  intents.forEach(assertOfficeAnimationIntentV1);
  return {
    version: 1,
    intents,
    cursor: { version: 1, seen_keys: [...seen].slice(-2_048), latest_sequences: latestSequences },
    diagnostics,
    state_authority_changed: false
  };
}
