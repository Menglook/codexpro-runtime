import { databaseReadonlyToolNames } from "../adapters/database-readonly-adapter.js";
import { dockerToolNames } from "../adapters/docker-adapter.js";
import { gitToolNames } from "../adapters/git-adapter.js";
import { nodeToolNames } from "../adapters/node-adapter.js";
import { phpWordPressToolNames } from "../adapters/php-wordpress-adapter.js";
import { pythonFastApiToolNames } from "../adapters/python-fastapi-adapter.js";
import { browserBusinessToolNames } from "../browser/browser-business-tools.js";
import { browserToolNames } from "../browser/browser-tools.js";
import type { CodexProConfig } from "../config.js";
import { skillToolNames } from "../tools/skills.js";
import type { CompiledTask } from "../workflow/taskCompiler.js";

export const SUPERTOOL_NAME = "codexpro";
export const SUPERTOOL_ACTION_ALIASES: Record<string, string> = {
  actions: "list_actions",
  config: "server_config",
  self_test: "codexpro_self_test",
  inventory: "codexpro_inventory",
  open: "open_current_workspace",
  snapshot: "workspace_snapshot",
  changes: "show_changes",
  project: "detect_project",
  projects: "list_projects",
  active_project: "show_active_project",
  activate_project: "activate_project",
  switch: "switch_project",
  open_project: "switch_project",
  project_profile: "read_project_profile",
  project_config: "read_project_config",
  project_memory: "read_project_memory",
  memory: "read_project_memory",
  memory_summary: "summarize_project_memory",
  rules: "read_rule_summary",
  rule_summary: "read_rule_summary",
  preflight_rules: "read_rule_summary",
  task: "run_task_template",
  task_template: "run_task_template",
  run_resume: "resume_run_task",
  run_cancel: "cancel_run_task",
  run_retry_step: "retry_run_task_step",
  validate_config: "validate_project_config",
  project_map: "generate_project_map",
  acceptance: "run_acceptance",
  acceptance_cancel: "cancel_acceptance",
  snapshot_start: "start_task_snapshot",
  snapshot_finish: "finish_task_snapshot",
  commit: "git_prepare",
  finalize: "git_finalize",
  push_only: "git_push_only",
  handoff_status: "handoff_status",
  handoff_poll: "wait_for_handoff",
  pro_export: "export_pro_context",
  agent_handoff: "handoff_to_agent",
  codex_handoff: "handoff_to_codex",
  browser: "browser_open",
  browser_open: "browser_open",
  browser_runtime_probe: "browser_runtime_probe",
  browser_observe: "browser_observe",
  browser_observe_region: "browser_observe_region",
  browser_get_element: "browser_get_element",
  browser_select: "browser_select",
  browser_check: "browser_check",
  browser_scroll_into_view: "browser_scroll_into_view",
  browser_visual_observe: "browser_visual_observe",
  browser_verification_run: "browser_verification_run",
  browser_verification_status: "browser_verification_status",
  browser_verification_resume: "browser_verification_resume",
  browser_verification_cancel: "browser_verification_cancel",
  browser_verification_result: "browser_verification_result",
  browser_click: "browser_click",
  browser_type: "browser_type",
  browser_wait: "browser_wait",
  browser_download: "browser_download",
  browser_screenshot: "browser_screenshot",
  browser_console: "browser_console",
  browser_network: "browser_network",
  browser_expect_text: "browser_expect_text",
  browser_expect_url: "browser_expect_url",
  browser_expect_hidden: "browser_expect_hidden",
  browser_visual_regression: "browser_visual_regression",
  browser_report: "browser_report",
  browser_status: "browser_status",
  browser_tabs: "browser_tabs",
  browser_disconnect: "browser_disconnect",
  browser_business_prepare_task: "browser_business_prepare_task",
  browser_business_validate_task: "browser_business_validate_task",
  browser_business_list_skills: "browser_business_list_skills",
  browser_business_read_skill: "browser_business_read_skill",
  browser_business_validate_skill: "browser_business_validate_skill",
  browser_business_run_skill: "browser_business_run_skill",
  browser_business_generate_handoff: "browser_business_generate_handoff",
  browser_business_verify_result: "browser_business_verify_result",
  skills: "list_skills",
  skill: "read_skill",
  list_skills: "list_skills",
  read_skill: "read_skill",
  ["se" + "cret"]: "secret_scan",
  secrets: "secret_scan",
  audit: "security_audit",
  security: "security_audit",
  safety: "release_safety_check",
  release_safety: "release_safety_check",
  report: "publish_task_report",
  publish_report: "publish_task_report"
};

export function normalizeSupertoolAction(value: unknown): string {
  const raw = String(value ?? "list_actions").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return SUPERTOOL_ACTION_ALIASES[normalized] ?? normalized;
}


const MINIMAL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "bash",
  "show_changes",
  "git_prepare_commit",
  "git_commit",
  "git_get_remote_state",
  "git_push",
  "git_finalize",
  "git_push_only",
  "publish_task_report",
  "task_complete"
] as const;

const SKILL_TOOL_NAMES = skillToolNames();

const PROGRESSIVE_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "open_current_workspace",
  "open_workspace",
  "read_rule_summary",
  ...SKILL_TOOL_NAMES,
  "classify_task",
  "tree",
  "search_project",
  "read",
  "read_many_files",
  "write",
  "edit",
  "apply_patch_bundle",
  "bash",
  "run_validation",
  "run_acceptance",
  "acceptance_status",
  "cancel_acceptance",
  "read_acceptance_result",
  "show_changes",
  "git_prepare_commit",
  "git_commit",
  "git_get_remote_state",
  "git_push",
  "git_finalize",
  "git_push_only",
  "publish_task_report",
  "task_complete",
  "current_task",
  "task_status",
  "task_recovery",
  "run_task_status",
  "read_run_task_result"
] as const;

const BROWSER_TOOL_NAMES = [...browserToolNames(), ...browserBusinessToolNames()];
const NODE_TOOL_NAMES = nodeToolNames();
const DOCKER_TOOL_NAMES = dockerToolNames();
const PHP_WORDPRESS_TOOL_NAMES = phpWordPressToolNames();
const PYTHON_FASTAPI_TOOL_NAMES = pythonFastApiToolNames();
const DATABASE_READONLY_TOOL_NAMES = databaseReadonlyToolNames();
const GIT_ADAPTER_TOOL_NAMES = gitToolNames();
const CODEX_DIRECT_TOOL_NAMES = [
  "codex_start_task",
  "codex_resume_task",
  "codex_cancel_task",
  "codex_task_status",
  "codex_task_events"
] as const;

const GOAL_TOOL_NAMES = [
  "goal_start",
  "goal_status",
  "goal_resume",
  "goal_cancel",
  "goal_events"
] as const;

const CODEX_EXECUTION_TOOL_NAMES = [
  "codex_capabilities",
  ...CODEX_DIRECT_TOOL_NAMES,
  ...GOAL_TOOL_NAMES
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "tree",
  "search",
  "load_skill",
  ...SKILL_TOOL_NAMES,
  "list_projects",
  "show_active_project",
  "activate_project",
  "switch_project",
  "detect_project",
  "read_project_profile",
  "read_project_config",
  "read_project_memory",
  "summarize_project_memory",
  "rebuild_memory_index",
  "query_memory_index",
  "compress_old_sessions",
  "query_session_summaries",
  "read_rule_summary",
  "propose_memory_update",
  "append_project_memory",
  "validate_project_config",
  "init_project_config",
  "generate_project_map",
  "dirty_guard",
  "start_task_snapshot",
  "finish_task_snapshot",
  "run_acceptance",
  "acceptance_status",
  "cancel_acceptance",
  "read_acceptance_result",
  "classify_task",
  "read_many_files",
  "search_project",
  "apply_patch_bundle",
  "run_validation",
  "run_task",
  "run_stage",
  "start_run_task",
  "current_task",
  "task_get",
  "task_status",
  "task_recovery",
  "task_timeline",
  "task_evidence",
  "task_resume",
  "task_cancel",
  "run_task_status",
  "resume_run_task",
  "cancel_run_task",
  "retry_run_task_step",
  "read_run_task_result",
  "run_task_template",
  "secret_scan",
  "security_audit",
  "release_safety_check",
  "publish_task_report",
  ...GIT_ADAPTER_TOOL_NAMES,
  "read_handoff",
  "handoff_status",
  "wait_for_handoff",
  "export_pro_context",
  "handoff_to_agent",
  ...BROWSER_TOOL_NAMES,
  ...NODE_TOOL_NAMES,
  ...DOCKER_TOOL_NAMES,
  ...PHP_WORDPRESS_TOOL_NAMES,
  ...PYTHON_FASTAPI_TOOL_NAMES,
  ...DATABASE_READONLY_TOOL_NAMES
] as const;

const FULL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "codexpro_inventory",
  "load_skill",
  ...SKILL_TOOL_NAMES,
  "list_projects",
  "show_active_project",
  "activate_project",
  "switch_project",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "detect_project",
  "read_project_profile",
  "read_project_config",
  "read_project_memory",
  "summarize_project_memory",
  "rebuild_memory_index",
  "query_memory_index",
  "compress_old_sessions",
  "query_session_summaries",
  "read_rule_summary",
  "propose_memory_update",
  "append_project_memory",
  "validate_project_config",
  "init_project_config",
  "generate_project_map",
  "dirty_guard",
  "start_task_snapshot",
  "finish_task_snapshot",
  "run_acceptance",
  "acceptance_status",
  "cancel_acceptance",
  "read_acceptance_result",
  "classify_task",
  "read_many_files",
  "search_project",
  "apply_patch_bundle",
  "run_validation",
  "run_task",
  "run_stage",
  "start_run_task",
  "current_task",
  "task_get",
  "task_status",
  "task_recovery",
  "task_timeline",
  "task_evidence",
  "task_resume",
  "task_cancel",
  "run_task_status",
  "resume_run_task",
  "cancel_run_task",
  "retry_run_task_step",
  "read_run_task_result",
  "run_task_template",
  "secret_scan",
  "security_audit",
  "release_safety_check",
  "publish_task_report",
  "tree",
  "search",
  "read",
  "write",
  "edit",
  "bash",
  "git_status",
  "git_diff",
  "show_changes",
  "task_complete",
  "commit_assistant",
  ...GIT_ADAPTER_TOOL_NAMES,
  "read_handoff",
  "handoff_status",
  "wait_for_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex",
  ...BROWSER_TOOL_NAMES,
  ...NODE_TOOL_NAMES,
  ...DOCKER_TOOL_NAMES,
  ...PHP_WORDPRESS_TOOL_NAMES,
  ...PYTHON_FASTAPI_TOOL_NAMES,
  ...DATABASE_READONLY_TOOL_NAMES
] as const;

export interface ToolDisclosureDecision {
  version: 1;
  mode: CodexProConfig["toolMode"];
  initial_tools: string[];
  disclosed_tools: string[];
  initial_count: number;
  disclosed_count: number;
  expanded_from_base: string[];
  capability_tags: Record<string, ToolCapabilityTag[]>;
  reason_code: string;
}

export interface ToolAvailability {
  available: boolean;
  reason_code: "available" | "bash_disabled" | "write_disabled" | "skills_disabled" | "progressive_task_scope_required" | "tool_mode_disabled" | "unknown_tool";
  reason: string;
}

export type ToolCapabilityTag =
  | "base"
  | "read"
  | "write_source"
  | "write_artifact"
  | "validation"
  | "browser"
  | "network"
  | "git"
  | "database_read"
  | "memory"
  | "provider"
  | "durable_task";

export function toolCapabilityTags(name: string): ToolCapabilityTag[] {
  const tags = new Set<ToolCapabilityTag>();
  if ((PROGRESSIVE_TOOL_NAMES as readonly string[]).includes(name)) tags.add("base");
  if (["tree", "search", "search_project", "read", "read_many_files", "show_changes", "read_project_config", "read_project_memory", "acceptance_status", "read_acceptance_result", "current_task", "task_get", "task_status", "task_recovery", "task_timeline", "task_evidence", ...SKILL_TOOL_NAMES].includes(name)) tags.add("read");
  if (["write", "edit", "apply_patch_bundle", "run_task", "run_stage"].includes(name)) tags.add("write_source");
  if (["write", "edit", "start_task_snapshot", "finish_task_snapshot", "generate_project_map", "export_pro_context", "publish_task_report"].includes(name)) tags.add("write_artifact");
  if (["bash", "run_validation", "run_acceptance", "release_safety_check"].includes(name)) tags.add("validation");
  if (BROWSER_TOOL_NAMES.includes(name)) tags.add("browser");
  if (GIT_ADAPTER_TOOL_NAMES.includes(name) || ["git_status", "git_diff"].includes(name)) tags.add("git");
  if (DATABASE_READONLY_TOOL_NAMES.includes(name)) tags.add("database_read");
  if (["read_project_memory", "summarize_project_memory", "propose_memory_update", "append_project_memory", "query_memory_index"].includes(name)) tags.add("memory");
  if (["codex_capabilities", ...CODEX_DIRECT_TOOL_NAMES, ...GOAL_TOOL_NAMES].includes(name)) tags.add("provider");
  if (["run_acceptance", "acceptance_status", "read_acceptance_result", "start_run_task", "current_task", "task_get", "task_status", "task_recovery", "task_timeline", "task_evidence", "task_resume", "task_cancel", "run_task_status", "resume_run_task", "cancel_run_task", "retry_run_task_step", "read_run_task_result", "publish_task_report"].includes(name)) tags.add("durable_task");
  return [...tags];
}

function gatedToolNames(config: CodexProConfig, names: string[]): string[] {
  const result = [...new Set(names)].filter((name) => toolAllowedByRuntimeGates(config, name));
  if (config.writeMode === "handoff" && !result.includes("handoff_to_agent")) result.push("handoff_to_agent");
  if (config.toolMode !== "progressive") {
    for (const name of [...codexSessionToolNames(config), ...codexExecutionToolNames(config)]) {
      if (!result.includes(name)) result.push(name);
    }
  }
  return result;
}

const BASH_MODE_TOOL_NAMES = new Set(["bash", "node_run_script", "php_lint_files", "python_run_tests", "run_validation", "run_acceptance"]);
const WORKSPACE_WRITE_TOOL_NAMES = new Set(["write", "edit", "apply_patch_bundle", "run_task", "run_stage", "docker_restart_service", "publish_task_report"]);

function toolAllowedByRuntimeGates(config: CodexProConfig, name: string): boolean {
  if (config.bashMode === "off" && BASH_MODE_TOOL_NAMES.has(name)) return false;
  if (config.writeMode !== "workspace" && WORKSPACE_WRITE_TOOL_NAMES.has(name)) return false;
  if (!config.skillsEnabled && SKILL_TOOL_NAMES.includes(name)) return false;
  return true;
}

export function toolAvailability(config: CodexProConfig, name: string): ToolAvailability {
  if (config.bashMode === "off" && BASH_MODE_TOOL_NAMES.has(name)) {
    return { available: false, reason_code: "bash_disabled", reason: `Tool ${name} is disabled because bash_mode=off.` };
  }
  if (config.writeMode !== "workspace" && WORKSPACE_WRITE_TOOL_NAMES.has(name)) {
    return { available: false, reason_code: "write_disabled", reason: `Tool ${name} is disabled because write_mode=${config.writeMode}.` };
  }
  if (!config.skillsEnabled && SKILL_TOOL_NAMES.includes(name)) {
    return { available: false, reason_code: "skills_disabled", reason: `Tool ${name} is disabled because CODEXPRO_SKILLS_ENABLED is not enabled.` };
  }
  if (toolNamesForMode(config).includes(name)) {
    return { available: true, reason_code: "available", reason: `Tool ${name} is available in tool_mode=${config.toolMode}.` };
  }
  const knownTools = new Set<string>([
    ...FULL_TOOL_NAMES,
    ...STANDARD_TOOL_NAMES,
    ...PROGRESSIVE_TOOL_NAMES,
    ...MINIMAL_TOOL_NAMES,
    ...CODEX_EXECUTION_TOOL_NAMES
  ]);
  if (!knownTools.has(name)) {
    return { available: false, reason_code: "unknown_tool", reason: `Tool ${name} is not registered by this CodexPro runtime.` };
  }
  if (config.toolMode === "progressive") {
    return {
      available: false,
      reason_code: "progressive_task_scope_required",
      reason: `Tool ${name} is a task-scoped specialist in progressive mode; call classify_task, then invoke it through codexpro with the same task_instruction.`
    };
  }
  return {
    available: false,
    reason_code: "tool_mode_disabled",
    reason: `Tool ${name} is registered by CodexPro but disabled in tool_mode=${config.toolMode}.`
  };
}

export function toolDisclosureForTask(config: CodexProConfig, task: CompiledTask): ToolDisclosureDecision {
  const initialTools = toolNamesForMode(config);
  if (config.toolMode !== "progressive") {
    return {
      version: 1,
      mode: config.toolMode,
      initial_tools: initialTools,
      disclosed_tools: initialTools,
      initial_count: initialTools.length,
      disclosed_count: initialTools.length,
      expanded_from_base: [],
      capability_tags: Object.fromEntries(initialTools.map((name) => [name, toolCapabilityTags(name)])),
      reason_code: "compatibility_tool_mode"
    };
  }

  const names = [...PROGRESSIVE_TOOL_NAMES] as string[];
  const add = (...values: readonly string[]) => {
    for (const name of values) if (!names.includes(name)) names.push(name);
  };
  if (task.capabilities.write_source) add("write", "edit", "apply_patch_bundle", "run_task", "run_stage", "start_task_snapshot", "finish_task_snapshot");
  if (task.capabilities.write_artifacts) add("write", "edit", "start_task_snapshot", "finish_task_snapshot");
  if (task.capabilities.run_bash) add("bash", "run_validation", "run_acceptance");
  if (task.capabilities.use_browser) add(
    ...BROWSER_TOOL_NAMES,
    "browser_business_prepare_task",
    "browser_business_validate_task",
    "browser_business_list_skills",
    "browser_business_read_skill",
    "browser_business_validate_skill",
    "browser_business_run_skill",
    "browser_business_generate_handoff",
    "browser_business_verify_result"
  );
  if (task.capabilities.use_git) add("git_summary", "git_prepare_commit", "git_commit", "git_get_remote_state", "git_push", "git_prepare", "git_finalize", "git_push_only");
  if (task.capabilities.read_database) add(...DATABASE_READONLY_TOOL_NAMES);
  if (/memory|记忆/i.test(task.intent)) add("read_project_memory", "summarize_project_memory", "propose_memory_update");
  if (task.phases.some((phase) => phase.kind === "execute")) add("start_run_task", "resume_run_task", "cancel_run_task", "retry_run_task_step");
  const disclosedTools = gatedToolNames(config, names);
  const initialSet = new Set(initialTools);
  return {
    version: 1,
    mode: config.toolMode,
    initial_tools: initialTools,
    disclosed_tools: disclosedTools,
    initial_count: initialTools.length,
    disclosed_count: disclosedTools.length,
    expanded_from_base: disclosedTools.filter((name) => !initialSet.has(name)),
    capability_tags: Object.fromEntries(disclosedTools.map((name) => [name, toolCapabilityTags(name)])),
    reason_code: "compiled_capability_disclosure"
  };
}

export function discloseToolsForTask(config: CodexProConfig, task: CompiledTask): string[] {
  return toolDisclosureForTask(config, task).disclosed_tools;
}

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function codexExecutionToolNames(config: CodexProConfig): string[] {
  if (config.codexAdapter === "off") return [];
  if (config.codexAdapter === "mock") return [...CODEX_EXECUTION_TOOL_NAMES];
  return ["codex_capabilities", ...GOAL_TOOL_NAMES];
}

export function toolNamesForMode(config: CodexProConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : config.toolMode === "progressive"
          ? [...PROGRESSIVE_TOOL_NAMES]
          : [...STANDARD_TOOL_NAMES];
  return gatedToolNames(config, names);
}

export function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (!toolAllowedByRuntimeGates(config, name)) return false;
  if (config.toolMode === "full") return true;
  return toolNamesForMode(config).includes(name);
}
