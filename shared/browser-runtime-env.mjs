import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_BROWSER_RUNTIME_KEYS = new Set([
  'CODEXPRO_BROWSER_MODE',
  'CODEXPRO_BROWSER_CDP_URL',
  'CODEXPRO_BROWSER_CDP_PROFILE_DIR',
  'CODEXPRO_BROWSER_CDP_CONNECT_TIMEOUT_MS',
  'CODEXPRO_BROWSER_REQUIRE_EXTENSION_AUTH',
  'CODEXPRO_BROWSER_ALLOW_HEADLESS_FALLBACK',
  'CODEXPRO_BROWSER_OBSERVE_MAX_NODES',
  'CODEXPRO_BROWSER_OBSERVE_MAX_TEXT_CHARS',
  'CODEXPRO_BROWSER_OBSERVE_MAX_RESPONSE_BYTES',
  'CODEXPRO_BROWSER_VERIFICATION_MAX_PAGES'
]);

export function defaultBrowserRuntimeEnvPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.codexpro', 'runtime', 'browser-bridge.env');
}

function unquoteRuntimeValue(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseBrowserRuntimeEnv(text) {
  const parsed = {};
  for (const [index, originalLine] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(normalized);
    if (!match) throw new Error(`Invalid Browser Bridge runtime env line ${index + 1}.`);
    const [, key, rawValue] = match;
    if (!ALLOWED_BROWSER_RUNTIME_KEYS.has(key)) continue;
    const value = unquoteRuntimeValue(rawValue);
    if (/\r|\n|\0/.test(value)) throw new Error(`Invalid Browser Bridge runtime env value for ${key}.`);
    parsed[key] = value;
  }
  return parsed;
}

export function readBrowserRuntimeEnv(options = {}) {
  const envPath = options.path ?? defaultBrowserRuntimeEnvPath(options.homeDir);
  if (!fs.existsSync(envPath)) return { path: envPath, loaded: false, values: {} };
  const values = parseBrowserRuntimeEnv(fs.readFileSync(envPath, 'utf8'));
  return { path: envPath, loaded: Object.keys(values).length > 0, values };
}

function noProxyEntries(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizedCdpHostname(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '').trim();
  } catch {
    return '';
  }
}

export function ensureBrowserCdpNoProxy(target = process.env, cdpUrl = target.CODEXPRO_BROWSER_CDP_URL) {
  const hostname = normalizedCdpHostname(cdpUrl);
  if (!hostname) return [];
  const merged = [];
  const seen = new Set();
  for (const entry of [...noProxyEntries(target.NO_PROXY), ...noProxyEntries(target.no_proxy), hostname]) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  const serialized = merged.join(',');
  target.NO_PROXY = serialized;
  target.no_proxy = serialized;
  return [hostname];
}

export function applyBrowserRuntimeEnv(target = process.env, options = {}) {
  if (target.CODEXPRO_DISABLE_BROWSER_RUNTIME_ENV === '1') {
    ensureBrowserCdpNoProxy(target);
    return { path: options.path ?? defaultBrowserRuntimeEnvPath(options.homeDir), loaded: false, applied: [], values: {} };
  }
  const runtime = readBrowserRuntimeEnv(options);
  const applied = [];
  for (const [key, value] of Object.entries(runtime.values)) {
    if (target[key] !== undefined && target[key] !== '') continue;
    target[key] = value;
    applied.push(key);
  }
  ensureBrowserCdpNoProxy(target);
  return { ...runtime, applied };
}
