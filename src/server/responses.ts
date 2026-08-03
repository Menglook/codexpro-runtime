import type { CodexProConfig } from "../config.js";
import { runBash } from "../bashOps.js";
import type { CodexAdapter, CodexNormalizedEvent, CodexRun } from "../codex/types.js";
import type { GoalRecord } from "../goals/types.js";
import { redactSensitiveText, redactStructured } from "../redact.js";

export function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

export function codexRunText(title: string, run: CodexRun): string {
  return [
    `# ${title}`,
    "",
    `Run: ${run.run_id}`,
    `Provider: ${run.provider}`,
    `Status: ${run.status}`,
    run.thread_id ? `Thread: ${run.thread_id}` : "Thread: pending",
    run.parent_run_id ? `Parent run: ${run.parent_run_id}` : "",
    `Workspace: ${run.working_directory}`,
    `Sandbox: ${run.sandbox_mode}`,
    `Events: ${run.event_count}`,
    run.final_response ? `\n## Final response\n\n${run.final_response}` : "",
    run.error_message ? `\n## Error\n\n${run.error_message}` : ""
  ].filter(Boolean).join("\n");
}

export function goalText(title: string, goal: GoalRecord): string {
  return [
    `# ${title}`,
    "",
    `Goal: ${goal.goal_id}`,
    `Run: ${goal.run_id}`,
    `Status: ${goal.status}`,
    `Workspace: ${goal.project_root}`,
    `Branch: ${goal.base_branch || "n/a"}`,
    `Codex thread: ${goal.codex_thread_id ?? "pending"}`,
    `Snapshot: ${goal.snapshot_id ?? "pending"}`,
    `Events: ${goal.last_event_sequence}`,
    goal.failure ? `Failure: ${goal.failure.code} — ${goal.failure.message}` : ""
  ].filter(Boolean).join("\n");
}

export async function collectCodexEvents(adapter: CodexAdapter, runId: string, afterSequence = 0): Promise<CodexNormalizedEvent[]> {
  const events: CodexNormalizedEvent[] = [];
  for await (const event of adapter.streamEvents(runId, { after_sequence: afterSequence, follow: false })) events.push(event);
  return events;
}

const TOOL_TEXT_RESPONSE_MAX_CHARS = 60_000;
const TOOL_STRUCTURED_RESPONSE_MAX_BYTES = 128_000;
const TOOL_STRUCTURED_STRING_MAX_CHARS = 4_000;
const TOOL_STRUCTURED_ARRAY_MAX_ITEMS = 25;
const TOOL_STRUCTURED_OBJECT_MAX_KEYS = 80;
const TOOL_STRUCTURED_DEPTH_LIMIT = 6;

function clipTransportText(text: string, maxChars = TOOL_TEXT_RESPONSE_MAX_CHARS): string {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n...[CodexPro response truncated to ${maxChars} chars. Narrow the request or inspect the saved .codexpro/runs report for full details.]`;
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function compactStructuredValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clipTransportText(value, TOOL_STRUCTURED_STRING_MAX_CHARS);
  if (!value || typeof value !== "object") return value;
  if (depth >= TOOL_STRUCTURED_DEPTH_LIMIT) return "[CodexPro structured value truncated: depth limit]";
  if (Array.isArray(value)) {
    const items = value.slice(0, TOOL_STRUCTURED_ARRAY_MAX_ITEMS).map((item) => compactStructuredValue(item, depth + 1));
    if (value.length > TOOL_STRUCTURED_ARRAY_MAX_ITEMS) {
      items.push({ codexpro_truncated_items: value.length - TOOL_STRUCTURED_ARRAY_MAX_ITEMS });
    }
    return items;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, TOOL_STRUCTURED_OBJECT_MAX_KEYS);
  for (const [key, item] of entries) out[key] = compactStructuredValue(item, depth + 1);
  const originalKeys = Object.keys(value).length;
  if (originalKeys > TOOL_STRUCTURED_OBJECT_MAX_KEYS) out.codexpro_truncated_keys = originalKeys - TOOL_STRUCTURED_OBJECT_MAX_KEYS;
  return out;
}

function structuredSummary(value: Record<string, unknown>): Record<string, unknown> {
  const keepKeys = [
    "workspace_id",
    "root",
    "path",
    "run_id",
    "title",
    "status",
    "report_path",
    "technical_report_path",
    "query_count",
    "file_count",
    "operation_count",
    "budget_exceeded",
    "total_chars",
    "error"
  ];
  const out: Record<string, unknown> = {};
  for (const key of keepKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
  }
  out.codexpro_structured_keys = Object.keys(value);
  return out;
}

export function safeStructuredContent(structuredContent: Record<string, unknown> = {}): Record<string, unknown> {
  const redacted = redactStructured(structuredContent);
  if (jsonByteLength(redacted) <= TOOL_STRUCTURED_RESPONSE_MAX_BYTES) return redacted;

  const compacted = compactStructuredValue(redacted);
  if (compacted && typeof compacted === "object" && !Array.isArray(compacted) && jsonByteLength(compacted) <= TOOL_STRUCTURED_RESPONSE_MAX_BYTES) {
    return {
      codexpro_payload_truncated: true,
      codexpro_payload_note: "Structured content exceeded the safe response budget and was compacted.",
      ...(compacted as Record<string, unknown>)
    };
  }

  return {
    codexpro_payload_truncated: true,
    codexpro_payload_note: "Structured content exceeded the safe response budget. Use the text summary and saved report/log paths for full details.",
    ...structuredSummary(redacted)
  };
}

export function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: clipTransportText(text) }],
    structuredContent: safeStructuredContent(structuredContent),
    _meta: meta
  };
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

export function bashTextResult(config: CodexProConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexPro card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

export function errorResult(error: unknown): any {
  const text = errorText(error);
  return {
    isError: true,
    content: [{ type: "text", text: clipTransportText(text, 12_000) }],
    structuredContent: safeStructuredContent({ error: text })
  };
}

