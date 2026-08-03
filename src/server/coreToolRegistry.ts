import { createHash } from "node:crypto";
import { TOOL_LIMITS_DIGEST } from "../tools/toolLimits.js";

export interface CoreToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CoreToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  capability_side_effect_level?: import("../security/riskGate.js").EffectiveSideEffectLevel;
  contract?: import("../tools/toolContract.js").ToolContractMetadataV1;
  presentation?: {
    widgetResourceUri?: string;
    outputTemplateUri?: string;
    invoking?: string;
    invoked?: string;
  };
}

export interface CoreToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CoreToolRequestContext {
  signal?: AbortSignal;
  mcp?: import("../mcp/modern/requestContext.js").CanonicalMcpRequestContext;
}

export interface CoreToolResult {
  isError?: boolean;
  content?: CoreToolContent[];
  structuredContent?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type CoreToolHandler = (call: CoreToolCall, context?: CoreToolRequestContext) => Promise<CoreToolResult> | CoreToolResult;

export interface CoreToolRegistration {
  definition: CoreToolDefinition;
  handler: CoreToolHandler;
}

function stableSchemaValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
  if (typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return `[${value.map((item) => stableSchemaValue(item, seen)).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  const entries = Object.keys(objectValue)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableSchemaValue(objectValue[key], seen)}`);
  const constructorName = value.constructor?.name;
  return `${constructorName && constructorName !== "Object" ? `[${constructorName}]` : ""}{${entries.join(",")}}`;
}

export class CoreToolRegistry {
  private readonly registrations = new Map<string, CoreToolRegistration>();

  constructor(private readonly limitsDigest: string = TOOL_LIMITS_DIGEST) {}

  register(definition: CoreToolDefinition, handler: CoreToolHandler): CoreToolRegistration {
    const registration = { definition, handler };
    this.registrations.set(definition.name, registration);
    return registration;
  }

  get(name: string): CoreToolRegistration | undefined {
    return this.registrations.get(name);
  }

  names(): string[] {
    return [...this.registrations.keys()];
  }

  definitions(): CoreToolDefinition[] {
    return [...this.registrations.values()].map((registration) => registration.definition);
  }

  schemaDigest(): string {
    const definitions = this.definitions().slice().sort((left, right) => left.name.localeCompare(right.name));
    return `sha256:${createHash("sha256").update(stableSchemaValue({ limits_digest: this.limitsDigest, definitions })).digest("hex")}`;
  }
}

export function normalizeCoreToolResult(value: unknown): CoreToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { content: [{ type: "text", text: String(value ?? "") }], structuredContent: {} };
  }
  const raw = value as Record<string, unknown>;
  const structured = raw.structuredContent && typeof raw.structuredContent === "object" && !Array.isArray(raw.structuredContent)
    ? raw.structuredContent as Record<string, unknown>
    : {};
  const metadata = raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
    ? raw.metadata as Record<string, unknown>
    : raw._meta && typeof raw._meta === "object" && !Array.isArray(raw._meta)
      ? raw._meta as Record<string, unknown>
      : undefined;
  return {
    ...(raw.isError === true ? { isError: true } : {}),
    ...(Array.isArray(raw.content) ? { content: raw.content as CoreToolContent[] } : {}),
    structuredContent: structured,
    ...(metadata ? { metadata } : {})
  };
}
