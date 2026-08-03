import type { CodexReasoningEffort } from "../codex/types.js";
import { CodexProError } from "../guard.js";
import { detectGitIntent } from "../security/gitIntent.js";
import { evaluateTaskRiskProfile, taskRiskLevelFromUnified } from "../security/riskGate.js";
import { buildDirectGitToolInvocation, type DirectToolInvocation } from "./directToolInvocation.js";
import { decideExecutionLane, type ExecutionLaneDecision } from "./executionLane.js";
import { compileTask, type CompiledTask, type SourceWritePolicy, type TaskAllowedAction, type TaskCapabilityMatrix } from "./taskCompiler.js";

export const TASK_MODES = [
  "read_only_review",
  "code_patch",
  "ui_patch",
  "backend_debug",
  "docker_debug",
  "database_readonly",
  "browser_validation",
  "memory_candidate",
  "release_gate",
  "git_prepare",
  "git_finalize",
  "archive_report",
  "large_stage"
] as const;

export type TaskMode = (typeof TASK_MODES)[number];

export interface ToolPolicy {
  preferred_tools: string[];
  allowed_tools: string[];
  blocked_tools: string[];
  source_writes_allowed: boolean;
  source_write_policy?: SourceWritePolicy;
  artifact_writes_allowed?: boolean;
  artifact_write_paths?: string[];
  bash_allowed: boolean;
  browser_allowed: boolean;
  network_allowed?: boolean;
  git_allowed?: boolean;
  database_write_allowed?: boolean;
  memory_write_policy: "no" | "proposal_only" | "explicit_only";
  notes: string[];
}

export interface RequestedToolDecision {
  name: string;
  allowed: boolean;
  severity: "allow" | "warn" | "block";
  reason: string;
}

export interface TaskRouteDecision {
  mode: TaskMode;
  confidence: number;
  label: string;
  reasons: string[];
  signals: string[];
  preferred_entrypoint: string;
  requires_write: boolean;
  requires_bash: boolean;
  requires_browser: boolean;
  risk_level: CompiledTask["risk_level"];
  execution_lane: ExecutionLaneDecision;
  capabilities: TaskCapabilityMatrix;
  compiled_task: CompiledTask;
  tool_policy: ToolPolicy;
  direct_tool_invocation?: DirectToolInvocation;
  requested_tool?: RequestedToolDecision;
}

export interface ClassifyTaskOptions {
  mode?: TaskMode;
  requestedTool?: string;
  patchesRequested?: boolean;
  commandsRequested?: boolean;
  targetPath?: string;
  explicitAcceptance?: string[];
  explicitConstraints?: string[];
  explicitScope?: string[];
  explicitAllowedPaths?: string[];
  explicitForbiddenPaths?: string[];
  executionLanesEnabled?: boolean;
  explicitReasoningEffort?: CodexReasoningEffort;
  explicitReviewRequired?: boolean;
}

const MODE_LABELS: Record<TaskMode, string> = {
  read_only_review: "Read-only review / audit",
  code_patch: "Small code patch",
  ui_patch: "UI patch",
  backend_debug: "Backend debug / patch",
  docker_debug: "Docker / service debug",
  database_readonly: "Database read-only inspection",
  browser_validation: "Browser validation",
  memory_candidate: "Memory update candidate",
  release_gate: "Release gate validation",
  git_prepare: "Git prepare",
  git_finalize: "Git finalization",
  archive_report: "Archive / report",
  large_stage: "Large stage task"
};

const READ_ONLY_SIGNALS = [
  "只审计",
  "先审计",
  "不要修改",
  "不修改",
  "不要改",
  "不改代码",
  "只读",
  "只看",
  "先看",
  "audit only",
  "review only",
  "read only",
  "inspect only",
  "do not modify",
  "do not edit",
  "don't modify",
  "don't edit",
  "no changes"
];

const PATCH_SIGNALS = ["开始修", "直接修", "修复", "修一下", "补丁", "修改", "改掉", "实现", "落地", "patch", "fix", "implement"];
const UI_SIGNALS = ["页面", "布局", "样式", "前端", "移动端", "按钮", "菜单", "header", "css", "ui", "截图", "点击", "视觉", "宽屏", "banner"];
const BACKEND_SIGNALS = ["后端", "接口", "路由", "api", "endpoint", "router", "server", "同步", "报错", "异常", "backend", "staledataerror"];
const DOCKER_SIGNALS = ["docker", "compose", "容器", "镜像", "postgres", "mysql", "redis", "服务没启动", "启动失败", "日志"];
const DATABASE_SIGNALS = ["数据库", "sql", "select", "psql", "查表", "查询表", "数据审计", "只读查询", "database", "readonly db"];
const BROWSER_SIGNALS = ["浏览器验收", "browser validation", "browser-smoke", "browser smoke", "browser visual", "visual regression", "视觉回归", "页面验收", "移动端回归", "全站回归", "打开页面", "验收页面"];
const MEMORY_SIGNALS = ["memory candidate", "记忆候选", "memory 更新候选", "更新候选记忆", "sqlite memory", "memory index", "本地记忆索引", "propose_memory_update", "append_project_memory", "rebuild_memory_index", "query_memory_index"];
const RELEASE_SIGNALS = ["release gate", "release-gate", "发布门禁", "release 验证", "npm run release-gate", "public schema", "公共 schema", "公共协议", "protocol compatibility", "schema compatibility", "兼容性验收"];
const GIT_COMMIT_FINALIZE_SIGNALS = ["提交推送", "提交并推送", "直接提交", "现在提交", "git_finalize", "commit and push", "git commit"];
const GIT_PUSH_ONLY_SIGNALS = ["重新推送", "只推送", "git_push_only", "git push"];
const GIT_PREPARE_SIGNALS = ["提交命令", "准备提交命令", "git_prepare", "git add"];
const ARCHIVE_SIGNALS = ["archive", "归档", "报告", "总结", "snapshot", "task snapshot", "验收报告"];
const STAGE_SIGNALS = ["stage ", "stage", "阶段", "进入 stage", "开始stage", "开始 stage", "大阶段", "run_stage"];

const READ_TOOLS = [
  "open_current_workspace",
  "open_workspace",
  "tree",
  "search",
  "search_project",
  "read",
  "read_many_files",
  "detect_project",
  "read_project_profile",
  "read_project_config",
  "read_project_memory",
  "summarize_project_memory",
  "query_memory_index",
  "read_rule_summary",
  "show_changes"
];

const PATCH_TOOLS = ["write", "edit", "apply_patch_bundle", "run_task", "run_stage", "run_task_template"];
const VALIDATION_TOOLS = ["bash", "run_validation", "run_acceptance", "run_task_template"];
const BROWSER_TOOLS = ["browser_status", "browser_runtime_probe", "browser_tabs", "browser_disconnect", "browser_open", "browser_observe", "browser_visual_observe", "browser_verification_run", "browser_verification_status", "browser_verification_resume", "browser_verification_cancel", "browser_verification_result", "browser_click", "browser_type", "browser_wait", "browser_expect_text", "browser_expect_url", "browser_expect_hidden", "browser_screenshot", "browser_visual_regression", "browser_console", "browser_network", "browser_report"];
const GIT_TOOLS = ["show_changes", "git_summary", "git_prepare", "git_finalize", "git_push_only"];
const MEMORY_TOOLS = ["propose_memory_update", "append_project_memory", "read_project_memory", "summarize_project_memory", "rebuild_memory_index", "query_memory_index"];

function uniq<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesAny(text: string, keywords: string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase()));
}

export function hasExplicitReadOnlyIntent(instruction: string): boolean {
  return matchesAny(normalizeText(instruction), READ_ONLY_SIGNALS).length > 0;
}

function normalizeToolName(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  return raw.toLowerCase().replace(/[\s-]+/g, "_");
}

function basePolicy(mode: TaskMode): ToolPolicy {
  switch (mode) {
    case "read_only_review":
      return {
        preferred_tools: ["search_project", "read_many_files", "show_changes", "read_rule_summary"],
        allowed_tools: [...READ_TOOLS, "codexpro", "classify_task"],
        blocked_tools: ["write", "edit", "apply_patch_bundle", "bash", "run_validation", "run_acceptance", "append_project_memory", "init_project_config", "generate_project_map"],
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        memory_write_policy: "no",
        notes: ["Do not modify source files.", "Do not run shell commands unless the task is reclassified away from read-only review."]
      };
    case "browser_validation":
      return {
        preferred_tools: ["run_acceptance", "run_validation", "browser_open", "browser_visual_regression", "browser_screenshot"],
        allowed_tools: uniq([...READ_TOOLS, ...VALIDATION_TOOLS, ...BROWSER_TOOLS, "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "append_project_memory"],
        source_writes_allowed: false,
        bash_allowed: true,
        browser_allowed: true,
        memory_write_policy: "no",
        notes: ["Validate behavior before patching.", "Switch to ui_patch or code_patch before making source edits."]
      };
    case "memory_candidate":
      return {
        preferred_tools: ["finish_task_snapshot", "propose_memory_update", "read_project_memory"],
        allowed_tools: uniq([...READ_TOOLS, "finish_task_snapshot", "propose_memory_update", "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "append_project_memory"],
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        memory_write_policy: "proposal_only",
        notes: ["Produce a memory proposal only.", "append_project_memory requires explicit user approval after the proposal."]
      };
    case "release_gate":
      return {
        preferred_tools: ["run_task_template", "run_validation", "run_acceptance", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...VALIDATION_TOOLS, "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "append_project_memory"],
        source_writes_allowed: false,
        bash_allowed: true,
        browser_allowed: false,
        memory_write_policy: "no",
        notes: ["Run release checks and report failures.", "Fixes require a separate patch mode."]
      };
    case "git_prepare":
      return {
        preferred_tools: ["git_summary", "git_prepare", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...GIT_TOOLS, "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "bash", "append_project_memory"],
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        memory_write_policy: "no",
        notes: ["Use git_summary for staged/unstaged/untracked grouping.", "Use git_prepare only to suggest exact commands without mutation."]
      };
    case "git_finalize":
      return {
        preferred_tools: ["git_finalize", "git_push_only"],
        allowed_tools: ["git_finalize", "git_push_only"],
        blocked_tools: uniq([
          ...READ_TOOLS,
          "git_summary",
          "git_prepare",
          "write",
          "edit",
          "apply_patch_bundle",
          "bash",
          "run_validation",
          "run_acceptance",
          "append_project_memory",
          "classify_task"
        ]),
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        network_allowed: true,
        git_allowed: true,
        memory_write_policy: "no",
        notes: [
          "Use the dedicated Git Finalization Lane.",
          "Dispatch the single terminal Git tool directly; do not Search, inspect documentation, read tool instructions, or call git_summary first.",
          "Reuse evidence already produced by the current task. A stale or missing Acceptance receipt is advisory and must not trigger a rerun.",
          "Only confirm Git change scope, isolate unrelated/untracked/sensitive files, commit, verify committed paths, and push. Do not rerun build, tests, browser validation, Acceptance, formal certification, Handoff, or model review."
        ]
      };
    case "archive_report":
      return {
        preferred_tools: ["start_task_snapshot", "finish_task_snapshot", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, "start_task_snapshot", "finish_task_snapshot", "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "bash"],
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        memory_write_policy: "no",
        notes: ["Write only task snapshot/report artifacts, not source patches."]
      };
    case "database_readonly":
      return {
        preferred_tools: ["search_project", "read_many_files"],
        allowed_tools: uniq([...READ_TOOLS, "classify_task"]),
        blocked_tools: ["write", "edit", "apply_patch_bundle", "bash", "run_validation"],
        source_writes_allowed: false,
        bash_allowed: false,
        browser_allowed: false,
        memory_write_policy: "no",
        notes: ["Inspect code and documented queries only.", "Do not mutate database state in this mode."]
      };
    case "large_stage":
      return {
        preferred_tools: ["run_stage", "run_task_template", "search_project", "read_many_files", "apply_patch_bundle", "run_validation", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...PATCH_TOOLS, ...VALIDATION_TOOLS, "classify_task", "git_prepare"]),
        blocked_tools: ["append_project_memory"],
        source_writes_allowed: true,
        bash_allowed: true,
        browser_allowed: true,
        memory_write_policy: "proposal_only",
        notes: ["Use run_stage/run_task to keep ChatGPT output compact.", "Keep full logs under .codexpro/runs/."]
      };
    case "ui_patch":
      return {
        preferred_tools: ["run_task_template", "search_project", "read_many_files", "apply_patch_bundle", "run_validation", "browser_open", "browser_visual_regression", "browser_screenshot", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...PATCH_TOOLS, ...VALIDATION_TOOLS, ...BROWSER_TOOLS, "classify_task"]),
        blocked_tools: ["append_project_memory"],
        source_writes_allowed: true,
        bash_allowed: true,
        browser_allowed: true,
        memory_write_policy: "proposal_only",
        notes: ["Prefer route/component/CSS scoped files.", "Validate with browser smoke or screenshots when available."]
      };
    case "backend_debug":
      return {
        preferred_tools: ["search_project", "read_many_files", "apply_patch_bundle", "run_validation", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...PATCH_TOOLS, ...VALIDATION_TOOLS, "classify_task"]),
        blocked_tools: ["append_project_memory"],
        source_writes_allowed: true,
        bash_allowed: true,
        browser_allowed: false,
        memory_write_policy: "proposal_only",
        notes: ["Prefer backend routes/services/tests over unrelated frontend files."]
      };
    case "docker_debug":
      return {
        preferred_tools: ["search_project", "read_many_files", "run_validation", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...PATCH_TOOLS, ...VALIDATION_TOOLS, "classify_task"]),
        blocked_tools: ["append_project_memory"],
        source_writes_allowed: true,
        bash_allowed: true,
        browser_allowed: false,
        memory_write_policy: "proposal_only",
        notes: ["Prefer project scripts and safe diagnostics; avoid destructive Docker commands."]
      };
    case "code_patch":
    default:
      return {
        preferred_tools: ["search_project", "read_many_files", "apply_patch_bundle", "run_validation", "show_changes"],
        allowed_tools: uniq([...READ_TOOLS, ...PATCH_TOOLS, ...VALIDATION_TOOLS, "classify_task"]),
        blocked_tools: ["append_project_memory"],
        source_writes_allowed: true,
        bash_allowed: true,
        browser_allowed: false,
        memory_write_policy: "proposal_only",
        notes: ["Keep the patch scoped and review with show_changes."]
      };
  }
}

function gitFinalizationEntrypoint(instruction: string): "git_finalize" | "git_push_only" {
  const text = normalizeText(instruction);
  const explicitCommitFinalization = matchesAny(text, GIT_COMMIT_FINALIZE_SIGNALS).length > 0;
  const explicitPushOnly = matchesAny(text, GIT_PUSH_ONLY_SIGNALS).length > 0;
  if (explicitPushOnly && !explicitCommitFinalization) return "git_push_only";
  const intent = detectGitIntent(instruction);
  return intent.actions.includes("push") && !intent.actions.includes("commit")
    ? "git_push_only"
    : "git_finalize";
}

function preferredEntrypoint(mode: TaskMode, instruction: string): string {
  switch (mode) {
    case "read_only_review": return "search_project + read_many_files";
    case "browser_validation": return "run_acceptance profile=browser or browser-smoke";
    case "memory_candidate": return "finish_task_snapshot + propose_memory_update";
    case "release_gate": return "run_validation";
    case "git_prepare": return "git_prepare";
    case "git_finalize": return gitFinalizationEntrypoint(instruction);
    case "archive_report": return "finish_task_snapshot";
    case "large_stage": return "run_stage";
    default: return "run_task";
  }
}

function isSourceWriteTool(tool: string): boolean {
  return ["write", "edit", "apply_patch_bundle", "init_project_config", "generate_project_map"].includes(tool);
}

function isAggregateTool(tool: string): boolean {
  return tool === "run_task" || tool === "run_stage" || tool === "run_task_template";
}

function isBashLikeTool(tool: string): boolean {
  return tool === "bash" || tool === "run_validation" || tool === "run_acceptance";
}

function normalizeRoutePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function artifactPathAllowed(targetPath: string | undefined, patterns: string[] | undefined): boolean {
  if (!targetPath || !patterns?.length) return false;
  const target = normalizeRoutePath(targetPath);
  return patterns.some((pattern) => {
    const normalized = normalizeRoutePath(pattern);
    if (normalized.endsWith("/**")) {
      const root = normalized.slice(0, -3);
      return target === root || target.startsWith(`${root}/`);
    }
    return target === normalized;
  });
}

function constrainedPolicy(base: ToolPolicy, task: CompiledTask): ToolPolicy {
  const sourceWritesAllowed = base.source_writes_allowed && task.capabilities.write_source;
  const artifactWritesAllowed = task.capabilities.write_artifacts && task.artifact_write_paths.length > 0;
  const bashAllowed = base.bash_allowed && task.capabilities.run_bash;
  const browserAllowed = base.browser_allowed && task.capabilities.use_browser;
  const allowed = [...base.allowed_tools];
  const blocked = [...base.blocked_tools];

  if (artifactWritesAllowed && !sourceWritesAllowed) {
    for (const name of ["write", "edit"]) {
      if (!allowed.includes(name)) allowed.push(name);
      const index = blocked.indexOf(name);
      if (index >= 0) blocked.splice(index, 1);
    }
  }
  if (!sourceWritesAllowed && !artifactWritesAllowed) {
    for (const name of ["write", "edit", "apply_patch_bundle", "init_project_config", "generate_project_map"]) {
      if (!blocked.includes(name)) blocked.push(name);
    }
  }
  if (!bashAllowed) {
    for (const name of VALIDATION_TOOLS) if (!blocked.includes(name)) blocked.push(name);
  }
  if (!browserAllowed) {
    for (const name of BROWSER_TOOLS) if (!blocked.includes(name)) blocked.push(name);
  }
  if (!task.capabilities.use_git) {
    for (const name of GIT_TOOLS) if (!blocked.includes(name)) blocked.push(name);
  }

  const finalAllowed = uniq(allowed.filter((name) => !blocked.includes(name)));
  return {
    ...base,
    preferred_tools: base.preferred_tools.filter((name) => finalAllowed.includes(name)),
    allowed_tools: finalAllowed,
    blocked_tools: uniq(blocked),
    source_writes_allowed: sourceWritesAllowed,
    source_write_policy: task.source_write_policy,
    artifact_writes_allowed: artifactWritesAllowed,
    artifact_write_paths: task.artifact_write_paths,
    bash_allowed: bashAllowed,
    browser_allowed: browserAllowed,
    network_allowed: base.network_allowed === true || task.capabilities.use_network,
    git_allowed: base.git_allowed === true || task.capabilities.use_git,
    database_write_allowed: task.capabilities.write_database,
    notes: uniq([
      ...base.notes,
      `Compiled task risk: ${task.risk_level}.`,
      `Source write policy: ${task.source_write_policy}.`,
      ...(artifactWritesAllowed ? [`Artifact writes limited to: ${task.artifact_write_paths.join(", ")}.`] : []),
      ...(task.confidence < 0.6 ? ["Low compiler confidence: mutation capabilities were removed."] : [])
    ])
  };
}

function evaluateRequestedTool(policy: ToolPolicy, options: ClassifyTaskOptions): RequestedToolDecision | undefined {
  const name = normalizeToolName(options.requestedTool);
  if (!name) return undefined;

  if (name === "append_project_memory") {
    return {
      name,
      allowed: policy.memory_write_policy === "explicit_only",
      severity: policy.memory_write_policy === "explicit_only" ? "warn" : "block",
      reason: policy.memory_write_policy === "explicit_only"
        ? "Allowed only after explicit user approval for a durable memory write."
        : "Blocked in this task mode; prepare a memory proposal instead of writing durable memory."
    };
  }

  if (isSourceWriteTool(name) && !policy.source_writes_allowed) {
    if ((name === "write" || name === "edit") && policy.artifact_writes_allowed) {
      const allowed = artifactPathAllowed(options.targetPath, policy.artifact_write_paths);
      return {
        name,
        allowed,
        severity: allowed ? "warn" : "block",
        reason: allowed
          ? `Allowed only for the compiled artifact path: ${options.targetPath}. Source files remain read-only.`
          : `Blocked: ${name} may write only compiled artifact paths (${policy.artifact_write_paths?.join(", ") || "none"}); target path was not allowed.`
      };
    }
    return { name, allowed: false, severity: "block", reason: `Blocked: ${name} would modify files, but this compiled task does not allow source writes.` };
  }
  if (isAggregateTool(name) && options.patchesRequested && !policy.source_writes_allowed) {
    return { name, allowed: false, severity: "block", reason: `Blocked: ${name} includes patches, but this task mode does not allow source writes.` };
  }
  if ((isBashLikeTool(name) || (isAggregateTool(name) && options.commandsRequested)) && !policy.bash_allowed) {
    return { name, allowed: false, severity: "block", reason: `Blocked: ${name} would run commands, but this task mode does not allow bash/validation.` };
  }
  if (policy.blocked_tools.includes(name)) {
    return { name, allowed: false, severity: "block", reason: `Blocked by task policy for this mode: ${name}.` };
  }
  if (!policy.allowed_tools.includes(name) && !policy.preferred_tools.includes(name)) {
    return { name, allowed: true, severity: "warn", reason: `${name} is not a preferred tool for this mode; use a preferred tool when possible.` };
  }
  return { name, allowed: true, severity: "allow", reason: `${name} is allowed for this task mode.` };
}

function classifyMode(instruction: string): { mode: TaskMode; confidence: number; reasons: string[]; signals: string[] } {
  const text = normalizeText(instruction);
  const readOnly = matchesAny(text, READ_ONLY_SIGNALS);
  const patch = matchesAny(text, PATCH_SIGNALS);
  const ui = matchesAny(text, UI_SIGNALS);
  const backend = matchesAny(text, BACKEND_SIGNALS);
  const docker = matchesAny(text, DOCKER_SIGNALS);
  const database = matchesAny(text, DATABASE_SIGNALS);
  const browser = matchesAny(text, BROWSER_SIGNALS);
  const memory = matchesAny(text, MEMORY_SIGNALS);
  const release = matchesAny(text, RELEASE_SIGNALS);
  const gitFinalize = matchesAny(text, GIT_COMMIT_FINALIZE_SIGNALS);
  const gitPushOnly = matchesAny(text, GIT_PUSH_ONLY_SIGNALS);
  const gitPrepare = matchesAny(text, GIT_PREPARE_SIGNALS);
  const gitIntent = detectGitIntent(instruction);
  const archive = matchesAny(text, ARCHIVE_SIGNALS);
  const stage = matchesAny(text, STAGE_SIGNALS);

  if (readOnly.length) return { mode: "read_only_review", confidence: 0.98, reasons: ["Explicit read-only/no-modification wording found."], signals: readOnly };
  if (gitFinalize.length) return { mode: "git_finalize", confidence: 0.98, reasons: ["Explicit Git commit finalization wording found."], signals: gitFinalize };
  if (gitPushOnly.length) return { mode: "git_finalize", confidence: 0.98, reasons: ["Explicit push-only finalization wording found."], signals: gitPushOnly };
  if (gitPrepare.length) return { mode: "git_prepare", confidence: 0.95, reasons: ["Git command preparation wording found."], signals: gitPrepare };
  if (gitIntent.detected) return { mode: "git_finalize", confidence: 0.96, reasons: ["Explicit standalone Git commit or push intent found."], signals: gitIntent.matched_signals };
  if (release.length) return { mode: "release_gate", confidence: 0.94, reasons: ["Release gate validation wording found."], signals: release };
  if (memory.length) return { mode: "memory_candidate", confidence: 0.93, reasons: ["Memory candidate/update wording found."], signals: memory };
  if (browser.length && !patch.length) return { mode: "browser_validation", confidence: 0.9, reasons: ["Browser validation wording found without patch wording."], signals: browser };
  if (stage.length) return { mode: "large_stage", confidence: 0.88, reasons: ["Stage-level task wording found."], signals: stage };
  if (ui.length) return { mode: "ui_patch", confidence: patch.length ? 0.88 : 0.78, reasons: ["UI/page/layout wording found."], signals: [...ui, ...patch] };
  if (docker.length) return { mode: "docker_debug", confidence: 0.82, reasons: ["Docker/service diagnostic wording found."], signals: docker };
  if (database.length && !patch.length) return { mode: "database_readonly", confidence: 0.8, reasons: ["Database inspection wording found without patch wording."], signals: database };
  if (backend.length) return { mode: "backend_debug", confidence: patch.length ? 0.86 : 0.78, reasons: ["Backend/API/debug wording found."], signals: [...backend, ...patch] };
  if (patch.length) return { mode: "code_patch", confidence: 0.78, reasons: ["Generic patch/fix wording found."], signals: patch };
  if (archive.length) return { mode: "archive_report", confidence: 0.72, reasons: ["Report/archive wording found."], signals: archive };
  return { mode: "read_only_review", confidence: 0.55, reasons: ["No write intent found; defaulting to safe read-only review."], signals: [] };
}

export function classifyTask(instruction: string, options: ClassifyTaskOptions = {}): TaskRouteDecision {
  const compiled = compileTask(instruction, {
    explicitAcceptance: options.explicitAcceptance,
    explicitConstraints: options.explicitConstraints,
    explicitScope: options.explicitScope,
    explicitAllowedPaths: options.explicitAllowedPaths,
    explicitForbiddenPaths: options.explicitForbiddenPaths
  });
  const structuredScope = uniq(options.explicitScope ?? []);
  const structuredPatchScope = options.patchesRequested === true && structuredScope.length > 0;
  const artifactOnlyPatch = structuredPatchScope && structuredScope.every((value) =>
    /(?:^|\/)(?:planning-local|docs|reports?|\.ai-bridge|\.codexpro)(?:\/|$)|\.(?:md|txt)$/i.test(value)
  );
  const structuredPatchConfidence = artifactOnlyPatch ? 0.72 : 0.78;
  const structuredCapabilities = structuredPatchScope
    ? {
        ...compiled.capabilities,
        write_source: !artifactOnlyPatch,
        write_artifacts: artifactOnlyPatch || compiled.capabilities.write_artifacts
      }
    : compiled.capabilities;
  const structuredRiskDecision = structuredPatchScope
    ? evaluateTaskRiskProfile({
        instruction,
        scope_paths: structuredScope,
        source_write: structuredCapabilities.write_source,
        artifact_write: structuredCapabilities.write_artifacts,
        run_bash: compiled.capabilities.run_bash,
        use_browser: compiled.capabilities.use_browser,
        use_network: compiled.capabilities.use_network,
        use_git: compiled.capabilities.use_git,
        write_database: compiled.capabilities.write_database,
        workspace_scope: false
      })
    : compiled.risk_decision;
  const structuredWriteAction: TaskAllowedAction = artifactOnlyPatch ? "write_artifacts" : "write_source";
  const compiledTask: CompiledTask = structuredPatchScope
    ? {
        ...compiled,
        confidence: Math.max(compiled.confidence, structuredPatchConfidence),
        source_write_policy: artifactOnlyPatch ? "none" : "scoped",
        artifact_write_paths: artifactOnlyPatch ? structuredScope : compiled.artifact_write_paths,
        capabilities: structuredCapabilities,
        risk_decision: structuredRiskDecision,
        risk_level: taskRiskLevelFromUnified(structuredRiskDecision),
        authorization_decision: {
          ...compiled.authorization_decision,
          allowed_actions: uniq([
            ...compiled.authorization_decision.allowed_actions.filter((action) => action !== "write_source" && action !== "write_artifacts"),
            structuredWriteAction
          ]),
          allowed_paths: uniq([...compiled.authorization_decision.allowed_paths, ...structuredScope])
        },
        signals: uniq([...compiled.signals, "structured_patch_scope"]),
        constraints: compiled.constraints.filter((constraint) => !constraint.startsWith("Low-confidence compilation:")),
        phases: artifactOnlyPatch
          ? compiled.phases
          : compiled.phases.some((phase) => phase.kind === "execute")
            ? compiled.phases
            : [
                { id: "execute", kind: "execute", description: "Apply scoped implementation changes.", requires_approval: false, idempotent: false },
                ...compiled.phases.filter((phase) => phase.kind !== "inspect")
              ]
      }
    : compiled;
  let base = options.mode
    ? { mode: options.mode, confidence: 1, reasons: [`Mode override supplied: ${options.mode}.`], signals: [] as string[] }
    : classifyMode(instruction);

  if (!options.mode) {
    const hasExecutionPhase = compiledTask.phases.some((phase) => phase.kind === "execute");
    const hasGitPhase = compiledTask.phases.some((phase) => phase.kind === "git_prepare");
    const releaseRequired = base.mode === "release_gate"
      || compiledTask.authorization_decision.validation_level === "release";
    if (releaseRequired) {
      base = { mode: "release_gate", confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Release or compatibility validation has precedence over artifact/report inference."], signals: [...base.signals, ...compiledTask.signals] };
    } else if (hasExecutionPhase && hasGitPhase) {
      base = { mode: "large_stage", confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Compiled task requires implementation, validation, and approval-gated Git preparation."], signals: [...base.signals, ...compiledTask.signals] };
    } else if (
      compiledTask.browser_required
      && compiledTask.source_write_policy === "none"
      && ["read_only_review", "browser_validation", "archive_report"].includes(base.mode)
    ) {
      base = { mode: "browser_validation", confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Compiled task requires browser access without source writes."], signals: [...base.signals, ...compiledTask.signals] };
    } else if (
      compiledTask.capabilities.write_artifacts
      && compiledTask.source_write_policy === "none"
      && !hasExecutionPhase
      && !hasGitPhase
    ) {
      base = { mode: "archive_report", confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Compiled task permits artifact-only writes with no source, release, or Git execution phase."], signals: [...base.signals, ...compiledTask.signals] };
    } else if (compiledTask.source_write_policy === "workspace") {
      base = { mode: "large_stage", confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Compiled task requires workspace-scale source changes."], signals: [...base.signals, ...compiledTask.signals] };
    } else if (
      compiledTask.source_write_policy === "scoped"
      && ["read_only_review", "browser_validation", "database_readonly", "archive_report"].includes(base.mode)
    ) {
      const mutationMode: TaskMode = compiledTask.browser_required ? "ui_patch" : "code_patch";
      base = { mode: mutationMode, confidence: Math.max(base.confidence, compiledTask.confidence), reasons: [...base.reasons, "Compiled task contains explicit scoped source-write intent."], signals: [...base.signals, ...compiledTask.signals] };
    }
  }

  let policy = constrainedPolicy(basePolicy(base.mode), compiledTask);
  const entrypoint = preferredEntrypoint(base.mode, instruction);
  let directToolInvocation: DirectToolInvocation | undefined;
  if (base.mode === "git_finalize") {
    const directEntrypoint = entrypoint === "git_push_only" ? "git_push_only" : "git_finalize";
    const prohibitedBeforeDispatch = uniq([
      ...policy.allowed_tools,
      ...READ_TOOLS,
      ...GIT_TOOLS,
      "classify_task"
    ].filter((name) => name !== directEntrypoint));
    policy = {
      ...policy,
      preferred_tools: [directEntrypoint],
      allowed_tools: [directEntrypoint],
      blocked_tools: uniq([...policy.blocked_tools, ...prohibitedBeforeDispatch]),
      notes: uniq([
        ...policy.notes,
        `${directEntrypoint} is the only permitted tool call for this instruction.`,
        "Direct dispatch must contain exactly one call and must use the startup-cached tool schema."
      ])
    };
    directToolInvocation = buildDirectGitToolInvocation(instruction, directEntrypoint);
  }
  const confidence = Number(Math.min(base.confidence, compiledTask.confidence).toFixed(2));
  const executionLane = decideExecutionLane({
    compiled_task: compiledTask,
    route_mode: base.mode,
    acceptance_count: compiledTask.acceptance.length,
    explicit_review_required: options.explicitReviewRequired
      ?? compiledTask.phases.some((phase) => phase.kind === "review"),
    explicit_reasoning_effort: options.explicitReasoningEffort,
    enabled: options.executionLanesEnabled
  });
  return {
    mode: base.mode,
    confidence,
    label: MODE_LABELS[base.mode],
    reasons: uniq([
      ...base.reasons,
      `Task Compiler confidence=${compiledTask.confidence.toFixed(2)} risk=${compiledTask.risk_level}.`,
      `Execution lane=${executionLane.lane}; ${executionLane.reason_codes.join(", ")}.`
    ]),
    signals: uniq([...base.signals, ...compiledTask.signals]),
    preferred_entrypoint: entrypoint,
    requires_write: policy.source_writes_allowed || Boolean(policy.artifact_writes_allowed),
    requires_bash: policy.bash_allowed,
    requires_browser: policy.browser_allowed,
    risk_level: compiledTask.risk_level,
    execution_lane: executionLane,
    capabilities: compiledTask.capabilities,
    compiled_task: compiledTask,
    tool_policy: policy,
    ...(directToolInvocation ? { direct_tool_invocation: directToolInvocation } : {}),
    requested_tool: evaluateRequestedTool(policy, options)
  };
}

export function assertTaskToolAllowed(decision: TaskRouteDecision, toolName: string, options: Omit<ClassifyTaskOptions, "mode" | "requestedTool"> = {}): void {
  const requested = evaluateRequestedTool(decision.tool_policy, { requestedTool: toolName, ...options });
  if (requested && !requested.allowed) throw new CodexProError(requested.reason);
}

export function formatTaskRouteDecision(decision: TaskRouteDecision): string {
  const lines = [
    "# Task Router",
    "",
    `Mode: ${decision.mode}`,
    `Label: ${decision.label}`,
    `Confidence: ${decision.confidence.toFixed(2)}`,
    `Preferred entrypoint: ${decision.preferred_entrypoint}`,
    `Requires write: ${decision.requires_write}`,
    `Requires bash: ${decision.requires_bash}`,
    `Requires browser: ${decision.requires_browser}`,
    `Risk: ${decision.risk_level}`,
    `Risk reason: ${decision.compiled_task.risk_decision.reason_code}`,
    `Execution lane: ${decision.execution_lane.lane}`,
    `Reasoning effort: ${decision.execution_lane.reasoning_effort}`,
    `Acceptance profile: ${decision.execution_lane.acceptance_profile}`,
    `Reviewer routing: ${decision.execution_lane.reviewer_mode}`,
    `Source write policy: ${decision.compiled_task.source_write_policy}`,
    `Artifact paths: ${decision.compiled_task.artifact_write_paths.join(", ") || "none"}`,
    "",
    "## Compiled phases",
    ...decision.compiled_task.phases.map((phase) => `- ${phase.id}: ${phase.kind}${phase.requires_approval ? " [approval]" : ""}`),
    "",
    "## Reasons",
    ...(decision.reasons.length ? decision.reasons.map((reason) => `- ${reason}`) : ["- No explicit reason."]),
    "",
    "## Lane reason codes",
    ...decision.execution_lane.reason_codes.map((code) => `- ${code}`),
    "",
    "## Signals",
    ...(decision.signals.length ? decision.signals.map((signal) => `- ${signal}`) : ["- none"]),
    "",
    "## Preferred tools",
    ...decision.tool_policy.preferred_tools.map((tool) => `- ${tool}`),
    "",
    "## Blocked tools",
    ...(decision.tool_policy.blocked_tools.length ? decision.tool_policy.blocked_tools.map((tool) => `- ${tool}`) : ["- none"]),
    "",
    "## Notes",
    ...decision.tool_policy.notes.map((note) => `- ${note}`)
  ];
  if (decision.direct_tool_invocation) {
    lines.push(
      "",
      "## Direct Tool Invocation",
      `Mode: ${decision.direct_tool_invocation.dispatch_mode}`,
      `Call count: ${decision.direct_tool_invocation.call_count}`,
      `Tool: ${decision.direct_tool_invocation.call.name}`,
      `Schema source: ${decision.direct_tool_invocation.schema_cache.source}`,
      `Schema cache hit: ${decision.direct_tool_invocation.schema_cache.cache_hit}`,
      `Runtime schema retrievals: ${decision.direct_tool_invocation.schema_cache.runtime_schema_retrieval_count}`,
      `Dispatch: ${decision.direct_tool_invocation.dispatch_ms.toFixed(3)} ms`
    );
  }
  if (decision.requested_tool) {
    lines.push(
      "",
      "## Requested tool decision",
      `Tool: ${decision.requested_tool.name}`,
      `Allowed: ${decision.requested_tool.allowed}`,
      `Severity: ${decision.requested_tool.severity}`,
      `Reason: ${decision.requested_tool.reason}`
    );
  }
  return lines.join("\n");
}
