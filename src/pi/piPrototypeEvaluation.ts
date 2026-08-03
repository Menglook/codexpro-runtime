import path from "node:path";

export const PI_ALLOWED_OPERATIONS = [
  "read_worktree",
  "write_worktree",
  "edit_worktree",
  "run_tests"
] as const;

export const PI_FORBIDDEN_OPERATIONS = [
  "production_database",
  "browser_high_risk",
  "git_push",
  "send_message",
  "deploy"
] as const;

export type PiAllowedOperation = (typeof PI_ALLOWED_OPERATIONS)[number];
export type PiForbiddenOperation = (typeof PI_FORBIDDEN_OPERATIONS)[number];
export type PiPrototypeOperation = PiAllowedOperation | PiForbiddenOperation;
export type PiEvaluationDecision = "eligible_for_integration" | "continue_isolated_evaluation" | "do_not_integrate";

export interface PiPrototypeRequest {
  project_root: string;
  worktree_path: string;
  operations: PiPrototypeOperation[];
  test_commands: string[];
  state_owner: "codexpro" | "pi";
  browser_mode: "none" | "read_only" | "high_risk";
  database_mode: "none" | "read_only" | "production_write";
  git_push: boolean;
  send_messages: boolean;
  deploy: boolean;
}

export interface PiPrototypeValidation {
  allowed: boolean;
  violations: string[];
  normalized: PiPrototypeRequest;
}

export interface PiPrototypeSpec {
  version: 1;
  backend: "pi";
  mode: "isolated_worktree_dry_run";
  worktree_path: string;
  allowed_operations: PiAllowedOperation[];
  test_commands: string[];
  state_owner: "codexpro";
  completion_owner: "codexpro";
  permission_owner: "codexpro";
  browser_trust_owner: "codexpro";
  dry_run: true;
}

export interface PiEvaluationMetrics {
  attempted_tasks: number;
  completed_tasks: number;
  repeated_file_reads: number;
  model_usage_units: number;
  recovery_attempts: number;
  recovery_successes: number;
  tool_calls: number;
  tool_errors: number;
  structured_handoff_loss_rate: number;
  added_dependencies: number;
  added_processes: number;
  fault_localization_complexity: number;
  maintenance_hours_per_month: number;
}

export interface PiEvaluationInput {
  replacement_target?: "direct_executor" | "exec_adapter" | "writable_implementer";
  replaces_existing_runtime: boolean;
  codexpro_remains_state_owner: boolean;
  security_gate_violations: number;
  baseline: PiEvaluationMetrics;
  candidate: PiEvaluationMetrics;
  minimum_tasks?: number;
  minimum_completion_improvement?: number;
  maximum_maintenance_multiplier?: number;
}

export interface PiEvaluationResult {
  version: 1;
  decision: PiEvaluationDecision;
  eligible: boolean;
  reasons: string[];
  metrics: {
    baseline_completion_rate: number;
    candidate_completion_rate: number;
    completion_improvement: number;
    baseline_recovery_rate: number;
    candidate_recovery_rate: number;
    baseline_tool_error_rate: number;
    candidate_tool_error_rate: number;
    repeated_read_change: number;
    model_usage_change: number;
    handoff_loss_change: number;
    maintenance_multiplier: number | null;
  };
  thresholds: {
    minimum_tasks: number;
    minimum_completion_improvement: number;
    maximum_maintenance_multiplier: number;
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeCommands(commands: string[]): string[] {
  return unique(commands).slice(0, 20).map((command) => command.slice(0, 2_000));
}

export function validatePiPrototypeRequest(input: PiPrototypeRequest): PiPrototypeValidation {
  const normalized: PiPrototypeRequest = {
    project_root: path.resolve(input.project_root),
    worktree_path: path.resolve(input.worktree_path),
    operations: [...new Set(input.operations)],
    test_commands: safeCommands(input.test_commands),
    state_owner: input.state_owner,
    browser_mode: input.browser_mode,
    database_mode: input.database_mode,
    git_push: input.git_push,
    send_messages: input.send_messages,
    deploy: input.deploy
  };
  const violations: string[] = [];
  if (inside(normalized.project_root, normalized.worktree_path)) {
    violations.push("Pi prototype must use an isolated managed Worktree outside the control workspace.");
  }
  if (normalized.state_owner !== "codexpro") violations.push("CodexPro must remain the only task-state owner.");
  for (const operation of normalized.operations) {
    if (PI_FORBIDDEN_OPERATIONS.includes(operation as PiForbiddenOperation)) violations.push(`Forbidden Pi operation requested: ${operation}.`);
  }
  if (normalized.database_mode !== "none") violations.push("Pi prototype cannot access project databases, including read-only database access.");
  if (normalized.browser_mode !== "none") violations.push("Pi prototype cannot own Browser Bridge or perform browser actions.");
  if (normalized.git_push) violations.push("Pi prototype cannot push Git refs.");
  if (normalized.send_messages) violations.push("Pi prototype cannot send messages or notifications.");
  if (normalized.deploy) violations.push("Pi prototype cannot deploy or publish.");
  if (!normalized.operations.length) violations.push("Pi prototype must declare at least one bounded Worktree operation.");
  if (normalized.operations.some((operation) => operation === "run_tests") && !normalized.test_commands.length) {
    violations.push("run_tests requires at least one explicit bounded test command.");
  }
  return { allowed: violations.length === 0, violations: unique(violations), normalized };
}

export function buildPiPrototypeSpec(input: PiPrototypeRequest): PiPrototypeSpec {
  const validation = validatePiPrototypeRequest(input);
  if (!validation.allowed) throw new Error(`Pi prototype blocked: ${validation.violations.join(" | ")}`);
  return {
    version: 1,
    backend: "pi",
    mode: "isolated_worktree_dry_run",
    worktree_path: validation.normalized.worktree_path,
    allowed_operations: validation.normalized.operations as PiAllowedOperation[],
    test_commands: validation.normalized.test_commands,
    state_owner: "codexpro",
    completion_owner: "codexpro",
    permission_owner: "codexpro",
    browser_trust_owner: "codexpro",
    dry_run: true
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeMetrics(metrics: PiEvaluationMetrics): PiEvaluationMetrics {
  return {
    attempted_tasks: Math.floor(finiteNonNegative(metrics.attempted_tasks)),
    completed_tasks: Math.floor(finiteNonNegative(metrics.completed_tasks)),
    repeated_file_reads: Math.floor(finiteNonNegative(metrics.repeated_file_reads)),
    model_usage_units: finiteNonNegative(metrics.model_usage_units),
    recovery_attempts: Math.floor(finiteNonNegative(metrics.recovery_attempts)),
    recovery_successes: Math.floor(finiteNonNegative(metrics.recovery_successes)),
    tool_calls: Math.floor(finiteNonNegative(metrics.tool_calls)),
    tool_errors: Math.floor(finiteNonNegative(metrics.tool_errors)),
    structured_handoff_loss_rate: Math.min(1, finiteNonNegative(metrics.structured_handoff_loss_rate)),
    added_dependencies: Math.floor(finiteNonNegative(metrics.added_dependencies)),
    added_processes: Math.floor(finiteNonNegative(metrics.added_processes)),
    fault_localization_complexity: finiteNonNegative(metrics.fault_localization_complexity),
    maintenance_hours_per_month: finiteNonNegative(metrics.maintenance_hours_per_month)
  };
}

export function evaluatePiPrototype(input: PiEvaluationInput): PiEvaluationResult {
  const baseline = normalizeMetrics(input.baseline);
  const candidate = normalizeMetrics(input.candidate);
  const minimumTasks = Math.max(10, Math.floor(input.minimum_tasks ?? 20));
  const minimumImprovement = Math.max(0.05, input.minimum_completion_improvement ?? 0.1);
  const maxMaintenanceMultiplier = Math.max(1, input.maximum_maintenance_multiplier ?? 1.25);
  const baselineCompletion = rate(baseline.completed_tasks, baseline.attempted_tasks);
  const candidateCompletion = rate(candidate.completed_tasks, candidate.attempted_tasks);
  const baselineRecovery = rate(baseline.recovery_successes, baseline.recovery_attempts);
  const candidateRecovery = rate(candidate.recovery_successes, candidate.recovery_attempts);
  const baselineToolErrors = rate(baseline.tool_errors, baseline.tool_calls);
  const candidateToolErrors = rate(candidate.tool_errors, candidate.tool_calls);
  const maintenanceMultiplier = baseline.maintenance_hours_per_month > 0
    ? candidate.maintenance_hours_per_month / baseline.maintenance_hours_per_month
    : candidate.maintenance_hours_per_month === 0 ? 1 : null;
  const reasons: string[] = [];

  if (!input.replacement_target) reasons.push("No existing execution layer is explicitly selected for replacement.");
  if (!input.replaces_existing_runtime) reasons.push("Candidate adds a second Agent Runtime instead of replacing an existing execution layer.");
  if (!input.codexpro_remains_state_owner) reasons.push("Candidate would own task or completion state outside the CodexPro control plane.");
  if (input.security_gate_violations > 0) reasons.push(`Candidate produced ${input.security_gate_violations} security-gate violation(s).`);
  if (candidate.attempted_tasks < minimumTasks) reasons.push(`Only ${candidate.attempted_tasks} candidate tasks were measured; at least ${minimumTasks} are required.`);
  if (candidateCompletion - baselineCompletion < minimumImprovement) {
    reasons.push(`Completion improvement ${(candidateCompletion - baselineCompletion).toFixed(3)} is below required ${minimumImprovement.toFixed(3)}.`);
  }
  if (candidateRecovery < baselineRecovery) reasons.push("Candidate interruption recovery rate is below the current executor baseline.");
  if (candidateToolErrors > baselineToolErrors) reasons.push("Candidate tool-call error rate is above the current executor baseline.");
  if (candidate.structured_handoff_loss_rate > baseline.structured_handoff_loss_rate) reasons.push("Candidate structured handoff loss is worse than baseline.");
  if (candidate.added_dependencies > 0 && !input.replaces_existing_runtime) reasons.push("Candidate adds dependencies without removing the runtime it duplicates.");
  if (candidate.added_processes > 1) reasons.push("Candidate adds more than one persistent or task-scoped process.");
  if (candidate.fault_localization_complexity > baseline.fault_localization_complexity) reasons.push("Candidate increases fault-localization complexity.");
  if (maintenanceMultiplier === null || maintenanceMultiplier > maxMaintenanceMultiplier) reasons.push("Candidate maintenance cost exceeds the allowed multiplier.");

  const evidenceIncomplete = candidate.attempted_tasks < minimumTasks;
  const eligible = reasons.length === 0;
  const decision: PiEvaluationDecision = eligible
    ? "eligible_for_integration"
    : evidenceIncomplete && input.replaces_existing_runtime && input.codexpro_remains_state_owner && input.security_gate_violations === 0
      ? "continue_isolated_evaluation"
      : "do_not_integrate";
  return {
    version: 1,
    decision,
    eligible,
    reasons: unique(reasons),
    metrics: {
      baseline_completion_rate: baselineCompletion,
      candidate_completion_rate: candidateCompletion,
      completion_improvement: candidateCompletion - baselineCompletion,
      baseline_recovery_rate: baselineRecovery,
      candidate_recovery_rate: candidateRecovery,
      baseline_tool_error_rate: baselineToolErrors,
      candidate_tool_error_rate: candidateToolErrors,
      repeated_read_change: candidate.repeated_file_reads - baseline.repeated_file_reads,
      model_usage_change: candidate.model_usage_units - baseline.model_usage_units,
      handoff_loss_change: candidate.structured_handoff_loss_rate - baseline.structured_handoff_loss_rate,
      maintenance_multiplier: maintenanceMultiplier
    },
    thresholds: {
      minimum_tasks: minimumTasks,
      minimum_completion_improvement: minimumImprovement,
      maximum_maintenance_multiplier: maxMaintenanceMultiplier
    }
  };
}
