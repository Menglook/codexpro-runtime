import { createHash } from "node:crypto";
import type {
  TaskReportEventV1,
  TaskReportStageSummaryV1,
  TaskReportSummaryV1
} from "./taskReportTypes.js";

export const TASK_REPORT_PROJECTION_VERSION = 1;

export interface TaskReportProjectionSourceSummaryV1 {
  event_digest: string;
  event_bytes: number;
  source_kinds: string[];
  latest_created_at: string | null;
}

export interface TaskReportProjectionMetaV1 {
  version: 1;
  projection_version: number;
  task_id: string;
  project_id: string | null;
  latest_sequence: number;
  valid_event_count: number;
  invalid_line_count: number;
  incomplete_tail: boolean;
  backfill_version: number | null;
  source_summary: TaskReportProjectionSourceSummaryV1;
  stages: TaskReportStageSummaryV1[];
  updated_at: string;
}

export interface TaskReportProjectionV1 {
  summary: TaskReportSummaryV1;
  meta: TaskReportProjectionMetaV1;
}

export interface TaskReportProjectionOptions {
  invalidLineCount?: number;
  incompleteTail?: boolean;
  eventBytes?: number;
  backfillVersion?: number | null;
  updatedAt?: string;
}

const CONCLUSION_EVENTS = new Set<TaskReportEventV1["event_kind"]>([
  "waiting_user",
  "blocked",
  "validation_passed",
  "validation_failed",
  "git_committed",
  "git_pushed",
  "git_failed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "assistant_summary"
]);

const IMPORTANT_FEED_EVENTS = new Set<TaskReportEventV1["event_kind"]>([
  "task_started",
  "stage_started",
  "finding",
  "warning",
  "waiting_user",
  "blocked",
  "recovery_started",
  "recovery_completed",
  "stage_completed",
  "validation_started",
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

function eventStageStatus(event: TaskReportEventV1): TaskReportStageSummaryV1["status"] | null {
  switch (event.event_kind) {
    case "stage_started":
    case "recovery_started":
    case "recovery_completed":
      return "running";
    case "stage_completed":
      return "completed";
    case "validation_failed":
    case "task_failed":
      return "failed";
    case "blocked":
    case "waiting_user":
      return "blocked";
    default:
      return null;
  }
}

function reportArtifactPath(event: TaskReportEventV1, fileName: string): string | null {
  for (let index = event.evidence_paths.length - 1; index >= 0; index -= 1) {
    const candidate = event.evidence_paths[index];
    if (candidate.replaceAll("\\", "/").split("/").pop()?.toLowerCase() === fileName) return candidate;
  }
  return null;
}

function sourceDigest(events: readonly TaskReportEventV1[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(JSON.stringify(event));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function projectTaskReportEvents(
  taskId: string,
  inputEvents: readonly TaskReportEventV1[],
  options: TaskReportProjectionOptions = {}
): TaskReportProjectionV1 {
  const events = [...inputEvents]
    .filter((event) => event.task_id === taskId)
    .sort((left, right) => left.sequence - right.sequence || left.created_at.localeCompare(right.created_at));
  const stages = new Map<string, TaskReportStageSummaryV1>();
  let bossReportPath: string | null = null;
  let technicalReportPath: string | null = null;
  let finalSummary: string | null = null;

  for (const event of events) {
    if (event.stage_key) {
      const current = stages.get(event.stage_key);
      const next: TaskReportStageSummaryV1 = current ?? {
        stage_key: event.stage_key,
        stage_title: event.stage_title?.trim() || event.stage_key,
        status: "pending",
        first_sequence: event.sequence,
        latest_sequence: event.sequence,
        event_count: 0,
        started_at: null,
        completed_at: null,
        latest_summary: null
      };
      next.stage_title = event.stage_title?.trim() || next.stage_title;
      next.latest_sequence = event.sequence;
      next.event_count += 1;
      next.latest_summary = event.summary;
      if (event.event_kind === "stage_started" && next.started_at === null) next.started_at = event.occurred_at;
      if (event.event_kind === "stage_completed") next.completed_at = event.occurred_at;
      const status = eventStageStatus(event);
      if (status) next.status = status;
      stages.set(event.stage_key, next);
    }
    if (CONCLUSION_EVENTS.has(event.event_kind)) finalSummary = event.summary;
    if (event.event_kind === "artifact_created") {
      bossReportPath = reportArtifactPath(event, "boss-report-full.md") ?? bossReportPath;
      technicalReportPath = reportArtifactPath(event, "task-report.md") ?? technicalReportPath;
    }
  }

  const latest = events.at(-1);
  const latestImportantEvent = [...events].reverse().find((event) => IMPORTANT_FEED_EVENTS.has(event.event_kind));
  const latestStageEvent = [...events].reverse().find((event) => event.stage_key !== null);
  const stageList = [...stages.values()].sort((left, right) => left.first_sequence - right.first_sequence);
  const summary: TaskReportSummaryV1 = {
    task_id: taskId,
    latest_sequence: latest?.sequence ?? 0,
    event_count: events.length,
    latest_event_at: latest?.occurred_at ?? null,
    current_stage_key: latestStageEvent?.stage_key ?? null,
    current_stage_title: latestStageEvent?.stage_title ?? null,
    current_title: latest?.title ?? null,
    current_summary: latest?.summary ?? null,
    current_source_kind: latest?.source_kind ?? null,
    latest_important_event: latestImportantEvent ? {
      event_id: latestImportantEvent.event_id,
      idempotency_key: latestImportantEvent.idempotency_key,
      sequence: latestImportantEvent.sequence,
      event_kind: latestImportantEvent.event_kind,
      severity: latestImportantEvent.severity,
      title: latestImportantEvent.title,
      summary: latestImportantEvent.summary,
      occurred_at: latestImportantEvent.occurred_at,
      source_kind: latestImportantEvent.source_kind
    } : null,
    finding_count: events.filter((event) => event.event_kind === "finding").length,
    warning_count: events.filter((event) => event.event_kind === "warning").length,
    action_required_count: events.filter((event) => event.severity === "action_required").length,
    final_summary: finalSummary,
    boss_report_path: bossReportPath,
    technical_report_path: technicalReportPath
  };
  const sourceKinds = [...new Set(events.map((event) => event.source_kind))].sort();
  const latestCreatedAt = [...events]
    .map((event) => event.created_at)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? null;
  return {
    summary,
    meta: {
      version: 1,
      projection_version: TASK_REPORT_PROJECTION_VERSION,
      task_id: taskId,
      project_id: latest?.project_id ?? null,
      latest_sequence: summary.latest_sequence,
      valid_event_count: events.length,
      invalid_line_count: Math.max(0, options.invalidLineCount ?? 0),
      incomplete_tail: options.incompleteTail ?? false,
      backfill_version: options.backfillVersion ?? null,
      source_summary: {
        event_digest: sourceDigest(events),
        event_bytes: Math.max(0, options.eventBytes ?? 0),
        source_kinds: sourceKinds,
        latest_created_at: latestCreatedAt
      },
      stages: stageList,
      updated_at: options.updatedAt ?? new Date().toISOString()
    }
  };
}

export function isTaskReportSummaryV1(value: unknown, taskId: string): value is TaskReportSummaryV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TaskReportSummaryV1>;
  return candidate.task_id === taskId
    && Number.isInteger(candidate.latest_sequence)
    && Number(candidate.latest_sequence) >= 0
    && Number.isInteger(candidate.event_count)
    && Number(candidate.event_count) >= 0;
}

export function isTaskReportProjectionMetaV1(value: unknown, taskId: string): value is TaskReportProjectionMetaV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TaskReportProjectionMetaV1>;
  return candidate.version === 1
    && candidate.projection_version === TASK_REPORT_PROJECTION_VERSION
    && candidate.task_id === taskId
    && Number.isInteger(candidate.latest_sequence)
    && Number(candidate.latest_sequence) >= 0
    && Number.isInteger(candidate.valid_event_count)
    && Number(candidate.valid_event_count) >= 0
    && Number.isInteger(candidate.invalid_line_count)
    && Number(candidate.invalid_line_count) >= 0
    && typeof candidate.incomplete_tail === "boolean"
    && Boolean(candidate.source_summary)
    && Array.isArray(candidate.stages)
    && typeof candidate.updated_at === "string"
    && Number.isFinite(Date.parse(candidate.updated_at));
}
