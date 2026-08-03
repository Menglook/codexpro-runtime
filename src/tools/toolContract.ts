import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import {
  TOOL_DELIVERY_STATUSES,
  TOOL_EXECUTION_STATUSES,
  TOOL_RECOVERY_STATUSES,
  TOOL_RESOURCE_STATUSES,
  TOOL_SECURITY_STATUSES,
  TOOL_VALIDATION_STATUSES,
  deriveOrthogonalToolOutcome,
  toolStatusFromOrthogonal,
  type CanonicalToolOutcomeV1,
  type OrthogonalToolOutcomeV1
} from "../runtime/orthogonalToolOutcome.js";

export const TOOL_RESULT_SCHEMA_VERSION = "tool-result-v1" as const;
export const TOOL_CONTRACT_SCHEMA_VERSION = "tool-contract-v1" as const;

export const TOOL_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "stalled",
  "completed",
  "failed",
  "cancelled"
] as const;
export type ToolStatus = typeof TOOL_STATUSES[number];

export const OPERATION_TYPES = ["read", "search", "write", "execute", "validate", "browser", "git", "memory", "handoff", "configuration"] as const;
export type OperationType = typeof OPERATION_TYPES[number];

export const TOOL_CATEGORIES = ["workspace", "project_read", "project_write", "command", "validation", "browser", "git", "memory", "handoff", "diagnostics"] as const;
export type ToolCategory = typeof TOOL_CATEGORIES[number];

export type SideEffectLevel = "none" | "local_state" | "workspace_write" | "process" | "browser" | "git_local" | "network_write" | "memory_write" | "handoff_write" | "configuration";

export interface EvidenceRef {
  type: "log" | "diff" | "snapshot" | "browser_report" | "screenshot" | "acceptance_report" | "commit" | "remote_state" | "deployment_report";
  path?: string;
  id?: string;
  sha256?: string;
  summary?: string;
}

export interface ToolError {
  code: string;
  category: "validation" | "permission" | "workspace" | "execution" | "timeout" | "git" | "network" | "conflict" | "internal";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  evidence_refs?: EvidenceRef[];
}

export interface ToolContractMetadataV1 {
  schema_version: typeof TOOL_CONTRACT_SCHEMA_VERSION;
  tool_name: string;
  display_name_cn: string;
  plain_description_cn: string;
  tool_category: ToolCategory;
  operation_type: OperationType;
  side_effect_level: SideEffectLevel;
  approval_required: boolean;
  requires_confirmation: boolean;
  requires_resource_lease: boolean;
  read_fast_path_eligible: boolean;
  workspace_required: boolean;
  workspace_generation_required: boolean;
  compatibility_workspace_warning: boolean;
  evidence_types: EvidenceRef["type"][];
  office_zone: string;
  office_role: string;
  input_schema_version: "tool-input-v1";
  output_schema_version: typeof TOOL_RESULT_SCHEMA_VERSION;
  deprecated: boolean;
  effective_tool_name?: string;
}

export interface ToolResultEnvelopeV1<TData = unknown> extends OrthogonalToolOutcomeV1 {
  schema_version: typeof TOOL_RESULT_SCHEMA_VERSION;
  canonical_outcome: CanonicalToolOutcomeV1;
  event_id: string;
  trace_id: string;
  conversation_id?: string;
  task_id?: string;
  stage_id?: string;
  attempt_id?: string;
  workspace_id?: string;
  workspace_generation?: number;
  executor_id?: string;
  owner_id?: string;
  tool_name: string;
  tool_category: ToolCategory;
  operation_type: OperationType;
  status: ToolStatus;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  summary: string;
  data?: TData;
  affected_paths?: string[];
  evidence_refs?: EvidenceRef[];
  approval?: {
    required: boolean;
    state: "not_required" | "pending" | "approved" | "denied";
  };
  side_effects?: {
    level: SideEffectLevel;
    occurred: boolean;
    summary: string;
  };
  warnings?: Array<{ code: string; message: string }>;
  error?: ToolError | null;
}

const GLOBAL_TOOLS = new Set([
  "server_config", "list_workspaces", "list_projects", "show_active_project", "codexpro_inventory",
  "codexpro", "open_current_workspace", "open_workspace", "activate_project", "switch_project"
]);
const WORKSPACE_BOOTSTRAP_TOOLS = new Set(["open_workspace", "activate_project", "switch_project"]);
const READ_FAST_PATH_TOOLS = new Set([
  "open_current_workspace", "read", "read_many_files", "search_project", "tree", "show_changes", "dirty_guard",
  "server_config", "list_projects", "show_active_project", "read_project_profile", "read_project_config",
  "read_project_memory", "summarize_project_memory", "read_rule_summary"
]);
const MEMORY_WRITE_TOOLS = new Set(["append_project_memory", "rebuild_memory_index", "compress_old_sessions"]);
const PROJECT_WRITE_TOOLS = new Set([
  "write", "edit", "apply_patch_bundle", "run_task", "run_stage", "start_run_task", "init_project_config",
  "generate_project_map", "start_task_snapshot", "finish_task_snapshot", "export_pro_context", "task_complete"
]);
const VALIDATION_TOOLS = new Set([
  "run_validation", "run_acceptance", "cancel_acceptance", "release_safety_check", "secret_scan", "security_audit"
]);
const HANDOFF_TOOLS = new Set(["handoff_to_agent", "handoff_to_codex", "publish_task_report"]);
const COMMAND_TOOLS = new Set(["bash", "node_run_script", "php_lint_files", "python_run_tests", "docker_restart_service"]);
const SEARCH_PATTERN = /(?:^|_)(?:search|query|find|list)(?:_|$)/;
const READ_PATTERN = /(?:^|_)(?:read|get|show|status|summary|inspect|observe|expect|check|detect|tree|timeline|evidence|inventory)(?:_|$)/;
const VALIDATION_PATTERN = /(?:^|_)(?:validation|acceptance|test|tests|lint|typecheck|healthcheck|smoke|build|audit|scan)(?:_|$)/;

function cleanName(value: string): string {
  return value.toLowerCase().trim().replace(/[\s-]+/g, "_");
}

export function operationTypeForTool(toolName: string): OperationType {
  const name = cleanName(toolName);
  if (READ_FAST_PATH_TOOLS.has(name)) return name.includes("search") ? "search" : "read";
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("git_") || name === "commit_assistant") return "git";
  if (name.includes("memory")) return "memory";
  if (name.includes("handoff") || HANDOFF_TOOLS.has(name)) return "handoff";
  if (VALIDATION_TOOLS.has(name) || VALIDATION_PATTERN.test(name)) return "validate";
  if (COMMAND_TOOLS.has(name) || name.startsWith("docker_") || name.startsWith("node_") || name.startsWith("php_") || name.startsWith("python_")) return "execute";
  if (PROJECT_WRITE_TOOLS.has(name) || /(?:^|_)(?:write|edit|apply|create|activate|switch|resume|cancel|retry|start|finish|publish|init|generate|compress|rebuild)(?:_|$)/.test(name)) return "write";
  if (SEARCH_PATTERN.test(name)) return "search";
  if (READ_PATTERN.test(name) || name === "server_config") return "read";
  return "configuration";
}

export function toolCategoryForContract(toolName: string, operation = operationTypeForTool(toolName)): ToolCategory {
  const name = cleanName(toolName);
  if (name.includes("workspace") || ["list_projects", "show_active_project", "activate_project", "switch_project"].includes(name)) return "workspace";
  if (operation === "browser") return "browser";
  if (operation === "git") return "git";
  if (operation === "memory") return "memory";
  if (operation === "handoff") return "handoff";
  if (operation === "validate") return "validation";
  if (operation === "execute") return "command";
  if (operation === "write") return "project_write";
  if (operation === "read" || operation === "search") return "project_read";
  return "diagnostics";
}

export function isReadFastPathTool(toolName: string): boolean {
  return READ_FAST_PATH_TOOLS.has(cleanName(toolName));
}

export function sideEffectLevelForTool(toolName: string, operation = operationTypeForTool(toolName)): SideEffectLevel {
  const name = cleanName(toolName);
  if (WORKSPACE_BOOTSTRAP_TOOLS.has(name)) return "configuration";
  if (operation === "read" || operation === "search") return "none";
  if (operation === "browser") return /(?:status|tabs|observe|inspect|console|network|expect|list|read|result)$/.test(name) ? "none" : "browser";
  if (operation === "git") {
    if (["git_status", "git_diff", "git_summary", "git_prepare_commit", "git_get_remote_state", "git_prepare", "commit_assistant"].includes(name)) return "none";
    return name === "git_push" || name === "git_push_only" ? "network_write" : "git_local";
  }
  if (operation === "memory") return MEMORY_WRITE_TOOLS.has(name) ? "memory_write" : "none";
  if (operation === "handoff") return "handoff_write";
  if (operation === "validate" || operation === "execute") return "process";
  if (operation === "write") return PROJECT_WRITE_TOOLS.has(name) || name.includes("write") || name.includes("edit") ? "workspace_write" : "local_state";
  return "local_state";
}

function chineseDisplayName(name: string, category: ToolCategory): string {
  const exact: Record<string, string> = {
    open_current_workspace: "打开当前项目", open_workspace: "打开并绑定项目", read_many_files: "批量读取项目文件",
    search_project: "检索项目代码", write: "写入项目文件", edit: "精确修改代码", apply_patch_bundle: "批量应用代码修改",
    run_validation: "运行项目检查", browser_report: "生成浏览器验收报告", git_prepare_commit: "准备提交",
    git_commit: "创建真实提交", git_push: "推送到远端", git_get_remote_state: "核对远端状态",
    commit_assistant: "生成提交建议", append_project_memory: "写入已批准记忆", codexpro: "CodexPro 兼容入口"
  };
  if (exact[name]) return exact[name];
  const tokenMap: Record<string, string> = {
    acceptance: "验收", activate: "启用", active: "当前", adapter: "适配器", agent: "智能体", analyze: "分析", append: "追加",
    apply: "应用", audit: "审计", bash: "命令", browser: "浏览器", build: "构建", cancel: "取消", capabilities: "能力", classify: "分类",
    codex: "Codex", codexpro: "CodexPro", commit: "提交", compact: "紧凑任务", compress: "压缩", config: "配置", context: "上下文",
    create: "创建", current: "当前", database: "数据库", detect: "识别", diff: "差异", docker: "容器", edit: "修改", evidence: "证据",
    execute: "执行", export: "导出", finalize: "交付", finish: "完成", generate: "生成", get: "获取", git: "Git", goal: "目标",
    handoff: "交接", health: "健康检查", index: "索引", init: "初始化", inspect: "检查", inventory: "清单", list: "列出", log: "日志",
    memory: "记忆", node: "Node", observe: "观察", open: "打开", patch: "补丁", php: "PHP", prepare: "准备", profile: "档案",
    project: "项目", publish: "发布", push: "推送", python: "Python", query: "查询", read: "读取", rebuild: "重建", recovery: "恢复",
    release: "发布", remote: "远端", report: "报告", restart: "重启", result: "结果", resume: "继续", retry: "重试", rule: "规则",
    run: "运行", scan: "扫描", search: "检索", secret: "敏感信息", server: "服务", session: "会话", sessions: "会话", show: "查看",
    skill: "技能", snapshot: "快照", stage: "阶段", status: "状态", summarize: "汇总", summary: "摘要", switch: "切换", task: "任务",
    template: "模板", test: "测试", timeline: "时间线", tool: "工具", tree: "目录树", update: "更新", validate: "校验", validation: "验证",
    workspace: "工作区", write: "写入"
  };
  const fallback: Record<ToolCategory, string> = {
    workspace: "工作区管理能力", project_read: "项目读取能力", project_write: "项目修改能力", command: "命令执行能力",
    validation: "测试验收能力", browser: "浏览器验收能力", git: "Git 交付能力", memory: "项目记忆能力", handoff: "协作交接能力", diagnostics: "诊断能力"
  };
  const translated = name.split("_").map((token) => tokenMap[token]).filter(Boolean).join(" · ");
  return translated && /[\u3400-\u9fff]/u.test(translated) ? translated : translated ? `${fallback[category]} · ${translated}` : fallback[category];
}

function officePlacement(category: ToolCategory): { zone: string; role: string } {
  switch (category) {
    case "workspace": return { zone: "项目控制台", role: "规划员" };
    case "project_read": return { zone: "分析研究室", role: "规划员" };
    case "project_write": return { zone: "开发工位", role: "代码工程师" };
    case "command": return { zone: "命令执行区", role: "代码工程师" };
    case "validation": return { zone: "验收中心", role: "测试工程师" };
    case "browser": return { zone: "浏览器实验室", role: "浏览器验收员" };
    case "git": return { zone: "Git 发布台", role: "Git 发布管理员" };
    case "memory": return { zone: "知识库", role: "知识管理员" };
    case "handoff": return { zone: "协作调度区", role: "监控观察员" };
    default: return { zone: "项目控制台", role: "监控观察员" };
  }
}

function evidenceTypes(category: ToolCategory): EvidenceRef["type"][] {
  switch (category) {
    case "project_write": return ["diff"];
    case "command": return ["log"];
    case "validation": return ["log", "acceptance_report"];
    case "browser": return ["browser_report", "screenshot"];
    case "git": return ["diff", "commit", "remote_state"];
    default: return [];
  }
}

export function buildToolContract(toolName: string, description = ""): ToolContractMetadataV1 {
  const name = cleanName(toolName);
  const operation = operationTypeForTool(name);
  const category = toolCategoryForContract(name, operation);
  const sideEffect = sideEffectLevelForTool(name, operation);
  const readFastPathEligible = READ_FAST_PATH_TOOLS.has(name)
    && sideEffect === "none"
    && (operation === "read" || operation === "search");
  const placement = officePlacement(category);
  const workspaceRequired = !GLOBAL_TOOLS.has(name);
  const generationRequired = workspaceRequired && (
    sideEffect !== "none" || operation === "browser" || operation === "git"
  );
  const displayName = chineseDisplayName(name, category);
  const plainDescription = description
    ? redactSensitiveText(description).slice(0, 500)
    : `在${placement.zone}由${placement.role}执行“${displayName}”，操作类型为${operation}。`;
  return {
    schema_version: TOOL_CONTRACT_SCHEMA_VERSION,
    tool_name: name,
    display_name_cn: displayName,
    plain_description_cn: plainDescription,
    tool_category: category,
    operation_type: operation,
    side_effect_level: sideEffect,
    approval_required: sideEffect === "network_write" || sideEffect === "configuration",
    requires_confirmation: sideEffect === "network_write" || sideEffect === "configuration",
    requires_resource_lease: sideEffect !== "none" && sideEffect !== "configuration",
    read_fast_path_eligible: readFastPathEligible,
    workspace_required: workspaceRequired,
    workspace_generation_required: generationRequired,
    compatibility_workspace_warning: workspaceRequired && !generationRequired,
    evidence_types: evidenceTypes(category),
    office_zone: placement.zone,
    office_role: placement.role,
    input_schema_version: "tool-input-v1",
    output_schema_version: TOOL_RESULT_SCHEMA_VERSION,
    deprecated: name === "commit_assistant"
  };
}

export function toolResultOutputSchema(): Record<string, z.ZodTypeAny> {
  return {
    tool_result: z.object({
      schema_version: z.literal(TOOL_RESULT_SCHEMA_VERSION),
      event_id: z.string(),
      trace_id: z.string(),
      conversation_id: z.string().optional(),
      task_id: z.string().optional(),
      stage_id: z.string().optional(),
      attempt_id: z.string().optional(),
      workspace_id: z.string().optional(),
      workspace_generation: z.number().int().min(1).optional(),
      executor_id: z.string().optional(),
      owner_id: z.string().optional(),
      tool_name: z.string(),
      tool_category: z.enum(TOOL_CATEGORIES),
      operation_type: z.enum(OPERATION_TYPES),
      security_status: z.enum(TOOL_SECURITY_STATUSES),
      resource_status: z.enum(TOOL_RESOURCE_STATUSES),
      execution_status: z.enum(TOOL_EXECUTION_STATUSES),
      recovery_status: z.enum(TOOL_RECOVERY_STATUSES),
      validation_status: z.enum(TOOL_VALIDATION_STATUSES),
      delivery_status: z.enum(TOOL_DELIVERY_STATUSES),
      permission_decision_id: z.string().nullable(),
      effective_side_effect_level: z.string().nullable(),
      resource_lease_id: z.string().nullable(),
      workspace_baseline_id: z.string().nullable(),
      confirmation_receipt_id: z.string().nullable(),
      tool_schema_digest: z.string().nullable(),
      retryable: z.boolean(),
      reason_code: z.string().nullable(),
      state_authority: z.enum(["handler_explicit", "authoritative_receipt", "legacy_inference", "default"]),
      canonical_outcome: z.object({
        security_status: z.enum(TOOL_SECURITY_STATUSES), resource_status: z.enum(TOOL_RESOURCE_STATUSES), execution_status: z.enum(TOOL_EXECUTION_STATUSES),
        recovery_status: z.enum(TOOL_RECOVERY_STATUSES), validation_status: z.enum(TOOL_VALIDATION_STATUSES), delivery_status: z.enum(TOOL_DELIVERY_STATUSES),
        permission_decision_id: z.string().nullable(), effective_side_effect_level: z.string().nullable(), resource_lease_id: z.string().nullable(),
        workspace_baseline_id: z.string().nullable(), confirmation_receipt_id: z.string().nullable(), tool_schema_digest: z.string().nullable(),
        retryable: z.boolean(), reason_code: z.string().nullable(), state_authority: z.enum(["handler_explicit", "authoritative_receipt", "legacy_inference", "default"])
      }),
      status: z.enum(TOOL_STATUSES),
      started_at: z.string(),
      finished_at: z.string().optional(),
      duration_ms: z.number().int().min(0).optional(),
      summary: z.string(),
      data: z.unknown().optional(),
      affected_paths: z.array(z.string()).optional(),
      evidence_refs: z.array(z.object({
        type: z.enum(["log", "diff", "snapshot", "browser_report", "screenshot", "acceptance_report", "commit", "remote_state", "deployment_report"]),
        path: z.string().optional(), id: z.string().optional(), sha256: z.string().optional(), summary: z.string().optional()
      })).optional(),
      approval: z.object({ required: z.boolean(), state: z.enum(["not_required", "pending", "approved", "denied"]) }).optional(),
      side_effects: z.object({ level: z.string(), occurred: z.boolean(), summary: z.string() }).optional(),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
      error: z.object({
        code: z.string(), category: z.enum(["validation", "permission", "workspace", "execution", "timeout", "git", "network", "conflict", "internal"]),
        message: z.string(), retryable: z.boolean(), details: z.record(z.unknown()).optional(), evidence_refs: z.array(z.unknown()).optional()
      }).nullable().optional()
    }).passthrough()
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown, fallback: string, max = 1_000): string {
  return (redactSensitiveText(String(value ?? "")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || fallback).slice(0, max);
}

function pathValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.length > 4_096 || normalized.includes("\0")) return null;
  return normalized;
}

function collectAffectedPaths(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["path", "report_path", "snapshot_path", "output_path"]) {
    const item = pathValue(data[key]);
    if (item) out.push(item);
  }
  for (const key of ["affected_paths", "changed_files", "committed_files", "files_touched", "files"]) {
    const values = data[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const item = pathValue(typeof value === "string" ? value : record(value).path);
      if (item) out.push(item);
    }
  }
  return [...new Set(out)].slice(0, 100);
}

function evidenceTypeForKey(key: string): EvidenceRef["type"] {
  if (/screenshot/i.test(key)) return "screenshot";
  if (/browser/i.test(key)) return "browser_report";
  if (/acceptance|validation/i.test(key)) return "acceptance_report";
  if (/remote/i.test(key)) return "remote_state";
  if (/commit/i.test(key)) return "commit";
  if (/snapshot/i.test(key)) return "snapshot";
  if (/diff|patch/i.test(key)) return "diff";
  if (/deploy/i.test(key)) return "deployment_report";
  return "log";
}

function collectEvidence(data: Record<string, unknown>): EvidenceRef[] {
  const out: EvidenceRef[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/(?:path|ref|sha|report|screenshot|commit|remote)/i.test(key)) continue;
    if (typeof value === "string" && value.trim()) {
      if (/sha/i.test(key) && /^[a-f0-9]{7,64}$/i.test(value)) out.push({ type: evidenceTypeForKey(key), id: value, summary: key });
      else {
        const path = pathValue(value);
        if (path) out.push({ type: evidenceTypeForKey(key), path, summary: key });
      }
    }
  }
  return out.slice(0, 30);
}

function errorFrom(data: Record<string, unknown>, toolName: string, status: ToolStatus): ToolError | null {
  if (status !== "failed" && status !== "blocked" && status !== "cancelled") return null;
  const raw = cleanText(data.error ?? data.message ?? data.reason ?? data.reason_code, `${toolName} ${status}.`);
  const lower = raw.toLowerCase();
  const category: ToolError["category"] = /workspace|generation|project/.test(lower)
    ? "workspace"
    : status === "blocked" || /permission|denied|approval/.test(lower)
      ? "permission"
      : /timeout|timed out/.test(lower)
        ? "timeout"
        : /git|commit|push|remote/.test(lower)
          ? "git"
          : /network|dns|connect/.test(lower)
            ? "network"
            : /invalid|argument|schema/.test(lower)
              ? "validation"
              : "execution";
  return {
    code: cleanText(data.error_code ?? data.reason_code, `${toolName}_${status}`, 160).toLowerCase().replace(/[^a-z0-9._-]+/g, "_"),
    category,
    message: raw,
    retryable: category === "timeout" || category === "network" || data.retryable === true
  };
}

function summaryFor(data: Record<string, unknown>, contract: ToolContractMetadataV1, status: ToolStatus): string {
  for (const key of ["public_summary", "safe_summary", "summary", "message", "reason"]) {
    if (typeof data[key] === "string" && data[key]?.trim()) return cleanText(data[key], contract.display_name_cn);
  }
  if (status === "blocked") return `${contract.display_name_cn}已被安全门禁阻止。`;
  if (status === "failed") return `${contract.display_name_cn}执行失败。`;
  if (status === "cancelled") return `${contract.display_name_cn}已取消。`;
  return `${contract.display_name_cn}已完成。`;
}

function boundedData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const encoded = JSON.stringify(data);
    if (encoded.length <= 120_000) return data;
  } catch {
    // Non-serializable compatibility data is omitted from the envelope only.
  }
  return undefined;
}

export function createToolResultEnvelope(input: {
  contract: ToolContractMetadataV1;
  trace_id: string;
  workspace?: Workspace | null;
  result: Record<string, unknown>;
  outcome: "ok" | "error";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  task_id?: string | null;
  stage_id?: string | null;
  attempt_id?: string | null;
  executor_id?: string | null;
  owner_id?: string | null;
  workspace_warning?: string | null;
  canonical_outcome?: CanonicalToolOutcomeV1;
}): ToolResultEnvelopeV1<Record<string, unknown>> {
  const data = record(input.result.structuredContent);
  const orthogonal = input.canonical_outcome ?? deriveOrthogonalToolOutcome({
    outcome: input.outcome,
    result: input.result,
    operation_type: input.contract.operation_type,
    tool_category: input.contract.tool_category
  });
  const status = toolStatusFromOrthogonal(orthogonal);
  const affectedPaths = collectAffectedPaths(data);
  const evidence = collectEvidence(data);
  const payload: ToolResultEnvelopeV1<Record<string, unknown>> = {
    schema_version: TOOL_RESULT_SCHEMA_VERSION,
    event_id: `tool:${createHash("sha256").update(`${input.trace_id}\0${input.contract.tool_name}\0${input.finished_at}\0${randomUUID()}`).digest("hex").slice(0, 24)}`,
    trace_id: input.trace_id,
    ...(input.workspace?.conversationId ? { conversation_id: input.workspace.conversationId } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.stage_id ? { stage_id: input.stage_id } : {}),
    ...(input.attempt_id ? { attempt_id: input.attempt_id } : {}),
    ...(input.workspace?.id ? { workspace_id: input.workspace.id } : {}),
    ...(input.workspace?.workspaceGeneration ? { workspace_generation: input.workspace.workspaceGeneration } : {}),
    ...(input.executor_id ? { executor_id: input.executor_id } : {}),
    ...(input.owner_id ? { owner_id: input.owner_id } : {}),
    tool_name: input.contract.effective_tool_name ?? input.contract.tool_name,
    tool_category: input.contract.tool_category,
    operation_type: input.contract.operation_type,
    canonical_outcome: orthogonal,
    ...orthogonal,
    status,
    started_at: input.started_at,
    finished_at: input.finished_at,
    duration_ms: Math.max(0, Math.floor(input.duration_ms)),
    summary: summaryFor(data, input.contract, status),
    ...(boundedData(data) ? { data: boundedData(data) } : {}),
    ...(affectedPaths.length ? { affected_paths: affectedPaths } : {}),
    ...(evidence.length ? { evidence_refs: evidence } : {}),
    approval: {
      required: input.contract.approval_required,
      state: !input.contract.approval_required
        ? "not_required"
        : orthogonal.security_status === "confirmation_required"
          ? "pending"
          : orthogonal.security_status === "denied" ? "denied" : "approved"
    },
    side_effects: {
      level: input.contract.side_effect_level,
      occurred: orthogonal.execution_status === "completed" && input.contract.side_effect_level !== "none",
      summary: input.contract.side_effect_level === "none" ? "未声明副作用。" : orthogonal.execution_status === "completed" ? "已执行声明的副作用。" : "声明的副作用未成功完成。"
    },
    ...(input.workspace_warning ? { warnings: [{ code: "workspace_binding_compatibility", message: cleanText(input.workspace_warning, "Workspace binding warning") }] } : {}),
    error: errorFrom(data, input.contract.tool_name, status)
  };
  return payload;
}
