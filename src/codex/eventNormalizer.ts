import { redactSensitiveText } from "../redact.js";
import type { CodexEventDraft } from "./types.js";

const OUTPUT_LIMIT = 8_000;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeText(value: unknown, maxChars = OUTPUT_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactSensitiveText(value).trim();
  if (!redacted) return undefined;
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}…`;
}

function safePath(value: unknown): string | undefined {
  const text = safeText(value, 1_000);
  if (!text) return undefined;
  return text.replaceAll("\\", "/");
}

function normalizeItem(itemValue: unknown, rawEventType: string): CodexEventDraft[] {
  const item = recordOf(itemValue);
  if (!item) return [];
  const type = typeof item.type === "string" ? item.type : "unknown";
  const status = typeof item.status === "string" ? item.status : undefined;

  if (type === "agent_message") {
    const text = safeText(item.text);
    return text ? [{ type: "task.output", data: { kind: "agent_message", text, raw_event_type: rawEventType } }] : [];
  }

  if (type === "reasoning") {
    const text = safeText(item.text);
    return text ? [{ type: "task.output", data: { kind: "reasoning_summary", text, raw_event_type: rawEventType } }] : [];
  }

  if (type === "command_execution") {
    const command = safeText(item.command, 2_000);
    const output = rawEventType === "item.completed" ? safeText(item.aggregated_output, 4_000) : undefined;
    const events: CodexEventDraft[] = [{
      type: "task.tool_called",
      data: {
        tool: "shell",
        ...(command ? { command } : {}),
        ...(status ? { status } : {}),
        ...(typeof item.exit_code === "number" ? { exit_code: item.exit_code } : {}),
        raw_event_type: rawEventType
      }
    }];
    if (output) events.push({ type: "task.output", data: { kind: "command_output", text: output, raw_event_type: rawEventType } });
    return events;
  }

  if (type === "file_change") {
    const changes = Array.isArray(item.changes)
      ? item.changes.slice(0, 100).map((changeValue) => {
          const change = recordOf(changeValue);
          if (!change) return undefined;
          const path = safePath(change.path);
          const kind = typeof change.kind === "string" ? change.kind : undefined;
          return path ? { path, ...(kind ? { kind } : {}) } : undefined;
        }).filter(Boolean)
      : [];
    return [{
      type: "task.checkpointed",
      data: {
        kind: "file_change",
        changes,
        ...(status ? { status } : {}),
        raw_event_type: rawEventType
      }
    }];
  }

  if (type === "mcp_tool_call") {
    return [{
      type: "task.tool_called",
      data: {
        tool: safeText(item.tool, 300) ?? "unknown",
        server: safeText(item.server, 300) ?? "unknown",
        ...(status ? { status } : {}),
        raw_event_type: rawEventType
      }
    }];
  }

  if (type === "web_search") {
    return [{
      type: "task.tool_called",
      data: {
        tool: "web_search",
        ...(safeText(item.query, 1_000) ? { query: safeText(item.query, 1_000) } : {}),
        raw_event_type: rawEventType
      }
    }];
  }

  if (type === "todo_list") {
    const itemCount = Array.isArray(item.items) ? item.items.length : 0;
    const completedCount = Array.isArray(item.items)
      ? item.items.filter((todoValue) => recordOf(todoValue)?.completed === true).length
      : 0;
    return [{
      type: "task.checkpointed",
      data: { kind: "todo_list", item_count: itemCount, completed_count: completedCount, raw_event_type: rawEventType }
    }];
  }

  if (type === "error") {
    const message = safeText(item.message) ?? "Codex reported a non-fatal item error.";
    return [{ type: "task.output", data: { kind: "error", message, raw_event_type: rawEventType } }];
  }

  return [{
    type: "task.output",
    data: { kind: "unknown_item", item_type: type, raw_event_type: rawEventType }
  }];
}

function normalizedUsage(value: unknown): Record<string, number> | undefined {
  const usage = recordOf(value);
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
    const item = usage[key];
    if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeCodexSdkEvent(rawValue: unknown): CodexEventDraft[] {
  const raw = recordOf(rawValue);
  if (!raw) return [{ type: "task.output", data: { kind: "invalid_sdk_event" } }];
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const lowered = type.toLowerCase();

  if (type === "thread.started") {
    const threadId = safeText(raw.thread_id, 200);
    return [{
      type: "task.checkpointed",
      ...(threadId ? { thread_id: threadId } : {}),
      data: { kind: "thread_started", raw_event_type: type }
    }];
  }

  if (type === "turn.started") {
    return [{ type: "task.checkpointed", data: { kind: "turn_started", raw_event_type: type } }];
  }

  if (type === "turn.completed") {
    const usage = normalizedUsage(raw.usage);
    return [{ type: "task.succeeded", data: { ...(usage ? { usage } : {}), raw_event_type: type } }];
  }

  if (type === "turn.failed") {
    const error = recordOf(raw.error);
    const message = safeText(error?.message ?? raw.message) ?? "Codex turn failed.";
    return [{ type: "task.failed", data: { error_code: "execution_failed", message, raw_event_type: type } }];
  }

  if (type === "error") {
    const message = safeText(raw.message) ?? "Codex reported a stream error event.";
    return [{ type: "task.output", data: { kind: "stream_error", message, raw_event_type: type } }];
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    return normalizeItem(raw.item, type);
  }

  if (lowered.includes("approval") && (lowered.includes("request") || lowered.includes("wait"))) {
    return [{ type: "task.waiting_approval", data: { raw_event_type: type } }];
  }

  if ((lowered.includes("input") || lowered.includes("question")) && (lowered.includes("request") || lowered.includes("wait"))) {
    return [{ type: "task.waiting_input", data: { raw_event_type: type } }];
  }

  return [{ type: "task.output", data: { kind: "unknown_sdk_event", raw_event_type: type } }];
}
