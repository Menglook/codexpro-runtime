import type { CodexProConfig } from "../../config.js";
import type { CoreToolContent, CoreToolDefinition, CoreToolResult } from "../../server/coreToolRegistry.js";
import {
  McpProtocolError,
  type CoreMcpCapabilities,
  type McpProtocolAdapter
} from "../protocolAdapter.js";
import { MCP_2026_07_28_PROTOCOL_VERSION } from "../modern/requestContext.js";

export const MCP_PROFILE_V3 = "v3" as const;
export const MCP_PROFILE_V3_PROTOCOL_VERSION = MCP_2026_07_28_PROTOCOL_VERSION;

export interface McpProfileV3Adapter extends McpProtocolAdapter {
  readonly profile: typeof MCP_PROFILE_V3;
  readonly releaseStatus: "rc";
  serializeDiscover(input: {
    serverName: string;
    serverVersion: string;
    tasksExtensionEnabled: boolean;
    mrtrEnabled: boolean;
    appsEnabled: boolean;
    subscriptionsEnabled: boolean;
  }): Record<string, unknown>;
  serializeProtocolError(error: unknown): {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function contentWithStructuredFallback(
  content: CoreToolContent[] | undefined,
  structuredContent: Record<string, unknown>
): CoreToolContent[] {
  const next = Array.isArray(content) ? [...content] : [];
  if (Object.keys(structuredContent).length > 0 && !next.some((part) => part.type === "text")) {
    next.push({ type: "text", text: JSON.stringify(structuredContent) });
  }
  return next;
}

function toolPresentation(definition: CoreToolDefinition, config: Pick<CodexProConfig, "toolCards">): Record<string, unknown> {
  if (!config.toolCards) return {};
  const presentation = definition.presentation ?? {};
  return {
    ...(presentation.widgetResourceUri ? { ui: { resourceUri: presentation.widgetResourceUri } } : {}),
    ...(presentation.outputTemplateUri ? { "openai/outputTemplate": presentation.outputTemplateUri } : {}),
    ...(presentation.invoking ? { "openai/toolInvocation/invoking": presentation.invoking } : {}),
    ...(presentation.invoked ? { "openai/toolInvocation/invoked": presentation.invoked } : {})
  };
}

export function createMcpProfileV3Adapter(): McpProfileV3Adapter {
  return {
    profile: MCP_PROFILE_V3,
    releaseStatus: "rc",
    supportedProtocolVersions: [MCP_PROFILE_V3_PROTOCOL_VERSION],

    negotiateInitialize(request: unknown) {
      const record = asRecord(request) ?? {};
      const requested = String(record.protocolVersion ?? MCP_PROFILE_V3_PROTOCOL_VERSION);
      if (requested !== MCP_PROFILE_V3_PROTOCOL_VERSION) {
        throw new McpProtocolError("Unsupported MCP 2026 protocol version.", -32602, {
          requested,
          supported: [MCP_PROFILE_V3_PROTOCOL_VERSION]
        });
      }
      return { profile: MCP_PROFILE_V3, protocolVersion: MCP_PROFILE_V3_PROTOCOL_VERSION };
    },

    mapServerCapabilities(coreCapabilities: CoreMcpCapabilities) {
      return {
        tools: { listChanged: coreCapabilities.tools?.listChanged === true },
        resources: { listChanged: coreCapabilities.resources?.listChanged === true },
        stateless: true,
        requestEnvelope: true,
        traceContext: "w3c",
        cacheControl: true,
        subscriptions: true,
        multiRoundTrip: true
      };
    },

    normalizeToolCall(input) {
      return {
        name: String(input.name),
        arguments: asRecord(input.arguments) ?? {}
      };
    },

    serializeToolDefinition(definition, config) {
      return {
        name: definition.name,
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description ? { description: definition.description } : {}),
        inputSchema: definition.inputSchema ?? { type: "object", additionalProperties: true },
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
        ...(definition.contract ? { contract: definition.contract } : {}),
        _meta: {
          protocolVersion: MCP_PROFILE_V3_PROTOCOL_VERSION,
          ...toolPresentation(definition, config)
        }
      };
    },

    serializeToolResult(result) {
      const structuredContent = result.structuredContent ?? {};
      return {
        resultType: "complete",
        isError: result.isError === true,
        content: contentWithStructuredFallback(result.content, structuredContent),
        structuredContent,
        ...(result.metadata ? { _meta: result.metadata } : {})
      };
    },

    serializeError(error) {
      const protocol = this.serializeProtocolError(error);
      return {
        resultType: "complete",
        isError: true,
        content: [{ type: "text", text: protocol.message }],
        structuredContent: {
          error: protocol.message,
          code: protocol.code,
          ...(protocol.data ? { data: protocol.data } : {})
        }
      };
    },

    serializeDiscover(input) {
      return {
        protocolVersion: MCP_PROFILE_V3_PROTOCOL_VERSION,
        releaseStatus: "rc",
        serverInfo: {
          name: input.serverName,
          version: input.serverVersion
        },
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          stateless: true,
          requestEnvelope: true,
          traceContext: "w3c",
          cacheControl: true,
          subscriptions: input.subscriptionsEnabled,
          multiRoundTrip: input.mrtrEnabled,
          apps: input.appsEnabled
        },
        extensions: {
          tasks: {
            enabled: input.tasksExtensionEnabled,
            namespace: "io.modelcontextprotocol/tasks",
            coreMethod: false
          }
        },
        compatibility: {
          initialize: "legacy-only",
          mcpSessionId: "legacy-hint-only",
          roots: "deprecated",
          sampling: "deprecated-use-mrtr",
          loggingSetLevel: "deprecated-use-request-logLevel"
        }
      };
    },

    serializeProtocolError(error) {
      if (error instanceof McpProtocolError) {
        return {
          code: error.code,
          message: error.message,
          ...(error.data ? { data: error.data } : {})
        };
      }
      return {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  };
}
