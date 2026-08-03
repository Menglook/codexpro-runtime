import { createHash } from "node:crypto";
import path from "node:path";
import { redactSensitiveText } from "../redact.js";
import type { ExecutionComponentRecord } from "../execution/componentStore.js";
import type { RuntimeActivityState, RuntimeNoProgressLevel, RuntimeUserActionRequiredV1 } from "../runtime/activityEvents.js";
import type { TaskReportEventKind, TaskReportSeverity, TaskReportSourceKind } from "../tasks/taskReportTypes.js";
import type {
  DashboardObjectiveProjection,
  DashboardProjectSummary,
  DashboardResponse,
  DashboardTaskAvailableAction,
  DashboardTaskProjection
} from "./projectAggregationService.js";
import { officeZoneLayouts, type OfficeZoneLayoutV1 } from "./officeDensitySemantics.js";
import { createOfficePlainSummary } from "./officePlainLanguage.js";
import type { OfficePlainSummaryV1 } from "./officePlainLanguageTypes.js";
import {
  officeGraphEdgeClass,
  resolveOfficeGraphRelation,
  type OfficeGraphEdgeClass,
  type OfficeGraphEdgeKind,
  type OfficeRelationEvidenceV1,
  type OfficeRetryPolicy,
  type OfficeRouteSource
} from "./officeGraphSemantics.js";

export const OFFICE_ZONES = [
  "waiting_user",
  "incident",
  "recovering",
  "validation",
  "browser",
  "development",
  "delivery",
  "dispatch",
  "archive"
] as const;

export type OfficeZone = typeof OFFICE_ZONES[number];
export type OfficeGraphAuthority = "explicit" | "partial" | "unavailable";
export type OfficeActivityState = "active" | "waiting" | "idle" | "stale" | "terminal" | "unknown";

export interface OfficeProjectionOptions {
  project?: string | null;
  include_archived?: boolean;
  include_test_history?: boolean;
  archive_limit?: number;
  active_limit_per_project?: number;
}

export interface OfficeAttemptSummaryV1 {
  task_id: string;
  run_id: string | null;
  workspace_id: string;
  workspace_root: string;
  workspace_generation: number | null;
  identity_quality: "authoritative" | "degraded";
  legacy_binding: boolean;
  actor_id: string | null;
  actor_role: "executor" | "reviewer" | "observer" | "system";
  title: string;
  status: string;
  liveness: string;
  phase: string;
  action: string;
  activity_state: RuntimeActivityState;
  activity_label: string;
  safe_progress_summary: string;
  last_meaningful_progress_at: string | null;
  no_progress_level: RuntimeNoProgressLevel;
  no_progress_duration_ms: number | null;
  user_action_required: RuntimeUserActionRequiredV1 | null;
  progress: {
    current: number;
    total: number | null;
    interpretation: "recorded_events" | "plan_nodes";
    label: string;
  };
  executor: {
    kind: string;
    provider: string | null;
    model: string | null;
    execution_id: string | null;
    source: string;
  } | null;
  resource: {
    status: string;
    execution_mode: string;
    queue_position: number | null;
    blocking_reasons: string[];
  } | null;
  writer_active: boolean;
  browser_active: boolean;
  validation_active: boolean;
  acceptance_status: string;
  implementation_status: string;
  validation_status: string;
  delivery_status: string;
  evidence_status: string;
  completion_state: DashboardTaskProjection["completion_state"];
  incident_state: "blocked" | "stalled" | "orphaned" | "failed" | "waiting_approval" | null;
  report_summary: {
    latest_sequence: number;
    event_count: number;
    current_stage_key: string | null;
    current_stage_title: string | null;
    current_summary: string | null;
    current_source_kind: string | null;
    latest_important_event: {
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
    latest_event_at: string | null;
  } | null;
  git: {
    branch: string | null;
    changed_files: string[];
    commit_status: string;
    push_status: string;
    delivery_status: string;
    local_commit_sha: string | null;
    remote_commit_sha: string | null;
    commit_message: string | null;
    push_transport: string | null;
    push_attempts: number;
    push_error_code: string | null;
    reason_code: string;
    reason: string;
    retry_available: boolean;
  } | null;
  last_heartbeat: string | null;
  updated_at: string;
  latest_error: string | null;
  observability: {
    last_liveness_at: string | null;
    last_progress_at: string | null;
    no_progress_duration_ms: number | null;
    recovery_count: number | null;
    recovery_from_run_id: string | null;
    resume_count: number | null;
    owner_alive: boolean | null;
    watcher_alive: boolean | null;
  };
  safe_to_close_chat: {
    safe: boolean;
    reason: string;
    stable_task_identity: boolean;
    authority_recognized: boolean;
    authority: "goal_store" | "durable_job_store" | "handoff_status" | null;
  };
  available_actions: DashboardTaskAvailableAction[];
}

export interface OfficeExecutorV1 {
  executor_key: string;
  executor_id: string;
  label: string;
  kind: string;
  worker_type: string | null;
  provider: string | null;
  model: string | null;
  component_ids: string[];
  read_write_mode: "read_only" | "writer" | "unknown";
  active: boolean;
  state: OfficeActivityState;
  activity_state: RuntimeActivityState;
  current_action: string | null;
  recent_activity_action: string | null;
  recent_activity_completed_at: string | null;
  recent_activity_until: string | null;
  last_progress_at: string | null;
  evidence_ref: string | null;
  writer: boolean;
  browser: boolean;
  validation: boolean;
}

export interface OfficeComponentV1 {
  component_id: string;
  component_kind: "model_stream" | "tool_process" | "worker";
  status: OfficeActivityState;
  raw_state: string;
  run_id: string | null;
  parent_run_id: string | null;
  owner_id: string | null;
  executor_ids: string[];
  read_write_mode: "read_only" | "writer" | "unknown";
  progress_marker: string | null;
  last_progress_at: string | null;
  evidence_ref: string | null;
}

export interface OfficeDeviceV1 {
  device_id: string;
  device_kind: "model_stream" | "tool_process" | "worker" | "browser" | "acceptance" | "writer_lease";
  label: string;
  state: OfficeActivityState;
  executor_ids: string[];
  component_ids: string[];
  evidence_source: string;
  evidence_ref: string | null;
  details: string;
}

export interface OfficeGraphNodeV1 {
  node_id: string;
  node_type: "objective" | "attempt" | "model_stream" | "tool_process" | "worker";
  label: string;
  state: OfficeActivityState;
  run_id: string | null;
  parent_hint: string | null;
  parent_node_ids: string[];
  blocked_by_node_ids: string[];
  executor_ids: string[];
  component_ids: string[];
  read_write_mode: "read_only" | "writer" | "unknown";
  evidence_ref: string | null;
  evidence_refs: string[];
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  route_source: OfficeRouteSource;
  transition_reason: string | null;
  retry_policy: OfficeRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
}

export interface OfficeGraphEdgeV1 {
  edge_id: string;
  from: string;
  to: string;
  from_node_id: string;
  to_node_id: string;
  relation: "current_attempt" | "observed_component" | "owner" | "recovery" | "execution_relation";
  edge_class: OfficeGraphEdgeClass;
  edge_kind: OfficeGraphEdgeKind;
  condition: string | null;
  selected: boolean | null;
  relation_group: string | null;
  dependency_satisfied: boolean | null;
  route_source: OfficeRouteSource;
  transition_reason: string | null;
  retry_policy: OfficeRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
  authority: string;
  evidence_ref: string | null;
  evidence_refs: string[];
  degraded_reason: string | null;
}

export interface OfficeExecutionGraphV1 {
  authority: OfficeGraphAuthority;
  reason: string;
  degraded_reasons: string[];
  nodes: OfficeGraphNodeV1[];
  edges: OfficeGraphEdgeV1[];
  truncated: boolean;
}

export interface OfficeWriterLeaseV1 {
  state: "active" | "queued" | "idle" | "unknown";
  holder_task_id: string | null;
  holder_run_id: string | null;
  lease_id: string | null;
  fence: number | null;
  acquired_at: string | null;
  expires_at: string | null;
  age_ms: number | null;
  waiting_count: number;
  stale: boolean;
  owner_alive: boolean | null;
  queue_position: number | null;
  blocking_reasons: string[];
  evidence: string;
}

export interface OfficeObjectiveV1 {
  objective_key: string;
  stable_key: string;
  project_id: string;
  project_name: string;
  title: string;
  stage_key: string | null;
  source: string;
  objective_status: string;
  reason_code: string;
  zone: OfficeZone;
  zone_reason: string;
  requires_human: boolean;
  user_action_required: RuntimeUserActionRequiredV1 | null;
  system_next_action: string | null;
  activity_state: RuntimeActivityState;
  activity_label: string;
  last_meaningful_progress_at: string | null;
  no_progress_level: RuntimeNoProgressLevel;
  no_progress_duration_ms: number | null;
  attention: boolean;
  attempt_count: number;
  current_attempt_id: string | null;
  current_attempt: OfficeAttemptSummaryV1 | null;
  historical_attempts: Array<{
    attempt_id: string;
    status: string;
    liveness: string;
    supersession: string;
    superseded_by_attempt_id: string | null;
    updated_at: string;
  }>;
  executors: OfficeExecutorV1[];
  components: OfficeComponentV1[];
  devices: OfficeDeviceV1[];
  resource_alerts: string[];
  writer_lease: OfficeWriterLeaseV1;
  execution_graph: OfficeExecutionGraphV1;
  summary: string;
  last_progress_at: string | null;
  created_at: string;
  updated_at: string;
  plain_summary: OfficePlainSummaryV1;
}

export interface OfficeProjectFloorV1 {
  project_id: string;
  name: string;
  root: string;
  canonical_root: string;
  workspace_id: string | null;
  workspace_generation: number | null;
  head_sha: string | null;
  current_task_id: string | null;
  current_stage: string | null;
  current_owner: string | null;
  last_activity_at: string | null;
  last_progress_at: string | null;
  workspace_conflict: boolean;
  available: boolean;
  unavailable_reason: string | null;
  branch: string;
  git_summary: string;
  watcher_state: string;
  floor_status: "active" | "waiting" | "incident" | "idle";
  resource_summary: {
    writers: number;
    readers: number;
    browsers: number;
    validations: number;
    queue_length: number;
    stale_writer_leases: number;
  };
  writer_lease: OfficeWriterLeaseV1;
  counts: Record<OfficeZone, number>;
  zones: Record<OfficeZone, OfficeObjectiveV1[]>;
  zone_layouts: Record<OfficeZone, OfficeZoneLayoutV1>;
  objective_count: number;
  archived_count: number;
  hidden_test_history_count: number;
  truncated_active_count: number;
  projection_consistency_errors: string[];
  projection_diagnostics: {
    orphan_runs: string[];
    orphan_resources: string[];
    observer_contamination_count: number;
    terminal_state_conflict_count: number;
    workspace_generation_conflict_count: number;
  };
}

export interface OfficeSnapshotObservabilityV1 {
  version: 1;
  mode: "stale_while_revalidate";
  fresh_for_ms: number;
  snapshot_ready: boolean;
  snapshot_generated_at: string | null;
  snapshot_completed_at: string | null;
  age_ms: number | null;
  refresh_in_flight: boolean;
  refresh_count: number;
  refresh_error_count: number;
  last_refresh_duration_ms: number | null;
  last_refresh_error: string | null;
}

export interface OfficeActivityFeedItemV1 {
  version: 1;
  feed_key: string;
  project_id: string;
  objective_key: string;
  task_id: string;
  sequence: number;
  event_kind: TaskReportEventKind;
  severity: TaskReportSeverity;
  tab: "progress" | "findings" | "acceptance" | "delivery";
  text: string;
  occurred_at: string;
  source_kind: TaskReportSourceKind;
}

export interface OfficeProjectionV1 {
  version: 1;
  generated_at: string;
  revision: string;
  projection_id: string;
  source: "project_aggregation_read_only";
  filters: {
    project: string | null;
    include_archived: boolean;
    include_test_history: boolean;
    archive_limit: number;
    active_limit_per_project: number;
  };
  attention_summary: {
    waiting_user: number;
    incidents: number;
    recovering: number;
    queued: number;
    validating: number;
    delivery: number;
    active_writers: number;
    active_browser_runs: number;
    total_objectives: number;
  };
  objective_summary: {
    current: number;
    executing: number;
    waiting_user: number;
    recovering: number;
    unresolved_incidents: number;
    completed_today: number;
    pending_delivery: number;
  };
  synchronization: {
    office_projection_lag_ms: number;
    last_authoritative_event_at: string | null;
    snapshot_generated_at: string;
    event_sequence: number | null;
    event_gap_count: number;
    orphan_run_count: number;
    orphan_resource_count: number;
    observer_contamination_count: number;
    terminal_state_conflict_count: number;
    workspace_generation_conflict_count: number;
  };
  activity_feed: OfficeActivityFeedItemV1[];
  projects: OfficeProjectFloorV1[];
  consistency: {
    ok: boolean;
    checked_at: string;
    violations: string[];
  };
  snapshot_observability?: OfficeSnapshotObservabilityV1;
  graph_policy: {
    node_limit_per_objective: 50;
    edge_limit_per_objective: 100;
    missing_parent_policy: "omit_unproven_edges";
  };
}

const DEFAULT_ARCHIVE_LIMIT = 10;
const DEFAULT_ACTIVE_LIMIT = 12;
const GRAPH_NODE_LIMIT = 50;
const GRAPH_EDGE_LIMIT = 100;
const HISTORICAL_TEST_OBJECTIVE_PATTERN = /(?:\bdurable\b.{0,80}\bvalidation\b|\bsmoke(?:\s+test)?\b|\bself[-\s]?test\b|\bbenchmark\b|\bdiagnostic\b|\bprobe\b|\bmock\b|\bfixture\b|\bcanary\b|\bmav-\d+\b|回归测试|命令验收|测试验收)/i;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, Math.floor(numeric))) : fallback;
}

function cleanText(value: unknown, max = 360): string {
  const normalized = String(value ?? "").replace(/[\u0000\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return redactSensitiveText(normalized).slice(0, max);
}

function cleanNullable(value: unknown, max = 360): string | null {
  return cleanText(value, max) || null;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["age_ms", "office_projection_lag_ms", "snapshot_generated_at", "checked_at"].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableObject(item)]));
}

function revisionFor(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableObject(value))).digest("hex").slice(0, 24);
}

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDegradedLegacyObjective(objective: DashboardObjectiveProjection): boolean {
  const attempt = objective.current_attempt;
  return objective.source === "legacy_single_attempt"
    && Boolean(attempt && (attempt.identity_quality === "degraded" || attempt.legacy_binding));
}

function isHistoricalTestObjective(
  objective: DashboardObjectiveProjection,
  projectCurrentObjectiveKey: string | null
): boolean {
  const attempt = objective.current_attempt;
  const currentObjective = Boolean(projectCurrentObjectiveKey && objective.objective_key === projectCurrentObjectiveKey);
  const recovering = Boolean(attempt?.execution_observability?.recovering || attempt?.status === "recovering" || objective.status === "recovering");
  const evidence = [
    objective.title,
    objective.objective_key,
    attempt?.title,
    attempt?.kind,
    attempt?.run_id,
    attempt?.acceptance_profile
  ].filter(Boolean).join(" ");
  const explicitTestOrMock = HISTORICAL_TEST_OBJECTIVE_PATTERN.test(evidence);
  const terminal = ["delivered", "cancelled", "incomplete"].includes(objective.status)
    || Boolean(attempt && ["completed", "failed", "blocked", "cancelled"].includes(attempt.status))
    || Boolean(attempt && ["stopped", "terminal"].includes(attempt.liveness))
    || attempt?.execution_observability?.owner_alive === false;
  if (recovering || !explicitTestOrMock) return false;
  if (currentObjective) return false;
  if (objective.source === "legacy_single_attempt") return true;
  return terminal;
}

function attemptHasLiveExecutionEvidence(attempt: DashboardTaskProjection | OfficeAttemptSummaryV1): boolean {
  if (["stale", "stopped", "terminal"].includes(attempt.liveness)) return false;
  const projected = "writer_active" in attempt;
  const ownerAlive = projected ? attempt.observability.owner_alive : attempt.execution_observability?.owner_alive;
  const writerActive = projected ? attempt.writer_active : attempt.writer_activity.active;
  const browserActive = projected ? attempt.browser_active : attempt.browser_activity.active;
  const validationActive = projected ? attempt.validation_active : attempt.validation_activity.active;
  const resourceStatus = projected ? attempt.resource?.status : attempt.resource_policy?.status;
  const queuedResource = projected
    ? resourceStatus === "queued_by_resource_policy" && attempt.resource?.queue_position !== null
    : Boolean(attempt.resource_policy?.queue_id && resourceStatus === "queued_by_resource_policy");
  return ownerAlive === true
    || writerActive
    || browserActive
    || validationActive
    || ["admitted", "running"].includes(resourceStatus ?? "")
    || queuedResource;
}

function attemptMatchesProjectAuthority(attempt: DashboardTaskProjection | OfficeAttemptSummaryV1, project: DashboardProjectSummary): boolean {
  if (!project.workspace_id || attempt.workspace_id !== project.workspace_id) return false;
  if (path.resolve(attempt.workspace_root) !== path.resolve(project.root)) return false;
  return project.workspace_generation === null
    ? attempt.workspace_generation !== null
    : attempt.workspace_generation === project.workspace_generation;
}

function isHistoricalWorkspaceObjective(objective: DashboardObjectiveProjection, project: DashboardProjectSummary): boolean {
  const attempt = objective.current_attempt;
  if (!attempt || attempt.identity_quality === "degraded" || attempt.legacy_binding) return false;
  return !attemptMatchesProjectAuthority(attempt, project) && !attemptHasLiveExecutionEvidence(attempt);
}

function activityState(value: string | null | undefined): OfficeActivityState {
  const state = String(value ?? "").toLowerCase();
  if (["running", "working", "registered"].includes(state)) return "active";
  if (["queued", "waiting", "expected_silence", "silent"].includes(state)) return "waiting";
  if (state === "idle") return "idle";
  if (["stale", "terminating", "interrupted"].includes(state)) return "stale";
  if (["terminal", "stopped", "completed", "failed", "cancelled"].includes(state)) return "terminal";
  return "unknown";
}

function deliveryNeedsAttention(attempt: DashboardTaskProjection | null): boolean {
  const status = attempt?.git_finalization?.delivery_status ?? attempt?.outcome.delivery_status ?? "not_requested";
  return ["not_ready", "ready", "committed", "failed", "delivery_unknown"].includes(status);
}

function hasConsistentCurrentAttempt(objective: DashboardObjectiveProjection): boolean {
  if (!objective.current_attempt_id && !objective.current_attempt) return true;
  if (!objective.current_attempt_id || objective.current_attempt?.task_id !== objective.current_attempt_id) return false;
  return objective.attempts.some((attempt) => attempt.attempt_id === objective.current_attempt_id && attempt.supersession === "current");
}

function isArchivedLegacyHandoff(objective: DashboardObjectiveProjection): boolean {
  const attempt = objective.current_attempt;
  if (objective.source !== "legacy_single_attempt" || attempt?.kind !== "handoff") return false;
  if (objective.requires_human || objective.user_action_required?.required === true) return false;
  const inactiveStatus = ["completed", "failed", "cancelled", "interrupted", "implemented_not_verified"].includes(attempt.status);
  const inactiveExecution = ["stopped", "stale", "terminal", "unknown"].includes(attempt.liveness)
    && attempt.execution_observability?.owner_alive !== true
    && !attempt.writer_activity.active
    && !attempt.browser_activity.active;
  return inactiveStatus && inactiveExecution;
}

function isArchivedNonCurrentLegacyTerminal(
  objective: DashboardObjectiveProjection,
  projectCurrentObjectiveKey: string | null
): boolean {
  const attempt = objective.current_attempt;
  if (projectCurrentObjectiveKey && objective.objective_key === projectCurrentObjectiveKey) return false;
  if (objective.source !== "legacy_single_attempt" || !attempt) return false;
  if (objective.requires_human || objective.user_action_required?.required === true) return false;
  const attemptStillActive = ["created", "assigned", "queued", "running", "validating", "recovering", "waiting"].includes(attempt.status)
    && !["stopped", "terminal", "stale"].includes(attempt.liveness);
  if (attemptStillActive) return false;
  const terminal = ["delivered", "incomplete", "cancelled"].includes(objective.status)
    || ["completed", "failed", "cancelled"].includes(attempt.status)
    || ["stopped", "terminal", "stale"].includes(attempt.liveness);
  const inactive = !attempt.writer_activity.active
    && !attempt.browser_activity.active
    && !(attempt.execution_observability?.recovering && attempt.execution_observability?.owner_alive !== false && attempt.liveness !== "stale");
  return terminal && inactive;
}

export function deriveOfficeZone(
  objective: DashboardObjectiveProjection,
  projectCurrentObjectiveKey: string | null = null
): { zone: OfficeZone; reason: string } {
  const attempt = objective.current_attempt;
  const resource = attempt?.resource_policy;
  const liveness = attempt?.liveness ?? "unknown";
  const attemptStillActive = Boolean(attempt
    && ["created", "assigned", "queued", "running", "validating", "recovering", "waiting"].includes(attempt.status)
    && !["stopped", "terminal", "stale"].includes(liveness));
  const delivery = attempt?.git_finalization?.delivery_status ?? attempt?.outcome.delivery_status ?? "not_requested";
  if (!hasConsistentCurrentAttempt(objective)) {
    return { zone: "archive", reason: "当前 Attempt 关系不一致，已降级为历史档案，避免进入当前异常统计" };
  }
  if (isArchivedLegacyHandoff(objective)) {
    return { zone: "archive", reason: "旧 Handoff 已结束，仅保留在历史档案" };
  }
  if (isArchivedNonCurrentLegacyTerminal(objective, projectCurrentObjectiveKey)) {
    return { zone: "archive", reason: "旧式单次任务已终态且不再是项目当前 Objective，仅保留在历史档案" };
  }
  if (objective.user_action_required?.required === true || objective.requires_human || objective.status === "waiting_user") {
    return { zone: "waiting_user", reason: objective.user_action_required?.prompt ?? "需要用户决策或补充信息" };
  }
  if (["delivered", "cancelled"].includes(objective.status)) {
    const leaked = Boolean(attempt?.browser_activity.active || attempt?.writer_activity.active);
    return {
      zone: "archive",
      reason: leaked ? "目标已形成终态，但仍检测到浏览器或写入资源未释放" : (objective.status === "delivered" ? "目标已交付" : "目标已取消")
    };
  }
  if (attempt?.status === "blocked" || objective.status === "blocked") {
    if (objective.system_next_action || attempt?.outcome.recoverable) {
      return { zone: "recovering", reason: "执行被策略或依赖阻止，正在等待系统安全调整" };
    }
    return { zone: "incident", reason: "执行被策略或依赖阻止；验收命令未实际执行" };
  }
  const validationLive = Boolean(
    attempt
    && !["completed", "failed", "blocked", "cancelled"].includes(attempt.status)
    && !["stopped", "terminal", "stale"].includes(attempt.liveness)
    && (attempt.activity_state === "validating" || attempt.validation_activity.active || attempt.status === "validating" || attempt.acceptance_status === "running")
  );
  if (validationLive) {
    return { zone: "validation", reason: objective.status === "recovering" ? "恢复 Attempt 正在重新验收" : "正在验收或验证" };
  }
  const recoveryInProgress = Boolean(
    objective.status === "recovering"
    || attempt?.status === "recovering"
    || attempt?.execution_observability?.recovering
  );
  if (
    attempt?.status === "failed"
    || objective.status === "failed"
    || (!recoveryInProgress && attempt?.outcome.validation_status === "failed")
    || (!recoveryInProgress && attempt?.acceptance_status === "failed")
  ) {
    return { zone: "incident", reason: "验收或执行已明确失败，等待恢复或重试" };
  }
  if (attempt?.activity_state === "stalled") {
    return { zone: "incident", reason: attempt.no_progress_level === "severe" ? "长时间没有真实进展证据" : "真实进展计时显示任务疑似停滞" };
  }
  if (
    liveness === "stale"
    || Boolean(attempt && ["running", "validating", "recovering"].includes(attempt.status) && ["stopped", "unknown"].includes(liveness))
    || (objective.status === "incomplete" && !attemptStillActive)
    || attempt?.execution_observability?.owner_alive === false
  ) {
    return { zone: "incident", reason: "存在停滞或执行证据异常" };
  }
  if (objective.status === "recovering" || attempt?.status === "recovering" || attempt?.execution_observability?.recovering) {
    return { zone: "recovering", reason: "失败后正在恢复或准备重试" };
  }
  if (attempt?.browser_activity.active) return { zone: "browser", reason: "浏览器执行证据显示活动中" };
  if (attempt?.status === "implemented_not_verified"
    || (attempt?.outcome.execution_status === "completed" && !["passed", "skipped"].includes(attempt.outcome.validation_status))) {
    return { zone: "validation", reason: "实现已完成，等待验收或复核" };
  }
  if (["passed", "skipped"].includes(attempt?.outcome.validation_status ?? "") && !["pushed", "delivered"].includes(delivery)) {
    return { zone: "delivery", reason: delivery === "failed" ? "验收已通过，但 Git 交付失败" : "验收已通过，等待提交或推送交付" };
  }
  if (deliveryNeedsAttention(attempt)) {
    return { zone: "delivery", reason: delivery === "failed" ? "实现或验收已完成，但 Git 交付失败" : "等待提交或推送交付" };
  }
  if (objective.status === "not_started" || ["queued", "created"].includes(attempt?.status ?? "") || resource?.status === "queued_by_resource_policy") {
    return { zone: "dispatch", reason: resource?.status === "queued_by_resource_policy" ? "等待资源调度" : "等待执行器接单" };
  }
  if (attempt && (["model_active", "tool_reading", "tool_writing", "idle_between_steps"].includes(attempt.activity_state)
    || ["running", "assigned"].includes(attempt.status)
    || attempt.writer_activity.active
    || attempt.outcome.execution_status === "running")) {
    const reason = attempt.activity_state === "model_active"
      ? "模型正在进行公开可观察的分析"
      : attempt.activity_state === "tool_reading"
        ? "正在读取或检索项目资料"
        : attempt.activity_state === "idle_between_steps"
          ? "当前工具步骤已完成，处于步骤间空闲"
          : "正在实现或执行本地写入";
    return { zone: "development", reason };
  }
  if (["delivered", "incomplete", "cancelled"].includes(objective.status)) {
    return { zone: "archive", reason: objective.status === "delivered" ? "目标已交付" : "目标已形成终态" };
  }
  return { zone: "dispatch", reason: "尚未形成可确认的活动证据" };
}

function attemptSummary(attempt: DashboardTaskProjection | null): OfficeAttemptSummaryV1 | null {
  if (!attempt) return null;
  const git = attempt.git_finalization;
  const incidentState: OfficeAttemptSummaryV1["incident_state"] = attempt.status === "blocked" || attempt.domain_status === "blocked"
    ? "blocked"
    : attempt.domain_status === "orphaned" || (attempt.execution_observability?.owner_alive === false && attempt.liveness === "stale")
      ? "orphaned"
      : attempt.domain_status === "stalled" || attempt.activity_state === "stalled" || ["stalled", "severe"].includes(attempt.no_progress_level)
        ? "stalled"
        : attempt.status === "failed" || attempt.outcome.validation_status === "failed"
          ? "failed"
          : attempt.user_action_required?.required === true
            ? "waiting_approval"
            : null;
  return {
    task_id: attempt.task_id,
    run_id: attempt.run_id,
    workspace_id: attempt.workspace_id ?? "unknown",
    workspace_root: attempt.workspace_root ?? "unknown",
    workspace_generation: attempt.workspace_generation ?? null,
    identity_quality: attempt.identity_quality ?? "authoritative",
    legacy_binding: attempt.legacy_binding === true,
    actor_id: attempt.actor_id ?? null,
    actor_role: attempt.actor_role ?? "executor",
    title: cleanText(attempt.title, 240),
    status: attempt.status,
    liveness: attempt.liveness,
    phase: cleanText(attempt.current_phase || attempt.phase, 120),
    action: cleanText(attempt.safe_progress_summary || attempt.current_action || attempt.progress_summary, 360),
    activity_state: attempt.activity_state,
    activity_label: cleanText(attempt.activity_label, 120),
    safe_progress_summary: cleanText(attempt.safe_progress_summary, 360),
    last_meaningful_progress_at: attempt.last_meaningful_progress_at,
    no_progress_level: attempt.no_progress_level,
    no_progress_duration_ms: attempt.no_progress_duration_ms,
    user_action_required: attempt.user_action_required,
    progress: {
      current: attempt.current_step,
      total: attempt.total_steps,
      interpretation: "recorded_events",
      label: `已记录 ${Math.max(0, attempt.current_step)} 条进展`
    },
    executor: attempt.executor ? {
      kind: attempt.executor.kind,
      provider: cleanNullable(attempt.executor.provider, 120),
      model: cleanNullable(attempt.executor.model, 120),
      execution_id: cleanNullable(attempt.executor.execution_id, 240),
      source: cleanText(attempt.executor.source, 120)
    } : null,
    resource: attempt.resource_policy ? {
      status: attempt.resource_policy.status,
      execution_mode: attempt.resource_policy.execution_mode,
      queue_position: attempt.resource_policy.queue_position,
      blocking_reasons: attempt.resource_policy.blocking_reasons.map((item) => cleanText(item, 240)).slice(0, 8)
    } : null,
    writer_active: attempt.writer_activity.active,
    browser_active: attempt.browser_activity.active,
    validation_active: attempt.validation_activity.active,
    acceptance_status: attempt.acceptance_status,
    implementation_status: attempt.outcome.execution_status,
    validation_status: attempt.outcome.validation_status,
    delivery_status: git?.delivery_status ?? attempt.outcome.delivery_status,
    evidence_status: attempt.outcome.evidence_status,
    completion_state: attempt.completion_state,
    incident_state: incidentState,
    report_summary: attempt.report_summary ? {
      latest_sequence: attempt.report_summary.latest_sequence,
      event_count: attempt.report_summary.event_count,
      current_stage_key: attempt.report_summary.current_stage_key,
      current_stage_title: cleanNullable(attempt.report_summary.current_stage_title, 200),
      current_summary: cleanNullable(attempt.report_summary.current_summary, 900),
      current_source_kind: cleanNullable(attempt.report_summary.current_source_kind, 40),
      latest_important_event: attempt.report_summary.latest_important_event ? {
        event_id: cleanText(attempt.report_summary.latest_important_event.event_id, 300),
        idempotency_key: cleanText(attempt.report_summary.latest_important_event.idempotency_key, 300),
        sequence: attempt.report_summary.latest_important_event.sequence,
        event_kind: attempt.report_summary.latest_important_event.event_kind,
        severity: attempt.report_summary.latest_important_event.severity,
        title: cleanText(attempt.report_summary.latest_important_event.title, 200),
        summary: cleanText(attempt.report_summary.latest_important_event.summary, 900),
        occurred_at: attempt.report_summary.latest_important_event.occurred_at,
        source_kind: attempt.report_summary.latest_important_event.source_kind
      } : null,
      finding_count: attempt.report_summary.finding_count,
      warning_count: attempt.report_summary.warning_count,
      action_required_count: attempt.report_summary.action_required_count,
      latest_event_at: attempt.report_summary.latest_event_at
    } : null,
    git: git ? {
      branch: cleanNullable(git.branch, 160),
      changed_files: (git.changed_files ?? []).map((item) => cleanText(item, 500)).slice(0, 500),
      commit_status: git.commit_status,
      push_status: git.push_status,
      delivery_status: git.delivery_status,
      local_commit_sha: cleanNullable(git.local_commit_sha, 80),
      remote_commit_sha: cleanNullable(git.remote_commit_sha, 80),
      commit_message: cleanNullable(git.commit_message, 500),
      push_transport: cleanNullable(git.push_transport, 120),
      push_attempts: git.push_attempts ?? 0,
      push_error_code: cleanNullable(git.push_error_code, 160),
      reason_code: cleanText(git.reason_code, 160),
      reason: cleanText(git.reason, 360),
      retry_available: git.retry_available
    } : null,
    last_heartbeat: attempt.last_heartbeat,
    updated_at: attempt.updated_at,
    latest_error: cleanNullable(attempt.execution_observability?.latest_error, 500),
    observability: {
      last_liveness_at: attempt.execution_observability?.last_liveness_at ?? attempt.last_heartbeat,
      last_progress_at: attempt.execution_observability?.last_progress_at ?? null,
      no_progress_duration_ms: attempt.execution_observability?.no_progress_duration_ms ?? null,
      recovery_count: attempt.execution_observability?.recovery_count ?? null,
      recovery_from_run_id: cleanNullable(attempt.execution_observability?.recovery_from_run_id, 240),
      resume_count: attempt.execution_observability?.resume_count ?? null,
      owner_alive: attempt.execution_observability?.owner_alive ?? null,
      watcher_alive: attempt.execution_observability?.watcher_alive ?? null
    },
    safe_to_close_chat: {
      safe: attempt.safe_to_close_chat.safe,
      reason: cleanText(attempt.safe_to_close_chat.reason, 360),
      stable_task_identity: attempt.safe_to_close_chat.stable_task_identity,
      authority_recognized: attempt.safe_to_close_chat.authority_recognized,
      authority: attempt.safe_to_close_chat.authority
    },
    available_actions: attempt.available_actions.slice(0, 8).map((action) => ({
      ...action,
      label: cleanText(action.label, 120),
      reason: cleanText(action.reason, 360),
      required_checks: action.required_checks.map((item) => cleanText(item, 240)).slice(0, 8)
    }))
  };
}

function componentRecords(attempt: DashboardTaskProjection | null): ExecutionComponentRecord[] {
  if (!attempt?.execution_components) return [];
  return [
    ...Object.values(attempt.execution_components.model_stream),
    ...Object.values(attempt.execution_components.tool_processes),
    ...Object.values(attempt.execution_components.workers)
  ].sort((left, right) => timestamp(right.last_progress_at ?? right.last_transition_at) - timestamp(left.last_progress_at ?? left.last_transition_at));
}

const RECENT_TOOL_ACTIVITY_WINDOW_MS = 7_000;

function recentToolActivity(records: ExecutionComponentRecord[], workerId: string, observedAt = Date.now()): {
  action: string;
  completed_at: string;
  visible_until: string;
  evidence_ref: string | null;
} | null {
  const recent = records
    .filter((record) => record.kind === "tool_process" && record.owner_id === workerId && record.state === "terminal")
    .map((record) => ({ record, completedAt: timestamp(record.last_transition_at ?? record.last_progress_at ?? record.last_liveness_at) }))
    .filter((item) => item.completedAt > 0 && observedAt - item.completedAt >= 0 && observedAt - item.completedAt <= RECENT_TOOL_ACTIVITY_WINDOW_MS)
    .sort((left, right) => right.completedAt - left.completedAt)[0];
  if (!recent) return null;
  const completedAt = new Date(recent.completedAt).toISOString();
  return {
    action: cleanText(`刚完成：${recent.record.progress_marker || recent.record.component_id}`, 300),
    completed_at: completedAt,
    visible_until: new Date(recent.completedAt + RECENT_TOOL_ACTIVITY_WINDOW_MS).toISOString(),
    evidence_ref: cleanNullable(recent.record.evidence_ref, 500)
  };
}

function executorsFor(attempt: DashboardTaskProjection | null, writerLease?: OfficeWriterLeaseV1): OfficeExecutorV1[] {
  if (!attempt) return [];
  const records = componentRecords(attempt);
  const workers = records.filter((record) => record.kind === "worker").slice(0, GRAPH_NODE_LIMIT - 2);
  const runtimeExecutionId = typeof attempt.executor?.execution_id === "string" && attempt.executor.execution_id.trim()
    ? attempt.executor.execution_id.trim()
    : null;
  const executors: OfficeExecutorV1[] = workers.map((record) => {
    const runtimeMatchesWorker = runtimeExecutionId === record.component_id;
    const recentActivity = recentToolActivity(records, record.component_id);
    return {
      executor_key: record.component_id,
      executor_id: record.component_id,
      label: cleanText(record.component_id, 120),
      kind: "worker",
      worker_type: "worker",
      provider: runtimeMatchesWorker ? cleanNullable(attempt.executor?.provider, 120) : null,
      model: runtimeMatchesWorker ? cleanNullable(attempt.executor?.model, 120) : null,
      component_ids: [record.component_id],
      read_write_mode: attempt.resource_policy?.execution_mode === "read" ? "read_only" : "unknown",
      active: activityState(record.state) === "active",
      state: activityState(record.state),
      activity_state: record.state === "idle"
        ? "idle_between_steps"
        : record.state === "stale"
          ? "stalled"
          : record.activity_state ?? attempt.activity_state,
      current_action: recentActivity?.action ?? cleanNullable(record.safe_summary ?? record.progress_marker, 300),
      recent_activity_action: recentActivity?.action ?? null,
      recent_activity_completed_at: recentActivity?.completed_at ?? null,
      recent_activity_until: recentActivity?.visible_until ?? null,
      last_progress_at: recentActivity?.completed_at ?? record.last_meaningful_progress_at ?? record.last_progress_at,
      evidence_ref: recentActivity?.evidence_ref ?? cleanNullable(record.evidence_ref, 500),
      writer: false,
      browser: false,
      validation: false
    };
  });
  const subagentNodes = (attempt.execution_graph_evidence?.nodes ?? [])
    .filter((node) => node.source_kind === "structured_runtime_event"
      && node.node_type === "worker"
      && (node.component_id?.startsWith("subagent:") || node.node_id.startsWith("subagent:")))
    .slice(0, GRAPH_NODE_LIMIT - 2);
  for (const node of subagentNodes) {
    const executorId = node.component_id ?? node.node_id;
    if (executors.some((executor) => executor.executor_id === executorId)) continue;
    executors.push({
      executor_key: executorId,
      executor_id: executorId,
      label: cleanText(node.label || executorId, 120),
      kind: "subagent",
      worker_type: "subagent",
      provider: null,
      model: null,
      component_ids: node.component_id ? [node.component_id] : [],
      read_write_mode: "read_only",
      active: node.state === "active",
      state: node.state,
      activity_state: attempt.activity_state,
      current_action: cleanNullable(node.transition_reason, 300),
      recent_activity_action: null,
      recent_activity_completed_at: null,
      recent_activity_until: null,
      last_progress_at: node.updated_at,
      evidence_ref: node.evidence_refs[0] ?? node.source_ref,
      writer: false,
      browser: false,
      validation: false
    });
  }
  const runtimeComponentIds = runtimeExecutionId
    ? records.filter((record) => record.component_id === runtimeExecutionId || record.owner_id === runtimeExecutionId).map((record) => record.component_id)
    : [];
  if (
    attempt.executor
    && runtimeExecutionId
    && workers.length === 0
    && !executors.some((executor) => executor.executor_id === runtimeExecutionId)
  ) {
    executors.push({
      executor_key: runtimeExecutionId,
      executor_id: runtimeExecutionId,
      label: cleanText([attempt.executor.provider, attempt.executor.model].filter(Boolean).join(" · ") || attempt.executor.kind, 120),
      kind: attempt.executor.kind,
      worker_type: cleanNullable(attempt.executor.kind, 120),
      provider: cleanNullable(attempt.executor.provider, 120),
      model: cleanNullable(attempt.executor.model, 120),
      component_ids: runtimeComponentIds,
      read_write_mode: attempt.resource_policy?.execution_mode === "read" ? "read_only" : "unknown",
      active: activityState(attempt.liveness) === "active",
      state: activityState(attempt.liveness),
      activity_state: attempt.activity_state,
      current_action: cleanNullable(attempt.safe_progress_summary || attempt.current_action || attempt.progress_summary, 300),
      recent_activity_action: null,
      recent_activity_completed_at: null,
      recent_activity_until: null,
      last_progress_at: attempt.last_meaningful_progress_at,
      evidence_ref: attempt.last_evidence,
      writer: false,
      browser: false,
      validation: false
    });
  }
  const leaseMatchesAttempt = writerLease?.state === "active" && writerLease.holder_task_id === attempt.task_id;
  if (executors.length === 0 && !leaseMatchesAttempt && attempt.actor_id && attempt.actor_role !== "observer") {
    executors.push({
      executor_key: attempt.actor_id,
      executor_id: attempt.actor_id,
      label: cleanText(attempt.actor_id, 120),
      kind: attempt.actor_role,
      worker_type: attempt.actor_role,
      provider: null,
      model: null,
      component_ids: [],
      read_write_mode: "unknown",
      active: !["completed", "failed", "cancelled"].includes(attempt.status),
      state: activityState(attempt.status),
      activity_state: attempt.activity_state,
      current_action: cleanNullable(attempt.safe_progress_summary || attempt.current_action || attempt.progress_summary, 300),
      recent_activity_action: null,
      recent_activity_completed_at: null,
      recent_activity_until: null,
      last_progress_at: attempt.last_meaningful_progress_at,
      evidence_ref: `task_identity:${attempt.task_id}`,
      writer: false,
      browser: false,
      validation: false
    });
  }
  if (leaseMatchesAttempt && executors.length === 0) {
    const leaseExecutorId = `lease-holder:${attempt.task_id}`;
    executors.push({
      executor_key: leaseExecutorId,
      executor_id: leaseExecutorId,
      label: "资源租约持有者",
      kind: "resource_lease_holder",
      worker_type: "degraded_projection",
      provider: null,
      model: null,
      component_ids: [],
      read_write_mode: "writer",
      active: writerLease?.owner_alive !== false && writerLease?.stale !== true,
      state: writerLease?.stale || writerLease?.owner_alive === false ? "stale" : "active",
      activity_state: writerLease?.stale || writerLease?.owner_alive === false ? "stalled" : "tool_writing",
      current_action: "正在占用写入工位",
      recent_activity_action: null,
      recent_activity_completed_at: null,
      recent_activity_until: null,
      last_progress_at: writerLease?.acquired_at ?? attempt.last_heartbeat,
      evidence_ref: writerLease?.evidence ?? "resource_governor_lease",
      writer: true,
      browser: false,
      validation: false
    });
  }
  const singleExecutor = executors.length === 1;
  const writerEvidence = writerLease
    ? writerLease.state === "active" && writerLease.holder_task_id === attempt.task_id
    : attempt.writer_activity.active;
  return executors.map((executor) => {
    const writer = singleExecutor && writerEvidence;
    return {
      ...executor,
      read_write_mode: writer ? "writer" : executor.read_write_mode,
      writer,
      browser: singleExecutor && attempt.browser_activity.active,
      validation: singleExecutor && attempt.validation_activity.active
    };
  });
}

function componentsFor(attempt: DashboardTaskProjection | null, writerLease?: OfficeWriterLeaseV1): OfficeComponentV1[] {
  if (!attempt) return [];
  const records = componentRecords(attempt).slice(0, GRAPH_NODE_LIMIT - 2);
  const graphNodes = attempt.execution_graph_evidence?.nodes ?? [];
  const evidenceByComponent = new Map(graphNodes
    .filter((node) => node.component_id)
    .map((node) => [node.component_id as string, node]));
  const workers = records.filter((record) => record.kind === "worker");
  const writerEvidence = writerLease
    ? writerLease.state === "active" && writerLease.holder_task_id === attempt.task_id
    : attempt.writer_activity.active;
  const provenWriterComponentId = workers.length === 1 && writerEvidence ? workers[0].component_id : null;
  const components: OfficeComponentV1[] = records.map((record) => {
    const graphNode = evidenceByComponent.get(record.component_id);
    return {
      component_id: cleanText(record.component_id, 180),
      component_kind: record.kind,
      status: graphNode?.state ?? activityState(record.state),
      raw_state: cleanText(graphNode?.state ?? record.state, 120),
      run_id: graphNode?.run_id ?? cleanNullable(record.run_id, 240),
      parent_run_id: graphNode?.parent_run_id ?? null,
      owner_id: graphNode?.parent_node_id ?? cleanNullable(record.owner_id, 240),
      executor_ids: record.kind === "worker" ? [record.component_id] : [],
      read_write_mode: attempt.resource_policy?.execution_mode === "read"
        ? "read_only"
        : (record.component_id === provenWriterComponentId ? "writer" : "unknown"),
      progress_marker: cleanNullable(graphNode?.transition_reason ?? record.progress_marker, 300),
      last_progress_at: graphNode?.updated_at ?? record.last_progress_at ?? record.last_liveness_at,
      evidence_ref: graphNode?.evidence_refs[0] ?? cleanNullable(record.evidence_ref, 500)
    };
  });
  const knownComponentIds = new Set(components.map((component) => component.component_id));
  for (const node of graphNodes) {
    if (node.node_id === `attempt:${attempt.task_id}`) continue;
    const componentId = cleanText(node.component_id ?? node.node_id, 180);
    if (knownComponentIds.has(componentId)) continue;
    knownComponentIds.add(componentId);
    components.push({
      component_id: componentId,
      component_kind: node.node_type,
      status: node.state,
      raw_state: node.state,
      run_id: node.run_id,
      parent_run_id: node.parent_run_id,
      owner_id: node.parent_node_id,
      executor_ids: node.node_type === "worker" ? [componentId] : [],
      read_write_mode: "unknown",
      progress_marker: cleanNullable(node.transition_reason ?? node.label, 300),
      last_progress_at: node.updated_at,
      evidence_ref: node.evidence_refs[0] ?? node.source_ref
    });
  }
  return components.slice(0, GRAPH_NODE_LIMIT - 2);
}

function devicesFor(
  attempt: DashboardTaskProjection | null,
  writerLease: OfficeWriterLeaseV1,
  executors: OfficeExecutorV1[],
  components: OfficeComponentV1[]
): OfficeDeviceV1[] {
  if (!attempt) return [];
  const devices: OfficeDeviceV1[] = components.map((component) => {
    const executorIds = executors
      .filter((executor) => executor.component_ids.includes(component.component_id)
        || executor.executor_id === component.owner_id
        || executor.executor_id === component.component_id)
      .map((executor) => executor.executor_id);
    return {
      device_id: `component:${component.component_id}`,
      device_kind: component.component_kind,
      label: component.component_id,
      state: component.status,
      executor_ids: executorIds,
      component_ids: [component.component_id],
      evidence_source: "execution_component_store",
      evidence_ref: component.evidence_ref,
      details: component.progress_marker ?? component.raw_state
    };
  });
  const soleExecutorIds = executors.length === 1 ? [executors[0].executor_id] : [];
  if (attempt.browser_activity.active) {
    devices.push({
      device_id: `browser:${attempt.task_id}`,
      device_kind: "browser",
      label: "浏览器工位",
      state: "active",
      executor_ids: soleExecutorIds,
      component_ids: [],
      evidence_source: "task_projection.browser_activity",
      evidence_ref: attempt.last_evidence,
      details: cleanText(attempt.browser_activity.summary || attempt.current_action, 240)
    });
  }
  const validationObserved = attempt.validation_activity.active
    || ["pending", "running", "passed", "failed"].includes(attempt.acceptance_status)
    || ["pending", "running", "passed", "failed", "skipped"].includes(attempt.outcome.validation_status);
  if (validationObserved) {
    const validationState: OfficeActivityState = attempt.validation_activity.active || attempt.acceptance_status === "running"
      ? "active"
      : (["passed", "failed", "skipped"].includes(attempt.outcome.validation_status) || ["passed", "failed"].includes(attempt.acceptance_status) ? "terminal" : "waiting");
    devices.push({
      device_id: `acceptance:${attempt.task_id}`,
      device_kind: "acceptance",
      label: "验收设备",
      state: validationState,
      executor_ids: soleExecutorIds,
      component_ids: [],
      evidence_source: "task_projection.acceptance",
      evidence_ref: attempt.last_evidence,
      details: cleanText(`验收 ${attempt.acceptance_status} · 结果 ${attempt.outcome.validation_status}`, 240)
    });
  }
  if (["active", "queued"].includes(writerLease.state)) {
    devices.push({
      device_id: `writer-lease:${attempt.task_id}`,
      device_kind: "writer_lease",
      label: writerLease.state === "active" ? "写入工位" : "写入排队位",
      state: writerLease.state === "active" ? "active" : "waiting",
      executor_ids: executors.filter((executor) => executor.writer).map((executor) => executor.executor_id),
      component_ids: [],
      evidence_source: writerLease.evidence,
      evidence_ref: writerLease.lease_id,
      details: writerLease.state === "active"
        ? cleanText(`任务 ${writerLease.holder_task_id ?? "未知"} · 代次 ${writerLease.fence ?? "未知"}`, 240)
        : cleanText(`排队位置 ${writerLease.queue_position ?? "未知"} · 等待 ${writerLease.waiting_count}`, 240)
    });
  }
  return devices;
}

function graphRetrySemantics(attempt: DashboardTaskProjection): {
  retry_policy: OfficeGraphNodeV1["retry_policy"];
  replay_allowed: boolean | null;
  transition_reason: string | null;
} {
  const action = attempt.available_actions.find((candidate) => candidate.action === "retry_step")
    ?? attempt.available_actions.find((candidate) => candidate.action === "resume");
  const transitionReason = cleanNullable(
    attempt.execution_observability?.termination_reason ?? attempt.outcome.primary_reason_code,
    300
  );
  if (!action) {
    return {
      retry_policy: "unknown",
      replay_allowed: null,
      transition_reason: transitionReason
    };
  }
  return {
    retry_policy: action.retry_policy,
    replay_allowed: action.retry_policy === "never" ? false : null,
    transition_reason: transitionReason
  };
}

type OfficeGraphNodeInput = Pick<OfficeGraphNodeV1, "node_id" | "node_type" | "label" | "state" | "run_id">
  & Partial<Omit<OfficeGraphNodeV1, "node_id" | "node_type" | "label" | "state" | "run_id">>;

function officeGraphNode(input: OfficeGraphNodeInput): OfficeGraphNodeV1 {
  const evidenceRef = input.evidence_ref ?? null;
  return {
    parent_hint: null,
    parent_node_ids: [],
    blocked_by_node_ids: [],
    executor_ids: [],
    component_ids: [],
    read_write_mode: "unknown",
    evidence_ref: evidenceRef,
    evidence_refs: input.evidence_refs ?? (evidenceRef ? [evidenceRef] : []),
    updated_at: null,
    started_at: null,
    completed_at: null,
    route_source: "unknown",
    transition_reason: null,
    retry_policy: "not_applicable",
    replay_allowed: null,
    attempt: null,
    max_attempts: null,
    ...input
  };
}

function officeGraphEdge(
  from: string,
  to: string,
  relation: OfficeGraphEdgeV1["relation"],
  edgeKind: OfficeGraphEdgeV1["edge_kind"],
  authority: string,
  evidenceRef: string | null = null
): OfficeGraphEdgeV1 {
  return {
    edge_id: `edge:${from}:${to}:${relation}:${edgeKind}`,
    from,
    to,
    from_node_id: from,
    to_node_id: to,
    relation,
    edge_class: officeGraphEdgeClass(edgeKind),
    edge_kind: edgeKind,
    condition: null,
    selected: null,
    relation_group: null,
    dependency_satisfied: null,
    route_source: "unknown",
    transition_reason: null,
    retry_policy: "not_applicable",
    replay_allowed: null,
    attempt: null,
    max_attempts: null,
    authority,
    evidence_ref: evidenceRef,
    evidence_refs: evidenceRef ? [evidenceRef] : [],
    degraded_reason: null
  };
}

function uniqueGraphValues(values: Array<string | null | undefined>, limit = 50): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, limit);
}

function latestGraphTimestamp(left: string | null, right: string | null): string | null {
  const leftTime = Date.parse(left ?? "");
  const rightTime = Date.parse(right ?? "");
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime >= leftTime ? right : left;
}

function mergeOfficeGraphNode(current: OfficeGraphNodeV1 | undefined, incoming: OfficeGraphNodeV1): OfficeGraphNodeV1 {
  if (!current) return incoming;
  const latest = latestGraphTimestamp(current.updated_at, incoming.updated_at) === incoming.updated_at ? incoming : current;
  const earlier = latest === incoming ? current : incoming;
  const preserveTaskState = current.node_type === "objective" || current.node_type === "attempt";
  return {
    ...earlier,
    ...latest,
    node_type: current.node_type,
    label: current.label === current.node_id && incoming.label !== incoming.node_id ? incoming.label : current.label,
    state: preserveTaskState ? current.state : latest.state,
    run_id: current.run_id ?? incoming.run_id,
    parent_hint: incoming.parent_hint ?? current.parent_hint,
    parent_node_ids: uniqueGraphValues([...current.parent_node_ids, ...incoming.parent_node_ids]),
    blocked_by_node_ids: uniqueGraphValues([...current.blocked_by_node_ids, ...incoming.blocked_by_node_ids]),
    executor_ids: uniqueGraphValues([...current.executor_ids, ...incoming.executor_ids]),
    component_ids: uniqueGraphValues([...current.component_ids, ...incoming.component_ids]),
    read_write_mode: current.read_write_mode !== "unknown" ? current.read_write_mode : incoming.read_write_mode,
    evidence_ref: incoming.evidence_ref ?? current.evidence_ref,
    evidence_refs: uniqueGraphValues([...current.evidence_refs, ...incoming.evidence_refs]),
    updated_at: latestGraphTimestamp(current.updated_at, incoming.updated_at),
    started_at: current.started_at ?? incoming.started_at,
    completed_at: incoming.completed_at ?? current.completed_at,
    route_source: incoming.route_source !== "unknown" ? incoming.route_source : current.route_source,
    transition_reason: incoming.transition_reason ?? current.transition_reason,
    retry_policy: incoming.retry_policy !== "unknown" && incoming.retry_policy !== "not_applicable" ? incoming.retry_policy : current.retry_policy,
    replay_allowed: incoming.replay_allowed ?? current.replay_allowed,
    attempt: incoming.attempt ?? current.attempt,
    max_attempts: incoming.max_attempts ?? current.max_attempts
  };
}

function resolvedOfficeGraphEdge(resolved: NonNullable<ReturnType<typeof resolveOfficeGraphRelation>["edge"]>): OfficeGraphEdgeV1 {
  return {
    edge_id: resolved.edge_id,
    from: resolved.from_node_id,
    to: resolved.to_node_id,
    from_node_id: resolved.from_node_id,
    to_node_id: resolved.to_node_id,
    relation: resolved.edge_kind === "recovery" ? "recovery" : "execution_relation",
    edge_class: "execution",
    edge_kind: resolved.edge_kind,
    condition: resolved.condition,
    selected: resolved.selected,
    relation_group: resolved.relation_group,
    dependency_satisfied: resolved.dependency_satisfied,
    route_source: resolved.route_source,
    transition_reason: resolved.transition_reason,
    retry_policy: resolved.retry_policy,
    replay_allowed: resolved.replay_allowed,
    attempt: resolved.attempt,
    max_attempts: resolved.max_attempts,
    authority: resolved.authority,
    evidence_ref: resolved.evidence_refs[0] ?? null,
    evidence_refs: resolved.evidence_refs,
    degraded_reason: null
  };
}

function graphFor(
  objective: DashboardObjectiveProjection,
  projectedExecutors: OfficeExecutorV1[] = [],
  writerLease?: OfficeWriterLeaseV1
): OfficeExecutionGraphV1 {
  const attempt = objective.current_attempt;
  const records = componentRecords(attempt);
  const objectiveNode = `objective:${objective.objective_key}`;
  const objectiveEvidence = `objective_projection:${objective.objective_key}:${objective.updated_at}`;
  const nodeMap = new Map<string, OfficeGraphNodeV1>();
  const edgeMap = new Map<string, OfficeGraphEdgeV1>();
  const degradedReasons: string[] = [];
  const addNode = (node: OfficeGraphNodeV1) => nodeMap.set(node.node_id, mergeOfficeGraphNode(nodeMap.get(node.node_id), node));
  const addEdge = (edge: OfficeGraphEdgeV1) => {
    const existing = edgeMap.get(edge.edge_id);
    if (!existing) {
      edgeMap.set(edge.edge_id, edge);
      return;
    }
    edgeMap.set(edge.edge_id, {
      ...existing,
      evidence_ref: edge.evidence_ref ?? existing.evidence_ref,
      evidence_refs: uniqueGraphValues([...existing.evidence_refs, ...edge.evidence_refs])
    });
  };

  addNode(officeGraphNode({
    node_id: objectiveNode,
    node_type: "objective",
    label: cleanText(objective.title, 180),
    state: activityState(objective.status),
    run_id: null,
    evidence_ref: objectiveEvidence,
    updated_at: objective.updated_at,
    started_at: objective.created_at,
    completed_at: ["delivered", "incomplete", "cancelled"].includes(objective.status) ? objective.updated_at : null,
    route_source: "unknown",
    transition_reason: cleanNullable(objective.reason_code, 240),
    retry_policy: "not_applicable"
  }));
  if (!attempt) return {
    authority: "unavailable",
    reason: "当前 Objective 没有可投影的 Attempt，执行图不可用。",
    degraded_reasons: [],
    nodes: [...nodeMap.values()],
    edges: [],
    truncated: false
  };

  const retry = graphRetrySemantics(attempt);
  const attemptNode = `attempt:${attempt.task_id}`;
  const attemptEvidence = attempt.last_evidence ?? `task_projection:${attempt.task_id}:${attempt.updated_at}`;
  const executorIds = projectedExecutors.length
    ? projectedExecutors.map((executor) => executor.executor_id)
    : executorsFor(attempt, writerLease).map((executor) => executor.executor_id);
  const componentIds = records.map((record) => record.component_id).slice(0, GRAPH_NODE_LIMIT - 2);
  const attemptReadWriteMode: OfficeGraphNodeV1["read_write_mode"] = attempt.writer_activity.active
    ? "writer"
    : (attempt.resource_policy?.execution_mode === "read" ? "read_only" : "unknown");
  addNode(officeGraphNode({
    node_id: attemptNode,
    node_type: "attempt",
    label: cleanText(attempt.title, 180),
    state: activityState(attempt.status),
    run_id: attempt.run_id,
    parent_hint: objective.objective_key,
    parent_node_ids: [objectiveNode],
    executor_ids: executorIds,
    component_ids: componentIds,
    read_write_mode: attemptReadWriteMode,
    evidence_ref: attemptEvidence,
    updated_at: attempt.updated_at,
    started_at: attempt.execution_observability?.started_at ?? null,
    completed_at: attempt.execution_observability?.finished_at ?? null,
    route_source: "unknown",
    transition_reason: retry.transition_reason,
    retry_policy: retry.retry_policy,
    replay_allowed: retry.replay_allowed
  }));
  addEdge(officeGraphEdge(objectiveNode, attemptNode, "current_attempt", "containment", "objective_projection", attemptEvidence));

  const visibleRecords = records.slice(0, GRAPH_NODE_LIMIT - 2);
  const visibleRecordIds = new Set(visibleRecords.map((record) => record.component_id));
  const workerRecords = visibleRecords.filter((record) => record.kind === "worker");
  const writerEvidence = writerLease
    ? writerLease.state === "active" && writerLease.holder_task_id === attempt.task_id
    : attempt.writer_activity.active;
  const provenWriterComponentId = workerRecords.length === 1 && writerEvidence ? workerRecords[0].component_id : null;
  for (const record of visibleRecords) {
    const componentEvidence = cleanNullable(record.evidence_ref, 500)
      ?? `execution_component_store:${record.component_id}:${record.last_transition_at}`;
    const provenOwnerNode = record.owner_id && visibleRecordIds.has(record.owner_id) ? record.owner_id : null;
    const componentReadWriteMode: OfficeGraphNodeV1["read_write_mode"] = attempt.resource_policy?.execution_mode === "read"
      ? "read_only"
      : (record.component_id === provenWriterComponentId ? "writer" : "unknown");
    addNode(officeGraphNode({
      node_id: record.component_id,
      node_type: record.kind,
      label: cleanText(record.component_id, 180),
      state: activityState(record.state),
      run_id: record.run_id,
      parent_hint: cleanNullable(record.owner_id, 240),
      parent_node_ids: [provenOwnerNode ?? attemptNode],
      executor_ids: record.kind === "worker" ? [record.component_id] : [],
      component_ids: [record.component_id],
      read_write_mode: componentReadWriteMode,
      evidence_ref: componentEvidence,
      updated_at: record.last_progress_at ?? record.last_transition_at,
      started_at: record.registered_at,
      completed_at: record.state === "terminal" ? record.last_transition_at : null,
      route_source: "runtime",
      transition_reason: cleanNullable(record.terminal_reason, 240),
      retry_policy: "unknown"
    }));
    addEdge(officeGraphEdge(attemptNode, record.component_id, "observed_component", "observation", "execution_component_store", componentEvidence));
  }
  for (const record of visibleRecords) if (record.owner_id && nodeMap.has(record.owner_id) && nodeMap.has(record.component_id)) {
    const componentEvidence = cleanNullable(record.evidence_ref, 500)
      ?? `execution_component_store:${record.component_id}:${record.last_transition_at}`;
    addEdge(officeGraphEdge(record.owner_id, record.component_id, "owner", "ownership", "execution_component_store", componentEvidence));
  }

  const graphEvidence = attempt.execution_graph_evidence;
  if (graphEvidence) {
    degradedReasons.push(...graphEvidence.degraded_reasons);
    for (const evidenceNode of graphEvidence.nodes) {
      const evidenceRefs = evidenceNode.evidence_refs.length ? evidenceNode.evidence_refs : [evidenceNode.source_ref];
      addNode(officeGraphNode({
        node_id: evidenceNode.node_id,
        node_type: evidenceNode.node_id === attemptNode ? "attempt" : evidenceNode.node_type,
        label: cleanText(evidenceNode.label, 180),
        state: evidenceNode.state,
        run_id: evidenceNode.run_id,
        parent_hint: evidenceNode.parent_run_id,
        parent_node_ids: evidenceNode.parent_node_id ? [evidenceNode.parent_node_id] : [],
        executor_ids: evidenceNode.node_type === "worker" && evidenceNode.node_id !== attemptNode ? [evidenceNode.component_id ?? evidenceNode.node_id] : [],
        component_ids: evidenceNode.component_id ? [evidenceNode.component_id] : [],
        evidence_ref: evidenceRefs[0],
        evidence_refs: evidenceRefs,
        updated_at: evidenceNode.updated_at,
        started_at: evidenceNode.started_at,
        completed_at: evidenceNode.completed_at,
        route_source: evidenceNode.route_source,
        transition_reason: evidenceNode.transition_reason,
        retry_policy: evidenceNode.retry_policy,
        replay_allowed: evidenceNode.replay_allowed,
        attempt: evidenceNode.attempt,
        max_attempts: evidenceNode.max_attempts
      }));
    }

    const runNodes = new Map<string, string[]>();
    for (const node of nodeMap.values()) if (node.run_id) {
      runNodes.set(node.run_id, [...(runNodes.get(node.run_id) ?? []), node.node_id]);
    }
    for (const evidenceNode of graphEvidence.nodes) {
      if (evidenceNode.node_id === attemptNode) continue;
      const explicitParent = evidenceNode.parent_node_id;
      const runParents = evidenceNode.parent_run_id ? uniqueGraphValues(runNodes.get(evidenceNode.parent_run_id) ?? []) : [];
      const parentNodeId = explicitParent && nodeMap.has(explicitParent)
        ? explicitParent
        : runParents.length === 1 && runParents[0] !== evidenceNode.node_id
          ? runParents[0]
          : null;
      if (!parentNodeId) {
        if (evidenceNode.parent_run_id) degradedReasons.push(`节点 ${evidenceNode.node_id} 的 parent_run_id=${evidenceNode.parent_run_id} 无法唯一绑定，父子关系已省略。`);
        continue;
      }
      const evidenceRef = evidenceNode.evidence_refs[0] ?? evidenceNode.source_ref;
      addEdge(officeGraphEdge(parentNodeId, evidenceNode.node_id, "owner", "ownership", evidenceNode.source_kind, evidenceRef));
    }

    const relationGroups = new Map<string, OfficeRelationEvidenceV1[]>();
    for (const relation of graphEvidence.relations) {
      const key = `${relation.edge_kind}\u0000${relation.from_node_id}\u0000${relation.to_node_id}`;
      const evidence: OfficeRelationEvidenceV1 = {
        version: 1,
        edge_kind: relation.edge_kind,
        from_node_id: relation.from_node_id,
        to_node_id: relation.to_node_id,
        source_kind: relation.source_kind,
        source_ref: relation.source_ref,
        evidence_ref: relation.evidence_ref,
        route_source: relation.route_source,
        transition_reason: relation.transition_reason,
        condition: relation.condition,
        selected: relation.selected,
        relation_group: relation.relation_group,
        dependency_satisfied: relation.dependency_satisfied,
        retry_policy: relation.retry_policy,
        replay_allowed: relation.replay_allowed,
        attempt: relation.attempt,
        max_attempts: relation.max_attempts,
        idempotency_key: relation.idempotency_key
      };
      relationGroups.set(key, [...(relationGroups.get(key) ?? []), evidence]);
    }
    const knownNodeIds = [...nodeMap.keys()];
    for (const evidence of relationGroups.values()) {
      const first = evidence[0];
      const resolution = resolveOfficeGraphRelation({
        edge_kind: first.edge_kind,
        from_node_id: first.from_node_id,
        to_node_id: first.to_node_id,
        evidence,
        known_node_ids: knownNodeIds
      });
      if (resolution.edge) addEdge(resolvedOfficeGraphEdge(resolution.edge));
      else degradedReasons.push(resolution.reason);
    }
  }

  const recoveryFromRunId = cleanNullable(attempt.execution_observability?.recovery_from_run_id, 240);
  if (recoveryFromRunId && ![...edgeMap.values()].some((edge) => edge.edge_kind === "recovery")) {
    degradedReasons.push(`恢复来源 ${recoveryFromRunId} 只有任务投影字段，没有 Checkpoint、结构化事件或 Handoff 关系证据，Recovery 边已省略。`);
  }

  const ownershipByChild = new Map<string, OfficeGraphEdgeV1[]>();
  for (const edge of edgeMap.values()) if (edge.edge_kind === "ownership") {
    ownershipByChild.set(edge.to_node_id, [...(ownershipByChild.get(edge.to_node_id) ?? []), edge]);
  }
  for (const [childNodeId, ownershipEdges] of ownershipByChild) {
    const parents = uniqueGraphValues(ownershipEdges.map((edge) => edge.from_node_id));
    if (parents.length <= 1) continue;
    for (const edge of ownershipEdges) edgeMap.delete(edge.edge_id);
    const child = nodeMap.get(childNodeId);
    if (child) nodeMap.set(childNodeId, { ...child, parent_node_ids: child.parent_node_ids.filter((parent) => !parents.includes(parent)) });
    degradedReasons.push(`节点 ${childNodeId} 存在冲突 Owner（${parents.join("、")}），全部 Ownership 边已省略。`);
  }

  const allNodes = [...nodeMap.values()];
  const visibleNodes = allNodes.slice(0, GRAPH_NODE_LIMIT);
  const nodeIds = new Set(visibleNodes.map((node) => node.node_id));
  const allEdges = [...edgeMap.values()];
  const displayEdges = allEdges.filter((edge) => edge.edge_kind !== "branch" || edge.selected === true);
  const visibleEdges = displayEdges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .slice(0, GRAPH_EDGE_LIMIT);
  const truncated = Boolean(graphEvidence?.truncated)
    || records.length > visibleRecords.length
    || allNodes.length > visibleNodes.length
    || displayEdges.length > visibleEdges.length;
  if (truncated) degradedReasons.push("执行图超过节点或关系上限，已安全截断并移除悬空边。");
  const uniqueDegradedReasons = uniqueGraphValues(degradedReasons, 50);
  const executionEdges = visibleEdges.filter((edge) => edge.edge_class === "execution");
  const authority: OfficeGraphAuthority = graphEvidence?.authority === "explicit"
    && executionEdges.length > 0
    && uniqueDegradedReasons.length === 0
    ? "explicit"
    : visibleNodes.length > 2 || visibleEdges.length > 1 || Boolean(graphEvidence)
      ? "partial"
      : "unavailable";
  const reason = authority === "explicit"
    ? `结构化事件、显式步骤、Checkpoint 或 Handoff 共确认 ${executionEdges.length} 条执行关系，所有可见节点和边均带证据。`
    : authority === "partial"
      ? `已投影 ${visibleNodes.length} 个有证据节点和 ${visibleEdges.length} 条有证据关系；${uniqueDegradedReasons.length ? `另有 ${uniqueDegradedReasons.length} 项关系因缺失或冲突降级。` : "完整执行路线仍只有部分权威证据。"}`
      : "当前只有 Objective 与 Attempt 身份，没有可证明的执行节点或执行关系。";
  return {
    authority,
    reason,
    degraded_reasons: uniqueDegradedReasons,
    nodes: visibleNodes,
    edges: visibleEdges,
    truncated
  };
}

function writerLeaseForAttempt(attempt: DashboardTaskProjection | null): OfficeWriterLeaseV1 {
  if (!attempt) return {
    state: "unknown",
    holder_task_id: null,
    holder_run_id: null,
    lease_id: null,
    fence: null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: 0,
    stale: false,
    owner_alive: null,
    queue_position: null,
    blocking_reasons: [],
    evidence: "no_current_attempt"
  };
  const resource = attempt.resource_policy;
  const ownerAlive = attempt.execution_observability?.owner_alive ?? null;
  if (attempt.writer_activity.active || (resource?.execution_mode === "write" && resource.status === "admitted")) return {
    state: "active",
    holder_task_id: attempt.task_id,
    holder_run_id: attempt.run_id,
    lease_id: resource?.lease_id ?? null,
    fence: attempt.execution_observability?.fencing_token ?? null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: 0,
    stale: ownerAlive === false,
    owner_alive: ownerAlive,
    queue_position: null,
    blocking_reasons: [],
    evidence: resource ? "task_resource_projection" : "task_writer_activity"
  };
  if (resource?.execution_mode === "write" && resource.status === "queued_by_resource_policy") return {
    state: "queued",
    holder_task_id: attempt.task_id,
    holder_run_id: attempt.run_id,
    lease_id: null,
    fence: attempt.execution_observability?.fencing_token ?? null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: 1,
    stale: false,
    owner_alive: ownerAlive,
    queue_position: resource.queue_position,
    blocking_reasons: resource.blocking_reasons.map((item) => cleanText(item, 240)).slice(0, 8),
    evidence: "task_resource_projection"
  };
  return {
    state: "idle",
    holder_task_id: null,
    holder_run_id: null,
    lease_id: null,
    fence: null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: 0,
    stale: false,
    owner_alive: ownerAlive,
    queue_position: resource?.queue_position ?? null,
    blocking_reasons: resource?.blocking_reasons.map((item) => cleanText(item, 240)).slice(0, 8) ?? [],
    evidence: resource ? "task_resource_projection" : "no_writer_activity"
  };
}

function projectWriterLease(project: DashboardProjectSummary, dashboard: DashboardResponse): OfficeWriterLeaseV1 {
  const now = Date.now();
  const queued = dashboard.resource_governance.queue
    .filter((item) => item.workspace_root === project.root && item.execution_mode === "write" && item.pools.includes("workspace_write"))
    .sort((left, right) => timestamp(left.queued_at) - timestamp(right.queued_at));
  const lease = dashboard.resource_governance.leases
    .filter((item) => item.workspace_root === project.root && item.execution_mode === "write" && item.pools.includes("workspace_write"))
    .sort((left, right) => timestamp(right.heartbeat_at) - timestamp(left.heartbeat_at))[0];
  if (lease) {
    const currentAttempt = dashboard.objectives
      .filter((objective) => objective.project_id === project.project_id)
      .map((objective) => objective.current_attempt)
      .find((attempt) => attempt?.task_id === lease.task_id) ?? null;
    const acquiredAt = timestamp(lease.acquired_at);
    const expiresAt = timestamp(lease.expires_at);
    const ownerAlive = currentAttempt?.execution_observability?.owner_alive ?? null;
    return {
      state: "active",
      holder_task_id: lease.task_id,
      holder_run_id: lease.run_id ?? null,
      lease_id: lease.lease_id,
      fence: lease.fencing_token ?? null,
      acquired_at: lease.acquired_at,
      expires_at: lease.expires_at,
      age_ms: acquiredAt ? Math.max(0, now - acquiredAt) : null,
      waiting_count: queued.length,
      stale: Boolean((expiresAt && expiresAt <= now) || ownerAlive === false),
      owner_alive: ownerAlive,
      queue_position: null,
      blocking_reasons: [],
      evidence: "resource_governor_lease"
    };
  }
  if (queued[0]) return {
    state: "queued",
    holder_task_id: queued[0].task_id,
    holder_run_id: queued[0].run_id ?? null,
    lease_id: null,
    fence: queued[0].fencing_token ?? null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: queued.length,
    stale: false,
    owner_alive: null,
    queue_position: 1,
    blocking_reasons: queued[0].blocking_reasons.map((item) => cleanText(item, 240)).slice(0, 8),
    evidence: "resource_governor_queue"
  };
  return {
    state: "idle",
    holder_task_id: null,
    holder_run_id: null,
    lease_id: null,
    fence: null,
    acquired_at: null,
    expires_at: null,
    age_ms: null,
    waiting_count: 0,
    stale: false,
    owner_alive: null,
    queue_position: null,
    blocking_reasons: [],
    evidence: "resource_governor"
  };
}

function resourceAlertsFor(
  objective: DashboardObjectiveProjection,
  writerLease: OfficeWriterLeaseV1,
  executors: OfficeExecutorV1[]
): string[] {
  const attempt = objective.current_attempt;
  if (!attempt) return [];
  const alerts: string[] = [];
  const terminal = ["delivered", "cancelled"].includes(objective.status) || ["completed", "failed", "cancelled"].includes(attempt.status);
  if (terminal && attempt.browser_activity.active) alerts.push("任务已形成终态，但浏览器空间或标签页仍显示活动状态");
  if (terminal && attempt.writer_activity.active) alerts.push("任务已形成终态，但写入活动仍未释放");
  if (terminal && writerLease.state === "active") alerts.push("任务已形成终态，但资源治理中的写入租约仍未释放");
  const activeAttempt = ["running", "validating", "recovering", "assigned"].includes(attempt.status)
    || attempt.writer_activity.active
    || attempt.browser_activity.active
    || attempt.validation_activity.active;
  if (activeAttempt && attempt.execution_observability?.owner_alive === false && attempt.execution_observability?.watcher_alive === true) {
    alerts.push("Watcher 仍存活，但实际执行 Owner 已死亡");
  } else if (activeAttempt && attempt.execution_observability?.owner_alive === false) alerts.push("执行 Owner 已死亡或无法确认存活");
  if (attempt.execution_observability?.watcher_alive === false && ["running", "validating", "recovering"].includes(attempt.status)) {
    alerts.push("Watcher 不可用，但任务仍处于活动状态");
  }
  if (attempt.no_progress_level === "quiet") alerts.push("最近 1 分钟以上没有新的真实进展证据；服务心跳未被计作进展");
  if (attempt.no_progress_level === "stalled") alerts.push("疑似停滞：至少 3 分钟没有新的真实进展证据");
  if (attempt.no_progress_level === "severe") alerts.push("长时间停滞：至少 5 分钟没有新的真实进展证据");
  const observedNoProgressMs = attempt.execution_observability?.no_progress_duration_ms ?? attempt.no_progress_duration_ms;
  if (Number(observedNoProgressMs) >= 60_000 && !["quiet", "stalled", "severe"].includes(attempt.no_progress_level)) {
    alerts.push(`已有 ${Math.floor(Number(observedNoProgressMs) / 60_000)} 分钟没有新的真实进展证据`);
  }
  if (writerLease.state === "active" && executors.some((executor) => executor.kind === "resource_lease_holder")) {
    alerts.push("active_lease_without_visible_actor：活动写入租约缺少完整执行器证据，已使用降级人物投影");
  }
  if (writerLease.stale) alerts.push("写入租约已过期或持有者失联");
  return alerts.map((item) => cleanText(item, 300)).slice(0, 8);
}

function officeObjective(
  objective: DashboardObjectiveProjection,
  projectWriterLease?: OfficeWriterLeaseV1,
  projectCurrentObjectiveKey: string | null = null
): OfficeObjectiveV1 {
  const placement = deriveOfficeZone(objective, projectCurrentObjectiveKey);
  const attempt = attemptSummary(objective.current_attempt);
  const attemptWriterLease = writerLeaseForAttempt(objective.current_attempt);
  const matchingProjectWriterLease = projectWriterLease && projectWriterLease.holder_task_id === objective.current_attempt?.task_id
    ? projectWriterLease
    : null;
  const writerLease = matchingProjectWriterLease ?? attemptWriterLease;
  const executors = executorsFor(objective.current_attempt, writerLease);
  const components = componentsFor(objective.current_attempt, writerLease);
  const devices = devicesFor(objective.current_attempt, writerLease, executors, components);
  const projected: Omit<OfficeObjectiveV1, "plain_summary"> = {
    objective_key: cleanText(objective.objective_key, 300),
    stable_key: `${objective.project_id}:${objective.objective_key}`,
    project_id: objective.project_id,
    project_name: cleanText(objective.project_name, 180),
    title: cleanText(objective.title, 240),
    stage_key: cleanNullable(objective.stage_key, 160),
    source: objective.source,
    objective_status: objective.status,
    reason_code: cleanText(objective.reason_code, 160),
    zone: placement.zone,
    zone_reason: placement.reason,
    requires_human: objective.requires_human,
    user_action_required: objective.user_action_required,
    system_next_action: cleanNullable(objective.system_next_action, 240),
    activity_state: attempt?.activity_state ?? "unknown",
    activity_label: attempt?.activity_label ?? "状态未知",
    last_meaningful_progress_at: attempt?.last_meaningful_progress_at ?? objective.last_progress_at,
    no_progress_level: attempt?.no_progress_level ?? "unknown",
    no_progress_duration_ms: attempt?.no_progress_duration_ms ?? null,
    attention: ["waiting_user", "incident", "recovering"].includes(placement.zone),
    attempt_count: objective.attempts.length,
    current_attempt_id: objective.current_attempt_id,
    current_attempt: attempt,
    historical_attempts: objective.attempts
      .filter((item) => item.attempt_id !== objective.current_attempt_id)
      .sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at))
      .slice(0, 20)
      .map((item) => ({
        attempt_id: item.attempt_id,
        status: item.status,
        liveness: item.liveness,
        supersession: item.supersession,
        superseded_by_attempt_id: item.superseded_by_attempt_id,
        updated_at: item.updated_at
      })),
    executors,
    components,
    devices,
    resource_alerts: resourceAlertsFor(objective, writerLease, executors),
    writer_lease: writerLease,
    execution_graph: graphFor(objective, executors, writerLease),
    summary: cleanText(attempt?.safe_progress_summary || attempt?.action || placement.reason, 360),
    last_progress_at: attempt?.last_meaningful_progress_at ?? objective.last_progress_at,
    created_at: objective.created_at,
    updated_at: objective.updated_at
  };
  return { ...projected, plain_summary: createOfficePlainSummary(projected) };
}

function emptyZones(): Record<OfficeZone, OfficeObjectiveV1[]> {
  return {
    waiting_user: [],
    incident: [],
    recovering: [],
    validation: [],
    browser: [],
    development: [],
    delivery: [],
    dispatch: [],
    archive: []
  };
}

function emptyCounts(): Record<OfficeZone, number> {
  return {
    waiting_user: 0,
    incident: 0,
    recovering: 0,
    validation: 0,
    browser: 0,
    development: 0,
    delivery: 0,
    dispatch: 0,
    archive: 0
  };
}

function projectMatches(project: DashboardProjectSummary, filter: string | null): boolean {
  if (!filter) return true;
  const normalized = filter.toLowerCase();
  return [project.project_id, project.name, project.root].some((value) => value.toLowerCase().includes(normalized));
}

function activityFeedTab(kind: TaskReportEventKind): OfficeActivityFeedItemV1["tab"] {
  if (["finding", "warning", "assistant_summary"].includes(kind)) return "findings";
  if (["validation_started", "validation_passed", "validation_failed"].includes(kind)) return "acceptance";
  if (["git_committed", "git_pushed", "git_failed"].includes(kind)) return "delivery";
  return "progress";
}

function canonicalActivityFeed(objectives: readonly OfficeObjectiveV1[], today: string): OfficeActivityFeedItemV1[] {
  const byKey = new Map<string, OfficeActivityFeedItemV1>();
  for (const objective of objectives) {
    const attempt = objective.current_attempt;
    const event = attempt?.report_summary?.latest_important_event;
    if (!attempt || !event || attempt.actor_role === "observer" || attempt.identity_quality === "degraded" || attempt.legacy_binding) continue;
    const recentTerminal = objective.zone === "archive"
      && ["task_completed", "task_failed", "task_cancelled"].includes(event.event_kind)
      && event.occurred_at.startsWith(today);
    if (objective.zone === "archive" && !recentTerminal) continue;
    const material = [objective.project_id, objective.objective_key, attempt.task_id, event.event_kind, event.idempotency_key].join("\u0000");
    const feedKey = `feed:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
    byKey.set(feedKey, {
      version: 1,
      feed_key: feedKey,
      project_id: objective.project_id,
      objective_key: objective.objective_key,
      task_id: attempt.task_id,
      sequence: event.sequence,
      event_kind: event.event_kind,
      severity: event.severity,
      tab: activityFeedTab(event.event_kind),
      text: cleanText(event.summary || event.title || "任务有一条新的重要进展", 160),
      occurred_at: event.occurred_at,
      source_kind: event.source_kind
    });
  }
  return [...byKey.values()]
    .sort((left, right) => timestamp(right.occurred_at) - timestamp(left.occurred_at) || right.sequence - left.sequence || left.feed_key.localeCompare(right.feed_key))
    .slice(0, 6);
}

export function emptyOfficeDashboard(options: OfficeProjectionOptions = {}): OfficeProjectionV1 {
  const generatedAt = new Date().toISOString();
  const filters = {
    project: cleanNullable(options.project, 240),
    include_archived: options.include_archived === true,
    include_test_history: options.include_test_history === true,
    archive_limit: boundedInteger(options.archive_limit, DEFAULT_ARCHIVE_LIMIT, 1, 50),
    active_limit_per_project: boundedInteger(options.active_limit_per_project, DEFAULT_ACTIVE_LIMIT, 1, 50)
  };
  const attentionSummary = {
    waiting_user: 0,
    incidents: 0,
    recovering: 0,
    queued: 0,
    validating: 0,
    delivery: 0,
    active_writers: 0,
    active_browser_runs: 0,
    total_objectives: 0
  };
  const revision = revisionFor({ filters, attention_summary: attentionSummary, projects: [] });
  return {
    version: 1,
    generated_at: generatedAt,
    revision,
    projection_id: revision,
    source: "project_aggregation_read_only",
    filters,
    attention_summary: attentionSummary,
    objective_summary: { current: 0, executing: 0, waiting_user: 0, recovering: 0, unresolved_incidents: 0, completed_today: 0, pending_delivery: 0 },
    synchronization: {
      office_projection_lag_ms: 0,
      last_authoritative_event_at: null,
      snapshot_generated_at: generatedAt,
      event_sequence: null,
      event_gap_count: 0,
      orphan_run_count: 0,
      orphan_resource_count: 0,
      observer_contamination_count: 0,
      terminal_state_conflict_count: 0,
      workspace_generation_conflict_count: 0
    },
    activity_feed: [],
    projects: [],
    consistency: { ok: true, checked_at: generatedAt, violations: [] },
    graph_policy: { node_limit_per_objective: 50, edge_limit_per_objective: 100, missing_parent_policy: "omit_unproven_edges" }
  };
}

export function projectOfficeDashboard(dashboard: DashboardResponse, options: OfficeProjectionOptions = {}): OfficeProjectionV1 {
  const projectFilter = cleanNullable(options.project, 240);
  const includeArchived = options.include_archived === true;
  const includeTestHistory = options.include_test_history === true;
  const archiveLimit = boundedInteger(options.archive_limit, DEFAULT_ARCHIVE_LIMIT, 1, 50);
  const activeLimit = boundedInteger(options.active_limit_per_project, DEFAULT_ACTIVE_LIMIT, 1, 50);
  const projects: OfficeProjectFloorV1[] = [];
  const aggregateProjected: OfficeObjectiveV1[] = [];
  const aggregateCounts = emptyCounts();
  let aggregateActiveWriters = 0;
  let aggregateActiveBrowserRuns = 0;
  for (const project of dashboard.projects.filter((item) => projectMatches(item, projectFilter))) {
    const writerLease = projectWriterLease(project, dashboard);
    const sourceObjectives = dashboard.objectives.filter((objective) => objective.project_id === project.project_id);
    const projectCurrentObjectiveKey = project.current_objective?.objective_key ?? null;
    const visibleObjectives = sourceObjectives.filter((objective) => {
      if (!includeArchived && isHistoricalWorkspaceObjective(objective, project)) return false;
      if (!includeTestHistory && (isHistoricalTestObjective(objective, projectCurrentObjectiveKey) || isDegradedLegacyObjective(objective))) return false;
      return true;
    });
    const hiddenTestHistoryCount = sourceObjectives.length - visibleObjectives.length;
    const projected = visibleObjectives
      .map((objective) => {
        const item = officeObjective(objective, writerLease, projectCurrentObjectiveKey);
        if (!isHistoricalWorkspaceObjective(objective, project)) return item;
        const archived = {
          ...item,
          zone: "archive" as const,
          zone_reason: "任务属于旧工作区代次且没有存活执行证据，仅保留为历史证据",
          attention: false
        };
        return { ...archived, plain_summary: createOfficePlainSummary(archived) };
      })
      .sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at) || left.stable_key.localeCompare(right.stable_key));
    aggregateProjected.push(...projected);
    const active = projected.filter((objective) => objective.zone !== "archive");
    const archived = projected.filter((objective) => objective.zone === "archive");
    for (const objective of projected) aggregateCounts[objective.zone] += 1;
    aggregateActiveBrowserRuns += projected.filter((objective) => objective.zone === "browser").length;
    if (writerLease.state === "active") aggregateActiveWriters += 1;
    const selected = [...active.slice(0, activeLimit), ...(includeArchived ? archived.slice(0, archiveLimit) : [])];
    const zones = emptyZones();
    const counts = emptyCounts();
    for (const objective of selected) {
      zones[objective.zone].push(objective);
      counts[objective.zone] += 1;
    }
    const projectionConsistencyErrors = OFFICE_ZONES
      .filter((zone) => counts[zone] !== zones[zone].length)
      .map((zone) => `projection_consistency_error:${zone}:${counts[zone]}!=${zones[zone].length}`);
    const currentAttemptIds = new Set(sourceObjectives.map((objective) => objective.current_attempt_id).filter((value): value is string => Boolean(value)));
    const projectTasks = dashboard.tasks.filter((task) => task.project_id === project.project_id || path.resolve(task.workspace_root ?? "") === path.resolve(project.root));
    const observerTasks = projectTasks.filter((task) => task.actor_role === "observer");
    const orphanRuns = projectTasks
      .filter((task) => task.actor_role !== "observer" && !sourceObjectives.some((objective) => objective.attempts.some((attempt) => attempt.attempt_id === task.task_id)))
      .map((task) => task.task_id);
    const projectResources = [...dashboard.resource_governance.leases, ...dashboard.resource_governance.queue]
      .filter((resource) => path.resolve(resource.workspace_root) === path.resolve(project.root));
    const orphanResources = projectResources
      .filter((resource) => !currentAttemptIds.has(resource.task_id))
      .map((resource) => `${"lease_id" in resource ? resource.lease_id : resource.queue_id}:${resource.task_id}`);
    const terminalStateConflictCount = projected.filter((objective) =>
      ["delivered", "cancelled"].includes(objective.objective_status)
      && Boolean(objective.current_attempt && ["running", "validating", "recovering"].includes(objective.current_attempt.status))
    ).length;
    const workspaceGenerationConflictCount = projected.filter((objective) => {
      const attempt = objective.current_attempt;
      if (!attempt || attempt.identity_quality === "degraded" || attempt.legacy_binding) return false;
      const bindingIsExecutionRelevant = ["created", "assigned", "queued", "running", "validating", "recovering", "waiting", "implemented_not_verified"].includes(attempt.status)
        && !["stale", "stopped", "terminal"].includes(attempt.liveness)
        && attemptHasLiveExecutionEvidence(attempt);
      return bindingIsExecutionRelevant && !attemptMatchesProjectAuthority(attempt, project);
    }).length;
    const displayedObjectiveCount = OFFICE_ZONES.reduce((sum, zone) => sum + counts[zone], 0);
    if (displayedObjectiveCount !== selected.length) {
      projectionConsistencyErrors.push(`projection_consistency_error:selected:${displayedObjectiveCount}!=${selected.length}`);
    }
    if (observerTasks.length > 0) projectionConsistencyErrors.push(`projection_consistency_error:observer_contamination:${observerTasks.length}`);
    if (terminalStateConflictCount > 0) projectionConsistencyErrors.push(`projection_consistency_error:terminal_state_conflict:${terminalStateConflictCount}`);
    if (workspaceGenerationConflictCount > 0) projectionConsistencyErrors.push(`projection_consistency_error:workspace_generation_conflict:${workspaceGenerationConflictCount}`);
    const currentProjectedObjective = projected.find((objective) => objective.objective_key === projectCurrentObjectiveKey) ?? active[0] ?? null;
    const currentProjectedAttempt = currentProjectedObjective?.current_attempt ?? null;
    const queueLength = dashboard.resource_governance.queue.filter((item) => item.workspace_root === project.root).length;
    const resourceSummary = {
      writers: writerLease.state === "active" ? 1 : 0,
      readers: selected.filter((objective) => objective.current_attempt?.resource?.execution_mode === "read" && !["terminal", "stopped"].includes(objective.current_attempt.liveness)).length,
      browsers: zones.browser.length,
      validations: zones.validation.length,
      queue_length: queueLength,
      stale_writer_leases: writerLease.stale ? 1 : 0
    };
    const floorStatus: OfficeProjectFloorV1["floor_status"] = counts.incident > 0 || writerLease.stale || projectionConsistencyErrors.length > 0
      ? "incident"
      : (counts.waiting_user > 0 || counts.dispatch > 0 || queueLength > 0 ? "waiting" : (active.length > 0 ? "active" : "idle"));
    projects.push({
      project_id: project.project_id,
      name: cleanText(project.name, 180),
      root: cleanText(project.root, 500),
      canonical_root: cleanText(path.resolve(project.root), 500),
      workspace_id: cleanNullable(project.workspace_id, 200),
      workspace_generation: project.workspace_generation ?? currentProjectedAttempt?.workspace_generation ?? null,
      head_sha: cleanNullable(project.git_finalization?.local_commit_sha, 80),
      current_task_id: currentProjectedAttempt?.task_id ?? project.current_task?.task_id ?? null,
      current_stage: currentProjectedObjective?.stage_key ?? currentProjectedAttempt?.phase ?? null,
      current_owner: currentProjectedAttempt?.actor_id ?? currentProjectedAttempt?.executor?.execution_id ?? null,
      last_activity_at: currentProjectedAttempt?.updated_at ?? currentProjectedObjective?.updated_at ?? null,
      last_progress_at: currentProjectedAttempt?.last_meaningful_progress_at ?? currentProjectedObjective?.last_progress_at ?? null,
      workspace_conflict: workspaceGenerationConflictCount > 0,
      available: project.available,
      unavailable_reason: cleanNullable(project.unavailable_reason, 360),
      branch: cleanText(project.branch, 160),
      git_summary: cleanText(project.git_status_summary.summary, 240),
      watcher_state: cleanText(project.watcher_status.state, 120),
      floor_status: floorStatus,
      resource_summary: resourceSummary,
      writer_lease: writerLease,
      counts,
      zones,
      zone_layouts: officeZoneLayouts(zones),
      objective_count: projected.length,
      archived_count: archived.length,
      hidden_test_history_count: hiddenTestHistoryCount,
      truncated_active_count: Math.max(0, active.length - activeLimit),
      projection_consistency_errors: projectionConsistencyErrors,
      projection_diagnostics: {
        orphan_runs: orphanRuns.slice(0, 50),
        orphan_resources: orphanResources.slice(0, 50),
        observer_contamination_count: observerTasks.length,
        terminal_state_conflict_count: terminalStateConflictCount,
        workspace_generation_conflict_count: workspaceGenerationConflictCount
      }
    });
  }
  const attentionSummary = {
    waiting_user: aggregateCounts.waiting_user,
    incidents: aggregateCounts.incident,
    recovering: aggregateCounts.recovering,
    queued: aggregateCounts.dispatch,
    validating: aggregateCounts.validation,
    delivery: aggregateCounts.delivery,
    active_writers: aggregateActiveWriters,
    active_browser_runs: aggregateActiveBrowserRuns,
    total_objectives: projects.reduce((sum, project) => sum + project.objective_count, 0)
  };
  const filters = {
    project: projectFilter,
    include_archived: includeArchived,
    include_test_history: includeTestHistory,
    archive_limit: archiveLimit,
    active_limit_per_project: activeLimit
  };
  const generatedAt = new Date().toISOString();
  const allProjected = aggregateProjected;
  const today = generatedAt.slice(0, 10);
  const activityFeed = canonicalActivityFeed(allProjected, today);
  const consistencyViolations = projects.flatMap((project) => project.projection_consistency_errors.map((violation) => `${project.project_id}:${violation}`));
  const objectiveSummary = {
    current: allProjected.filter((objective) => objective.zone !== "archive").length,
    executing: allProjected.filter((objective) => objective.zone === "development"
      || objective.zone === "browser"
      || (objective.zone === "validation" && Boolean(objective.current_attempt?.validation_active
        || objective.current_attempt?.status === "validating"
        || objective.current_attempt?.liveness === "working"))).length,
    waiting_user: aggregateCounts.waiting_user,
    recovering: aggregateCounts.recovering,
    unresolved_incidents: aggregateCounts.incident + consistencyViolations.length,
    completed_today: allProjected.filter((objective) => objective.zone === "archive" && objective.objective_status === "delivered" && objective.updated_at.startsWith(today)).length,
    pending_delivery: aggregateCounts.delivery
  };
  const projectRuntimeActivity = dashboard.projects
    .filter((project) => projectMatches(project, projectFilter))
    .map((project) => project.runtime_activity)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const lastAuthoritativeEventAt = [
    ...dashboard.objectives.map((objective) => objective.updated_at),
    ...projectRuntimeActivity
      .map((activity) => activity.last_authoritative_event_at)
      .filter((value): value is string => Boolean(value))
  ]
    .filter(Boolean)
    .sort((left, right) => timestamp(right) - timestamp(left))[0] ?? null;
  const projectionLagMs = lastAuthoritativeEventAt ? Math.max(0, Date.parse(generatedAt) - Date.parse(lastAuthoritativeEventAt)) : 0;
  const synchronization = {
    office_projection_lag_ms: projectionLagMs,
    last_authoritative_event_at: lastAuthoritativeEventAt,
    snapshot_generated_at: generatedAt,
    event_sequence: projectRuntimeActivity.length
      ? projectRuntimeActivity.reduce((sum, activity) => sum + activity.event_sequence, 0)
      : null,
    event_gap_count: projectRuntimeActivity.reduce((sum, activity) => sum + activity.event_gap_count, 0),
    orphan_run_count: projects.reduce((sum, project) => sum + project.projection_diagnostics.orphan_runs.length, 0),
    orphan_resource_count: projects.reduce((sum, project) => sum + project.projection_diagnostics.orphan_resources.length, 0),
    observer_contamination_count: projects.reduce((sum, project) => sum + project.projection_diagnostics.observer_contamination_count, 0),
    terminal_state_conflict_count: projects.reduce((sum, project) => sum + project.projection_diagnostics.terminal_state_conflict_count, 0),
    workspace_generation_conflict_count: projects.reduce((sum, project) => sum + project.projection_diagnostics.workspace_generation_conflict_count, 0)
  };
  const consistency = { ok: consistencyViolations.length === 0, checked_at: generatedAt, violations: consistencyViolations };
  const revision = revisionFor({ filters, attention_summary: attentionSummary, objective_summary: objectiveSummary, synchronization, activity_feed: activityFeed, consistency, projects });
  return {
    version: 1,
    generated_at: generatedAt,
    revision,
    projection_id: revision,
    source: "project_aggregation_read_only",
    filters,
    attention_summary: attentionSummary,
    objective_summary: objectiveSummary,
    synchronization,
    activity_feed: activityFeed,
    projects,
    consistency,
    graph_policy: { node_limit_per_objective: 50, edge_limit_per_objective: 100, missing_parent_policy: "omit_unproven_edges" }
  };
}
