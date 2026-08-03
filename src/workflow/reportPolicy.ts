import type { ExecutionLane } from "./executionLane.js";

export type ReportTerminalStatus = "passed" | "failed" | "blocked" | "cancelled" | "planned" | "unknown";
export type ReportOutputMode = "compact" | "full";
export type ReportPersistenceMode = "none" | "summary" | "full";

export interface ReportPolicyInput {
  lane?: ExecutionLane;
  status?: ReportTerminalStatus;
  output_mode?: ReportOutputMode;
  persistence_mode?: ReportPersistenceMode;
  save_full_logs?: boolean;
  repair_count?: number;
  escalated?: boolean;
  debug?: boolean;
  unknown_external_state?: boolean;
  lane_based_enabled?: boolean;
  full_logs_on_failure?: boolean;
}

export interface ReportPolicyDecision {
  version: 1;
  lane: ExecutionLane;
  status: ReportTerminalStatus;
  response_mode: ReportOutputMode;
  persistence_mode: ReportPersistenceMode;
  archive_mode: ReportOutputMode;
  save_command_logs: boolean;
  save_technical_report: boolean;
  save_full_boss_report: boolean;
  compact_success: boolean;
  explicit_override: boolean;
  reason_code: string;
  reasons: string[];
  omitted_artifacts: string[];
}

function normalizeCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function defaultPersistence(lane: ExecutionLane, status: ReportTerminalStatus): ReportPersistenceMode {
  if (lane === "fast" && status === "passed") return "none";
  return "summary";
}

export function decideReportPolicy(input: ReportPolicyInput = {}): ReportPolicyDecision {
  const lane = input.lane ?? "standard";
  const status = input.status ?? "unknown";
  const responseMode = input.output_mode ?? "compact";
  const explicitNoCommandLogs = input.save_full_logs === false;
  const repairCount = normalizeCount(input.repair_count);
  const failureLike = status === "failed" || status === "blocked" || status === "cancelled";
  const escalated = input.escalated === true;
  const unknownExternalState = input.unknown_external_state === true;
  const laneBasedEnabled = input.lane_based_enabled !== false;
  const fullLogsOnFailure = input.full_logs_on_failure !== false;
  const explicitPersistence = input.persistence_mode
    ?? (input.save_full_logs === true ? "full" : input.save_full_logs === false ? "summary" : undefined);

  if (!laneBasedEnabled) {
    const persistenceMode = explicitPersistence ?? "full";
    const saveFull = persistenceMode === "full";
    return {
      version: 1,
      lane,
      status,
      response_mode: responseMode,
      persistence_mode: persistenceMode,
      archive_mode: saveFull ? "full" : "compact",
      save_command_logs: saveFull,
      save_technical_report: saveFull,
      save_full_boss_report: saveFull,
      compact_success: status === "passed" && !saveFull,
      explicit_override: input.save_full_logs !== undefined || input.output_mode !== undefined || input.persistence_mode !== undefined,
      reason_code: "report_policy_legacy_compat",
      reasons: ["Lane-based report grading is disabled; preserve the legacy persistence default without coupling it to response verbosity."],
      omitted_artifacts: saveFull ? [] : ["command_logs", "technical_report", "full_boss_report"]
    };
  }

  const evidenceRequired = lane === "deep"
    || repairCount > 0
    || escalated
    || input.debug === true
    || unknownExternalState
    || (failureLike && fullLogsOnFailure);
  const persistenceMode: ReportPersistenceMode = evidenceRequired ? "full" : explicitPersistence ?? defaultPersistence(lane, status);
  const saveFullEvidence = persistenceMode === "full";
  const saveCommandLogs = explicitNoCommandLogs ? false : saveFullEvidence;
  const compactSuccess = status === "passed" && !saveFullEvidence;

  let reasonCode = "report_policy_summary_persistence";
  const reasons: string[] = [];
  if (input.debug === true) {
    reasonCode = "report_policy_debug_full_persistence";
    reasons.push("Debug execution requires full persisted evidence independently of response verbosity.");
  } else if (lane === "deep") {
    reasonCode = "report_policy_deep_full_persistence";
    reasons.push("Deep Lane preserves complete technical and review evidence.");
  } else if (failureLike && fullLogsOnFailure) {
    reasonCode = `report_policy_${status}_full_persistence`;
    reasons.push(`${status} execution requires complete related audit evidence.`);
  } else if (repairCount > 0) {
    reasonCode = "report_policy_repair_full_persistence";
    reasons.push(`Repair count is ${repairCount}; preserve full related evidence.`);
  } else if (escalated) {
    reasonCode = "report_policy_escalation_full_persistence";
    reasons.push("Runtime escalation requires full related evidence.");
  } else if (unknownExternalState) {
    reasonCode = "report_policy_unknown_external_state_full_persistence";
    reasons.push("Unknown external state requires full related evidence.");
  } else if (explicitPersistence === "full") {
    reasonCode = "report_policy_explicit_full_persistence";
    reasons.push("The caller explicitly requested full persistence.");
  } else if (persistenceMode === "none") {
    reasonCode = "report_policy_no_persistence";
    reasons.push("Successful low-cost execution keeps the response but omits duplicate durable reports.");
  } else {
    reasons.push("Persist a compact summary while keeping response verbosity independent.");
  }
  if (input.output_mode === "full" && persistenceMode !== "full") reasons.push("Full response mode does not imply full report persistence.");
  if (explicitNoCommandLogs) reasons.push("The caller explicitly disabled command log persistence; audit summaries remain available.");

  const omitted: string[] = [];
  if (!saveCommandLogs) omitted.push("command_logs");
  if (!saveFullEvidence) omitted.push("technical_report", "full_boss_report");
  if (persistenceMode === "none") omitted.push("summary_report");

  return {
    version: 1,
    lane,
    status,
    response_mode: responseMode,
    persistence_mode: persistenceMode,
    archive_mode: saveFullEvidence ? "full" : "compact",
    save_command_logs: saveCommandLogs,
    save_technical_report: saveFullEvidence,
    save_full_boss_report: saveFullEvidence,
    compact_success: compactSuccess,
    explicit_override: input.save_full_logs !== undefined || input.output_mode !== undefined || input.persistence_mode !== undefined || input.debug === true,
    reason_code: reasonCode,
    reasons,
    omitted_artifacts: omitted
  };
}
