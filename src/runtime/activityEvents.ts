import { createHash } from "node:crypto";
import { redactSensitiveText } from "../redact.js";

export const RUNTIME_ACTIVITY_STATES = [
  "model_active",
  "tool_reading",
  "tool_writing",
  "validating",
  "delivering",
  "idle_between_steps",
  "waiting_user",
  "stalled",
  "terminal",
  "unknown"
] as const;

export type RuntimeActivityState = typeof RUNTIME_ACTIVITY_STATES[number];
export type RuntimeActivitySource = "model_stream" | "tool_process" | "worker" | "task_runtime" | "projection";
export type RuntimeNoProgressLevel = "fresh" | "quiet" | "stalled" | "severe" | "unknown";

export interface RuntimeUserActionRequiredV1 {
  version: 1;
  required: true;
  action_type: string;
  label: string;
  prompt: string;
  since: string;
  evidence_ref: string | null;
}

export interface RuntimeActivityEventV1 {
  version: 1;
  event_id: string;
  task_id: string | null;
  run_id: string | null;
  source: RuntimeActivitySource;
  activity_state: RuntimeActivityState;
  safe_summary: string;
  occurred_at: string;
  meaningful_progress: boolean;
  evidence_ref: string | null;
  user_action_required: RuntimeUserActionRequiredV1 | null;
}

export const AUTHORITATIVE_RUNTIME_EVENT_KINDS = [
  "workspace.activated",
  "office.workspace_conflict",
  "objective.created",
  "attempt.started",
  "analysis.started",
  "edit.started",
  "edit.completed",
  "validation.started",
  "validation.passed",
  "validation.failed",
  "validation.blocked",
  "resource.acquired",
  "resource.released",
  "attempt.superseded",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.blocked",
  "tool.cancelled",
  "tool.result_projected",
  "objective.completed"
] as const;

export type AuthoritativeRuntimeEventKind = typeof AUTHORITATIVE_RUNTIME_EVENT_KINDS[number];

export interface RuntimeActivityEventV2 {
  version: 2;
  event_id: string;
  sequence: number;
  occurred_at: string;
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  objective_id: string | null;
  attempt_id: string | null;
  run_id: string | null;
  actor_id: string | null;
  actor_role: "executor" | "reviewer" | "observer" | "system";
  kind: AuthoritativeRuntimeEventKind;
  terminal: boolean;
  payload: Record<string, unknown>;
}

export interface RuntimeActivityReplayStateV2 {
  version: 2;
  objective_id: string;
  latest_sequence: number;
  terminal_sequence: number | null;
  terminal_kind: AuthoritativeRuntimeEventKind | null;
  current_attempt_id: string | null;
  latest_kind: AuthoritativeRuntimeEventKind;
  updated_at: string;
}

export interface RuntimeNoProgressAssessment {
  level: RuntimeNoProgressLevel;
  duration_ms: number | null;
  activity_state: RuntimeActivityState;
  label: string;
}

const ACTIVITY_STATE_SET = new Set<string>(RUNTIME_ACTIVITY_STATES);
const PUBLIC_SUMMARY_KEYS = ["safe_summary", "public_summary", "progress_summary", "checkpoint_summary", "summary"] as const;
const PUBLIC_TOOL_NAME_KEYS = ["tool_name", "tool", "name"] as const;

export const NO_PROGRESS_QUIET_MS = 60_000;
export const NO_PROGRESS_STALLED_MS = 180_000;
export const NO_PROGRESS_SEVERE_MS = 300_000;

export function cleanRuntimeActivityText(value: unknown, fallback: string, max = 300): string {
  const cleaned = redactSensitiveText(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, max);
}

export function isRuntimeActivityState(value: unknown): value is RuntimeActivityState {
  return typeof value === "string" && ACTIVITY_STATE_SET.has(value);
}

export function runtimeActivityLabel(state: RuntimeActivityState): string {
  switch (state) {
    case "model_active": return "分析中";
    case "tool_reading": return "检索中";
    case "tool_writing": return "开发中";
    case "validating": return "验收中";
    case "delivering": return "交付中";
    case "idle_between_steps": return "步骤间空闲";
    case "waiting_user": return "等待用户操作";
    case "stalled": return "疑似停滞";
    case "terminal": return "已结束";
    default: return "状态未知";
  }
}

export function createRuntimeActivityEvent(input: {
  task_id?: string | null;
  run_id?: string | null;
  source: RuntimeActivitySource;
  activity_state: RuntimeActivityState;
  safe_summary: unknown;
  occurred_at?: string;
  meaningful_progress?: boolean;
  evidence_ref?: string | null;
  user_action_required?: RuntimeUserActionRequiredV1 | null;
}): RuntimeActivityEventV1 {
  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const summary = cleanRuntimeActivityText(input.safe_summary, runtimeActivityLabel(input.activity_state));
  const material = [input.task_id ?? "", input.run_id ?? "", input.source, input.activity_state, summary, occurredAt].join("\u0000");
  return {
    version: 1,
    event_id: `activity:${createHash("sha256").update(material).digest("hex").slice(0, 24)}`,
    task_id: input.task_id ?? null,
    run_id: input.run_id ?? null,
    source: input.source,
    activity_state: input.activity_state,
    safe_summary: summary,
    occurred_at: occurredAt,
    meaningful_progress: input.meaningful_progress !== false,
    evidence_ref: input.evidence_ref ? cleanRuntimeActivityText(input.evidence_ref, "activity_evidence", 500) : null,
    user_action_required: input.user_action_required ?? null
  };
}

function publicString(data: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (!data) return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return cleanRuntimeActivityText(value, "", 300) || null;
  }
  return null;
}

export function safePublicModelActivitySummary(eventType: string, data?: Record<string, unknown>): string {
  const explicit = publicString(data, PUBLIC_SUMMARY_KEYS);
  if (explicit) return explicit;
  if (eventType === "task.tool_called") {
    const toolName = publicString(data, PUBLIC_TOOL_NAME_KEYS);
    return toolName ? `准备调用工具 ${toolName}` : "准备调用工具";
  }
  if (eventType === "task.checkpointed") return "已记录阶段性进展";
  if (eventType === "task.output") return "模型输出了公开进展";
  if (eventType === "task.started") return "模型响应已开始";
  if (eventType === "task.waiting_input") return "等待用户补充信息";
  if (eventType === "task.waiting_approval") return "等待用户批准";
  if (eventType === "task.succeeded") return "模型任务已完成";
  if (eventType === "task.failed") return "模型任务执行失败";
  if (eventType === "task.cancelled") return "模型任务已取消";
  return "模型活动已更新";
}

export function explicitModelUserAction(eventType: string, data: Record<string, unknown> | undefined, at: string, evidenceRef: string): RuntimeUserActionRequiredV1 | null {
  if (eventType !== "task.waiting_input" && eventType !== "task.waiting_approval") return null;
  const approval = eventType === "task.waiting_approval";
  const prompt = safePublicModelActivitySummary(eventType, data);
  return {
    version: 1,
    required: true,
    action_type: approval ? "approve" : "provide_input",
    label: approval ? "批准或拒绝" : "补充信息",
    prompt,
    since: at,
    evidence_ref: evidenceRef
  };
}

export function assessRuntimeNoProgress(
  lastMeaningfulProgressAt: string | null | undefined,
  now: number | Date = Date.now(),
  thresholds: { quiet_ms?: number; stalled_ms?: number; severe_ms?: number } = {}
): RuntimeNoProgressAssessment {
  const at = Date.parse(lastMeaningfulProgressAt ?? "");
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) {
    return { level: "unknown", duration_ms: null, activity_state: "unknown", label: "尚无真实进展时间" };
  }
  const duration = Math.max(0, nowMs - at);
  const quietMs = Math.max(1, thresholds.quiet_ms ?? NO_PROGRESS_QUIET_MS);
  const stalledMs = Math.max(quietMs, thresholds.stalled_ms ?? NO_PROGRESS_STALLED_MS);
  const severeMs = Math.max(stalledMs, thresholds.severe_ms ?? NO_PROGRESS_SEVERE_MS);
  if (duration >= severeMs) return { level: "severe", duration_ms: duration, activity_state: "stalled", label: "长时间无真实进展" };
  if (duration >= stalledMs) return { level: "stalled", duration_ms: duration, activity_state: "stalled", label: "疑似停滞" };
  if (duration >= quietMs) return { level: "quiet", duration_ms: duration, activity_state: "idle_between_steps", label: "暂无新执行证据" };
  return { level: "fresh", duration_ms: duration, activity_state: "idle_between_steps", label: "最近有真实进展" };
}
