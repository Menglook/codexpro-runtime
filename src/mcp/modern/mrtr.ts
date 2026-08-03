import type { CoreToolDefinition } from "../../server/coreToolRegistry.js";
import { McpProtocolError } from "../protocolAdapter.js";

export interface ModernInputRequest {
  requestId: string;
  type: "text" | "number" | "boolean" | "confirmation";
  title: string;
  description: string;
  required: true;
  field?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function schemaType(schema: unknown): ModernInputRequest["type"] {
  const typeName = String(asRecord(asRecord(schema)._def).typeName ?? "");
  if (typeName.includes("Boolean")) return "boolean";
  if (typeName.includes("Number") || typeName.includes("BigInt")) return "number";
  return "text";
}

function schemaDescription(schema: unknown, field: string): string {
  const record = asRecord(schema);
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return description || `Provide the required ${field} value.`;
}

function isRequiredSchema(schema: unknown): boolean {
  const candidate = schema as { safeParse?: (value: unknown) => { success?: boolean } };
  if (typeof candidate?.safeParse !== "function") return false;
  try {
    return candidate.safeParse(undefined)?.success !== true;
  } catch {
    return true;
  }
}

export function missingRequiredInputRequests(
  definition: CoreToolDefinition | undefined,
  args: Record<string, unknown>
): ModernInputRequest[] {
  const inputSchema = asRecord(definition?.inputSchema);
  const requests: ModernInputRequest[] = [];
  for (const [field, schema] of Object.entries(inputSchema)) {
    if (Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined && args[field] !== null && args[field] !== "") continue;
    if (!isRequiredSchema(schema)) continue;
    requests.push({
      requestId: `argument:${field}`,
      type: schemaType(schema),
      title: `Provide ${field}`,
      description: schemaDescription(schema, field),
      required: true,
      field
    });
  }
  return requests;
}

export function confirmationInputRequest(toolName: string): ModernInputRequest {
  return {
    requestId: "confirmation:execute",
    type: "confirmation",
    title: `Confirm ${toolName}`,
    description: `Confirm that CodexPro may execute the side-effecting tool ${toolName} with the displayed arguments.`,
    required: true
  };
}

export function inputResponseMap(value: unknown): Map<string, unknown> {
  const responses = new Map<string, unknown>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      const requestId = String(record.requestId ?? record.request_id ?? record.id ?? record.name ?? "").trim();
      if (!requestId) continue;
      const response = Object.prototype.hasOwnProperty.call(record, "value")
        ? record.value
        : Object.prototype.hasOwnProperty.call(record, "response")
          ? record.response
          : record.answer;
      responses.set(requestId, response);
    }
    return responses;
  }
  const record = asRecord(value);
  const singularId = String(record.requestId ?? record.request_id ?? record.id ?? "").trim();
  if (singularId) {
    responses.set(singularId, Object.prototype.hasOwnProperty.call(record, "value") ? record.value : record.response ?? record.answer);
    return responses;
  }
  for (const [requestId, response] of Object.entries(record)) responses.set(requestId, response);
  return responses;
}

export function mergeArgumentInputResponses(
  args: Record<string, unknown>,
  requiredFields: string[],
  inputResponses: unknown
): Record<string, unknown> {
  const responses = inputResponseMap(inputResponses);
  const next = { ...args };
  for (const field of requiredFields) {
    const requestId = `argument:${field}`;
    if (responses.has(requestId)) next[field] = responses.get(requestId);
    else if (responses.has(field)) next[field] = responses.get(field);
  }
  return next;
}

export function confirmationGranted(inputResponses: unknown): boolean {
  const responses = inputResponseMap(inputResponses);
  const value = responses.get("confirmation:execute") ?? responses.get("confirm") ?? responses.get("confirmation");
  if (value === true) return true;
  if (typeof value === "string" && ["true", "yes", "confirm", "confirmed", "approve", "approved"].includes(value.trim().toLowerCase())) return true;
  if (value === false || (typeof value === "string" && ["false", "no", "decline", "declined", "cancel", "cancelled"].includes(value.trim().toLowerCase()))) return false;
  throw new McpProtocolError("MRTR confirmation response is missing or invalid.", -32602, {
    requestId: "confirmation:execute"
  });
}
