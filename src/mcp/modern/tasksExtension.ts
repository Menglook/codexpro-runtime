import { McpProtocolError } from "../protocolAdapter.js";
import type { CanonicalMcpRequestContext } from "./requestContext.js";

export const MCP_TASKS_EXTENSION_NAMESPACE = "io.modelcontextprotocol/tasks";

export type ModernToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  context: CanonicalMcpRequestContext
) => Promise<Record<string, unknown>>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isTasksExtensionMethod(method: string): boolean {
  return method.startsWith("extensions/tasks/");
}

export function isMutatingTasksExtensionMethod(method: string): boolean {
  return [
    "extensions/tasks/update",
    "extensions/tasks/cancel",
    "extensions/tasks/resume",
    "extensions/tasks/retry"
  ].includes(method);
}

export async function handleTasksExtensionMethod(
  method: string,
  params: unknown,
  context: CanonicalMcpRequestContext,
  invoke: ModernToolInvoker
): Promise<Record<string, unknown>> {
  const input = asRecord(params);
  const runId = String(input.runId ?? input.run_id ?? context.runId ?? "").trim();
  if (!runId && method !== "extensions/tasks/current") {
    throw new McpProtocolError("Tasks extension requires an explicit runId.", -32602);
  }
  switch (method) {
    case "extensions/tasks/get":
      return invoke("run_task_status", { run_id: runId }, context);
    case "extensions/tasks/result":
      return invoke("read_run_task_result", { run_id: runId, ...(input.maxChars ? { max_chars: input.maxChars } : {}) }, context);
    case "extensions/tasks/update": {
      const action = String(input.action ?? input.operation ?? "").trim().toLowerCase();
      if (action === "cancel") return invoke("cancel_run_task", { run_id: runId }, context);
      if (action === "resume") return invoke("resume_run_task", { run_id: runId }, context);
      if (action === "retry") {
        const stepId = String(input.stepId ?? input.step_id ?? "").trim();
        if (!stepId) throw new McpProtocolError("Task retry update requires stepId.", -32602);
        return invoke("retry_run_task_step", { run_id: runId, step_id: stepId }, context);
      }
      throw new McpProtocolError("Tasks update only permits controlled cancel, resume, or retry actions.", -32602, {
        allowedActions: ["cancel", "resume", "retry"]
      });
    }
    case "extensions/tasks/cancel":
      return invoke("cancel_run_task", { run_id: runId }, context);
    case "extensions/tasks/resume":
      return invoke("resume_run_task", { run_id: runId }, context);
    case "extensions/tasks/retry": {
      const stepId = String(input.stepId ?? input.step_id ?? "").trim();
      if (!stepId) throw new McpProtocolError("Task retry requires stepId.", -32602);
      return invoke("retry_run_task_step", { run_id: runId, step_id: stepId }, context);
    }
    case "extensions/tasks/current":
      return invoke("current_task", {}, context);
    default:
      throw new McpProtocolError("Unknown Tasks extension method.", -32601, { method });
  }
}
