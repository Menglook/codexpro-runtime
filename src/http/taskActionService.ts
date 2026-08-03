import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resumeAsyncCompactTask, retryAsyncCompactTaskStep, cancelAsyncCompactTask } from "../asyncCompactTasks.js";
import { createCodexAdapter } from "../codex/adapterFactory.js";
import type { CodexProConfig } from "../config.js";
import { gitCurrentBranch, gitHeadSha } from "../gitOps.js";
import { PathGuard, type Workspace } from "../guard.js";
import { getGoalManager } from "../goals/goalManagerFactory.js";
import { evaluateUnifiedRisk, type UnifiedRiskDecision } from "../security/riskGate.js";
import { TaskProjectionService } from "../tasks/taskProjectionService.js";
import { gitPushOnly } from "../workflow/gitFinalize.js";
import { readLatestGitFinalizationRecord } from "../workflow/gitFinalizationState.js";
import type { TaskRecoveryPlan, TaskStatusProjection, UnifiedTaskStatus } from "../tasks/types.js";
import {
  consumeTaskActionNonce,
  issueTaskActionNonce,
  TaskActionConfirmationError,
  type TaskActionNonceBinding
} from "./taskActionConfirmation.js";
import {
  deriveDashboardTaskAvailableActions,
  discoverDashboardProjects,
  matchesProjectFilter,
  workspaceForDashboardProject,
  type DashboardProjectSummary
} from "./projectAggregationService.js";

const TASK_ACTION_ROOT = ".ai-bridge/console-actions/task-actions";
const IDEMPOTENCY_DIR = `${TASK_ACTION_ROOT}/idempotency`;
const AUDIT_DIR = `${TASK_ACTION_ROOT}/audit`;
const CONSUMED_NONCE_DIR = `${TASK_ACTION_ROOT}/consumed-nonces`;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const AUDIT_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_IDEMPOTENCY_FILES = 200;
const MAX_IDEMPOTENCY_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_FILES = 500;
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_NONCE_FILES = 500;
const MAX_NONCE_BYTES = 2 * 1024 * 1024;
const DETAIL_EVENT_LIMIT = 200;
const DETAIL_PATH_LIMIT = 100;
const SAFE_TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const UNIFIED_STATUSES = [
  "created",
  "queued",
  "assigned",
  "running",
  "waiting",
  "interrupted",
  "recovering",
  "implemented_not_verified",
  "validating",
  "completed",
  "failed",
  "cancelled"
] as const;

const TaskActionRequestSchema = z.object({
  action: z.enum(["resume", "cancel", "retry_step"]),
  idempotency_key: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  expected_status: z.enum(UNIFIED_STATUSES),
  step_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  confirm_manual: z.boolean().optional(),
  prompt: z.string().max(8_000).optional(),
  action_nonce: z.string().min(40).max(4_096).optional()
}).strict();

const TaskActionNonceRequestSchema = z.object({
  action: z.enum(["resume", "cancel", "retry_step"]),
  expected_status: z.enum(UNIFIED_STATUSES),
  step_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/).optional()
}).strict();

const GitRetryActionRequestSchema = z.object({
  action: z.literal("retry_push"),
  idempotency_key: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/)
}).strict();

type TaskActionRequest = z.infer<typeof TaskActionRequestSchema>;
type TaskActionName = TaskActionRequest["action"];

export interface TaskActionHttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface StoredActionResponse {
  http_status: number;
  body: Record<string, unknown>;
}

interface IdempotencyRecord {
  version: 1;
  state: "in_progress" | "completed";
  idempotency_key_hash: string;
  payload_hash: string;
  audit_id: string;
  created_at: string;
  updated_at: string;
  response?: StoredActionResponse;
}

interface IdempotencyReservation {
  relative_path: string;
  payload_hash: string;
  idempotency_key_hash: string;
}

interface ActionContext {
  workspace: Workspace;
  guard: PathGuard;
  request: TaskActionRequest;
  confirmation_verified: boolean;
}

export class TaskActionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TaskActionError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function clip(value: unknown, max = 2_000): string {
  return String(value ?? "").replace(/[\u0000\r]+/g, " ").slice(0, max);
}

function terminalStatus(status: UnifiedTaskStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "implemented_not_verified";
}

function normalizedGitIdentity(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized === "(no output)" || /git unavailable|not a git repository|fatal:|exited with status/i.test(normalized)) return null;
  return normalized;
}

function actionToolName(action: TaskActionName): string {
  if (action === "resume") return "task_resume";
  if (action === "cancel") return "task_cancel";
  return "retry_run_task_step";
}

function recoverySummary(recovery: TaskRecoveryPlan): Record<string, unknown> {
  return {
    task_id: recovery.task_id,
    kind: recovery.kind,
    status: recovery.status,
    mode: recovery.mode,
    resumable: recovery.resumable,
    automatic: recovery.automatic,
    action: recovery.action,
    current_step_id: recovery.current_step_id,
    last_completed_step_id: recovery.last_completed_step_id,
    next_step_id: recovery.next_step_id,
    idempotent: recovery.idempotent,
    retryable: recovery.retryable,
    side_effect_level: recovery.side_effect_level,
    retry_policy: recovery.retry_policy,
    rollback_method: recovery.rollback_method,
    required_checks: recovery.required_checks.slice(0, 20),
    reason: clip(recovery.reason, 1_000),
    generated_at: recovery.generated_at
  };
}

function projectionSummary(projection: TaskStatusProjection): Record<string, unknown> {
  return {
    identity: projection.identity,
    status: projection.status,
    domain_status: projection.domain_status,
    progress: projection.progress,
    liveness: projection.liveness,
    execution: projection.execution,
    acceptance: projection.acceptance,
    executor: projection.executor,
    changed_files_count: projection.changed_files_count ?? null,
    evidence_paths: projection.evidence_paths.slice(0, DETAIL_PATH_LIMIT),
    updated_at: projection.updated_at
  };
}

function activeExecutionConflict(projection: TaskStatusProjection): string | null {
  if (projection.liveness.state === "working" || projection.liveness.state === "silent") {
    return `Task liveness is ${projection.liveness.state}; concurrent resume or retry is not allowed.`;
  }
  const lease = projection.liveness.lease;
  if (lease?.active === true && lease.expired !== true && projection.liveness.heartbeat_fresh !== false) {
    return "Task has an active owner lease or fresh heartbeat; concurrent resume or retry is not allowed.";
  }
  return null;
}

function errorBody(
  auditId: string,
  code: string,
  message: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ok: false,
    audit_id: auditId,
    error: { code, message },
    ...extra
  };
}

async function atomicWriteJson(absPath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  const temporary = `${absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, absPath);
}

async function readJson<T>(absPath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(absPath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class TaskActionService {
  constructor(
    private readonly config: CodexProConfig,
    private readonly actionNonceSecret = randomBytes(32).toString("base64url")
  ) {}

  async getTimeline(taskId: string, projectSelector: string | undefined): Promise<Record<string, unknown>> {
    const context = await this.readContext(taskId, projectSelector);
    const timeline = (await context.service.getTimeline(taskId)).slice(-DETAIL_EVENT_LIMIT).map((event) => ({
      ...event,
      ...(event.summary ? { summary: clip(event.summary) } : {}),
      ...(event.evidence_paths ? { evidence_paths: event.evidence_paths.slice(0, DETAIL_PATH_LIMIT) } : {})
    }));
    return {
      ok: true,
      project_id: context.project.project_id,
      task_id: taskId,
      timeline,
      limit: DETAIL_EVENT_LIMIT
    };
  }

  async getEvidence(taskId: string, projectSelector: string | undefined): Promise<Record<string, unknown>> {
    const context = await this.readContext(taskId, projectSelector);
    const evidence = await context.service.getEvidence(taskId);
    return {
      ok: true,
      project_id: context.project.project_id,
      task_id: taskId,
      evidence: {
        ...evidence,
        artifact_paths: evidence.artifact_paths.slice(0, DETAIL_PATH_LIMIT),
        last_evidence: evidence.last_evidence ? clip(evidence.last_evidence, 1_000) : null
      },
      limit: DETAIL_PATH_LIMIT
    };
  }

  async getRecovery(taskId: string, projectSelector: string | undefined): Promise<Record<string, unknown>> {
    const context = await this.readContext(taskId, projectSelector);
    const projection = await this.statusOrNotFound(context.service, taskId);
    this.assertTaskProjectBinding(projection, context.project);
    const recovery = await context.service.getRecovery(taskId);
    return {
      ok: true,
      project_id: context.project.project_id,
      task_id: taskId,
      recovery: recoverySummary(recovery),
      available_actions: deriveDashboardTaskAvailableActions(projection, recovery)
    };
  }

  async issueActionNonce(
    taskId: string,
    projectSelector: string | undefined,
    rawBody: unknown,
    sessionBinding: string
  ): Promise<TaskActionHttpResult> {
    try {
      if (!SAFE_TASK_ID.test(taskId)) throw new TaskActionError(400, "invalid_task_id", "Task id is invalid.");
      const parsed = TaskActionNonceRequestSchema.safeParse(rawBody ?? {});
      if (!parsed.success) throw new TaskActionError(400, "invalid_task_action_nonce_request", "Task action nonce request is invalid.");
      const context = await this.readContext(taskId, projectSelector);
      const projection = await this.statusOrNotFound(context.service, taskId);
      const recovery = await context.service.getRecovery(taskId);
      if (projection.status !== parsed.data.expected_status) {
        throw new TaskActionError(409, "expected_status_conflict", `Task status is ${projection.status}, not ${parsed.data.expected_status}.`);
      }
      const descriptor = deriveDashboardTaskAvailableActions(projection, recovery).find((candidate) => (
        candidate.action === parsed.data.action
        && (candidate.step_id ?? null) === (parsed.data.step_id ?? null)
      ));
      if (!descriptor) throw new TaskActionError(422, "task_action_not_available", "This action is not available for the current authoritative task state.");
      if (!descriptor.action_nonce_required) {
        return { status: 200, body: { ok: true, action_nonce_required: false } };
      }
      const issued = issueTaskActionNonce(this.actionNonceSecret, {
        project_id: context.project.project_id,
        task_id: taskId,
        action: parsed.data.action,
        expected_status: parsed.data.expected_status,
        step_id: parsed.data.step_id,
        session_binding: sessionBinding
      });
      return {
        status: 200,
        body: {
          ok: true,
          project_id: context.project.project_id,
          task_id: taskId,
          action: parsed.data.action,
          expected_status: parsed.data.expected_status,
          step_id: parsed.data.step_id ?? null,
          action_nonce_required: true,
          ...issued
        }
      };
    } catch (error) {
      const taskError = error instanceof TaskActionError
        ? error
        : new TaskActionError(500, "task_action_nonce_internal_error", "Task action confirmation nonce could not be issued.");
      return { status: taskError.status, body: errorBody(randomUUID(), taskError.code, taskError.message) };
    }
  }

  async handleAction(
    taskId: string,
    projectSelector: string | undefined,
    rawBody: unknown,
    sessionBinding = "direct-service-session"
  ): Promise<TaskActionHttpResult> {
    const auditId = randomUUID();
    const startedAt = nowIso();
    let workspace = this.defaultWorkspace();
    let projectId: string | null = null;
    let action: string | null = typeof (rawBody as { action?: unknown } | null)?.action === "string"
      ? String((rawBody as { action: string }).action)
      : null;
    let expectedStatus: string | null = typeof (rawBody as { expected_status?: unknown } | null)?.expected_status === "string"
      ? String((rawBody as { expected_status: string }).expected_status)
      : null;
    let actualStatus: string | null = null;
    let reason = "request rejected before execution";
    let decision = "rejected";
    let risk: UnifiedRiskDecision | undefined;
    let reservation: IdempotencyReservation | undefined;
    let projection: TaskStatusProjection | undefined;
    let recovery: TaskRecoveryPlan | undefined;
    let confirmationVerified = false;
    const idempotencyKey = typeof (rawBody as { idempotency_key?: unknown } | null)?.idempotency_key === "string"
      ? String((rawBody as { idempotency_key: string }).idempotency_key)
      : "";
    const idempotencyKeyHash = idempotencyKey ? sha256(idempotencyKey) : null;

    const finish = async (status: number, body: Record<string, unknown>): Promise<TaskActionHttpResult> => {
      if (reservation) await this.completeIdempotency(workspace, reservation, { http_status: status, body });
      await this.writeAudit(workspace, {
        audit_id: auditId,
        timestamp: startedAt,
        project_id: projectId,
        task_id: SAFE_TASK_ID.test(taskId) ? taskId : null,
        action,
        idempotency_key_hash: idempotencyKeyHash ? idempotencyKeyHash.slice(0, 24) : null,
        expected_status: expectedStatus,
        actual_status: actualStatus,
        decision,
        reason: clip(reason, 1_000),
        result_status: status,
        risk_level: risk?.level ?? null,
        risk_reason_code: risk?.reason_code ?? null
      }).catch(() => undefined);
      return { status, body };
    };

    try {
      if (!SAFE_TASK_ID.test(taskId)) throw new TaskActionError(400, "invalid_task_id", "Task id is invalid.");
      const project = this.resolveRequiredProject(projectSelector);
      projectId = project.project_id;
      workspace = workspaceForDashboardProject(project);
      const guard = new PathGuard(this.config);
      const parsed = TaskActionRequestSchema.safeParse(rawBody ?? {});
      if (!parsed.success) {
        throw new TaskActionError(400, "invalid_task_action", "Task action request is invalid.");
      }
      action = parsed.data.action;
      expectedStatus = parsed.data.expected_status;
      await this.pruneState(workspace);

      const payloadHash = sha256(stableStringify({
        project_id: project.project_id,
        task_id: taskId,
        ...parsed.data
      }));
      const reserved = await this.reserveIdempotency(workspace, parsed.data.idempotency_key, payloadHash, auditId);
      if (reserved.kind === "replay") {
        decision = "idempotency_replay";
        reason = "Repeated idempotency key returned the first stored result.";
        return await finish(reserved.record.response!.http_status, reserved.record.response!.body);
      }
      if (reserved.kind === "conflict") {
        throw new TaskActionError(409, "idempotency_conflict", "This idempotency key is already bound to a different task action payload.");
      }
      if (reserved.kind === "in_progress") {
        throw new TaskActionError(423, "idempotency_in_progress", "This idempotency key is already executing.");
      }
      reservation = reserved.reservation;

      const service = new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
      const context: ActionContext = {
        workspace,
        guard,
        request: parsed.data,
        confirmation_verified: false
      };
      projection = await this.statusOrNotFound(service, taskId);
      this.assertTaskProjectBinding(projection, project);
      actualStatus = projection.status;
      recovery = await service.getRecovery(taskId);
      if (projection.status !== parsed.data.expected_status) {
        throw new TaskActionError(409, "expected_status_conflict", `Task status is ${projection.status}, not ${parsed.data.expected_status}.`);
      }
      const descriptor = deriveDashboardTaskAvailableActions(projection, recovery).find((candidate) => (
        candidate.action === parsed.data.action
        && (candidate.step_id ?? null) === (parsed.data.step_id ?? null)
      ));
      if (!descriptor) throw new TaskActionError(422, "task_action_not_available", "This action is not available for the current authoritative task state.");
      if (descriptor.action_nonce_required) {
        const token = parsed.data.action_nonce?.trim();
        if (!token) throw new TaskActionError(422, "action_nonce_required", "This task action requires a fresh confirmation nonce.");
        const binding: TaskActionNonceBinding = {
          project_id: project.project_id,
          task_id: taskId,
          action: parsed.data.action,
          expected_status: parsed.data.expected_status,
          step_id: parsed.data.step_id,
          session_binding: sessionBinding
        };
        try {
          await consumeTaskActionNonce(this.statePath(workspace, CONSUMED_NONCE_DIR), this.actionNonceSecret, token, binding);
          confirmationVerified = true;
        } catch (error) {
          if (error instanceof TaskActionConfirmationError) {
            throw new TaskActionError(error.code === "nonce_reused" ? 409 : 422, error.code, error.message);
          }
          throw error;
        }
      }
      context.confirmation_verified = confirmationVerified;
      risk = evaluateUnifiedRisk(actionToolName(parsed.data.action), {
        task_id: taskId,
        action: parsed.data.action,
        step_id: parsed.data.step_id,
        expected_status: parsed.data.expected_status,
        explicit_authorization: confirmationVerified || descriptor.confirmation_mode === "none"
      });
      if (!risk.allowed) throw new TaskActionError(403, "risk_gate_denied", risk.reason);

      const domainResult = await this.executeAction(context, projection, recovery);
      const latestProjection = await service.getStatus(taskId);
      const latestRecovery = await service.getRecovery(taskId).catch(() => recovery!);
      decision = "allowed";
      reason = "Task action executed through the authoritative manager.";
      actualStatus = latestProjection.status;
      return await finish(200, {
        ok: true,
        audit_id: auditId,
        project_id: project.project_id,
        task_id: taskId,
        action: parsed.data.action,
        projection: projectionSummary(latestProjection),
        recovery: recoverySummary(latestRecovery),
        available_actions: deriveDashboardTaskAvailableActions(latestProjection, latestRecovery),
        domain_result: domainResult
      });
    } catch (error) {
      const taskError = error instanceof TaskActionError
        ? error
        : new TaskActionError(500, "task_action_internal_error", "Task action failed before a safe domain result was produced.");
      reason = taskError.message;
      decision = "rejected";
      return await finish(taskError.status, errorBody(auditId, taskError.code, taskError.message, {
        ...(projectId ? { project_id: projectId } : {}),
        ...(SAFE_TASK_ID.test(taskId) ? { task_id: taskId } : {}),
        ...(action ? { action } : {}),
        ...(expectedStatus ? { expected_status: expectedStatus } : {}),
        ...(actualStatus ? { actual_status: actualStatus } : {}),
        ...(recovery ? { recovery: recoverySummary(recovery) } : {})
      }));
    }
  }

  async handleGitRetry(
    projectSelector: string | undefined,
    rawBody: unknown
  ): Promise<TaskActionHttpResult> {
    const auditId = randomUUID();
    const startedAt = nowIso();
    let workspace = this.defaultWorkspace();
    let projectId: string | null = null;
    let decision = "rejected";
    let reason = "request rejected before execution";
    let actualStatus: string | null = null;
    let risk: UnifiedRiskDecision | undefined;
    let reservation: IdempotencyReservation | undefined;
    const rawKey = typeof (rawBody as { idempotency_key?: unknown } | null)?.idempotency_key === "string"
      ? String((rawBody as { idempotency_key: string }).idempotency_key)
      : "";
    const idempotencyKeyHash = rawKey ? sha256(rawKey) : null;

    const finish = async (status: number, body: Record<string, unknown>): Promise<TaskActionHttpResult> => {
      if (reservation) await this.completeIdempotency(workspace, reservation, { http_status: status, body });
      await this.writeAudit(workspace, {
        audit_id: auditId,
        timestamp: startedAt,
        project_id: projectId,
        task_id: null,
        action: "retry_push",
        idempotency_key_hash: idempotencyKeyHash ? idempotencyKeyHash.slice(0, 24) : null,
        expected_status: "failed",
        actual_status: actualStatus,
        decision,
        reason: clip(reason, 1_000),
        result_status: status,
        risk_level: risk?.level ?? null,
        risk_reason_code: risk?.reason_code ?? null
      }).catch(() => undefined);
      return { status, body };
    };

    try {
      const project = this.resolveRequiredProject(projectSelector);
      projectId = project.project_id;
      workspace = workspaceForDashboardProject(project);
      const guard = new PathGuard(this.config);
      const parsed = GitRetryActionRequestSchema.safeParse(rawBody ?? {});
      if (!parsed.success) throw new TaskActionError(400, "invalid_git_retry_action", "Git retry request is invalid.");
      await this.pruneState(workspace);

      const payloadHash = sha256(stableStringify({ project_id: project.project_id, ...parsed.data }));
      const reserved = await this.reserveIdempotency(workspace, parsed.data.idempotency_key, payloadHash, auditId);
      if (reserved.kind === "replay") {
        decision = "idempotency_replay";
        reason = "Repeated idempotency key returned the first stored Git retry result.";
        return await finish(reserved.record.response!.http_status, reserved.record.response!.body);
      }
      if (reserved.kind === "conflict") throw new TaskActionError(409, "idempotency_conflict", "This idempotency key is already bound to a different action payload.");
      if (reserved.kind === "in_progress") throw new TaskActionError(423, "idempotency_in_progress", "This idempotency key is already executing.");
      reservation = reserved.reservation;

      risk = evaluateUnifiedRisk("git_push_only", {
        user_intent: "重新推送",
        action: "retry_push",
        explicit_authorization: true
      });
      if (!risk.allowed) throw new TaskActionError(403, "risk_gate_denied", risk.reason);

      const before = await readLatestGitFinalizationRecord(this.config, guard, workspace);
      if (!before) throw new TaskActionError(404, "git_finalization_not_found", "No persisted Git finalization state is available for this project.");
      actualStatus = before.push_status;
      if (!before.retry_available) {
        throw new TaskActionError(409, "git_push_not_retryable", `Git push status is ${before.push_status}; retry is not currently available.`);
      }
      const currentBranch = normalizedGitIdentity(gitCurrentBranch(this.config, workspace));
      const currentHead = normalizedGitIdentity(gitHeadSha(this.config, workspace));
      if (!before.branch || !before.local_commit_sha || currentBranch !== before.branch || currentHead !== before.local_commit_sha) {
        throw new TaskActionError(
          409,
          "git_retry_state_stale",
          "The current branch or HEAD no longer matches the persisted failed-push state. Create a new explicit Git finalization decision instead of retrying this stale state."
        );
      }

      const pushResult = await gitPushOnly(this.config, workspace, { userIntent: "重新推送" }, guard);
      const latest = await readLatestGitFinalizationRecord(this.config, guard, workspace);
      actualStatus = latest?.push_status ?? pushResult.push_status;
      decision = "allowed";
      reason = pushResult.ok
        ? "The persisted local commit was pushed without rerunning implementation or Acceptance."
        : "The retry action completed safely, but remote synchronization is still unsuccessful.";
      return await finish(200, {
        ok: pushResult.ok,
        audit_id: auditId,
        project_id: project.project_id,
        action: "retry_push",
        git_finalization: latest ?? before,
        push_result: {
          status: pushResult.status,
          reason_code: pushResult.reason_code,
          reasons: pushResult.reasons,
          branch: pushResult.branch ?? null,
          commit_status: pushResult.commit_status,
          push_status: pushResult.push_status,
          local_commit_sha: pushResult.local_commit_sha ?? null,
          remote_commit_sha: pushResult.remote_commit_sha ?? null,
          push_attempts: pushResult.push_attempts,
          push_transport: pushResult.push_transport ?? null,
          push_error_code: pushResult.push_error_code ?? null,
          duration_ms: pushResult.duration_ms
        }
      });
    } catch (error) {
      const actionError = error instanceof TaskActionError
        ? error
        : new TaskActionError(500, "git_retry_internal_error", "Git push retry failed before a safe result was produced.");
      reason = actionError.message;
      decision = "rejected";
      return await finish(actionError.status, errorBody(auditId, actionError.code, actionError.message, {
        ...(projectId ? { project_id: projectId } : {}),
        action: "retry_push",
        ...(actualStatus ? { actual_status: actualStatus } : {})
      }));
    }
  }

  async auditRejectedAttempt(input: {
    task_id?: string;
    project_id?: string;
    action?: string;
    expected_status?: string;
    reason: string;
    result_status: number;
  }): Promise<void> {
    await this.writeAudit(this.defaultWorkspace(), {
      audit_id: randomUUID(),
      timestamp: nowIso(),
      project_id: input.project_id ?? null,
      task_id: input.task_id && SAFE_TASK_ID.test(input.task_id) ? input.task_id : null,
      action: input.action ?? null,
      idempotency_key_hash: null,
      expected_status: input.expected_status ?? null,
      actual_status: null,
      decision: "rejected",
      reason: clip(input.reason, 1_000),
      result_status: input.result_status,
      risk_level: null,
      risk_reason_code: null
    }).catch(() => undefined);
  }

  private async readContext(taskId: string, projectSelector: string | undefined): Promise<{
    project: DashboardProjectSummary;
    workspace: Workspace;
    service: TaskProjectionService;
  }> {
    if (!SAFE_TASK_ID.test(taskId)) throw new TaskActionError(400, "invalid_task_id", "Task id is invalid.");
    const project = this.resolveRequiredProject(projectSelector);
    const workspace = workspaceForDashboardProject(project);
    const guard = new PathGuard(this.config);
    const service = new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
    const projection = await this.statusOrNotFound(service, taskId);
    this.assertTaskProjectBinding(projection, project);
    return { project, workspace, service };
  }

  private resolveRequiredProject(projectSelector: string | undefined): DashboardProjectSummary {
    const selector = projectSelector?.trim();
    if (!selector) throw new TaskActionError(400, "project_required", "Task project selector is required.");
    const matches = discoverDashboardProjects(this.config).filter((project) => matchesProjectFilter(project, selector));
    const available = matches.find((project) => project.available);
    if (available) return available;
    const unavailable = matches[0];
    if (unavailable?.unavailable_reason?.includes("outside configured allowed roots")) {
      throw new TaskActionError(403, "project_not_allowed", "Project root is outside configured allowed roots.");
    }
    throw new TaskActionError(404, "project_not_found", "Task project is not available.");
  }

  private async statusOrNotFound(service: TaskProjectionService, taskId: string): Promise<TaskStatusProjection> {
    try {
      return await service.getStatus(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|does not match|not the current/i.test(message)) {
        throw new TaskActionError(404, "task_not_found", "Task was not found in the selected project.");
      }
      throw error;
    }
  }

  private assertTaskProjectBinding(projection: TaskStatusProjection, project: DashboardProjectSummary): void {
    const taskRoot = path.resolve(projection.identity.project_root);
    const projectRoot = path.resolve(project.root);
    if (taskRoot !== projectRoot) {
      throw new TaskActionError(404, "task_not_found", "Task does not belong to the selected project.");
    }
  }

  private async executeAction(
    context: ActionContext,
    projection: TaskStatusProjection,
    recovery: TaskRecoveryPlan
  ): Promise<Record<string, unknown>> {
    const { request } = context;
    if (request.action === "cancel") return await this.executeCancel(context, projection);
    if (request.action === "resume") return await this.executeResume(context, projection, recovery);
    return await this.executeRetryStep(context, projection, recovery);
  }

  private async executeCancel(context: ActionContext, projection: TaskStatusProjection): Promise<Record<string, unknown>> {
    if (projection.identity.kind === "handoff") {
      throw new TaskActionError(422, "handoff_cancel_unsupported", "Handoff cancellation has no safe domain protocol and will not kill recorded PIDs.");
    }
    if (terminalStatus(projection.status)) {
      throw new TaskActionError(409, "task_terminal", `Task is terminal (${projection.status}) and cannot be cancelled from the console.`);
    }
    try {
      if (projection.identity.kind === "goal") {
        const adapter = createCodexAdapter(this.config);
        if (!adapter) throw new TaskActionError(409, "goal_adapter_unavailable", "Goal cancellation is unavailable because no Codex provider adapter is configured.");
        const goal = await getGoalManager(this.config, context.guard, context.workspace, adapter).cancel(projection.identity.domain_id);
        return { kind: "goal", goal_id: goal.goal_id, status: goal.status };
      }
      const state = await cancelAsyncCompactTask(this.config, context.guard, context.workspace, projection.identity.domain_id);
      return { kind: "durable_job", run_id: state.run_id, status: state.status, cancel_requested: state.cancel_requested };
    } catch (error) {
      if (error instanceof TaskActionError) throw error;
      throw new TaskActionError(409, "task_cancel_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async executeResume(
    context: ActionContext,
    projection: TaskStatusProjection,
    recovery: TaskRecoveryPlan
  ): Promise<Record<string, unknown>> {
    if (projection.identity.kind === "handoff") {
      throw new TaskActionError(422, "handoff_resume_unsupported", "Handoff execution is not replayed by the console.");
    }
    const conflict = activeExecutionConflict(projection);
    if (conflict) throw new TaskActionError(423, "task_owner_conflict", conflict);
    if (!recovery.resumable || recovery.mode === "none" || recovery.mode === "blocked") {
      throw new TaskActionError(409, "task_not_resumable", recovery.reason);
    }
    if (recovery.action !== "goal_resume" && recovery.action !== "resume_run_task") {
      throw new TaskActionError(422, "recovery_action_not_supported", `Recovery action ${recovery.action} cannot be executed by resume.`);
    }
    if (!recovery.automatic && context.confirmation_verified !== true) {
      throw new TaskActionError(422, "manual_confirmation_required", "Manual recovery requires a verified one-time confirmation nonce.");
    }
    try {
      if (projection.identity.kind === "goal") {
        if (recovery.action !== "goal_resume") throw new TaskActionError(422, "recovery_action_not_supported", `Unexpected Goal recovery action: ${recovery.action}.`);
        const adapter = createCodexAdapter(this.config);
        if (!adapter) throw new TaskActionError(409, "goal_adapter_unavailable", "Goal recovery is unavailable because no Codex provider adapter is configured.");
        const prompt = recovery.automatic
          ? "Resume the persisted validation or review checkpoint without replaying the implementation turn."
          : context.request.prompt?.trim() ?? "";
        if (!prompt) throw new TaskActionError(400, "prompt_required", "Manual Goal recovery requires a non-empty prompt.");
        const goal = await getGoalManager(this.config, context.guard, context.workspace, adapter).resume({
          goal_id: projection.identity.domain_id,
          prompt,
          idempotency_key: context.request.idempotency_key
        });
        return { kind: "goal", goal_id: goal.goal_id, status: goal.status };
      }
      if (recovery.action !== "resume_run_task") throw new TaskActionError(422, "recovery_action_not_supported", `Unexpected Durable Job recovery action: ${recovery.action}.`);
      const state = await resumeAsyncCompactTask(this.config, context.guard, context.workspace, projection.identity.domain_id);
      return { kind: "durable_job", run_id: state.run_id, status: state.status, current_step_id: state.current_step_id };
    } catch (error) {
      if (error instanceof TaskActionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/owned by another|currently owned|owner/i.test(message)) throw new TaskActionError(423, "task_owner_conflict", message);
      throw new TaskActionError(409, "task_resume_failed", message);
    }
  }

  private async executeRetryStep(
    context: ActionContext,
    projection: TaskStatusProjection,
    recovery: TaskRecoveryPlan
  ): Promise<Record<string, unknown>> {
    if (projection.identity.kind !== "durable_job") {
      throw new TaskActionError(422, "retry_step_unsupported", "Retry step is available only for Durable Jobs.");
    }
    const conflict = activeExecutionConflict(projection);
    if (conflict) throw new TaskActionError(423, "task_owner_conflict", conflict);
    const stepId = context.request.step_id;
    if (!stepId) throw new TaskActionError(400, "step_id_required", "retry_step requires step_id.");
    const plannedStep = recovery.current_step_id ?? recovery.next_step_id;
    if (stepId !== recovery.current_step_id && stepId !== recovery.next_step_id) {
      throw new TaskActionError(409, "step_id_conflict", `Step ${stepId} does not match the recovery plan step ${plannedStep ?? "none"}.`);
    }
    if (recovery.action !== "retry_run_task_step") {
      throw new TaskActionError(422, "recovery_action_not_supported", `Recovery action ${recovery.action} cannot be executed by retry_step.`);
    }
    if (recovery.mode === "manual" && context.confirmation_verified !== true) {
      throw new TaskActionError(422, "manual_confirmation_required", "Manual retry requires a verified one-time confirmation nonce.");
    }
    if (recovery.idempotent !== true || recovery.retryable !== true || recovery.retry_policy === "never") {
      throw new TaskActionError(422, "step_not_retryable", "Recovery plan does not mark the step as idempotent and retryable.");
    }
    if (recovery.side_effect_level === "external_write" || recovery.side_effect_level === "unknown") {
      throw new TaskActionError(422, "unsafe_side_effect_level", `Retry is not allowed for side_effect_level=${recovery.side_effect_level}.`);
    }
    try {
      const state = await retryAsyncCompactTaskStep(this.config, context.guard, context.workspace, projection.identity.domain_id, stepId);
      return { kind: "durable_job", run_id: state.run_id, status: state.status, current_step_id: state.current_step_id, retry_step_id: stepId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/owned by another|currently owned|owner/i.test(message)) throw new TaskActionError(423, "task_owner_conflict", message);
      throw new TaskActionError(409, "retry_step_failed", message);
    }
  }

  private defaultWorkspace(): Workspace {
    return {
      id: "default",
      root: this.config.defaultRoot,
      openedAt: new Date().toISOString()
    };
  }

  private statePath(workspace: Workspace, relPath: string): string {
    return new PathGuard(this.config).resolve(workspace, relPath, { forWrite: true }).absPath;
  }

  private async reserveIdempotency(
    workspace: Workspace,
    key: string,
    payloadHash: string,
    auditId: string
  ): Promise<
    | { kind: "reserved"; reservation: IdempotencyReservation }
    | { kind: "replay"; record: IdempotencyRecord }
    | { kind: "conflict" }
    | { kind: "in_progress" }
  > {
    const keyHash = sha256(key);
    const relativePath = `${IDEMPOTENCY_DIR}/${keyHash}.json`;
    const absPath = this.statePath(workspace, relativePath);
    const createdAt = nowIso();
    const record: IdempotencyRecord = {
      version: 1,
      state: "in_progress",
      idempotency_key_hash: keyHash,
      payload_hash: payloadHash,
      audit_id: auditId,
      created_at: createdAt,
      updated_at: createdAt
    };
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fsp.open(absPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return {
          kind: "reserved",
          reservation: {
            relative_path: relativePath,
            payload_hash: payloadHash,
            idempotency_key_hash: keyHash
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readJson<IdempotencyRecord>(absPath);
        const createdMs = Date.parse(existing?.created_at ?? "");
        if (!Number.isFinite(createdMs) || Date.now() - createdMs > IDEMPOTENCY_TTL_MS) {
          await fsp.rm(absPath, { force: true });
          continue;
        }
        if (existing?.payload_hash !== payloadHash) return { kind: "conflict" };
        if (existing.state === "completed" && existing.response) return { kind: "replay", record: existing };
        return { kind: "in_progress" };
      }
    }
    return { kind: "in_progress" };
  }

  private async completeIdempotency(
    workspace: Workspace,
    reservation: IdempotencyReservation,
    response: StoredActionResponse
  ): Promise<void> {
    const absPath = this.statePath(workspace, reservation.relative_path);
    const existing = await readJson<IdempotencyRecord>(absPath);
    const completed: IdempotencyRecord = {
      version: 1,
      state: "completed",
      idempotency_key_hash: reservation.idempotency_key_hash,
      payload_hash: reservation.payload_hash,
      audit_id: existing?.audit_id ?? randomUUID(),
      created_at: existing?.created_at ?? nowIso(),
      updated_at: nowIso(),
      response
    };
    await atomicWriteJson(absPath, completed);
  }

  private async writeAudit(workspace: Workspace, record: Record<string, unknown>): Promise<void> {
    await this.pruneAudit(workspace);
    const auditId = typeof record.audit_id === "string" ? record.audit_id : randomUUID();
    const relPath = `${AUDIT_DIR}/${new Date().toISOString().slice(0, 10)}-${auditId}.json`;
    const absPath = this.statePath(workspace, relPath);
    await atomicWriteJson(absPath, {
      version: 1,
      ...record
    });
  }

  private async pruneState(workspace: Workspace): Promise<void> {
    await Promise.all([
      this.pruneDir(workspace, IDEMPOTENCY_DIR, {
        ttlMs: IDEMPOTENCY_TTL_MS,
        maxFiles: MAX_IDEMPOTENCY_FILES,
        maxBytes: MAX_IDEMPOTENCY_BYTES
      }),
      this.pruneDir(workspace, CONSUMED_NONCE_DIR, {
        ttlMs: IDEMPOTENCY_TTL_MS,
        maxFiles: MAX_NONCE_FILES,
        maxBytes: MAX_NONCE_BYTES
      }),
      this.pruneAudit(workspace)
    ]);
  }

  private async pruneAudit(workspace: Workspace): Promise<void> {
    await this.pruneDir(workspace, AUDIT_DIR, {
      ttlMs: AUDIT_TTL_MS,
      maxFiles: MAX_AUDIT_FILES,
      maxBytes: MAX_AUDIT_BYTES
    });
  }

  private async pruneDir(
    workspace: Workspace,
    relDir: string,
    limits: { ttlMs: number; maxFiles: number; maxBytes: number }
  ): Promise<void> {
    const absDir = this.statePath(workspace, relDir);
    let entries: Array<{ name: string; absPath: string; mtimeMs: number; size: number }> = [];
    try {
      const dirents = await fsp.readdir(absDir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isFile() || !dirent.name.endsWith(".json")) continue;
        const absPath = path.join(absDir, dirent.name);
        const stat = await fsp.stat(absPath).catch(() => undefined);
        if (!stat?.isFile()) continue;
        entries.push({ name: dirent.name, absPath, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.mtimeMs > limits.ttlMs) await fsp.rm(entry.absPath, { force: true });
    }
    entries = entries.filter((entry) => now - entry.mtimeMs <= limits.ttlMs);
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let totalBytes = 0;
    for (const [index, entry] of entries.entries()) {
      totalBytes += entry.size;
      if (index >= limits.maxFiles || totalBytes > limits.maxBytes) await fsp.rm(entry.absPath, { force: true });
    }
  }
}
