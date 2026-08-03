import type { CodexProConfig } from "../config.js";
import type { CoreToolCall, CoreToolDefinition, CoreToolResult } from "../server/coreToolRegistry.js";

export type McpProfileName = "v1" | "v2" | "v3";

export class McpProtocolError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;

  constructor(message: string, code = -32602, data?: Record<string, unknown>) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

export interface CoreMcpCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    listChanged?: boolean;
  };
}

export interface McpProtocolAdapter {
  readonly profile: McpProfileName;
  readonly supportedProtocolVersions: string[];

  negotiateInitialize(request: unknown): {
    profile: McpProfileName;
    protocolVersion: string;
  };
  mapServerCapabilities(coreCapabilities: CoreMcpCapabilities): Record<string, unknown>;
  normalizeToolCall(input: { name: string; arguments?: unknown }): CoreToolCall;
  serializeToolDefinition(definition: CoreToolDefinition, config: Pick<CodexProConfig, "toolCards">): Record<string, unknown>;
  serializeToolResult(result: CoreToolResult): Record<string, unknown>;
  serializeError(error: unknown): Record<string, unknown>;
}
