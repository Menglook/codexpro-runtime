import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus, type CodexProEvent } from "../events/eventBus.js";
import { GoalStore } from "../goals/goalStore.js";
import type { GoalRecord } from "../goals/types.js";
import { isSubpath, PathGuard, type Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import type { ObjectiveProjectionV1 } from "../tasks/objectiveProjectionService.js";
import { ProjectionSnapshotProvider } from "../tasks/projectionSnapshot.js";
import { TaskProjectionService } from "../tasks/taskProjectionService.js";
import type { TaskProjectionListObservability, TaskRecoveryPlan, TaskStatusProjection } from "../tasks/types.js";
import { browserAuthorizationStore } from "../browser/browser-authorization.js";
import {
  discoverDashboardProjects,
  isAllowedDashboardArtifactPath,
  matchesProjectFilter,
  workspaceForDashboardProject,
  type DashboardProjectSummary
} from "./projectAggregationService.js";

const ATTENTION_ROOT = ".ai-bridge/console-attention";
const EVENTS_FILE = "events.json";
const ATTENTION_FILE = "attention.json";
const SCHEMA_VERSION = 1;
const MAX_TASKS_PER_PROJECT = 250;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EVENT_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const ATTENTION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_EVENTS = 1_000;
const MAX_EVENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTENTION_ITEMS = 500;
const MAX_ATTENTION_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_RECORDS = 500;
const MAX_AUDIT_BYTES = 1024 * 1024;
const EVENT_RECONCILE_DEBOUNCE_MS = 250;
const SAFE_ATTENTION_ID = /^attn_[a-f0-9]{24,64}$/;
const SAFE_PROJECT_SELECTOR = /^[A-Za-z0-9._:/\\ -]{1,260}$/;

export type ConsoleAttentionType =
  | "approval_required"
  | "browser_authorization"
  | "recovery_required"
  | "resource_blocked"
  | "decision_required"
  | "task_failed";

export type ConsoleAttentionEventType =
  | "task_persisted"
  | "task_taken_over"
  | "task_completed"
  | "task_failed"
  | "recovery_required"
  | "approval_required"
  | "browser_authorization"
  | "decision_required"
  | "external_service_wait"
  | "resource_blocked"
  | "local_version_recorded"
  | "remote_sync_succeeded"
  | "remote_sync_failed";

export type ConsoleAttentionSeverity = "info" | "warning" | "critical";

export interface ConsoleAttentionArtifact {
  path: string;
  href: string;
}

export interface ConsoleAttentionEventRecord {
  version: 1;
  event_id: string;
  sequence: number;
  dedupe_key: string;
  project_id: string;
  project: string;
  task_id: string | null;
  task_title: string | null;
  type: ConsoleAttentionEventType;
  severity: ConsoleAttentionSeverity;
  status: string | null;
  domain_status: string | null;
  reason: string;
  recommended_action: string;
  created_at: string;
  expires_at: string;
  artifacts: ConsoleAttentionArtifact[];
}

export interface ConsoleAttentionItemRecord {
  version: 1;
  attention_id: string;
  dedupe_key: string;
  project_id: string;
  project: string;
  task_id: string;
  task_title: string | null;
  objective_key?: string;
  attempt_id?: string;
  requires_human?: boolean;
  action_code?: string;
  action_available?: boolean;
  impact_if_ignored?: string;
  verification_rule?: string;
  condition_fingerprint?: string;
  generation?: number;
  type: ConsoleAttentionType;
  severity: ConsoleAttentionSeverity;
  status: string;
  domain_status: string;
  reason: string;
  recommended_action: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolved_reason: string | null;
  acknowledged_at: string | null;
  artifacts: ConsoleAttentionArtifact[];
}

interface EventsFile {
  version: 1;
  schema_version: 1;
  next_sequence: number;
  updated_at: string;
  events: ConsoleAttentionEventRecord[];
}

interface AttentionFile {
  version: 1;
  schema_version: 1;
  updated_at: string;
  attention: ConsoleAttentionItemRecord[];
}

interface ProjectAttentionState {
  eventsFile: EventsFile;
  attentionFile: AttentionFile;
}

interface DesiredEvent {
  dedupe_key: string;
  task_id: string | null;
  task_title: string | null;
  type: ConsoleAttentionEventType;
  severity: ConsoleAttentionSeverity;
  status: string | null;
  domain_status: string | null;
  reason: string;
  recommended_action: string;
  artifacts: ConsoleAttentionArtifact[];
}

interface DesiredAttention {
  dedupe_key: string;
  task_id: string;
  task_title: string | null;
  objective_key: string;
  attempt_id: string;
  requires_human: true;
  action_code: string;
  action_available: boolean;
  impact_if_ignored: string;
  verification_rule: string;
  condition_fingerprint: string;
  type: ConsoleAttentionType;
  severity: ConsoleAttentionSeverity;
  status: string;
  domain_status: string;
  reason: string;
  recommended_action: string;
  artifacts: ConsoleAttentionArtifact[];
}

interface AttentionAuditRecord {
  version: 1;
  audit_id: string;
  created_at: string;
  project_id: string;
  project: string;
  attention_id: string | null;
  task_id: string | null;
  action: "acknowledge";
  decision: "allowed" | "rejected";
  reason: string;
  result_status: number;
}

export interface AttentionQueryResponse {
  ok: true;
  generated_at: string;
  cursor: string | null;
  next_cursor: string;
  limit: number;
  summary: {
    unresolved_count: number;
    event_count: number;
    by_type: Record<string, number>;
    by_severity: Record<string, number>;
    by_project: Record<string, number>;
  };
  projects: Array<{
    project_id: string;
    project: string;
    available: boolean;
    unresolved_count: number;
    latest_event_sequence: number;
  }>;
  attention: ConsoleAttentionItemRecord[];
  events: ConsoleAttentionEventRecord[];
  retention: {
    event_ttl_ms: number;
    attention_ttl_ms: number;
    max_events_per_project: number;
    max_attention_items_per_project: number;
  };
  projection_observability: AttentionProjectionObservability;
}

export interface AttentionReconcileObservability {
  version: 1;
  project_id: string;
  project: string;
  duration_ms: number;
  task_count: number;
  generated_event_count: number;
  generated_attention_count: number;
  invocation_counts: {
    task_projection: number;
    projection_snapshot_hit: number;
    projection_snapshot_miss: number;
    recovery_lookup: number;
    goal_load: number;
    state_read: number;
    state_write: number;
  };
  task_projection_observability: TaskProjectionListObservability | null;
}

export interface AttentionProjectionObservability {
  version: 1;
  generated_at: string;
  source: "attention_projection";
  requested_limit: number;
  bounded_limit: number;
  max_limit: number;
  bounded: boolean;
  project_count: number;
  duration_ms: number;
  durations_ms: {
    reconcile: number;
    state_read: number;
    sort_and_cursor: number;
  };
  invocation_counts: {
    project_discovery: number;
    reconcile_project: number;
    state_read: number;
  };
  reconciliation: AttentionReconcileObservability[];
}

export interface AttentionQueryOptions {
  projectionSnapshotProvider?: ProjectionSnapshotProvider;
}

export class AttentionServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AttentionServiceError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function expiresAt(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventIdFor(dedupeKey: string): string {
  return `evt_${sha256(dedupeKey).slice(0, 32)}`;
}

function attentionIdFor(dedupeKey: string): string {
  return `attn_${sha256(dedupeKey).slice(0, 32)}`;
}

function stripUrlPayloads(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[REDACTED_URL]";
    }
  });
}

function clippedText(value: unknown, max = 500): string {
  const text = String(value ?? "")
    .replace(/[\u0000\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripUrlPayloads(redactSensitiveText(text)).slice(0, max);
}

function compactTitle(value: unknown): string | null {
  const text = clippedText(value, 120);
  return text || null;
}

function normalizeProjectSelector(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new AttentionServiceError(400, "invalid_project", "Project selector must be a string.");
  const selector = raw.trim();
  if (!selector || selector.length > 260 || !SAFE_PROJECT_SELECTOR.test(selector)) {
    throw new AttentionServiceError(400, "invalid_project", "Project selector is invalid.");
  }
  return selector;
}

function parseLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new AttentionServiceError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return parsed;
}

function encodeCursor(positions: Record<string, number>): string {
  const stable: Record<string, number> = {};
  for (const [key, value] of Object.entries(positions).sort(([left], [right]) => left.localeCompare(right))) {
    stable[key] = Math.max(0, Math.floor(value));
  }
  return Buffer.from(JSON.stringify({ version: 1, positions: stable }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): Record<string, number> {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string" || raw.length > 8_000) {
    throw new AttentionServiceError(400, "invalid_cursor", "Cursor is invalid.");
  }
  if (raw === "0") return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const cursor = parsed as { version?: unknown; positions?: unknown };
    if (cursor.version !== 1 || !cursor.positions || typeof cursor.positions !== "object" || Array.isArray(cursor.positions)) {
      throw new Error("bad cursor schema");
    }
    const out: Record<string, number> = {};
    for (const [projectId, sequence] of Object.entries(cursor.positions as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(projectId)) throw new Error("bad project id");
      if (!Number.isInteger(sequence) || Number(sequence) < 0) throw new Error("bad sequence");
      out[projectId] = Number(sequence);
    }
    return out;
  } catch {
    throw new AttentionServiceError(400, "invalid_cursor", "Cursor is invalid or expired.");
  }
}

function emptyEventsFile(): EventsFile {
  return {
    version: 1,
    schema_version: SCHEMA_VERSION,
    next_sequence: 1,
    updated_at: nowIso(),
    events: []
  };
}

function emptyAttentionFile(): AttentionFile {
  return {
    version: 1,
    schema_version: SCHEMA_VERSION,
    updated_at: nowIso(),
    attention: []
  };
}

function latestSequence(events: ConsoleAttentionEventRecord[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0);
}

function severityRank(value: ConsoleAttentionSeverity): number {
  if (value === "critical") return 3;
  if (value === "warning") return 2;
  return 1;
}

function countBy<T extends string>(items: T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((result, item) => {
    result[item] = (result[item] ?? 0) + 1;
    return result;
  }, {});
}

function statusSignature(task: TaskStatusProjection, recovery?: TaskRecoveryPlan): string {
  const reason = [
    task.progress.wait_reason,
    task.liveness.reason,
    recovery?.mode,
    recovery?.action,
    recovery?.current_step_id,
    recovery?.next_step_id,
    recovery?.reason
  ].map((item) => clippedText(item, 240)).join("|");
  return sha256([
    task.identity.kind,
    task.identity.domain_id,
    task.status,
    task.domain_status,
    task.progress.phase,
    task.progress.execution_state,
    reason
  ].join("|")).slice(0, 24);
}

function terminalSignature(task: TaskStatusProjection): string {
  return sha256([
    task.identity.kind,
    task.identity.domain_id,
    task.status,
    task.domain_status
  ].join("|")).slice(0, 24);
}

function taskObjectiveKey(task: TaskStatusProjection): string {
  return task.identity.objective?.objective_key ?? `legacy:${task.identity.kind}:${task.identity.domain_id}`;
}

function attentionDedupe(project: DashboardProjectSummary, objectiveKey: string, type: ConsoleAttentionType): string {
  return `${project.project_id}:${objectiveKey}:attention:${type}`;
}

function attentionRequiresHuman(
  type: ConsoleAttentionType,
  objective: ObjectiveProjectionV1 | undefined
): boolean {
  if (type === "approval_required" || type === "browser_authorization" || type === "decision_required" || type === "resource_blocked") return true;
  return objective?.requires_human === true;
}

function attentionAction(type: ConsoleAttentionType, recovery?: TaskRecoveryPlan): {
  action_code: string;
  action_available: boolean;
  impact_if_ignored: string;
  verification_rule: string;
} {
  if (type === "approval_required") {
    return {
      action_code: "review_approval",
      action_available: true,
      impact_if_ignored: "The Objective remains blocked and no protected action is executed.",
      verification_rule: "The authoritative Goal leaves waiting_approval after an explicit owner decision."
    };
  }
  if (type === "browser_authorization") {
    return {
      action_code: "authorize_browser",
      action_available: true,
      impact_if_ignored: "Browser verification or business-page execution cannot continue.",
      verification_rule: "A valid browser authorization is present and the Objective can re-enter execution."
    };
  }
  if (type === "recovery_required" || type === "task_failed") {
    return {
      action_code: "open_recovery",
      action_available: Boolean(recovery),
      impact_if_ignored: "The Objective cannot safely resume or reach a proven terminal result.",
      verification_rule: "Authority is reconciled and a current Attempt starts, completes, or is explicitly abandoned."
    };
  }
  if (type === "resource_blocked") {
    return {
      action_code: "review_resource_policy",
      action_available: true,
      impact_if_ignored: "Execution remains queued or blocked by the active resource policy.",
      verification_rule: "The resource projection no longer reports queued_by_resource_policy or blocked_by_resource_policy."
    };
  }
  return {
    action_code: "review_decision",
    action_available: true,
    impact_if_ignored: "The Objective remains unable to proceed to a verified delivery state.",
    verification_rule: "The required input or validation decision is persisted and the Objective status changes."
  };
}

function eventDedupe(project: DashboardProjectSummary, taskId: string | null, type: ConsoleAttentionEventType, signature: string): string {
  return `${project.project_id}:${taskId ?? "project"}:event:${type}:${signature}`;
}

function taskArtifacts(project: DashboardProjectSummary, task: TaskStatusProjection): ConsoleAttentionArtifact[] {
  const values = [
    ...task.evidence_paths,
    ...task.acceptance.evidence_paths,
    task.progress.last_evidence
  ].filter((item): item is string => Boolean(item?.trim()));
  const seen = new Set<string>();
  const artifacts: ConsoleAttentionArtifact[] = [];
  for (const value of values) {
    let relPath = value;
    if (path.isAbsolute(value)) {
      const abs = path.resolve(value);
      if (!isSubpath(abs, project.root)) continue;
      relPath = path.relative(project.root, abs);
    }
    const clean = relPath.split(path.sep).join("/").replace(/^\.\//, "");
    if (!isAllowedDashboardArtifactPath(clean) || seen.has(clean)) continue;
    seen.add(clean);
    const params = new URLSearchParams();
    params.set("project", project.project_id);
    params.set("path", clean);
    artifacts.push({ path: clean, href: `/admin/artifact?${params.toString()}` });
    if (artifacts.length >= 5) break;
  }
  return artifacts;
}

function combinedTaskText(task: TaskStatusProjection, recovery?: TaskRecoveryPlan, goal?: GoalRecord): string {
  return [
    task.identity.title,
    task.status,
    task.domain_status,
    task.progress.phase,
    task.progress.current_action,
    task.progress.wait_reason,
    task.liveness.reason,
    task.acceptance.reason,
    recovery?.mode,
    recovery?.action,
    recovery?.reason,
    goal?.failure?.code,
    goal?.failure?.message,
    goal?.hook_delivery?.last_error
  ].map((item) => clippedText(item, 500)).join(" ");
}

function isCancelled(task: TaskStatusProjection): boolean {
  return task.status === "cancelled" || task.domain_status === "cancelled";
}

function isTaskCompleted(task: TaskStatusProjection): boolean {
  if (isCancelled(task)) return false;
  return task.status === "completed" || task.domain_status === "completed" || task.domain_status === "succeeded";
}

function isTaskFailed(task: TaskStatusProjection): boolean {
  if (isCancelled(task)) return false;
  return task.status === "failed"
    || task.domain_status === "failed"
    || task.domain_status === "blocked"
    || task.domain_status === "timed_out";
}

function explicitResourceBlocked(text: string, task: TaskStatusProjection): boolean {
  return task.resource_policy?.status === "queued_by_resource_policy"
    || task.resource_policy?.status === "blocked_by_resource_policy"
    || /blocked_by_resource_policy|queued_by_resource_policy|resource[_ -]?blocked|resource policy|resource_exhausted/i.test(text)
    || task.acceptance.status === "failed" && /blocked_by_resource_policy|resource policy/i.test(task.acceptance.reason);
}

function explicitBrowserAuthorization(text: string): boolean {
  return /(browser|chrome|extension|tab).{0,120}(authori[sz]ation|authorize|auth)|(?:authori[sz]ation|authorize|auth).{0,120}(browser|chrome|extension|tab)/i.test(text);
}

function explicitExternalWait(text: string): boolean {
  return /external service|remote service|provider wait|waiting for service|rate limit|throttl/i.test(text);
}

function eventFromAttention(type: ConsoleAttentionType): ConsoleAttentionEventType {
  if (type === "approval_required") return "approval_required";
  if (type === "browser_authorization") return "browser_authorization";
  if (type === "resource_blocked") return "resource_blocked";
  if (type === "recovery_required") return "recovery_required";
  if (type === "task_failed") return "task_failed";
  if (type === "decision_required") return "decision_required";
  return "external_service_wait";
}

function attentionReason(task: TaskStatusProjection, recovery: TaskRecoveryPlan | undefined, fallback: string): string {
  return clippedText(
    recovery?.reason
      || task.resource_policy?.blocking_reasons?.[0]
      || task.progress.wait_reason
      || task.liveness.reason
      || task.acceptance.reason
      || fallback,
    500
  );
}

function attentionNeedsRecoveryProjection(task: TaskStatusProjection): boolean {
  return task.status === "interrupted"
    || task.status === "recovering"
    || task.liveness.state === "stale"
    || task.domain_status === "recovery_required"
    || task.domain_status === "stale"
    || task.resource_policy?.status === "queued_by_resource_policy"
    || task.resource_policy?.status === "blocked_by_resource_policy";
}

function attentionNeedsGoalRecord(task: TaskStatusProjection): boolean {
  if (task.identity.kind !== "goal") return false;
  return task.status === "waiting"
    || task.status === "implemented_not_verified"
    || task.status === "completed"
    || task.domain_status === "waiting_approval"
    || task.domain_status === "waiting_input"
    || task.domain_status === "succeeded";
}

export class AttentionService {
  private readonly projectQueues = new Map<string, Promise<void>>();
  private readonly eventReconciliations = new Map<string, {
    timer: NodeJS.Timeout;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();

  constructor(
    private readonly config: CodexProConfig,
    private readonly options: { browserAuthorization?: { latest(): unknown | undefined } } = {}
  ) {}

  async getAttention(query: Record<string, unknown>, options: AttentionQueryOptions = {}): Promise<AttentionQueryResponse> {
    const totalStarted = Date.now();
    const projectionSnapshotProvider = options.projectionSnapshotProvider ?? new ProjectionSnapshotProvider(this.config);
    const invocationCounts = {
      project_discovery: 0,
      reconcile_project: 0,
      state_read: 0
    };
    const projectSelector = normalizeProjectSelector(query.project);
    const limit = parseLimit(query.limit);
    const requestedCursor = typeof query.cursor === "string" ? query.cursor : null;
    const cursor = decodeCursor(query.cursor);
    invocationCounts.project_discovery += 1;
    const projects = this.resolveProjects(projectSelector);
    const projectStates: Array<{ project: DashboardProjectSummary; state: ProjectAttentionState }> = [];
    const reconciliation: AttentionReconcileObservability[] = [];

    const reconcileStarted = Date.now();
    invocationCounts.reconcile_project += projects.length;
    reconciliation.push(...await Promise.all(
      projects.map((project) => this.reconcileProjectAttention(project, projectionSnapshotProvider))
    ));
    const reconcileDuration = elapsedSince(reconcileStarted);

    const stateStarted = Date.now();
    invocationCounts.state_read += projects.length;
    projectStates.push(...await Promise.all(
      projects.map(async (project) => ({ project, state: await this.readState(project) }))
    ));
    const stateDuration = elapsedSince(stateStarted);

    const sortStarted = Date.now();
    const allAttention = projectStates
      .flatMap(({ state }) => state.attentionFile.attention)
      .filter((item) => !item.resolved_at)
      .sort((left, right) =>
        severityRank(right.severity) - severityRank(left.severity)
        || right.created_at.localeCompare(left.created_at)
        || left.attention_id.localeCompare(right.attention_id)
      );

    const eventCandidates = projectStates
      .flatMap(({ project, state }) =>
        state.eventsFile.events
          .filter((event) => event.sequence > (cursor[project.project_id] ?? 0))
          .map((event) => ({ project_id: project.project_id, event }))
      )
      .sort((left, right) =>
        left.event.created_at.localeCompare(right.event.created_at)
        || left.project_id.localeCompare(right.project_id)
        || left.event.sequence - right.event.sequence
      );
    const allEvents = eventCandidates.slice(0, limit);

    const nextPositions = { ...cursor };
    for (const { project } of projectStates) {
      nextPositions[project.project_id] ??= 0;
    }
    for (const { project_id, event } of allEvents) {
      nextPositions[project_id] = Math.max(nextPositions[project_id] ?? 0, event.sequence);
    }

    const byType = countBy(allAttention.map((item) => item.type));
    const bySeverity = countBy(allAttention.map((item) => item.severity));
    const byProject = countBy(allAttention.map((item) => item.project_id));
    const sortDuration = elapsedSince(sortStarted);

    return {
      ok: true,
      generated_at: nowIso(),
      cursor: requestedCursor,
      next_cursor: encodeCursor(nextPositions),
      limit,
      summary: {
        unresolved_count: allAttention.length,
        event_count: allEvents.length,
        by_type: byType,
        by_severity: bySeverity,
        by_project: byProject
      },
      projects: projectStates.map(({ project, state }) => ({
        project_id: project.project_id,
        project: project.name,
        available: project.available,
        unresolved_count: state.attentionFile.attention.filter((item) => !item.resolved_at).length,
        latest_event_sequence: latestSequence(state.eventsFile.events)
      })),
      attention: allAttention,
      events: allEvents.map(({ event }) => event),
      retention: {
        event_ttl_ms: EVENT_TTL_MS,
        attention_ttl_ms: ATTENTION_TTL_MS,
        max_events_per_project: MAX_EVENTS,
        max_attention_items_per_project: MAX_ATTENTION_ITEMS
      },
      projection_observability: {
        version: 1,
        generated_at: nowIso(),
        source: "attention_projection",
        requested_limit: limit,
        bounded_limit: limit,
        max_limit: MAX_LIMIT,
        bounded: eventCandidates.length > limit,
        project_count: projects.length,
        duration_ms: elapsedSince(totalStarted),
        durations_ms: {
          reconcile: reconcileDuration,
          state_read: stateDuration,
          sort_and_cursor: sortDuration
        },
        invocation_counts: invocationCounts,
        reconciliation
      }
    };
  }

  async acknowledgeAttention(attentionId: string, projectSelector?: string | null): Promise<Record<string, unknown>> {
    if (!SAFE_ATTENTION_ID.test(attentionId)) {
      throw new AttentionServiceError(400, "invalid_attention_id", "Attention id is invalid.");
    }
    const selector = normalizeProjectSelector(projectSelector);
    if (!selector) throw new AttentionServiceError(400, "project_required", "Project selector is required for attention mutations.");
    const projects = this.resolveProjects(selector);
    for (const project of projects) {
      const result = await this.updateState(project, (state) => {
        const item = state.attentionFile.attention.find((candidate) => candidate.attention_id === attentionId);
        if (!item) return { found: false as const };
        if (!item.acknowledged_at) {
          const timestamp = nowIso();
          item.acknowledged_at = timestamp;
          item.updated_at = timestamp;
        }
        return { found: true as const, item: structuredClone(item) };
      });
      if (result.found) {
        const auditId = await this.writeAudit(project, {
          attention_id: attentionId,
          task_id: result.item.task_id,
          decision: "allowed",
          reason: "Attention item acknowledged from the local console.",
          result_status: 200
        });
        return { ok: true, audit_id: auditId, project_id: project.project_id, attention: result.item };
      }
    }
    throw new AttentionServiceError(404, "attention_not_found", "Attention item was not found.");
  }

  async auditRejectedAttempt(input: {
    project_id?: string | null;
    attention_id?: string | null;
    reason: string;
    result_status: number;
  }): Promise<string> {
    const project = this.auditProject(input.project_id ?? null);
    return await this.writeAudit(project, {
      attention_id: SAFE_ATTENTION_ID.test(String(input.attention_id ?? "")) ? String(input.attention_id) : null,
      task_id: null,
      decision: "rejected",
      reason: clippedText(input.reason, 500),
      result_status: input.result_status
    });
  }

  async reconcileProjectAttention(
    project: DashboardProjectSummary,
    projectionSnapshotProvider = new ProjectionSnapshotProvider(this.config)
  ): Promise<AttentionReconcileObservability> {
    const started = Date.now();
    const invocationCounts = {
      task_projection: 0,
      projection_snapshot_hit: 0,
      projection_snapshot_miss: 0,
      recovery_lookup: 0,
      goal_load: 0,
      state_read: project.available ? 1 : 0,
      state_write: project.available ? 1 : 0
    };
    if (!project.available) {
      return {
        version: 1,
        project_id: project.project_id,
        project: project.name,
        duration_ms: elapsedSince(started),
        task_count: 0,
        generated_event_count: 0,
        generated_attention_count: 0,
        invocation_counts: invocationCounts,
        task_projection_observability: null
      };
    }
    return await this.updateState(project, async (state) => {
      const workspace = workspaceForDashboardProject(project);
      const guard = new PathGuard(this.config);
      const service = new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
      const goalStore = new GoalStore(this.config, guard, workspace);
      const projectionRead = await projectionSnapshotProvider.get(workspace);
      invocationCounts.task_projection += projectionRead.cache_hit ? 0 : 1;
      invocationCounts.projection_snapshot_hit += projectionRead.cache_hit ? 1 : 0;
      invocationCounts.projection_snapshot_miss += projectionRead.cache_hit ? 0 : 1;
      const tasks = projectionRead.snapshot.tasks;
      const objectives = projectionRead.snapshot.objectives;
      const objectiveByAttempt = new Map<string, ObjectiveProjectionV1>();
      for (const objective of objectives) {
        for (const attempt of objective.attempts) objectiveByAttempt.set(attempt.attempt_id, objective);
      }
      const activeDedupeKeys = new Set<string>();
      const enriched: Array<{
        task: TaskStatusProjection;
        recovery: TaskRecoveryPlan | undefined;
        goal: GoalRecord | undefined;
      }> = [];
      const batchSize = 8;
      for (let index = 0; index < tasks.length; index += batchSize) {
        const batch = await Promise.all(tasks.slice(index, index + batchSize).map(async (task) => {
          const [recovery, goal] = await Promise.all([
            attentionNeedsRecoveryProjection(task)
              ? (invocationCounts.recovery_lookup += 1, service.getRecovery(task.identity.task_id).catch(() => undefined))
              : Promise.resolve(undefined),
            attentionNeedsGoalRecord(task)
              ? (invocationCounts.goal_load += 1, goalStore.loadGoal(task.identity.domain_id).catch(() => undefined))
              : Promise.resolve(undefined)
          ]);
          return { task, recovery, goal };
        }));
        enriched.push(...batch);
      }

      let generatedEventCount = 0;
      let generatedAttentionCount = 0;
      for (const { task, recovery, goal } of enriched) {
        const { events, attention } = this.deriveTaskRecords(project, task, recovery, goal, objectiveByAttempt.get(task.identity.task_id));
        generatedEventCount += events.length;
        generatedAttentionCount += attention.length;
        for (const event of events) this.upsertEvent(state, project, event);
        for (const item of attention) {
          activeDedupeKeys.add(item.dedupe_key);
          this.upsertAttention(state, project, item);
        }
      }

      const timestamp = nowIso();
      for (const item of state.attentionFile.attention) {
        if (item.resolved_at) continue;
        if (activeDedupeKeys.has(item.dedupe_key) && Date.parse(item.expires_at) > Date.now()) continue;
        item.resolved_at = timestamp;
        item.resolved_reason = "condition_cleared";
        item.updated_at = timestamp;
      }
      return {
        version: 1,
        project_id: project.project_id,
        project: project.name,
        duration_ms: elapsedSince(started),
        task_count: tasks.length,
        generated_event_count: generatedEventCount,
        generated_attention_count: generatedAttentionCount,
        invocation_counts: invocationCounts,
        task_projection_observability: projectionRead.snapshot.task_projection_observability
      };
    });
  }

  async recordEventBusNotification(event: CodexProEvent): Promise<void> {
    if (
      event.name === "execution_exited"
      && !event.task_id
      && typeof event.data.task_id !== "string"
      && typeof event.data.run_id !== "string"
    ) return;
    const project = await this.projectForEvent(event);
    if (!project?.available) return;
    if ([
      "task_created",
      "task_assigned",
      "task_started",
      "task_interrupted",
      "task_completed",
      "execution_exited",
      "validation_completed"
    ].includes(event.name)) {
      await this.scheduleProjectReconciliation(project);
      return;
    }
    const mapped = this.mapEventBusEvent(event);
    if (!mapped) return;
    await this.updateState(project, (state) => {
      this.upsertEvent(state, project, {
        dedupe_key: mapped.dedupe_key,
        task_id: event.task_id ?? (typeof event.data.task_id === "string" ? event.data.task_id : null),
        task_title: null,
        type: mapped.type,
        severity: mapped.severity,
        status: typeof event.data.status === "string" ? clippedText(event.data.status, 80) : null,
        domain_status: typeof event.data.status === "string" ? clippedText(event.data.status, 80) : null,
        reason: mapped.reason,
        recommended_action: mapped.recommended_action,
        artifacts: []
      });
    });
  }

  private deriveTaskRecords(
    project: DashboardProjectSummary,
    task: TaskStatusProjection,
    recovery?: TaskRecoveryPlan,
    goal?: GoalRecord,
    objective?: ObjectiveProjectionV1
  ): { events: DesiredEvent[]; attention: DesiredAttention[] } {
    const events: DesiredEvent[] = [];
    const attention: DesiredAttention[] = [];
    const artifacts = taskArtifacts(project, task);
    const title = compactTitle(task.identity.title);
    const statusSig = statusSignature(task, recovery);
    const text = combinedTaskText(task, recovery, goal);
    const objectiveKey = objective?.objective_key ?? taskObjectiveKey(task);
    const currentAttempt = !objective || objective.current_attempt_id === task.identity.task_id;

    const pushEvent = (
      type: ConsoleAttentionEventType,
      severity: ConsoleAttentionSeverity,
      reason: string,
      recommendedAction: string,
      signature = statusSig
    ): void => {
      events.push({
        dedupe_key: eventDedupe(project, task.identity.task_id, type, signature),
        task_id: task.identity.task_id,
        task_title: title,
        type,
        severity,
        status: task.status,
        domain_status: task.domain_status,
        reason: clippedText(reason, 500),
        recommended_action: clippedText(recommendedAction, 300),
        artifacts
      });
    };

    const pushAttention = (
      type: ConsoleAttentionType,
      severity: ConsoleAttentionSeverity,
      reason: string,
      recommendedAction: string,
      signature = statusSig
    ): void => {
      const humanRequired = currentAttempt && attentionRequiresHuman(type, objective);
      if (humanRequired) {
        const action = attentionAction(type, recovery);
        const conditionFingerprint = sha256(`${objectiveKey}:${type}:${signature}`).slice(0, 24);
        const dedupeKey = attentionDedupe(project, objectiveKey, type);
        attention.push({
          dedupe_key: dedupeKey,
          task_id: task.identity.task_id,
          task_title: title,
          objective_key: objectiveKey,
          attempt_id: task.identity.task_id,
          requires_human: true,
          action_code: action.action_code,
          action_available: action.action_available,
          impact_if_ignored: action.impact_if_ignored,
          verification_rule: action.verification_rule,
          condition_fingerprint: conditionFingerprint,
          type,
          severity,
          status: task.status,
          domain_status: task.domain_status,
          reason: clippedText(reason, 500),
          recommended_action: clippedText(recommendedAction, 300),
          artifacts
        });
      }
      pushEvent(eventFromAttention(type), severity, reason, recommendedAction, signature);
    };

    events.push({
      dedupe_key: eventDedupe(project, task.identity.task_id, "task_persisted", task.identity.created_at),
      task_id: task.identity.task_id,
      task_title: title,
      type: "task_persisted",
      severity: "info",
      status: task.status,
      domain_status: task.domain_status,
      reason: "Task identity is visible in the persistent projection.",
      recommended_action: "Monitor the task from the local control console.",
      artifacts
    });

    if (["assigned", "running", "waiting", "recovering", "validating", "interrupted"].includes(task.status)) {
      pushEvent("task_taken_over", "info", "Task state is now represented by an authoritative local store.", "The ChatGPT page can be closed only when the task safe-to-close check also agrees.");
    }

    if (isTaskCompleted(task)) {
      pushEvent(
        "task_completed",
        "info",
        task.domain_status === "completed" && task.status === "implemented_not_verified"
          ? "Task implementation completed and still needs validation evidence."
          : "Task completed.",
        task.status === "implemented_not_verified"
          ? "Review validation evidence before treating the work as accepted."
          : "Review the result and decide whether to commit or continue.",
        terminalSignature(task)
      );
    }

    if (isTaskFailed(task)) {
      pushEvent("task_failed", "critical", attentionReason(task, recovery, "Task failed."), "Inspect recovery and evidence before retrying.", terminalSignature(task));
      pushAttention("task_failed", "critical", attentionReason(task, recovery, "Task failed."), "Open the task recovery view before creating a replacement or retrying.", terminalSignature(task));
    }

    if (task.domain_status === "waiting_approval") {
      pushAttention("approval_required", "warning", "Goal is waiting for explicit approval.", "Review the pending action and use the existing Goal control path to approve, resume, or cancel.");
    }

    if (task.domain_status === "waiting_input") {
      pushAttention("decision_required", "warning", attentionReason(task, recovery, "Goal is waiting for owner input."), "Provide the requested input through the existing task action workflow.");
    }

    const recoveryRequired = task.domain_status === "recovery_required"
      || task.domain_status === "stale"
      || task.liveness.state === "stale"
      || recovery?.mode === "blocked"
      || recovery?.action === "external_reconciliation";
    if (recoveryRequired && !isTaskFailed(task)) {
      pushAttention("recovery_required", recovery?.mode === "blocked" ? "critical" : "warning", attentionReason(task, recovery, "Task recovery requires review."), "Open the recovery plan and reconcile authority state before resuming.");
    } else if (recoveryRequired) {
      pushEvent("recovery_required", "warning", attentionReason(task, recovery, "Task recovery requires review."), "Open the recovery plan before retrying.");
    }

    if (task.status === "implemented_not_verified" || recovery?.action === "validate_only") {
      pushAttention("decision_required", "warning", attentionReason(task, recovery, "Implementation completed without sufficient validation."), "Run or review validation evidence before accepting the task.");
    }

    if (explicitResourceBlocked(text, task)) {
      pushAttention("resource_blocked", "critical", attentionReason(task, recovery, "Task is queued or blocked by the resource policy."), "Wait for the current resource lease to clear, or review the configured quota and threshold without bypassing safety locks.");
    }

    if (explicitBrowserAuthorization(text) && !this.browserAuthorizationAvailable()) {
      pushAttention("browser_authorization", "warning", attentionReason(task, recovery, "Browser authorization is required."), "Authorize the Chrome tab from the browser extension, then refresh the local console.");
    }

    if (explicitExternalWait(text)) {
      pushEvent("external_service_wait", "info", attentionReason(task, recovery, "Task is waiting on an external service."), "Continue monitoring unless the task asks for an explicit human decision.");
    }

    const hookError = goal?.hook_delivery?.last_error;
    if (hookError && goal && !goal.final_notification_sent && goal.status !== "cancelled") {
      pushAttention(
        "decision_required",
        "warning",
        `Hook Bridge delivery failed: ${clippedText(hookError, 360)}`,
        "Inspect Hook Bridge delivery and replay terminal hooks only if the existing Goal controls allow it.",
        sha256(`hook:${goal.goal_id}:${goal.hook_delivery?.last_event_key ?? ""}:${hookError}`).slice(0, 24)
      );
    }

    return { events, attention };
  }

  private browserAuthorizationAvailable(): boolean {
    const store = this.options.browserAuthorization ?? browserAuthorizationStore;
    return Boolean(store.latest());
  }

  private upsertEvent(state: ProjectAttentionState, project: DashboardProjectSummary, desired: DesiredEvent): void {
    if (state.eventsFile.events.some((event) => event.dedupe_key === desired.dedupe_key)) return;
    const sequence = Math.max(1, state.eventsFile.next_sequence);
    const createdAt = nowIso();
    state.eventsFile.events.push({
      version: 1,
      event_id: eventIdFor(desired.dedupe_key),
      sequence,
      dedupe_key: desired.dedupe_key,
      project_id: project.project_id,
      project: project.name,
      task_id: desired.task_id,
      task_title: desired.task_title,
      type: desired.type,
      severity: desired.severity,
      status: desired.status,
      domain_status: desired.domain_status,
      reason: clippedText(desired.reason, 500),
      recommended_action: clippedText(desired.recommended_action, 300),
      created_at: createdAt,
      expires_at: expiresAt(EVENT_TTL_MS),
      artifacts: desired.artifacts.slice(0, 5)
    });
    state.eventsFile.next_sequence = sequence + 1;
    state.eventsFile.updated_at = createdAt;
  }

  private upsertAttention(state: ProjectAttentionState, project: DashboardProjectSummary, desired: DesiredAttention): void {
    const attentionId = attentionIdFor(desired.dedupe_key);
    const existing = state.attentionFile.attention.find((item) => item.attention_id === attentionId || item.dedupe_key === desired.dedupe_key);
    const timestamp = nowIso();
    if (existing) {
      const conditionChanged = Boolean(existing.condition_fingerprint && existing.condition_fingerprint !== desired.condition_fingerprint);
      const reopening = Boolean(existing.resolved_at) || conditionChanged;
      existing.project_id = project.project_id;
      existing.project = project.name;
      existing.task_id = desired.task_id;
      existing.task_title = desired.task_title;
      existing.objective_key = desired.objective_key;
      existing.attempt_id = desired.attempt_id;
      existing.requires_human = desired.requires_human;
      existing.action_code = desired.action_code;
      existing.action_available = desired.action_available;
      existing.impact_if_ignored = desired.impact_if_ignored;
      existing.verification_rule = desired.verification_rule;
      existing.condition_fingerprint = desired.condition_fingerprint;
      existing.generation = Math.max(1, existing.generation ?? 1) + (reopening ? 1 : 0);
      existing.severity = desired.severity;
      existing.status = desired.status;
      existing.domain_status = desired.domain_status;
      existing.reason = clippedText(desired.reason, 500);
      existing.recommended_action = clippedText(desired.recommended_action, 300);
      existing.updated_at = timestamp;
      existing.expires_at = expiresAt(ATTENTION_TTL_MS);
      existing.resolved_at = null;
      existing.resolved_reason = null;
      if (reopening) existing.acknowledged_at = null;
      existing.artifacts = desired.artifacts.slice(0, 5);
      return;
    }
    state.attentionFile.attention.push({
      version: 1,
      attention_id: attentionId,
      dedupe_key: desired.dedupe_key,
      project_id: project.project_id,
      project: project.name,
      task_id: desired.task_id,
      task_title: desired.task_title,
      objective_key: desired.objective_key,
      attempt_id: desired.attempt_id,
      requires_human: desired.requires_human,
      action_code: desired.action_code,
      action_available: desired.action_available,
      impact_if_ignored: desired.impact_if_ignored,
      verification_rule: desired.verification_rule,
      condition_fingerprint: desired.condition_fingerprint,
      generation: 1,
      type: desired.type,
      severity: desired.severity,
      status: desired.status,
      domain_status: desired.domain_status,
      reason: clippedText(desired.reason, 500),
      recommended_action: clippedText(desired.recommended_action, 300),
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: expiresAt(ATTENTION_TTL_MS),
      resolved_at: null,
      resolved_reason: null,
      acknowledged_at: null,
      artifacts: desired.artifacts.slice(0, 5)
    });
    state.attentionFile.updated_at = timestamp;
  }

  private mapEventBusEvent(event: CodexProEvent): {
    type: ConsoleAttentionEventType;
    severity: ConsoleAttentionSeverity;
    reason: string;
    recommended_action: string;
    dedupe_key: string;
  } | null {
    const status = typeof event.data.status === "string" ? event.data.status : "";
    const outcome = typeof event.data.outcome === "string" ? event.data.outcome : "";
    const taskId = event.task_id ?? (typeof event.data.task_id === "string" ? event.data.task_id : "project");
    const signature = sha256(`${event.name}:${taskId}:${status}:${outcome}:${event.correlation_id ?? ""}`).slice(0, 24);
    if (event.name === "task_created") {
      return {
        type: "task_persisted",
        severity: "info",
        reason: "Task lifecycle event was observed in this process.",
        recommended_action: "Use the local console for authoritative status.",
        dedupe_key: `bus:${taskId}:task_persisted:${signature}`
      };
    }
    if (event.name === "task_assigned") {
      return {
        type: "task_taken_over",
        severity: "info",
        reason: "Task assignment event was observed in this process.",
        recommended_action: "Continue monitoring from the persistent task projection.",
        dedupe_key: `bus:${taskId}:task_taken_over:${signature}`
      };
    }
    if (event.name === "task_completed") {
      if (status === "cancelled" || outcome === "cancelled") return null;
      const failed = ["failed", "blocked", "timed_out", "recovery_required"].includes(status) || ["failed", "blocked"].includes(outcome);
      return {
        type: failed ? "task_failed" : "task_completed",
        severity: failed ? "critical" : "info",
        reason: failed ? "Task failure event was observed in this process." : "Task completion event was observed in this process.",
        recommended_action: failed ? "Inspect persisted recovery state before retrying." : "Review result evidence before committing or continuing.",
        dedupe_key: `bus:${taskId}:${failed ? "task_failed" : "task_completed"}:${signature}`
      };
    }
    if (event.name === "git_after_commit") {
      return {
        type: "local_version_recorded",
        severity: "info",
        reason: "Local version record event was observed after a CodexPro-managed commit.",
        recommended_action: "Review local repository state if needed.",
        dedupe_key: `bus:${taskId}:local_version_recorded:${signature}`
      };
    }
    if (event.name === "git_after_push") {
      const failed = event.data.outcome === "error" || event.data.ok === false || Number(event.data.exit_code ?? 0) !== 0;
      return {
        type: failed ? "remote_sync_failed" : "remote_sync_succeeded",
        severity: failed ? "warning" : "info",
        reason: failed ? "Remote sync failed after a CodexPro-managed push." : "Remote sync succeeded after a CodexPro-managed push.",
        recommended_action: failed ? "Inspect the Git push output from the authoritative task evidence." : "No action is required unless review is pending.",
        dedupe_key: `bus:${taskId}:${failed ? "remote_sync_failed" : "remote_sync_succeeded"}:${signature}`
      };
    }
    return null;
  }

  private async projectForEvent(event: CodexProEvent): Promise<DashboardProjectSummary | undefined> {
    const projects = discoverDashboardProjects(this.config).filter((project) => project.available);
    const root = typeof event.data.project_root === "string"
      ? event.data.project_root
      : typeof event.data.workspace_root === "string"
        ? event.data.workspace_root
        : undefined;
    if (root) {
      const resolved = path.resolve(root);
      const byRoot = projects.find((project) => path.resolve(project.root) === resolved);
      if (byRoot) return byRoot;
    }
    if (event.task_id) {
      for (const project of projects) {
        const workspace = workspaceForDashboardProject(project);
        const guard = new PathGuard(this.config);
        const service = new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
        const projection = await service.getStatus(event.task_id).catch(() => undefined);
        if (projection && path.resolve(projection.identity.project_root) === path.resolve(project.root)) return project;
      }
    }
    return projects.find((project) => path.resolve(project.root) === path.resolve(this.config.defaultRoot)) ?? projects[0];
  }

  private auditProject(projectSelector: string | null): DashboardProjectSummary {
    const discovered = discoverDashboardProjects(this.config).filter((project) => project.available);
    if (projectSelector) {
      const matched = discovered.find((project) => matchesProjectFilter(project, projectSelector));
      if (matched) return matched;
    }
    return discovered.find((project) => path.resolve(project.root) === path.resolve(this.config.defaultRoot))
      ?? discovered[0]
      ?? (() => { throw new AttentionServiceError(404, "project_not_found", "No available project can store the attention audit."); })();
  }

  private resolveProjects(projectSelector: string | null): DashboardProjectSummary[] {
    const discovered = discoverDashboardProjects(this.config);
    if (!projectSelector) return discovered.filter((project) => project.available);
    const matches = discovered.filter((project) => matchesProjectFilter(project, projectSelector));
    if (!matches.length) throw new AttentionServiceError(404, "project_not_found", "Project is not available.");
    const available = matches.filter((project) => project.available);
    if (!available.length) throw new AttentionServiceError(404, "project_not_found", matches[0].unavailable_reason ?? "Project is not available.");
    return available;
  }

  private statePath(workspace: Workspace, relPath: string, forWrite = false): string {
    return new PathGuard(this.config).resolve(workspace, `${ATTENTION_ROOT}/${relPath}`, { forWrite }).absPath;
  }

  private async readJson<T>(workspace: Workspace, relPath: string): Promise<T | undefined> {
    const absPath = this.statePath(workspace, relPath);
    try {
      return JSON.parse(await fsp.readFile(absPath, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readState(project: DashboardProjectSummary): Promise<ProjectAttentionState> {
    const workspace = workspaceForDashboardProject(project);
    const eventsFile = await this.readJson<EventsFile>(workspace, EVENTS_FILE) ?? emptyEventsFile();
    const attentionFile = await this.readJson<AttentionFile>(workspace, ATTENTION_FILE) ?? emptyAttentionFile();
    if (eventsFile.version !== 1 || eventsFile.schema_version !== SCHEMA_VERSION || !Array.isArray(eventsFile.events)) {
      return { eventsFile: emptyEventsFile(), attentionFile };
    }
    if (attentionFile.version !== 1 || attentionFile.schema_version !== SCHEMA_VERSION || !Array.isArray(attentionFile.attention)) {
      return { eventsFile, attentionFile: emptyAttentionFile() };
    }
    eventsFile.next_sequence = Math.max(eventsFile.next_sequence || 1, latestSequence(eventsFile.events) + 1);
    eventsFile.events = eventsFile.events
      .filter((event) => event.version === 1 && typeof event.event_id === "string" && Number.isInteger(event.sequence))
      .sort((left, right) => left.sequence - right.sequence);
    attentionFile.attention = attentionFile.attention
      .filter((item) => item.version === 1 && SAFE_ATTENTION_ID.test(item.attention_id))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    return { eventsFile, attentionFile };
  }

  private async writeState(project: DashboardProjectSummary, state: ProjectAttentionState): Promise<void> {
    const workspace = workspaceForDashboardProject(project);
    this.pruneState(state);
    await this.atomicWriteJson(workspace, EVENTS_FILE, state.eventsFile);
    await this.atomicWriteJson(workspace, ATTENTION_FILE, state.attentionFile);
  }

  private async updateState<T>(
    project: DashboardProjectSummary,
    mutate: (state: ProjectAttentionState) => T | Promise<T>
  ): Promise<T> {
    const key = path.resolve(project.root);
    const previous = this.projectQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const state = await this.readState(project);
      const result = await mutate(state);
      await this.writeState(project, state);
      return result;
    });
    this.projectQueues.set(key, run.then(() => undefined, () => undefined));
    return await run;
  }

  private async scheduleProjectReconciliation(project: DashboardProjectSummary): Promise<void> {
    const key = path.resolve(project.root);
    const existing = this.eventReconciliations.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flushProjectReconciliation(key, project, existing), EVENT_RECONCILE_DEBOUNCE_MS);
      existing.timer.unref();
      return await existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const entry = {
      timer: undefined as unknown as NodeJS.Timeout,
      promise,
      resolve,
      reject
    };
    entry.timer = setTimeout(() => void this.flushProjectReconciliation(key, project, entry), EVENT_RECONCILE_DEBOUNCE_MS);
    entry.timer.unref();
    this.eventReconciliations.set(key, entry);
    return await promise;
  }

  private async flushProjectReconciliation(
    key: string,
    project: DashboardProjectSummary,
    entry: { resolve: () => void; reject: (error: unknown) => void }
  ): Promise<void> {
    if (this.eventReconciliations.get(key) !== entry) return;
    this.eventReconciliations.delete(key);
    try {
      await this.reconcileProjectAttention(project);
      entry.resolve();
    } catch (error) {
      entry.reject(error);
    }
  }

  private async writeAudit(
    project: DashboardProjectSummary,
    input: Pick<AttentionAuditRecord, "attention_id" | "task_id" | "decision" | "reason" | "result_status">
  ): Promise<string> {
    const workspace = workspaceForDashboardProject(project);
    const auditId = randomUUID();
    const record: AttentionAuditRecord = {
      version: 1,
      audit_id: auditId,
      created_at: nowIso(),
      project_id: project.project_id,
      project: project.name,
      attention_id: input.attention_id,
      task_id: input.task_id,
      action: "acknowledge",
      decision: input.decision,
      reason: clippedText(input.reason, 500),
      result_status: Math.max(100, Math.min(599, Math.floor(input.result_status)))
    };
    const fileName = `${Date.now()}-${auditId}.json`;
    await this.atomicWriteJson(workspace, `audit/${fileName}`, record);
    await this.pruneAudit(workspace);
    return auditId;
  }

  private async pruneAudit(workspace: Workspace): Promise<void> {
    const dir = path.dirname(this.statePath(workspace, "audit/placeholder.json", true));
    let entries: Array<{ name: string; size: number; mtimeMs: number }> = [];
    try {
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
        const stat = await fsp.stat(path.join(dir, dirent.name));
        entries.push({ name: dirent.name, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    let bytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      bytes += entry.size;
      if (index < MAX_AUDIT_RECORDS && bytes <= MAX_AUDIT_BYTES) continue;
      await fsp.rm(path.join(dir, entry.name), { force: true });
    }
  }

  private async atomicWriteJson(workspace: Workspace, relPath: string, value: unknown): Promise<void> {
    const absPath = this.statePath(workspace, relPath, true);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    const temporary = `${absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, absPath);
  }

  private pruneState(state: ProjectAttentionState): void {
    const timestamp = nowIso();
    const now = Date.now();
    state.eventsFile.events = state.eventsFile.events.filter((event) => Date.parse(event.expires_at) > now);
    state.eventsFile.events.sort((left, right) => right.sequence - left.sequence);
    state.eventsFile.events = this.limitJsonRecords(state.eventsFile.events, MAX_EVENTS, MAX_EVENT_BYTES);
    state.eventsFile.events.sort((left, right) => left.sequence - right.sequence);
    state.eventsFile.updated_at = timestamp;

    state.attentionFile.attention = state.attentionFile.attention.filter((item) => {
      if (!item.resolved_at) return true;
      const resolvedMs = Date.parse(item.resolved_at);
      return Number.isFinite(resolvedMs) && now - resolvedMs <= ATTENTION_TTL_MS;
    });
    state.attentionFile.attention.sort((left, right) => {
      if (!left.resolved_at && right.resolved_at) return -1;
      if (left.resolved_at && !right.resolved_at) return 1;
      return right.updated_at.localeCompare(left.updated_at);
    });
    state.attentionFile.attention = this.limitJsonRecords(state.attentionFile.attention, MAX_ATTENTION_ITEMS, MAX_ATTENTION_BYTES);
    state.attentionFile.attention.sort((left, right) => left.created_at.localeCompare(right.created_at));
    state.attentionFile.updated_at = timestamp;
  }

  private limitJsonRecords<T>(records: T[], maxCount: number, maxBytes: number): T[] {
    const out: T[] = [];
    let bytes = 0;
    for (const record of records) {
      const size = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (out.length >= maxCount || bytes + size > maxBytes) break;
      out.push(record);
      bytes += size;
    }
    return out;
  }
}

export function installAttentionEventBusListener(
  config: CodexProConfig,
  service = new AttentionService(config)
): () => void {
  return codexProEventBus.on("*", (event) => {
    void service.recordEventBusNotification(event).catch(() => undefined);
  }, {
    role: "observer",
    listener_id: "attention_service"
  });
}
