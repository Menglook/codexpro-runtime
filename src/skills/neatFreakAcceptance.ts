import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { writeTextFile } from "../fsOps.js";
import { CodexProError, isSubpath, type PathGuard, type Workspace } from "../guard.js";
import { createNeatFreakCleanupProposal, type NeatFreakCleanupProposal } from "./neatFreakCleanup.js";
import { assertActiveSkillCurrent } from "./skillUsage.js";
import type { ActiveSkillRecord } from "./types.js";

export const NEAT_FREAK_FACT_STATUSES = [
  "verified-current",
  "changed-and-verified",
  "pending",
  "out-of-scope",
  "not-applicable"
] as const;

export type NeatFreakFactStatus = (typeof NEAT_FREAK_FACT_STATUSES)[number];
type FactArea = "code" | "docs" | "rules";
type StatusArea = "code" | "runtime" | "docs" | "rules" | "memory" | "workspace";

export interface NeatFreakFactCheck {
  area: FactArea;
  target_path: string;
  target_contains?: string;
  target_absent?: string;
  evidence_path: string;
  evidence_contains: string;
}

export interface NeatFreakRuleCheck {
  rule_file: "AGENTS.md" | "AGENTS.override.md" | "CLAUDE.md" | "CLAUDE.local.md";
  referenced_paths?: string[];
  commands?: string[];
}

export interface NeatFreakAcceptanceInput {
  run_id: string;
  active_skill: ActiveSkillRecord;
  fact_checks?: NeatFreakFactCheck[];
  rule_checks?: NeatFreakRuleCheck[];
  claimed_fact_status?: Partial<Record<StatusArea, NeatFreakFactStatus>>;
  memory: {
    action: "none" | "proposal_only";
    summary: string;
  };
  workspace: {
    cleanup_action: "proposal_only";
    candidate_paths?: string[];
  };
}

export interface NeatFreakAcceptanceResult {
  active_skill: Pick<ActiveSkillRecord, "name" | "source_repository" | "source_commit" | "entry_path" | "digest" | "loaded_at">;
  planned_files: string[];
  changed_files: string[];
  unexpected_files: string[];
  fact_status: Record<StatusArea, NeatFreakFactStatus>;
  fact_checks: Array<NeatFreakFactCheck & { passed: boolean; findings: string[] }>;
  rule_checks: Array<NeatFreakRuleCheck & { passed: boolean; findings: string[] }>;
  cleanup_proposal: NeatFreakCleanupProposal;
  cleanup_proposal_path: string;
  cleanup_candidate_count: number;
  cleanup_deleted_files: [];
  findings: string[];
  acceptance_passed: boolean;
  acceptance_path: string;
  created_at: string;
}

interface SavedPlan {
  skill: string;
  active_skill: ActiveSkillRecord;
  planned_changes: Array<{ path: string }>;
  planned_commands: string[];
  memory_action: string;
  cleanup_action: string;
}

interface SavedComparison {
  status: string;
  reason: string;
  planned_files: string[];
  changed_files: string[];
  unexpected_files: string[];
  missing_files: string[];
  deleted_files: string[];
  case_mismatches: Array<{ planned: string; actual: string }>;
  symlink_escape_files: string[];
  validation_status?: string | null;
}

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const MEMORY_PATH_PATTERN = /(^|\/)(?:\.codexpro\/memory|\.ai-bridge\/memory)(\/|$)|(?:^|\/)(?:memory-index|memory_index)\.(?:db|sqlite|sqlite3)$/i;
const SOURCE_PATH_PATTERN = /^(?:src|app|server|api|database|migrations)\//i;
const DUPLICATE_RULE_DOC_NAME_PATTERN = /(?:^|[-_.])(?:rules?|authorit[y]|instructions?|agent-policy)(?:[-_.]|$)/i;

function normalizeRel(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexProError("Acceptance path must be non-empty.");
  const portable = value.trim().replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) {
    throw new CodexProError(`Acceptance path must be workspace-relative: ${value}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`Acceptance path escapes the workspace: ${value}`);
  }
  return normalized;
}

async function readJson<T>(guard: PathGuard, workspace: Workspace, relPath: string): Promise<T> {
  const resolved = guard.resolve(workspace, relPath);
  await guard.assertTextFile(resolved.absPath, 2_000_000);
  try {
    return JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as T;
  } catch (error) {
    throw new CodexProError(`Invalid neat-freak JSON at ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readWorkspaceText(guard: PathGuard, workspace: Workspace, relPath: string): Promise<string> {
  const resolved = guard.resolve(workspace, normalizeRel(relPath));
  await guard.assertTextFile(resolved.absPath, 2_000_000);
  return await fsp.readFile(resolved.absPath, "utf8");
}

async function pathExistsInsideWorkspace(guard: PathGuard, workspace: Workspace, relPath: string): Promise<boolean> {
  try {
    const resolved = guard.resolve(workspace, normalizeRel(relPath));
    const canonical = await fsp.realpath(resolved.absPath);
    const root = await fsp.realpath(workspace.root);
    return isSubpath(canonical, root);
  } catch {
    return false;
  }
}

async function packageScripts(guard: PathGuard, workspace: Workspace): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readWorkspaceText(guard, workspace, "package.json")) as Record<string, unknown>;
    return parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? parsed.scripts as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function commandExists(
  guard: PathGuard,
  workspace: Workspace,
  scripts: Record<string, unknown>,
  command: string
): Promise<boolean> {
  const normalized = command.trim();
  const runMatch = normalized.match(/^(?:npm|pnpm|yarn|bun)\s+run\s+([a-zA-Z0-9:_-]+)/);
  if (runMatch) return typeof scripts[runMatch[1]] === "string";
  if (/^(?:npm|pnpm|yarn|bun)\s+test(?:\s|$)/.test(normalized)) return typeof scripts.test === "string";
  const localPath = normalized.match(/^(?:node|bash|sh|python3?|tsx|ts-node)\s+([^\s]+)/)?.[1]
    ?? normalized.match(/^(\.\.?\/[^\s]+)/)?.[1];
  return localPath
    ? await pathExistsInsideWorkspace(guard, workspace, localPath.replace(/^['"]|['"]$/g, ""))
    : false;
}

function strongRuleStatements(text: string): Array<{ key: string; negative: boolean; original: string }> {
  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.replace(/^\s*[-*]\s+/, "").trim();
    if (!line) return [];
    const negative = /\b(?:do not|don't|never|must not)\b|(?:禁止|不得|不要|不允许)/i.test(line);
    const positive = /\bmust\b|(?:必须|务必|只允许)/i.test(line);
    if (!negative && !positive) return [];
    const key = line.toLowerCase()
      .replace(/\b(?:do not|don't|never|must not|must)\b/gi, "")
      .replace(/(?:禁止|不得|不要|不允许|必须|务必|只允许)/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .trim();
    return key ? [{ key, negative, original: line }] : [];
  });
}

function ruleConflicts(texts: Array<{ path: string; text: string }>): string[] {
  const groups = new Map<string, Array<{ negative: boolean; original: string; path: string }>>();
  for (const file of texts) {
    for (const statement of strongRuleStatements(file.text)) {
      const group = groups.get(statement.key) ?? [];
      group.push({ negative: statement.negative, original: statement.original, path: file.path });
      groups.set(statement.key, group);
    }
  }
  return [...groups.values()].flatMap((entries) => {
    if (new Set(entries.map((entry) => entry.negative)).size < 2) return [];
    return [`Conflicting current rules: ${entries.map((entry) => `${entry.path}: ${entry.original}`).join(" | ")}`];
  });
}

function classifyChangedFiles(files: string[]): {
  docs: string[];
  rules: string[];
  source: string[];
  memory: string[];
  duplicateRuleDocs: string[];
} {
  const rules = files.filter((file) => /^(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?)\.md$/i.test(file));
  const docs = files.filter((file) => /^(?:README(?:_[^/]+)?\.md|docs\/)/i.test(file));
  const source = files.filter((file) => SOURCE_PATH_PATTERN.test(file) || /^(?:package(?:-lock)?\.json|\.env)/i.test(file));
  const memory = files.filter((file) => MEMORY_PATH_PATTERN.test(file));
  const duplicateRuleDocs = docs.filter((file) => DUPLICATE_RULE_DOC_NAME_PATTERN.test(path.basename(file)));
  return { docs, rules, source, memory, duplicateRuleDocs };
}

export async function runNeatFreakAcceptance(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: NeatFreakAcceptanceInput
): Promise<NeatFreakAcceptanceResult> {
  if (!RUN_ID_PATTERN.test(input.run_id)) throw new CodexProError("Invalid neat-freak run_id.");
  const activeSkill = await assertActiveSkillCurrent(config, input.active_skill);
  if (activeSkill.name !== "neat-freak") throw new CodexProError("This acceptance check requires neat-freak.");

  const base = `.ai-bridge/neat-freak/runs/${input.run_id}`;
  const plan = await readJson<SavedPlan>(guard, workspace, `${base}/plan.json`);
  const comparison = await readJson<SavedComparison>(guard, workspace, `${base}/comparison.json`);
  const cleanup = await createNeatFreakCleanupProposal(config, guard, workspace, input.run_id);
  const findings: string[] = [];

  if (plan.skill !== "neat-freak") findings.push("Saved plan does not belong to neat-freak.");
  if (plan.active_skill?.source_commit !== activeSkill.source_commit || plan.active_skill?.digest !== activeSkill.digest) {
    findings.push("Saved plan Skill version does not match the currently approved Skill.");
  }
  if (comparison.status !== "passed") findings.push(`Plan comparison did not pass: ${comparison.reason}.`);
  if (comparison.unexpected_files?.length) findings.push(`Unexpected changed files: ${comparison.unexpected_files.join(", ")}.`);
  if (comparison.missing_files?.length) findings.push(`Planned files not changed: ${comparison.missing_files.join(", ")}.`);
  if (comparison.deleted_files?.length) findings.push(`Files were deleted and the现场 must remain for review: ${comparison.deleted_files.join(", ")}.`);
  if (comparison.case_mismatches?.length) findings.push("Path case differs from the approved plan.");
  if (comparison.symlink_escape_files?.length) findings.push(`Symlink escaped the project: ${comparison.symlink_escape_files.join(", ")}.`);

  const classified = classifyChangedFiles(comparison.changed_files ?? []);
  if (classified.source.length) findings.push(`Business/source scope was modified: ${classified.source.join(", ")}.`);
  if (classified.memory.length) findings.push(`Generated project memory was modified directly: ${classified.memory.join(", ")}.`);
  if (classified.duplicateRuleDocs.length) findings.push(`Possible second rule authority was created: ${classified.duplicateRuleDocs.join(", ")}.`);

  const factChecks: NeatFreakAcceptanceResult["fact_checks"] = [];
  for (const check of input.fact_checks ?? []) {
    const checkFindings: string[] = [];
    let target = "";
    let evidence = "";
    try { target = await readWorkspaceText(guard, workspace, check.target_path); }
    catch { checkFindings.push(`Target file is missing or unreadable: ${check.target_path}.`); }
    try { evidence = await readWorkspaceText(guard, workspace, check.evidence_path); }
    catch { checkFindings.push(`Evidence file is missing or unreadable: ${check.evidence_path}.`); }
    if (check.target_contains && !target.includes(check.target_contains)) checkFindings.push(`Target text is not present in ${check.target_path}.`);
    if (check.target_absent && target.includes(check.target_absent)) checkFindings.push(`Deprecated or conflicting text is still present in ${check.target_path}.`);
    if (!check.target_contains && !check.target_absent) checkFindings.push("Fact check needs target_contains or target_absent.");
    if (!check.evidence_contains || !evidence.includes(check.evidence_contains)) checkFindings.push(`Evidence text is not present in ${check.evidence_path}.`);
    factChecks.push({ ...check, passed: checkFindings.length === 0, findings: checkFindings });
    findings.push(...checkFindings.map((item) => `${check.area}: ${item}`));
  }

  const ruleChecks: NeatFreakAcceptanceResult["rule_checks"] = [];
  const scripts = await packageScripts(guard, workspace);
  const ruleTexts: Array<{ path: string; text: string }> = [];
  for (const check of input.rule_checks ?? []) {
    const checkFindings: string[] = [];
    try { ruleTexts.push({ path: check.rule_file, text: await readWorkspaceText(guard, workspace, check.rule_file) }); }
    catch { checkFindings.push(`Rule file is missing: ${check.rule_file}.`); }
    for (const reference of check.referenced_paths ?? []) {
      if (!await pathExistsInsideWorkspace(guard, workspace, reference)) checkFindings.push(`Referenced file does not exist inside the project: ${reference}.`);
    }
    for (const command of check.commands ?? []) {
      if (!await commandExists(guard, workspace, scripts, command)) checkFindings.push(`Referenced command does not exist: ${command}.`);
    }
    ruleChecks.push({ ...check, passed: checkFindings.length === 0, findings: checkFindings });
    findings.push(...checkFindings.map((item) => `rules: ${item}`));
  }
  findings.push(...ruleConflicts(ruleTexts));

  const checksByArea = (area: FactArea) => factChecks.filter((check) => check.area === area);
  const docsChecks = checksByArea("docs");
  const rulesFactChecks = checksByArea("rules");
  const codeChecks = checksByArea("code");
  const docsCovered = new Set(docsChecks.map((check) => normalizeRel(check.target_path)));
  const rulesCovered = new Set(ruleChecks.map((check) => check.rule_file));
  for (const changedDoc of classified.docs) {
    if (!docsCovered.has(changedDoc)) findings.push(`Changed documentation has no fact check: ${changedDoc}.`);
  }
  for (const changedRule of classified.rules) {
    if (!rulesCovered.has(changedRule as NeatFreakRuleCheck["rule_file"])) findings.push(`Changed rule file has no reference check: ${changedRule}.`);
  }

  if (input.memory.action === "none" && !/本次没有新的长期记忆|no new long-term memory/i.test(input.memory.summary)) {
    findings.push("Memory status 'none' must explicitly state that this run has no new long-term memory.");
  }
  if (plan.memory_action !== "proposal_only") findings.push("Saved plan memory_action must remain proposal_only.");
  if (input.workspace.cleanup_action !== "proposal_only" || plan.cleanup_action !== "proposal_only") {
    findings.push("Cleanup must remain proposal_only for the first neat-freak version.");
  }
  if (cleanup.deleted_files.length) findings.push("Cleanup proposal unexpectedly reports deleted files.");
  const cleanupCandidates = new Set(cleanup.candidates.map((candidate) => candidate.path));
  for (const claimedCandidate of input.workspace.candidate_paths ?? []) {
    const normalizedCandidate = normalizeRel(claimedCandidate);
    if (!cleanupCandidates.has(normalizedCandidate)) {
      findings.push(`Claimed cleanup candidate was not found by the bounded scan: ${normalizedCandidate}.`);
    }
  }

  const runtimeVerified = (plan.planned_commands?.length ?? 0) > 0 && comparison.validation_status === "passed";
  const factStatus: NeatFreakAcceptanceResult["fact_status"] = {
    code: codeChecks.length && codeChecks.every((check) => check.passed) ? "verified-current" : "out-of-scope",
    runtime: (plan.planned_commands?.length ?? 0) === 0 ? "not-applicable" : runtimeVerified ? "verified-current" : "pending",
    docs: classified.docs.length
      ? docsChecks.length && docsChecks.every((check) => check.passed) ? "changed-and-verified" : "pending"
      : docsChecks.length && docsChecks.every((check) => check.passed) ? "verified-current" : "out-of-scope",
    rules: classified.rules.length
      ? ruleChecks.length && ruleChecks.every((check) => check.passed) && rulesFactChecks.every((check) => check.passed) ? "changed-and-verified" : "pending"
      : ruleChecks.length && ruleChecks.every((check) => check.passed) ? "verified-current" : "not-applicable",
    memory: input.memory.action === "none" ? "verified-current" : "pending",
    workspace: cleanup.candidate_count ? "pending" : "verified-current"
  };

  for (const [area, claimed] of Object.entries(input.claimed_fact_status ?? {})) {
    const actual = factStatus[area as StatusArea];
    if (claimed !== actual) findings.push(`Claimed ${area} status ${claimed} is not supported; computed status is ${actual}.`);
  }
  if (factStatus.runtime === "pending") findings.push("Runtime status lacks a passing command result.");
  if (factStatus.docs === "pending") findings.push("Documentation facts remain pending.");
  if (factStatus.rules === "pending") findings.push("Agent rule verification remains pending.");

  const acceptancePath = `${base}/acceptance.json`;
  const result: NeatFreakAcceptanceResult = {
    active_skill: {
      name: activeSkill.name,
      source_repository: activeSkill.source_repository,
      source_commit: activeSkill.source_commit,
      entry_path: activeSkill.entry_path,
      digest: activeSkill.digest,
      loaded_at: activeSkill.loaded_at
    },
    planned_files: comparison.planned_files ?? [],
    changed_files: comparison.changed_files ?? [],
    unexpected_files: comparison.unexpected_files ?? [],
    fact_status: factStatus,
    fact_checks: factChecks,
    rule_checks: ruleChecks,
    cleanup_proposal: cleanup,
    cleanup_proposal_path: cleanup.proposal_path,
    cleanup_candidate_count: cleanup.candidate_count,
    cleanup_deleted_files: cleanup.deleted_files,
    findings: [...new Set(findings)],
    acceptance_passed: findings.length === 0,
    acceptance_path: acceptancePath,
    created_at: new Date().toISOString()
  };
  await writeTextFile(config, guard, workspace, acceptancePath, `${JSON.stringify(result, null, 2)}\n`, {
    createDirs: true,
    overwrite: true
  });
  return result;
}
