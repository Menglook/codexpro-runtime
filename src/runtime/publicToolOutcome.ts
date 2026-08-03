import { createHash } from "node:crypto";
import { redactSensitiveText } from "../redact.js";
import { classifyAggregateToolCall } from "../workflow/aggregateExecutionMode.js";
import {
  deriveOrthogonalToolOutcome,
  hasOrthogonalToolOutcome,
  publicStatusFromOrthogonal,
  type CanonicalToolOutcomeV1,
  type OrthogonalToolOutcomeV1
} from "./orthogonalToolOutcome.js";

export const PUBLIC_TOOL_CATEGORIES = ["read", "write", "validation", "browser", "git", "report", "other"] as const;
export type PublicToolCategory = typeof PUBLIC_TOOL_CATEGORIES[number];
export type PublicToolOutcomeStatus = "completed" | "failed" | "blocked" | "degraded";
export type PublicToolActorRole = "executor" | "reviewer" | "observer" | "system";

export interface PublicToolOutcomeFindingV1 {
  kind: "finding" | "warning";
  summary: string;
  evidence_refs: string[];
}

export interface PublicToolOutcomeV1 extends OrthogonalToolOutcomeV1 {
  version: 1;
  canonical_outcome: CanonicalToolOutcomeV1;
  event_id: string;
  correlation_id: string;
  idempotency_key: string;
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  conversation_ref: string;
  task_id: string | null;
  objective_id: string | null;
  attempt_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  actor_role: PublicToolActorRole;
  tool_name: string;
  tool_category: PublicToolCategory;
  phase: string;
  status: PublicToolOutcomeStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  public_title: string;
  public_summary: string;
  result_metrics: Record<string, string | number | boolean | null>;
  findings: PublicToolOutcomeFindingV1[];
  evidence_refs: string[];
  result_digest: string;
  redaction_applied: boolean;
  truncated: boolean;
  state_authority_changed: false;
}

export interface StoredPublicToolOutcomeV1 extends PublicToolOutcomeV1 {
  sequence: number;
  persisted_at: string;
}

export interface OfficeProjectionReceiptV1 {
  version: 1;
  event_id: string;
  projection_status: "queued" | "persisted" | "projected" | "degraded";
  result_digest: string;
  sequence: number | null;
  state_authority_changed: false;
}

export interface PublicToolActivityBinding {
  observer_only: boolean;
  call_role?: "executor" | "observer";
  task_id?: string;
  run_id?: string;
  phase?: string;
  terminal?: boolean;
  observer_session_id?: string;
  correlation_id?: string;
  status?: string;
}

export interface NormalizePublicToolOutcomeInput {
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  conversation_id?: string | null;
  objective_id?: string | null;
  attempt_id?: string | null;
  actor_id?: string | null;
  actor_role?: PublicToolActorRole;
  correlation_id: string;
  tool_name: string;
  phase?: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  outcome: "ok" | "error";
  args?: unknown;
  result?: unknown;
  canonical_outcome?: CanonicalToolOutcomeV1;
  binding?: PublicToolActivityBinding | null;
}

const FORBIDDEN_KEYS = new Set([
  "prompt",
  "prompts",
  "message",
  "messages",
  "system_prompt",
  "developer_prompt",
  "chain_of_thought",
  "reasoning",
  "authorization",
  "authorization_header",
  "cookie",
  "cookies",
  "codexpro_token",
  "api_token",
  "token",
  "password",
  "private_key",
  "secret",
  "environment",
  "env"
]);
const MAX_EVIDENCE = 20;
const MAX_SUMMARY = 1_000;
const MAX_METRICS = 40;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function shortDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

function cleanIdentifier(value: unknown, fallback: string, max = 240): string {
  const normalized = String(value ?? "")
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return normalized || fallback;
}

function safeText(value: unknown, fallback: string, max = MAX_SUMMARY): { value: string; redacted: boolean; truncated: boolean } {
  const raw = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const redacted = redactSensitiveText(raw);
  const clipped = (redacted || fallback).slice(0, max);
  return { value: clipped, redacted: redacted !== raw, truncated: (redacted || fallback).length > max };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structuredResult(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const structured = record(outer.structuredContent);
  if (Object.keys(structured).length) return structured;
  return outer;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function publicToolCategory(toolName: string, args?: unknown): PublicToolCategory {
  const name = toolName.toLowerCase();
  if (name.startsWith("browser_")) return "browser";
  if (/(?:^|_)(?:git|commit|push)(?:_|$)/.test(name)) return "git";
  if (/(?:test|smoke|lint|typecheck|build|acceptance|validation|healthcheck)/.test(name)) return "validation";
  if (["write", "edit", "apply_patch_bundle"].includes(name)) return "write";
  if (["publish_task_report", "publish_task_update"].includes(name)) return "report";
  if (["run_task", "run_stage"].includes(name)) {
    const aggregate = classifyAggregateToolCall(name, args);
    if (aggregate?.mode === "analysis_only") return aggregate.archive_requested ? "write" : "read";
    const input = record(args);
    if (Array.isArray(input.patches) && input.patches.length) return "write";
    if (Array.isArray(input.commands) && input.commands.length) return "validation";
  }
  if ([
    "open_current_workspace", "open_workspace", "read", "read_many_files", "search", "search_project", "tree",
    "show_changes", "dirty_guard", "detect_project", "read_rule_summary", "read_project_config", "read_project_profile",
    "read_project_memory", "summarize_project_memory", "read_handoff"
  ].includes(name)) return "read";
  return "other";
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.length > 4_096 || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

function collectEvidence(data: Record<string, unknown>): string[] {
  const candidates: unknown[] = [];
  for (const key of ["report_path", "path", "evidence_path", "snapshot_path", "output_path", "boss_report_path", "technical_report_path"]) {
    if (data[key] !== undefined) candidates.push(data[key]);
  }
  for (const key of ["evidence_paths", "files", "artifacts"]) {
    const value = data[key];
    if (Array.isArray(value)) candidates.push(...value.map((item) => typeof item === "string" ? item : record(item).path));
  }
  return [...new Set(candidates.map(safeRelativePath).filter((item): item is string => Boolean(item)))].slice(0, MAX_EVIDENCE);
}

function resultMetrics(toolName: string, category: PublicToolCategory, data: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const metrics: Record<string, string | number | boolean | null> = {};
  const put = (key: string, value: string | number | boolean | null | undefined) => {
    if (value === undefined || Object.keys(metrics).length >= MAX_METRICS) return;
    metrics[key] = value;
  };
  if (["search", "search_project"].includes(toolName)) {
    const queries = Array.isArray(data.queries) ? data.queries.map(record) : [];
    put("query_count", numeric(data.query_count) ?? queries.length);
    put("match_count", numeric(data.match_count) ?? numeric(data.matches_count) ?? queries.reduce((sum, query) => sum + countArray(query.matches), 0));
    put("file_count", numeric(data.unique_files) ?? numeric(data.files_scanned) ?? queries.reduce((sum, query) => sum + (numeric(query.unique_files) ?? 0), 0));
    put("truncated", boolean(data.truncated) ?? queries.some((query) => query.truncated === true));
  } else if (["read", "read_many_files"].includes(toolName)) {
    put("file_count", numeric(data.file_count) ?? (Array.isArray(data.files) ? data.files.length : data.path ? 1 : 0));
    put("total_lines", numeric(data.totalLines ?? data.total_lines));
    put("truncated", boolean(data.truncated) ?? boolean(data.codexpro_payload_truncated));
  } else if (["write", "edit", "apply_patch_bundle"].includes(toolName) || category === "write") {
    put("file_count", numeric(data.file_count) ?? countArray(data.changed_files) ?? (data.path ? 1 : null));
    put("additions", numeric(data.additions));
    put("deletions", numeric(data.deletions));
    put("replacement_count", numeric(data.replacements ?? data.replacement_count));
    put("changed", boolean(data.changed) ?? true);
  } else if (category === "validation") {
    put("passed", boolean(data.passed) ?? boolean(data.success));
    put("exit_code", numeric(data.exitCode ?? data.exit_code));
    put("command_count", numeric(data.command_count) ?? countArray(data.commands));
    put("failure_count", numeric(data.failure_count) ?? countArray(data.failures));
  } else if (category === "browser") {
    put("url", typeof data.url === "string" ? safeText(data.url, "", 500).value : null);
    put("passed", boolean(data.passed) ?? boolean(data.ok));
    put("error_count", numeric(data.error_count) ?? countArray(data.errors));
    put("failed_request_count", numeric(data.failed_request_count) ?? countArray(data.failed_requests));
  } else if (toolName === "show_changes" || toolName === "dirty_guard") {
    put("changed", boolean(data.changed));
    put("changed_file_count", numeric(data.changed_file_count) ?? countArray(data.changed_files));
    put("additions", numeric(data.additions));
    put("deletions", numeric(data.deletions));
  }
  const status = typeof data.status === "string" ? safeText(data.status, "", 120).value : undefined;
  if (status) put("result_status", status);
  return metrics;
}

function titleFor(category: PublicToolCategory, status: PublicToolOutcomeStatus): string {
  if (status === "blocked") return "工具调用被安全门禁阻止";
  if (status === "failed") return "工具执行失败";
  switch (category) {
    case "read": return "项目资料读取完成";
    case "write": return "项目修改完成";
    case "validation": return "验证工具执行完成";
    case "browser": return "浏览器检查完成";
    case "git": return "Git 操作完成";
    case "report": return "公开任务说明已发布";
    default: return "工具调用完成";
  }
}

function summaryFor(toolName: string, category: PublicToolCategory, status: PublicToolOutcomeStatus, data: Record<string, unknown>, metrics: Record<string, string | number | boolean | null>): string {
  for (const key of ["public_summary", "safe_summary", "summary", "message", "reason", "status"]) {
    if (typeof data[key] === "string" && data[key]?.trim()) return safeText(data[key], titleFor(category, status)).value;
  }
  if (status === "blocked") return `${toolName} 已被安全门禁阻止。`;
  if (status === "failed") {
    const exit = metrics.exit_code;
    return exit === null || exit === undefined ? `${toolName} 执行失败。` : `${toolName} 执行失败，退出码 ${exit}。`;
  }
  if (["search", "search_project"].includes(toolName)) return `检索完成，找到 ${metrics.match_count ?? 0} 个匹配，涉及 ${metrics.file_count ?? 0} 个文件。`;
  if (["read", "read_many_files"].includes(toolName)) return `已读取 ${metrics.file_count ?? 0} 个文件。`;
  if (category === "write") return `已完成项目修改，涉及 ${metrics.file_count ?? 1} 个文件。`;
  if (category === "validation") return metrics.passed === false ? "验证未通过。" : "验证命令已完成。";
  if (category === "browser") return Number(metrics.error_count ?? 0) > 0 || Number(metrics.failed_request_count ?? 0) > 0 ? "浏览器检查发现异常。" : "浏览器检查未发现已记录异常。";
  if (category === "git") return "Git 操作已返回结果。";
  if (category === "report") return "ChatGPT 公开任务说明已写入回报中心。";
  return `${toolName} 已完成。`;
}

function containsRedactedMaterial(value: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (typeof value === "string") return redactSensitiveText(value) !== value;
  if (Array.isArray(value)) return value.slice(0, 100).some((item) => containsRedactedMaterial(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).slice(0, 100).some(([key, item]) =>
    FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[-\s]/g, "_")) || containsRedactedMaterial(item, depth + 1)
  );
}

function sanitizedFindings(data: Record<string, unknown>, evidence: string[]): PublicToolOutcomeFindingV1[] {
  const raw = Array.isArray(data.findings) ? data.findings : [];
  const out: PublicToolOutcomeFindingV1[] = [];
  for (const item of raw.slice(0, 10)) {
    const entry = record(item);
    const summary = safeText(entry.summary ?? entry.message ?? item, "发现一项工具结果", 500).value;
    const refs = collectEvidence(entry);
    if (!refs.length && !evidence.length) continue;
    out.push({ kind: String(entry.kind ?? "finding") === "warning" ? "warning" : "finding", summary, evidence_refs: refs.length ? refs : evidence });
  }
  return out;
}

export function normalizePublicToolOutcome(input: NormalizePublicToolOutcomeInput): PublicToolOutcomeV1 {
  const data = structuredResult(input.result);
  const category = publicToolCategory(input.tool_name, input.args);
  const canonicalOutcome = input.canonical_outcome ?? deriveOrthogonalToolOutcome({
    outcome: input.outcome,
    result: input.result,
    tool_category: category,
    operation_type: category === "validation" ? "validate" : category
  });
  const status = publicStatusFromOrthogonal(canonicalOutcome);
  const metrics = resultMetrics(input.tool_name, category, data);
  const evidence = collectEvidence(data);
  const titleResult = safeText(titleFor(category, status), "工具结果");
  const summaryResult = safeText(summaryFor(input.tool_name, category, status, data, metrics), titleResult.value);
  const findings = sanitizedFindings(data, evidence);
  const binding = input.binding ?? null;
  const actorRole: PublicToolActorRole = binding?.observer_only ? "observer" : input.actor_role ?? "executor";
  const taskId = binding?.observer_only ? null : binding?.task_id ?? null;
  const runId = binding?.observer_only ? null : binding?.run_id ?? null;
  const objectiveId = binding?.observer_only ? null : input.objective_id ?? taskId;
  const attemptId = binding?.observer_only ? null : input.attempt_id ?? taskId;
  const conversationRef = `sha256:${createHash("sha256").update(String(input.conversation_id ?? "unbound")).digest("hex")}`;
  const core = {
    project_id: cleanIdentifier(input.project_id, "project"),
    workspace_id: cleanIdentifier(input.workspace_id, "workspace"),
    workspace_generation: Math.max(1, Math.floor(input.workspace_generation || 1)),
    conversation_ref: conversationRef,
    task_id: taskId,
    objective_id: objectiveId,
    attempt_id: attemptId,
    run_id: runId,
    actor_id: input.actor_id ? cleanIdentifier(input.actor_id, "actor") : null,
    actor_role: actorRole,
    tool_name: cleanIdentifier(input.tool_name, "tool"),
    tool_category: category,
    phase: safeText(binding?.phase ?? input.phase ?? category, category, 120).value,
    canonical_outcome: canonicalOutcome,
    ...canonicalOutcome,
    status,
    started_at: input.started_at,
    completed_at: input.completed_at,
    duration_ms: Math.max(0, Math.floor(input.duration_ms)),
    public_title: titleResult.value,
    public_summary: summaryResult.value,
    result_metrics: metrics,
    findings,
    evidence_refs: evidence,
    redaction_applied: titleResult.redacted || summaryResult.redacted || containsRedactedMaterial(data),
    truncated: titleResult.truncated || summaryResult.truncated || data.codexpro_payload_truncated === true || metrics.truncated === true,
    state_authority_changed: false as const
  };
  const resultDigest = digest(core);
  const eventId = `tool-result:${shortDigest({ correlation_id: input.correlation_id, tool_name: input.tool_name, result_digest: resultDigest })}`;
  return {
    version: 1,
    event_id: eventId,
    correlation_id: cleanIdentifier(input.correlation_id, eventId, 300),
    idempotency_key: `office-tool-result:${eventId}`,
    ...core,
    result_digest: resultDigest
  };
}

function basePublicToolOutcomeV1(value: unknown): value is Record<string, unknown> {
  const item = record(value);
  return item.version === 1
    && typeof item.event_id === "string"
    && typeof item.correlation_id === "string"
    && typeof item.result_digest === "string"
    && typeof item.project_id === "string"
    && typeof item.workspace_id === "string"
    && Number.isInteger(item.workspace_generation)
    && typeof item.tool_name === "string"
    && (PUBLIC_TOOL_CATEGORIES as readonly string[]).includes(String(item.tool_category))
    && ["completed", "failed", "blocked", "degraded"].includes(String(item.status))
    && item.state_authority_changed === false;
}

export function upgradePublicToolOutcomeV1(value: unknown): PublicToolOutcomeV1 | null {
  if (!basePublicToolOutcomeV1(value)) return null;
  if (hasOrthogonalToolOutcome(value)) {
    const item = value as Record<string, unknown>;
    return {
      ...item,
      canonical_outcome: hasOrthogonalToolOutcome(item.canonical_outcome) ? item.canonical_outcome : Object.freeze({
        security_status: item.security_status,
        resource_status: item.resource_status,
        execution_status: item.execution_status,
        recovery_status: item.recovery_status,
        validation_status: item.validation_status,
        delivery_status: item.delivery_status,
        permission_decision_id: item.permission_decision_id ?? null,
        effective_side_effect_level: item.effective_side_effect_level ?? null,
        resource_lease_id: item.resource_lease_id ?? null,
        workspace_baseline_id: item.workspace_baseline_id ?? null,
        confirmation_receipt_id: item.confirmation_receipt_id ?? null,
        tool_schema_digest: item.tool_schema_digest ?? null,
        retryable: item.retryable,
        reason_code: item.reason_code ?? null,
        state_authority: item.state_authority ?? "legacy_inference"
      })
    } as unknown as PublicToolOutcomeV1;
  }
  const item = value as Record<string, unknown>;
  const legacyStatus = String(item.status);
  const legacyCategory = String(item.tool_category);
  const orthogonal = deriveOrthogonalToolOutcome({
    outcome: legacyStatus === "failed" || legacyStatus === "blocked" ? "error" : "ok",
    tool_category: legacyCategory,
    operation_type: legacyCategory === "validation" ? "validate" : legacyCategory,
    result: {
      structuredContent: {
        status: legacyStatus === "degraded" ? "recovery_required" : legacyStatus,
        security_status: legacyStatus === "blocked" ? "denied" : "allowed",
        resource_status: "unknown",
        execution_status: legacyStatus === "blocked" ? "not_started" : legacyStatus === "failed" ? "failed" : "completed",
        recovery_status: legacyStatus === "degraded" ? "retryable" : legacyStatus === "failed" ? "not_recoverable" : "not_required",
        validation_status: legacyCategory !== "validation"
          ? "not_requested"
          : legacyStatus === "failed" ? "failed" : legacyStatus === "degraded" ? "pending" : "passed",
        delivery_status: legacyCategory === "git" ? "delivery_unknown" : "not_requested"
      }
    }
  });
  return { ...item, ...orthogonal } as unknown as PublicToolOutcomeV1;
}

export function isPublicToolOutcomeV1(value: unknown): value is PublicToolOutcomeV1 {
  return upgradePublicToolOutcomeV1(value) !== null;
}

export function sanitizePublicToolOutcomePayload(value: PublicToolOutcomeV1): PublicToolOutcomeV1 {
  const sanitized = JSON.parse(JSON.stringify(value, (key, item) => FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[-\s]/g, "_")) ? undefined : item)) as PublicToolOutcomeV1;
  const title = safeText(sanitized.public_title, "工具结果", 200);
  const summary = safeText(sanitized.public_summary, "工具结果已更新", MAX_SUMMARY);
  sanitized.public_title = title.value;
  sanitized.public_summary = summary.value;
  sanitized.redaction_applied = sanitized.redaction_applied || title.redacted || summary.redacted;
  sanitized.truncated = sanitized.truncated || title.truncated || summary.truncated;
  sanitized.findings = sanitized.findings.slice(0, 10).map((finding) => ({
    kind: finding.kind === "warning" ? "warning" : "finding",
    summary: safeText(finding.summary, "发现一项工具结果", 500).value,
    evidence_refs: finding.evidence_refs.map(safeRelativePath).filter((item): item is string => Boolean(item)).slice(0, MAX_EVIDENCE)
  }));
  sanitized.evidence_refs = sanitized.evidence_refs.map(safeRelativePath).filter((item): item is string => Boolean(item)).slice(0, MAX_EVIDENCE);
  sanitized.result_metrics = Object.fromEntries(Object.entries(sanitized.result_metrics).slice(0, MAX_METRICS));
  sanitized.state_authority_changed = false;
  return sanitized;
}
