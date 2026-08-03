import { createHash } from "node:crypto";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { workspaceRuntimeStateRoot } from "../runtime/workspaceState.js";
import type { TokenMeasurement, UsageComponent, UsageEntryV1, UsageLedgerSummaryV1 } from "./usageTypes.js";

export const USAGE_LEDGER_ROOT = ".ai-bridge/usage";
export const USAGE_LEDGER_ENTRIES = `${USAGE_LEDGER_ROOT}/entries.jsonl`;
export const USAGE_LEDGER_INDEX = `${USAGE_LEDGER_ROOT}/index.json`;
export const USAGE_LEDGER_WARNINGS = `${USAGE_LEDGER_ROOT}/warnings.jsonl`;
export const USAGE_LEDGER_AGGREGATE = `${USAGE_LEDGER_ROOT}/aggregates/latest.json`;

interface UsageLedgerIndexV1 {
  version: 1;
  entries: Record<string, { usage_id: string; evidence_hash: string; written_at: string }>;
  ledger_bytes: number;
  updated_at: string;
}

export interface UsageLedgerAppendInput {
  source_event_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  execution_id?: string | null;
  agent_id?: string | null;
  step_id?: string | null;
  component: UsageComponent;
  provider?: string | null;
  model?: string | null;
  tool?: string | null;
  started_at: string;
  finished_at: string;
  wall_duration_ms?: number;
  queue_duration_ms?: number | null;
  active_duration_ms?: number | null;
  silent_duration_ms?: number | null;
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_output_tokens?: number | null;
  token_measurement?: TokenMeasurement;
  input_bytes?: number | null;
  output_bytes?: number | null;
  process_count?: number;
  retry_count?: number;
  cache_hit?: boolean | null;
  outcome: string;
  verified_completion?: boolean;
  skill_id?: string | null;
  refresh_count?: number | null;
  rebind_count?: number | null;
  reconnect_count?: number | null;
  recovery_count?: number | null;
  human_wait_ms?: number | null;
  review_duration_ms?: number | null;
  evidence?: unknown;
  dedupe_key?: string;
}

export interface UsageLedgerAppendResult {
  appended: boolean;
  duplicate: boolean;
  filtered?: boolean;
  entry: UsageEntryV1;
  entries_path: string;
  index_path: string;
}

function nonNegative(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function nullableNonNegative(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function validTimestamp(value: string, fallback: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : fallback;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function sha256(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(canonical(value));
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : null;
}

function tokenValue(value: unknown, measurement: TokenMeasurement): number | null {
  return measurement === "unavailable" ? null : nullableNonNegative(value);
}

function defaultIndex(): UsageLedgerIndexV1 {
  return { version: 1, entries: {}, ledger_bytes: 0, updated_at: new Date(0).toISOString() };
}

async function readIndex(target: string): Promise<UsageLedgerIndexV1> {
  try {
    const parsed = JSON.parse(await fsp.readFile(target, "utf8")) as Partial<UsageLedgerIndexV1>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return {
        version: 1,
        entries: { ...parsed.entries },
        ledger_bytes: nonNegative(parsed.ledger_bytes),
        updated_at: safeString(parsed.updated_at) ?? new Date(0).toISOString()
      };
    }
  } catch {
    // A missing or partial index is rebuilt from the append-only ledger when needed.
  }
  return defaultIndex();
}

function readIndexSync(target: string): UsageLedgerIndexV1 {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<UsageLedgerIndexV1>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return {
        version: 1,
        entries: { ...parsed.entries },
        ledger_bytes: nonNegative(parsed.ledger_bytes),
        updated_at: safeString(parsed.updated_at) ?? new Date(0).toISOString()
      };
    }
  } catch {
    // A missing or partial index is rebuilt from the append-only ledger when needed.
  }
  return defaultIndex();
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, target);
}

function writeJsonAtomicSync(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLedgerLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, USAGE_LEDGER_ROOT, ".lock");
  await fsp.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  while (!handle) {
    try {
      handle = await fsp.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) await fsp.rm(lockPath, { force: true });
      } catch {
        // The competing writer may have released the lock between checks.
      }
      if (Date.now() >= deadline) throw new Error(`Usage ledger lock timed out for ${root}.`);
      await delay(25);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fsp.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function withLedgerLockSync<T>(root: string, operation: () => T): T {
  const lockPath = path.join(root, USAGE_LEDGER_ROOT, ".lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  let descriptor: number | undefined;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) fs.rmSync(lockPath, { force: true });
      } catch {
        // The competing writer may have released the lock between checks.
      }
      if (Date.now() >= deadline) throw new Error(`Usage ledger lock timed out for ${root}.`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

const USAGE_PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "composer.json",
  "go.mod",
  "Cargo.toml",
  "Gemfile"
] as const;

function looksLikeUsageProjectRoot(root: string): boolean {
  return fs.existsSync(path.join(root, ".codexpro", "project.yml"))
    || fs.existsSync(path.join(root, ".git"))
    || USAGE_PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(root, marker)));
}

function resolveUsageProjectRoot(start: string): string {
  const requested = path.resolve(start || process.cwd());
  let current = requested;
  const filesystemRoot = path.parse(current).root;
  while (true) {
    if (looksLikeUsageProjectRoot(current)) return current;
    if (current === filesystemRoot) return requested;
    current = path.dirname(current);
  }
}

export function resolveUsageWorkspaceRoot(start: string): string {
  return workspaceRuntimeStateRoot(resolveUsageProjectRoot(start));
}

function usageInputFiltered(input: UsageLedgerAppendInput): boolean {
  return input.component === "process" && input.provider?.trim().toLowerCase() === "probe";
}

function normalizeEntry(input: UsageLedgerAppendInput): UsageEntryV1 {
  const writtenAt = new Date().toISOString();
  const startedAt = validTimestamp(input.started_at, writtenAt);
  const finishedAt = validTimestamp(input.finished_at, writtenAt);
  const measurement = input.token_measurement ?? (
    [input.input_tokens, input.cached_input_tokens, input.output_tokens, input.reasoning_output_tokens]
      .some((value) => value !== null && value !== undefined)
      ? "measured"
      : "unavailable"
  );
  const wallDuration = input.wall_duration_ms === undefined
    ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
    : nonNegative(input.wall_duration_ms);
  const dedupeKey = input.dedupe_key?.trim() || sha256([
    input.source_event_id ?? null,
    input.task_id ?? null,
    input.run_id ?? null,
    input.execution_id ?? null,
    input.component,
    finishedAt
  ]).slice("sha256:".length);
  const evidenceHash = sha256(input.evidence ?? {
    source_event_id: input.source_event_id ?? null,
    task_id: input.task_id ?? null,
    run_id: input.run_id ?? null,
    execution_id: input.execution_id ?? null,
    component: input.component,
    finished_at: finishedAt,
    outcome: input.outcome
  });
  return {
    version: 1,
    usage_id: `usage-${createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32)}`,
    dedupe_key: dedupeKey,
    source_event_id: safeString(input.source_event_id),
    task_id: safeString(input.task_id),
    run_id: safeString(input.run_id),
    execution_id: safeString(input.execution_id),
    agent_id: safeString(input.agent_id),
    step_id: safeString(input.step_id),
    component: input.component,
    provider: safeString(input.provider),
    model: safeString(input.model),
    tool: safeString(input.tool),
    started_at: startedAt,
    finished_at: finishedAt,
    wall_duration_ms: wallDuration,
    queue_duration_ms: nullableNonNegative(input.queue_duration_ms),
    active_duration_ms: nullableNonNegative(input.active_duration_ms),
    silent_duration_ms: nullableNonNegative(input.silent_duration_ms),
    input_tokens: tokenValue(input.input_tokens, measurement),
    cached_input_tokens: tokenValue(input.cached_input_tokens, measurement),
    output_tokens: tokenValue(input.output_tokens, measurement),
    reasoning_output_tokens: tokenValue(input.reasoning_output_tokens, measurement),
    token_measurement: measurement,
    input_bytes: nullableNonNegative(input.input_bytes),
    output_bytes: nullableNonNegative(input.output_bytes),
    process_count: nonNegative(input.process_count),
    retry_count: nonNegative(input.retry_count),
    cache_hit: typeof input.cache_hit === "boolean" ? input.cache_hit : null,
    outcome: safeString(input.outcome) ?? "unknown",
    verified_completion: input.verified_completion === true,
    skill_id: safeString(input.skill_id),
    refresh_count: nullableNonNegative(input.refresh_count),
    rebind_count: nullableNonNegative(input.rebind_count),
    reconnect_count: nullableNonNegative(input.reconnect_count),
    recovery_count: nullableNonNegative(input.recovery_count),
    human_wait_ms: nullableNonNegative(input.human_wait_ms),
    review_duration_ms: nullableNonNegative(input.review_duration_ms),
    evidence_hash: evidenceHash,
    written_at: writtenAt
  };
}

async function readJsonLines<T>(target: string, limit = 100_000): Promise<T[]> {
  try {
    const content = await fsp.readFile(target, "utf8");
    const lines = content.split(/\r?\n/g).filter(Boolean).slice(-Math.max(1, limit));
    const out: T[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // One partial line must not hide the remaining append-only evidence.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readJsonLinesSync<T>(target: string, limit = 100_000): T[] {
  try {
    const content = fs.readFileSync(target, "utf8");
    const lines = content.split(/\r?\n/g).filter(Boolean).slice(-Math.max(1, limit));
    const out: T[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // One partial line must not hide the remaining append-only evidence.
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function rebuildIndex(entriesPath: string): Promise<UsageLedgerIndexV1> {
  const entries = await readJsonLines<UsageEntryV1>(entriesPath);
  const index = defaultIndex();
  for (const entry of entries) {
    if (!entry?.dedupe_key || !entry.usage_id || !entry.evidence_hash) continue;
    index.entries[entry.dedupe_key] = {
      usage_id: entry.usage_id,
      evidence_hash: entry.evidence_hash,
      written_at: entry.written_at
    };
  }
  index.ledger_bytes = await fsp.stat(entriesPath).then((stat) => stat.size).catch(() => 0);
  index.updated_at = new Date().toISOString();
  return index;
}

function rebuildIndexSync(entriesPath: string): UsageLedgerIndexV1 {
  const entries = readJsonLinesSync<UsageEntryV1>(entriesPath);
  const index = defaultIndex();
  for (const entry of entries) {
    if (!entry?.dedupe_key || !entry.usage_id || !entry.evidence_hash) continue;
    index.entries[entry.dedupe_key] = {
      usage_id: entry.usage_id,
      evidence_hash: entry.evidence_hash,
      written_at: entry.written_at
    };
  }
  try {
    index.ledger_bytes = fs.statSync(entriesPath).size;
  } catch {
    index.ledger_bytes = 0;
  }
  index.updated_at = new Date().toISOString();
  return index;
}

function nullableSum(entries: UsageEntryV1[], field: keyof UsageEntryV1): number | null {
  const values = entries
    .map((entry) => entry[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + Math.max(0, value), 0) : null;
}

function browserOutcome(outcome: string): "success" | "failed" | "unknown" {
  const normalized = outcome.toLowerCase();
  if (["completed", "succeeded", "passed", "verified"].includes(normalized)) return "success";
  if (["failed", "blocked", "cancelled", "timed_out", "error"].includes(normalized)) return "failed";
  return "unknown";
}

export function summarizeUsageEntries(entries: UsageEntryV1[], warningCount = 0): UsageLedgerSummaryV1 {
  const tokenMeasurement = { measured: 0, estimated: 0, unavailable: 0 };
  const tokens = { input: 0, cached_input: 0, output: 0, reasoning_output: 0 };
  let hasTokenValue = false;
  const cache = { hit: 0, miss: 0, unavailable: 0 };
  const browser = { success: 0, failed: 0, unknown: 0, refresh_count: 0, rebind_count: 0, reconnect_count: 0, recovery_count: 0 };
  const completionUnits = new Set<string>();
  const verifiedUnits = new Set<string>();
  const wallByUnit = new Map<string, number>();
  const goalEntries = entries.filter((entry) => entry.component === "agent");
  const durationEntries = goalEntries.length ? goalEntries : entries;
  for (const entry of entries) {
    const unit = entry.task_id ?? entry.run_id ?? entry.usage_id;
    wallByUnit.set(unit, Math.max(wallByUnit.get(unit) ?? 0, nonNegative(entry.wall_duration_ms)));
    if (entry.component === "model") {
      tokenMeasurement[entry.token_measurement] += 1;
      for (const [field, target] of [
        ["input_tokens", "input"],
        ["cached_input_tokens", "cached_input"],
        ["output_tokens", "output"],
        ["reasoning_output_tokens", "reasoning_output"]
      ] as const) {
        const value = entry[field];
        if (typeof value === "number" && Number.isFinite(value)) {
          tokens[target] += Math.max(0, value);
          hasTokenValue = true;
        }
      }
    }
    if (["acceptance", "model", "tool"].includes(entry.component)) {
      if (entry.cache_hit === true) cache.hit += 1;
      else if (entry.cache_hit === false) cache.miss += 1;
      else cache.unavailable += 1;
    }
    if (entry.component === "browser") {
      browser[browserOutcome(entry.outcome)] += 1;
      browser.refresh_count += entry.refresh_count ?? 0;
      browser.rebind_count += entry.rebind_count ?? 0;
      browser.reconnect_count += entry.reconnect_count ?? 0;
      browser.recovery_count += entry.recovery_count ?? 0;
    }
    if (entry.component === "agent" || entry.component === "browser") {
      completionUnits.add(unit);
      if (entry.verified_completion) verifiedUnits.add(unit);
    }
  }
  return {
    version: 1,
    availability: entries.length ? "available" : "unavailable",
    entry_count: entries.length,
    total_wall_duration_ms: [...wallByUnit.values()].reduce((sum, value) => sum + value, 0),
    queue_duration_ms: nullableSum(durationEntries, "queue_duration_ms"),
    active_duration_ms: nullableSum(durationEntries, "active_duration_ms"),
    silent_duration_ms: nullableSum(durationEntries, "silent_duration_ms"),
    acceptance_duration_ms: entries.filter((entry) => entry.component === "acceptance").reduce((sum, entry) => sum + nonNegative(entry.wall_duration_ms), 0),
    human_wait_ms: nullableSum(entries, "human_wait_ms"),
    review_duration_ms: nullableSum(entries, "review_duration_ms"),
    token_measurement: tokenMeasurement,
    tokens: hasTokenValue ? tokens : null,
    process_count: entries.reduce((sum, entry) => sum + nonNegative(entry.process_count), 0),
    retry_count: entries.reduce((sum, entry) => sum + nonNegative(entry.retry_count), 0),
    verified_completion_count: verifiedUnits.size,
    verified_completion_efficiency: completionUnits.size ? verifiedUnits.size / completionUnits.size : null,
    cache,
    browser,
    warning_count: Math.max(0, warningCount),
    generated_at: new Date().toISOString()
  };
}

export async function readUsageEntries(workspaceRoot: string, options: { task_id?: string; run_id?: string; limit?: number } = {}): Promise<UsageEntryV1[]> {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const entries = await readJsonLines<UsageEntryV1>(path.join(root, USAGE_LEDGER_ENTRIES), options.limit ?? 100_000);
  return entries.filter((entry) =>
    entry?.version === 1
    && (!options.task_id || entry.task_id === options.task_id)
    && (!options.run_id || entry.run_id === options.run_id)
  );
}

export async function readUsageSummary(workspaceRoot: string, options: { task_id?: string; run_id?: string } = {}): Promise<UsageLedgerSummaryV1> {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const [allEntries, warnings] = await Promise.all([
    readJsonLines<UsageEntryV1>(path.join(root, USAGE_LEDGER_ENTRIES)),
    readJsonLines<Record<string, unknown>>(path.join(root, USAGE_LEDGER_WARNINGS))
  ]);
  const entries = allEntries.filter((entry) =>
    entry?.version === 1
    && (!options.task_id || entry.task_id === options.task_id)
    && (!options.run_id || entry.run_id === options.run_id)
  );
  return summarizeUsageEntries(entries, warnings.length);
}

async function writeAggregate(root: string): Promise<void> {
  const entries = await readJsonLines<UsageEntryV1>(path.join(root, USAGE_LEDGER_ENTRIES));
  const warnings = await readJsonLines<Record<string, unknown>>(path.join(root, USAGE_LEDGER_WARNINGS));
  await writeJsonAtomic(path.join(root, USAGE_LEDGER_AGGREGATE), summarizeUsageEntries(entries, warnings.length));
}

function writeAggregateSync(root: string): void {
  const entries = readJsonLinesSync<UsageEntryV1>(path.join(root, USAGE_LEDGER_ENTRIES));
  const warnings = readJsonLinesSync<Record<string, unknown>>(path.join(root, USAGE_LEDGER_WARNINGS));
  writeJsonAtomicSync(path.join(root, USAGE_LEDGER_AGGREGATE), summarizeUsageEntries(entries, warnings.length));
}

export async function appendUsageEntry(workspaceRoot: string, input: UsageLedgerAppendInput): Promise<UsageLedgerAppendResult> {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const entry = normalizeEntry(input);
  const entriesPath = path.join(root, USAGE_LEDGER_ENTRIES);
  const indexPath = path.join(root, USAGE_LEDGER_INDEX);
  if (usageInputFiltered(input)) {
    return {
      appended: false,
      duplicate: false,
      filtered: true,
      entry,
      entries_path: USAGE_LEDGER_ENTRIES,
      index_path: USAGE_LEDGER_INDEX
    };
  }
  return await withLedgerLock(root, async () => {
    await fsp.mkdir(path.dirname(entriesPath), { recursive: true, mode: 0o700 });
    let index = await readIndex(indexPath);
    const currentLedgerBytes = await fsp.stat(entriesPath).then((stat) => stat.size).catch(() => 0);
    if (currentLedgerBytes !== index.ledger_bytes) index = await rebuildIndex(entriesPath);
    const existing = index.entries[entry.dedupe_key];
    if (existing) {
      return {
        appended: false,
        duplicate: true,
        entry: { ...entry, usage_id: existing.usage_id, evidence_hash: existing.evidence_hash },
        entries_path: USAGE_LEDGER_ENTRIES,
        index_path: USAGE_LEDGER_INDEX
      };
    }
    await fsp.appendFile(entriesPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    const dailyPath = path.join(root, USAGE_LEDGER_ROOT, "daily", `${entry.finished_at.slice(0, 10)}.jsonl`);
    await fsp.mkdir(path.dirname(dailyPath), { recursive: true, mode: 0o700 });
    await fsp.appendFile(dailyPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    index.entries[entry.dedupe_key] = { usage_id: entry.usage_id, evidence_hash: entry.evidence_hash, written_at: entry.written_at };
    index.ledger_bytes = await fsp.stat(entriesPath).then((stat) => stat.size).catch(() => 0);
    index.updated_at = new Date().toISOString();
    await writeJsonAtomic(indexPath, index);
    await writeAggregate(root);
    return { appended: true, duplicate: false, entry, entries_path: USAGE_LEDGER_ENTRIES, index_path: USAGE_LEDGER_INDEX };
  });
}

export function appendUsageEntrySync(workspaceRoot: string, input: UsageLedgerAppendInput): UsageLedgerAppendResult {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const entry = normalizeEntry(input);
  const entriesPath = path.join(root, USAGE_LEDGER_ENTRIES);
  const indexPath = path.join(root, USAGE_LEDGER_INDEX);
  if (usageInputFiltered(input)) {
    return {
      appended: false,
      duplicate: false,
      filtered: true,
      entry,
      entries_path: USAGE_LEDGER_ENTRIES,
      index_path: USAGE_LEDGER_INDEX
    };
  }
  return withLedgerLockSync(root, () => {
    fs.mkdirSync(path.dirname(entriesPath), { recursive: true, mode: 0o700 });
    let index = readIndexSync(indexPath);
    let currentLedgerBytes = 0;
    try {
      currentLedgerBytes = fs.statSync(entriesPath).size;
    } catch {
      currentLedgerBytes = 0;
    }
    if (currentLedgerBytes !== index.ledger_bytes) index = rebuildIndexSync(entriesPath);
    const existing = index.entries[entry.dedupe_key];
    if (existing) {
      return {
        appended: false,
        duplicate: true,
        entry: { ...entry, usage_id: existing.usage_id, evidence_hash: existing.evidence_hash },
        entries_path: USAGE_LEDGER_ENTRIES,
        index_path: USAGE_LEDGER_INDEX
      };
    }
    fs.appendFileSync(entriesPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    const dailyPath = path.join(root, USAGE_LEDGER_ROOT, "daily", `${entry.finished_at.slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(dailyPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(dailyPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    index.entries[entry.dedupe_key] = { usage_id: entry.usage_id, evidence_hash: entry.evidence_hash, written_at: entry.written_at };
    index.ledger_bytes = fs.statSync(entriesPath).size;
    index.updated_at = new Date().toISOString();
    writeJsonAtomicSync(indexPath, index);
    writeAggregateSync(root);
    return { appended: true, duplicate: false, entry, entries_path: USAGE_LEDGER_ENTRIES, index_path: USAGE_LEDGER_INDEX };
  });
}

export async function recordUsageLedgerWarning(workspaceRoot: string, source: string, error: unknown, evidence?: unknown): Promise<void> {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const warning = {
    version: 1,
    warning_id: sha256([source, error instanceof Error ? error.message : String(error), Date.now()]),
    source: source.slice(0, 200),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    evidence_hash: sha256(evidence ?? null),
    created_at: new Date().toISOString()
  };
  try {
    const target = path.join(root, USAGE_LEDGER_WARNINGS);
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.appendFile(target, `${JSON.stringify(warning)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Usage observability remains best-effort and must never change task outcome.
  }
}

export function recordUsageLedgerWarningSync(workspaceRoot: string, source: string, error: unknown, evidence?: unknown): void {
  const root = resolveUsageWorkspaceRoot(workspaceRoot);
  const warning = {
    version: 1,
    warning_id: sha256([source, error instanceof Error ? error.message : String(error), Date.now()]),
    source: source.slice(0, 200),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
    evidence_hash: sha256(evidence ?? null),
    created_at: new Date().toISOString()
  };
  try {
    const target = path.join(root, USAGE_LEDGER_WARNINGS);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, `${JSON.stringify(warning)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Usage observability remains best-effort and must never change task outcome.
  }
}
