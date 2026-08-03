import type { UnifiedTaskStatus } from "./types.js";

export interface CurrentTaskCandidate {
  task_id: string;
  status: UnifiedTaskStatus;
  updated_at: string;
  liveness: string | {
    state?: string | null;
    step_active?: boolean | null;
    lease_active?: boolean | null;
    owner_alive?: boolean | null;
  };
  outcome?: {
    execution_status?: string | null;
    validation_status?: string | null;
  } | null;
  acceptance_status?: string | null;
  acceptance?: { status?: string | null } | null;
  writer_activity?: { active?: boolean | null } | null;
  validation_activity?: { active?: boolean | null } | null;
  resource_policy?: { status?: string | null; execution_mode?: string | null } | null;
  execution_observability?: {
    owner_alive?: boolean | null;
    recovering?: boolean | null;
    execution_state?: string | null;
  } | null;
  execution?: {
    owner_alive?: boolean | null;
    recovering?: boolean | null;
    current_phase?: string | null;
  } | null;
}

function livenessState(candidate: CurrentTaskCandidate): string {
  return typeof candidate.liveness === "string"
    ? candidate.liveness
    : String(candidate.liveness?.state ?? "unknown");
}

function stepActive(candidate: CurrentTaskCandidate): boolean {
  return typeof candidate.liveness === "object" && candidate.liveness?.step_active === true;
}

function leaseActive(candidate: CurrentTaskCandidate): boolean {
  return (typeof candidate.liveness === "object" && candidate.liveness?.lease_active === true)
    || candidate.resource_policy?.status === "admitted";
}

function ownerAlive(candidate: CurrentTaskCandidate): boolean | null {
  if (candidate.execution_observability?.owner_alive !== undefined) return candidate.execution_observability.owner_alive ?? null;
  if (candidate.execution?.owner_alive !== undefined) return candidate.execution.owner_alive ?? null;
  if (typeof candidate.liveness === "object" && candidate.liveness?.owner_alive !== undefined) return candidate.liveness.owner_alive ?? null;
  return null;
}

export function currentTaskSelectionScore(candidate: CurrentTaskCandidate): number {
  const liveness = livenessState(candidate);
  const expectedInactiveStop = ["completed", "failed", "cancelled", "interrupted", "implemented_not_verified"].includes(candidate.status);
  const stale = candidate.status !== "interrupted"
    && (liveness === "stale" || (["stopped", "terminal"].includes(liveness) && !expectedInactiveStop));
  const unknown = liveness === "unknown";
  const deadOwner = ownerAlive(candidate) === false;
  const validationStatus = candidate.outcome?.validation_status ?? candidate.acceptance_status ?? candidate.acceptance?.status ?? "not_requested";
  const recovering = candidate.status === "recovering"
    || candidate.execution_observability?.recovering === true
    || candidate.execution?.recovering === true;
  const validationActive = candidate.status === "validating"
    || candidate.validation_activity?.active === true
    || candidate.acceptance_status === "running"
    || candidate.acceptance?.status === "running";
  const writerActive = candidate.writer_activity?.active === true
    || (leaseActive(candidate) && candidate.resource_policy?.execution_mode === "write");
  const executionActive = candidate.status === "running"
    || candidate.outcome?.execution_status === "running";
  const failed = candidate.status === "failed"
    || validationStatus === "failed"
    || candidate.outcome?.execution_status === "failed";

  let score = 0;
  if (stepActive(candidate) && !deadOwner) score = Math.max(score, 1_300);
  if (writerActive && !deadOwner) score = Math.max(score, 1_220);
  if (validationActive && !deadOwner) score = Math.max(score, 1_180);
  if (recovering && !deadOwner) score = Math.max(score, 1_140);
  if (executionActive && !deadOwner) score = Math.max(score, 1_100);
  if (candidate.status === "waiting") score = Math.max(score, 1_040);
  if (candidate.status === "interrupted") score = Math.max(score, 1_000);
  if (candidate.status === "queued" || candidate.status === "assigned") score = Math.max(score, 940);
  if (failed) score = Math.max(score, 860);
  if (candidate.status === "implemented_not_verified") score = Math.max(score, 760);
  if (candidate.status === "created") score = Math.max(score, 620);
  if (candidate.status === "completed") score = Math.max(score, 180);
  if (candidate.status === "cancelled") score = Math.max(score, 80);

  if (deadOwner && candidate.status !== "interrupted") score -= 260;
  if (stale) score -= 720;
  else if (unknown && !stepActive(candidate) && !leaseActive(candidate)) score -= 120;

  return score;
}

function staleFailurePenalty(candidate: CurrentTaskCandidate, latestUpdatedAt: number): number {
  const validationStatus = candidate.outcome?.validation_status ?? candidate.acceptance_status ?? candidate.acceptance?.status ?? "not_requested";
  const failed = candidate.status === "failed"
    || validationStatus === "failed"
    || candidate.outcome?.execution_status === "failed";
  const updatedAt = Date.parse(candidate.updated_at);
  return failed && Number.isFinite(updatedAt) && latestUpdatedAt - updatedAt > 5 * 60_000 ? 800 : 0;
}

function staleInactivePendingPenalty(candidate: CurrentTaskCandidate, latestUpdatedAt: number): number {
  const inactivePending = ["interrupted", "implemented_not_verified"].includes(candidate.status)
    && ["stale", "stopped", "terminal"].includes(livenessState(candidate));
  const updatedAt = Date.parse(candidate.updated_at);
  return inactivePending && Number.isFinite(updatedAt) && latestUpdatedAt - updatedAt > 5 * 60_000 ? 900 : 0;
}

export function selectMostCurrentTask<T extends CurrentTaskCandidate>(candidates: T[]): T | undefined {
  const latestUpdatedAt = candidates.reduce((latest, candidate) => Math.max(latest, Date.parse(candidate.updated_at) || 0), 0);
  return [...candidates]
    .sort((left, right) => {
      const leftScore = currentTaskSelectionScore(left)
        - staleFailurePenalty(left, latestUpdatedAt)
        - staleInactivePendingPenalty(left, latestUpdatedAt);
      const rightScore = currentTaskSelectionScore(right)
        - staleFailurePenalty(right, latestUpdatedAt)
        - staleInactivePendingPenalty(right, latestUpdatedAt);
      const rank = rightScore - leftScore;
      return rank || Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.task_id.localeCompare(right.task_id);
    })[0];
}
