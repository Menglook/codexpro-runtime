import { detectGitIntentFromArgs } from "./gitIntent.js";
import { classifyAggregateToolCall } from "../workflow/aggregateExecutionMode.js";
import {
  authorizationDecisionPayload,
  verifyAuthorizationPayloadBinding,
  type AuthorizationPayloadBindingV1
} from "./authorizationIntegrity.js";
import {
  permissionDecisionAllowsExecution,
  verifyPermissionDecision,
  type MonotonicPermissionDecision
} from "./permissionDecision.js";

export type UnifiedRiskLevel = "L0" | "L1" | "L2" | "L3";
export type EffectiveSideEffectLevel =
  | "none"
  | "process"
  | "local_state"
  | "workspace_write"
  | "git_local"
  | "network_write"
  | "business_critical"
  | "unknown";
export type ControlKind = "invariant" | "policy" | "recovery" | "evidence";
export type ControlEnforcement = "block" | "degrade" | "warn" | "record";
export type ControlScope =
  | "workspace_entry"
  | "write_boundary"
  | "external_effect_boundary"
  | "delivery_claim_boundary"
  | "execution_policy"
  | "post_processing";
export type ExecutionControlMode = "runtime" | "benchmark" | "high_risk_delivery";

export type RiskArgumentRole =
  | "control"
  | "path"
  | "static_content"
  | "read_query"
  | "execution_payload"
  | "external_target"
  | "authorization"
  | "metadata";

export type RiskToolCapability =
  | "read_only"
  | "static_file"
  | "aggregate"
  | "shell"
  | "browser"
  | "git"
  | "database"
  | "external"
  | "unknown";

export type SideEffectAction =
  | "read"
  | "local_write"
  | "command_execution"
  | "browser_action"
  | "git_remote_update"
  | "database_write"
  | "external_write"
  | "deployment"
  | "business_critical"
  | "destructive"
  | "unknown";

export type SideEffectScope = "none" | "workspace" | "external" | "production" | "business_critical" | "unknown";
export type SideEffectAuthorization = "not_required" | "implicit_local" | "explicit_required" | "detected" | "denied" | "unknown";
export type SideEffectReversibility = "none" | "reversible" | "conditional" | "irreversible" | "unknown";

export interface SideEffectDescriptor {
  version: 1;
  action: SideEffectAction;
  target: string;
  scope: SideEffectScope;
  authorization: SideEffectAuthorization;
  reversibility: SideEffectReversibility;
  source_paths: string[];
  signals: string[];
}

export interface UnifiedRiskSignalMatch {
  signal: string;
  argument_path: string;
  role: RiskArgumentRole | "tool";
}

export interface UnifiedRiskDecision {
  level: UnifiedRiskLevel;
  allowed: boolean;
  reason: string;
  reason_code: string;
  control_kind: ControlKind;
  control_scope: ControlScope;
  enforcement: ControlEnforcement;
  recoverable: boolean;
  retryable: boolean;
  blocks_only: string[];
  execution_mode: ExecutionControlMode;
  checkpoint_required: boolean;
  explicit_authorization_required: boolean;
  authorization_detected: boolean;
  automatic_replay_allowed: boolean;
  side_effect: boolean;
  matched_signals: string[];
  matched_argument_paths: string[];
  signal_matches: UnifiedRiskSignalMatch[];
  side_effects: SideEffectDescriptor[];
  capability_side_effect_level: EffectiveSideEffectLevel;
  effective_side_effect_level: EffectiveSideEffectLevel;
  effective_operations: string[];
  effective_paths: string[];
  effective_external_targets: string[];
}

export interface UnifiedRiskBaselineObservation {
  decision: UnifiedRiskDecision;
  risk_decision_ms: number;
  handler_before_total_ms: number;
  regex_scan_count: number;
  parameter_string_length: number;
  flattened_string_count: number;
  tool_class: RiskToolCapability;
  argument_roles: RiskArgumentRole[];
}

export interface UnifiedRiskEvaluationOptions {
  toolAwareInputs?: boolean;
  executionMode?: ExecutionControlMode;
}

export interface RiskArgumentEntry {
  path: string;
  role: RiskArgumentRole;
  value: string;
}

export interface RiskInputExtraction {
  capability: RiskToolCapability;
  by_role: Record<RiskArgumentRole, string[]>;
  entries: RiskArgumentEntry[];
  parameter_string_length: number;
  flattened_string_count: number;
}

export interface TaskRiskPlannedAction {
  action: SideEffectAction;
  target?: string;
  scope?: SideEffectScope;
}

export interface TaskRiskProfileInput {
  instruction: string;
  execution_mode?: ExecutionControlMode;
  scope_paths: string[];
  source_write: boolean;
  artifact_write: boolean;
  run_bash: boolean;
  use_browser: boolean;
  use_network: boolean;
  use_git: boolean;
  write_database: boolean;
  workspace_scope: boolean;
  planned_actions?: TaskRiskPlannedAction[];
  side_effects?: Array<Pick<SideEffectDescriptor, "action" | "target" | "scope">>;
  explicit_authorization?: boolean;
  authorization_text?: string;
}

export interface StructuredTaskAuthorizationDecision {
  version: 1;
  decision_id: string;
  allowed_actions: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  authorization_evidence?: string[];
  external_side_effects?: Array<{ action?: string; target?: string; maximum_loss?: string; reversible?: boolean }>;
  payload_binding?: AuthorizationPayloadBindingV1;
  permission_decision?: MonotonicPermissionDecision;
}

const AUTHORIZATION_KEYS = new Set([
  "approval",
  "approval_text",
  "approved",
  "confirm_external_side_effect",
  "confirm_high_risk",
  "confirmation",
  "confirmation_text",
  "explicit_authorization",
  "task_instruction",
  "user_instruction",
  "user_intent",
  "user_message",
  "user_request"
]);

const PATH_KEYS = new Set([
  "cwd",
  "file",
  "file_path",
  "filename",
  "path",
  "root",
  "target_file",
  "working_directory",
  "workspace_root"
]);

const EXECUTION_KEYS = new Set([
  "args",
  "argv",
  "command",
  "commands",
  "keys",
  "query",
  "script",
  "shell",
  "sql",
  "statement",
  "text",
  "value"
]);

const READ_QUERY_KEYS = new Set([
  "pattern",
  "query",
  "queries",
  "search_queries",
  "text"
]);

const EXTERNAL_TARGET_KEYS = new Set([
  "branch",
  "endpoint",
  "host",
  "remote",
  "repository",
  "service",
  "target",
  "url"
]);

const STATIC_CONTENT_KEYS = new Set(["content", "new_text", "old_text"]);
const TASK_CONSTRAINT_KEYS = new Set([
  "acceptance",
  "assumptions",
  "authorization_evidence",
  "constraints",
  "forbidden_actions",
  "non_goals",
  "preconditions",
  "required_acceptance",
  "success_criteria",
  "uncertainty_notes"
]);
const METADATA_KEYS = new Set([
  "description",
  "goal",
  "id",
  "label",
  "name",
  "note",
  "prompt",
  "reason",
  "summary",
  "task_id",
  "title"
]);

const SECURITY_BOUNDARY_PATH_PATTERNS = [
  /(^|\/)src\/security\//i,
  /(^|\/)src\/hooks\//i,
  /(^|\/)src\/server\/toolRegistration\.ts$/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)\.codexpro\/(?:acceptance|project)\.ya?ml$/i,
  /(^|\/)scripts\/[^/]*(?:security|risk|authorization|allowlist|guard|release|deplo\u0079|recovery|hook)[^/]*\.(?:mjs|js|ts)$/i,
  /(^|\/)(?:package|docker-compose)[^/]*\.(?:json|ya?ml)$/i,
  /(^|\/)[^/]*(?:allowlist|authorization|guard|permission|policy|security)[^/]*\.[^/]+$/i
];

const L3_SIGNALS: Array<[RegExp, string]> = [
  [/\b(payment|pay now|transfer money|wire transfer)\b|付款|支付|转账/i, "financial_operation"],
  [/\b(submit order|place order|confirm order|purchase now)\b|提交订单|确认订单|真实订单/i, "order_submission"],
  [/\b(send message|send email|publish post|post message)\b|发送消息|发送邮件|发布消息/i, "external_message"],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b|删除数据|清空数据库|销毁数据/i, "destructive_database"],
  [/(^|\s)rm\s+-rf\s+(\/|~|\$HOME|\.\.)(\s|$)|\b(shred|wipefs|mkfs)\b/i, "destructive_filesystem"],
  [/\b(overwrite|replace)\b.{0,30}\b(production backup|prod backup)\b|覆盖生产备份/i, "overwrite_production_backup"]
];

const L2_SIGNALS: Array<[RegExp, string]> = [
  [/\bgit\s+push\b|\bpush\s+origin\b/i, "git_push"],
  [/\b(kubectl\s+(apply|delete|rollout)|helm\s+(install|upgrade|uninstall)|terraform\s+apply)\b/i, "deployment_or_remote_config"],
  [/\b(deploy|release to production|publish package|npm publish)\b|部署|发布到生产/i, "deployment_or_publish"],
  [/\b(update|insert\s+into|alter\s+table|create\s+table)\b.{0,80}\b(database|postgres|mysql|production|prod)\b|写入生产数据库|修改生产数据库/i, "external_database_write"],
  [/\b(curl|wget|http|https)\b.{0,160}(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-raw|-binary)?\b|--upload-file\b|\b(?:POST|PUT|PATCH|DELETE)\b)/i, "external_http_write"],
  [/\bdocker\s+(exec|compose\s+(down|up|restart))\b/i, "docker_external_or_service_write"],
  [/\b(aws|gcloud|az)\b.{0,100}\b(create|update|delete|put|deploy|apply)\b/i, "remote_cloud_write"]
];

const L1_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch_bundle",
  "task_resume",
  "task_cancel",
  "goal_start",
  "goal_resume",
  "goal_cancel",
  "git_finalize",
  "node_run_script",
  "php_lint_files",
  "python_run_tests",
  "docker_restart_service",
  "task_complete",
  "append_project_memory",
  "generate_project_map",
  "publish_task_report"
]);

const L0_PREFIXES = [
  "read",
  "search",
  "tree",
  "open_",
  "current_",
  "task_status",
  "acceptance_status",
  "task_get",
  "task_recovery",
  "task_timeline",
  "task_evidence",
  "browser_status",
  "browser_pages",
  "browser_console",
  "browser_network",
  "browser_report",
  "git_summary",
  "detect_",
  "classify_",
  "task_complete"
];

const APPROVAL_PATTERNS = [
  /\b(explicitly approved|I approve|confirmed external side effect|authorize external write)\b/i,
  /明确授权|我已确认|确认执行外部副作用/i
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyRoleMap(): Record<RiskArgumentRole, string[]> {
  return {
    control: [],
    path: [],
    static_content: [],
    read_query: [],
    execution_payload: [],
    external_target: [],
    authorization: [],
    metadata: []
  };
}

function normalizeArgumentKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function capabilityForTool(toolName: string): RiskToolCapability {
  if (toolName === "write" || toolName === "edit") return "static_file";
  if (/^(?:apply_patch_bundle|run_task|run_stage|start_run_task|run_task_template)$/.test(toolName)) return "aggregate";
  if (/^browser_/.test(toolName)) return "browser";
  if (/^git_/.test(toolName)) return "git";
  if (/^database_/.test(toolName)) return "database";
  if (/^(?:bash|run_validation|run_acceptance|node_run_script|python_run_tests|php_lint_files)$/.test(toolName)) return "shell";
  if (/^(?:docker_|deploy_|release_|publish_|send_|post_|webhook_|http_)/.test(toolName)) return "external";
  if (L0_PREFIXES.some((prefix) => toolName === prefix || toolName.startsWith(prefix))) return "read_only";
  return "unknown";
}

function sensitiveArgumentKey(key: string): boolean {
  return /token|secret|password|cookie|credential|bearer|api[_-]?key/i.test(key);
}

function aggregatePatchField(path: string, key: string): RiskArgumentRole | undefined {
  if (!/(^|\.)patches(?:\.|$)/.test(path)) return undefined;
  if (STATIC_CONTENT_KEYS.has(key)) return "static_content";
  if (PATH_KEYS.has(key)) return "path";
  if (key === "operation") return "control";
  return undefined;
}

function roleForArgument(
  capability: RiskToolCapability,
  path: string,
  key: string,
  inherited?: RiskArgumentRole
): RiskArgumentRole {
  if (sensitiveArgumentKey(key)) return "metadata";
  if (AUTHORIZATION_KEYS.has(key)) return "authorization";
  if (TASK_CONSTRAINT_KEYS.has(key)) return "metadata";
  const aggregateRole = capability === "aggregate" ? aggregatePatchField(path, key) : undefined;
  if (aggregateRole) return aggregateRole;
  if (PATH_KEYS.has(key)) return "path";
  if (capability === "read_only" && READ_QUERY_KEYS.has(key)) return "read_query";
  if (capability === "static_file" && STATIC_CONTENT_KEYS.has(key)) return "static_content";
  if (capability === "aggregate") {
    if (key === "commands") return "execution_payload";
    if (key === "search_queries") return "read_query";
    if (STATIC_CONTENT_KEYS.has(key)) return "static_content";
    if (METADATA_KEYS.has(key)) return "metadata";
  }
  if (capability === "browser") {
    if (EXTERNAL_TARGET_KEYS.has(key)) return "external_target";
    if (EXECUTION_KEYS.has(key)) return "execution_payload";
    if (/selector|element|ref|timeout|case_sensitive|exact/.test(key)) return "control";
  }
  if (capability === "shell" || capability === "database") {
    if (EXECUTION_KEYS.has(key)) return "execution_payload";
    if (EXTERNAL_TARGET_KEYS.has(key)) return "external_target";
  }
  if (capability === "git") {
    if (EXECUTION_KEYS.has(key)) return "execution_payload";
    if (EXTERNAL_TARGET_KEYS.has(key)) return "external_target";
    if (/message|subject/.test(key)) return "metadata";
  }
  if (capability === "external") {
    if (EXTERNAL_TARGET_KEYS.has(key)) return "external_target";
    if (EXECUTION_KEYS.has(key) || STATIC_CONTENT_KEYS.has(key)) return "execution_payload";
  }
  if (capability === "unknown") return "execution_payload";
  if (EXECUTION_KEYS.has(key)) return "execution_payload";
  if (EXTERNAL_TARGET_KEYS.has(key)) return "external_target";
  if (STATIC_CONTENT_KEYS.has(key)) return "static_content";
  if (METADATA_KEYS.has(key)) return "metadata";
  return inherited ?? "control";
}

function appendRiskValue(target: RiskInputExtraction, role: RiskArgumentRole, value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
  const text = String(value);
  target.by_role[role].push(text);
  target.entries.push({ path: path || "$", role, value: text });
  target.parameter_string_length += text.length;
  target.flattened_string_count += 1;
}

function walkRiskInputs(
  target: RiskInputExtraction,
  value: unknown,
  path = "",
  inheritedRole?: RiskArgumentRole,
  depth = 0
): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    appendRiskValue(target, inheritedRole ?? "control", value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkRiskInputs(target, value[index], path ? `${path}.${index}` : String(index), inheritedRole, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeArgumentKey(rawKey);
    if (sensitiveArgumentKey(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    const role = roleForArgument(target.capability, childPath, key, inheritedRole);
    walkRiskInputs(target, child, childPath, role, depth + 1);
  }
}

export function extractRiskInputs(toolName: string, args: unknown): RiskInputExtraction {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const extraction: RiskInputExtraction = {
    capability: capabilityForTool(safeTool),
    by_role: emptyRoleMap(),
    entries: [],
    parameter_string_length: 0,
    flattened_string_count: 0
  };
  walkRiskInputs(extraction, args);
  return extraction;
}

function walkLegacyRiskInputs(
  target: RiskInputExtraction,
  value: unknown,
  path = "",
  inheritedRole: RiskArgumentRole = "execution_payload",
  depth = 0
): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    appendRiskValue(target, inheritedRole, value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkLegacyRiskInputs(target, value[index], path ? `${path}.${index}` : String(index), inheritedRole, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeArgumentKey(rawKey);
    if (sensitiveArgumentKey(key)) continue;
    const childPath = path ? `${path}.${key}` : key;
    const role: RiskArgumentRole = AUTHORIZATION_KEYS.has(key)
      ? "authorization"
      : PATH_KEYS.has(key)
        ? "path"
        : "execution_payload";
    walkLegacyRiskInputs(target, child, childPath, role, depth + 1);
  }
}

export function extractLegacyRiskInputs(toolName: string, args: unknown): RiskInputExtraction {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const extraction: RiskInputExtraction = {
    capability: capabilityForTool(safeTool),
    by_role: emptyRoleMap(),
    entries: [],
    parameter_string_length: 0,
    flattened_string_count: 0
  };
  walkLegacyRiskInputs(extraction, args);
  return extraction;
}

function securityBoundaryMatches(entries: Array<{ path: string; value: string }>): UnifiedRiskSignalMatch[] {
  return entries
    .map((entry) => ({ ...entry, value: entry.value.replace(/\\/g, "/") }))
    .filter((entry) => SECURITY_BOUNDARY_PATH_PATTERNS.some((pattern) => pattern.test(entry.value)))
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.path === entry.path) === index)
    .map((entry) => ({ signal: "security_boundary_change", argument_path: entry.path, role: "path" }));
}

function explicitAuthorization(args: unknown, extraction: RiskInputExtraction): boolean {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const value = args as Record<string, unknown>;
    if (
      value.explicit_authorization === true
      || value.confirm_external_side_effect === true
      || value.confirm_high_risk === true
      || value.approved === true
    ) return true;
  }
  const text = extraction.by_role.authorization.join("\n");
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(text));
}

type ActionEntry = Omit<RiskArgumentEntry, "role"> & { role: RiskArgumentRole | "tool" };

function actionEntriesFor(toolName: string, extraction: RiskInputExtraction): ActionEntry[] {
  const capabilityCarriesAction = !["read_only", "static_file", "aggregate"].includes(extraction.capability);
  return [
    ...(capabilityCarriesAction ? [{ path: "$tool", role: "tool" as const, value: toolName.replace(/_/g, " ") }] : []),
    ...extraction.entries.filter((entry) => entry.role === "execution_payload" || entry.role === "external_target")
  ];
}

function matchRiskEntries(entries: ActionEntry[], definitions: Array<[RegExp, string]>): UnifiedRiskSignalMatch[] {
  const matches: UnifiedRiskSignalMatch[] = [];
  for (const [pattern, signal] of definitions) {
    for (const entry of entries) {
      if (!pattern.test(entry.value)) continue;
      if (!matches.some((item) => item.signal === signal && item.argument_path === entry.path)) {
        matches.push({ signal, argument_path: entry.path, role: entry.role });
      }
    }
  }
  return matches;
}

function actionTextFor(toolName: string, extraction: RiskInputExtraction): string {
  return actionEntriesFor(toolName, extraction).map((entry) => entry.value).join("\n");
}

function arrayHasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function aggregateEffectiveLevel(args: unknown): EffectiveSideEffectLevel {
  const classification = classifyAggregateToolCall("run_task", args);
  if (classification?.mode === "analysis_only") return classification.archive_requested ? "local_state" : "none";
  const root = recordValue(args);
  if (!root) return "unknown";
  if (arrayHasItems(root.patches) || arrayHasItems(root.operations)) return "workspace_write";
  if (arrayHasItems(root.commands)) return "process";
  return "unknown";
}

export function capabilitySideEffectLevelForTool(toolName: string): EffectiveSideEffectLevel {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const capability = capabilityForTool(safeTool);
  if (capability === "read_only") return "none";
  if (capability === "static_file" || capability === "aggregate") return "workspace_write";
  if (capability === "shell") return "process";
  if (capability === "git" || capability === "browser" || capability === "database" || capability === "external") return "network_write";
  return "unknown";
}

function looksLikeLocalWrite(toolName: string, text: string, args: unknown): boolean {
  if (L1_TOOL_NAMES.has(toolName)) return true;
  if (/^(?:run_task|run_stage|start_run_task|run_task_template)$/.test(toolName)) {
    return aggregateEffectiveLevel(args) !== "none";
  }
  if (/^(?:run_validation|run_acceptance)$/.test(toolName)) return true;
  if (/^(browser_click|browser_type|browser_select|browser_check|browser_upload)$/.test(toolName)) return true;
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?(build|test|lint|typecheck|smoke|release[-:]?gate)\b/i.test(text)) return true;
  if (/\b(pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test)\b/i.test(text)) return true;
  if (/\b(git\s+(add|commit)|docker\s+(build|compose\s+build))\b/i.test(text)) return true;
  return false;
}

function authorizationState(required: boolean, detected: boolean, denied = false): SideEffectAuthorization {
  if (denied) return "denied";
  if (detected) return "detected";
  return required ? "explicit_required" : "implicit_local";
}

function descriptorForSignal(
  signal: string,
  sourcePaths: string[],
  authorization: SideEffectAuthorization
): SideEffectDescriptor {
  const common = { version: 1 as const, authorization, source_paths: unique(sourcePaths), signals: [signal] };
  switch (signal) {
    case "financial_operation":
    case "order_submission":
    case "external_message":
      return { ...common, action: "business_critical", target: signal, scope: "business_critical", reversibility: "irreversible" };
    case "destructive_database":
      return { ...common, action: "destructive", target: "database", scope: "production", reversibility: "irreversible" };
    case "destructive_filesystem":
      return { ...common, action: "destructive", target: "filesystem", scope: "production", reversibility: "irreversible" };
    case "overwrite_production_backup":
      return { ...common, action: "destructive", target: "production_backup", scope: "production", reversibility: "irreversible" };
    case "git_push":
      return { ...common, action: "git_remote_update", target: "git_remote", scope: "external", reversibility: "conditional" };
    case "deployment_or_remote_config":
    case "deployment_or_publish":
    case "remote_cloud_write":
      return { ...common, action: "deployment", target: signal, scope: "production", reversibility: "conditional" };
    case "external_database_write":
      return { ...common, action: "database_write", target: "database", scope: "production", reversibility: "conditional" };
    case "external_http_write":
    case "docker_external_or_service_write":
      return { ...common, action: "external_write", target: signal, scope: "external", reversibility: "conditional" };
    case "security_boundary_change":
      return { ...common, action: "local_write", target: "security_boundary", scope: "workspace", reversibility: "reversible" };
    case "local_reversible_write":
      return { ...common, action: "local_write", target: "workspace", scope: "workspace", reversibility: "reversible" };
    default:
      return { ...common, action: "unknown", target: signal, scope: "unknown", reversibility: "unknown" };
  }
}

function descriptorsForMatches(
  matches: UnifiedRiskSignalMatch[],
  required: boolean,
  detected: boolean,
  denied = false
): SideEffectDescriptor[] {
  const signals = unique(matches.map((item) => item.signal));
  return signals.map((signal) => descriptorForSignal(
    signal,
    matches.filter((item) => item.signal === signal).map((item) => item.argument_path),
    authorizationState(required, detected, denied)
  ));
}

function controlSemanticsFor(input: {
  level: UnifiedRiskLevel;
  allowed: boolean;
  reasonCode: string;
  automaticReplayAllowed: boolean;
  sideEffects: SideEffectDescriptor[];
}): Pick<UnifiedRiskDecision, "control_kind" | "control_scope" | "enforcement" | "recoverable" | "retryable" | "blocks_only"> {
  const externalEffect = input.level === "L2"
    || input.level === "L3"
    || input.sideEffects.some((item) => item.scope === "external" || item.scope === "production" || item.scope === "business_critical");
  const writeBoundary = /path|security_boundary|write/.test(input.reasonCode) && !externalEffect;
  if (!input.allowed) {
    return {
      control_kind: "invariant",
      control_scope: writeBoundary ? "write_boundary" : externalEffect ? "external_effect_boundary" : "workspace_entry",
      enforcement: "block",
      recoverable: input.level !== "L3",
      retryable: false,
      blocks_only: [writeBoundary ? "workspace_write" : externalEffect ? "external_effect_execution" : "task_entry"]
    };
  }
  if (externalEffect) {
    return {
      control_kind: "invariant",
      control_scope: "external_effect_boundary",
      enforcement: "record",
      recoverable: true,
      retryable: input.automaticReplayAllowed,
      blocks_only: []
    };
  }
  if (/security_boundary/.test(input.reasonCode)) {
    return {
      control_kind: "invariant",
      control_scope: "write_boundary",
      enforcement: "warn",
      recoverable: true,
      retryable: input.automaticReplayAllowed,
      blocks_only: []
    };
  }
  return {
    control_kind: "policy",
    control_scope: "execution_policy",
    enforcement: "record",
    recoverable: true,
    retryable: input.automaticReplayAllowed,
    blocks_only: []
  };
}

function withExecutionMode(decision: UnifiedRiskDecision, mode: ExecutionControlMode | undefined): UnifiedRiskDecision {
  return mode && mode !== decision.execution_mode ? { ...decision, execution_mode: mode } : decision;
}

function buildDecision(input: {
  level: UnifiedRiskLevel;
  allowed: boolean;
  reason: string;
  reasonCode: string;
  checkpointRequired: boolean;
  explicitAuthorizationRequired: boolean;
  authorizationDetected: boolean;
  automaticReplayAllowed: boolean;
  matches?: UnifiedRiskSignalMatch[];
  sideEffects?: SideEffectDescriptor[];
}): UnifiedRiskDecision {
  const matches = input.matches ?? [];
  const sideEffects = input.sideEffects ?? [];
  const control = controlSemanticsFor({
    level: input.level,
    allowed: input.allowed,
    reasonCode: input.reasonCode,
    automaticReplayAllowed: input.automaticReplayAllowed,
    sideEffects
  });
  return {
    level: input.level,
    allowed: input.allowed,
    reason: input.reason,
    reason_code: input.reasonCode,
    ...control,
    execution_mode: "runtime",
    checkpoint_required: input.checkpointRequired,
    explicit_authorization_required: input.explicitAuthorizationRequired,
    authorization_detected: input.authorizationDetected,
    automatic_replay_allowed: input.automaticReplayAllowed,
    side_effect: sideEffects.length > 0,
    matched_signals: unique(matches.map((item) => item.signal)),
    matched_argument_paths: unique(matches.map((item) => item.argument_path)),
    signal_matches: matches,
    side_effects: sideEffects,
    capability_side_effect_level: "unknown",
    effective_side_effect_level: input.level === "L3" ? "business_critical" : input.level === "L2" ? "network_write" : input.level === "L1" ? "workspace_write" : "none",
    effective_operations: [],
    effective_paths: [],
    effective_external_targets: []
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface ContractAuthorizationExtraction {
  decision: StructuredTaskAuthorizationDecision;
  integrity_reasons: string[];
}

function authorizationDecisionFromArgs(args: unknown): ContractAuthorizationExtraction | undefined {
  const root = recordValue(args);
  const compiled = recordValue(root?.compiled_task) ?? recordValue(root?.task_contract);
  const candidate = recordValue(root?.authorization_decision) ?? recordValue(compiled?.authorization_decision);
  if (!candidate || candidate.version !== 1 || typeof candidate.decision_id !== "string" || !Array.isArray(candidate.allowed_actions)) return undefined;
  const decision = candidate as unknown as StructuredTaskAuthorizationDecision;
  const reasons: string[] = [];
  if (!decision.payload_binding) reasons.push("payload_binding_missing");
  else {
    const verification = verifyAuthorizationPayloadBinding(authorizationDecisionPayload(decision), decision.payload_binding);
    reasons.push(...verification.reasons.map((reason) => `payload_${reason}`));
  }
  if (!decision.permission_decision) reasons.push("permission_decision_missing");
  else {
    const verification = verifyPermissionDecision(decision.permission_decision);
    reasons.push(...verification.reasons.map((reason) => `permission_${reason}`));
  }
  return { decision, integrity_reasons: reasons };
}

function normalizedContractPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function contractPathMatches(pathValue: string, pattern: string): boolean {
  const path = normalizedContractPath(pathValue);
  const clean = normalizedContractPath(pattern);
  if (!clean) return false;
  if (clean.endsWith("/**")) return path === clean.slice(0, -3) || path.startsWith(clean.slice(0, -2));
  return path === clean || path.startsWith(clean.endsWith("/") ? clean : clean + "/");
}

function requestedContractActions(toolName: string, args: unknown, extraction: RiskInputExtraction): string[] {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const actionText = actionEntriesFor(safeTool, extraction).map((entry) => entry.value).join("\n");
  const actions: string[] = [];
  const readOnly = extraction.capability === "read_only" || L0_PREFIXES.some((prefix) => safeTool === prefix || safeTool.startsWith(prefix));
  if (readOnly) actions.push("read_workspace");
  if (["write", "edit", "apply_patch_bundle"].includes(safeTool)) {
    const paths = extraction.entries.filter((entry) => entry.role === "path").map((entry) => entry.value);
    if (paths.length && paths.every((value) => /(^|\/)(planning-local|docs|reports?|\.ai-bridge|\.codexpro)(\/|$)|\.(md|json|ya?ml|txt|html)$/i.test(value))) actions.push("write_artifacts");
    else actions.push("write_source");
  }
  if (safeTool === "git_prepare" || safeTool === "commit_assistant" || safeTool === "git_finalize") actions.push("git_local");
  const aggregate = classifyAggregateToolCall(safeTool, args);
  if (aggregate?.mode === "analysis_only") {
    actions.push(aggregate.archive_requested ? "write_artifacts" : "read_workspace");
  }
  if (aggregate?.mode === "engineering" && arrayHasItems(recordValue(args)?.patches)) {
    actions.push("write_source");
  }
  if (safeTool === "bash" || safeTool === "run_validation" || safeTool === "run_acceptance" || (aggregate?.mode === "engineering" && arrayHasItems(recordValue(args)?.commands))) actions.push("run_bash");
  if (safeTool === "git_push_only" || (safeTool === "git_finalize" && detectGitIntentFromArgs(args).actions.includes("push")) || /\bgit\s+push\b|\bpush\s+origin\b/i.test(actionText)) actions.push("git_push");
  if (/^browser_/.test(safeTool)) actions.push("use_browser");
  if (safeTool === "database_readonly_query" || safeTool === "database_schema_summary") actions.push("read_database");
  if (/\b(update|insert\s+into|delete\s+from|alter\s+table|create\s+table|drop\s+table|truncate\s+table)\b/i.test(actionText)) actions.push("write_database");
  if (/\b(kubectl|helm|terraform|npm\s+publish|deploy)\b/i.test(actionText) || safeTool === "docker_restart_service") actions.push("deployment");
  if (/\b(?:POST|PUT|PATCH|DELETE)\b|--data|--upload-file/i.test(actionText)) actions.push("external_write");
  const normalized = actions.some((action) => ["git_push", "external_write", "deployment", "write_database"].includes(action))
    ? actions.filter((action) => action !== "run_bash")
    : actions;
  return unique(normalized.length ? normalized : ["read_workspace"]);
}

function evaluateContractRisk(
  toolName: string,
  args: unknown,
  extraction: RiskInputExtraction
): UnifiedRiskDecision | undefined {
  const extracted = authorizationDecisionFromArgs(args);
  if (!extracted) return undefined;
  const contract = extracted.decision;
  if (extracted.integrity_reasons.length) {
    const matches: UnifiedRiskSignalMatch[] = extracted.integrity_reasons.map((reason) => ({
      signal: `authorization_integrity:${reason}`,
      argument_path: "$authorization_decision",
      role: "authorization"
    }));
    return buildDecision({
      level: "L2",
      allowed: false,
      reason: `Task authorization ${contract.decision_id} failed integrity verification: ${extracted.integrity_reasons.join(", ")}. Recompile or re-authorize the exact payload before execution.`,
      reasonCode: "contract_authorization_integrity_failed",
      checkpointRequired: true,
      explicitAuthorizationRequired: true,
      authorizationDetected: false,
      automaticReplayAllowed: false,
      matches,
      sideEffects: []
    });
  }
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const actionEntries = actionEntriesFor(safeTool, extraction);
  const l3Matches = matchRiskEntries(actionEntries, L3_SIGNALS);
  if (l3Matches.length) {
    return buildDecision({
      level: "L3",
      allowed: false,
      reason: "Task authorization " + contract.decision_id + " cannot authorize irreversible or business-critical execution payloads.",
      reasonCode: "contract_l3_prohibited",
      checkpointRequired: true,
      explicitAuthorizationRequired: true,
      authorizationDetected: false,
      automaticReplayAllowed: false,
      matches: l3Matches,
      sideEffects: descriptorsForMatches(l3Matches, true, false)
    });
  }
  const requested = requestedContractActions(safeTool, args, extraction);
  const missing = requested.filter((action) => !contract.allowed_actions.includes(action));
  const pathEntries = extraction.entries.filter((entry) => entry.role === "path");
  const forbidden = pathEntries.filter((entry) => (contract.forbidden_paths ?? []).some((pattern) => contractPathMatches(entry.value, pattern)));
  const allowedPaths = contract.allowed_paths ?? [];
  const outsideScope = allowedPaths.length
    ? pathEntries.filter((entry) => !(allowedPaths.some((pattern) => contractPathMatches(entry.value, pattern))))
    : [];
  if (missing.length || forbidden.length || outsideScope.length) {
    const pathMatches: UnifiedRiskSignalMatch[] = [...forbidden, ...outsideScope].map((entry) => ({
      signal: forbidden.includes(entry) ? "contract_forbidden_path" : "contract_path_outside_scope",
      argument_path: entry.path,
      role: "path"
    }));
    return buildDecision({
      level: requested.some((action) => ["git_push", "external_write", "deployment", "write_database"].includes(action)) ? "L2" : "L1",
      allowed: false,
      reason: "Requested action does not match Task authorization " + contract.decision_id + ": " + [...missing, ...pathMatches.map((item) => item.signal)].join(", ") + ".",
      reasonCode: missing.length ? "contract_action_not_allowed" : "contract_path_not_allowed",
      checkpointRequired: true,
      explicitAuthorizationRequired: missing.some((action) => ["git_push", "external_write", "deployment", "write_database"].includes(action)),
      authorizationDetected: false,
      automaticReplayAllowed: false,
      matches: pathMatches,
      sideEffects: []
    });
  }
  if (contract.permission_decision && !permissionDecisionAllowsExecution(contract.permission_decision)) {
    const finalDecision = contract.permission_decision.final_decision;
    return buildDecision({
      level: finalDecision === "deny" ? "L3" : "L2",
      allowed: false,
      reason: `Task authorization ${contract.decision_id} has monotonic permission result ${finalDecision}: ${contract.permission_decision.reasons.join(" | ")}.`,
      reasonCode: finalDecision === "deny" ? "contract_permission_denied" : "contract_permission_approval_required",
      checkpointRequired: true,
      explicitAuthorizationRequired: finalDecision === "ask",
      authorizationDetected: false,
      automaticReplayAllowed: false,
      matches: [{ signal: `permission_${finalDecision}`, argument_path: "$authorization_decision.permission_decision", role: "authorization" }],
      sideEffects: []
    });
  }
  const external = requested.filter((action) => ["git_push", "external_write", "deployment", "write_database"].includes(action));
  const evidence = contract.authorization_evidence ?? [];
  if (external.length && !evidence.length) {
    return buildDecision({
      level: "L2",
      allowed: false,
      reason: "Task authorization " + contract.decision_id + " lacks explicit authorization evidence for " + external.join(", ") + ".",
      reasonCode: "contract_external_authorization_missing",
      checkpointRequired: true,
      explicitAuthorizationRequired: true,
      authorizationDetected: false,
      automaticReplayAllowed: false
    });
  }
  const level: UnifiedRiskLevel = external.length ? "L2" : requested.every((action) => action === "read_workspace" || action === "read_database") ? "L0" : "L1";
  const localMatch: UnifiedRiskSignalMatch | undefined = level === "L1" ? {
    signal: "contract_reversible_local_action",
    argument_path: "$authorization_decision",
    role: "control"
  } : undefined;
  return buildDecision({
    level,
    allowed: true,
    reason: "Requested action matches Task authorization " + contract.decision_id + ": " + requested.join(", ") + ".",
    reasonCode: level === "L0" ? "contract_read_allowed" : level === "L1" ? "contract_local_action_allowed" : "contract_external_action_authorized",
    checkpointRequired: level !== "L0",
    explicitAuthorizationRequired: external.length > 0,
    authorizationDetected: external.length ? evidence.length > 0 : true,
    automaticReplayAllowed: level === "L0" || requested.every((action) => ["read_workspace", "read_database", "write_artifacts"].includes(action)),
    matches: localMatch ? [localMatch] : [],
    sideEffects: external.map((action) => ({
      version: 1,
      action: action === "git_push" ? "git_remote_update" : action === "write_database" ? "database_write" : action === "deployment" ? "deployment" : "external_write",
      target: contract.external_side_effects?.find((item) => item.action === action)?.target ?? "contract target",
      scope: action === "deployment" ? "production" : "external",
      authorization: "detected",
      reversibility: contract.external_side_effects?.find((item) => item.action === action)?.reversible ? "reversible" : "conditional",
      source_paths: ["$authorization_decision"],
      signals: [action]
    } as SideEffectDescriptor))
  });
}

function evaluateUnifiedRiskFromInputs(
  toolName: string,
  args: unknown,
  extraction: RiskInputExtraction
): UnifiedRiskDecision {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const actionEntries = actionEntriesFor(safeTool, extraction);
  const actionText = actionEntries.map((entry) => entry.value).join("\n");
  const authorizationDetected = explicitAuthorization(args, extraction);
  const gitIntent = detectGitIntentFromArgs(args);
  const l3Matches = matchRiskEntries(actionEntries, L3_SIGNALS);
  if (l3Matches.length) {
    const signals = unique(l3Matches.map((item) => item.signal));
    return buildDecision({
      level: "L3",
      allowed: false,
      reason: `Automatic execution is prohibited for irreversible or business-critical operation(s): ${signals.join(", ")} at ${unique(l3Matches.map((item) => item.argument_path)).join(", ")}.`,
      reasonCode: "l3_irreversible_or_business_critical",
      checkpointRequired: true,
      explicitAuthorizationRequired: true,
      authorizationDetected,
      automaticReplayAllowed: false,
      matches: l3Matches,
      sideEffects: descriptorsForMatches(l3Matches, true, authorizationDetected)
    });
  }
  const l2Matches = matchRiskEntries(actionEntries, L2_SIGNALS);
  if (safeTool === "git_finalize" && gitIntent.actions.includes("push") && !l2Matches.some((match) => match.signal === "git_push")) {
    l2Matches.push({ signal: "git_push", argument_path: "user_intent", role: "authorization" });
  }
  if (l2Matches.length) {
    const signals = unique(l2Matches.map((item) => item.signal));
    const gitPushDetected = signals.includes("git_push");
    const nonGitSignals = signals.filter((signal) => signal !== "git_push");
    const gitPushExplicitlyDenied = gitPushDetected && gitIntent.negated;
    const missingGenericApproval = nonGitSignals.length > 0 && !authorizationDetected;
    const allowed = !gitPushExplicitlyDenied && !missingGenericApproval;
    const effectiveAuthorizationDetected = gitPushDetected
      ? !gitPushExplicitlyDenied && !missingGenericApproval
      : authorizationDetected;
    const blockers = [
      ...(gitPushExplicitlyDenied ? ["Git push was explicitly negated by the user instruction"] : []),
      ...(missingGenericApproval ? ["explicit authorization is required for non-Git external side effects"] : [])
    ];
    return buildDecision({
      level: "L2",
      allowed,
      reason: allowed
        ? gitPushDetected && nonGitSignals.length === 0
          ? "Git remote update is trusted by local policy and may execute without a fixed approval phrase. External state must be verified after execution."
          : `Explicit authorization detected for external side effect(s): ${signals.join(", ")}. External state must be verified after execution.`
        : `Explicit authorization is required for external side effect(s): ${signals.join(", ")} at ${unique(l2Matches.map((item) => item.argument_path)).join(", ")}. ${blockers.join("; ")}.`,
      reasonCode: allowed ? "l2_external_side_effect_authorized" : gitPushExplicitlyDenied ? "l2_git_push_explicitly_denied" : "l2_external_authorization_required",
      checkpointRequired: true,
      explicitAuthorizationRequired: nonGitSignals.length > 0,
      authorizationDetected: effectiveAuthorizationDetected,
      automaticReplayAllowed: false,
      matches: l2Matches,
      sideEffects: descriptorsForMatches(l2Matches, nonGitSignals.length > 0, effectiveAuthorizationDetected, gitPushExplicitlyDenied)
    });
  }
  if (looksLikeLocalWrite(safeTool, actionText, args)) {
    const boundaryMatches = securityBoundaryMatches(
      extraction.entries.filter((entry) => entry.role === "path").map((entry) => ({ path: entry.path, value: entry.value }))
    );
    const localMatch: UnifiedRiskSignalMatch = {
      signal: "local_reversible_write",
      argument_path: extraction.entries.find((entry) => entry.role === "path")?.path ?? "$tool",
      role: extraction.entries.some((entry) => entry.role === "path") ? "path" : "tool"
    };
    const matches = [localMatch, ...boundaryMatches];
    return buildDecision({
      level: "L1",
      allowed: true,
      reason: boundaryMatches.length
        ? `Reversible local write targets a security boundary or execution entrypoint at ${boundaryMatches.map((item) => item.argument_path).join(", ")}. Preserve the normal checkpoint and require focused review.`
        : "Reversible local write or bounded local validation. Use the existing Goal Snapshot, Worktree, Git diff, or atomic file-write checkpoint.",
      reasonCode: boundaryMatches.length ? "l1_security_boundary_write" : "l1_reversible_local_write",
      checkpointRequired: true,
      explicitAuthorizationRequired: false,
      authorizationDetected,
      automaticReplayAllowed: false,
      matches,
      sideEffects: descriptorsForMatches(matches, false, authorizationDetected)
    });
  }
  const knownRead = extraction.capability === "read_only"
    || L0_PREFIXES.some((prefix) => safeTool === prefix || safeTool.startsWith(prefix));
  return buildDecision({
    level: "L0",
    allowed: true,
    reason: knownRead ? "Read-only operation." : "No external or destructive side-effect signal was detected.",
    reasonCode: knownRead ? "l0_read_only" : "l0_no_side_effect_signal",
    checkpointRequired: false,
    explicitAuthorizationRequired: false,
    authorizationDetected,
    automaticReplayAllowed: true
  });
}

function operationMetadataFor(
  toolName: string,
  args: unknown,
  extraction: RiskInputExtraction,
  decision: UnifiedRiskDecision
): Pick<UnifiedRiskDecision, "capability_side_effect_level" | "effective_side_effect_level" | "effective_operations" | "effective_paths" | "effective_external_targets"> {
  const safeTool = String(toolName ?? "").trim().toLowerCase();
  const root = recordValue(args);
  const operations: string[] = [];
  const paths = unique(extraction.entries.filter((entry) => entry.role === "path").map((entry) => entry.value));
  const externalTargets = unique([
    ...extraction.entries.filter((entry) => entry.role === "external_target").map((entry) => entry.value),
    ...decision.side_effects.filter((item) => item.scope === "external" || item.scope === "production" || item.scope === "business_critical").map((item) => item.target)
  ]);
  let effective: EffectiveSideEffectLevel;
  if (decision.level === "L3") effective = "business_critical";
  else if (decision.level === "L2") effective = "network_write";
  else if (/^(?:run_task|run_stage|start_run_task|run_task_template)$/.test(safeTool)) effective = aggregateEffectiveLevel(args);
  else if (/^(?:run_validation|run_acceptance|bash|node_run_script|python_run_tests|php_lint_files)$/.test(safeTool)) effective = "process";
  else if (safeTool === "git_finalize" || safeTool === "git_prepare" || safeTool === "commit_assistant") {
    effective = detectGitIntentFromArgs(args).actions.includes("push") ? "network_write" : "git_local";
  } else if (["write", "edit", "apply_patch_bundle"].includes(safeTool)) effective = "workspace_write";
  else if (decision.level === "L1") effective = "local_state";
  else effective = "none";

  if (arrayHasItems(root?.search_queries) || arrayHasItems(root?.queries)) operations.push("search_workspace");
  if (arrayHasItems(root?.read_files) || arrayHasItems(root?.files)) operations.push("read_workspace");
  if (arrayHasItems(root?.patches) || arrayHasItems(root?.operations) || ["write", "edit", "apply_patch_bundle"].includes(safeTool)) operations.push("write_workspace");
  if (arrayHasItems(root?.commands) || /^(?:run_validation|run_acceptance|bash|node_run_script|python_run_tests|php_lint_files)$/.test(safeTool)) operations.push("run_command");
  const gitIntent = detectGitIntentFromArgs(args);
  if (safeTool.startsWith("git_") || safeTool === "commit_assistant") {
    if (gitIntent.actions.includes("commit") || safeTool !== "git_push_only") operations.push("git_commit");
    if (gitIntent.actions.includes("push") || safeTool === "git_push_only") operations.push("git_push");
  }
  operations.push(...decision.side_effects.map((item) => item.action));
  if (!operations.length && effective === "none") operations.push("read_only");

  return {
    capability_side_effect_level: capabilitySideEffectLevelForTool(safeTool),
    effective_side_effect_level: effective,
    effective_operations: unique(operations),
    effective_paths: paths,
    effective_external_targets: externalTargets
  };
}

export function evaluateUnifiedRiskWithObservation(
  toolName: string,
  args: unknown,
  options: UnifiedRiskEvaluationOptions = {}
): UnifiedRiskBaselineObservation {
  const preHandlerStarted = performance.now();
  const riskStarted = performance.now();
  const extraction = options.toolAwareInputs === false
    ? extractLegacyRiskInputs(toolName, args)
    : extractRiskInputs(toolName, args);
  const actionEntries = actionEntriesFor(String(toolName ?? "").trim().toLowerCase(), extraction);
  const contractDecision = evaluateContractRisk(toolName, args, extraction);
  const baseDecision = withExecutionMode(
    contractDecision ?? evaluateUnifiedRiskFromInputs(toolName, args, extraction),
    options.executionMode
  );
  const decision: UnifiedRiskDecision = {
    ...baseDecision,
    ...operationMetadataFor(toolName, args, extraction, baseDecision)
  };
  const riskDecisionMs = performance.now() - riskStarted;
  const regexScanCount = contractDecision
    ? (actionEntries.length ? L3_SIGNALS.length : 0)
    : APPROVAL_PATTERNS.length
      + (actionEntries.length ? L3_SIGNALS.length : 0)
      + (actionEntries.length && decision.level !== "L3" ? L2_SIGNALS.length : 0);
  return {
    decision,
    risk_decision_ms: riskDecisionMs,
    handler_before_total_ms: performance.now() - preHandlerStarted,
    regex_scan_count: regexScanCount,
    parameter_string_length: extraction.parameter_string_length,
    flattened_string_count: extraction.flattened_string_count,
    tool_class: extraction.capability,
    argument_roles: (Object.entries(extraction.by_role) as Array<[RiskArgumentRole, string[]]>)
      .filter(([, values]) => values.length > 0)
      .map(([role]) => role)
  };
}

export function evaluateUnifiedRisk(
  toolName: string,
  args: unknown,
  options: UnifiedRiskEvaluationOptions = {}
): UnifiedRiskDecision {
  return evaluateUnifiedRiskWithObservation(toolName, args, options).decision;
}

function taskSignalForStructuredAction(action: SideEffectAction): { level: "L2" | "L3"; signal: string } | undefined {
  if (action === "business_critical") return { level: "L3", signal: "order_submission" };
  if (action === "destructive") return { level: "L3", signal: "destructive_database" };
  if (action === "git_remote_update") return { level: "L2", signal: "git_push" };
  if (action === "database_write") return { level: "L2", signal: "external_database_write" };
  if (action === "external_write") return { level: "L2", signal: "external_http_write" };
  if (action === "deployment") return { level: "L2", signal: "deployment_or_publish" };
  return undefined;
}

function structuredTaskRiskMatches(input: TaskRiskProfileInput): {
  l2: UnifiedRiskSignalMatch[];
  l3: UnifiedRiskSignalMatch[];
} {
  const l2: UnifiedRiskSignalMatch[] = [];
  const l3: UnifiedRiskSignalMatch[] = [];
  const sources = [
    ...(input.planned_actions ?? []).map((item, index) => ({
      ...item,
      path: `planned_actions.${index}.action`
    })),
    ...(input.side_effects ?? []).map((item, index) => ({
      ...item,
      path: `side_effects.${index}.action`
    }))
  ];
  for (const source of sources) {
    const matched = taskSignalForStructuredAction(source.action);
    if (!matched) continue;
    const match: UnifiedRiskSignalMatch = {
      signal: matched.signal,
      argument_path: source.path,
      role: "control"
    };
    (matched.level === "L3" ? l3 : l2).push(match);
  }
  if (input.write_database && !l2.some((item) => item.signal === "external_database_write")) {
    l2.push({ signal: "external_database_write", argument_path: "capabilities.write_database", role: "control" });
  }
  return { l2, l3 };
}

export function evaluateTaskRiskProfile(input: TaskRiskProfileInput): UnifiedRiskDecision {
  const finishDecision = (decision: UnifiedRiskDecision): UnifiedRiskDecision => withExecutionMode(decision, input.execution_mode);
  const authorizationText = input.authorization_text?.trim() ?? "";
  const authorizationDetected = input.explicit_authorization === true
    || (authorizationText.length > 0 && APPROVAL_PATTERNS.some((pattern) => pattern.test(authorizationText)));
  const structuredMatches = structuredTaskRiskMatches(input);
  if (structuredMatches.l3.length) {
    const signals = unique(structuredMatches.l3.map((item) => item.signal));
    return finishDecision(buildDecision({
      level: "L3",
      allowed: false,
      reason: `Structured task actions describe prohibited business-critical or irreversible operation(s): ${signals.join(", ")}.`,
      reasonCode: "task_l3_irreversible_or_business_critical",
      checkpointRequired: true,
      explicitAuthorizationRequired: true,
      authorizationDetected,
      automaticReplayAllowed: false,
      matches: structuredMatches.l3,
      sideEffects: descriptorsForMatches(structuredMatches.l3, true, authorizationDetected)
    }));
  }
  if (structuredMatches.l2.length) {
    const signals = unique(structuredMatches.l2.map((item) => item.signal));
    const gitOnly = signals.every((signal) => signal === "git_push");
    const gitIntent = gitOnly
      ? detectGitIntentFromArgs({ task_instruction: input.instruction.trim() })
      : { detected: false, actions: [], negated: false };
    const allowed = gitOnly ? !gitIntent.negated : authorizationDetected;
    return finishDecision(buildDecision({
      level: "L2",
      allowed,
      reason: allowed
        ? `Task includes authorized structured external side effect(s): ${signals.join(", ")}.`
        : `Task includes structured external side effect(s) requiring final tool-level authorization: ${signals.join(", ")}.`,
      reasonCode: allowed ? "task_l2_external_authorized" : "task_l2_final_gate_required",
      checkpointRequired: true,
      explicitAuthorizationRequired: !gitOnly,
      authorizationDetected: allowed,
      automaticReplayAllowed: false,
      matches: structuredMatches.l2,
      sideEffects: descriptorsForMatches(structuredMatches.l2, !gitOnly, allowed, gitIntent.negated)
    }));
  }
  const localWrite = input.source_write || input.artifact_write || input.run_bash || input.use_browser || input.use_git;
  if (localWrite) {
    const boundaryMatches = securityBoundaryMatches(
      input.scope_paths.map((value, index) => ({ path: `scope_paths.${index}`, value }))
    );
    const localMatch: UnifiedRiskSignalMatch = {
      signal: "local_reversible_write",
      argument_path: input.scope_paths.length ? "scope_paths.0" : "task.capabilities",
      role: input.scope_paths.length ? "path" : "control"
    };
    const matches = [localMatch, ...boundaryMatches];
    return finishDecision(buildDecision({
      level: "L1",
      allowed: true,
      reason: boundaryMatches.length
        ? `Task includes a reversible write to security-sensitive scope: ${boundaryMatches.map((item) => item.argument_path).join(", ")}.`
        : "Task includes only reversible local writes, bounded local commands, or non-critical browser interaction.",
      reasonCode: boundaryMatches.length ? "task_l1_security_boundary" : "task_l1_reversible_local_effect",
      checkpointRequired: true,
      explicitAuthorizationRequired: false,
      authorizationDetected,
      automaticReplayAllowed: false,
      matches,
      sideEffects: descriptorsForMatches(matches, false, authorizationDetected)
    }));
  }
  return finishDecision(buildDecision({
    level: "L0",
    allowed: true,
    reason: "Task capabilities are read-only and contain no external side effect.",
    reasonCode: "task_l0_read_only",
    checkpointRequired: false,
    explicitAuthorizationRequired: false,
    authorizationDetected,
    automaticReplayAllowed: true
  }));
}

export function taskRiskLevelFromUnified(decision: UnifiedRiskDecision): "low" | "medium" | "high" | "critical" {
  if (decision.level === "L3") return "critical";
  if (decision.level === "L2") return "high";
  if (decision.level === "L1") return "medium";
  return "low";
}

export function observeUnifiedRiskBaseline(
  toolName: string,
  args: unknown,
  options: UnifiedRiskEvaluationOptions = {}
): UnifiedRiskBaselineObservation {
  return evaluateUnifiedRiskWithObservation(toolName, args, options);
}

export function assertUnifiedRiskAllowed(
  toolName: string,
  args: unknown,
  options: UnifiedRiskEvaluationOptions = {}
): UnifiedRiskDecision {
  const decision = evaluateUnifiedRisk(toolName, args, options);
  if (!decision.allowed) throw new Error(`Unified risk gate blocked ${toolName}: ${decision.reason}`);
  return decision;
}
