import { createHash } from "node:crypto";

export const TOOL_LIMITS_VERSION = 2;

export const TOOL_LIMITS = {
  common: {
    file_input_max_bytes: 2_000_000,
    max_files_per_task: 80,
    max_lines_per_file: 2_000,
    max_total_chars: 2_000_000
  },
  search_project: {
    max_queries: 4,
    max_long_task_queries: 20,
    max_results_per_query: 20,
    max_files_per_task: 80,
    max_lines_per_file: 2_000,
    max_total_chars: 2_000_000
  },
  read_many_files: {
    max_files: 50,
    max_chars_per_file: 80_000,
    max_files_per_task: 80,
    max_lines_per_file: 2_000,
    max_total_chars: 2_000_000
  },
  aggregate_execution: {
    max_search_queries: 4,
    max_results_per_query: 20,
    max_read_files: 8,
    max_patches: 5,
    max_commands: 3
  },
  durable_execution: {
    max_search_queries: 20,
    max_results_per_query: 20,
    max_read_files: 50,
    max_patches: 50,
    max_commands: 20
  },
  task_template: {
    max_search_queries: 4,
    max_read_files: 50,
    max_patches: 50,
    max_commands: 20
  },
  validation: {
    max_commands: 20
  },
  patch_bundle: {
    max_operations: 50
  },
  git: {
    max_selected_paths: 500,
    max_expected_paths: 500,
    max_validation_refs: 100,
    max_commit_message_chars: 200,
    max_prepare_commit_message_chars: 500
  },
  browser: {
    runtime_probe_max_nodes: 100,
    runtime_probe_default_nodes: 20,
    runtime_probe_text_chars: 2_000,
    observe_max_nodes: 1_000,
    observe_default_nodes: 300,
    observe_max_text_chars: 80_000,
    observe_default_text_chars: 20_000,
    observe_max_response_bytes: 500_000,
    observe_default_response_bytes: 120_000,
    inspect_default_nodes: 500,
    inspect_default_text_chars: 40_000,
    region_default_nodes: 200,
    region_default_text_chars: 10_000,
    extract_table_max_rows: 5_000,
    extract_table_default_rows: 500,
    extract_table_max_scrolls: 20,
    extract_table_default_scrolls: 5,
    flow_max_steps: 200,
    flow_max_repeat_iterations: 20,
    flow_max_extract_facts: 100,
    verification_max_pages: 50,
    verification_default_pages: 20,
    verification_max_devices: 2
  }
} as const;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function toolLimitsDigest(
  limits: unknown = TOOL_LIMITS,
  version: number = TOOL_LIMITS_VERSION
): string {
  return `sha256:${createHash("sha256").update(stableStringify({ version, limits })).digest("hex")}`;
}

export function clampToolLimit(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(numeric)));
}

export const TOOL_LIMITS_DIGEST = toolLimitsDigest();
