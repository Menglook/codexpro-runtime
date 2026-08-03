import fsp from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, activeWorkspaceFilePath, type Workspace } from "./guard.js";
import { defaultConversationId, WorkspaceActivationService } from "./workspaces/workspaceAuthority.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, ensureAiBridge } from "./fsOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { applyPatchBundle, MAX_AGGREGATE_COMMANDS, MAX_AGGREGATE_PATCHES, MAX_AGGREGATE_READ_FILES, MAX_AGGREGATE_RESULTS_PER_QUERY, MAX_AGGREGATE_SEARCH_QUERIES, readManyFiles, resolveValidationCommands, runStage, runTask, runValidation, searchProject, type RunTaskOptions } from "./compactExecution.js";
import {
  cancelAsyncCompactTask,
  getAsyncCompactTaskStatus,
  readAsyncCompactTaskResult,
  resumeAsyncCompactTask,
  retryAsyncCompactTaskStep,
  shouldStartAsyncValidation,
  startAsyncCompactTask,
  type AsyncCompactTaskState,
  type CommandExecutionMode
} from "./asyncCompactTasks.js";
import { gitChangeSummary, gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { ensureHandoffWatcher, readHandoffStatus, type HandoffStatusResult } from "./handoffStatus.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { createCodexAdapter } from "./codex/adapterFactory.js";
import type { CodexAdapter, CodexNormalizedEvent, CodexRun } from "./codex/types.js";
import { getGoalManager } from "./goals/goalManagerFactory.js";
import type { GoalRecord } from "./goals/types.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { detectProject, formatDetectedProject } from "./project/projectDetector.js";
import { initProjectConfig, readProjectProfile, readProjectConfig, validateProjectConfig, formatProjectConfigLoadResult, PROJECT_CONFIG_PATH, ACCEPTANCE_CONFIG_PATH } from "./project/projectConfig.js";
import { activateUserProject, isConfiguredProjectPoolRoot, listUserProjects, resolveConfiguredActiveUserProject, resolveUserProject, showActiveUserProject } from "./project/userProjects.js";
import { readProjectMemory, formatProjectMemory, summarizeProjectMemory, PROJECT_MEMORY_DIR } from "./project/projectMemory.js";
import { buildMemoryIndex, formatMemoryIndexBuildResult, formatMemoryIndexQueryResult, queryMemoryIndex, PROJECT_MEMORY_INDEX_PATH } from "./project/memoryIndex.js";
import { buildRuleSummary, formatRuleSummary } from "./project/ruleSummary.js";
import { generateProjectMap, PROJECT_MAP_PATH } from "./project/projectMap.js";
import { dirtyGuard } from "./workflow/dirtyGuard.js";
import { startTaskSnapshot, finishTaskSnapshot } from "./workflow/taskSnapshot.js";
import { proposeMemoryUpdate, appendProjectMemory } from "./workflow/memoryCandidate.js";
import { compressOldSessions, formatSessionCompressionResult, formatSessionSummaryQueryResult, querySessionSummaries } from "./workflow/sessionCompression.js";
import { prepareAcceptanceRun, runAcceptance } from "./workflow/acceptanceEngine.js";
import {
  cancelAcceptanceTask,
  getAcceptanceTaskStatus,
  readAcceptanceTaskResult,
  shouldStartAsyncAcceptance,
  startAcceptanceTask,
  type AcceptanceExecutionMode
} from "./workflow/asyncAcceptance.js";
import { TASKS_CONFIG_PATH } from "./project/taskTemplatesConfig.js";
import { runTaskTemplate } from "./workflow/taskTemplateEngine.js";
import { classifyTask, formatTaskRouteDecision, TASK_MODES, type TaskMode } from "./workflow/taskRouter.js";
import { buildCommitAssistant } from "./workflow/commitAssistant.js";
import { runReleaseSafetyCheck, runSecretScan, runSecurityAudit } from "./workflow/securityAudit.js";
import { createBrowserTools } from "./browser/browser-tools.js";
import { createBrowserBusinessTools } from "./browser/browser-business-tools.js";
import { createSkillTools } from "./tools/skills.js";
import { resolveSkillUsageReceipt } from "./skills/skillUsage.js";
import { NEAT_FREAK_FACT_STATUSES, runNeatFreakAcceptance } from "./skills/neatFreakAcceptance.js";
import { createNodeTools } from "./adapters/node-adapter.js";
import { createDockerTools } from "./adapters/docker-adapter.js";
import { createPhpWordPressTools } from "./adapters/php-wordpress-adapter.js";
import { createPythonFastApiTools } from "./adapters/python-fastapi-adapter.js";
import { createDatabaseReadonlyTools } from "./adapters/database-readonly-adapter.js";
import { createGitTools } from "./adapters/git-adapter.js";
import { SUPERTOOL_ACTION_ALIASES, SUPERTOOL_NAME, discloseToolsForTask, normalizeSupertoolAction, toolAvailability, toolNamesForMode } from "./server/toolRegistry.js";
import { nativeRuntimePolicy } from "./runtime/executionOrigin.js";
import { RuntimeActivityEventStore } from "./runtime/activityEventStore.js";
import { createToolRegistrationRuntime } from "./server/toolRegistration.js";
import { normalizeCoreToolResult, type CoreToolDefinition, type CoreToolRequestContext, type CoreToolResult } from "./server/coreToolRegistry.js";
import { TOOL_LIMITS, TOOL_LIMITS_DIGEST, TOOL_LIMITS_VERSION } from "./tools/toolLimits.js";
import { officeCapabilityRegistry } from "./http/officeCapabilityRegistry.js";
import { bashTextResult, codexRunText, collectCodexEvents, errorResult, errorText, goalText, safeStructuredContent, textResult } from "./server/responses.js";
import { TaskProjectionService } from "./tasks/taskProjectionService.js";
import { publishTaskReport } from "./tasks/publishTaskReport.js";
import { dispatchTaskCompletionNotification } from "./notifications/taskCompletionNotifier.js";
import { sharedSearchLoopBreaker as searchLoopBreaker } from "./server/searchLoopBreaker.js";
import {
  enforceGoldTaskCompletionGate,
  enforceGoldTaskPatchLoopBudget,
  goldTaskRuntimeIdentity,
  releaseGoldTaskPatchLoopReservation
} from "./evaluation/goldTaskSession.js";

const {
  toolCardMeta,
  registerToolCardResource,
  registeredToolHandler,
  assertWriteToolAllowed,
  assertNotProjectPoolRoot,
  assertTaskRouteToolAllowed,
  registerCodexTool,
  setServerWorkspaceResolver,
  registeredToolNames,
  coreToolNames,
  coreToolDefinitions,
  coreToolSchemaDigest,
  serverInstructions
} = createToolRegistrationRuntime({
  safeStructuredContent,
  errorResult,
  resolveWorkspace: (runtimeConfig, input) => getSharedWorkspaceAuthority(runtimeConfig).resolveCurrent({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    connectorRequest: Boolean(input.conversationId)
  })
});

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

type AggregateOperationMode = "analyze" | "implement" | "validate";

function aggregateOperationMode(args: Record<string, any>, toolName: string): AggregateOperationMode {
  const explicit = args.mode as AggregateOperationMode | undefined;
  const mode: AggregateOperationMode = explicit ?? (args.patches?.length ? "implement" : args.commands?.length ? "validate" : "analyze");
  if (mode === "analyze" && args.patches?.length) throw new CodexProError(`${toolName} mode=analyze cannot contain patches.`);
  if (mode === "validate" && args.patches?.length) throw new CodexProError(`${toolName} mode=validate cannot write source files.`);
  return mode;
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("##"));
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

function formatCommandHints(commands: Array<{ name: string; command: string }>): string {
  return commands.length ? commands.map((command) => `- ${command.name}: ${command.command}`).join("\n") : "- none detected";
}

function activateConfiguredWorkspaceIfAvailable(config: CodexProConfig, authority: WorkspaceActivationService): void {
  if (authority.activeState()) {
    try {
      authority.resolveCurrent();
      return;
    } catch {
      // Fall through to the configured project/default root when persisted authority is unusable.
    }
  }

  try {
    const activeProject = resolveConfiguredActiveUserProject(config);
    const root = activeProject?.project.real_root ?? activeProject?.project.expanded_root;
    authority.openAndActivate(root ?? config.defaultRoot, { source: "inherited_active" });
  } catch {
    // Bad or disallowed project config should not prevent server startup. Explicit project tools surface the issue.
  }
}

async function switchToUserProject(
  config: CodexProConfig,
  guard: PathGuard,
  workspaces: WorkspaceManager,
  authority: WorkspaceActivationService,
  projectName: string,
  options: { includeTree?: boolean; maxDepth?: number; maxEntries?: number; includeSkills?: boolean; includeGlobalSkills?: boolean; conversationId?: string } = {}
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const activation = await activateUserProject(config, projectName);
  const target = resolveUserProject(config, projectName, workspaces.activeWorkspace());
  const authorityResult = authority.openAndActivate(target.project.real_root ?? target.project.expanded_root, {
    conversationId: options.conversationId,
    source: "explicit_activate",
    activatedBySessionId: options.conversationId
  });
  const workspace = authorityResult.workspace;
  const summary = await workspaceSummary(config, guard, workspace, {
    includeTree: options.includeTree ?? false,
    maxDepth: options.maxDepth ?? 2,
    maxEntries: options.maxEntries ?? 500,
    includeSkills: options.includeSkills ?? false,
    includeGlobalSkills: options.includeGlobalSkills ?? false,
    bootstrapContext: false
  });
  const profile = await detectProject(config, guard, workspace);
  const text = [
    "# Switch CodexPro Project",
    "",
    `Project: ${target.project.name}`,
    `Config: ${target.config_path}`,
    `Workspace: ${summary.workspaceId}`,
    `Root: ${summary.root}`,
    `Persistent active workspace file: ${activeWorkspaceFilePath()}`,
    "Runtime active workspace: yes",
    "Default tools without workspace_id now use this root.",
    "",
    "## Git status",
    "",
    summary.gitStatus,
    "",
    "## Project type",
    "",
    `Kind: ${profile.kind}`,
    `Package manager: ${profile.package_manager ?? "n/a"}`,
    `Primary language: ${profile.primary_language ?? "n/a"}`,
    `Frameworks: ${profile.frameworks.length ? profile.frameworks.join(", ") : "n/a"}`,
    "",
    "## Suggested acceptance commands",
    "",
    formatCommandHints(profile.suggested_acceptance_commands),
    "",
    "## Preflight summary",
    "",
    summary.text
  ].join("\n");
  return {
    text,
    structured: {
      workspace_id: summary.workspaceId,
      root: summary.root,
      project_name: target.project.name,
      project: target.project,
      config_path: target.config_path,
      active_config_project: target.project.name,
      activation: activation.structured,
      current_server_root: config.defaultRoot,
      runtime_active_root: summary.root,
      active_workspace_file: activeWorkspaceFilePath(),
      active_workspace_state: authorityResult.activeState,
      conversation_workspace_binding: authorityResult.conversationBinding,
      allowed_roots: [...config.allowedRoots],
      changed_default_workspace: summary.root !== config.defaultRoot,
      switched_runtime_root: true,
      restart_required_to_make_default: false,
      profile,
      project_kind: profile.kind,
      suggested_acceptance_commands: profile.suggested_acceptance_commands,
      agents_loaded: summary.agentsLoaded,
      agents_path: summary.agentsPath,
      skills: summary.skills,
      skill_inventory: summary.skillInventory,
      skill_counts: summary.skillCounts,
      tree: summary.tree,
      git_status: summary.gitStatus,
      rule_summary: summary.ruleSummary,
      issues: target.issues,
      bash_mode: config.bashMode,
      write_mode: config.writeMode,
      tool_mode: config.toolMode
    }
  };
}

async function readRawTextFileBounded(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
    requireWatcher: boolean;
    autoStartWatcher: boolean;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  handoffStatus: HandoffStatusResult;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const preflight = options.requireWatcher && options.autoStartWatcher
    ? await ensureHandoffWatcher(config, guard, workspace, { agent, model: options.model })
    : await readHandoffStatus(config, guard, workspace);
  if (options.requireWatcher && !preflight.watcher_online) {
    throw new CodexProError(
      `Local ${agentName} handoff watcher is offline for workspace ${workspace.root}: ${preflight.watcher_reason}. ` +
      `The handoff plan was not written. ${preflight.recovery_action} ` +
      "Fallback to CodexPro is allowed only after an explicit Codex quota/capacity error, not for watcher or workspace failures."
    );
  }
  await ensureAiBridge(config, guard, workspace);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexProError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");
  const handoffStatus = await readHandoffStatus(config, guard, workspace);

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    handoffStatus,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SKILL_PLAN_INPUT_SCHEMA = z.object({
  planned_changes: z.array(z.object({
    path: z.string().min(1).max(500),
    reason: z.string().min(1).max(2_000),
    evidence: z.array(z.string().min(1).max(2_000)).min(1).max(50)
  })).max(100),
  planned_commands: z.array(z.string().min(1).max(4_000)).max(50).optional(),
  memory_action: z.literal("proposal_only").optional(),
  cleanup_action: z.literal("proposal_only").optional()
});
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const NOTIFICATION_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const GIT_NETWORK_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: false, idempotentHint: false };
const REPORT_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };

const workspaceManagers = new Map<string, WorkspaceManager>();
const workspaceAuthorities = new Map<string, WorkspaceActivationService>();

function workspaceManagerKey(config: CodexProConfig): string {
  return JSON.stringify({
    defaultRoot: config.defaultRoot,
    allowedRoots: [...config.allowedRoots].sort(),
    contextDir: config.contextDir
  });
}

function getSharedWorkspaceManager(config: CodexProConfig): WorkspaceManager {
  const key = workspaceManagerKey(config);
  const existing = workspaceManagers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceManager(config);
  workspaceManagers.set(key, manager);
  return manager;
}

function getSharedWorkspaceAuthority(config: CodexProConfig): WorkspaceActivationService {
  const key = workspaceManagerKey(config);
  const existing = workspaceAuthorities.get(key);
  if (existing) return existing;
  const authority = new WorkspaceActivationService(config, getSharedWorkspaceManager(config));
  authority.onActivated(async (result) => {
    const events = new RuntimeActivityEventStore(new PathGuard(config), result.workspace);
    await events.append({
      kind: "workspace.activated",
      project_id: result.project.projectId,
      workspace_id: result.workspace.id,
      workspace_generation: result.activeState.generation,
      actor_id: result.activeState.activatedBySessionId ?? null,
      actor_role: "system",
      payload: {
        workspace_root: result.workspace.root,
        aliases: result.project.aliases,
        conversation_id: result.conversationBinding?.conversationId ?? null
      }
    });
  });
  workspaceAuthorities.set(key, authority);
  return authority;
}

export function createCodexProServer(config: CodexProConfig): McpServer {
  const workspaces = getSharedWorkspaceManager(config);
  const workspaceAuthority = getSharedWorkspaceAuthority(config);
  const conversationId = defaultConversationId();
  const guard = new PathGuard(config);
  const codexAdapter = createCodexAdapter(config);
  activateConfiguredWorkspaceIfAvailable(config, workspaceAuthority);
  const resolveWorkspace = (
    input: string | { workspaceId?: string; conversationId?: string } = {}
  ): Workspace => {
    const normalized = typeof input === "string" ? { workspaceId: input } : input;
    const requestedConversationId = normalized.conversationId ?? conversationId;
    return workspaceAuthority.resolveCurrent({
      workspaceId: normalized.workspaceId,
      conversationId: requestedConversationId,
      connectorRequest: Boolean(requestedConversationId)
    });
  };
  const server = new McpServer({ name: "CodexPro", version: "0.28.6" }, { instructions: serverInstructions(config) });
  setServerWorkspaceResolver(server, resolveWorkspace);
  registerToolCardResource(server, config);

  async function durableValidationAccepted(
    workspace: Workspace,
    state: AsyncCompactTaskState,
    sourceTool: "bash" | "run_validation",
    executionMode: CommandExecutionMode
  ): Promise<any> {
    const taskService = new TaskProjectionService(config, guard, workspace);
    const identity = await taskService.ensureDurableJob({
      run_id: state.run_id,
      title: state.title,
      workspace_root: workspace.root,
      created_at: state.created_at,
      updated_at: state.finished_at ?? state.started_at ?? state.created_at
    });
    const text = [
      `${sourceTool} long command accepted for durable background execution.`,
      `task_id=${identity.task_id}`,
      `run_id=${state.run_id}`,
      `status=${state.status}`,
      "The local command continues independently of this Connector response.",
      "Use run_task_status to check progress, then read_run_task_result to read the saved result. If this response is lost, use current_task to recover the latest durable task. Do not start the same command again after a transport error."
    ].join("\n");
    return textResult(text, {
      ...state,
      workspace_id: workspace.id,
      root: workspace.root,
      dispatch_mode: "durable",
      source_tool: sourceTool,
      execution_mode: executionMode,
      task_id: identity.task_id,
      identity
    });
  }

  async function inheritedValidationIdentity(workspace: Workspace): Promise<{
    title: string;
    task_identity: NonNullable<RunTaskOptions["task_identity"]>;
  } | null> {
    const taskService = new TaskProjectionService(config, guard, workspace);
    const current = await taskService.getCurrentForConversation(workspace.conversationId).catch(() => undefined);
    if (!current || current.identity.project_root !== workspace.root) return null;
    if (["completed", "cancelled"].includes(current.status)) return null;
    if (["stale", "stopped"].includes(current.liveness.state) && current.status !== "failed" && current.status !== "interrupted") return null;
    const rootIdentity = current.identity.parent_task_id
      ? await taskService.getIdentity(current.identity.parent_task_id).catch(() => current.identity)
      : current.identity;
    const objective = current.identity.objective ?? rootIdentity.objective ?? {
      version: 1 as const,
      objective_key: `legacy:${rootIdentity.kind}:${rootIdentity.domain_id}`,
      stage_key: null,
      previous_attempt_id: null,
      source: "legacy_single_attempt" as const
    };
    return {
      title: rootIdentity.title,
      task_identity: {
        parent_task_id: rootIdentity.task_id,
        objective: {
          ...objective,
          previous_attempt_id: current.identity.task_id
        },
        ...(current.identity.workspace_binding ?? rootIdentity.workspace_binding
          ? { workspace_binding: current.identity.workspace_binding ?? rootIdentity.workspace_binding }
          : {}),
        ...(current.identity.actor ?? rootIdentity.actor
          ? { actor: current.identity.actor ?? rootIdentity.actor }
          : {})
      }
    };
  }

  function durableValidationTitle(baseTitle: string | undefined, command: string): string {
    const suffix = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\btsc\b/i.test(command)
      ? "构建验收"
      : /\b(?:test|vitest|jest|pytest|smoke)\b/i.test(command)
        ? "回归测试"
        : "命令验收";
    return baseTitle ? `${baseTitle} · ${suffix}` : `Durable ${suffix}`;
  }

  registerCodexTool(
    config,
    server,
    SUPERTOOL_NAME,
    {
      title: "CodexPro Supertool",
      description:
        "Stable wrapper only for hidden specialist actions. Call visible tools such as search_project, read_many_files, apply_patch_bundle, run_validation, and show_changes directly; wrapping visible actions adds avoidable routing failures. It cannot call tools disabled by the current mode.",
      inputSchema: {
        action: z.string().optional().describe("Action or registered tool name. Use list_actions to see what this server mode allows."),
        args: z.record(z.any()).optional().describe("Arguments for the selected action. Same shape as the wrapped CodexPro tool.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro supertool action...",
        "openai/toolInvocation/invoked": "CodexPro supertool action complete"
      }
    },
    async (args) => {
      const action = normalizeSupertoolAction(args.action);
      const names = registeredToolNames(server).filter((name) => name !== SUPERTOOL_NAME);
      if (action === "list_actions" || action === "help") {
        const text = [
          "# CodexPro Supertool",
          "",
          "Use `codexpro` only for hidden specialist actions. Call every action listed below directly by its explicit tool name; direct calls give validated schemas and avoid wrapper routing failures.",
          "For an active code task, stop supertool discovery here and return to the direct tools. Do not probe classify_task, current_task, server_config, run_task_status, or read_run_task_result unless the user explicitly requested durable task control or runtime administration.",
          "",
          "## Available actions",
          "",
          names.length ? names.map((name) => `- ${name}`).join("\n") : "- none",
          "",
          "## Usage",
          "",
          "```json",
          JSON.stringify({ action: "search", args: { workspace_id: "ws_...", query: "needle", path: "src" } }, null, 2),
          "```"
        ].join("\n");
        return textResult(text, {
          actions: names,
          action_count: names.length,
          aliases: SUPERTOOL_ACTION_ALIASES,
          tool_mode: config.toolMode,
          bash_mode: config.bashMode,
          write_mode: config.writeMode,
          workflow_guidance: {
            continue_with: "direct_tools",
            avoid_supertool_probes: ["classify_task", "current_task", "server_config", "run_task_status", "read_run_task_result"]
          }
        });
      }

      if (action === SUPERTOOL_NAME) {
        throw new CodexProError("codexpro cannot call itself. Use action=list_actions to inspect available wrapped actions.");
      }

      const childArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? args.args
          : {};
      const isPublicAction = names.includes(action);
      const taskInstruction = typeof childArgs.task_instruction === "string"
        ? childArgs.task_instruction.trim()
        : "";
      const route = !isPublicAction && config.toolMode === "progressive" && taskInstruction
        ? classifyTask(taskInstruction)
        : undefined;
      const taskDisclosed = Boolean(
        route
        && discloseToolsForTask(config, route.compiled_task).includes(action)
        && route.tool_policy.allowed_tools.includes(action)
      );
      const handler = isPublicAction || taskDisclosed
        ? registeredToolHandler(server, action)
        : undefined;
      if (!handler) {
        const availability = toolAvailability(config, action);
        throw new CodexProError(
          `CodexPro action is unavailable (${availability.reason_code}): ${action}. ${availability.reason} ` +
            (config.toolMode === "progressive"
              ? "Call codexpro with action=list_actions. Hidden specialist actions also require args.task_instruction and must be disclosed by that task's compiled capability policy."
              : "Call codexpro with action=list_actions, or restart CodexPro with a broader tool mode if that action should be exposed.")
        );
      }
      let result: any;
      try {
        result = await handler(childArgs);
      } catch (error) {
        result = errorResult(error);
      }
      if (result && typeof result === "object") {
        const structured = result.structuredContent;
        result.structuredContent = safeStructuredContent({
          codexpro_tool: action,
          codexpro_title: action,
          codexpro_super_action: action,
          wrapped_tool: action,
          ...(structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {})
        });
      }
      return result;
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexPro server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro server config...",
        "openai/toolInvocation/invoked": "CodexPro server config ready"
      }
    },
    async () => {
      const protocolServer = (server as unknown as {
        server?: {
          getClientVersion?: () => unknown;
          getClientCapabilities?: () => unknown;
          getNegotiatedProtocolVersion?: () => unknown;
        };
      }).server;
      const sdkClientVersion = typeof protocolServer?.getClientVersion === "function"
        ? protocolServer.getClientVersion()
        : null;
      const sdkClientCapabilities = typeof protocolServer?.getClientCapabilities === "function"
        ? protocolServer.getClientCapabilities()
        : null;
      const sdkNegotiatedProtocolVersion = typeof protocolServer?.getNegotiatedProtocolVersion === "function"
        ? protocolServer.getNegotiatedProtocolVersion()
        : null;
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        runtimeProcess: {
          pid: process.pid,
          startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          uptimeSeconds: Math.round(process.uptime())
        },
        currentMcpConnection: {
          sdkClientVersion,
          sdkClientCapabilities,
          sdkNegotiatedProtocolVersion,
          evidenceMeaning: sdkNegotiatedProtocolVersion === "2026-07-28"
            ? "modern_2026_07_28"
            : sdkClientVersion
              ? "legacy_initialized_connection"
              : "not_exposed_by_current_sdk_or_transport"
        },
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        codexAdapter: config.codexAdapter,
        codexExecutable: config.codexExecutable,
        nativeRuntimePolicy: nativeRuntimePolicy(config),
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        browserMode: config.browserMode,
        browserCdpConfigured: Boolean(config.browserCdpUrl),
        browserCdpProfileConfigured: Boolean(config.browserCdpProfileDir),
        browserCdpConnectTimeoutMs: config.browserCdpConnectTimeoutMs,
        browserAllowHeadlessFallback: config.browserAllowHeadlessFallback,
        browserObserveMaxNodes: config.browserObserveMaxNodes,
        browserObserveMaxTextChars: config.browserObserveMaxTextChars,
        browserObserveMaxResponseBytes: config.browserObserveMaxResponseBytes,
        browserVerificationMaxPages: config.browserVerificationMaxPages,
        toolCards: config.toolCards,
        mcpModern: {
          protocolVersion: "2026-07-28",
          releaseStatus: "rc",
          explicitVersionClientsDefault: config.mcp20260728Enabled,
          rolloutPercent: config.mcp20260728RolloutPercent,
          tasksExtensionEnabled: config.mcpTasksExtensionEnabled,
          mrtrEnabled: config.mcpMrtrEnabled,
          appsEnabled: config.mcpAppsEnabled,
          subscriptionsEnabled: config.mcpSubscriptionsEnabled,
          oauthHardeningEnabled: config.mcpOauthHardeningEnabled,
          dpopRequired: config.mcpOauthDpopRequired,
          unversionedClientRoute: "legacy"
        },
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        skillsEnabled: config.skillsEnabled,
        skillsRoot: config.skillsRoot,
        skillsLockFile: config.skillsLockFile,
        maxSkillReadBytes: config.maxSkillReadBytes,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        toolLimitsVersion: TOOL_LIMITS_VERSION,
        toolLimitsDigest: TOOL_LIMITS_DIGEST,
        toolSchemaDigest: coreToolSchemaDigest(server),
        toolLimits: TOOL_LIMITS,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length,
        runtimeClass: goldTaskRuntimeIdentity(config.defaultRoot).active ? "isolated_gold_task" : "ordinary",
        toolAvailability: Object.fromEntries(coreToolNames(server).map((name) => [name, toolAvailability(config, name)]))
      };
      return textResult(`# CodexPro Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  for (const skillTool of createSkillTools(config)) {
    registerCodexTool(
      config,
      server,
      skillTool.name,
      {
        title: skillTool.title,
        description: skillTool.description,
        inputSchema: skillTool.inputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": skillTool.invoking,
          "openai/toolInvocation/invoked": skillTool.invoked
        }
      },
      async (args) => {
        const result = await skillTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  registerCodexTool(
    config,
    server,
    "run_neat_freak_acceptance",
    {
      title: "Run neat-freak Acceptance",
      description: "Verify a completed neat-freak run against its saved plan, actual changed files, document/code evidence, Agent rule references, memory boundary, workspace preservation, and six-area status table. Writes only the final acceptance receipt under .ai-bridge/neat-freak/runs/<run-id>/acceptance.json.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        skill_receipt: z.string().min(1).describe("Receipt returned by the successful read_skill call used for this neat-freak task."),
        run_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
        fact_checks: z.array(z.object({
          area: z.enum(["code", "docs", "rules"]),
          target_path: z.string().min(1).max(500),
          target_contains: z.string().min(1).max(4_000).optional(),
          target_absent: z.string().min(1).max(4_000).optional(),
          evidence_path: z.string().min(1).max(500),
          evidence_contains: z.string().min(1).max(4_000)
        })).max(100).optional(),
        rule_checks: z.array(z.object({
          rule_file: z.enum(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"]),
          referenced_paths: z.array(z.string().min(1).max(500)).max(100).optional(),
          commands: z.array(z.string().min(1).max(4_000)).max(50).optional()
        })).max(20).optional(),
        claimed_fact_status: z.object({
          code: z.enum(NEAT_FREAK_FACT_STATUSES).optional(),
          runtime: z.enum(NEAT_FREAK_FACT_STATUSES).optional(),
          docs: z.enum(NEAT_FREAK_FACT_STATUSES).optional(),
          rules: z.enum(NEAT_FREAK_FACT_STATUSES).optional(),
          memory: z.enum(NEAT_FREAK_FACT_STATUSES).optional(),
          workspace: z.enum(NEAT_FREAK_FACT_STATUSES).optional()
        }).optional(),
        memory: z.object({
          action: z.enum(["none", "proposal_only"]),
          summary: z.string().min(1).max(10_000)
        }),
        workspace: z.object({
          cleanup_action: z.literal("proposal_only"),
          candidate_paths: z.array(z.string().min(1).max(500)).max(200).optional()
        })
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Verifying neat-freak completion...",
        "openai/toolInvocation/invoked": "neat-freak acceptance ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const activeSkill = await resolveSkillUsageReceipt(config, args.skill_receipt);
      const result = await runNeatFreakAcceptance(config, guard, workspace, {
        run_id: args.run_id,
        active_skill: activeSkill,
        fact_checks: args.fact_checks,
        rule_checks: args.rule_checks,
        claimed_fact_status: args.claimed_fact_status,
        memory: args.memory,
        workspace: args.workspace
      });
      const text = [
        "# neat-freak Acceptance",
        "",
        `Passed: ${result.acceptance_passed}`,
        `Receipt: ${result.acceptance_path}`,
        "",
        "## Six-area status",
        "",
        ...Object.entries(result.fact_status).map(([area, status]) => `- ${area}: ${status}`),
        "",
        "## Findings",
        "",
        ...(result.findings.length ? result.findings.map((finding: string) => `- ${finding}`) : ["- none"]),
        "",
        "## Cleanup proposal",
        "",
        `Candidates: ${result.cleanup_candidate_count}`,
        `Proposal: ${result.cleanup_proposal_path}`,
        "No files were deleted. Candidate files remain in place until the user reviews and confirms them."
      ].join("\n");
      return textResult(text, result as unknown as Record<string, unknown>);
    }
  );

  for (const browserTool of createBrowserTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      browserTool.name,
      {
        title: browserTool.title,
        description: browserTool.description,
        inputSchema: browserTool.inputSchema,
        annotations: browserTool.safety === "write" ? HANDOFF_WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": browserTool.invoking,
          "openai/toolInvocation/invoked": browserTool.invoked
        }
      },
      async (args) => {
        const result = await browserTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const browserBusinessTool of createBrowserBusinessTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      browserBusinessTool.name,
      {
        title: browserBusinessTool.title,
        description: browserBusinessTool.description,
        inputSchema: browserBusinessTool.inputSchema,
        annotations: browserBusinessTool.safety === "write" ? HANDOFF_WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": browserBusinessTool.invoking,
          "openai/toolInvocation/invoked": browserBusinessTool.invoked
        }
      },
      async (args) => {
        const result = await browserBusinessTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const nodeTool of createNodeTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      nodeTool.name,
      {
        title: nodeTool.title,
        description: nodeTool.description,
        inputSchema: nodeTool.inputSchema,
        annotations: nodeTool.safety === "run" ? BASH_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": nodeTool.invoking,
          "openai/toolInvocation/invoked": nodeTool.invoked
        }
      },
      async (args) => {
        const result = await nodeTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const dockerTool of createDockerTools(guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      dockerTool.name,
      {
        title: dockerTool.title,
        description: dockerTool.description,
        inputSchema: dockerTool.inputSchema,
        annotations: dockerTool.safety === "write" ? HANDOFF_WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": dockerTool.invoking,
          "openai/toolInvocation/invoked": dockerTool.invoked
        }
      },
      async (args) => {
        const result = await dockerTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const phpTool of createPhpWordPressTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      phpTool.name,
      {
        title: phpTool.title,
        description: phpTool.description,
        inputSchema: phpTool.inputSchema,
        annotations: phpTool.safety === "run" ? BASH_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": phpTool.invoking,
          "openai/toolInvocation/invoked": phpTool.invoked
        }
      },
      async (args) => {
        const result = await phpTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const pythonTool of createPythonFastApiTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      pythonTool.name,
      {
        title: pythonTool.title,
        description: pythonTool.description,
        inputSchema: pythonTool.inputSchema,
        annotations: pythonTool.safety === "run" ? BASH_ANNOTATIONS : READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": pythonTool.invoking,
          "openai/toolInvocation/invoked": pythonTool.invoked
        }
      },
      async (args) => {
        const result = await pythonTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const databaseTool of createDatabaseReadonlyTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      databaseTool.name,
      {
        title: databaseTool.title,
        description: databaseTool.description,
        inputSchema: databaseTool.inputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": databaseTool.invoking,
          "openai/toolInvocation/invoked": databaseTool.invoked
        }
      },
      async (args) => {
        const result = await databaseTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  for (const gitTool of createGitTools(config, guard, resolveWorkspace)) {
    registerCodexTool(
      config,
      server,
      gitTool.name,
      {
        title: gitTool.title,
        description: gitTool.description,
        inputSchema: gitTool.inputSchema,
        annotations: gitTool.safety === "read"
          ? READ_ONLY_ANNOTATIONS
          : ["git_push", "git_push_only", "git_finalize"].includes(gitTool.name)
            ? GIT_NETWORK_WRITE_ANNOTATIONS
            : HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": gitTool.invoking,
          "openai/toolInvocation/invoked": gitTool.invoked
        }
      },
      async (args) => {
        const result = await gitTool.handler(args);
        return textResult(result.text, result.structured);
      }
    );
  }

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: "CodexPro Self Test",
      description:
        "Run one controlled, local-only CodexPro diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro self-test...",
        "openai/toolInvocation/invoked": "CodexPro self-test complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        "pass",
        config.authToken
          ? "token configured"
          : config.requireHttpToken
            ? "token required when serving HTTP"
            : "token auth explicitly disabled"
      );
      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );
      const definitions = coreToolDefinitions(server);
      const missingInputSchemas = definitions.filter((definition) => !definition.inputSchema).map((definition) => definition.name);
      const missingOutputSchemas = definitions.filter((definition) => !definition.outputSchema || !("tool_result" in definition.outputSchema)).map((definition) => definition.name);
      const missingContracts = definitions.filter((definition) => !definition.contract).map((definition) => definition.name);
      const missingWorkspaceBindings = definitions.filter((definition) => {
        if (!definition.contract?.workspace_generation_required) return false;
        const keys = Object.keys(definition.inputSchema ?? {});
        return !keys.includes("workspace_id") || !keys.includes("workspace_generation");
      }).map((definition) => definition.name);
      const missingEvidenceDeclarations = definitions.filter((definition) =>
        definition.contract && ["project_write", "command", "validation", "browser", "git"].includes(definition.contract.tool_category)
        && definition.contract.evidence_types.length === 0
      ).map((definition) => definition.name);
      const duplicateTools = actualTools.filter((name, index) => actualTools.indexOf(name) !== index);
      const gitForceArguments = definitions.filter((definition) => definition.name.startsWith("git_")
        && Object.keys(definition.inputSchema ?? {}).some((key) => /force|no_verify|skip_hook/i.test(key))).map((definition) => definition.name);
      const commitAssistant = definitions.find((definition) => definition.name === "commit_assistant")?.contract;
      const officeRegistryNames = officeCapabilityRegistry(config).capabilities.map((item) => item.tool_name).sort();
      const contractNames = definitions.map((definition) => definition.name).sort();
      check("input schemas", missingInputSchemas.length ? "fail" : "pass", missingInputSchemas.length ? `missing: ${missingInputSchemas.join(", ")}` : `${definitions.length} tools declare inputs`);
      check("ToolResultEnvelopeV1 outputs", missingOutputSchemas.length ? "fail" : "pass", missingOutputSchemas.length ? `missing: ${missingOutputSchemas.join(", ")}` : `${definitions.length} tools declare tool_result`);
      check("tool contract metadata", missingContracts.length ? "fail" : "pass", missingContracts.length ? `missing: ${missingContracts.join(", ")}` : `${definitions.length} tools classified`);
      check("workspace generation binding", missingWorkspaceBindings.length ? "fail" : "pass", missingWorkspaceBindings.length ? `missing: ${missingWorkspaceBindings.join(", ")}` : "every generation-bound tool has workspace_id and workspace_generation inputs");
      check("evidence declarations", missingEvidenceDeclarations.length ? "fail" : "pass", missingEvidenceDeclarations.length ? `missing: ${missingEvidenceDeclarations.join(", ")}` : "side-effect and acceptance categories declare evidence types");
      check("duplicate registration", duplicateTools.length ? "fail" : "pass", duplicateTools.length ? `duplicates: ${duplicateTools.join(", ")}` : "no duplicate public tool names");
      check("Git safety schema", gitForceArguments.length ? "fail" : "pass", gitForceArguments.length ? `forbidden override arguments: ${gitForceArguments.join(", ")}` : "no force/no-verify/skip-hook public Git arguments");
      check("commit assistant boundary", commitAssistant?.deprecated === true && commitAssistant.side_effect_level === "none" ? "pass" : "fail", commitAssistant ? `deprecated=${commitAssistant.deprecated}; side_effect=${commitAssistant.side_effect_level}` : "commit_assistant contract missing");
      check("Office capability registry", JSON.stringify(officeRegistryNames) === JSON.stringify(contractNames) ? "pass" : "fail", `${officeRegistryNames.length} Office capabilities / ${contractNames.length} MCP contracts`);

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexPro Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
            const scopedStatus = gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexPro Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexPro Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexPro exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_inventory",
    {
      title: "CodexPro Inventory",
      description:
        "List CodexPro modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro inventory...",
        "openai/toolInvocation/invoked": "CodexPro inventory ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const inventory = await codexproInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        name: z.string().describe("Exact skill name from skill_inventory or codexpro_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source when multiple skills share a name."),
        path: z.string().optional().describe("Exact sanitized path from skill_inventory when name/source are still ambiguous."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: auto when source/path is not workspace."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to scan while resolving the requested skill. Default: 500."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      const includeGlobalDefault =
        args.source === undefined ||
        (args.source !== undefined && args.source !== "workspace") ||
        Boolean(requestedPath && !requestedPath.startsWith("$WORKSPACE/"));
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: requestedPath,
        includeGlobal: parseBool(args.include_global_skills, includeGlobalDefault),
        maxSkills: limitInt(args.max_skills, 500, 1, 500),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List currently opened CodexPro workspaces for this server/config.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro workspaces...",
        "openai/toolInvocation/invoked": "CodexPro workspaces listed"
      }
    },
    async () => {
      const current = workspaces.listWorkspaces();
      const text = current.length
        ? current.map((workspace) => `- ${workspace.id} — ${workspace.root} (opened ${workspace.openedAt})`).join("\n")
        : "No workspaces opened on this CodexPro server/config yet. Call open_workspace first.";
      return textResult(text, { workspaces: current, count: current.length });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_projects",
    {
      title: "List Projects",
      description: "List named projects from ~/.codexpro/projects.yml, showing configured active project, runtime active workspace, and allowed-root status.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro projects...",
        "openai/toolInvocation/invoked": "CodexPro projects listed"
      }
    },
    async () => {
      const result = listUserProjects(config, workspaces.activeWorkspace());
      return textResult(result.text, result.structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "show_active_project",
    {
      title: "Show Active Project",
      description: "Show the configured active project from ~/.codexpro/projects.yml and whether it matches the runtime active workspace.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading active CodexPro project...",
        "openai/toolInvocation/invoked": "Active CodexPro project ready"
      }
    },
    async () => {
      const result = showActiveUserProject(config, workspaces.activeWorkspace());
      return textResult(result.text, result.structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "activate_project",
    {
      title: "Activate Project",
      description: "Update ~/.codexpro/projects.yml active project and switch the runtime active workspace to that project after allowed-root checks.",
      inputSchema: {
        project: z.string().optional().describe("Project name from ~/.codexpro/projects.yml."),
        name: z.string().optional().describe("Alias for project."),
        conversation_id: z.string().optional().describe("Stable conversation id used to bind subsequent tasks to this workspace.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Activating CodexPro project...",
        "openai/toolInvocation/invoked": "CodexPro project activation updated"
      }
    },
    async (args) => {
      const projectName = typeof args.project === "string" && args.project.trim() ? args.project : args.name;
      const result = await switchToUserProject(config, guard, workspaces, workspaceAuthority, String(projectName ?? ""), {
        includeTree: false,
        conversationId: args.conversation_id ?? conversationId
      });
      return textResult(result.text, result.structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "switch_project",
    {
      title: "Switch Project",
      description: "Switch to a named project from ~/.codexpro/projects.yml, persist it as active, and make tools without workspace_id use that active workspace.",
      inputSchema: {
        project: z.string().optional().describe("Project name from ~/.codexpro/projects.yml."),
        name: z.string().optional().describe("Alias for project."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        conversation_id: z.string().optional().describe("Stable conversation id used to bind subsequent tasks to this workspace.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Switching CodexPro active project...",
        "openai/toolInvocation/invoked": "CodexPro active project switched"
      }
    },
    async (args) => {
      if (args.project && args.name && args.project !== args.name) {
        throw new CodexProError("switch_project accepts either project or name. If both are provided, they must match.");
      }
      const projectName = typeof args.project === "string" && args.project.trim() ? args.project : args.name;
      const result = await switchToUserProject(config, guard, workspaces, workspaceAuthority, String(projectName ?? ""), {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        conversationId: args.conversation_id ?? conversationId
      });
      return textResult(result.text, result.structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Read the workspace already bound to this Connector conversation. This tool is strictly read-only: it never activates, rebinds, or changes the global active workspace. If the conversation is unbound, it inspects the configured default root and asks the caller to use open_workspace explicitly.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Explicit task-bound workspace id. This has priority over conversation and global active workspace."),
        conversation_id: z.string().optional().describe("Stable conversation id. The conversation binding has priority over global active workspace."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexPro workspace...",
        "openai/toolInvocation/invoked": "Current CodexPro workspace opened"
      }
    },
    async (args) => {
      const requestedConversationId = args.conversation_id ?? conversationId;
      const workspace = workspaceAuthority.resolveCurrent({
        workspaceId: args.workspace_id,
        conversationId: requestedConversationId,
        connectorRequest: true
      });
      const conversationBinding = workspaceAuthority.conversationBinding(requestedConversationId) ?? null;
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        project_id: workspace.projectId ?? null,
        workspace_generation: workspace.workspaceGeneration ?? null,
        active_workspace_state: workspaceAuthority.activeState() ?? null,
        conversation_workspace_binding: conversationBinding,
        conversation_workspace_bound: Boolean(conversationBinding),
        authority_source: workspace.authoritySource ?? null,
        read_only_inspection: true,
        binding_guidance: conversationBinding ? null : "This Connector conversation is not bound. Call open_workspace with the intended project before side effects.",
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        rule_summary: summary.ruleSummary,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open a local project directory. In a ChatGPT Connector request this updates only the current conversation binding and never changes the global active workspace; local CLI calls retain the global active-workspace compatibility path. Set activate=false for read-only inspection.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXPRO_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files."),
        activate: z.boolean().optional().describe("Activate and bind this workspace. Default: true. Set false for read-only inspection."),
        conversation_id: z.string().optional().describe("Stable conversation id used to bind subsequent tasks to this workspace.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexPro workspace...",
        "openai/toolInvocation/invoked": "CodexPro workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexProError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const requestedConversationId = args.conversation_id ?? conversationId;
      const activation = workspaceAuthority.openAndActivate(args.root ?? args.path, {
        activate: args.activate !== false,
        conversationId: requestedConversationId,
        source: "explicit_open",
        activatedBySessionId: requestedConversationId,
        authorityScope: requestedConversationId ? "conversation" : "global"
      });
      const workspace = activation.workspace;
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        project_id: activation.project.projectId,
        project_identity: activation.project,
        workspace_generation: workspace.workspaceGeneration ?? null,
        active_workspace_state: activation.activeState,
        conversation_workspace_binding: activation.conversationBinding,
        activated: activation.activated,
        authority_scope: activation.authorityScope,
        global_active_workspace_changed: activation.authorityScope === "global" && activation.activated,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        rule_summary: summary.ruleSummary,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "detect_project",
    {
      title: "Detect Project",
      description: "Detect the current workspace type, package manager, frameworks, important paths, and suggested acceptance commands from local repository signals.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Detecting project profile...",
        "openai/toolInvocation/invoked": "Project profile detected"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const profile = await detectProject(config, guard, workspace);
      return textResult(formatDetectedProject(profile), { workspace_id: workspace.id, root: workspace.root, profile });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_project_profile",
    {
      title: "Read Project Profile",
      description: "Read .codexpro/project.yml when present and merge it with detected local project signals.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading project profile...",
        "openai/toolInvocation/invoked": "Project profile ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const profile = await readProjectProfile(config, guard, workspace);
      const text = [`# Project Profile`, "", `Path: ${profile.path}`, `Exists: ${profile.existed ? "yes" : "no"}`, "", "```yaml", JSON.stringify(profile.config, null, 2), "```"].join("\n");
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...profile });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_project_config",
    {
      title: "Read Project Config",
      description: "Read and merge .codexpro/project.yml, detected project signals, and AGENTS/rules file summaries.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading project config...",
        "openai/toolInvocation/invoked": "Project config ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readProjectConfig(config, guard, workspace);
      return textResult(formatProjectConfigLoadResult(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_project_memory",
    {
      title: "Read Project Memory",
      description: `Read ${PROJECT_MEMORY_DIR} standard and custom markdown memory files. This tool is read-only and does not write long-term memory.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_custom: z.boolean().optional().describe("Include custom markdown/text files under .codexpro/memory. Default: true."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum memory files to read. Default: 20."),
        max_file_bytes: z.number().int().min(1000).max(80000).optional().describe("Maximum bytes per memory file. Default: 20000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading project memory...",
        "openai/toolInvocation/invoked": "Project memory ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readProjectMemory(config, guard, workspace, {
        includeCustom: parseBool(args.include_custom, true),
        maxFiles: Number.isFinite(Number(args.max_files)) ? Number(args.max_files) : undefined,
        maxFileBytes: Number.isFinite(Number(args.max_file_bytes)) ? Number(args.max_file_bytes) : undefined
      });
      return textResult(formatProjectMemory(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "summarize_project_memory",
    {
      title: "Summarize Project Memory",
      description: `Summarize ${PROJECT_MEMORY_DIR} into a compact project-memory briefing without writing or updating long-term memory.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_custom: z.boolean().optional().describe("Include custom markdown/text files under .codexpro/memory. Default: true."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum memory files to read before summarizing. Default: 20."),
        max_file_bytes: z.number().int().min(1000).max(80000).optional().describe("Maximum bytes per memory file. Default: 20000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing project memory...",
        "openai/toolInvocation/invoked": "Project memory summarized"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readProjectMemory(config, guard, workspace, {
        includeCustom: parseBool(args.include_custom, true),
        maxFiles: Number.isFinite(Number(args.max_files)) ? Number(args.max_files) : undefined,
        maxFileBytes: Number.isFinite(Number(args.max_file_bytes)) ? Number(args.max_file_bytes) : undefined
      });
      return textResult(summarizeProjectMemory(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "rebuild_memory_index",
    {
      title: "Rebuild Memory Index",
      description: `Build or refresh the local SQLite memory index at ${PROJECT_MEMORY_INDEX_PATH}. Markdown memory remains the source of truth; indexed text is redacted before storage.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_custom: z.boolean().optional().describe("Include custom markdown/text files under .codexpro/memory. Default: true."),
        max_files: z.number().int().min(1).max(50).optional().describe("Maximum memory files to index. Default: 30."),
        max_file_bytes: z.number().int().min(1000).max(80000).optional().describe("Maximum bytes per memory file before indexing. Default: 40000."),
        max_body_chars: z.number().int().min(1000).max(40000).optional().describe("Maximum characters stored per indexed item. Default: 12000.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Rebuilding memory index...",
        "openai/toolInvocation/invoked": "Memory index rebuilt"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, PROJECT_MEMORY_DIR);
      const result = await buildMemoryIndex(config, guard, workspace, {
        includeCustom: parseBool(args.include_custom, true),
        maxFiles: Number.isFinite(Number(args.max_files)) ? Number(args.max_files) : undefined,
        maxFileBytes: Number.isFinite(Number(args.max_file_bytes)) ? Number(args.max_file_bytes) : undefined,
        maxBodyChars: Number.isFinite(Number(args.max_body_chars)) ? Number(args.max_body_chars) : undefined
      });
      return textResult(formatMemoryIndexBuildResult(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "query_memory_index",
    {
      title: "Query Memory Index",
      description: `Query the local SQLite memory index at ${PROJECT_MEMORY_INDEX_PATH} by text, tag, session id, or memory source path. Read-only; run rebuild_memory_index first when memory changes.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().optional().describe("Case-insensitive text query over title, body, and source path."),
        tag: z.string().optional().describe("Optional normalized tag filter, such as stage-6.1 or rules."),
        session_id: z.string().optional().describe("Optional session/run/snapshot id filter."),
        source_path: z.string().optional().describe("Optional exact memory source path, for example .codexpro/memory/handoff.md."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum items to return. Default: 10.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Querying memory index...",
        "openai/toolInvocation/invoked": "Memory index query ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await queryMemoryIndex(config, guard, workspace, {
        query: args.query,
        tag: args.tag,
        sessionId: args.session_id,
        sourcePath: args.source_path,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
      });
      return textResult(formatMemoryIndexQueryResult(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "compress_old_sessions",
    {
      title: "Compress Old Sessions",
      description:
        "Build a local searchable summary layer for .codexpro/runs and .ai-bridge/task-snapshots. Recent sessions keep bounded detail; old sessions are summary-only so long logs and diffs do not pollute context.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_sessions: z.number().int().min(1).max(500).optional().describe("Maximum session directories to scan. Default: 200."),
        recent_count: z.number().int().min(1).max(30).optional().describe("Number of newest sessions allowed to expose bounded detail. Default: 5."),
        max_summary_chars: z.number().int().min(1000).max(12000).optional().describe("Maximum characters retained per final-report/memory-candidate summary. Default: 4000.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Compressing old session history...",
        "openai/toolInvocation/invoked": "Session summaries ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, ".codexpro/session-summaries");
      const result = await compressOldSessions(config, guard, workspace, {
        maxSessions: Number.isFinite(Number(args.max_sessions)) ? Number(args.max_sessions) : undefined,
        recentCount: Number.isFinite(Number(args.recent_count)) ? Number(args.recent_count) : undefined,
        maxSummaryChars: Number.isFinite(Number(args.max_summary_chars)) ? Number(args.max_summary_chars) : undefined
      });
      return textResult(formatSessionCompressionResult(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "query_session_summaries",
    {
      title: "Query Session Summaries",
      description:
        "Search the local session-summary layer by text or session id. include_detail returns bounded detail only for recent sessions; old sessions stay summary-only.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().optional().describe("Case-insensitive text search over final reports, diff summaries, memory candidates, and log clues."),
        session_id: z.string().optional().describe("Optional exact run/session/snapshot directory id."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum matches to return. Default: 10."),
        include_detail: z.boolean().optional().describe("Return bounded retained-artifact detail for recent sessions only. Default: false."),
        recent_count: z.number().int().min(1).max(30).optional().describe("Recent-session count used for read-only in-memory fallback. Default: 5."),
        max_sessions: z.number().int().min(1).max(500).optional().describe("Maximum sessions to scan in read-only fallback when the summary index does not exist. Default: 200."),
        max_detail_bytes: z.number().int().min(4000).max(120000).optional().describe("Maximum bytes of recent-session detail to return. Default: 80000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Querying session summaries...",
        "openai/toolInvocation/invoked": "Session summary query ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await querySessionSummaries(config, guard, workspace, {
        query: args.query,
        sessionId: args.session_id,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined,
        includeDetail: parseBool(args.include_detail, false),
        recentCount: Number.isFinite(Number(args.recent_count)) ? Number(args.recent_count) : undefined,
        maxSessions: Number.isFinite(Number(args.max_sessions)) ? Number(args.max_sessions) : undefined,
        maxDetailBytes: Number.isFinite(Number(args.max_detail_bytes)) ? Number(args.max_detail_bytes) : undefined
      });
      return textResult(formatSessionSummaryQueryResult(result), { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_rule_summary",
    {
      title: "Read Rule Summary",
      description: "Build a task preflight rule summary from global CodexPro operating rules, .codexpro/project.yml, AGENTS/rules files, and .codexpro/memory/rules.md. Read-only; does not write long-term memory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_rules: z.number().int().min(10).max(200).optional().describe("Maximum preflight rules to return. Default: 80."),
        max_memory_file_bytes: z.number().int().min(1000).max(80000).optional().describe("Maximum bytes per memory file. Default: 20000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Building rule summary...",
        "openai/toolInvocation/invoked": "Rule summary ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await buildRuleSummary(config, guard, workspace, {
        maxRules: Number.isFinite(Number(args.max_rules)) ? Number(args.max_rules) : undefined,
        maxMemoryFileBytes: Number.isFinite(Number(args.max_memory_file_bytes)) ? Number(args.max_memory_file_bytes) : undefined
      });
      return textResult(formatRuleSummary(result), { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "propose_memory_update",
    {
      title: "Propose Memory Update",
      description: "Read a task snapshot memory-candidate.md and prepare a safe proposal for a specific project memory file. This tool does not write long-term memory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        snapshot_id: z.string().optional().describe("Snapshot id containing memory-candidate.md."),
        candidate_path: z.string().optional().describe("Explicit candidate path under .ai-bridge/task-snapshots/.../memory-candidate.md."),
        target_file: z.string().optional().describe("Optional explicit target file under .codexpro/memory, for example .codexpro/memory/handoff.md.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Preparing memory update proposal...",
        "openai/toolInvocation/invoked": "Memory update proposal ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await proposeMemoryUpdate(config, guard, workspace, {
        snapshotId: args.snapshot_id,
        candidatePath: args.candidate_path,
        targetFile: args.target_file
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "append_project_memory",
    {
      title: "Append Project Memory",
      description: "Append explicit, user-approved content to one target file under .codexpro/memory. This never runs automatically from task snapshots.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        target_file: z.string().describe("Required explicit target file under .codexpro/memory, for example .codexpro/memory/decisions.md."),
        content: z.string().describe("Approved memory content to append after redaction."),
        heading: z.string().optional().describe("Optional section heading for the appended entry. Default: Accepted memory update.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Appending project memory...",
        "openai/toolInvocation/invoked": "Project memory appended"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, PROJECT_MEMORY_DIR);
      const result = await appendProjectMemory(config, guard, workspace, {
        targetFile: args.target_file,
        content: args.content,
        heading: args.heading
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "validate_project_config",
    {
      title: "Validate Project Config",
      description: "Validate .codexpro/project.yml shape and report warnings about sensitive paths, invalid browser config, and missing project identity fields.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Validating project config...",
        "openai/toolInvocation/invoked": "Project config validated"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await validateProjectConfig(config, guard, workspace);
      const text = [
        "# Validate Project Config",
        "",
        `Path: ${result.path}`,
        `Exists: ${result.existed ? "yes" : "no"}`,
        "",
        "## Validation",
        result.validation.length ? result.validation.map((issue) => `- ${issue.level.toUpperCase()} ${issue.path}: ${issue.message}`).join("\n") : "- no issues",
        "",
        "## Rules files",
        result.agents.files.length ? result.agents.files.map((file) => `- ${file.path}: ${file.title}`).join("\n") : "- none"
      ].join("\n");
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "init_project_config",
    {
      title: "Init Project Config",
      description: `Create ${PROJECT_CONFIG_PATH}, ${ACCEPTANCE_CONFIG_PATH}, ${TASKS_CONFIG_PATH}, and ${PROJECT_MEMORY_DIR} starter files from detected project signals. Existing memory files are always preserved.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        overwrite: z.boolean().optional().describe("Overwrite existing .codexpro config files. Default: false.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Initializing CodexPro project config...",
        "openai/toolInvocation/invoked": "CodexPro project config initialized"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, PROJECT_CONFIG_PATH);
      assertWriteToolAllowed(config, ACCEPTANCE_CONFIG_PATH);
      assertWriteToolAllowed(config, TASKS_CONFIG_PATH);
      assertWriteToolAllowed(config, PROJECT_MEMORY_DIR);
      const result = await initProjectConfig(config, guard, workspace, { overwrite: parseBool(args.overwrite, false) });
      const text = [
        "# Init Project Config",
        "",
        `Project config: ${result.project.path} (${result.project.changed ? "written" : "kept"})`,
        `Acceptance config: ${result.acceptance.path} (${result.acceptance.changed ? "written" : "kept"})`,
        `Tasks config: ${result.tasks.path} (${result.tasks.changed ? "written" : "kept"})`,
        `Project memory: ${result.memory.path} (${result.memory.changed ? "updated" : "kept"})`,
        `Memory files: ${result.memory.files.map((file) => `${file.path}:${file.changed ? "written" : "kept"}`).join(", ")}`,
        "",
        formatDetectedProject(result.profile)
      ].join("\n");
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "generate_project_map",
    {
      title: "Generate Project Map",
      description: `Generate ${PROJECT_MAP_PATH}, a human-readable map of the detected workspace architecture and safety notes.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Generating project map...",
        "openai/toolInvocation/invoked": "Project map generated"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, PROJECT_MAP_PATH);
      const result = await generateProjectMap(config, guard, workspace);
      return textResult(result.content, { workspace_id: workspace.id, root: workspace.root, path: result.path, profile: result.profile });
    }
  );

  registerCodexTool(
    config,
    server,
    "dirty_guard",
    {
      title: "Dirty Guard",
      description: "Report current git dirty state, changed files, and optional diff preview without blocking writes.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_diff: z.boolean().optional().describe("Include a bounded diff preview. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Checking workspace dirty state...",
        "openai/toolInvocation/invoked": "Workspace dirty state checked"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = dirtyGuard(config, guard, workspace, { includeDiff: parseBool(args.include_diff, false) });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "start_task_snapshot",
    {
      title: "Start Task Snapshot",
      description: "Capture before-status and before-diff under .ai-bridge/task-snapshots for a named task.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_name: z.string().describe("Short task name used in the snapshot directory slug."),
        task_id: z.string().min(1).max(128).optional().describe("Authoritative Task Identity to bind into the snapshot."),
        objective: z.string().min(1).max(2000).optional().describe("Final objective accepted for this task."),
        accepted_scope: z.array(z.string().min(1)).max(200).optional(),
        excluded_scope: z.array(z.string().min(1)).max(200).optional(),
        task_rule_summary: z.string().max(10000).optional(),
        initial_owner: z.string().max(300).optional(),
        initial_plan: z.string().max(100000).optional().describe("Initial plan body; only its SHA-256 is persisted in snapshot metadata."),
        notes: z.string().optional().describe("Optional human-readable notes to store in the snapshot summary."),
        skill_receipt: z.string().optional().describe("Receipt returned by a successful read_skill call. Omit for tasks that do not use a Skill.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Starting task snapshot...",
        "openai/toolInvocation/invoked": "Task snapshot started"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, `${config.contextDir}/task-snapshots`);
      const activeSkill = args.skill_receipt ? await resolveSkillUsageReceipt(config, args.skill_receipt) : undefined;
      const result = await startTaskSnapshot(config, guard, workspace, {
        taskName: args.task_name,
        notes: args.notes,
        activeSkill,
        taskId: args.task_id,
        objective: args.objective,
        acceptedScope: args.accepted_scope,
        excludedScope: args.excluded_scope,
        taskRuleSummary: args.task_rule_summary,
        initialOwner: args.initial_owner,
        initialPlan: args.initial_plan
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "finish_task_snapshot",
    {
      title: "Finish Task Snapshot",
      description: "Capture after-status, after-diff, changed-file summary, and task snapshot report under .ai-bridge/task-snapshots.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        snapshot_id: z.string().describe("Snapshot id returned by start_task_snapshot."),
        notes: z.string().optional().describe("Optional human-readable finish notes."),
        validation_refs: z.array(z.string().min(1)).max(100).optional().describe("Existing workspace-relative validation evidence files."),
        browser_report_refs: z.array(z.string().min(1)).max(100).optional().describe("Existing workspace-relative browser report files."),
        commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
        push_remote_state: z.object({
          status: z.enum(["not_requested", "completed", "failed", "unknown"]),
          remote: z.string().max(100).optional(),
          branch: z.string().max(255).optional(),
          remote_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(),
          ahead: z.number().int().min(0).nullable().optional(),
          behind: z.number().int().min(0).nullable().optional()
        }).optional(),
        deployment_evidence: z.array(z.string().min(1)).max(100).optional(),
        remaining_issues: z.array(z.string().min(1)).max(200).optional(),
        memory_candidates: z.array(z.string().min(1)).max(100).optional(),
        final_completion_state: z.object({
          version: z.literal(1),
          analysis_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          implementation_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          validation_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          browser_acceptance_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          git_prepare_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          git_commit_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          git_push_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          deployment_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          post_deploy_check_status: z.enum(["not_requested", "pending", "running", "completed", "passed", "failed", "blocked", "cancelled", "skipped", "unknown"]),
          completion_level: z.string(), closure_ready: z.boolean(), required_gates: z.array(z.string()), unsatisfied_gates: z.array(z.string()), terminal_reason: z.string().nullable()
        }).optional(),
        terminal_reason: z.string().max(2000).optional()
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Finishing task snapshot...",
        "openai/toolInvocation/invoked": "Task snapshot finished"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, `${config.contextDir}/task-snapshots`);
      const result = await finishTaskSnapshot(config, guard, workspace, {
        snapshotId: args.snapshot_id,
        notes: args.notes,
        validationRefs: args.validation_refs,
        browserReportRefs: args.browser_report_refs,
        commitSha: args.commit_sha,
        pushRemoteState: args.push_remote_state,
        deploymentEvidence: args.deployment_evidence,
        remainingIssues: args.remaining_issues,
        memoryCandidates: args.memory_candidates,
        finalCompletionState: args.final_completion_state,
        terminalReason: args.terminal_reason
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_acceptance",
    {
      title: "Run Acceptance",
      description: `Run commands from ${ACCEPTANCE_CONFIG_PATH}. Long profiles start as persistent local tasks and return a run id immediately; short checks may remain synchronous.`,
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        profile: z.string().optional().describe("Acceptance profile name. Defaults to default_profile in .codexpro/acceptance.yml."),
        stop_on_failure: z.boolean().optional().describe("Stop after the first failing command. Default: false."),
        session_id: z.string().optional().describe("Optional bash session id when this server requires one."),
        execution_mode: z.enum(["auto", "sync", "async"]).optional().describe("Execution mode. auto keeps short checks synchronous and starts long acceptance as a persistent task. Default: auto."),
        skill_receipt: z.string().optional().describe("Receipt returned by a successful read_skill call. Omit for tasks that do not use a Skill.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running acceptance checks...",
        "openai/toolInvocation/invoked": "Acceptance checks complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertWriteToolAllowed(config, `${config.contextDir}/acceptance-reports`);
      assertWriteToolAllowed(config, `${config.contextDir}/acceptance-runs`);
      const activeSkill = args.skill_receipt ? await resolveSkillUsageReceipt(config, args.skill_receipt) : undefined;
      const options = {
        profile: args.profile,
        stopOnFailure: parseBool(args.stop_on_failure, false),
        sessionId: args.session_id,
        activeSkill
      };
      const preparation = await prepareAcceptanceRun(config, guard, workspace, options);
      const executionMode = String(args.execution_mode ?? "auto") as AcceptanceExecutionMode;
      if (shouldStartAsyncAcceptance(preparation, executionMode)) {
        const state = await startAcceptanceTask(config, guard, workspace, options, preparation);
        const text = [
          "Acceptance accepted as a persistent local task.",
          `run_id=${state.run_id}`,
          `acceptance_key=${state.acceptance_key}`,
          `profile=${state.profile}`,
          `ownership_status=${state.ownership_status}`,
          `coalesced=${state.coalesced}`,
          `cache_hit=${state.cache_hit}`,
          `execution_status=${state.execution_status}`,
          `validation_status=${state.validation_status}`,
          `transport_status=${state.transport_status}`,
          `cache_key=${state.cache_key}`,
          `owner_token=${state.owner_token}`,
          `fencing_token=${state.fencing_token}`,
          `resource_status=${state.resource_status}`,
          state.queue_id ? `queue_id=${state.queue_id}` : "",
          state.queue_position ? `queue_position=${state.queue_position}` : "",
          "Use acceptance_status to query progress, cancel_acceptance to cancel this run, and read_acceptance_result to read the final report."
        ].join("\n");
        return textResult(text, {
          root: workspace.root,
          accepted: true,
          execution_mode: "async",
          status_tool: "acceptance_status",
          result_tool: "read_acceptance_result",
          ...state
        });
      }
      const result = await runAcceptance(config, guard, workspace, options);
      return textResult(result.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        accepted: true,
        execution_mode: "sync",
        transport_status: "response_complete",
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "acceptance_status",
    {
      title: "Acceptance Status",
      description: "Read the persisted execution and validation status for a long acceptance run returned by run_acceptance.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).max(80).describe("Acceptance run id returned by run_acceptance.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading acceptance status...",
        "openai/toolInvocation/invoked": "Acceptance status ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await getAcceptanceTaskStatus(config, guard, workspace, args.run_id);
      return textResult([
        `run_id=${state.run_id}`,
        `acceptance_key=${state.acceptance_key}`,
        `profile=${state.profile}`,
        `ownership_status=${state.ownership_status}`,
        `coalesced=${state.coalesced}`,
        `cache_hit=${state.cache_hit}`,
        `execution_status=${state.execution_status}`,
        `validation_status=${state.validation_status}`,
        `transport_status=${state.transport_status}`,
        `phase=${state.progress.phase}`,
        `action=${state.progress.current_action}`,
        `execution_state=${state.progress.execution_state}`,
        `heartbeat_at=${state.progress.heartbeat_at}`,
        `result_available=${state.result_available}`,
        `start_status=${state.start_status}`,
        `validation_started=${state.validation_started}`,
        `resource_status=${state.resource_status}`,
        state.queue_id ? `queue_id=${state.queue_id}` : "",
        state.queue_position ? `queue_position=${state.queue_position}` : "",
        state.queue_deadline ? `queue_deadline=${state.queue_deadline}` : "",
        state.blocking_reasons.length ? `blocking_reasons=${state.blocking_reasons.join(" | ")}` : "",
        state.report_path ? `report=${state.report_path}` : "",
        state.result_path ? `result=${state.result_path}` : "",
        state.progress.wait_reason ? `wait_reason=${state.progress.wait_reason}` : "",
        state.recovery_reason ? `recovery_reason=${state.recovery_reason}` : "",
        state.error ? `error=${state.error}` : ""
      ].filter(Boolean).join("\n"), { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "cancel_acceptance",
    {
      title: "Cancel Acceptance",
      description: "Cancel one persisted acceptance run. Queued runs are removed from the resource queue; running managed validation receives an abort signal and its process tree is terminated.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).max(80).describe("Acceptance run id returned by run_acceptance."),
        owner_token: z.string().min(1).max(128).describe("Acceptance cancellation owner token returned by run_acceptance or acceptance_status."),
        fencing_token: z.number().int().min(1).describe("Acceptance fencing token returned by run_acceptance or acceptance_status.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Cancelling acceptance...",
        "openai/toolInvocation/invoked": "Acceptance cancellation recorded"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await cancelAcceptanceTask(config, guard, workspace, args.run_id, args.owner_token, args.fencing_token);
      return textResult([
        `run_id=${state.run_id}`,
        `execution_status=${state.execution_status}`,
        `validation_status=${state.validation_status}`,
        `cancel_requested=${state.cancel_requested}`,
        `resource_status=${state.resource_status}`,
        `start_status=${state.start_status}`
      ].join("\n"), { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_acceptance_result",
    {
      title: "Read Acceptance Result",
      description: "Read the final persisted acceptance result and bounded report text after a long acceptance run completes.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).max(80).describe("Acceptance run id returned by run_acceptance."),
        max_chars: z.number().int().min(1000).max(60000).optional().describe("Maximum report characters to return. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading acceptance result...",
        "openai/toolInvocation/invoked": "Acceptance result ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const read = await readAcceptanceTaskResult(config, guard, workspace, args.run_id, limitInt(args.max_chars, 60_000, 1_000, 60_000));
      if (!read.result) {
        return textResult([
          `run_id=${read.state.run_id}`,
          `execution_status=${read.state.execution_status}`,
          `validation_status=${read.state.validation_status}`,
          "result_available=false",
          "Use acceptance_status and call read_acceptance_result again after the task reaches a terminal state."
        ].join("\n"), { workspace_id: workspace.id, root: workspace.root, ...read });
      }
      return textResult(read.text ?? read.result.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...read
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "commit_assistant",
    {
      title: "生成提交建议",
      description: "Legacy alias for git_prepare. Summarizes commit candidates but does not suggest commit/push commands unless the newer git_prepare approval gate is satisfied.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_untracked: z.boolean().optional().describe("Include untracked files in recommended commit candidates. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Preparing commit assistance...",
        "openai/toolInvocation/invoked": "Commit assistance ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = buildCommitAssistant(config, guard, workspace, { includeUntracked: parseBool(args.include_untracked, true) });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used,
        status: result.status,
        failure_code: result.failureCode ?? null,
        degraded_reason: result.degradedReason ?? null,
        search_backend: result.used,
        duration_ms: result.diagnostics.durationMs,
        search_process_count: result.diagnostics.searchProcessCount,
        backend_probe_count: result.diagnostics.backendProbeCount,
        filesystem_walk_count: result.diagnostics.filesystemWalkCount,
        files_scanned: result.diagnostics.filesScanned,
        files_read: result.diagnostics.filesRead,
        bytes_scanned: result.diagnostics.bytesScanned
      };
      // The tool card widget renders search hits from structuredContent.text.
      // When cards are disabled (the default), including it would only duplicate
      // the human-readable content payload, so omit the large blob in that case.
      if (config.toolCards) structured.text = result.text;
      return textResult(result.text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. Returns a unified diff; do not create empty placeholder files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this write.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "write");
      assertTaskRouteToolAllowed("write", args);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const patchReservation = enforceGoldTaskPatchLoopBudget(workspace.root, "workspace_mutation", [{
        operation: "write",
        path: args.path,
        content: args.content
      }]);
      let result;
      try {
        result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
          createDirs: args.create_dirs !== false,
          overwrite: args.overwrite !== false
        });
        if (!result.diff.changed) releaseGoldTaskPatchLoopReservation(patchReservation, "write_no_change");
      } catch (error) {
        releaseGoldTaskPatchLoopReservation(patchReservation, "write_failed");
        throw error;
      }
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement inside a workspace text file. Returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        task_instruction: z.string().optional().describe("Original user task. Required in progressive mode so Task Router can verify write intent."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this edit.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "edit");
      assertTaskRouteToolAllowed("edit", args);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const patchReservation = enforceGoldTaskPatchLoopBudget(workspace.root, "workspace_mutation", [{
        operation: "replace",
        path: args.path,
        old_text: args.old_text,
        new_text: args.new_text
      }]);
      let result;
      try {
        result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
          replaceAll: parseBool(args.replace_all, false),
          expectedReplacements: args.expected_replacements
        });
        if (!result.diff.changed) releaseGoldTaskPatchLoopReservation(patchReservation, "edit_no_change");
      } catch (error) {
        releaseGoldTaskPatchLoopReservation(patchReservation, "edit_failed");
        throw error;
      }
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_many_files",
    {
      title: "Read Many Files",
      description: "Read multiple text files in one compact tool call to reduce repeated read/cat windows. Returns bounded per-file previews.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        files: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), max_bytes: z.number().int().min(1000).max(TOOL_LIMITS.common.file_input_max_bytes).optional() })).min(1).max(TOOL_LIMITS.read_many_files.max_files),
        max_chars_per_file: z.number().int().min(500).max(TOOL_LIMITS.read_many_files.max_chars_per_file).optional(),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.read_many_files.max_files_per_task).optional().describe("Override context.max_files_per_task for this call."),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.read_many_files.max_lines_per_file).optional().describe("Override context.max_lines_per_file for this call."),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.read_many_files.max_total_chars).optional().describe("Override context.max_total_chars for this call.")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readManyFiles(config, guard, workspace, args.files, args.max_chars_per_file, {
        maxFilesPerTask: args.max_files_per_task,
        maxLinesPerFile: args.max_lines_per_file,
        maxTotalChars: args.max_total_chars
      });
      searchLoopBreaker.recordProgress(workspace.root);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.data });
    }
  );

  registerCodexTool(
    config,
    server,
    "search_project",
    {
      title: "Search Project",
      description: "Batch all currently known fixed-string queries into one compact call, then read returned paths with read_many_files. Do not issue one search call per symbol or repeat the same query unless this response is partial.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        queries: z.array(z.string()).min(1).max(MAX_AGGREGATE_SEARCH_QUERIES),
        path: z.string().optional(),
        glob: z.string().optional(),
        include_hidden: z.boolean().optional(),
        max_results_per_query: z.number().int().min(1).max(MAX_AGGREGATE_RESULTS_PER_QUERY).optional(),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.search_project.max_files_per_task).optional().describe("Override context.max_files_per_task for this call."),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.search_project.max_lines_per_file).optional().describe("Override context.max_lines_per_file for this call."),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.search_project.max_total_chars).optional().describe("Override context.max_total_chars for this call.")
      },
      annotations: { readOnlyHint: true }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const searchLoopGuard = searchLoopBreaker.beforeSearch(workspace.root, {
        queries: args.queries,
        path: args.path,
        glob: args.glob
      });
      const result = await searchProject(config, guard, workspace, args.queries, {
        path: args.path,
        glob: args.glob,
        include_hidden: args.include_hidden,
        max_results_per_query: args.max_results_per_query,
        max_files_per_task: args.max_files_per_task,
        max_lines_per_file: args.max_lines_per_file,
        max_total_chars: args.max_total_chars
      });
      return textResult(result.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        ...result.data,
        search_loop_guard: searchLoopGuard
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "classify_task",
    {
      title: "Classify Task",
      description: "Classify a user task into a CodexPro task mode and return mode-specific tool policy / misuse guard guidance.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        instruction: z.string().min(1).describe("User task or instruction to classify."),
        requested_tool: z.string().optional().describe("Optional tool name to check against the classified task mode."),
        patches_requested: z.boolean().optional().describe("Set true when a planned run_task/run_stage includes patches."),
        commands_requested: z.boolean().optional().describe("Set true when a planned tool call includes bash/validation commands."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional explicit task mode override.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const decision = classifyTask(String(args.instruction ?? ""), {
        mode: args.task_mode,
        requestedTool: args.requested_tool,
        patchesRequested: args.patches_requested,
        commandsRequested: args.commands_requested
      });
      return textResult(formatTaskRouteDecision(decision), { workspace_id: workspace.id, root: workspace.root, ...decision });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch_bundle",
    {
      title: "Apply Patch Bundle",
      description: "Apply multiple write or exact-replacement operations in one compact tool call.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        operations: z.array(z.object({ operation_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(), operation: z.enum(["write", "replace"]), path: z.string(), content: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), create_dirs: z.boolean().optional(), overwrite: z.boolean().optional(), replace_all: z.boolean().optional(), expected_replacements: z.number().int().min(1).optional() })).min(1).max(TOOL_LIMITS.patch_bundle.max_operations),
        task_instruction: z.string().optional().describe("Original user task. Required in progressive mode so Task Router can verify write intent."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this patch bundle.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "apply_patch_bundle");
      const activeGoldTask = goldTaskRuntimeIdentity(workspace.root).active;
      if (config.toolMode === "progressive" && !args.task_instruction && !args.task_mode && !activeGoldTask) {
        throw new CodexProError(
          "apply_patch_bundle requires task_instruction or task_mode in progressive mode so Task Router can verify write intent."
        );
      }
      const routedArgs = activeGoldTask && !args.task_instruction && !args.task_mode
        ? { ...args, task_mode: "code_patch" as const }
        : args;
      assertTaskRouteToolAllowed("apply_patch_bundle", routedArgs, { patchesRequested: true });
      const result = await applyPatchBundle(config, guard, workspace, args.operations);
      searchLoopBreaker.recordProgress(workspace.root);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.data });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_validation",
    {
      title: "Run Validation",
      description: "Run project checks with durable handling for long builds and test suites. In execution_mode=auto, long commands return immediately with a run id and continue locally; use run_task_status and read_run_task_result for the final result. Short checks still return synchronously.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        commands: z.array(z.string()).min(1).max(TOOL_LIMITS.validation.max_commands).optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().int().min(1000).max(180000).optional(),
        session_id: z.string().optional(),
        output_mode: z.enum(["compact", "full"]).optional().describe("Response verbosity only; does not imply durable report persistence."),
        persistence_mode: z.enum(["none", "summary", "full"]).optional().describe("Durable report policy independent of response verbosity."),
        tail_lines: z.number().int().min(20).max(400).optional(),
        run_id: z.string().optional(),
        save_full_logs: z.boolean().optional().describe("Legacy compatibility override; prefer persistence_mode."),
        execution_mode: z.enum(["auto", "sync", "async"]).optional().describe("Default: auto. Long builds/tests use durable background execution; sync forces direct waiting; async always returns a run id.")
      }
    },
    async (args, context) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const executionMode = (args.execution_mode ?? "auto") as CommandExecutionMode;
      const commands = resolveValidationCommands(config, workspace, { commands: args.commands });
      if (shouldStartAsyncValidation(commands, executionMode, args.timeout_ms)) {
        const inherited = await inheritedValidationIdentity(workspace);
        const commandSummary = commands.join("\n");
        const state = await startAsyncCompactTask(config, guard, workspace, "task", {
          title: durableValidationTitle(inherited?.title, commandSummary),
          goal: inherited
            ? `Run validation for ${inherited.title} and persist the final result without depending on one long Connector response.`
            : "Run the selected project checks and persist the final result without depending on one long Connector response.",
          ...(inherited ? { task_identity: inherited.task_identity } : {}),
          commands,
          cwd: args.cwd,
          timeout_ms: args.timeout_ms,
          session_id: args.session_id,
          output_mode: args.output_mode,
          persistence_mode: args.persistence_mode,
          tail_lines: args.tail_lines,
          run_id: args.run_id,
          save_full_logs: args.save_full_logs
        });
        searchLoopBreaker.recordProgress(workspace.root);
        return await durableValidationAccepted(workspace, state, "run_validation", executionMode);
      }
      const result = await runValidation(config, guard, workspace, {
        commands,
        cwd: args.cwd,
        timeout_ms: args.timeout_ms,
        session_id: args.session_id,
        output_mode: args.output_mode,
        persistence_mode: args.persistence_mode,
        tail_lines: args.tail_lines,
        run_id: args.run_id,
        save_full_logs: args.save_full_logs,
        signal: context?.signal
      });
      searchLoopBreaker.recordProgress(workspace.root);
      return textResult(result.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        dispatch_mode: "synchronous",
        execution_mode: executionMode,
        ...result.data
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_task",
    {
      title: "Run Task",
      description: "Run one bounded short task with deterministic local CodexPro tools only; it does not invoke Codex CLI, Codex SDK, or an external model. Returns a compact summary and report path; use start_run_task for long-running work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional(),
        goal: z.string().optional(),
        search_queries: z.array(z.string()).max(MAX_AGGREGATE_SEARCH_QUERIES).optional(),
        search_path: z.string().optional().describe("Limit all aggregate searches to this workspace-relative path."),
        search_glob: z.string().optional().describe("Optional glob applied to all aggregate searches."),
        search_include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results_per_query: z.number().int().min(1).max(MAX_AGGREGATE_RESULTS_PER_QUERY).optional().describe(`Maximum matches per search query. Default: ${TOOL_LIMITS.aggregate_execution.max_results_per_query}.`),
        read_files: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), max_bytes: z.number().int().min(1000).max(TOOL_LIMITS.common.file_input_max_bytes).optional() })).max(MAX_AGGREGATE_READ_FILES).optional(),
        patches: z.array(z.object({ operation_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(), operation: z.enum(["write", "replace"]), path: z.string(), content: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), create_dirs: z.boolean().optional(), overwrite: z.boolean().optional(), replace_all: z.boolean().optional(), expected_replacements: z.number().int().min(1).optional() })).max(MAX_AGGREGATE_PATCHES).optional(),
        commands: z.array(z.string()).max(MAX_AGGREGATE_COMMANDS).optional().describe(`Up to ${TOOL_LIMITS.aggregate_execution.max_commands} targeted validation commands. They may follow bounded search, read, and patch steps in the same task.`),
        run_id: z.string().optional(),
        output_mode: z.enum(["compact", "full"]).optional().describe("Response verbosity only; does not imply durable report persistence."),
        persistence_mode: z.enum(["none", "summary", "full"]).optional().describe("Durable report policy independent of response verbosity."),
        tail_lines: z.number().int().min(20).max(400).optional(),
        save_full_logs: z.boolean().optional().describe("Legacy compatibility override; prefer persistence_mode."),
        skill_receipt: z.string().optional().describe("Receipt returned by a successful read_skill call. Omit for tasks that do not use a Skill."),
        skill_plan: SKILL_PLAN_INPUT_SCHEMA.optional().describe("Required for neat-freak tasks that write files or run commands. Lists every planned file with reason and evidence."),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this task."),
        mode: z.enum(["analyze", "implement", "validate"]).optional().describe("Strongly recommended aggregate operation mode. When omitted it is derived from patches/commands; analyze and validate can never contain source patches."),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.common.max_files_per_task).optional().describe("Override context.max_files_per_task for this task."),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.common.max_lines_per_file).optional().describe("Override context.max_lines_per_file for this task."),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.common.max_total_chars).optional().describe("Override context.max_total_chars for this task.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const operationMode = aggregateOperationMode(args, "run_task");
      if (args.patches?.length) assertNotProjectPoolRoot(config, workspace, "run_task patches");
      assertTaskRouteToolAllowed("run_task", args, { patchesRequested: Boolean(args.patches?.length), commandsRequested: Boolean(args.commands?.length) });
      const { skill_receipt: skillReceipt, ...taskArgs } = args;
      const activeSkill = skillReceipt ? await resolveSkillUsageReceipt(config, skillReceipt) : undefined;
      const result = await runTask(config, guard, workspace, { ...taskArgs, active_skill: activeSkill });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, operation_mode: operationMode, ...result.data });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_stage",
    {
      title: "Run Stage",
      description: "Run one bounded short stage with deterministic local CodexPro tools only; it does not invoke Codex CLI, Codex SDK, or an external model. Returns a compact summary plus report path. Use start_run_task with kind=stage for long-running work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional(),
        goal: z.string().optional(),
        search_queries: z.array(z.string()).max(MAX_AGGREGATE_SEARCH_QUERIES).optional(),
        search_path: z.string().optional().describe("Limit all aggregate searches to this workspace-relative path."),
        search_glob: z.string().optional().describe("Optional glob applied to all aggregate searches."),
        search_include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results_per_query: z.number().int().min(1).max(MAX_AGGREGATE_RESULTS_PER_QUERY).optional().describe(`Maximum matches per search query. Default: ${TOOL_LIMITS.aggregate_execution.max_results_per_query}.`),
        read_files: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), max_bytes: z.number().int().min(1000).max(TOOL_LIMITS.common.file_input_max_bytes).optional() })).max(MAX_AGGREGATE_READ_FILES).optional(),
        patches: z.array(z.object({ operation_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(), operation: z.enum(["write", "replace"]), path: z.string(), content: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), create_dirs: z.boolean().optional(), overwrite: z.boolean().optional(), replace_all: z.boolean().optional(), expected_replacements: z.number().int().min(1).optional() })).max(MAX_AGGREGATE_PATCHES).optional(),
        commands: z.array(z.string()).max(MAX_AGGREGATE_COMMANDS).optional().describe(`Up to ${TOOL_LIMITS.aggregate_execution.max_commands} targeted validation commands. They may follow bounded search, read, and patch steps in the same task.`),
        run_id: z.string().optional(),
        output_mode: z.enum(["compact", "full"]).optional().describe("Response verbosity only; does not imply durable report persistence."),
        persistence_mode: z.enum(["none", "summary", "full"]).optional().describe("Durable report policy independent of response verbosity."),
        tail_lines: z.number().int().min(20).max(400).optional(),
        save_full_logs: z.boolean().optional().describe("Legacy compatibility override; prefer persistence_mode."),
        skill_receipt: z.string().optional().describe("Receipt returned by a successful read_skill call. Omit for tasks that do not use a Skill."),
        skill_plan: SKILL_PLAN_INPUT_SCHEMA.optional().describe("Required for neat-freak tasks that write files or run commands. Lists every planned file with reason and evidence."),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this stage."),
        mode: z.enum(["analyze", "implement", "validate"]).optional().describe("Strongly recommended aggregate operation mode. When omitted it is derived from patches/commands; analyze and validate can never contain source patches."),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.common.max_files_per_task).optional().describe("Override context.max_files_per_task for this stage."),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.common.max_lines_per_file).optional().describe("Override context.max_lines_per_file for this stage."),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.common.max_total_chars).optional().describe("Override context.max_total_chars for this stage.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const operationMode = aggregateOperationMode(args, "run_stage");
      if (args.patches?.length) assertNotProjectPoolRoot(config, workspace, "run_stage patches");
      assertTaskRouteToolAllowed("run_stage", args, { patchesRequested: Boolean(args.patches?.length), commandsRequested: Boolean(args.commands?.length) });
      const { skill_receipt: skillReceipt, ...taskArgs } = args;
      const activeSkill = skillReceipt ? await resolveSkillUsageReceipt(config, skillReceipt) : undefined;
      const result = await runStage(config, guard, workspace, { ...taskArgs, active_skill: activeSkill });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, operation_mode: operationMode, ...result.data });
    }
  );

  registerCodexTool(
    config,
    server,
    "start_run_task",
    {
      title: "Start Run Task",
      description: "Start a long-running deterministic local CodexPro task or stage asynchronously; it does not invoke Codex CLI, Codex SDK, or an external model. Returns immediately with a run id; use run_task_status and read_run_task_result afterward.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        kind: z.enum(["task", "stage"]).optional().describe("Asynchronous execution kind. Default: task."),
        title: z.string().optional(),
        goal: z.string().optional(),
        search_queries: z.array(z.string()).max(TOOL_LIMITS.durable_execution.max_search_queries).optional(),
        search_path: z.string().optional().describe("Limit all aggregate searches to this workspace-relative path."),
        search_glob: z.string().optional().describe("Optional glob applied to all aggregate searches."),
        search_include_hidden: z.boolean().optional(),
        max_results_per_query: z.number().int().min(1).max(TOOL_LIMITS.durable_execution.max_results_per_query).optional(),
        read_files: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), max_bytes: z.number().int().min(1000).max(TOOL_LIMITS.common.file_input_max_bytes).optional() })).max(TOOL_LIMITS.durable_execution.max_read_files).optional(),
        patches: z.array(z.object({ operation_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(), operation: z.enum(["write", "replace"]), path: z.string(), content: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), create_dirs: z.boolean().optional(), overwrite: z.boolean().optional(), replace_all: z.boolean().optional(), expected_replacements: z.number().int().min(1).optional() })).max(TOOL_LIMITS.durable_execution.max_patches).optional(),
        commands: z.array(z.string()).max(TOOL_LIMITS.durable_execution.max_commands).optional(),
        run_id: z.string().optional(),
        output_mode: z.enum(["compact", "full"]).optional().describe("Response verbosity only; does not imply durable report persistence."),
        persistence_mode: z.enum(["none", "summary", "full"]).optional().describe("Durable report policy independent of response verbosity."),
        tail_lines: z.number().int().min(20).max(400).optional(),
        save_full_logs: z.boolean().optional().describe("Legacy compatibility override; prefer persistence_mode."),
        skill_receipt: z.string().optional().describe("Receipt returned by a successful read_skill call. Omit for tasks that do not use a Skill."),
        skill_plan: SKILL_PLAN_INPUT_SCHEMA.optional().describe("Required for neat-freak tasks that write files or run commands. Lists every planned file with reason and evidence."),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this asynchronous task."),
        mode: z.enum(["analyze", "implement", "validate"]).optional().describe("Strongly recommended aggregate operation mode. When omitted it is derived from patches/commands; analyze and validate can never contain source patches."),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.common.max_files_per_task).optional(),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.common.max_lines_per_file).optional(),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.common.max_total_chars).optional()
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const operationMode = aggregateOperationMode(args, "start_run_task");
      const kind = args.kind ?? "task";
      if (args.patches?.length) assertNotProjectPoolRoot(config, workspace, "start_run_task patches");
      assertTaskRouteToolAllowed(kind === "stage" ? "run_stage" : "run_task", args, {
        patchesRequested: Boolean(args.patches?.length),
        commandsRequested: Boolean(args.commands?.length)
      });
      const { skill_receipt: skillReceipt, ...taskArgs } = args;
      const activeSkill = skillReceipt ? await resolveSkillUsageReceipt(config, skillReceipt) : undefined;
      const state = await startAsyncCompactTask(config, guard, workspace, kind, { ...taskArgs, active_skill: activeSkill });
      const taskService = new TaskProjectionService(config, guard, workspace);
      const identity = await taskService.ensureDurableJob({
        run_id: state.run_id,
        title: state.title,
        workspace_root: workspace.root,
        created_at: state.created_at,
        updated_at: state.finished_at ?? state.started_at ?? state.created_at
      });
      const text = [
        `Asynchronous ${kind} accepted.`,
        `task_id=${identity.task_id}`,
        `run_id=${state.run_id}`,
        `status=${state.status}`,
        "Use task_status for the unified view, or run_task_status for the durable-job detail."
      ].join("\n");
      return textResult(text, { root: workspace.root, task_id: identity.task_id, identity, operation_mode: operationMode, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "publish_task_report",
    {
      title: "Publish Task Report",
      description: "Append one bounded ChatGPT-authored public progress update, summary, finding, or warning to an existing task in the active workspace. This is an idempotent explanatory report write only: it cannot change task, validation, Git, or completion state.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active workspace."),
        task_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/).describe("Existing authoritative task id in this workspace."),
        idempotency_key: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).describe("Stable key reused when retrying the same report write."),
        event_kind: z.enum(["assistant_progress", "assistant_summary", "finding", "warning"]).optional().describe("ChatGPT public update kind. Default: assistant_summary."),
        severity: z.enum(["info", "success", "warning", "error", "action_required"]).optional().describe("Presentation severity. Default: success for assistant_summary, warning otherwise."),
        title: z.string().trim().min(1).max(200).optional().describe("Short report title. Default: ChatGPT 最终总结."),
        summary: z.string().trim().min(1).max(1000).describe("Boss-readable final answer or finding summary."),
        detail_markdown: z.string().max(20000).optional().describe("Optional bounded detail. The Office page renders it as inert text."),
        evidence_paths: z.array(z.string().min(1).max(4096)).max(20).optional().describe("Existing workspace-relative evidence files only.")
      },
      annotations: REPORT_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Publishing the task report...",
        "openai/toolInvocation/invoked": "Task report published"
      }
    },
    async (args) => {
      const assistantUpdatesEnabled = !["0", "false", "no", "off", "none"].includes(String(process.env.CODEXPRO_OFFICE_ASSISTANT_UPDATES ?? "1").trim().toLowerCase());
      if (!assistantUpdatesEnabled) throw new Error("ChatGPT public Office updates are disabled by CODEXPRO_OFFICE_ASSISTANT_UPDATES.");
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "publish_task_report");
      const eventKind = args.event_kind ?? "assistant_summary";
      const result = await publishTaskReport(config, guard, workspace, {
        taskId: args.task_id,
        idempotencyKey: args.idempotency_key,
        eventKind,
        severity: args.severity ?? (eventKind === "assistant_summary" ? "success" : eventKind === "assistant_progress" ? "info" : eventKind === "finding" ? "info" : "warning"),
        title: args.title ?? (eventKind === "assistant_summary" ? "ChatGPT 最终总结" : eventKind === "assistant_progress" ? "ChatGPT 进度说明" : eventKind === "finding" ? "ChatGPT 重要发现" : "ChatGPT 风险提示"),
        summary: args.summary,
        detailMarkdown: args.detail_markdown ?? null,
        evidencePaths: args.evidence_paths ?? []
      });
      const text = [
        result.appended ? "Task report appended." : "Task report already existed; no duplicate was written.",
        `task_id=${args.task_id}`,
        `sequence=${result.event.sequence}`,
        `event_kind=${result.event.event_kind}`,
        `redaction_applied=${result.redaction_applied}`,
        "authoritative_task_state_changed=false"
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        task_id: args.task_id,
        ...result
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_task_status",
    {
      title: "Run Task Status",
      description: "Read the current state of a durable asynchronous run started by start_run_task or automatically returned by a long bash/run_validation command.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).describe("Run id returned by start_run_task, bash, or run_validation.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await getAsyncCompactTaskStatus(guard, workspace, args.run_id);
      const text = [
        `run_id=${state.run_id}`,
        `status=${state.status}`,
        `phase=${state.progress.phase}`,
        `step=${state.progress.current_step}/${state.progress.total_steps ?? "unknown"}`,
        `action=${state.progress.current_action}`,
        `execution_state=${state.progress.execution_state}`,
        `heartbeat_at=${state.progress.heartbeat_at}`,
        `retries=${state.progress.retries}`,
        `writer_active=${state.progress.writer_active}`,
        `browser_active=${state.progress.browser_active}`,
        state.progress.wait_reason ? `wait_reason=${state.progress.wait_reason}` : "",
        state.progress.last_evidence ? `last_evidence=${state.progress.last_evidence}` : "",
        state.duration_ms !== undefined ? `duration_ms=${state.duration_ms}` : "",
        state.report_path ? `report=${state.report_path}` : "",
        state.recovery_reason ? `recovery_reason=${state.recovery_reason}` : "",
        state.error ? `error=${state.error}` : ""
      ].filter(Boolean).join("\n");
      return textResult(text, { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "current_task",
    {
      title: "Current Task",
      description: "Read the highest-priority current task across Goal, Durable Job, and Handoff using the unified live projection. Running and waiting work takes precedence over recent terminal history.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Finding current task...",
        "openai/toolInvocation/invoked": "Current task ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const current = await new TaskProjectionService(config, guard, workspace).getCurrent();
      if (!current) return textResult("No unified task is currently known for this workspace.", { root: workspace.root, current: null });
      return textResult([
        `task_id=${current.identity.task_id}`,
        `title=${current.identity.title}`,
        `kind=${current.identity.kind}`,
        `status=${current.status}`,
        `domain_status=${current.domain_status}`,
        `phase=${current.progress.phase}`,
        `action=${current.progress.current_action}`,
        `liveness=${current.liveness.state}`,
        `heartbeat_at=${current.progress.heartbeat_at}`,
        `acceptance_status=${current.acceptance.status}`,
        current.progress.wait_reason ? `wait_reason=${current.progress.wait_reason}` : "",
        `updated_at=${current.updated_at}`
      ].filter(Boolean).join("\n"), { root: workspace.root, current });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_get",
    {
      title: "Get Task Identity",
      description: "Read the thin unified Task Identity that links a task id to its authoritative Goal, Durable Job, or current Handoff domain object. This does not copy domain state.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128).describe("Unified task id returned by Goal, asynchronous task, or Handoff status.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading task identity...",
        "openai/toolInvocation/invoked": "Task identity ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const identity = await new TaskProjectionService(config, guard, workspace).getIdentity(args.task_id);
      return textResult([
        `task_id=${identity.task_id}`,
        `kind=${identity.kind}`,
        `domain_id=${identity.domain_id}`,
        `title=${identity.title}`,
        `project_root=${identity.project_root}`,
        `created_at=${identity.created_at}`,
        `updated_at=${identity.updated_at}`
      ].join("\n"), { root: workspace.root, identity });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_status",
    {
      title: "Task Status",
      description: "Read one unified, read-only task status projected live from the authoritative Goal, Durable Job, or current Handoff state.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128)
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Projecting unified task status...",
        "openai/toolInvocation/invoked": "Unified task status ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const projection = await new TaskProjectionService(config, guard, workspace).getStatus(args.task_id);
      const progress = projection.progress;
      return textResult([
        `task_id=${projection.identity.task_id}`,
        `kind=${projection.identity.kind}`,
        `status=${projection.status}`,
        `domain_status=${projection.domain_status}`,
        `phase=${progress.phase}`,
        `step=${progress.current_step}/${progress.total_steps ?? "unknown"}`,
        `action=${progress.current_action}`,
        `execution_state=${progress.execution_state}`,
        `liveness=${projection.liveness.state}`,
        `execution_id=${projection.liveness.execution_id ?? "unknown"}`,
        `owner_pid=${projection.liveness.owner_pid ?? "unknown"}`,
        `supervisor_pid=${projection.liveness.supervisor_pid ?? "unknown"}`,
        `watcher_pid=${projection.liveness.watcher_pid ?? "unknown"}`,
        `owner_alive=${projection.liveness.owner_alive ?? "unknown"}`,
        `lease_active=${projection.liveness.lease_active ?? "unknown"}`,
        `heartbeat_fresh=${projection.liveness.heartbeat_fresh ?? "unknown"}`,
        `heartbeat_age_ms=${projection.liveness.heartbeat_age_ms ?? "unknown"}`,
        `liveness_reason=${projection.liveness.reason}`,
        `acceptance_required=${projection.acceptance.required}`,
        `acceptance_status=${projection.acceptance.status}`,
        `acceptance_profile=${projection.acceptance.profile}`,
        `acceptance_reason=${projection.acceptance.reason}`,
        `heartbeat_at=${progress.heartbeat_at}`,
        `writer_active=${progress.writer_active}`,
        `browser_active=${progress.browser_active}`,
        progress.wait_reason ? `wait_reason=${progress.wait_reason}` : "",
        progress.last_evidence ? `last_evidence=${progress.last_evidence}` : ""
      ].filter(Boolean).join("\n"), { root: workspace.root, ...projection });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_recovery",
    {
      title: "Task Recovery Plan",
      description: "Read a unified, side-effect-aware recovery plan before resuming a Goal, Durable Job, or Handoff. This tool is read-only and never replays work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128)
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Analyzing task recovery safety...",
        "openai/toolInvocation/invoked": "Task recovery plan ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const recovery = await new TaskProjectionService(config, guard, workspace).getRecovery(args.task_id);
      const text = [
        `task_id=${recovery.task_id}`,
        `kind=${recovery.kind}`,
        `status=${recovery.status}`,
        `mode=${recovery.mode}`,
        `resumable=${recovery.resumable}`,
        `automatic=${recovery.automatic}`,
        `action=${recovery.action}`,
        `current_step_id=${recovery.current_step_id ?? "unknown"}`,
        `last_completed_step_id=${recovery.last_completed_step_id ?? "unknown"}`,
        `next_step_id=${recovery.next_step_id ?? "unknown"}`,
        `idempotent=${recovery.idempotent ?? "unknown"}`,
        `retryable=${recovery.retryable ?? "unknown"}`,
        `side_effect_level=${recovery.side_effect_level}`,
        `retry_policy=${recovery.retry_policy}`,
        recovery.rollback_method ? `rollback_method=${recovery.rollback_method}` : "",
        `reason=${recovery.reason}`,
        ...recovery.required_checks.map((check, index) => `check_${index + 1}=${check}`)
      ].filter(Boolean).join("\n");
      return textResult(text, { root: workspace.root, recovery });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_timeline",
    {
      title: "Task Timeline",
      description: "Read a normalized, read-only timeline from the authoritative Goal events, Durable Job steps, or current Handoff state.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128)
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading unified task timeline...",
        "openai/toolInvocation/invoked": "Unified task timeline ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const events = await new TaskProjectionService(config, guard, workspace).getTimeline(args.task_id);
      const rows = events.length
        ? events.map((event) => `- ${event.sequence} ${event.timestamp} ${event.type} status=${event.status}`).join("\n")
        : "- No task events.";
      return textResult(`# Task Timeline\n\nTask: ${args.task_id}\nCount: ${events.length}\n\n${rows}`, {
        root: workspace.root,
        task_id: args.task_id,
        events,
        event_count: events.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_evidence",
    {
      title: "Task Evidence",
      description: "Read the normalized validation, review, report, browser, and other artifact paths associated with a unified task.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128)
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting task evidence...",
        "openai/toolInvocation/invoked": "Task evidence ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const evidence = await new TaskProjectionService(config, guard, workspace).getEvidence(args.task_id);
      const rows = evidence.artifact_paths.length
        ? evidence.artifact_paths.map((artifact, index) => `artifact_${index + 1}=${artifact}`)
        : ["artifact_count=0"];
      return textResult([
        `task_id=${evidence.task_id}`,
        `kind=${evidence.kind}`,
        `status=${evidence.status}`,
        `acceptance_status=${evidence.acceptance.status}`,
        `acceptance_profile=${evidence.acceptance.profile}`,
        `acceptance_reason=${evidence.acceptance.reason}`,
        `last_evidence=${evidence.last_evidence ?? "none"}`,
        ...rows
      ].join("\n"), { root: workspace.root, evidence });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_resume",
    {
      title: "Resume Task",
      description: "Resume a unified Goal or Durable Job only after evaluating its persisted recovery plan. Automatic recovery executes only declared-safe checkpoints. Manual recovery requires confirm_manual=true. Handoff and external reconciliation are never replayed here.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128),
        prompt: z.string().max(200000).optional().describe("Required for a manual Goal continuation. Automatic validation recovery uses a fixed checkpoint prompt."),
        idempotency_key: z.string().min(1).max(1000).optional(),
        confirm_manual: z.boolean().optional().describe("Must be true when task_recovery returns mode=manual.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Resuming unified task...",
        "openai/toolInvocation/invoked": "Unified task resume requested"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const service = new TaskProjectionService(config, guard, workspace);
      const identity = await service.getIdentity(args.task_id);
      const recovery = await service.getRecovery(args.task_id);
      if (!recovery.resumable || recovery.mode === "none" || recovery.mode === "blocked") {
        throw new CodexProError(`Task ${args.task_id} is not safely resumable: ${recovery.reason}`);
      }
      if (!recovery.automatic && args.confirm_manual !== true) {
        throw new CodexProError(`Task ${args.task_id} requires manual recovery confirmation. Read task_recovery, then call task_resume with confirm_manual=true.`);
      }
      if (identity.kind === "handoff") {
        throw new CodexProError("Handoff execution is intentionally not replayed by task_resume. Inspect task_evidence and issue a new handoff_to_agent request with a new run id.");
      }
      if (recovery.action === "external_reconciliation" || recovery.action === "validate_only" || recovery.action === "reissue_handoff" || recovery.action === "none") {
        throw new CodexProError(`Task ${args.task_id} requires ${recovery.action}; task_resume will not execute that side effect.`);
      }
      let domainResult: Record<string, unknown>;
      if (identity.kind === "goal") {
        if (!codexAdapter) throw new CodexProError("Goal recovery is unavailable because no Codex provider adapter is configured.");
        if (recovery.action !== "goal_resume") throw new CodexProError(`Unexpected Goal recovery action: ${recovery.action}`);
        const prompt = recovery.automatic
          ? "Resume the persisted validation or review checkpoint without replaying the implementation turn."
          : String(args.prompt ?? "").trim();
        if (!prompt) throw new CodexProError("Manual Goal recovery requires a non-empty prompt.");
        const goal = await getGoalManager(config, guard, workspace, codexAdapter).resume({
          goal_id: identity.domain_id,
          prompt,
          idempotency_key: args.idempotency_key
        });
        domainResult = { goal };
      } else {
        if (recovery.action === "resume_run_task") {
          domainResult = await resumeAsyncCompactTask(config, guard, workspace, identity.domain_id) as unknown as Record<string, unknown>;
        } else if (recovery.action === "retry_run_task_step" && recovery.current_step_id) {
          domainResult = await retryAsyncCompactTaskStep(config, guard, workspace, identity.domain_id, recovery.current_step_id) as unknown as Record<string, unknown>;
        } else {
          throw new CodexProError(`Unexpected Durable Job recovery action: ${recovery.action}`);
        }
      }
      const projection = await service.getStatus(args.task_id);
      return textResult([
        `task_id=${args.task_id}`,
        `kind=${identity.kind}`,
        `status=${projection.status}`,
        `domain_status=${projection.domain_status}`,
        `phase=${projection.progress.phase}`,
        `action=${projection.progress.current_action}`,
        `liveness=${projection.liveness.state}`,
        `recovery_action=${recovery.action}`
      ].join("\n"), { root: workspace.root, recovery, projection, domain_result: domainResult });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_cancel",
    {
      title: "Cancel Task",
      description: "Cancel a unified Goal or Durable Job through its authoritative domain manager. Handoff cancellation is rejected until a domain cancellation protocol exists; this tool never kills a recorded PID directly.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        task_id: z.string().min(1).max(128)
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Cancelling unified task...",
        "openai/toolInvocation/invoked": "Unified task cancellation requested"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const service = new TaskProjectionService(config, guard, workspace);
      const identity = await service.getIdentity(args.task_id);
      let domainResult: Record<string, unknown>;
      if (identity.kind === "goal") {
        if (!codexAdapter) throw new CodexProError("Goal cancellation is unavailable because no Codex provider adapter is configured.");
        const goal = await getGoalManager(config, guard, workspace, codexAdapter).cancel(identity.domain_id);
        domainResult = { goal };
      } else if (identity.kind === "durable_job") {
        domainResult = await cancelAsyncCompactTask(config, guard, workspace, identity.domain_id) as unknown as Record<string, unknown>;
      } else {
        throw new CodexProError("Handoff cancellation has no safe domain protocol yet. task_cancel will not kill the recorded agent, supervisor, or Watcher PID directly.");
      }
      const projection = await service.getStatus(args.task_id);
      return textResult([
        `task_id=${args.task_id}`,
        `kind=${identity.kind}`,
        `status=${projection.status}`,
        `domain_status=${projection.domain_status}`,
        `liveness=${projection.liveness.state}`
      ].join("\n"), { root: workspace.root, projection, domain_result: domainResult });
    }
  );

  registerCodexTool(
    config,
    server,
    "resume_run_task",
    {
      title: "Resume Run Task",
      description: "Resume a durable asynchronous run from its persisted checkpoint. Completed steps are reused; an interrupted non-idempotent write step remains recovery_required and is not replayed automatically.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).describe("Durable run id returned by start_run_task.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await resumeAsyncCompactTask(config, guard, workspace, args.run_id);
      return textResult([
        `run_id=${state.run_id}`,
        `status=${state.status}`,
        `phase=${state.progress.phase}`,
        `step=${state.progress.current_step}/${state.progress.total_steps ?? "unknown"}`,
        state.recovery_reason ? `recovery_reason=${state.recovery_reason}` : ""
      ].filter(Boolean).join("\n"), { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "cancel_run_task",
    {
      title: "Cancel Run Task",
      description: "Request cancellation of a durable asynchronous run. The current bounded operation stops at its cancellation boundary and the persisted status exposes the wait reason.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).describe("Durable run id returned by start_run_task.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await cancelAsyncCompactTask(config, guard, workspace, args.run_id);
      return textResult([
        `run_id=${state.run_id}`,
        `status=${state.status}`,
        `cancel_requested=${state.cancel_requested}`,
        state.progress.wait_reason ? `wait_reason=${state.progress.wait_reason}` : ""
      ].filter(Boolean).join("\n"), { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "retry_run_task_step",
    {
      title: "Retry Run Task Step",
      description: "Retry one persisted, retryable and idempotent durable step. Non-idempotent uncertain writes require external reconciliation and cannot be retried through this tool.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).describe("Durable run id returned by start_run_task."),
        step_id: z.string().min(1).describe("Persisted step id from run_task_status.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const state = await retryAsyncCompactTaskStep(config, guard, workspace, args.run_id, args.step_id);
      return textResult([
        `run_id=${state.run_id}`,
        `status=${state.status}`,
        `retry_step=${args.step_id}`,
        `phase=${state.progress.phase}`,
        `retries=${state.progress.retries}`
      ].join("\n"), { root: workspace.root, ...state });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_run_task_result",
    {
      title: "Read Run Task Result",
      description: "Read the saved result for a terminal durable run, including completed, failed, blocked, or cancelled long bash/run_validation commands. Does not duplicate the report in structured content.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        run_id: z.string().min(1).describe("Run id returned by start_run_task, bash, or run_validation."),
        max_chars: z.number().int().min(1000).max(60000).optional().describe("Maximum report characters to return. Default and maximum: 60000.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await readAsyncCompactTaskResult(guard, workspace, args.run_id, args.max_chars);
      const text = result.text ?? [
        `run_id=${result.state.run_id}`,
        `status=${result.state.status}`,
        result.state.error ? `error=${result.state.error}` : "Result is not ready. Use run_task_status before reading the result."
      ].filter(Boolean).join("\n");
      return textResult(text, { root: workspace.root, ...result.state });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_task_template",
    {
      title: "Run Task Template",
      description: "Run a named task template from .codexpro/tasks.yml or built-ins such as bugfix, feature, ui-fix, backend-debug, docker-debug, and release-check.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        template: z.string().optional().describe("Task template name. Built-ins include bugfix, feature, ui-fix, backend-debug, docker-debug, and release-check."),
        task: z.string().optional().describe("Short user task or issue summary for the template run."),
        title: z.string().optional(),
        goal: z.string().optional(),
        search_queries: z.array(z.string()).max(TOOL_LIMITS.task_template.max_search_queries).optional().describe(`At most ${TOOL_LIMITS.task_template.max_search_queries} focused queries; use start_run_task for broader discovery.`),
        read_files: z.array(z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional(), max_bytes: z.number().int().min(1000).max(TOOL_LIMITS.common.file_input_max_bytes).optional() })).max(TOOL_LIMITS.task_template.max_read_files).optional(),
        patches: z.array(z.object({ operation_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(), operation: z.enum(["write", "replace"]), path: z.string(), content: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), create_dirs: z.boolean().optional(), overwrite: z.boolean().optional(), replace_all: z.boolean().optional(), expected_replacements: z.number().int().min(1).optional() })).max(TOOL_LIMITS.task_template.max_patches).optional(),
        commands: z.array(z.string()).max(TOOL_LIMITS.task_template.max_commands).optional(),
        acceptance_profile: z.string().optional(),
        dry_run: z.boolean().optional(),
        run_id: z.string().optional(),
        output_mode: z.enum(["compact", "full"]).optional(),
        tail_lines: z.number().int().min(20).max(400).optional(),
        save_full_logs: z.boolean().optional(),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this task template."),
        max_files_per_task: z.number().int().min(1).max(TOOL_LIMITS.common.max_files_per_task).optional().describe("Override context.max_files_per_task for this template run."),
        max_lines_per_file: z.number().int().min(20).max(TOOL_LIMITS.common.max_lines_per_file).optional().describe("Override context.max_lines_per_file for this template run."),
        max_total_chars: z.number().int().min(10000).max(TOOL_LIMITS.common.max_total_chars).optional().describe("Override context.max_total_chars for this template run.")
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const templateName = typeof args.template === "string" ? args.template : "";
      const templateRunsCommands = ["release-check", "ui-fix"].includes(templateName) || Boolean(args.commands?.length);
      assertTaskRouteToolAllowed("run_task_template", args, { patchesRequested: Boolean(args.patches?.length), commandsRequested: templateRunsCommands });
      const result = await runTaskTemplate(config, guard, workspace, args);
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result.data });
    }
  );

  registerCodexTool(
    config,
    server,
    "secret_scan",
    {
      title: "Secret Scan",
      description: "Scan the workspace for leaked secrets. Sensitive files such as .env, .pem, .key, and id_rsa are reported by path only and their contents are not read.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Workspace-relative file or directory to scan. Default: ."),
        max_files: z.number().int().min(1).max(50000).optional().describe("Maximum text files to scan. Default: 4000."),
        max_file_bytes: z.number().int().min(1000).max(5000000).optional().describe("Maximum bytes per text file to read. Default: 256000."),
        large_file_bytes: z.number().int().min(10000).max(200000000).optional().describe("Large-file warning threshold in bytes. Default: 1000000."),
        include_generated: z.boolean().optional().describe("Also scan generated/cache folders such as dist and coverage. Default: false."),
        fail_on_warnings: z.boolean().optional().describe("Mark warnings as not ok. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Scanning for secrets...",
        "openai/toolInvocation/invoked": "Secret scan complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await runSecretScan(config, guard, workspace, args);
      return textResult(result.text, { workspace_id: workspace.id, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "security_audit",
    {
      title: "Security Audit",
      description: "Scan for leaked secrets, dangerous shell commands, Docker volume risks, SQL write-operation patterns, debug markers, and large-file risks. Values are never printed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Workspace-relative file or directory to audit. Default: ."),
        max_files: z.number().int().min(1).max(50000).optional().describe("Maximum text files to scan. Default: 4000."),
        max_file_bytes: z.number().int().min(1000).max(5000000).optional().describe("Maximum bytes per text file to read. Default: 256000."),
        large_file_bytes: z.number().int().min(10000).max(200000000).optional().describe("Large-file warning threshold in bytes. Default: 1000000."),
        include_generated: z.boolean().optional().describe("Also scan generated/cache folders such as dist and coverage. Default: false."),
        fail_on_warnings: z.boolean().optional().describe("Mark warnings as not ok. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running security audit...",
        "openai/toolInvocation/invoked": "Security audit complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await runSecurityAudit(config, guard, workspace, args);
      return textResult(result.text, { workspace_id: workspace.id, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "release_safety_check",
    {
      title: "Release Safety Check",
      description: "Run a release decision gate in targeted, incremental, full, or baseline_proposal mode. Incomplete scans, invalid or expired baselines, stale confirmations, and new high-risk findings block release. Reports include reason codes and remediation actions without printing matched values.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        mode: z.enum(["targeted", "incremental", "full", "baseline_proposal"]).optional().describe("Release check mode. Default: targeted."),
        path: z.string().optional().describe("Workspace-relative file or directory for targeted or baseline_proposal mode. Default: ."),
        base_ref: z.string().optional().describe("Explicit Git base reference for incremental mode. Default: current upstream."),
        upstream_ref: z.string().optional().describe("Git upstream reference for incremental mode when base_ref is omitted."),
        candidate_paths: z.array(z.string().min(1)).max(500).optional().describe("Exact changed paths to evaluate in incremental mode and bind into the release receipt. Default: all current Git changes."),
        write_receipt: z.boolean().optional().describe("Write a content-bound release safety receipt for an allowed incremental/full result. Default: true."),
        policy_path: z.string().optional().describe("Workspace-relative security policy file. Default: .codexpro/security-policy.json when present."),
        baseline_path: z.string().optional().describe("Workspace-relative approved baseline file. Defaults to the policy setting."),
        max_files: z.number().int().min(1).max(50000).optional().describe("Maximum text files to scan. Default: 4000."),
        max_file_bytes: z.number().int().min(1000).max(200000000).optional().describe("Maximum bytes per text file for targeted/full scans. Default: 256000."),
        max_changed_file_bytes: z.number().int().min(1000).max(200000000).optional().describe("Maximum bytes per changed file in incremental mode. Default: 25000000."),
        large_file_bytes: z.number().int().min(10000).max(200000000).optional().describe("Large-file warning threshold in bytes. Default: 1000000."),
        include_generated: z.boolean().optional().describe("Also scan generated/cache folders such as dist and coverage. Default: false."),
        fail_on_warnings: z.boolean().optional().describe("Block release on unconfirmed warnings as well as high-risk findings. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running release safety check...",
        "openai/toolInvocation/invoked": "Release safety check complete"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await runReleaseSafetyCheck(config, guard, workspace, args);
      return textResult(result.text, { workspace_id: workspace.id, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command. In execution_mode=auto, long build, test, smoke, lint, typecheck, and validation commands return immediately with a durable run id and continue locally. Use run_task_status and read_run_task_result instead of repeating the command after a transport error. Short commands still return synchronously. Do not use bash for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000."),
        run_id: z.string().optional().describe("Optional durable run id for an asynchronously dispatched long command."),
        execution_mode: z.enum(["auto", "sync", "async"]).optional().describe("Default: auto. Long validation commands run durably; sync forces direct waiting; async always returns a run id."),
        task_instruction: z.string().optional().describe("Optional original user task for Task Router mode control."),
        task_mode: z.enum(TASK_MODES).optional().describe("Optional Task Router mode override for this command.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Starting bash command...",
        "openai/toolInvocation/invoked": "Bash command accepted or finished"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertTaskRouteToolAllowed("bash", args, { commandsRequested: true });
      const command = String(args.command ?? "");
      const executionMode = (args.execution_mode ?? "auto") as CommandExecutionMode;
      if (shouldStartAsyncValidation([command], executionMode, args.timeout_ms)) {
        const inherited = await inheritedValidationIdentity(workspace);
        const state = await startAsyncCompactTask(config, guard, workspace, "task", {
          title: durableValidationTitle(inherited?.title, command),
          goal: inherited
            ? `Run validation for ${inherited.title} and persist its result without keeping one Connector response open.`
            : "Run one long verification command and persist its result without keeping one Connector response open.",
          ...(inherited ? { task_identity: inherited.task_identity } : {}),
          commands: [command],
          cwd: args.cwd,
          timeout_ms: args.timeout_ms,
          session_id: args.session_id,
          run_id: args.run_id
        });
        return await durableValidationAccepted(workspace, state, "bash", executionMode);
      }
      const result = await runBash(config, guard, workspace, command, {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      const text = bashTextResult(config, result);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        dispatch_mode: "synchronous",
        execution_mode: executionMode,
        ...result,
        bash_session_id: result.bashSessionId ?? null
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "git_status");
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace status",
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "git_diff");
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "task_complete",
    {
      title: "Task Complete",
      description: "Send one local Windows notification after the entire workspace task has passed focused verification. In an active Gold Task session this first enforces the mandatory file scope, fresh validation, Git, and control-repository completion check and supplies the supervisor completion signal; outside Gold Tasks it remains optional.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().min(1).max(160).describe("Exact human-readable task or stage name, for example Stage 9A 商品经营决策基础审计."),
        summary: z.string().max(500).optional().describe("Brief completion result shown in the Windows notification."),
        next_step: z.string().max(300).optional().describe("Optional next action shown in the notification."),
        idempotency_key: z.string().max(200).optional().describe("Stable task-specific key used to suppress duplicate notifications for 24 hours.")
      },
      annotations: NOTIFICATION_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Sending task completion notification...",
        "openai/toolInvocation/invoked": "Task completion notification handled"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "task_complete");
      const completionCheck = enforceGoldTaskCompletionGate(workspace.root);
      const delivery = dispatchTaskCompletionNotification({
        root: workspace.root,
        title: args.title,
        summary: args.summary,
        nextStep: args.next_step,
        idempotencyKey: args.idempotency_key
      });
      const message = delivery.queued
        ? `Windows completion notification queued for ${delivery.title}.`
        : delivery.duplicate
          ? `Duplicate completion notification suppressed for ${delivery.title}.`
          : `Windows completion notification was not queued: ${delivery.reason}.`;
      return textResult(message, {
        workspace_id: workspace.id,
        root: workspace.root,
        completion_check: completionCheck,
        ...delivery
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      assertNotProjectPoolRoot(config, workspace, "show_changes");
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, scopedPath, parseBool(args.staged, false)));
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const responseDiff = includeDiff ? diff : "";
      const selectedDiffStats = diffStats(diff);
      const changeSummary = gitChangeSummary(config, guard, workspace, scopedPath);
      const stats = statusError
        ? { additions: 0, deletions: 0, changed: false }
        : { additions: changeSummary.additions, deletions: changeSummary.deletions, changed: changeSummary.changedFiles.length > 0 };
      const changedFiles = statusError ? [] : changeSummary.changedFiles;
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : changedFiles.length
          ? changedFiles.map((file) => `- ${file}`).join("\n")
          : "- No changed files.";
      const diffText = includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
          : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${stats.additions} -${stats.deletions}${diffText}`;
      searchLoopBreaker.recordProgress(workspace.root);
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: changedFiles,
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !statusError && (changedFiles.length > 0 || stats.changed),
        tracked_modified_files: changeSummary.trackedModifiedFiles,
        staged_files: changeSummary.stagedFiles,
        untracked_files: changeSummary.untrackedFiles,
        deleted_files: changeSummary.deletedFiles,
        ignored_files: changeSummary.ignoredFiles,
        binary_files: changeSummary.binaryFiles,
        selected_diff_additions: selectedDiffStats.additions,
        selected_diff_deletions: selectedDiffStats.deletions,
        diff: responseDiff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_status",
    {
      title: "Handoff Status",
      description:
        "Check the exact workspace handoff watcher heartbeat, current plan hash, and run acknowledgement before creating or claiming a local agent execution. Watcher outages are infrastructure failures and must not trigger an automatic fallback to CodexPro.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Checking local handoff readiness...",
        "openai/toolInvocation/invoked": "Local handoff readiness checked"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const status = await readHandoffStatus(config, guard, workspace);
      const taskId = new TaskProjectionService(config, guard, workspace).handoffTaskId(status);
      const lines = [
        "# Handoff Status",
        "",
        `Workspace: ${workspace.root}`,
        `Watcher: ${status.watcher_online ? "online" : "offline"} (${status.watcher_state})`,
        `Reason: ${status.watcher_reason}`,
        `Plan: ${status.current_plan_exists ? status.current_plan_path : "missing"}`,
        ...(status.current_plan_hash ? [`Plan hash: ${status.current_plan_hash}`] : []),
        `Execution acknowledged: ${status.execution_acknowledged ? "yes" : "no"}`,
        ...(taskId ? [`Task id: ${taskId}`] : []),
        "",
        status.recovery_action,
        "",
        "Policy: do not report that Codex started until the matching plan hash is acknowledged as running or terminal. Do not fall back to CodexPro for watcher, path, heartbeat, or service failures."
      ];
      return textResult(lines.join("\n"), { ...status, ...(taskId ? { task_id: taskId } : {}) });
    }
  );

  registerCodexTool(
    config,
    server,
    "wait_for_handoff",
    {
      title: "Wait For Handoff",
      description:
        "Read-only long-poll of the local handoff run state so ChatGPT can stay the planner/reviewer while a local executor runs. Reads .ai-bridge/handoff-run-state.json and returns the run status plus status/diff/log/test excerpts. It never starts processes or runs shell commands; it only observes local handoff state written by execute-handoff/watch-handoff/loop-handoff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        plan_hash: z.string().optional().describe("Expected current-plan.md hash. If set, only a terminal run with this plan_hash counts as completed."),
        since_iteration: z.number().int().min(0).optional().describe("Only treat a run with iteration greater than this as the awaited completion."),
        max_wait_seconds: z.number().int().min(1).max(60).optional().describe("Maximum seconds to long-poll before returning the current state. Default: 20."),
        poll_ms: z.number().int().min(250).max(5000).optional().describe("Poll interval in milliseconds. Default: 1000."),
        include_diff: z.boolean().optional().describe("Include the implementation diff excerpt when completed. Default: true."),
        include_log_excerpt: z.boolean().optional().describe("Include the tail of execution-log.jsonl when completed. Default: true."),
        include_tests: z.boolean().optional().describe("Include the loop-tests.txt excerpt when completed. Default: true.")
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Waiting for local handoff result...",
        "openai/toolInvocation/invoked": "Local handoff state ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const maxWaitSeconds = limitInt(args.max_wait_seconds, 20, 1, 60);
      const pollMs = limitInt(args.poll_ms, 1000, 250, 5000);
      const includeDiff = parseBool(args.include_diff, true);
      const includeLog = parseBool(args.include_log_excerpt, true);
      const includeTests = parseBool(args.include_tests, true);
      const expectedPlanHash =
        typeof args.plan_hash === "string" && args.plan_hash.trim() ? args.plan_hash.trim() : undefined;
      const sinceIteration =
        Number.isFinite(Number(args.since_iteration)) && args.since_iteration !== undefined
          ? Math.floor(Number(args.since_iteration))
          : undefined;

      const stateRel = `${config.contextDir}/handoff-run-state.json`;
      const contextPrefix = `${config.contextDir.replace(/\/+$/, "")}/`;
      const terminalStates = new Set(["completed", "failed", "timed_out", "cancelled"]);

      const readState = async (): Promise<Record<string, any> | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, stateRel);
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      };

      const isAwaited = (state: Record<string, any> | undefined): boolean =>
        Boolean(
          state &&
            terminalStates.has(state.state) &&
            (!expectedPlanHash || state.plan_hash === expectedPlanHash) &&
            (sinceIteration === undefined || (typeof state.iteration === "number" && state.iteration > sinceIteration))
        );

      const deadline = Date.now() + maxWaitSeconds * 1000;
      let state = await readState();
      while (Date.now() < deadline && !isAwaited(state)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        state = await readState();
      }

      const awaitedTerminal = isAwaited(state);
      const awaitedCompleted = awaitedTerminal && state?.state === "completed";
      const planHashMismatch = Boolean(expectedPlanHash && state && state.plan_hash !== expectedPlanHash);
      const reportedState = awaitedTerminal
        ? String(state?.state)
        : state
          ? state.state === "running" || planHashMismatch || sinceIteration !== undefined
            ? "running"
            : String(state.state)
          : "unknown";

      const excerpt = async (rel: string, maxChars: number, tailLines?: number): Promise<string | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, rel);
          const body = tailLines
            ? raw.split(/\r?\n/).filter(Boolean).slice(-tailLines).join("\n")
            : raw;
          const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n...[excerpt truncated]` : body;
          return redactSensitiveText(trimmed);
        } catch {
          return undefined;
        }
      };
      const bridgeArtifact = (value: unknown, fallback: string): string => {
        const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
        const normalized = path.posix.normalize(raw.split(path.sep).join("/")).replace(/^\.\//, "");
        return normalized.startsWith(contextPrefix) ? normalized : fallback;
      };

      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        state: reportedState,
        awaited_completed: awaitedCompleted,
        awaited_terminal: awaitedTerminal,
        succeeded: awaitedCompleted,
        state_file: stateRel,
        ...(state ? { run_state: state.state } : {}),
        ...(typeof state?.iteration === "number" ? { iteration: state.iteration } : {}),
        ...(state?.plan_hash ? { plan_hash: state.plan_hash } : {}),
        ...(expectedPlanHash ? { expected_plan_hash: expectedPlanHash, plan_hash_mismatch: planHashMismatch } : {}),
        ...(state && "exit_code" in state ? { exit_code: state.exit_code } : {}),
        ...(state && "timed_out" in state ? { timed_out: state.timed_out } : {}),
        ...(state?.started_at ? { started_at: state.started_at } : {}),
        ...(state?.finished_at ? { finished_at: state.finished_at } : {}),
        ...(typeof state?.duration_ms === "number" ? { duration_ms: state.duration_ms } : {}),
        ...(typeof state?.execution_timeout_ms === "number" ? { execution_timeout_ms: state.execution_timeout_ms } : {}),
        ...(state?.last_output_at ? { last_output_at: state.last_output_at } : {}),
        ...(state?.timeout_reason ? { timeout_reason: state.timeout_reason } : {}),
        ...(state?.termination_signal ? { termination_signal: state.termination_signal } : {}),
        ...(state?.recovery_from_run_id ? { recovery_from_run_id: state.recovery_from_run_id } : {}),
        ...(typeof state?.resume_count === "number" ? { resume_count: state.resume_count } : {}),
        ...(state?.executor ? { executor: state.executor } : {}),
        ...(state?.model ? { model: state.model } : {}),
        ...(awaitedTerminal ? {} : { next_poll_after_seconds: Math.max(1, Math.ceil(pollMs / 1000)) })
      };

      if (awaitedTerminal) {
        const statusFile = bridgeArtifact(state?.status_file, `${config.contextDir}/agent-status.md`);
        const diffFile = bridgeArtifact(state?.diff_file, `${config.contextDir}/implementation-diff.patch`);
        const logFile = bridgeArtifact(state?.log_file, `${config.contextDir}/execution-log.jsonl`);
        const testsFile = bridgeArtifact(state?.tests_file, `${config.contextDir}/loop-tests.txt`);
        structured.status_file = statusFile;
        structured.diff_file = diffFile;
        structured.log_file = logFile;
        const status = await excerpt(statusFile, 6_000);
        if (status) structured.status_excerpt = status;
        if (includeDiff) {
          const diff = await excerpt(diffFile, 12_000);
          if (diff) structured.diff_excerpt = diff;
        }
        if (includeLog) {
          const log = await excerpt(logFile, 6_000, 20);
          if (log) structured.log_excerpt = log;
        }
        if (includeTests) {
          const tests = await excerpt(testsFile, 4_000);
          if (tests) {
            structured.tests_file = testsFile;
            structured.tests_excerpt = tests;
          }
        }
      }

      const summary = !state
        ? `No handoff run state found at ${stateRel}. Start a run with handoff_to_agent + local execute-handoff/watch-handoff, then call wait_for_handoff again.`
        : awaitedTerminal
          ? `Handoff run ${state.state} (iteration ${state.iteration ?? 1}, exit ${state.exit_code ?? "null"}${state.timeout_reason ? `, reason ${state.timeout_reason}` : ""}).`
          : planHashMismatch
            ? `Executor has not completed the expected plan yet (last known run plan_hash=${state.plan_hash ?? "unknown"}). Still waiting.`
            : `Handoff run is ${state.state}. Re-poll after ~${Math.max(1, Math.ceil(pollMs / 1000))}s.`;

      const lines = [
        "# Wait For Handoff",
        "",
        summary,
        "",
        `State file: ${stateRel}`,
        ...(state?.plan_hash ? [`Plan hash: ${state.plan_hash}`] : []),
        ...(awaitedTerminal && structured.status_excerpt ? ["", "## Status", "", `\`\`\`text\n${structured.status_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.diff_excerpt ? ["", "## Diff", "", `\`\`\`diff\n${structured.diff_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.tests_excerpt ? ["", "## Tests", "", `\`\`\`text\n${structured.tests_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.log_excerpt ? ["", "## Log tail", "", `\`\`\`text\n${structured.log_excerpt}\n\`\`\``] : [])
      ];
      return textResult(lines.join("\n"), structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24. Capped by context.max_files_per_task."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle. Capped by context.max_total_chars."),
        max_files_per_task: z.number().int().min(1).max(80).optional().describe("Override context.max_files_per_task for this export."),
        max_lines_per_file: z.number().int().min(20).max(2000).optional().describe("Override context.max_lines_per_file for this export."),
        max_total_chars: z.number().int().min(10000).max(2000000).optional().describe("Override context.max_total_chars for this export.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await exportProContext(config, guard, workspace, {
        title: args.title,
        selectedPaths: args.selected_paths,
        extraGlobs: args.extra_globs,
        includeImportantFiles: args.include_important_files,
        includeChangedFiles: args.include_changed_files,
        includeDiff: args.include_diff,
        includeAiBridge: args.include_ai_bridge,
        maxDepth: args.max_depth,
        maxFiles: args.max_files,
        maxFileBytes: args.max_file_bytes,
        maxTotalBytes: args.max_total_bytes,
        maxFilesPerTask: args.max_files_per_task,
        maxLinesPerFile: args.max_lines_per_file,
        maxTotalChars: args.max_total_chars
      });
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexpro pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated,
        budget: {
          max_files_per_task: result.budget.maxFilesPerTask,
          max_lines_per_file: result.budget.maxLinesPerFile,
          max_total_chars: result.budget.maxTotalChars,
          source: result.budget.source
        },
        budget_exceeded: result.budgetExceeded
      });
    }
  );

  if (codexAdapter) {
    registerCodexTool(
      config,
      server,
      "codex_capabilities",
      {
        title: "Codex Capabilities",
        description: "Probe the explicitly configured Codex provider, CLI version, authentication status, and T1 exec/MCP availability without reading credential files or returning secret values. This may start bounded local Codex probe processes, but it does not start a model task or consume model quota.",
        inputSchema: {},
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Checking Codex capabilities...",
          "openai/toolInvocation/invoked": "Codex capabilities ready"
        }
      },
      async () => {
        const result = await codexAdapter.capabilities();
        const text = `# Codex Capabilities\n\n${JSON.stringify(result, null, 2)}`;
        return textResult(text, result as unknown as Record<string, unknown>);
      }
    );

    registerCodexTool(
      config,
      server,
      "codex_start_task",
      {
        title: "Start Codex Task",
        description: "Explicit model delegation: start one in-memory Codex provider run in the selected workspace. This may start a local Codex process and consume Codex/model quota; it is hidden when the adapter is off. Goal persistence and restart recovery are intentionally deferred to T2.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          prompt: z.string().min(1).max(200000).describe("Task instruction for Codex."),
          cwd: z.string().optional().describe("Workspace-relative working directory. Default: workspace root."),
          sandbox_mode: z.enum(["read-only", "workspace-write"]).optional().describe("Default: read-only. workspace-write requires CodexPro write_mode=workspace."),
          approval_policy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional().describe("Default: never."),
          model: z.string().optional().describe("Optional Codex model override. Prefer the user's Codex configuration."),
          reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
          network_access_enabled: z.boolean().optional().describe("Default: false."),
          skip_git_repo_check: z.boolean().optional().describe("Default: false.")
        },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Starting Codex task...",
          "openai/toolInvocation/invoked": "Codex task started"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const sandboxMode = args.sandbox_mode ?? "read-only";
        if (sandboxMode === "workspace-write" && config.writeMode !== "workspace") {
          throw new CodexProError("codex_start_task workspace-write requires CodexPro write_mode=workspace.");
        }
        const resolved = guard.resolve(workspace, args.cwd ?? ".", { forWrite: sandboxMode === "workspace-write" });
        const stat = await fsp.stat(resolved.absPath);
        if (!stat.isDirectory()) throw new CodexProError(`Codex cwd is not a directory: ${resolved.relPath}`);
        const run = await codexAdapter.startTask({
          prompt: args.prompt,
          working_directory: resolved.absPath,
          sandbox_mode: sandboxMode,
          approval_policy: args.approval_policy ?? "never",
          model: args.model,
          reasoning_effort: args.reasoning_effort,
          network_access_enabled: args.network_access_enabled ?? false,
          skip_git_repo_check: args.skip_git_repo_check ?? false
        });
        return textResult(codexRunText("Codex Task Started", run), { run });
      }
    );

    registerCodexTool(
      config,
      server,
      "codex_resume_task",
      {
        title: "Resume Codex Task",
        description: "Explicit model delegation: continue a completed T1 run in the same Codex thread. This starts provider execution and may consume Codex/model quota; it is hidden when the adapter is off. Runs are in memory until Goal Store is implemented in T2.",
        inputSchema: {
          run_id: z.string().min(1).describe("Run id returned by codex_start_task or a prior codex_resume_task."),
          prompt: z.string().min(1).max(200000).describe("Follow-up instruction for the same Codex thread.")
        },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Resuming Codex task...",
          "openai/toolInvocation/invoked": "Codex task resumed"
        }
      },
      async (args) => {
        const run = await codexAdapter.resumeTask({ run_id: args.run_id, prompt: args.prompt });
        return textResult(codexRunText("Codex Task Resumed", run), { run });
      }
    );

    registerCodexTool(
      config,
      server,
      "codex_cancel_task",
      {
        title: "Cancel Codex Task",
        description: "Request cancellation of an active T1 Codex run using the SDK AbortSignal boundary.",
        inputSchema: { run_id: z.string().min(1) },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Cancelling Codex task...",
          "openai/toolInvocation/invoked": "Codex cancellation requested"
        }
      },
      async (args) => {
        const run = await codexAdapter.cancelTask(args.run_id);
        return textResult(codexRunText("Codex Task Cancellation", run), { run });
      }
    );

    registerCodexTool(
      config,
      server,
      "codex_task_status",
      {
        title: "Codex Task Status",
        description: "Read the current in-memory status for a T1 Codex run.",
        inputSchema: { run_id: z.string().min(1) },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Reading Codex task status...",
          "openai/toolInvocation/invoked": "Codex task status ready"
        }
      },
      async (args) => {
        const run = await codexAdapter.getRun(args.run_id);
        return textResult(codexRunText("Codex Task Status", run), { run });
      }
    );

    registerCodexTool(
      config,
      server,
      "codex_task_events",
      {
        title: "Codex Task Events",
        description: "Read a bounded snapshot of normalized T1 events. This tool never exposes raw SDK event objects or credential data.",
        inputSchema: {
          run_id: z.string().min(1),
          after_sequence: z.number().int().min(0).optional().describe("Return events after this sequence number. Default: 0.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Reading Codex task events...",
          "openai/toolInvocation/invoked": "Codex task events ready"
        }
      },
      async (args) => {
        const events = await collectCodexEvents(codexAdapter, args.run_id, args.after_sequence ?? 0);
        const rows = events.length
          ? events.map((event) => `- ${event.sequence} ${event.type}${event.thread_id ? ` thread=${event.thread_id}` : ""}`).join("\n")
          : "- No new events.";
        return textResult(`# Codex Task Events\n\nRun: ${args.run_id}\nCount: ${events.length}\n\n${rows}`, {
          run_id: args.run_id,
          events,
          event_count: events.length
        });
      }
    );

    registerCodexTool(
      config,
      server,
      "goal_start",
      {
        title: "Start Goal",
        description: "Explicit model delegation: create or return one idempotent persistent Goal, capture a start snapshot, and start Codex through the Goal Store state machine. This may start a local Codex process and consume Codex/model quota; it is hidden when the adapter is off.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          objective: z.string().min(1).max(200000).describe("Persistent Goal objective."),
          constraints: z.array(z.string().max(4000)).max(100).optional(),
          acceptance: z.array(z.string().max(4000)).max(100).optional(),
          acceptance_contract: z.object({
            version: z.literal(1),
            source: z.enum(["user", "project", "inferred"]).optional(),
            items: z.array(z.object({
              id: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional(),
              category: z.enum(["functional", "visual", "regression", "security", "performance", "forbidden", "evidence"]).optional(),
              description: z.string().min(1).max(4000),
              blocking: z.boolean().optional(),
              verifier: z.enum(["command", "browser", "diff", "review", "manual", "state"]).optional(),
              verifier_config: z.record(z.unknown()).optional()
            })).max(100)
          }).optional().describe("Optional explicit structured acceptance contract. When supplied, it takes precedence over inferred verifier selection."),
          idempotency_key: z.string().min(1).max(1000).describe("Required stable key. Repeating the same request returns the existing Goal."),
          sandbox_mode: z.enum(["read-only", "workspace-write"]).optional().describe("Default: read-only. workspace-write requires CodexPro write_mode=workspace."),
          approval_policy: z.enum(["never", "on-request", "on-failure", "untrusted"]).optional().describe("Default: never."),
          model: z.string().optional(),
          reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
          network_access_enabled: z.boolean().optional().describe("Default: false."),
          skip_git_repo_check: z.boolean().optional().describe("Default: false.")
        },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Starting persistent Goal...",
          "openai/toolInvocation/invoked": "Persistent Goal started"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const sandboxMode = args.sandbox_mode ?? "read-only";
        if (sandboxMode === "workspace-write" && config.writeMode !== "workspace") {
          throw new CodexProError("goal_start workspace-write requires CodexPro write_mode=workspace.");
        }
        const manager = getGoalManager(config, guard, workspace, codexAdapter);
        const goal = await manager.start({
          objective: args.objective,
          constraints: args.constraints,
          acceptance: args.acceptance,
          acceptance_contract: args.acceptance_contract,
          idempotency_key: args.idempotency_key,
          sandbox_mode: sandboxMode,
          approval_policy: args.approval_policy ?? "never",
          model: args.model,
          reasoning_effort: args.reasoning_effort,
          network_access_enabled: args.network_access_enabled ?? false,
          skip_git_repo_check: args.skip_git_repo_check ?? false
        });
        const identity = await new TaskProjectionService(config, guard, workspace).ensureGoal(goal);
        return textResult(`${goalText("Goal Started", goal)}\n\ntask_id=${identity.task_id}`, { task_id: identity.task_id, identity, goal });
      }
    );

    registerCodexTool(
      config,
      server,
      "goal_status",
      {
        title: "Goal Status",
        description: "Read the persistent Goal fact, normalized event history, validation evidence, review evidence, and result artifact.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          goal_id: z.string().min(1)
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Reading Goal status...",
          "openai/toolInvocation/invoked": "Goal status ready"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const manager = getGoalManager(config, guard, workspace, codexAdapter);
        const inspection = await manager.status(args.goal_id);
        return textResult(goalText("Goal Status", inspection.goal), inspection as unknown as Record<string, unknown>);
      }
    );

    registerCodexTool(
      config,
      server,
      "goal_resume",
      {
        title: "Resume Goal",
        description: "Explicit model delegation: resume a waiting persistent Goal. Resuming its Codex thread may start a local Codex process and consume Codex/model quota; it never automatically replays uncertain writes.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          goal_id: z.string().min(1),
          prompt: z.string().min(1).max(200000),
          idempotency_key: z.string().min(1).max(1000).optional()
        },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Resuming persistent Goal...",
          "openai/toolInvocation/invoked": "Persistent Goal resumed"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const manager = getGoalManager(config, guard, workspace, codexAdapter);
        const goal = await manager.resume({ goal_id: args.goal_id, prompt: args.prompt, idempotency_key: args.idempotency_key });
        return textResult(goalText("Goal Resumed", goal), { goal });
      }
    );

    registerCodexTool(
      config,
      server,
      "goal_cancel",
      {
        title: "Cancel Goal",
        description: "Cancel one persistent Goal. Repeated cancellation is idempotent and cannot replace an existing terminal state.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          goal_id: z.string().min(1)
        },
        annotations: HANDOFF_WRITE_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Cancelling persistent Goal...",
          "openai/toolInvocation/invoked": "Persistent Goal cancelled"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const manager = getGoalManager(config, guard, workspace, codexAdapter);
        const goal = await manager.cancel(args.goal_id);
        return textResult(goalText("Goal Cancellation", goal), { goal });
      }
    );

    registerCodexTool(
      config,
      server,
      "goal_events",
      {
        title: "Goal Events",
        description: "Read persisted normalized Goal events from .ai-bridge/goals/<goal-id>/events.jsonl. Invalid trailing JSONL from an interrupted append is ignored on load.",
        inputSchema: {
          workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the active/default workspace."),
          goal_id: z.string().min(1),
          after_sequence: z.number().int().min(0).optional().describe("Return events after this sequence number. Default: 0.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Reading Goal events...",
          "openai/toolInvocation/invoked": "Goal events ready"
        }
      },
      async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
        const manager = getGoalManager(config, guard, workspace, codexAdapter);
        await manager.ready();
        const events = await manager.store.readEvents(args.goal_id, args.after_sequence ?? 0);
        const rows = events.length
          ? events.map((event) => `- ${event.sequence} ${event.type} status=${event.status}`).join("\n")
          : "- No new events.";
        return textResult(`# Goal Events\n\nGoal: ${args.goal_id}\nCount: ${events.length}\n\n${rows}`, {
          goal_id: args.goal_id,
          events,
          event_count: events.length
        });
      }
    );
  }

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read and returns a bounded transcript from a local Codex session JSONL file.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum transcript content bytes. Default: 80000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false."),
        require_watcher: z.boolean().optional().describe("Require a healthy watcher before writing. Default: true for agent=codex, false for other agents."),
        auto_start_watcher: z.boolean().optional().describe("Auto-start a missing watcher before writing. Default: true for agent=codex.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const targetAgent = normalizeAgentId(args.agent ?? "custom");
      const requireWatcher = args.require_watcher === undefined
        ? targetAgent === "codex"
        : parseBool(args.require_watcher, targetAgent === "codex");
      const autoStartWatcher = args.auto_start_watcher === undefined
        ? targetAgent === "codex"
        : parseBool(args.auto_start_watcher, targetAgent === "codex");
      const handoffTitle = cleanOneLine(args.title, "Agent implementation plan");
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: targetAgent,
        agentName: args.agent_name,
        model: args.model,
        title: handoffTitle,
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent",
        requireWatcher,
        autoStartWatcher
      });
      const identity = await new TaskProjectionService(config, guard, workspace).ensureHandoffPlan({
        plan_hash: result.writeResult.sha256,
        title: handoffTitle
      });

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Watcher: ${result.handoffStatus.watcher_online ? "online" : "offline"} (${result.handoffStatus.watcher_state})
Execution ready: ${result.handoffStatus.execution_ready ? "yes" : "no"}
Execution acknowledged: ${result.handoffStatus.execution_acknowledged ? "yes" : "no"}
Task id: ${identity.task_id}
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

${result.handoffStatus.execution_acknowledged
  ? "The matching plan hash has been acknowledged by the local executor."
  : "This confirms plan creation only. Do not claim that the agent started until wait_for_handoff reports the matching plan hash as running or terminal. Do not fall back to CodexPro for watcher or path failures."}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        task_id: identity.task_id,
        identity,
        plan_hash: result.writeResult.sha256,
        watcher_online: result.handoffStatus.watcher_online,
        watcher_state: result.handoffStatus.watcher_state,
        watcher_reason: result.handoffStatus.watcher_reason,
        execution_ready: result.handoffStatus.execution_ready,
        execution_acknowledged: result.handoffStatus.execution_acknowledged,
        must_not_fallback: result.handoffStatus.must_not_fallback,
        heartbeat_path: result.handoffStatus.heartbeat_path,
        recovery_action: result.handoffStatus.recovery_action,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false."),
        require_watcher: z.boolean().optional().describe("Require a healthy Codex watcher before writing. Default: true."),
        auto_start_watcher: z.boolean().optional().describe("Auto-start a missing Codex watcher before writing. Default: true.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(args.title, "Codex implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex",
        requireWatcher: parseBool(args.require_watcher, true),
        autoStartWatcher: parseBool(args.auto_start_watcher, true)
      });
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Watcher: ${result.handoffStatus.watcher_online ? "online" : "offline"} (${result.handoffStatus.watcher_state})
Execution ready: ${result.handoffStatus.execution_ready ? "yes" : "no"}
Execution acknowledged: ${result.handoffStatus.execution_acknowledged ? "yes" : "no"}
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

This confirms plan creation only. Do not claim Codex started until wait_for_handoff reports this plan hash as running or terminal. Watcher or workspace failures must be repaired; they are not a reason to fall back to CodexPro.

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        plan_hash: result.writeResult.sha256,
        watcher_online: result.handoffStatus.watcher_online,
        watcher_state: result.handoffStatus.watcher_state,
        watcher_reason: result.handoffStatus.watcher_reason,
        execution_ready: result.handoffStatus.execution_ready,
        execution_acknowledged: result.handoffStatus.execution_acknowledged,
        must_not_fallback: result.handoffStatus.must_not_fallback,
        heartbeat_path: result.handoffStatus.heartbeat_path,
        recovery_action: result.handoffStatus.recovery_action,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return server;
}

export function listCodexProToolDefinitions(server: McpServer): CoreToolDefinition[] {
  return coreToolDefinitions(server);
}

export async function invokeCodexProTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  context?: CoreToolRequestContext
): Promise<CoreToolResult> {
  const handler = registeredToolHandler(server, name);
  if (!handler) throw new CodexProError(`Unknown CodexPro tool: ${name}`);
  return normalizeCoreToolResult(await handler(args, context));
}
