import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_RUNTIME_ROUTE_STATE = path.join(os.homedir(), '.codexpro', 'stack', 'runtime-route.json');
export const DEFAULT_RUNTIME_ROUTE_LOCK = path.join(os.homedir(), '.codexpro', 'stack', 'runtime-route.lock');

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

function positivePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} must be a valid TCP port.`);
  return port;
}

function positivePid(value, label) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`${label} must be a positive process id.`);
  return pid;
}

export function runtimeWorktreeDigest(worktreePath) {
  return `sha256:${createHash('sha256').update(path.resolve(worktreePath)).digest('hex')}`;
}

export function readRuntimeRoute(statePath = DEFAULT_RUNTIME_ROUTE_STATE) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function validateRuntimeRoute(route) {
  if (!route || route.version !== 1) throw new Error('Runtime route state is missing or invalid.');
  if (!['primary', 'candidate'].includes(route.mode)) throw new Error('Runtime route mode is invalid.');
  if (route.target_host !== '127.0.0.1') throw new Error('Runtime route target must remain on loopback.');
  positivePort(route.entry_port, 'Runtime route entry_port');
  positivePort(route.target_port, 'Runtime route target_port');
  positivePid(route.target_pid, 'Runtime route target_pid');
  if (!Number.isInteger(route.generation) || route.generation < 1) throw new Error('Runtime route generation is invalid.');
  if (!route.identity || typeof route.identity !== 'object') throw new Error('Runtime route identity is missing.');
  if (route.mode === 'candidate') {
    for (const field of ['suite_run_id', 'task_id', 'runtime_git_sha', 'worktree_sha256', 'preflight_nonce', 'started_at']) {
      if (typeof route.identity[field] !== 'string' || !route.identity[field]) {
        throw new Error(`Candidate Runtime route identity is missing ${field}.`);
      }
    }
    positivePid(route.identity.runtime_pid, 'Candidate Runtime identity runtime_pid');
  }
  return route;
}

export function writePrimaryRuntimeRoute(input) {
  const previous = readRuntimeRoute(input.state_path);
  const route = {
    version: 1,
    generation: Number.isInteger(previous?.generation) ? previous.generation + 1 : 1,
    mode: 'primary',
    entry_port: positivePort(input.entry_port, 'Primary Runtime entry_port'),
    target_host: '127.0.0.1',
    target_port: positivePort(input.target_port, 'Primary Runtime target_port'),
    target_pid: positivePid(input.target_pid, 'Primary Runtime target_pid'),
    identity: {
      active: false,
      suite_run_id: null,
      task_id: null,
      runtime_git_sha: null,
      worktree_sha256: runtimeWorktreeDigest(input.worktree_path),
      preflight_nonce: null,
      runtime_pid: Number.isInteger(input.runtime_pid) ? input.runtime_pid : null,
      started_at: input.started_at ?? new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  };
  atomicWriteJson(input.state_path, route);
  return route;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function acquireRuntimeRouteLease(input = {}) {
  const statePath = path.resolve(input.state_path ?? DEFAULT_RUNTIME_ROUTE_STATE);
  const lockPath = path.resolve(input.lock_path ?? DEFAULT_RUNTIME_ROUTE_LOCK);
  const primary = validateRuntimeRoute(readRuntimeRoute(statePath));
  if (primary.mode !== 'primary') throw new Error('Stable Runtime entry is not currently routed to the primary service.');
  const owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    suite_run_id: String(input.suite_run_id ?? ''),
    task_id: String(input.task_id ?? ''),
    acquired_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { state_path: statePath, lock_path: lockPath, owner, primary_route: primary, active: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readLock(lockPath);
      if (processAlive(Number(existing?.pid))) {
        throw new Error(`Stable Runtime entry is already leased by pid ${existing.pid}.`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error('Unable to acquire the stable Runtime entry lease.');
}

function assertLease(lease) {
  if (!lease?.active) throw new Error('Runtime route lease is not active.');
  const current = readLock(lease.lock_path);
  if (!current || current.token !== lease.owner.token || current.pid !== lease.owner.pid) {
    throw new Error('Runtime route lease ownership changed.');
  }
}

export function activateCandidateRuntimeRoute(lease, input) {
  assertLease(lease);
  const current = validateRuntimeRoute(readRuntimeRoute(lease.state_path));
  if (current.mode !== 'primary' || current.generation !== lease.primary_route.generation) {
    throw new Error('Primary Runtime route changed after the candidate lease was acquired.');
  }
  const identity = input.identity ?? {};
  const route = {
    version: 1,
    generation: current.generation + 1,
    mode: 'candidate',
    entry_port: current.entry_port,
    target_host: '127.0.0.1',
    target_port: positivePort(input.target_port, 'Candidate Runtime target_port'),
    target_pid: positivePid(input.target_pid, 'Candidate Runtime target_pid'),
    identity: {
      active: true,
      suite_run_id: identity.suite_run_id,
      task_id: identity.task_id,
      runtime_git_sha: identity.runtime_git_sha,
      worktree_sha256: identity.worktree_sha256,
      preflight_nonce: identity.preflight_nonce,
      runtime_pid: positivePid(identity.runtime_pid, 'Candidate Runtime identity runtime_pid'),
      started_at: identity.started_at
    },
    updated_at: new Date().toISOString()
  };
  validateRuntimeRoute(route);
  atomicWriteJson(lease.state_path, route);
  lease.candidate_route = route;
  return route;
}

export function restorePrimaryRuntimeRoute(lease) {
  assertLease(lease);
  const current = validateRuntimeRoute(readRuntimeRoute(lease.state_path));
  const route = {
    ...lease.primary_route,
    generation: current.generation + 1,
    updated_at: new Date().toISOString()
  };
  atomicWriteJson(lease.state_path, route);
  lease.restored = true;
  return route;
}

export function releaseRuntimeRouteLease(lease) {
  if (!lease?.active) return false;
  assertLease(lease);
  if (!lease.restored) throw new Error('Runtime route lease cannot be released before the primary route is restored.');
  fs.rmSync(lease.lock_path, { force: true });
  lease.active = false;
  return true;
}

