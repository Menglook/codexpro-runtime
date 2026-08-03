import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { listFiles } from "./fsOps.js";
import { redactSensitiveText } from "./redact.js";
import { runProcess } from "./runtime/processWrapper.js";
import { TOOL_LIMITS, clampToolLimit } from "./tools/toolLimits.js";

export type SearchBackend = "ripgrep" | "node";

export type SearchFailureCode =
  | "ripgrep_missing"
  | "search_cancelled"
  | "search_path_not_found"
  | "search_permission_denied"
  | "search_process_failed"
  | "search_query_limit_exceeded"
  | "search_result_truncated"
  | "search_timeout";

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResults: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SearchManyOptions {
  queries: string[];
  regex?: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResultsPerQuery: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  forceBackend?: SearchBackend;
}

export interface SearchQueryResult {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface SearchDiagnostics {
  durationMs: number;
  searchProcessCount: number;
  backendProbeCount: number;
  filesystemWalkCount: number;
  filesScanned: number | null;
  filesRead: number;
  bytesScanned: number | null;
}

export interface SearchManyResult {
  text: string;
  queries: SearchQueryResult[];
  truncated: boolean;
  used: SearchBackend;
  status: "ok" | "partial";
  failureCode?: SearchFailureCode;
  degradedReason?: SearchFailureCode;
  error?: string;
  diagnostics: SearchDiagnostics;
}

export interface SearchResult {
  text: string;
  matches: SearchMatch[];
  truncated: boolean;
  used: SearchBackend;
  status: "ok" | "partial";
  failureCode?: SearchFailureCode;
  degradedReason?: SearchFailureCode;
  error?: string;
  diagnostics: SearchDiagnostics;
}

export class SearchOperationError extends CodexProError {
  readonly failureCode: SearchFailureCode;

  constructor(failureCode: SearchFailureCode, message: string) {
    super(`[${failureCode}] ${message}`);
    this.failureCode = failureCode;
  }
}

const DEFAULT_SEARCH_TIMEOUT_MS = 8_000;
const MAX_SEARCH_TIMEOUT_MS = 30_000;
const MAX_MULTI_QUERIES = TOOL_LIMITS.search_project.max_long_task_queries;
const MAX_NODE_FILES = 20_000;
const NODE_SOFT_TIMEOUT_MS = 1_200;
const NODE_WALK_TIMEOUT_MS = 300;
const NODE_READ_CONCURRENCY = 8;
const RIPGREP_PROBE_TTL_MS = 30_000;

const SEARCH_RUNTIME_BASES = [
  ".codexpro/runs",
  ".codexpro/sessions",
  ".ai-bridge/acceptance-cache",
  ".ai-bridge/acceptance-receipts",
  ".ai-bridge/acceptance-reports",
  ".ai-bridge/browser-business-tasks",
  ".ai-bridge/browser-downloads",
  ".ai-bridge/browser-reports",
  ".ai-bridge/console-attention",
  ".ai-bridge/control-center-effect",
  ".ai-bridge/control-center-performance",
  ".ai-bridge/diagnostics",
  ".ai-bridge/exec-runs",
  ".ai-bridge/execution",
  ".ai-bridge/execution-components",
  ".ai-bridge/git-finalization",
  ".ai-bridge/gold-task-evaluation",
  ".ai-bridge/gold-task-session-smoke",
  ".ai-bridge/history",
  ".ai-bridge/live-regression",
  ".ai-bridge/release-reports",
  ".ai-bridge/resource-baselines",
  ".ai-bridge/resource-governor",
  ".ai-bridge/run-events",
  ".ai-bridge/runs",
  ".ai-bridge/runtime-backups",
  ".ai-bridge/session-runs",
  ".ai-bridge/task-runs",
  ".ai-bridge/task-snapshots",
  ".ai-bridge/trace",
  ".ai-bridge/usage"
] as const;

let ripgrepProbeCache: { key: string; available: boolean; expiresAt: number } | undefined;
let ripgrepProbeInFlight: { key: string; promise: Promise<boolean> } | undefined;

export function resetSearchBackendProbeForTests(): void {
  ripgrepProbeCache = undefined;
  ripgrepProbeInFlight = undefined;
}

export function classifySearchFailure(error: unknown): SearchFailureCode {
  if (error instanceof SearchOperationError) return error.failureCode;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (code === "ENOENT" || message.includes("not found") || message.includes("no such file")) return "search_path_not_found";
  if (code === "EACCES" || code === "EPERM" || message.includes("permission denied")) return "search_permission_denied";
  if (message.includes("cancel")) return "search_cancelled";
  if (message.includes("timeout") || message.includes("timed out")) return "search_timeout";
  return "search_process_failed";
}

function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

function normalizeSearchRoot(root?: string): string {
  return String(root ?? ".").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "") || ".";
}

function explicitlyTargetsRuntimeArtifacts(root?: string): boolean {
  const normalized = normalizeSearchRoot(root);
  return SEARCH_RUNTIME_BASES.some((base) => normalized === base || normalized.startsWith(`${base}/`));
}

function runtimeExcludeGlobs(root?: string): string[] {
  if (explicitlyTargetsRuntimeArtifacts(root)) return [];
  return SEARCH_RUNTIME_BASES.flatMap((base) => [base, `${base}/**`]);
}

function boundedTimeout(timeoutMs?: number): number {
  return Math.max(1, Math.min(timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, MAX_SEARCH_TIMEOUT_MS));
}

async function ripgrepAvailable(workspace: Workspace): Promise<{ available: boolean; probeCount: number }> {
  const key = `${process.platform}\0${process.env.PATH ?? ""}`;
  const now = Date.now();
  if (ripgrepProbeCache?.key === key && ripgrepProbeCache.expiresAt > now) {
    return { available: ripgrepProbeCache.available, probeCount: 0 };
  }
  if (ripgrepProbeInFlight?.key === key) {
    return { available: await ripgrepProbeInFlight.promise, probeCount: 0 };
  }
  const promise = runProcess("rg", ["--version"], {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: 2_000,
    maxOutputBytes: 8_000,
    domain: "probe",
    operation: "ripgrep_probe",
    sideEffectLevel: "none",
    riskLevel: "low",
    recordRoot: workspace.root,
    usageTracking: false
  }).then((result) => result.exitCode === 0 && !result.spawnError).catch(() => false);
  ripgrepProbeInFlight = { key, promise };
  const available = await promise;
  ripgrepProbeCache = { key, available, expiresAt: Date.now() + RIPGREP_PROBE_TTL_MS };
  if (ripgrepProbeInFlight?.promise === promise) ripgrepProbeInFlight = undefined;
  return { available, probeCount: 1 };
}

function emptyQueryResults(queries: string[]): SearchQueryResult[] {
  return queries.map((query) => ({ query, matches: [], truncated: false }));
}

function formatManyText(results: SearchQueryResult[], failureCode?: SearchFailureCode, error?: string): string {
  return results.map((result) => {
    const matches = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches.";
    const suffix = failureCode ? `\n[partial: ${failureCode}]${error ? ` ${error}` : ""}` : "";
    return `## ${result.query}\n${matches}${suffix}`;
  }).join("\n\n");
}

async function runRipgrepMany(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: Required<Pick<SearchManyOptions, "queries" | "includeHidden" | "maxResultsPerQuery">> & SearchManyOptions,
  probeCount: number
): Promise<SearchManyResult> {
  const started = Date.now();
  const target = guard.resolve(workspace, options.root ?? ".");
  try {
    await fsp.access(target.absPath);
  } catch (error) {
    throw new SearchOperationError(
      classifySearchFailure(error),
      `Search root is unavailable: ${target.relPath}. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const includeHidden = options.includeHidden || explicitlyTargetsRuntimeArtifacts(options.root);
  const args = [
    "--json",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color=never",
    "--max-columns",
    "500",
    "--max-count",
    String(Math.max(2, options.maxResultsPerQuery + 1)),
    "--max-filesize",
    String(config.maxReadBytes)
  ];
  if (!options.regex) args.push("--fixed-strings");
  if (includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  for (const glob of runtimeExcludeGlobs(options.root)) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  for (const query of options.queries) args.push("-e", query);
  args.push("--", target.absPath);

  const processResult = await runProcess("rg", args, {
    cwd: workspace.root,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs: boundedTimeout(options.timeoutMs),
    maxOutputBytes: config.maxOutputBytes,
    domain: "shell",
    operation: "ripgrep_multi_search",
    sideEffectLevel: "local_read",
    riskLevel: "low",
    signal: options.signal,
    recordRoot: workspace.root,
    // Search already reports bounded, structured diagnostics to its caller. Do
    // not let a contended execution-component projection lock delay this
    // local-read operation or postpone its hard timeout.
    componentTracking: false,
    usageTracking: false
  });

  const queryResults = emptyQueryResults(options.queries);
  const visibleCounts = options.queries.map(() => 0);
  const seenFiles = new Set<string>();
  let summaryFiles: number | null = null;
  let bytesScanned: number | null = null;

  for (const line of processResult.stdout.split("\n")) {
    if (!line.trim()) continue;
    let value: any;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type === "summary") {
      const searches = Number(value.data?.stats?.searches);
      const bytes = Number(value.data?.stats?.bytes_searched);
      if (Number.isFinite(searches)) summaryFiles = searches;
      if (Number.isFinite(bytes)) bytesScanned = bytes;
      continue;
    }
    if (value.type === "begin" || value.type === "match" || value.type === "end") {
      const rawPath = String(value.data?.path?.text ?? "");
      if (rawPath) seenFiles.add(path.resolve(rawPath));
    }
    if (value.type !== "match") continue;
    const absPath = path.resolve(value.data?.path?.text ?? "");
    const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
    if (rel.startsWith("..") || guard.isBlockedRelativePath(rel)) continue;
    const lineText = String(value.data?.lines?.text ?? "").replace(/\r?\n$/, "");
    for (let index = 0; index < options.queries.length; index += 1) {
      const query = options.queries[index];
      // rg already evaluated its own regex dialect. Regex mode is restricted to
      // one query, so every emitted match belongs to that query without a second
      // JavaScript RegExp pass (which would reject valid rg syntax such as (?i)).
      const hit = options.regex ? index === 0 : lineText.includes(query);
      if (!hit) continue;
      visibleCounts[index] += 1;
      if (queryResults[index].matches.length < options.maxResultsPerQuery) {
        queryResults[index].matches.push({
          path: rel || ".",
          line: Number(value.data?.line_number ?? 0),
          text: redactSensitiveText(truncateLine(lineText))
        });
      }
    }
  }

  let failureCode: SearchFailureCode | undefined;
  let error: string | undefined;
  if (processResult.cancelled) failureCode = "search_cancelled";
  else if (processResult.timedOut) failureCode = "search_timeout";
  else if ((processResult.exitCode !== null && processResult.exitCode > 1) || processResult.spawnError) {
    failureCode = "search_process_failed";
    error = redactSensitiveText(processResult.stderr.trim() || `ripgrep failed with exit code ${processResult.exitCode ?? "unknown"}`);
  } else if (processResult.truncated) {
    failureCode = "search_result_truncated";
  }

  for (let index = 0; index < queryResults.length; index += 1) {
    queryResults[index].truncated = visibleCounts[index] > queryResults[index].matches.length || Boolean(processResult.truncated);
  }
  const truncated = queryResults.some((result) => result.truncated);
  if (!failureCode && truncated) failureCode = "search_result_truncated";
  return {
    text: formatManyText(queryResults, failureCode, error),
    queries: queryResults,
    truncated,
    used: "ripgrep",
    status: failureCode ? "partial" : "ok",
    failureCode,
    error,
    diagnostics: {
      durationMs: Date.now() - started,
      searchProcessCount: 1,
      backendProbeCount: probeCount,
      filesystemWalkCount: 0,
      filesScanned: summaryFiles ?? seenFiles.size,
      filesRead: 0,
      bytesScanned
    }
  };
}

async function runNodeMany(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: Required<Pick<SearchManyOptions, "queries" | "includeHidden" | "maxResultsPerQuery">> & SearchManyOptions,
  probeCount: number,
  degradedReason?: SearchFailureCode
): Promise<SearchManyResult> {
  const started = Date.now();
  const hardTimeoutMs = boundedTimeout(options.timeoutMs);
  const hardDeadline = started + hardTimeoutMs;
  const softTimeoutMs = Math.min(NODE_SOFT_TIMEOUT_MS, Math.max(1, hardTimeoutMs - 100));
  const softDeadline = started + softTimeoutMs;
  const walkDeadline = Math.min(softDeadline, started + Math.min(NODE_WALK_TIMEOUT_MS, Math.max(1, Math.floor(softTimeoutMs / 3))));
  let timedOut = false;
  let softLimited = false;
  let stoppedAfterLimits = false;

  const hardStopped = (): boolean => {
    if (options.signal?.aborted) return true;
    if (Date.now() < hardDeadline) return false;
    timedOut = true;
    return true;
  };
  const walkStopped = (): boolean => {
    if (hardStopped()) return true;
    if (Date.now() < walkDeadline) return false;
    softLimited = true;
    return true;
  };
  const scanStopped = (): boolean => {
    if (hardStopped() || stoppedAfterLimits) return true;
    if (Date.now() < softDeadline) return false;
    softLimited = true;
    return true;
  };

  const includeHidden = options.includeHidden || explicitlyTargetsRuntimeArtifacts(options.root);
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden,
    maxFiles: MAX_NODE_FILES,
    excludeGlobs: runtimeExcludeGlobs(options.root),
    shouldStop: walkStopped
  });
  const queryResults = emptyQueryResults(options.queries);
  const visibleCounts = options.queries.map(() => 0);
  const matchers = options.regex
    ? options.queries.map((query) => {
        try {
          return new RegExp(query);
        } catch (error) {
          throw new SearchOperationError("search_process_failed", `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    : [];
  let filesRead = 0;
  let bytesScanned = 0;
  let nextFileIndex = 0;

  const scanFile = async (rel: string): Promise<void> => {
    const resolved = guard.resolve(workspace, rel);
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (stat.size > config.maxReadBytes || scanStopped()) return;
      const buffer = await fsp.readFile(resolved.absPath);
      filesRead += 1;
      bytesScanned += buffer.length;
      if (buffer.includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && !scanStopped(); lineIndex += 1) {
        const line = lines[lineIndex];
        for (let queryIndex = 0; queryIndex < options.queries.length; queryIndex += 1) {
          const hit = options.regex ? matchers[queryIndex].test(line) : line.includes(options.queries[queryIndex]);
          if (!hit) continue;
          visibleCounts[queryIndex] += 1;
          if (queryResults[queryIndex].matches.length < options.maxResultsPerQuery) {
            queryResults[queryIndex].matches.push({
              path: rel,
              line: lineIndex + 1,
              text: redactSensitiveText(truncateLine(line))
            });
          }
        }
        if (visibleCounts.every((count) => count > options.maxResultsPerQuery)) {
          stoppedAfterLimits = true;
        }
      }
    } catch {
      // Unreadable files are skipped; path and process-level failures are handled outside this loop.
    }
  };

  const worker = async (): Promise<void> => {
    while (!scanStopped()) {
      const index = nextFileIndex;
      nextFileIndex += 1;
      if (index >= files.length) return;
      await scanFile(files[index]);
    }
  };
  const workerCount = Math.min(NODE_READ_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const cancelled = Boolean(options.signal?.aborted);
  const fileLimitReached = files.length >= MAX_NODE_FILES;
  for (let index = 0; index < queryResults.length; index += 1) {
    queryResults[index].truncated = visibleCounts[index] > queryResults[index].matches.length
      || stoppedAfterLimits
      || fileLimitReached
      || softLimited;
  }
  const truncated = queryResults.some((result) => result.truncated);
  const failureCode: SearchFailureCode | undefined = cancelled
    ? "search_cancelled"
    : timedOut
      ? "search_timeout"
      : truncated
        ? "search_result_truncated"
        : undefined;
  return {
    text: formatManyText(queryResults, failureCode),
    queries: queryResults,
    truncated,
    used: "node",
    status: failureCode ? "partial" : "ok",
    failureCode,
    degradedReason,
    diagnostics: {
      durationMs: Date.now() - started,
      searchProcessCount: 0,
      backendProbeCount: probeCount,
      filesystemWalkCount: 1,
      filesScanned: files.length,
      filesRead,
      bytesScanned
    }
  };
}

export async function searchWorkspaceMany(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: SearchManyOptions
): Promise<SearchManyResult> {
  const started = Date.now();
  const queries = (rawOptions.queries ?? []).map((query) => String(query).trim()).filter(Boolean);
  if (!queries.length) throw new SearchOperationError("search_query_limit_exceeded", "queries must contain at least one query.");
  if (queries.length > MAX_MULTI_QUERIES) {
    throw new SearchOperationError("search_query_limit_exceeded", `Search accepts at most ${MAX_MULTI_QUERIES} queries.`);
  }
  if (rawOptions.regex && queries.length > 1) {
    throw new SearchOperationError("search_query_limit_exceeded", "Regular expression search accepts one query at a time.");
  }
  const options = {
    ...rawOptions,
    queries,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResultsPerQuery: clampToolLimit(
      rawOptions.maxResultsPerQuery,
      Math.min(config.maxSearchResults, TOOL_LIMITS.search_project.max_results_per_query),
      Math.min(config.maxSearchResults, TOOL_LIMITS.search_project.max_results_per_query)
    )
  };

  if (options.forceBackend === "node") {
    const result = await runNodeMany(config, guard, workspace, options, 0);
    result.diagnostics.durationMs = Date.now() - started;
    return result;
  }
  const probe = options.forceBackend === "ripgrep"
    ? { available: true, probeCount: 0 }
    : await ripgrepAvailable(workspace);
  const result = probe.available
    ? await runRipgrepMany(config, guard, workspace, options, probe.probeCount)
    : await runNodeMany(config, guard, workspace, options, probe.probeCount, "ripgrep_missing");
  result.diagnostics.durationMs = Date.now() - started;
  return result;
}

export async function searchWorkspace(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  rawOptions: Partial<SearchOptions>
): Promise<SearchResult> {
  const query = rawOptions.query?.toString() ?? "";
  if (!query) throw new CodexProError("query is required.");
  const result = await searchWorkspaceMany(config, guard, workspace, {
    queries: [query],
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResultsPerQuery: clampToolLimit(
      rawOptions.maxResults,
      Math.min(config.maxSearchResults, TOOL_LIMITS.search_project.max_results_per_query),
      Math.min(config.maxSearchResults, TOOL_LIMITS.search_project.max_results_per_query)
    ),
    timeoutMs: rawOptions.timeoutMs,
    signal: rawOptions.signal
  });
  const queryResult = result.queries[0];
  const text = queryResult.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n")
    || (result.error ? `[error] ${result.error}` : "No matches.");
  return {
    text,
    matches: queryResult.matches,
    truncated: queryResult.truncated,
    used: result.used,
    status: result.status,
    failureCode: result.failureCode,
    degradedReason: result.degradedReason,
    error: result.error,
    diagnostics: result.diagnostics
  };
}
