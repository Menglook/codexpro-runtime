import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { isSubpath, PathGuard, type Workspace } from "../guard.js";
import { readHandoffStatus, type HandoffStatusResult } from "../handoffStatus.js";
import { readUsageSummary, summarizeUsageEntries } from "../observability/usageLedger.js";
import type { UsageLedgerSummaryV1 } from "../observability/usageTypes.js";
import {
  assessRuntimeNoProgress,
  isRuntimeActivityState,
  runtimeActivityLabel,
  type RuntimeActivityState,
  type RuntimeNoProgressLevel,
  type RuntimeUserActionRequiredV1
} from "../runtime/activityEvents.js";
import { runProcess } from "../runtime/processWrapper.js";
import { ResourceGovernor, type ResourceGovernorStatus, type ResourceProjection } from "../resources/resourceGovernor.js";
import { chooseCurrentObjective, type ObjectiveProjectionV1 } from "../tasks/objectiveProjectionService.js";
import { ProjectionSnapshotProvider } from "../tasks/projectionSnapshot.js";
import { TaskReportEventStore } from "../tasks/taskReportEventStore.js";
import type { TaskReportSummaryV1 } from "../tasks/taskReportTypes.js";
import { TaskProjectionService } from "../tasks/taskProjectionService.js";
import { currentTaskSelectionScore, selectMostCurrentTask } from "../tasks/taskCurrentness.js";
import { readLatestGitFinalizationRecord, type GitFinalizationRecord } from "../workflow/gitFinalizationState.js";
import { latestWorkspaceAuthorityForRoot } from "../workspaces/workspaceAuthority.js";
import type { TaskExecutionGraphEvidenceV1, TaskProjectionListObservability, TaskRecoveryPlan, TaskStatusProjection, UnifiedTaskStatus } from "../tasks/types.js";

const MB = 1024 * 1024;
const STACK_STATE_MAX_BYTES = 2 * MB;
const MAX_TASKS_PER_PROJECT = 250;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DASHBOARD_RECOVERY_BATCH_SIZE = 8;
const OFFICE_RECOVERY_LIMIT = 12;
const OFFICE_ACTIVE_OBJECTIVE_SOURCE_LIMIT = 50;
const OFFICE_ARCHIVE_OBJECTIVE_SOURCE_LIMIT = 10;
const DASHBOARD_DEFAULT_PROJECT_NAMES = ["codexpro-gpt", "example-project-a", "example-project-b"];
const DASHBOARD_PROJECT_MARKERS = [
  ".git",
  ".codexpro/project.yml",
  "package.json",
  "pyproject.toml",
  "composer.json",
  "Cargo.toml",
  "go.mod"
];

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export const DASHBOARD_ARTIFACT_ROOTS = [
  ".ai-bridge/acceptance-reports",
  ".ai-bridge/browser-reports",
  ".ai-bridge/release-reports",
  ".ai-bridge/task-snapshots",
  ".ai-bridge/console-actions",
  ".codexpro/final-acceptance",
  ".codexpro/memory",
  ".codexpro/project-map.md"
];

export const DASHBOARD_ARTIFACT_EXTENSIONS = new Set([".md", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".html"]);

type JsonRecord = Record<string, unknown>;

interface StackState {
  server_root?: string;
  server?: { pid?: number; port?: number; log?: string };
  watchers?: Array<{ root?: string; pid?: number; log?: string }>;
}

interface DashboardProjectCandidate {
  root: string;
  source: string;
}

export interface DashboardSafeToClose {
  safe: boolean;
  reason: string;
  stable_task_identity: boolean;
  authority_recognized: boolean;
  authority: "goal_store" | "durable_job_store" | "handoff_status" | null;
}

export interface DashboardActivity {
  active: boolean;
  summary: string;
}

export interface DashboardTaskExecutionObservability {
  run_id: string | null;
  owner_source: string | null;
  owner_pid: number | null;
  managed_pid: number | null;
  fencing_token: number | null;
  current_step_id: string | null;
  current_phase: string | null;
  waiting_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  execution_timeout_ms: number | null;
  last_output_at: string | null;
  last_liveness_at: string | null;
  last_progress_at: string | null;
  progress_fingerprint: string | null;
  step_deadline: string | null;
  no_progress_deadline: string | null;
  hard_deadline: string | null;
  termination_reason: string | null;
  heartbeat_write_failures: number | null;
  queue_duration_ms: number | null;
  time_to_first_progress_ms: number | null;
  no_progress_duration_ms: number | null;
  acceptance_duration_ms: number | null;
  recovery_count: number | null;
  owner_change_count: number | null;
  manual_intervention_count: number | null;
  timeout_reason: string | null;
  termination_signal: string | null;
  recovery_from_run_id: string | null;
  resume_count: number | null;
  latest_error: string | null;
  cancelling: boolean;
  recovering: boolean;
  owner_alive: boolean | null;
  watcher_alive: boolean | null;
}

export type DashboardTaskActionName = "resume" | "cancel" | "retry_step";

export interface DashboardTaskAvailableAction {
  action: DashboardTaskActionName;
  label: string;
  expected_status: UnifiedTaskStatus;
  step_id: string | null;
  recovery_action: TaskRecoveryPlan["action"] | "cancel";
  recovery_mode: TaskRecoveryPlan["mode"] | "none";
  side_effect_level: TaskRecoveryPlan["side_effect_level"] | "unknown";
  retry_policy: TaskRecoveryPlan["retry_policy"] | "never";
  confirmation_mode: "none" | "simple" | "prompt";
  requires_confirmation: boolean;
  prompt_required: boolean;
  action_nonce_required: boolean;
  automatic: boolean;
  recovery_scope: "task" | "step";
  reason: string;
  required_checks: string[];
}

export interface DashboardGitFinalizationSummary extends GitFinalizationRecord {
  linked_task_id: string | null;
}

export interface DashboardTaskProjection {
  task_id: string;
  project_id: string;
  project_name: string;
  workspace_id: string;
  workspace_root: string;
  workspace_generation: number | null;
  identity_quality?: "authoritative" | "degraded";
  legacy_binding?: boolean;
  source_conversation_id: string | null;
  actor_id: string | null;
  actor_role: "executor" | "reviewer" | "observer" | "system";
  goal_id: string | null;
  run_id: string | null;
  objective_key: string;
  objective_source: "explicit" | "structured_task" | "legacy_single_attempt";
  stage_key: string | null;
  previous_attempt_id: string | null;
  title: string;
  kind: string;
  status: UnifiedTaskStatus;
  domain_status: string;
  outcome: TaskStatusProjection["outcome"];
  completion_state: TaskStatusProjection["completion_state"] | null;
  executor: TaskStatusProjection["executor"] | null;
  liveness: string;
  liveness_reason: string;
  current_phase: string;
  current_step: number;
  total_steps: number | null;
  progress_summary: string;
  activity_state: RuntimeActivityState;
  activity_label: string;
  safe_progress_summary: string;
  last_meaningful_progress_at: string | null;
  no_progress_level: RuntimeNoProgressLevel;
  no_progress_duration_ms: number | null;
  user_action_required: RuntimeUserActionRequiredV1 | null;
  last_heartbeat: string | null;
  wait_reason: string | null;
  acceptance_status: string;
  acceptance_profile: string;
  changed_files_count: number | null;
  git_finalization: TaskStatusProjection["git_finalization"] | null;
  last_evidence: string | null;
  last_evidence_artifact: DashboardLink | null;
  browser_activity: DashboardActivity;
  writer_activity: DashboardActivity;
  validation_activity: DashboardActivity;
  execution_observability: DashboardTaskExecutionObservability | null;
  execution_components: TaskStatusProjection["execution_components"] | null;
  execution_graph_evidence: TaskExecutionGraphEvidenceV1 | null;
  resource_policy: ResourceProjection | null;
  safe_to_close_chat: DashboardSafeToClose;
  available_actions: DashboardTaskAvailableAction[];
  updated_at: string;
  phase: string;
  current_action: string;
  execution_state: string;
  heartbeat_at: string;
  report_summary: TaskReportSummaryV1 | null;
}

export interface DashboardLink {
  title: string;
  path: string;
  href: string;
  kind: string;
  mtimeMs: number;
}

export interface DashboardGitStatusSummary {
  clean: boolean | null;
  summary: string;
  entries: string[];
  dirty_count: number | null;
  truncated: boolean;
}

export interface DashboardWatcherStatus {
  online: boolean | null;
  state: string;
  reason: string;
  pid: number | null;
  source: string | null;
  handoff_ready?: boolean | null;
  handoff_state?: string;
  handoff_reason?: string;
}

export interface DashboardResourceSummary {
  server_pid: number | null;
  server_alive: boolean | null;
  watcher_pid: number | null;
  watcher_alive: boolean | null;
  active_writers: number;
  active_browser_runs: number;
  active_validation_runs: number;
  heavy_activity: number;
  source: string;
}

export type DashboardCurrentTaskSummary = Pick<DashboardTaskProjection, "task_id" | "title" | "status" | "liveness" | "safe_to_close_chat">;

export interface DashboardObjectiveProjection extends ObjectiveProjectionV1 {
  project_id: string;
  project_name: string;
  current_attempt: DashboardTaskProjection | null;
}

export type DashboardCurrentObjectiveSummary = Pick<DashboardObjectiveProjection, "objective_key" | "title" | "stage_key" | "status" | "reason_code" | "requires_human" | "current_attempt_id">;

export interface DashboardProjectSummary {
  project_id: string;
  name: string;
  root: string;
  available: boolean;
  unavailable_reason: string | null;
  source: string;
  workspace_id: string | null;
  workspace_generation: number | null;
  branch: string;
  git_status_summary: DashboardGitStatusSummary;
  git_finalization: DashboardGitFinalizationSummary | null;
  watcher_status: DashboardWatcherStatus;
  current_objective: DashboardCurrentObjectiveSummary | null;
  current_active_task: DashboardCurrentTaskSummary | null;
  current_task: DashboardCurrentTaskSummary | null;
  active_write_tasks: number;
  queued_tasks: number;
  attention_tasks: number;
  recent_acceptance: DashboardLink | null;
  recent_browser_report: DashboardLink | null;
  recent_screenshots: DashboardLink[];
  last_completed_at: string | null;
  resource_summary: DashboardResourceSummary;
  usage_summary: UsageLedgerSummaryV1;
  objective_count: number;
  task_count: number;
  runtime_activity?: {
    event_sequence: number;
    event_count: number;
    event_gap_count: number;
    last_authoritative_event_at: string | null;
  };
}

export interface DashboardPagination {
  page: number;
  page_size: number;
  total_tasks: number;
  total_pages: number;
  has_next: boolean;
  has_previous: boolean;
  max_page_size: number;
  scanned_task_limit_per_project: number;
}

export interface DashboardOverview {
  running: number;
  queued: number;
  attention: number;
  recovery_required: number;
  failed: number;
  completed: number;
  heavy_activity: number;
  status_counts: Record<string, number>;
}

export interface DashboardProjectionObservability {
  version: 1;
  generated_at: string;
  source: "project_aggregation";
  profile: "full" | "office";
  project_count: number;
  available_project_count: number;
  requested_page_size: number;
  bounded_page_size: number;
  max_page_size: number;
  scanned_task_limit_per_project: number;
  bounded: boolean;
  duration_ms: number;
  durations_ms: {
    resource_governance: number;
    projects: number;
    sort_filter_paginate: number;
  };
  invocation_counts: {
    resource_governance_status: number;
    project_discovery: number;
    task_projection: number;
    projection_snapshot_hit: number;
    projection_snapshot_miss: number;
    recovery_lookup: number;
    recovery_skipped: number;
    recovery_deferred: number;
    office_source_tasks?: number;
    office_selected_tasks?: number;
    office_deferred_tasks?: number;
    office_source_objectives?: number;
    office_selected_objectives?: number;
    office_deferred_objectives?: number;
    artifact_scan: number;
    git_status: number;
    watcher_status: number;
    usage_summary: number;
    git_finalization_read: number;
  };
  task_projection_observability: TaskProjectionListObservability[];
}

export interface DashboardRequestOptions {
  projectionSnapshotProvider?: ProjectionSnapshotProvider;
  profile?: "full" | "office";
}

export interface DashboardResponse {
  ok: true;
  generated_at: string;
  workspace: string;
  current_objective: DashboardObjectiveProjection | null;
  objectives: DashboardObjectiveProjection[];
  current_active_task: DashboardTaskProjection | null;
  recent_completed_tasks: DashboardTaskProjection[];
  attention_required_tasks: DashboardTaskProjection[];
  current_task_id: string | null;
  counts: Record<string, number>;
  filtered_counts: Record<string, number>;
  overview: DashboardOverview;
  resource_governance: ResourceGovernorStatus;
  projects: DashboardProjectSummary[];
  tasks: DashboardTaskProjection[];
  pagination: DashboardPagination;
  projection_observability: DashboardProjectionObservability;
  filters: {
    project: string | null;
    status: string | null;
  };
}

function readJsonSafe(filePath: string, maxBytes = STACK_STATE_MAX_BYTES): unknown {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function readStackState(): { path: string; state: StackState | null } {
  const statePath = process.env.CODEXPRO_STACK_STATE_PATH?.trim()
    ? path.resolve(process.env.CODEXPRO_STACK_STATE_PATH)
    : process.env.CODEXPRO_STACK_STATE_DIR?.trim()
      ? path.join(path.resolve(process.env.CODEXPRO_STACK_STATE_DIR), "state.json")
      : path.join(os.homedir(), ".codexpro", "stack", "state.json");
  const parsed = record(readJsonSafe(statePath));
  if (!parsed) return { path: statePath, state: null };
  const watchers = Array.isArray(parsed.watchers)
    ? parsed.watchers
        .map((item) => record(item))
        .filter((item): item is JsonRecord => Boolean(item))
        .map((item) => ({
          root: typeof item.root === "string" ? item.root : undefined,
          pid: typeof item.pid === "number" ? item.pid : undefined,
          log: typeof item.log === "string" ? item.log : undefined
        }))
    : undefined;
  return {
    path: statePath,
    state: {
      server_root: typeof parsed.server_root === "string" ? parsed.server_root : undefined,
      server: record(parsed.server)
        ? {
            pid: typeof record(parsed.server)?.pid === "number" ? record(parsed.server)?.pid as number : undefined,
            port: typeof record(parsed.server)?.port === "number" ? record(parsed.server)?.port as number : undefined,
            log: typeof record(parsed.server)?.log === "string" ? record(parsed.server)?.log as string : undefined
          }
        : undefined,
      watchers
    }
  };
}

function splitConfiguredRoots(value: string | undefined): string[] {
  if (!value) return [];
  const delimiter = path.delimiter === ";" ? /[;,]/g : /[:,]/g;
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeResolve(input: string): string | null {
  try {
    return path.resolve(input);
  } catch {
    return null;
  }
}

function realDir(input: string): string | null {
  try {
    const resolved = path.resolve(input);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
    return fs.realpathSync(resolved);
  } catch {
    return null;
  }
}

function normalizeRootKey(input: string): string {
  return path.resolve(input).replaceAll("\\", "/").toLowerCase();
}

function uniqueCandidates(candidates: DashboardProjectCandidate[]): DashboardProjectCandidate[] {
  const seen = new Map<string, DashboardProjectCandidate>();
  for (const candidate of candidates) {
    const resolved = safeResolve(candidate.root);
    if (!resolved) continue;
    const key = normalizeRootKey(resolved);
    if (!seen.has(key)) seen.set(key, { root: resolved, source: candidate.source });
  }
  return [...seen.values()];
}

function allowedByConfig(realRoot: string, config: CodexProConfig): boolean {
  return config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
}

function looksLikeProjectRoot(root: string): boolean {
  return DASHBOARD_PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(root, marker)));
}

function hasValidGitMetadataRoot(root: string): boolean {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) {
      return fs.statSync(path.join(dotGit, "HEAD")).isFile();
    }
    if (!stat.isFile()) return false;
    const pointer = fs.readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return false;
    const gitDir = path.resolve(root, pointer.slice("gitdir:".length).trim());
    return fs.statSync(path.join(gitDir, "HEAD")).isFile();
  } catch {
    return false;
  }
}

function isStrictProjectContainer(candidate: DashboardProjectCandidate, candidates: DashboardProjectCandidate[]): boolean {
  if (candidate.source !== "config.defaultRoot") return false;
  const existing = realDir(candidate.root);
  if (!existing || hasValidGitMetadataRoot(existing)) return false;
  return candidates.some((other) => {
    if (other === candidate) return false;
    const child = realDir(other.root);
    return Boolean(
      child
      && normalizeRootKey(child) !== normalizeRootKey(existing)
      && isSubpath(child, existing)
      && looksLikeProjectRoot(child)
    );
  });
}

function projectIdFor(root: string, duplicateBasenames: Set<string>): string {
  const base = (path.basename(root) || "project").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  if (!duplicateBasenames.has(base)) return base;
  return `${base}-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8)}`;
}

function workspaceIdForRoot(root: string): string {
  return `ws_${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}`;
}

function pathParentsForDefaults(config: CodexProConfig, stack: StackState | null): string[] {
  const roots = [
    stack?.server_root,
    path.dirname(config.defaultRoot),
    ...config.allowedRoots
  ].filter((item): item is string => Boolean(item));
  const out: string[] = [];
  for (const root of roots) {
    const resolved = safeResolve(root);
    if (!resolved) continue;
    const base = path.basename(resolved);
    if (DASHBOARD_DEFAULT_PROJECT_NAMES.includes(base)) out.push(resolved);
    for (const name of DASHBOARD_DEFAULT_PROJECT_NAMES) {
      const child = path.join(resolved, name);
      if (fs.existsSync(child)) out.push(child);
    }
  }
  return out;
}

export function discoverDashboardProjects(config: CodexProConfig): DashboardProjectSummary[] {
  const stack = readStackState();
  const configuredControlCenterRoots = splitConfiguredRoots(process.env.CODEXPRO_CONTROL_CENTER_PROJECTS);
  const configuredDashboardRoots = splitConfiguredRoots(process.env.CODEXPRO_DASHBOARD_PROJECTS);
  const configuredRoots = [...configuredControlCenterRoots, ...configuredDashboardRoots];
  const discoveredCandidates = uniqueCandidates([
    { root: config.defaultRoot, source: "config.defaultRoot" },
    ...configuredControlCenterRoots.map((root) => ({ root, source: "CODEXPRO_CONTROL_CENTER_PROJECTS" })),
    ...configuredDashboardRoots.map((root) => ({ root, source: "CODEXPRO_DASHBOARD_PROJECTS" })),
    ...(configuredRoots.length ? [] : (stack.state?.watchers ?? []).map((watcher) => ({ root: watcher.root ?? "", source: "stack.watchers" }))),
    ...(configuredRoots.length ? [] : pathParentsForDefaults(config, stack.state).map((root) => ({ root, source: "derived.default-projects" })))
  ].filter((candidate) => candidate.root));
  const candidates = discoveredCandidates.filter((candidate) => !isStrictProjectContainer(candidate, discoveredCandidates));
  const basenames = candidates.map((candidate) => path.basename(candidate.root) || "project");
  const duplicateBasenames = new Set(basenames.filter((name, index) => basenames.indexOf(name) !== index));
  return candidates.map((candidate) => {
    const existing = realDir(candidate.root);
    const projectId = projectIdFor(existing ?? candidate.root, duplicateBasenames);
    const unavailable = existing
      ? allowedByConfig(existing, config)
        ? null
        : "project root is outside configured allowed roots"
      : "project root is missing or not a directory";
    const workspaceAuthority = existing && unavailable === null ? latestWorkspaceAuthorityForRoot(existing) : null;
    return {
      project_id: projectId,
      name: path.basename(existing ?? candidate.root) || projectId,
      root: existing ?? path.resolve(candidate.root),
      available: unavailable === null,
      unavailable_reason: unavailable,
      source: candidate.source,
      workspace_id: existing && unavailable === null ? (workspaceAuthority?.workspaceId ?? workspaceIdForRoot(existing)) : null,
      workspace_generation: workspaceAuthority?.workspaceGeneration ?? null,
      branch: "unknown",
      git_status_summary: emptyGitSummary(unavailable ?? "not collected"),
      git_finalization: null,
      watcher_status: emptyWatcherStatus(unavailable ?? "not collected"),
      current_objective: null,
      current_active_task: null,
      current_task: null,
      active_write_tasks: 0,
      queued_tasks: 0,
      attention_tasks: 0,
      recent_acceptance: null,
      recent_browser_report: null,
      recent_screenshots: [],
      last_completed_at: null,
      resource_summary: {
        server_pid: stack.state?.server?.pid ?? null,
        server_alive: processAlive(stack.state?.server?.pid ?? null),
        watcher_pid: null,
        watcher_alive: null,
        active_writers: 0,
        active_browser_runs: 0,
        active_validation_runs: 0,
        heavy_activity: 0,
        source: stack.state ? "stack_state" : "local_projection"
      },
      usage_summary: summarizeUsageEntries([]),
      objective_count: 0,
      task_count: 0,
      runtime_activity: existing ? runtimeActivityObservability(existing) : undefined
    };
  });
}

function emptyGitSummary(reason: string): DashboardGitStatusSummary {
  return { clean: null, summary: reason, entries: [], dirty_count: null, truncated: false };
}

function runtimeActivityObservability(projectRoot: string): NonNullable<DashboardProjectSummary["runtime_activity"]> {
  const parsed = readJsonSafe(path.join(projectRoot, ".codexpro", "runtime-activity-events", "sequence.json"), 32_000) as {
    version?: unknown;
    next_sequence?: unknown;
    event_count?: unknown;
    updated_at?: unknown;
  } | undefined;
  const eventSequence = parsed?.version === 1 && Number.isInteger(parsed.next_sequence) && Number(parsed.next_sequence) >= 1
    ? Number(parsed.next_sequence) - 1
    : 0;
  const eventCount = Number.isInteger(parsed?.event_count) && Number(parsed?.event_count) >= 0
    ? Number(parsed?.event_count)
    : eventSequence;
  const updatedAt = typeof parsed?.updated_at === "string" && Number.isFinite(Date.parse(parsed.updated_at))
    ? parsed.updated_at
    : null;
  return {
    event_sequence: eventSequence,
    event_count: eventCount,
    event_gap_count: Math.max(0, eventSequence - eventCount),
    last_authoritative_event_at: updatedAt
  };
}

function emptyWatcherStatus(reason: string): DashboardWatcherStatus {
  return { online: null, state: "unknown", reason, pid: null, source: null };
}

function processAlive(pid: number | null | undefined): boolean | null {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return null;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stackWatcherStatus(stack: StackState | null, projectRoot: string): DashboardWatcherStatus | null {
  const watcher = stack?.watchers?.find((item) => item.root && normalizeRootKey(item.root) === normalizeRootKey(projectRoot));
  if (!watcher) return null;
  const online = processAlive(watcher.pid ?? null);
  return {
    online,
    state: online === true ? "alive" : online === false ? "dead" : "unknown",
    reason: online === true
      ? "Stack watcher process is alive."
      : online === false
        ? "Stack watcher process is not alive."
        : "Stack watcher PID is unavailable.",
    pid: watcher.pid ?? null,
    source: "stack_state"
  };
}

async function readOnlyCommand(root: string, command: string, args: string[], timeoutMs = 1200): Promise<string> {
  try {
    const result = await runProcess(command, args, {
      cwd: root,
      timeoutMs,
      maxOutputBytes: 96_000,
      domain: "probe",
      operation: command,
      lifecycleTracking: false,
      recordTracking: false,
      usageTracking: false,
      sideEffectLevel: "local_read",
      riskLevel: "low"
    });
    const text = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (result.spawnError) return result.stderr || result.errorClass || "spawn failed";
    return text || (typeof result.exitCode === "number" && result.exitCode !== 0 ? `exit ${result.exitCode}` : "");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function gitStatus(root: string): Promise<{ branch: string; summary: DashboardGitStatusSummary }> {
  const rawStatus = await readOnlyCommand(root, "git", ["status", "--short", "--branch"], 1600);
  if (/not a git repository|fatal:/i.test(rawStatus)) {
    return {
      branch: "unknown",
      summary: { clean: null, summary: rawStatus.split(/\r?\n/g)[0]?.slice(0, 160) || "git unavailable", entries: [], dirty_count: null, truncated: false }
    };
  }
  const lines = rawStatus.split(/\r?\n/g).filter(Boolean);
  const branchLine = lines[0]?.startsWith("## ") ? lines.shift()?.slice(3).trim() ?? "" : "";
  const branch = branchLine.split("...")[0]?.split(" [")[0]?.trim() || "unknown";
  if (!lines.length) {
    return {
      branch,
      summary: { clean: true, summary: "clean", entries: ["clean"], dirty_count: 0, truncated: false }
    };
  }
  const entries = lines;
  const visible = entries.slice(0, 12);
  return {
    branch,
    summary: {
      clean: false,
      summary: `${entries.length} changed file${entries.length === 1 ? "" : "s"}`,
      entries: visible,
      dirty_count: entries.length,
      truncated: entries.length > visible.length
    }
  };
}

function toPosixRel(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

export function isAllowedDashboardArtifactPath(relPath: string): boolean {
  const clean = toPosixRel(relPath);
  if (clean.includes("..") || clean.startsWith("/") || path.isAbsolute(clean)) return false;
  const ext = path.extname(clean).toLowerCase();
  if (!DASHBOARD_ARTIFACT_EXTENSIONS.has(ext)) return false;
  return DASHBOARD_ARTIFACT_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`));
}

function artifactHref(projectId: string, relPath: string): string {
  const params = new URLSearchParams();
  params.set("project", projectId);
  params.set("path", toPosixRel(relPath));
  return `/admin/artifact?${params.toString()}`;
}

function titleFromPath(relPath: string): string {
  const clean = toPosixRel(relPath);
  const parts = clean.split("/");
  if (parts.length >= 3) return `${parts.at(-2)} / ${parts.at(-1)}`;
  return parts.at(-1) ?? clean;
}

function linkFor(projectId: string, root: string, relPath: string, kind: string): DashboardLink | null {
  const clean = toPosixRel(relPath);
  if (!isAllowedDashboardArtifactPath(clean)) return null;
  const abs = path.resolve(root, clean);
  if (!isSubpath(abs, root)) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    return { title: titleFromPath(clean), path: clean, href: artifactHref(projectId, clean), kind, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function collectRecentLinks(projectId: string, root: string, baseRel: string, kind: string, names: RegExp, limit = 5): DashboardLink[] {
  const base = path.join(root, baseRel);
  const out: DashboardLink[] = [];
  function visit(absDir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = toPosixRel(path.relative(root, abs));
      if (entry.isDirectory()) {
        visit(abs, depth + 1);
      } else if (entry.isFile() && names.test(entry.name)) {
        const link = linkFor(projectId, root, rel, kind);
        if (link) out.push(link);
      }
    }
  }
  visit(base, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function relEvidencePath(root: string, evidence: string | undefined): string | null {
  if (!evidence?.trim()) return null;
  const value = evidence.trim();
  if (path.isAbsolute(value)) {
    const resolved = path.resolve(value);
    if (!isSubpath(resolved, root)) return null;
    return toPosixRel(path.relative(root, resolved));
  }
  return toPosixRel(value);
}

export function chooseCurrentDashboardTask(tasks: DashboardTaskProjection[]): DashboardTaskProjection | null {
  return selectMostCurrentTask(tasks) ?? null;
}

function mapObjectives(
  source: ObjectiveProjectionV1[],
  tasks: DashboardTaskProjection[],
  project: DashboardProjectSummary
): DashboardObjectiveProjection[] {
  const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
  return source.map((objective) => ({
    ...objective,
    project_id: project.project_id,
    project_name: project.name,
    current_attempt: objective.current_attempt_id ? tasksById.get(objective.current_attempt_id) ?? null : null
  }));
}

function isTerminal(status: UnifiedTaskStatus): boolean {
  return ["completed", "failed", "cancelled", "implemented_not_verified"].includes(status);
}

function isAttentionTask(task: DashboardTaskProjection): boolean {
  return task.status === "waiting"
    || task.status === "interrupted"
    || task.status === "blocked"
    || task.status === "failed"
    || task.status === "implemented_not_verified"
    || task.acceptance_status === "failed";
}

function isRecoveryRequired(task: DashboardTaskProjection): boolean {
  return task.status === "recovering"
    || task.status === "interrupted"
    || task.domain_status === "recovery_required"
    || task.domain_status === "stale";
}

function isValidationActivity(task: TaskStatusProjection): boolean {
  return task.status === "validating"
    || task.acceptance.status === "running"
    || /validat|review/i.test(task.progress.phase)
    || /validat|review/i.test(task.progress.current_action);
}

function clip(value: unknown, max = 360): string {
  return String(value ?? "").replace(/[\u0000\r\n]+/g, " ").trim().slice(0, max);
}

function taskUserActionRequired(task: TaskStatusProjection): RuntimeUserActionRequiredV1 | null {
  if (task.progress.user_action_required?.required === true) return task.progress.user_action_required;
  const status = String(task.domain_status ?? "").toLowerCase();
  if (!["waiting_input", "waiting_approval", "waiting_user", "awaiting_input", "awaiting_approval"].includes(status)) return null;
  const approval = status.includes("approval");
  return {
    version: 1,
    required: true,
    action_type: approval ? "approve" : "provide_input",
    label: approval ? "批准或拒绝" : "补充信息",
    prompt: approval ? "任务明确等待用户批准" : "任务明确等待用户补充信息",
    since: task.progress.last_meaningful_progress_at ?? task.progress.progress_at ?? task.updated_at,
    evidence_ref: task.progress.last_evidence ?? null
  };
}

function taskComponents(task: TaskStatusProjection) {
  if (!task.execution_components) return [];
  return [
    ...Object.values(task.execution_components.model_stream),
    ...Object.values(task.execution_components.tool_processes),
    ...Object.values(task.execution_components.workers)
  ];
}

function taskLastMeaningfulProgressAt(task: TaskStatusProjection): string | null {
  const values = [
    task.progress.last_meaningful_progress_at,
    task.progress.progress_at,
    task.execution?.last_progress_at,
    ...taskComponents(task).map((component) => component.last_meaningful_progress_at ?? component.last_progress_at)
  ].filter((value): value is string => Boolean(value));
  return values.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export function deriveTaskRuntimeActivity(task: TaskStatusProjection, validationActive: boolean): {
  activity_state: RuntimeActivityState;
  activity_label: string;
  safe_summary: string;
  last_meaningful_progress_at: string | null;
  no_progress_level: RuntimeNoProgressLevel;
  no_progress_duration_ms: number | null;
  user_action_required: RuntimeUserActionRequiredV1 | null;
} {
  const userAction = taskUserActionRequired(task);
  const components = taskComponents(task);
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  const currentComponents = terminal
    ? components
    : components.filter((component) => component.state !== "terminal" && component.activity_state !== "terminal");
  const latestComponent = [...currentComponents].sort((left, right) => Date.parse(right.last_meaningful_progress_at ?? right.last_progress_at ?? right.last_transition_at) - Date.parse(left.last_meaningful_progress_at ?? left.last_progress_at ?? left.last_transition_at))[0];
  const lastMeaningful = taskLastMeaningfulProgressAt(task);
  let activityState: RuntimeActivityState = terminal
    ? "terminal"
    : userAction
      ? "waiting_user"
      : task.status === "blocked"
        ? "idle_between_steps"
        : validationActive
          ? "validating"
          : task.progress.writer_active
          ? "tool_writing"
          : isRuntimeActivityState(latestComponent?.activity_state)
            ? latestComponent.activity_state
            : isRuntimeActivityState(task.progress.activity_state)
              ? task.progress.activity_state
              : /analysis|research|inspect|read|search/i.test(task.progress.phase)
                ? "tool_reading"
                : task.progress.execution_state === "waiting" || latestComponent?.state === "idle"
                  ? "idle_between_steps"
                  : task.liveness.state === "stale"
                    ? "stalled"
                    : task.status === "running"
                      ? "idle_between_steps"
                      : "unknown";
  const thresholds = validationActive
    ? { quiet_ms: 120_000, stalled_ms: 600_000, severe_ms: 900_000 }
    : { quiet_ms: 60_000, stalled_ms: 180_000, severe_ms: 300_000 };
  const noProgress = assessRuntimeNoProgress(lastMeaningful, Date.now(), thresholds);
  const eligibleForNoProgress = !terminal && !userAction && ["running", "validating", "recovering", "implemented_not_verified"].includes(task.status);
  if (eligibleForNoProgress && noProgress.level === "quiet" && !task.progress.writer_active && !validationActive) activityState = "idle_between_steps";
  if (eligibleForNoProgress && ["stalled", "severe"].includes(noProgress.level)) activityState = "stalled";
  const safeSummary = clip(
    userAction?.prompt
      ?? latestComponent?.safe_summary
      ?? latestComponent?.progress_marker
      ?? task.progress.safe_progress_summary
      ?? task.progress.current_action
      ?? runtimeActivityLabel(activityState),
    360
  );
  return {
    activity_state: activityState,
    activity_label: runtimeActivityLabel(activityState),
    safe_summary: safeSummary,
    last_meaningful_progress_at: lastMeaningful,
    no_progress_level: noProgress.level,
    no_progress_duration_ms: noProgress.duration_ms,
    user_action_required: userAction
  };
}

export function deriveDashboardSafeToClose(task: TaskStatusProjection): DashboardSafeToClose {
  const authority = task.identity.kind === "goal"
    ? "goal_store"
    : task.identity.kind === "durable_job"
      ? "durable_job_store"
      : task.identity.kind === "handoff"
        ? "handoff_status"
        : null;
  const stableIdentity = Boolean(task.identity.task_id && task.identity.domain_id && task.identity.project_root);
  const authorityRecognized = authority !== null;
  if (!stableIdentity) {
    return {
      safe: false,
      reason: "Task has not formed a stable identity yet; keep the current task entry open.",
      stable_task_identity: false,
      authority_recognized: authorityRecognized,
      authority
    };
  }
  if (!authorityRecognized) {
    return {
      safe: false,
      reason: "Task is not recognized by Goal, Durable Job, or Handoff authority state.",
      stable_task_identity: stableIdentity,
      authority_recognized: false,
      authority
    };
  }
  const confirmedStatuses = new Set<UnifiedTaskStatus>([
    "queued",
    "running",
    "waiting",
    "recovering",
    "validating",
    "interrupted",
    "implemented_not_verified",
    "completed",
    "blocked",
    "failed",
    "cancelled"
  ]);
  if (!confirmedStatuses.has(task.status)) {
    return {
      safe: false,
      reason: `Task status ${task.status} is not yet a durable queued/running/waiting/recovery or terminal state.`,
      stable_task_identity: stableIdentity,
      authority_recognized: authorityRecognized,
      authority
    };
  }
  if (task.status === "blocked") {
    return {
      safe: true,
      reason: "任务已持久记录为被策略或依赖阻止；关闭聊天不会把它误记为执行失败。",
      stable_task_identity: stableIdentity,
      authority_recognized: authorityRecognized,
      authority
    };
  }
  const terminal = ["completed", "failed", "cancelled"].includes(task.status);
  if (terminal) {
    return {
      safe: true,
      reason: "任务已形成终态，不依赖当前聊天页面继续执行。",
      stable_task_identity: stableIdentity,
      authority_recognized: authorityRecognized,
      authority
    };
  }
  const managedPid = Number(task.execution?.managed_pid ?? 0);
  const managedProcess = Number.isInteger(managedPid) && managedPid > 0 && task.execution?.owner_alive !== false;
  const handoffWorker = task.identity.kind === "handoff" && task.execution?.watcher_alive === true && task.execution?.owner_alive !== false;
  const providerRun = task.identity.kind === "goal"
    && Boolean(task.executor?.execution_id)
    && task.liveness.lease?.evidence !== "none"
    && task.liveness.owner_alive !== false;
  const durableBackground = task.identity.kind === "durable_job"
    && !task.identity.domain_id.startsWith("direct-")
    && Boolean(task.execution?.owner_pid)
    && task.execution?.owner_alive !== false
    && (task.liveness.lease_active === true || task.liveness.step_active === true);
  if (!managedProcess && !handoffWorker && !providerRun && !durableBackground) {
    return {
      safe: false,
      reason: "后台续行能力未证明；当前没有独立 managed_pid、Agent Run、Handoff Worker 或持久后台执行 Owner。",
      stable_task_identity: stableIdentity,
      authority_recognized: authorityRecognized,
      authority
    };
  }
  return {
    safe: true,
    reason: managedProcess
      ? "存在独立托管执行进程，关闭聊天后任务仍可继续。"
      : handoffWorker
        ? "存在独立 Handoff Worker，关闭聊天后任务仍可继续。"
        : providerRun
          ? "存在独立模型 Agent Run 和权威租约证据，关闭聊天后任务仍可继续。"
          : "存在独立持久后台执行 Owner，关闭聊天后任务仍可继续。",
    stable_task_identity: stableIdentity,
    authority_recognized: authorityRecognized,
    authority
  };
}

function mapTask(
  task: TaskStatusProjection,
  project: DashboardProjectSummary,
  recovery?: TaskRecoveryPlan,
  reportSummary: TaskReportSummaryV1 | null = null
): DashboardTaskProjection {
  const lastEvidence = relEvidencePath(project.root, task.progress.last_evidence);
  const lastEvidenceArtifact = lastEvidence ? linkFor(project.project_id, project.root, lastEvidence, "evidence") : null;
  const validationActive = isValidationActivity(task);
  const runtimeActivity = deriveTaskRuntimeActivity(task, validationActive);
  const heartbeat = task.liveness.heartbeat_at ?? (task.progress.heartbeat_at === "unknown" ? null : task.progress.heartbeat_at);
  const objective = task.identity.objective ?? {
    version: 1 as const,
    objective_key: `legacy:${task.identity.kind}:${task.identity.domain_id}`,
    stage_key: null,
    previous_attempt_id: null,
    source: "legacy_single_attempt" as const
  };
  return {
    task_id: task.identity.task_id,
    project_id: task.identity.workspace_binding?.project_id ?? project.project_id,
    project_name: project.name,
    workspace_id: task.identity.workspace_binding?.workspace_id ?? project.workspace_id ?? workspaceIdForRoot(project.root),
    workspace_root: task.identity.workspace_binding?.workspace_root ?? task.identity.project_root,
    workspace_generation: task.identity.workspace_binding?.workspace_generation ?? null,
    identity_quality: task.identity.identity_quality ?? "authoritative",
    legacy_binding: task.identity.legacy_binding === true,
    source_conversation_id: task.identity.workspace_binding?.source_conversation_id ?? null,
    actor_id: task.identity.actor?.actor_id ?? null,
    actor_role: task.identity.actor?.role ?? "executor",
    goal_id: task.identity.kind === "goal" ? task.identity.domain_id : null,
    run_id: task.identity.kind === "durable_job" ? task.identity.domain_id : task.executor?.execution_id ?? null,
    objective_key: objective.objective_key,
    objective_source: objective.source,
    stage_key: objective.stage_key,
    previous_attempt_id: objective.previous_attempt_id,
    title: task.identity.title,
    kind: task.identity.kind,
    status: task.status,
    domain_status: task.domain_status,
    outcome: task.outcome,
    completion_state: task.completion_state ?? null,
    executor: task.executor ?? null,
    liveness: task.liveness.state,
    liveness_reason: task.liveness.reason,
    current_phase: task.progress.phase,
    current_step: task.progress.current_step,
    total_steps: task.progress.total_steps ?? null,
    progress_summary: runtimeActivity.safe_summary,
    activity_state: runtimeActivity.activity_state,
    activity_label: runtimeActivity.activity_label,
    safe_progress_summary: runtimeActivity.safe_summary,
    last_meaningful_progress_at: runtimeActivity.last_meaningful_progress_at,
    no_progress_level: runtimeActivity.no_progress_level,
    no_progress_duration_ms: runtimeActivity.no_progress_duration_ms,
    user_action_required: runtimeActivity.user_action_required,
    last_heartbeat: heartbeat,
    wait_reason: task.progress.wait_reason ?? null,
    acceptance_status: task.acceptance.status,
    acceptance_profile: task.acceptance.profile,
    changed_files_count: task.changed_files_count ?? null,
    git_finalization: task.git_finalization ?? null,
    last_evidence: lastEvidence,
    last_evidence_artifact: lastEvidenceArtifact,
    browser_activity: {
      active: task.progress.browser_active,
      summary: task.progress.browser_active ? "active" : "idle"
    },
    writer_activity: {
      active: task.progress.writer_active,
      summary: task.progress.writer_active ? "active" : "idle"
    },
    validation_activity: {
      active: validationActive,
      summary: validationActive ? "active" : "idle"
    },
    execution_observability: task.execution
      ? {
          run_id: task.execution.run_id,
          owner_source: task.execution.owner_source,
          owner_pid: task.execution.owner_pid,
          managed_pid: task.execution.managed_pid,
          fencing_token: Number.isFinite(task.execution.fencing_token) ? Number(task.execution.fencing_token) : null,
          current_step_id: task.execution.current_step_id,
          current_phase: task.execution.current_phase,
          waiting_for: task.execution.waiting_for,
          started_at: task.execution.started_at,
          finished_at: task.execution.finished_at,
          duration_ms: task.execution.duration_ms,
          execution_timeout_ms: task.execution.execution_timeout_ms,
          last_output_at: task.execution.last_output_at,
          last_liveness_at: task.execution.last_liveness_at,
          last_progress_at: task.execution.last_progress_at,
          progress_fingerprint: task.execution.progress_fingerprint,
          step_deadline: task.execution.step_deadline,
          no_progress_deadline: task.execution.no_progress_deadline,
          hard_deadline: task.execution.hard_deadline,
          termination_reason: task.execution.termination_reason,
          heartbeat_write_failures: task.execution.heartbeat_write_failures,
          queue_duration_ms: task.execution.queue_duration_ms,
          time_to_first_progress_ms: task.execution.time_to_first_progress_ms,
          no_progress_duration_ms: task.execution.no_progress_duration_ms,
          acceptance_duration_ms: task.execution.acceptance_duration_ms,
          recovery_count: task.execution.recovery_count,
          owner_change_count: task.execution.owner_change_count,
          manual_intervention_count: task.execution.manual_intervention_count,
          timeout_reason: task.execution.timeout_reason,
          termination_signal: task.execution.termination_signal,
          recovery_from_run_id: task.execution.recovery_from_run_id,
          resume_count: task.execution.resume_count,
          latest_error: task.execution.latest_error,
          cancelling: task.execution.cancelling,
          recovering: task.execution.recovering,
          owner_alive: task.execution.owner_alive,
          watcher_alive: task.execution.watcher_alive
      }
      : null,
    execution_components: task.execution_components ?? null,
    execution_graph_evidence: task.execution_graph_evidence ?? null,
    resource_policy: task.resource_policy ?? null,
    safe_to_close_chat: deriveDashboardSafeToClose(task),
    available_actions: deriveDashboardTaskAvailableActions(task, recovery),
    updated_at: task.updated_at,
    phase: task.progress.phase,
    current_action: task.progress.current_action,
    execution_state: task.progress.execution_state,
    heartbeat_at: task.progress.heartbeat_at,
    report_summary: reportSummary
  };
}

function countsFor(tasks: DashboardTaskProjection[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((result, task) => {
    result[task.status] = (result[task.status] ?? 0) + 1;
    return result;
  }, {});
}

function overviewFor(tasks: DashboardTaskProjection[]): DashboardOverview {
  return {
    running: tasks.filter((task) => task.status === "running" || task.status === "validating").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    attention: tasks.filter(isAttentionTask).length,
    recovery_required: tasks.filter(isRecoveryRequired).length,
    failed: tasks.filter((task) => task.status === "failed").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    heavy_activity: tasks.filter((task) => task.writer_activity.active || task.browser_activity.active || task.validation_activity.active).length,
    status_counts: countsFor(tasks)
  };
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function queryText(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export function matchesProjectFilter(project: DashboardProjectSummary, filter: string | null): boolean {
  if (!filter) return true;
  const normalized = filter.toLowerCase();
  return project.project_id.toLowerCase() === normalized
    || project.name.toLowerCase() === normalized
    || project.root.toLowerCase() === normalized
    || path.basename(project.root).toLowerCase() === normalized;
}

function matchesStatusFilter(task: DashboardTaskProjection, filter: string | null): boolean {
  if (!filter) return true;
  const allowed = new Set(filter.split(",").map((item) => item.trim()).filter(Boolean));
  return allowed.has(task.status) || allowed.has(task.domain_status);
}

export function workspaceForDashboardProject(project: DashboardProjectSummary): Workspace {
  return {
    id: project.workspace_id ?? workspaceIdForRoot(project.root),
    root: project.root,
    openedAt: new Date().toISOString()
  };
}

export function resolveDashboardProject(config: CodexProConfig, projectFilter: string): DashboardProjectSummary | null {
  return discoverDashboardProjects(config)
    .filter((project) => project.available)
    .find((project) => matchesProjectFilter(project, projectFilter)) ?? null;
}

function terminalTaskStatus(status: UnifiedTaskStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "implemented_not_verified";
}

function retryStepAllowed(recovery: TaskRecoveryPlan): boolean {
  return recovery.action === "retry_run_task_step"
    && recovery.resumable
    && recovery.idempotent === true
    && recovery.retryable === true
    && recovery.retry_policy !== "never"
    && recovery.side_effect_level !== "external_write"
    && recovery.side_effect_level !== "unknown"
    && Boolean(recovery.current_step_id ?? recovery.next_step_id);
}

export function deriveDashboardTaskAvailableActions(
  task: TaskStatusProjection,
  recovery?: TaskRecoveryPlan
): DashboardTaskAvailableAction[] {
  const actions: DashboardTaskAvailableAction[] = [];
  if (!terminalTaskStatus(task.status) && (task.identity.kind === "goal" || task.identity.kind === "durable_job")) {
    actions.push({
      action: "cancel",
      label: "Cancel",
      expected_status: task.status,
      step_id: null,
      recovery_action: "cancel",
      recovery_mode: recovery?.mode ?? "none",
      side_effect_level: recovery?.side_effect_level ?? "unknown",
      retry_policy: recovery?.retry_policy ?? "never",
      confirmation_mode: "simple",
      requires_confirmation: true,
      prompt_required: false,
      action_nonce_required: true,
      automatic: false,
      recovery_scope: "task",
      reason: "Cancel through the authoritative Goal or Durable Job manager.",
      required_checks: ["Confirm this is the intended Goal or Durable Job. Handoff cancellation is not exposed."]
    });
  }
  if (!recovery) return actions;
  if (
    recovery.resumable
    && (recovery.mode === "automatic" || recovery.mode === "manual")
    && (recovery.action === "goal_resume" || recovery.action === "resume_run_task")
    && recovery.kind !== "handoff"
  ) {
    const automatic = recovery.automatic === true || recovery.mode === "automatic";
    const promptRequired = !automatic && recovery.action === "goal_resume" && task.identity.kind === "goal";
    const confirmationMode: DashboardTaskAvailableAction["confirmation_mode"] = automatic
      ? "none"
      : promptRequired
        ? "prompt"
        : "simple";
    actions.push({
      action: "resume",
      label: "Resume",
      expected_status: task.status,
      step_id: null,
      recovery_action: recovery.action,
      recovery_mode: recovery.mode,
      side_effect_level: recovery.side_effect_level,
      retry_policy: recovery.retry_policy,
      confirmation_mode: confirmationMode,
      requires_confirmation: confirmationMode !== "none",
      prompt_required: promptRequired,
      action_nonce_required: confirmationMode !== "none",
      automatic,
      recovery_scope: "task",
      reason: recovery.reason,
      required_checks: [...recovery.required_checks]
    });
  }
  if (retryStepAllowed(recovery)) {
    const automatic = recovery.automatic === true || recovery.mode === "automatic";
    actions.push({
      action: "retry_step",
      label: "Retry step",
      expected_status: task.status,
      step_id: recovery.current_step_id ?? recovery.next_step_id,
      recovery_action: recovery.action,
      recovery_mode: recovery.mode,
      side_effect_level: recovery.side_effect_level,
      retry_policy: recovery.retry_policy,
      confirmation_mode: automatic ? "none" : "simple",
      requires_confirmation: !automatic,
      prompt_required: false,
      action_nonce_required: !automatic,
      automatic,
      recovery_scope: "step",
      reason: recovery.reason,
      required_checks: [...recovery.required_checks]
    });
  }
  return actions;
}

export interface DashboardRecoverySelectionOptions {
  current_attempt_ids?: ReadonlySet<string>;
}

export function dashboardNeedsRecoveryProjection(
  task: TaskStatusProjection,
  options: DashboardRecoverySelectionOptions = {}
): boolean {
  if (task.identity.kind === "handoff") return false;
  if (options.current_attempt_ids && !options.current_attempt_ids.has(task.identity.task_id)) return false;
  if (task.status === "completed" || task.status === "cancelled" || task.status === "implemented_not_verified") return false;
  if (task.liveness.state === "stale") return true;
  if (task.domain_status === "recovery_required" || task.domain_status === "stale") return true;
  if (task.execution?.recovering) return true;
  return task.status === "running"
    || task.status === "validating"
    || task.status === "waiting"
    || task.status === "recovering"
    || task.status === "interrupted"
    || task.status === "blocked"
    || task.status === "failed"
    || task.domain_status === "waiting_input"
    || task.domain_status === "waiting_approval";
}

export interface OfficeDashboardSourceScope {
  tasks: TaskStatusProjection[];
  objectives: ObjectiveProjectionV1[];
  source_task_count: number;
  deferred_task_count: number;
  source_objective_count: number;
  deferred_objective_count: number;
}

function officeObjectiveIsArchived(
  objective: ObjectiveProjectionV1,
  taskById: Map<string, TaskStatusProjection>,
  projectCurrentObjectiveKey: string | null
): boolean {
  const attempt = objective.current_attempt_id ? taskById.get(objective.current_attempt_id) : undefined;
  if (!attempt) return true;
  const unresolvedFailure = attempt.outcome.execution_status === "failed"
    || attempt.outcome.validation_status === "failed"
    || attempt.acceptance.status === "failed";
  const taskTerminal = ["completed", "failed", "cancelled"].includes(attempt.status);
  const objectiveTerminal = ["delivered", "incomplete", "cancelled"].includes(objective.status);
  if (unresolvedFailure) return false;
  if (objective.status === "delivered" || objective.status === "cancelled") return true;
  if (objective.source === "legacy_single_attempt" && attempt.identity.kind === "handoff" && taskTerminal) return true;
  if (
    objective.source === "legacy_single_attempt"
    && objective.objective_key !== projectCurrentObjectiveKey
    && (taskTerminal || objectiveTerminal || ["stopped", "stale"].includes(attempt.liveness.state))
  ) return true;
  return false;
}

export function dashboardActionableAttemptIds(
  tasks: TaskStatusProjection[],
  objectives: ObjectiveProjectionV1[]
): Set<string> {
  const taskById = new Map(tasks.map((task) => [task.identity.task_id, task]));
  const projectCurrentObjectiveKey = chooseCurrentObjective(objectives)?.objective_key ?? null;
  return new Set(objectives
    .filter((objective) => !officeObjectiveIsArchived(objective, taskById, projectCurrentObjectiveKey))
    .map((objective) => objective.current_attempt_id)
    .filter((value): value is string => Boolean(value)));
}

export function selectOfficeDashboardSourceScope(
  tasks: TaskStatusProjection[],
  objectives: ObjectiveProjectionV1[],
  activeLimit = OFFICE_ACTIVE_OBJECTIVE_SOURCE_LIMIT,
  archiveLimit = OFFICE_ARCHIVE_OBJECTIVE_SOURCE_LIMIT
): OfficeDashboardSourceScope {
  const taskById = new Map(tasks.map((task) => [task.identity.task_id, task]));
  const projectCurrentObjectiveKey = chooseCurrentObjective(objectives)?.objective_key ?? null;
  const sortedObjectives = [...objectives].sort((left, right) =>
    Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.objective_key.localeCompare(right.objective_key));
  const active = sortedObjectives.filter((objective) => !officeObjectiveIsArchived(objective, taskById, projectCurrentObjectiveKey));
  const archived = sortedObjectives.filter((objective) => officeObjectiveIsArchived(objective, taskById, projectCurrentObjectiveKey));
  const selectedObjectives = [
    ...active.slice(0, Math.max(1, activeLimit)),
    ...archived.slice(0, Math.max(1, archiveLimit))
  ];
  const selectedTaskIds = new Set(selectedObjectives
    .map((objective) => objective.current_attempt_id)
    .filter((value): value is string => Boolean(value)));
  const selectedTasks = tasks.filter((task) => selectedTaskIds.has(task.identity.task_id));
  return {
    tasks: selectedTasks,
    objectives: selectedObjectives,
    source_task_count: tasks.length,
    deferred_task_count: Math.max(0, tasks.length - selectedTasks.length),
    source_objective_count: objectives.length,
    deferred_objective_count: Math.max(0, objectives.length - selectedObjectives.length)
  };
}

async function watcherStatus(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  stack: StackState | null,
  preloadedStatus?: Promise<HandoffStatusResult>
): Promise<DashboardWatcherStatus> {
  let handoff: DashboardWatcherStatus;
  try {
    const status = await (preloadedStatus ?? readHandoffStatus(config, guard, workspace));
    handoff = {
      online: status.watcher_online,
      state: status.watcher_state,
      reason: status.watcher_reason,
      pid: status.watcher_pid ?? null,
      source: status.watcher_source ?? null
    };
  } catch (error) {
    handoff = {
      online: null,
      state: "unknown",
      reason: error instanceof Error ? error.message : String(error),
      pid: null,
      source: null
    };
  }
  const processStatus = stackWatcherStatus(stack, workspace.root);
  return {
    ...(processStatus ?? handoff),
    handoff_ready: handoff.online,
    handoff_state: handoff.state,
    handoff_reason: handoff.reason
  };
}

function taskHasLiveExecutionEvidence(task: DashboardTaskProjection): boolean {
  if (["stale", "stopped", "terminal"].includes(task.liveness)) return false;
  return task.execution_observability?.owner_alive === true
    || task.writer_activity.active
    || task.browser_activity.active
    || task.validation_activity.active
    || ["admitted", "running"].includes(task.resource_policy?.status ?? "")
    || Boolean(task.resource_policy?.queue_id && task.resource_policy?.status === "queued_by_resource_policy");
}

function taskMatchesProjectAuthority(task: DashboardTaskProjection, project: DashboardProjectSummary): boolean {
  if (!project.workspace_id || task.workspace_id !== project.workspace_id) return false;
  if (path.resolve(task.workspace_root) !== path.resolve(project.root)) return false;
  return project.workspace_generation === null
    ? task.workspace_generation !== null
    : task.workspace_generation === project.workspace_generation;
}

function taskCanRepresentCurrentProject(task: DashboardTaskProjection, project: DashboardProjectSummary): boolean {
  if (["completed", "failed", "cancelled"].includes(task.status) || ["stopped", "terminal"].includes(task.liveness)) return false;
  return taskMatchesProjectAuthority(task, project) || taskHasLiveExecutionEvidence(task);
}

function finalizeProject(
  project: DashboardProjectSummary,
  tasks: DashboardTaskProjection[],
  objectives: DashboardObjectiveProjection[],
  watcher: DashboardWatcherStatus,
  usage: UsageLedgerSummaryV1,
  stack: StackState | null
): DashboardProjectSummary {
  const currentObjective = chooseCurrentObjective(objectives.filter((objective) =>
    Boolean(objective.current_attempt && taskCanRepresentCurrentProject(objective.current_attempt, project))));
  const objectiveAttempt = currentObjective?.current_attempt ?? null;
  const current = objectiveAttempt && !["completed", "failed", "cancelled"].includes(objectiveAttempt.status) && currentTaskSelectionScore(objectiveAttempt) > 0
    ? objectiveAttempt
    : chooseCurrentDashboardTask(tasks.filter((task) => taskCanRepresentCurrentProject(task, project)));
  const activeWriters = tasks.filter((task) => task.writer_activity.active).length;
  const activeBrowser = tasks.filter((task) => task.browser_activity.active).length;
  const activeValidation = tasks.filter((task) => task.validation_activity.active).length;
  const completed = tasks
    .filter((task) => isTerminal(task.status))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];
  const currentSummary: DashboardCurrentTaskSummary | null = current
    ? {
        task_id: current.task_id,
        title: current.title,
        status: current.status,
        liveness: current.liveness,
        safe_to_close_chat: current.safe_to_close_chat
      }
    : null;
  const currentObjectiveSummary: DashboardCurrentObjectiveSummary | null = currentObjective
    ? {
        objective_key: currentObjective.objective_key,
        title: currentObjective.title,
        stage_key: currentObjective.stage_key,
        status: currentObjective.status,
        reason_code: currentObjective.reason_code,
        requires_human: currentObjective.requires_human,
        current_attempt_id: currentObjective.current_attempt_id
      }
    : null;
  return {
    ...project,
    watcher_status: watcher,
    current_objective: currentObjectiveSummary,
    current_active_task: currentSummary,
    current_task: currentSummary,
    active_write_tasks: activeWriters,
    queued_tasks: tasks.filter((task) => task.status === "queued").length,
    attention_tasks: tasks.filter(isAttentionTask).length,
    last_completed_at: completed?.updated_at ?? null,
    resource_summary: {
      server_pid: stack?.server?.pid ?? null,
      server_alive: processAlive(stack?.server?.pid ?? null),
      watcher_pid: watcher.pid,
      watcher_alive: watcher.online,
      active_writers: activeWriters,
      active_browser_runs: activeBrowser,
      active_validation_runs: activeValidation,
      heavy_activity: activeWriters + activeBrowser + activeValidation,
      source: stack ? "stack_state_and_task_projection" : "task_projection"
    },
    usage_summary: usage,
    objective_count: objectives.length,
    task_count: tasks.length
  };
}

export function resolveDashboardArtifactRoot(config: CodexProConfig, projectFilter: string | null): DashboardProjectSummary | null {
  const projects = discoverDashboardProjects(config).filter((project) => project.available);
  if (!projectFilter) {
    return projects.find((project) => path.resolve(project.root) === path.resolve(config.defaultRoot)) ?? projects[0] ?? null;
  }
  return projects.find((project) => matchesProjectFilter(project, projectFilter)) ?? null;
}

export class ProjectAggregationService {
  constructor(private readonly config: CodexProConfig) {}

  async dashboard(query: Record<string, unknown>, options: DashboardRequestOptions = {}): Promise<DashboardResponse> {
    const totalStarted = Date.now();
    const profile = options.profile ?? "full";
    const officeProfile = profile === "office";
    const projectionSnapshotProvider = options.projectionSnapshotProvider ?? new ProjectionSnapshotProvider(this.config);
    const invocationCounts = {
      resource_governance_status: 0,
      project_discovery: 0,
      task_projection: 0,
      projection_snapshot_hit: 0,
      projection_snapshot_miss: 0,
      recovery_lookup: 0,
      recovery_skipped: 0,
      recovery_deferred: 0,
      office_source_tasks: 0,
      office_selected_tasks: 0,
      office_deferred_tasks: 0,
      office_source_objectives: 0,
      office_selected_objectives: 0,
      office_deferred_objectives: 0,
      artifact_scan: 0,
      git_status: 0,
      watcher_status: 0,
      usage_summary: 0,
      git_finalization_read: 0
    };
    const stack = readStackState();
    const resourceStarted = Date.now();
    invocationCounts.resource_governance_status += 1;
    let resourceDuration = 0;
    const resourceGovernancePromise = new ResourceGovernor(this.config).status({ readOnly: true }).then((status) => {
      resourceDuration = elapsedSince(resourceStarted);
      return status;
    });
    const page = parsePositiveInt(query.page, 1, 1, 10_000);
    const requestedPageSize = parsePositiveInt(query.page_size, DEFAULT_PAGE_SIZE, 1, 10_000);
    const pageSize = Math.max(1, Math.min(requestedPageSize, MAX_PAGE_SIZE));
    const projectFilter = queryText(query.project);
    const statusFilter = queryText(query.status);
    invocationCounts.project_discovery += 1;
    const discoveredProjects = discoverDashboardProjects(this.config);
    const officeArchiveProjectionLimit = discoveredProjects.length > 1
      ? Math.max(4, Math.ceil(OFFICE_ARCHIVE_OBJECTIVE_SOURCE_LIMIT / discoveredProjects.length))
      : OFFICE_ARCHIVE_OBJECTIVE_SOURCE_LIMIT;
    const allTasks: DashboardTaskProjection[] = [];
    const allObjectives: DashboardObjectiveProjection[] = [];
    const finalizedProjects: DashboardProjectSummary[] = [];
    const taskProjectionObservability: TaskProjectionListObservability[] = [];

    const projectsStarted = Date.now();
    const projectResults = await Promise.all(discoveredProjects.map(async (project) => {
      if (!matchesProjectFilter(project, projectFilter) || !project.available) {
        return {
          project,
          tasks: [] as DashboardTaskProjection[],
          objectives: [] as DashboardObjectiveProjection[],
          task_projection_observability: null as TaskProjectionListObservability | null
        };
      }
      const guard = new PathGuard(this.config);
      const workspace = workspaceForDashboardProject(project);
      try {
        const service = new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
        invocationCounts.watcher_status += 1;
        const handoffStatusPromise = readHandoffStatus(this.config, guard, workspace);
        const watcherPromise = watcherStatus(this.config, guard, workspace, stack.state, handoffStatusPromise);
        invocationCounts.git_status += 1;
        const gitPromise = gitStatus(project.root);
        const resourceGovernance = await resourceGovernancePromise;
        const projectionPromise = projectionSnapshotProvider.get(
          workspace,
          officeProfile
            ? {
                profile: "office",
                office_archive_objective_limit: officeArchiveProjectionLimit,
                resource_status: resourceGovernance,
                handoff_status_promise: handoffStatusPromise
              }
            : { profile: "full", resource_status: resourceGovernance, handoff_status_promise: handoffStatusPromise },
          service
        );
        const [git, projectionRead] = await Promise.all([gitPromise, projectionPromise]);
        invocationCounts.task_projection += projectionRead.cache_hit ? 0 : 1;
        invocationCounts.projection_snapshot_hit += projectionRead.cache_hit ? 1 : 0;
        invocationCounts.projection_snapshot_miss += projectionRead.cache_hit ? 0 : 1;
        const sourceScope = officeProfile
          ? selectOfficeDashboardSourceScope(projectionRead.snapshot.tasks, projectionRead.snapshot.objectives)
          : {
              tasks: projectionRead.snapshot.tasks,
              objectives: projectionRead.snapshot.objectives,
              source_task_count: projectionRead.snapshot.tasks.length,
              deferred_task_count: 0,
              source_objective_count: projectionRead.snapshot.objectives.length,
              deferred_objective_count: 0
            };
        const sourceTasks = sourceScope.tasks;
        const sourceObjectives = sourceScope.objectives;
        if (officeProfile) {
          invocationCounts.office_source_tasks += sourceScope.source_task_count;
          invocationCounts.office_selected_tasks += sourceTasks.length;
          invocationCounts.office_deferred_tasks += sourceScope.deferred_task_count;
          invocationCounts.office_source_objectives += sourceScope.source_objective_count;
          invocationCounts.office_selected_objectives += sourceObjectives.length;
          invocationCounts.office_deferred_objectives += sourceScope.deferred_objective_count;
        }
        const recoveries = new Map<string, TaskRecoveryPlan>();
        const currentAttemptIds = dashboardActionableAttemptIds(sourceTasks, sourceObjectives);
        const allRecoveryCandidates = sourceTasks
          .filter((task) => dashboardNeedsRecoveryProjection(task, { current_attempt_ids: currentAttemptIds }))
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
        const recoveryCandidates = officeProfile
          ? allRecoveryCandidates.slice(0, OFFICE_RECOVERY_LIMIT)
          : allRecoveryCandidates;
        invocationCounts.recovery_skipped += sourceTasks.length - allRecoveryCandidates.length;
        invocationCounts.recovery_deferred += allRecoveryCandidates.length - recoveryCandidates.length;
        const recoveryProjectionPromise = (async () => {
          for (let index = 0; index < recoveryCandidates.length; index += DASHBOARD_RECOVERY_BATCH_SIZE) {
            const batch = await Promise.all(
              recoveryCandidates.slice(index, index + DASHBOARD_RECOVERY_BATCH_SIZE).map(async (task) => {
                invocationCounts.recovery_lookup += 1;
                const recovery = await service.getRecoveryForProjection(task).catch(() => undefined);
                return { task_id: task.identity.task_id, recovery };
              })
            );
            for (const item of batch) {
              if (item.recovery) recoveries.set(item.task_id, item.recovery);
            }
          }
        })();
        const reportStore = new TaskReportEventStore(guard, workspace);
        const reportSummariesPromise = Promise.all(sourceTasks.map(async (task) =>
          await reportStore.readCachedSummary(task.identity.task_id, { maxAgeMs: 4_000 }).catch(() => null)
        ));
        const [, reportSummaries] = await Promise.all([recoveryProjectionPromise, reportSummariesPromise]);
        const mappedTasks = sourceTasks.map((task, index) =>
          mapTask(task, project, recoveries.get(task.identity.task_id), reportSummaries[index] ?? null)
        );
        const mappedObjectives = mapObjectives(sourceObjectives, mappedTasks, project);
        const watcher = await watcherPromise;
        const usage = officeProfile
          ? summarizeUsageEntries([])
          : await (async () => {
              invocationCounts.usage_summary += 1;
              return await readUsageSummary(project.root);
            })();
        const gitFinalizationRecord = officeProfile
          ? null
          : await (async () => {
              invocationCounts.git_finalization_read += 1;
              return await readLatestGitFinalizationRecord(this.config, guard, workspace);
            })();
        const linkedTask = gitFinalizationRecord
          ? mappedTasks.find((task) => task.git_finalization?.updated_at === gitFinalizationRecord.updated_at) ?? null
          : null;
        const gitFinalization: DashboardGitFinalizationSummary | null = gitFinalizationRecord
          ? { ...gitFinalizationRecord, linked_task_id: linkedTask?.task_id ?? null }
          : null;
        if (!officeProfile) invocationCounts.artifact_scan += 3;
        const acceptance = officeProfile ? null : collectRecentLinks(project.project_id, project.root, ".ai-bridge/acceptance-reports", "acceptance", /report\.(?:md|json)$/i, 1)[0] ?? null;
        const browser = officeProfile ? null : collectRecentLinks(project.project_id, project.root, ".ai-bridge/browser-reports", "browser-report", /report\.(?:md|json|html)$/i, 1)[0] ?? null;
        const screenshots = officeProfile ? [] : collectRecentLinks(project.project_id, project.root, ".ai-bridge/browser-reports", "screenshot", /\.(?:png|jpg|jpeg|webp)$/i, 4);
        return {
          project: finalizeProject({
            ...project,
            branch: git.branch,
            git_status_summary: git.summary,
            git_finalization: gitFinalization,
            recent_acceptance: acceptance,
            recent_browser_report: browser,
            recent_screenshots: screenshots
          }, mappedTasks, mappedObjectives, watcher, usage, stack.state),
          tasks: mappedTasks,
          objectives: mappedObjectives,
          task_projection_observability: projectionRead.snapshot.task_projection_observability
        };
      } catch (error) {
        return {
          project: {
            ...project,
            available: false,
            unavailable_reason: error instanceof Error ? error.message : String(error)
          },
          tasks: [] as DashboardTaskProjection[],
          objectives: [] as DashboardObjectiveProjection[],
          task_projection_observability: null as TaskProjectionListObservability | null
        };
      }
    }));
    for (const result of projectResults) {
      finalizedProjects.push(result.project);
      allTasks.push(...result.tasks);
      allObjectives.push(...result.objectives);
      if (result.task_projection_observability) taskProjectionObservability.push(result.task_projection_observability);
    }
    const projectsDuration = elapsedSince(projectsStarted);
    const resourceGovernance = await resourceGovernancePromise;

    const paginateStarted = Date.now();
    const sortedTasks = allTasks.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    const filteredTasks = sortedTasks.filter((task) => matchesStatusFilter(task, statusFilter) && finalizedProjects.some((project) => project.project_id === task.project_id && matchesProjectFilter(project, projectFilter)));
    const start = (page - 1) * pageSize;
    const pageTasks = filteredTasks.slice(start, start + pageSize);
    const currentObjective = chooseCurrentObjective(allObjectives);
    const objectiveAttempt = currentObjective?.current_attempt ?? null;
    const currentActiveTask = objectiveAttempt && !["completed", "failed", "cancelled"].includes(objectiveAttempt.status) && currentTaskSelectionScore(objectiveAttempt) > 0
      ? objectiveAttempt
      : chooseCurrentDashboardTask(sortedTasks);
    const recentCompletedTasks = sortedTasks
      .filter((task) => task.status === "completed" || task.status === "cancelled")
      .slice(0, 10);
    const attentionRequiredTasks = sortedTasks.filter(isAttentionTask).slice(0, 25);
    const totalPages = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
    const paginateDuration = elapsedSince(paginateStarted);
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      workspace: this.config.defaultRoot,
      current_objective: currentObjective,
      objectives: allObjectives,
      current_active_task: currentActiveTask,
      recent_completed_tasks: recentCompletedTasks,
      attention_required_tasks: attentionRequiredTasks,
      current_task_id: currentActiveTask?.task_id ?? null,
      counts: countsFor(sortedTasks),
      filtered_counts: countsFor(filteredTasks),
      overview: overviewFor(sortedTasks),
      resource_governance: resourceGovernance,
      projects: finalizedProjects,
      tasks: pageTasks,
      pagination: {
        page,
        page_size: pageSize,
        total_tasks: filteredTasks.length,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_previous: page > 1,
        max_page_size: MAX_PAGE_SIZE,
        scanned_task_limit_per_project: MAX_TASKS_PER_PROJECT
      },
      projection_observability: {
        version: 1,
        generated_at: new Date().toISOString(),
        source: "project_aggregation",
        profile,
        project_count: discoveredProjects.length,
        available_project_count: discoveredProjects.filter((project) => project.available).length,
        requested_page_size: requestedPageSize,
        bounded_page_size: pageSize,
        max_page_size: MAX_PAGE_SIZE,
        scanned_task_limit_per_project: MAX_TASKS_PER_PROJECT,
        bounded: requestedPageSize !== pageSize || taskProjectionObservability.some((item) => item.bounded),
        duration_ms: elapsedSince(totalStarted),
        durations_ms: {
          resource_governance: resourceDuration,
          projects: projectsDuration,
          sort_filter_paginate: paginateDuration
        },
        invocation_counts: invocationCounts,
        task_projection_observability: taskProjectionObservability
      },
      filters: {
        project: projectFilter,
        status: statusFilter
      }
    };
  }
}
