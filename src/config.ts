import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import type { ReviewMode } from "./agents/types.js";
import type { CodexAdapterMode } from "./codex/types.js";
import { TOOL_LIMITS } from "./tools/toolLimits.js";

export type BashMode = "off" | "safe" | "full";
export type BashTranscriptMode = "compact" | "full";
export type CodexSessionsMode = "off" | "metadata" | "read";
export type WriteMode = "off" | "handoff" | "workspace";
export type ToolMode = "minimal" | "progressive" | "standard" | "full";
export type BrowserMode = "headless" | "headed" | "cdp";

export interface CodexProConfig {
  defaultRoot: string;
  allowedRoots: string[];
  host: string;
  port: number;
  widgetDomain: string;
  authToken?: string;
  requireHttpToken: boolean;
  bashMode: BashMode;
  bashTranscript: BashTranscriptMode;
  bashSessionId?: string;
  requireBashSession: boolean;
  codexSessions: CodexSessionsMode;
  codexDir: string;
  codexAdapter: CodexAdapterMode;
  codexExecutable: string;
  codexSubagentsEnabled: boolean;
  codexSubagentsMaxParallel: number;
  codexReviewEnabled: boolean;
  codexReviewMode: ReviewMode;
  codexReviewP0Threshold: number;
  codexReviewP1Threshold: number;
  codexReviewRequireCriticalScopeCovered: boolean;
  executionLanesEnabled: boolean;
  providerCapabilityCacheEnabled: boolean;
  providerCapabilityCacheAvailableTtlMs: number;
  providerCapabilityCacheUnavailableTtlMs: number;
  providerCapabilityCacheWarmup: boolean;
  contextProfilesEnabled: boolean;
  riskInputRolesEnabled: boolean;
  riskObservabilityEnabled: boolean;
  reportPolicyLaneBased: boolean;
  reportFullLogsOnFailure: boolean;
  resourceWaitTimeoutMs: number;
  codexWorktreesEnabled: boolean;
  codexWorktreeRoot: string;
  codexWritableImplementersEnabled: boolean;
  codexHooksEnabled: boolean;
  codexHookKitRoot: string;
  codexHookProfile?: string;
  codexHookProjectName?: string;
  codexHookWorklogDir: string;
  codexHookTimeoutMs: number;
  writeMode: WriteMode;
  toolMode: ToolMode;
  browserMode: BrowserMode;
  browserCdpUrl?: string;
  browserCdpProfileDir?: string;
  browserCdpDownloadDir?: string;
  browserCdpDownloadMountDir?: string;
  browserCdpConnectTimeoutMs: number;
  browserRequireExtensionAuth: boolean;
  browserAllowHeadlessFallback: boolean;
  browserObserveMaxNodes: number;
  browserObserveMaxTextChars: number;
  browserObserveMaxResponseBytes: number;
  browserVerificationMaxPages: number;
  inheritEnv: boolean;
  skillsEnabled: boolean;
  skillsRoot: string;
  skillsLockFile: string;
  maxSkillReadBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxHttpSessions: number;
  httpSessionTtlMs: number;
  mcp20260728Enabled: boolean;
  mcp20260728RolloutPercent: number;
  mcpTasksExtensionEnabled: boolean;
  mcpMrtrEnabled: boolean;
  mcpAppsEnabled: boolean;
  mcpSubscriptionsEnabled: boolean;
  mcpOauthHardeningEnabled: boolean;
  mcpRequestStateSecret?: string;
  mcpOauthResource: string;
  mcpOauthAudience?: string;
  mcpOauthAuthorizationServers: string[];
  mcpOauthScopes: string[];
  mcpOauthDpopRequired: boolean;
  blockedGlobs: string[];
  contextDir: string;
  toolCards: boolean;
}

const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env/**",
  ".env.*",
  ".env.*/**",
  "**/.env",
  "**/.env/**",
  "**/.env.*",
  "**/.env.*/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
];

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bashModeFrom(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "full") return value;
  return "safe";
}

function bashTranscriptFrom(value: string | undefined): BashTranscriptMode {
  if (value === "compact" || value === "full") return value;
  return "compact";
}

function codexSessionsFrom(value: string | undefined): CodexSessionsMode {
  if (value === "metadata" || value === "read") return value;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "metadata";
  return "off";
}

function codexAdapterFrom(value: string | undefined): CodexAdapterMode {
  if (value === "auto" || value === "sdk" || value === "exec" || value === "mock") return value;
  return "off";
}

function codexExecutableFrom(value: string | undefined): string {
  const trimmed = value?.trim() || "codex";
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new Error("CODEXPRO_CODEX_EXECUTABLE must be one executable path without line breaks.");
  }
  return expandHome(trimmed);
}

function optionalHookNameFrom(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(trimmed)) {
    throw new Error(`${label} must be 1-100 characters using letters, numbers, dot, underscore, or dash.`);
  }
  return trimmed;
}

function safePathValue(value: string | undefined, fallback: string, label: string): string {
  const trimmed = value?.trim() || fallback;
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new Error(`${label} must be one path without line breaks.`);
  }
  return path.resolve(expandHome(trimmed));
}

function bashSessionIdFrom(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("CODEXPRO_BASH_SESSION_ID must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.");
  }
  return trimmed;
}

function writeModeFrom(value: string | undefined): WriteMode {
  if (value === "off" || value === "handoff" || value === "workspace") return value;
  return "workspace";
}

function toolModeFrom(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "progressive" || value === "standard" || value === "full") return value;
  return "progressive";
}

function browserModeFrom(value: string | undefined): BrowserMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "headless";
  if (normalized === "headless" || normalized === "headed" || normalized === "cdp") return normalized;
  throw new Error(`CODEXPRO_BROWSER_MODE must be headless, headed, or cdp, got: ${value}`);
}

function optionalSingleLineValue(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new Error(`${label} must be one value without line breaks.`);
  }
  return trimmed;
}

function isPrivateOrLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;

  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (family === 6) {
    if (host === "::1") return true;
    const firstGroup = Number.parseInt(host.split(":", 1)[0] || "0", 16);
    return (firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80;
  }
  return false;
}

function browserCdpUrlFrom(value: string | undefined): string | undefined {
  const trimmed = optionalSingleLineValue(value, "CODEXPRO_BROWSER_CDP_URL");
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("CODEXPRO_BROWSER_CDP_URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CODEXPRO_BROWSER_CDP_URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("CODEXPRO_BROWSER_CDP_URL must not contain username/password credentials.");
  }
  if (!isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error("CODEXPRO_BROWSER_CDP_URL must use localhost or a private Windows/WSL IP address; public CDP endpoints are prohibited.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function widgetDomainFrom(value: string | undefined): string {
  const raw = value?.trim() || "https://example.github.io";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`CODEXPRO_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("CODEXPRO_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CODEXPRO_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

function contextDirFrom(value: string | undefined): string {
  const raw = (value?.trim() || ".ai-bridge").replaceAll("\\", "/");
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("CODEXPRO_CONTEXT_DIR must be a workspace-relative hidden directory, for example .ai-bridge.");
  }

  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must stay inside the workspace.");
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must be a simple relative directory path.");
  }
  if (!parts[0].startsWith(".")) {
    throw new Error("CODEXPRO_CONTEXT_DIR must start with a hidden directory such as .ai-bridge.");
  }

  const blocked = new Set([".git", ".ssh", ".gnupg", ".cache", "node_modules", "src", "dist", "build", ".next", "coverage"]);
  if (parts.some((part) => blocked.has(part))) {
    throw new Error("CODEXPRO_CONTEXT_DIR cannot point at source, dependency, build, cache, or credential directories.");
  }
  return normalized;
}

function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function reviewModeFrom(value: string | undefined): ReviewMode {
  const normalized = value?.trim().toLowerCase() || "advisory";
  if (normalized === "advisory" || normalized === "gated" || normalized === "independent") return normalized;
  throw new Error(`CODEXPRO_CODEX_REVIEW_MODE must be advisory, gated, or independent, got: ${value}`);
}

function confidenceThresholdFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Review confidence threshold must be between 0 and 1, got: ${value}`);
  }
  return parsed;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadConfig(argv = process.argv.slice(2)): CodexProConfig {
  const args = parseArgs(argv);

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? process.env.CODEXPRO_ROOT ?? process.env.CODEBASE_BRIDGE_REPO_ROOT ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = [
    ...splitRoots(process.env.CODEXPRO_ALLOWED_ROOTS),
    ...splitRoots(process.env.CODEBASE_BRIDGE_ALLOWED_ROOTS)
  ];

  const allowHome = process.env.CODEXPRO_ALLOW_HOME === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const bashTranscriptArg = typeof args["bash-transcript"] === "string" ? args["bash-transcript"] : undefined;
  const bashSessionArg = typeof args["bash-session"] === "string" ? args["bash-session"] : undefined;
  const codexSessionsArg = typeof args["codex-sessions"] === "string" ? args["codex-sessions"] : undefined;
  const codexDirArg = typeof args["codex-dir"] === "string" ? args["codex-dir"] : undefined;
  const codexAdapterArg = typeof args["codex-adapter"] === "string" ? args["codex-adapter"] : undefined;
  const codexExecutableArg = typeof args["codex-executable"] === "string" ? args["codex-executable"] : undefined;
  const codexSubagentsArg = args["codex-subagents"] === true
    ? "true"
    : typeof args["codex-subagents"] === "string"
      ? args["codex-subagents"]
      : undefined;
  const codexSubagentsMaxParallelArg = typeof args["codex-subagents-max-parallel"] === "string"
    ? args["codex-subagents-max-parallel"]
    : undefined;
  const codexReviewArg = args["codex-review"] === true
    ? "true"
    : typeof args["codex-review"] === "string"
      ? args["codex-review"]
      : undefined;
  const codexReviewModeArg = typeof args["codex-review-mode"] === "string" ? args["codex-review-mode"] : undefined;
  const codexReviewP0ThresholdArg = typeof args["codex-review-p0-threshold"] === "string" ? args["codex-review-p0-threshold"] : undefined;
  const codexReviewP1ThresholdArg = typeof args["codex-review-p1-threshold"] === "string" ? args["codex-review-p1-threshold"] : undefined;
  const codexReviewRequireCriticalScopeArg = args["codex-review-require-critical-scope"] === true
    ? "true"
    : typeof args["codex-review-require-critical-scope"] === "string"
      ? args["codex-review-require-critical-scope"]
      : undefined;
  const executionLanesArg = args["execution-lanes"] === true
    ? "true"
    : typeof args["execution-lanes"] === "string"
      ? args["execution-lanes"]
      : undefined;
  const providerCapabilityCacheArg = args["provider-capability-cache"] === true
    ? "true"
    : typeof args["provider-capability-cache"] === "string"
      ? args["provider-capability-cache"]
      : undefined;
  const providerCapabilityCacheAvailableTtlArg = typeof args["provider-capability-cache-available-ttl-ms"] === "string"
    ? args["provider-capability-cache-available-ttl-ms"]
    : undefined;
  const providerCapabilityCacheUnavailableTtlArg = typeof args["provider-capability-cache-unavailable-ttl-ms"] === "string"
    ? args["provider-capability-cache-unavailable-ttl-ms"]
    : undefined;
  const providerCapabilityCacheWarmupArg = args["provider-capability-cache-warmup"] === true
    ? "true"
    : typeof args["provider-capability-cache-warmup"] === "string"
      ? args["provider-capability-cache-warmup"]
      : undefined;
  const contextProfilesArg = args["context-profiles"] === true
    ? "true"
    : typeof args["context-profiles"] === "string"
      ? args["context-profiles"]
      : undefined;
  const riskInputRolesArg = args["risk-input-roles"] === true
    ? "true"
    : typeof args["risk-input-roles"] === "string"
      ? args["risk-input-roles"]
      : undefined;
  const riskObservabilityArg = args["risk-observability"] === true
    ? "true"
    : typeof args["risk-observability"] === "string"
      ? args["risk-observability"]
      : undefined;
  const resourceWaitTimeoutArg = typeof args["resource-wait-timeout-ms"] === "string" ? args["resource-wait-timeout-ms"] : undefined;
  const codexWorktreesArg = args["codex-worktrees"] === true
    ? "true"
    : typeof args["codex-worktrees"] === "string"
      ? args["codex-worktrees"]
      : undefined;
  const codexWorktreeRootArg = typeof args["codex-worktree-root"] === "string" ? args["codex-worktree-root"] : undefined;
  const codexWritableImplementersArg = args["codex-writable-implementers"] === true
    ? "true"
    : typeof args["codex-writable-implementers"] === "string"
      ? args["codex-writable-implementers"]
      : undefined;
  const codexHooksArg = args["codex-hooks"] === true
    ? "true"
    : typeof args["codex-hooks"] === "string"
      ? args["codex-hooks"]
      : undefined;
  const codexHookKitRootArg = typeof args["codex-hook-kit-root"] === "string" ? args["codex-hook-kit-root"] : undefined;
  const codexHookProfileArg = typeof args["codex-hook-profile"] === "string" ? args["codex-hook-profile"] : undefined;
  const codexHookProjectArg = typeof args["codex-hook-project"] === "string" ? args["codex-hook-project"] : undefined;
  const codexHookWorklogDirArg = typeof args["codex-hook-worklog-dir"] === "string" ? args["codex-hook-worklog-dir"] : undefined;
  const codexHookTimeoutArg = typeof args["codex-hook-timeout-ms"] === "string" ? args["codex-hook-timeout-ms"] : undefined;
  const requireBashSessionArg =
    args["require-bash-session"] === true
      ? "true"
      : typeof args["require-bash-session"] === "string"
        ? args["require-bash-session"]
        : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const browserModeArg = typeof args["browser-mode"] === "string" ? args["browser-mode"] : undefined;
  const browserCdpUrlArg = typeof args["browser-cdp-url"] === "string" ? args["browser-cdp-url"] : undefined;
  const browserCdpProfileDirArg = typeof args["browser-cdp-profile-dir"] === "string" ? args["browser-cdp-profile-dir"] : undefined;
  const browserCdpDownloadDirArg = typeof args["browser-cdp-download-dir"] === "string" ? args["browser-cdp-download-dir"] : undefined;
  const browserCdpDownloadMountDirArg = typeof args["browser-cdp-download-mount-dir"] === "string" ? args["browser-cdp-download-mount-dir"] : undefined;
  const browserCdpConnectTimeoutArg = typeof args["browser-cdp-connect-timeout-ms"] === "string" ? args["browser-cdp-connect-timeout-ms"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const toolCardsArg =
    args["tool-cards"] === true
      ? "true"
      : typeof args["tool-cards"] === "string"
        ? args["tool-cards"]
        : undefined;
  const extraBlockedGlobs = splitList(process.env.CODEXPRO_BLOCKED_GLOBS, ",");
  const host = hostArg ?? process.env.CODEXPRO_HOST ?? process.env.HOST ?? "127.0.0.1";
  const configuredAuthToken = process.env.CODEXPRO_HTTP_TOKEN ?? process.env.CODEBASE_BRIDGE_HTTP_TOKEN;
  const allowNoToken = boolFrom(process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN, false) && isLoopbackHost(host);
  const authToken = allowNoToken ? undefined : configuredAuthToken;
  const requireHttpToken =
    !allowNoToken && (
      !authToken ||
      boolFrom(process.env.CODEXPRO_REQUIRE_HTTP_TOKEN, false) ||
      boolFrom(process.env.CODEXPRO_TUNNEL_MODE, false) ||
      !isLoopbackHost(host)
    );
  const bashSessionId = bashSessionIdFrom(bashSessionArg ?? process.env.CODEXPRO_BASH_SESSION_ID);
  const requireBashSession = boolFrom(requireBashSessionArg ?? process.env.CODEXPRO_REQUIRE_BASH_SESSION, false);
  if (requireBashSession && !bashSessionId) {
    throw new Error("CODEXPRO_REQUIRE_BASH_SESSION requires CODEXPRO_BASH_SESSION_ID or --bash-session.");
  }

  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.CODEXPRO_PORT ?? process.env.PORT, 8787, 1, 65535),
    widgetDomain: widgetDomainFrom(widgetDomainArg ?? process.env.CODEXPRO_WIDGET_DOMAIN),
    authToken,
    requireHttpToken,
    bashMode: bashModeFrom(bashArg ?? process.env.CODEXPRO_BASH_MODE),
    bashTranscript: bashTranscriptFrom(bashTranscriptArg ?? process.env.CODEXPRO_BASH_TRANSCRIPT),
    bashSessionId,
    requireBashSession,
    codexSessions: codexSessionsFrom(codexSessionsArg ?? process.env.CODEXPRO_CODEX_SESSIONS),
    codexDir: expandHome(codexDirArg || process.env.CODEXPRO_CODEX_DIR || path.join(os.homedir(), ".codex")),
    codexAdapter: codexAdapterFrom(codexAdapterArg ?? process.env.CODEXPRO_CODEX_ADAPTER),
    codexExecutable: codexExecutableFrom(codexExecutableArg ?? process.env.CODEXPRO_CODEX_EXECUTABLE),
    codexSubagentsEnabled: boolFrom(codexSubagentsArg ?? process.env.CODEXPRO_CODEX_SUBAGENTS, false),
    codexSubagentsMaxParallel: numberFrom(
      codexSubagentsMaxParallelArg ?? process.env.CODEXPRO_CODEX_SUBAGENTS_MAX_PARALLEL,
      2,
      1,
      2
    ),
    codexReviewEnabled: boolFrom(codexReviewArg ?? process.env.CODEXPRO_CODEX_REVIEW, false),
    codexReviewMode: reviewModeFrom(codexReviewModeArg ?? process.env.CODEXPRO_CODEX_REVIEW_MODE),
    codexReviewP0Threshold: confidenceThresholdFrom(
      codexReviewP0ThresholdArg ?? process.env.CODEXPRO_CODEX_REVIEW_P0_THRESHOLD,
      0.5
    ),
    codexReviewP1Threshold: confidenceThresholdFrom(
      codexReviewP1ThresholdArg ?? process.env.CODEXPRO_CODEX_REVIEW_P1_THRESHOLD,
      0.7
    ),
    codexReviewRequireCriticalScopeCovered: boolFrom(
      codexReviewRequireCriticalScopeArg ?? process.env.CODEXPRO_CODEX_REVIEW_REQUIRE_CRITICAL_SCOPE,
      true
    ),
    executionLanesEnabled: boolFrom(
      executionLanesArg ?? process.env.CODEXPRO_EXECUTION_LANES_ENABLED,
      true
    ),
    providerCapabilityCacheEnabled: boolFrom(
      providerCapabilityCacheArg ?? process.env.CODEXPRO_PROVIDER_CAPABILITY_CACHE_ENABLED,
      true
    ),
    providerCapabilityCacheAvailableTtlMs: numberFrom(
      providerCapabilityCacheAvailableTtlArg ?? process.env.CODEXPRO_PROVIDER_CAPABILITY_CACHE_AVAILABLE_TTL_MS,
      60_000,
      1_000,
      600_000
    ),
    providerCapabilityCacheUnavailableTtlMs: numberFrom(
      providerCapabilityCacheUnavailableTtlArg ?? process.env.CODEXPRO_PROVIDER_CAPABILITY_CACHE_UNAVAILABLE_TTL_MS,
      10_000,
      500,
      120_000
    ),
    providerCapabilityCacheWarmup: boolFrom(
      providerCapabilityCacheWarmupArg ?? process.env.CODEXPRO_PROVIDER_CAPABILITY_CACHE_WARMUP,
      true
    ),
    contextProfilesEnabled: boolFrom(
      contextProfilesArg ?? process.env.CODEXPRO_CONTEXT_PROFILES_ENABLED,
      true
    ),
    riskInputRolesEnabled: boolFrom(
      riskInputRolesArg ?? process.env.CODEXPRO_RISK_INPUT_ROLES_ENABLED,
      true
    ),
    riskObservabilityEnabled: boolFrom(
      riskObservabilityArg ?? process.env.CODEXPRO_RISK_OBSERVABILITY_ENABLED,
      true
    ),
    reportPolicyLaneBased: boolFrom(process.env.CODEXPRO_REPORT_POLICY_LANE_BASED, true),
    reportFullLogsOnFailure: boolFrom(process.env.CODEXPRO_REPORT_FULL_LOGS_ON_FAILURE, true),
    resourceWaitTimeoutMs: numberFrom(
      resourceWaitTimeoutArg ?? process.env.CODEXPRO_RESOURCE_WAIT_TIMEOUT_MS,
      10_000,
      100,
      24 * 60 * 60_000
    ),
    codexWorktreesEnabled: boolFrom(codexWorktreesArg ?? process.env.CODEXPRO_CODEX_WORKTREES, false),
    codexWorktreeRoot: path.resolve(expandHome(codexWorktreeRootArg || process.env.CODEXPRO_CODEX_WORKTREE_ROOT || path.join(os.homedir(), ".codexpro", "worktrees"))),
    codexWritableImplementersEnabled: boolFrom(
      codexWritableImplementersArg ?? process.env.CODEXPRO_CODEX_WRITABLE_IMPLEMENTERS,
      false
    ),
    codexHooksEnabled: boolFrom(codexHooksArg ?? process.env.CODEXPRO_CODEX_HOOKS, false),
    codexHookKitRoot: safePathValue(
      codexHookKitRootArg ?? process.env.CODEXPRO_CODEX_HOOK_KIT_ROOT,
      path.join(path.dirname(defaultRoot), "codexpro-hook-kit"),
      "CODEXPRO_CODEX_HOOK_KIT_ROOT"
    ),
    codexHookProfile: optionalHookNameFrom(
      codexHookProfileArg ?? process.env.CODEXPRO_CODEX_HOOK_PROFILE,
      "CODEXPRO_CODEX_HOOK_PROFILE"
    ),
    codexHookProjectName: optionalHookNameFrom(
      codexHookProjectArg ?? process.env.CODEXPRO_CODEX_HOOK_PROJECT,
      "CODEXPRO_CODEX_HOOK_PROJECT"
    ),
    codexHookWorklogDir: safePathValue(
      codexHookWorklogDirArg ?? process.env.CODEXPRO_CODEX_HOOK_WORKLOG_DIR,
      path.join(path.dirname(defaultRoot), "_codexpro-worklog"),
      "CODEXPRO_CODEX_HOOK_WORKLOG_DIR"
    ),
    codexHookTimeoutMs: numberFrom(
      codexHookTimeoutArg ?? process.env.CODEXPRO_CODEX_HOOK_TIMEOUT_MS,
      12_000,
      1_000,
      60_000
    ),
    writeMode: writeModeFrom(writeArg ?? process.env.CODEXPRO_WRITE_MODE),
    toolMode: toolModeFrom(toolModeArg ?? process.env.CODEXPRO_TOOL_MODE),
    browserMode: browserModeFrom(browserModeArg ?? process.env.CODEXPRO_BROWSER_MODE),
    browserCdpUrl: browserCdpUrlFrom(browserCdpUrlArg ?? process.env.CODEXPRO_BROWSER_CDP_URL),
    browserCdpProfileDir: optionalSingleLineValue(
      browserCdpProfileDirArg ?? process.env.CODEXPRO_BROWSER_CDP_PROFILE_DIR,
      "CODEXPRO_BROWSER_CDP_PROFILE_DIR"
    ),
    browserCdpDownloadDir: optionalSingleLineValue(
      browserCdpDownloadDirArg ?? process.env.CODEXPRO_BROWSER_CDP_DOWNLOAD_DIR,
      "CODEXPRO_BROWSER_CDP_DOWNLOAD_DIR"
    ),
    browserCdpDownloadMountDir: optionalSingleLineValue(
      browserCdpDownloadMountDirArg ?? process.env.CODEXPRO_BROWSER_CDP_DOWNLOAD_MOUNT_DIR,
      "CODEXPRO_BROWSER_CDP_DOWNLOAD_MOUNT_DIR"
    ),
    browserCdpConnectTimeoutMs: numberFrom(
      browserCdpConnectTimeoutArg ?? process.env.CODEXPRO_BROWSER_CDP_CONNECT_TIMEOUT_MS,
      15_000,
      250,
      120_000
    ),
    browserRequireExtensionAuth: boolFrom(process.env.CODEXPRO_BROWSER_REQUIRE_EXTENSION_AUTH, false),
    browserAllowHeadlessFallback: boolFrom(process.env.CODEXPRO_BROWSER_ALLOW_HEADLESS_FALLBACK, false),
    browserObserveMaxNodes: numberFrom(
      process.env.CODEXPRO_BROWSER_OBSERVE_MAX_NODES,
      TOOL_LIMITS.browser.observe_default_nodes,
      1,
      TOOL_LIMITS.browser.observe_max_nodes
    ),
    browserObserveMaxTextChars: numberFrom(
      process.env.CODEXPRO_BROWSER_OBSERVE_MAX_TEXT_CHARS,
      TOOL_LIMITS.browser.observe_default_text_chars,
      1_000,
      TOOL_LIMITS.browser.observe_max_text_chars
    ),
    browserObserveMaxResponseBytes: numberFrom(
      process.env.CODEXPRO_BROWSER_OBSERVE_MAX_RESPONSE_BYTES,
      TOOL_LIMITS.browser.observe_default_response_bytes,
      10_000,
      TOOL_LIMITS.browser.observe_max_response_bytes
    ),
    browserVerificationMaxPages: numberFrom(
      process.env.CODEXPRO_BROWSER_VERIFICATION_MAX_PAGES,
      TOOL_LIMITS.browser.verification_default_pages,
      1,
      TOOL_LIMITS.browser.verification_max_pages
    ),
    inheritEnv: process.env.CODEXPRO_INHERIT_ENV === "1",
    skillsEnabled: boolFrom(process.env.CODEXPRO_SKILLS_ENABLED, false),
    skillsRoot: safePathValue(
      process.env.CODEXPRO_SKILLS_ROOT,
      path.join(os.homedir(), ".codexpro", "skills"),
      "CODEXPRO_SKILLS_ROOT"
    ),
    skillsLockFile: safePathValue(
      process.env.CODEXPRO_SKILLS_LOCK_FILE,
      path.join(os.homedir(), ".codexpro", "skills", "skills-lock.json"),
      "CODEXPRO_SKILLS_LOCK_FILE"
    ),
    maxSkillReadBytes: numberFrom(process.env.CODEXPRO_MAX_SKILL_READ_BYTES, 200_000, 1_000, 2_000_000),
    maxReadBytes: numberFrom(process.env.CODEXPRO_MAX_READ_BYTES, 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(process.env.CODEXPRO_MAX_WRITE_BYTES, 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(
      process.env.CODEXPRO_MAX_SEARCH_RESULTS,
      TOOL_LIMITS.search_project.max_results_per_query,
      1,
      TOOL_LIMITS.search_project.max_results_per_query
    ),
    maxHttpSessions: numberFrom(process.env.CODEXPRO_MAX_HTTP_SESSIONS, 64, 1, 512),
    httpSessionTtlMs: numberFrom(process.env.CODEXPRO_HTTP_SESSION_TTL_MS, 30 * 60_000, 60_000, 24 * 60 * 60_000),
    mcp20260728Enabled: boolFrom(process.env.CODEXPRO_MCP_2026_07_28_ENABLED, true),
    mcp20260728RolloutPercent: numberFrom(process.env.CODEXPRO_MCP_2026_07_28_ROLLOUT_PERCENT, 100, 0, 100),
    mcpTasksExtensionEnabled: boolFrom(process.env.CODEXPRO_MCP_TASKS_EXTENSION_ENABLED, true),
    mcpMrtrEnabled: boolFrom(process.env.CODEXPRO_MCP_MRTR_ENABLED, true),
    mcpAppsEnabled: boolFrom(process.env.CODEXPRO_MCP_APPS_ENABLED, true),
    mcpSubscriptionsEnabled: boolFrom(process.env.CODEXPRO_MCP_SUBSCRIPTIONS_ENABLED, true),
    mcpOauthHardeningEnabled: boolFrom(process.env.CODEXPRO_MCP_OAUTH_HARDENING_ENABLED, true),
    mcpRequestStateSecret: optionalSingleLineValue(process.env.CODEXPRO_MCP_REQUEST_STATE_SECRET || authToken, "CODEXPRO_MCP_REQUEST_STATE_SECRET"),
    mcpOauthResource: optionalSingleLineValue(process.env.CODEXPRO_MCP_OAUTH_RESOURCE, "CODEXPRO_MCP_OAUTH_RESOURCE") ?? "urn:codexpro:mcp",
    mcpOauthAudience: optionalSingleLineValue(process.env.CODEXPRO_MCP_OAUTH_AUDIENCE, "CODEXPRO_MCP_OAUTH_AUDIENCE"),
    mcpOauthAuthorizationServers: String(process.env.CODEXPRO_MCP_OAUTH_AUTHORIZATION_SERVERS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    mcpOauthScopes: String(process.env.CODEXPRO_MCP_OAUTH_SCOPES ?? "codexpro.read,codexpro.write").split(",").map((value) => value.trim()).filter(Boolean),
    mcpOauthDpopRequired: boolFrom(process.env.CODEXPRO_MCP_OAUTH_DPOP_REQUIRED, false),
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    contextDir: contextDirFrom(process.env.CODEXPRO_CONTEXT_DIR),
    toolCards: boolFrom(toolCardsArg ?? process.env.CODEXPRO_TOOL_CARDS, false)
  };
}
