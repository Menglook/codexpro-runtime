import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { appendDurableMessageSync, type DurableMessageEnvelope } from "../messages/messageStore.js";
import { startProcess } from "../runtime/processWrapper.js";

const codexProRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultNotificationScript = path.join(codexProRoot, "scripts", "notifications", "notify-task-finished.sh");
const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TaskCompletionNotificationOptions {
  root: string;
  title: string;
  summary?: string;
  nextStep?: string;
  idempotencyKey?: string;
  projectName?: string;
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  dedupeTtlMs?: number;
  spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => { on?: (event: string, listener: (...args: any[]) => void) => unknown; unref?: () => void };
}

export interface TaskCompletionNotificationResult {
  queued: boolean;
  reason:
    | "notification_process_started"
    | "notification_process_not_started"
    | "notification_spawn_failed"
    | "notification_script_missing"
    | "duplicate_suppressed";
  duplicate?: boolean;
  scriptPath?: string;
  projectName?: string;
  title?: string;
  error?: string;
}

interface CompletionState {
  version: 1;
  entries: Record<string, number>;
}

function expandHome(input: string): string {
  const value = String(input || "").trim();
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function limitText(value: unknown, maxLength: number): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function statePath(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEXPRO_NOTIFICATION_STATE_DIR;
  const dir = path.resolve(expandHome(configured || "~/.codexpro/notifications"));
  return path.join(dir, "task-completion-state.json");
}

function readState(target: string): CompletionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return { version: 1, entries: { ...parsed.entries } };
    }
  } catch {
    // Missing or corrupt local state must not block notifications.
  }
  return { version: 1, entries: {} };
}

function writeState(target: string, state: CompletionState): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

function notificationKey(options: TaskCompletionNotificationOptions, projectName: string, title: string, summary: string): string {
  const identity = options.idempotencyKey?.trim() || `${title}\n${summary}`;
  return createHash("sha256")
    .update(path.resolve(options.root))
    .update("\0")
    .update(projectName)
    .update("\0")
    .update(identity)
    .digest("hex");
}

function compactHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function appendNotificationAck(root: string, message: DurableMessageEnvelope, outcome: "applied" | "duplicate" | "rejected", resultHash: string | null): void {
  const dir = path.join(path.resolve(root), ".ai-bridge", "messages");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(dir, "inbox.jsonl"), `${JSON.stringify({
    version: 1,
    inbox_id: randomUUID(),
    message_id: message.message_id,
    message_type: message.message_type,
    consumer: message.consumer,
    dedupe_key: message.dedupe_key,
    status: outcome === "rejected" ? "rejected" : "applied",
    received_at: at,
    applied_at: outcome === "rejected" ? null : at,
    result_hash: resultHash,
    error: outcome === "rejected" ? message.last_error : null
  })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.appendFileSync(path.join(dir, "acks.jsonl"), `${JSON.stringify({
    version: 1,
    ack_id: randomUUID(),
    message_id: message.message_id,
    message_type: message.message_type,
    consumer: message.consumer,
    dedupe_key: message.dedupe_key,
    received_at: message.created_at,
    applied_at: at,
    outcome,
    resulting_state_version: null,
    resulting_state_hash: resultHash
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function isDuplicate(target: string, key: string, now: number, ttlMs: number): boolean {
  const state = readState(target);
  const previous = Number(state.entries[key]);
  return Number.isFinite(previous) && now - previous >= 0 && now - previous < ttlMs;
}

function rememberDelivery(target: string, key: string, now: number, ttlMs: number): void {
  try {
    const state = readState(target);
    const retained: Record<string, number> = {};
    for (const [entryKey, timestamp] of Object.entries(state.entries)) {
      const numeric = Number(timestamp);
      if (Number.isFinite(numeric) && now - numeric < Math.max(ttlMs, DEFAULT_DEDUPE_TTL_MS)) retained[entryKey] = numeric;
    }
    retained[key] = now;
    writeState(target, { version: 1, entries: retained });
  } catch {
    // Local dedupe persistence is best-effort and must not alter task success.
  }
}

export function dispatchTaskCompletionNotification(options: TaskCompletionNotificationOptions): TaskCompletionNotificationResult {
  const env = options.env ?? process.env;
  const root = path.resolve(options.root);
  const projectName = limitText(options.projectName || path.basename(root) || "codexpro-project", 100);
  const title = limitText(options.title || `${projectName} 任务`, 160);
  const summary = limitText(options.summary || "任务已成功完成。", 500);
  const nextStep = limitText(options.nextStep || "回到 ChatGPT 查看结果。", 300);
  const scriptPath = path.resolve(expandHome(options.scriptPath || defaultNotificationScript));

  if (!fs.existsSync(scriptPath)) {
    return { queued: false, reason: "notification_script_missing", scriptPath, projectName, title };
  }

  const now = options.now ?? Date.now();
  const ttlMs = Math.max(0, options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS);
  const targetStatePath = statePath(env);
  const key = notificationKey(options, projectName, title, summary);
  const message = appendDurableMessageSync(root, {
    message_type: "task.completion.notification",
    producer: "task_complete_tool",
    consumer: "task_completion_notifier",
    task_id: options.idempotencyKey ?? null,
    dedupe_key: key,
    payload: {
      project_name: projectName,
      title,
      summary_hash: compactHash(summary),
      next_step_hash: compactHash(nextStep),
      script_path_hash: compactHash(scriptPath)
    },
    max_attempts: 1
  });
  if (ttlMs > 0 && isDuplicate(targetStatePath, key, now, ttlMs)) {
    appendNotificationAck(root, message, "duplicate", compactHash("duplicate_suppressed"));
    return { queued: false, reason: "duplicate_suppressed", duplicate: true, scriptPath, projectName, title };
  }

  try {
    const child = options.spawnImpl
      ? options.spawnImpl("bash", [scriptPath, title, summary, nextStep, projectName], {
          cwd: codexProRoot,
          env: {
            ...env,
            CODEXPRO_TARGET_ROOT: root,
            CODEXPRO_PROJECT_ROOT: root,
            CODEXPRO_PROJECT_NAME: projectName
          },
          detached: true,
          stdio: "ignore",
          windowsHide: true
        })
      : startProcess("bash", [scriptPath, title, summary, nextStep, projectName], {
          cwd: codexProRoot,
          env: {
            ...env,
            CODEXPRO_TARGET_ROOT: root,
            CODEXPRO_PROJECT_ROOT: root,
            CODEXPRO_PROJECT_NAME: projectName
          },
          detached: true,
          stdio: "ignore",
          domain: "notification",
          operation: "task_completion_notification",
          sideEffectLevel: "external_write",
          riskLevel: "low"
        }).child;
    if (!child || typeof child.unref !== "function") {
      return { queued: false, reason: "notification_process_not_started", scriptPath, projectName, title };
    }
    child.on("error", () => {});
    child.unref();
    rememberDelivery(targetStatePath, key, now, ttlMs);
    appendNotificationAck(root, message, "applied", compactHash("notification_process_started"));
    return { queued: true, reason: "notification_process_started", scriptPath, projectName, title };
  } catch (error) {
    appendNotificationAck(root, message, "rejected", compactHash("notification_spawn_failed"));
    return {
      queued: false,
      reason: "notification_spawn_failed",
      error: error instanceof Error ? error.message : String(error),
      scriptPath,
      projectName,
      title
    };
  }
}
