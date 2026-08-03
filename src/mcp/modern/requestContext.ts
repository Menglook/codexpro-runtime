import { randomUUID } from "node:crypto";
import { McpProtocolError } from "../protocolAdapter.js";
import type { PermissionConfirmationReceiptV1 } from "../../security/confirmationReceipt.js";

export const MCP_2026_07_28_PROTOCOL_VERSION = "2026-07-28";

export type McpCompatibilityMode = "modern_rc" | "legacy";
export type McpCacheScope = "public" | "client" | "conversation" | "workspace" | "actor" | "private";

export interface McpTraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
  traceId: string;
  parentSpanId?: string;
}

export interface CanonicalMcpRequestContext {
  requestId: string;
  protocolVersion: string;
  adapterName: "mcp-2026-07-28-rc";
  compatibilityMode: McpCompatibilityMode;
  downgradeReason: null;
  method: string;
  name?: string;
  clientId?: string;
  actorId?: string;
  actorRole?: string;
  conversationId?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  workspaceGeneration?: number;
  taskId?: string;
  runId?: string;
  attemptId?: string;
  browserId?: string;
  logLevel?: string;
  idempotencyKey?: string;
  appSessionId?: string;
  sessionIdHint?: string;
  confirmationReceipt?: PermissionConfirmationReceiptV1;
  trace: McpTraceContext;
  capabilities: Record<string, unknown>;
  receivedAt: string;
}

export type McpHeaderValue = string | string[] | undefined;
export type McpHeaderMap = Record<string, McpHeaderValue>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function headerValue(headers: McpHeaderMap, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0]?.trim() || undefined;
  return typeof direct === "string" && direct.trim() ? direct.trim() : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function requestIdValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function integerValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function traceFromHeaders(headers: McpHeaderMap): McpTraceContext {
  const traceparent = headerValue(headers, "traceparent");
  const match = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (traceparent && !match) {
    throw new McpProtocolError("Invalid W3C traceparent header.", -32602, { field: "traceparent" });
  }
  return {
    ...(traceparent ? { traceparent } : {}),
    ...(headerValue(headers, "tracestate") ? { tracestate: headerValue(headers, "tracestate") } : {}),
    ...(headerValue(headers, "baggage") ? { baggage: headerValue(headers, "baggage") } : {}),
    traceId: match?.[1]?.toLowerCase() ?? randomUUID().replaceAll("-", ""),
    ...(match?.[2] ? { parentSpanId: match[2].toLowerCase() } : {})
  };
}

export function declaredModernProtocolVersion(headers: McpHeaderMap, body: unknown): string | undefined {
  const request = asRecord(body);
  const params = asRecord(request.params);
  const requestMeta = asRecord(request._meta);
  const paramsMeta = asRecord(params._meta);
  return stringValue(
    headerValue(headers, "mcp-protocol-version"),
    requestMeta.protocolVersion,
    paramsMeta.protocolVersion
  );
}

export function shouldHandleModernMcpRequest(headers: McpHeaderMap, body: unknown): boolean {
  const request = asRecord(body);
  return declaredModernProtocolVersion(headers, body) === MCP_2026_07_28_PROTOCOL_VERSION || request.method === "server/discover";
}

export function buildCanonicalMcpRequestContext(headers: McpHeaderMap, body: unknown): CanonicalMcpRequestContext {
  const request = asRecord(body);
  const params = asRecord(request.params);
  const requestMeta = asRecord(request._meta);
  const paramsMeta = asRecord(params._meta);
  const meta = { ...requestMeta, ...paramsMeta };
  const method = stringValue(request.method);
  if (!method) throw new McpProtocolError("JSON-RPC method is required.", -32600);

  const headerProtocol = headerValue(headers, "mcp-protocol-version");
  const metaProtocol = stringValue(requestMeta.protocolVersion, paramsMeta.protocolVersion);
  if (headerProtocol && metaProtocol && headerProtocol !== metaProtocol) {
    throw new McpProtocolError("MCP protocol declarations disagree.", -32602, {
      headerProtocol,
      metaProtocol
    });
  }
  const protocolVersion = headerProtocol ?? metaProtocol ?? (method === "server/discover" ? MCP_2026_07_28_PROTOCOL_VERSION : undefined);
  if (protocolVersion !== MCP_2026_07_28_PROTOCOL_VERSION) {
    throw new McpProtocolError("Unsupported modern MCP protocol version.", -32602, {
      requested: protocolVersion ?? null,
      supported: [MCP_2026_07_28_PROTOCOL_VERSION]
    });
  }

  const headerMethod = headerValue(headers, "mcp-method");
  if (headerMethod && headerMethod !== method) {
    throw new McpProtocolError("Mcp-Method header does not match the JSON-RPC method.", -32602, {
      headerMethod,
      bodyMethod: method
    });
  }
  const bodyName = stringValue(params.name, meta.name);
  const headerName = headerValue(headers, "mcp-name");
  if (headerName && bodyName && headerName !== bodyName) {
    throw new McpProtocolError("Mcp-Name header does not match the request name.", -32602, {
      headerName,
      bodyName
    });
  }

  return {
    requestId: requestIdValue(headerValue(headers, "mcp-request-id"), request.id) ?? randomUUID(),
    protocolVersion,
    adapterName: "mcp-2026-07-28-rc",
    compatibilityMode: "modern_rc",
    downgradeReason: null,
    method,
    ...(headerName ?? bodyName ? { name: headerName ?? bodyName } : {}),
    ...(stringValue(meta.clientId, headerValue(headers, "mcp-client-id")) ? { clientId: stringValue(meta.clientId, headerValue(headers, "mcp-client-id")) } : {}),
    ...(stringValue(meta.actorId, headerValue(headers, "mcp-actor-id")) ? { actorId: stringValue(meta.actorId, headerValue(headers, "mcp-actor-id")) } : {}),
    ...(stringValue(meta.actorRole, headerValue(headers, "mcp-actor-role")) ? { actorRole: stringValue(meta.actorRole, headerValue(headers, "mcp-actor-role")) } : {}),
    ...(stringValue(meta.conversationId, headerValue(headers, "mcp-conversation-id")) ? { conversationId: stringValue(meta.conversationId, headerValue(headers, "mcp-conversation-id")) } : {}),
    ...(stringValue(meta.workspaceId, headerValue(headers, "mcp-workspace-id")) ? { workspaceId: stringValue(meta.workspaceId, headerValue(headers, "mcp-workspace-id")) } : {}),
    ...(stringValue(meta.workspaceRoot, headerValue(headers, "mcp-workspace-root")) ? { workspaceRoot: stringValue(meta.workspaceRoot, headerValue(headers, "mcp-workspace-root")) } : {}),
    ...(integerValue(meta.workspaceGeneration, headerValue(headers, "mcp-workspace-generation")) ? { workspaceGeneration: integerValue(meta.workspaceGeneration, headerValue(headers, "mcp-workspace-generation")) } : {}),
    ...(stringValue(meta.taskId, headerValue(headers, "mcp-task-id")) ? { taskId: stringValue(meta.taskId, headerValue(headers, "mcp-task-id")) } : {}),
    ...(stringValue(meta.runId, headerValue(headers, "mcp-run-id")) ? { runId: stringValue(meta.runId, headerValue(headers, "mcp-run-id")) } : {}),
    ...(stringValue(meta.attemptId, headerValue(headers, "mcp-attempt-id")) ? { attemptId: stringValue(meta.attemptId, headerValue(headers, "mcp-attempt-id")) } : {}),
    ...(stringValue(meta.browserId, headerValue(headers, "mcp-browser-id")) ? { browserId: stringValue(meta.browserId, headerValue(headers, "mcp-browser-id")) } : {}),
    ...(stringValue(meta.logLevel, headerValue(headers, "mcp-log-level")) ? { logLevel: stringValue(meta.logLevel, headerValue(headers, "mcp-log-level")) } : {}),
    ...(stringValue(meta.idempotencyKey, headerValue(headers, "mcp-idempotency-key")) ? { idempotencyKey: stringValue(meta.idempotencyKey, headerValue(headers, "mcp-idempotency-key")) } : {}),
    ...(stringValue(meta.appSessionId, headerValue(headers, "mcp-app-session-id")) ? { appSessionId: stringValue(meta.appSessionId, headerValue(headers, "mcp-app-session-id")) } : {}),
    ...(headerValue(headers, "mcp-session-id") ? { sessionIdHint: headerValue(headers, "mcp-session-id") } : {}),
    trace: traceFromHeaders(headers),
    capabilities: asRecord(meta.capabilities),
    receivedAt: new Date().toISOString()
  };
}

export function bindCanonicalContextToToolArguments(
  args: Record<string, unknown>,
  context: CanonicalMcpRequestContext
): Record<string, unknown> {
  return {
    ...args,
    ...(args.conversation_id === undefined && context.conversationId ? { conversation_id: context.conversationId } : {}),
    ...(args.workspace_id === undefined && context.workspaceId ? { workspace_id: context.workspaceId } : {}),
    ...(args.workspace_generation === undefined && context.workspaceGeneration ? { workspace_generation: context.workspaceGeneration } : {}),
    ...(args.task_id === undefined && context.taskId ? { task_id: context.taskId } : {}),
    ...(args.run_id === undefined && context.runId ? { run_id: context.runId } : {}),
    ...(args.attempt_id === undefined && context.attemptId ? { attempt_id: context.attemptId } : {}),
    ...(args.browser_id === undefined && context.browserId ? { browser_id: context.browserId } : {})
  };
}

export function modernResponseMeta(context: CanonicalMcpRequestContext): Record<string, unknown> {
  return {
    protocolVersion: context.protocolVersion,
    negotiated_protocol_version: context.protocolVersion,
    adapter_name: context.adapterName,
    compatibility_mode: context.compatibilityMode,
    downgrade_reason: context.downgradeReason,
    request_id: context.requestId,
    trace_id: context.trace.traceId,
    parent_span_id: context.trace.parentSpanId ?? null,
    workspace_id: context.workspaceId ?? null,
    workspace_generation: context.workspaceGeneration ?? null,
    actor_id: context.actorId ?? null,
    actor_role: context.actorRole ?? null,
    task_id: context.taskId ?? null,
    run_id: context.runId ?? null,
    attempt_id: context.attemptId ?? null,
    browser_id: context.browserId ?? null,
    idempotency_key_present: Boolean(context.idempotencyKey),
    app_session_id: context.appSessionId ?? null,
    legacy_session_hint_ignored: Boolean(context.sessionIdHint)
  };
}
