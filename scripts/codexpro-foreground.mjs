#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, startManagedProcess } from '../shared/execution-kernel.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function expandHome(value) {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function optionValue(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === `--${name}`) return args[index + 1];
    if (value.startsWith(`--${name}=`)) return value.slice(name.length + 3);
  }
  return undefined;
}

function readActiveStack() {
  const stateDir = path.resolve(expandHome(process.env.CODEXPRO_STACK_STATE_DIR ?? '~/.codexpro/stack'));
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    const pid = Number(state?.server?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return null;
    return state;
  } catch {
    return null;
  }
}

export function inspectForegroundConflict(args = process.argv.slice(2)) {
  const requestedRoot = path.resolve(expandHome(optionValue(args, 'root') ?? process.env.CODEXPRO_ROOT ?? process.cwd()));
  const requestedPort = Number(optionValue(args, 'port') ?? process.env.CODEXPRO_PORT ?? 8787);
  const state = readActiveStack();
  if (!state) return { conflict: false, requested_root: requestedRoot, requested_port: requestedPort, stack: null };
  const managedRoot = state.server_root ? path.resolve(state.server_root) : null;
  const managedPort = Number(state.port ?? 8787);
  const sameRoot = managedRoot === requestedRoot;
  const samePort = managedPort === requestedPort;
  return {
    conflict: sameRoot || samePort,
    requested_root: requestedRoot,
    requested_port: requestedPort,
    stack: {
      pid: state.server.pid,
      root: managedRoot,
      port: managedPort
    },
    same_root: sameRoot,
    same_port: samePort
  };
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check-only');
const forwarded = args.filter((value) => value !== '--check-only');
const inspection = inspectForegroundConflict(forwarded);
if (checkOnly) {
  fs.writeSync(process.stdout.fd, `${JSON.stringify(inspection, null, 2)}\n`);
  process.exit(inspection.conflict ? 2 : 0);
}
if (inspection.conflict) {
  console.error([
    'A canonical CodexPro Stack server is already running.',
    `Managed PID: ${inspection.stack.pid}`,
    `Managed root: ${inspection.stack.root ?? 'unknown'}`,
    `Managed port: ${inspection.stack.port}`,
    `Requested root: ${inspection.requested_root}`,
    `Requested port: ${inspection.requested_port}`,
    'Use `npm run stack:status` or `npm run stack:restart`.',
    'For an explicit foreground development instance, provide both a different --root and a different --port.'
  ].join('\n'));
  process.exit(2);
}

const started = startManagedProcess(process.execPath, [path.join(projectRoot, 'scripts/codexpro.mjs'), ...forwarded], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  domain: 'server',
  operation: 'codexpro_foreground',
  sideEffectLevel: 'local_write',
  riskLevel: 'medium',
  recordRoot: process.cwd()
});
const child = started.child;
if (!child) {
  console.error(`Failed to launch CodexPro foreground connector: ${started.errorClass ?? 'spawn failed'}`);
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Failed to launch CodexPro foreground connector: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
