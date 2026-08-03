import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { PathGuard, type Workspace } from "../guard.js";
import { TaskProjectionService } from "../tasks/taskProjectionService.js";
import { TaskReportEventStore, type TaskReportReadResultV1 } from "../tasks/taskReportEventStore.js";
import { isSafeTaskReportRelativePath, type TaskReportEventKind, type TaskReportSeverity, type TaskReportSourceKind } from "../tasks/taskReportTypes.js";
import type { TaskStatusProjection } from "../tasks/types.js";
import {
  discoverDashboardProjects,
  workspaceForDashboardProject,
  type DashboardProjectSummary
} from "./projectAggregationService.js";

export class OfficeReportServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OfficeReportServiceError";
  }
}

export interface OfficeReportEventQuery {
  project: string;
  taskId: string;
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export interface OfficeReportListEvent extends Omit<TaskReportReadResultV1["events"][number], "detail_markdown"> {
  detail_markdown: null;
  detail_available: boolean;
}

export interface OfficeReportEventResponse extends Omit<TaskReportReadResultV1, "events"> {
  ok: true;
  task_id: string;
  project_id: string;
  events: OfficeReportListEvent[];
  revision: string;
}

export interface OfficeReportDetailResponse {
  ok: true;
  task_id: string;
  project_id: string;
  sequence: number;
  detail_markdown: string | null;
  detail_available: boolean;
  revision: string;
}

export interface OfficeReportStageResponse {
  ok: true;
  task_id: string;
  project_id: string;
  latest_sequence: number;
  stages: Awaited<ReturnType<TaskReportEventStore["readStages"]>>;
  revision: string;
}

function finiteSequence(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new OfficeReportServiceError(400, "invalid_report_query", `${field} must be a non-negative integer.`);
  return value;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new OfficeReportServiceError(400, "invalid_report_query", "limit must be an integer from 1 to 100.");
  }
  return value;
}

function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function sourceRef(config: CodexProConfig, task: TaskStatusProjection): string {
  if (task.identity.kind === "durable_job") return `.codexpro/runs/${task.identity.domain_id}/job.json`;
  if (task.identity.kind === "goal") return `${config.contextDir}/goals/${task.identity.domain_id}/goal.json`;
  return `${config.contextDir}/handoff/status.json`;
}

function backfillConclusion(task: TaskStatusProjection): {
  eventKind: TaskReportEventKind;
  severity: TaskReportSeverity;
  title: string;
  summary: string;
} | null {
  switch (task.status) {
    case "completed":
      return { eventKind: "task_completed", severity: "success", title: "历史任务已完成", summary: task.progress.current_action || "历史任务已完成。" };
    case "failed":
      return { eventKind: "task_failed", severity: "error", title: "历史任务失败", summary: task.progress.wait_reason || task.progress.current_action || "历史任务以失败状态结束。" };
    case "cancelled":
      return { eventKind: "task_cancelled", severity: "warning", title: "历史任务已取消", summary: task.progress.wait_reason || "历史任务已取消。" };
    case "waiting":
      return { eventKind: "waiting_user", severity: "action_required", title: "历史任务正在等待", summary: task.progress.wait_reason || task.progress.current_action || "任务正在等待人工处理。" };
    case "recovering":
      return { eventKind: "recovery_started", severity: "warning", title: "历史任务正在恢复", summary: task.progress.wait_reason || task.progress.current_action || "任务正在恢复。" };
    case "interrupted":
      return { eventKind: "blocked", severity: "error", title: "历史任务已中断", summary: task.progress.wait_reason || task.progress.current_action || "任务执行已中断。" };
    case "implemented_not_verified":
      return { eventKind: "warning", severity: "action_required", title: "实现尚未验收", summary: "已有实现证据，但尚无通过的验收证据。" };
    case "running":
    case "validating":
    case "assigned":
    case "queued":
      return { eventKind: "progress", severity: "info", title: "历史任务状态已补建", summary: task.progress.current_action || task.progress.phase || task.status };
    default:
      return null;
  }
}

export class OfficeReportService {
  constructor(readonly config: CodexProConfig) {}

  private async auditRejectedRead(
    project: DashboardProjectSummary,
    workspace: Workspace,
    guard: PathGuard,
    taskId: string,
    reasonCode: "task_not_found" | "task_project_mismatch"
  ): Promise<void> {
    const auditId = randomUUID();
    const occurredAt = new Date().toISOString();
    const relativePath = `.codexpro/task-reports/security-audit/${occurredAt.slice(0, 10)}-${auditId}.json`;
    let temporary: string | undefined;
    try {
      const target = guard.resolve(workspace, relativePath, { forWrite: true });
      await fsp.mkdir(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
      temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      await fsp.writeFile(temporary, `${JSON.stringify({
        version: 1,
        audit_id: auditId,
        occurred_at: occurredAt,
        action: "office_report_read",
        outcome: "rejected",
        reason_code: reasonCode,
        project_id: project.project_id,
        task_id_hash: `sha256:${createHash("sha256").update(taskId).digest("hex")}`
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, target.absPath);
    } catch {
      if (temporary) await fsp.rm(temporary, { force: true }).catch(() => undefined);
      // Audit persistence must not reveal additional project or task information in the HTTP response.
    }
  }

  private project(selector: string): DashboardProjectSummary {
    const requested = selector.trim();
    if (!requested) throw new OfficeReportServiceError(400, "project_required", "project is required.");
    const matches = discoverDashboardProjects(this.config).filter((project) =>
      project.project_id === requested
      || project.name === requested
      || path.resolve(project.root) === path.resolve(requested)
    );
    if (matches.length !== 1 || !matches[0].available) {
      throw new OfficeReportServiceError(404, "project_not_found", "The requested Office project is unavailable or ambiguous.");
    }
    return matches[0];
  }

  private async authoritativeTask(
    project: DashboardProjectSummary,
    workspace: Workspace,
    guard: PathGuard,
    taskId: string
  ): Promise<TaskStatusProjection | null> {
    try {
      return await new TaskProjectionService(this.config, guard, workspace, { readOnly: true }).getStatus(taskId);
    } catch {
      const runId = taskId.startsWith("job-") ? taskId.slice(4) : "";
      if (!runId || !/^[a-z0-9._-]{1,200}$/i.test(runId)) return null;
      const candidates = [
        `.codexpro/runs/${runId}/job.json`,
        `${this.config.contextDir}/acceptance-runs/${runId}/job.json`
      ];
      for (const candidate of candidates) {
        try {
          const resolved = guard.resolve(workspace, candidate);
          if ((await fsp.stat(resolved.absPath)).isFile()) return null;
        } catch {
          // Try the next authoritative task path.
        }
      }
      throw new OfficeReportServiceError(404, "task_not_found", `Task ${taskId} does not belong to project ${project.project_id}.`);
    }
  }

  private async backfill(
    project: DashboardProjectSummary,
    store: TaskReportEventStore,
    task: TaskStatusProjection
  ): Promise<void> {
    const identity = task.identity;
    const ref = sourceRef(this.config, task);
    const evidencePaths = task.evidence_paths.filter(isSafeTaskReportRelativePath).slice(0, 20);
    const sourceKind = identity.kind as TaskReportSourceKind;
    await store.append({
      idempotency_key: `backfill-${identity.task_id}-started`,
      project_id: project.project_id,
      objective_key: identity.objective?.objective_key ?? `legacy:${identity.kind}:${identity.domain_id}`,
      task_id: identity.task_id,
      run_id: identity.kind === "durable_job" ? identity.domain_id : null,
      attempt_id: identity.task_id,
      stage_key: identity.objective?.stage_key ?? null,
      stage_title: identity.objective?.stage_key ?? null,
      event_kind: "task_started",
      severity: "info",
      title: "历史任务已纳入回报中心",
      summary: identity.title,
      detail_markdown: null,
      evidence_paths: [],
      source_kind: sourceKind,
      source_ref: ref,
      occurred_at: identity.created_at
    });
    const conclusion = backfillConclusion(task);
    if (conclusion) {
      await store.append({
        idempotency_key: `backfill-${identity.task_id}-${task.status}`,
        project_id: project.project_id,
        objective_key: identity.objective?.objective_key ?? `legacy:${identity.kind}:${identity.domain_id}`,
        task_id: identity.task_id,
        run_id: identity.kind === "durable_job" ? identity.domain_id : null,
        attempt_id: identity.task_id,
        stage_key: identity.objective?.stage_key ?? null,
        stage_title: identity.objective?.stage_key ?? null,
        event_kind: conclusion.eventKind,
        severity: conclusion.severity,
        title: conclusion.title,
        summary: conclusion.summary,
        detail_markdown: null,
        evidence_paths: evidencePaths,
        source_kind: sourceKind,
        source_ref: ref,
        occurred_at: task.updated_at
      });
    }
    await store.rebuild(identity.task_id, 1);
  }

  private async context(projectSelector: string, taskId: string): Promise<{
    project: DashboardProjectSummary;
    workspace: Workspace;
    store: TaskReportEventStore;
  }> {
    const project = this.project(projectSelector);
    const workspace = workspaceForDashboardProject(project);
    const guard = new PathGuard(this.config);
    const store = new TaskReportEventStore(guard, workspace);
    const cached = await store.readCachedSummary(taskId).catch(() => null);
    let task: TaskStatusProjection | null;
    try {
      task = await this.authoritativeTask(project, workspace, guard, taskId);
    } catch (error) {
      if (error instanceof OfficeReportServiceError && error.code === "task_not_found") {
        await this.auditRejectedRead(project, workspace, guard, taskId, "task_not_found");
      }
      throw error;
    }
    if (!cached && task) await this.backfill(project, store, task);
    const first = await store.readEvents(taskId, { afterSequence: 0, limit: 1 });
    if (!first.events.length) throw new OfficeReportServiceError(404, "report_not_found", `No report events exist for task ${taskId}.`);
    const acceptedProjectIds = new Set([project.project_id, project.name, workspace.id]);
    if (!acceptedProjectIds.has(first.events[0].project_id)) {
      await this.auditRejectedRead(project, workspace, guard, taskId, "task_project_mismatch");
      throw new OfficeReportServiceError(409, "task_project_mismatch", "Task report project binding does not match the requested project.");
    }
    return { project, workspace, store };
  }

  async events(query: OfficeReportEventQuery): Promise<OfficeReportEventResponse> {
    const afterSequence = finiteSequence(query.afterSequence, "after_sequence");
    const beforeSequence = finiteSequence(query.beforeSequence, "before_sequence");
    if (afterSequence !== undefined && beforeSequence !== undefined) {
      throw new OfficeReportServiceError(400, "invalid_report_query", "after_sequence and before_sequence cannot be combined.");
    }
    const limit = boundedLimit(query.limit);
    const { project, store } = await this.context(query.project, query.taskId);
    const result = await store.readEvents(query.taskId, { afterSequence, beforeSequence, limit });
    const events: OfficeReportListEvent[] = result.events.map((event) => ({
      ...event,
      detail_markdown: null,
      detail_available: Boolean(event.detail_markdown)
    }));
    const responseRevision = revision({
      task_id: query.taskId,
      latest_sequence: result.latest_sequence,
      invalid_line_count: result.invalid_line_count,
      incomplete_tail: result.incomplete_tail,
      selected: events.map((event) => event.event_id)
    });
    return { ok: true, task_id: query.taskId, project_id: project.project_id, ...result, events, revision: responseRevision };
  }

  async detail(projectSelector: string, taskId: string, sequenceInput: number): Promise<OfficeReportDetailResponse> {
    const sequence = finiteSequence(sequenceInput, "sequence");
    if (!sequence) throw new OfficeReportServiceError(400, "invalid_report_query", "sequence must be a positive integer.");
    const { project, store } = await this.context(projectSelector, taskId);
    const result = await store.readEvents(taskId, { afterSequence: sequence - 1, limit: 1 });
    const event = result.events[0];
    if (!event || event.sequence !== sequence) {
      throw new OfficeReportServiceError(404, "report_event_not_found", `Report event ${sequence} was not found.`);
    }
    const responseRevision = revision({
      task_id: taskId,
      event_id: event.event_id,
      sequence,
      detail_markdown: event.detail_markdown
    });
    return {
      ok: true,
      task_id: taskId,
      project_id: project.project_id,
      sequence,
      detail_markdown: event.detail_markdown,
      detail_available: Boolean(event.detail_markdown),
      revision: responseRevision
    };
  }

  async stages(projectSelector: string, taskId: string): Promise<OfficeReportStageResponse> {
    const { project, store } = await this.context(projectSelector, taskId);
    const [summary, stages] = await Promise.all([store.readSummary(taskId), store.readStages(taskId)]);
    const responseRevision = revision({ task_id: taskId, latest_sequence: summary.latest_sequence, stages });
    return {
      ok: true,
      task_id: taskId,
      project_id: project.project_id,
      latest_sequence: summary.latest_sequence,
      stages,
      revision: responseRevision
    };
  }
}
