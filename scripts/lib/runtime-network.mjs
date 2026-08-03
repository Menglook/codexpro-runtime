import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runManagedProcessSync } from '../../shared/execution-kernel.mjs';
import { redactSensitiveText } from '../../shared/redaction.mjs';

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_USE_ENV_PROXY'
];

function redactProxyEnvironmentOutput(value) {
  const proxyKeyPattern = PROXY_ENV_KEYS.filter((key) => key !== 'NODE_USE_ENV_PROXY').join('|');
  const proxyRedacted = String(value ?? '').replace(
    new RegExp(`(^|\\0)(${proxyKeyPattern})=([^\\0]*)`, 'g'),
    (_match, prefix, key) => `${prefix}${key}=[REDACTED_SECRET]`
  );
  return redactSensitiveText(proxyRedacted);
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value || value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function presentProxyKeys(env = process.env) {
  return PROXY_ENV_KEYS.filter((key) => String(env[key] || '').trim().length > 0).sort();
}

function mirrorProxyPair(env, upper, lower) {
  if (env[upper] && !env[lower]) env[lower] = env[upper];
  if (env[lower] && !env[upper]) env[upper] = env[lower];
}

function normalizeProxyEnvironment(env) {
  mirrorProxyPair(env, 'HTTP_PROXY', 'http_proxy');
  mirrorProxyPair(env, 'HTTPS_PROXY', 'https_proxy');
  mirrorProxyPair(env, 'ALL_PROXY', 'all_proxy');
  mirrorProxyPair(env, 'NO_PROXY', 'no_proxy');
  const configured = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some((key) => String(env[key] || '').trim().length > 0);
  if (configured && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
  return configured;
}

export function loadProxyEnvironment(options = {}) {
  const enabled = options.enabled !== false && process.env.CODEXPRO_AUTO_PROXY !== '0';
  const scriptPath = path.resolve(expandHome(
    options.scriptPath
      ?? process.env.CODEXPRO_PROXY_SCRIPT
      ?? '~/.config/wsl-proxy.sh'
  ));

  if (!enabled) {
    normalizeProxyEnvironment(process.env);
    return {
      loaded: false,
      source: 'disabled',
      script_path: scriptPath,
      keys: presentProxyKeys()
    };
  }

  if (!fs.existsSync(scriptPath)) {
    normalizeProxyEnvironment(process.env);
    return {
      loaded: false,
      source: presentProxyKeys().length ? 'existing-environment' : 'script-not-found',
      script_path: scriptPath,
      keys: presentProxyKeys()
    };
  }

  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL || 'bash');
  const result = runManagedProcessSync(
    shell,
    [
      '--noprofile',
      '--norc',
      '-c',
      'set -a; source "$1" >/dev/null 2>&1; env -0',
      'codexpro-proxy-loader',
      scriptPath
    ],
    {
      env: { ...process.env },
      maxOutputBytes: 1024 * 1024,
      returnRawStdout: true,
      redact: redactProxyEnvironmentOutput,
      domain: 'probe',
      operation: 'load_proxy_environment',
      sideEffectLevel: 'none',
      riskLevel: 'low',
      recordRoot: process.cwd()
    }
  );

  if (result.spawnError || result.exitCode !== 0) {
    normalizeProxyEnvironment(process.env);
    return {
      loaded: false,
      source: 'script-error',
      script_path: scriptPath,
      keys: presentProxyKeys(),
      error: (result.spawnError ? result.stderr || result.errorClass : '') || `proxy script exited with code ${result.exitCode ?? 'null'}`
    };
  }

  const imported = {};
  const entries = String(result.stdout || '').split('\0');
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const key = entry.slice(0, index);
    if (!PROXY_ENV_KEYS.includes(key)) continue;
    const value = entry.slice(index + 1);
    if (value) imported[key] = value;
  }

  Object.assign(process.env, imported);
  normalizeProxyEnvironment(process.env);
  return {
    loaded: Object.keys(imported).length > 0,
    source: Object.keys(imported).length > 0 ? 'proxy-script' : 'script-empty',
    script_path: scriptPath,
    keys: presentProxyKeys()
  };
}

export function probeAgentTransport(options = {}) {
  if (options.skip === true || process.env.CODEXPRO_SKIP_TRANSPORT_PREFLIGHT === '1') {
    return {
      ok: true,
      skipped: true,
      url: options.url ?? process.env.CODEXPRO_TRANSPORT_PROBE_URL ?? 'https://chatgpt.com',
      duration_ms: 0,
      http_status: null
    };
  }

  const url = String(options.url ?? process.env.CODEXPRO_TRANSPORT_PROBE_URL ?? 'https://chatgpt.com');
  const timeoutMs = Math.max(1000, Math.min(30_000, Number(options.timeoutMs ?? process.env.CODEXPRO_TRANSPORT_PREFLIGHT_TIMEOUT_MS ?? 10_000)));
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const startedAt = Date.now();
  const result = runManagedProcessSync(
    'curl',
    [
      '--silent',
      '--show-error',
      '--location',
      '--head',
      '--output',
      '/dev/null',
      '--write-out',
      '%{http_code}',
      '--max-time',
      String(timeoutSeconds),
      url
    ],
    {
      env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || '1' },
      timeoutMs: timeoutMs + 2000,
      maxOutputBytes: 32 * 1024,
      domain: 'probe',
      operation: 'agent_transport_probe',
      sideEffectLevel: 'none',
      riskLevel: 'low',
      recordRoot: process.cwd()
    }
  );

  const httpStatus = String(result.stdout || '').trim() || null;
  const ok = result.exitCode === 0 && Boolean(httpStatus) && httpStatus !== '000';
  const stderr = String(result.stderr || '').trim();
  return {
    ok,
    skipped: false,
    url,
    duration_ms: Date.now() - startedAt,
    http_status: httpStatus,
    exit_code: result.exitCode ?? null,
    error: ok ? null : ((result.spawnError ? result.errorClass : '') || stderr.split('\n').at(-1) || 'transport probe failed')
  };
}

export function ensureAgentTransportReady(options = {}) {
  const proxy = loadProxyEnvironment({
    enabled: options.autoProxy !== false,
    scriptPath: options.proxyScript
  });
  const probe = probeAgentTransport({
    skip: options.skipProbe,
    url: options.url,
    timeoutMs: options.timeoutMs
  });

  if (!probe.ok) {
    const keys = presentProxyKeys();
    throw new Error([
      `Agent transport preflight failed after ${probe.duration_ms} ms: ${probe.error || 'unknown error'}.`,
      `Probe URL: ${probe.url}.`,
      `Proxy environment keys present: ${keys.length ? keys.join(', ') : 'none'}.`,
      `Proxy script: ${proxy.script_path} (${proxy.source}).`,
      'Codex was not started. Fix the proxy/network environment and retry.'
    ].join(' '));
  }

  return { proxy, probe };
}

export function runtimeNetworkSummary(env = process.env) {
  const keys = presentProxyKeys(env);
  return {
    proxy_configured: keys.some((key) => !['NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'].includes(key)),
    proxy_keys: keys,
    node_use_env_proxy: env.NODE_USE_ENV_PROXY === '1'
  };
}
