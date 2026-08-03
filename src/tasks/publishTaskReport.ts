import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { TaskProjectionService } from "./taskProjectionService.js";
import { TaskReportEventStore } from "./taskReportEventStore.js";
import type { TaskReportEventKind, TaskReportSeverity } from "./taskReportTypes.js";

export interface PublishTaskReportInput {
  taskId: string;
  idempotencyKey: string;
  eventKind: Extract<TaskReportEventKind, "assistant_progress" | "assistant_summary" | "finding" | "warning">;
  severity: TaskReportSeverity;
  title: string;
  summary: string;
  detailMarkdown: string | null;
  evidencePaths: string[];
}

function identifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
  return normalized || fallback;
}

function projectId(workspace: Workspace): string {
  return identifier(path.basename(workspace.root), workspace.id);
}

function stableIdempotencyKey(taskId: string, key: string): string {
  return `chatgpt-${createHash("sha256").update(`${taskId}\0${key}`).digest("hex")}`;
}

export async function publishTaskReport(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: PublishTaskReportInput
) {
  let task;
  try {
    task = await new TaskProjectionService(config, guard, workspace, { readOnly: true }).getStatus(input.taskId);
  } catch {
    throw new Error("The requested task does not exist in the active workspace.");
  }
  if (task.identity.task_id !== input.taskId) {
    throw new Error("The requested task binding does not match the active workspace.");
  }

  const evidencePaths = [...new Set(input.evidencePaths)];
  for (const evidencePath of evidencePaths) {
    let stat;
    try {
      const resolved = guard.resolve(workspace, evidencePath);
      stat = await fsp.stat(resolved.absPath);
    } catch {
      throw new Error(`Evidence path is unavailable inside the active workspace: ${evidencePath}`);
    }
    if (!stat.isFile()) throw new Error(`Evidence path must identify a file: ${evidencePath}`);
  }

  const runId = task.identity.kind === "durable_job" ? task.identity.domain_id : null;
  const store = new TaskReportEventStore(guard, workspace);
  const result = await store.append({
    idempotency_key: stableIdempotencyKey(input.taskId, input.idempotencyKey),
    project_id: projectId(workspace),
    objective_key: task.identity.objective?.objective_key ?? `legacy:${task.identity.kind}:${identifier(task.identity.domain_id, "unknown")}`,
    task_id: task.identity.task_id,
    run_id: runId,
    attempt_id: task.identity.task_id,
    stage_key: null,
    stage_title: null,
    event_kind: input.eventKind,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    detail_markdown: input.detailMarkdown,
    evidence_paths: evidencePaths,
    source_kind: "chatgpt",
    source_ref: "chatgpt:publish_task_report",
    occurred_at: new Date().toISOString()
  });
  const redactionApplied = result.event.title !== input.title
    || result.event.summary !== input.summary
    || result.event.detail_markdown !== input.detailMarkdown
    || JSON.stringify(result.event.evidence_paths) !== JSON.stringify(evidencePaths);
  return {
    appended: result.appended,
    reason: result.reason,
    event: result.event,
    summary: result.summary,
    redaction_applied: redactionApplied,
    state_authority_changed: false
  };
}
