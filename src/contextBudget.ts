import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import type { PathGuard } from "./guard.js";
import { readProjectProfile } from "./project/projectConfig.js";
import type { ProjectContextBudget } from "./project/types.js";

export interface ResolvedContextBudget {
  maxFilesPerTask: number;
  maxLinesPerFile: number;
  maxTotalChars: number;
  source: "defaults" | "project" | "project+overrides" | "overrides";
}

export interface ContextBudgetOverrides {
  maxFilesPerTask?: number;
  maxLinesPerFile?: number;
  maxTotalChars?: number;
}

export const DEFAULT_CONTEXT_BUDGET: ResolvedContextBudget = {
  maxFilesPerTask: 16,
  maxLinesPerFile: 240,
  maxTotalChars: 180_000,
  source: "defaults"
};

function positiveInteger(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined;
  return Math.floor(numberValue);
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = positiveInteger(value);
  if (numberValue === undefined) return fallback;
  return Math.max(min, Math.min(max, numberValue));
}

export type ProjectContextBudgetMode = "override" | "cap";

export function normalizeContextBudget(
  raw?: ProjectContextBudget,
  overrides: ContextBudgetOverrides = {},
  defaults: ResolvedContextBudget = DEFAULT_CONTEXT_BUDGET,
  projectMode: ProjectContextBudgetMode = "override"
): ResolvedContextBudget {
  const hasProjectBudget = Boolean(raw && Object.keys(raw).length);
  const hasOverrides = Object.values(overrides).some((value) => positiveInteger(value) !== undefined);
  const valueFor = (override: number | undefined, project: number | undefined, fallback: number): number => {
    const requested = positiveInteger(override) ?? fallback;
    const projectValue = positiveInteger(project);
    if (projectMode === "cap" && projectValue !== undefined) return Math.min(requested, projectValue);
    return positiveInteger(override) ?? projectValue ?? fallback;
  };
  const merged = {
    maxFilesPerTask: valueFor(overrides.maxFilesPerTask, raw?.max_files_per_task, defaults.maxFilesPerTask),
    maxLinesPerFile: valueFor(overrides.maxLinesPerFile, raw?.max_lines_per_file, defaults.maxLinesPerFile),
    maxTotalChars: valueFor(overrides.maxTotalChars, raw?.max_total_chars, defaults.maxTotalChars)
  };
  return {
    maxFilesPerTask: clamp(merged.maxFilesPerTask, defaults.maxFilesPerTask, 1, 80),
    maxLinesPerFile: clamp(merged.maxLinesPerFile, defaults.maxLinesPerFile, 20, 2_000),
    maxTotalChars: clamp(merged.maxTotalChars, defaults.maxTotalChars, 10_000, 2_000_000),
    source: hasProjectBudget && hasOverrides ? "project+overrides" : hasProjectBudget ? "project" : hasOverrides ? "overrides" : "defaults"
  };
}

export async function loadContextBudget(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  overrides: ContextBudgetOverrides = {},
  defaults: ResolvedContextBudget = DEFAULT_CONTEXT_BUDGET,
  projectMode: ProjectContextBudgetMode = "override"
): Promise<ResolvedContextBudget> {
  try {
    const profile = await readProjectProfile(config, guard, workspace);
    return normalizeContextBudget(profile.existed ? profile.config.context : undefined, overrides, defaults, projectMode);
  } catch {
    return normalizeContextBudget(undefined, overrides, defaults, projectMode);
  }
}

export function budgetExceededAdvice(toolName: string, budget: ResolvedContextBudget): string {
  return [
    `${toolName} exceeded the task context budget.`,
    `Budget: max_files_per_task=${budget.maxFilesPerTask}, max_lines_per_file=${budget.maxLinesPerFile}, max_total_chars=${budget.maxTotalChars}.`,
    "Narrow the request with explicit paths, a smaller path/glob, fewer search queries, lower line ranges, or a higher context budget in .codexpro/project.yml."
  ].join(" ");
}
