import { randomUUID } from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus, type CodexProEventName, type EventDispatchResult } from "../events/eventBus.js";
import { CodexProError, type Workspace } from "../guard.js";
import type { McpProtocolAdapter } from "../mcp/protocolAdapter.js";
import { createMcpProfileV1Adapter } from "../mcp/profiles/v1.js";
import { recordL0ReadObservation } from "../observability/l0ReadMetrics.js";
import { recordRiskObservation } from "../observability/riskMetrics.js";
import { isConfiguredProjectPoolRoot } from "../project/userProjects.js";
import { capabilitySideEffectLevelForTool, evaluateUnifiedRiskWithObservation, type UnifiedRiskDecision } from "../security/riskGate.js";
import {
  analyzeAuthorizationPayload,
  authorizationPayloadAuditSummary,
  bindExecutedAuthorizationPayloadFromIntegrity,
  createAuthorizationPayloadBindingFromIntegrity,
  type AuthorizationPayloadBindingV1,
  type AuthorizationPayloadIntegrityV1
} from "../security/authorizationIntegrity.js";
import {
  assertPreExecutionDecision,
  createPreExecutionDecision,
  type PreExecutionDecisionV1
} from "../security/preExecutionDecision.js";
import {
  mergePermissionDecisions,
  permissionDecisionAllowsExecution,
  type MonotonicPermissionDecision,
  type PermissionDecisionSource
} from "../security/permissionDecision.js";
import {
  resolvePermissionConfirmation,
  type PermissionConfirmationScopeV1
} from "../security/confirmationReceipt.js";
import type { AuthorizationAuditPhase } from "../security/authorizationAuditStore.js";
import {
  authorizationAuditPersistencePolicy,
  persistAuthorizationAuditWithPolicy,
  type AuthorizationAuditPersistenceReceiptV1
} from "../security/authorizationAuditPolicy.js";
import type { ExecutionLane } from "../workflow/executionLane.js";
import { executionOriginReceipt } from "../runtime/executionOrigin.js";
import { deriveOrthogonalToolOutcome, toolStatusFromOrthogonal } from "../runtime/orthogonalToolOutcome.js";
import { withProcessTrackingSuppressed } from "../runtime/processWrapper.js";
import { classifyAggregateToolCall, isZeroWriteAnalysisOnlyAggregateCall } from "../workflow/aggregateExecutionMode.js";
import type { PublicToolOutcomeV1 } from "../runtime/publicToolOutcome.js";
import {
  enforceGoldTaskExplorationBudget,
  enforceGoldTaskInternalForwardingBudget,
  recordGoldTaskConnectorCall,
  withGoldTaskConnectorRequest,
  type GoldTaskConnectorRequestContext
} from "../evaluation/goldTaskSession.js";
import { classifyTask, type TaskMode } from "../workflow/taskRouter.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "../toolCardWidget.js";
import { CoreToolRegistry, normalizeCoreToolResult, type CoreToolDefinition, type CoreToolRegistration, type CoreToolRequestContext, type CoreToolResult } from "./coreToolRegistry.js";
import { EXPLICIT_SKILL_LOADING_INSTRUCTION } from "../tools/skills.js";
import { DirectToolTaskBridge, classifyDirectToolActivity, type DirectToolActivityBinding, type DirectToolActivityHandle } from "../tasks/directToolTaskBridge.js";
import { normalizeSupertoolAction, shouldRegisterTool, SUPERTOOL_NAME } from "./toolRegistry.js";
import {
  buildToolContract,
  createToolResultEnvelope,
  toolResultOutputSchema,
  type ToolContractMetadataV1
} from "../tools/toolContract.js";
import { assertToolWorkspaceBinding } from "../workspaces/toolWorkspaceGuard.js";

export interface ToolWorkspaceResolutionInput {
  workspaceId?: string;
  conversationId?: string;
}

export interface ToolRegistrationRuntimeDependencies {
  safeStructuredContent(structuredContent?: Record<string, unknown>): Record<string, unknown>;
  errorResult(error: unknown): any;
  resolveWorkspace?(config: CodexProConfig, input: ToolWorkspaceResolutionInput): Workspace;
  mcpAdapter?: McpProtocolAdapter;
}

export interface RiskEvaluationTarget {
  tool_name: string;
  args: unknown;
  wrapped: boolean;
}

export interface MarkdownWriteFastPath {
  kind: "static_markdown_write";
  args: Record<string, unknown>;
  risk_args: Record<string, unknown>;
  context_auto_bound: boolean;
  content_risk_scan: "skipped_static_content";
  office_projection: "async";
}

export interface AuthoritativeWorkspaceArgumentBinding {
  args: Record<string, unknown>;
  workspace: Workspace | null;
  conversation_id_auto_bound: boolean;
  workspace_id_auto_bound: boolean;
  workspace_generation_auto_bound: boolean;
}

export function bindAuthoritativeWorkspaceArguments(
  rawArgs: unknown,
  contract: ToolContractMetadataV1,
  workspace: Workspace | null
): AuthoritativeWorkspaceArgumentBinding {
  const input = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
  if (!contract.workspace_required || !workspace) {
    return {
      args: input,
      workspace,
      conversation_id_auto_bound: false,
      workspace_id_auto_bound: false,
      workspace_generation_auto_bound: false
    };
  }

  const args = { ...input };
  const suppliedConversationId = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
  const suppliedWorkspaceId = typeof args.workspace_id === "string" ? args.workspace_id.trim() : "";
  let conversationIdAutoBound = false;
  let workspaceIdAutoBound = false;
  let workspaceGenerationAutoBound = false;
  const recoverWorkspaceBinding = workspace.authoritySource === "workspace_binding" && Boolean(workspace.conversationId);
  if ((recoverWorkspaceBinding || !suppliedConversationId) && workspace.conversationId) {
    args.conversation_id = workspace.conversationId;
    conversationIdAutoBound = !suppliedConversationId || suppliedConversationId !== workspace.conversationId;
  }
  if (!suppliedWorkspaceId) {
    args.workspace_id = workspace.id;
    workspaceIdAutoBound = true;
  }
  if (
    contract.workspace_generation_required
    && args.workspace_generation === undefined
    && Number.isInteger(workspace.workspaceGeneration)
    && Number(workspace.workspaceGeneration) > 0
  ) {
    args.workspace_generation = workspace.workspaceGeneration;
    workspaceGenerationAutoBound = true;
  }
  return {
    args,
    workspace,
    conversation_id_auto_bound: conversationIdAutoBound,
    workspace_id_auto_bound: workspaceIdAutoBound,
    workspace_generation_auto_bound: workspaceGenerationAutoBound
  };
}

export function optionsWithContractInputs(name: string, options: Record<string, unknown>): Record<string, unknown> {
  const contract = buildToolContract(name, typeof options.description === "string" ? options.description : "");
  if (!contract.workspace_required) return options;
  const original = options.inputSchema && typeof options.inputSchema === "object" && !Array.isArray(options.inputSchema)
    ? options.inputSchema as Record<string, unknown>
    : {};
  const inputSchema: Record<string, unknown> = {
    ...original,
    workspace_id: z.string().optional().describe(
      "Optional workspace id. When omitted, CodexPro binds the authoritative conversation workspace automatically; an explicit unknown or mismatched id is rejected."
    )
  };
  inputSchema.conversation_id = z.string().min(1).optional().describe(
    "Connector conversation id bound to this workspace. Modern MCP injects it automatically; side-effecting tools require it to match the authoritative binding."
  );
  if (contract.workspace_generation_required) {
    inputSchema.workspace_generation = z.number().int().min(1).optional().describe(
      "Optional authoritative workspace generation. When omitted, CodexPro injects the conversation-bound generation; an explicit stale generation is rejected."
    );
  }
  return { ...options, inputSchema };
}

export interface PreExecutionPermissionDispatch {
  source: string;
  dispatch: Pick<EventDispatchResult, "permission_decisions" | "block_reasons">;
}

export function mergePreExecutionPermissionDecisions(
  base: MonotonicPermissionDecision,
  dispatches: PreExecutionPermissionDispatch[]
): MonotonicPermissionDecision {
  const hookSources: PermissionDecisionSource[] = [];
  const seen = new Set<string>();
  for (const entry of dispatches) {
    const source = entry.source.trim();
    if (!source) continue;
    for (const reason of entry.dispatch.block_reasons) {
      const cleanReason = reason.trim();
      if (!cleanReason) continue;
      const key = JSON.stringify([source, "security_controller", "deny", cleanReason]);
      if (seen.has(key)) continue;
      seen.add(key);
      hookSources.push({
        source: `${source}:security_controller`,
        decision: "deny",
        reason: cleanReason,
        constraints: ["security_controller_block"]
      });
    }
    for (const decision of entry.dispatch.permission_decisions) {
      const constraints = [...new Set(decision.constraints.map((value) => value.trim()).filter(Boolean))].sort();
      const decisionSource = `${source}:${decision.listener_id}`;
      const key = JSON.stringify([decisionSource, decision.decision, decision.reason.trim(), constraints]);
      if (seen.has(key)) continue;
      seen.add(key);
      hookSources.push({
        source: decisionSource,
        decision: decision.decision,
        reason: decision.reason,
        constraints
      });
    }
  }
  if (!hookSources.length) return base;
  return mergePermissionDecisions([...base.sources, ...hookSources]);
}

export function permissionConfirmationScopeForToolCall(
  name: string,
  args: unknown,
  context: CoreToolRequestContext["mcp"] | undefined,
  workspace: Workspace | null,
  authorizationPayloadHash?: string
): PermissionConfirmationScopeV1 {
  return {
    tool: name,
    arguments: args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {},
    ...(context?.actorId ? { actor_id: context.actorId } : {}),
    ...(context?.conversationId ? { conversation_id: context.conversationId } : {}),
    ...(workspace?.id ?? context?.workspaceId ? { workspace_id: workspace?.id ?? context?.workspaceId } : {}),
    ...(Number.isInteger(workspace?.workspaceGeneration ?? context?.workspaceGeneration)
      ? { workspace_generation: Number(workspace?.workspaceGeneration ?? context?.workspaceGeneration) }
      : {}),
    ...(authorizationPayloadHash ? { authorization_payload_hash: authorizationPayloadHash } : {})
  };
}

export function permissionConfirmationRequiredResult(
  name: string,
  permission: MonotonicPermissionDecision,
  scope: PermissionConfirmationScopeV1
): CoreToolResult {
  return {
    content: [{
      type: "text",
      text: `Confirmation is required before ${name} executes: ${permission.reasons.join(" | ")}`
    }],
    structuredContent: {
      waiting_for: "confirmation",
      tool: name,
      inputRequests: [{
        requestId: "confirmation:execute",
        type: "confirmation",
        title: `Confirm ${name}`,
        description: `Confirm this exact one-time ${name} call with the displayed arguments.`,
        required: true
      }],
      confirmation_scope: scope,
      permission_decision: {
        decision_id: permission.decision_id,
        final_decision: permission.final_decision,
        constraints: permission.constraints,
        reasons: permission.reasons,
        evidence_refs: permission.evidence_refs
      }
    }
  };
}

class PermissionConfirmationRequiredError extends Error {
  constructor(readonly result: CoreToolResult) {
    super("Permission confirmation is required.");
    this.name = "PermissionConfirmationRequiredError";
  }
}

function assertPermissionOrRequestConfirmation(
  name: string,
  permission: MonotonicPermissionDecision,
  scope: PermissionConfirmationScopeV1
): void {
  if (permission.final_decision === "ask") {
    throw new PermissionConfirmationRequiredError(permissionConfirmationRequiredResult(name, permission, scope));
  }
  if (!permissionDecisionAllowsExecution(permission)) {
    throw new CodexProError(`Authorization policy blocked ${name}: ${permission.reasons.join(" | ")}`);
  }
}

const MARKDOWN_FAST_PATH_BLOCKED_ROOTS = [".ai-bridge/", ".codexpro/", ".git/", ".github/"];
const MARKDOWN_FAST_PATH_BLOCKED_FILES = new Set([
  "agents.md",
  "chatgpt_prompt.md",
  "claude.md",
  "code_of_conduct.md",
  "codex_prompt.md",
  "security.md"
]);

function normalizedMarkdownPath(value: unknown): string {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function markdownFastPathBlocked(pathValue: string): boolean {
  const lower = pathValue.toLowerCase();
  if (MARKDOWN_FAST_PATH_BLOCKED_ROOTS.some((prefix) => lower.startsWith(prefix))) return true;
  const base = path.posix.basename(lower);
  if (MARKDOWN_FAST_PATH_BLOCKED_FILES.has(base)) return true;
  return /(^|\/)[^/]*(?:allowlist|authorization|guard|permission|policy|security)[^/]*\.(?:md|markdown)$/i.test(lower);
}

export function prepareMarkdownWriteFastPath(toolName: string, rawArgs: unknown, workspace: Workspace | null): MarkdownWriteFastPath | null {
  if (toolName !== "write" || !workspace || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  const input = rawArgs as Record<string, unknown>;
  const targetPath = normalizedMarkdownPath(input.path);
  if (!targetPath || !/\.(?:md|markdown)$/i.test(targetPath) || markdownFastPathBlocked(targetPath)) return null;
  if (typeof input.content !== "string") return null;
  if (["task_id", "run_id", "stage_id", "attempt_id", "executor_id", "task_instruction", "task_mode"].some((key) => input[key] !== undefined)) return null;
  if (typeof input.workspace_id === "string" && input.workspace_id.trim() && input.workspace_id !== workspace.id) return null;
  const authoritativeGeneration = workspace.workspaceGeneration;
  if (!authoritativeGeneration || authoritativeGeneration < 1) return null;
  const contextAutoBound = typeof input.workspace_id !== "string" || !input.workspace_id.trim() || input.workspace_generation === undefined;
  const args: Record<string, unknown> = {
    ...input,
    workspace_id: typeof input.workspace_id === "string" && input.workspace_id.trim() ? input.workspace_id : workspace.id,
    workspace_generation: input.workspace_generation ?? authoritativeGeneration
  };
  return {
    kind: "static_markdown_write",
    args,
    risk_args: {
      workspace_id: args.workspace_id,
      workspace_generation: args.workspace_generation,
      path: targetPath
    },
    context_auto_bound: contextAutoBound,
    content_risk_scan: "skipped_static_content",
    office_projection: "async"
  };
}

export function riskEvaluationTargetForToolCall(name: string, args: unknown): RiskEvaluationTarget {
  const toolName = String(name ?? "").trim();
  if (toolName !== SUPERTOOL_NAME || !args || typeof args !== "object" || Array.isArray(args)) {
    return { tool_name: toolName, args, wrapped: false };
  }
  const wrapper = args as Record<string, unknown>;
  const wrappedToolName = normalizeSupertoolAction(wrapper.action);
  if (!wrappedToolName || wrappedToolName === SUPERTOOL_NAME) {
    return { tool_name: toolName, args, wrapped: false };
  }
  const wrappedArgs = wrapper.args && typeof wrapper.args === "object" && !Array.isArray(wrapper.args)
    ? wrapper.args
    : {};
  return {
    tool_name: wrappedToolName,
    args: wrappedArgs,
    wrapped: true
  };
}

export function createToolRegistrationRuntime(dependencies: ToolRegistrationRuntimeDependencies) {
  const { safeStructuredContent, errorResult } = dependencies;
  const mcpAdapter = dependencies.mcpAdapter ?? createMcpProfileV1Adapter({ safeStructuredContent, errorResult });
  const directToolBridgesByServer = new WeakMap<object, Map<string, DirectToolTaskBridge>>();
  const workspaceResolversByServer = new WeakMap<object, (input: ToolWorkspaceResolutionInput) => Workspace>();
  function workspaceResolutionInput(args: Record<string, unknown>): ToolWorkspaceResolutionInput {
    return {
      ...(typeof args.workspace_id === "string" && args.workspace_id.trim() ? { workspaceId: args.workspace_id.trim() } : {}),
      ...(typeof args.conversation_id === "string" && args.conversation_id.trim() ? { conversationId: args.conversation_id.trim() } : {})
    };
  }
  function workspaceForToolCall(server: McpServer, config: CodexProConfig, args: Record<string, unknown>): Workspace | null {
    const serverResolver = workspaceResolversByServer.get(server as object);
    if (!serverResolver && !dependencies.resolveWorkspace) return null;
    const input = workspaceResolutionInput(args);
    try {
      return serverResolver
        ? serverResolver(input)
        : dependencies.resolveWorkspace!(config, input);
    } catch {
      return null;
    }
  }
  function directToolBridgeForWorkspace(server: McpServer, config: CodexProConfig, workspace: Workspace | null): DirectToolTaskBridge | null {
    if (!workspace) return null;
    const serverKey = server as object;
    const directToolBridges = directToolBridgesByServer.get(serverKey) ?? new Map<string, DirectToolTaskBridge>();
    if (!directToolBridgesByServer.has(serverKey)) directToolBridgesByServer.set(serverKey, directToolBridges);
    const bridgeKey = `${workspace.root}\0${workspace.workspaceGeneration ?? 1}`;
    const existing = directToolBridges.get(bridgeKey);
    if (existing) return existing;
    const bridge = new DirectToolTaskBridge(config, workspace);
    directToolBridges.set(bridgeKey, bridge);
    return bridge;
  }
  function directToolBridge(server: McpServer, config: CodexProConfig, args: Record<string, unknown>): DirectToolTaskBridge | null {
    const serverResolver = workspaceResolversByServer.get(server as object);
    if (!serverResolver && !dependencies.resolveWorkspace) return null;
    const input = workspaceResolutionInput(args);
    const workspace = serverResolver
      ? serverResolver(input)
      : dependencies.resolveWorkspace!(config, input);
    return directToolBridgeForWorkspace(server, config, workspace);
  }
  function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
    const inputSchema = options.inputSchema;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(inputSchema)) {
      if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
        shape[key] = value as z.ZodTypeAny;
      }
    }
    if (!Object.keys(shape).length) return {};
    const schema = name === "git_finalize" ? z.object(shape).strict() : z.object(shape);
    const parsed = schema.safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
      .join("; ");
    throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
  }

  function tagToolResult(
    result: any,
    name: string,
    definition: CoreToolDefinition,
    config: CodexProConfig,
    outcome: { handlerInvoked?: boolean; handlerSucceeded?: boolean } = {}
  ): any {
    if (!result || typeof result !== "object") return result;
    const structured = result.structuredContent;
    const base =
      structured && typeof structured === "object" && !Array.isArray(structured)
        ? structured
        : {};
    const existingReceipt = base.execution_origin_receipt;
    result.structuredContent = safeStructuredContent({
      codexpro_tool: name,
      codexpro_title: definition.title ?? name,
      ...base,
      execution_origin_receipt: existingReceipt ?? executionOriginReceipt(config, name, outcome)
    });
    return result;
  }

  function normalizeFormalEvidenceFields(name: string, args: any, result: any): any {
    if (!result || typeof result !== "object") return result;
    const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? result.structuredContent as Record<string, any>
      : {};
    if (name.startsWith("browser_")) {
      const expectation = structured.expectation && typeof structured.expectation === "object" ? structured.expectation : null;
      result.structuredContent = safeStructuredContent({
        ...structured,
        browser_session_id: structured.browser_session_id ?? structured.current_session_id ?? structured.session_id ?? null,
        page_id: structured.page_id ?? structured.tab_id ?? null,
        requested_url: structured.requested_url ?? args?.url ?? null,
        final_url: structured.final_url ?? structured.url ?? structured.current_url ?? null,
        device: structured.device ?? args?.device ?? null,
        expectation_result: structured.expectation_result ?? (expectation ? expectation.passed === true ? "passed" : "failed" : "not_run"),
        console_error_count: Number(structured.console_error_count ?? 0),
        network_failure_count: Number(structured.network_failure_count ?? structured.failed_request_count ?? 0),
        screenshot_ref: structured.screenshot_ref ?? structured.screenshot_path ?? (name === "browser_screenshot" ? structured.path ?? null : null),
        report_ref: structured.report_ref ?? structured.report_path ?? null,
        browser_acceptance_status: structured.browser_acceptance_status ?? "not_requested"
      });
    }
    if (name === "run_validation") {
      const data = result.structuredContent as Record<string, any>;
      const commands = Array.isArray(data.commands) ? data.commands : [];
      const failed = commands.find((command: any) => command?.status === "failed" || Number(command?.exit_code ?? command?.exitCode ?? 0) !== 0);
      result.structuredContent = safeStructuredContent({
        ...data,
        validation_run_id: data.run_id ?? null,
        per_command_status: commands.map((command: any) => ({
          command: command.command ?? command.name ?? "unknown",
          status: command.status ?? "unknown",
          exit_code: command.exit_code ?? command.exitCode ?? null,
          duration_ms: command.duration_ms ?? null,
          stdout_tail: command.stdout_tail ?? command.stdout ?? null,
          stderr_tail: command.stderr_tail ?? command.stderr ?? null,
          full_log_ref: command.log_path ?? null
        })),
        overall_status: data.status ?? (result.isError ? "failed" : "unknown"),
        failed_command: failed?.command ?? failed?.name ?? null,
        timeout_status: commands.some((command: any) => command?.timed_out === true) ? "timed_out" : "not_timed_out",
        full_log_ref: data.report_path ?? null
      });
    }
    return result;
  }

  function attachWorkspaceOpenServerTiming(
    result: any,
    name: string,
    timing: {
      requestReceivedAtMs: number;
      handlerStartedAtMs?: number;
      handlerCompletedAtMs?: number;
      resultSerializedAtMs?: number;
      wrapperCompletedAtMs: number;
    }
  ): void {
    if (name !== "open_current_workspace" && name !== "open_workspace") return;
    if (!result || typeof result !== "object") return;
    const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? result.structuredContent as Record<string, unknown>
      : {};
    const { requestReceivedAtMs, handlerStartedAtMs, handlerCompletedAtMs, resultSerializedAtMs, wrapperCompletedAtMs } = timing;
    result.structuredContent = safeStructuredContent({
      ...structured,
      server_timing: {
        request_received_at: new Date(requestReceivedAtMs).toISOString(),
        ...(handlerStartedAtMs !== undefined ? { handler_started_at: new Date(handlerStartedAtMs).toISOString() } : {}),
        ...(handlerCompletedAtMs !== undefined ? { handler_completed_at: new Date(handlerCompletedAtMs).toISOString() } : {}),
        ...(resultSerializedAtMs !== undefined ? { result_serialized_at: new Date(resultSerializedAtMs).toISOString() } : {}),
        wrapper_completed_at: new Date(wrapperCompletedAtMs).toISOString(),
        policy_ms: handlerStartedAtMs === undefined ? null : Math.max(0, handlerStartedAtMs - requestReceivedAtMs),
        handler_ms: handlerStartedAtMs === undefined || handlerCompletedAtMs === undefined
          ? null
          : Math.max(0, handlerCompletedAtMs - handlerStartedAtMs),
        serialization_ms: handlerCompletedAtMs === undefined || resultSerializedAtMs === undefined
          ? null
          : Math.max(0, resultSerializedAtMs - handlerCompletedAtMs),
        finalization_ms: resultSerializedAtMs === undefined
          ? null
          : Math.max(0, wrapperCompletedAtMs - resultSerializedAtMs),
        total_server_ms: Math.max(0, wrapperCompletedAtMs - requestReceivedAtMs)
      }
    });
  }
  
  function toolCardMeta(): Record<string, unknown> {
    return {
      ui: { resourceUri: TOOL_CARD_URI },
      "openai/outputTemplate": TOOL_CARD_URI
    };
  }

  function metaString(meta: Record<string, unknown>, key: string): string | undefined {
    const value = meta[key];
    return typeof value === "string" && value ? value : undefined;
  }

  function coreToolDefinitionFromOptions(name: string, options: Record<string, unknown>): CoreToolDefinition {
    const meta = options._meta && typeof options._meta === "object" && !Array.isArray(options._meta)
      ? options._meta as Record<string, unknown>
      : {};
    const ui = meta.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui)
      ? meta.ui as Record<string, unknown>
      : {};
    const widgetResourceUri = typeof ui.resourceUri === "string" && ui.resourceUri ? ui.resourceUri : undefined;
    const outputTemplateUri = metaString(meta, "openai/outputTemplate");
    const invoking = metaString(meta, "openai/toolInvocation/invoking");
    const invoked = metaString(meta, "openai/toolInvocation/invoked");
    const presentation = widgetResourceUri || outputTemplateUri || invoking || invoked
      ? { widgetResourceUri, outputTemplateUri, invoking, invoked }
      : undefined;
    return {
      name,
      ...(typeof options.title === "string" ? { title: options.title } : {}),
      ...(typeof options.description === "string" ? { description: options.description } : {}),
      ...(options.inputSchema && typeof options.inputSchema === "object" && !Array.isArray(options.inputSchema)
        ? { inputSchema: options.inputSchema as Record<string, unknown> }
        : { inputSchema: {} }),
      ...(options.outputSchema && typeof options.outputSchema === "object" && !Array.isArray(options.outputSchema)
        ? { outputSchema: options.outputSchema as Record<string, unknown> }
        : { outputSchema: toolResultOutputSchema() }),
      ...(options.annotations && typeof options.annotations === "object" && !Array.isArray(options.annotations)
        ? { annotations: options.annotations as Record<string, unknown> }
        : {}),
      capability_side_effect_level: capabilitySideEffectLevelForTool(name),
      contract: buildToolContract(name, typeof options.description === "string" ? options.description : ""),
      ...(presentation ? { presentation } : {})
    };
  }
  
  function toolCallLoggingEnabled(): boolean {
    return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
  }
  
  function logToolCall(name: string, status: "ok" | "error", started: number): void {
    if (!toolCallLoggingEnabled()) return;
    console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
  }
  
  function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
    const s = server as any;
    if (typeof s.registerResource !== "function") {
      throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
    }
  
    const registerUri = (uri: string, name: string): void => {
      s.registerResource(
        name,
        uri,
        {
          title: "CodexPro Tool Card",
          description: "Compact visual renderer for CodexPro workspace orientation, source changes, and handoffs.",
          mimeType: TOOL_CARD_MIME_TYPE
        },
        async () => ({
          contents: [
            {
              uri,
              mimeType: TOOL_CARD_MIME_TYPE,
              text: toolCardWidgetHtml,
              _meta: {
                ui: {
                  prefersBorder: true,
                  domain: config.widgetDomain,
                  csp: {
                    connectDomains: [],
                    resourceDomains: []
                  }
                },
                "openai/widgetDescription": "Renders CodexPro workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
                "openai/widgetPrefersBorder": true,
                "openai/widgetDomain": config.widgetDomain,
                "openai/widgetCSP": {
                  connect_domains: [],
                  resource_domains: []
                }
              }
            }
          ]
        })
      );
    };
  
    registerUri(TOOL_CARD_URI, "codexpro-tool-card");
    for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
      registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
    }
  }
  
  type CodexToolHandler = (args: any, context?: CoreToolRequestContext) => Promise<any> | any;
  
  const coreToolRegistriesByServer = new WeakMap<object, CoreToolRegistry>();
  const policyWrappedToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();

  function coreToolRegistry(server: McpServer): CoreToolRegistry {
    const key = server as object;
    const existing = coreToolRegistriesByServer.get(key);
    if (existing) return existing;
    const registry = new CoreToolRegistry();
    coreToolRegistriesByServer.set(key, registry);
    return registry;
  }

  function rememberCoreTool(server: McpServer, definition: CoreToolDefinition, handler: CodexToolHandler): CoreToolRegistration {
    return coreToolRegistry(server).register(
      definition,
      async (call, context) => normalizeCoreToolResult(await handler(call.arguments ?? {}, context))
    );
  }
  
  function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
    return policyWrappedToolHandlersByServer.get(server as object)?.get(name);
  }

  function rememberPolicyWrappedToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
    const key = server as object;
    const handlers = policyWrappedToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
    if (!policyWrappedToolHandlersByServer.has(key)) policyWrappedToolHandlersByServer.set(key, handlers);
    handlers.set(name, handler);
  }

  function coreToolNames(server: McpServer): string[] {
    return coreToolRegistry(server).names();
  }

  function coreToolDefinitions(server: McpServer): CoreToolDefinition[] {
    return coreToolRegistry(server).definitions();
  }

  function coreToolSchemaDigest(server: McpServer): string {
    return coreToolRegistry(server).schemaDigest();
  }
  
  function isContextPath(config: CodexProConfig, relPath: string): boolean {
    const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
    const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
  }
  
  function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
    if (config.writeMode === "workspace") return;
    if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
    if (config.writeMode === "handoff") {
      throw new CodexProError(
        `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
          `Use handoff_to_agent or handoff_to_codex, or write/edit only inside ${config.contextDir}/.`
      );
    }
    throw new CodexProError("write/edit tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
  }
  
  function assertNotProjectPoolRoot(config: CodexProConfig, workspace: Workspace, operation: string): void {
    if (!isConfiguredProjectPoolRoot(config, workspace.root)) return;
    throw new CodexProError(
      `${operation} is blocked on the project pool root: ${workspace.root}\n` +
        "Switch to a configured project such as example-project-a or codexpro-gpt, then run the tool without a workspace_id so it stays inside the active workspace."
    );
  }
  
  function taskModeFromArgs(args: any): TaskMode | undefined {
    return typeof args.task_mode === "string" ? (args.task_mode as TaskMode) : undefined;
  }
  
  function taskInstructionFromArgs(args: any): string | undefined {
    const raw = typeof args.task_instruction === "string" ? args.task_instruction.trim() : "";
    return raw || undefined;
  }
  
  function assertTaskRouteToolAllowed(
    toolName: string,
    args: any,
    options: { patchesRequested?: boolean; commandsRequested?: boolean } = {}
  ): void {
    const mode = taskModeFromArgs(args);
    const instruction = taskInstructionFromArgs(args);
    if (!mode && !instruction) return;
    const decision = classifyTask(instruction ?? mode ?? "", {
      mode,
      requestedTool: toolName,
      patchesRequested: options.patchesRequested,
      commandsRequested: options.commandsRequested,
      targetPath: typeof args.path === "string" ? args.path : undefined
    });
    const requested = decision.requested_tool;
    if (requested && !requested.allowed) throw new CodexProError(requested.reason);
  }
  
  function domainEventsForTool(name: string): { before?: CodexProEventName; after?: CodexProEventName } {
    if (name.startsWith("browser_") && !["browser_status", "browser_pages", "browser_console", "browser_network", "browser_report"].includes(name)) {
      return { before: "browser_before_action", after: "browser_after_action" };
    }
    if (name === "git_finalize" || name === "git_commit" || name.endsWith("_git_commit")) {
      return { before: "git_before_commit", after: "git_after_commit" };
    }
    if (name === "git_push_only" || name === "git_push" || name.endsWith("_git_push")) {
      return { before: "git_before_push", after: "git_after_push" };
    }
    return {};
  }

  function safeTaskIdFromArgs(args: any): string | undefined {
    const value = typeof args?.task_id === "string" ? args.task_id.trim() : "";
    return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
  }

  function executionLaneFromArgs(args: any): ExecutionLane | "unknown" {
    const direct = typeof args?.execution_lane === "string" ? args.execution_lane : undefined;
    const nested = args?.task_route && typeof args.task_route === "object" && typeof args.task_route.execution_lane === "string"
      ? args.task_route.execution_lane
      : undefined;
    const value = direct ?? nested;
    return value === "finalization" || value === "fast" || value === "standard" || value === "deep" ? value : "unknown";
  }

  function permissionSourceFromRisk(risk: UnifiedRiskDecision): PermissionDecisionSource {
    if (!risk.allowed) {
      const ask = risk.level !== "L3"
        && risk.explicit_authorization_required
        && !risk.authorization_detected
        && !/denied|prohibited|irreversible|critical/i.test(risk.reason_code);
      return {
        source: "risk_gate",
        decision: ask ? "ask" : "deny",
        reason: risk.reason,
        constraints: risk.matched_signals
      };
    }
    return {
      source: "risk_gate",
      decision: risk.level === "L0" ? "allow" : "constrained",
      reason: risk.reason,
      constraints: [
        ...(risk.checkpoint_required ? ["checkpoint_required"] : []),
        ...(!risk.automatic_replay_allowed ? ["automatic_replay_forbidden"] : [])
      ]
    };
  }

  function embeddedAuthorizationDecision(args: any): Record<string, any> | undefined {
    const root = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, any> : undefined;
    const compiled = root?.compiled_task && typeof root.compiled_task === "object" && !Array.isArray(root.compiled_task)
      ? root.compiled_task as Record<string, any>
      : root?.task_contract && typeof root.task_contract === "object" && !Array.isArray(root.task_contract)
        ? root.task_contract as Record<string, any>
        : undefined;
    const candidate = root?.authorization_decision ?? compiled?.authorization_decision;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : undefined;
  }

  function permissionForToolCall(
    risk: UnifiedRiskDecision,
    integrity: AuthorizationPayloadIntegrityV1,
    args: any,
    definition: CoreToolDefinition
  ): MonotonicPermissionDecision {
    const embedded = embeddedAuthorizationDecision(args);
    const embeddedSources = risk.reason_code === "contract_authorization_integrity_failed"
      ? []
      : Array.isArray(embedded?.permission_decision?.sources)
        ? embedded.permission_decision.sources.filter((source: unknown): source is PermissionDecisionSource => {
            if (!source || typeof source !== "object" || Array.isArray(source)) return false;
            const candidate = source as Record<string, unknown>;
            return typeof candidate.source === "string"
              && typeof candidate.reason === "string"
              && ["allow", "constrained", "sandbox", "ask", "deny"].includes(String(candidate.decision));
          })
        : [];
    const manualConfirmed = embedded?.payload_binding?.manual_confirmation === true;
    const payloadDecision: PermissionDecisionSource = integrity.requires_manual_confirmation
      ? {
          source: "payload_integrity",
          decision: risk.level === "L0" || manualConfirmed ? "constrained" : "ask",
          reason: risk.level === "L0"
            ? "Read-only payload contains suspicious Unicode and may proceed only as an audited read."
            : manualConfirmed
              ? "Suspicious Unicode was explicitly confirmed in the bound authorization payload."
              : "Suspicious Unicode requires confirmation of the exact displayed payload before execution.",
          constraints: integrity.unicode_findings.map((item) => `${item.code}:${item.path}`)
        }
      : integrity.requires_warning
        ? {
            source: "payload_integrity",
            decision: "constrained",
            reason: "Unicode normalization changes are recorded and the raw payload remains authoritative.",
            constraints: integrity.unicode_findings.map((item) => `${item.code}:${item.path}`)
          }
        : {
            source: "payload_integrity",
            decision: "allow",
            reason: "No Unicode or invisible-character risk was found in the execution payload."
          };
    const destructiveHint = definition.annotations && typeof definition.annotations === "object"
      ? definition.annotations.destructiveHint === true
      : false;
    return mergePermissionDecisions([
      ...embeddedSources,
      permissionSourceFromRisk(risk),
      payloadDecision,
      {
        source: "runtime_policy",
        decision: destructiveHint && risk.level === "L3" ? "deny" : "allow",
        reason: destructiveHint && risk.level === "L3"
          ? "Runtime policy prohibits automatic execution of a destructive L3 tool call."
          : "Runtime policy does not broaden the task, risk, hook, or payload decisions."
      }
    ]);
  }

  function authorizationEventData(
    integrity: AuthorizationPayloadIntegrityV1,
    permission: MonotonicPermissionDecision,
    binding: AuthorizationPayloadBindingV1
  ): Record<string, unknown> {
    return {
      authorization_payload: authorizationPayloadAuditSummary(integrity),
      authorization_binding: {
        binding_id: binding.binding_id,
        payload_version: binding.payload_version,
        scope: binding.scope,
        raw_hash: binding.raw_hash,
        normalized_hash: binding.normalized_hash,
        approved_payload_hash: binding.approved_payload_hash,
        executed_payload_hash: binding.executed_payload_hash,
        approved_by: binding.approved_by,
        approved_at: binding.approved_at,
        manual_confirmation: binding.manual_confirmation,
        finding_codes: binding.finding_codes
      },
      permission_decision: {
        decision_id: permission.decision_id,
        final_decision: permission.final_decision,
        constraints: permission.constraints,
        reasons: permission.reasons,
        evidence_refs: permission.evidence_refs,
        audit_hash: permission.audit_hash,
        sources: permission.sources
      }
    };
  }

  function toolEventData(
    name: string,
    args: any,
    definition: CoreToolDefinition,
    risk: UnifiedRiskDecision,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const annotations = definition.annotations && typeof definition.annotations === "object"
      ? definition.annotations
      : {};
    return {
      tool: name,
      argument_keys: args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args).sort() : [],
      read_only_hint: annotations.readOnlyHint === true,
      destructive_hint: annotations.destructiveHint === true,
      risk_level: risk.level,
      risk_reason_code: risk.reason_code,
      capability_side_effect_level: risk.capability_side_effect_level,
      effective_side_effect_level: risk.effective_side_effect_level,
      effective_operations: risk.effective_operations,
      effective_paths: risk.effective_paths,
      effective_external_targets: risk.effective_external_targets,
      risk_argument_paths: risk.matched_argument_paths,
      risk_signal_matches: risk.signal_matches.map((match) => ({
        signal: match.signal,
        argument_path: match.argument_path,
        role: match.role
      })),
      side_effect: risk.side_effect,
      side_effects: risk.side_effects.map((descriptor) => ({
        action: descriptor.action,
        target: descriptor.target,
        scope: descriptor.scope,
        authorization: descriptor.authorization,
        reversibility: descriptor.reversibility,
        source_paths: descriptor.source_paths,
        signals: descriptor.signals
      })),
      checkpoint_required: risk.checkpoint_required,
      explicit_authorization_required: risk.explicit_authorization_required,
      authorization_detected: risk.authorization_detected,
      automatic_replay_allowed: risk.automatic_replay_allowed,
      risk_signals: risk.matched_signals,
      ...extra
    };
  }

  function registerToolCompat(
    server: McpServer,
    config: CodexProConfig,
    registration: CoreToolRegistration,
    riskObservabilityEnabled = true,
    riskInputRolesEnabled = true,
    publish = true
  ): CodexToolHandler {
    const { definition, handler } = registration;
    const name = definition.name;
    const contract = definition.contract ?? buildToolContract(name, definition.description ?? "");
    const fullWrapped = async (args: any, extra?: CoreToolRequestContext) => {
      const requestedWorkspace = workspaceForToolCall(
        server,
        config,
        args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}
      );
      const authoritativeWorkspace = requestedWorkspace ?? workspaceForToolCall(server, config, {
        ...(typeof args.conversation_id === "string" && args.conversation_id.trim()
          ? { conversation_id: args.conversation_id.trim() }
          : {})
      });
      const workspaceArgumentBinding = bindAuthoritativeWorkspaceArguments(args, contract, authoritativeWorkspace);
      args = workspaceArgumentBinding.args;
      const evaluatedWorkspaceId = workspaceArgumentBinding.workspace?.id ?? null;
      const evaluatedWorkspaceGeneration = Number.isInteger(workspaceArgumentBinding.workspace?.workspaceGeneration)
        ? Number(workspaceArgumentBinding.workspace?.workspaceGeneration)
        : null;
      const correlationId = extra?.mcp?.trace.traceId ?? randomUUID();
      const mcpEventContext = extra?.mcp ? {
        mcp_protocol_version: extra.mcp.protocolVersion,
        mcp_method: extra.mcp.method,
        mcp_name: extra.mcp.name ?? name,
        request_id: extra.mcp.requestId,
        trace_id: extra.mcp.trace.traceId,
        parent_span_id: extra.mcp.trace.parentSpanId ?? null,
        workspace_id: extra.mcp.workspaceId ?? null,
        workspace_generation: extra.mcp.workspaceGeneration ?? null,
        task_id: extra.mcp.taskId ?? null,
        run_id: extra.mcp.runId ?? null,
        attempt_id: extra.mcp.attemptId ?? null,
        browser_id: extra.mcp.browserId ?? null,
        actor_id: extra.mcp.actorId ?? null,
        actor_role: extra.mcp.actorRole ?? null,
        app_session_id: extra.mcp.appSessionId ?? null,
        compatibility_mode: extra.mcp.compatibilityMode
      } : {};
      const fastPathWorkspace = workspaceForToolCall(server, config, args ?? {});
      const markdownFastPath = prepareMarkdownWriteFastPath(name, args, fastPathWorkspace);
      if (markdownFastPath) args = markdownFastPath.args;
      const execute = async (connectorRequest: GoldTaskConnectorRequestContext) => {
      const started = Date.now();
      const taskId = safeTaskIdFromArgs(args);
      const domainEvents = domainEventsForTool(name);
      const payloadIntegrity = analyzeAuthorizationPayload(args);
      const riskTarget = markdownFastPath
        ? { tool_name: "write", args: markdownFastPath.risk_args, wrapped: false }
        : riskEvaluationTargetForToolCall(name, args);
      const riskObservation = evaluateUnifiedRiskWithObservation(riskTarget.tool_name, riskTarget.args, {
        toolAwareInputs: riskInputRolesEnabled
      });
      const risk = riskObservation.decision;
      let permission = permissionForToolCall(risk, payloadIntegrity, args, definition);
      const embedded = embeddedAuthorizationDecision(args);
      const baseConfirmationScope = permissionConfirmationScopeForToolCall(
        name,
        args,
        extra?.mcp,
        workspaceForToolCall(server, config, args ?? {}),
        payloadIntegrity.raw_hash
      );
      let confirmationScope = baseConfirmationScope;
      let confirmationReceiptAccepted = false;
      let preExecutionDecision: PreExecutionDecisionV1 | null = null;
      let payloadBinding = createAuthorizationPayloadBindingFromIntegrity(payloadIntegrity, {
        payloadVersion: 1,
        scope: `tool_call:${name}`,
        approvedBy: risk.authorization_detected
          ? "user_authorization_evidence"
          : risk.level === "L0"
            ? "runtime_readonly_policy"
            : "task_and_runtime_policy",
        manualConfirmation: embedded?.payload_binding?.manual_confirmation === true
      });
      if (riskObservabilityEnabled) {
        try {
          recordRiskObservation(riskObservation, executionLaneFromArgs(args));
        } catch {
          // Observability must never block the tool success path.
        }
      }
      let outcome: "ok" | "error" = "error";
      let responseResult: any;
      let handlerStartedAtMs: number | undefined;
      let handlerCompletedAtMs: number | undefined;
      let resultSerializedAtMs: number | undefined;
      let activityBridge: DirectToolTaskBridge | null = null;
      let activityHandle: DirectToolActivityHandle | null = null;
      let pendingPublicToolOutcome: PublicToolOutcomeV1 | null = null;
      let workspaceBindingWarning: string | null = null;
      const authorizationAuditPolicy = authorizationAuditPersistencePolicy(contract, risk);
      const authorizationAuditReceipts: AuthorizationAuditPersistenceReceiptV1[] = [];
      try {
        if (extra?.signal?.aborted) throw new CodexProError(`${name} was aborted before execution.`);
        if (connectorRequest.budget_exceeded) {
          throw new CodexProError(
            `Gold Task Connector request budget exhausted (${connectorRequest.request_limit} requests allowed); `
            + `request ${connectorRequest.request_index} was blocked before handler execution.`
          );
        }
        enforceGoldTaskInternalForwardingBudget(config.defaultRoot, name);
        enforceGoldTaskExplorationBudget(config.defaultRoot, name);
        try {
          const bindingCheck = await assertToolWorkspaceBinding({
            config,
            workspace: workspaceArgumentBinding.workspace,
            contract,
            args: args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}
          });
          workspaceBindingWarning = bindingCheck.warning;
        } catch (error) {
          authorizationAuditReceipts.push(await persistAuthorizationAuditWithPolicy(config, {
            phase: "evaluated",
            correlationId,
            taskId,
            tool: name,
            risk,
            binding: payloadBinding,
            permission,
            outcome: "blocked"
          }, {
            version: 1,
            enabled: true,
            fail_closed: false,
            reason_code: "l0_security_exception_audit"
          }));
          throw error;
        }
        const permissionDispatches: PreExecutionPermissionDispatch[] = [];
        const before = await codexProEventBus.emit(
          "tool_before_call",
          toolEventData(name, args, definition, risk, { ...mcpEventContext, ...authorizationEventData(payloadIntegrity, permission, payloadBinding) }),
          { source: "mcp_tool", correlation_id: correlationId, ...(taskId ? { task_id: taskId } : {}) }
        );
        permissionDispatches.push({ source: "hook:tool_before_call", dispatch: before });
        if (domainEvents.before) {
          const domainBefore = await codexProEventBus.emit(
            domainEvents.before,
            toolEventData(name, args, definition, risk, { ...mcpEventContext, ...authorizationEventData(payloadIntegrity, permission, payloadBinding) }),
            { source: "mcp_tool", correlation_id: correlationId, ...(taskId ? { task_id: taskId } : {}) }
          );
          permissionDispatches.push({ source: `hook:${domainEvents.before}`, dispatch: domainBefore });
        }
        permission = mergePreExecutionPermissionDecisions(permission, permissionDispatches);
        confirmationScope = {
          ...baseConfirmationScope,
          permission_decision_hash: permission.audit_hash
        };
        const finalConfirmation = resolvePermissionConfirmation(
          permission,
          extra?.mcp?.confirmationReceipt,
          confirmationScope
        );
        if (!finalConfirmation.receipt_valid) {
          throw new CodexProError(`Confirmation receipt binding failed for ${name}: ${finalConfirmation.reasons.join(", ")}.`);
        }
        confirmationReceiptAccepted = finalConfirmation.receipt_applied;
        permission = finalConfirmation.decision;
        if (confirmationReceiptAccepted) {
          payloadBinding = createAuthorizationPayloadBindingFromIntegrity(payloadIntegrity, {
            payloadVersion: 1,
            scope: `tool_call:${name}`,
            approvedBy: "mcp_request_state_confirmation",
            manualConfirmation: true
          });
        }
        preExecutionDecision = createPreExecutionDecision({
          toolName: name,
          integrity: payloadIntegrity,
          workspaceId: evaluatedWorkspaceId,
          workspaceGeneration: evaluatedWorkspaceGeneration,
          risk,
          permission,
          confirmationReceiptId: confirmationReceiptAccepted ? extra?.mcp?.confirmationReceipt?.receipt_id ?? null : null,
          confirmationApplied: confirmationReceiptAccepted
        });
        if (!markdownFastPath) {
          authorizationAuditReceipts.push(await persistAuthorizationAuditWithPolicy(config, {
            phase: "evaluated",
            correlationId,
            taskId,
            tool: name,
            risk,
            binding: payloadBinding,
            permission,
            outcome: "pending"
          }, authorizationAuditPolicy));
        }
        assertPermissionOrRequestConfirmation(name, permission, confirmationScope);
        const coreCall = mcpAdapter.normalizeToolCall({ name, arguments: args });
        const executionWorkspace = workspaceForToolCall(
          server,
          config,
          coreCall.arguments && typeof coreCall.arguments === "object" && !Array.isArray(coreCall.arguments)
            ? coreCall.arguments as Record<string, unknown>
            : {}
        );
        assertPreExecutionDecision(preExecutionDecision, {
          payload: coreCall.arguments,
          workspace: executionWorkspace,
          permission,
          confirmationReceiptId: confirmationReceiptAccepted ? extra?.mcp?.confirmationReceipt?.receipt_id ?? null : null
        });
        payloadBinding = bindExecutedAuthorizationPayloadFromIntegrity(payloadIntegrity, payloadBinding, {
          requireManualConfirmation: risk.level !== "L0"
        });
        if (!markdownFastPath) {
          authorizationAuditReceipts.push(await persistAuthorizationAuditWithPolicy(config, {
            phase: "executing",
            correlationId,
            taskId,
            tool: name,
            risk,
            binding: payloadBinding,
            permission,
            outcome: "pending"
          }, authorizationAuditPolicy));
        }
        const activityPlan = markdownFastPath ? null : classifyDirectToolActivity(name, coreCall.arguments);
        if (activityPlan) {
          try {
            activityBridge = directToolBridge(server, config, coreCall.arguments);
            activityHandle = activityBridge ? await activityBridge.begin(name, coreCall.arguments, correlationId, activityPlan) : null;
          } catch {
            activityBridge = null;
            activityHandle = null;
          }
        }
        handlerStartedAtMs = Date.now();
        const handlerResult = await handler(coreCall, { signal: extra?.signal, mcp: extra?.mcp });
        handlerCompletedAtMs = Date.now();
        responseResult = mcpAdapter.serializeToolResult(tagToolResult(handlerResult, name, definition, config, {
          handlerInvoked: true,
          handlerSucceeded: true
        }));
        resultSerializedAtMs = Date.now();
        outcome = responseResult.isError ? "error" : "ok";
        logToolCall(name, outcome, started);
      } catch (error) {
        if (handlerStartedAtMs !== undefined && handlerCompletedAtMs === undefined) handlerCompletedAtMs = Date.now();
        if (error instanceof PermissionConfirmationRequiredError) {
          responseResult = tagToolResult(mcpAdapter.serializeToolResult(error.result), name, definition, config, {
            handlerInvoked: false,
            handlerSucceeded: false
          });
          outcome = "ok";
          logToolCall(name, "ok", started);
        } else {
          if (authorizationAuditReceipts.length === 0) {
            authorizationAuditReceipts.push(await persistAuthorizationAuditWithPolicy(config, {
              phase: "evaluated",
              correlationId,
              taskId,
              tool: name,
              risk,
              binding: payloadBinding,
              permission,
              outcome: "blocked"
            }, {
              version: 1,
              enabled: true,
              fail_closed: false,
              reason_code: "l0_security_exception_audit"
            }));
          }
          responseResult = tagToolResult(mcpAdapter.serializeError(error), name, definition, config, {
            handlerInvoked: handlerStartedAtMs !== undefined,
            handlerSucceeded: false
          });
          outcome = "error";
          logToolCall(name, "error", started);
        }
        resultSerializedAtMs = Date.now();
      }
      responseResult = normalizeFormalEvidenceFields(name, args, responseResult);
      if (authorizationAuditReceipts.length > 0) {
        const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
          ? responseResult.structuredContent as Record<string, unknown>
          : {};
        const status = authorizationAuditReceipts.some((receipt) => receipt.status === "degraded")
          ? "degraded"
          : authorizationAuditReceipts.some((receipt) => receipt.status === "queued")
            ? "queued"
            : "persisted";
        responseResult.structuredContent = safeStructuredContent({
          ...structured,
          authorization_audit: {
            status,
            fail_closed: authorizationAuditPolicy.fail_closed,
            reason_code: authorizationAuditPolicy.reason_code,
            phases: authorizationAuditReceipts
          }
        });
      }
      if (markdownFastPath) {
        const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
          ? responseResult.structuredContent as Record<string, unknown>
          : {};
        responseResult.structuredContent = safeStructuredContent({
          ...structured,
          fast_path: {
            kind: markdownFastPath.kind,
            context_auto_bound: markdownFastPath.context_auto_bound,
            content_risk_scan: markdownFastPath.content_risk_scan,
            office_projection: markdownFastPath.office_projection
          }
        });
      }
      let canonicalOutcome: ReturnType<typeof deriveOrthogonalToolOutcome> | null = null;
      {
        const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
          ? responseResult.structuredContent as Record<string, unknown>
          : {};
        const structuredReasonCode = typeof structured.reason_code === "string" && structured.reason_code.trim()
          ? structured.reason_code.trim()
          : null;
        canonicalOutcome = deriveOrthogonalToolOutcome({
          outcome,
          result: responseResult,
          operation_type: contract.operation_type,
          tool_category: contract.tool_category,
          handler_invoked: handlerStartedAtMs !== undefined,
          permission_decision_id: permission.decision_id,
          permission_final_decision: permission.final_decision,
          effective_side_effect_level: risk.effective_side_effect_level,
          confirmation_receipt_id: confirmationReceiptAccepted ? extra?.mcp?.confirmationReceipt?.receipt_id ?? null : null,
          tool_schema_digest: coreToolSchemaDigest(server),
          retryable: handlerStartedAtMs === undefined ? risk.retryable : undefined,
          reason_code: structuredReasonCode ?? (outcome === "error" ? risk.reason_code : null)
        });
        const existingToolResult = structured.tool_result && typeof structured.tool_result === "object" && !Array.isArray(structured.tool_result)
          ? structured.tool_result as Record<string, unknown>
          : null;
        const preExecutionSummary = preExecutionDecision ? {
          pre_execution_decision_id: preExecutionDecision.decision_id,
          payload_analysis_count: preExecutionDecision.payload_analysis_count,
          pre_execution_decision: {
            decision_id: preExecutionDecision.decision_id,
            audit_hash: preExecutionDecision.audit_hash,
            payload_analysis_count: preExecutionDecision.payload_analysis_count,
            final_permission: preExecutionDecision.final_permission,
            permission_decision_id: preExecutionDecision.permission_decision_id,
            workspace_generation: preExecutionDecision.workspace_generation,
            confirmation_receipt_id: preExecutionDecision.confirmation_receipt_id,
            reason_codes: preExecutionDecision.reason_codes
          }
        } : {};
        responseResult.structuredContent = safeStructuredContent({
          ...structured,
          canonical_outcome: canonicalOutcome,
          ...canonicalOutcome,
          ...preExecutionSummary,
          ...(existingToolResult ? {
            tool_result: {
              ...existingToolResult,
              canonical_outcome: canonicalOutcome,
              ...canonicalOutcome,
              ...preExecutionSummary,
              status: toolStatusFromOrthogonal(canonicalOutcome)
            }
          } : {})
        });
      }
      let activityBinding: DirectToolActivityBinding | null = null;
      if (activityBridge && activityHandle) {
        try {
          activityBinding = await activityBridge.finish(activityHandle, { outcome, result: responseResult });
          const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
            ? responseResult.structuredContent as Record<string, unknown>
            : {};
          responseResult.structuredContent = safeStructuredContent({
            ...structured,
            ...(activityBinding.observer_only ? { observer_binding: activityBinding } : { direct_task_binding: activityBinding })
          });
        } catch {
          // Direct task observability must never replace the actual tool result.
        }
      }
      if (!activityBridge) {
        try {
          activityBridge = directToolBridgeForWorkspace(server, config, workspaceArgumentBinding.workspace)
            ?? directToolBridge(server, config, args);
        } catch {
          activityBridge = directToolBridgeForWorkspace(server, config, workspaceArgumentBinding.workspace);
        }
      }
      if (activityBridge) {
        try {
          const projectionCompletedAtMs = Date.now();
          pendingPublicToolOutcome = activityBridge.preparePublicToolOutcome(activityHandle, activityBinding, {
            tool_name: name,
            correlation_id: correlationId,
            args,
            outcome,
            result: responseResult,
            canonical_outcome: canonicalOutcome ?? deriveOrthogonalToolOutcome({ outcome, result: responseResult, operation_type: contract.operation_type, tool_category: contract.tool_category }),
            started_at: new Date(handlerStartedAtMs ?? started).toISOString(),
            completed_at: new Date(handlerCompletedAtMs ?? projectionCompletedAtMs).toISOString(),
            duration_ms: Math.max(0, projectionCompletedAtMs - (handlerStartedAtMs ?? started))
          });
          const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
            ? responseResult.structuredContent as Record<string, unknown>
            : {};
          responseResult.structuredContent = safeStructuredContent({
            ...structured,
            office_projection_receipt: activityBridge.queuedPublicToolOutcomeReceipt(pendingPublicToolOutcome)
          });
        } catch {
          pendingPublicToolOutcome = null;
          // Public Office projection is derived observability and must never replace the real tool result.
        }
      }
      const wrapperCompletedAtMs = Date.now();
      attachWorkspaceOpenServerTiming(responseResult, name, {
        requestReceivedAtMs: started,
        handlerStartedAtMs,
        handlerCompletedAtMs,
        resultSerializedAtMs,
        wrapperCompletedAtMs
      });
      const envelopeWorkspace = workspaceForToolCall(server, config, args ?? {}) ?? workspaceArgumentBinding.workspace;
      const workspaceWarning = workspaceBindingWarning ?? (contract.compatibility_workspace_warning && typeof args?.workspace_id !== "string"
        ? `${name} 本次通过兼容路径使用了会话工作区；请在迁移期内显式传入 workspace_id。`
        : null);
      const structuredBeforeEnvelope = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
        ? responseResult.structuredContent as Record<string, unknown>
        : {};
      const envelope = createToolResultEnvelope({
        contract,
        trace_id: correlationId,
        workspace: envelopeWorkspace,
        result: { ...responseResult, structuredContent: structuredBeforeEnvelope },
        outcome,
        started_at: new Date(started).toISOString(),
        finished_at: new Date(wrapperCompletedAtMs).toISOString(),
        duration_ms: wrapperCompletedAtMs - started,
        task_id: activityBinding && !activityBinding.observer_only ? activityBinding.task_id : taskId ?? null,
        stage_id: activityBinding && !activityBinding.observer_only ? activityBinding.phase : null,
        attempt_id: activityBinding && !activityBinding.observer_only ? activityBinding.task_id : null,
        executor_id: activityHandle && !activityHandle.observer_only ? activityHandle.actor_id : null,
        owner_id: activityHandle && !activityHandle.observer_only ? activityHandle.worker_id : null,
        workspace_warning: workspaceWarning,
        canonical_outcome: canonicalOutcome ?? deriveOrthogonalToolOutcome({ outcome, result: responseResult, operation_type: contract.operation_type, tool_category: contract.tool_category })
      });
      responseResult.structuredContent = safeStructuredContent({
        ...structuredBeforeEnvelope,
        tool_result: envelope
      });
      const durationMs = wrapperCompletedAtMs - started;
      const terminalPhase: AuthorizationAuditPhase = outcome === "ok"
        ? "completed"
        : payloadBinding.executed_payload_hash
          ? "failed"
          : "blocked";
      const eventData = toolEventData(name, args, definition, risk, {
        ...mcpEventContext,
        ...authorizationEventData(payloadIntegrity, permission, payloadBinding),
        outcome,
        duration_ms: durationMs,
        handler_started_at: handlerStartedAtMs ? new Date(handlerStartedAtMs).toISOString() : null,
        handler_returned_at: handlerCompletedAtMs ? new Date(handlerCompletedAtMs).toISOString() : null,
        result_serialized_at: resultSerializedAtMs ? new Date(resultSerializedAtMs).toISOString() : null,
        tool_returned_at: new Date(wrapperCompletedAtMs).toISOString()
      });
      recordGoldTaskConnectorCall({
        workspace_root: config.defaultRoot,
        correlation_id: correlationId,
        tool_name: name,
        request_task_id: taskId ?? null,
        started_at_ms: started,
        finished_at_ms: wrapperCompletedAtMs,
        outcome,
        handler_invoked: handlerStartedAtMs !== undefined,
        handler_succeeded: handlerCompletedAtMs !== undefined && outcome === "ok",
        risk_level: risk.level,
        side_effect: risk.side_effect,
        result: responseResult
      });
      setTimeout(() => {
        void (async () => {
          try {
            if (activityBridge && pendingPublicToolOutcome) {
              await activityBridge.publishPreparedPublicToolOutcome(pendingPublicToolOutcome);
            }
          await persistAuthorizationAuditWithPolicy(config, {
            phase: terminalPhase,
            correlationId,
            taskId,
            tool: name,
            risk,
            binding: payloadBinding,
            permission,
            outcome: outcome === "ok" ? "ok" : terminalPhase === "blocked" ? "blocked" : "error",
            durationMs
          }, { ...authorizationAuditPolicy, fail_closed: false, reason_code: `${authorizationAuditPolicy.reason_code}_terminal_async` });
          await codexProEventBus.emit(
            "tool_after_call",
            eventData,
            { source: "mcp_tool", correlation_id: correlationId, ...(taskId ? { task_id: taskId } : {}) }
          );
          if (domainEvents.after) {
            await codexProEventBus.emit(
              domainEvents.after,
              eventData,
              { source: "mcp_tool", correlation_id: correlationId, ...(taskId ? { task_id: taskId } : {}) }
            );
          }
          } catch {
            // Terminal audit and after-call events are durable observability work; they must not delay the tool response.
          }
        })();
      }, 0);
      return responseResult;
      };
      return await withGoldTaskConnectorRequest({
        workspace_root: config.defaultRoot,
        connector_request_id: correlationId
      }, execute);
    };

    const staticReadFastPathEligible = contract.side_effect_level === "none"
      && contract.requires_confirmation === false
      && contract.requires_resource_lease === false
      && contract.read_fast_path_eligible === true;
    const wrapped: CodexToolHandler = async (rawArgs: any, extra?: CoreToolRequestContext) => {
      const aggregateClassification = classifyAggregateToolCall(name, rawArgs);
      const aggregateReadFastPathEligible = isZeroWriteAnalysisOnlyAggregateCall(name, rawArgs);
      if (!staticReadFastPathEligible && !aggregateReadFastPathEligible) return await fullWrapped(rawArgs, extra);
      const effectiveContract: typeof contract = aggregateReadFastPathEligible ? {
        ...contract,
        tool_category: "project_read",
        operation_type: "read",
        side_effect_level: "none",
        approval_required: false,
        requires_confirmation: false,
        requires_resource_lease: false,
        read_fast_path_eligible: true,
        evidence_types: []
      } : contract;
      const startedAtMs = Date.now();
      const correlationId = extra?.mcp?.trace.traceId ?? randomUUID();
      try {
        if (extra?.signal?.aborted) throw new CodexProError(`${name} was aborted before execution.`);
        const suppliedArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? rawArgs as Record<string, unknown>
          : {};
        const requestedWorkspace = workspaceForToolCall(server, config, suppliedArgs);
        const authoritativeWorkspace = requestedWorkspace ?? workspaceForToolCall(server, config, {
          ...(typeof suppliedArgs.conversation_id === "string" && suppliedArgs.conversation_id.trim()
            ? { conversation_id: suppliedArgs.conversation_id.trim() }
            : {})
        });
        const workspaceArgumentBinding = bindAuthoritativeWorkspaceArguments(suppliedArgs, effectiveContract, authoritativeWorkspace);
        const args = workspaceArgumentBinding.args;
        const bindingCheck = await assertToolWorkspaceBinding({
          config,
          workspace: workspaceArgumentBinding.workspace,
          contract: effectiveContract,
          args
        });
        const coreCall = mcpAdapter.normalizeToolCall({ name, arguments: args });
        const handlerStartedAtMs = Date.now();
        const handlerResult = await withProcessTrackingSuppressed(async () =>
          await handler(coreCall, { signal: extra?.signal, mcp: extra?.mcp })
        );
        const handlerCompletedAtMs = Date.now();
        let responseResult = mcpAdapter.serializeToolResult(tagToolResult(handlerResult, name, definition, config, {
          handlerInvoked: true,
          handlerSucceeded: true
        }));
        const resultSerializedAtMs = Date.now();
        if (responseResult?.isError === true) return await fullWrapped(rawArgs, extra);
        responseResult = normalizeFormalEvidenceFields(name, args, responseResult);
        const wrapperCompletedAtMs = Date.now();
        const structured = responseResult?.structuredContent && typeof responseResult.structuredContent === "object" && !Array.isArray(responseResult.structuredContent)
          ? responseResult.structuredContent as Record<string, unknown>
          : {};
        const fastPathKind = aggregateReadFastPathEligible ? "analysis_only_aggregate" : "l0_read";
        const fastPathReason = aggregateReadFastPathEligible
          ? aggregateClassification?.reason_code ?? "analysis_only_read_shape"
          : "explicit_contract_allowlist";
        const orthogonal = {
          security_status: "allowed" as const,
          resource_status: "not_required" as const,
          execution_status: "completed" as const,
          recovery_status: "not_required" as const,
          validation_status: "not_requested" as const,
          delivery_status: "not_requested" as const,
          permission_decision_id: null,
          effective_side_effect_level: "none",
          resource_lease_id: null,
          workspace_baseline_id: null,
          confirmation_receipt_id: null,
          tool_schema_digest: coreToolSchemaDigest(server),
          retryable: false,
          reason_code: aggregateReadFastPathEligible ? "analysis_only_aggregate" : "l0_read_fast_path",
          state_authority: "handler_explicit" as const
        };
        const serverTiming = {
          request_received_at: new Date(startedAtMs).toISOString(),
          handler_started_at: new Date(handlerStartedAtMs).toISOString(),
          handler_completed_at: new Date(handlerCompletedAtMs).toISOString(),
          result_serialized_at: new Date(resultSerializedAtMs).toISOString(),
          wrapper_completed_at: new Date(wrapperCompletedAtMs).toISOString(),
          policy_ms: Math.max(0, handlerStartedAtMs - startedAtMs),
          handler_ms: Math.max(0, handlerCompletedAtMs - handlerStartedAtMs),
          serialization_ms: Math.max(0, resultSerializedAtMs - handlerCompletedAtMs),
          finalization_ms: Math.max(0, wrapperCompletedAtMs - resultSerializedAtMs),
          total_server_ms: Math.max(0, wrapperCompletedAtMs - startedAtMs)
        };
        const envelope = createToolResultEnvelope({
          contract: effectiveContract,
          trace_id: correlationId,
          workspace: authoritativeWorkspace,
          result: { ...responseResult, structuredContent: structured },
          outcome: "ok",
          started_at: new Date(startedAtMs).toISOString(),
          finished_at: new Date(wrapperCompletedAtMs).toISOString(),
          duration_ms: wrapperCompletedAtMs - startedAtMs,
          task_id: safeTaskIdFromArgs(args),
          workspace_warning: bindingCheck.warning,
          canonical_outcome: orthogonal
        });
        const metricReceipt = recordL0ReadObservation({ tool_name: name, duration_ms: wrapperCompletedAtMs - startedAtMs, outcome: "success" });
        responseResult.structuredContent = safeStructuredContent({
          ...structured,
          canonical_outcome: orthogonal,
          ...orthogonal,
          server_timing: serverTiming,
          read_fast_path: {
            version: 1,
            kind: fastPathKind,
            reason_code: fastPathReason,
            persistent_observability: "omitted_on_success",
            observability: metricReceipt,
            contract: {
              side_effect_level: effectiveContract.side_effect_level,
              requires_confirmation: effectiveContract.requires_confirmation,
              requires_resource_lease: effectiveContract.requires_resource_lease,
              read_fast_path_eligible: effectiveContract.read_fast_path_eligible
            }
          },
          tool_result: {
            ...envelope,
            canonical_outcome: orthogonal,
            ...orthogonal,
            status: "completed"
          }
        });
        logToolCall(name, "ok", startedAtMs);
        return responseResult;
      } catch {
        recordL0ReadObservation({ tool_name: name, duration_ms: Date.now() - startedAtMs, outcome: "fallback" });
        return await fullWrapped(rawArgs, extra);
      }
    };
  
    if (!publish) return wrapped;

    const fullOptions = mcpAdapter.serializeToolDefinition(definition, config);
  
    const s = server as any;
    if (typeof s.registerTool === "function") {
      s.registerTool(name, fullOptions, wrapped);
      return wrapped;
    }
  
    if (typeof s.tool === "function") {
      s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
      return wrapped;
    }
  
    throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
  }
  
  const registeredToolNamesByServer = new WeakMap<object, string[]>();
  
  function rememberRegisteredTool(server: McpServer, name: string): void {
    const key = server as object;
    const names = registeredToolNamesByServer.get(key) ?? [];
    if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
    if (!names.includes(name)) names.push(name);
  }
  
  function registeredToolNames(server: McpServer): string[] {
    return [...(registeredToolNamesByServer.get(server as object) ?? [])];
  }
  
  function registerCodexTool(
    config: CodexProConfig,
    server: McpServer,
    name: string,
    options: Record<string, unknown>,
    handler: CodexToolHandler
  ): void {
    const normalizedOptions = optionsWithContractInputs(name, options);
    const definition = coreToolDefinitionFromOptions(name, normalizedOptions);
    const validatedHandler: CodexToolHandler = (args, context) => handler(validateToolArgs(name, normalizedOptions, args), context);
    const registration = rememberCoreTool(server, definition, validatedHandler);
    const publish = shouldRegisterTool(config, name);
    const wrapped = registerToolCompat(
      server,
      config,
      registration,
      config.riskObservabilityEnabled,
      config.riskInputRolesEnabled,
      publish
    );
    rememberPolicyWrappedToolHandler(server, name, wrapped);
    if (!publish) return;
    rememberRegisteredTool(server, name);
  }

  function setServerWorkspaceResolver(server: McpServer, resolver: (input: ToolWorkspaceResolutionInput) => Workspace): void {
    workspaceResolversByServer.set(server as object, resolver);
  }
  
  function serverInstructions(config: CodexProConfig): string {
    const editInstruction =
      config.writeMode === "workspace"
        ? config.toolMode === "progressive"
          ? "5. Apply all currently known source edits in one apply_patch_bundle call and include the original user request as task_instruction so Task Router can enforce write intent. Do not route visible write actions through codexpro. After edits, call show_changes once for status, diff stats, and review diff."
          : "5. Edit source files with write/edit. After edits, call show_changes once for git status, diff stats, and review diff."
        : config.writeMode === "handoff"
          ? "5. Source writes are disabled and generic write/edit tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
          : "5. Write/edit tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
    const bashInstruction =
      config.bashMode === "off"
        ? "6. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
        : config.toolMode === "progressive"
          ? "6. Run all known verification commands together in one run_validation call. Long builds and test suites may return a durable run_id immediately; then use run_task_status and read_run_task_result instead of repeating the command. If a synchronous check succeeds and show_changes is already reviewed, answer the user without another Connector call."
          : "6. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script. Long verification commands may return a durable run_id; check that run instead of starting the same command again.";
    const inspectionInstruction = config.toolMode === "progressive"
      ? "4. Inspect efficiently: make at most one batched search_project call with all currently known terms, then one read_many_files call for returned paths. Repeat search only when the response is partial or a newly read identifier requires it. Do not wrap these visible tools with codexpro."
      : "4. Inspect with tree, search, and read. Use show_changes or git_summary only when Git state is needed. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.";
  
    return [
      "CodexPro connects ChatGPT to one local development workspace.",
      config.skillsEnabled ? EXPLICIT_SKILL_LOADING_INSTRUCTION : "",
      "",
      "Preferred workflow:",
      "1. Standalone Git terminal requests such as 提交推送 or commit and push use Direct Tool Invocation: call the first-class git_finalize tool exactly once from the startup-cached schema, pass the original user wording as user_intent, and set include_push=true when push is requested. Reuse evidence already produced by the current task. The finalization path may only confirm the current Git change scope, isolate unrelated/untracked/sensitive files, commit, verify the committed path set, and push. It must never rerun build, tests, browser validation, Acceptance, or formal certification; a stale or missing Acceptance receipt is advisory and must not trigger or require a rerun. Never route this path through codexpro, commit_assistant, git_prepare, show_changes, run_acceptance, run_task, workspace opening, Search, search_project, documentation lookup, tool-instruction reads, read_rule_summary, or git_summary before dispatch.",
      "2. When the user's only requested side effect is saving already-prepared content to an ordinary Markdown file, call the first-class write tool exactly once with path and content. Do not open the workspace, inspect files, read rules, call show_changes, use bash/Node, or route the write through codexpro. The Markdown Fast Path automatically binds the current authoritative conversation workspace and generation, treats content as static text, and projects the outcome asynchronously. Control/security Markdown and task-bound writes automatically fall back to the full path.",
      "3. For all other tasks, start with open_current_workspace. The fast open path restores the configured Active Workspace Authority when allowed and returns the workspace identity without blocking on Git, project rules, memory, or AGENTS discovery. Tools without workspace_id use this server conversation's workspace binding, then the global active workspace only when the conversation has no binding. Before editing files or making project decisions, call read_rule_summary and follow the returned AGENTS.md, project.yml, and project-memory rules; workspace open intentionally reports preflight as deferred.",
      inspectionInstruction,
      editInstruction,
      bashInstruction,
      "7. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
      "8. task_complete is normally an optional local desktop notification helper. In an active Gold Task session it also runs the mandatory file/validation/Git/control-repository completion check and supplies the supervisor completion signal; call it exactly once after final verification, and follow its remediation message if rejected. Outside Gold Tasks, a normal final MCP response does not require it.",
      config.codexSessions !== "off"
        ? `9. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
        : "",
      config.requireBashSession && config.bashSessionId
        ? `10. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
        : config.bashSessionId
          ? `10. Bash session label for this server is "${config.bashSessionId}".`
          : "",
      "",
      `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
    ].filter(Boolean).join("\n");
  }
  
  
  return {
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
  };
}
