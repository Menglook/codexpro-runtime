import type { CodexProConfig } from "../../config.js";
import type { CoreToolContent, CoreToolDefinition, CoreToolResult } from "../../server/coreToolRegistry.js";
import {
  McpProtocolError,
  type CoreMcpCapabilities,
  type McpProtocolAdapter
} from "../protocolAdapter.js";

export const MCP_PROFILE_V2 = "v2" as const;
export const MCP_PROFILE_V2_PROTOCOL_VERSION = "2025-11-25";

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

export interface McpProfileV2AdapterDependencies {
  safeStructuredContent(structuredContent?: Record<string, unknown>): Record<string, unknown>;
  errorResult(error: unknown): Record<string, unknown>;
}

export interface McpProfileV2Adapter extends McpProtocolAdapter {
  readonly profile: typeof MCP_PROFILE_V2;
  readonly testOnly: true;
  assertCapability(capability: string, negotiatedCapabilities: Record<string, unknown>): void;
  serializeProtocolError(error: unknown): {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
  serializeProgressNotification(input: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  }): Record<string, unknown>;
  normalizeCancellationNotification(input: unknown): {
    requestId: string | number;
    reason?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolMetaForDefinition(definition: CoreToolDefinition): Record<string, unknown> {
  const presentation = definition.presentation ?? {};
  const meta: Record<string, unknown> = {};
  if (presentation.widgetResourceUri) meta.ui = { resourceUri: presentation.widgetResourceUri };
  if (presentation.outputTemplateUri) meta["openai/outputTemplate"] = presentation.outputTemplateUri;
  if (presentation.invoking) meta["openai/toolInvocation/invoking"] = presentation.invoking;
  if (presentation.invoked) meta["openai/toolInvocation/invoked"] = presentation.invoked;
  return meta;
}

function stripOptionalToolCardMeta(
  config: Pick<CodexProConfig, "toolCards">,
  meta: Record<string, unknown>
): Record<string, unknown> {
  if (config.toolCards) return meta;
  const next = { ...meta };
  for (const key of OPTIONAL_TOOL_CARD_META) delete next[key];
  return next;
}

function resultMeta(result: CoreToolResult): Record<string, unknown> | undefined {
  return result.metadata && Object.keys(result.metadata).length ? result.metadata : undefined;
}

function textForStructuredContent(structuredContent: Record<string, unknown>): CoreToolContent {
  return {
    type: "text",
    text: JSON.stringify(structuredContent)
  };
}

function contentWithStructuredFallback(
  content: CoreToolContent[] | undefined,
  structuredContent: Record<string, unknown>
): CoreToolContent[] {
  const next = Array.isArray(content) ? [...content] : [];
  if (Object.keys(structuredContent).length > 0 && !next.some((part) => part.type === "text")) {
    next.push(textForStructuredContent(structuredContent));
  }
  return next;
}

function capabilityValue(capabilities: Record<string, unknown>, capability: string): unknown {
  let current: unknown = capabilities;
  for (const segment of capability.split(".")) {
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function capabilityEnabled(value: unknown): boolean {
  return value === true || Boolean(asRecord(value));
}

function protocolError(error: unknown): McpProtocolError {
  if (error instanceof McpProtocolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpProtocolError(message || "Internal MCP protocol error", -32603);
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpProtocolError(`${field} must be a finite number`, -32602, { field });
  }
}

export function createMcpProfileV2Adapter(
  dependencies: McpProfileV2AdapterDependencies,
  options: { testOnly: true }
): McpProfileV2Adapter {
  if (options?.testOnly !== true) {
    throw new Error("MCP Profile v2 is test-only and cannot be enabled as the production default.");
  }

  const { safeStructuredContent, errorResult } = dependencies;
  return {
    profile: MCP_PROFILE_V2,
    testOnly: true,
    supportedProtocolVersions: [MCP_PROFILE_V2_PROTOCOL_VERSION],

    negotiateInitialize(request: unknown) {
      const params = asRecord(request);
      const requested = params?.protocolVersion;
      if (requested !== MCP_PROFILE_V2_PROTOCOL_VERSION) {
        throw new McpProtocolError("Unsupported protocol version", -32602, {
          supported: [MCP_PROFILE_V2_PROTOCOL_VERSION],
          requested: requested ?? null
        });
      }
      if (params?.capabilities !== undefined && !asRecord(params.capabilities)) {
        throw new McpProtocolError("Client capabilities must be an object", -32602, {
          field: "capabilities"
        });
      }
      return {
        profile: MCP_PROFILE_V2,
        protocolVersion: MCP_PROFILE_V2_PROTOCOL_VERSION
      };
    },

    mapServerCapabilities(coreCapabilities: CoreMcpCapabilities) {
      const capabilities: Record<string, unknown> = {};
      if (coreCapabilities.tools) {
        capabilities.tools = coreCapabilities.tools.listChanged === true
          ? { listChanged: true }
          : {};
      }
      if (coreCapabilities.resources) {
        capabilities.resources = coreCapabilities.resources.listChanged === true
          ? { listChanged: true }
          : {};
      }
      return capabilities;
    },

    assertCapability(capability: string, negotiatedCapabilities: Record<string, unknown>) {
      if (capabilityEnabled(capabilityValue(negotiatedCapabilities, capability))) return;
      throw new McpProtocolError(`MCP capability was not negotiated: ${capability}`, -32601, {
        capability,
        profile: MCP_PROFILE_V2
      });
    },

    normalizeToolCall(input) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.name)) {
        throw new McpProtocolError("Invalid tool name", -32602, { name: input.name });
      }
      if (input.arguments === undefined) return { name: input.name, arguments: {} };
      const args = asRecord(input.arguments);
      if (!args) {
        throw new McpProtocolError("Tool arguments must be an object", -32602, {
          tool: input.name,
          field: "arguments"
        });
      }
      return { name: input.name, arguments: args };
    },

    serializeToolDefinition(definition: CoreToolDefinition, config: Pick<CodexProConfig, "toolCards">) {
      const securitySchemes = [{ type: "noauth" }];
      return {
        securitySchemes,
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description ? { description: definition.description } : {}),
        inputSchema: definition.inputSchema ?? { type: "object", additionalProperties: false },
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
        execution: {
          taskSupport: "forbidden"
        },
        _meta: {
          securitySchemes,
          ...stripOptionalToolCardMeta(config, toolMetaForDefinition(definition))
        }
      };
    },

    serializeToolResult(result: CoreToolResult) {
      const structuredContent = safeStructuredContent(result.structuredContent ?? {});
      return {
        isError: result.isError === true,
        content: contentWithStructuredFallback(result.content, structuredContent),
        structuredContent,
        ...(resultMeta(result) ? { _meta: resultMeta(result) } : {})
      };
    },

    serializeError(error: unknown) {
      const result = errorResult(error);
      const structured = asRecord(result.structuredContent) ?? {};
      const metadata = asRecord(result._meta) ?? {};
      const message = error instanceof Error ? error.message : String(error);
      const structuredContent = safeStructuredContent({
        ...structured,
        codexpro_error: {
          kind: "tool_execution",
          message
        }
      });
      return {
        isError: true,
        content: contentWithStructuredFallback(
          Array.isArray(result.content) ? result.content as CoreToolContent[] : undefined,
          structuredContent
        ),
        structuredContent,
        _meta: {
          ...metadata,
          "codexpro/errorKind": "tool_execution"
        }
      };
    },

    serializeProtocolError(error: unknown) {
      const normalized = protocolError(error);
      return {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.data ? { data: normalized.data } : {})
      };
    },

    serializeProgressNotification(input) {
      if (typeof input.progressToken !== "string" && !Number.isInteger(input.progressToken)) {
        throw new McpProtocolError("progressToken must be a string or integer", -32602, {
          field: "progressToken"
        });
      }
      assertFiniteNumber(input.progress, "progress");
      if (input.total !== undefined) assertFiniteNumber(input.total, "total");
      const params: Record<string, unknown> = {
        progress: input.progress,
        ...(input.total !== undefined ? { total: input.total } : {}),
        ...(input.message ? { message: input.message } : {})
      };
      params["progressToken"] = input.progressToken;
      return {
        method: "notifications/progress",
        params
      };
    },

    normalizeCancellationNotification(input: unknown) {
      const notification = asRecord(input);
      const params = asRecord(notification?.params);
      if (notification?.method !== "notifications/cancelled" || !params) {
        throw new McpProtocolError("Malformed cancellation notification", -32602);
      }
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") {
        throw new McpProtocolError("Cancellation requestId must be a string or number", -32602, {
          field: "requestId"
        });
      }
      const reason = typeof params.reason === "string" && params.reason ? params.reason : undefined;
      return {
        requestId,
        ...(reason ? { reason } : {})
      };
    }
  };
}
