export const GOLD_TASK_CATEGORIES = [
  "exact_code_change",
  "root_cause_investigation",
  "cross_module_refactor",
  "test_and_regression",
  "browser_task",
  "git_delivery",
  "interruption_recovery",
  "business_data_task"
] as const;

export type GoldTaskCategory = (typeof GOLD_TASK_CATEGORIES)[number];
export type GoldTaskOutcome = "passed" | "failed" | "blocked" | "cancelled";
export type BenchmarkProtocolStatus = "not_applicable" | "compliant" | "violated";

export interface GoldTaskDefinitionV1 {
  task_id: string;
  title: string;
  category: GoldTaskCategory;
  status: "frozen";
  source: {
    captured_at: string;
    provenance: "conversation" | "execution_contract" | "acceptance_report";
    reference: string | null;
    instructions: string[];
  };
  repository: {
    baseline_commit: string;
    reference_result_commit: string;
  };
  acceptance_requirements: string[];
  forbidden_scope: string[];
  reference_solution: {
    key_facts: string[];
    changed_paths: string[];
    validation_commands: string[];
    evaluator_validation_paths: string[];
    change_scope_mode: "exact" | "behavioral";
    evidence_paths: string[];
  };
  constraints: {
    max_tool_calls: number;
    max_wall_clock_ms: number;
    human_intervention_allowed: boolean;
    external_network_allowed: boolean;
    model_delegation_allowed: boolean;
    allowed_side_effects: string[];
  };
  expected_completion_proof: {
    required: boolean;
    evidence_kinds: string[];
  };
}

export interface GoldTaskManifestV1 {
  version: 1;
  suite_id: string;
  title: string;
  frozen_at: string;
  target_task_count: number;
  task_mix: Record<GoldTaskCategory, number>;
  replay_input_gaps: Array<{
    task_id: string;
    reason: string;
    required_paths: string[];
  }>;
  tasks: GoldTaskDefinitionV1[];
}

export interface GoldTaskResultV1 {
  task_id: string;
  attempt: number;
  started_at: string;
  finished_at: string;
  outcome: GoldTaskOutcome;
  acceptance_passed: boolean;
  completion_proof_verified: boolean;
  wrong_change_detected: boolean;
  false_completion_detected: boolean;
  human_intervention_count: number;
  tool_call_count: number;
  wall_clock_duration_ms: number;
  irrelevant_context_bytes: number | null;
  recovery_attempted: boolean;
  recovery_succeeded: boolean | null;
  duplicate_side_effect_count: number;
  unauthorized_side_effect_count: number;
  external_network_call_count: number;
  codex_cli_invocation_count: number;
  api_key_use_count: number;
  zero_model_policy_verified: boolean;
  failure_classification: string | null;
  stop_reason: string | null;
  last_progress_at: string | null;
  supervisor_terminated: boolean;
  tree_terminated: boolean;
  completion_check_passed: boolean;
  evidence_paths: string[];
  usage_entry_ids: string[];
  execution_origin_receipt_paths: string[];
}

export interface GoldTaskSuiteRunV1 {
  version: 1;
  suite_run_id: string;
  suite_id: string;
  measurement_phase: "baseline" | "candidate";
  runtime_version: string;
  git_sha: string;
  started_at: string;
  finished_at: string;
  task_results: GoldTaskResultV1[];
}

export interface GoldTaskAggregateMetricsV1 {
  attempted_task_count: number;
  task_execution_count: number;
  attempt_count: number;
  first_pass_success_rate: number | null;
  final_success_rate: number | null;
  wrong_change_rate: number | null;
  false_completion_rate: number | null;
  human_intervention_count: number;
  tool_call_count: number;
  wall_clock_duration_ms: number;
  irrelevant_context_bytes: number | null;
  irrelevant_context_measured_attempt_count: number;
  recovery_success_rate: number | null;
  recovery_attempt_count: number;
  duplicate_side_effect_count: number;
  unauthorized_side_effect_count: number;
  external_network_call_count: number;
  codex_cli_invocation_count: number;
  api_key_use_count: number;
  zero_model_policy_violation_count: number;
  final_constraint_violation_count: number;
}

export interface GoldTaskBaselineReportV1 {
  version: 1;
  suite_id: string;
  generated_at: string;
  measurement_status: "not_started" | "partial" | "complete";
  integrity: {
    manifest_valid: true;
    reference_git_chain_verified_task_count: number;
    source_reference_verified_task_count: number;
    reference_evidence_path_verified_count: number;
    reference_commits_are_scores: false;
  };
  coverage: {
    target_task_count: number;
    frozen_task_count: number;
    remaining_to_freeze_count: number;
    replay_ready_task_count: number;
    replay_blocked_task_count: number;
    suite_run_count: number;
    measured_task_count: number;
    remaining_to_measure_count: number;
  };
  metrics: GoldTaskAggregateMetricsV1;
  targets: {
    final_success_rate_minimum: number;
    false_completion_rate_maximum: number;
    wrong_change_rate_maximum: number;
    duplicate_side_effect_count_maximum: number;
    codex_cli_invocation_count_maximum: number;
    api_key_use_count_maximum: number;
    recovery_success_rate_minimum: number;
  };
  notes: string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as UnknownRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${label} must be an ISO timestamp.`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function strings(value: unknown, label: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${label} must contain at least ${minimum} string(s).`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function sha(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[a-f0-9]{40}$/i.test(parsed)) throw new Error(`${label} must be a full 40-character Git SHA.`);
  return parsed.toLowerCase();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function parseTask(value: unknown, index: number): GoldTaskDefinitionV1 {
  const label = `manifest.tasks[${index}]`;
  const item = record(value, label);
  const source = record(item.source, `${label}.source`);
  const repository = record(item.repository, `${label}.repository`);
  const reference = record(item.reference_solution, `${label}.reference_solution`);
  const constraints = record(item.constraints, `${label}.constraints`);
  const proof = record(item.expected_completion_proof, `${label}.expected_completion_proof`);
  const baselineCommit = sha(repository.baseline_commit, `${label}.repository.baseline_commit`);
  const resultCommit = sha(repository.reference_result_commit, `${label}.repository.reference_result_commit`);
  if (baselineCommit === resultCommit) throw new Error(`${label} must use different baseline and reference result commits.`);
  const changedPaths = strings(reference.changed_paths, `${label}.reference_solution.changed_paths`, 1);
  const validationCommands = strings(reference.validation_commands, `${label}.reference_solution.validation_commands`, 1);
  const evaluatorValidationPaths = strings(
    reference.evaluator_validation_paths ?? [],
    `${label}.reference_solution.evaluator_validation_paths`
  );
  for (const validationPath of evaluatorValidationPaths) {
    if (!validationCommands.some((command) => command.includes(validationPath))) {
      throw new Error(`${label}.reference_solution.evaluator_validation_paths is not referenced by a validation command: ${validationPath}.`);
    }
  }

  return {
    task_id: text(item.task_id, `${label}.task_id`),
    title: text(item.title, `${label}.title`),
    category: enumValue(item.category, GOLD_TASK_CATEGORIES, `${label}.category`),
    status: enumValue(item.status, ["frozen"] as const, `${label}.status`),
    source: {
      captured_at: timestamp(source.captured_at, `${label}.source.captured_at`),
      provenance: enumValue(
        source.provenance,
        ["conversation", "execution_contract", "acceptance_report"] as const,
        `${label}.source.provenance`
      ),
      reference: source.reference === null ? null : text(source.reference, `${label}.source.reference`),
      instructions: strings(source.instructions, `${label}.source.instructions`, 1)
    },
    repository: { baseline_commit: baselineCommit, reference_result_commit: resultCommit },
    acceptance_requirements: strings(item.acceptance_requirements, `${label}.acceptance_requirements`, 1),
    forbidden_scope: strings(item.forbidden_scope, `${label}.forbidden_scope`, 1),
    reference_solution: {
      key_facts: strings(reference.key_facts, `${label}.reference_solution.key_facts`, 1),
      changed_paths: changedPaths,
      validation_commands: validationCommands,
      evaluator_validation_paths: evaluatorValidationPaths,
      change_scope_mode: reference.change_scope_mode === undefined
        ? "exact"
        : enumValue(reference.change_scope_mode, ["exact", "behavioral"] as const, `${label}.reference_solution.change_scope_mode`),
      evidence_paths: strings(reference.evidence_paths, `${label}.reference_solution.evidence_paths`)
    },
    constraints: {
      max_tool_calls: integer(constraints.max_tool_calls, `${label}.constraints.max_tool_calls`, 1),
      max_wall_clock_ms: integer(constraints.max_wall_clock_ms, `${label}.constraints.max_wall_clock_ms`, 1),
      human_intervention_allowed: boolean(constraints.human_intervention_allowed, `${label}.constraints.human_intervention_allowed`),
      external_network_allowed: boolean(constraints.external_network_allowed, `${label}.constraints.external_network_allowed`),
      model_delegation_allowed: boolean(constraints.model_delegation_allowed, `${label}.constraints.model_delegation_allowed`),
      allowed_side_effects: strings(constraints.allowed_side_effects, `${label}.constraints.allowed_side_effects`, 1)
    },
    expected_completion_proof: {
      required: boolean(proof.required, `${label}.expected_completion_proof.required`),
      evidence_kinds: strings(proof.evidence_kinds, `${label}.expected_completion_proof.evidence_kinds`, 1)
    }
  };
}

export function parseGoldTaskManifest(value: unknown): GoldTaskManifestV1 {
  const item = record(value, "manifest");
  if (item.version !== 1) throw new Error("manifest.version must equal 1.");
  const targetTaskCount = integer(item.target_task_count, "manifest.target_task_count", 1);
  const mixInput = record(item.task_mix, "manifest.task_mix");
  const taskMix = Object.fromEntries(
    GOLD_TASK_CATEGORIES.map((category) => [category, integer(mixInput[category], `manifest.task_mix.${category}`)])
  ) as Record<GoldTaskCategory, number>;
  const unexpectedCategories = Object.keys(mixInput).filter((key) => !GOLD_TASK_CATEGORIES.includes(key as GoldTaskCategory));
  if (unexpectedCategories.length) throw new Error(`manifest.task_mix contains unsupported categories: ${unexpectedCategories.join(", ")}.`);
  const mixTotal = Object.values(taskMix).reduce((sum, count) => sum + count, 0);
  if (mixTotal !== targetTaskCount) throw new Error("manifest.task_mix must sum to manifest.target_task_count.");
  if (!Array.isArray(item.tasks)) throw new Error("manifest.tasks must be an array.");
  const tasks = item.tasks.map(parseTask);
  if (tasks.length > targetTaskCount) throw new Error("manifest.tasks exceeds manifest.target_task_count.");
  const taskIds = tasks.map((task) => task.task_id);
  if (new Set(taskIds).size !== taskIds.length) throw new Error("manifest.tasks contains duplicate task_id values.");
  for (const category of GOLD_TASK_CATEGORIES) {
    const captured = tasks.filter((task) => task.category === category).length;
    if (captured > taskMix[category]) throw new Error(`manifest.tasks exceeds the ${category} quota.`);
  }
  if (!Array.isArray(item.replay_input_gaps)) throw new Error("manifest.replay_input_gaps must be an array.");
  const replayInputGaps = item.replay_input_gaps.map((value, index) => {
    const gap = record(value, `manifest.replay_input_gaps[${index}]`);
    const taskId = text(gap.task_id, `manifest.replay_input_gaps[${index}].task_id`);
    if (!taskIds.includes(taskId)) throw new Error(`manifest.replay_input_gaps references unknown task_id: ${taskId}.`);
    return {
      task_id: taskId,
      reason: text(gap.reason, `manifest.replay_input_gaps[${index}].reason`),
      required_paths: strings(gap.required_paths, `manifest.replay_input_gaps[${index}].required_paths`, 1)
    };
  });
  if (new Set(replayInputGaps.map((gap) => gap.task_id)).size !== replayInputGaps.length) {
    throw new Error("manifest.replay_input_gaps contains duplicate task_id values.");
  }
  return {
    version: 1,
    suite_id: text(item.suite_id, "manifest.suite_id"),
    title: text(item.title, "manifest.title"),
    frozen_at: timestamp(item.frozen_at, "manifest.frozen_at"),
    target_task_count: targetTaskCount,
    task_mix: taskMix,
    replay_input_gaps: replayInputGaps,
    tasks
  };
}

function parseTaskResult(value: unknown, index: number, taskIds: Set<string>): GoldTaskResultV1 {
  const label = `run.task_results[${index}]`;
  const item = record(value, label);
  const taskId = text(item.task_id, `${label}.task_id`);
  if (!taskIds.has(taskId)) throw new Error(`${label}.task_id is not present in the manifest: ${taskId}.`);
  const recoveryAttempted = boolean(item.recovery_attempted, `${label}.recovery_attempted`);
  const recoverySucceeded = item.recovery_succeeded === null
    ? null
    : boolean(item.recovery_succeeded, `${label}.recovery_succeeded`);
  if (recoveryAttempted !== (recoverySucceeded !== null)) {
    throw new Error(`${label}.recovery_succeeded must be boolean exactly when recovery_attempted is true.`);
  }
  const startedAt = timestamp(item.started_at, `${label}.started_at`);
  const finishedAt = timestamp(item.finished_at, `${label}.finished_at`);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error(`${label}.finished_at precedes started_at.`);
  const failureClassification = item.failure_classification === null || item.failure_classification === undefined
    ? null
    : text(item.failure_classification, `${label}.failure_classification`);
  const stopReason = item.stop_reason === null || item.stop_reason === undefined
    ? null
    : text(item.stop_reason, `${label}.stop_reason`);
  const lastProgressAt = item.last_progress_at === null || item.last_progress_at === undefined
    ? null
    : timestamp(item.last_progress_at, `${label}.last_progress_at`);
  return {
    task_id: taskId,
    attempt: integer(item.attempt, `${label}.attempt`, 1),
    started_at: startedAt,
    finished_at: finishedAt,
    outcome: enumValue(item.outcome, ["passed", "failed", "blocked", "cancelled"] as const, `${label}.outcome`),
    acceptance_passed: boolean(item.acceptance_passed, `${label}.acceptance_passed`),
    completion_proof_verified: boolean(item.completion_proof_verified, `${label}.completion_proof_verified`),
    wrong_change_detected: boolean(item.wrong_change_detected, `${label}.wrong_change_detected`),
    false_completion_detected: boolean(item.false_completion_detected, `${label}.false_completion_detected`),
    human_intervention_count: integer(item.human_intervention_count, `${label}.human_intervention_count`),
    tool_call_count: integer(item.tool_call_count, `${label}.tool_call_count`),
    wall_clock_duration_ms: integer(item.wall_clock_duration_ms, `${label}.wall_clock_duration_ms`),
    irrelevant_context_bytes: nullableInteger(item.irrelevant_context_bytes, `${label}.irrelevant_context_bytes`),
    recovery_attempted: recoveryAttempted,
    recovery_succeeded: recoverySucceeded,
    duplicate_side_effect_count: integer(item.duplicate_side_effect_count, `${label}.duplicate_side_effect_count`),
    unauthorized_side_effect_count: integer(item.unauthorized_side_effect_count, `${label}.unauthorized_side_effect_count`),
    external_network_call_count: integer(item.external_network_call_count, `${label}.external_network_call_count`),
    codex_cli_invocation_count: integer(item.codex_cli_invocation_count, `${label}.codex_cli_invocation_count`),
    api_key_use_count: integer(item.api_key_use_count, `${label}.api_key_use_count`),
    zero_model_policy_verified: boolean(item.zero_model_policy_verified, `${label}.zero_model_policy_verified`),
    failure_classification: failureClassification,
    stop_reason: stopReason,
    last_progress_at: lastProgressAt,
    supervisor_terminated: item.supervisor_terminated === undefined
      ? false
      : boolean(item.supervisor_terminated, `${label}.supervisor_terminated`),
    tree_terminated: item.tree_terminated === undefined
      ? true
      : boolean(item.tree_terminated, `${label}.tree_terminated`),
    completion_check_passed: item.completion_check_passed === undefined
      ? boolean(item.completion_proof_verified, `${label}.completion_proof_verified`)
      : boolean(item.completion_check_passed, `${label}.completion_check_passed`),
    evidence_paths: strings(item.evidence_paths, `${label}.evidence_paths`),
    usage_entry_ids: strings(item.usage_entry_ids, `${label}.usage_entry_ids`),
    execution_origin_receipt_paths: strings(item.execution_origin_receipt_paths, `${label}.execution_origin_receipt_paths`)
  };
}

export function parseGoldTaskSuiteRun(value: unknown, manifest: GoldTaskManifestV1): GoldTaskSuiteRunV1 {
  const item = record(value, "run");
  if (item.version !== 1) throw new Error("run.version must equal 1.");
  if (text(item.suite_id, "run.suite_id") !== manifest.suite_id) throw new Error("run.suite_id does not match the manifest.");
  if (!Array.isArray(item.task_results) || item.task_results.length === 0) {
    throw new Error("run.task_results must contain at least one result.");
  }
  const startedAt = timestamp(item.started_at, "run.started_at");
  const finishedAt = timestamp(item.finished_at, "run.finished_at");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("run.finished_at precedes run.started_at.");
  const results = item.task_results.map((result, index) => parseTaskResult(result, index, new Set(manifest.tasks.map((task) => task.task_id))));
  for (const result of results) {
    if (Date.parse(result.started_at) < Date.parse(startedAt) || Date.parse(result.finished_at) > Date.parse(finishedAt)) {
      throw new Error(`run.task_results timestamps for ${result.task_id} must fall within the suite run interval.`);
    }
  }
  const resultKeys = results.map((result) => `${result.task_id}:${result.attempt}`);
  if (new Set(resultKeys).size !== resultKeys.length) throw new Error("run.task_results contains duplicate task_id/attempt pairs.");
  return {
    version: 1,
    suite_run_id: text(item.suite_run_id, "run.suite_run_id"),
    suite_id: manifest.suite_id,
    measurement_phase: enumValue(item.measurement_phase, ["baseline", "candidate"] as const, "run.measurement_phase"),
    runtime_version: text(item.runtime_version, "run.runtime_version"),
    git_sha: sha(item.git_sha, "run.git_sha"),
    started_at: startedAt,
    finished_at: finishedAt,
    task_results: results
  };
}

function constraintsSatisfied(result: GoldTaskResultV1, task: GoldTaskDefinitionV1 | undefined): boolean {
  if (!task) return true;
  return result.tool_call_count <= task.constraints.max_tool_calls
    && result.wall_clock_duration_ms <= task.constraints.max_wall_clock_ms
    && (task.constraints.human_intervention_allowed || result.human_intervention_count === 0)
    && (task.constraints.external_network_allowed || result.external_network_call_count === 0)
    && (task.constraints.model_delegation_allowed || (
      result.codex_cli_invocation_count === 0
      && result.api_key_use_count === 0
      && result.zero_model_policy_verified
    ))
    && result.unauthorized_side_effect_count === 0
    && result.tree_terminated;
}

export function benchmarkProtocolStatus(
  result: GoldTaskResultV1,
  task: GoldTaskDefinitionV1 | undefined
): BenchmarkProtocolStatus {
  if (!task) return "not_applicable";
  return constraintsSatisfied(result, task) ? "compliant" : "violated";
}

function successful(result: GoldTaskResultV1, task: GoldTaskDefinitionV1 | undefined): boolean {
  return result.outcome === "passed"
    && result.acceptance_passed
    && result.completion_proof_verified
    && !result.wrong_change_detected
    && !result.false_completion_detected
    && result.duplicate_side_effect_count === 0
    && result.codex_cli_invocation_count === 0
    && result.api_key_use_count === 0
    && result.zero_model_policy_verified
    && result.completion_check_passed
    && result.tree_terminated
    && benchmarkProtocolStatus(result, task) === "compliant";
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

export function aggregateGoldTaskRuns(
  runs: readonly GoldTaskSuiteRunV1[],
  manifest?: GoldTaskManifestV1
): GoldTaskAggregateMetricsV1 {
  const attempts = runs.flatMap((run) => run.task_results.map((result) => ({ run_id: run.suite_run_id, result })));
  const groups = new Map<string, GoldTaskResultV1[]>();
  for (const entry of attempts) {
    const key = entry.result.task_id;
    const group = groups.get(key) ?? [];
    group.push(entry.result);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()].map(([taskId, group]) => {
    const ordered = group.sort((left, right) => left.attempt - right.attempt);
    const attemptNumbers = ordered.map((result) => result.attempt);
    if (new Set(attemptNumbers).size !== attemptNumbers.length) {
      throw new Error(`Gold Task runs contain duplicate attempts for ${taskId}.`);
    }
    if (attemptNumbers.some((attempt, index) => attempt !== index + 1)) {
      throw new Error(`Gold Task runs attempts for ${taskId} must be contiguous and start at 1.`);
    }
    return ordered;
  });
  const taskById = new Map(manifest?.tasks.map((task) => [task.task_id, task]) ?? []);
  const firstPassSuccesses = orderedGroups.filter((group) => successful(group[0], taskById.get(group[0].task_id))).length;
  const finalSuccesses = orderedGroups.filter((group) => successful(group[group.length - 1], taskById.get(group[0].task_id))).length;
  const finalConstraintViolations = orderedGroups.filter((group) => {
    const final = group[group.length - 1];
    return benchmarkProtocolStatus(final, taskById.get(final.task_id)) === "violated";
  }).length;
  const wrongChanges = orderedGroups.filter((group) => group.some((entry) => entry.wrong_change_detected)).length;
  const falseCompletions = orderedGroups.filter((group) => group.some((entry) => entry.false_completion_detected)).length;
  const recoveryAttempts = attempts.filter((entry) => entry.result.recovery_attempted);
  const irrelevantMeasured = attempts.filter((entry) => entry.result.irrelevant_context_bytes !== null);
  const sum = (pick: (result: GoldTaskResultV1) => number): number => attempts.reduce((total, entry) => total + pick(entry.result), 0);

  return {
    attempted_task_count: new Set(attempts.map((entry) => entry.result.task_id)).size,
    task_execution_count: orderedGroups.length,
    attempt_count: attempts.length,
    first_pass_success_rate: rate(firstPassSuccesses, orderedGroups.length),
    final_success_rate: rate(finalSuccesses, orderedGroups.length),
    wrong_change_rate: rate(wrongChanges, orderedGroups.length),
    false_completion_rate: rate(falseCompletions, orderedGroups.length),
    human_intervention_count: sum((result) => result.human_intervention_count),
    tool_call_count: sum((result) => result.tool_call_count),
    wall_clock_duration_ms: sum((result) => result.wall_clock_duration_ms),
    irrelevant_context_bytes: attempts.length > 0 && irrelevantMeasured.length === attempts.length
      ? sum((result) => result.irrelevant_context_bytes ?? 0)
      : null,
    irrelevant_context_measured_attempt_count: irrelevantMeasured.length,
    recovery_success_rate: rate(recoveryAttempts.filter((entry) => entry.result.recovery_succeeded).length, recoveryAttempts.length),
    recovery_attempt_count: recoveryAttempts.length,
    duplicate_side_effect_count: sum((result) => result.duplicate_side_effect_count),
    unauthorized_side_effect_count: sum((result) => result.unauthorized_side_effect_count),
    external_network_call_count: sum((result) => result.external_network_call_count),
    codex_cli_invocation_count: sum((result) => result.codex_cli_invocation_count),
    api_key_use_count: sum((result) => result.api_key_use_count),
    zero_model_policy_violation_count: attempts.filter((entry) => !entry.result.zero_model_policy_verified).length,
    final_constraint_violation_count: finalConstraintViolations
  };
}

export function createGoldTaskBaselineReport(
  manifest: GoldTaskManifestV1,
  runs: readonly GoldTaskSuiteRunV1[],
  verification: {
    reference_git_chain_verified_task_count: number;
    source_reference_verified_task_count: number;
    reference_evidence_path_verified_count: number;
  },
  generatedAt = new Date().toISOString()
): GoldTaskBaselineReportV1 {
  if (!Number.isInteger(verification.reference_git_chain_verified_task_count)
    || verification.reference_git_chain_verified_task_count < 0
    || verification.reference_git_chain_verified_task_count > manifest.tasks.length) {
    throw new Error("reference_git_chain_verified_task_count must be between 0 and the frozen task count.");
  }
  const sourceReferenceCount = manifest.tasks.filter((task) => task.source.reference !== null).length;
  if (!Number.isInteger(verification.source_reference_verified_task_count)
    || verification.source_reference_verified_task_count < 0
    || verification.source_reference_verified_task_count > sourceReferenceCount) {
    throw new Error("source_reference_verified_task_count must be between 0 and the declared source reference count.");
  }
  const evidencePathCount = manifest.tasks.reduce((total, task) => total + task.reference_solution.evidence_paths.length, 0);
  if (!Number.isInteger(verification.reference_evidence_path_verified_count)
    || verification.reference_evidence_path_verified_count < 0
    || verification.reference_evidence_path_verified_count > evidencePathCount) {
    throw new Error("reference_evidence_path_verified_count must be between 0 and the declared evidence path count.");
  }
  const metrics = aggregateGoldTaskRuns(runs, manifest);
  const measuredTaskCount = metrics.attempted_task_count;
  const complete = manifest.tasks.length === manifest.target_task_count && measuredTaskCount === manifest.target_task_count;
  const measurementStatus = measuredTaskCount === 0 ? "not_started" : complete ? "complete" : "partial";
  return {
    version: 1,
    suite_id: manifest.suite_id,
    generated_at: timestamp(generatedAt, "report.generated_at"),
    measurement_status: measurementStatus,
    integrity: {
      manifest_valid: true,
      ...verification,
      reference_commits_are_scores: false
    },
    coverage: {
      target_task_count: manifest.target_task_count,
      frozen_task_count: manifest.tasks.length,
      remaining_to_freeze_count: manifest.target_task_count - manifest.tasks.length,
      replay_ready_task_count: manifest.tasks.length - manifest.replay_input_gaps.length,
      replay_blocked_task_count: manifest.replay_input_gaps.length,
      suite_run_count: runs.length,
      measured_task_count: measuredTaskCount,
      remaining_to_measure_count: manifest.target_task_count - measuredTaskCount
    },
    metrics,
    targets: {
      final_success_rate_minimum: 0.8,
      false_completion_rate_maximum: 0,
      wrong_change_rate_maximum: 0,
      duplicate_side_effect_count_maximum: 0,
      codex_cli_invocation_count_maximum: 0,
      api_key_use_count_maximum: 0,
      recovery_success_rate_minimum: 0.9
    },
    notes: [
      "Reference result commits are answer keys and Git integrity evidence, not measured baseline outcomes.",
      ...(measuredTaskCount === 0 ? ["Rates remain null until at least one standardized suite run record exists."] : []),
      `${manifest.replay_input_gaps.length} frozen task(s) require non-leaking input snapshots before replay.`,
      "M1 is complete only after all 20 tasks are frozen, executed, and backed by evidence."
    ]
  };
}

function metric(value: number | null): string {
  return value === null ? "未测量" : value.toFixed(3);
}

export function renderGoldTaskBaselineMarkdown(report: GoldTaskBaselineReportV1): string {
  return `# CodexPro Gold Tasks 基线报告\n\n`
    + `- Suite：\`${report.suite_id}\`\n`
    + `- 生成时间：${report.generated_at}\n`
    + `- 测量状态：\`${report.measurement_status}\`\n`
    + `- 已冻结：${report.coverage.frozen_task_count}/${report.coverage.target_task_count}\n`
    + `- 可直接重放：${report.coverage.replay_ready_task_count}/${report.coverage.target_task_count}\n`
    + `- 等待无泄题输入快照：${report.coverage.replay_blocked_task_count}\n`
    + `- 已标准执行：${report.coverage.measured_task_count}/${report.coverage.target_task_count}\n`
    + `- 已校验参考 Git 事实链：${report.integrity.reference_git_chain_verified_task_count}/${report.coverage.frozen_task_count}\n`
    + `- 已校验历史来源引用：${report.integrity.source_reference_verified_task_count}\n`
    + `- 已校验参考证据路径：${report.integrity.reference_evidence_path_verified_count}\n\n`
    + `> 历史参考提交只是参考答案，不计作基线成绩。没有标准 Run 记录时，成功率保持“未测量”。\n\n`
    + `| 指标 | 当前值 |\n|---|---:|\n`
    + `| 首次成功率 | ${metric(report.metrics.first_pass_success_rate)} |\n`
    + `| 最终成功率 | ${metric(report.metrics.final_success_rate)} |\n`
    + `| 错误修改率 | ${metric(report.metrics.wrong_change_rate)} |\n`
    + `| 假完成率 | ${metric(report.metrics.false_completion_rate)} |\n`
    + `| 恢复成功率 | ${metric(report.metrics.recovery_success_rate)} |\n`
    + `| 人工介入次数 | ${report.metrics.human_intervention_count} |\n`
    + `| 工具调用次数 | ${report.metrics.tool_call_count} |\n`
    + `| Codex CLI 调用次数 | ${report.metrics.codex_cli_invocation_count} |\n`
    + `| API Key 使用次数 | ${report.metrics.api_key_use_count} |\n`
    + `| 重复副作用次数 | ${report.metrics.duplicate_side_effect_count} |\n`
    + `| 未授权副作用次数 | ${report.metrics.unauthorized_side_effect_count} |\n`
    + `| 外部网络调用次数 | ${report.metrics.external_network_call_count} |\n`
    + `| 最终约束违规数 | ${report.metrics.final_constraint_violation_count} |\n\n`
    + `## 判定\n\n`
    + (report.measurement_status === "complete"
      ? "20 项任务均已冻结并执行，可以进入失败分类和改造前后对比。\n"
      : `M1 未完成：还需冻结 ${report.coverage.remaining_to_freeze_count} 项，并标准执行 ${report.coverage.remaining_to_measure_count} 项。\n`);
}
