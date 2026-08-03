import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { deriveGitDeliveryStatus, type TaskDeliveryStatus } from "../runtime/taskOutcome.js";
import { publishGitFinalizationEvents } from "../tasks/taskReportPublishers.js";
import type { GitPushErrorCode, GitPushTransport } from "./gitPushTransport.js";

export type PersistedGitCommitStatus = "not_started" | "completed" | "failed";
export type PersistedGitPushStatus = "not_requested" | "waiting_security_baseline" | "already_synced" | "completed" | "failed";
export type GitFinalizationAction = "git_commit" | "git_finalize" | "git_push_only";
export type GitFinalizationImplementationStatus = "completed" | "unknown";
export type GitFinalizationAcceptanceStatus = "passed" | "skipped" | "unknown";

export interface GitFinalizationRecord {
  version: 1;
  project_root: string;
  source_run_id: string | null;
  acceptance_report_path: string | null;
  implementation_status: GitFinalizationImplementationStatus;
  acceptance_status: GitFinalizationAcceptanceStatus;
  branch: string | null;
  changed_files: string[];
  commit_status: PersistedGitCommitStatus;
  push_status: PersistedGitPushStatus;
  delivery_status: TaskDeliveryStatus;
  local_commit_sha: string | null;
  remote_commit_sha: string | null;
  commit_message: string | null;
  push_transport: GitPushTransport | null;
  push_attempts: number;
  push_error_code: GitPushErrorCode | null;
  push_started_at?: string | null;
  git_process_exited_at?: string | null;
  tool_returned_at?: string | null;
  push_duration_ms?: number | null;
  reason_code: string;
  reason: string;
  retry_available: boolean;
  last_action: GitFinalizationAction;
  updated_at: string;
}

export interface GitFinalizationRecordInput {
  source_run_id?: string | null;
  acceptance_report_path?: string | null;
  implementation_status?: GitFinalizationImplementationStatus;
  acceptance_status?: GitFinalizationAcceptanceStatus;
  branch?: string | null;
  changed_files?: string[];
  commit_status: PersistedGitCommitStatus;
  push_status: PersistedGitPushStatus;
  delivery_status?: TaskDeliveryStatus;
  local_commit_sha?: string | null;
  remote_commit_sha?: string | null;
  commit_message?: string | null;
  push_transport?: GitPushTransport | null;
  push_attempts?: number;
  push_error_code?: GitPushErrorCode | null;
  push_started_at?: string | null;
  git_process_exited_at?: string | null;
  tool_returned_at?: string | null;
  push_duration_ms?: number | null;
  reason_code: string;
  reason?: string | null;
  last_action: GitFinalizationAction;
}

function stateRelPath(config: CodexProConfig): string {
  return `${config.contextDir}/git-finalization/latest.json`;
}

function safeString(value: unknown, max = 2_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactSensitiveText(value).replace(/[\u0000\r]+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeStringArray(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\\/g, "/").trim())
    .filter(Boolean))].slice(0, max);
}

function retryAvailable(commitStatus: PersistedGitCommitStatus, pushStatus: PersistedGitPushStatus): boolean {
  return commitStatus === "completed" && (pushStatus === "failed" || pushStatus === "waiting_security_baseline");
}

function isRecord(value: unknown): value is GitFinalizationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.project_root === "string"
    && (record.source_run_id === null || typeof record.source_run_id === "string")
    && (record.acceptance_report_path === null || typeof record.acceptance_report_path === "string")
    && (record.implementation_status === "completed" || record.implementation_status === "unknown")
    && (record.acceptance_status === "passed" || record.acceptance_status === "skipped" || record.acceptance_status === "unknown")
    && (record.branch === null || typeof record.branch === "string")
    && Array.isArray(record.changed_files)
    && record.changed_files.every((item) => typeof item === "string")
    && (record.commit_status === "not_started" || record.commit_status === "completed" || record.commit_status === "failed")
    && (record.push_status === "not_requested" || record.push_status === "waiting_security_baseline" || record.push_status === "already_synced" || record.push_status === "completed" || record.push_status === "failed")
    && (record.delivery_status === undefined || ["not_requested", "not_ready", "ready", "committed", "push_waiting_security_baseline", "pushed", "failed", "delivery_unknown"].includes(String(record.delivery_status)))
    && (record.local_commit_sha === null || typeof record.local_commit_sha === "string")
    && (record.remote_commit_sha === null || typeof record.remote_commit_sha === "string")
    && (record.commit_message === null || typeof record.commit_message === "string")
    && (record.push_transport === null || typeof record.push_transport === "string")
    && Number.isInteger(record.push_attempts)
    && Number(record.push_attempts) >= 0
    && (record.push_error_code === null || typeof record.push_error_code === "string")
    && (record.push_started_at === undefined || record.push_started_at === null || typeof record.push_started_at === "string")
    && (record.git_process_exited_at === undefined || record.git_process_exited_at === null || typeof record.git_process_exited_at === "string")
    && (record.tool_returned_at === undefined || record.tool_returned_at === null || typeof record.tool_returned_at === "string")
    && (record.push_duration_ms === undefined || record.push_duration_ms === null || (typeof record.push_duration_ms === "number" && record.push_duration_ms >= 0))
    && typeof record.reason_code === "string"
    && typeof record.reason === "string"
    && typeof record.retry_available === "boolean"
    && (record.last_action === "git_commit" || record.last_action === "git_finalize" || record.last_action === "git_push_only")
    && typeof record.updated_at === "string";
}

export async function readLatestGitFinalizationRecord(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<GitFinalizationRecord | undefined> {
  try {
    const resolved = guard.resolve(workspace, stateRelPath(config));
    const parsed: unknown = JSON.parse(await fsp.readFile(resolved.absPath, "utf8"));
    if (!isRecord(parsed)) return undefined;
    if (path.resolve(parsed.project_root) !== path.resolve(workspace.root)) return undefined;
    return {
      ...parsed,
      delivery_status: parsed.delivery_status ?? deriveGitDeliveryStatus({
        commit_status: parsed.commit_status,
        push_status: parsed.push_status,
        reason_code: parsed.reason_code,
        push_error_code: parsed.push_error_code
      })
    };
  } catch {
    return undefined;
  }
}

export async function writeLatestGitFinalizationRecord(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: GitFinalizationRecordInput
): Promise<GitFinalizationRecord> {
  const commitStatus = input.commit_status;
  const pushStatus = input.push_status;
  const record: GitFinalizationRecord = {
    version: 1,
    project_root: path.resolve(workspace.root),
    source_run_id: safeString(input.source_run_id, 200),
    acceptance_report_path: safeString(input.acceptance_report_path, 1_000),
    implementation_status: input.implementation_status ?? "unknown",
    acceptance_status: input.acceptance_status ?? "unknown",
    branch: safeString(input.branch, 300),
    changed_files: safeStringArray(input.changed_files),
    commit_status: commitStatus,
    push_status: pushStatus,
    delivery_status: input.delivery_status ?? deriveGitDeliveryStatus({
      commit_status: commitStatus,
      push_status: pushStatus,
      reason_code: input.reason_code,
      push_error_code: input.push_error_code
    }),
    local_commit_sha: safeString(input.local_commit_sha, 200),
    remote_commit_sha: safeString(input.remote_commit_sha, 200),
    commit_message: safeString(input.commit_message, 300),
    push_transport: input.push_transport ?? null,
    push_attempts: Math.max(0, Math.floor(Number(input.push_attempts ?? 0) || 0)),
    push_error_code: input.push_error_code ?? null,
    push_started_at: safeString(input.push_started_at, 100),
    git_process_exited_at: safeString(input.git_process_exited_at, 100),
    tool_returned_at: safeString(input.tool_returned_at, 100),
    push_duration_ms: input.push_duration_ms === null || input.push_duration_ms === undefined
      ? null
      : Math.max(0, Math.floor(Number(input.push_duration_ms) || 0)),
    reason_code: safeString(input.reason_code, 200) ?? "git_finalization_unknown",
    reason: safeString(input.reason, 2_000) ?? "Git finalization state was updated.",
    retry_available: retryAvailable(commitStatus, pushStatus),
    last_action: input.last_action,
    updated_at: new Date().toISOString()
  };
  const resolved = guard.resolve(workspace, stateRelPath(config), { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  const temporary = `${resolved.absPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, resolved.absPath);
  await publishGitFinalizationEvents(config, guard, workspace, record);
  return record;
}
