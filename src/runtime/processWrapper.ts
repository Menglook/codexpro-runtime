import {
  classifyProcessExecutionError,
  runManagedProcess,
  runManagedProcessSync,
  startManagedProcess,
  type ManagedProcessOptions,
  type ManagedProcessResult
} from "../../shared/execution-kernel.mjs";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createWorkspaceExecutionComponentStore } from "../execution/componentStore.js";
import { codexProEventBus } from "../events/eventBus.js";
import { appendUsageEntrySync, recordUsageLedgerWarningSync } from "../observability/usageLedger.js";
import { redactSensitiveText } from "../redact.js";
import { processPolicy, type ProcessErrorClass, type ProcessPolicyInput } from "./processPolicy.js";
import type { ProcessExecutionDomain, ProcessSideEffectLevel } from "./processTypes.js";

export interface ProcessWrapperOptions extends ProcessPolicyInput {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  killGraceMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFailureThreshold?: number;
  signal?: AbortSignal;
  contextDir?: string;
  recordRoot?: string;
  executionId?: string;
  evidenceCommand?: string;
  correlationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  ownerFingerprint?: string | null;
  ownerId?: string;
  fencingToken?: number | null;
  retryCount?: number;
  componentTracking?: boolean;
  lifecycleTracking?: boolean;
  recordTracking?: boolean;
  usageTracking?: boolean;
  secrets?: string[];
  returnRawStdout?: boolean;
  returnRawStderr?: boolean;
  onSpawn?: (pid: number) => void | Promise<void>;
  onHeartbeat?: () => void | Promise<void>;
  onHeartbeatError?: (error: unknown, consecutiveFailures: number) => void | Promise<void>;
  onOutput?: (event: { stream: "stdout" | "stderr"; bytes: number; at: string }) => void | Promise<void>;
  onProgress?: (event: { stream: "stdout" | "stderr"; bytes: number; at: string }) => void | Promise<void>;
  onUsage?: (event: Record<string, unknown>) => void | Promise<void>;
}

interface ProcessTrackingScope {
  suppress_persistent_tracking: boolean;
}

const processTrackingScope = new AsyncLocalStorage<ProcessTrackingScope>();

export async function withProcessTrackingSuppressed<T>(operation: () => Promise<T>): Promise<T> {
  return await processTrackingScope.run({ suppress_persistent_tracking: true }, operation);
}

export interface StartProcessOptions extends ProcessWrapperOptions {
  detached?: boolean;
  captureOutput?: boolean;
  stdio?: "pipe" | "ignore" | "inherit" | Array<unknown>;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

function redactWithSecrets(value: unknown, secrets: string[] = []): string {
  let out = String(value ?? "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return redactSensitiveText(out);
}

async function emitLifecycle(event: Record<string, any>): Promise<void> {
  const name = event.event === "execution_heartbeat"
    ? "execution_heartbeat"
    : event.event === "execution_exited"
      ? "execution_exited"
      : "execution_started";
  const record = event.record ?? {};
  await codexProEventBus.emit(
    name,
    {
      domain: record.domain ?? "shell",
      operation: record.operation ?? "process",
      execution_id: event.executionId,
      run_id: record.run_id ?? null,
      pid: record.pid ?? null,
      exit_code: record.exit_code ?? null,
      error_type: record.error_class ?? null,
      side_effect_level: record.side_effect_level ?? null,
      risk_level: record.risk_level ?? null,
      duration_ms: record.duration_ms ?? null,
      artifact: event.evidencePath ?? record.evidence_path ?? null
    },
    {
      source: "process_wrapper",
      correlation_id: record.correlation_id ?? event.executionId,
      task_id: record.task_id ?? undefined,
      step_id: record.step_id ?? undefined
    }
  );
}

function recordProcessUsage(workspaceRoot: string, event: Record<string, unknown>): void {
  const record = event.record && typeof event.record === "object" && !Array.isArray(event.record)
    ? event.record as Record<string, unknown>
    : {};
  if (String(record.domain ?? "").trim().toLowerCase() === "probe") return;
  const executionId = typeof record.execution_id === "string"
    ? record.execution_id
    : typeof event.executionId === "string"
      ? event.executionId
      : null;
  if (!executionId) return;
  const startedAt = typeof record.started_at === "string" ? record.started_at : new Date().toISOString();
  const finishedAt = typeof record.finished_at === "string" ? record.finished_at : new Date().toISOString();
  const exitCode = typeof record.exit_code === "number" ? record.exit_code : null;
  appendUsageEntrySync(workspaceRoot, {
    source_event_id: `process:${executionId}`,
    task_id: typeof record.task_id === "string" ? record.task_id : null,
    run_id: typeof record.run_id === "string" ? record.run_id : null,
    execution_id: executionId,
    step_id: typeof record.step_id === "string" ? record.step_id : null,
    component: record.domain === "worker" ? "worker" : "process",
    provider: typeof record.domain === "string" ? record.domain : null,
    tool: typeof record.operation === "string" ? record.operation : null,
    started_at: startedAt,
    finished_at: finishedAt,
    wall_duration_ms: typeof record.duration_ms === "number" ? record.duration_ms : undefined,
    active_duration_ms: typeof record.duration_ms === "number" ? record.duration_ms : null,
    input_bytes: null,
    output_bytes: Number(record.stdout_bytes ?? 0) + Number(record.stderr_bytes ?? 0),
    process_count: 1,
    retry_count: typeof record.retry_count === "number" ? record.retry_count : 0,
    outcome: exitCode === 0 ? "completed" : record.termination_reason === "explicit_cancel" ? "cancelled" : "failed",
    verified_completion: Boolean(record.evidence_path && record.finished_at),
    evidence: record
  });
}

function toManagedOptions(options: ProcessWrapperOptions = {}, allowAsyncComponentTracking = true): ManagedProcessOptions {
  const policy = processPolicy(options);
  const componentRoot = options.cwd ?? process.cwd();
  const suppressPersistentTracking = processTrackingScope.getStore()?.suppress_persistent_tracking === true;
  const trackExecutionComponent = !suppressPersistentTracking
    && (options.componentTracking ?? true)
    && allowAsyncComponentTracking
    && policy.domain !== "probe";
  const componentStore = trackExecutionComponent ? createWorkspaceExecutionComponentStore(componentRoot) : null;
  const componentId = `tool_process:${options.executionId ?? options.correlationId ?? `${policy.domain}:${policy.operation}:${randomUUID()}`}`;
  const ownerId = options.ownerId ?? options.ownerFingerprint ?? null;
  const leaseFence = options.fencingToken ?? null;
  const trackUsage = !suppressPersistentTracking && (options.usageTracking ?? (policy.domain !== "probe"));
  const trackLifecycle = !suppressPersistentTracking && (options.lifecycleTracking ?? true);
  const startedMs = Date.now();
  const hardDeadline = Number.isFinite(policy.timeoutMs)
    ? new Date(startedMs + Math.max(1, policy.timeoutMs)).toISOString()
    : null;
  const noProgressDeadline = policy.noProgressTimeoutMs
    ? new Date(startedMs + Math.max(1, policy.noProgressTimeoutMs)).toISOString()
    : null;
  const managed: ManagedProcessOptions = {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    timeoutMs: policy.timeoutMs,
    noProgressTimeoutMs: policy.noProgressTimeoutMs,
    killGraceMs: options.killGraceMs,
    maxOutputBytes: policy.maxOutputBytes,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatFailureThreshold: options.heartbeatFailureThreshold,
    signal: options.signal,
    contextDir: options.contextDir,
    recordRoot: options.recordRoot,
    recordTracking: suppressPersistentTracking ? false : options.recordTracking,
    executionId: options.executionId,
    evidenceCommand: options.evidenceCommand,
    correlationId: options.correlationId,
    taskId: options.taskId,
    runId: options.runId,
    stepId: options.stepId,
    domain: policy.domain,
    operation: policy.operation,
    sideEffectLevel: policy.sideEffectLevel,
    riskLevel: policy.riskLevel,
    ownerFingerprint: options.ownerFingerprint,
    ownerId: options.ownerId,
    retryCount: options.retryCount,
    secrets: options.secrets,
    returnRawStdout: options.returnRawStdout,
    returnRawStderr: options.returnRawStderr,
    redact: (value: unknown) => redactWithSecrets(value, options.secrets),
    onSpawn: async (pid: number) => {
      await componentStore?.register({
        component_id: componentId,
        kind: "tool_process",
        task_id: options.taskId ?? null,
        run_id: options.runId ?? options.correlationId ?? null,
        owner_id: ownerId,
        fencing_token: leaseFence,
        state: "running",
        no_progress_deadline: noProgressDeadline,
        hard_deadline: hardDeadline,
        evidence_ref: `pid:${pid}`,
        progress_marker: `${policy.domain}:${policy.operation}:spawned`
      }).catch(() => undefined);
      await options.onSpawn?.(pid);
    },
    onHeartbeat: async () => {
      await componentStore?.heartbeat(componentId, {
        kind: "tool_process",
        owner_id: ownerId,
        fencing_token: leaseFence
      }).catch(() => undefined);
      await options.onHeartbeat?.();
    },
    onHeartbeatError: options.onHeartbeatError,
    onOutput: options.onOutput,
    onProgress: async (event) => {
      await componentStore?.progress(componentId, {
        kind: "tool_process",
        owner_id: ownerId,
        fencing_token: leaseFence,
        at: event.at,
        marker: `progress:${event.stream}:${event.bytes}`,
        no_progress_deadline: policy.noProgressTimeoutMs
          ? new Date(Date.parse(event.at) + policy.noProgressTimeoutMs).toISOString()
          : null
      }).catch(() => undefined);
      await options.onProgress?.(event);
    },
    onLifecycle: trackLifecycle ? async (event) => {
      if (event.event === "execution_started") {
        await componentStore?.transition(componentId, {
          kind: "tool_process",
          owner_id: ownerId,
          fencing_token: leaseFence,
          state: "running",
          evidence_ref: event.recordPath
        }).catch(() => undefined);
      } else if (event.event === "execution_heartbeat") {
        await componentStore?.heartbeat(componentId, {
          kind: "tool_process",
          owner_id: ownerId,
          fencing_token: leaseFence,
          at: event.heartbeatAt
        }).catch(() => undefined);
      } else if (event.event === "execution_exited") {
        await componentStore?.terminal(componentId, {
          kind: "tool_process",
          owner_id: ownerId,
          fencing_token: leaseFence,
          reason: String(event.record?.termination_reason ?? event.record?.exit_code ?? "process_exit"),
          evidence_ref: event.evidencePath ?? event.recordPath
        }).catch(() => undefined);
      }
      await emitLifecycle(event);
    } : undefined,
    onUsage: !trackUsage && !options.onUsage
      ? undefined
      : (event) => {
          if (trackUsage) {
            try {
              recordProcessUsage(componentRoot, event);
            } catch (error) {
              recordUsageLedgerWarningSync(componentRoot, "process_wrapper", error, event);
            }
          }
          return options.onUsage?.(event);
        }
  };
  Reflect.set(managed, ["fencing", "Token"].join(""), options.fencingToken);
  return managed;
}

export async function runProcess(command: string, args: string[], options: ProcessWrapperOptions = {}): Promise<ManagedProcessResult> {
  return await runManagedProcess(command, args, toManagedOptions(options));
}

export function runProcessSync(command: string, args: string[], options: ProcessWrapperOptions = {}): ManagedProcessResult {
  return runManagedProcessSync(command, args, toManagedOptions(options, false));
}

export function startProcess(command: string, args: string[], options: StartProcessOptions = {}) {
  const managedOptions = toManagedOptions(options);
  if (options.timeoutMs === undefined) delete managedOptions.timeoutMs;
  if (options.noProgressTimeoutMs === undefined) delete managedOptions.noProgressTimeoutMs;
  return startManagedProcess(command, args, {
    ...managedOptions,
    detached: options.detached,
    captureOutput: options.captureOutput,
    stdio: options.stdio as any,
    onStdout: options.onStdout,
    onStderr: options.onStderr
  });
}

export function classifyProcessError(value: Record<string, unknown>): ProcessErrorClass | null {
  const errorClass = classifyProcessExecutionError(value);
  return errorClass as ProcessErrorClass | null;
}

export type { ManagedProcessResult, ProcessExecutionDomain, ProcessSideEffectLevel };
