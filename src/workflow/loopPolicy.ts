import { createHash } from "node:crypto";

export const LOOP_FAILURE_CATEGORIES = [
  "implementation_error",
  "environment_error",
  "authorization_required",
  "transport_error",
  "external_state_unknown",
  "policy_denied",
  "no_progress",
  "contract_changed",
  "resource_exhausted"
] as const;

export type LoopFailureCategory = (typeof LOOP_FAILURE_CATEGORIES)[number];
export type LoopDecisionAction = "execute" | "verify" | "repair" | "wait_input" | "wait_approval" | "reconcile" | "block" | "replan" | "complete" | "stop";

export interface LoopBudget {
  max_attempts_per_step: number;
  max_repair_rounds: number;
  max_same_failure_repeats: number;
  max_full_validation_runs: number;
  max_browser_reconnects: number;
  max_elapsed_ms: number;
  max_tool_calls: number;
}

export interface LoopBudgetRemaining {
  attempts_per_step: number;
  repair_rounds: number;
  same_failure_repeats: number;
  full_validation_runs: number;
  browser_reconnects: number;
  elapsed_ms: number;
  tool_calls: number;
}

export interface LoopFailureClassification {
  category: LoopFailureCategory;
  fingerprint: string;
  retry_disposition: "retry_limited" | "wait_for_input" | "wait_for_approval" | "reconcile_before_retry" | "block" | "replan" | "stop";
  recommended_action: string;
  reason: string;
  source_code: string | null;
  source_domain: string | null;
  evidence_refs: string[];
}

export interface LoopDecision {
  action: LoopDecisionAction;
  reason: string;
  category: LoopFailureCategory | null;
  failure_fingerprint: string | null;
  retry_allowed: boolean;
  automatic_retry: boolean;
  evidence_refs: string[];
  decided_at: string;
}

export interface LoopState {
  version: 1;
  started_at: string;
  iteration: number;
  repair_rounds: number;
  tool_calls: number;
  full_validation_runs: number;
  browser_reconnects: number;
  last_failure_category: LoopFailureCategory | null;
  last_failure_fingerprint: string | null;
  same_failure_repeats: number;
  last_progress_fingerprint: string | null;
  last_progress_at: string;
  budget_remaining: LoopBudgetRemaining;
  stop_reason: string | null;
  last_decision: LoopDecision | null;
  decision_history: LoopDecision[];
}

const DEFAULT_LOOP_BUDGET: LoopBudget = {
  max_attempts_per_step: 1,
  max_repair_rounds: 0,
  max_same_failure_repeats: 2,
  max_full_validation_runs: 1,
  max_browser_reconnects: 1,
  max_elapsed_ms: 1_800_000,
  max_tool_calls: 100
};

function integer(value: unknown, fallback: number, minimum = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function unique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeLoopBudget(
  input: Partial<LoopBudget> & { max_attempts?: number; max_retries?: number } = {},
  defaults: Partial<LoopBudget> = {}
): LoopBudget {
  const fallback = { ...DEFAULT_LOOP_BUDGET, ...defaults };
  return {
    max_attempts_per_step: integer(input.max_attempts_per_step ?? input.max_attempts, fallback.max_attempts_per_step, 1),
    max_repair_rounds: integer(input.max_repair_rounds ?? input.max_retries, fallback.max_repair_rounds),
    max_same_failure_repeats: integer(input.max_same_failure_repeats, fallback.max_same_failure_repeats, 1),
    max_full_validation_runs: integer(input.max_full_validation_runs, fallback.max_full_validation_runs),
    max_browser_reconnects: integer(input.max_browser_reconnects, fallback.max_browser_reconnects),
    max_elapsed_ms: integer(input.max_elapsed_ms, fallback.max_elapsed_ms, 1),
    max_tool_calls: integer(input.max_tool_calls, fallback.max_tool_calls, 1)
  };
}

export function loopBudgetRemaining(state: LoopState, budget: LoopBudget, now = new Date().toISOString(), attempts = 0): LoopBudgetRemaining {
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(state.started_at));
  return {
    attempts_per_step: Math.max(0, budget.max_attempts_per_step - attempts),
    repair_rounds: Math.max(0, budget.max_repair_rounds - state.repair_rounds),
    same_failure_repeats: Math.max(0, budget.max_same_failure_repeats - state.same_failure_repeats),
    full_validation_runs: Math.max(0, budget.max_full_validation_runs - state.full_validation_runs),
    browser_reconnects: Math.max(0, budget.max_browser_reconnects - state.browser_reconnects),
    elapsed_ms: Math.max(0, budget.max_elapsed_ms - elapsed),
    tool_calls: Math.max(0, budget.max_tool_calls - state.tool_calls)
  };
}

export function createLoopState(input: Partial<LoopBudget> & { max_attempts?: number; max_retries?: number } = {}, now = new Date().toISOString()): LoopState {
  const budget = normalizeLoopBudget(input);
  const state = {
    version: 1 as const,
    started_at: now,
    iteration: 0,
    repair_rounds: 0,
    tool_calls: 0,
    full_validation_runs: 0,
    browser_reconnects: 0,
    last_failure_category: null,
    last_failure_fingerprint: null,
    same_failure_repeats: 0,
    last_progress_fingerprint: null,
    last_progress_at: now,
    budget_remaining: {} as LoopBudgetRemaining,
    stop_reason: null,
    last_decision: null,
    decision_history: []
  } satisfies LoopState;
  state.budget_remaining = loopBudgetRemaining(state, budget, now);
  return state;
}

export function loopProgressFingerprint(input: { status?: string; phase?: string; changed_files?: string[]; evidence_ids?: string[]; contract_version?: number }): string {
  return hash(JSON.stringify({
    status: input.status ?? null,
    phase: input.phase ?? null,
    changed_files: unique(input.changed_files).sort(),
    evidence_ids: unique(input.evidence_ids).sort(),
    contract_version: input.contract_version ?? null
  }));
}

export interface ClassifyLoopFailureInput {
  code?: string;
  message?: string;
  failure_domain?: string;
  status?: string;
  policy_layer?: string;
  sandbox_mode?: string;
  side_effect_level?: "read_only" | "local_write" | "external_write" | "unknown";
  non_idempotent?: boolean;
  contract_changed?: boolean;
  external_state_unknown?: boolean;
  evidence_refs?: string[];
}

function normalizedText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d{4,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyLoopFailure(input: ClassifyLoopFailureInput): LoopFailureClassification {
  const code = normalizedText(input.code);
  const message = normalizedText(input.message);
  const domain = normalizedText(input.failure_domain);
  const status = normalizedText(input.status);
  const policy = normalizedText(input.policy_layer);
  const combined = [code, message, domain, status, policy].filter(Boolean).join(" ");
  let category: LoopFailureCategory;

  if (input.contract_changed || matches(combined, [/contract[_\s-]?changed/, /plan hash/, /contract version/])) {
    category = "contract_changed";
  } else if (input.external_state_unknown) {
    category = "external_state_unknown";
  } else if (matches(combined, [/blocked[_\s-]?by[_\s-]?(?:bash|resource)[_\s-]?policy/, /policy[_\s-]?(?:denied|blocked)/, /allowlist/, /cpu[_\s-]?resource[_\s-]?policy/, /risk gate blocked/])) {
    category = "policy_denied";
  } else if (matches(combined, [/auth[_\s-]?(?:required|failed)/, /authorization[_\s-]?required/, /approval[_\s-]?required/, /login required/, /not authenticated/])) {
    category = "authorization_required";
  } else if (matches(combined, [/resource[_\s-]?exhausted/, /quota[_\s-]?exhausted/, /rate[_\s-]?limited/, /budget[_\s-]?(?:exhausted|exceeded)/, /tool call budget/, /elapsed time budget/])) {
    category = "resource_exhausted";
  } else if (matches(combined, [/no[_\s-]?progress/, /same failure repeated/, /no effective diff/, /no new evidence/])) {
    category = "no_progress";
  } else if (matches(combined, [/\b502\b/, /\b503\b/, /bad gateway/, /gateway timeout/, /timed? out/, /econnreset/, /stream disconnected/, /connection reset/, /socket hang up/, /transient[_\s-]?transport/, /network error/])) {
    const uncertain = input.non_idempotent === true
      || input.side_effect_level === "local_write"
      || input.side_effect_level === "external_write"
      || input.sandbox_mode === "workspace-write";
    category = uncertain ? "external_state_unknown" : "transport_error";
  } else if (matches(combined, [/environment[_\s-]?error/, /service (?:is )?not running/, /dependency (?:is )?missing/, /module not found/, /command not found/, /\benoent\b/, /\beconnrefused\b/, /address already in use/, /docker daemon/, /provider[_\s-]?unavailable/, /snapshot.*failed/])) {
    category = "environment_error";
  } else {
    category = "implementation_error";
  }

  const policies: Record<LoopFailureCategory, [LoopFailureClassification["retry_disposition"], string, string]> = {
    implementation_error: ["retry_limited", "repair_implementation", "A bounded, evidence-driven implementation repair may be attempted."],
    environment_error: ["wait_for_input", "repair_environment_or_block", "Repair the environment or block without unrelated source changes."],
    authorization_required: ["wait_for_approval", "wait_for_approval", "Explicit approval or login is required before continuing."],
    transport_error: ["retry_limited", "retry_from_checkpoint", "Resume from durable state without repeating confirmed work."],
    external_state_unknown: ["reconcile_before_retry", "reconcile_external_state", "Reconcile observed state before any retry."],
    policy_denied: ["block", "report_policy_block", "Report the policy decision without bypassing or automatically retrying it."],
    no_progress: ["stop", "stop_no_progress", "Stop because the same failure is repeating without meaningful progress."],
    contract_changed: ["replan", "replan_contract", "The previous execution is invalid and must be replanned."],
    resource_exhausted: ["stop", "stop_budget_exhausted", "Stop because a configured execution budget was exhausted."]
  };
  const selected = policies[category];
  return {
    category,
    fingerprint: hash(JSON.stringify({ category, code, domain, status, message })),
    retry_disposition: selected[0],
    recommended_action: selected[1],
    reason: selected[2],
    source_code: input.code?.trim() || null,
    source_domain: input.failure_domain?.trim() || null,
    evidence_refs: unique(input.evidence_refs)
  };
}

export interface EvaluateLoopPolicyInput {
  state: LoopState;
  budget: LoopBudget;
  classification?: LoopFailureClassification;
  phase?: string;
  verification_passed?: boolean;
  progress_fingerprint?: string | null;
  current_step_attempts?: number;
  now?: string;
}

function decision(
  action: LoopDecisionAction,
  reason: string,
  category: LoopFailureCategory | null,
  fingerprint: string | null,
  retryAllowed: boolean,
  automaticRetry: boolean,
  evidenceRefs: string[],
  now: string
): LoopDecision {
  return {
    action,
    reason,
    category,
    failure_fingerprint: fingerprint,
    retry_allowed: retryAllowed,
    automatic_retry: automaticRetry,
    evidence_refs: [...evidenceRefs],
    decided_at: now
  };
}

function failureDecision(classification: LoopFailureClassification, retryAllowed: boolean, automaticRetry: boolean, now: string): LoopDecision {
  const action: LoopDecisionAction = classification.category === "implementation_error"
    ? retryAllowed ? "repair" : "block"
    : classification.category === "environment_error"
      ? "wait_input"
      : classification.category === "authorization_required"
        ? "wait_approval"
        : classification.category === "transport_error"
          ? retryAllowed ? "execute" : "block"
          : classification.category === "external_state_unknown"
            ? "reconcile"
            : classification.category === "policy_denied"
              ? "block"
              : classification.category === "contract_changed"
                ? "replan"
                : "stop";
  return decision(action, classification.reason, classification.category, classification.fingerprint, retryAllowed, automaticRetry, classification.evidence_refs, now);
}

export function evaluateLoopPolicy(input: EvaluateLoopPolicyInput): LoopDecision {
  const now = input.now ?? new Date().toISOString();
  const remaining = loopBudgetRemaining(input.state, input.budget, now, input.current_step_attempts ?? 0);
  if (input.verification_passed) {
    return decision("complete", "Required verification and evidence gates passed.", null, null, false, false, [], now);
  }
  if (remaining.elapsed_ms === 0 || remaining.tool_calls === 0 || (input.current_step_attempts !== undefined && remaining.attempts_per_step === 0)) {
    const exhausted = classifyLoopFailure({
      code: "resource_exhausted",
      message: remaining.elapsed_ms === 0
        ? "Elapsed time budget exhausted."
        : remaining.tool_calls === 0
          ? "Tool call budget exhausted."
          : "Per-step attempt budget exhausted."
    });
    return failureDecision(exhausted, false, false, now);
  }
  if (!input.classification) {
    return decision(
      input.phase === "validating" || input.phase === "reviewing" ? "verify" : "execute",
      "Continue with the next admissible contract step.",
      null,
      null,
      true,
      false,
      [],
      now
    );
  }
  const classification = input.classification;
  const repeats = classification.fingerprint === input.state.last_failure_fingerprint
    ? input.state.same_failure_repeats + 1
    : 1;
  const unchangedProgress = Boolean(input.progress_fingerprint && input.progress_fingerprint === input.state.last_progress_fingerprint);
  if (
    !["authorization_required", "policy_denied", "contract_changed"].includes(classification.category)
    && (repeats >= input.budget.max_same_failure_repeats || (unchangedProgress && repeats > 1))
  ) {
    return failureDecision(classifyLoopFailure({ code: "no_progress", message: "Same failure repeated without meaningful progress." }), false, false, now);
  }
  if (classification.category === "implementation_error" && input.state.repair_rounds >= input.budget.max_repair_rounds) {
    return failureDecision(classifyLoopFailure({ code: "resource_exhausted", message: "Repair round budget exhausted." }), false, false, now);
  }
  const retryAllowed = classification.retry_disposition === "retry_limited" && remaining.attempts_per_step > 0;
  const automaticRetry = retryAllowed && classification.category === "transport_error" && input.state.repair_rounds < input.budget.max_repair_rounds;
  return failureDecision(classification, retryAllowed, automaticRetry, now);
}

export function applyLoopDecision(
  state: LoopState,
  budgetInput: Partial<LoopBudget> & { max_attempts?: number; max_retries?: number },
  loopDecision: LoopDecision,
  options: {
    progress_fingerprint?: string | null;
    tool_calls_delta?: number;
    full_validation_runs_delta?: number;
    browser_reconnects_delta?: number;
    repair_rounds_delta?: number;
    current_step_attempts?: number;
  } = {}
): LoopState {
  const budget = normalizeLoopBudget(budgetInput);
  const progressChanged = Boolean(
    options.progress_fingerprint
    && options.progress_fingerprint !== state.last_progress_fingerprint
  );
  const next: LoopState = {
    ...structuredClone(state),
    iteration: state.iteration + 1,
    repair_rounds: state.repair_rounds + integer(options.repair_rounds_delta, 0),
    tool_calls: state.tool_calls + integer(options.tool_calls_delta, 0),
    full_validation_runs: state.full_validation_runs + integer(options.full_validation_runs_delta, 0),
    browser_reconnects: state.browser_reconnects + integer(options.browser_reconnects_delta, 0),
    last_failure_category: loopDecision.category ?? state.last_failure_category,
    last_failure_fingerprint: loopDecision.failure_fingerprint ?? state.last_failure_fingerprint,
    same_failure_repeats: loopDecision.failure_fingerprint
      ? loopDecision.failure_fingerprint === state.last_failure_fingerprint
        ? state.same_failure_repeats + 1
        : 1
      : state.same_failure_repeats,
    last_progress_fingerprint: options.progress_fingerprint ?? state.last_progress_fingerprint,
    last_progress_at: progressChanged ? loopDecision.decided_at : state.last_progress_at,
    stop_reason: ["block", "replan", "stop"].includes(loopDecision.action) ? loopDecision.reason : null,
    last_decision: loopDecision,
    decision_history: [...state.decision_history, loopDecision].slice(-50),
    budget_remaining: state.budget_remaining
  };
  next.budget_remaining = loopBudgetRemaining(next, budget, loopDecision.decided_at, options.current_step_attempts ?? 0);
  return next;
}

export function recordLoopProgress(
  state: LoopState,
  budgetInput: Partial<LoopBudget> & { max_attempts?: number; max_retries?: number },
  progressFingerprint: string,
  reason: string,
  now = new Date().toISOString()
): LoopState {
  const progressed = applyLoopDecision(
    state,
    budgetInput,
    decision("execute", reason, null, null, true, false, [], now),
    { progress_fingerprint: progressFingerprint }
  );
  return {
    ...progressed,
    last_failure_category: null,
    last_failure_fingerprint: null,
    same_failure_repeats: 0,
    stop_reason: null
  };
}
