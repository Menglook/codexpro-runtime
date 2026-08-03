export type AggregateExecutionMode = "analysis_only" | "engineering";

export interface AggregateExecutionClassification {
  mode: AggregateExecutionMode;
  read_requested: boolean;
  archive_requested: boolean;
  reason_code: "analysis_only_read_shape" | "aggregate_side_effect_requested" | "aggregate_no_read_input";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasMeaningfulStrings(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0);
}

function hasReadInputs(root: Record<string, unknown>): boolean {
  return hasMeaningfulStrings(root.search_queries)
    || hasArrayItems(root.read_files);
}

function hasSideEffectInputs(root: Record<string, unknown>): boolean {
  return hasArrayItems(root.patches)
    || hasMeaningfulStrings(root.commands);
}

export function classifyAggregateExecutionArgs(args: unknown): AggregateExecutionClassification {
  const root = recordValue(args) ?? {};
  const readRequested = hasReadInputs(root);
  const sideEffectRequested = hasSideEffectInputs(root);
  if (sideEffectRequested) {
    return {
      mode: "engineering",
      read_requested: readRequested,
      archive_requested: root.save_full_logs === true,
      reason_code: "aggregate_side_effect_requested"
    };
  }
  if (!readRequested) {
    return {
      mode: "engineering",
      read_requested: false,
      archive_requested: root.save_full_logs === true,
      reason_code: "aggregate_no_read_input"
    };
  }
  return {
    mode: "analysis_only",
    read_requested: true,
    archive_requested: root.save_full_logs === true,
    reason_code: "analysis_only_read_shape"
  };
}

export function classifyAggregateToolCall(toolName: string, args: unknown): AggregateExecutionClassification | null {
  const normalized = String(toolName ?? "").trim().toLowerCase();
  if (normalized !== "run_task" && normalized !== "run_stage") return null;
  return classifyAggregateExecutionArgs(args);
}

export function isZeroWriteAnalysisOnlyAggregateCall(toolName: string, args: unknown): boolean {
  const classification = classifyAggregateToolCall(toolName, args);
  return classification?.mode === "analysis_only" && classification.archive_requested === false;
}
