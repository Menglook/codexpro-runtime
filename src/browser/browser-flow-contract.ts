import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { agentTaskContractHash } from "../agents/completionProof.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { TOOL_LIMITS } from "../tools/toolLimits.js";
import {
  assertBrowserBusinessActionPermitted,
  assertBusinessContextMatches,
  browserBusinessActionSchema,
  browserBusinessRiskClassSchema,
  businessObjectSchema,
  isFinalBusinessAction,
  shopContextSchema,
  validateBrowserBusinessTask,
  type BrowserBusinessAction,
  type BrowserBusinessTask
} from "./browser-business-contract.js";

export const BROWSER_FLOW_VERSION = 1;
export const BROWSER_FLOW_STATE_VERSION = 1;
export const BROWSER_FLOW_RESULT_VERSION = 1;
export const BROWSER_FLOW_DEFAULT_SPACE_ID = "default";
export const BROWSER_FLOW_MAX_REPEAT_ITERATIONS = TOOL_LIMITS.browser.flow_max_repeat_iterations;

export const BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS = [
  "payment",
  "recharge",
  "checkout",
  "submit_order",
  "confirm_fulfillment",
  "cancel_order",
  "refund",
  "resend",
  "change_price",
  "change_inventory",
  "change_ad_budget",
  "change_campaign_state",
  "delete",
  "clear",
  "publish",
  "send_message",
  "send_email",
  "send_support_reply",
  "change_password",
  "change_account",
  "change_production_configuration"
] as const;

export const browserFlowStepTypeSchema = z.enum([
  "open",
  "observe",
  "observe_continue",
  "assert",
  "click",
  "input",
  "select",
  "check",
  "scroll",
  "wait",
  "extract_table",
  "extract_facts",
  "download",
  "visual_observe",
  "branch",
  "repeat_bounded",
  "handoff",
  "report"
]);
export type BrowserFlowStepType = z.infer<typeof browserFlowStepTypeSchema>;

export const browserFlowConditionSchema = z.object({
  fact_ref: z.string().trim().min(1).max(240),
  operator: z.enum(["text_contains", "url_matches", "element_exists", "element_hidden", "equals", "step_status"]),
  expected: z.unknown().optional(),
  verified: z.literal(true).default(true)
}).strict();
export type BrowserFlowCondition = z.infer<typeof browserFlowConditionSchema>;

const flowBranchCaseSchema = z.object({
  condition: browserFlowConditionSchema,
  next_step_id: z.string().trim().min(1).max(120)
}).strict();

const flowRepeatSchema = z.object({
  body_step_ids: z.array(z.string().trim().min(1).max(120)).min(1),
  max_iterations: z.number().int().min(1).max(BROWSER_FLOW_MAX_REPEAT_ITERATIONS),
  progress_fact_ref: z.string().trim().min(1).max(240)
}).strict();

export const browserFlowStepSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  type: browserFlowStepTypeSchema,
  description: z.string().trim().min(1).max(1000),
  depends_on: z.array(z.string().trim().min(1).max(120)).default([]),
  preconditions: z.array(browserFlowConditionSchema).default([]),
  allowed_actions: z.array(browserBusinessActionSchema).min(1),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  input: z.record(z.unknown()),
  branch_cases: z.array(flowBranchCaseSchema).min(1).optional(),
  repeat: flowRepeatSchema.optional()
}).strict().superRefine((step, context) => {
  if (step.type === "branch" && !step.branch_cases?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "branch steps require branch_cases." });
  }
  if (step.type !== "branch" && step.branch_cases) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "branch_cases are only valid for branch steps." });
  }
  if (step.type === "repeat_bounded" && !step.repeat) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repeat_bounded steps require repeat." });
  }
  if (step.type !== "repeat_bounded" && step.repeat) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repeat is only valid for repeat_bounded steps." });
  }
  if (["click", "input", "select", "check", "download"].includes(step.type) && step.retryable) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${step.type} steps cannot enable automatic retry.` });
  }
});
export type BrowserFlowStep = z.infer<typeof browserFlowStepSchema>;

export const browserFlowContractSchema = z.object({
  version: z.literal(BROWSER_FLOW_VERSION),
  flow_id: z.string().uuid(),
  contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  task_contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  space_id: z.string().trim().min(1),
  platform: z.string().trim().min(1),
  risk_class: browserBusinessRiskClassSchema,
  skill_ref: z.string().trim().min(1).optional(),
  steps: z.array(browserFlowStepSchema).min(1).max(200),
  success_criteria: z.array(z.string().trim().min(1)).min(1),
  permanently_blocked_actions: z.array(z.enum(BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS)).min(1),
  created_at: z.string().datetime()
}).strict();
export type BrowserFlowContract = z.infer<typeof browserFlowContractSchema>;

export const browserFlowPrepareInputSchema = z.object({
  space_id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).default(BROWSER_FLOW_DEFAULT_SPACE_ID),
  skill_ref: z.string().trim().min(1).max(240).optional(),
  steps: z.array(browserFlowStepSchema).min(1).max(200),
  success_criteria: z.array(z.string().trim().min(1)).min(1).optional()
}).strict();
export type BrowserFlowPrepareInput = z.infer<typeof browserFlowPrepareInputSchema>;

export const browserFlowStepStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "waiting_human",
  "cancelled"
]);
export type BrowserFlowStepStatus = z.infer<typeof browserFlowStepStatusSchema>;

export const browserFlowStatusSchema = z.enum([
  "prepared",
  "queued",
  "running",
  "waiting_resource",
  "waiting_human",
  "passed",
  "failed",
  "blocked",
  "cancelled"
]);
export type BrowserFlowStatus = z.infer<typeof browserFlowStatusSchema>;

export const browserFlowStepStateSchema = z.object({
  step_id: z.string().trim().min(1),
  status: browserFlowStepStatusSchema,
  input_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  started_at: z.string().datetime().optional(),
  finished_at: z.string().datetime().optional(),
  before_snapshot_id: z.string().optional(),
  after_snapshot_id: z.string().optional(),
  output: z.record(z.unknown()).optional(),
  recoverable: z.boolean(),
  retryable: z.boolean(),
  attempt_count: z.number().int().min(0),
  error_class: z.string().optional(),
  error_message: z.string().optional(),
  evidence_paths: z.array(z.string().trim().min(1))
}).strict();
export type BrowserFlowStepState = z.infer<typeof browserFlowStepStateSchema>;

export const browserFlowStateSchema = z.object({
  version: z.literal(BROWSER_FLOW_STATE_VERSION),
  flow_id: z.string().uuid(),
  contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  space_id: z.string().trim().min(1),
  status: browserFlowStatusSchema,
  current_step_id: z.string().nullable(),
  steps: z.array(browserFlowStepStateSchema).min(1),
  resume_count: z.number().int().min(0),
  blocking_reason: z.string().optional(),
  resource_wait: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();
export type BrowserFlowState = z.infer<typeof browserFlowStateSchema>;

export const browserFlowFactSchema = z.object({
  key: z.string().trim().min(1),
  value: z.unknown(),
  evidence_refs: z.array(z.string().trim().min(1)).min(1),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  verified: z.literal(true).optional()
}).strict();
export type BrowserFlowFact = z.infer<typeof browserFlowFactSchema>;

export const browserFlowResultSchema = z.object({
  version: z.literal(BROWSER_FLOW_RESULT_VERSION),
  flow_id: z.string().uuid(),
  contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  space_id: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "blocked", "waiting_human", "cancelled"]),
  facts: z.array(browserFlowFactSchema.omit({ verified: true })),
  completed_step_ids: z.array(z.string().trim().min(1)),
  unresolved_step_ids: z.array(z.string().trim().min(1)),
  completion_proof: z.record(z.unknown()).optional(),
  human_action_package: z.record(z.unknown()).optional(),
  report_path: z.string().trim().min(1).optional(),
  evidence_paths: z.array(z.string().trim().min(1)),
  limitations: z.array(z.string().trim().min(1)).optional(),
  completed_at: z.string().datetime()
}).strict();
export type BrowserFlowResult = z.infer<typeof browserFlowResultSchema>;

const targetSchema = z.object({
  ref: z.string().regex(/^e\d+$/).optional(),
  selector: z.string().trim().min(1).max(1000).optional(),
  target_name: z.string().trim().min(1).max(500),
  identity_signature: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  timeout_ms: z.number().int().min(250).max(120_000).optional()
}).strict();

const interactionTargetSchema = targetSchema.extend({
  expected_context: z.object({
    platform: z.string().trim().min(1),
    shop_context: shopContextSchema,
    business_object: businessObjectSchema,
    required_visible_text: z.array(z.string().trim().min(1)).min(1)
  }).strict()
});

function requireTarget<T extends z.ZodTypeAny>(schema: T): z.ZodTypeAny {
  return schema.refine((value: { ref?: string; selector?: string }) => Boolean(value.ref || value.selector), "A stable ref or selector is required.");
}

const extractFactSpecSchema = z.object({
  key: z.string().trim().min(1).max(240),
  source_fact_ref: z.string().trim().min(1).max(240).optional(),
  source_step_id: z.string().trim().min(1).max(120).optional(),
  path: z.string().trim().min(1).max(500).optional(),
  operation: z.enum(["copy", "count", "sum", "min", "max", "unique"]).default("copy"),
  column: z.string().trim().min(1).max(240).optional(),
  confidence: z.enum(["high", "medium", "low", "unknown"]).default("high")
}).strict().refine((value) => Boolean(value.source_fact_ref || value.source_step_id), "A source_fact_ref or source_step_id is required.");

const flowDownloadFingerprintSchema = z.object({
  ref: z.string().regex(/^e\d+$/),
  selector: z.string().trim().min(1),
  tag_name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  href_absent: z.literal(true),
  visible: z.literal(true),
  clickable: z.literal(true),
  container_ref: z.string().regex(/^e\d+$/).optional(),
  container_role: z.string().trim().min(1).optional(),
  container_text_contains: z.string().trim().min(1).optional()
}).strict();

const flowDownloadPageFingerprintSchema = z.object({
  type: z.enum(["url_contains", "hostname_contains", "title_contains", "text_contains", "element_text_contains", "accessible_name_contains"]),
  value: z.string().trim().min(1),
  required: z.boolean().optional()
}).strict();

const flowStepInputSchemas: Record<BrowserFlowStepType, z.ZodTypeAny> = {
  open: z.object({
    url: z.string().url(),
    device: z.enum(["desktop", "mobile"]).optional(),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    timeout_ms: z.number().int().min(1000).max(120_000).optional()
  }).strict(),
  observe: z.object({
    scope: z.enum(["viewport", "document", "selector"]).optional(),
    selector: z.string().trim().min(1).max(1000).optional(),
    max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.observe_max_nodes).optional(),
    max_text_chars: z.number().int().min(1000).max(TOOL_LIMITS.browser.observe_max_text_chars).optional(),
    include_tables: z.boolean().optional(),
    include_forms: z.boolean().optional(),
    include_layout_issues: z.boolean().optional(),
    include_accessibility: z.boolean().optional()
  }).strict(),
  observe_continue: z.object({
    cursor: z.string().uuid().optional(),
    cursor_fact_ref: z.string().trim().min(1).optional(),
    initial_cursor_fact_ref: z.string().trim().min(1).optional()
  }).strict().refine((value) => Boolean(value.cursor || value.cursor_fact_ref || value.initial_cursor_fact_ref), "A cursor source is required."),
  assert: z.object({ conditions: z.array(browserFlowConditionSchema).min(1) }).strict(),
  click: requireTarget(interactionTargetSchema.extend({ button: z.enum(["left", "right", "middle"]).optional() })),
  input: requireTarget(interactionTargetSchema.extend({
    text: z.string().max(20_000),
    clear: z.boolean().optional(),
    delay_ms: z.number().int().min(0).max(500).optional()
  })),
  select: requireTarget(interactionTargetSchema.extend({
    value: z.string().max(2000).optional(),
    label: z.string().max(2000).optional()
  }).refine((value) => value.value !== undefined || value.label !== undefined, "A select value or label is required.")),
  check: requireTarget(interactionTargetSchema.extend({ checked: z.boolean().optional() })),
  scroll: requireTarget(targetSchema),
  wait: requireTarget(targetSchema.extend({ state: z.enum(["visible", "hidden", "attached", "detached"]).optional() })),
  extract_table: z.object({
    snapshot_id: z.string().uuid().optional(),
    snapshot_fact_ref: z.string().trim().min(1).optional(),
    table_ref: z.string().regex(/^[er]\d+$/).optional(),
    table_ref_fact_ref: z.string().trim().min(1).optional(),
    max_rows: z.number().int().min(1).max(TOOL_LIMITS.browser.extract_table_max_rows).optional(),
    max_scrolls: z.number().int().min(0).max(TOOL_LIMITS.browser.extract_table_max_scrolls).optional(),
    unique_key_hint: z.string().trim().min(1).max(240).optional()
  }).strict().refine((value) => Boolean(value.snapshot_id || value.snapshot_fact_ref), "A snapshot source is required.")
    .refine((value) => Boolean(value.table_ref || value.table_ref_fact_ref), "A table ref source is required."),
  extract_facts: z.object({ facts: z.array(extractFactSpecSchema).min(1).max(TOOL_LIMITS.browser.flow_max_extract_facts) }).strict(),
  download: z.object({
    ref: z.string().regex(/^e\d+$/),
    snapshot_id: z.string().uuid().optional(),
    snapshot_fact_ref: z.string().trim().min(1).optional(),
    element_fingerprint: flowDownloadFingerprintSchema,
    page_fingerprints: z.array(flowDownloadPageFingerprintSchema).min(1),
    expected_context: z.object({
      platform: z.string().trim().min(1),
      shop_context: shopContextSchema,
      business_object: businessObjectSchema,
      required_visible_text: z.array(z.string().trim().min(1)).min(1).optional()
    }).strict(),
    timeout_ms: z.number().int().min(1000).max(120_000).optional()
  }).strict().refine((value) => Boolean(value.snapshot_id || value.snapshot_fact_ref), "A snapshot source is required."),
  visual_observe: z.object({
    reason: z.enum(["layout", "image_crop", "responsive", "style", "canvas", "video", "cross_origin_frame", "semantic_empty", "semantic_conflict", "manual"]),
    scope: z.enum(["viewport", "full_page", "selector"]).optional(),
    selector: z.string().trim().min(1).max(1000).optional(),
    name: z.string().trim().min(1).max(240).optional(),
    full_page: z.boolean().optional()
  }).strict(),
  branch: z.object({}).strict(),
  repeat_bounded: z.object({ until: browserFlowConditionSchema.optional() }).strict(),
  handoff: z.object({
    reason: z.string().trim().min(1).max(2000),
    instructions: z.array(z.string().trim().min(1).max(2000)).min(1).optional()
  }).strict(),
  report: z.object({ title: z.string().trim().min(1).max(240).optional() }).strict()
};

const stepAllowedActions: Record<BrowserFlowStepType, readonly BrowserBusinessAction[]> = {
  open: ["navigate"],
  observe: ["observe"],
  observe_continue: ["observe"],
  assert: ["assert"],
  click: ["navigate", "filter", "expand"],
  input: ["filter", "prepare_draft"],
  select: ["filter", "prepare_draft"],
  check: ["filter", "prepare_draft"],
  scroll: ["observe", "expand"],
  wait: ["observe", "assert"],
  extract_table: ["observe", "record"],
  extract_facts: ["record"],
  download: ["download"],
  visual_observe: ["observe"],
  branch: ["assert"],
  repeat_bounded: ["assert"],
  handoff: ["handoff"],
  report: ["report"]
};

const repeatSafeStepTypes = new Set<BrowserFlowStepType>([
  "observe",
  "observe_continue",
  "assert",
  "scroll",
  "wait",
  "extract_table",
  "extract_facts"
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

export function browserFlowHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function flowContractHashBody(contract: Omit<BrowserFlowContract, "contract_hash">): Record<string, unknown> {
  return { ...contract };
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function assertNoFinalActionStep(step: BrowserFlowStep): void {
  if (!["click", "input", "select", "check", "download"].includes(step.type)) return;
  const input = step.input as Record<string, unknown>;
  const fingerprint = isRecordValue(input.element_fingerprint) ? input.element_fingerprint : {};
  const targetText = [step.description, input.target_name, input.selector, input.action, input.label, fingerprint.name, fingerprint.text, fingerprint.selector]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const normalizedTarget = normalize(targetText);
  const explicitlyBlocked = BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS.find((action) => normalizedTarget.includes(action));
  if (explicitlyBlocked || isFinalBusinessAction(targetText)) {
    throw new CodexProError(`Browser flow step ${step.id} is blocked during preparation because its target may perform a final business action${explicitlyBlocked ? ` (${explicitlyBlocked})` : ""}.`);
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertStepInput(step: BrowserFlowStep): BrowserFlowStep {
  const parsedInput = flowStepInputSchemas[step.type].parse(step.input) as Record<string, unknown>;
  return { ...step, input: parsedInput };
}

function assertDependencyGraph(steps: BrowserFlowStep[]): void {
  const positions = new Map(steps.map((step, index) => [step.id, index]));
  if (positions.size !== steps.length) throw new CodexProError("Browser flow step ids must be unique.");
  for (const [index, step] of steps.entries()) {
    for (const dependency of step.depends_on) {
      const dependencyIndex = positions.get(dependency);
      if (dependencyIndex === undefined) throw new CodexProError(`Browser flow step ${step.id} depends on unknown step ${dependency}.`);
      if (dependencyIndex >= index) throw new CodexProError(`Browser flow step ${step.id} depends on non-prior step ${dependency}; cycles and forward dependencies are rejected.`);
    }
    for (const branchCase of step.branch_cases ?? []) {
      const targetIndex = positions.get(branchCase.next_step_id);
      if (targetIndex === undefined) throw new CodexProError(`Browser flow branch ${step.id} targets unknown step ${branchCase.next_step_id}.`);
      if (targetIndex <= index) throw new CodexProError(`Browser flow branch ${step.id} must target a later step.`);
    }
    if (step.repeat) {
      for (const bodyStepId of step.repeat.body_step_ids) {
        const bodyIndex = positions.get(bodyStepId);
        if (bodyIndex === undefined) throw new CodexProError(`Browser flow repeat ${step.id} references unknown body step ${bodyStepId}.`);
        if (bodyIndex <= index) throw new CodexProError(`Browser flow repeat ${step.id} body step ${bodyStepId} must follow the repeat step.`);
        const bodyStep = steps[bodyIndex];
        if (!repeatSafeStepTypes.has(bodyStep.type)) {
          throw new CodexProError(`Browser flow repeat ${step.id} cannot contain ${bodyStep.type}; loop bodies are read-only and bounded.`);
        }
      }
    }
  }
}

function assertStepAuthorization(task: BrowserBusinessTask, step: BrowserFlowStep): void {
  const serializedInput = JSON.stringify(step.input);
  if (redactSensitiveText(serializedInput) !== serializedInput) {
    throw new CodexProError(`Browser flow step ${step.id} contains token-like or credential-like input that cannot be persisted in a recoverable Flow contract.`);
  }
  const permittedForType = stepAllowedActions[step.type];
  for (const action of step.allowed_actions) {
    if (!permittedForType.includes(action)) {
      throw new CodexProError(`Browser flow step ${step.id} cannot declare ${action} for step type ${step.type}.`);
    }
    assertBrowserBusinessActionPermitted(task, action, `browser flow step ${step.id}`);
  }
  if (!step.allowed_actions.some((action) => permittedForType.includes(action))) {
    throw new CodexProError(`Browser flow step ${step.id} has no action compatible with ${step.type}.`);
  }
  if (["click", "select", "check"].includes(step.type) && step.recoverable) {
    throw new CodexProError(`Browser flow step ${step.id} cannot be recoverable because interactive draft/filter steps require re-preparation after interruption.`);
  }
  assertNoFinalActionStep(step);
  if (["click", "input", "select", "check"].includes(step.type)) {
    const expectedContext = (step.input as Record<string, unknown>).expected_context;
    if (!expectedContext || typeof expectedContext !== "object") {
      throw new CodexProError(`Browser flow step ${step.id} requires expected_context bound to the Browser Business Task.`);
    }
    assertBusinessContextMatches(task, expectedContext as Parameters<typeof assertBusinessContextMatches>[1], `browser flow step ${step.id} expected_context`);
    if (!step.preconditions.length) {
      throw new CodexProError(`Browser flow step ${step.id} requires at least one verified page-fact precondition before interaction.`);
    }
  }
  if (step.type === "download") {
    assertBusinessContextMatches(task, (step.input as Record<string, unknown>).expected_context as Parameters<typeof assertBusinessContextMatches>[1], `browser flow step ${step.id} expected_context`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

export function prepareBrowserFlowContract(taskValue: unknown, inputValue: unknown): BrowserFlowContract {
  const task = validateBrowserBusinessTask(taskValue);
  const input = browserFlowPrepareInputSchema.parse(inputValue);
  const steps = input.steps.map((step) => assertStepInput(step));
  assertDependencyGraph(steps);
  for (const step of steps) assertStepAuthorization(task, step);
  const successCriteria = input.success_criteria?.length ? input.success_criteria : task.success_criteria;
  if (!successCriteria.length) throw new CodexProError("Browser flow requires at least one success criterion from the flow or browser business task.");
  const createdAt = new Date().toISOString();
  const base: Omit<BrowserFlowContract, "contract_hash"> = {
    version: BROWSER_FLOW_VERSION,
    flow_id: randomUUID(),
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    space_id: input.space_id,
    platform: task.platform,
    risk_class: task.risk_class,
    ...(input.skill_ref ? { skill_ref: input.skill_ref } : {}),
    steps,
    success_criteria: successCriteria,
    permanently_blocked_actions: [...BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS],
    created_at: createdAt
  };
  return deepFreeze(browserFlowContractSchema.parse({
    ...base,
    contract_hash: agentTaskContractHash(flowContractHashBody(base))
  }));
}

export function validateBrowserFlowContract(value: unknown): BrowserFlowContract {
  const contract = browserFlowContractSchema.parse(value);
  const { contract_hash: actual, ...base } = contract;
  const expected = agentTaskContractHash(flowContractHashBody(base));
  if (actual !== expected) throw new CodexProError(`browser_flow contract_hash mismatch: expected ${expected}, got ${actual}.`);
  if (contract.permanently_blocked_actions.length !== BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS.length ||
      BROWSER_FLOW_PERMANENTLY_BLOCKED_ACTIONS.some((action) => !contract.permanently_blocked_actions.includes(action))) {
    throw new CodexProError("browser_flow permanently_blocked_actions cannot be weakened.");
  }
  assertDependencyGraph(contract.steps);
  return deepFreeze(contract);
}

export function createInitialBrowserFlowState(contractValue: unknown): BrowserFlowState {
  const contract = validateBrowserFlowContract(contractValue);
  const createdAt = new Date().toISOString();
  return browserFlowStateSchema.parse({
    version: BROWSER_FLOW_STATE_VERSION,
    flow_id: contract.flow_id,
    contract_hash: contract.contract_hash,
    task_id: contract.task_id,
    run_id: contract.run_id,
    space_id: contract.space_id,
    status: "prepared",
    current_step_id: null,
    steps: contract.steps.map((step) => ({
      step_id: step.id,
      status: "pending",
      input_hash: browserFlowHash(step.input),
      recoverable: step.recoverable,
      retryable: step.retryable,
      attempt_count: 0,
      evidence_paths: []
    })),
    resume_count: 0,
    created_at: createdAt,
    updated_at: createdAt
  });
}

export function assertBrowserFlowStateMatchesContract(stateValue: unknown, contractValue: unknown): BrowserFlowState {
  const state = browserFlowStateSchema.parse(stateValue);
  const contract = validateBrowserFlowContract(contractValue);
  if (state.flow_id !== contract.flow_id || state.contract_hash !== contract.contract_hash || state.task_id !== contract.task_id ||
      state.run_id !== contract.run_id || state.space_id !== contract.space_id) {
    throw new CodexProError("Persisted browser flow state does not match its immutable contract.");
  }
  if (state.steps.length !== contract.steps.length) throw new CodexProError("Persisted browser flow state step count does not match its contract.");
  for (const [index, step] of state.steps.entries()) {
    const contractStep = contract.steps[index];
    if (step.step_id !== contractStep.id || step.input_hash !== browserFlowHash(contractStep.input) ||
        step.recoverable !== contractStep.recoverable || step.retryable !== contractStep.retryable) {
      throw new CodexProError(`Persisted browser flow step ${step.step_id} does not match its immutable contract.`);
    }
  }
  return state;
}
