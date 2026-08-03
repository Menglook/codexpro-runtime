import type { RuntimeActivityEventV2 } from "../runtime/activityEvents.js";
import type { PublicToolOutcomeV1, StoredPublicToolOutcomeV1 } from "../runtime/publicToolOutcome.js";
import type { StructuredRuntimeEventEnvelopeV1 } from "../runtime/structuredRuntimeEvents.js";
import type { TaskReportEventV1, TaskReportSourceKind } from "../tasks/taskReportTypes.js";
import type { OfficeAnimationSourceEventV1 } from "./officeAnimationIntent.js";
import type { OfficeActorSnapshotV1 } from "./officeVisualProjection.js";

export interface OfficeVisualEventCursorV1 {
  version: 1;
  sequences: Record<string, number>;
}

export interface OfficeVisualTransientEventV1 {
  version: 1;
  actor_id: string;
  project_id: string;
  task_id: string;
  sequence: number;
  event_kind: TaskReportEventV1["event_kind"];
  severity: TaskReportEventV1["severity"];
  tab: "progress" | "findings" | "acceptance" | "delivery";
  short_text: string;
  source_kind: TaskReportSourceKind;
  source_label: string;
  authoritative_state_change: false;
  persisted_by_scene: false;
}

export interface OfficeVisualEventAdaptResultV1 {
  version: 1;
  events: OfficeVisualTransientEventV1[];
  cursor: OfficeVisualEventCursorV1;
}

const IMPORTANT_EVENTS = new Set<TaskReportEventV1["event_kind"]>([
  "stage_completed",
  "finding",
  "warning",
  "validation_passed",
  "validation_failed",
  "git_committed",
  "git_pushed",
  "git_failed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "assistant_progress",
  "assistant_summary"
]);

const SOURCE_LABELS: Record<TaskReportSourceKind, string> = {
  durable_job: "CodexPro 运行回报",
  goal: "CodexPro 目标回报",
  handoff: "CodexPro Handoff 回报",
  acceptance: "CodexPro 验收回报",
  git: "CodexPro Git 回报",
  tool: "CodexPro 工具事实",
  chatgpt: "ChatGPT 公开说明"
};

function identity(projectId: string, taskId: string): string {
  return `${projectId}\0${taskId}`;
}

function tabFor(kind: TaskReportEventV1["event_kind"]): OfficeVisualTransientEventV1["tab"] {
  if (["finding", "warning", "assistant_summary"].includes(kind)) return "findings";
  if (["validation_started", "validation_passed", "validation_failed"].includes(kind)) return "acceptance";
  if (["artifact_created", "git_committed", "git_pushed", "git_failed"].includes(kind)) return "delivery";
  return "progress";
}

function shortText(event: TaskReportEventV1): string {
  const prefix = event.source_kind === "chatgpt"
    ? event.event_kind === "assistant_progress" ? "ChatGPT 进度：" : "ChatGPT 总结："
    : "";
  const value = `${prefix}${event.summary || event.title}`
    .replace(/[`*_>#\[\]()]/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.slice(0, 96);
}

export function emptyOfficeVisualEventCursor(): OfficeVisualEventCursorV1 {
  return { version: 1, sequences: {} };
}

export function baselineOfficeVisualEventCursor(
  cursor: OfficeVisualEventCursorV1,
  projectId: string,
  taskId: string,
  latestSequence: number
): OfficeVisualEventCursorV1 {
  const key = identity(projectId, taskId);
  if (cursor.sequences[key] !== undefined) return cursor;
  return { version: 1, sequences: { ...cursor.sequences, [key]: Math.max(0, Math.floor(latestSequence)) } };
}

export function adaptOfficeVisualEvents(
  events: readonly TaskReportEventV1[],
  actors: readonly OfficeActorSnapshotV1[],
  cursor: OfficeVisualEventCursorV1
): OfficeVisualEventAdaptResultV1 {
  const actorByTask = new Map(actors.map((actor) => [identity(actor.project_id, actor.task_id), actor]));
  const sequences = { ...cursor.sequences };
  const latestByActor = new Map<string, OfficeVisualTransientEventV1>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const key = identity(event.project_id, event.task_id);
    const actor = actorByTask.get(key);
    if (!actor || !Number.isInteger(event.sequence) || event.sequence <= 0) continue;
    const seen = sequences[key] ?? 0;
    if (event.sequence <= seen) continue;
    sequences[key] = event.sequence;
    if (!IMPORTANT_EVENTS.has(event.event_kind)) continue;
    latestByActor.set(actor.actor_id, {
      version: 1,
      actor_id: actor.actor_id,
      project_id: event.project_id,
      task_id: event.task_id,
      sequence: event.sequence,
      event_kind: event.event_kind,
      severity: event.severity,
      tab: tabFor(event.event_kind),
      short_text: shortText(event),
      source_kind: event.source_kind,
      source_label: SOURCE_LABELS[event.source_kind],
      authoritative_state_change: false,
      persisted_by_scene: false
    });
  }
  return { version: 1, events: [...latestByActor.values()], cursor: { version: 1, sequences } };
}

export interface OfficeAnimationAdapterContextV1 {
  project_id: string;
  workspace_id: string | null;
  workspace_generation: number;
  actor_by_task?: ReadonlyMap<string, string>;
  actor_role_by_task?: ReadonlyMap<string, OfficeAnimationSourceEventV1["actor_role"]>;
  historical_task_ids?: ReadonlySet<string>;
}

function animationActor(context: OfficeAnimationAdapterContextV1, taskId: string, fallback?: string | null): string | null {
  return context.actor_by_task?.get(taskId) ?? fallback ?? null;
}

function animationRole(context: OfficeAnimationAdapterContextV1, taskId: string, fallback: OfficeAnimationSourceEventV1["actor_role"]): OfficeAnimationSourceEventV1["actor_role"] {
  return context.actor_role_by_task?.get(taskId) ?? fallback;
}

export function taskReportAnimationSource(event: TaskReportEventV1, context: OfficeAnimationAdapterContextV1): OfficeAnimationSourceEventV1 {
  return {
    version: 1,
    source_type: "task_report_event",
    event_id: event.event_id,
    project_id: event.project_id,
    workspace_id: context.workspace_id,
    workspace_generation: context.workspace_generation,
    task_id: event.task_id,
    actor_id: animationActor(context, event.task_id),
    actor_role: animationRole(context, event.task_id, "executor"),
    source_sequence: event.sequence,
    event_kind: event.event_kind,
    phase: event.stage_key,
    status: event.severity,
    tool_category: event.source_kind === "acceptance" ? "validation" : event.source_kind === "git" ? "git" : event.source_kind === "tool" ? "other" : event.source_kind === "chatgpt" ? "report" : null,
    from_zone: null,
    safe_summary: shortText(event),
    evidence_refs: [...event.evidence_paths, ...(event.source_ref ? [event.source_ref] : [])],
    occurred_at: event.occurred_at,
    historical: context.historical_task_ids?.has(event.task_id) === true,
    run_id: event.run_id,
    parent_run_id: null,
    related_actor_id: null,
    dependency_task_ids: []
  };
}

export function publicToolOutcomeAnimationSource(
  outcome: PublicToolOutcomeV1 | StoredPublicToolOutcomeV1,
  context?: Pick<OfficeAnimationAdapterContextV1, "historical_task_ids">
): OfficeAnimationSourceEventV1 | null {
  if (!outcome.task_id) return null;
  return {
    version: 1,
    source_type: "public_tool_outcome",
    event_id: outcome.event_id,
    project_id: outcome.project_id,
    workspace_id: outcome.workspace_id,
    workspace_generation: outcome.workspace_generation,
    task_id: outcome.task_id,
    actor_id: outcome.actor_id,
    actor_role: outcome.actor_role,
    source_sequence: "sequence" in outcome ? outcome.sequence : 1,
    event_kind: outcome.tool_name,
    phase: outcome.phase,
    status: outcome.status,
    tool_category: outcome.tool_category,
    from_zone: null,
    safe_summary: outcome.public_summary,
    evidence_refs: outcome.evidence_refs,
    occurred_at: outcome.completed_at,
    historical: context?.historical_task_ids?.has(outcome.task_id) === true,
    run_id: outcome.run_id,
    parent_run_id: null,
    related_actor_id: null,
    dependency_task_ids: []
  };
}

export function runtimeActivityAnimationSource(event: RuntimeActivityEventV2): OfficeAnimationSourceEventV1 | null {
  const taskId = event.objective_id ?? event.attempt_id ?? event.run_id;
  if (!taskId) return null;
  const summary = typeof event.payload.safe_summary === "string" ? event.payload.safe_summary
    : typeof event.payload.public_summary === "string" ? event.payload.public_summary : event.kind;
  const category = event.payload.tool_category;
  return {
    version: 1,
    source_type: "runtime_event",
    event_id: event.event_id,
    project_id: event.project_id,
    workspace_id: event.workspace_id,
    workspace_generation: event.workspace_generation,
    task_id: taskId,
    actor_id: event.actor_id,
    actor_role: event.actor_role,
    source_sequence: event.sequence,
    event_kind: event.kind,
    phase: typeof event.payload.phase === "string" ? event.payload.phase : null,
    status: event.terminal ? "terminal" : null,
    tool_category: typeof category === "string" && ["read", "write", "validation", "browser", "git", "report", "other"].includes(category)
      ? category as OfficeAnimationSourceEventV1["tool_category"] : null,
    from_zone: null,
    safe_summary: summary,
    evidence_refs: typeof event.payload.evidence_ref === "string" ? [event.payload.evidence_ref] : [],
    occurred_at: event.occurred_at,
    historical: false,
    run_id: event.run_id,
    parent_run_id: typeof event.payload.parent_run_id === "string" ? event.payload.parent_run_id : null,
    related_actor_id: typeof event.payload.related_actor_id === "string" ? event.payload.related_actor_id : null,
    dependency_task_ids: Array.isArray(event.payload.dependency_task_ids)
      ? event.payload.dependency_task_ids.filter((item): item is string => typeof item === "string") : []
  };
}

export function structuredRuntimeAnimationSource(event: StructuredRuntimeEventEnvelopeV1, context: OfficeAnimationAdapterContextV1): OfficeAnimationSourceEventV1 {
  return {
    version: 1,
    source_type: "structured_runtime_event",
    event_id: event.idempotency_key,
    project_id: context.project_id,
    workspace_id: context.workspace_id,
    workspace_generation: context.workspace_generation,
    task_id: event.task_id,
    actor_id: animationActor(context, event.task_id, event.component_id),
    actor_role: animationRole(context, event.task_id, "executor"),
    source_sequence: event.sequence,
    event_kind: event.event_name,
    phase: null,
    status: event.terminal ? "terminal" : null,
    tool_category: null,
    from_zone: null,
    safe_summary: event.event_name,
    evidence_refs: event.evidence_ref ? [event.evidence_ref] : [],
    occurred_at: event.timestamp,
    historical: context.historical_task_ids?.has(event.task_id) === true,
    run_id: event.run_id,
    parent_run_id: event.parent_run_id,
    related_actor_id: null,
    dependency_task_ids: []
  };
}
