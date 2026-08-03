import { randomUUID } from "node:crypto";
import { recordModelProviderHeartbeat, recordModelStreamEvent, registerModelStreamComponent } from "../execution/modelStreamComponents.js";
import { CodexAdapterError, type CodexAdapter, type CodexCapabilities, type CodexEventDraft, type CodexEventStreamOptions, type CodexNormalizedEvent, type CodexResumeInput, type CodexRun, type CodexTaskInput } from "./types.js";

interface MockRecord {
  run: CodexRun;
  events: CodexNormalizedEvent[];
  waiters: Set<() => void>;
  timer?: NodeJS.Timeout;
}

function terminal(status: CodexRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export class MockCodexAdapter implements CodexAdapter {
  readonly provider = "mock" as const;
  private readonly records = new Map<string, MockRecord>();

  async capabilities(): Promise<CodexCapabilities> {
    return {
      provider: "mock",
      available: true,
      sdk_available: true,
      sdk_version: "mock",
      cli_available: false,
      authentication: "authenticated",
      authentication_method: "unknown",
      exec_available: false,
      mcp_server_available: false,
      supports: { start: true, resume: true, cancel: true, streaming: true, read_only: true, workspace_write: true },
      notes: ["Mock adapter is deterministic and does not call Codex or consume quota."]
    };
  }

  async startTask(input: CodexTaskInput): Promise<CodexRun> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex task prompt cannot be empty.");
    const record = this.createRecord(input, undefined, `mock-thread-${randomUUID()}`);
    this.emit(record, { type: "task.started", thread_id: record.run.thread_id, data: { provider: "mock" } });
    this.schedule(record, input.prompt);
    return { ...record.run };
  }

  async resumeTask(input: CodexResumeInput): Promise<CodexRun> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex resume prompt cannot be empty.");
    let threadId: string;
    let workingDirectory: string;
    let sandboxMode: CodexTaskInput["sandbox_mode"];
    let parentRunId: string | undefined;

    if (input.run_id && this.records.has(input.run_id)) {
      const previous = this.records.get(input.run_id);
      if (!previous) throw new CodexAdapterError("run_not_found", `Codex run not found: ${input.run_id}`);
      if (!previous.run.thread_id) throw new CodexAdapterError("run_not_resumable", `Codex run has no thread id: ${input.run_id}`);
      threadId = previous.run.thread_id;
      workingDirectory = previous.run.working_directory;
      sandboxMode = previous.run.sandbox_mode;
      parentRunId = previous.run.run_id;
    } else {
      if (!input.thread_id?.trim()) throw new CodexAdapterError("invalid_input", "thread_id is required when run_id is unavailable.");
      if (!input.working_directory?.trim()) throw new CodexAdapterError("invalid_input", "working_directory is required when resuming a persisted thread.");
      threadId = input.thread_id;
      workingDirectory = input.working_directory;
      sandboxMode = input.sandbox_mode ?? "read-only";
      parentRunId = input.run_id;
    }

    const record = this.createRecord({
      prompt: input.prompt,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode
    }, parentRunId, threadId);
    this.emit(record, { type: "task.started", thread_id: record.run.thread_id, data: { provider: "mock", resumed: true, recovered: !input.run_id } });
    this.schedule(record, input.prompt);
    return { ...record.run };
  }

  async cancelTask(runId: string): Promise<CodexRun> {
    const record = this.records.get(runId);
    if (!record) throw new CodexAdapterError("run_not_found", `Codex run not found: ${runId}`);
    if (terminal(record.run.status)) return { ...record.run };
    record.run.cancel_requested = true;
    if (record.timer) clearTimeout(record.timer);
    this.finish(record, "cancelled", { type: "task.cancelled", data: { error_code: "cancelled" } });
    return { ...record.run };
  }

  async getRun(runId: string): Promise<CodexRun> {
    const record = this.records.get(runId);
    if (!record) throw new CodexAdapterError("run_not_found", `Codex run not found: ${runId}`);
    recordModelProviderHeartbeat(record.run);
    return { ...record.run };
  }

  async *streamEvents(runId: string, options: CodexEventStreamOptions = {}): AsyncIterable<CodexNormalizedEvent> {
    const record = this.records.get(runId);
    if (!record) throw new CodexAdapterError("run_not_found", `Codex run not found: ${runId}`);
    let cursor = Math.max(0, Number(options.after_sequence ?? 0));
    while (true) {
      const pending = record.events.filter((event) => event.sequence > cursor);
      for (const event of pending) {
        cursor = event.sequence;
        yield { ...event, data: event.data ? { ...event.data } : undefined };
      }
      if (!options.follow || terminal(record.run.status)) return;
      await new Promise<void>((resolve) => record.waiters.add(resolve));
    }
  }

  private createRecord(input: CodexTaskInput, parentRunId?: string, threadId?: string): MockRecord {
    const now = new Date().toISOString();
    const ownerToken = randomUUID();
    const run: CodexRun = {
      run_id: randomUUID(),
      provider: "mock",
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
      working_directory: input.working_directory,
      sandbox_mode: input.sandbox_mode ?? "read-only",
      status: "running",
      started_at: now,
      updated_at: now,
      cancel_requested: false,
      event_count: 0,
      host_pid: process.pid,
      supervisor_pid: process.pid,
      provider_pid: process.pid,
      owner_pid: process.pid,
      owner_token: ownerToken,
      fencing_token: 1,
      heartbeat_at: now,
      heartbeat_lease_ms: 30_000,
      last_output_at: now
    };
    const record: MockRecord = { run, events: [], waiters: new Set() };
    this.records.set(run.run_id, record);
    registerModelStreamComponent(run, "mock_stream_created");
    return record;
  }

  private schedule(record: MockRecord, prompt: string): void {
    if (prompt.includes("[mock:wait]")) return;
    record.timer = setTimeout(() => {
      if (terminal(record.run.status)) return;
      if (prompt.includes("[mock:fail]")) {
        this.emit(record, { type: "task.output", data: { kind: "mock", text: "Mock failure requested." } });
        this.finish(record, "failed", { type: "task.failed", data: { error_code: "execution_failed", message: "Mock failure requested." } });
        return;
      }
      if (prompt.includes("[mock:waiting_input]")) {
        this.emit(record, { type: "task.waiting_input", data: { kind: "mock" } });
      }
      if (prompt.includes("[mock:waiting_approval]")) {
        this.emit(record, { type: "task.waiting_approval", data: { kind: "mock" } });
      }
      this.emit(record, { type: "task.output", data: { kind: "agent_message", text: `Mock response: ${prompt}` } });
      record.run.final_response = `Mock response: ${prompt}`;
      this.finish(record, "succeeded", { type: "task.succeeded", data: { provider: "mock" } });
    }, 10);
  }

  private emit(record: MockRecord, draft: CodexEventDraft): void {
    const now = new Date().toISOString();
    const event: CodexNormalizedEvent = {
      sequence: record.events.length + 1,
      type: draft.type,
      run_id: record.run.run_id,
      ...(draft.thread_id || record.run.thread_id ? { thread_id: draft.thread_id ?? record.run.thread_id } : {}),
      timestamp: now,
      ...(draft.data ? { data: { ...draft.data } } : {})
    };
    record.events.push(event);
    record.run.event_count = record.events.length;
    record.run.updated_at = now;
    record.run.heartbeat_at = now;
    record.run.last_output_at = now;
    recordModelStreamEvent(record.run, event);
    for (const waiter of record.waiters) waiter();
    record.waiters.clear();
  }

  private finish(record: MockRecord, status: CodexRun["status"], event: CodexEventDraft): void {
    record.run.status = status;
    const now = new Date().toISOString();
    record.run.updated_at = now;
    record.run.completed_at = now;
    if (status === "cancelled") record.run.error_code = "cancelled";
    if (status === "failed") record.run.error_code = "execution_failed";
    this.emit(record, event);
  }
}
