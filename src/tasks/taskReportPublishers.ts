import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import type { AcceptanceRunResult } from "../workflow/acceptanceEngine.js";
import type { GitFinalizationRecord } from "../workflow/gitFinalizationState.js";
import { TaskReportEventStore } from "./taskReportEventStore.js";
import type { TaskReportEventKind, TaskReportSeverity } from "./taskReportTypes.js";

function identifier(value: string, fallback: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return normalized || fallback;
}

function projectId(workspace: Workspace): string {
  return identifier(path.basename(workspace.root), workspace.id);
}

function taskId(runId: string): string {
  return `job-${identifier(runId, "unknown-run")}`;
}

function stableIdempotencyKey(value: string): string {
  return `publisher-${createHash("sha256").update(value).digest("hex")}`;
}

async function appendAcceptanceEvent(
  guard: PathGuard,
  workspace: Workspace,
  input: {
    runId: string;
    eventKind: TaskReportEventKind;
    severity: TaskReportSeverity;
    title: string;
    summary: string;
    idempotencyKey: string;
    sourceRef: string;
    evidencePaths?: string[];
    occurredAt?: string;
  }
): Promise<void> {
  try {
    await new TaskReportEventStore(guard, workspace).append({
      idempotency_key: stableIdempotencyKey(input.idempotencyKey),
      project_id: projectId(workspace),
      objective_key: `legacy:acceptance:${identifier(input.runId, "unknown-run")}`,
      task_id: taskId(input.runId),
      run_id: identifier(input.runId, "unknown-run"),
      attempt_id: taskId(input.runId),
      stage_key: "acceptance",
      stage_title: "验收",
      event_kind: input.eventKind,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      detail_markdown: null,
      evidence_paths: input.evidencePaths ?? [],
      source_kind: "acceptance",
      source_ref: input.sourceRef,
      occurred_at: input.occurredAt ?? new Date().toISOString()
    });
  } catch {
    // Acceptance artifacts remain authoritative when the optional report projection fails.
  }
}

export async function publishAcceptanceStarted(
  guard: PathGuard,
  workspace: Workspace,
  runId: string,
  profile: string,
  sourceRef: string
): Promise<void> {
  await appendAcceptanceEvent(guard, workspace, {
    runId,
    eventKind: "validation_started",
    severity: "info",
    title: "验收开始",
    summary: `正在执行验收配置 ${profile}。`,
    idempotencyKey: `acceptance:${runId}:started:${profile}`,
    sourceRef
  });
}

export async function publishAcceptanceOutcome(
  guard: PathGuard,
  workspace: Workspace,
  runId: string,
  result: AcceptanceRunResult,
  resultPath: string,
  phase = "completed"
): Promise<void> {
  const conclusion: { eventKind: TaskReportEventKind; severity: TaskReportSeverity; title: string; summary: string } = result.status === "passed"
    ? {
        eventKind: "validation_passed",
        severity: "success",
        title: "验收通过",
        summary: `验收已通过，共执行 ${result.commands.length} 个命令。`
      }
    : result.status === "failed"
      ? {
          eventKind: "validation_failed",
          severity: "error",
          title: "验收失败",
          summary: `验收未通过，${result.commands.filter((command) => command.blocked || command.exitCode !== 0).length} 个命令失败或被阻断。`
        }
      : result.status === "skipped"
        ? {
            eventKind: "warning",
            severity: "warning",
            title: "验收未执行",
            summary: "当前配置没有可执行的验收检查，不能据此宣称验收通过。"
          }
        : {
            eventKind: "blocked",
            severity: "error",
            title: "验收被阻断",
            summary: result.status === "blocked_by_bash_policy"
              ? "验收被命令安全策略阻断。"
              : "验收被资源策略阻断。"
          };
  const evidencePaths = [...new Set([result.report_path, resultPath])];
  await appendAcceptanceEvent(guard, workspace, {
    runId,
    ...conclusion,
    idempotencyKey: `acceptance:${runId}:${phase}:${result.status}:${result.artifact_digest ?? result.cache_key ?? "no-digest"}`,
    sourceRef: resultPath,
    evidencePaths
  });
  await appendAcceptanceEvent(guard, workspace, {
    runId,
    eventKind: "artifact_created",
    severity: "success",
    title: "验收报告已保存",
    summary: `验收报告已保存至 ${result.report_path}。`,
    idempotencyKey: `acceptance:${runId}:${phase}:artifact:${result.report_path}`,
    sourceRef: resultPath,
    evidencePaths
  });
}

function changedFilesMarkdown(record: GitFinalizationRecord): string | null {
  if (!record.changed_files.length) return null;
  return ["## 修改文件", "", ...record.changed_files.slice(0, 200).map((file) => `- \`${file.replaceAll("`", "")}\``)].join("\n");
}

async function appendGitEvent(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  record: GitFinalizationRecord,
  input: {
    eventKind: "git_committed" | "git_pushed" | "git_failed" | "warning";
    severity: TaskReportSeverity;
    title: string;
    summary: string;
    idempotencyKey: string;
  }
): Promise<void> {
  if (!record.source_run_id) return;
  const runId = identifier(record.source_run_id, "unknown-run");
  const statePath = `${config.contextDir}/git-finalization/latest.json`;
  const evidencePaths = record.acceptance_report_path ? [record.acceptance_report_path] : [];
  try {
    await new TaskReportEventStore(guard, workspace).append({
      idempotency_key: stableIdempotencyKey(input.idempotencyKey),
      project_id: projectId(workspace),
      objective_key: `legacy:durable_job:${runId}`,
      task_id: taskId(runId),
      run_id: runId,
      attempt_id: taskId(runId),
      stage_key: "git-delivery",
      stage_title: "Git 交付",
      event_kind: input.eventKind,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      detail_markdown: changedFilesMarkdown(record),
      evidence_paths: evidencePaths,
      source_kind: "git",
      source_ref: statePath,
      occurred_at: record.updated_at
    });
  } catch {
    // Git finalization state remains authoritative when report projection fails.
  }
}

export async function publishGitFinalizationEvents(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  record: GitFinalizationRecord
): Promise<void> {
  if (!record.source_run_id) return;
  if (record.commit_status === "completed") {
    await appendGitEvent(config, guard, workspace, record, {
      eventKind: "git_committed",
      severity: "success",
      title: "Git 提交完成",
      summary: record.local_commit_sha
        ? `本地提交 ${record.local_commit_sha.slice(0, 12)} 已创建，共 ${record.changed_files.length} 个文件。`
        : `本地提交已完成，共 ${record.changed_files.length} 个文件。`,
      idempotencyKey: `git:${record.source_run_id}:commit:${record.local_commit_sha ?? "unknown"}`
    });
  }
  if (record.push_status === "completed" || record.push_status === "already_synced") {
    await appendGitEvent(config, guard, workspace, record, {
      eventKind: "git_pushed",
      severity: "success",
      title: record.last_action === "git_push_only" ? "重新推送成功" : "Git 推送完成",
      summary: record.remote_commit_sha
        ? `远端已同步提交 ${record.remote_commit_sha.slice(0, 12)}。`
        : "远端分支已与本地提交同步。",
      idempotencyKey: `git:${record.source_run_id}:push:${record.remote_commit_sha ?? record.local_commit_sha ?? "synced"}`
    });
  } else if (record.commit_status === "failed" || record.push_status === "failed") {
    await appendGitEvent(config, guard, workspace, record, {
      eventKind: "git_failed",
      severity: "error",
      title: record.push_status === "failed" ? "Git 推送失败" : "Git 提交失败",
      summary: record.reason,
      idempotencyKey: `git:${record.source_run_id}:failed:${record.last_action}:${record.reason_code}:${record.push_attempts}`
    });
  }
}

export async function publishGitRetryStarted(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  record: GitFinalizationRecord
): Promise<void> {
  await appendGitEvent(config, guard, workspace, record, {
    eventKind: "warning",
    severity: "warning",
    title: "开始重新推送",
    summary: "保留既有本地提交，只重试远端推送。",
    idempotencyKey: `git:${record.source_run_id ?? "unlinked"}:retry-started:${record.local_commit_sha ?? "unknown"}:${record.push_attempts + 1}`
  });
}
