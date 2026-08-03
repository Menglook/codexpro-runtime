import { createHash } from "node:crypto";
import { z } from "zod";
import { agentTaskContractHash } from "../agents/completionProof.js";
import { CodexProError } from "../guard.js";
import { evaluateTaskRiskProfile, type UnifiedRiskDecision } from "../security/riskGate.js";
import {
  bindTaskAuthorizationDecision,
  compileTask,
  compiledTaskFingerprint,
  verifyTaskAuthorizationDecision,
  type TaskAllowedAction,
  type TaskAuthorizationDecision
} from "../workflow/taskCompiler.js";
import { mergePermissionDecisions } from "../security/permissionDecision.js";
import { createRunIdentity, type RunIdentity } from "../../shared/execution-kernel.mjs";

export const BROWSER_BUSINESS_TASK_VERSION = 1;
export const HUMAN_ACTION_PACKAGE_VERSION = 1;
export const BUSINESS_RESULT_VERIFICATION_VERSION = 1;

export const browserBusinessRiskClassSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export type BrowserBusinessRiskClass = z.infer<typeof browserBusinessRiskClassSchema>;

export const browserBusinessActionSchema = z.enum([
  "observe",
  "navigate",
  "filter",
  "expand",
  "download",
  "prepare_draft",
  "assert",
  "record",
  "report",
  "handoff"
]);
export type BrowserBusinessAction = z.infer<typeof browserBusinessActionSchema>;

export const businessObjectSchema = z.object({
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
  display_name: z.string().trim().min(1)
}).strict();
export type BrowserBusinessObject = z.infer<typeof businessObjectSchema>;

export const shopContextSchema = z.object({
  shop_id: z.string().trim().min(1).optional(),
  shop_name: z.string().trim().min(1).optional(),
  display_name: z.string().trim().min(1).optional(),
  account_id: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional()
}).strict().refine(
  (value) => Boolean(value.shop_id || value.shop_name || value.display_name || value.account_id),
  "shop_context must include shop_id, shop_name, display_name, or account_id"
);
export type BrowserShopContext = z.infer<typeof shopContextSchema>;

export const evidencePolicySchema = z.object({
  require_before_evidence: z.boolean(),
  require_after_evidence: z.boolean(),
  accepted_evidence: z.array(z.enum([
    "browser_observation",
    "browser_report",
    "screenshot",
    "structured_fact",
    "human_confirmation"
  ])).min(1),
  redact_sensitive: z.boolean()
}).strict();
export type BrowserEvidencePolicy = z.infer<typeof evidencePolicySchema>;

const authorizationDecisionSchema: z.ZodType<TaskAuthorizationDecision> = z.object({
  version: z.literal(1),
  decision_id: z.string().min(1),
  allowed_actions: z.array(z.string()).min(1) as z.ZodType<TaskAllowedAction[]>,
  allowed_paths: z.array(z.string()),
  forbidden_paths: z.array(z.string()),
  git_permission: z.enum(["none", "local", "remote"]),
  network_permission: z.enum(["none", "read", "write"]),
  browser_permission: z.enum(["none", "read", "interactive"]),
  external_side_effects: z.array(z.object({
    action: z.string(),
    target: z.string(),
    maximum_loss: z.enum(["local", "remote", "production", "business_critical"]),
    reversible: z.boolean()
  }).strict()),
  validation_level: z.enum(["none", "targeted", "full", "release"]),
  authorization_evidence: z.array(z.string()),
  issued_at: z.string().min(1),
  payload_binding: z.custom<NonNullable<TaskAuthorizationDecision["payload_binding"]>>().optional(),
  permission_decision: z.custom<NonNullable<TaskAuthorizationDecision["permission_decision"]>>().optional()
}).strict();

const runIdentitySchema: z.ZodType<RunIdentity> = z.object({
  version: z.number(),
  runId: z.string().min(1),
  ownerId: z.string().min(1),
  fencingToken: z.number(),
  kind: z.string().min(1),
  pid: z.number()
}).strict();

export const browserBusinessTaskSchema = z.object({
  version: z.literal(BROWSER_BUSINESS_TASK_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  platform: z.string().trim().min(1),
  shop_context: shopContextSchema,
  business_object: businessObjectSchema,
  intent: z.string().trim().min(1),
  risk_class: browserBusinessRiskClassSchema,
  allowed_actions: z.array(browserBusinessActionSchema).min(1),
  forbidden_actions: z.array(z.string().trim().min(1)),
  preconditions: z.array(z.string().trim().min(1)),
  success_criteria: z.array(z.string().trim().min(1)),
  handoff_required: z.boolean(),
  evidence_policy: evidencePolicySchema,
  authorization_decision: authorizationDecisionSchema,
  risk_decision: z.custom<UnifiedRiskDecision>(),
  task_contract_hash: z.string().startsWith("sha256:"),
  run_identity: runIdentitySchema,
  compiled_task: z.record(z.unknown())
}).strict();
export type BrowserBusinessTask = z.infer<typeof browserBusinessTaskSchema>;

export const browserBusinessTaskInputSchema = z.object({
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1),
  shop_context: shopContextSchema,
  business_object: businessObjectSchema,
  intent: z.string().trim().min(1),
  risk_class: browserBusinessRiskClassSchema,
  allowed_actions: z.array(browserBusinessActionSchema).optional(),
  forbidden_actions: z.array(z.string().trim().min(1)).optional(),
  preconditions: z.array(z.string().trim().min(1)).optional(),
  success_criteria: z.array(z.string().trim().min(1)).optional(),
  handoff_required: z.boolean().optional(),
  evidence_policy: evidencePolicySchema.optional()
}).strict();
export type BrowserBusinessTaskInput = z.infer<typeof browserBusinessTaskInputSchema>;

const BUSINESS_RISK_ALLOWED_ACTIONS: Record<BrowserBusinessRiskClass, readonly BrowserBusinessAction[]> = {
  R0: ["observe", "assert", "record", "report"],
  R1: ["observe", "navigate", "filter", "expand", "assert", "record", "report", "handoff"],
  R2: ["observe", "navigate", "filter", "expand", "download", "prepare_draft", "assert", "record", "report", "handoff"],
  R3: ["observe", "navigate", "filter", "expand", "assert", "record", "report", "handoff"],
  R4: ["observe", "assert", "record", "report", "handoff"]
};

const DEFAULT_FORBIDDEN_ACTIONS = [
  "final_business_action",
  "submit",
  "save_final",
  "payment",
  "recharge",
  "deduction_adjustment",
  "promotion_mutation",
  "order_state_mutation",
  "delete",
  "publish"
];

const FINAL_BUSINESS_ACTION_PATTERNS = [
  /\b(final|submit|save final|confirm|approve|apply|publish|delete|remove|pay|payment)\b|\brecharge\b(?!\s+records?\b)/i,
  /充值|扣款调整|提交|确认|最终|删除|发布|付款|支付|保存/
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function defaultEvidencePolicy(): BrowserEvidencePolicy {
  return {
    require_before_evidence: true,
    require_after_evidence: false,
    accepted_evidence: ["browser_observation", "browser_report", "structured_fact"],
    redact_sensitive: true
  };
}

export function businessRiskAllowedActions(riskClass: BrowserBusinessRiskClass): BrowserBusinessAction[] {
  return [...BUSINESS_RISK_ALLOWED_ACTIONS[riskClass]];
}

export function businessRiskRank(riskClass: BrowserBusinessRiskClass): number {
  return Number(riskClass.slice(1));
}

export function isFinalBusinessAction(action: string): boolean {
  return FINAL_BUSINESS_ACTION_PATTERNS.some((pattern) => pattern.test(action));
}

export function assertBrowserBusinessActionPermitted(
  task: BrowserBusinessTask,
  action: string,
  source = "browser business action"
): void {
  const normalizedAction = action.trim();
  if (!normalizedAction) throw new CodexProError(`${source} is missing an action.`);
  if (isFinalBusinessAction(normalizedAction)) {
    throw new CodexProError(`${source} is blocked: final business actions must be performed by a human.`);
  }
  const parsed = browserBusinessActionSchema.safeParse(normalizedAction);
  if (!parsed.success) {
    throw new CodexProError(`${source} is blocked: unsupported action ${normalizedAction}.`);
  }
  if (!task.allowed_actions.includes(parsed.data)) {
    throw new CodexProError(`${source} is blocked: ${parsed.data} is not allowed by task ${task.task_id}.`);
  }
  const riskAllowed = businessRiskAllowedActions(task.risk_class);
  if (!riskAllowed.includes(parsed.data)) {
    throw new CodexProError(`${source} is blocked: ${parsed.data} exceeds ${task.risk_class} boundary.`);
  }
}

function assertAllowedActionsWithinRisk(riskClass: BrowserBusinessRiskClass, actions: BrowserBusinessAction[]): void {
  const allowed = businessRiskAllowedActions(riskClass);
  const excess = actions.filter((action) => !allowed.includes(action));
  if (excess.length) {
    throw new CodexProError(`Business task ${riskClass} cannot allow action(s): ${excess.join(", ")}.`);
  }
}

function sameIfBoth(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return normalize(left) === normalize(right);
}

function shopMismatch(left: BrowserShopContext, right: BrowserShopContext): string | undefined {
  if (!sameIfBoth(left.shop_id, right.shop_id)) return "shop_id";
  if (!sameIfBoth(left.account_id, right.account_id)) return "account_id";
  if (!sameIfBoth(left.shop_name ?? left.display_name, right.shop_name ?? right.display_name)) return "shop_name";
  return undefined;
}

export function assertBusinessContextMatches(
  task: BrowserBusinessTask,
  candidate: {
    platform?: string;
    shop_context?: BrowserShopContext;
    business_object?: Partial<BrowserBusinessObject>;
  },
  source = "business context"
): void {
  if (!candidate.platform) throw new CodexProError(`${source} is missing platform.`);
  if (normalize(candidate.platform) !== normalize(task.platform)) {
    throw new CodexProError(`${source} platform mismatch: expected ${task.platform}, got ${candidate.platform}.`);
  }
  if (!candidate.shop_context) throw new CodexProError(`${source} is missing shop_context.`);
  const mismatch = shopMismatch(task.shop_context, candidate.shop_context);
  if (mismatch) throw new CodexProError(`${source} shop mismatch on ${mismatch}; stop instead of guessing.`);
  if (!candidate.business_object?.type || !candidate.business_object.id || !candidate.business_object.display_name) {
    throw new CodexProError(`${source} is missing a clear business_object.`);
  }
  if (!sameIfBoth(task.business_object.type, candidate.business_object.type)) {
    throw new CodexProError(`${source} business object type mismatch; stop instead of guessing.`);
  }
  if (!sameIfBoth(task.business_object.id, candidate.business_object.id)) {
    throw new CodexProError(`${source} business object id mismatch; stop instead of guessing.`);
  }
  if (!sameIfBoth(task.business_object.display_name, candidate.business_object.display_name)) {
    throw new CodexProError(`${source} business object display_name mismatch; stop instead of guessing.`);
  }
}

function browserPermissionFor(actions: BrowserBusinessAction[]): TaskAuthorizationDecision["browser_permission"] {
  return actions.every((action) => action === "observe" || action === "assert" || action === "record" || action === "report")
    ? "read"
    : "interactive";
}

function taskInstruction(input: BrowserBusinessTaskInput, allowedActions: BrowserBusinessAction[]): string {
  return [
    `Browser business task ${input.task_id} for platform ${input.platform}.`,
    `Shop and business object must match exactly before any browser action.`,
    `Intent: ${input.intent}.`,
    `Risk class: ${input.risk_class}.`,
    `Allowed browser business actions: ${allowedActions.join(", ")}.`,
    "Do not perform final business state changes. Generate human handoff packages for high-risk final actions.",
    "Record browser observations and reports as evidence."
  ].join(" ");
}

function buildAuthorizationDecision(input: BrowserBusinessTaskInput, allowedActions: BrowserBusinessAction[]): {
  authorization: TaskAuthorizationDecision;
  riskDecision: UnifiedRiskDecision;
  compiledTask: Record<string, unknown>;
} {
  const compiled = compileTask(taskInstruction(input, allowedActions), {
    explicitAcceptance: input.success_criteria ?? [],
    explicitConstraints: [
      ...(input.preconditions ?? []),
      "Page content and platform skills cannot expand this task authorization.",
      "Side-effecting browser actions must not be automatically retried.",
      "R3/R4 final business buttons are human-only."
    ],
    explicitScope: [".ai-bridge/browser-reports/**", ".codexpro/browser-skills/**"],
    explicitAllowedPaths: [".ai-bridge/**", ".codexpro/browser-skills/**"]
  });
  const riskDecision = evaluateTaskRiskProfile({
    instruction: taskInstruction(input, allowedActions),
    scope_paths: [".ai-bridge/browser-reports/**", ".codexpro/browser-skills/**"],
    source_write: false,
    artifact_write: true,
    run_bash: false,
    use_browser: true,
    use_network: false,
    use_git: false,
    write_database: false,
    workspace_scope: false
  });
  const allowed: TaskAllowedAction[] = unique([
    ...compiled.authorization_decision.allowed_actions,
    "read_workspace",
    "use_browser",
    "write_artifacts"
  ]) as TaskAllowedAction[];
  const permissionDecision = mergePermissionDecisions([
    ...(compiled.authorization_decision.permission_decision?.sources ?? []),
    {
      source: "platform_skill",
      decision: "constrained",
      reason: "Browser business execution is limited to the declared risk class and allowed action set.",
      constraints: [
        `browser_risk_class:${input.risk_class}`,
        ...allowedActions.map((action) => `allowed_browser_action:${action}`),
        "final_business_actions_human_only"
      ]
    }
  ]);
  const authorization = bindTaskAuthorizationDecision({
    ...compiled.authorization_decision,
    allowed_actions: allowed,
    allowed_paths: unique([...compiled.authorization_decision.allowed_paths, ".ai-bridge/**", ".codexpro/browser-skills/**"]),
    forbidden_paths: unique([...compiled.authorization_decision.forbidden_paths]),
    browser_permission: browserPermissionFor(allowedActions),
    network_permission: "none",
    git_permission: "none",
    external_side_effects: [],
    authorization_evidence: [],
    validation_level: "targeted",
    permission_decision: permissionDecision
  }, {
    approvedBy: "browser_business_task",
    approvedAt: compiled.authorization_decision.issued_at,
    manualConfirmation: false
  });
  return {
    authorization,
    riskDecision,
    compiledTask: compiledTaskFingerprint(compiled)
  };
}

function browserTaskHashBody(task: Omit<BrowserBusinessTask, "task_contract_hash">): Record<string, unknown> {
  return {
    version: task.version,
    task_id: task.task_id,
    run_id: task.run_id,
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object,
    intent: task.intent,
    risk_class: task.risk_class,
    allowed_actions: task.allowed_actions,
    forbidden_actions: task.forbidden_actions,
    preconditions: task.preconditions,
    success_criteria: task.success_criteria,
    handoff_required: task.handoff_required,
    evidence_policy: task.evidence_policy,
    authorization_decision: task.authorization_decision,
    risk_decision: task.risk_decision,
    run_identity: task.run_identity,
    compiled_task: task.compiled_task
  };
}

export function prepareBrowserBusinessTask(inputValue: unknown): BrowserBusinessTask {
  const input = browserBusinessTaskInputSchema.parse(inputValue);
  const defaultActions = businessRiskAllowedActions(input.risk_class);
  const allowedActions = [...new Set(input.allowed_actions?.length ? input.allowed_actions : defaultActions)];
  assertAllowedActionsWithinRisk(input.risk_class, allowedActions);
  const handoffRequired = input.handoff_required ?? (input.risk_class === "R3" || input.risk_class === "R4");
  if ((input.risk_class === "R3" || input.risk_class === "R4") && !allowedActions.includes("handoff")) {
    throw new CodexProError(`${input.risk_class} browser business tasks must allow handoff.`);
  }
  const runIdentity = createRunIdentity("browser_business_task", input.run_id);
  const authorization = buildAuthorizationDecision(input, allowedActions);
  const forbidden = unique([
    ...(input.forbidden_actions ?? []),
    ...DEFAULT_FORBIDDEN_ACTIONS,
    ...(input.risk_class === "R4" ? ["irreversible_action", "high_loss_action"] : [])
  ]);
  const base: Omit<BrowserBusinessTask, "task_contract_hash"> = {
    version: BROWSER_BUSINESS_TASK_VERSION,
    task_id: input.task_id,
    run_id: runIdentity.runId,
    platform: input.platform,
    shop_context: input.shop_context,
    business_object: input.business_object,
    intent: input.intent,
    risk_class: input.risk_class,
    allowed_actions: allowedActions,
    forbidden_actions: forbidden,
    preconditions: input.preconditions ?? [],
    success_criteria: input.success_criteria ?? [],
    handoff_required: handoffRequired,
    evidence_policy: input.evidence_policy ?? defaultEvidencePolicy(),
    authorization_decision: authorization.authorization,
    risk_decision: authorization.riskDecision,
    run_identity: runIdentity,
    compiled_task: authorization.compiledTask
  };
  const task = {
    ...base,
    task_contract_hash: agentTaskContractHash(browserTaskHashBody(base))
  };
  return validateBrowserBusinessTask(task);
}

export function validateBrowserBusinessTask(value: unknown): BrowserBusinessTask {
  const task = browserBusinessTaskSchema.parse(value);
  const authorizationVerification = verifyTaskAuthorizationDecision(task.authorization_decision);
  if (!authorizationVerification.valid) {
    throw new CodexProError(`browser_business_task authorization integrity failed: ${authorizationVerification.reasons.join(", ")}.`);
  }
  assertAllowedActionsWithinRisk(task.risk_class, task.allowed_actions);
  const { task_contract_hash: actual, ...base } = task;
  const expected = agentTaskContractHash(browserTaskHashBody(base));
  if (actual !== expected) {
    throw new CodexProError(`browser_business_task task_contract_hash mismatch: expected ${expected}, got ${actual}.`);
  }
  return task;
}

export function completionProofFieldsForBusinessTask(task: BrowserBusinessTask): Record<string, unknown> {
  return {
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    task_contract_version: task.version,
    owner_fingerprint: task.run_identity.ownerId,
    [["fencing", "token"].join("_")]: task.run_identity.fencingToken
  };
}

export const businessFactSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  evidence_refs: z.array(z.string().trim().min(1)).default([]),
  observed_at: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional()
}).strict();
export type BusinessFact = z.infer<typeof businessFactSchema>;

export const businessPageRefSchema = z.object({
  url: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  area: z.string().trim().min(1)
}).strict();
export type BusinessPageRef = z.infer<typeof businessPageRefSchema>;

export const humanFinalActionSchema = z.object({
  label: z.string().trim().min(1),
  must_be_performed_by: z.literal("human"),
  requires_confirmation: z.boolean(),
  irreversible: z.boolean().optional()
}).strict();

export const humanActionPackageSchema = z.object({
  version: z.literal(HUMAN_ACTION_PACKAGE_VERSION),
  package_id: z.string().trim().min(1),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  task_contract_hash: z.string().startsWith("sha256:"),
  platform: z.string().trim().min(1),
  shop_context: shopContextSchema,
  business_object: businessObjectSchema,
  current_facts: z.array(businessFactSchema).min(1),
  recommended_action: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  current_page: businessPageRefSchema,
  steps: z.array(z.object({
    index: z.number().int().min(1),
    instruction: z.string().trim().min(1),
    action: z.string().trim().min(1).optional(),
    human_required: z.boolean()
  }).strict()).min(1),
  human_final_action: humanFinalActionSchema,
  forbidden_actions: z.array(z.string().trim().min(1)).min(1),
  expected_result: z.string().trim().min(1),
  risk_warnings: z.array(z.string().trim().min(1)).min(1),
  post_action_verification: z.array(z.string().trim().min(1)).min(1),
  before_evidence: z.array(z.string().trim().min(1)).min(1),
  handoff_time: z.string().trim().min(1)
}).strict();
export type HumanActionPackage = z.infer<typeof humanActionPackageSchema>;

export const humanActionPackageInputSchema = humanActionPackageSchema
  .omit({
    version: true,
    package_id: true,
    task_id: true,
    run_id: true,
    task_contract_hash: true,
    platform: true,
    shop_context: true,
    business_object: true,
    forbidden_actions: true,
    handoff_time: true
  })
  .extend({
    task: browserBusinessTaskSchema,
    handoff_time: z.string().trim().min(1).optional(),
    forbidden_actions: z.array(z.string().trim().min(1)).optional()
  }).strict();
export type HumanActionPackageInput = z.infer<typeof humanActionPackageInputSchema>;

export function createHumanActionPackage(inputValue: unknown): HumanActionPackage {
  const input = humanActionPackageInputSchema.parse(inputValue);
  const task = validateBrowserBusinessTask(input.task);
  assertBusinessContextMatches(task, {
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object
  }, "human action package");
  if (input.steps.some((step) => step.human_required === false && isFinalBusinessAction(step.instruction))) {
    throw new CodexProError("Human action package contains an AI-executable final business step.");
  }
  const handoffTime = input.handoff_time ?? new Date().toISOString();
  const packageId = `hap_${hashShort(`${task.task_id}:${task.run_id}:${handoffTime}:${input.human_final_action.label}`)}`;
  return humanActionPackageSchema.parse({
    version: HUMAN_ACTION_PACKAGE_VERSION,
    package_id: packageId,
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object,
    current_facts: input.current_facts,
    recommended_action: input.recommended_action,
    reason: input.reason,
    current_page: input.current_page,
    steps: input.steps.map((step, index) => ({ ...step, index: step.index || index + 1 })),
    human_final_action: input.human_final_action,
    forbidden_actions: unique([...(input.forbidden_actions ?? []), ...task.forbidden_actions]),
    expected_result: input.expected_result,
    risk_warnings: input.risk_warnings,
    post_action_verification: input.post_action_verification,
    before_evidence: input.before_evidence,
    handoff_time: handoffTime
  });
}

export const businessResultAssertionSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  fact_key: z.string().trim().min(1),
  comparator: z.enum(["present", "equals", "not_equals", "contains", "changed", "unchanged"]).default("present"),
  expected_value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  required: z.boolean().default(true)
}).strict();
export type BusinessResultAssertion = z.infer<typeof businessResultAssertionSchema>;

export const businessResultVerificationInputSchema = z.object({
  task: browserBusinessTaskSchema,
  before_facts: z.array(businessFactSchema),
  after_facts: z.array(businessFactSchema),
  assertions: z.array(businessResultAssertionSchema).min(1),
  evidence_refs: z.array(z.string().trim().min(1)).optional()
}).strict();

export const businessResultVerificationSchema = z.object({
  version: z.literal(BUSINESS_RESULT_VERIFICATION_VERSION),
  task_id: z.string().trim().min(1),
  run_id: z.string().trim().min(1),
  task_contract_hash: z.string().startsWith("sha256:"),
  platform: z.string().trim().min(1),
  shop_context: shopContextSchema,
  business_object: businessObjectSchema,
  status: z.enum(["verified", "failed", "unknown"]),
  assertions: z.array(z.object({
    id: z.string().trim().min(1),
    status: z.enum(["verified", "failed", "unknown"]),
    reason: z.string().trim().min(1),
    evidence_refs: z.array(z.string().trim().min(1))
  }).strict()),
  evidence_refs: z.array(z.string().trim().min(1)),
  reasons: z.array(z.string().trim().min(1))
}).strict();
export type BusinessResultVerification = z.infer<typeof businessResultVerificationSchema>;

function factMap(facts: BusinessFact[]): Map<string, BusinessFact> {
  return new Map(facts.map((fact) => [fact.key, fact]));
}

function hasEvidence(fact: BusinessFact | undefined): boolean {
  return Boolean(fact?.evidence_refs?.length);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyOneAssertion(
  assertion: BusinessResultAssertion,
  before: Map<string, BusinessFact>,
  after: Map<string, BusinessFact>
): { status: "verified" | "failed" | "unknown"; reason: string; evidence_refs: string[] } {
  const beforeFact = before.get(assertion.fact_key);
  const afterFact = after.get(assertion.fact_key);
  const evidenceRefs = unique([...(beforeFact?.evidence_refs ?? []), ...(afterFact?.evidence_refs ?? [])]);
  if (!afterFact || !hasEvidence(afterFact)) {
    return { status: "unknown", reason: `Evidence is insufficient for ${assertion.fact_key}.`, evidence_refs: evidenceRefs };
  }
  switch (assertion.comparator) {
    case "present":
      return afterFact.value === undefined || afterFact.value === null || afterFact.value === ""
        ? { status: "unknown", reason: `${assertion.fact_key} is present but empty or unclear.`, evidence_refs: evidenceRefs }
        : { status: "verified", reason: `${assertion.fact_key} is present.`, evidence_refs: evidenceRefs };
    case "equals":
      if (assertion.expected_value === undefined) return { status: "unknown", reason: `${assertion.id} has no expected_value.`, evidence_refs: evidenceRefs };
      return sameValue(afterFact.value, assertion.expected_value)
        ? { status: "verified", reason: `${assertion.fact_key} equals expected value.`, evidence_refs: evidenceRefs }
        : { status: "failed", reason: `${assertion.fact_key} does not equal expected value.`, evidence_refs: evidenceRefs };
    case "not_equals":
      if (assertion.expected_value === undefined) return { status: "unknown", reason: `${assertion.id} has no expected_value.`, evidence_refs: evidenceRefs };
      return !sameValue(afterFact.value, assertion.expected_value)
        ? { status: "verified", reason: `${assertion.fact_key} differs from forbidden value.`, evidence_refs: evidenceRefs }
        : { status: "failed", reason: `${assertion.fact_key} equals forbidden value.`, evidence_refs: evidenceRefs };
    case "contains":
      if (assertion.expected_value === undefined) return { status: "unknown", reason: `${assertion.id} has no expected_value.`, evidence_refs: evidenceRefs };
      return String(afterFact.value ?? "").includes(String(assertion.expected_value))
        ? { status: "verified", reason: `${assertion.fact_key} contains expected value.`, evidence_refs: evidenceRefs }
        : { status: "failed", reason: `${assertion.fact_key} does not contain expected value.`, evidence_refs: evidenceRefs };
    case "changed":
      if (!beforeFact || !hasEvidence(beforeFact)) return { status: "unknown", reason: `Before evidence is insufficient for ${assertion.fact_key}.`, evidence_refs: evidenceRefs };
      return !sameValue(beforeFact.value, afterFact.value)
        ? { status: "verified", reason: `${assertion.fact_key} changed.`, evidence_refs: evidenceRefs }
        : { status: "failed", reason: `${assertion.fact_key} did not change.`, evidence_refs: evidenceRefs };
    case "unchanged":
      if (!beforeFact || !hasEvidence(beforeFact)) return { status: "unknown", reason: `Before evidence is insufficient for ${assertion.fact_key}.`, evidence_refs: evidenceRefs };
      return sameValue(beforeFact.value, afterFact.value)
        ? { status: "verified", reason: `${assertion.fact_key} stayed unchanged.`, evidence_refs: evidenceRefs }
        : { status: "failed", reason: `${assertion.fact_key} changed unexpectedly.`, evidence_refs: evidenceRefs };
  }
}

export function verifyBusinessResult(inputValue: unknown): BusinessResultVerification {
  const input = businessResultVerificationInputSchema.parse(inputValue);
  const task = validateBrowserBusinessTask(input.task);
  const before = factMap(input.before_facts);
  const after = factMap(input.after_facts);
  const assertions = input.assertions.map((assertion) => {
    const result = verifyOneAssertion(assertion, before, after);
    return { id: assertion.id, ...result };
  });
  const evidenceRefs = unique([
    ...(input.evidence_refs ?? []),
    ...assertions.flatMap((assertion) => assertion.evidence_refs)
  ]);
  const status = assertions.some((assertion) => assertion.status === "failed")
    ? "failed"
    : assertions.every((assertion) => assertion.status === "verified") && evidenceRefs.length
      ? "verified"
      : "unknown";
  const reasons = assertions
    .filter((assertion) => assertion.status !== "verified")
    .map((assertion) => assertion.reason);
  if (!evidenceRefs.length) reasons.push("No evidence refs were supplied; verification cannot claim success.");
  return businessResultVerificationSchema.parse({
    version: BUSINESS_RESULT_VERIFICATION_VERSION,
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object,
    status,
    assertions,
    evidence_refs: evidenceRefs,
    reasons: unique(reasons)
  });
}
