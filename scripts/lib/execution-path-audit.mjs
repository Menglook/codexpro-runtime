import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive, readWorkspaceLeaseSync } from '../../shared/execution-kernel.mjs';

export const EXECUTION_PATHS = Object.freeze([
  {
    id: 'foreground_stdio',
    purpose: 'Interactive local MCP over stdio',
    entrypoints: ['npm run start', 'npm run start:stdio', 'npm run dev:stdio'],
    authority: 'caller process',
    persistent: false,
    coexistence: 'Do not run as a background service beside the canonical stack.'
  },
  {
    id: 'foreground_http',
    purpose: 'Interactive local HTTP/MCP development and setup',
    entrypoints: ['npm run start:http', 'npm run dev:http', 'npm run connect:*'],
    authority: 'launcher process',
    persistent: false,
    coexistence: 'Use for setup/debugging only; do not leave running beside stack:start on the same port/root.'
  },
  {
    id: 'stack_background',
    purpose: 'Canonical persistent Server and configured Handoff Watchers',
    entrypoints: ['npm run stack:start', 'npm run stack:restart'],
    authority: '~/.codexpro/stack/state.json',
    persistent: true,
    coexistence: 'Exactly one tracked Server and one tracked Watcher per configured root.'
  },
  {
    id: 'direct_executor',
    purpose: 'Short bounded synchronous inspection or verification',
    entrypoints: ['run_task', 'run_stage', 'run_validation'],
    authority: 'request-scoped report',
    persistent: false,
    coexistence: 'Must not hold long-running work or duplicate a Durable Job/Goal.'
  },
  {
    id: 'durable_job',
    purpose: 'Long-running or resumable aggregate task',
    entrypoints: ['start_run_task', 'task_resume'],
    authority: '.codexpro/runs/<run_id>/job.json + owner.lock',
    persistent: true,
    coexistence: 'One owner token and owner lock per run_id.'
  },
  {
    id: 'goal_worktree',
    purpose: 'Medium/high-risk coding with acceptance, review, and optional Worktree isolation',
    entrypoints: ['goal_start', 'goal_resume', 'task_resume'],
    authority: '.codexpro/goals/<goal_id>',
    persistent: true,
    coexistence: 'One GoalManager owner; provider write lease must match codex_run_id.'
  },
  {
    id: 'handoff',
    purpose: 'Explicit cross-session or local Watcher handoff',
    entrypoints: ['handoff_to_agent', 'execute-handoff', 'watch-handoff', 'loop-handoff'],
    authority: '.ai-bridge/handoff-run-state.json + Execution Kernel write lease',
    persistent: true,
    coexistence: 'One acknowledged run per plan hash; Watcher, supervisor, and agent PIDs remain distinct.'
  },
  {
    id: 'browser_validator',
    purpose: 'Real Chrome validation and evidence collection',
    entrypoints: ['browser_*', 'browser_report'],
    authority: 'Browser Session/Authorization + validation artifacts',
    persistent: false,
    coexistence: 'Browser state cannot declare the coding task complete by itself.'
  }
]);

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const TERMINAL_HANDOFF_STATES = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const DURABLE_ACKNOWLEDGEMENT_FILE = '.codexpro/audits/execution-path-acknowledgements.json';
const DURABLE_QUARANTINE_DISPOSITION = 'quarantined_non_idempotent';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function durableAcknowledgements(root) {
  const source = readJson(path.join(root, DURABLE_ACKNOWLEDGEMENT_FILE));
  if (source?.version !== 1 || !Array.isArray(source.acknowledgements)) return new Map();
  const output = new Map();
  for (const item of source.acknowledgements) {
    if (!item || typeof item !== 'object') continue;
    const runId = typeof item.run_id === 'string' ? item.run_id.trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    const approvedAt = typeof item.approved_at === 'string' ? item.approved_at.trim() : '';
    const approvedBy = typeof item.approved_by === 'string' ? item.approved_by.trim() : '';
    const jobSha256 = typeof item.job_sha256 === 'string' ? item.job_sha256.trim().replace(/^sha256:/, '') : '';
    const stepSha256 = typeof item.step_sha256 === 'string' ? item.step_sha256.trim().replace(/^sha256:/, '') : '';
    if (!runId || !reason || !approvedAt || !approvedBy || !Number.isFinite(Date.parse(approvedAt))) continue;
    if (!/^[a-f0-9]{64}$/.test(jobSha256) || !/^[a-f0-9]{64}$/.test(stepSha256)) continue;
    if (item.disposition !== DURABLE_QUARANTINE_DISPOSITION) continue;
    output.set(runId, {
      run_id: runId,
      disposition: item.disposition,
      reason,
      approved_at: approvedAt,
      approved_by: approvedBy,
      job_sha256: jobSha256,
      step_sha256: stepSha256,
      evidence_paths: Array.isArray(item.evidence_paths)
        ? [...new Set(item.evidence_paths.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].slice(0, 12)
        : []
    });
  }
  return output;
}

function nonIdempotentRecoveryStep(runRoot, job) {
  if (!['recovery_required', 'stale'].includes(job.status)) return null;
  const stepId = typeof job.current_step_id === 'string' ? job.current_step_id.trim() : '';
  if (!stepId) return null;
  const step = readJson(path.join(runRoot, 'steps', stepId, 'step.json'));
  if (!step || step.idempotent !== false || step.retryable !== false || step.retry_policy !== 'never') return null;
  return step;
}

function meaningfulHandoffPlan(planText) {
  if (!planText) return null;
  const body = planText
    .replace(/^#\s+Current Plan\s*$/gim, '')
    .trim();
  if (!body || /^No plan written yet\.?$/i.test(body)) return null;
  return planText;
}

function safeRealpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function sameRoot(command, root) {
  return command.includes(`--root ${root}`) || command.includes(`--root '${root}'`) || command.includes(`--root \"${root}\"`);
}

function trackedProcessTree(rows, trackedPids) {
  const tracked = new Set(trackedPids.filter(Number.isInteger));
  const frontier = [...tracked];
  while (frontier.length) {
    const parent = frontier.shift();
    for (const row of rows) {
      if (row.ppid !== parent || tracked.has(row.pid)) continue;
      tracked.add(row.pid);
      frontier.push(row.pid);
    }
  }
  return tracked;
}

function classifyProcesses({ rows, state, codexProRoot, serverRoot, watchRoots }) {
  const trackedServer = state?.server?.pid;
  const trackedWatchers = new Map((state?.watchers ?? []).map((watcher) => [safeRealpath(watcher.root), watcher.pid]));
  const trackedPids = [trackedServer, ...trackedWatchers.values()].filter(Number.isInteger);
  const trackedTree = trackedProcessTree(rows, trackedPids);
  const duplicateServers = [];
  const duplicateWatchers = [];
  const fakeCodex = [];

  for (const row of rows) {
    if (trackedTree.has(row.pid)) continue;
    if (row.command.includes('/tmp/codexpro-exec-runner-') && row.command.includes('/fake-codex.mjs exec')) {
      fakeCodex.push({ pid: row.pid, ppid: row.ppid, command: row.command });
      continue;
    }
    const looksLikeServer = (row.command.includes('/dist/http.js') && row.command.includes(codexProRoot))
      || (row.command.includes('scripts/codexpro.mjs start') && row.command.includes(codexProRoot) && sameRoot(row.command, serverRoot));
    if (looksLikeServer) {
      duplicateServers.push({ pid: row.pid, ppid: row.ppid, command: row.command });
      continue;
    }
    for (const root of watchRoots) {
      if (row.command.includes('scripts/codexpro.mjs watch-handoff') && sameRoot(row.command, root)) {
        duplicateWatchers.push({ root, pid: row.pid, ppid: row.ppid, command: row.command });
        break;
      }
    }
  }
  return { duplicate_servers: duplicateServers, duplicate_watchers: duplicateWatchers, fake_codex_processes: fakeCodex };
}

function auditDurableJobs(root) {
  const runsRoot = path.join(root, '.codexpro', 'runs');
  let entries = [];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return { findings: [], acknowledged: [] };
  }
  const acknowledgements = durableAcknowledgements(root);
  const findings = [];
  const acknowledged = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runRoot = path.join(runsRoot, entry.name);
    const job = readJson(path.join(runRoot, 'job.json'));
    if (!job || TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'queued') continue;
    const lock = readJson(path.join(runRoot, 'owner.lock'));
    const ownerPid = Number.isInteger(lock?.pid) && lock.pid > 0 ? lock.pid : null;
    const ownerAlive = ownerPid ? isProcessAlive(ownerPid) : false;
    if (ownerAlive) continue;
    const runId = job.run_id ?? entry.name;
    const acknowledgement = acknowledgements.get(runId);
    const recoveryStep = acknowledgement ? nonIdempotentRecoveryStep(runRoot, job) : null;
    const jobPath = path.join(runRoot, 'job.json');
    const stepPath = job.current_step_id ? path.join(runRoot, 'steps', job.current_step_id, 'step.json') : null;
    const acknowledgementMatches = Boolean(
      acknowledgement
      && recoveryStep
      && fileSha256(jobPath) === acknowledgement.job_sha256
      && stepPath
      && fileSha256(stepPath) === acknowledgement.step_sha256
    );
    const finding = {
      root,
      run_id: runId,
      status: job.status,
      owner_pid: ownerPid,
      owner_alive: false,
      current_step_id: job.current_step_id ?? null,
      heartbeat_at: job.progress?.heartbeat_at ?? null,
      recovery_reason: job.recovery_reason ?? job.progress?.wait_reason ?? null,
      action: job.status === 'recovery_required' || job.status === 'stale'
        ? 'Use task_recovery/task_resume after reviewing side effects.'
        : 'Run startup recovery or task_recovery before resuming; do not start a second owner blindly.'
    };
    if (acknowledgementMatches) {
      acknowledged.push({
        ...finding,
        disposition: acknowledgement.disposition,
        acknowledgement_reason: acknowledgement.reason,
        approved_at: acknowledgement.approved_at,
        approved_by: acknowledgement.approved_by,
        evidence_hashes: {
          job_sha256: acknowledgement.job_sha256,
          step_sha256: acknowledgement.step_sha256
        },
        evidence_paths: acknowledgement.evidence_paths,
        step_policy: {
          idempotent: recoveryStep.idempotent,
          retryable: recoveryStep.retryable,
          retry_policy: recoveryStep.retry_policy,
          side_effect_level: recoveryStep.side_effect_level ?? null
        },
        action: 'Preserve the original task and evidence. Do not retry, resume, cancel, delete, or rewrite it without a separate reconciliation decision.'
      });
      continue;
    }
    findings.push(finding);
  }
  return { findings, acknowledged };
}

function auditHandoff(root, contextDir = '.ai-bridge') {
  const contextRoot = path.join(root, contextDir);
  const planText = meaningfulHandoffPlan(readText(path.join(contextRoot, 'current-plan.md')));
  const run = readJson(path.join(contextRoot, 'handoff-run-state.json'));
  const watcher = readJson(path.join(contextRoot, 'watch-handoff-heartbeat.json'));
  const planHash = planText ? crypto.createHash('sha256').update(planText).digest('hex') : null;
  const watcherPid = Number.isInteger(watcher?.pid) && watcher.pid > 0 ? watcher.pid : null;
  const watcherAlive = watcherPid ? isProcessAlive(watcherPid) : false;
  const executorPid = Number.isInteger(run?.pid) && run.pid > 0 ? run.pid : null;
  const executorAlive = executorPid ? isProcessAlive(executorPid) : false;
  const leaseInspection = run?.run_id
    ? readWorkspaceLeaseSync(root, { contextDir, name: 'write' })
    : null;
  const matchingLease = leaseInspection?.lease?.run_id === run?.run_id ? leaseInspection : null;
  const findings = [];

  if (planHash && run?.plan_hash !== planHash && !watcherAlive) {
    findings.push({
      root,
      type: 'unowned_plan',
      plan_hash: planHash,
      run_plan_hash: run?.plan_hash ?? null,
      watcher_pid: watcherPid,
      watcher_alive: watcherAlive,
      action: 'Start the canonical Stack Watcher or explicitly execute the Handoff; do not create another plan copy.'
    });
  }

  if (run?.state === 'running' && (!executorAlive || !matchingLease?.active)) {
    findings.push({
      root,
      type: 'orphaned_run',
      run_id: run.run_id ?? null,
      plan_hash: run.plan_hash ?? null,
      executor_pid: executorPid,
      executor_alive: executorAlive,
      watcher_pid: watcherPid,
      watcher_alive: watcherAlive,
      matching_lease: Boolean(matchingLease),
      lease_active: matchingLease?.active ?? false,
      action: 'Inspect run-specific diff/log and task_recovery. Do not kill the Watcher or replay the old run automatically.'
    });
  }

  if (run?.state && TERMINAL_HANDOFF_STATES.has(run.state) && executorAlive) {
    findings.push({
      root,
      type: 'terminal_run_process_alive',
      run_id: run.run_id ?? null,
      state: run.state,
      executor_pid: executorPid,
      executor_alive: true,
      action: 'Inspect the recorded execution process before cleanup; terminal state and live process are inconsistent.'
    });
  }
  return findings;
}

export function auditExecutionPaths({ rows = [], state = null, codexProRoot = process.cwd(), serverRoot, watchRoots = [], contextDir = '.ai-bridge' }) {
  const roots = [...new Set([serverRoot, ...watchRoots].filter(Boolean).map(safeRealpath))];
  const processes = classifyProcesses({
    rows,
    state,
    codexProRoot: safeRealpath(codexProRoot),
    serverRoot: safeRealpath(serverRoot),
    watchRoots: roots
  });
  const durableAudits = roots.map((root) => auditDurableJobs(root));
  const orphanedJobs = durableAudits.flatMap((result) => result.findings);
  const acknowledgedJobs = durableAudits.flatMap((result) => result.acknowledged);
  const handoffFindings = roots.flatMap((root) => auditHandoff(root, contextDir));
  const issueCount = processes.duplicate_servers.length
    + processes.duplicate_watchers.length
    + processes.fake_codex_processes.length
    + orphanedJobs.length
    + handoffFindings.length;
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    status: issueCount ? 'issues_found' : 'clean',
    issue_count: issueCount,
    manifest: EXECUTION_PATHS,
    processes,
    orphaned_durable_jobs: orphanedJobs,
    acknowledged_durable_jobs: acknowledgedJobs,
    handoff_findings: handoffFindings,
    policy: {
      canonical_background_entrypoint: 'npm run stack:start',
      destructive_cleanup: false,
      acknowledgement_file: DURABLE_ACKNOWLEDGEMENT_FILE,
      acknowledgement_scope: 'Only dead-owner recovery_required/stale jobs whose current step is explicitly non-idempotent, non-retryable, retry_policy=never, and whose job/step SHA-256 hashes still match the approved evidence may be quarantined.',
      note: 'This audit reports ownership conflicts only. Task processes and persisted evidence are never terminated, deleted, retried, or rewritten by the audit.'
    }
  };
}
