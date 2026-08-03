import { readWorkspaceLeaseSync } from "../../shared/execution-kernel.mjs";
import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { createWorkspaceExecutionComponentStore, type ExecutionComponentStateFile } from "../execution/componentStore.js";
import { GoalStore, goalOfficeIndexEntry, type GoalOfficeIndexEntry } from "../goals/goalStore.js";
import type { GoalEvent, GoalProviderRunRecord, GoalRecord } from "../goals/types.js";
import type { PathGuard, Workspace } from "../guard.js";
import { readHandoffStatus, type HandoffStatusResult } from "../handoffStatus.js";
import { DurableJobManager } from "../jobs/jobManager.js";
import {
  DurableJobStore,
  durableJobOfficeIndexEntry,
  type DurableJobOfficeIndexEntry
} from "../jobs/jobStore.js";
import type { DurableJobRecord, DurableJobStep, TaskProgress } from "../jobs/jobSteps.js";
import { projectGoalProgress } from "../jobs/progressProjection.js";
import { ResourceGovernor, type ResourceGovernorStatus } from "../resources/resourceGovernor.js";
import { deriveTaskCompletionState, deriveTaskOutcome, mergeTaskOutcomeDelivery } from "../runtime/taskOutcome.js";
import { readLatestGitFinalizationRecord, type GitFinalizationRecord } from "../workflow/gitFinalizationState.js";
import type { LoopState } from "../workflow/loopPolicy.js";
import { selectMostCurrentTask } from "./taskCurrentness.js";
import { TaskIdentityStore, taskIdFor } from "./taskIdentityStore.js";
import {
  taskGraphEvidenceFromDurableJob,
  taskGraphEvidenceFromGoal,
  taskGraphEvidenceFromHandoff
} from "./taskGraphEvidence.js";
import type {
  TaskAcceptanceProjection,
  TaskCompletionProofProjection,
  TaskDomainKind,
  TaskEvidenceProjection,
  TaskIdentity,
  TaskLeaseProjection,
  TaskLiveness,
  TaskObjectiveMetadataV1,
  TaskProjectionListResult,
  TaskRecoveryPlan,
  TaskStatusProjection,
  TaskTimelineEvent,
  UnifiedTaskStatus
} from "./types.js";

const MAX_TASK_PROJECTION_LIMIT = 500;
const OFFICE_ACTIVE_OBJECTIVE_LIMIT = 50;
const OFFICE_ARCHIVE_OBJECTIVE_LIMIT = 10;
const OFFICE_ATTEMPT_LIMIT_PER_OBJECTIVE = 21;
const TASK_PROJECTION_BATCH_SIZE = 32;
const INDEX_FRESHNESS_CACHE_MS = 1_000;
const MAX_TERMINAL_DURABLE_PROJECTION_CACHE_ENTRIES = 1_024;

const terminalDurableProjectionCache = new Map<string, TaskStatusProjection>();

function cacheTerminalDurableProjection(key: string, projection: TaskStatusProjection): void {
  terminalDurableProjectionCache.delete(key);
  terminalDurableProjectionCache.set(key, structuredClone(projection));
  while (terminalDurableProjectionCache.size > MAX_TERMINAL_DURABLE_PROJECTION_CACHE_ENTRIES) {
    const oldest = terminalDurableProjectionCache.keys().next().value;
    if (typeof oldest !== "string") break;
    terminalDurableProjectionCache.delete(oldest);
  }
}

interface IndexFreshnessCacheEntry {
  checked_at: number;
  index_mtime_ms: number;
  root_mtime_ms: number;
  fresh: boolean;
}

const indexFreshnessCache = new Map<string, IndexFreshnessCacheEntry>();

async function projectionIndexFresh(
  guard: PathGuard,
  workspace: Workspace,
  indexRelativePath: string,
  authorityRootRelativePath: string,
  authorityFileName: string
): Promise<boolean> {
  const index = guard.resolve(workspace, indexRelativePath);
  const authorityRoot = guard.resolve(workspace, authorityRootRelativePath);
  const [indexStat, rootStat] = await Promise.all([
    fsp.stat(index.absPath).catch(() => undefined),
    fsp.stat(authorityRoot.absPath).catch(() => undefined)
  ]);
  if (!indexStat || !rootStat) return false;
  const cacheKey = `${index.absPath}\0${authorityRoot.absPath}`;
  const cached = indexFreshnessCache.get(cacheKey);
  const now = Date.now();
  if (
    cached
    && now - cached.checked_at < INDEX_FRESHNESS_CACHE_MS
    && cached.index_mtime_ms === indexStat.mtimeMs
    && cached.root_mtime_ms === rootStat.mtimeMs
  ) return cached.fresh;
  let newestAuthorityMtime = 0;
  try {
    const entries = await fsp.readdir(authorityRoot.absPath, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    for (let offset = 0; offset < directories.length; offset += 128) {
      const stats = await Promise.all(directories.slice(offset, offset + 128).map((entry) =>
        fsp.stat(`${authorityRoot.absPath}/${entry.name}/${authorityFileName}`).catch(() => undefined)
      ));
      for (const stat of stats) newestAuthorityMtime = Math.max(newestAuthorityMtime, stat?.mtimeMs ?? 0);
    }
  } catch {
    return false;
  }
  const fresh = indexStat.mtimeMs >= newestAuthorityMtime;
  indexFreshnessCache.set(cacheKey, {
    checked_at: now,
    index_mtime_ms: indexStat.mtimeMs,
    root_mtime_ms: rootStat.mtimeMs,
    fresh
  });
  return fresh;
}

export interface TaskProjectionListOptions {
  profile?: "full" | "office";
  office_active_objective_limit?: number;
  office_archive_objective_limit?: number;
  resource_status?: ResourceGovernorStatus | null;
  handoff_status_promise?: Promise<HandoffStatusResult>;
}

interface TaskProjectionSelectionCandidate {
  identity: TaskIdentity;
  status: UnifiedTaskStatus;
  recoverable: boolean;
  updated_at: string;
}

function taskObjectiveKey(identity: TaskIdentity): string {
  return identity.objective?.objective_key ?? `legacy:${identity.kind}:${identity.domain_id}`;
}

function taskSelectionPriority(status: UnifiedTaskStatus): number {
  const priority: Record<UnifiedTaskStatus, number> = {
    running: 110,
    validating: 108,
    recovering: 106,
    waiting: 104,
    implemented_not_verified: 102,
    interrupted: 100,
    assigned: 98,
    queued: 96,
    created: 94,
    completed: 80,
    blocked: 70,
    failed: 70,
    cancelled: 10
  };
  return priority[status] ?? 0;
}

function boundedSelectionLimit(value: unknown, fallback: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(numeric)));
}

function compareSelectionCandidates(left: TaskProjectionSelectionCandidate, right: TaskProjectionSelectionCandidate): number {
  return taskSelectionPriority(right.status) - taskSelectionPriority(left.status)
    || Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || left.identity.task_id.localeCompare(right.identity.task_id);
}

function selectOfficeProjectionIdentities(
  candidates: TaskProjectionSelectionCandidate[],
  options: TaskProjectionListOptions
): TaskIdentity[] {
  const activeLimit = boundedSelectionLimit(options.office_active_objective_limit, OFFICE_ACTIVE_OBJECTIVE_LIMIT, OFFICE_ACTIVE_OBJECTIVE_LIMIT);
  const archiveLimit = boundedSelectionLimit(options.office_archive_objective_limit, OFFICE_ARCHIVE_OBJECTIVE_LIMIT, OFFICE_ARCHIVE_OBJECTIVE_LIMIT);
  const groups = new Map<string, TaskProjectionSelectionCandidate[]>();
  for (const candidate of candidates) {
    const key = taskObjectiveKey(candidate.identity);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const objectiveGroups = [...groups.entries()].map(([key, group]) => {
    const explicitlySuperseded = new Set(group
      .map((candidate) => candidate.identity.objective?.previous_attempt_id)
      .filter((value): value is string => Boolean(value)));
    const heads = group.filter((candidate) => !explicitlySuperseded.has(candidate.identity.task_id));
    const current = [...(heads.length ? heads : group)].sort(compareSelectionCandidates)[0];
    const ranked = current
      ? [current, ...group.filter((candidate) => candidate.identity.task_id !== current.identity.task_id).sort(compareSelectionCandidates)]
      : [];
    return { key, ranked, current };
  }).filter((item) => Boolean(item.current));
  const projectCurrent = [...objectiveGroups].sort((left, right) =>
    compareSelectionCandidates(left.current, right.current)
    || left.key.localeCompare(right.key))[0] ?? null;
  const active = objectiveGroups.filter((group) => {
    const current = group.current;
    const source = current.identity.objective?.source ?? "legacy_single_attempt";
    if (current.status === "completed" || current.status === "cancelled") return false;
    if (current.status !== "failed" && current.status !== "blocked") return true;
    if (current.recoverable || source !== "legacy_single_attempt") return true;
    return projectCurrent?.key === group.key;
  }).sort((left, right) => compareSelectionCandidates(left.current, right.current) || left.key.localeCompare(right.key));
  const archived = objectiveGroups.filter((group) => !active.includes(group))
    .sort((left, right) => Date.parse(right.current.updated_at) - Date.parse(left.current.updated_at) || left.key.localeCompare(right.key));
  const selectedGroups = [...active.slice(0, activeLimit), ...archived.slice(0, archiveLimit)];
  const selected = new Map<string, TaskIdentity>();
  for (const group of selectedGroups) {
    for (const candidate of group.ranked.slice(0, OFFICE_ATTEMPT_LIMIT_PER_OBJECTIVE)) {
      selected.set(candidate.identity.task_id, candidate.identity);
    }
  }
  return [...selected.values()];
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

interface DurableJobIdentityInput {
  run_id: string;
  title: string;
  workspace_root: string;
  parent_task_id?: string;
  objective?: TaskObjectiveMetadataV1;
  workspace_binding?: TaskIdentity["workspace_binding"];
  actor?: TaskIdentity["actor"];
  created_at: string;
  updated_at?: string;
}

function uniquePaths(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))];
}

function goalCompletionProof(goal: GoalRecord): TaskCompletionProofProjection {
  const subagentResults = goal.subagent_result?.results ?? [];
  const modelReview = goal.review_result?.reviewer_run_id ? goal.review_result : null;
  const proofPaths = uniquePaths([
    ...subagentResults.map((result) => result.proof_path ?? undefined),
    modelReview?.proof_path ?? undefined
  ]);
  const invalidReasons = [
    ...subagentResults.flatMap((result) => [
      ...(!result.proof_path ? [`subagent:${result.task_id}:proof_missing`] : []),
      ...(result.proof_invalid_reasons ?? []).map((reason) => `subagent:${result.task_id}:${reason}`)
    ]),
    ...(modelReview
      ? [
          ...(!modelReview.proof_path ? ["review:proof_missing"] : []),
          ...(modelReview.proof_invalid_reasons ?? []).map((reason) => `review:${reason}`)
        ]
      : [])
  ];
  const classes = [
    ...subagentResults.map((result) => result.completion_class ?? "invalid"),
    ...(modelReview ? [modelReview.completion_class ?? "invalid"] : [])
  ];
  const source = subagentResults.length && modelReview
    ? "combined"
    : subagentResults.length
      ? "subagents"
      : modelReview
        ? "review"
        : "none";
  if (source === "none") {
    return { status: "missing", verified: false, source, proof_paths: [], invalid_reasons: [] };
  }
  const status = invalidReasons.length || classes.includes("invalid")
    ? "invalid"
    : classes.includes("implemented_not_verified")
      ? "implemented_not_verified"
      : classes.includes("analysis_unverified")
        ? "analysis_unverified"
        : classes.every((item) => item === "verified")
          ? "verified"
          : "missing";
  return {
    status,
    verified: status === "verified",
    source,
    proof_paths: proofPaths,
    invalid_reasons: [...new Set(invalidReasons)]
  };
}

function attachGitFinalization(
  projection: TaskStatusProjection,
  record: GitFinalizationRecord | undefined
): TaskStatusProjection {
  if (!record) return projection;
  const sourceIds = new Set([
    projection.identity.domain_id,
    projection.executor?.execution_id ?? "",
    projection.execution?.run_id ?? ""
  ].filter(Boolean));
  const evidencePaths = new Set([
    ...projection.evidence_paths,
    ...projection.acceptance.evidence_paths
  ]);
  const matchedByRun = Boolean(record.source_run_id && sourceIds.has(record.source_run_id));
  const matchedByEvidence = Boolean(record.acceptance_report_path && evidencePaths.has(record.acceptance_report_path));
  if (!matchedByRun && !matchedByEvidence) return projection;
  return {
    ...projection,
    outcome: mergeTaskOutcomeDelivery(projection.outcome, record.delivery_status, {
      reason_code: record.reason_code,
      updated_at: record.updated_at
    }),
    git_finalization: {
      source_run_id: record.source_run_id,
      acceptance_report_path: record.acceptance_report_path,
      implementation_status: record.implementation_status,
      acceptance_status: record.acceptance_status,
      branch: record.branch,
      changed_files: [...record.changed_files],
      commit_status: record.commit_status,
      push_status: record.push_status,
      delivery_status: record.delivery_status,
      local_commit_sha: record.local_commit_sha,
      remote_commit_sha: record.remote_commit_sha,
      commit_message: record.commit_message,
      push_transport: record.push_transport,
      push_attempts: record.push_attempts,
      push_error_code: record.push_error_code,
      reason_code: record.reason_code,
      reason: record.reason,
      retry_available: record.retry_available,
      last_action: record.last_action,
      updated_at: record.updated_at
    }
  };
}

function attachCompletionState(projection: TaskStatusProjection): TaskStatusProjection {
  const git = projection.git_finalization;
  return {
    ...projection,
    completion_state: deriveTaskCompletionState({
      outcome: projection.outcome,
      git_prepare_status: git ? "completed" : "not_requested",
      git_commit_status: git?.commit_status === "completed" ? "completed" : git?.commit_status === "failed" ? "failed" : "not_requested",
      git_push_status: git?.push_status === "completed" || git?.push_status === "already_synced"
        ? "completed"
        : git?.push_status === "waiting_security_baseline"
          ? "pending"
          : git?.push_status === "failed"
            ? "failed"
            : "not_requested",
      terminal_reason: projection.execution?.termination_reason ?? projection.outcome.primary_reason_code
    })
  };
}

function loopProjection(state: LoopState | undefined): TaskStatusProjection["loop"] | undefined {
  if (!state) return undefined;
  return {
    iteration: state.iteration,
    repair_rounds: state.repair_rounds,
    tool_calls: state.tool_calls,
    full_validation_runs: state.full_validation_runs,
    browser_reconnects: state.browser_reconnects,
    same_failure_repeats: state.same_failure_repeats,
    failure_category: state.last_failure_category,
    last_action: state.last_decision?.action ?? null,
    budget_remaining: { ...state.budget_remaining },
    stop_reason: state.stop_reason
  };
}

function goalAcceptance(goal: GoalRecord): TaskAcceptanceProjection {
  const validation = goal.validation_result;
  const review = goal.review_result;
  const evidencePaths = uniquePaths([
    validation?.report_path,
    ...goal.evidence.map((evidence) => evidence.path)
  ]);
  if (goal.status === "validating" || goal.status === "reviewing") {
    return {
      required: true,
      status: "running",
      profile: validation?.profile ?? "goal_acceptance_contract",
      evidence_paths: evidencePaths,
      reason: goal.status === "reviewing"
        ? "Automatic validation passed far enough to enter independent review; final acceptance is still running."
        : "Goal acceptance validation is running."
    };
  }
  if (validation?.ok && (!review || review.ok) && goal.status === "succeeded") {
    return {
      required: true,
      status: "passed",
      profile: validation.profile,
      evidence_paths: evidencePaths,
      reason: review ? "Validation and independent review passed." : "Blocking acceptance items passed."
    };
  }
  if (validation && !validation.ok) {
    return {
      required: true,
      status: "failed",
      profile: validation.profile,
      evidence_paths: evidencePaths,
      reason: `Goal acceptance profile ended with ${validation.status}.`
    };
  }
  if (review && !review.ok) {
    return {
      required: true,
      status: "failed",
      profile: validation?.profile ?? "goal_review",
      evidence_paths: evidencePaths,
      reason: "Independent Goal review failed."
    };
  }
  if (goal.status === "succeeded") {
    return {
      required: true,
      status: "failed",
      profile: validation?.profile ?? "goal_acceptance_contract",
      evidence_paths: evidencePaths,
      reason: "Invariant violation: Goal is succeeded without passing validation evidence."
    };
  }
  if (goal.status === "failed" || goal.status === "blocked") {
    return {
      required: true,
      status: "failed",
      profile: validation?.profile ?? "goal_acceptance_contract",
      evidence_paths: evidencePaths,
      reason: goal.failure?.message ?? `Goal ended with ${goal.status} before acceptance passed.`
    };
  }
  return {
    required: true,
    status: "pending",
    profile: validation?.profile ?? "goal_acceptance_contract",
    evidence_paths: evidencePaths,
    reason: "Goal has not reached its acceptance phase or is waiting for recovery/input."
  };
}

interface HandoffAcceptanceReceipt {
  version?: unknown;
  task_id?: unknown;
  plan_hash?: unknown;
  run_id?: unknown;
  status?: unknown;
  profile?: unknown;
  accepted_at?: unknown;
  accepted_by?: unknown;
  reason?: unknown;
  evidence_paths?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

async function handoffAcceptance(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  identity: TaskIdentity,
  status: HandoffStatusResult
): Promise<TaskAcceptanceProjection> {
  const receiptPath = `.codexpro/final-acceptance/${identity.task_id}.json`;
  const evidencePaths = uniquePaths([status.run_dir, status.progress.last_evidence]);
  if (status.run_state === "completed") {
    try {
      const resolved = guard.resolve(workspace, receiptPath);
      const stat = await fsp.stat(resolved.absPath);
      if (stat.isFile() && stat.size <= config.maxReadBytes) {
        const receipt = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as HandoffAcceptanceReceipt;
        const acceptedAt = typeof receipt.accepted_at === "string" ? Date.parse(receipt.accepted_at) : Number.NaN;
        const valid = receipt.version === 1
          && receipt.status === "passed"
          && receipt.accepted_by === "owner"
          && receipt.task_id === identity.task_id
          && receipt.plan_hash === identity.domain_id
          && receipt.run_id === status.run_id
          && Number.isFinite(acceptedAt);
        if (valid) {
          return {
            required: true,
            status: "passed",
            profile: typeof receipt.profile === "string" && receipt.profile.trim() ? receipt.profile : "handoff_validation",
            evidence_paths: uniquePaths([...evidencePaths, receiptPath, ...stringArray(receipt.evidence_paths)]),
            reason: typeof receipt.reason === "string" && receipt.reason.trim()
              ? receipt.reason
              : "The owner explicitly accepted the completed Handoff after reviewing validation evidence."
          };
        }
      }
    } catch {
      // Missing or malformed local acceptance receipts leave completed Handoffs pending validation.
    }
    return {
      required: true,
      status: "pending",
      profile: "handoff_validation",
      evidence_paths: evidencePaths,
      reason: "Handoff executor completion is implementation evidence only; required tests, review and browser validation have not been proven by an owner acceptance receipt."
    };
  }
  if (["failed", "timed_out", "cancelled"].includes(status.run_state ?? "")) {
    return {
      required: true,
      status: "failed",
      profile: "handoff_validation",
      evidence_paths: evidencePaths,
      reason: `Handoff execution ended with ${status.run_state}${status.timeout_reason ? ` (${status.timeout_reason})` : ""}; validation cannot pass.`
    };
  }
  return {
    required: true,
    status: "pending",
    profile: "handoff_validation",
    evidence_paths: evidencePaths,
    reason: "Handoff implementation or validation has not completed."
  };
}

function parsedAgeMs(value: string | undefined): number | null {
  if (!value || value === "unknown") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : null;
}

function durationBetween(startedAt: string | undefined | null, endedAt: string | undefined | null = new Date().toISOString()): number | null {
  if (!startedAt || !endedAt || startedAt === "unknown" || endedAt === "unknown") return null;
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

function observedNoProgressDuration(progressAt: string | undefined, terminalAt?: string | null): number | null {
  if (!progressAt || progressAt === "unknown") return null;
  return durationBetween(progressAt, terminalAt ?? new Date().toISOString());
}

function progressLivenessAt(progress: TaskProgress): string | null {
  return progress.liveness_at ?? (progress.heartbeat_at === "unknown" ? null : progress.heartbeat_at);
}

function progressProgressAt(progress: TaskProgress): string | null {
  return progress.progress_at ?? null;
}

function processAlive(pid: number | null): boolean | null {
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function emptyLease(evidence: TaskLeaseProjection["evidence"] = "none"): TaskLeaseProjection {
  return {
    evidence,
    active: null,
    stale: null,
    expired: null,
    holder_pid: null,
    managed_pid: null,
    run_id: null,
    heartbeat_at: null,
    ttl_ms: null
  };
}

function providerRunFor(goal: GoalRecord, executionId: string | null): GoalProviderRunRecord | undefined {
  const record = goal.checkpoint?.provider_run;
  if (!record) return undefined;
  if (executionId && record.run_id !== executionId) return undefined;
  if (record.contract_version !== goal.goal_contract.contract_version) return undefined;
  return record;
}

function providerLease(record: GoalProviderRunRecord): TaskLeaseProjection {
  const age = parsedAgeMs(record.heartbeat_at ?? undefined);
  const expired = age === null ? null : age > record.heartbeat_lease_ms;
  return {
    evidence: "provider_run",
    active: record.status === "running" ? expired === false : false,
    stale: expired === null ? null : expired,
    expired,
    holder_pid: record.provider_pid,
    managed_pid: record.executor_pid,
    run_id: record.run_id,
    heartbeat_at: record.heartbeat_at,
    ttl_ms: record.heartbeat_lease_ms
  };
}

function goalLiveness(goal: GoalRecord): TaskLiveness {
  const observedAt = new Date().toISOString();
  const executionId = typeof goal.checkpoint?.codex_run_id === "string"
    ? goal.checkpoint.codex_run_id
    : goal.run_id || null;
  const providerRun = providerRunFor(goal, executionId);
  const leaseInspection = executionId
    ? readWorkspaceLeaseSync(goal.project_root, { contextDir: ".ai-bridge", name: "write" })
    : undefined;
  const matchingLease = leaseInspection?.lease?.run_id === executionId ? leaseInspection : undefined;
  const providerHeartbeatAge = parsedAgeMs(providerRun?.heartbeat_at ?? undefined);
  const providerHeartbeatFresh = providerRun?.heartbeat_at
    ? providerHeartbeatAge !== null && providerHeartbeatAge <= providerRun.heartbeat_lease_ms
    : null;
  const providerOwnerAlive = providerRun ? processAlive(providerRun.owner_pid) : null;
  const providerLastOutput = providerRun?.last_output_at ?? providerRun?.last_event_at ?? providerRun?.heartbeat_at ?? null;
  const providerLeaseProjection = providerRun ? providerLease(providerRun) : emptyLease();
  if (["succeeded", "failed", "blocked", "cancelled"].includes(goal.status)) {
    return {
      state: "stopped",
      execution_id: executionId,
      owner_pid: null,
      supervisor_pid: null,
      watcher_pid: null,
      owner_alive: null,
      lease_active: null,
      heartbeat_fresh: null,
      heartbeat_age_ms: null,
      heartbeat_at: providerRun?.heartbeat_at ?? null,
      lease: providerRun ? { ...providerLeaseProjection, active: false } : emptyLease(),
      step_active: false,
      last_output_at: providerLastOutput,
      observed_at: observedAt,
      reason: `Goal is terminal (${goal.status}).`
    };
  }
  if (goal.status === "queued") {
    return {
      state: "queued",
      execution_id: executionId,
      owner_pid: null,
      supervisor_pid: null,
      watcher_pid: null,
      owner_alive: null,
      lease_active: null,
      heartbeat_fresh: null,
      heartbeat_age_ms: null,
      heartbeat_at: null,
      lease: emptyLease(),
      step_active: false,
      last_output_at: null,
      observed_at: observedAt,
      reason: "Goal is queued; no execution owner has been proven."
    };
  }
  if (goal.status === "waiting_input" || goal.status === "waiting_approval") {
    return {
      state: "waiting",
      execution_id: executionId,
      owner_pid: providerRun?.owner_pid ?? null,
      supervisor_pid: providerRun?.supervisor_pid ?? null,
      watcher_pid: providerRun?.watcher_pid ?? null,
      owner_alive: providerOwnerAlive,
      lease_active: providerRun ? providerLeaseProjection.active : null,
      heartbeat_fresh: providerHeartbeatFresh,
      heartbeat_age_ms: providerHeartbeatAge,
      heartbeat_at: providerRun?.heartbeat_at ?? null,
      lease: providerRun ? providerLeaseProjection : emptyLease(),
      step_active: false,
      last_output_at: providerLastOutput,
      observed_at: observedAt,
      reason: `Goal is explicitly waiting (${goal.status}); heartbeat expiry does not advance or replay a waiting checkpoint.`
    };
  }
  if (matchingLease?.lease) {
    const lease = matchingLease.lease;
    const hostPid = Number.isInteger(Number(lease.pid)) && Number(lease.pid) > 0 ? Number(lease.pid) : null;
    const managedPid = Number.isInteger(Number(lease.managed_pid)) && Number(lease.managed_pid) > 0
      ? Number(lease.managed_pid)
      : null;
    const ownerPid = managedPid ?? hostPid;
    const ownerAlive = managedPid ? matchingLease.managed_alive : matchingLease.owner_alive;
    const heartbeatAge = parsedAgeMs(typeof lease.heartbeat_at === "string" ? lease.heartbeat_at : undefined);
    const heartbeatFresh = !matchingLease.expired;
    const state: TaskLiveness["state"] = matchingLease.stale
      ? "stale"
      : ownerAlive && heartbeatFresh
        ? "working"
        : matchingLease.active
          ? "silent"
          : "stale";
    return {
      state,
      execution_id: executionId,
      owner_pid: ownerPid,
      supervisor_pid: managedPid ? hostPid : null,
      watcher_pid: null,
      owner_alive: ownerAlive,
      lease_active: matchingLease.active,
      heartbeat_fresh: heartbeatFresh,
      heartbeat_age_ms: heartbeatAge,
      heartbeat_at: typeof lease.heartbeat_at === "string" ? lease.heartbeat_at : null,
      lease: {
        evidence: "execution_kernel",
        active: matchingLease.active,
        stale: matchingLease.stale,
        expired: matchingLease.expired,
        holder_pid: hostPid,
        managed_pid: managedPid,
        run_id: typeof lease.run_id === "string" ? lease.run_id : null,
        heartbeat_at: typeof lease.heartbeat_at === "string" ? lease.heartbeat_at : null,
        ttl_ms: typeof lease.ttlMs === "number" ? lease.ttlMs : typeof lease.ttl_ms === "number" ? lease.ttl_ms : null
      },
      step_active: true,
      last_output_at: providerLastOutput ?? (typeof lease.heartbeat_at === "string" ? lease.heartbeat_at : null),
      observed_at: observedAt,
      reason: state === "working"
        ? `Matching Execution Kernel write lease is active for Goal run ${executionId}.`
        : state === "silent"
          ? `The matching Goal lease is still active, but its heartbeat expired or the execution process is not currently observable.`
          : `The matching Goal lease is stale and no execution owner is alive.`
    };
  }
  if (providerRun) {
    const state: TaskLiveness["state"] = providerRun.status !== "running"
      ? "unknown"
      : providerOwnerAlive === true && providerHeartbeatFresh === true
        ? "working"
        : providerOwnerAlive === true && providerHeartbeatFresh === false
          ? "silent"
          : providerOwnerAlive === false
            ? "stale"
            : providerHeartbeatFresh === true
              ? "silent"
              : providerHeartbeatFresh === false
                ? "stale"
                : "unknown";
    return {
      state,
      execution_id: executionId,
      owner_pid: providerRun.owner_pid,
      supervisor_pid: providerRun.supervisor_pid,
      watcher_pid: providerRun.watcher_pid,
      owner_alive: providerOwnerAlive,
      lease_active: providerLeaseProjection.active,
      heartbeat_fresh: providerHeartbeatFresh,
      heartbeat_age_ms: providerHeartbeatAge,
      heartbeat_at: providerRun.heartbeat_at,
      lease: providerLeaseProjection,
      step_active: state === "working" || state === "silent",
      last_output_at: providerLastOutput,
      observed_at: observedAt,
      reason: state === "working"
        ? `Matching provider run ${providerRun.run_id} has a live owner and fresh heartbeat.`
        : state === "silent"
          ? `Matching provider run ${providerRun.run_id} has partial live evidence but no complete fresh owner/heartbeat proof.`
          : state === "stale"
            ? `Matching provider run ${providerRun.run_id} is stale or orphaned by explicit PID/heartbeat evidence.`
            : `Matching provider run ${providerRun.run_id} exists, but status ${providerRun.status} is not enough to prove active execution.`
    };
  }
  const sandboxMode = goal.checkpoint?.execution_options?.sandbox_mode;
  return {
    state: "unknown",
    execution_id: executionId,
    owner_pid: null,
    supervisor_pid: null,
    watcher_pid: null,
    owner_alive: null,
    lease_active: null,
    heartbeat_fresh: null,
    heartbeat_age_ms: null,
    heartbeat_at: null,
    lease: emptyLease(),
    step_active: true,
    last_output_at: null,
    observed_at: observedAt,
    reason: sandboxMode === "read-only"
      ? "No matching provider run heartbeat was persisted for this read-only Goal; liveness is unknown instead of inferred from Goal updated_at."
      : executionId
        ? `No active Execution Kernel write lease matches Goal run ${executionId}; liveness remains unknown instead of borrowing another task's lease.`
        : "Goal has not persisted a provider run id or matching execution lease; liveness cannot be proven."
  };
}

function handoffLiveness(status: HandoffStatusResult): TaskLiveness {
  const observedAt = new Date().toISOString();
  const leaseInspection = status.run_id
    ? readWorkspaceLeaseSync(status.root, { contextDir: status.context_dir, name: "write" })
    : undefined;
  const matchingLease = leaseInspection?.lease?.run_id === status.run_id ? leaseInspection : undefined;
  const lease = matchingLease?.lease;
  const hostPid = Number.isInteger(Number(lease?.pid)) && Number(lease?.pid) > 0 ? Number(lease?.pid) : null;
  const managedPid = Number.isInteger(Number(lease?.managed_pid)) && Number(lease?.managed_pid) > 0
    ? Number(lease?.managed_pid)
    : null;
  const recordedPid = status.executor_pid ?? null;
  const ownerPid = managedPid ?? recordedPid ?? hostPid;
  const ownerAlive = matchingLease
    ? managedPid
      ? matchingLease.managed_alive
      : matchingLease.owner_alive
    : processAlive(ownerPid);
  const heartbeatAt = typeof lease?.heartbeat_at === "string" ? lease.heartbeat_at : undefined;
  const heartbeatAge = parsedAgeMs(heartbeatAt);
  const heartbeatFresh = matchingLease ? !matchingLease.expired : null;
  const terminal = ["completed", "failed", "timed_out", "cancelled"].includes(status.run_state ?? "");
  const observableOutputAt = status.last_output_at ?? null;
  const diagnosticActivityAt = observableOutputAt ?? status.finished_at ?? heartbeatAt ?? status.progress.heartbeat_at;
  if (terminal) {
    return {
      state: "stopped",
      execution_id: status.run_id ?? null,
      owner_pid: ownerPid,
      supervisor_pid: managedPid && hostPid !== managedPid ? hostPid : null,
      watcher_pid: status.watcher_pid ?? null,
      owner_alive: ownerAlive,
      lease_active: matchingLease?.active ?? false,
      heartbeat_fresh: heartbeatFresh,
      heartbeat_age_ms: heartbeatAge,
      heartbeat_at: heartbeatAt ?? null,
      lease: lease
        ? {
            evidence: "execution_kernel",
            active: matchingLease?.active ?? null,
            stale: matchingLease?.stale ?? null,
            expired: matchingLease?.expired ?? null,
            holder_pid: hostPid,
            managed_pid: managedPid,
            run_id: typeof lease.run_id === "string" ? lease.run_id : null,
            heartbeat_at: heartbeatAt ?? null,
            ttl_ms: typeof lease.ttlMs === "number" ? lease.ttlMs : typeof lease.ttl_ms === "number" ? lease.ttl_ms : null
          }
        : emptyLease("handoff"),
      step_active: false,
      last_output_at: diagnosticActivityAt,
      observed_at: observedAt,
      reason: ownerAlive
        ? `Handoff run is terminal (${status.run_state}), but its recorded execution process is still alive and requires cleanup review.`
        : `Handoff run is terminal (${status.run_state}).`
    };
  }
  if (!status.execution_acknowledged) {
    return {
      state: status.current_plan_exists ? "waiting" : "queued",
      execution_id: status.run_id ?? null,
      owner_pid: ownerPid,
      supervisor_pid: hostPid,
      watcher_pid: status.watcher_pid ?? null,
      owner_alive: ownerAlive,
      lease_active: matchingLease?.active ?? null,
      heartbeat_fresh: heartbeatFresh,
      heartbeat_age_ms: heartbeatAge,
      heartbeat_at: heartbeatAt ?? null,
      lease: lease
        ? {
            evidence: "execution_kernel",
            active: matchingLease?.active ?? null,
            stale: matchingLease?.stale ?? null,
            expired: matchingLease?.expired ?? null,
            holder_pid: hostPid,
            managed_pid: managedPid,
            run_id: typeof lease.run_id === "string" ? lease.run_id : null,
            heartbeat_at: heartbeatAt ?? null,
            ttl_ms: typeof lease.ttlMs === "number" ? lease.ttlMs : typeof lease.ttl_ms === "number" ? lease.ttl_ms : null
          }
        : emptyLease("handoff"),
      step_active: false,
      last_output_at: diagnosticActivityAt,
      observed_at: observedAt,
      reason: status.current_plan_exists
        ? `Handoff plan exists but the matching plan hash has not been acknowledged. Watcher: ${status.watcher_reason}`
        : "No Handoff plan is queued."
    };
  }
  const state: TaskLiveness["state"] = matchingLease?.stale || ownerAlive === false
    ? "stale"
    : matchingLease?.active && ownerAlive === true && heartbeatFresh === true
      ? "working"
      : ownerAlive === true || matchingLease?.active
        ? "silent"
        : "unknown";
  return {
    state,
    execution_id: status.run_id ?? null,
    owner_pid: ownerPid,
    supervisor_pid: managedPid && hostPid !== managedPid ? hostPid : null,
    watcher_pid: status.watcher_pid ?? null,
    owner_alive: ownerAlive,
    lease_active: matchingLease?.active ?? null,
    heartbeat_fresh: heartbeatFresh,
    heartbeat_age_ms: heartbeatAge,
    heartbeat_at: heartbeatAt ?? null,
    lease: lease
      ? {
          evidence: "execution_kernel",
          active: matchingLease?.active ?? null,
          stale: matchingLease?.stale ?? null,
          expired: matchingLease?.expired ?? null,
          holder_pid: hostPid,
          managed_pid: managedPid,
          run_id: typeof lease.run_id === "string" ? lease.run_id : null,
          heartbeat_at: heartbeatAt ?? null,
          ttl_ms: typeof lease.ttlMs === "number" ? lease.ttlMs : typeof lease.ttl_ms === "number" ? lease.ttl_ms : null
        }
      : emptyLease("handoff"),
    step_active: status.run_state === "running",
    last_output_at: diagnosticActivityAt,
    observed_at: observedAt,
    reason: state === "working"
      ? `The Handoff agent process and matching Execution Kernel lease are active. Watcher: ${status.watcher_reason}`
      : state === "silent"
        ? `The Handoff execution has partial live evidence, but no fresh complete owner/lease proof. Watcher: ${status.watcher_reason}`
        : state === "stale"
          ? `The Handoff execution owner or matching lease is stale or missing. Watcher: ${status.watcher_reason}`
          : `The Handoff run is acknowledged, but execution liveness cannot be proven. Watcher: ${status.watcher_reason}`
  };
}

function goalTaskStatus(goal: GoalRecord): UnifiedTaskStatus {
  switch (goal.status) {
    case "queued": return "queued";
    case "running": return "running";
    case "waiting_input":
    case "waiting_approval": return "waiting";
    case "validating":
    case "reviewing": return "validating";
    case "succeeded": return "completed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "failed": return "failed";
  }
}

function indexedGoalTaskStatus(goal: GoalOfficeIndexEntry): UnifiedTaskStatus {
  switch (goal.status) {
    case "queued": return "queued";
    case "running": return "running";
    case "waiting_input":
    case "waiting_approval": return "waiting";
    case "validating":
    case "reviewing": return "validating";
    case "succeeded": return "completed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "failed": return "failed";
  }
}

function durableJobTaskStatus(job: DurableJobRecord): UnifiedTaskStatus {
  switch (job.status) {
    case "queued": return "queued";
    case "running": return job.progress.execution_state === "waiting" && job.progress.phase === "validating"
      ? "implemented_not_verified"
      : "running";
    case "recovering": return "recovering";
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    case "recovery_required":
    case "stale": return "interrupted";
    case "blocked": return "blocked";
    case "failed": return "failed";
  }
}

function indexedDurableJobTaskStatus(job: DurableJobOfficeIndexEntry): UnifiedTaskStatus {
  switch (job.status) {
    case "queued": return "queued";
    case "running": return "running";
    case "recovering": return "recovering";
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    case "recovery_required":
    case "stale": return "interrupted";
    case "blocked": return "blocked";
    case "failed": return "failed";
  }
}

function handoffTaskStatus(
  status: HandoffStatusResult,
  liveness?: TaskLiveness,
  acceptance?: TaskAcceptanceProjection
): UnifiedTaskStatus {
  const state = status.run_state ?? (status.current_plan_exists ? "queued" : "created");
  if (status.progress.execution_state === "stale") return "interrupted";
  if (state === "running" && (liveness?.state === "stale" || (liveness?.state === "unknown" && liveness.owner_alive !== true))) return "interrupted";
  switch (state) {
    case "running": return "running";
    case "completed": return acceptance?.status === "passed" ? "completed" : "implemented_not_verified";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "stalled":
    case "orphaned": return "interrupted";
    case "failed":
    case "timed_out": return "failed";
    default: return status.execution_acknowledged ? "assigned" : "queued";
  }
}

function handoffDurationMs(status: HandoffStatusResult): number | null {
  if (typeof status.duration_ms === "number" && Number.isFinite(status.duration_ms)) return Math.max(0, status.duration_ms);
  if (status.run_state !== "running" || !status.started_at) return null;
  const started = Date.parse(status.started_at);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
}

function legacyObjectiveMetadata(kind: TaskDomainKind, domainId: string): TaskObjectiveMetadataV1 {
  return {
    version: 1,
    objective_key: `legacy:${kind}:${domainId}`,
    stage_key: null,
    previous_attempt_id: null,
    source: "legacy_single_attempt"
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function indexedGoalObjectiveMetadata(goal: GoalOfficeIndexEntry): TaskObjectiveMetadataV1 {
  const explicit = objectRecord(goal.task_objective);
  const explicitKey = typeof explicit?.objective_key === "string" ? explicit.objective_key.trim() : "";
  if (explicitKey) {
    return {
      version: 1,
      objective_key: explicitKey,
      stage_key: typeof explicit?.stage_key === "string" ? explicit.stage_key.trim() || null : null,
      previous_attempt_id: typeof explicit?.previous_attempt_id === "string" ? explicit.previous_attempt_id.trim() || null : null,
      source: "explicit"
    };
  }
  const structured = objectRecord(goal.structured_task);
  const key = typeof structured?.dedupe_key === "string"
    ? structured.dedupe_key.trim()
    : typeof structured?.duplicate_key === "string"
      ? structured.duplicate_key.trim()
      : "";
  if (key) {
    const material = objectRecord(structured?.dedupe_material);
    return {
      version: 1,
      objective_key: key,
      stage_key: typeof material?.stage === "string" ? material.stage.trim() || null : null,
      previous_attempt_id: typeof structured?.previous_attempt_id === "string" ? structured.previous_attempt_id.trim() || null : null,
      source: "structured_task"
    };
  }
  return legacyObjectiveMetadata("goal", goal.goal_id);
}

function goalObjectiveMetadata(goal: GoalRecord): TaskObjectiveMetadataV1 {
  const explicit = objectRecord(goal.checkpoint?.task_objective);
  const explicitKey = typeof explicit?.objective_key === "string" ? explicit.objective_key.trim() : "";
  if (explicitKey) {
    return {
      version: 1,
      objective_key: explicitKey,
      stage_key: typeof explicit?.stage_key === "string" ? explicit.stage_key.trim() || null : null,
      previous_attempt_id: typeof explicit?.previous_attempt_id === "string" ? explicit.previous_attempt_id.trim() || null : null,
      source: "explicit"
    };
  }
  const structured = objectRecord(goal.checkpoint?.structured_task);
  const key = typeof structured?.dedupe_key === "string"
    ? structured.dedupe_key.trim()
    : typeof structured?.duplicate_key === "string"
      ? structured.duplicate_key.trim()
      : "";
  if (key) {
    const material = objectRecord(structured?.dedupe_material);
    return {
      version: 1,
      objective_key: key,
      stage_key: typeof material?.stage === "string" ? material.stage.trim() || null : null,
      previous_attempt_id: typeof structured?.previous_attempt_id === "string" ? structured.previous_attempt_id.trim() || null : null,
      source: "structured_task"
    };
  }
  return legacyObjectiveMetadata("goal", goal.goal_id);
}

function transientIdentity(
  kind: TaskDomainKind,
  domainId: string,
  projectRoot: string,
  title: string,
  createdAt: string,
  updatedAt = createdAt,
  objective: TaskObjectiveMetadataV1 = legacyObjectiveMetadata(kind, domainId)
): TaskIdentity {
  return {
    version: 1,
    task_id: taskIdFor(kind, domainId),
    kind,
    domain_id: domainId,
    project_root: projectRoot,
    title,
    objective,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

interface ProjectionResourceContext {
  governor: ResourceGovernor;
  status: ResourceGovernorStatus | null;
}

export class TaskProjectionService {
  readonly identityStore: TaskIdentityStore;
  private readonly goalStore: GoalStore;
  private readonly jobManager: DurableJobManager;
  private readonly projectedGoals = new Map<string, GoalRecord>();
  private readonly projectedGoalEvents = new Map<string, GoalEvent[]>();
  private readonly projectedDurableJobs = new Map<string, DurableJobRecord>();
  private readonly projectedDurableJobSteps = new Map<string, DurableJobStep[]>();

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly workspace: Workspace,
    private readonly options: { readOnly?: boolean } = {}
  ) {
    this.identityStore = new TaskIdentityStore(guard, workspace);
    this.goalStore = new GoalStore(config, guard, workspace);
    this.jobManager = new DurableJobManager(new DurableJobStore(guard, workspace, config));
  }

  async ensureGoal(goal: GoalRecord): Promise<TaskIdentity> {
    return await this.identityStore.ensure({
      kind: "goal",
      domain_id: goal.goal_id,
      project_root: goal.project_root,
      title: goal.objective,
      objective: goalObjectiveMetadata(goal),
      created_at: goal.created_at,
      updated_at: goal.updated_at
    });
  }

  async ensureDurableJob(job: DurableJobIdentityInput): Promise<TaskIdentity> {
    const taskId = taskIdFor("durable_job", job.run_id);
    const existing = await this.identityStore.load(taskId).catch(() => undefined);
    return await this.identityStore.ensure({
      kind: "durable_job",
      domain_id: job.run_id,
      project_root: job.workspace_root,
      title: job.title,
      ...(job.parent_task_id ?? existing?.parent_task_id ? { parent_task_id: job.parent_task_id ?? existing?.parent_task_id } : {}),
      objective: job.objective ?? existing?.objective ?? legacyObjectiveMetadata("durable_job", job.run_id),
      ...(job.workspace_binding ?? existing?.workspace_binding ? { workspace_binding: job.workspace_binding ?? existing?.workspace_binding } : {}),
      ...(job.actor ?? existing?.actor ? { actor: job.actor ?? existing?.actor } : {}),
      created_at: job.created_at,
      updated_at: job.updated_at
    });
  }

  async ensureHandoffPlan(input: { plan_hash: string; title: string; created_at?: string }): Promise<TaskIdentity> {
    return await this.identityStore.ensure({
      kind: "handoff",
      domain_id: input.plan_hash,
      project_root: this.workspace.root,
      title: input.title,
      objective: legacyObjectiveMetadata("handoff", input.plan_hash),
      created_at: input.created_at
    });
  }

  handoffTaskId(status: HandoffStatusResult): string | undefined {
    const domainId = status.current_plan_hash ?? status.run_plan_hash ?? status.run_id;
    return domainId ? taskIdFor("handoff", domainId) : undefined;
  }

  async getIdentity(taskId: string): Promise<TaskIdentity> {
    const persisted = await this.identityStore.load(taskId);
    if (persisted) return persisted;
    return await this.discoverIdentity(taskId);
  }

  async getStatus(taskId: string): Promise<TaskStatusProjection> {
    const identity = await this.getIdentity(taskId);
    const projection = identity.kind === "goal"
      ? await this.projectGoal(identity)
      : identity.kind === "durable_job"
        ? await this.projectDurableJob(identity)
        : await this.projectHandoff(identity);
    const record = await readLatestGitFinalizationRecord(this.config, this.guard, this.workspace);
    const components = await createWorkspaceExecutionComponentStore(this.workspace.root).readProjection().catch(() => undefined);
    return attachCompletionState(this.attachExecutionComponents(attachGitFinalization(projection, record), components));
  }

  async listStatuses(limit = 100): Promise<TaskStatusProjection[]> {
    return (await this.listStatusesWithObservability(limit)).tasks;
  }

  async listStatusesWithObservability(limit = 100, options: TaskProjectionListOptions = {}): Promise<TaskProjectionListResult> {
    this.projectedGoals.clear();
    this.projectedGoalEvents.clear();
    this.projectedDurableJobs.clear();
    this.projectedDurableJobSteps.clear();
    const totalStarted = Date.now();
    const requestedLimit = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 100;
    const boundedLimit = Math.max(1, Math.min(requestedLimit, MAX_TASK_PROJECTION_LIMIT));
    const invocationCounts = {
      identity_store_list: 0,
      goal_store_list: 0,
      durable_job_store_list: 0,
      durable_job_batch_read: 0,
      durable_job_batch_fallback: 0,
      durable_job_read: 0,
      handoff_status_read: 0,
      git_finalization_read: 0,
      execution_component_read: 0,
      project_goal: 0,
      project_durable_job: 0,
      project_handoff: 0,
      office_identity_index_read: 0,
      office_identity_index_rebuild: 0,
      office_goal_index_read: 0,
      office_goal_index_rebuild: 0,
      office_durable_job_index_read: 0,
      office_durable_job_index_rebuild: 0,
      office_selected_goal_read: 0,
      office_selected_durable_job_read: 0
    };
    const identityStarted = Date.now();
    const officeProfile = options.profile === "office";
    const fullProjectionIndexFresh = officeProfile ? false : (await Promise.all([
      projectionIndexFresh(this.guard, this.workspace, ".codexpro/office-projection-index/identities.json", ".codexpro/task-identities", "identity.json"),
      projectionIndexFresh(this.guard, this.workspace, ".codexpro/office-projection-index/goals.json", `${this.config.contextDir}/goals`, "goal.json"),
      projectionIndexFresh(this.guard, this.workspace, ".codexpro/office-projection-index/durable-jobs.json", ".codexpro/runs", "job.json")
    ])).every(Boolean);
    const useProjectionIndexes = officeProfile || fullProjectionIndexFresh;
    let officeIndexRebuildDuration = 0;
    let fullDurableJobIndexUsed = false;
    const identities = new Map<string, TaskIdentity>();
    const selectionCandidates = new Map<string, TaskProjectionSelectionCandidate>();
    let goalRecords: GoalRecord[] = [];
    let durableJobs = [] as Awaited<ReturnType<DurableJobStore["readJobs"]>>;
    let handoff: HandoffStatusResult;
    const gitFinalizationPromise = readLatestGitFinalizationRecord(this.config, this.guard, this.workspace);
    const executionComponentsPromise = createWorkspaceExecutionComponentStore(this.workspace.root).readProjection().catch(() => undefined);

    if (useProjectionIndexes) {
      const officeIndexStarted = Date.now();
      const [identityIndex, goalIndex, durableJobIndex, handoffStatus] = await Promise.all([
        this.identityStore.ensureOfficeIndex(),
        this.goalStore.ensureOfficeIndex(),
        this.jobManager.store.ensureOfficeIndex(),
        options.handoff_status_promise ?? readHandoffStatus(this.config, this.guard, this.workspace)
      ]);
      handoff = handoffStatus;
      invocationCounts.office_identity_index_read += 1;
      invocationCounts.office_goal_index_read += 1;
      invocationCounts.office_durable_job_index_read += 1;
      invocationCounts.office_identity_index_rebuild += identityIndex.rebuilt ? 1 : 0;
      invocationCounts.office_goal_index_rebuild += goalIndex.rebuilt ? 1 : 0;
      invocationCounts.office_durable_job_index_rebuild += durableJobIndex.rebuilt ? 1 : 0;
      officeIndexRebuildDuration = identityIndex.rebuilt || goalIndex.rebuilt || durableJobIndex.rebuilt
        ? elapsedSince(officeIndexStarted)
        : 0;
      invocationCounts.identity_store_list += identityIndex.rebuilt ? 1 : 0;
      invocationCounts.goal_store_list += goalIndex.rebuilt ? 1 : 0;
      invocationCounts.durable_job_store_list += durableJobIndex.rebuilt ? 1 : 0;
      invocationCounts.handoff_status_read += 1;

      for (const identity of identityIndex.entries.values()) {
        if (identity.kind !== "handoff") identities.set(identity.task_id, identity);
      }
      for (const goal of goalIndex.entries.values()) {
        const objective = indexedGoalObjectiveMetadata(goal);
        const identity = transientIdentity("goal", goal.goal_id, goal.project_root, goal.title, goal.created_at, goal.updated_at, objective);
        const existing = identities.get(identity.task_id);
        const selectedIdentity = existing ? { ...existing, objective } : identity;
        identities.set(identity.task_id, selectedIdentity);
        selectionCandidates.set(identity.task_id, {
          identity: selectedIdentity,
          status: indexedGoalTaskStatus(goal),
          recoverable: goal.recovery_required || goal.replay_allowed || goal.failure_retryable,
          updated_at: goal.updated_at
        });
      }
      for (const job of durableJobIndex.entries.values()) {
        const identity = transientIdentity("durable_job", job.run_id, job.workspace_root, job.title, job.created_at, job.updated_at);
        if (!identities.has(identity.task_id)) identities.set(identity.task_id, identity);
        const selectedIdentity = identities.get(identity.task_id) ?? identity;
        selectionCandidates.set(identity.task_id, {
          identity: selectedIdentity,
          status: indexedDurableJobTaskStatus(job),
          recoverable: job.recoverable,
          updated_at: job.updated_at
        });
      }
    } else {
      invocationCounts.identity_store_list += 1;
      for (const identity of await this.identityStore.list(Math.max(boundedLimit * 2, 100))) {
        if (identity.kind === "handoff") continue;
        identities.set(identity.task_id, identity);
      }
      invocationCounts.goal_store_list += 1;
      goalRecords = await this.goalStore.listGoals();
      for (const goal of goalRecords) {
        const objective = goalObjectiveMetadata(goal);
        const identity = transientIdentity("goal", goal.goal_id, goal.project_root, goal.objective, goal.created_at, goal.updated_at, objective);
        const existing = identities.get(identity.task_id);
        const selectedIdentity = existing ? { ...existing, objective } : identity;
        identities.set(identity.task_id, selectedIdentity);
        selectionCandidates.set(identity.task_id, {
          identity: selectedIdentity,
          status: goalTaskStatus(goal),
          recoverable: goal.checkpoint?.recovery_required === true || goal.checkpoint?.replay_allowed === true || goal.failure?.retryable === true,
          updated_at: goal.updated_at
        });
      }
      invocationCounts.durable_job_store_list += 1;
      const durableJobIndex = await this.jobManager.store.listOfficeIndex();
      const [durableJobIndexStat, durableJobRootStat] = await Promise.all([
        fsp.stat(this.guard.resolve(this.workspace, ".codexpro/office-projection-index/durable-jobs.json").absPath).catch(() => undefined),
        fsp.stat(this.guard.resolve(this.workspace, ".codexpro/runs").absPath).catch(() => undefined)
      ]);
      const durableJobIndexFresh = Boolean(
        durableJobIndex
        && durableJobIndexStat
        && (!durableJobRootStat || durableJobIndexStat.mtimeMs >= durableJobRootStat.mtimeMs)
      );
      if (durableJobIndex && durableJobIndexFresh) {
        fullDurableJobIndexUsed = true;
        invocationCounts.office_durable_job_index_read += 1;
        for (const job of durableJobIndex) {
          const transient = transientIdentity("durable_job", job.run_id, job.workspace_root, job.title, job.created_at, job.updated_at);
          if (!identities.has(transient.task_id)) identities.set(transient.task_id, transient);
          const selectedIdentity = identities.get(transient.task_id) ?? transient;
          selectionCandidates.set(transient.task_id, {
            identity: selectedIdentity,
            status: indexedDurableJobTaskStatus(job),
            recoverable: job.recoverable,
            updated_at: job.updated_at
          });
        }
      } else {
        const durableJobRunIds = await this.jobManager.store.listJobIds();
        if (durableJobRunIds.length) {
          try {
            invocationCounts.durable_job_batch_read += 1;
            durableJobs = await this.jobManager.store.readJobs(durableJobRunIds);
          } catch {
            invocationCounts.durable_job_batch_fallback += 1;
            for (const runId of durableJobRunIds) {
              invocationCounts.durable_job_read += 1;
              const job = await this.jobManager.store.readJob(runId);
              if (job) durableJobs.push(job);
            }
          }
        }
        for (const job of durableJobs) {
          const identity = transientIdentity("durable_job", job.run_id, job.workspace_root, job.title, job.created_at, job.updated_at);
          if (!identities.has(identity.task_id)) identities.set(identity.task_id, identity);
          const selectedIdentity = identities.get(identity.task_id) ?? identity;
          selectionCandidates.set(identity.task_id, {
            identity: selectedIdentity,
            status: durableJobTaskStatus(job),
            recoverable: ["recovering", "recovery_required", "stale"].includes(job.status) || Boolean(job.recovery_reason?.trim()),
            updated_at: job.updated_at
          });
        }
      }
      invocationCounts.handoff_status_read += 1;
      handoff = await (options.handoff_status_promise ?? readHandoffStatus(this.config, this.guard, this.workspace));
    }

    const handoffDomainId = handoff.current_plan_hash ?? handoff.run_plan_hash ?? handoff.run_id;
    if (handoffDomainId) {
      const createdAt = handoff.started_at ?? (handoff.progress.heartbeat_at === "unknown" ? new Date(0).toISOString() : handoff.progress.heartbeat_at);
      const identity = transientIdentity(
        "handoff",
        handoffDomainId,
        this.workspace.root,
        "Current handoff execution",
        createdAt,
        handoff.finished_at ?? createdAt
      );
      if (!identities.has(identity.task_id)) identities.set(identity.task_id, identity);
      const selectedIdentity = identities.get(identity.task_id) ?? identity;
      const selectionStatus: UnifiedTaskStatus = handoff.run_state === "running"
        ? "running"
        : handoff.run_state === "completed"
          ? "implemented_not_verified"
          : handoff.run_state === "cancelled"
            ? "cancelled"
            : ["failed", "timed_out"].includes(handoff.run_state ?? "")
              ? "failed"
              : handoff.execution_acknowledged
                ? "assigned"
                : handoff.current_plan_exists
                  ? "queued"
                  : "created";
      selectionCandidates.set(identity.task_id, {
        identity: selectedIdentity,
        status: selectionStatus,
        recoverable: false,
        updated_at: handoff.finished_at ?? createdAt
      });
    }

    const allSelectionCandidates = officeProfile
      ? [...selectionCandidates.values()]
      : [...identities.values()].map((identity) => selectionCandidates.get(identity.task_id) ?? {
          identity,
          status: "created" as UnifiedTaskStatus,
          recoverable: false,
          updated_at: identity.updated_at
        });
    let projectionIdentities = officeProfile
      ? selectOfficeProjectionIdentities(allSelectionCandidates, options)
      : allSelectionCandidates
          .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.identity.task_id.localeCompare(right.identity.task_id))
          .slice(0, boundedLimit)
          .map((candidate) => candidate.identity);

    if (useProjectionIndexes) {
      const selectedTaskIds = projectionIdentities.map((identity) => identity.task_id);
      const selectedGoalIds = projectionIdentities.filter((identity) => identity.kind === "goal").map((identity) => identity.domain_id);
      const selectedDurableJobIds = projectionIdentities.filter((identity) => identity.kind === "durable_job").map((identity) => identity.domain_id);
      const [authoritativeIdentities, selectedGoalReads, selectedDurableJobs] = await Promise.all([
        this.identityStore.readMany(selectedTaskIds),
        this.goalStore.readGoalsWithEvents(selectedGoalIds),
        this.jobManager.store.readJobs(selectedDurableJobIds)
      ]);
      const selectedGoals = selectedGoalReads.map((item) => item.goal);
      goalRecords = selectedGoals;
      durableJobs = selectedDurableJobs;
      for (const item of selectedGoalReads) {
        this.projectedGoals.set(item.goal.goal_id, item.goal);
        this.projectedGoalEvents.set(item.goal.goal_id, item.events);
      }
      for (const job of selectedDurableJobs) this.projectedDurableJobs.set(job.run_id, job);
      invocationCounts.office_selected_goal_read += selectedGoals.length;
      invocationCounts.office_selected_durable_job_read += selectedDurableJobs.length;
      invocationCounts.durable_job_batch_read += selectedDurableJobIds.length > 0 ? 1 : 0;
      const authoritativeIdentityById = new Map(authoritativeIdentities.map((identity) => [identity.task_id, identity]));
      const selectedGoalById = new Map(selectedGoals.map((goal) => [goal.goal_id, goal]));
      const selectedDurableJobById = new Map(selectedDurableJobs.map((job) => [job.run_id, job]));
      projectionIdentities = projectionIdentities.map((identity) => {
        const persisted = authoritativeIdentityById.get(identity.task_id) ?? identity;
        if (identity.kind === "goal") {
          const goal = selectedGoalById.get(identity.domain_id);
          return goal ? { ...persisted, objective: goalObjectiveMetadata(goal) } : persisted;
        }
        if (identity.kind === "durable_job") {
          const job = selectedDurableJobById.get(identity.domain_id);
          return job ? authoritativeIdentityById.get(identity.task_id)
            ?? transientIdentity("durable_job", job.run_id, job.workspace_root, job.title, job.created_at, job.updated_at)
            : persisted;
        }
        return persisted;
      });
    } else if (fullDurableJobIndexUsed) {
      const selectedDurableJobIds = projectionIdentities
        .filter((identity) => identity.kind === "durable_job")
        .map((identity) => identity.domain_id);
      if (selectedDurableJobIds.length) {
        invocationCounts.durable_job_batch_read += 1;
        durableJobs = await this.jobManager.store.readJobs(selectedDurableJobIds);
      }
    }
    const goalById = new Map(goalRecords.map((goal) => [goal.goal_id, goal]));
    const durableJobById = new Map(durableJobs.map((job) => [job.run_id, job]));
    const identityDiscoveryDuration = elapsedSince(identityStarted);

    const projections: TaskStatusProjection[] = [];
    let skippedIdentityCount = 0;
    const projectionStarted = Date.now();
    invocationCounts.git_finalization_read += 1;
    const resourceGovernor = new ResourceGovernor(this.config);
    const [gitFinalization, resourceStatus, executionComponents] = await Promise.all([
      gitFinalizationPromise,
      options.resource_status !== undefined
        ? Promise.resolve(options.resource_status)
        : resourceGovernor.status().catch(() => null),
      executionComponentsPromise
    ]);
    const resourceContext: ProjectionResourceContext = { governor: resourceGovernor, status: resourceStatus };
    invocationCounts.execution_component_read += 1;
    for (let index = 0; index < projectionIdentities.length; index += TASK_PROJECTION_BATCH_SIZE) {
      const batch = projectionIdentities.slice(index, index + TASK_PROJECTION_BATCH_SIZE);
      const results = await Promise.all(batch.map(async (identity): Promise<TaskStatusProjection | undefined> => {
        try {
          let projection: TaskStatusProjection;
          if (identity.kind === "goal") {
            invocationCounts.project_goal += 1;
            projection = await this.projectGoal(
              identity,
              resourceContext,
              goalById.get(identity.domain_id),
              this.projectedGoalEvents.get(identity.domain_id)
            );
          } else if (identity.kind === "durable_job") {
            invocationCounts.project_durable_job += 1;
            projection = await this.projectDurableJob(identity, resourceContext, durableJobById.get(identity.domain_id), {
              allowTerminalCache: !officeProfile
            });
          } else {
            invocationCounts.project_handoff += 1;
            projection = await this.projectHandoff(identity, resourceContext, handoff);
          }
          return attachCompletionState(this.attachExecutionComponents(attachGitFinalization(projection, gitFinalization), executionComponents));
        } catch {
          // Domain state may be removed between listing and projection. Skip stale identity links.
          return undefined;
        }
      }));
      for (const projection of results) {
        if (projection) projections.push(projection);
        else skippedIdentityCount += 1;
      }
    }
    const projectionDuration = elapsedSince(projectionStarted);
    const sortStarted = Date.now();
    const tasks = projections
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .slice(0, boundedLimit);
    const sortDuration = elapsedSince(sortStarted);
    return {
      tasks,
      observability: {
        version: 1,
        generated_at: new Date().toISOString(),
        source: "task_projection",
        requested_limit: requestedLimit,
        bounded_limit: boundedLimit,
        max_limit: MAX_TASK_PROJECTION_LIMIT,
        bounded: requestedLimit !== boundedLimit || projections.length > boundedLimit || projectionIdentities.length < identities.size,
        discovered_identity_count: identities.size,
        projected_task_count: tasks.length,
        skipped_identity_count: skippedIdentityCount,
        selection_profile: options.profile ?? "full",
        selected_identity_count: projectionIdentities.length,
        deferred_identity_count: Math.max(0, identities.size - projectionIdentities.length),
        duration_ms: elapsedSince(totalStarted),
        durations_ms: {
          identity_discovery: identityDiscoveryDuration,
          projection: projectionDuration,
          sort_and_slice: sortDuration,
          office_index_rebuild: officeIndexRebuildDuration
        },
        invocation_counts: invocationCounts
      }
    };
  }

  async getCurrent(): Promise<TaskStatusProjection | undefined> {
    const statuses = await this.listStatuses(200);
    return selectMostCurrentTask(statuses.map((status) => ({
      ...status,
      task_id: status.identity.task_id,
      acceptance_status: status.acceptance.status
    })));
  }

  async getCurrentForConversation(conversationId: string | undefined): Promise<TaskStatusProjection | undefined> {
    const expected = conversationId?.trim();
    if (!expected || expected === "server-default") return undefined;
    const statuses = await this.listStatuses(500);
    const scoped = statuses.filter((status) => {
      const actorSession = status.identity.actor?.session_id?.trim();
      const bindingSession = status.identity.workspace_binding?.source_conversation_id?.trim();
      const recorded = [actorSession, bindingSession].filter((value): value is string => Boolean(value));
      return recorded.length > 0
        && !recorded.includes("server-default")
        && recorded.every((value) => value === expected);
    });
    return selectMostCurrentTask(scoped.map((status) => ({
      ...status,
      task_id: status.identity.task_id,
      acceptance_status: status.acceptance.status
    })));
  }

  async getEvidence(taskId: string): Promise<TaskEvidenceProjection> {
    const projection = await this.getStatus(taskId);
    const artifactPaths = uniquePaths([
      ...projection.evidence_paths,
      ...projection.acceptance.evidence_paths,
      projection.progress.last_evidence
    ]);
    return {
      task_id: projection.identity.task_id,
      kind: projection.identity.kind,
      status: projection.status,
      acceptance: projection.acceptance,
      artifact_paths: artifactPaths,
      last_evidence: projection.progress.last_evidence ?? artifactPaths[0] ?? null,
      generated_at: new Date().toISOString()
    };
  }

  private attachExecutionComponents(
    projection: TaskStatusProjection,
    components: ExecutionComponentStateFile["execution_components"] | undefined
  ): TaskStatusProjection {
    if (!components) return projection;
    const ids = new Set<string>([
      projection.identity.task_id,
      projection.identity.domain_id,
      projection.execution?.run_id ?? "",
      projection.executor?.execution_id ?? ""
    ].filter(Boolean));
    const filterBucket = (bucket: Record<string, ExecutionComponentStateFile["execution_components"]["workers"][string]>) => {
      const out: typeof bucket = {};
      for (const [key, record] of Object.entries(bucket)) {
        if (
          (record.task_id && ids.has(record.task_id))
          || (record.run_id && ids.has(record.run_id))
          || ids.has(record.component_id)
        ) {
          out[key] = record;
        }
      }
      return out;
    };
    return {
      ...projection,
      execution_components: {
        model_stream: filterBucket(components.model_stream),
        tool_processes: filterBucket(components.tool_processes),
        workers: filterBucket(components.workers)
      }
    };
  }

  async getRecovery(taskId: string): Promise<TaskRecoveryPlan> {
    const identity = await this.getIdentity(taskId);
    if (identity.kind === "goal") return await this.goalRecovery(identity);
    if (identity.kind === "durable_job") return await this.durableJobRecovery(identity);
    return await this.handoffRecovery(identity);
  }

  async getRecoveryForProjection(projection: TaskStatusProjection): Promise<TaskRecoveryPlan> {
    const identity = projection.identity;
    if (identity.kind === "goal") return await this.goalRecovery(identity, projection, this.projectedGoals.get(identity.domain_id));
    if (identity.kind === "durable_job") return await this.durableJobRecovery(
      identity,
      projection,
      this.options.readOnly ? this.projectedDurableJobs.get(identity.domain_id) : undefined,
      this.options.readOnly ? this.projectedDurableJobSteps.get(identity.domain_id) : undefined
    );
    return await this.handoffRecovery(identity);
  }

  async getTimeline(taskId: string): Promise<TaskTimelineEvent[]> {
    const identity = await this.getIdentity(taskId);
    if (identity.kind === "goal") {
      const events = await this.goalStore.readEvents(identity.domain_id);
      return events.map((event) => ({
        sequence: event.sequence,
        timestamp: event.timestamp,
        source: "goal",
        type: event.type,
        status: event.status,
        ...(event.data ? { summary: JSON.stringify(event.data).slice(0, 2_000) } : {})
      }));
    }
    if (identity.kind === "durable_job") {
      const { job, steps } = await this.jobManager.inspect(identity.domain_id, { markStale: !this.options.readOnly });
      return this.jobTimeline(job, steps);
    }
    const status = await readHandoffStatus(this.config, this.guard, this.workspace);
    this.assertCurrentHandoff(identity, status);
    return [{
      sequence: 1,
      timestamp: status.progress.heartbeat_at === "unknown" ? identity.updated_at : status.progress.heartbeat_at,
      source: "handoff",
      type: `handoff.${status.run_state ?? "queued"}`,
      status: status.run_state ?? "queued",
      summary: status.progress.current_action,
      ...(status.run_dir ? { evidence_paths: [status.run_dir] } : {})
    }];
  }

  private async discoverIdentity(taskId: string): Promise<TaskIdentity> {
    if (taskId.startsWith("goal-")) {
      const goal = await this.goalStore.loadGoal(taskId.slice("goal-".length));
      return transientIdentity("goal", goal.goal_id, goal.project_root, goal.objective, goal.created_at, goal.updated_at, goalObjectiveMetadata(goal));
    }
    if (taskId.startsWith("job-")) {
      const runId = taskId.slice("job-".length);
      const job = await this.jobManager.store.readJob(runId);
      if (!job) throw new Error(`Task not found: ${taskId}`);
      return transientIdentity("durable_job", job.run_id, job.workspace_root, job.title, job.created_at, job.updated_at);
    }
    if (taskId.startsWith("handoff-")) {
      const status = await readHandoffStatus(this.config, this.guard, this.workspace);
      const domainId = taskId.slice("handoff-".length);
      if (domainId !== status.run_id && domainId !== status.current_plan_hash) throw new Error(`Current handoff does not match task: ${taskId}`);
      const createdAt = status.started_at ?? status.progress.heartbeat_at;
      return transientIdentity("handoff", domainId, this.workspace.root, "Current handoff execution", createdAt, status.finished_at ?? status.progress.heartbeat_at);
    }
    throw new Error(`Task not found: ${taskId}`);
  }

  private async goalRecovery(identity: TaskIdentity, existingProjection?: TaskStatusProjection, existingGoal?: GoalRecord): Promise<TaskRecoveryPlan> {
    const goal = existingGoal ?? await this.goalStore.loadGoal(identity.domain_id);
    const projection = existingProjection ?? await this.projectGoal(identity, null);
    const generatedAt = new Date().toISOString();
    const sandboxMode = goal.checkpoint?.execution_options?.sandbox_mode;
    const recoveryRequired = goal.checkpoint?.recovery_required === true;
    const recoveredFrom = typeof goal.checkpoint?.recovered_from_status === "string"
      ? goal.checkpoint.recovered_from_status
      : undefined;
    const base = {
      task_id: identity.task_id,
      kind: identity.kind,
      status: projection.status,
      current_step_id: typeof goal.checkpoint?.phase === "string" ? goal.checkpoint.phase : null,
      last_completed_step_id: null,
      next_step_id: null,
      generated_at: generatedAt
    } as const;

    if (goal.status === "succeeded" || goal.status === "cancelled") {
      return {
        ...base,
        mode: "none",
        resumable: false,
        automatic: false,
        action: "none",
        idempotent: null,
        retryable: null,
        side_effect_level: "unknown",
        retry_policy: "never",
        rollback_method: null,
        required_checks: [],
        reason: `Goal is terminal (${goal.status}); no recovery is required.`
      };
    }
    if (goal.status === "failed" || goal.status === "blocked") {
      return {
        ...base,
        mode: "blocked",
        resumable: false,
        automatic: false,
        action: "none",
        idempotent: false,
        retryable: false,
        side_effect_level: sandboxMode === "workspace-write" ? "local_write" : "unknown",
        retry_policy: "never",
        rollback_method: sandboxMode === "workspace-write" ? "Inspect the Goal snapshot and current Git diff before creating a new Goal." : null,
        required_checks: ["Inspect the terminal failure and evidence before creating a replacement Goal."],
        reason: `Goal terminal status ${goal.status} cannot be resumed in place.`
      };
    }
    if (goal.status === "waiting_input" || goal.status === "waiting_approval") {
      if (recoveryRequired && (recoveredFrom === "validating" || recoveredFrom === "reviewing")) {
        return {
          ...base,
          mode: "automatic",
          resumable: true,
          automatic: true,
          action: "goal_resume",
          idempotent: true,
          retryable: true,
          side_effect_level: "local_write",
          retry_policy: "automatic",
          rollback_method: "Regenerate validation and review evidence from the persisted Goal checkpoint.",
          required_checks: ["Confirm the persisted changed-file set still matches the workspace before reusing validation evidence."],
          reason: `Goal restart interrupted ${recoveredFrom}; GoalManager can resume the validation checkpoint without replaying the implementation turn.`
        };
      }
      const checks = [
        goal.status === "waiting_approval" ? "Obtain the required user approval." : "Provide the requested continuation prompt.",
        "Confirm the previous Codex turn reached a durable checkpoint."
      ];
      if (sandboxMode === "workspace-write") {
        checks.push("Inspect the current Git diff before resuming a writable Goal.");
        checks.push("Reconcile any external side effect that may have completed before the interruption.");
      }
      return {
        ...base,
        mode: "manual",
        resumable: Boolean(goal.codex_thread_id && goal.checkpoint?.execution_options),
        automatic: false,
        action: goal.codex_thread_id && goal.checkpoint?.execution_options ? "goal_resume" : "external_reconciliation",
        idempotent: null,
        retryable: Boolean(goal.codex_thread_id && goal.checkpoint?.execution_options),
        side_effect_level: sandboxMode === "workspace-write" ? "local_write" : sandboxMode === "read-only" ? "read_only" : "unknown",
        retry_policy: "manual",
        rollback_method: sandboxMode === "workspace-write" ? "Use the Goal snapshot and Git diff to restore or continue the partial workspace state." : null,
        required_checks: checks,
        reason: recoveryRequired
          ? goal.checkpoint?.recovery_reason ?? "Goal was recovered after process restart and requires an explicit continuation decision."
          : `Goal is waiting for ${goal.status === "waiting_approval" ? "approval" : "input"}; this is not safe to auto-answer.`
      };
    }
    if (["running", "validating", "reviewing"].includes(goal.status)) {
      if (projection.liveness.state === "working" || projection.liveness.state === "silent") {
        return {
          ...base,
          mode: "none",
          resumable: false,
          automatic: false,
          action: "none",
          idempotent: null,
          retryable: null,
          side_effect_level: sandboxMode === "workspace-write" ? "local_write" : sandboxMode === "read-only" ? "read_only" : "unknown",
          retry_policy: "never",
          rollback_method: null,
          required_checks: [],
          reason: `Goal execution is ${projection.liveness.state}; recovery must not start concurrently.`
        };
      }
      return {
        ...base,
        mode: "blocked",
        resumable: false,
        automatic: false,
        action: "external_reconciliation",
        idempotent: null,
        retryable: null,
        side_effect_level: sandboxMode === "workspace-write" ? "local_write" : "unknown",
        retry_policy: "manual",
        rollback_method: sandboxMode === "workspace-write" ? "Inspect the Goal snapshot and current Git diff after the startup recovery scan." : null,
        required_checks: ["Run the persisted Goal recovery scan or restart the owning service before attempting resume.", "Verify no matching provider run or workspace lease is still active."],
        reason: `Goal is ${goal.status}, but liveness is ${projection.liveness.state}; GoalManager must first convert it to a durable waiting recovery checkpoint.`
      };
    }
    return {
      ...base,
      mode: "none",
      resumable: false,
      automatic: false,
      action: "none",
      idempotent: null,
      retryable: null,
      side_effect_level: "unknown",
      retry_policy: "never",
      rollback_method: null,
      required_checks: [],
      reason: `Goal status ${goal.status} does not require recovery.`
    };
  }

  private async durableJobRecovery(
    identity: TaskIdentity,
    existingProjection?: TaskStatusProjection,
    existingJob?: DurableJobRecord,
    existingSteps?: DurableJobStep[]
  ): Promise<TaskRecoveryPlan> {
    const { job, steps } = existingJob
      ? { job: existingJob, steps: existingSteps ?? await this.jobManager.store.readSteps(existingJob) }
      : await this.jobManager.inspect(identity.domain_id, { markStale: !this.options.readOnly });
    const projection = existingProjection ?? await this.projectDurableJob(identity, null);
    const current = steps.find((step) => step.step_id === job.current_step_id)
      ?? steps.find((step) => step.status === "running" || step.status === "recovery_required")
      ?? steps.find((step) => step.status !== "completed");
    const lastCompleted = [...steps].reverse().find((step) => step.status === "completed");
    const next = current?.next_step ? steps.find((step) => step.step_id === current.next_step) : current;
    const sideEffectLevel = current?.side_effect_level ?? "unknown";
    const retryPolicy = current?.retry_policy ?? (current?.idempotent && current?.retryable ? "automatic" : current?.retryable ? "manual" : "never");
    const base = {
      task_id: identity.task_id,
      kind: identity.kind,
      status: projection.status,
      current_step_id: current?.step_id ?? null,
      last_completed_step_id: lastCompleted?.step_id ?? null,
      next_step_id: next?.step_id ?? null,
      idempotent: current?.idempotent ?? null,
      retryable: current?.retryable ?? null,
      side_effect_level: sideEffectLevel,
      retry_policy: retryPolicy,
      rollback_method: current?.rollback_method ?? null,
      generated_at: new Date().toISOString()
    } as const;

    if (job.status === "completed" || job.status === "cancelled") {
      return { ...base, mode: "none", resumable: false, automatic: false, action: "none", required_checks: [], reason: `Durable Job is terminal (${job.status}); no recovery is required.` };
    }
    if (job.status === "recovery_required" || current?.status === "recovery_required" || (current && !current.idempotent)) {
      return {
        ...base,
        mode: "manual",
        resumable: false,
        automatic: false,
        action: "external_reconciliation",
        required_checks: [
          "Inspect the step output, evidence and current external state.",
          "Determine whether the pending operation already completed before the process ended.",
          current?.rollback_method ?? "Define an explicit rollback or continuation procedure before retry."
        ],
        reason: job.recovery_reason ?? current?.error ?? "The interrupted step is non-idempotent; automatic replay is unsafe."
      };
    }
    if (job.status === "failed" || job.status === "blocked") {
      const canRetry = Boolean(current?.idempotent && current?.retryable && retryPolicy !== "never");
      return {
        ...base,
        mode: canRetry ? "manual" : "blocked",
        resumable: canRetry,
        automatic: false,
        action: canRetry ? "retry_run_task_step" : "external_reconciliation",
        required_checks: canRetry
          ? ["Inspect the deterministic failure before explicitly retrying the failed step."]
          : ["Resolve the blocking condition or reconcile the external state before creating a replacement task."],
        reason: canRetry
          ? `Failed step ${current?.step_id} is declared idempotent and retryable, but terminal failures require an explicit retry decision.`
          : job.error ?? job.recovery_reason ?? "The failed Durable Job has no safely retryable current step."
      };
    }
    const interrupted = job.status === "stale" || job.status === "recovering" || projection.liveness.state === "stale";
    if (interrupted && current?.idempotent && current.retryable && retryPolicy === "automatic") {
      return {
        ...base,
        mode: "automatic",
        resumable: true,
        automatic: true,
        action: "resume_run_task",
        required_checks: sideEffectLevel === "local_write"
          ? ["Confirm generated local artifacts may be safely regenerated."]
          : [],
        reason: `Interrupted step ${current.step_id} is explicitly idempotent with automatic retry; completed steps will be reused.`
      };
    }
    if (interrupted) {
      return {
        ...base,
        mode: "manual",
        resumable: false,
        automatic: false,
        action: "external_reconciliation",
        required_checks: ["Inspect the current step and its evidence before replay."],
        reason: `Durable Job is interrupted, but step ${current?.step_id ?? "unknown"} is not approved for automatic replay.`
      };
    }
    return {
      ...base,
      mode: "none",
      resumable: false,
      automatic: false,
      action: "none",
      required_checks: [],
      reason: `Durable Job is ${job.status} with liveness ${projection.liveness.state}; no recovery action is currently required.`
    };
  }

  private async handoffRecovery(identity: TaskIdentity): Promise<TaskRecoveryPlan> {
    const status = await readHandoffStatus(this.config, this.guard, this.workspace);
    this.assertCurrentHandoff(identity, status);
    const projection = await this.projectHandoff(identity, null);
    const base = {
      task_id: identity.task_id,
      kind: identity.kind,
      status: projection.status,
      current_step_id: status.run_state ?? null,
      last_completed_step_id: null,
      next_step_id: null,
      idempotent: false,
      retryable: false,
      side_effect_level: "unknown" as const,
      retry_policy: "never" as const,
      rollback_method: "Inspect the Handoff implementation diff and external state before issuing a new Handoff run.",
      generated_at: new Date().toISOString(),
      recovery_from_run_id: status.run_id ?? null,
      resume_count: status.resume_count ?? null
    };
    if (status.run_state === "completed") {
      if (projection.acceptance.status === "passed") {
        return {
          ...base,
          mode: "none",
          resumable: false,
          automatic: false,
          action: "none",
          required_checks: [],
          reason: "Handoff execution and owner acceptance evidence are complete; no recovery action is required."
        };
      }
      return {
        ...base,
        mode: "manual",
        resumable: false,
        automatic: false,
        action: "validate_only",
        required_checks: ["Run the required tests, review and browser validation against the recorded implementation diff."],
        reason: "Handoff execution completed, but completion must be established by validation evidence rather than replay."
      };
    }
    if (["failed", "timed_out", "cancelled"].includes(status.run_state ?? "") || projection.liveness.state === "stale") {
      const priorRun = status.run_id ?? projection.liveness.execution_id ?? "the interrupted Handoff run";
      return {
        ...base,
        mode: "manual",
        resumable: false,
        automatic: false,
        action: "reissue_handoff",
        required_checks: [
          "Inspect the run-specific implementation diff and execution log.",
          "Check whether any external side effect completed before interruption.",
          "Preserve the current worktree; do not reset, checkout, stash, clean, or roll back files automatically.",
          "Create a new Handoff run id rather than reusing the old execution.",
          `Link the new run with recovery_from_run_id=${priorRun}.`,
          "Include the current Git diff, recorded completed evidence, and remaining validation items in the recovery handoff plan."
        ],
        reason: `Handoff is ${status.run_state ?? projection.liveness.state}; arbitrary agent execution is not assumed idempotent. Start a new associated recovery run and keep the original run evidence.`
      };
    }
    return {
      ...base,
      mode: "none",
      resumable: false,
      automatic: false,
      action: "none",
      required_checks: [],
      reason: `Handoff is ${status.run_state ?? "queued"} with liveness ${projection.liveness.state}; no recovery replay is allowed or required.`
    };
  }

  private async projectResourcePolicy(
    taskId: string,
    context?: ProjectionResourceContext | null
  ) {
    if (context === null) return undefined;
    if (context) return context.status ? context.governor.projectionFromStatus(taskId, context.status) : undefined;
    return await new ResourceGovernor(this.config).projectionFor(taskId);
  }

  private async projectGoal(
    identity: TaskIdentity,
    resourceContext?: ProjectionResourceContext | null,
    preloadedGoal?: GoalRecord,
    preloadedGoalEvents?: GoalEvent[]
  ): Promise<TaskStatusProjection> {
    const goal = preloadedGoal ?? await this.goalStore.loadGoal(identity.domain_id);
    const goalEvents = preloadedGoalEvents ?? await this.goalStore.readEvents(identity.domain_id);
    const progress = projectGoalProgress(goal);
    const acceptance = goalAcceptance(goal);
    const completionProof = goalCompletionProof(goal);
    const liveness = goalLiveness(goal);
    const domainProjection = goalTaskStatus(goal);
    const runningWithoutAuthority = domainProjection === "running"
      && (
        liveness.state === "stale"
        || liveness.state === "stopped"
        || (liveness.state === "unknown" && liveness.owner_alive !== true && liveness.lease_active !== true)
      );
    const livenessAwareProjection = runningWithoutAuthority ? "interrupted" : domainProjection;
    const status = livenessAwareProjection === "completed"
      && (acceptance.status !== "passed" || (completionProof.source !== "none" && !completionProof.verified))
      ? "implemented_not_verified"
      : livenessAwareProjection;
    const executionId = typeof goal.checkpoint?.codex_run_id === "string" ? goal.checkpoint.codex_run_id : null;
    const providerRun = providerRunFor(goal, executionId);
    const executionOptions = goal.checkpoint?.execution_options;
    const terminalAt = ["succeeded", "failed", "blocked", "cancelled"].includes(goal.status) ? goal.updated_at : null;
    const lastProgressAt = progressProgressAt(progress);
    const lastLivenessAt = progressLivenessAt(progress);
    return {
      identity,
      status,
      domain_status: goal.status,
      outcome: goal.checkpoint?.task_outcome ?? deriveTaskOutcome({
        domain_status: goal.status,
        validation_status: goal.checkpoint?.acceptance_status ?? goal.validation_result?.status,
        validation_ok: goal.validation_result?.ok,
        failure_domain: goal.failure?.failure_domain,
        failure_code: goal.failure?.code,
        failure_retryable: goal.failure?.retryable,
        receipt_status: goal.checkpoint?.receipt_status,
        hook_delivery_status: goal.checkpoint?.hook_delivery_status,
        has_evidence: goal.evidence.length > 0 || Boolean(goal.validation_result?.report_path),
        updated_at: goal.updated_at
      }),
      executor: {
        kind: "goal_provider",
        provider: providerRun?.provider ?? goal.checkpoint?.execution_provider ?? null,
        model: typeof executionOptions?.model === "string" ? executionOptions.model : null,
        sandbox_mode: executionOptions?.sandbox_mode ?? providerRun?.sandbox_mode ?? null,
        execution_id: providerRun?.run_id ?? executionId,
        source: providerRun ? "goal_checkpoint.provider_run" : "goal_checkpoint"
      },
      progress,
      liveness,
      execution: {
        run_id: executionId ?? goal.run_id ?? null,
        owner_source: providerRun ? "goal_provider_run" : "goal_checkpoint",
        owner_pid: liveness.owner_pid,
        managed_pid: liveness.lease?.managed_pid ?? null,
        fencing_token: null,
        current_step_id: typeof goal.checkpoint?.phase === "string" ? goal.checkpoint.phase : null,
        current_phase: progress.phase,
        waiting_for: progress.wait_reason ?? null,
        started_at: providerRun?.started_at ?? goal.checkpoint?.latency?.wall_clock_started_at ?? null,
        finished_at: terminalAt,
        core_execution_completed_at: goal.checkpoint?.core_execution_completed_at ?? terminalAt,
        terminal_persisted_at: goal.checkpoint?.terminal_event_emitted_at ?? terminalAt,
        duration_ms: goal.checkpoint?.latency?.breakdown.total_ms ?? durationBetween(providerRun?.started_at ?? null, terminalAt),
        execution_timeout_ms: null,
        last_output_at: providerRun?.last_output_at ?? providerRun?.last_event_at ?? null,
        last_liveness_at: lastLivenessAt,
        last_progress_at: lastProgressAt,
        progress_fingerprint: progress.progress_fingerprint ?? null,
        step_deadline: providerRun?.step_deadline ?? progress.step_deadline ?? null,
        no_progress_deadline: providerRun?.no_progress_deadline ?? progress.no_progress_deadline ?? null,
        hard_deadline: providerRun?.hard_deadline ?? progress.hard_deadline ?? null,
        termination_reason: providerRun?.termination_reason ?? progress.termination_reason ?? null,
        heartbeat_write_failures: providerRun?.heartbeat_write_failures ?? progress.heartbeat_write_failures ?? null,
        queue_duration_ms: goal.checkpoint?.latency?.breakdown.queue_ms ?? null,
        time_to_first_progress_ms: null,
        no_progress_duration_ms: observedNoProgressDuration(lastProgressAt ?? undefined, terminalAt),
        acceptance_duration_ms: goal.validation_result?.acceptance_duration_ms ?? goal.validation_result?.duration_ms ?? null,
        recovery_count: null,
        owner_change_count: null,
        manual_intervention_count: null,
        timeout_reason: null,
        termination_signal: null,
        recovery_from_run_id: null,
        resume_count: null,
        latest_error: typeof goal.checkpoint?.last_error === "string" ? goal.checkpoint.last_error : null,
        cancelling: goal.checkpoint?.pending_operation === "cancel",
        recovering: status === "recovering" || goal.checkpoint?.recovery_required === true,
        owner_alive: liveness.owner_alive,
        watcher_alive: null
      },
      execution_graph_evidence: taskGraphEvidenceFromGoal(goal, goalEvents),
      acceptance,
      resource_policy: await this.projectResourcePolicy(`goal-${goal.goal_id}`, resourceContext),
      contract: {
        contract_version: goal.goal_contract.contract_version,
        plan_path: goal.goal_contract.plan_path,
        plan_sha256: goal.goal_contract.plan_sha256,
        allowed_paths: [...goal.goal_contract.allowed_paths],
        forbidden_paths: [...goal.goal_contract.forbidden_paths],
        tool_permissions: { ...goal.goal_contract.tool_permissions },
        side_effect_permissions: { ...goal.goal_contract.side_effect_permissions },
        completion_rule: goal.goal_contract.completion_rule
      },
      loop: loopProjection(goal.loop_state),
      changed_files_count: Array.isArray(goal.changed_files) ? goal.changed_files.length : null,
      completion_proof: completionProof,
      evidence_paths: uniquePaths([
        ...goal.evidence.map((evidence) => evidence.path),
        ...completionProof.proof_paths,
        goal.validation_result?.report_path,
        goal.review_result?.reviewer_run_id ?? undefined,
        goal.snapshot_id ?? undefined,
        progress.last_evidence
      ]),
      updated_at: goal.updated_at
    };
  }

  private async projectDurableJob(
    identity: TaskIdentity,
    resourceContext?: ProjectionResourceContext | null,
    preloadedJob?: DurableJobRecord,
    options: { allowTerminalCache?: boolean } = {}
  ): Promise<TaskStatusProjection> {
    const inspected = preloadedJob ? null : await this.jobManager.inspect(identity.domain_id, { markStale: !this.options.readOnly });
    const job = preloadedJob ?? inspected!.job;
    const isTerminal = ["completed", "failed", "blocked", "cancelled"].includes(job.status);
    const taskId = `job-${job.run_id}`;
    const hasResourceState = Boolean(resourceContext?.status
      && (
        resourceContext.status.leases.some((item) => item.task_id === taskId || item.request_id === taskId)
        || resourceContext.status.queue.some((item) => item.task_id === taskId || item.request_id === taskId)
      ));
    const terminalCacheKey = `${this.workspace.root}\0${job.run_id}\0${job.updated_at}`;
    if (isTerminal && options.allowTerminalCache && !hasResourceState) {
      const cached = terminalDurableProjectionCache.get(terminalCacheKey);
      if (cached) {
        terminalDurableProjectionCache.delete(terminalCacheKey);
        terminalDurableProjectionCache.set(terminalCacheKey, cached);
        return { ...structuredClone(cached), identity };
      }
    }
    const steps = inspected?.steps ?? await this.jobManager.store.readSteps(job);
    if (this.options.readOnly && preloadedJob) this.projectedDurableJobSteps.set(job.run_id, steps);
    const acceptance = await this.durableJobAcceptance(job, steps);
    const owner = isTerminal || job.status === "queued"
      ? undefined
      : await this.jobManager.store.readJson<{ pid?: number; owner_pid?: number; acquired_at?: string }>(
          this.jobManager.store.ownerLockPath(job.run_id)
        ).catch(() => undefined);
    const rawOwnerPid = owner?.owner_pid ?? owner?.pid;
    const ownerPid = Number.isInteger(rawOwnerPid) && Number(rawOwnerPid) > 0 ? Number(rawOwnerPid) : null;
    const ownerAlive = processAlive(ownerPid);
    const heartbeatAge = parsedAgeMs(job.progress.heartbeat_at);
    const threshold = job.progress.browser_active
      ? this.jobManager.staleAfterMs * 3
      : job.progress.writer_active
        ? this.jobManager.staleAfterMs * 2
        : this.jobManager.staleAfterMs;
    const heartbeatFresh = heartbeatAge === null ? null : heartbeatAge <= threshold;
    const currentStep = steps.find((step) => step.step_id === job.current_step_id);
    const validationStep = steps.find((step) => step.phase === "validating");
    const livenessState: TaskLiveness["state"] = isTerminal
      ? "stopped"
      : job.status === "queued"
        ? "queued"
        : job.status === "stale" || job.status === "recovery_required" || job.progress.execution_state === "stale"
          ? "stale"
          : job.progress.execution_state === "waiting" || job.progress.execution_state === "blocked"
            ? "waiting"
            : ownerAlive === true && heartbeatFresh === false
              ? "silent"
              : ownerAlive === false && heartbeatFresh === false
                ? "stale"
                : heartbeatFresh === true && ["working", "recovering"].includes(job.progress.execution_state)
                  ? "working"
                  : "unknown";
    const liveness: TaskLiveness = {
      state: livenessState,
      execution_id: job.run_id,
      owner_pid: ownerPid,
      supervisor_pid: null,
      watcher_pid: null,
      owner_alive: ownerAlive,
      lease_active: ownerPid === null ? (isTerminal || job.status === "queued" ? false : null) : ownerAlive,
      heartbeat_fresh: heartbeatFresh,
      heartbeat_age_ms: heartbeatAge,
      heartbeat_at: job.progress.heartbeat_at === "unknown" ? null : job.progress.heartbeat_at,
      lease: {
        evidence: "owner_lock",
        active: ownerPid === null ? (isTerminal || job.status === "queued" ? false : null) : ownerAlive,
        stale: livenessState === "stale",
        expired: heartbeatFresh === null ? null : !heartbeatFresh,
        holder_pid: ownerPid,
        managed_pid: null,
        run_id: job.run_id,
        heartbeat_at: job.progress.heartbeat_at === "unknown" ? null : job.progress.heartbeat_at,
        ttl_ms: threshold
      },
      step_active: Boolean(currentStep && currentStep.status === "running"),
      last_output_at: currentStep?.finished_at ?? currentStep?.heartbeat_at ?? currentStep?.started_at ?? job.updated_at,
      observed_at: new Date().toISOString(),
      reason: isTerminal
        ? `Durable Job is terminal (${job.status}).`
        : livenessState === "stale"
          ? job.recovery_reason ?? job.progress.wait_reason ?? "Durable Job heartbeat or owner is stale."
          : livenessState === "silent"
            ? `Owner process ${ownerPid} is alive, but heartbeat age ${heartbeatAge} ms exceeds the ${threshold} ms threshold.`
            : livenessState === "working"
              ? `Owner lock and heartbeat evidence are consistent within the ${threshold} ms threshold.`
              : job.progress.wait_reason ?? `Durable Job liveness is ${livenessState}.`
    };
    const domainProjection = durableJobTaskStatus(job);
    const livenessAwareProjection = domainProjection === "running"
      && (livenessState === "stale" || (livenessState === "unknown" && ownerAlive !== true))
      ? "interrupted"
      : domainProjection;
    const status = livenessAwareProjection === "completed" && acceptance.required && acceptance.status !== "passed"
      ? "implemented_not_verified"
      : livenessAwareProjection;
    const lastLivenessAt = progressLivenessAt(job.progress);
    const lastProgressAt = progressProgressAt(job.progress);
    const queueDurationMs = job.started_at
      ? durationBetween(job.created_at, job.started_at)
      : job.status === "queued"
        ? durationBetween(job.created_at)
        : null;
    const acceptanceDurationMs = validationStep?.started_at && validationStep.finished_at
      ? durationBetween(validationStep.started_at, validationStep.finished_at)
      : null;
    const projection: TaskStatusProjection = {
      identity,
      status,
      domain_status: job.status,
      outcome: deriveTaskOutcome({
        domain_status: status === "implemented_not_verified" ? "completed" : job.status,
        validation_status: acceptance.status,
        validation_ok: acceptance.status === "passed" ? true : acceptance.status === "failed" ? false : undefined,
        failure_code: job.error ? "durable_job_failed" : null,
        failure_retryable: job.status === "stale" || job.status === "recovery_required",
        has_evidence: acceptance.evidence_paths.length > 0,
        updated_at: job.updated_at
      }),
      executor: {
        kind: "durable_job",
        provider: "durable_job_manager",
        model: null,
        sandbox_mode: null,
        execution_id: job.run_id,
        source: "durable_job_record"
      },
      progress: job.progress,
      liveness,
      execution: {
        run_id: job.run_id,
        owner_source: "durable_job_owner_lock",
        owner_pid: liveness.owner_pid,
        managed_pid: liveness.lease?.managed_pid ?? null,
        fencing_token: job.fencing_token ?? currentStep?.fencing_token ?? null,
        current_step_id: job.current_step_id,
        current_phase: job.progress.phase,
        waiting_for: job.progress.wait_reason ?? null,
        started_at: job.started_at ?? null,
        finished_at: job.finished_at ?? null,
        core_execution_completed_at: job.finished_at ?? null,
        terminal_persisted_at: isTerminal && job.status_transition_status === job.status
          ? job.status_transition_at ?? null
          : null,
        duration_ms: job.duration_ms ?? (job.started_at && !job.finished_at ? durationBetween(job.started_at) : null),
        execution_timeout_ms: null,
        last_output_at: liveness.last_output_at,
        last_liveness_at: lastLivenessAt,
        last_progress_at: lastProgressAt,
        progress_fingerprint: job.progress.progress_fingerprint ?? null,
        step_deadline: job.step_deadline ?? job.progress.step_deadline ?? null,
        no_progress_deadline: job.no_progress_deadline ?? job.progress.no_progress_deadline ?? null,
        hard_deadline: job.hard_deadline ?? job.progress.hard_deadline ?? null,
        termination_reason: job.termination_reason ?? job.progress.termination_reason ?? null,
        heartbeat_write_failures: job.heartbeat_write_failures ?? job.progress.heartbeat_write_failures ?? null,
        queue_duration_ms: queueDurationMs,
        time_to_first_progress_ms: job.first_progress_at ? durationBetween(job.created_at, job.first_progress_at) : null,
        no_progress_duration_ms: observedNoProgressDuration(lastProgressAt ?? undefined, job.finished_at),
        acceptance_duration_ms: acceptanceDurationMs,
        recovery_count: job.recovery_count ?? 0,
        owner_change_count: job.owner_change_count ?? 0,
        manual_intervention_count: job.manual_intervention_count ?? 0,
        timeout_reason: null,
        termination_signal: null,
        recovery_from_run_id: null,
        resume_count: null,
        latest_error: currentStep?.error ?? job.error ?? job.recovery_reason ?? null,
        cancelling: job.cancel_requested === true,
        recovering: status === "recovering" || job.status === "recovery_required",
        owner_alive: liveness.owner_alive,
        watcher_alive: null
      },
      execution_graph_evidence: taskGraphEvidenceFromDurableJob(job, steps),
      acceptance,
      resource_policy: await this.projectResourcePolicy(`job-${job.run_id}`, resourceContext),
      loop: loopProjection(job.loop_state),
      changed_files_count: null,
      evidence_paths: uniquePaths([
        job.report_path,
        job.progress.last_evidence,
        ...steps.flatMap((step) => [step.output_path, ...step.evidence_paths])
      ]),
      updated_at: job.updated_at
    };
    if (isTerminal && options.allowTerminalCache && !hasResourceState) {
      cacheTerminalDurableProjection(terminalCacheKey, projection);
    }
    return projection;
  }

  private async projectHandoff(
    identity: TaskIdentity,
    resourceContext?: ProjectionResourceContext | null,
    preloadedStatus?: HandoffStatusResult
  ): Promise<TaskStatusProjection> {
    const status = preloadedStatus ?? await readHandoffStatus(this.config, this.guard, this.workspace);
    this.assertCurrentHandoff(identity, status);
    const liveness = handoffLiveness(status);
    const acceptance = await handoffAcceptance(this.config, this.guard, this.workspace, identity, status);
    const lastProgressAt = progressProgressAt(status.progress);
    const lastLivenessAt = progressLivenessAt(status.progress);
    const taskStatus = handoffTaskStatus(status, liveness, acceptance);
    return {
      identity,
      status: taskStatus,
      domain_status: status.run_state ?? "queued",
      outcome: deriveTaskOutcome({
        domain_status: taskStatus,
        validation_status: acceptance.status,
        validation_ok: acceptance.status === "passed" ? true : acceptance.status === "failed" ? false : undefined,
        failure_code: status.blocked_reason || status.timeout_reason ? "handoff_failed" : null,
        failure_retryable: status.recovery_action !== "none",
        has_evidence: acceptance.evidence_paths.length > 0 || Boolean(status.run_dir),
        updated_at: status.finished_at ?? status.last_output_at ?? status.progress.heartbeat_at
      }),
      executor: {
        kind: "handoff",
        provider: status.executor ?? null,
        model: null,
        sandbox_mode: null,
        execution_id: status.run_id ?? null,
        source: "handoff_status"
      },
      progress: status.progress,
      liveness,
      execution: {
        run_id: status.run_id ?? null,
        owner_source: status.executor ?? null,
        owner_pid: status.executor_pid ?? liveness.owner_pid,
        managed_pid: status.executor_pid ?? liveness.lease?.managed_pid ?? null,
        fencing_token: Number.isFinite(status.watcher_fencing_token) ? Number(status.watcher_fencing_token) : null,
        current_step_id: status.run_state ?? null,
        current_phase: status.progress.phase,
        waiting_for: status.progress.wait_reason ?? null,
        started_at: status.started_at ?? null,
        finished_at: status.finished_at ?? null,
        duration_ms: handoffDurationMs(status),
        execution_timeout_ms: status.execution_timeout_ms ?? null,
        last_output_at: status.last_output_at ?? null,
        last_liveness_at: lastLivenessAt,
        last_progress_at: lastProgressAt,
        progress_fingerprint: status.progress.progress_fingerprint ?? null,
        step_deadline: status.progress.step_deadline ?? null,
        no_progress_deadline: status.progress.no_progress_deadline ?? null,
        hard_deadline: status.progress.hard_deadline ?? (status.started_at && status.execution_timeout_ms ? new Date(Date.parse(status.started_at) + status.execution_timeout_ms).toISOString() : null),
        termination_reason: status.progress.termination_reason ?? status.timeout_reason ?? null,
        heartbeat_write_failures: status.progress.heartbeat_write_failures ?? null,
        queue_duration_ms: status.started_at && identity.created_at ? durationBetween(identity.created_at, status.started_at) : null,
        time_to_first_progress_ms: null,
        no_progress_duration_ms: observedNoProgressDuration(lastProgressAt ?? undefined, status.finished_at ?? null),
        acceptance_duration_ms: null,
        recovery_count: status.resume_count ?? null,
        owner_change_count: null,
        manual_intervention_count: null,
        timeout_reason: status.timeout_reason ?? null,
        termination_signal: status.termination_signal ?? null,
        recovery_from_run_id: status.recovery_from_run_id ?? null,
        resume_count: status.resume_count ?? null,
        latest_error: status.blocked_reason ?? status.timeout_reason ?? null,
        cancelling: status.run_state === "cancelling" || status.timeout_reason === "explicit_cancel",
        recovering: taskStatus === "recovering" || status.recovery_action !== "none",
        owner_alive: liveness.owner_alive,
        watcher_alive: status.watcher_online
      },
      execution_graph_evidence: taskGraphEvidenceFromHandoff(identity.task_id, status),
      acceptance,
      resource_policy: await this.projectResourcePolicy(`handoff-${identity.domain_id}`, resourceContext),
      changed_files_count: null,
      evidence_paths: uniquePaths([status.run_dir, status.progress.last_evidence]),
      updated_at: status.finished_at ?? status.last_output_at ?? status.progress.heartbeat_at
    };
  }

  private async durableJobAcceptance(job: DurableJobRecord, steps: DurableJobStep[]): Promise<TaskAcceptanceProjection> {
    const persisted = await this.jobManager.store.readJson<{
      options?: { patches?: unknown[]; commands?: string[] };
    }>(job.input_path).catch(() => undefined);
    const options = persisted?.options;
    const hasPatches = Boolean(options?.patches?.length);
    const hasCommands = Boolean(options?.commands?.length);
    const directWriteSteps = steps.filter((step) => step.phase === "development" && step.side_effect_level === "local_write");
    const hasDirectWorkspaceWrites = directWriteSteps.some((step) => ["running", "completed", "failed", "blocked"].includes(step.status));
    const hasWorkspaceWrites = hasPatches || hasDirectWorkspaceWrites;
    const validationStep = steps.find((step) => step.phase === "validating");
    const validationOutput = validationStep?.output_path
      ? await this.jobManager.store.readJson<{
        data?: {
          status?: string;
          completion_ready?: boolean;
          commands?: Array<{ status?: string; exit_code?: number | null; cancelled?: boolean; timed_out?: boolean }>;
        };
      }>(validationStep.output_path).catch(() => undefined)
      : undefined;
    const observedCommands = validationOutput?.data?.commands ?? [];
    const observedValidationPassed = validationOutput?.data?.status === "passed"
      && validationOutput.data.completion_ready === true
      && observedCommands.length > 0
      && observedCommands.every((command) => command.status === "passed"
        && command.exit_code === 0
        && command.cancelled !== true
        && command.timed_out !== true);
    const observedValidationFailed = validationOutput?.data?.status === "failed"
      || observedCommands.some((command) => command.status === "failed"
        || (typeof command.exit_code === "number" && command.exit_code !== 0)
        || command.cancelled === true
        || command.timed_out === true);
    const evidencePaths = uniquePaths([
      ...directWriteSteps.flatMap((step) => [step.output_path, ...(step.evidence_paths ?? [])]),
      validationStep?.output_path,
      ...(validationStep?.evidence_paths ?? []),
      job.report_path
    ]);
    const required = hasWorkspaceWrites || hasCommands;
    if (!required) {
      return {
        required: false,
        status: "not_required",
        profile: "durable_read_only",
        evidence_paths: evidencePaths,
        reason: "Durable Job contains no workspace patches or validation commands; successful step completion is sufficient."
      };
    }
    if (validationStep?.status === "running") {
      return {
        required: true,
        status: "running",
        profile: "durable_bounded_validation",
        evidence_paths: evidencePaths,
        reason: "Bounded validation commands are running."
      };
    }
    if (validationStep?.status === "failed" || validationStep?.status === "blocked" || job.status === "failed" || job.status === "blocked" || observedValidationFailed) {
      return {
        required: true,
        status: "failed",
        profile: "durable_bounded_validation",
        evidence_paths: evidencePaths,
        reason: validationStep?.error ?? job.error ?? `Durable Job ended with ${job.status} before validation passed.`
      };
    }
    if (
      job.status === "completed"
      && validationStep?.status === "completed"
      && (observedValidationPassed || validationStep.retry_policy === "automatic" || job.run_id.startsWith("direct-"))
    ) {
      const profile = job.run_id.startsWith("direct-")
        ? "durable_direct_validation"
        : observedValidationPassed && validationStep.retry_policy !== "automatic"
          ? "durable_observed_validation"
          : "durable_bounded_validation";
      return {
        required: true,
        status: "passed",
        profile,
        evidence_paths: evidencePaths,
        reason: job.run_id.startsWith("direct-")
          ? "The direct task persisted a completed validation step before finalization."
          : observedValidationPassed
            ? "Persisted structured validation output proves every requested command completed successfully; replay classification does not change the observed result."
            : "The declared bounded validation step completed successfully and is classified as safely repeatable."
      };
    }
    if (job.status === "completed" && !validationStep) {
      return {
        required: true,
        status: "pending",
        profile: "durable_bounded_validation",
        evidence_paths: evidencePaths,
        reason: hasWorkspaceWrites
          ? "Workspace writes completed without a validation step."
          : "Commands were requested but no validation step was persisted."
      };
    }
    if (job.status === "completed" && validationStep?.status === "completed") {
      return {
        required: true,
        status: "pending",
        profile: "durable_manual_validation_review",
        evidence_paths: evidencePaths,
        reason: "Validation commands completed, but their replay/safety classification is unknown; manual evidence review is required."
      };
    }
    return {
      required: true,
      status: "pending",
      profile: "durable_bounded_validation",
      evidence_paths: evidencePaths,
      reason: "Required validation has not completed."
    };
  }

  private assertCurrentHandoff(identity: TaskIdentity, status: HandoffStatusResult): void {
    if (identity.domain_id !== status.run_id && identity.domain_id !== status.current_plan_hash) {
      throw new Error(`Handoff task ${identity.task_id} is not the current workspace handoff.`);
    }
  }

  private jobTimeline(job: DurableJobRecord, steps: DurableJobStep[]): TaskTimelineEvent[] {
    const events: TaskTimelineEvent[] = [{
      sequence: 1,
      timestamp: job.created_at,
      source: "durable_job",
      type: "job.created",
      status: "queued",
      summary: job.title
    }];
    for (const step of steps) {
      events.push({
        sequence: step.index + 1,
        timestamp: step.finished_at ?? step.started_at ?? step.heartbeat_at ?? job.updated_at,
        source: "durable_job",
        type: `job.step.${step.status}`,
        status: step.status,
        summary: `${step.phase}: ${step.output_summary ?? step.error ?? step.pending_operation ?? step.status}`,
        ...(step.evidence_paths.length ? { evidence_paths: step.evidence_paths } : {})
      });
    }
    return events;
  }
}
