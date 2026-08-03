import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodexProConfig } from "../../config.js";
import { createCodexProServer, invokeCodexProTool, listCodexProToolDefinitions } from "../../server.js";
import type { CoreToolDefinition, CoreToolResult } from "../../server/coreToolRegistry.js";
import { createPermissionConfirmationReceipt } from "../../security/confirmationReceipt.js";
import { McpProtocolError } from "../protocolAdapter.js";
import { createMcpProfileV3Adapter } from "../profiles/v3.js";
import { listModernMcpApps } from "./apps.js";
import { modernMcpAppSessionStore } from "./appSession.js";
import { cachePolicyForModernMethod, ModernMcpResponseCache, withCacheMetadata } from "./cache.js";
import { modernMcpIdempotencyStore } from "./idempotency.js";
import { modernMcpMetrics } from "./metrics.js";
import { protectedResourceMetadata, validateModernOAuthHeaders } from "./oauth.js";
import {
  confirmationGranted,
  mergeArgumentInputResponses,
  missingRequiredInputRequests
} from "./mrtr.js";
import type { PermissionConfirmationScopeV1 } from "../../security/confirmationReceipt.js";
import {
  bindCanonicalContextToToolArguments,
  buildCanonicalMcpRequestContext,
  modernResponseMeta,
  type CanonicalMcpRequestContext,
  type McpHeaderMap
} from "./requestContext.js";
import { hashMcpArguments, RequestStateCodec } from "./requestState.js";
import { modernMcpSubscriptionHub } from "./subscriptionHub.js";
import { handleTasksExtensionMethod, isMutatingTasksExtensionMethod, isTasksExtensionMethod } from "./tasksExtension.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "../../toolCardWidget.js";

const adapter = createMcpProfileV3Adapter();
const responseCache = new ModernMcpResponseCache();
const runtimeCache = new WeakMap<CodexProConfig, Promise<{ server: McpServer; definitions: CoreToolDefinition[] }>>();
let stateCodec: RequestStateCodec | undefined;
let stateKeyDigest: string | undefined;

export interface ModernMcpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRpcId(body: unknown): string | number | null {
  const id = asRecord(body).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function stateCodecFor(config: CodexProConfig): RequestStateCodec {
  const configValue = config.mcpRequestStateSecret;
  if (!configValue) throw new McpProtocolError("MRTR is enabled but no request-state key material is configured.", -32002);
  const digest = createHash("sha256").update(configValue).digest("hex");
  if (!stateCodec || stateKeyDigest !== digest) {
    stateCodec = new RequestStateCodec(configValue);
    stateKeyDigest = digest;
  }
  return stateCodec;
}

function rolloutBucket(context: CanonicalMcpRequestContext): number {
  const subject = context.clientId ?? context.actorId ?? context.requestId;
  const digest = createHash("sha256").update(subject).digest();
  return digest.readUInt32BE(0) % 100;
}

export function modernMcpRolloutAllows(config: CodexProConfig, context: CanonicalMcpRequestContext): boolean {
  if (!config.mcp20260728Enabled) return false;
  if (config.mcp20260728RolloutPercent >= 100) return true;
  if (config.mcp20260728RolloutPercent <= 0) return false;
  return rolloutBucket(context) < config.mcp20260728RolloutPercent;
}

function responseTraceparent(context: CanonicalMcpRequestContext): string {
  return `00-${context.trace.traceId}-${randomBytes(8).toString("hex")}-01`;
}

function responseHeaders(context: CanonicalMcpRequestContext, policy = cachePolicyForModernMethod(context.method)): Record<string, string> {
  const cacheControl = policy.ttlMs > 0
    ? `${policy.cacheScope === "public" ? "public" : "private"}, max-age=${Math.floor(policy.ttlMs / 1000)}`
    : "private, no-store";
  return {
    "content-type": "application/json",
    "mcp-protocol-version": context.protocolVersion,
    "mcp-request-id": context.requestId,
    traceparent: responseTraceparent(context),
    "cache-control": cacheControl,
    vary: "authorization, mcp-protocol-version, mcp-client-id, mcp-actor-id, mcp-workspace-id"
  };
}

function success(
  requestBody: unknown,
  context: CanonicalMcpRequestContext,
  result: Record<string, unknown>,
  policy = cachePolicyForModernMethod(context.method)
): ModernMcpHttpResponse {
  return {
    status: 200,
    headers: responseHeaders(context, policy),
    body: {
      jsonrpc: "2.0",
      id: jsonRpcId(requestBody),
      result: withCacheMetadata({
        ...result,
        _meta: {
          ...asRecord(result._meta),
          ...modernResponseMeta(context)
        }
      }, policy)
    }
  };
}

function failure(requestBody: unknown, context: CanonicalMcpRequestContext | undefined, error: unknown): ModernMcpHttpResponse {
  const serialized = adapter.serializeProtocolError(error);
  const fallbackContext = context ?? buildCanonicalMcpRequestContext({}, {
    jsonrpc: "2.0",
    id: jsonRpcId(requestBody),
    method: "server/discover"
  });
  return {
    status: serialized.code === -32001 ? 401 : serialized.code === -32003 ? 426 : 200,
    headers: responseHeaders(fallbackContext),
    body: {
      jsonrpc: "2.0",
      id: jsonRpcId(requestBody),
      error: {
        ...serialized,
        data: {
          ...serialized.data,
          ...modernResponseMeta(fallbackContext)
        }
      }
    }
  };
}

function definitionReadOnly(definition: CoreToolDefinition | undefined): boolean {
  return definition?.annotations?.readOnlyHint === true || ["read", "search"].includes(definition?.contract?.operation_type ?? "");
}

function definitionRequiresIdempotency(definition: CoreToolDefinition | undefined): boolean {
  if (!definition) return true;
  if (definitionReadOnly(definition)) return false;
  return definition.contract?.side_effect_level !== "none";
}

async function runtimeFor(config: CodexProConfig): Promise<{ server: McpServer; definitions: CoreToolDefinition[] }> {
  const cached = runtimeCache.get(config);
  if (cached) return cached;
  const created = Promise.resolve().then(() => {
    const server = createCodexProServer(config);
    return { server, definitions: listCodexProToolDefinitions(server) };
  });
  runtimeCache.set(config, created);
  try {
    return await created;
  } catch (error) {
    runtimeCache.delete(config);
    throw error;
  }
}

async function invokeTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  context: CanonicalMcpRequestContext
): Promise<CoreToolResult> {
  return invokeCodexProTool(server, name, bindCanonicalContextToToolArguments(args, context), { mcp: context });
}

function serializedToolResult(result: CoreToolResult, context: CanonicalMcpRequestContext): Record<string, unknown> {
  return adapter.serializeToolResult({
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      ...modernResponseMeta(context)
    }
  });
}

function inputRequestsFromResult(result: CoreToolResult): unknown[] | undefined {
  const structured = result.structuredContent ?? {};
  const value = structured.inputRequests ?? structured.input_requests ?? structured.inputRequired ?? structured.input_required;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return undefined;
}

interface ModernContinuation {
  name: string;
  args: Record<string, unknown>;
  stage: "arguments" | "confirmation" | "tool_result";
  confirmationGranted: boolean;
  confirmationStateNonce?: string;
  confirmationScope?: PermissionConfirmationScopeV1;
  declined: boolean;
}

function continueArguments(params: Record<string, unknown>, context: CanonicalMcpRequestContext, config: CodexProConfig): ModernContinuation | undefined {
  const token = typeof params.requestState === "string" ? params.requestState : undefined;
  if (!token) return undefined;
  if (!config.mcpMrtrEnabled) throw new McpProtocolError("MRTR continuation is disabled.", -32601);
  const payload = stateCodecFor(config).open(token, {
    method: "tools/call",
    actorId: context.actorId,
    conversationId: context.conversationId,
    workspaceId: context.workspaceId,
    workspaceGeneration: context.workspaceGeneration
  });
  const continuation = asRecord(payload.continuation);
  const originalArgs = asRecord(continuation.arguments);
  if (hashMcpArguments(originalArgs) !== payload.argumentsHash) {
    throw new McpProtocolError("requestState arguments integrity validation failed.", -32602);
  }
  const stageValue = String(continuation.stage ?? "tool_result");
  const stage: ModernContinuation["stage"] = stageValue === "arguments" || stageValue === "confirmation" ? stageValue : "tool_result";
  const inputResponses = params.inputResponses ?? params.input_responses ?? [];
  if (stage === "arguments") {
    const requiredFields = Array.isArray(continuation.requiredFields) ? continuation.requiredFields.map(String) : [];
    return {
      name: String(payload.name ?? continuation.name ?? ""),
      args: mergeArgumentInputResponses(originalArgs, requiredFields, inputResponses),
      stage,
      confirmationGranted: continuation.confirmationGranted === true,
      declined: false
    };
  }
  if (stage === "confirmation") {
    const granted = confirmationGranted(inputResponses);
    const confirmationScope = asRecord(continuation.confirmationScope) as unknown as PermissionConfirmationScopeV1;
    if (!confirmationScope.tool || !confirmationScope.arguments) {
      throw new McpProtocolError("requestState confirmation scope is missing or invalid.", -32602);
    }
    return {
      name: String(payload.name ?? continuation.name ?? ""),
      args: originalArgs,
      stage,
      confirmationGranted: granted,
      confirmationStateNonce: payload.nonce,
      confirmationScope,
      declined: !granted
    };
  }
  return {
    name: String(payload.name ?? continuation.name ?? ""),
    args: {
      ...originalArgs,
      input_responses: inputResponses
    },
    stage,
    confirmationGranted: continuation.confirmationGranted === true,
    declined: false
  };
}

function sealMrtrState(input: {
  config: CodexProConfig;
  context: CanonicalMcpRequestContext;
  name: string;
  args: Record<string, unknown>;
  stage: ModernContinuation["stage"];
  requiredFields?: string[];
  confirmationGranted?: boolean;
  confirmationScope?: PermissionConfirmationScopeV1;
}): string {
  return stateCodecFor(input.config).seal({
    requestId: input.context.requestId,
    method: "tools/call",
    name: input.name,
    argumentsHash: hashMcpArguments(input.args),
    actorId: input.context.actorId,
    conversationId: input.context.conversationId,
    workspaceId: input.context.workspaceId,
    workspaceGeneration: input.context.workspaceGeneration,
    continuation: {
      stage: input.stage,
      name: input.name,
      arguments: input.args,
      requiredFields: input.requiredFields ?? [],
      confirmationGranted: input.confirmationGranted === true,
      ...(input.confirmationScope ? { confirmationScope: input.confirmationScope } : {})
    }
  });
}

export async function handleModernMcpRequest(input: {
  config: CodexProConfig;
  headers: McpHeaderMap;
  body: unknown;
}): Promise<ModernMcpHttpResponse> {
  const startedAt = performance.now();
  let metricMethod = "unknown";
  let failed = false;
  let context: CanonicalMcpRequestContext | undefined;
  try {
    context = buildCanonicalMcpRequestContext(input.headers, input.body);
    metricMethod = context.method;
    if (!modernMcpRolloutAllows(input.config, context)) {
      throw new McpProtocolError("MCP 2026-07-28 RC is not enabled for this client.", -32003, {
        releaseStatus: "rc",
        rolloutPercent: input.config.mcp20260728RolloutPercent
      });
    }
    if (input.config.mcpOauthHardeningEnabled) {
      validateModernOAuthHeaders(input.headers, {
        resource: input.config.mcpOauthResource,
        audience: input.config.mcpOauthAudience,
        authorizationServers: input.config.mcpOauthAuthorizationServers,
        scopesSupported: input.config.mcpOauthScopes,
        dpopRequired: input.config.mcpOauthDpopRequired
      });
    }

    const body = asRecord(input.body);
    const params = asRecord(body.params);
    const cacheIdentity = [
      context.protocolVersion,
      context.method,
      context.name,
      context.clientId,
      context.actorId,
      context.conversationId,
      context.workspaceId,
      context.workspaceGeneration
    ];

    if (context.method === "server/discover") {
      const policy = cachePolicyForModernMethod(context.method);
      const key = responseCache.key(cacheIdentity);
      const cached = responseCache.get<Record<string, unknown>>(key);
      if (cached) return success(input.body, context, cached, policy);
      const result = adapter.serializeDiscover({
        serverName: "codexpro",
        serverVersion: "0.28.6",
        tasksExtensionEnabled: input.config.mcpTasksExtensionEnabled,
        mrtrEnabled: input.config.mcpMrtrEnabled,
        appsEnabled: input.config.mcpAppsEnabled,
        subscriptionsEnabled: input.config.mcpSubscriptionsEnabled
      });
      responseCache.set(key, result, policy.ttlMs);
      return success(input.body, context, result, policy);
    }

    if (context.method === "oauth/protected-resource") {
      if (!input.config.mcpOauthHardeningEnabled) throw new McpProtocolError("OAuth metadata is disabled.", -32601);
      return success(input.body, context, protectedResourceMetadata({
        resource: input.config.mcpOauthResource,
        audience: input.config.mcpOauthAudience,
        authorizationServers: input.config.mcpOauthAuthorizationServers,
        scopesSupported: input.config.mcpOauthScopes,
        dpopRequired: input.config.mcpOauthDpopRequired
      }));
    }

    if (context.method === "observability/metrics") {
      return success(input.body, context, { metrics: modernMcpMetrics.snapshot(context.protocolVersion) });
    }

    if (["roots/list", "sampling/createMessage", "logging/setLevel"].includes(context.method)) {
      modernMcpMetrics.recordDeprecation();
      throw new McpProtocolError("This legacy session capability is not available in MCP 2026-07-28.", -32601, {
        method: context.method,
        replacement: context.method === "logging/setLevel" ? "per-request _meta.logLevel" : "MRTR or explicit request handles"
      });
    }
    if (context.method.startsWith("tasks/")) {
      throw new McpProtocolError("Tasks are an extension in MCP 2026-07-28 and are not core methods.", -32601, {
        extensionNamespace: "io.modelcontextprotocol/tasks"
      });
    }

    const { server, definitions } = await runtimeFor(input.config);
    const invoke = async (name: string, args: Record<string, unknown>, invokeContext: CanonicalMcpRequestContext): Promise<Record<string, unknown>> => {
      const result = await invokeTool(server, name, args, invokeContext);
      return serializedToolResult(result, invokeContext);
    };

    if (context.method === "tools/list") {
      const policy = cachePolicyForModernMethod(context.method);
      const key = responseCache.key([...cacheIdentity, definitions.length, input.config.toolCards]);
      const cached = responseCache.get<Record<string, unknown>>(key);
      if (cached) return success(input.body, context, cached, policy);
      const result = { tools: definitions.map((definition) => adapter.serializeToolDefinition(definition, input.config)) };
      responseCache.set(key, result, policy.ttlMs);
      return success(input.body, context, result, policy);
    }

    if (context.method === "apps/list") {
      if (!input.config.mcpAppsEnabled) throw new McpProtocolError("MCP Apps support is disabled.", -32601);
      return success(input.body, context, { apps: listModernMcpApps(definitions, input.config.widgetDomain) });
    }

    if (context.method === "apps/open") {
      if (!input.config.mcpAppsEnabled) throw new McpProtocolError("MCP Apps support is disabled.", -32601);
      const toolName = String(params.toolName ?? params.tool_name ?? "").trim();
      const app = listModernMcpApps(definitions, input.config.widgetDomain).find((candidate) => candidate.toolName === toolName);
      if (!app) throw new McpProtocolError("Unknown MCP App tool.", -32602, { toolName });
      const appSession = modernMcpAppSessionStore.create(toolName, context);
      return success(input.body, context, { app, appSession });
    }

    if (context.method === "apps/session/validate") {
      if (!input.config.mcpAppsEnabled) throw new McpProtocolError("MCP Apps support is disabled.", -32601);
      const toolName = String(params.toolName ?? params.tool_name ?? "").trim();
      const appSessionId = String(params.appSessionId ?? params.app_session_id ?? context.appSessionId ?? "").trim();
      return success(input.body, context, {
        appSession: modernMcpAppSessionStore.assert(appSessionId, toolName, context),
        valid: true
      });
    }

    if (context.method === "subscriptions/listen") {
      if (!input.config.mcpSubscriptionsEnabled) throw new McpProtocolError("MCP subscriptions are disabled.", -32601);
      return success(input.body, context, modernMcpSubscriptionHub.listen({
        cursor: Number(params.cursor ?? 0),
        topics: Array.isArray(params.topics) ? params.topics.map(String) : [],
        limit: Number(params.limit ?? 100),
        instanceId: typeof params.instanceId === "string" ? params.instanceId : undefined
      }));
    }

    if (isTasksExtensionMethod(context.method)) {
      if (!input.config.mcpTasksExtensionEnabled) throw new McpProtocolError("MCP Tasks extension is disabled.", -32601);
      const mutating = isMutatingTasksExtensionMethod(context.method);
      if (mutating && !context.idempotencyKey) {
        throw new McpProtocolError("Mutating Tasks extension methods require Mcp-Idempotency-Key or _meta.idempotencyKey.", -32602, {
          method: context.method
        });
      }
      const taskContext = context;
      const executeTaskMethod = () => handleTasksExtensionMethod(taskContext.method, params, taskContext, invoke);
      const result = mutating
        ? await modernMcpIdempotencyStore.run(
          [taskContext.clientId, taskContext.actorId, taskContext.workspaceId, taskContext.idempotencyKey].filter(Boolean).join(":"),
          hashMcpArguments({ method: taskContext.method, params, workspaceGeneration: taskContext.workspaceGeneration }),
          executeTaskMethod
        )
        : await executeTaskMethod();
      modernMcpSubscriptionHub.publish("tasks.changed", {
        method: context.method,
        run_id: context.runId ?? params.runId ?? params.run_id ?? null,
        request_id: context.requestId,
        trace_id: context.trace.traceId
      });
      return success(input.body, context, result);
    }

    if (context.method === "resources/read") {
      const uri = String(params.uri ?? "").trim();
      if (![TOOL_CARD_URI, ...TOOL_CARD_LEGACY_URIS].includes(uri)) {
        throw new McpProtocolError("Unknown modern MCP App resource.", -32602, { uri });
      }
      return success(input.body, context, {
        contents: [{ uri, mimeType: TOOL_CARD_MIME_TYPE, text: toolCardWidgetHtml }]
      });
    }

    if (context.method === "resources/list") {
      return success(input.body, context, {
        resources: input.config.mcpAppsEnabled
          ? [{ uri: TOOL_CARD_URI, name: "CodexPro task card", mimeType: TOOL_CARD_MIME_TYPE }]
          : []
      });
    }

    if (context.method === "prompts/list") {
      return success(input.body, context, { prompts: [] });
    }

    if (context.method === "tools/call") {
      const continuation = continueArguments(params, context, input.config);
      const name = continuation?.name || String(params.name ?? "").trim();
      if (!name) throw new McpProtocolError("tools/call requires a tool name.", -32602);
      const args = continuation?.args ?? asRecord(params.arguments);
      const definition = definitions.find((candidate) => candidate.name === name);
      if (!definition) throw new McpProtocolError("Unknown tool.", -32602, { tool: name });
      if (context.appSessionId && definition.presentation?.widgetResourceUri) {
        modernMcpAppSessionStore.assert(context.appSessionId, name, context);
      }
      if (definitionRequiresIdempotency(definition) && !context.idempotencyKey) {
        throw new McpProtocolError("Side-effecting tools/call requires Mcp-Idempotency-Key or _meta.idempotencyKey.", -32602, {
          tool: name
        });
      }
      if (continuation?.declined) {
        return success(input.body, context, {
          resultType: "cancelled",
          cancelled: true,
          content: [{ type: "text", text: `The ${name} call was cancelled before execution.` }],
          structuredContent: { cancelled: true, tool: name }
        });
      }
      const missingInputs = missingRequiredInputRequests(definition, bindCanonicalContextToToolArguments(args, context));
      if (missingInputs.length && input.config.mcpMrtrEnabled) {
        modernMcpSubscriptionHub.publish("mrtr.input_required", {
          tool: name,
          request_id: context.requestId,
          trace_id: context.trace.traceId,
          workspace_id: context.workspaceId ?? null,
          workspace_generation: context.workspaceGeneration ?? null,
          input_request_ids: missingInputs.map((item) => item.requestId)
        });
        return success(input.body, context, {
          resultType: "input_required",
          inputRequests: missingInputs,
          requestState: sealMrtrState({
            config: input.config,
            context,
            name,
            args,
            stage: "arguments",
            requiredFields: missingInputs.map((item) => String(item.field))
          }),
          content: [{ type: "text", text: "Additional required tool arguments are needed before execution." }],
          structuredContent: { waiting_for: "arguments", tool: name }
        });
      }
      const requestContext: CanonicalMcpRequestContext = continuation?.confirmationGranted === true
        && continuation.confirmationStateNonce
        && continuation.confirmationScope
        ? {
            ...context,
            confirmationReceipt: createPermissionConfirmationReceipt(
              continuation.confirmationScope,
              { requestStateNonce: continuation.confirmationStateNonce }
            )
          }
        : context;
      const execute = () => invokeTool(server, name, args, requestContext);
      const idempotencyStoreKey = requestContext.idempotencyKey
        ? [requestContext.clientId, requestContext.actorId, requestContext.workspaceId, requestContext.idempotencyKey].filter(Boolean).join(":")
        : undefined;
      const result = idempotencyStoreKey
        ? await modernMcpIdempotencyStore.run(
          idempotencyStoreKey,
          hashMcpArguments({ name, args, workspaceGeneration: requestContext.workspaceGeneration }),
          execute
        )
        : await execute();
      const inputRequests = inputRequestsFromResult(result);
      if (inputRequests && input.config.mcpMrtrEnabled) {
        if (idempotencyStoreKey) modernMcpIdempotencyStore.forget(idempotencyStoreKey);
        const confirmationRequired = inputRequests.some((item) => asRecord(item).type === "confirmation");
        const confirmationScope = confirmationRequired
          ? asRecord(result.structuredContent).confirmation_scope as PermissionConfirmationScopeV1 | undefined
          : undefined;
        if (confirmationRequired && (!confirmationScope?.tool || !confirmationScope.arguments)) {
          throw new McpProtocolError("Tool requested confirmation without a bound confirmation scope.", -32603);
        }
        if (confirmationRequired) {
          modernMcpSubscriptionHub.publish("mrtr.confirmation_required", {
            tool: name,
            request_id: context.requestId,
            trace_id: context.trace.traceId,
            workspace_id: context.workspaceId ?? null,
            workspace_generation: context.workspaceGeneration ?? null
          });
        }
        const requestState = sealMrtrState({
          config: input.config,
          context,
          name,
          args,
          stage: confirmationRequired ? "confirmation" : "tool_result",
          confirmationGranted: continuation?.confirmationGranted === true,
          confirmationScope
        });
        return success(input.body, context, {
          resultType: "input_required",
          inputRequests,
          requestState,
          content: result.content ?? [],
          structuredContent: result.structuredContent ?? {},
          _meta: { ...result.metadata, ...modernResponseMeta(context) }
        });
      }
      const policy = cachePolicyForModernMethod(context.method, definitionReadOnly(definition));
      const serialized = serializedToolResult(result, context);
      modernMcpSubscriptionHub.publish("tools.completed", {
        tool: name,
        is_error: result.isError === true,
        request_id: context.requestId,
        trace_id: context.trace.traceId,
        workspace_id: context.workspaceId ?? null,
        task_id: context.taskId ?? null,
        run_id: context.runId ?? null,
        attempt_id: context.attemptId ?? null
      });
      return success(input.body, context, serialized, policy);
    }

    throw new McpProtocolError("Method not found.", -32601, { method: context.method });
  } catch (error) {
    failed = true;
    return failure(input.body, context, error);
  } finally {
    modernMcpMetrics.record(metricMethod, performance.now() - startedAt, failed);
  }
}
