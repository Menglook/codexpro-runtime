import type { CodexReasoningEffort } from "../codex/types.js";
import type { UnifiedRiskDecision } from "../security/riskGate.js";
import type { CompiledTask } from "./taskCompiler.js";

export type ExecutionLane = "finalization" | "fast" | "standard" | "deep";
export type ReviewerRoutingMode = "deterministic" | "conditional" | "required";

export interface ExecutionLaneDecision {
  version: 1;
  enabled: boolean;
  lane: ExecutionLane;
  forced_deep: boolean;
  fast_eligible: boolean;
  reason_codes: string[];
  reasons: string[];
  reasoning_effort: CodexReasoningEffort;
  acceptance_profile: "none" | "docs" | "targeted" | "targeted-build" | "full" | "browser" | "release";
  reviewer_mode: ReviewerRoutingMode;
  risk_decision: UnifiedRiskDecision;
  scope_size: number;
  escalation_only: true;
  escalated_from?: ExecutionLane;
}

export interface ExecutionLaneInput {
  compiled_task: CompiledTask;
  route_mode: string;
  acceptance_count: number;
  explicit_review_required?: boolean;
  explicit_reasoning_effort?: CodexReasoningEffort;
  enabled?: boolean;
}

export interface ExecutionLaneEscalationInput {
  previous: ExecutionLaneDecision;
  risk_decision: UnifiedRiskDecision;
  changed_files: string[];
  route_mode: string;
  compiled_task: CompiledTask;
  acceptance_count: number;
  explicit_review_required?: boolean;
}

const REASONING_RANK: Record<CodexReasoningEffort, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4
};

const LANE_RANK: Record<ExecutionLane, number> = {
  finalization: 0,
  fast: 1,
  standard: 2,
  deep: 3
};

const REVIEW_RANK: Record<ReviewerRoutingMode, number> = {
  deterministic: 0,
  conditional: 1,
  required: 2
};

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function laneReasoning(lane: ExecutionLane): CodexReasoningEffort {
  if (lane === "finalization" || lane === "fast") return "low";
  if (lane === "deep") return "high";
  return "medium";
}

function strongerReasoning(base: CodexReasoningEffort, requested?: CodexReasoningEffort): CodexReasoningEffort {
  if (!requested || REASONING_RANK[requested] <= REASONING_RANK[base]) return base;
  return requested;
}

function isPureReadOnlyTask(task: CompiledTask): boolean {
  return task.risk_decision.level === "L0"
    && task.capabilities.read_workspace
    && !task.capabilities.write_source
    && !task.capabilities.write_artifacts
    && !task.capabilities.run_bash
    && !task.capabilities.use_browser
    && !task.capabilities.use_network
    && !task.capabilities.use_git
    && !task.capabilities.write_database;
}

function acceptanceProfile(
  lane: ExecutionLane,
  routeMode: string,
  task: CompiledTask
): ExecutionLaneDecision["acceptance_profile"] {
  if (isPureReadOnlyTask(task)) return "none";
  if (routeMode === "release_gate") return "release";
  if (lane === "finalization") return "targeted";
  if (task.capabilities.use_browser || routeMode === "browser_validation" || routeMode === "ui_patch") return "browser";
  if (lane === "deep") return "full";
  if (lane === "fast" && task.capabilities.write_artifacts && !task.capabilities.write_source) return "docs";
  if (lane === "fast" && !task.capabilities.write_source) return "targeted";
  return "targeted-build";
}

function reviewerMode(lane: ExecutionLane): ReviewerRoutingMode {
  if (lane === "finalization" || lane === "fast") return "deterministic";
  if (lane === "deep") return "required";
  return "conditional";
}

function hasSignal(risk: UnifiedRiskDecision, signal: string): boolean {
  return risk.matched_signals.includes(signal);
}

const CRITICAL_CONTROL_PLANE_PATHS = [
  /^src\/goals\/goalManager\.ts$/i,
  /^src\/jobs\/jobManager\.ts$/i,
  /^src\/workflow\/(?:executionLane|taskRouter|taskCompiler|loopPolicy)\.ts$/i,
  /^src\/server\/toolRegistration\.ts$/i,
  /^src\/security\/riskGate\.ts$/i
];

const PUBLIC_CONTRACT_PATHS = [
  /^schemas?\//i,
  /^package(?:-lock)?\.json$/i,
  /^src\/goals\/types\.ts$/i,
  /^src\/[^/]+\/(?:types|schema)\.ts$/i
];

function normalizedScopeMatches(task: CompiledTask, patterns: RegExp[]): string[] {
  return task.scope.filter((value) => patterns.some((pattern) => pattern.test(value.replace(/\\/g, "/"))));
}

function criticalControlPlanePaths(task: CompiledTask): string[] {
  return normalizedScopeMatches(task, CRITICAL_CONTROL_PLANE_PATHS);
}

function publicContractPaths(task: CompiledTask): string[] {
  return normalizedScopeMatches(task, PUBLIC_CONTRACT_PATHS);
}

function deepReasons(input: ExecutionLaneInput): Array<[string, string]> {
  const task = input.compiled_task;
  const risk = task.risk_decision;
  const reasons: Array<[string, string]> = [];
  if (risk.level === "L3") reasons.push(["risk_l3", "L3 irreversible or business-critical risk requires Deep execution."]);
  if (risk.level === "L2") reasons.push(["risk_l2", "L2 external side effect requires Deep execution and a final tool gate."]);
  if (hasSignal(risk, "security_boundary_change")) reasons.push(["security_boundary", "Security-boundary changes require Deep execution."]);
  const controlPlanePaths = criticalControlPlanePaths(task);
  if (controlPlanePaths.length) reasons.push(["critical_control_plane", `Core state-machine or execution-control changes require Deep execution: ${controlPlanePaths.join(", ")}.`]);
  if (["large_stage", "release_gate", "docker_debug"].includes(input.route_mode)) {
    reasons.push([`route_${input.route_mode}`, `Task route ${input.route_mode} requires Deep execution.`]);
  }
  if (task.source_write_policy === "workspace") reasons.push(["workspace_scope", "Workspace-scale source changes require Deep execution."]);
  if (task.capabilities.write_database) reasons.push(["database_write", "Database writes require Deep execution."]);
  if (task.capabilities.use_browser && task.capabilities.write_source) reasons.push(["browser_plus_source_write", "Browser-dependent source changes require Deep execution."]);
  if (task.capabilities.use_network && (task.capabilities.write_source || task.capabilities.write_database)) {
    reasons.push(["network_mutation", "Network access combined with mutation requires Deep execution."]);
  }
  if (input.explicit_review_required) reasons.push(["explicit_review", "The acceptance contract explicitly requires review evidence."]);
  if (task.scope.length > 8) reasons.push(["large_explicit_scope", "More than eight explicit scope paths require Deep execution."]);
  return reasons;
}

function fastEligibility(input: ExecutionLaneInput): { eligible: boolean; reasonCodes: string[]; reasons: string[] } {
  const task = input.compiled_task;
  const blockers: Array<[string, string]> = [];
  if (task.risk_decision.level === "L2" || task.risk_decision.level === "L3") blockers.push(["external_or_critical_risk", "External or critical risk is not eligible for Fast execution."]);
  if (hasSignal(task.risk_decision, "security_boundary_change")) blockers.push(["security_boundary", "Security-boundary changes are not eligible for Fast execution."]);
  if (criticalControlPlanePaths(task).length) blockers.push(["critical_control_plane", "Core state-machine or execution-control changes are not eligible for Fast execution."]);
  if (publicContractPaths(task).length) blockers.push(["public_contract", "Public type or schema changes require at least Standard compatibility validation."]);
  if (task.capabilities.use_browser) blockers.push(["browser_required", "Browser tasks are not eligible for Fast execution."]);
  if (task.capabilities.use_network) blockers.push(["network_required", "Network-dependent tasks are not eligible for Fast execution."]);
  if (task.capabilities.use_git) blockers.push(["git_required", "Git mutation tasks are not eligible for Fast execution."]);
  if (task.capabilities.write_database) blockers.push(["database_write", "Database writes are not eligible for Fast execution."]);
  if (task.source_write_policy === "workspace") blockers.push(["workspace_scope", "Workspace-scale writes are not eligible for Fast execution."]);
  if (task.capabilities.write_source && (task.scope.length === 0 || task.scope.length > 2)) blockers.push(["source_scope_not_small", "Fast source changes require one or two explicit scope paths."]);
  const pureReadOnly = isPureReadOnlyTask(task);
  const minimumConfidence = task.capabilities.write_artifacts && !task.capabilities.write_source ? 0.7 : 0.75;
  if (!pureReadOnly && task.confidence < minimumConfidence) {
    blockers.push(["compiler_confidence", `Compiler confidence below ${minimumConfidence.toFixed(2)} is not eligible for Fast execution.`]);
  }
  if (input.acceptance_count > 3) blockers.push(["acceptance_scope", "More than three acceptance clauses are not eligible for Fast execution."]);
  if (input.explicit_review_required) blockers.push(["explicit_review", "Explicit review requirements are not eligible for Fast execution."]);
  if (!["read_only_review", "archive_report", "code_patch", "memory_candidate"].includes(input.route_mode)) {
    blockers.push(["route_not_fast", `Task route ${input.route_mode} is not on the Fast allowlist.`]);
  }
  return {
    eligible: blockers.length === 0,
    reasonCodes: blockers.map(([code]) => code),
    reasons: blockers.map(([, reason]) => reason)
  };
}

export function decideExecutionLane(input: ExecutionLaneInput): ExecutionLaneDecision {
  if (input.route_mode === "git_finalize" || input.route_mode === "git_push_only") {
    const lane: ExecutionLane = "finalization";
    return {
      version: 1,
      enabled: true,
      lane,
      forced_deep: false,
      fast_eligible: false,
      reason_codes: ["git_finalization_lane"],
      reasons: ["Git finalization uses deterministic Acceptance-receipt and workspace checks instead of a normal engineering execution lane."],
      reasoning_effort: "low",
      acceptance_profile: "targeted",
      reviewer_mode: "deterministic",
      risk_decision: input.compiled_task.risk_decision,
      scope_size: input.compiled_task.scope.length,
      escalation_only: true
    };
  }
  const enabled = input.enabled ?? true;
  if (!enabled) {
    const lane: ExecutionLane = "standard";
    return {
      version: 1,
      enabled: false,
      lane,
      forced_deep: false,
      fast_eligible: false,
      reason_codes: ["execution_lanes_disabled"],
      reasons: ["Execution lanes are disabled; Standard compatibility behavior is active."],
      reasoning_effort: strongerReasoning(laneReasoning(lane), input.explicit_reasoning_effort),
      acceptance_profile: acceptanceProfile(lane, input.route_mode, input.compiled_task),
      reviewer_mode: "conditional",
      risk_decision: input.compiled_task.risk_decision,
      scope_size: input.compiled_task.scope.length,
      escalation_only: true
    };
  }

  const deep = deepReasons(input);
  const fast = fastEligibility(input);
  const lane: ExecutionLane = deep.length ? "deep" : fast.eligible ? "fast" : "standard";
  const reasons = deep.length
    ? deep
    : fast.eligible
      ? [["fast_allowlist", "Task satisfies the Fast execution allowlist."]] as Array<[string, string]>
      : unique(fast.reasonCodes.map((code, index) => `${code}\u0000${fast.reasons[index]}`)).map((value) => {
          const [code, reason] = value.split("\u0000");
          return [code, reason] as [string, string];
        });
  return {
    version: 1,
    enabled: true,
    lane,
    forced_deep: deep.length > 0,
    fast_eligible: fast.eligible,
    reason_codes: reasons.map(([code]) => code),
    reasons: reasons.map(([, reason]) => reason),
    reasoning_effort: strongerReasoning(laneReasoning(lane), input.explicit_reasoning_effort),
    acceptance_profile: acceptanceProfile(lane, input.route_mode, input.compiled_task),
    reviewer_mode: reviewerMode(lane),
    risk_decision: input.compiled_task.risk_decision,
    scope_size: input.compiled_task.scope.length,
    escalation_only: true
  };
}

export function escalateExecutionLane(input: ExecutionLaneEscalationInput): ExecutionLaneDecision {
  const changedScope = unique(input.changed_files);
  const actualTask: CompiledTask = {
    ...input.compiled_task,
    scope: changedScope.length ? changedScope : input.compiled_task.scope,
    risk_decision: input.risk_decision
  };
  const candidate = decideExecutionLane({
    compiled_task: actualTask,
    route_mode: input.route_mode,
    acceptance_count: input.acceptance_count,
    explicit_review_required: input.explicit_review_required,
    explicit_reasoning_effort: input.previous.reasoning_effort,
    enabled: input.previous.enabled
  });
  if (LANE_RANK[candidate.lane] <= LANE_RANK[input.previous.lane]) return input.previous;
  return {
    ...candidate,
    escalated_from: input.previous.lane,
    reason_codes: unique([...input.previous.reason_codes, "runtime_scope_or_risk_escalation", ...candidate.reason_codes]),
    reasons: unique([...input.previous.reasons, "Runtime scope or risk expanded; lane escalation is one-way.", ...candidate.reasons]),
    reasoning_effort: strongerReasoning(candidate.reasoning_effort, input.previous.reasoning_effort),
    reviewer_mode: REVIEW_RANK[candidate.reviewer_mode] >= REVIEW_RANK[input.previous.reviewer_mode]
      ? candidate.reviewer_mode
      : input.previous.reviewer_mode
  };
}

export function shouldRunModelReview(
  decision: ExecutionLaneDecision,
  input: {
    reviewer_available: boolean;
    explicit_review_items: boolean;
    minimal_change_decision?: string;
    acceptance_blocking_passed: boolean;
    changes_observed?: boolean;
  }
): { run: boolean; reason_code: string; reason: string } {
  if (decision.reviewer_mode === "required") {
    return input.reviewer_available
      ? { run: true, reason_code: "review_required_by_deep_lane", reason: "Deep execution requires model review." }
      : { run: false, reason_code: "review_required_but_unavailable", reason: "Deep execution requires model review, but no reviewer is available." };
  }
  if (decision.reviewer_mode === "deterministic") {
    return { run: false, reason_code: "deterministic_review_sufficient", reason: "Fast execution uses deterministic validation and scope checks." };
  }
  const scopeUncertainty = input.changes_observed !== false && (
    input.minimal_change_decision === "scope_exceeded"
    || input.minimal_change_decision === "insufficient_missing_changes"
    || input.minimal_change_decision === "not_assessable"
  );
  const conditionalTrigger = input.explicit_review_items
    || !input.acceptance_blocking_passed
    || scopeUncertainty;
  if (!conditionalTrigger) {
    return { run: false, reason_code: "conditional_review_not_triggered", reason: "Standard execution has no unresolved condition requiring model review." };
  }
  return input.reviewer_available
    ? { run: true, reason_code: "conditional_review_triggered", reason: "Standard execution triggered model review due to acceptance or scope uncertainty." }
    : { run: false, reason_code: "conditional_review_unavailable", reason: "Conditional model review was triggered, but no reviewer is available." };
}
