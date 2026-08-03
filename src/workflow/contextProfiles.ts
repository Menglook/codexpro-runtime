import type { ContextBudgetOverrides } from "../contextBudget.js";
import type { ExecutionLane } from "./executionLane.js";

export type ContextProfileName = ExecutionLane;

export interface ContextProfile {
  name: ContextProfileName;
  max_files_per_task: number;
  max_lines_per_file: number;
  max_total_chars: number;
  reason_code: string;
}

export const CONTEXT_PROFILES: Record<ContextProfileName, ContextProfile> = {
  finalization: {
    name: "finalization",
    max_files_per_task: 2,
    max_lines_per_file: 80,
    max_total_chars: 20_000,
    reason_code: "lane_finalization_context_budget"
  },
  fast: {
    name: "fast",
    max_files_per_task: 8,
    max_lines_per_file: 160,
    max_total_chars: 80_000,
    reason_code: "lane_fast_context_budget"
  },
  standard: {
    name: "standard",
    max_files_per_task: 12,
    max_lines_per_file: 220,
    max_total_chars: 120_000,
    reason_code: "lane_standard_context_budget"
  },
  deep: {
    name: "deep",
    max_files_per_task: 16,
    max_lines_per_file: 240,
    max_total_chars: 180_000,
    reason_code: "lane_deep_context_budget"
  }
};

export function resolveContextProfile(lane: ExecutionLane | undefined, enabled = true): ContextProfile {
  if (!enabled) return { ...CONTEXT_PROFILES.deep, reason_code: "context_profiles_disabled" };
  return { ...CONTEXT_PROFILES[lane ?? "standard"] };
}

export function contextProfileOverrides(profile: ContextProfile): ContextBudgetOverrides {
  return {
    maxFilesPerTask: profile.max_files_per_task,
    maxLinesPerFile: profile.max_lines_per_file,
    maxTotalChars: profile.max_total_chars
  };
}

export function mergeContextBudgetOverrides(
  profile: ContextProfile,
  explicit: ContextBudgetOverrides = {}
): ContextBudgetOverrides {
  return {
    maxFilesPerTask: explicit.maxFilesPerTask ?? profile.max_files_per_task,
    maxLinesPerFile: explicit.maxLinesPerFile ?? profile.max_lines_per_file,
    maxTotalChars: explicit.maxTotalChars ?? profile.max_total_chars
  };
}
