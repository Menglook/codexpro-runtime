import { createHash } from "node:crypto";
import { z } from "zod";

export const BROWSER_SKILL_PACK_VERSION = 2;
export const BROWSER_SKILL_PACK_RUNTIME_VERSION = "codexpro-browser-skill-pack-runtime@2";
export const BROWSER_SKILL_PACK_LAYERS = ["workspace", "user", "builtin"] as const;
export const BROWSER_SKILL_PACK_STATUSES = ["active", "warning", "quarantined", "retired"] as const;

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().trim().min(1).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.replace(/\\/g, "/").split("/").includes("..");
}, "resource path must remain relative to its pack");

const pathList = z.array(relativePath).refine((values) => new Set(values).size === values.length, "resource paths must be unique");

export const browserSkillPackManifestSchema = z.object({
  version: z.literal(BROWSER_SKILL_PACK_VERSION),
  pack_id: identifier,
  platform: nonEmpty,
  pack_version: nonEmpty,
  platform_version_hint: z.string().optional(),
  layer: z.enum(BROWSER_SKILL_PACK_LAYERS),
  compatible_runtime: nonEmpty,
  status: z.enum(BROWSER_SKILL_PACK_STATUSES),
  skill_contract_hash: sha256,
  verified_at: z.string().datetime().nullable(),
  verified_pages: z.array(nonEmpty).refine((values) => new Set(values).size === values.length),
  resources: z.object({
    pages: pathList,
    navigation: pathList,
    extractors: pathList,
    workflows: pathList,
    recovery: pathList,
    fixtures: pathList
  }).strict(),
  promotion_policy: z.object({
    automatic_long_term_write: z.literal(false),
    requires_redaction_scan: z.literal(true),
    requires_duplicate_check: z.literal(true),
    requires_targeted_regression: z.literal(true),
    requires_explicit_user_approval: z.literal(true)
  }).strict()
}).strict();
export type BrowserSkillPackManifest = z.infer<typeof browserSkillPackManifestSchema>;

export const browserPageFingerprintSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  platform: nonEmpty,
  page: nonEmpty,
  layout_version_hint: z.string().optional(),
  signals: z.array(z.object({
    type: z.enum(["hostname", "url_path", "title", "navigation_item", "accessible_name", "text_present", "text_absent", "layout_feature"]),
    value: nonEmpty,
    match: z.enum(["exact", "contains", "pattern"]).optional(),
    required: z.boolean()
  }).strict()).min(1),
  minimum_required_matches: z.number().int().min(1),
  on_mismatch: z.enum(["warning_readonly", "quarantine"]),
  verified_at: z.string().datetime().nullable().optional()
}).strict().superRefine((value, context) => {
  const requiredCount = value.signals.filter((signal) => signal.required).length;
  if (value.minimum_required_matches > requiredCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimum_required_matches"],
      message: "minimum_required_matches cannot exceed the number of required signals"
    });
  }
});
export type BrowserPageFingerprint = z.infer<typeof browserPageFingerprintSchema>;

const navigationStepSchema = z.object({
  action: z.enum(["open", "click", "select", "wait", "observe", "assert"]),
  target: nonEmpty,
  risk_class: z.enum(["R0", "R1"])
}).strict();

export const browserNavigationMapSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  platform: nonEmpty,
  nodes: z.array(z.object({ id: nonEmpty, fingerprint_ref: nonEmpty }).strict()).min(1),
  routes: z.array(z.object({
    id: nonEmpty,
    from: nonEmpty,
    to: nonEmpty,
    steps: z.array(navigationStepSchema),
    success_checks: z.array(nonEmpty).min(1),
    return_steps: z.array(navigationStepSchema)
  }).strict()),
  failure_rules: z.object({
    login_expired: z.literal("stop_human_login"),
    permission_denied: z.literal("stop"),
    fingerprint_mismatch: z.enum(["readonly_fallback", "stop"]),
    context_mismatch: z.literal("stop")
  }).strict()
}).strict();
export type BrowserNavigationMap = z.infer<typeof browserNavigationMapSchema>;

const extractorMethodSchema = z.enum(["business_semantic", "stable_element_ref", "role_name", "stable_selector", "network_field"]);
export const BROWSER_EXTRACTOR_LOCATE_ORDER = ["business_semantic", "stable_element_ref", "role_name", "stable_selector", "network_field"] as const;

export const browserExtractorSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  platform: nonEmpty,
  page_fingerprint_ref: nonEmpty,
  fields: z.array(z.object({
    key: nonEmpty,
    metric_name: nonEmpty,
    unit: z.string().optional(),
    period: z.string().optional(),
    source: z.enum(["semantic", "table", "page_data", "network_fact"]),
    strategies: z.array(z.object({ order: z.number().int().min(1), method: extractorMethodSchema, target: nonEmpty }).strict()).min(1),
    required: z.boolean()
  }).strict()).min(1),
  completeness_rules: z.object({
    required_field_keys: z.array(nonEmpty).refine((values) => new Set(values).size === values.length),
    sample_must_not_be_reported_as_complete: z.literal(true)
  }).strict(),
  redaction_required: z.literal(true)
}).strict().superRefine((value, context) => {
  const keys = new Set(value.fields.map((field) => field.key));
  for (const key of value.completeness_rules.required_field_keys) {
    if (!keys.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["completeness_rules", "required_field_keys"], message: `unknown required field ${key}` });
  }
  for (const [fieldIndex, field] of value.fields.entries()) {
    const ordered = [...field.strategies].sort((left, right) => left.order - right.order);
    let lastMethod = -1;
    for (const [strategyIndex, strategy] of ordered.entries()) {
      const method = BROWSER_EXTRACTOR_LOCATE_ORDER.indexOf(strategy.method);
      if (strategy.order !== strategyIndex + 1 || method < lastMethod) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", fieldIndex, "strategies"], message: "extractor strategies must use consecutive order and semantic-first precedence" });
        break;
      }
      lastMethod = method;
    }
  }
});
export type BrowserExtractor = z.infer<typeof browserExtractorSchema>;

export const browserSkillWorkflowV2Schema = z.object({
  version: z.literal(2),
  id: identifier,
  platform: nonEmpty,
  intent: nonEmpty,
  risk_class: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  page_ref: nonEmpty,
  extractor_refs: z.array(nonEmpty).min(1),
  route_ref: nonEmpty.optional(),
  required_context: z.object({
    shop_context_required: z.boolean(),
    shop_context_visible_required: z.boolean(),
    business_object_type: nonEmpty.optional(),
    business_object_visible_required: z.boolean()
  }).strict(),
  locate_order: z.tuple([
    z.literal("business_semantic_accessible_name"),
    z.literal("stable_element_ref"),
    z.literal("role_name"),
    z.literal("stable_selector"),
    z.literal("local_visual_confirmation")
  ]),
  steps: z.array(z.object({
    id: nonEmpty,
    action: z.enum(["observe", "navigate", "filter", "expand", "download", "assert", "record", "report", "handoff"]),
    description: nonEmpty,
    target: nonEmpty.optional(),
    selector: nonEmpty.optional(),
    expected: nonEmpty.optional(),
    readonly: z.literal(true),
    auto_retry: z.literal(false)
  }).strict()).min(1),
  handoff: z.object({ required: z.boolean(), trigger_conditions: z.array(nonEmpty), human_final_action: nonEmpty.optional() }).strict(),
  recovery_ref: nonEmpty
}).strict();
export type BrowserSkillWorkflowV2 = z.infer<typeof browserSkillWorkflowV2Schema>;

export const browserRecoveryPolicySchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  page_not_ready: z.literal("wait_once"),
  login_expired: z.literal("stop_human_login"),
  fingerprint_mismatch: z.enum(["readonly_fallback", "stop"]),
  shop_context_mismatch: z.literal("stop"),
  business_object_mismatch: z.literal("stop"),
  missing_element: z.literal("reobserve_once"),
  network_error: z.enum(["record_and_stop", "flow_contract"]),
  final_business_action_failure: z.literal("never_retry")
}).strict();
export type BrowserRecoveryPolicy = z.infer<typeof browserRecoveryPolicySchema>;

const fixtureElementSchema = z.object({
  ref: nonEmpty.optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  selector: z.string().optional()
}).passthrough();

export const browserRedactedSkillFixtureSchema = z.object({
  version: z.literal(1),
  skill_id: identifier,
  page_ref: nonEmpty,
  redacted: z.literal(true),
  task_context: z.object({
    platform: nonEmpty,
    shop: nonEmpty,
    business_object_type: nonEmpty,
    business_object_id: nonEmpty,
    business_object_display_name: nonEmpty
  }).strict(),
  snapshot: z.object({
    url: nonEmpty,
    title: z.string(),
    text: z.string(),
    elements: z.array(fixtureElementSchema),
    accessibility: z.array(z.object({ role: z.string().optional(), name: z.string().optional() }).passthrough()),
    tables: z.array(z.object({ headers: z.array(z.string()), sampleRows: z.array(z.array(z.string())) }).passthrough())
  }).strict()
}).strict();
export type BrowserRedactedSkillFixture = z.infer<typeof browserRedactedSkillFixtureSchema>;

const candidateCheckSchema = z.object({ status: z.enum(["pending", "passed", "failed"]), notes: z.array(nonEmpty) }).strict();
const strategyEvidenceSchema = z.object({ method: nonEmpty, target: nonEmpty, evidence_ref: nonEmpty }).strict();

export const browserExperienceCandidateSchema = z.object({
  version: z.literal(1),
  candidate_id: nonEmpty,
  task_id: nonEmpty,
  run_id: nonEmpty,
  platform: nonEmpty,
  page: nonEmpty,
  fingerprint_changes: z.array(nonEmpty),
  successful_strategies: z.array(strategyEvidenceSchema),
  failed_strategies: z.array(strategyEvidenceSchema),
  recovery: z.array(nonEmpty),
  evidence_refs: z.array(nonEmpty).min(1),
  sensitive_scan: candidateCheckSchema,
  duplicate_check: candidateCheckSchema,
  targeted_regression: candidateCheckSchema,
  suggested_skill_path: relativePath,
  approval: z.object({ status: z.enum(["pending", "approved", "rejected"]), approved_by: z.string().nullable(), approved_at: z.string().datetime().nullable() }).strict(),
  automatic_long_term_write: z.literal(false),
  created_at: z.string().datetime()
}).strict();
export type BrowserExperienceCandidate = z.infer<typeof browserExperienceCandidateSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function browserSkillPackContractHash(manifest: BrowserSkillPackManifest, resources: Record<string, unknown>): string {
  const normalizedManifest = { ...manifest, skill_contract_hash: "sha256:" + "0".repeat(64) };
  const payload = canonical({ manifest: normalizedManifest, resources });
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}
