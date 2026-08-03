import { createHash } from "node:crypto";
import { redactSensitiveText } from "../redact.js";

export const TASK_REPORT_EVENT_KINDS = [
  "task_started",
  "stage_started",
  "progress",
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
  "artifact_created",
  "git_committed",
  "git_pushed",
  "git_failed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "assistant_progress",
  "assistant_summary"
] as const;

export type TaskReportEventKind = typeof TASK_REPORT_EVENT_KINDS[number];

export const TASK_REPORT_SEVERITIES = ["info", "success", "warning", "error", "action_required"] as const;
export type TaskReportSeverity = typeof TASK_REPORT_SEVERITIES[number];

export const TASK_REPORT_SOURCE_KINDS = ["durable_job", "goal", "handoff", "acceptance", "git", "tool", "chatgpt"] as const;
export type TaskReportSourceKind = typeof TASK_REPORT_SOURCE_KINDS[number];

export interface TaskReportEventV1 {
  version: 1;
  event_id: string;
  idempotency_key: string;
  sequence: number;
  project_id: string;
  objective_key: string | null;
  task_id: string;
  run_id: string | null;
  attempt_id: string | null;
  stage_key: string | null;
  stage_title: string | null;
  event_kind: TaskReportEventKind;
  severity: TaskReportSeverity;
  title: string;
  summary: string;
  detail_markdown: string | null;
  evidence_paths: string[];
  source_kind: TaskReportSourceKind;
  source_ref: string | null;
  occurred_at: string;
  created_at: string;
}

export interface TaskReportSummaryV1 {
  task_id: string;
  latest_sequence: number;
  event_count: number;
  latest_event_at: string | null;
  current_stage_key: string | null;
  current_stage_title: string | null;
  current_title: string | null;
  current_summary: string | null;
  current_source_kind?: TaskReportSourceKind | null;
  latest_important_event?: {
    event_id: string;
    idempotency_key: string;
    sequence: number;
    event_kind: TaskReportEventKind;
    severity: TaskReportSeverity;
    title: string;
    summary: string;
    occurred_at: string;
    source_kind: TaskReportSourceKind;
  } | null;
  finding_count: number;
  warning_count: number;
  action_required_count: number;
  final_summary: string | null;
  boss_report_path: string | null;
  technical_report_path: string | null;
}

export interface TaskReportStageSummaryV1 {
  stage_key: string;
  stage_title: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "unknown";
  first_sequence: number;
  latest_sequence: number;
  event_count: number;
  started_at: string | null;
  completed_at: string | null;
  latest_summary: string | null;
}

export const TASK_REPORT_LIMITS = Object.freeze({
  title_chars: 200,
  summary_chars: 1_000,
  detail_markdown_chars: 20_000,
  evidence_paths: 20,
  identifier_chars: 200,
  idempotency_key_chars: 200
});

export const TASK_REPORT_STATE_AUTHORITY = Object.freeze({
  owns_task_state: false,
  role: "explanatory_projection" as const,
  authoritative_sources: Object.freeze([
    "goal_store",
    "durable_job_store",
    "task_projection",
    "objective_projection",
    "git_finalization",
    "acceptance",
    "handoff_state",
    "structured_runtime_event"
  ]),
  rule: "A report event may explain an authoritative fact but cannot create or change that fact."
});

export interface TaskReportSourcePresentation {
  label: string;
  authority: "runtime_fact_explanation" | "assistant_commentary";
  visually_distinct: boolean;
}

export const TASK_REPORT_SOURCE_PRESENTATION: Readonly<Record<TaskReportSourceKind, TaskReportSourcePresentation>> = Object.freeze({
  durable_job: Object.freeze({ label: "CodexPro 运行回报", authority: "runtime_fact_explanation", visually_distinct: false }),
  goal: Object.freeze({ label: "CodexPro 目标回报", authority: "runtime_fact_explanation", visually_distinct: false }),
  handoff: Object.freeze({ label: "CodexPro Handoff 回报", authority: "runtime_fact_explanation", visually_distinct: false }),
  acceptance: Object.freeze({ label: "CodexPro 验收回报", authority: "runtime_fact_explanation", visually_distinct: false }),
  git: Object.freeze({ label: "CodexPro Git 交付回报", authority: "runtime_fact_explanation", visually_distinct: false }),
  tool: Object.freeze({ label: "CodexPro 工具事实", authority: "runtime_fact_explanation", visually_distinct: false }),
  chatgpt: Object.freeze({ label: "ChatGPT 公开说明", authority: "assistant_commentary", visually_distinct: true })
});

const SOURCE_EVENT_KINDS: Readonly<Record<TaskReportSourceKind, ReadonlySet<TaskReportEventKind>>> = Object.freeze({
  durable_job: new Set<TaskReportEventKind>([
    "task_started", "stage_started", "progress", "finding", "warning", "waiting_user", "blocked",
    "recovery_started", "recovery_completed", "stage_completed", "artifact_created", "task_completed",
    "task_failed", "task_cancelled"
  ]),
  goal: new Set<TaskReportEventKind>([
    "task_started", "stage_started", "progress", "finding", "warning", "waiting_user", "blocked",
    "recovery_started", "recovery_completed", "stage_completed", "artifact_created", "task_completed",
    "task_failed", "task_cancelled"
  ]),
  handoff: new Set<TaskReportEventKind>([
    "task_started", "stage_started", "progress", "finding", "warning", "waiting_user", "blocked",
    "recovery_started", "recovery_completed", "stage_completed", "artifact_created", "task_completed",
    "task_failed", "task_cancelled"
  ]),
  acceptance: new Set<TaskReportEventKind>(["validation_started", "validation_passed", "validation_failed", "warning", "blocked", "artifact_created"]),
  git: new Set<TaskReportEventKind>(["git_committed", "git_pushed", "git_failed", "warning", "artifact_created"]),
  tool: new Set<TaskReportEventKind>(["progress", "finding", "warning", "artifact_created"]),
  chatgpt: new Set<TaskReportEventKind>(["assistant_progress", "finding", "warning", "assistant_summary"])
});

const SEVERITIES_BY_EVENT: Readonly<Record<TaskReportEventKind, ReadonlySet<TaskReportSeverity>>> = Object.freeze({
  task_started: new Set<TaskReportSeverity>(["info"]),
  stage_started: new Set<TaskReportSeverity>(["info"]),
  progress: new Set<TaskReportSeverity>(["info"]),
  finding: new Set<TaskReportSeverity>(["info", "success", "warning"]),
  warning: new Set<TaskReportSeverity>(["warning", "action_required"]),
  waiting_user: new Set<TaskReportSeverity>(["action_required"]),
  blocked: new Set<TaskReportSeverity>(["error", "action_required"]),
  recovery_started: new Set<TaskReportSeverity>(["info", "warning"]),
  recovery_completed: new Set<TaskReportSeverity>(["success"]),
  stage_completed: new Set<TaskReportSeverity>(["success"]),
  validation_started: new Set<TaskReportSeverity>(["info"]),
  validation_passed: new Set<TaskReportSeverity>(["success"]),
  validation_failed: new Set<TaskReportSeverity>(["error"]),
  artifact_created: new Set<TaskReportSeverity>(["info", "success"]),
  git_committed: new Set<TaskReportSeverity>(["success"]),
  git_pushed: new Set<TaskReportSeverity>(["success"]),
  git_failed: new Set<TaskReportSeverity>(["error"]),
  task_completed: new Set<TaskReportSeverity>(["success"]),
  task_failed: new Set<TaskReportSeverity>(["error"]),
  task_cancelled: new Set<TaskReportSeverity>(["warning"]),
  assistant_progress: new Set<TaskReportSeverity>(["info", "success", "warning"]),
  assistant_summary: new Set<TaskReportSeverity>(["info", "success", "warning", "error", "action_required"])
});

const STAGE_EVENTS = new Set<TaskReportEventKind>(["stage_started", "stage_completed"]);
const AUTHORITATIVE_CLAIM_EVENTS = new Set<TaskReportEventKind>([
  "recovery_completed",
  "stage_completed",
  "validation_passed",
  "validation_failed",
  "artifact_created",
  "git_committed",
  "git_pushed",
  "git_failed",
  "task_completed",
  "task_failed",
  "task_cancelled"
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface TaskReportSemanticIssue {
  code:
    | "invalid_version"
    | "invalid_identifier"
    | "invalid_sequence"
    | "invalid_timestamp"
    | "invalid_event_kind"
    | "invalid_severity"
    | "source_event_mismatch"
    | "chatgpt_runtime_impersonation"
    | "stage_metadata_required"
    | "title_required"
    | "title_too_long"
    | "summary_required"
    | "summary_too_long"
    | "detail_too_long"
    | "too_many_evidence_paths"
    | "unsafe_evidence_path"
    | "finding_evidence_required"
    | "authoritative_claim_evidence_required";
  field: string;
  message: string;
}

function issue(code: TaskReportSemanticIssue["code"], field: string, message: string): TaskReportSemanticIssue {
  return { code, field, message };
}

function validIdentifier(value: unknown, allowNull = false): boolean {
  if (allowNull && value === null) return true;
  return typeof value === "string"
    && value.length > 0
    && value.length <= TASK_REPORT_LIMITS.identifier_chars
    && IDENTIFIER_PATTERN.test(value);
}

function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function isTaskReportEventKind(value: unknown): value is TaskReportEventKind {
  return typeof value === "string" && (TASK_REPORT_EVENT_KINDS as readonly string[]).includes(value);
}

export function isSafeTaskReportRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) return false;
  if (/%(?:2e|2f|5c)/i.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return false;
  const segments = normalized.split("/");
  return segments.every((segment) => Boolean(segment)
    && segment !== "."
    && segment !== ".."
    && !/[\u0000-\u001f\u007f]/u.test(segment));
}

export function taskReportDeduplicationKey(projectId: string, taskId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${projectId}\0${taskId}\0${idempotencyKey}`).digest("hex");
}

export function taskReportProgressFingerprint(event: Pick<TaskReportEventV1,
  "project_id" | "task_id" | "stage_key" | "event_kind" | "title" | "summary" | "detail_markdown" | "evidence_paths" | "source_kind" | "source_ref"
>): string {
  const stable = JSON.stringify({
    project_id: event.project_id,
    task_id: event.task_id,
    stage_key: event.stage_key,
    event_kind: event.event_kind,
    title: event.title.trim(),
    summary: event.summary.trim(),
    detail_markdown: event.detail_markdown?.trim() ?? null,
    evidence_paths: [...new Set(event.evidence_paths)].sort(),
    source_kind: event.source_kind,
    source_ref: event.source_ref
  });
  return `sha256:${createHash("sha256").update(stable).digest("hex")}`;
}

function clippedRedactedText(value: string, max: number, trim: boolean): string {
  const redacted = redactSensitiveText(value).replaceAll("\r\n", "\n");
  return (trim ? redacted.trim() : redacted).slice(0, max);
}

export function sanitizeTaskReportEventV1(event: TaskReportEventV1): TaskReportEventV1 {
  return {
    ...event,
    stage_title: event.stage_title === null
      ? null
      : clippedRedactedText(event.stage_title, TASK_REPORT_LIMITS.title_chars, true),
    title: clippedRedactedText(event.title, TASK_REPORT_LIMITS.title_chars, true),
    summary: clippedRedactedText(event.summary, TASK_REPORT_LIMITS.summary_chars, true),
    detail_markdown: event.detail_markdown === null
      ? null
      : clippedRedactedText(event.detail_markdown, TASK_REPORT_LIMITS.detail_markdown_chars, false),
    source_ref: event.source_ref === null ? null : clippedRedactedText(event.source_ref, 4_096, true),
    evidence_paths: [...new Set(event.evidence_paths.map((value) => clippedRedactedText(value, 4_096, true)))]
      .slice(0, TASK_REPORT_LIMITS.evidence_paths)
  };
}

export function validateTaskReportEventV1(event: TaskReportEventV1): TaskReportSemanticIssue[] {
  const issues: TaskReportSemanticIssue[] = [];
  if (event.version !== 1) issues.push(issue("invalid_version", "version", "Task report events must use version 1."));
  for (const [field, value, allowNull] of [
    ["event_id", event.event_id, false],
    ["idempotency_key", event.idempotency_key, false],
    ["project_id", event.project_id, false],
    ["task_id", event.task_id, false],
    ["objective_key", event.objective_key, true],
    ["run_id", event.run_id, true],
    ["attempt_id", event.attempt_id, true],
    ["stage_key", event.stage_key, true]
  ] as const) {
    if (!validIdentifier(value, allowNull)) issues.push(issue("invalid_identifier", field, `${field} must use bounded stable identifier characters.`));
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) issues.push(issue("invalid_sequence", "sequence", "sequence must be a positive integer."));
  if (!validTimestamp(event.occurred_at)) issues.push(issue("invalid_timestamp", "occurred_at", "occurred_at must be a valid timestamp."));
  if (!validTimestamp(event.created_at)) issues.push(issue("invalid_timestamp", "created_at", "created_at must be a valid timestamp."));
  if (!isTaskReportEventKind(event.event_kind)) issues.push(issue("invalid_event_kind", "event_kind", "Unknown task report event kind."));

  const allowedSourceKinds = SOURCE_EVENT_KINDS[event.source_kind];
  if (!allowedSourceKinds?.has(event.event_kind)) {
    issues.push(issue("source_event_mismatch", "source_kind", `${event.source_kind} cannot publish ${event.event_kind}.`));
    if (event.source_kind === "chatgpt") {
      issues.push(issue("chatgpt_runtime_impersonation", "source_kind", "ChatGPT report events cannot impersonate runtime, acceptance, Git, or terminal task facts."));
    }
  }
  if (!SEVERITIES_BY_EVENT[event.event_kind]?.has(event.severity)) {
    issues.push(issue("invalid_severity", "severity", `${event.severity} is not valid for ${event.event_kind}.`));
  }
  if (STAGE_EVENTS.has(event.event_kind) && (!event.stage_key || !event.stage_title?.trim())) {
    issues.push(issue("stage_metadata_required", "stage_key", `${event.event_kind} requires stage_key and stage_title.`));
  }
  if (!event.title.trim()) issues.push(issue("title_required", "title", "title is required."));
  if (event.title.length > TASK_REPORT_LIMITS.title_chars) issues.push(issue("title_too_long", "title", `title exceeds ${TASK_REPORT_LIMITS.title_chars} characters.`));
  if (!event.summary.trim()) issues.push(issue("summary_required", "summary", "summary is required."));
  if (event.summary.length > TASK_REPORT_LIMITS.summary_chars) issues.push(issue("summary_too_long", "summary", `summary exceeds ${TASK_REPORT_LIMITS.summary_chars} characters.`));
  if ((event.detail_markdown?.length ?? 0) > TASK_REPORT_LIMITS.detail_markdown_chars) {
    issues.push(issue("detail_too_long", "detail_markdown", `detail_markdown exceeds ${TASK_REPORT_LIMITS.detail_markdown_chars} characters.`));
  }
  if (event.evidence_paths.length > TASK_REPORT_LIMITS.evidence_paths) {
    issues.push(issue("too_many_evidence_paths", "evidence_paths", `At most ${TASK_REPORT_LIMITS.evidence_paths} evidence paths are allowed.`));
  }
  event.evidence_paths.forEach((path, index) => {
    if (!isSafeTaskReportRelativePath(path)) issues.push(issue("unsafe_evidence_path", `evidence_paths.${index}`, "Evidence paths must be safe workspace-relative paths."));
  });
  if (event.event_kind === "finding" && event.evidence_paths.length === 0) {
    issues.push(issue("finding_evidence_required", "evidence_paths", "A deterministic finding requires at least one evidence path."));
  }
  if (AUTHORITATIVE_CLAIM_EVENTS.has(event.event_kind) && !event.source_ref && event.evidence_paths.length === 0) {
    issues.push(issue("authoritative_claim_evidence_required", "source_ref", `${event.event_kind} must reference authoritative source evidence.`));
  }
  return issues;
}
