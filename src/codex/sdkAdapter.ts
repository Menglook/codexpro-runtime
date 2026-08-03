import { randomUUID } from "node:crypto";
import { Codex, type Thread, type ThreadOptions } from "@openai/codex-sdk";
import {
  acquireWorkspaceLeaseSync,
  heartbeatWorkspaceLeaseSync,
  releaseWorkspaceLeaseSync,
  type WorkspaceLease
} from "../../shared/execution-kernel.mjs";
import { recordModelProviderHeartbeat, recordModelStreamEvent, registerModelStreamComponent } from "../execution/modelStreamComponents.js";
import { redactSensitiveText } from "../redact.js";
import { detectCodexCapabilities } from "./capabilities.js";
import { normalizeCodexSdkEvent } from "./eventNormalizer.js";
import { CodexAdapterError, type CodexAdapter, type CodexCapabilities, type CodexEventDraft, type CodexEventStreamOptions, type CodexNormalizedEvent, type CodexResumeInput, type CodexRun, type CodexTaskInput } from "./types.js";

interface SdkRecord {
  run: CodexRun;
  events: CodexNormalizedEvent[];
  waiters: Set<() => void>;
  controller: AbortController;
  thread_options: ThreadOptions;
  workspace_lease?: WorkspaceLease;
  completion?: Promise<void>;
}

function terminal(status: CodexRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function errorCode(message: string): NonNullable<CodexRun["error_code"]> {
  return /auth|login|unauthorized|forbidden|unsupported[_\s-]?(?:country|region|territory)|401|403|credential/i.test(message)
    ? "auth_required"
    : "execution_failed";
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(raw).slice(0, 8_000);
}

function finalAgentMessage(rawValue: unknown): string | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const raw = rawValue as Record<string, unknown>;
  if (raw.type !== "item.completed" || !raw.item || typeof raw.item !== "object") return undefined;
  const item = raw.item as Record<string, unknown>;
  if (item.type !== "agent_message" || typeof item.text !== "string") return undefined;
  return redactSensitiveText(item.text).slice(0, 40_000);
}

export class SdkCodexAdapter implements CodexAdapter {
  readonly provider = "sdk" as const;
  private readonly codex: Codex;
  private readonly executable: string;
  private readonly records = new Map<string, SdkRecord>();
  private capabilitiesCache?: Promise<CodexCapabilities>;

  constructor(options: { executable?: string; codexPathOverride?: string } = {}) {
    this.executable = options.executable?.trim() || "codex";
    this.codex = new Codex(options.codexPathOverride ? { codexPathOverride: options.codexPathOverride } : {});
  }

  async capabilities(): Promise<CodexCapabilities> {
    this.capabilitiesCache ??= detectCodexCapabilities({ provider: "sdk", executable: this.executable });
    return await this.capabilitiesCache;
  }

  async startTask(input: CodexTaskInput): Promise<CodexRun> {
    await this.assertReady(input);
    const threadOptions = this.threadOptions(input);
    const record = this.createRecord(input, threadOptions);
    const thread = this.codex.startThread(threadOptions);
    this.emit(record, { type: "task.started", data: { provider: "sdk", resumed: false } });
    record.completion = this.consume(record, thread, input.prompt);
    return { ...record.run };
  }

  async resumeTask(input: CodexResumeInput): Promise<CodexRun> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex resume prompt cannot be empty.");
    const capabilities = await this.capabilities();
    if (!capabilities.available) throw new CodexAdapterError("provider_unavailable", "The Codex SDK is not available.");
    if (capabilities.authentication === "auth_required") throw new CodexAdapterError("auth_required", "Codex authentication is required. Run `codex login` outside CodexPro.");

    let threadId: string;
    let threadOptions: ThreadOptions;
    let workingDirectory: string;
    let sandboxMode: CodexTaskInput["sandbox_mode"];
    let parentRunId: string | undefined;

    if (input.run_id && this.records.has(input.run_id)) {
      const previous = this.records.get(input.run_id);
      if (!previous) throw new CodexAdapterError("run_not_found", `Codex run not found: ${input.run_id}`);
      if (!previous.run.thread_id) throw new CodexAdapterError("run_not_resumable", `Codex run has no thread id: ${input.run_id}`);
      if (!terminal(previous.run.status)) throw new CodexAdapterError("run_not_resumable", `Codex run is still active: ${input.run_id}`);
      threadId = previous.run.thread_id;
      threadOptions = previous.thread_options;
      workingDirectory = previous.run.working_directory;
      sandboxMode = previous.run.sandbox_mode;
      parentRunId = previous.run.run_id;
    } else {
      if (!input.thread_id?.trim()) throw new CodexAdapterError("invalid_input", "thread_id is required when run_id is unavailable.");
      if (!input.working_directory?.trim()) throw new CodexAdapterError("invalid_input", "working_directory is required when resuming a persisted thread.");
      const recoveredInput: CodexTaskInput = {
        prompt: input.prompt,
        working_directory: input.working_directory,
        sandbox_mode: input.sandbox_mode ?? "read-only",
        approval_policy: input.approval_policy ?? "never",
        model: input.model,
        reasoning_effort: input.reasoning_effort,
        network_access_enabled: input.network_access_enabled ?? false,
        skip_git_repo_check: input.skip_git_repo_check ?? false
      };
      threadId = input.thread_id;
      threadOptions = this.threadOptions(recoveredInput);
      workingDirectory = recoveredInput.working_directory;
      sandboxMode = recoveredInput.sandbox_mode;
      parentRunId = input.run_id;
    }

    const record = this.createRecord({
      prompt: input.prompt,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode
    }, threadOptions, parentRunId, threadId);
    const thread = this.codex.resumeThread(threadId, threadOptions);
    this.emit(record, { type: "task.started", thread_id: threadId, data: { provider: "sdk", resumed: true, recovered: !input.run_id } });
    record.completion = this.consume(record, thread, input.prompt);
    return { ...record.run };
  }

  async cancelTask(runId: string): Promise<CodexRun> {
    const record = this.records.get(runId);
    if (!record) throw new CodexAdapterError("run_not_found", `Codex run not found: ${runId}`);
    if (terminal(record.run.status)) return { ...record.run };
    record.run.cancel_requested = true;
    record.run.updated_at = new Date().toISOString();
    record.controller.abort();
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

  private async assertReady(input: CodexTaskInput): Promise<void> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex task prompt cannot be empty.");
    const capabilities = await this.capabilities();
    if (!capabilities.available) throw new CodexAdapterError("provider_unavailable", "The Codex SDK is not available.");
    if (capabilities.authentication === "auth_required") throw new CodexAdapterError("auth_required", "Codex authentication is required. Run `codex login` outside CodexPro.");
  }

  private threadOptions(input: CodexTaskInput): ThreadOptions {
    return {
      workingDirectory: input.working_directory,
      sandboxMode: input.sandbox_mode ?? "read-only",
      approvalPolicy: input.approval_policy ?? "never",
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning_effort ? { modelReasoningEffort: input.reasoning_effort } : {}),
      networkAccessEnabled: input.network_access_enabled ?? false,
      skipGitRepoCheck: input.skip_git_repo_check ?? false
    };
  }

  private createRecord(
    input: CodexTaskInput,
    threadOptions: ThreadOptions,
    parentRunId?: string,
    threadId?: string
  ): SdkRecord {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const ownerToken = randomUUID();
    const sandboxMode = input.sandbox_mode ?? "read-only";
    const workspaceLease = sandboxMode === "workspace-write"
      ? acquireWorkspaceLeaseSync(input.working_directory, {
          contextDir: ".ai-bridge",
          name: "write",
          kind: "codex-sdk",
          runId,
          pid: process.pid,
          ttlMs: 30_000
        })
      : undefined;
    const run: CodexRun = {
      run_id: runId,
      provider: "sdk",
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
      working_directory: input.working_directory,
      sandbox_mode: sandboxMode,
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
    const record: SdkRecord = {
      run,
      events: [],
      waiters: new Set(),
      controller: new AbortController(),
      thread_options: threadOptions,
      ...(workspaceLease ? { workspace_lease: workspaceLease } : {})
    };
    this.records.set(run.run_id, record);
    registerModelStreamComponent(run, "sdk_stream_created");
    return record;
  }

  private async consume(record: SdkRecord, thread: Thread, prompt: string): Promise<void> {
    const leaseHeartbeat = record.workspace_lease
      ? setInterval(() => {
          try {
            record.workspace_lease = heartbeatWorkspaceLeaseSync(record.run.working_directory, record.workspace_lease!, { contextDir: ".ai-bridge", name: "write" });
          } catch (error) {
            record.controller.abort(error instanceof Error ? error : new Error(String(error)));
          }
        }, 5_000)
      : undefined;
    leaseHeartbeat?.unref?.();
    try {
      const { events } = await thread.runStreamed(prompt, { signal: record.controller.signal });
      for await (const rawEvent of events) {
        if (record.workspace_lease) {
          record.workspace_lease = heartbeatWorkspaceLeaseSync(record.run.working_directory, record.workspace_lease, { contextDir: ".ai-bridge", name: "write" });
        }
        if (rawEvent.type === "thread.started") record.run.thread_id = rawEvent.thread_id;
        const finalResponse = finalAgentMessage(rawEvent);
        if (finalResponse) record.run.final_response = finalResponse;
        for (const draft of normalizeCodexSdkEvent(rawEvent)) {
          this.emit(record, draft);
          this.applyTerminalEvent(record, draft);
        }
      }
      if (!terminal(record.run.status)) {
        this.finish(record, "succeeded", { type: "task.succeeded", data: { provider: "sdk", synthetic: true } });
      }
    } catch (error) {
      if (record.run.cancel_requested || record.controller.signal.aborted) {
        this.finish(record, "cancelled", { type: "task.cancelled", data: { error_code: "cancelled" } });
        return;
      }
      const message = safeMessage(error);
      const code = errorCode(message);
      record.run.error_code = code;
      record.run.error_message = message;
      this.finish(record, "failed", { type: "task.failed", data: { error_code: code, message } });
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (record.workspace_lease) {
        releaseWorkspaceLeaseSync(record.run.working_directory, record.workspace_lease, { contextDir: ".ai-bridge", name: "write" });
        record.workspace_lease = undefined;
      }
    }
  }

  private applyTerminalEvent(record: SdkRecord, draft: CodexEventDraft): void {
    if (draft.type === "task.succeeded") this.markTerminal(record, "succeeded");
    if (draft.type === "task.failed") {
      const message = typeof draft.data?.message === "string" ? draft.data.message : "Codex task failed.";
      const code = errorCode(message);
      record.run.error_code = code;
      record.run.error_message = message;
      this.markTerminal(record, "failed");
    }
    if (draft.type === "task.cancelled") this.markTerminal(record, "cancelled");
  }

  private emit(record: SdkRecord, draft: CodexEventDraft): void {
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
    record.run.last_progress_at = now;
    recordModelStreamEvent(record.run, event);
    for (const waiter of record.waiters) waiter();
    record.waiters.clear();
  }

  private finish(record: SdkRecord, status: CodexRun["status"], event: CodexEventDraft): void {
    if (terminal(record.run.status)) return;
    this.emit(record, event);
    this.markTerminal(record, status);
  }

  private markTerminal(record: SdkRecord, status: CodexRun["status"]): void {
    if (terminal(record.run.status)) return;
    const now = new Date().toISOString();
    record.run.status = status;
    record.run.updated_at = now;
    record.run.completed_at = now;
    if (status === "cancelled") record.run.error_code = "cancelled";
    for (const waiter of record.waiters) waiter();
    record.waiters.clear();
  }
}
