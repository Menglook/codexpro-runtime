import fsp from "node:fs/promises";
import YAML from "yaml";
import type { CodexProConfig } from "../config.js";
import { sha256, writeTextFile } from "../fsOps.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { findSecretValues, redactSensitiveText } from "../redact.js";

export const MEMORY_GOVERNANCE_FILE = ".codexpro/memory/governance.yml";
export const MEMORY_GOVERNANCE_REPORT_FILE = ".codexpro/reports/memory-governance.md";

export type GovernedMemoryStatus = "active" | "deprecated" | "conflicted";

export interface GovernedMemoryRecord {
  id: string;
  statement: string;
  scope: string[];
  source: string;
  accepted_at: string;
  confidence: number;
  supersedes: string[];
  expires_at: string | null;
  status: GovernedMemoryStatus;
  conflicts_with: string[];
  tags: string[];
}

export interface MemoryGovernanceDocument {
  version: 1;
  entries: GovernedMemoryRecord[];
}

export interface EffectiveGovernedMemoryRecord extends GovernedMemoryRecord {
  effective_status: GovernedMemoryStatus | "expired";
  relevance: number;
  inactive_reason?: string;
}

export interface MemoryGovernanceQueryOptions {
  scope?: string;
  query?: string;
  now?: string;
  max_entries?: number;
  include_inactive?: boolean;
}

export interface MemoryGovernanceQueryResult {
  path: string;
  existed: boolean;
  entries: EffectiveGovernedMemoryRecord[];
  active_entries: EffectiveGovernedMemoryRecord[];
  expired_ids: string[];
  conflicted_ids: string[];
  deprecated_ids: string[];
  superseded_ids: string[];
}

export interface AppendGovernedMemoryResult {
  path: string;
  bytes: number;
  sha256: string;
  record: GovernedMemoryRecord;
  deprecated_ids: string[];
  text: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,119}$/i.test(id)) {
    throw new CodexProError("Memory record id must use 2-120 letters, numbers, dot, underscore, or dash characters.");
  }
  return id;
}

function normalizeDate(value: unknown, field: string, nullable = false): string | null {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const text = String(value ?? "").trim();
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed)) throw new CodexProError(`${field} must be an ISO date or timestamp${nullable ? ", or null" : ""}.`);
  return new Date(parsed).toISOString();
}

function normalizeStatus(value: unknown): GovernedMemoryStatus {
  const status = String(value ?? "active").trim().toLowerCase();
  if (status !== "active" && status !== "deprecated" && status !== "conflicted") {
    throw new CodexProError("Memory record status must be active, deprecated, or conflicted.");
  }
  return status;
}

export function normalizeGovernedMemoryRecord(value: unknown): GovernedMemoryRecord {
  const object = asObject(value);
  if (!object) throw new CodexProError("Governed memory content must be a YAML/JSON object.");
  const rawStatement = String(object.statement ?? "").trim();
  if (!rawStatement) throw new CodexProError("Memory record statement is required.");
  if (findSecretValues(rawStatement, { path: MEMORY_GOVERNANCE_FILE }).length) {
    throw new CodexProError("Memory record statement contains a secret-like value and cannot be stored.");
  }
  const statement = redactSensitiveText(rawStatement);
  const confidenceRaw = Number(object.confidence ?? 1);
  if (!Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
    throw new CodexProError("Memory record confidence must be between 0 and 1.");
  }
  const scope = stringArray(object.scope);
  if (!scope.length) scope.push("global");
  return {
    id: normalizeId(object.id),
    statement,
    scope,
    source: String(object.source ?? "user_explicit").trim() || "user_explicit",
    accepted_at: normalizeDate(object.accepted_at ?? new Date().toISOString(), "accepted_at") as string,
    confidence: Number(confidenceRaw.toFixed(3)),
    supersedes: stringArray(object.supersedes),
    expires_at: normalizeDate(object.expires_at, "expires_at", true),
    status: normalizeStatus(object.status),
    conflicts_with: stringArray(object.conflicts_with),
    tags: stringArray(object.tags)
  };
}

export function parseGovernedMemoryRecord(content: string): GovernedMemoryRecord {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new CodexProError(`Invalid governed memory YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = asObject(parsed);
  return normalizeGovernedMemoryRecord(object?.entry ?? parsed);
}

function emptyDocument(): MemoryGovernanceDocument {
  return { version: 1, entries: [] };
}

function normalizeDocument(value: unknown): MemoryGovernanceDocument {
  const object = asObject(value);
  const entries = Array.isArray(object?.entries) ? object.entries.map(normalizeGovernedMemoryRecord) : [];
  return { version: 1, entries };
}

export async function loadMemoryGovernance(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<{ existed: boolean; document: MemoryGovernanceDocument }> {
  const resolved = guard.resolve(workspace, MEMORY_GOVERNANCE_FILE);
  try {
    await guard.assertTextFile(resolved.absPath, Math.min(config.maxReadBytes, 240_000));
    const raw = await fsp.readFile(resolved.absPath, "utf8");
    return { existed: true, document: normalizeDocument(YAML.parse(raw) ?? {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || (error instanceof CodexProError && /does not exist|not a file/i.test(error.message))) {
      return { existed: false, document: emptyDocument() };
    }
    throw error;
  }
}

function terms(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2))];
}

function relevance(record: GovernedMemoryRecord, scope: string | undefined, query: string | undefined): number {
  const scopeScore = !scope
    ? 0.5
    : record.scope.includes("global")
      ? 0.7
      : record.scope.includes(scope)
        ? 1
        : record.scope.some((item) => scope.startsWith(`${item}.`) || item.startsWith(`${scope}.`))
          ? 0.82
          : 0;
  const queryTerms = terms(query ?? "");
  const recordTerms = new Set(terms([record.statement, ...record.tags, ...record.scope].join(" ")));
  const lexical = queryTerms.length ? queryTerms.filter((item) => recordTerms.has(item)).length / queryTerms.length : 0.5;
  return Number(Math.min(1, scopeScore * 0.62 + lexical * 0.28 + record.confidence * 0.1).toFixed(3));
}

export function evaluateMemoryGovernance(
  document: MemoryGovernanceDocument,
  options: MemoryGovernanceQueryOptions = {}
): MemoryGovernanceQueryResult {
  const now = Number.isFinite(Date.parse(options.now ?? "")) ? Date.parse(options.now as string) : Date.now();
  const activeSuperseders = document.entries.filter((entry) => entry.status === "active" && (!entry.expires_at || Date.parse(entry.expires_at) > now));
  const superseded = new Set(activeSuperseders.flatMap((entry) => entry.supersedes));
  const explicitConflicts = new Set<string>();
  for (const entry of activeSuperseders) {
    for (const conflictId of entry.conflicts_with) {
      if (document.entries.some((candidate) => candidate.id === conflictId && candidate.status === "active")) {
        explicitConflicts.add(entry.id);
        explicitConflicts.add(conflictId);
      }
    }
  }
  const evaluated = document.entries.map((entry): EffectiveGovernedMemoryRecord => {
    const score = relevance(entry, options.scope, options.query);
    if (entry.expires_at && Date.parse(entry.expires_at) <= now) {
      return { ...entry, effective_status: "expired", relevance: score, inactive_reason: `expired at ${entry.expires_at}` };
    }
    if (explicitConflicts.has(entry.id) || entry.status === "conflicted") {
      return { ...entry, effective_status: "conflicted", relevance: score, inactive_reason: "requires human conflict resolution" };
    }
    if (superseded.has(entry.id)) {
      return { ...entry, effective_status: "deprecated", relevance: score, inactive_reason: "superseded by an active memory record" };
    }
    return { ...entry, effective_status: entry.status, relevance: score, ...(entry.status !== "active" ? { inactive_reason: `status is ${entry.status}` } : {}) };
  });
  const scoped = evaluated
    .filter((entry) => options.include_inactive === true || entry.effective_status === "active")
    .filter((entry) => !options.scope || entry.scope.includes("global") || entry.scope.some((item) => item === options.scope || options.scope!.startsWith(`${item}.`) || item.startsWith(`${options.scope}.`)))
    .filter((entry) => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || right.confidence - left.confidence || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(options.max_entries ?? 50, 200)));
  return {
    path: MEMORY_GOVERNANCE_FILE,
    existed: document.entries.length > 0,
    entries: scoped,
    active_entries: scoped.filter((entry) => entry.effective_status === "active"),
    expired_ids: evaluated.filter((entry) => entry.effective_status === "expired").map((entry) => entry.id),
    conflicted_ids: evaluated.filter((entry) => entry.effective_status === "conflicted").map((entry) => entry.id),
    deprecated_ids: evaluated.filter((entry) => entry.effective_status === "deprecated").map((entry) => entry.id),
    superseded_ids: [...superseded].sort((a, b) => a.localeCompare(b))
  };
}

export async function queryGovernedMemory(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: MemoryGovernanceQueryOptions = {}
): Promise<MemoryGovernanceQueryResult> {
  const loaded = await loadMemoryGovernance(config, guard, workspace);
  const result = evaluateMemoryGovernance(loaded.document, options);
  return { ...result, existed: loaded.existed };
}

export async function appendGovernedMemoryRecord(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: { record: GovernedMemoryRecord; approved: boolean }
): Promise<AppendGovernedMemoryResult> {
  if (input.approved !== true) throw new CodexProError("Governed memory writes require explicit user approval.");
  const record = normalizeGovernedMemoryRecord(input.record);
  const loaded = await loadMemoryGovernance(config, guard, workspace);
  const entries = loaded.document.entries.map((entry) => ({ ...entry, scope: [...entry.scope], supersedes: [...entry.supersedes], conflicts_with: [...entry.conflicts_with], tags: [...entry.tags] }));
  if (entries.some((entry) => entry.id === record.id)) throw new CodexProError(`Memory record id already exists: ${record.id}`);
  const knownIds = new Set(entries.map((entry) => entry.id));
  const missingSupersedes = record.supersedes.filter((id) => !knownIds.has(id));
  if (missingSupersedes.length) throw new CodexProError(`supersedes references unknown memory ids: ${missingSupersedes.join(", ")}`);
  const unresolvedConflicts = record.conflicts_with.filter((id) => knownIds.has(id) && !record.supersedes.includes(id));
  if (unresolvedConflicts.length) {
    throw new CodexProError(`Memory conflicts require a human decision before writing. Resolve or supersede: ${unresolvedConflicts.join(", ")}`);
  }
  const deprecatedIds: string[] = [];
  for (const entry of entries) {
    if (record.supersedes.includes(entry.id) && entry.status !== "deprecated") {
      entry.status = "deprecated";
      deprecatedIds.push(entry.id);
    }
  }
  entries.push(record);
  const document: MemoryGovernanceDocument = { version: 1, entries };
  const text = YAML.stringify(document, { lineWidth: 120 });
  if (findSecretValues(text, { path: MEMORY_GOVERNANCE_FILE }).length) {
    throw new CodexProError("Governed memory document contains a secret-like value and cannot be written.");
  }
  const result = await writeTextFile(config, guard, workspace, MEMORY_GOVERNANCE_FILE, text, { createDirs: true, overwrite: true });
  return {
    path: result.path,
    bytes: result.bytes,
    sha256: result.sha256 || sha256(text),
    record,
    deprecated_ids: deprecatedIds,
    text: [
      "# Governed Memory Append",
      "",
      `Record: ${record.id}`,
      `Status: ${record.status}`,
      `Scope: ${record.scope.join(", ")}`,
      `Deprecated by supersedes: ${deprecatedIds.join(", ") || "none"}`,
      "",
      "The record was written only after an explicit append_project_memory call."
    ].join("\n")
  };
}

export function formatMemoryGovernanceReport(result: MemoryGovernanceQueryResult): string {
  const attention = result.entries.filter((entry) => entry.effective_status !== "active");
  return [
    "# Memory Governance Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Path: ${result.path}`,
    `Exists: ${result.existed ? "yes" : "no"}`,
    `Active relevant entries: ${result.active_entries.length}`,
    `Expired: ${result.expired_ids.join(", ") || "none"}`,
    `Conflicted: ${result.conflicted_ids.join(", ") || "none"}`,
    `Deprecated: ${result.deprecated_ids.join(", ") || "none"}`,
    `Superseded: ${result.superseded_ids.join(", ") || "none"}`,
    "",
    "## Active relevant memory",
    result.active_entries.length
      ? result.active_entries.map((entry) => `- [${entry.id}] (${entry.scope.join(", ")}; relevance=${entry.relevance}) ${entry.statement}`).join("\n")
      : "- none",
    "",
    "## Candidates requiring attention",
    attention.length
      ? attention.map((entry) => `- [${entry.id}] ${entry.effective_status}: ${entry.inactive_reason ?? "review required"}`).join("\n")
      : "- none",
    "",
    "Automatic durable memory writes remain disabled. Conflicted entries require explicit human resolution."
  ].join("\n");
}

export async function writeMemoryGovernanceReport(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: MemoryGovernanceQueryOptions = {}
): Promise<{ path: string; text: string; bytes: number; sha256: string; result: MemoryGovernanceQueryResult }> {
  const result = await queryGovernedMemory(config, guard, workspace, {
    ...options,
    include_inactive: true,
    max_entries: options.max_entries ?? 200
  });
  const text = formatMemoryGovernanceReport(result);
  const written = await writeTextFile(
    config,
    guard,
    workspace,
    MEMORY_GOVERNANCE_REPORT_FILE,
    `${text.trimEnd()}\n`,
    { createDirs: true, overwrite: true }
  );
  return { path: written.path, text, bytes: written.bytes, sha256: written.sha256, result };
}
