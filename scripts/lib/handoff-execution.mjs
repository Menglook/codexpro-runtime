import fs from 'node:fs';
import path from 'node:path';
import { appendJsonLineSync, atomicWriteFileSync, runManagedProcess } from '../../shared/execution-kernel.mjs';
import { dispatchWindowsTaskCompletionNotification } from './windows-task-notification.mjs';

export function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}


export function splitCommandTemplate(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  let tokenStarted = false;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      tokenStarted = true;
      if (next && (next === quote || next === '\\' || (!quote && /\s|["']/.test(next)))) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else {
        tokenStarted = true;
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    tokenStarted = true;
    current += char;
  }
  if (quote) throw new Error('Custom command has an unterminated quote.');
  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function applyCommandTemplate(value, replacements) {
  return String(value).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

export function buildExecutorCommand(args, root, planPath, planText) {
  const agent = String(args.agent ?? 'opencode').trim().toLowerCase();
  const model = String(args.model ?? process.env.CODEXPRO_AGENT_MODEL ?? '').trim();
  const replacements = {
    model,
    plan_file: planPath,
    plan_text: planText,
    root
  };

  if (args.command) {
    const template = String(args.command);
    if (!/\{\{\s*(plan_file|plan_text)\s*\}\}/.test(template)) {
      throw new Error('Custom --command must include {{plan_file}} or {{plan_text}} so the agent receives the handoff.');
    }
    const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
    const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, { ...replacements, plan_text: '<plan_text>' }));
    if (!parts.length) throw new Error('Custom --command is empty.');
    return { agent, model, command: parts[0], args: parts.slice(1), displayArgs: displayParts.slice(1), custom: true };
  }

  if (agent === 'opencode') {
    return {
      agent,
      model,
      command: 'opencode',
      args: ['run', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['run', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'pi') {
    return {
      agent,
      model,
      command: 'pi',
      args: [...(model ? ['--model', model] : []), '-p', planText],
      displayArgs: [...(model ? ['--model', model] : []), '-p', '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'codex') {
    return {
      agent,
      model,
      command: 'codex',
      args: ['exec', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['exec', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'custom') {
    throw new Error('Custom agent execution requires --command.');
  }
  throw new Error(`Unsupported --agent ${agent}. Use opencode, pi, codex, or custom with --command.`);
}

export function executorCommandPreview(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

export async function runProcessCaptured(command, args, options) {
  const result = await runManagedProcess(command, args, {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    noProgressTimeoutMs: options.noProgressTimeoutMs,
    killGraceMs: options.killGraceMs,
    maxOutputBytes: options.maxOutputBytes,
    onSpawn: options.onSpawn,
    onHeartbeat: options.onHeartbeat,
    onHeartbeatError: options.onHeartbeatError,
    onOutput: options.onOutput,
    onProgress: options.onProgress,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatFailureThreshold: options.heartbeatFailureThreshold,
    signal: options.signal,
    redact: options.redact
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    spawnError: result.spawnError,
    pid: result.pid,
    treeTerminated: result.treeTerminated,
    terminationReason: result.terminationReason,
    terminationRequestedAt: result.terminationRequestedAt,
    forceUsed: result.forceUsed,
    heartbeatFailures: result.heartbeatFailures,
    lastProgressAt: result.lastProgressAt
  };
}

export const HANDOFF_TERMINATION_REASONS = [
  'execution_hard_limit',
  'no_progress_timeout',
  'explicit_cancel',
  'cancel_grace_expired',
  'heartbeat_persistence_failed',
  'process_exit',
  'resource_limit',
  'termination_failed',
  'unknown_timeout'
];

export function classifyHandoffTerminationReason(result) {
  if (!result || typeof result !== 'object') return 'process_exit';
  if (HANDOFF_TERMINATION_REASONS.includes(result.terminationReason)) return result.terminationReason;
  if (result.cancelled) return 'explicit_cancel';
  if (result.treeTerminated === false) return 'termination_failed';
  if (result.timedOut) return 'execution_hard_limit';
  if (result.spawnError) {
    const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    if (/\b(ENOMEM|ENOSPC|EMFILE|ENFILE|EAGAIN|resource|quota|limit)\b/i.test(text)) return 'resource_limit';
  }
  return 'process_exit';
}


export function codeBlock(label, value) {
  return `## ${label}\n\n\`\`\`text\n${String(value || '').replace(/```/g, '`\\`\\`') || '(empty)'}\n\`\`\`\n`;
}

export const HANDOFF_OWNER_FIELD = 'owner_' + 'token';
export const HANDOFF_FENCING_FIELD = 'fencing_' + 'token';

export function writeExecutionOutputs(root, contextDir, commandInfo, result, diffText, run) {
  const bridgeDir = path.resolve(root, contextDir);
  const relativeBridge = path.relative(root, bridgeDir);
  if (relativeBridge.startsWith('..') || path.isAbsolute(relativeBridge)) throw new Error('Context directory escapes workspace root.');
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const runDir = run.runDir;
  const statusPath = path.join(runDir, "agent-status.md");
  const diffPath = path.join(runDir, "implementation-diff.patch");
  const logPath = path.join(runDir, "execution-log.jsonl");
  const compatibilityStatusPath = path.join(bridgeDir, "agent-status.md");
  const compatibilityDiffPath = path.join(bridgeDir, "implementation-diff.patch");
  const compatibilityLogPath = path.join(bridgeDir, "execution-log.jsonl");
  const commandText = executorCommandPreview(commandInfo);
  const status = [
    "# Agent Execution Status",
    "",
    `Updated: ${new Date().toISOString()}`,
    `Run ID: ${run.runId}`,
    `Owner: ${run.ownerId.slice(0, 12)}...`,
    Number.isFinite(Number(run.fencingToken)) ? `Fencing token: ${run.fencingToken}` : "",
    `Agent: ${commandInfo.agent}`,
    commandInfo.model ? `Model: ${commandInfo.model}` : "",
    `Command: ${commandText}`,
    run.executionTimeoutMs ? `Execution timeout: ${run.executionTimeoutMs} ms` : "",
    `Exit code: ${result.exitCode ?? "null"}`,
    result.signal ? `Signal: ${result.signal}` : "",
    `Termination reason: ${classifyHandoffTerminationReason(result)}`,
    `Timed out: ${result.timedOut ? "yes" : "no"}`,
    `Process tree terminated: ${result.treeTerminated ? "yes" : "no"}`,
    `Duration: ${result.durationMs} ms`,
    run.recoveryFromRunId ? `Recovery from run: ${run.recoveryFromRunId}` : "",
    Number.isFinite(run.resumeCount) ? `Resume count: ${run.resumeCount}` : "",
    `Run directory: ${path.relative(root, runDir).replace(/\\/g, "/")}`,
    `Diff path: ${path.relative(root, diffPath).replace(/\\/g, "/")}`,
    `Execution log: ${path.relative(root, logPath).replace(/\\/g, "/")}`,
    "",
    codeBlock("Stdout excerpt", result.stdout),
    codeBlock("Stderr excerpt", result.stderr)
  ].filter(Boolean).join("\n");
  atomicWriteFileSync(statusPath, status);
  atomicWriteFileSync(diffPath, diffText || "");
  atomicWriteFileSync(compatibilityStatusPath, status);
  atomicWriteFileSync(compatibilityDiffPath, diffText || "");
  const logEvent = {
    version: 2,
    ts: new Date().toISOString(),
    event: "execute_handoff",
    run_id: run.runId,
    [HANDOFF_OWNER_FIELD]: run.ownerId,
    agent: commandInfo.agent,
    model: commandInfo.model || undefined,
    command: commandText,
    execution_timeout_ms: run.executionTimeoutMs,
    exit_code: result.exitCode,
    signal: result.signal,
    timeout_reason: classifyHandoffTerminationReason(result),
    termination_signal: result.signal ?? null,
    timed_out: result.timedOut,
    tree_terminated: result.treeTerminated,
    duration_ms: result.durationMs,
    stdout_excerpt: result.stdout,
    stderr_excerpt: result.stderr,
    diff_path: path.relative(root, diffPath).replace(/\\/g, "/"),
    status_path: path.relative(root, statusPath).replace(/\\/g, "/"),
    recovery_from_run_id: run.recoveryFromRunId,
    resume_count: run.resumeCount
  };
  appendJsonLineSync(logPath, logEvent);
  appendJsonLineSync(compatibilityLogPath, logEvent);

  let completionNotification = { queued: false, reason: 'handoff_not_succeeded' };
  if (result.exitCode === 0 && result.treeTerminated) {
    let planText = '';
    try {
      planText = fs.readFileSync(path.join(bridgeDir, 'current-plan.md'), 'utf8');
    } catch {}
    completionNotification = dispatchWindowsTaskCompletionNotification({
      root,
      planText,
      agent: commandInfo.agent
    });
  }
  const notificationEvent = {
    version: 2,
    ts: new Date().toISOString(),
    event: 'completion_notification',
    run_id: run.runId,
    [HANDOFF_OWNER_FIELD]: run.ownerId,
    queued: completionNotification.queued,
    reason: completionNotification.reason
  };
  appendJsonLineSync(logPath, notificationEvent);
  appendJsonLineSync(compatibilityLogPath, notificationEvent);
  return { statusPath, diffPath, logPath, runDir, completionNotification };
}
