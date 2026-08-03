import { createHash, randomUUID } from "node:crypto";
import { normalizeLoopBudget, type LoopBudget } from "../workflow/loopPolicy.js";

export type GoalContractAmendmentSource = "user" | "plan" | "operator" | "compatibility";

export interface GoalContractRetryBudget extends LoopBudget {
  max_attempts: number;
  max_retries: number;
}

export interface GoalContractScopeV1 {
  include: string[];
  exclude: string[];
}

export interface GoalContractPermissionsV1 {
  source_edit: boolean;
  migration: boolean;
  local_record: boolean;
  remote_sync: boolean;
  production_change: boolean;
}

export interface GoalContractExecutionV1 {
  profile: string;
  priority: "urgent" | "normal" | "background";
  browser_verification: boolean;
  retry_policy: string;
}

export interface GoalContractCompletionV1 {
  diff_required: boolean;
  acceptance_report_required: boolean;
  notify_on: string[];
}

export interface GoalContractV1 {
  schema_version: 1;
  goal_id: string;
  task_id: string;
  project_id: string;
  workspace_id: string;
  contract_version: number;
  objective: string;
  scope: GoalContractScopeV1;
  permissions: GoalContractPermissionsV1;
  execution: GoalContractExecutionV1;
  completion: GoalContractCompletionV1;
  original_instruction_ref: string;
  workspace_root: string;
  baseline_git_sha: string;
  plan_path: string | null;
  plan_sha256: string | null;
  allowed_paths: string[];
  forbidden_paths: string[];
  required_acceptance: string[];
  optional_acceptance: string[];
  tool_permissions: Record<string, boolean>;
  side_effect_permissions: Record<string, boolean>;
  commit_policy: string;
  push_policy: string;
  deploy_policy: string;
  database_policy: string;
  retry_budget: GoalContractRetryBudget;
  stop_conditions: string[];
  deliverables: string[];
  completion_rule: string;
  amended_from_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface GoalContractInput {
  task_id?: string;
  project_id?: string;
  workspace_id?: string;
  scope?: Partial<GoalContractScopeV1>;
  permissions?: Partial<GoalContractPermissionsV1>;
  execution?: Partial<GoalContractExecutionV1>;
  completion?: Partial<GoalContractCompletionV1>;
  original_instruction_ref?: string;
  baseline_git_sha?: string;
  plan_path?: string | null;
  plan_sha256?: string | null;
  allowed_paths?: string[];
  forbidden_paths?: string[];
  required_acceptance?: string[];
  optional_acceptance?: string[];
  tool_permissions?: Record<string, boolean>;
  side_effect_permissions?: Record<string, boolean>;
  commit_policy?: string;
  push_policy?: string;
  deploy_policy?: string;
  database_policy?: string;
  retry_budget?: Partial<GoalContractRetryBudget>;
  stop_conditions?: string[];
  deliverables?: string[];
  completion_rule?: string;
}

export interface GoalContractAmendment {
  amendment_id: string;
  source: GoalContractAmendmentSource;
  reason: string;
  from_version: number;
  to_version: number;
  previous_plan_sha256: string | null;
  next_plan_sha256: string | null;
  original_instruction_ref: string;
  created_at: string;
}

export interface GoalContractAmendmentInput {
  source: GoalContractAmendmentSource;
  reason: string;
  original_instruction_ref?: string;
  changes?: GoalContractInput & { objective?: string };
}

function uniq(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizedPermissions(value: Record<string, boolean> | undefined): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .filter(([key, item]) => Boolean(key.trim()) && typeof item === "boolean")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizedBudget(value: Partial<GoalContractRetryBudget> | undefined): GoalContractRetryBudget {
  const loopBudget = normalizeLoopBudget(value ?? {});
  return {
    ...loopBudget,
    max_attempts: loopBudget.max_attempts_per_step,
    max_retries: loopBudget.max_repair_rounds
  };
}

function normalizedPriority(value: unknown): GoalContractExecutionV1["priority"] {
  return value === "urgent" || value === "background" ? value : "normal";
}

export function sha256Reference(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function goalContractFingerprint(contract: GoalContractV1): string {
  return sha256Reference(JSON.stringify(contract));
}

export function compileGoalContract(input: {
  goal_id: string;
  objective: string;
  workspace_root: string;
  baseline_git_sha: string;
  original_instruction_ref: string;
  required_acceptance: string[];
  optional_acceptance: string[];
  created_at: string;
  contract?: GoalContractInput;
}): GoalContractV1 {
  const contract = input.contract ?? {};
  const allowedPaths = uniq(contract.allowed_paths);
  const forbiddenPaths = uniq(contract.forbidden_paths);
  const requiredAcceptance = uniq(contract.required_acceptance ?? input.required_acceptance);
  const optionalAcceptance = uniq(contract.optional_acceptance ?? input.optional_acceptance);
  const toolPermissions = normalizedPermissions(contract.tool_permissions);
  const sideEffectPermissions = normalizedPermissions(contract.side_effect_permissions);
  const commitPolicy = contract.commit_policy?.trim() || "manual";
  const pushPolicy = contract.push_policy?.trim() || "forbidden";
  const deployPolicy = contract.deploy_policy?.trim() || "forbidden";
  return {
    schema_version: 1,
    goal_id: input.goal_id,
    task_id: contract.task_id?.trim() || `goal-${input.goal_id}`,
    project_id: contract.project_id?.trim() || "default",
    workspace_id: contract.workspace_id?.trim() || input.workspace_root,
    contract_version: 1,
    objective: input.objective,
    scope: {
      include: uniq(contract.scope?.include ?? allowedPaths),
      exclude: uniq(contract.scope?.exclude ?? forbiddenPaths)
    },
    permissions: {
      source_edit: contract.permissions?.source_edit ?? toolPermissions.write_source === true,
      migration: contract.permissions?.migration ?? contract.database_policy === "explicit",
      local_record: contract.permissions?.local_record ?? commitPolicy !== "forbidden",
      remote_sync: contract.permissions?.remote_sync ?? pushPolicy !== "forbidden",
      production_change: contract.permissions?.production_change ?? deployPolicy !== "forbidden"
    },
    execution: {
      profile: contract.execution?.profile?.trim() || "standard",
      priority: normalizedPriority(contract.execution?.priority),
      browser_verification: contract.execution?.browser_verification ?? toolPermissions.use_browser === true,
      retry_policy: contract.execution?.retry_policy?.trim() || "bounded"
    },
    completion: {
      diff_required: contract.completion?.diff_required ?? toolPermissions.write_source === true,
      acceptance_report_required: contract.completion?.acceptance_report_required ?? requiredAcceptance.length > 0,
      notify_on: uniq(contract.completion?.notify_on)
    },
    original_instruction_ref: contract.original_instruction_ref?.trim() || input.original_instruction_ref,
    workspace_root: input.workspace_root,
    baseline_git_sha: contract.baseline_git_sha?.trim() || input.baseline_git_sha || "unknown",
    plan_path: contract.plan_path?.trim() || null,
    plan_sha256: contract.plan_sha256?.trim() || null,
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    required_acceptance: requiredAcceptance,
    optional_acceptance: optionalAcceptance,
    tool_permissions: toolPermissions,
    side_effect_permissions: sideEffectPermissions,
    commit_policy: commitPolicy,
    push_policy: pushPolicy,
    deploy_policy: deployPolicy,
    database_policy: contract.database_policy?.trim() || "forbidden",
    retry_budget: normalizedBudget(contract.retry_budget),
    stop_conditions: uniq(contract.stop_conditions),
    deliverables: uniq(contract.deliverables),
    completion_rule: contract.completion_rule?.trim() || "required_acceptance_and_review_gate",
    amended_from_version: null,
    created_at: input.created_at,
    updated_at: input.created_at
  };
}

export function compatibilityGoalContract(input: {
  goal_id: string;
  objective: string;
  workspace_root: string;
  created_at: string;
  acceptance_ids: string[];
}): GoalContractV1 {
  return compileGoalContract({
    goal_id: input.goal_id,
    objective: input.objective,
    workspace_root: input.workspace_root,
    baseline_git_sha: "unknown",
    original_instruction_ref: `legacy:${sha256Reference(`${input.goal_id}:${input.objective}:${input.created_at}`)}`,
    required_acceptance: input.acceptance_ids,
    optional_acceptance: [],
    created_at: input.created_at,
    contract: {
      tool_permissions: {
        read_workspace: true,
        write_source: false,
        write_artifacts: false,
        run_bash: false,
        use_browser: false
      },
      side_effect_permissions: {
        local_write: false,
        external_write: false,
        network: false
      },
      stop_conditions: ["Explicit contract amendment required before expanding scope or permissions."],
      completion_rule: "required_acceptance_and_review_gate"
    }
  });
}

export function amendGoalContract(
  current: GoalContractV1,
  input: GoalContractAmendmentInput,
  now = new Date().toISOString()
): { contract: GoalContractV1; amendment: GoalContractAmendment } {
  const reason = input.reason.trim();
  if (!reason) throw new Error("Goal Contract amendment reason cannot be empty.");
  const changes = input.changes ?? {};
  const nextVersion = current.contract_version + 1;
  const currentScope = current.scope ?? { include: current.allowed_paths ?? [], exclude: current.forbidden_paths ?? [] };
  const currentPermissions = current.permissions ?? {
    source_edit: current.tool_permissions?.write_source === true,
    migration: current.database_policy === "explicit",
    local_record: current.commit_policy !== "forbidden",
    remote_sync: current.push_policy !== "forbidden",
    production_change: current.deploy_policy !== "forbidden"
  };
  const currentExecution = current.execution ?? {
    profile: "standard",
    priority: "normal" as const,
    browser_verification: current.tool_permissions?.use_browser === true,
    retry_policy: "bounded"
  };
  const currentCompletion = current.completion ?? {
    diff_required: current.tool_permissions?.write_source === true,
    acceptance_report_required: (current.required_acceptance ?? []).length > 0,
    notify_on: []
  };
  const next: GoalContractV1 = {
    ...structuredClone(current),
    contract_version: nextVersion,
    task_id: changes.task_id?.trim() || current.task_id || `goal-${current.goal_id}`,
    project_id: changes.project_id?.trim() || current.project_id || "default",
    workspace_id: changes.workspace_id?.trim() || current.workspace_id || current.workspace_root,
    objective: changes.objective?.trim() || current.objective,
    scope: {
      include: changes.scope?.include === undefined ? currentScope.include : uniq(changes.scope.include),
      exclude: changes.scope?.exclude === undefined ? currentScope.exclude : uniq(changes.scope.exclude)
    },
    permissions: {
      source_edit: changes.permissions?.source_edit ?? currentPermissions.source_edit,
      migration: changes.permissions?.migration ?? currentPermissions.migration,
      local_record: changes.permissions?.local_record ?? currentPermissions.local_record,
      remote_sync: changes.permissions?.remote_sync ?? currentPermissions.remote_sync,
      production_change: changes.permissions?.production_change ?? currentPermissions.production_change
    },
    execution: {
      profile: changes.execution?.profile?.trim() || currentExecution.profile,
      priority: changes.execution?.priority === undefined ? currentExecution.priority : normalizedPriority(changes.execution.priority),
      browser_verification: changes.execution?.browser_verification ?? currentExecution.browser_verification,
      retry_policy: changes.execution?.retry_policy?.trim() || currentExecution.retry_policy
    },
    completion: {
      diff_required: changes.completion?.diff_required ?? currentCompletion.diff_required,
      acceptance_report_required: changes.completion?.acceptance_report_required ?? currentCompletion.acceptance_report_required,
      notify_on: changes.completion?.notify_on === undefined ? currentCompletion.notify_on : uniq(changes.completion.notify_on)
    },
    original_instruction_ref: input.original_instruction_ref?.trim()
      || changes.original_instruction_ref?.trim()
      || current.original_instruction_ref,
    baseline_git_sha: changes.baseline_git_sha?.trim() || current.baseline_git_sha,
    plan_path: changes.plan_path === undefined ? current.plan_path : changes.plan_path?.trim() || null,
    plan_sha256: changes.plan_sha256 === undefined ? current.plan_sha256 : changes.plan_sha256?.trim() || null,
    allowed_paths: changes.allowed_paths === undefined ? current.allowed_paths : uniq(changes.allowed_paths),
    forbidden_paths: changes.forbidden_paths === undefined ? current.forbidden_paths : uniq(changes.forbidden_paths),
    required_acceptance: changes.required_acceptance === undefined ? current.required_acceptance : uniq(changes.required_acceptance),
    optional_acceptance: changes.optional_acceptance === undefined ? current.optional_acceptance : uniq(changes.optional_acceptance),
    tool_permissions: changes.tool_permissions === undefined ? current.tool_permissions : normalizedPermissions(changes.tool_permissions),
    side_effect_permissions: changes.side_effect_permissions === undefined
      ? current.side_effect_permissions
      : normalizedPermissions(changes.side_effect_permissions),
    commit_policy: changes.commit_policy?.trim() || current.commit_policy,
    push_policy: changes.push_policy?.trim() || current.push_policy,
    deploy_policy: changes.deploy_policy?.trim() || current.deploy_policy,
    database_policy: changes.database_policy?.trim() || current.database_policy,
    retry_budget: changes.retry_budget === undefined
      ? current.retry_budget
      : normalizedBudget({ ...current.retry_budget, ...changes.retry_budget }),
    stop_conditions: changes.stop_conditions === undefined ? current.stop_conditions : uniq(changes.stop_conditions),
    deliverables: changes.deliverables === undefined ? current.deliverables : uniq(changes.deliverables),
    completion_rule: changes.completion_rule?.trim() || current.completion_rule,
    amended_from_version: current.contract_version,
    updated_at: now
  };
  const amendment: GoalContractAmendment = {
    amendment_id: randomUUID(),
    source: input.source,
    reason,
    from_version: current.contract_version,
    to_version: nextVersion,
    previous_plan_sha256: current.plan_sha256,
    next_plan_sha256: next.plan_sha256,
    original_instruction_ref: next.original_instruction_ref,
    created_at: now
  };
  return { contract: next, amendment };
}
