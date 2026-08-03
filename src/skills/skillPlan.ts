import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { writeTextFile } from "../fsOps.js";
import { gitChangeSummary } from "../gitOps.js";
import { CodexProError, isSubpath, type PathGuard, type Workspace } from "../guard.js";
import { captureRepositoryState, type RepositoryStateSnapshot } from "../workflow/repositoryState.js";
import { assertSkillWritePathAllowed, type SkillExecutionPolicy } from "./skillPolicy.js";
import type { ActiveSkillRecord, SkillPlannedChange, SkillTaskPlanInput } from "./types.js";

export interface PreparedSkillTaskPlan {
  plan_path: string;
  plan: {
    skill: "neat-freak";
    active_skill: ActiveSkillRecord;
    planned_changes: SkillPlannedChange[];
    planned_commands: string[];
    memory_action: "proposal_only";
    cleanup_action: "proposal_only";
    created_at: string;
  };
  baseline: RepositoryStateSnapshot;
}

export interface SkillPlanComparison {
  status: "passed" | "failed";
  reason: "matched" | "unexpected_changed_files" | "planned_files_not_changed" | "skill_plan_mismatch";
  planned_files: string[];
  changed_files: string[];
  unexpected_files: string[];
  missing_files: string[];
  deleted_files: string[];
  case_mismatches: Array<{ planned: string; actual: string }>;
  symlink_escape_files: string[];
  baseline_digest: string;
  final_digest: string;
  validation_status: string | null;
  validation_reason_code: string | null;
  comparison_path: string;
}

function normalizePlannedPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexProError("Each neat-freak planned change needs a path.");
  const portable = value.trim().replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) throw new CodexProError(`neat-freak plan path must be workspace-relative: ${value}`);
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`neat-freak plan path escapes the current project: ${value}`);
  }
  return normalized;
}

function normalizeCommand(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexProError("neat-freak planned commands must be non-empty strings.");
  const normalized = value.trim();
  if (normalized.includes("\0") || /[\r\n]/.test(normalized)) throw new CodexProError("neat-freak planned commands must be one line.");
  return normalized;
}

function normalizePlan(policy: SkillExecutionPolicy, activeSkill: ActiveSkillRecord, input: SkillTaskPlanInput): PreparedSkillTaskPlan["plan"] {
  if (!input || typeof input !== "object" || !Array.isArray(input.planned_changes)) {
    throw new CodexProError("neat-freak write tasks require skill_plan.planned_changes before execution.");
  }
  if (input.planned_changes.length > 100) throw new CodexProError("neat-freak skill_plan supports at most 100 planned changes.");
  const plannedChanges = input.planned_changes.map((change, index) => {
    if (!change || typeof change !== "object") throw new CodexProError(`skill_plan.planned_changes[${index}] must be an object.`);
    const plannedPath = assertSkillWritePathAllowed(policy, normalizePlannedPath(change.path));
    const reason = typeof change.reason === "string" ? change.reason.trim() : "";
    if (!reason) throw new CodexProError(`skill_plan.planned_changes[${index}].reason is required.`);
    const evidence = Array.isArray(change.evidence)
      ? [...new Set(change.evidence.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))]
      : [];
    if (!evidence.length) throw new CodexProError(`skill_plan.planned_changes[${index}].evidence needs at least one item.`);
    return { path: plannedPath, reason, evidence };
  });
  const seenLower = new Map<string, string>();
  for (const change of plannedChanges) {
    const lower = change.path.toLowerCase();
    const previous = seenLower.get(lower);
    if (previous) throw new CodexProError(`neat-freak plan contains duplicate or case-conflicting paths: ${previous}, ${change.path}`);
    seenLower.set(lower, change.path);
  }
  return {
    skill: "neat-freak",
    active_skill: activeSkill,
    planned_changes: plannedChanges,
    planned_commands: (input.planned_commands ?? []).map(normalizeCommand),
    memory_action: "proposal_only",
    cleanup_action: "proposal_only",
    created_at: new Date().toISOString()
  };
}

async function captureFullChangedState(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<RepositoryStateSnapshot> {
  const summary = gitChangeSummary(config, guard, workspace);
  return await captureRepositoryState(config, workspace, { changed_files: summary.changedFiles });
}

function maps(snapshot: RepositoryStateSnapshot): Map<string, string> {
  return new Map(snapshot.file_sha256.map((entry) => [entry.path.replaceAll("\\", "/"), entry.sha256]));
}

function changedByTask(before: RepositoryStateSnapshot, after: RepositoryStateSnapshot): string[] {
  const beforeMap = maps(before);
  const afterMap = maps(after);
  const union = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  return [...union].filter((file) => beforeMap.get(file) !== afterMap.get(file)).sort();
}

async function symlinkEscapes(workspace: Workspace, files: string[]): Promise<string[]> {
  const escaped: string[] = [];
  const root = await fsp.realpath(workspace.root);
  for (const file of files) {
    const absolute = path.resolve(root, file);
    try {
      const stat = await fsp.lstat(absolute);
      if (!stat.isSymbolicLink()) continue;
      let target: string;
      try {
        target = await fsp.realpath(absolute);
      } catch {
        const link = await fsp.readlink(absolute);
        target = path.resolve(path.dirname(absolute), link);
      }
      if (!isSubpath(target, root)) escaped.push(file);
    } catch {
      // Missing files are handled as deletions below.
    }
  }
  return escaped.sort();
}

export async function prepareNeatFreakTaskPlan(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string,
  policy: SkillExecutionPolicy | undefined,
  activeSkill: ActiveSkillRecord | undefined,
  input: SkillTaskPlanInput | undefined,
  requestedCommands: string[]
): Promise<PreparedSkillTaskPlan | undefined> {
  if (policy?.skill_name !== "neat-freak" || !activeSkill) return undefined;
  if (!input) throw new CodexProError("neat-freak write or command tasks require skill_plan before execution.");
  const plan = normalizePlan(policy, activeSkill, input);
  const commands = requestedCommands.map(normalizeCommand);
  if (JSON.stringify(plan.planned_commands) !== JSON.stringify(commands)) {
    throw new CodexProError("neat-freak skill_plan.planned_commands must exactly match the commands requested for this task.");
  }
  const planPath = `.ai-bridge/neat-freak/runs/${runId}/plan.json`;
  await writeTextFile(config, guard, workspace, planPath, `${JSON.stringify(plan, null, 2)}\n`, { createDirs: true, overwrite: false });
  const baseline = await captureFullChangedState(config, guard, workspace);
  return { plan_path: planPath, plan, baseline };
}

function successfulPatchPaths(operations: unknown[]): string[] {
  return [...new Set(operations.flatMap((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return [];
    const record = operation as Record<string, unknown>;
    if (record.status !== "ok" || typeof record.path !== "string") return [];
    return [normalizePlannedPath(record.path)];
  }))].sort();
}

export async function compareNeatFreakTaskPlan(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string,
  prepared: PreparedSkillTaskPlan,
  patchOperations: unknown[] = [],
  validationData?: Record<string, unknown>
): Promise<SkillPlanComparison> {
  const finalState = await captureFullChangedState(config, guard, workspace);
  const changedFiles = [...new Set([
    ...changedByTask(prepared.baseline, finalState),
    ...successfulPatchPaths(patchOperations)
  ])].sort();
  const plannedFiles = prepared.plan.planned_changes.map((change) => change.path).sort();
  const planned = new Set(plannedFiles);
  const actual = new Set(changedFiles);
  const unexpectedFiles = changedFiles.filter((file) => !planned.has(file));
  const missingFiles = plannedFiles.filter((file) => !actual.has(file));
  const plannedByLower = new Map(plannedFiles.map((file) => [file.toLowerCase(), file]));
  const caseMismatches = unexpectedFiles.flatMap((actualPath) => {
    const plannedPath = plannedByLower.get(actualPath.toLowerCase());
    return plannedPath && plannedPath !== actualPath ? [{ planned: plannedPath, actual: actualPath }] : [];
  });
  const finalHashes = maps(finalState);
  const deletedFiles = changedFiles.filter((file) => finalHashes.get(file) === "missing");
  const symlinkEscapeFiles = await symlinkEscapes(workspace, changedFiles);
  const passed = unexpectedFiles.length === 0
    && missingFiles.length === 0
    && deletedFiles.length === 0
    && caseMismatches.length === 0
    && symlinkEscapeFiles.length === 0;
  const reason: SkillPlanComparison["reason"] = passed
    ? "matched"
    : unexpectedFiles.length || deletedFiles.length || caseMismatches.length || symlinkEscapeFiles.length
      ? "unexpected_changed_files"
      : missingFiles.length
        ? "planned_files_not_changed"
        : "skill_plan_mismatch";
  const comparisonPath = `.ai-bridge/neat-freak/runs/${runId}/comparison.json`;
  const result: SkillPlanComparison = {
    status: passed ? "passed" : "failed",
    reason,
    planned_files: plannedFiles,
    changed_files: changedFiles,
    unexpected_files: unexpectedFiles,
    missing_files: missingFiles,
    deleted_files: deletedFiles,
    case_mismatches: caseMismatches,
    symlink_escape_files: symlinkEscapeFiles,
    baseline_digest: prepared.baseline.content_digest,
    final_digest: finalState.content_digest,
    validation_status: typeof validationData?.status === "string" ? validationData.status : null,
    validation_reason_code: typeof validationData?.reason_code === "string" ? validationData.reason_code : null,
    comparison_path: comparisonPath
  };
  await writeTextFile(config, guard, workspace, comparisonPath, `${JSON.stringify(result, null, 2)}\n`, { createDirs: true, overwrite: true });
  return result;
}
