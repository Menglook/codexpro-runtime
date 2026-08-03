import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireWorkspaceLeaseSync,
  heartbeatWorkspaceLeaseSync,
  isProcessAlive,
  releaseWorkspaceLeaseSync,
  runManagedProcess,
  terminateProcessTree,
  type WorkspaceLease
} from "../../shared/execution-kernel.mjs";
import type { AdvisoryReviewReport, ReviewFinding, ReviewRequest } from "../agents/types.js";
import { recordModelProviderHeartbeat, recordModelStreamEvent, registerModelStreamComponent } from "../execution/modelStreamComponents.js";
import { codexProEventBus, type CodexProEventName } from "../events/eventBus.js";
import { redactSensitiveText } from "../redact.js";
import {
  currentResourceAdmissionSnapshot,
  type ResourceAdmissionSnapshot
} from "../resources/resourceGovernor.js";
import { detectCodexCapabilities } from "./capabilities.js";
import {
  CodexAdapterError,
  type CodexAdapter,
  type CodexCapabilities,
  type CodexEventDraft,
  type CodexEventStreamOptions,
  type CodexNormalizedEvent,
  type CodexResumeInput,
  type CodexRun,
  type CodexTaskInput
} from "./types.js";

export type ExecStructuredStatus = "succeeded" | "failed" | "waiting_input" | "waiting_approval";

export interface ExecStructuredResult extends Record<string, unknown> {
  status: ExecStructuredStatus;
  summary: string;
  changed_files: string[];
  follow_up_prompt: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ExecCodexAdapterOptions {
  executable?: string;
  working_directory: string;
  state_directory: string;
  result_schema_path: string;
  review_schema_path: string;
  timeout_ms?: number;
  no_progress_timeout_ms?: number;
  kill_grace_ms?: number;
  heartbeat_failure_threshold?: number;
  review_timeout_ms?: number;
  max_parallel?: number;
  slot_wait_timeout_ms?: number;
  poll_interval_ms?: number;
  max_log_bytes?: number;
}

interface ExecRunRecord {
  run: CodexRun;
  pid: number | null;
  timeout_ms: number;
  no_progress_timeout_ms: number;
  kill_grace_ms: number;
  slot_lease: ExecSlotLease | null;
  output_path: string;
  stdout_path: string;
  stderr_path: string;
  events_path: string;
  command_argv: string[];
  execution_options: {
    model?: string;
    reasoning_effort?: CodexTaskInput["reasoning_effort"];
    skip_git_repo_check: boolean;
  };
  structured_result: ExecStructuredResult | null;
}

type ExecSlotSchedulerMode = "resource_governor" | "legacy_exec_slot";

interface ExecSlotLease {
  slot_path: string;
  slot_index: number;
  run_id: string;
  owner_token: string;
  fencing_token: number;
  scheduler_mode: ExecSlotSchedulerMode;
  resource_lease_id?: string;
  resource_request_id?: string;
  resource_run_id?: string;
  resource_task_id?: string;
  resource_pools?: string[];
}

interface ProcessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  cancelled: boolean;
  tree_terminated: boolean;
  pid: number | null;
  termination_reason: CodexRun["termination_reason"] | null;
  termination_requested_at: string | null;
  force_used: boolean;
  heartbeat_failures: number;
  last_progress_at: string;
}

interface ReviewPayload {
  ok: boolean;
  summary: string;
  findings: ReviewFinding[];
  reviewed_files: string[];
  uncovered_scope: string[];
  error: string | null;
}

function terminal(status: CodexRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function safeText(value: unknown, max = 40_000): string {
  return redactSensitiveText(typeof value === "string" ? value : String(value)).slice(0, max);
}

function safeArray(value: unknown, maxItems = 1_000): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).filter((item): item is string => typeof item === "string").map((item) => safeText(item, 1_000));
}

function safeJson<T>(value: T, depth = 0): T {
  if (depth > 10) return "[CodexPro structured value truncated]" as T;
  if (typeof value === "string") return safeText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => safeJson(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = safeJson(item, depth + 1);
  return out as T;
}

function parseExecResult(raw: unknown): ExecStructuredResult {
  if (!raw || typeof raw !== "object") throw new Error("Exec result is not a JSON object.");
  const value = raw as Record<string, unknown>;
  const status = value.status;
  if (status !== "succeeded" && status !== "failed" && status !== "waiting_input" && status !== "waiting_approval") {
    throw new Error("Exec result has an invalid status.");
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Exec result summary is required.");
  return safeJson({
    status,
    summary: value.summary,
    changed_files: safeArray(value.changed_files),
    follow_up_prompt: typeof value.follow_up_prompt === "string" ? value.follow_up_prompt : null,
    error_code: typeof value.error_code === "string" ? value.error_code : null,
    error_message: typeof value.error_message === "string" ? value.error_message : null
  });
}

function parseReviewPayload(raw: unknown): ReviewPayload {
  if (!raw || typeof raw !== "object") throw new Error("Exec review result is not a JSON object.");
  const value = raw as Record<string, unknown>;
  if (typeof value.ok !== "boolean") throw new Error("Exec review result ok must be boolean.");
  if (typeof value.summary !== "string") throw new Error("Exec review summary is required.");
  const findings = Array.isArray(value.findings)
    ? value.findings.slice(0, 500).map((entry) => {
        const finding = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const severity = finding.severity;
        if (severity !== "P0" && severity !== "P1" && severity !== "P2" && severity !== "P3") {
          throw new Error("Exec review finding has an invalid severity.");
        }
        return safeJson({
          severity,
          file: safeText(finding.file ?? "", 1_000),
          ...(Number.isInteger(finding.line) && Number(finding.line) > 0 ? { line: Number(finding.line) } : {}),
          issue: safeText(finding.issue ?? "", 10_000),
          impact: safeText(finding.impact ?? "", 10_000),
          evidence: safeText(finding.evidence ?? "", 10_000),
          recommendation: safeText(finding.recommendation ?? "", 10_000),
          confidence: Math.max(0, Math.min(1, Number(finding.confidence) || 0))
        } satisfies ReviewFinding);
      })
    : [];
  return safeJson({
    ok: value.ok,
    summary: safeText(value.summary, 20_000),
    findings,
    reviewed_files: safeArray(value.reviewed_files),
    uncovered_scope: safeArray(value.uncovered_scope, 500),
    error: typeof value.error === "string" ? safeText(value.error, 20_000) : null
  });
}

async function emitExecObservation(
  name: CodexProEventName,
  record: ExecRunRecord,
  data: Record<string, unknown> = {}
): Promise<void> {
  try {
    await codexProEventBus.emit(
      name,
      {
        domain: "codex_exec",
        run_id: record.run.run_id,
        provider: record.run.provider,
        status: record.run.status,
        pid: record.pid,
        owner_pid: record.run.owner_pid ?? null,
        owner_token: record.run.owner_token ?? null,
        fencing_token: record.run.fencing_token ?? null,
        executor_pid: record.run.executor_pid ?? null,
        resource_scheduler: record.run.resource_scheduler ?? null,
        resource_lease_id: record.run.resource_lease_id ?? null,
        resource_request_id: record.run.resource_request_id ?? null,
        resource_run_id: record.run.resource_run_id ?? null,
        resource_task_id: record.run.resource_task_id ?? null,
        resource_pools: record.run.resource_pools ?? [],
        ...data
      },
      {
        source: "codex_exec_adapter",
        correlation_id: record.run.run_id,
        task_id: record.run.resource_task_id ?? `codex-${record.run.run_id}`
      }
    );
  } catch {
    // Exec run files and process state remain authoritative when observers fail.
  }
}

export class ExecCodexAdapter implements CodexAdapter {
  readonly provider = "exec" as const;
  private readonly executable: string;
  private readonly workingDirectory: string;
  private readonly stateDirectory: string;
  private readonly resultSchemaPath: string;
  private readonly reviewSchemaPath: string;
  private readonly timeoutMs: number;
  private readonly noProgressTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly heartbeatFailureThreshold: number;
  private readonly reviewTimeoutMs: number;
  private readonly maxParallel: number;
  private readonly slotWaitTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxLogBytes: number;
  private capabilitiesCache?: Promise<CodexCapabilities>;

  constructor(options: ExecCodexAdapterOptions) {
    this.executable = options.executable?.trim() || "codex";
    this.workingDirectory = path.resolve(options.working_directory);
    this.stateDirectory = path.resolve(options.state_directory);
    this.resultSchemaPath = path.resolve(options.result_schema_path);
    this.reviewSchemaPath = path.resolve(options.review_schema_path);
    this.timeoutMs = Math.max(1_000, Math.min(options.timeout_ms ?? 30 * 60_000, 24 * 60 * 60_000));
    this.noProgressTimeoutMs = Math.max(100, Math.min(options.no_progress_timeout_ms ?? Math.min(15 * 60_000, this.timeoutMs), this.timeoutMs));
    this.killGraceMs = Math.max(100, Math.min(options.kill_grace_ms ?? 5_000, 60_000));
    this.heartbeatFailureThreshold = Math.max(1, Math.floor(options.heartbeat_failure_threshold ?? 3));
    this.reviewTimeoutMs = Math.max(1_000, Math.min(options.review_timeout_ms ?? 10 * 60_000, 24 * 60 * 60_000));
    this.maxParallel = Math.max(1, Math.min(options.max_parallel ?? 1, 8));
    this.slotWaitTimeoutMs = Math.max(100, Math.min(options.slot_wait_timeout_ms ?? 10 * 60_000, 24 * 60 * 60_000));
    this.pollIntervalMs = Math.max(25, Math.min(options.poll_interval_ms ?? 100, 2_000));
    this.maxLogBytes = Math.max(4_000, Math.min(options.max_log_bytes ?? 2_000_000, 10_000_000));
  }

  async capabilities(): Promise<CodexCapabilities> {
    this.capabilitiesCache ??= detectCodexCapabilities({ provider: "exec", executable: this.executable });
    return await this.capabilitiesCache;
  }

  async startTask(input: CodexTaskInput): Promise<CodexRun> {
    await this.assertReady(input);
    const record = await this.createRecord(input, this.timeoutMs);
    await this.emit(record, { type: "task.started", data: { provider: "exec", resumed: false } });
    void this.consume(record, input.prompt, false).catch(async (error) => {
      await this.failRecord(record, "exec_runner_error", safeText(error, 8_000));
    });
    return structuredClone(record.run);
  }

  async resumeTask(input: CodexResumeInput): Promise<CodexRun> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex Exec resume prompt cannot be empty.");

    let parentRunId = input.run_id;
    let threadId = input.thread_id?.trim();
    let workingDirectory = input.working_directory?.trim();
    let sandboxMode = input.sandbox_mode;
    let model = input.model;
    let reasoningEffort = input.reasoning_effort;
    let skipGitRepoCheck = input.skip_git_repo_check;

    if (input.run_id) {
      const previous = await this.loadRecord(input.run_id);
      if (!terminal(previous.run.status)) {
        throw new CodexAdapterError("run_not_resumable", `Exec run is still active: ${input.run_id}`);
      }
      threadId = previous.run.thread_id;
      workingDirectory = previous.run.working_directory;
      sandboxMode = previous.run.sandbox_mode;
      model = previous.execution_options.model;
      reasoningEffort = previous.execution_options.reasoning_effort;
      skipGitRepoCheck = previous.execution_options.skip_git_repo_check;
    }

    if (!threadId) throw new CodexAdapterError("run_not_resumable", "Codex Exec run has no persisted thread id.");
    if (!workingDirectory) throw new CodexAdapterError("invalid_input", "working_directory is required for Codex Exec resume.");
    const taskInput: CodexTaskInput = {
      prompt: input.prompt,
      working_directory: workingDirectory,
      sandbox_mode: sandboxMode ?? "read-only",
      approval_policy: input.approval_policy ?? "never",
      model,
      reasoning_effort: reasoningEffort,
      network_access_enabled: input.network_access_enabled ?? false,
      skip_git_repo_check: skipGitRepoCheck ?? false
    };
    await this.assertReady(taskInput);
    const record = await this.createRecord(taskInput, this.timeoutMs, parentRunId, threadId);
    await this.emit(record, {
      type: "task.started",
      thread_id: threadId,
      data: { provider: "exec", resumed: true }
    });
    void this.consume(record, input.prompt, true).catch(async (error) => {
      await this.failRecord(record, "exec_runner_error", safeText(error, 8_000));
    });
    return structuredClone(record.run);
  }

  async cancelTask(runId: string): Promise<CodexRun> {
    const record = await this.loadRecord(runId);
    if (terminal(record.run.status)) return structuredClone(record.run);
    record.run.cancel_requested = true;
    record.run.updated_at = new Date().toISOString();
    await this.saveRecord(record);
    if (record.pid) terminateProcessTree(record.pid, { signal: "SIGTERM" });
    return structuredClone(record.run);
  }

  async getRun(runId: string): Promise<CodexRun> {
    const run = (await this.loadRecord(runId)).run;
    recordModelProviderHeartbeat(run);
    return structuredClone(run);
  }

  async *streamEvents(runId: string, options: CodexEventStreamOptions = {}): AsyncIterable<CodexNormalizedEvent> {
    let cursor = Math.max(0, Number(options.after_sequence ?? 0));
    while (true) {
      const events = await this.readEvents(runId);
      for (const event of events) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield structuredClone(event);
      }
      const run = await this.getRun(runId);
      if (!options.follow || terminal(run.status)) return;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async runReview(request: ReviewRequest): Promise<AdvisoryReviewReport> {
    const capabilities = await this.capabilities();
    if (!capabilities.exec_available) {
      return this.failedReview(request, null, "Codex Exec is not available.");
    }
    const reviewRunId = randomUUID();
    const reviewDir = path.join(this.stateDirectory, `review-${reviewRunId}`);
    await fsp.mkdir(reviewDir, { recursive: true });
    const outputPath = path.join(reviewDir, "review.json");
    const stdoutPath = path.join(reviewDir, "stdout.log");
    const stderrPath = path.join(reviewDir, "stderr.log");
    const slotLease = await this.acquireSlot(`review-${reviewRunId}`);
    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--output-schema",
      this.reviewSchemaPath,
      "-o",
      outputPath,
      "-C",
      this.workingDirectory,
      "-s",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-"
    ];
    const prompt = this.reviewPrompt(request);
    try {
      const result = await this.runProcess(
        args,
        this.workingDirectory,
        prompt,
        this.reviewTimeoutMs,
        async (pid) => await this.updateSlotOwner(slotLease, pid, `review-${reviewRunId}`)
      );
      await this.writeLog(stdoutPath, result.stdout);
      await this.writeLog(stderrPath, result.stderr);
      if (result.timed_out) return this.failedReview(request, reviewRunId, `Exec review timed out after ${this.reviewTimeoutMs} ms.`);
      if (result.exit_code !== 0) {
        return this.failedReview(request, reviewRunId, safeText(result.stderr || result.stdout || "Exec review failed.", 8_000));
      }
      const payload = parseReviewPayload(JSON.parse(await fsp.readFile(outputPath, "utf8")));
      return {
        ok: payload.ok,
        mode: "advisory",
        summary: payload.summary,
        target: request.target,
        findings: payload.findings,
        reviewed_files: payload.reviewed_files,
        uncovered_scope: payload.uncovered_scope,
        workspace_unchanged: true,
        reviewer_run_id: reviewRunId,
        gate_passed: true,
        blocking_findings: [],
        critical_uncovered_scope: [],
        review_policy: {
          mode: "advisory",
          p0_confidence_threshold: 0.5,
          p1_confidence_threshold: 0.7,
          require_critical_scope_covered: false,
          isolated_context: true,
          provider: "exec"
        },
        ...(payload.error ? { error: payload.error } : {}),
        completed_at: new Date().toISOString()
      };
    } catch (error) {
      return this.failedReview(request, reviewRunId, safeText(error, 8_000));
    } finally {
      await this.releaseSlot(slotLease);
    }
  }

  private async assertReady(input: CodexTaskInput): Promise<void> {
    if (!input.prompt.trim()) throw new CodexAdapterError("invalid_input", "Codex Exec prompt cannot be empty.");
    if ((input.approval_policy ?? "never") !== "never") {
      throw new CodexAdapterError("invalid_input", "Exec Runner v1 only allows approval_policy=never for non-interactive execution.");
    }
    if (input.network_access_enabled) {
      throw new CodexAdapterError("invalid_input", "Exec Runner v1 does not enable network access implicitly. Use the SDK path for networked tasks.");
    }
    const capabilities = await this.capabilities();
    if (!capabilities.exec_available) throw new CodexAdapterError("provider_unavailable", "Codex Exec is not available.");
    if (capabilities.authentication === "auth_required") {
      throw new CodexAdapterError("auth_required", "Codex authentication is required. Run `codex login` outside CodexPro.");
    }
  }

  private async createRecord(
    input: CodexTaskInput,
    timeoutMs: number,
    parentRunId?: string,
    threadId?: string
  ): Promise<ExecRunRecord> {
    const runId = randomUUID();
    const ownerToken = randomUUID();
    const resourceAdmission = currentResourceAdmissionSnapshot();
    const runDir = path.join(this.stateDirectory, runId);
    await fsp.mkdir(runDir, { recursive: true });
    const slotLease = await this.acquireSlot(runId, ownerToken, resourceAdmission);
    const now = new Date().toISOString();
    const run: CodexRun = {
      run_id: runId,
      provider: "exec",
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
      fencing_token: resourceAdmission ? resourceAdmission.primary_lease.fencing_token : slotLease.fencing_token,
      resource_scheduler: slotLease.scheduler_mode,
      ...(slotLease.resource_lease_id ? { resource_lease_id: slotLease.resource_lease_id } : {}),
      ...(slotLease.resource_request_id ? { resource_request_id: slotLease.resource_request_id } : {}),
      ...(slotLease.resource_run_id ? { resource_run_id: slotLease.resource_run_id } : {}),
      ...(slotLease.resource_task_id ? { resource_task_id: slotLease.resource_task_id } : {}),
      ...(slotLease.resource_pools ? { resource_pools: [...slotLease.resource_pools] } : {}),
      heartbeat_at: now,
      heartbeat_lease_ms: 30_000,
      last_output_at: now,
      last_progress_at: now,
      hard_deadline: new Date(Date.parse(now) + timeoutMs).toISOString(),
      no_progress_deadline: new Date(Date.parse(now) + Math.min(this.noProgressTimeoutMs, timeoutMs)).toISOString(),
      heartbeat_write_failures: 0
    };
    const record: ExecRunRecord = {
      run,
      pid: null,
      timeout_ms: timeoutMs,
      no_progress_timeout_ms: Math.min(this.noProgressTimeoutMs, timeoutMs),
      kill_grace_ms: this.killGraceMs,
      slot_lease: slotLease,
      output_path: path.join(runDir, "result.json"),
      stdout_path: path.join(runDir, "stdout.log"),
      stderr_path: path.join(runDir, "stderr.log"),
      events_path: path.join(runDir, "events.jsonl"),
      command_argv: [],
      execution_options: {
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
        skip_git_repo_check: input.skip_git_repo_check ?? false
      },
      structured_result: null
    };
    await this.saveRecord(record);
    registerModelStreamComponent(run, "exec_stream_created");
    await emitExecObservation("run_created", record, {
      started_at: now,
      sandbox_mode: run.sandbox_mode,
      parent_run_id: parentRunId ?? null
    });
    return record;
  }

  private async consume(record: ExecRunRecord, prompt: string, resume: boolean): Promise<void> {
    let workspaceLease: WorkspaceLease | undefined;
    try {
      if (record.run.sandbox_mode !== "read-only") {
        workspaceLease = acquireWorkspaceLeaseSync(record.run.working_directory, {
          contextDir: ".ai-bridge",
          name: "write",
          kind: "codex-exec",
          runId: record.run.run_id,
          pid: process.pid,
          ttlMs: 30_000
        });
      }
      const args = this.buildArgs(record, resume);
      record.command_argv = args;
      await this.saveRecord(record);
      const result = await this.runProcess(
        args,
        record.run.working_directory,
        this.execPrompt(prompt),
        record.timeout_ms,
        async (pid) => {
          record.pid = pid;
          const now = new Date().toISOString();
          record.run.executor_pid = pid;
          record.run.owner_pid = pid;
          record.run.heartbeat_at = now;
          record.run.updated_at = now;
          if (workspaceLease) {
            workspaceLease = heartbeatWorkspaceLeaseSync(record.run.working_directory, workspaceLease, {
              contextDir: ".ai-bridge",
              name: "write",
              managedPid: pid
            });
          }
          await this.saveRecord(record);
          await this.updateSlotOwner(record.slot_lease, pid, record.run.run_id);
          await emitExecObservation("owner_acquired", record, {
            managed_pid: pid,
            owner_pid: record.run.owner_pid ?? pid,
            owner_token: record.run.owner_token ?? null,
            fencing_token: record.run.fencing_token ?? null,
            heartbeat_at: now
          });
        },
        workspaceLease
          ? async () => {
              const now = new Date().toISOString();
              record.run.heartbeat_at = now;
              record.run.updated_at = now;
              workspaceLease = heartbeatWorkspaceLeaseSync(record.run.working_directory, workspaceLease!, {
                contextDir: ".ai-bridge",
                name: "write",
                managedPid: record.pid ?? workspaceLease!.managed_pid
              });
              await this.saveRecord(record);
            }
          : async () => {
              const now = new Date().toISOString();
              record.run.heartbeat_at = now;
              record.run.updated_at = now;
              await this.saveRecord(record);
            },
        async (event) => {
          record.run.last_output_at = event.at;
          record.run.last_progress_at = event.at;
          record.run.no_progress_deadline = new Date(Date.parse(event.at) + record.no_progress_timeout_ms).toISOString();
          record.run.heartbeat_write_failures = 0;
          record.run.updated_at = event.at;
          await this.saveRecord(record);
          await emitExecObservation("progress_recorded", record, {
            stream: event.stream,
            bytes: event.bytes,
            progress_at: event.at,
            no_progress_deadline: record.run.no_progress_deadline
          });
        },
        async (error, consecutiveFailures) => {
          record.run.heartbeat_write_failures = consecutiveFailures;
          record.run.updated_at = new Date().toISOString();
          await emitExecObservation("execution_heartbeat", record, {
            heartbeat_error: safeText(error, 2_000),
            consecutive_failures: consecutiveFailures
          });
          await this.saveRecord(record).catch(() => undefined);
        },
        record.no_progress_timeout_ms,
        record.kill_grace_ms
      );
      record.run.termination_reason = result.termination_reason ?? undefined;
      record.run.termination_requested_at = result.termination_requested_at ?? undefined;
      record.run.termination_force_used = result.force_used;
      record.run.heartbeat_write_failures = result.heartbeat_failures;
      record.run.last_progress_at = result.last_progress_at;
      record.run.last_output_at = result.last_progress_at;
      await this.saveRecord(record);
      await this.writeLog(record.stdout_path, result.stdout);
      await this.writeLog(record.stderr_path, result.stderr);
      await this.captureCliEvents(record, result.stdout);
      await this.captureProcessStreams(record, result);
      await this.releaseSlot(record.slot_lease);
      record.slot_lease = null;
      await this.saveRecord(record);
      const persisted = await this.loadRecord(record.run.run_id);
      record.run.cancel_requested = persisted.run.cancel_requested;
      if (record.run.cancel_requested) {
        await this.finish(record, "cancelled", { type: "task.cancelled", data: { provider: "exec", error_code: "cancelled" } });
        return;
      }
      if (result.timed_out) {
        const reason = result.termination_reason === "no_progress_timeout" ? "no_progress_timeout" : "execution_hard_limit";
        const message = reason === "no_progress_timeout"
          ? `Exec run made no real progress for ${record.no_progress_timeout_ms} ms.`
          : `Exec run timed out after ${record.timeout_ms} ms.`;
        await this.failRecord(record, reason, message);
        return;
      }
      if (!result.tree_terminated) {
        record.run.termination_reason = "termination_failed";
        await this.failRecord(record, "termination_failed", "Exec process tree did not fully terminate before the run reached a terminal state.");
        return;
      }
      if (result.exit_code !== 0) {
        await this.failRecord(record, "execution_failed", safeText(result.stderr || result.stdout || "Codex Exec failed.", 8_000));
        return;
      }
      let structured: ExecStructuredResult;
      try {
        structured = parseExecResult(JSON.parse(await fsp.readFile(record.output_path, "utf8")));
      } catch (error) {
        await this.failRecord(record, "invalid_structured_result", safeText(error, 8_000));
        return;
      }
      record.structured_result = structured;
      record.run.final_response = JSON.stringify(structured);
      await this.emit(record, {
        type: "task.output",
        data: {
          provider: "exec",
          summary: structured.summary,
          structured_result: structured
        }
      });
      if (structured.status === "failed") {
        await this.failRecord(record, structured.error_code || "execution_failed", structured.error_message || structured.summary);
        return;
      }
      if (structured.status === "waiting_input") {
        await this.emit(record, {
          type: "task.waiting_input",
          data: { provider: "exec", prompt: structured.follow_up_prompt, structured_result: structured }
        });
      }
      if (structured.status === "waiting_approval") {
        await this.emit(record, {
          type: "task.waiting_approval",
          data: { provider: "exec", prompt: structured.follow_up_prompt, structured_result: structured }
        });
      }
      await this.finish(record, "succeeded", {
        type: "task.succeeded",
        data: {
          provider: "exec",
          structured_result: structured,
          final_response: record.run.final_response
        }
      });
    } finally {
      if (workspaceLease) {
        releaseWorkspaceLeaseSync(record.run.working_directory, workspaceLease, { contextDir: ".ai-bridge", name: "write" });
      }
      await this.releaseSlot(record.slot_lease);
      record.slot_lease = null;
      await this.saveRecord(record).catch(() => undefined);
    }
  }

  private buildArgs(record: ExecRunRecord, resume: boolean): string[] {
    const executionArgs: string[] = [];
    if (record.execution_options.model) executionArgs.push("-m", record.execution_options.model);
    if (record.execution_options.reasoning_effort) {
      executionArgs.push("-c", `model_reasoning_effort="${record.execution_options.reasoning_effort}"`);
    }
    if (record.execution_options.skip_git_repo_check) executionArgs.push("--skip-git-repo-check");

    if (resume) {
      const args = [
        "exec",
        "resume",
        "--json",
        "--output-schema",
        this.resultSchemaPath,
        "-o",
        record.output_path,
        "-c",
        `sandbox_mode="${record.run.sandbox_mode}"`,
        "-c",
        'approval_policy="never"',
        ...executionArgs
      ];
      if (record.run.thread_id) args.push(record.run.thread_id);
      args.push("-");
      return args;
    }
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--output-schema",
      this.resultSchemaPath,
      "-o",
      record.output_path,
      "-C",
      record.run.working_directory,
      "-s",
      record.run.sandbox_mode,
      "-c",
      'approval_policy="never"',
      ...executionArgs,
      "-"
    ];
  }

  private execPrompt(prompt: string): string {
    return [
      prompt.trim(),
      "",
      "CodexPro Exec Runner v1 contract:",
      "- Do not commit, push, merge, publish, or bypass the sandbox.",
      "- Finish with the exact JSON object required by the provided output schema.",
      "- Use status=waiting_input or waiting_approval only when execution cannot safely continue.",
      "- Report only actual changed files; do not invent changes."
    ].join("\n");
  }

  private reviewPrompt(request: ReviewRequest): string {
    return [
      "Perform an independent advisory code review in read-only mode. Do not modify files.",
      "Inspect the selected Git target directly with read-only Git and file inspection commands.",
      `Target: ${JSON.stringify(request.target)}`,
      `Related files: ${JSON.stringify(request.related_files ?? [])}`,
      `Acceptance result: ${JSON.stringify(request.acceptance_result ?? null)}`,
      `Minimal change contract: ${JSON.stringify(request.minimal_change_contract ?? null)}`,
      `Change footprint: ${JSON.stringify(request.change_footprint ?? null)}`,
      `Extra context: ${JSON.stringify(request.extra_context ?? [])}`,
      "Report only evidence-backed findings. Use P0/P1/P2/P3 severity. Check for unexplained scope expansion and missing necessary changes, but do not treat file count or diff size as a correctness rule. If there are no findings, state the reviewed files and any uncovered scope.",
      "Return the exact JSON object required by the provided review output schema."
    ].join("\n");
  }

  private async runProcess(
    args: string[],
    cwd: string,
    stdin: string,
    timeoutMs: number,
    onSpawn?: (pid: number) => Promise<void>,
    onHeartbeat?: () => Promise<void> | void,
    onProgress?: (event: { stream: "stdout" | "stderr"; bytes: number; at: string }) => Promise<void> | void,
    onHeartbeatError?: (error: unknown, consecutiveFailures: number) => Promise<void> | void,
    noProgressTimeoutMs = Math.min(this.noProgressTimeoutMs, timeoutMs),
    killGraceMs = this.killGraceMs
  ): Promise<ProcessResult> {
    const result = await runManagedProcess(this.executable, args, {
      cwd,
      env: process.env,
      stdin,
      timeoutMs,
      noProgressTimeoutMs,
      killGraceMs,
      maxOutputBytes: this.maxLogBytes,
      heartbeatIntervalMs: 5_000,
      heartbeatFailureThreshold: this.heartbeatFailureThreshold,
      onSpawn,
      onHeartbeat,
      onProgress,
      onHeartbeatError,
      redact: (value: unknown) => safeText(value, this.maxLogBytes)
    });
    return {
      exit_code: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      tree_terminated: result.treeTerminated,
      pid: result.pid,
      termination_reason: result.terminationReason,
      termination_requested_at: result.terminationRequestedAt,
      force_used: result.forceUsed,
      heartbeat_failures: result.heartbeatFailures,
      last_progress_at: result.lastProgressAt
    };
  }

  private async captureCliEvents(record: ExecRunRecord, stdout: string): Promise<void> {
    let captured = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim() || captured >= 500) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        captured += 1;
        if (raw.type === "thread.started" && typeof raw.thread_id === "string") {
          record.run.thread_id = safeText(raw.thread_id, 200);
          await this.emit(record, {
            type: "task.checkpointed",
            thread_id: record.run.thread_id,
            data: { provider: "exec", cli_event_type: "thread.started" }
          });
          continue;
        }
        await this.emit(record, {
          type: "task.output",
          data: {
            provider: "exec",
            cli_event_type: safeText(raw.type ?? "unknown", 200),
            cli_event: raw
          }
        });
      } catch {
        // Non-JSON stdout is persisted as a redacted stream event below.
      }
    }
  }

  private async captureProcessStreams(record: ExecRunRecord, result: ProcessResult): Promise<void> {
    for (const [stream, content] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
      if (!content.trim()) continue;
      const maxEventChars = 8_000;
      await this.emit(record, {
        type: "task.output",
        data: {
          provider: "exec",
          stream,
          content: safeText(content, maxEventChars),
          truncated: content.length > maxEventChars
        }
      });
    }
  }

  private async failRecord(record: ExecRunRecord, code: string, message: string): Promise<void> {
    const explicitCodes = new Set([
      "cancelled",
      "resource_wait_timeout",
      "no_progress_timeout",
      "step_timeout",
      "execution_hard_limit",
      "cancel_grace_expired",
      "heartbeat_persistence_failed",
      "termination_failed"
    ]);
    record.run.error_code = explicitCodes.has(code) ? code as NonNullable<CodexRun["error_code"]> : "execution_failed";
    record.run.error_message = safeText(message, 8_000);
    await this.finish(record, "failed", {
      type: "task.failed",
      data: { provider: "exec", error_code: safeText(code, 200), message: record.run.error_message }
    });
  }

  private async finish(record: ExecRunRecord, status: CodexRun["status"], event: CodexEventDraft): Promise<void> {
    if (terminal(record.run.status)) return;
    await this.emit(record, event);
    const now = new Date().toISOString();
    const releasedPid = record.pid;
    record.run.status = status;
    record.run.updated_at = now;
    record.run.completed_at = now;
    record.pid = null;
    if (status === "cancelled") record.run.error_code = "cancelled";
    await this.saveRecord(record);
    await emitExecObservation("execution_exited", record, {
      outcome: status,
      completed_at: now,
      duration_ms: Math.max(0, Date.parse(now) - Date.parse(record.run.started_at))
    });
    await emitExecObservation("owner_released", record, {
      outcome: status,
      owner_pid: record.run.owner_pid ?? releasedPid ?? null,
      managed_pid: releasedPid ?? null,
      completed_at: now
    });
  }

  private async emit(record: ExecRunRecord, draft: CodexEventDraft): Promise<void> {
    await this.assertRecordOwner(record);
    const event: CodexNormalizedEvent = safeJson({
      sequence: record.run.event_count + 1,
      type: draft.type,
      run_id: record.run.run_id,
      ...(draft.thread_id || record.run.thread_id ? { thread_id: draft.thread_id ?? record.run.thread_id } : {}),
      timestamp: new Date().toISOString(),
      ...(draft.data ? { data: draft.data } : {})
    });
    record.run.event_count = event.sequence;
    record.run.updated_at = event.timestamp;
    record.run.heartbeat_at = event.timestamp;
    record.run.last_output_at = event.timestamp;
    recordModelStreamEvent(record.run, event);
    await fsp.mkdir(path.dirname(record.events_path), { recursive: true });
    await fsp.appendFile(record.events_path, `${JSON.stringify(event)}\n`, "utf8");
    await this.saveRecord(record);
    if (draft.type === "task.started") {
      await emitExecObservation("execution_started", record, {
        event_type: draft.type,
        thread_id: event.thread_id ?? null,
        started_at: event.timestamp
      });
    } else if (draft.type === "task.output" || draft.type === "task.checkpointed" || draft.type === "task.waiting_input" || draft.type === "task.waiting_approval") {
      await emitExecObservation("progress_recorded", record, {
        event_type: draft.type,
        thread_id: event.thread_id ?? null,
        progress_at: event.timestamp,
        liveness_at: event.timestamp,
        progress_fingerprint: `${draft.type}:${event.sequence}`
      });
    }
  }

  private async saveRecord(record: ExecRunRecord): Promise<void> {
    const runDir = path.join(this.stateDirectory, record.run.run_id);
    await fsp.mkdir(runDir, { recursive: true });
    const target = path.join(runDir, "run.json");
    await this.assertRecordOwner(record, target);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(temp, `${JSON.stringify(safeJson(record), null, 2)}\n`, "utf8");
    await fsp.rename(temp, target);
  }

  private async assertRecordOwner(record: ExecRunRecord, target = path.join(this.stateDirectory, record.run.run_id, "run.json")): Promise<void> {
    let current: ExecRunRecord | undefined;
    try {
      current = JSON.parse(await fsp.readFile(target, "utf8")) as ExecRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const currentOwner = current.run.owner_token;
    const currentFence = Number(current.run.fencing_token);
    if (!currentOwner && !Number.isFinite(currentFence)) return;
    if (currentOwner !== record.run.owner_token || currentFence !== Number(record.run.fencing_token)) {
      throw new Error(`Exec run ownership changed for ${record.run.run_id}; stale writer refused.`);
    }
    if (terminal(current.run.status) && current.run.status !== record.run.status) {
      throw new Error(`Exec run ${record.run.run_id} is already terminal with status ${current.run.status}.`);
    }
  }

  private async loadRecord(runId: string): Promise<ExecRunRecord> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(runId)) throw new CodexAdapterError("run_not_found", `Invalid Exec run id: ${runId}`);
    try {
      return JSON.parse(await fsp.readFile(path.join(this.stateDirectory, runId, "run.json"), "utf8")) as ExecRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodexAdapterError("run_not_found", `Exec run not found: ${runId}`);
      throw error;
    }
  }

  private async readEvents(runId: string): Promise<CodexNormalizedEvent[]> {
    const record = await this.loadRecord(runId);
    let text = "";
    try {
      text = await fsp.readFile(record.events_path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: CodexNormalizedEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodexNormalizedEvent;
        if (Number.isInteger(event.sequence)) events.push(safeJson(event));
      } catch {
        // Ignore a partial final JSONL line after abrupt termination.
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  private async writeLog(target: string, value: string): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, safeText(value, this.maxLogBytes), "utf8");
  }

  private async acquireSlot(
    runId: string,
    ownerToken = randomUUID(),
    inheritedAdmission: ResourceAdmissionSnapshot | undefined = currentResourceAdmissionSnapshot()
  ): Promise<ExecSlotLease> {
    const slotsDir = path.join(this.stateDirectory, ".slots");
    await fsp.mkdir(slotsDir, { recursive: true });
    const schedulerMode: ExecSlotSchedulerMode = inheritedAdmission ? "resource_governor" : "legacy_exec_slot";
    const started = Date.now();
    const deadline = started + this.slotWaitTimeoutMs;
    while (true) {
      for (let slot = 0; slot < this.maxParallel; slot += 1) {
        const slotPath = path.join(slotsDir, `${slot}.json`);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const handle = await fsp.open(slotPath, "wx");
            try {
              const fencingToken = await this.nextSlotFencingToken(slotPath);
              const resourceLineage = inheritedAdmission
                ? {
                    resource_lease_id: inheritedAdmission.primary_lease.lease_id,
                    resource_request_id: inheritedAdmission.primary_lease.request_id,
                    resource_run_id: inheritedAdmission.primary_lease.run_id,
                    resource_task_id: inheritedAdmission.primary_lease.task_id,
                    resource_pools: [...inheritedAdmission.pools]
                  }
                : {};
              await handle.writeFile(`${JSON.stringify({
                version: 3,
                slot_index: slot,
                run_id: runId,
                owner_id: runId,
                owner_token: ownerToken,
                fencing_token: fencingToken,
                owner_pid: process.pid,
                scheduler_mode: schedulerMode,
                ...resourceLineage,
                created_at: new Date().toISOString(),
                ...(schedulerMode === "legacy_exec_slot" ? { queue_deadline: new Date(deadline).toISOString() } : {})
              })}\n`, "utf8");
              return {
                slot_path: slotPath,
                slot_index: slot,
                run_id: runId,
                owner_token: ownerToken,
                fencing_token: fencingToken,
                scheduler_mode: schedulerMode,
                ...resourceLineage
              };
            } finally {
              await handle.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
              const existing = JSON.parse(await fsp.readFile(slotPath, "utf8")) as { owner_pid?: number };
              if (!existing.owner_pid || !isProcessAlive(existing.owner_pid)) {
                await fsp.rm(slotPath, { force: true });
                continue;
              }
            } catch {
              await fsp.rm(slotPath, { force: true });
              continue;
            }
            break;
          }
        }
      }
      if (schedulerMode === "resource_governor") {
        throw new CodexAdapterError(
          "provider_unavailable",
          `Exec process mutex unavailable after Resource Governor admission (max_parallel=${this.maxParallel}, lease_id=${inheritedAdmission!.primary_lease.lease_id}).`
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, remaining)));
    }
    throw new CodexAdapterError(
      "resource_wait_timeout",
      `resource_wait_timeout: Legacy Exec slot wait timed out after ${Math.max(0, Date.now() - started)} ms (max_parallel=${this.maxParallel}).`
    );
  }

  private async updateSlotOwner(slotLease: ExecSlotLease | null, ownerPid: number, ownerId: string): Promise<void> {
    if (!slotLease) return;
    const existing = await this.readSlot(slotLease.slot_path);
    if (!this.sameSlotLease(existing, slotLease)) throw new Error(`Exec slot ownership changed for ${ownerId}.`);
    const temp = `${slotLease.slot_path}.tmp-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(temp, `${JSON.stringify({
      ...existing,
      owner_id: ownerId,
      owner_pid: ownerPid,
      updated_at: new Date().toISOString()
    })}\n`, "utf8");
    await fsp.rename(temp, slotLease.slot_path);
  }

  private async releaseSlot(slotLease: ExecSlotLease | null): Promise<void> {
    if (!slotLease) return;
    const existing = await this.readSlot(slotLease.slot_path);
    if (!existing || !this.sameSlotLease(existing, slotLease)) return;
    await fsp.rm(slotLease.slot_path, { force: true }).catch(() => undefined);
  }

  private async readSlot(slotPath: string): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(await fsp.readFile(slotPath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private sameSlotLease(existing: Record<string, unknown> | undefined, lease: ExecSlotLease): boolean {
    return existing?.run_id === lease.run_id
      && existing.owner_token === lease.owner_token
      && Number(existing.fencing_token) === lease.fencing_token;
  }

  private async nextSlotFencingToken(slotPath: string): Promise<number> {
    const fencePath = `${slotPath}.fencing.json`;
    const existing = await this.readSlot(fencePath).catch(() => undefined);
    const previous = Number(existing?.fencing_token);
    const next = (Number.isInteger(previous) && previous >= 0 ? previous : 0) + 1;
    const temp = `${fencePath}.tmp-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(temp, `${JSON.stringify({ version: 1, fencing_token: next, updated_at: new Date().toISOString() })}\n`, "utf8");
    await fsp.rename(temp, fencePath);
    return next;
  }

  private failedReview(request: ReviewRequest, runId: string | null, error: string): AdvisoryReviewReport {
    return {
      ok: false,
      mode: "advisory",
      summary: "Exec review did not complete successfully.",
      target: request.target,
      findings: [],
      reviewed_files: [],
      uncovered_scope: request.related_files ?? [],
      workspace_unchanged: true,
      reviewer_run_id: runId,
      gate_passed: false,
      blocking_findings: [],
      critical_uncovered_scope: ["CRITICAL: Exec review did not complete."],
      review_policy: {
        mode: "advisory",
        p0_confidence_threshold: 0.5,
        p1_confidence_threshold: 0.7,
        require_critical_scope_covered: false,
        isolated_context: true,
        provider: "exec"
      },
      error: safeText(error, 8_000),
      completed_at: new Date().toISOString()
    };
  }
}
