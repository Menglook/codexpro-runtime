import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 1_500;
const OWNER_STATE_FIELD = "owner_" + "token";
const FENCING_STATE_FIELD = "fencing_" + "token";
const DEFAULT_CONTEXT_DIR = ".ai-bridge";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function runtimeTempDir() {
  const candidate = os.tmpdir();
  if (process.platform !== "win32" && /^\/mnt\/[a-z](?:\/|$)/i.test(candidate)) return "/tmp";
  return candidate;
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported by every platform/filesystem.
  }
}

function bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function compactString(value, max = 8_000) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 32))}\n...[truncated]`;
}

function defaultRedact(value, secrets = []) {
  let out = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  out = out
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/?#]{1,255}:)[^@\s]{1,512}(@)/gi, "$1[REDACTED]$2")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "$1 [REDACTED]")
    .replace(/\b([A-Z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE)[A-Z0-9_]{0,64})=([^\s"']+)/gi, "$1=[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]");
  return out;
}

function commandDisplay(command, args) {
  return [command, ...(Array.isArray(args) ? args : [])].map((part) => String(part)).join(" ");
}

function commandFingerprint(command, args, cwd) {
  return sha256(JSON.stringify({
    command: String(command ?? ""),
    args: Array.isArray(args) ? args.map((arg) => String(arg)) : [],
    cwd: path.resolve(cwd || process.cwd())
  }));
}

function normalizeDomain(value) {
  const domain = String(value || "shell");
  return ["shell", "git", "model", "worker", "hook", "notification", "adapter", "probe", "server"].includes(domain)
    ? domain
    : "shell";
}

function normalizeSideEffectLevel(value) {
  const level = String(value || "none");
  return ["none", "local_read", "local_write", "external_write"].includes(level) ? level : "none";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateCommand(command, args) {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
    return "Command must be a non-empty string without NUL bytes.";
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    return "Command arguments must be strings without NUL bytes.";
  }
  return null;
}

function processExecutionPaths(options, executionId, cwd) {
  const sideEffectLevel = normalizeSideEffectLevel(options.sideEffectLevel ?? options.side_effect_level);
  const defaultRoot = sideEffectLevel === "none" || sideEffectLevel === "local_read"
    ? path.join(runtimeTempDir(), "codexpro-process-records", sha256(path.resolve(cwd || process.cwd())).slice(0, 24))
    : path.resolve(cwd || process.cwd());
  const root = path.resolve(options.recordRoot || options.root || defaultRoot);
  const contextDir = options.contextDir || DEFAULT_CONTEXT_DIR;
  return {
    root,
    contextDir,
    recordPath: path.resolve(options.recordPath || path.join(root, contextDir, "execution", "process-records", `${executionId}.json`)),
    evidencePath: path.resolve(options.evidencePath || path.join(root, contextDir, "execution", "process-evidence", `${executionId}.json`))
  };
}

function createProcessExecutionContext(command, args, options = {}, startedAt = new Date()) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const executionId = options.executionId || options.execution_id || randomUUID();
  const paths = processExecutionPaths(options, executionId, cwd);
  const startedIso = startedAt.toISOString();
  const fingerprint = commandFingerprint(command, args, cwd);
  const evidenceCommand = typeof options.evidenceCommand === "string" && options.evidenceCommand.trim()
    ? options.evidenceCommand.trim()
    : null;
  const ownerFingerprint = options.ownerFingerprint ?? options.owner_fingerprint ?? sha256(
    String(options.ownerId || options.owner_id || `process:${process.pid}:${process.ppid ?? 0}:${paths.root}`)
  ).slice(0, 32);
  const baseRecord = {
    version: 1,
    execution_id: executionId,
    correlation_id: options.correlationId ?? options.correlation_id ?? null,
    task_id: options.taskId ?? options.task_id ?? null,
    run_id: options.runId ?? options.run_id ?? null,
    step_id: options.stepId ?? options.step_id ?? null,
    domain: normalizeDomain(options.domain),
    operation: String(options.operation || command || "process").slice(0, 200),
    command_fingerprint: fingerprint,
    cwd,
    side_effect_level: normalizeSideEffectLevel(options.sideEffectLevel ?? options.side_effect_level),
    risk_level: String(options.riskLevel ?? options.risk_level ?? "low").slice(0, 80),
    owner_fingerprint: ownerFingerprint,
    fencing_token: numberOrNull(options.fencingToken ?? options.fencing_token),
    pid: null,
    started_at: startedIso,
    last_heartbeat_at: null,
    last_progress_at: startedIso,
    finished_at: startedIso,
    duration_ms: 0,
    exit_code: null,
    signal: null,
    termination_reason: null,
    tree_terminated: true,
    stdout_bytes: 0,
    stderr_bytes: 0,
    output_truncated: false,
    stdout_hash: EMPTY_SHA256,
    stderr_hash: EMPTY_SHA256,
    error_class: null,
    retry_count: Math.max(0, Math.floor(Number(options.retryCount ?? options.retry_count ?? 0) || 0)),
    evidence_path: paths.evidencePath
  };
  return {
    executionId,
    commandFingerprint: fingerprint,
    recordPath: paths.recordPath,
    evidencePath: paths.evidencePath,
    evidenceCommand,
    recordTracking: options.recordTracking !== false,
    root: paths.root,
    contextDir: paths.contextDir,
    redact: typeof options.redact === "function"
      ? options.redact
      : (value) => defaultRedact(value, options.secrets || []),
    baseRecord,
    record: { ...baseRecord }
  };
}

function writeProcessRecordSync(ctx, patch = {}) {
  ctx.record = { ...ctx.record, ...patch };
  if (!ctx.recordTracking) return ctx.record;
  atomicWriteJsonSync(ctx.recordPath, ctx.record);
  return ctx.record;
}

async function emitProcessLifecycle(options, event, ctx, patch = {}) {
  if (typeof options.onLifecycle !== "function") return;
  try {
    const observer = Promise.resolve(options.onLifecycle({
      event,
      executionId: ctx.executionId,
      recordPath: ctx.recordPath,
      evidencePath: ctx.evidencePath,
      record: { ...ctx.record },
      ...patch
    })).catch(() => undefined);
    await Promise.race([observer, sleep(500)]);
  } catch {
    // Observers must not alter process execution semantics.
  }
}

function emitProcessLifecycleSync(options, event, ctx, patch = {}) {
  if (typeof options.onLifecycle !== "function") return;
  try {
    const result = options.onLifecycle({
      event,
      executionId: ctx.executionId,
      recordPath: ctx.recordPath,
      evidencePath: ctx.evidencePath,
      record: { ...ctx.record },
      ...patch
    });
    if (result && typeof result.catch === "function") result.catch(() => undefined);
  } catch {
    // Observers must not alter process execution semantics.
  }
}

function textForClassification(result = {}, error) {
  return [
    result.stderr,
    result.stdout,
    result.error,
    error instanceof Error ? error.message : error
  ].filter(Boolean).join("\n").toLowerCase();
}

export function classifyProcessExecutionError(input = {}) {
  const result = input.result || input;
  const error = input.error || result.error;
  const code = String(error?.code || result.errorCode || "");
  const reason = String(result.terminationReason || result.termination_reason || "");
  const text = textForClassification(result, error);
  const status = result.exitCode ?? result.exit_code ?? result.status;
  const hasExitStatus = typeof status === "number";

  if (reason === "invalid_command" || code === "EINVAL") return "invalid_command";
  if (reason === "explicit_cancel" || result.cancelled) return "explicit_cancel";
  if (reason === "no_progress_timeout") return "no_progress_timeout";
  if (reason === "execution_hard_limit" || result.timedOut || code === "ETIMEDOUT") return "execution_hard_limit";
  if (reason === "heartbeat_persistence_failed") return "heartbeat_persistence_failed";
  if (reason === "process_tree_termination_failed" || reason === "termination_failed") return "process_tree_termination_failed";
  if (!hasExitStatus && (code === "ENOENT" || /enoent|not found|command not found|no such file or directory/.test(text))) return "spawn_unavailable";
  if (!hasExitStatus && (code === "EACCES" || code === "EPERM" || /permission denied|operation not permitted|access is denied/.test(text))) return "permission_denied";
  if (/workspace[_ -]?(?:write[_ -]?)?lease.*busy|workspace_write_lease_busy|active writer/.test(text)) return "workspace_lease_busy";
  if (/owner mismatch|owner_mismatch|state_owner_mismatch|ownership changed/.test(text)) return "owner_mismatch";
  if (/fencing mismatch|fencing_mismatch|state_fencing_mismatch/.test(text)) return "fencing_mismatch";
  if (/tls|ssl|certificate|gnutls|schannel|x509/.test(text)) return "network_tls";
  if (/could not resolve host|temporary failure in name resolution|enotfound|eai_again|dns/.test(text)) return "network_dns";
  if (/proxy|407|could not resolve proxy|unable to connect to proxy|proxy authentication required/.test(text)) return "network_proxy";
  if (/non-fast-forward|\[rejected\]|remote rejected|authentication failed|access denied|repository not found|permission denied \(publickey\)|requested url returned error:\s*(?:401|403)/.test(text)) return "remote_rejected";
  if (result.spawnError || (!hasExitStatus && error)) return "spawn_unavailable";
  if (hasExitStatus && status !== 0) return "nonzero_exit";
  return null;
}

function terminalProcessRecord(ctx, result, stdout, stderr, finishedAt = new Date()) {
  const redactedStdout = String(stdout ?? "");
  const redactedStderr = String(stderr ?? "");
  const errorClass = classifyProcessExecutionError({ result });
  return {
    pid: Number.isInteger(Number(result.pid)) && Number(result.pid) >= 0 ? Number(result.pid) : null,
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, Math.floor(Number(result.durationMs ?? result.duration_ms ?? 0) || 0)),
    exit_code: Number.isInteger(Number(result.exitCode ?? result.exit_code ?? result.status))
      ? Number(result.exitCode ?? result.exit_code ?? result.status)
      : null,
    signal: stringOrNull(result.signal),
    termination_reason: result.terminationReason ?? result.termination_reason ?? null,
    tree_terminated: result.treeTerminated ?? result.tree_terminated ?? true,
    stdout_bytes: bytes(redactedStdout),
    stderr_bytes: bytes(redactedStderr),
    output_truncated: Boolean(result.truncated ?? result.output_truncated),
    stdout_hash: sha256(redactedStdout),
    stderr_hash: sha256(redactedStderr),
    last_heartbeat_at: result.lastHeartbeatAt ?? result.last_heartbeat_at ?? ctx.record.last_heartbeat_at ?? null,
    last_progress_at: result.lastProgressAt ?? result.last_progress_at ?? ctx.record.last_progress_at ?? ctx.record.started_at,
    error_class: errorClass
  };
}

function writeProcessEvidenceSync(ctx, command, args, result, stdout, stderr) {
  if (!ctx.recordTracking) return;
  atomicWriteJsonSync(ctx.evidencePath, {
    version: 1,
    execution_id: ctx.executionId,
    command_fingerprint: ctx.commandFingerprint,
    command: ctx.redact(ctx.evidenceCommand || commandDisplay(command, args)),
    cwd: ctx.record.cwd,
    started_at: ctx.record.started_at,
    finished_at: new Date().toISOString(),
    result: {
      exit_code: result.exitCode ?? result.exit_code ?? result.status ?? null,
      signal: result.signal ?? null,
      termination_reason: result.terminationReason ?? result.termination_reason ?? null,
      error_class: result.errorClass ?? result.error_class ?? classifyProcessExecutionError({ result }),
      duration_ms: result.durationMs ?? result.duration_ms ?? null,
      tree_terminated: result.treeTerminated ?? result.tree_terminated ?? true
    },
    stdout: compactString(stdout, 200_000),
    stderr: compactString(stderr, 200_000)
  });
}

export function atomicWriteFileSync(filePath, value, options = {}) {
  const dir = path.dirname(filePath);
  safeMkdir(dir);
  const mode = options.mode ?? 0o600;
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${suffix}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, mode); } catch {}
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
  }
}

export function atomicWriteJsonSync(filePath, value, options = {}) {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function appendJsonLineSync(filePath, value, options = {}) {
  safeMkdir(path.dirname(filePath));
  const fd = fs.openSync(filePath, "a", options.mode ?? 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonFileSync(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createRunIdentity(kind = "execution", runId) {
  return {
    version: 1,
    runId: runId || randomUUID(),
    ownerId: randomBytes(24).toString("hex"),
    ["fencing" + "Token"]: 0,
    kind,
    pid: process.pid
  };
}

export function createRunDirectorySync(root, contextDir, runId) {
  const dir = path.resolve(root, contextDir, "runs", runId);
  safeMkdir(dir);
  return dir;
}

export function atomicWriteOwnedJsonSync(filePath, value, options = {}) {
  const ownerId = options.ownerId || value?.[OWNER_STATE_FIELD];
  const fencingToken = Number(options.fencingToken ?? value?.[FENCING_STATE_FIELD]);
  const current = readJsonFileSync(filePath);
  if (!options.replaceOwner && current?.[OWNER_STATE_FIELD] && ownerId && current[OWNER_STATE_FIELD] !== ownerId) {
    const error = new Error(`State owner mismatch for ${filePath}. Refusing stale writer overwrite.`);
    error.code = "STATE_OWNER_MISMATCH";
    throw error;
  }
  if (
    !options.replaceOwner
    && Number.isFinite(Number(current?.[FENCING_STATE_FIELD]))
    && Number.isFinite(fencingToken)
    && Number(current[FENCING_STATE_FIELD]) !== fencingToken
  ) {
    const error = new Error(`State fencing mismatch for ${filePath}. Refusing stale writer overwrite.`);
    error.code = "STATE_FENCING_MISMATCH";
    throw error;
  }
  atomicWriteJsonSync(filePath, value, options);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isProcessTreeAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {}
  }
  return isProcessAlive(pid);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const force = Boolean(options.force);
  const signal = force ? "SIGKILL" : (options.signal || "SIGTERM");
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, shell: false });
    if (result.status === 0 || !isProcessAlive(pid)) return true;
  } else {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return !isProcessAlive(pid);
  }
}

export async function waitForProcessTreeExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessTreeAlive(pid)) return true;
    await sleep(50);
  }
  return !isProcessTreeAlive(pid);
}

function boundedAppend(current, chunk, maxBytes) {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return { value: current, truncated: true };
  const buffer = Buffer.from(`${current}${String(chunk)}`, "utf8");
  if (buffer.byteLength <= maxBytes) return { value: buffer.toString("utf8"), truncated: false };
  return { value: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function runManagedProcess(command, args, options = {}) {
  const started = Date.now();
  const startedAt = new Date(started);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? 30_000));
  const killGraceMs = Math.max(100, Number(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  const maxOutputBytes = Math.max(1_024, Number(options.maxOutputBytes ?? 120_000));
  const heartbeatMs = Math.max(100, Number(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS));
  const configuredNoProgressMs = Number(options.noProgressTimeoutMs ?? 0);
  const noProgressTimeoutMs = Number.isFinite(configuredNoProgressMs) && configuredNoProgressMs > 0
    ? Math.max(100, configuredNoProgressMs)
    : null;
  const heartbeatFailureThreshold = Math.max(1, Number(options.heartbeatFailureThreshold ?? 3));
  const ctx = createProcessExecutionContext(command, args, options, startedAt);
  const redact = ctx.redact;

  const finishImmediate = async (patch) => {
    const stdout = redact(patch.stdout ?? "");
    const stderr = redact(patch.stderr ?? "");
    const result = {
      exitCode: patch.exitCode ?? null,
      signal: patch.signal ?? null,
      durationMs: Date.now() - started,
      timedOut: Boolean(patch.timedOut),
      cancelled: Boolean(patch.cancelled),
      stdout,
      stderr,
      truncated: false,
      spawnError: Boolean(patch.spawnError),
      pid: null,
      treeTerminated: true,
      terminationReason: patch.terminationReason ?? null,
      terminationRequestedAt: patch.terminationRequestedAt ?? null,
      forceUsed: false,
      heartbeatFailures: 0,
      lastProgressAt: startedAt.toISOString()
    };
    result.errorClass = classifyProcessExecutionError({ result, error: patch.error });
    result.executionId = ctx.executionId;
    result.commandFingerprint = ctx.commandFingerprint;
    result.recordPath = ctx.recordPath;
    result.evidencePath = ctx.evidencePath;
    writeProcessEvidenceSync(ctx, command, args, result, stdout, stderr);
    writeProcessRecordSync(ctx, terminalProcessRecord(ctx, result, stdout, stderr));
    await emitProcessLifecycle(options, "execution_exited", ctx, { result });
    if (typeof options.onUsage === "function") {
      await Promise.resolve(options.onUsage({ record: { ...ctx.record }, result })).catch(() => undefined);
    }
    return result;
  };

  const validationError = validateCommand(command, args);
  if (validationError) {
    writeProcessRecordSync(ctx);
    return await finishImmediate({
      stderr: `[codexpro] ${validationError}`,
      spawnError: true,
      terminationReason: "invalid_command",
      error: Object.assign(new Error(validationError), { code: "EINVAL" })
    });
  }

  writeProcessRecordSync(ctx);
  await emitProcessLifecycle(options, "execution_started", ctx);

  if (options.signal?.aborted) {
    return await finishImmediate({
      cancelled: true,
      stderr: "[codexpro] Command cancelled before process start.",
      terminationReason: "explicit_cancel",
      terminationRequestedAt: new Date().toISOString()
    });
  }

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: Boolean(options.shell),
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch (error) {
      void finishImmediate({
        stderr: error instanceof Error ? error.message : String(error),
        spawnError: true,
        terminationReason: "spawn_unavailable",
        error
      }).then(resolve);
      return;
    }

    const pid = child.pid ?? null;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let spawnHookError;
    let forceTimer;
    let noProgressTimer;
    let terminationReason = null;
    let terminationRequestedAt = null;
    let forceUsed = false;
    let heartbeatFailures = 0;
    let lastProgressAt = startedAt.toISOString();
    let lastHeartbeatAt = null;
    let heartbeatWork = Promise.resolve();
    let observerWork = Promise.resolve();

    try {
      writeProcessRecordSync(ctx, { pid, last_progress_at: lastProgressAt });
    } catch (error) {
      spawnHookError = error;
      terminationReason = "heartbeat_persistence_failed";
    }

    const requestTermination = (reason) => {
      if (!pid || settled) return;
      if (reason === "timeout") {
        timedOut = true;
        terminationReason ??= "execution_hard_limit";
      } else if (reason === "no_progress") {
        timedOut = true;
        terminationReason ??= "no_progress_timeout";
      } else if (reason === "cancel") {
        cancelled = true;
        terminationReason ??= "explicit_cancel";
      } else if (reason === "heartbeat_failure") {
        terminationReason ??= "heartbeat_persistence_failed";
      } else if (reason === "spawn_hook") {
        terminationReason ??= "spawn_hook_failed";
      }
      terminationRequestedAt ??= new Date().toISOString();
      terminateProcessTree(pid, { force: false });
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          forceUsed = true;
          if (terminationReason === "explicit_cancel") terminationReason = "cancel_grace_expired";
          terminateProcessTree(pid, { force: true });
          if (!settled) void finish(null, "SIGKILL", undefined);
        }, killGraceMs);
        forceTimer.unref?.();
      }
    };

    const markProgress = (stream, chunkBytes, at = new Date().toISOString()) => {
      lastProgressAt = at;
      try {
        writeProcessRecordSync(ctx, { last_progress_at: at, pid });
      } catch {
        // Progress persistence is best-effort; heartbeat persistence remains the liveness gate.
      }
      if (typeof options.onProgress === "function") {
        observerWork = observerWork.then(() => options.onProgress({ stream, bytes: chunkBytes, at })).catch(() => undefined);
      }
    };

    const spawnReady = pid && typeof options.onSpawn === "function"
      ? Promise.resolve(options.onSpawn(pid)).catch((error) => {
          spawnHookError = error;
          requestTermination("spawn_hook");
        })
      : Promise.resolve();

    child.stdout?.on("data", (chunk) => {
      const next = boundedAppend(stdout, chunk, maxOutputBytes);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
      const at = new Date().toISOString();
      const chunkBytes = Buffer.byteLength(chunk);
      markProgress("stdout", chunkBytes, at);
      if (typeof options.onOutput === "function") {
        observerWork = observerWork.then(() => options.onOutput({ stream: "stdout", bytes: chunkBytes, at })).catch(() => undefined);
      }
    });
    child.stderr?.on("data", (chunk) => {
      const next = boundedAppend(stderr, chunk, maxOutputBytes);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
      const at = new Date().toISOString();
      const chunkBytes = Buffer.byteLength(chunk);
      markProgress("stderr", chunkBytes, at);
      if (typeof options.onOutput === "function") {
        observerWork = observerWork.then(() => options.onOutput({ stream: "stderr", bytes: chunkBytes, at })).catch(() => undefined);
      }
    });

    void spawnReady.then(() => {
      if (spawnHookError) {
        child.stdin?.destroy();
      } else if (options.stdin !== undefined) {
        child.stdin?.end(String(options.stdin));
      }
    });

    const timeout = setTimeout(() => requestTermination("timeout"), timeoutMs);
    timeout.unref?.();
    if (noProgressTimeoutMs !== null) {
      const noProgressPollMs = Math.max(50, Math.min(heartbeatMs, Math.floor(noProgressTimeoutMs / 4)));
      noProgressTimer = setInterval(() => {
        const last = Date.parse(lastProgressAt);
        if (Number.isFinite(last) && Date.now() - last >= noProgressTimeoutMs) requestTermination("no_progress");
      }, noProgressPollMs);
      noProgressTimer.unref?.();
    }
    const heartbeat = setInterval(() => {
      heartbeatWork = heartbeatWork
        .then(async () => {
          if (typeof options.onHeartbeat === "function") await options.onHeartbeat();
          lastHeartbeatAt = new Date().toISOString();
          writeProcessRecordSync(ctx, { last_heartbeat_at: lastHeartbeatAt, last_progress_at: lastProgressAt, pid });
          heartbeatFailures = 0;
          await emitProcessLifecycle(options, "execution_heartbeat", ctx, { heartbeatAt: lastHeartbeatAt });
        })
        .catch((error) => {
          heartbeatFailures += 1;
          if (typeof options.onHeartbeatError === "function") {
            Promise.resolve(options.onHeartbeatError(error, heartbeatFailures)).catch(() => undefined);
          }
          if (heartbeatFailures >= heartbeatFailureThreshold) {
            spawnHookError ||= error;
            requestTermination("heartbeat_failure");
          }
        });
    }, heartbeatMs);
    heartbeat.unref?.();

    const abortHandler = () => requestTermination("cancel");
    options.signal?.addEventListener?.("abort", abortHandler, { once: true });

    const finish = async (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (noProgressTimer) clearInterval(noProgressTimer);
      clearInterval(heartbeat);
      options.signal?.removeEventListener?.("abort", abortHandler);
      await spawnReady;
      await Promise.race([heartbeatWork.catch(() => undefined), sleep(killGraceMs)]);
      await Promise.race([observerWork.catch(() => undefined), sleep(killGraceMs)]);

      let treeTerminated = true;
      if (pid && isProcessTreeAlive(pid)) {
        terminateProcessTree(pid, { force: false });
        treeTerminated = await waitForProcessTreeExit(pid, killGraceMs);
        if (!treeTerminated) {
          forceUsed = true;
          terminateProcessTree(pid, { force: true });
          treeTerminated = await waitForProcessTreeExit(pid, Math.max(2_000, killGraceMs));
        }
      }
      if (!treeTerminated) terminationReason = "process_tree_termination_failed";

      const suffix = [
        terminationReason === "no_progress_timeout" ? `[codexpro] Command made no real progress for ${noProgressTimeoutMs} ms.` : "",
        terminationReason === "execution_hard_limit" ? `[codexpro] Command timed out after ${timeoutMs} ms.` : "",
        cancelled ? "[codexpro] Command cancelled." : "",
        !treeTerminated ? "[codexpro] Managed process tree did not fully exit before the termination deadline." : "",
        spawnHookError ? redact(spawnHookError instanceof Error ? spawnHookError.message : String(spawnHookError)) : "",
        error ? redact(error instanceof Error ? error.message : String(error)) : ""
      ].filter(Boolean).join("\n");
      const stdoutWithMarker = stdoutTruncated
        ? `${stdout}\n...[output truncated to ${maxOutputBytes} bytes]`
        : stdout;
      const stderrWithMarker = stderrTruncated
        ? `${stderr}\n...[output truncated to ${maxOutputBytes} bytes]`
        : stderr;
      const finalErr = suffix ? `${stderrWithMarker}${stderrWithMarker ? "\n" : ""}${suffix}` : stderrWithMarker;
      const redactedStdout = redact(stdoutWithMarker);
      const redactedStderr = redact(finalErr);
      const result = {
        exitCode: spawnHookError ? null : exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        stdout: options.returnRawStdout ? stdoutWithMarker : redactedStdout,
        stderr: options.returnRawStderr ? finalErr : redactedStderr,
        truncated: stdoutTruncated || stderrTruncated,
        spawnError: Boolean(error) || Boolean(spawnHookError),
        pid,
        treeTerminated,
        terminationReason,
        terminationRequestedAt,
        forceUsed,
        heartbeatFailures,
        lastProgressAt,
        lastHeartbeatAt,
        executionId: ctx.executionId,
        commandFingerprint: ctx.commandFingerprint,
        recordPath: ctx.recordPath,
        evidencePath: ctx.evidencePath
      };
      result.errorClass = classifyProcessExecutionError({ result, error: error || spawnHookError });
      const persistedResult = { ...result, stdout: redactedStdout, stderr: redactedStderr };
      writeProcessEvidenceSync(ctx, command, args, persistedResult, redactedStdout, redactedStderr);
      writeProcessRecordSync(ctx, terminalProcessRecord(ctx, persistedResult, redactedStdout, redactedStderr));
      await emitProcessLifecycle(options, "execution_exited", ctx, { result: persistedResult });
      if (typeof options.onUsage === "function") {
        await Promise.resolve(options.onUsage({ record: { ...ctx.record }, result: persistedResult })).catch(() => undefined);
      }
      resolve(result);
    };

    child.once("error", (error) => { void finish(null, null, error); });
    child.once("close", (code, signal) => { void finish(code, signal, undefined); });
  });
}

export function runManagedProcessSync(command, args, options = {}) {
  const started = Date.now();
  const startedAt = new Date(started);
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs ?? options.timeout ?? 30_000));
  const maxOutputBytes = Math.max(1_024, Number(options.maxOutputBytes ?? options.maxBuffer ?? 120_000));
  const ctx = createProcessExecutionContext(command, args, options, startedAt);
  const redact = ctx.redact;

  const finish = (result, rawStdout = "", rawStderr = "", error) => {
    const rawStdoutText = Buffer.isBuffer(rawStdout) ? rawStdout.toString("utf8") : String(rawStdout ?? "");
    const rawStderrText = Buffer.isBuffer(rawStderr) ? rawStderr.toString("utf8") : String(rawStderr ?? "");
    const redactedStdout = redact(rawStdoutText);
    const redactedStderr = redact(rawStderrText);
    result.stdout = options.returnRawStdout ? rawStdoutText : redactedStdout;
    result.stderr = options.returnRawStderr ? rawStderrText : redactedStderr;
    result.durationMs = Math.max(0, Date.now() - started);
    result.executionId = ctx.executionId;
    result.commandFingerprint = ctx.commandFingerprint;
    result.recordPath = ctx.recordPath;
    result.evidencePath = ctx.evidencePath;
    result.errorClass = classifyProcessExecutionError({ result, error });
    const persistedResult = { ...result, stdout: redactedStdout, stderr: redactedStderr };
    writeProcessEvidenceSync(ctx, command, args, persistedResult, redactedStdout, redactedStderr);
    writeProcessRecordSync(ctx, terminalProcessRecord(ctx, persistedResult, redactedStdout, redactedStderr));
    emitProcessLifecycleSync(options, "execution_exited", ctx, { result: persistedResult });
    if (typeof options.onUsage === "function") {
      try { options.onUsage({ record: { ...ctx.record }, result: persistedResult }); } catch {}
    }
    return result;
  };

  const validationError = validateCommand(command, args);
  writeProcessRecordSync(ctx);
  emitProcessLifecycleSync(options, "execution_started", ctx);
  if (validationError) {
    return finish({
      exitCode: null,
      status: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      spawnError: true,
      pid: null,
      treeTerminated: true,
      terminationReason: "invalid_command",
      terminationRequestedAt: null,
      forceUsed: false,
      heartbeatFailures: 0,
      lastProgressAt: startedAt.toISOString()
    }, "", `[codexpro] ${validationError}`, Object.assign(new Error(validationError), { code: "EINVAL" }));
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    shell: Boolean(options.shell),
    windowsHide: true,
    stdio: options.stdio || "pipe"
  });
  const spawnFailed = Boolean(result.error && result.status === null);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const stdout = result.stdout ?? "";
  const stderrParts = [
    result.stderr ?? "",
    timedOut ? `[codexpro] Command timed out after ${timeoutMs} ms.` : "",
    spawnFailed && !timedOut ? result.error.message : ""
  ].filter(Boolean);
  return finish({
    exitCode: result.status,
    status: result.status,
    signal: result.signal,
    timedOut,
    cancelled: false,
    truncated: false,
    spawnError: spawnFailed,
    pid: result.pid ?? null,
    treeTerminated: true,
    terminationReason: timedOut ? "execution_hard_limit" : null,
    terminationRequestedAt: timedOut ? new Date().toISOString() : null,
    forceUsed: timedOut,
    heartbeatFailures: 0,
    lastProgressAt: startedAt.toISOString(),
    error: result.error ? result.error.message : undefined
  }, stdout, stderrParts.join("\n"), result.error);
}

export function startManagedProcess(command, args, options = {}) {
  const started = Date.now();
  const startedAt = new Date(started);
  const maxOutputBytes = Math.max(1_024, Number(options.maxOutputBytes ?? 120_000));
  const killGraceMs = Math.max(100, Number(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
  const heartbeatMs = Math.max(100, Number(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS));
  const heartbeatFailureThreshold = Math.max(1, Number(options.heartbeatFailureThreshold ?? 3));
  const configuredTimeoutMs = Number(options.timeoutMs ?? 0);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.max(1_000, configuredTimeoutMs)
    : null;
  const configuredNoProgressMs = Number(options.noProgressTimeoutMs ?? 0);
  const noProgressTimeoutMs = Number.isFinite(configuredNoProgressMs) && configuredNoProgressMs > 0
    ? Math.max(100, configuredNoProgressMs)
    : null;
  const ctx = createProcessExecutionContext(command, args, options, startedAt);
  const redact = ctx.redact;
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  let child = null;
  let heartbeatTimer;
  let timeoutTimer;
  let noProgressTimer;
  let forceTimer;
  let abortHandler;
  let heartbeatFailures = 0;
  let lastHeartbeatAt = null;
  let lastProgressAt = startedAt.toISOString();
  let cancelled = false;
  let timedOut = false;
  let terminationReason = null;
  let terminationRequestedAt = null;
  let forceUsed = false;
  let spawnHookError;
  let spawnReady = Promise.resolve();
  let heartbeatWork = Promise.resolve();
  let observerWork = Promise.resolve();
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  let requestTermination = () => false;
  const cancel = () => requestTermination("explicit_cancel");

  const validationError = validateCommand(command, args);
  writeProcessRecordSync(ctx);
  emitProcessLifecycleSync(options, "execution_started", ctx);
  if (validationError) {
    const result = {
      exitCode: null,
      signal: null,
      durationMs: Date.now() - started,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: `[codexpro] ${validationError}`,
      truncated: false,
      spawnError: true,
      pid: null,
      treeTerminated: true,
      terminationReason: "invalid_command",
      terminationRequestedAt: null,
      forceUsed: false,
      heartbeatFailures: 0,
      lastProgressAt: startedAt.toISOString(),
      executionId: ctx.executionId,
      commandFingerprint: ctx.commandFingerprint,
      recordPath: ctx.recordPath,
      evidencePath: ctx.evidencePath,
      errorClass: "invalid_command"
    };
    writeProcessEvidenceSync(ctx, command, args, result, result.stdout, result.stderr);
    writeProcessRecordSync(ctx, terminalProcessRecord(ctx, result, result.stdout, result.stderr));
    resolveCompletion(result);
    return { child: null, completion, cancel, ...result };
  }

  const finalize = async (exitCode, signal, error) => {
    if (settled) return;
    settled = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (noProgressTimer) clearInterval(noProgressTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (abortHandler) options.signal?.removeEventListener?.("abort", abortHandler);
    await spawnReady;
    await heartbeatWork;
    await observerWork;

    let treeTerminated = true;
    if (child?.pid && isProcessTreeAlive(child.pid)) {
      terminateProcessTree(child.pid, { force: false });
      treeTerminated = await waitForProcessTreeExit(child.pid, killGraceMs);
      if (!treeTerminated) {
        forceUsed = true;
        terminateProcessTree(child.pid, { force: true });
        treeTerminated = await waitForProcessTreeExit(child.pid, Math.max(2_000, killGraceMs));
      }
    }
    if (!treeTerminated) terminationReason = "process_tree_termination_failed";

    const effectiveError = error || spawnHookError;
    const redactedStdout = redact(stdoutTruncated ? `${stdout}\n...[output truncated to ${maxOutputBytes} bytes]` : stdout);
    const suffix = effectiveError ? redact(effectiveError instanceof Error ? effectiveError.message : String(effectiveError)) : "";
    const redactedStderr = redact([
      stderrTruncated ? `${stderr}\n...[output truncated to ${maxOutputBytes} bytes]` : stderr,
      terminationReason === "no_progress_timeout" ? `[codexpro] Command made no real progress for ${noProgressTimeoutMs} ms.` : "",
      terminationReason === "execution_hard_limit" ? `[codexpro] Command timed out after ${timeoutMs} ms.` : "",
      cancelled ? "[codexpro] Command cancelled." : "",
      !treeTerminated ? "[codexpro] Managed process tree did not fully exit before the termination deadline." : "",
      suffix
    ].filter(Boolean).join("\n"));
    const result = {
      exitCode: spawnHookError ? null : exitCode,
      signal,
      durationMs: Date.now() - started,
      timedOut,
      cancelled,
      stdout: redactedStdout,
      stderr: redactedStderr,
      truncated: stdoutTruncated || stderrTruncated,
      spawnError: Boolean(effectiveError),
      pid: child?.pid ?? null,
      treeTerminated,
      terminationReason: terminationReason ?? (effectiveError ? "spawn_unavailable" : null),
      terminationRequestedAt,
      forceUsed,
      heartbeatFailures,
      lastProgressAt,
      lastHeartbeatAt,
      executionId: ctx.executionId,
      commandFingerprint: ctx.commandFingerprint,
      recordPath: ctx.recordPath,
      evidencePath: ctx.evidencePath
    };
    result.errorClass = classifyProcessExecutionError({ result, error: effectiveError });
    try {
      writeProcessEvidenceSync(ctx, command, args, result, redactedStdout, redactedStderr);
      writeProcessRecordSync(ctx, terminalProcessRecord(ctx, result, redactedStdout, redactedStderr));
      await emitProcessLifecycle(options, "execution_exited", ctx, { result });
      if (typeof options.onUsage === "function") {
        await Promise.resolve(options.onUsage({ record: { ...ctx.record }, result })).catch(() => undefined);
      }
    } catch {
      // Terminal persistence is best-effort for detached children whose parent may be exiting.
    }
    resolveCompletion(result);
  };

  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: Boolean(options.shell),
      detached: Boolean(options.detached),
      windowsHide: true,
      stdio: options.stdio ?? (options.captureOutput || options.onStdout || options.onStderr ? ["ignore", "pipe", "pipe"] : "ignore")
    });
  } catch (error) {
    void finalize(null, null, error);
    return {
      child: null,
      completion,
      cancel,
      executionId: ctx.executionId,
      commandFingerprint: ctx.commandFingerprint,
      recordPath: ctx.recordPath,
      evidencePath: ctx.evidencePath,
      errorClass: classifyProcessExecutionError({ result: { spawnError: true }, error })
    };
  }

  const pid = child.pid ?? null;
  requestTermination = (reason = "explicit_cancel") => {
    if (!pid || settled) return false;
    if (reason === "execution_hard_limit") {
      timedOut = true;
      terminationReason ??= "execution_hard_limit";
    } else if (reason === "no_progress_timeout") {
      timedOut = true;
      terminationReason ??= "no_progress_timeout";
    } else if (reason === "heartbeat_persistence_failed") {
      terminationReason ??= "heartbeat_persistence_failed";
    } else if (reason === "spawn_hook_failed") {
      terminationReason ??= "spawn_hook_failed";
    } else {
      cancelled = true;
      terminationReason ??= "explicit_cancel";
    }
    terminationRequestedAt ??= new Date().toISOString();
    terminateProcessTree(pid, { force: false });
    if (!forceTimer) {
      forceTimer = setTimeout(() => {
        forceUsed = true;
        terminateProcessTree(pid, { force: true });
      }, killGraceMs);
      forceTimer.unref?.();
    }
    return true;
  };

  try {
    writeProcessRecordSync(ctx, { pid, last_progress_at: lastProgressAt });
  } catch (error) {
    spawnHookError = error;
    requestTermination("heartbeat_persistence_failed");
  }

  const markProgress = (stream, chunkBytes, at = new Date().toISOString()) => {
    lastProgressAt = at;
    try { writeProcessRecordSync(ctx, { last_progress_at: at, pid }); } catch {}
    if (typeof options.onOutput === "function") {
      observerWork = observerWork.then(() => options.onOutput({ stream, bytes: chunkBytes, at })).catch(() => undefined);
    }
    if (typeof options.onProgress === "function") {
      observerWork = observerWork.then(() => options.onProgress({ stream, bytes: chunkBytes, at })).catch(() => undefined);
    }
  };

  if (pid && typeof options.onSpawn === "function") {
    spawnReady = Promise.resolve(options.onSpawn(pid)).catch((error) => {
      spawnHookError = error;
      requestTermination("spawn_hook_failed");
    });
  }

  heartbeatTimer = setInterval(() => {
    heartbeatWork = heartbeatWork
      .then(async () => {
        if (typeof options.onHeartbeat === "function") await options.onHeartbeat();
        lastHeartbeatAt = new Date().toISOString();
        writeProcessRecordSync(ctx, { last_heartbeat_at: lastHeartbeatAt, last_progress_at: lastProgressAt, pid });
        heartbeatFailures = 0;
        await emitProcessLifecycle(options, "execution_heartbeat", ctx, { heartbeatAt: lastHeartbeatAt });
      })
      .catch((error) => {
        heartbeatFailures += 1;
        if (typeof options.onHeartbeatError === "function") {
          Promise.resolve(options.onHeartbeatError(error, heartbeatFailures)).catch(() => undefined);
        }
        if (heartbeatFailures >= heartbeatFailureThreshold) {
          spawnHookError ||= error;
          requestTermination("heartbeat_persistence_failed");
        }
      });
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  if (timeoutMs !== null) {
    timeoutTimer = setTimeout(() => requestTermination("execution_hard_limit"), timeoutMs);
    timeoutTimer.unref?.();
  }
  if (noProgressTimeoutMs !== null) {
    const noProgressPollMs = Math.max(50, Math.min(heartbeatMs, Math.floor(noProgressTimeoutMs / 4)));
    noProgressTimer = setInterval(() => {
      const last = Date.parse(lastProgressAt);
      if (Number.isFinite(last) && Date.now() - last >= noProgressTimeoutMs) {
        requestTermination("no_progress_timeout");
      }
    }, noProgressPollMs);
    noProgressTimer.unref?.();
  }

  abortHandler = () => requestTermination("explicit_cancel");
  options.signal?.addEventListener?.("abort", abortHandler, { once: true });
  if (options.signal?.aborted) requestTermination("explicit_cancel");

  child.stdout?.on("data", (chunk) => {
    const next = boundedAppend(stdout, chunk, maxOutputBytes);
    stdout = next.value;
    stdoutTruncated ||= next.truncated;
    const at = new Date().toISOString();
    markProgress("stdout", Buffer.byteLength(chunk), at);
    if (typeof options.onStdout === "function") options.onStdout(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    const next = boundedAppend(stderr, chunk, maxOutputBytes);
    stderr = next.value;
    stderrTruncated ||= next.truncated;
    const at = new Date().toISOString();
    markProgress("stderr", Buffer.byteLength(chunk), at);
    if (typeof options.onStderr === "function") options.onStderr(chunk);
  });
  child.once("error", (error) => { void finalize(null, null, error); });
  child.once("close", (code, signal) => { void finalize(code, signal, undefined); });

  return {
    child,
    completion,
    cancel,
    executionId: ctx.executionId,
    commandFingerprint: ctx.commandFingerprint,
    recordPath: ctx.recordPath,
    evidencePath: ctx.evidencePath,
    errorClass: null
  };
}

function leasePaths(root, contextDir, name) {
  const executionDir = path.resolve(root, contextDir, "execution");
  const leaseDir = path.join(executionDir, "leases", name);
  return {
    executionDir,
    leaseDir,
    leaseFile: path.join(leaseDir, "lease.json"),
    fencingFile: path.join(executionDir, "leases", `${name}.fencing.json`)
  };
}

function readFencingToken(filePath) {
  const parsed = readJsonFileSync(filePath);
  const value = Number(parsed?.[FENCING_STATE_FIELD] ?? parsed?.fencing_token);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function nextFencingToken(filePath) {
  const next = readFencingToken(filePath) + 1;
  atomicWriteJsonSync(filePath, { version: 1, [FENCING_STATE_FIELD]: next, updated_at: new Date().toISOString() });
  return next;
}

function sameLeaseOwner(current, lease) {
  if (!current || !lease) return false;
  if (current.run_id !== lease.run_id) return false;
  if (current[OWNER_STATE_FIELD] !== lease[OWNER_STATE_FIELD]) return false;
  const currentFence = Number(current[FENCING_STATE_FIELD]);
  const leaseFence = Number(lease[FENCING_STATE_FIELD]);
  if (Number.isFinite(currentFence) || Number.isFinite(leaseFence)) {
    return Number.isFinite(currentFence) && Number.isFinite(leaseFence) && currentFence === leaseFence;
  }
  return true;
}

function leaseActivity(lease, now = Date.now()) {
  if (!lease || typeof lease !== "object") {
    return { active: false, stale: false, expired: false, ownerAlive: false, managedAlive: false };
  }
  const expiresAt = Date.parse(String(lease.expires_at || ""));
  const expired = !Number.isFinite(expiresAt) || expiresAt <= now;
  const ownerAlive = isProcessAlive(Number(lease.pid));
  const managedPid = Number(lease.managed_pid);
  const managedAlive = Number.isInteger(managedPid) && managedPid > 0 && isProcessTreeAlive(managedPid);
  // A live owner or managed process always keeps the lease active, even if a
  // heartbeat was delayed. If both processes are gone, retain the lease until
  // its TTL expires so a brief startup/shutdown race cannot admit two writers.
  const active = ownerAlive || managedAlive || !expired;
  return { active, stale: !active, expired, ownerAlive, managedAlive };
}

export function readWorkspaceLeaseSync(root, options = {}) {
  const contextDir = options.contextDir || ".ai-bridge";
  const name = options.name || "write";
  const paths = leasePaths(root, contextDir, name);
  const lease = readJsonFileSync(paths.leaseFile);
  const activity = leaseActivity(lease);
  return {
    ...paths,
    lease,
    active: activity.active,
    stale: Boolean(lease) && activity.stale,
    expired: activity.expired,
    owner_alive: activity.ownerAlive,
    managed_alive: activity.managedAlive
  };
}

export function acquireWorkspaceLeaseSync(root, options = {}) {
  const contextDir = options.contextDir || ".ai-bridge";
  const name = options.name || "write";
  const ttlMs = Math.max(5_000, Number(options.ttlMs ?? DEFAULT_LEASE_TTL_MS));
  const identity = {
    ...createRunIdentity(options.kind || name, options.runId),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    pid: Number(options.pid ?? process.pid)
  };
  const paths = leasePaths(root, contextDir, name);
  safeMkdir(path.dirname(paths.leaseDir));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.mkdirSync(paths.leaseDir, { mode: 0o700 });
      const now = new Date();
      const fencingToken = nextFencingToken(paths.fencingFile);
      const payload = {
        version: 1,
        name,
        run_id: identity.runId,
        [OWNER_STATE_FIELD]: identity.ownerId,
        [FENCING_STATE_FIELD]: fencingToken,
        pid: identity.pid,
        ...(Number.isInteger(Number(options.managedPid)) && Number(options.managedPid) > 0 ? { managed_pid: Number(options.managedPid) } : {}),
        kind: identity.kind,
        workspace: path.resolve(root),
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString()
      };
      atomicWriteJsonSync(paths.leaseFile, payload);
      return { ...payload, contextDir, leaseDir: paths.leaseDir, leaseFile: paths.leaseFile, ttlMs };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readWorkspaceLeaseSync(root, { contextDir, name });
      if (current.active) {
        const busy = new Error(`Workspace write lease is active: kind=${current.lease.kind} run_id=${current.lease.run_id} pid=${current.lease.pid}`);
        busy.code = "WORKSPACE_WRITE_LEASE_BUSY";
        busy.lease = current.lease;
        throw busy;
      }
      const stalePath = `${paths.leaseDir}.stale-${Date.now()}-${randomBytes(4).toString("hex")}`;
      try {
        fs.renameSync(paths.leaseDir, stalePath);
        fs.rmSync(stalePath, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error(`Failed to acquire workspace lease ${name}.`);
}

export function heartbeatWorkspaceLeaseSync(root, lease, options = {}) {
  const contextDir = options.contextDir || lease.contextDir || ".ai-bridge";
  const name = options.name || lease.name || "write";
  const current = readWorkspaceLeaseSync(root, { contextDir, name });
  if (!sameLeaseOwner(current.lease, lease)) {
    const error = new Error(`Workspace lease ownership changed for ${name}.`);
    error.code = "WORKSPACE_LEASE_OWNER_MISMATCH";
    throw error;
  }
  const now = new Date();
  const managedPid = Number(options.managedPid ?? lease.managed_pid ?? current.lease.managed_pid);
  const payload = {
    ...current.lease,
    ...(Number.isInteger(managedPid) && managedPid > 0 ? { managed_pid: managedPid } : {}),
    heartbeat_at: now.toISOString(),
    expires_at: new Date(now.getTime() + Number(lease.ttlMs ?? DEFAULT_LEASE_TTL_MS)).toISOString()
  };
  atomicWriteOwnedJsonSync(current.leaseFile, payload, {
    ownerId: lease[OWNER_STATE_FIELD],
    ["fencing" + "Token"]: lease[FENCING_STATE_FIELD]
  });
  return { ...lease, ...payload };
}

export function releaseWorkspaceLeaseSync(root, lease, options = {}) {
  if (!lease) return false;
  const contextDir = options.contextDir || lease.contextDir || ".ai-bridge";
  const name = options.name || lease.name || "write";
  const current = readWorkspaceLeaseSync(root, { contextDir, name });
  if (!current.lease) return true;
  if (!sameLeaseOwner(current.lease, lease)) return false;
  const releasedPath = `${current.leaseDir}.released-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(current.leaseDir, releasedPath);
    fs.rmSync(releasedPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export function assertNoActiveWorkspaceWriterSync(root, options = {}) {
  const current = readWorkspaceLeaseSync(root, { ...options, name: options.name || "write" });
  if (!current.active) return undefined;
  const error = new Error(`Workspace has an active writer: kind=${current.lease.kind} run_id=${current.lease.run_id} pid=${current.lease.pid}`);
  error.code = "WORKSPACE_WRITE_LEASE_BUSY";
  error.lease = current.lease;
  throw error;
}
