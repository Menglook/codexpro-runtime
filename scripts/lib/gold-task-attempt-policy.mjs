import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ATTEMPT_POLICY_LOCK_TIMEOUT_MS = 5_000;
const ATTEMPT_POLICY_LOCK_STALE_MS = 30_000;
const ATTEMPT_POLICY_LOCK_POLL_MS = 25;
const FROZEN_SUITE_MANIFEST = path.join('benchmarks', 'gold-tasks', 'v1', 'manifest.json');

export const INFRASTRUCTURE_RETRY_FAILURE_CODES = new Set([
  'prepare_failed',
  'runtime_start_failed',
  'runtime_verification_failed',
  'connector_transport_failed',
  'tunnel_unavailable'
]);

const PREPARATION_INFRASTRUCTURE_PATTERNS = [
  /\b(?:enospc|eacces|eperm|emfile|enfile|ebusy|etimedout)\b/i,
  /no space left|permission denied|resource temporarily unavailable/i,
  /command failed:\s*git\b[\s\S]*\bworktree\b/i,
  /gold task dependency preflight failed/i
];

function safeId(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must be 1-128 safe identifier characters.`);
  }
  return normalized;
}

function normalizeRuntimeGitSha(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function known(value) {
  return value !== undefined && value !== null && value !== '';
}

function firstKnown(...values) {
  return values.find(known) ?? null;
}

async function readJsonIfExists(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM' ? true : false;
  }
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withAttemptPolicyLock(policyPath, operation) {
  const lockDirectory = `${policyPath}.lock`;
  const ownerPath = path.join(lockDirectory, 'owner.json');
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(policyPath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      try {
        await fs.writeFile(ownerPath, `${JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString()
        })}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      let lockModifiedAt = 0;
      try {
        owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      } catch {
        // A competing process may still be writing the owner record.
      }
      try {
        lockModifiedAt = (await fs.stat(lockDirectory)).mtimeMs;
      } catch {
        continue;
      }
      const acquiredAt = Date.parse(owner?.acquired_at ?? '');
      const lastKnownActiveAt = Number.isFinite(acquiredAt) ? acquiredAt : lockModifiedAt;
      if (Date.now() - lastKnownActiveAt > ATTEMPT_POLICY_LOCK_STALE_MS && processAlive(owner?.pid) !== true) {
        await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= ATTEMPT_POLICY_LOCK_TIMEOUT_MS) {
        throw new Error(`Candidate attempt policy lock timed out: ${policyPath}.`);
      }
      await delay(ATTEMPT_POLICY_LOCK_POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 20 * 1024 * 1024
  });
}

function nulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function changedPaths(worktree, baseline) {
  const tracked = nulPaths(git(worktree, ['diff', '--name-only', '--no-renames', '-z', baseline, '--'], { encoding: 'buffer' }));
  const untracked = nulPaths(git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' }));
  return [...new Set([...tracked, ...untracked])].sort();
}

function mergeKnown(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!known(merged[key]) || (Array.isArray(merged[key]) && merged[key].length === 0)) {
      if (known(value)) merged[key] = value;
    }
  }
  return merged;
}

export async function historicalCandidateAttempts(root, taskId) {
  const attempts = new Map();
  const reportsRoot = path.join(root, 'benchmarks', 'gold-tasks', 'v1', 'reports', 'runs');
  let reportNames = [];
  try {
    reportNames = await fs.readdir(reportsRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of reportNames.filter((item) => item.endsWith('.json'))) {
    const report = await readJsonIfExists(path.join(reportsRoot, name));
    if (report?.measurement_phase !== 'candidate' || !report?.suite_run_id) continue;
    const result = (report.task_results ?? []).find((item) => item?.task_id === taskId);
    if (!result) continue;
    const proofRelativePath = (result.evidence_paths ?? []).find((item) => path.basename(item) === 'completion-proof.json');
    const proof = proofRelativePath ? await readJsonIfExists(path.resolve(root, proofRelativePath)) : null;
    attempts.set(report.suite_run_id, {
      task_id: taskId,
      suite_run_id: report.suite_run_id,
      suite_id: firstKnown(report.suite_id, proof?.suite_id),
      runtime_git_sha: normalizeRuntimeGitSha(firstKnown(result.runtime_git_sha, proof?.runtime_git_sha, report.runtime_git_sha, report.git_sha)),
      attempt_number: Number.isInteger(result.attempt) ? result.attempt : null,
      recorded_at: report.started_at ?? report.finished_at ?? null,
      source: 'run_report',
      outcome: result.evaluated_outcome ?? result.outcome ?? null,
      failure_classification: result.failure_classification ?? null,
      acceptance_passed: result.acceptance_passed ?? null,
      actual_changed_paths: proof?.actual_changed_paths ?? [],
      missing_changed_paths: proof?.missing_changed_paths ?? [],
      unexpected_changed_paths: proof?.unexpected_changed_paths ?? [],
      completion_proof_present: Boolean(proof)
    });
  }

  const sessionsRoot = path.join(root, '.ai-bridge', 'gold-task-evaluation', 'sessions');
  let suiteNames = [];
  try {
    suiteNames = await fs.readdir(sessionsRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const suiteName of suiteNames) {
    const sessionDirectory = path.join(sessionsRoot, suiteName, taskId.toLowerCase());
    const descriptor = await readJsonIfExists(path.join(sessionDirectory, 'session.json'));
    if (descriptor?.measurement_phase !== 'candidate' || descriptor?.task_id !== taskId || !descriptor?.suite_run_id) continue;
    const sessionRecord = {
      task_id: taskId,
      suite_run_id: descriptor.suite_run_id,
      suite_id: descriptor.suite_id ?? null,
      runtime_git_sha: normalizeRuntimeGitSha(descriptor.runtime_git_sha),
      attempt_number: Number.isInteger(descriptor.attempt_policy?.commit_suite_attempt_number)
        ? descriptor.attempt_policy.commit_suite_attempt_number
        : Number.isInteger(descriptor.attempt_policy?.attempt_number)
          ? descriptor.attempt_policy.attempt_number
          : null,
      recorded_at: descriptor.prepared_at ?? descriptor.finalized_at ?? null,
      source: 'session_descriptor',
      session_dir: sessionDirectory,
      worktree_path: descriptor.worktree_path ?? null,
      baseline_commit: descriptor.baseline_commit ?? null,
      infrastructure_retry: descriptor.attempt_policy?.infrastructure_retry
        ?? descriptor.attempt_policy?.retry_authorized
        ?? false,
      retry_of: descriptor.attempt_policy?.retry_of ?? null,
      infrastructure_failure_code: descriptor.attempt_policy?.infrastructure_failure_code ?? null
    };
    attempts.set(
      descriptor.suite_run_id,
      mergeKnown(attempts.get(descriptor.suite_run_id) ?? {}, sessionRecord)
    );
  }
  return [...attempts.values()].sort((left, right) =>
    String(left.recorded_at ?? left.suite_run_id).localeCompare(String(right.recorded_at ?? right.suite_run_id))
  );
}

function normalizedAttempt(taskId, attempt, history) {
  const merged = mergeKnown(attempt ?? {}, history ?? {});
  const runtimeGitSha = normalizeRuntimeGitSha(firstKnown(merged.runtime_git_sha, merged.git_sha));
  const suiteId = firstKnown(merged.suite_id, history?.suite_id);
  return {
    ...merged,
    task_id: firstKnown(merged.task_id, taskId),
    suite_id: suiteId,
    runtime_git_sha: runtimeGitSha,
    infrastructure_retry: merged.infrastructure_retry === true || merged.retry_authorized === true,
    retry_authorized: merged.infrastructure_retry === true || merged.retry_authorized === true,
    retry_of: merged.retry_of ?? null,
    legacy_scope_unknown: !suiteId || !runtimeGitSha
  };
}

function attemptOrder(left, right) {
  return String(left.recorded_at ?? left.suite_run_id).localeCompare(String(right.recorded_at ?? right.suite_run_id));
}

function scopeKey(attempt) {
  if (attempt.legacy_scope_unknown) return null;
  return JSON.stringify([attempt.task_id, attempt.runtime_git_sha, attempt.suite_id]);
}

function numberAttempts(attempts) {
  const counts = new Map();
  return [...attempts].sort(attemptOrder).map((attempt) => {
    const key = scopeKey(attempt);
    if (!key) {
      return {
        ...attempt,
        commit_suite_attempt_number: Number.isInteger(attempt.commit_suite_attempt_number)
          ? attempt.commit_suite_attempt_number
          : Number.isInteger(attempt.attempt_number) ? attempt.attempt_number : null
      };
    }
    const number = (counts.get(key) ?? 0) + 1;
    counts.set(key, number);
    return { ...attempt, attempt_number: number, commit_suite_attempt_number: number };
  });
}

function scopeSummaries(attempts) {
  const scopes = new Map();
  for (const attempt of attempts) {
    const key = scopeKey(attempt);
    if (!key) continue;
    const current = scopes.get(key) ?? {
      task_id: attempt.task_id,
      suite_id: attempt.suite_id,
      runtime_git_sha: attempt.runtime_git_sha,
      attempt_count: 0
    };
    current.attempt_count += 1;
    scopes.set(key, current);
  }
  return [...scopes.values()].sort((left, right) =>
    `${left.task_id}\0${left.runtime_git_sha}\0${left.suite_id}`.localeCompare(`${right.task_id}\0${right.runtime_git_sha}\0${right.suite_id}`)
  );
}

function ledgerValue(taskId, attempts) {
  const numbered = numberAttempts(attempts);
  return {
    version: 2,
    task_id: taskId,
    scope_fields: ['task_id', 'runtime_git_sha', 'suite_id'],
    scopes: scopeSummaries(numbered),
    attempts: numbered
  };
}

function sameScope(attempt, scope) {
  return !attempt.legacy_scope_unknown
    && attempt.task_id === scope.task_id
    && attempt.runtime_git_sha === scope.runtime_git_sha
    && attempt.suite_id === scope.suite_id;
}

async function proveInfrastructureFailureBeforeCandidateChanges(root, previous, failureCode) {
  if (failureCode === 'prepare_failed') {
    const batchState = previous.batch_state_path ? await readJsonIfExists(previous.batch_state_path) : null;
    const taskState = (batchState?.tasks ?? []).find((item) => item?.task_id === previous.task_id);
    if (
      batchState?.status !== 'prepare_failed'
      || taskState?.status !== 'prepare_failed'
      || taskState?.attempts !== 0
      || taskState?.prepare_failure_kind !== 'infrastructure'
    ) {
      throw new Error(`Cannot prove prepare_failed for infrastructure retry target ${previous.suite_run_id}.`);
    }
    return;
  }
  if (previous.failure_classification !== failureCode) {
    throw new Error(
      `Infrastructure retry classification does not match recorded failure for ${previous.suite_run_id}: `
      + `${previous.failure_classification ?? 'unknown'} != ${failureCode}.`
    );
  }
  if ((previous.actual_changed_paths ?? []).length > 0) {
    throw new Error(
      `Infrastructure retry is not allowed after candidate modification for ${previous.task_id}: `
      + `${previous.actual_changed_paths.join(', ')}.`
    );
  }
  if (previous.completion_proof_present) return;
  if (previous.session_dir && previous.worktree_path && previous.baseline_commit) {
    const descriptor = await readJsonIfExists(path.join(previous.session_dir, 'session.json'));
    if (!descriptor) {
      throw new Error(`Cannot prove that infrastructure retry target ${previous.suite_run_id} stopped before candidate modification.`);
    }
    const evaluatorOwnedPrefixes = (descriptor.evaluator_owned_paths ?? [])
      .map((item) => String(item).replaceAll('\\', '/').replace(/\/$/, ''));
    const candidateChanges = changedPaths(previous.worktree_path, previous.baseline_commit)
      .filter((item) => !evaluatorOwnedPrefixes.some((prefix) => item === prefix || item.startsWith(`${prefix}/`)));
    if (candidateChanges.length === 0) return;
    throw new Error(
      `Infrastructure retry is not allowed after candidate modification for ${previous.task_id}: ${candidateChanges.join(', ')}.`
    );
  }
  throw new Error(`Cannot prove that infrastructure retry target ${previous.suite_run_id} stopped before candidate modification.`);
}

function requiredText(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

export function assertFormalRuntimeClean(runtimeDirty, phase, allowDirtyRuntime = false) {
  if (!runtimeDirty) return;
  if (phase === 'candidate' || !allowDirtyRuntime) {
    throw new Error('Gold Task sessions require a clean runtime commit. Commit or restore runtime changes before preparing a real run.');
  }
}

export function assertFormalCandidateManifest(root, manifestPath, phase) {
  if (phase !== 'candidate') return;
  const expectedManifestPath = path.resolve(root, FROZEN_SUITE_MANIFEST);
  if (path.resolve(manifestPath) !== expectedManifestPath) {
    throw new Error(
      `Candidate Gold Task runs require the committed frozen suite manifest: ${expectedManifestPath}.`
    );
  }
}

export function classifyGoldTaskPreparationFailure(error) {
  const message = String(error instanceof Error ? error.message : error ?? '');
  return PREPARATION_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(message))
    ? 'infrastructure'
    : 'unclassified';
}

export async function authorizeCandidateAttempt({
  root,
  taskId,
  phase,
  suiteRunId,
  suiteId,
  runtimeGitSha,
  retryOf: retryOfValue = '',
  failureCode: failureCodeValue = '',
  retryFailureSummary: retryFailureSummaryValue = '',
  retryChangeSummary: retryChangeSummaryValue = '',
  retryExpectedResult: retryExpectedResultValue = '',
  batchStatePath = null
}) {
  const normalizedRuntimeGitSha = normalizeRuntimeGitSha(runtimeGitSha);
  if (phase !== 'candidate') {
    return {
      task_id: taskId,
      suite_id: suiteId,
      runtime_git_sha: normalizedRuntimeGitSha,
      suite_run_id: suiteRunId,
      attempt_number: 1,
      commit_suite_attempt_number: 1,
      infrastructure_retry: false,
      retry_authorized: false,
      retry_of: null,
      infrastructure_failure_code: null,
      retry_failure_summary: null,
      retry_change_summary: null,
      retry_expected_result: null,
      policy_path: null
    };
  }
  if (!normalizedRuntimeGitSha) throw new Error('Candidate attempt policy requires a full runtime Git commit SHA.');
  const normalizedSuiteId = safeId(suiteId, 'frozen suite id');
  const normalizedSuiteRunId = safeId(suiteRunId, 'candidate suite run id');
  const scope = { task_id: taskId, suite_id: normalizedSuiteId, runtime_git_sha: normalizedRuntimeGitSha };
  const policyPath = path.join(root, '.ai-bridge', 'gold-task-evaluation', 'attempt-policy', `${taskId.toLowerCase()}.json`);
  return await withAttemptPolicyLock(policyPath, async () => {
    const rawLedger = await readJsonIfExists(policyPath);
    if (rawLedger && ![1, 2].includes(rawLedger.version)) {
      throw new Error(`Candidate attempt policy state has an unsupported version for ${taskId}: ${policyPath}.`);
    }
    if (rawLedger && (rawLedger.task_id !== taskId || !Array.isArray(rawLedger.attempts))) {
      throw new Error(`Candidate attempt policy state is invalid for ${taskId}: ${policyPath}.`);
    }

    const history = await historicalCandidateAttempts(root, taskId);
    const historyByRun = new Map(history.map((attempt) => [attempt.suite_run_id, attempt]));
    const attemptsByRun = new Map();
    for (const attempt of rawLedger?.attempts ?? []) {
      attemptsByRun.set(attempt.suite_run_id, normalizedAttempt(taskId, attempt, historyByRun.get(attempt.suite_run_id)));
    }
    for (const attempt of history) {
      if (!attemptsByRun.has(attempt.suite_run_id)) {
        attemptsByRun.set(attempt.suite_run_id, normalizedAttempt(taskId, attempt, null));
      }
    }
    let attempts = numberAttempts([...attemptsByRun.values()]);
    if (attempts.some((attempt) => attempt.suite_run_id === normalizedSuiteRunId)) {
      throw new Error(`Candidate suite run id is already recorded for ${taskId}: ${normalizedSuiteRunId}.`);
    }

    const scopedAttempts = attempts.filter((attempt) => sameScope(attempt, scope));
    const retryOf = retryOfValue ? safeId(retryOfValue, 'infrastructure retry suite run id') : null;
    const failureCode = failureCodeValue ? safeId(failureCodeValue, 'infrastructure failure code') : null;
    if (Boolean(retryOf) !== Boolean(failureCode)) {
      throw new Error('--infrastructure-retry-of and --infrastructure-failure-code must be provided together.');
    }

    let attemptNumber = 1;
    let retryFailureSummary = null;
    let retryChangeSummary = null;
    let retryExpectedResult = null;
    if (scopedAttempts.length === 0) {
      if (retryOf) {
        throw new Error(
          `Cannot authorize an infrastructure retry for ${taskId} before its first candidate attempt `
          + `for runtime ${normalizedRuntimeGitSha} and suite ${normalizedSuiteId}.`
        );
      }
    } else {
      if (scopedAttempts.length >= 2) {
        const recent = scopedAttempts.slice(-2).map((attempt) => ({
          suite_run_id: attempt.suite_run_id,
          commit_suite_attempt_number: attempt.commit_suite_attempt_number,
          runtime_git_sha: attempt.runtime_git_sha,
          suite_id: attempt.suite_id,
          infrastructure_retry: attempt.infrastructure_retry,
          retry_of: attempt.retry_of,
          outcome: attempt.outcome ?? null,
          failure_classification: attempt.failure_classification ?? null,
          actual_changed_paths: attempt.actual_changed_paths ?? []
        }));
        throw new Error(
          `Candidate attempt limit reached for ${taskId} at runtime ${normalizedRuntimeGitSha} and suite ${normalizedSuiteId}: `
          + `one candidate plus one infrastructure retry are already recorded. Recent attempt comparison: ${JSON.stringify(recent)}.`
        );
      }
      if (!retryOf) {
        throw new Error(
          `Candidate attempt limit reached for ${taskId} at runtime ${normalizedRuntimeGitSha} and suite ${normalizedSuiteId}: `
          + 'the default candidate attempt already exists. A single retry requires a proven infrastructure failure.'
        );
      }
      if (!INFRASTRUCTURE_RETRY_FAILURE_CODES.has(failureCode)) {
        throw new Error(
          `Unsupported infrastructure failure code: ${failureCode}. Allowed values: `
          + `${[...INFRASTRUCTURE_RETRY_FAILURE_CODES].join(', ')}.`
        );
      }
      const previous = scopedAttempts.find((attempt) => attempt.suite_run_id === retryOf);
      if (!previous) {
        throw new Error(
          `Infrastructure retry target is not a recorded candidate attempt in the current task, runtime commit, and frozen suite scope: ${retryOf}.`
        );
      }
      retryFailureSummary = requiredText(retryFailureSummaryValue, '--retry-failure-summary');
      retryChangeSummary = requiredText(retryChangeSummaryValue, '--retry-change-summary');
      retryExpectedResult = requiredText(retryExpectedResultValue, '--retry-expected-result');
      if (retryChangeSummary.toLowerCase() === retryFailureSummary.toLowerCase()) {
        throw new Error('--retry-change-summary must describe a new repair, not repeat the previous failure summary.');
      }
      await proveInfrastructureFailureBeforeCandidateChanges(root, previous, failureCode);
      attemptNumber = 2;
    }

    const entry = {
      task_id: taskId,
      suite_id: normalizedSuiteId,
      runtime_git_sha: normalizedRuntimeGitSha,
      suite_run_id: normalizedSuiteRunId,
      attempt_number: attemptNumber,
      commit_suite_attempt_number: attemptNumber,
      recorded_at: new Date().toISOString(),
      source: 'prepare_reservation',
      infrastructure_retry: attemptNumber === 2,
      retry_authorized: attemptNumber === 2,
      retry_of: attemptNumber === 2 ? retryOf : null,
      infrastructure_failure_code: attemptNumber === 2 ? failureCode : null,
      retry_failure_summary: retryFailureSummary,
      retry_change_summary: retryChangeSummary,
      retry_expected_result: retryExpectedResult,
      batch_state_path: batchStatePath ? path.resolve(batchStatePath) : null,
      legacy_scope_unknown: false
    };
    attempts.push(entry);
    await writeJsonAtomic(policyPath, ledgerValue(taskId, attempts));
    return { ...entry, policy_path: policyPath };
  });
}

export async function attachAttemptWorkspace(attemptPolicy, sessionDirectory, worktreePath) {
  if (!attemptPolicy.policy_path) return;
  await withAttemptPolicyLock(attemptPolicy.policy_path, async () => {
    const ledger = await readJsonIfExists(attemptPolicy.policy_path);
    const selected = ledger?.attempts?.find((attempt) => attempt.suite_run_id === attemptPolicy.suite_run_id);
    if (!selected) throw new Error(`Candidate attempt reservation disappeared: ${attemptPolicy.policy_path}.`);
    selected.session_dir = sessionDirectory;
    selected.worktree_path = worktreePath;
    await writeJsonAtomic(attemptPolicy.policy_path, ledgerValue(ledger.task_id, ledger.attempts));
  });
}
