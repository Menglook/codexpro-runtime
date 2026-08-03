import type { CodexProConfig } from "../../config.js";
import type { CoreToolDefinition, CoreToolResult } from "../../server/coreToolRegistry.js";
import type { CoreMcpCapabilities, McpProtocolAdapter } from "../protocolAdapter.js";

export const MCP_PROFILE_V1 = "v1" as const;
export const MCP_PROFILE_V1_PROTOCOL_VERSION = "2024-11-05";

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

export interface McpProfileV1AdapterDependencies {
  safeStructuredContent(structuredContent?: Record<string, unknown>): Record<string, unknown>;
  errorResult(error: unknown): Record<string, unknown>;
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

function stripOptionalToolCardMeta(config: Pick<CodexProConfig, "toolCards">, meta: Record<string, unknown>): Record<string, unknown> {
  if (config.toolCards) return meta;
  const next = { ...meta };
  for (const key of OPTIONAL_TOOL_CARD_META) delete next[key];
  return next;
}

function resultMeta(result: CoreToolResult): Record<string, unknown> | undefined {
  return result.metadata && Object.keys(result.metadata).length ? result.metadata : undefined;
}

export function createMcpProfileV1Adapter(dependencies: McpProfileV1AdapterDependencies): McpProtocolAdapter {
  const { safeStructuredContent, errorResult } = dependencies;
  return {
    profile: MCP_PROFILE_V1,
    supportedProtocolVersions: [MCP_PROFILE_V1_PROTOCOL_VERSION],

    negotiateInitialize(request: unknown) {
      const requested =
        request && typeof request === "object" && "protocolVersion" in request
          ? String((request as { protocolVersion?: unknown }).protocolVersion ?? MCP_PROFILE_V1_PROTOCOL_VERSION)
          : MCP_PROFILE_V1_PROTOCOL_VERSION;
      return {
        profile: MCP_PROFILE_V1,
        protocolVersion: requested === MCP_PROFILE_V1_PROTOCOL_VERSION ? requested : MCP_PROFILE_V1_PROTOCOL_VERSION
      };
    },

    mapServerCapabilities(coreCapabilities: CoreMcpCapabilities) {
      return {
        tools: {
          listChanged: coreCapabilities.tools?.listChanged === true
        },
        resources: {
          listChanged: coreCapabilities.resources?.listChanged === true
        }
      };
    },

    normalizeToolCall(input) {
      const args = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
        ? input.arguments as Record<string, unknown>
        : {};
      return { name: input.name, arguments: args };
    },

    serializeToolDefinition(definition: CoreToolDefinition, config: Pick<CodexProConfig, "toolCards">) {
      const securitySchemes = [{ type: "noauth" }];
      return {
        securitySchemes,
        ...(definition.title ? { title: definition.title } : {}),
        ...(definition.description ? { description: definition.description } : {}),
        inputSchema: definition.inputSchema ?? {},
        ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
        _meta: {
          securitySchemes,
          ...stripOptionalToolCardMeta(config, toolMetaForDefinition(definition))
        }
      };
    },

    serializeToolResult(result: CoreToolResult) {
      return {
        ...(result.isError === true ? { isError: true } : {}),
        content: result.content ?? [],
        structuredContent: safeStructuredContent(result.structuredContent ?? {}),
        ...(resultMeta(result) ? { _meta: resultMeta(result) } : {})
      };
    },

    serializeError(error: unknown) {
      const result = errorResult(error);
      const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
        ? result.structuredContent as Record<string, unknown>
        : {};
      return {
        isError: true,
        ...(Array.isArray(result.content) ? { content: result.content } : {}),
        structuredContent: safeStructuredContent(structured),
        ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta) ? { _meta: result._meta } : {})
      };
    }
  };
}
