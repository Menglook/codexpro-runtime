import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentTaskContractHash } from "../agents/completionProof.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import type { CodexProConfig } from "../config.js";
import type { BrowserSemanticSnapshot } from "./browser-session.js";
import {
  extractSemanticValueByTargets,
  loadBrowserSkillPacks,
  type LayeredBrowserSkillSource
} from "./browser-skill-pack-runtime.js";
import type { BrowserSkillWorkflowV2 } from "./browser-skill-pack-contract.js";
import {
  assertBrowserBusinessActionPermitted,
  assertBusinessContextMatches,
  businessFactSchema,
  businessRiskRank,
  browserBusinessActionSchema,
  browserBusinessRiskClassSchema,
  completionProofFieldsForBusinessTask,
  createHumanActionPackage,
  validateBrowserBusinessTask,
  type BrowserBusinessTask,
  type BusinessFact,
  type HumanActionPackage
} from "./browser-business-contract.js";

export const PLATFORM_SKILL_VERSION = 1;
export const PROJECT_BROWSER_SKILLS_DIR = ".codexpro/browser-skills";

const locateMethodSchema = z.enum([
  "business_semantic_accessible_name",
  "stable_element_ref",
  "role_name",
  "stable_selector",
  "local_visual_confirmation"
]);

const entryFingerprintSchema = z.object({
  type: z.enum(["url_contains", "hostname_contains", "title_contains", "text_contains", "element_text_contains", "accessible_name_contains"]),
  value: z.string().trim().min(1),
  required: z.boolean().optional()
}).strict();

const locateStrategySchema = z.object({
  order: z.number().int().min(1),
  method: locateMethodSchema,
  description: z.string().trim().min(1),
  target: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  ref_hint: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  visual_prompt: z.string().trim().min(1).optional()
}).strict();

const skillStepSchema = z.object({
  id: z.string().trim().min(1),
  action: browserBusinessActionSchema,
  description: z.string().trim().min(1),
  target: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  expected: z.string().trim().min(1).optional(),
  readonly: z.boolean().optional(),
  auto_retry: z.boolean().optional()
}).strict();

const skillAssertionSchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  fact_key: z.string().trim().min(1).optional(),
  text_contains: z.string().trim().min(1).optional(),
  required: z.boolean().optional()
}).strict();

const outputFactSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  required: z.boolean().optional(),
  patterns: z.array(z.string().trim().min(1)).optional()
}).strict();

const skillDiagnosticSchema = z.object({
  id: z.string().trim().min(1),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  fact_keys: z.array(z.string().trim().min(1)).min(1).optional(),
  match_any: z.array(z.string().trim().min(1)).min(1),
  reason: z.string().trim().min(1),
  human_steps: z.array(z.string().trim().min(1)).min(1)
}).strict();

const skillActionPackageSchema = z.object({
  when_diagnosis_ids: z.array(z.string().trim().min(1)).min(1).optional(),
  unless_diagnosis_ids: z.array(z.string().trim().min(1)).min(1).optional(),
  recommended_action: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  current_page_area: z.string().trim().min(1),
  steps: z.array(z.object({
    instruction: z.string().trim().min(1),
    action: z.string().trim().min(1).optional(),
    human_required: z.boolean()
  }).strict()).min(1),
  human_final_action: z.object({
    label: z.string().trim().min(1),
    must_be_performed_by: z.literal("human"),
    requires_confirmation: z.boolean(),
    irreversible: z.boolean().optional()
  }).strict(),
  expected_result: z.string().trim().min(1),
  risk_warnings: z.array(z.string().trim().min(1)).min(1),
  post_action_verification: z.array(z.string().trim().min(1)).min(1)
}).strict();

export const platformSkillSchema = z.object({
  version: z.literal(PLATFORM_SKILL_VERSION),
  id: z.string().trim().min(1),
  platform: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  risk_class: browserBusinessRiskClassSchema,
  entry_fingerprints: z.array(entryFingerprintSchema).min(1),
  required_context: z.object({
    platform: z.string().trim().min(1),
    shop_context_required: z.boolean(),
    shop_context_visible_required: z.boolean().optional(),
    business_object_type: z.string().trim().min(1).optional(),
    business_object_visible_required: z.boolean().optional()
  }).strict(),
  locate_strategies: z.array(locateStrategySchema).min(1),
  steps: z.array(skillStepSchema).min(1),
  assertions: z.array(skillAssertionSchema),
  diagnostics: z.array(skillDiagnosticSchema).optional(),
  handoff: z.object({
    required: z.boolean(),
    trigger_conditions: z.array(z.string().trim().min(1)),
    human_final_action: z.string().trim().min(1).optional(),
    action_package: skillActionPackageSchema.optional()
  }).strict(),
  recovery: z.object({
    on_fingerprint_mismatch: z.literal("stop"),
    on_context_mismatch: z.literal("stop"),
    auto_retry: z.literal(false).optional()
  }).strict(),
  outputs: z.object({
    facts: z.array(outputFactSchema).min(1),
    evidence: z.array(z.string().trim().min(1)),
    customer_questions: z.array(z.string().trim().min(1))
  }).strict()
}).strict();
export type PlatformSkill = z.infer<typeof platformSkillSchema>;

export interface LoadedPlatformSkill {
  skill: PlatformSkill;
  path: string;
  skill_contract_hash: string;
  source_contract_version: 1 | 2;
  layer: "workspace" | "user" | "builtin";
  pack_id?: string;
  pack_version?: string;
  pack_status?: "active" | "warning" | "quarantined" | "retired";
  pack_contract_hash?: string;
  pack_source?: LayeredBrowserSkillSource;
  migration?: {
    mode: "v1_compat" | "v2_compiled";
    original_contract_hash: string;
    runtime_contract_hash: string;
  };
}

export interface PlatformSkillFingerprintResult {
  ok: boolean;
  matches: Array<{ type: string; value: string; matched: boolean; required: boolean }>;
  reasons: string[];
}

export interface PlatformSkillContextResult {
  ok: boolean;
  shop_matched: boolean;
  business_object_matched: boolean;
  reasons: string[];
}

export interface PlatformSkillDiagnosis {
  id: string;
  severity: "info" | "warning" | "critical";
  reason: string;
  human_steps: string[];
  evidence_refs: string[];
}

export interface PlatformSkillRunResult {
  version: 1;
  skill_id: string;
  task_id: string;
  run_id: string;
  task_contract_hash: string;
  platform: string;
  shop_context: BrowserBusinessTask["shop_context"];
  business_object: BrowserBusinessTask["business_object"];
  current_page: {
    url: string;
    title: string;
    snapshot_id: string;
    session_id: string;
  };
  status: "completed" | "blocked";
  next_step?: string;
  facts: BusinessFact[];
  verification: {
    status: "verified" | "failed" | "unknown";
    reasons: string[];
  };
  evidence_refs: string[];
  browser_report_refs: string[];
  fingerprint: PlatformSkillFingerprintResult;
  context_match: PlatformSkillContextResult;
  diagnoses: PlatformSkillDiagnosis[];
  human_action_package?: HumanActionPackage;
  executed_steps: Array<{ id: string; action: string; description: string }>;
  deferred_steps: Array<{ id: string; action: string; description: string; reason: string }>;
  completion_proof_fields: Record<string, unknown>;
}

const LOCATE_METHOD_ORDER = [
  "business_semantic_accessible_name",
  "stable_element_ref",
  "role_name",
  "stable_selector",
  "local_visual_confirmation"
] as const;

const READ_ONLY_SKILL_ACTIONS = new Set(["observe", "navigate", "filter", "expand", "download", "assert", "record", "report", "handoff"]);
const DEFERRED_SKILL_ACTIONS = new Set(["navigate", "filter", "expand", "download", "handoff"]);

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function safeIncludes(haystack: string | undefined, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function hostnameIncludes(rawUrl: string | undefined, needle: string): boolean {
  try {
    return safeIncludes(new URL(rawUrl ?? "").hostname, needle);
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function textForSkillScan(skill: PlatformSkill): string {
  return JSON.stringify(skill);
}

function assertNoFixedCoordinates(skill: PlatformSkill): void {
  const text = textForSkillScan(skill);
  if (/"(?:x|y|left|top|screen_x|screen_y)"\s*:\s*\d+/i.test(text)) {
    throw new CodexProError(`platform_skill ${skill.id} must not use fixed coordinates.`);
  }
  if (/\bfixed[_ -]?coordinates?\b|固定坐标/i.test(text)) {
    throw new CodexProError(`platform_skill ${skill.id} must not mention fixed coordinates as a locate strategy.`);
  }
}

function assertLocateOrder(skill: PlatformSkill): void {
  const ordered = [...skill.locate_strategies].sort((left, right) => left.order - right.order);
  let lastIndex = -1;
  for (const strategy of ordered) {
    const index = LOCATE_METHOD_ORDER.indexOf(strategy.method);
    if (index < lastIndex) {
      throw new CodexProError(`platform_skill ${skill.id} locate strategies are out of required order.`);
    }
    lastIndex = index;
  }
  if (ordered[0]?.method !== "business_semantic_accessible_name") {
    throw new CodexProError(`platform_skill ${skill.id} must start with business semantic/accessibility location.`);
  }
}

function assertStepsWithinSkillRisk(skill: PlatformSkill): void {
  for (const step of skill.steps) {
    if (!READ_ONLY_SKILL_ACTIONS.has(step.action)) {
      throw new CodexProError(`platform_skill ${skill.id} step ${step.id} uses unsupported action ${step.action}.`);
    }
    if (step.auto_retry === true) {
      throw new CodexProError(`platform_skill ${skill.id} step ${step.id} enables auto_retry; side-effect actions must never auto-retry.`);
    }
    if (step.readonly === false) {
      throw new CodexProError(`platform_skill ${skill.id} step ${step.id} is not read-only.`);
    }
  }
}

export function validatePlatformSkill(value: unknown): PlatformSkill {
  const skill = platformSkillSchema.parse(value);
  assertNoFixedCoordinates(skill);
  assertLocateOrder(skill);
  assertStepsWithinSkillRisk(skill);
  return skill;
}

export function platformSkillHash(skill: PlatformSkill): string {
  return agentTaskContractHash({ version: PLATFORM_SKILL_VERSION, platform_skill: skill });
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function collectLegacyJsonFiles(absDir: string): Promise<string[]> {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json")
      .map((entry) => path.join(absDir, entry.name))
      .sort((left, right) => left.localeCompare(right));
  }
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await collectLegacyJsonFiles(abs));
    else if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json") files.push(abs);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function v2FingerprintType(type: LayeredBrowserSkillSource["page"]["signals"][number]["type"]): PlatformSkill["entry_fingerprints"][number]["type"] | undefined {
  if (type === "hostname") return "hostname_contains";
  if (type === "url_path") return "url_contains";
  if (type === "title") return "title_contains";
  if (type === "accessible_name") return "accessible_name_contains";
  if (type === "text_absent") return undefined;
  return "text_contains";
}

export function compileBrowserSkillPackWorkflow(source: LayeredBrowserSkillSource): PlatformSkill {
  const workflow = source.workflow;
  const extractorFields = source.extractors.flatMap((extractor) => extractor.fields);
  const uniqueFields = [...new Map(extractorFields.map((field) => [field.key, field])).values()];
  const requiredKeys = new Set(source.extractors.flatMap((extractor) => extractor.completeness_rules.required_field_keys));
  const semanticTargets = [...new Set(extractorFields.flatMap((field) => field.strategies.map((strategy) => strategy.target)))].join("|") || workflow.id;
  const entryFingerprints = source.page.signals
    .map((signal) => {
      const type = v2FingerprintType(signal.type);
      return type ? { type, value: signal.value, required: signal.required } : undefined;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (!entryFingerprints.length) entryFingerprints.push({ type: "text_contains", value: source.page.page, required: false });
  const locateStrategies = workflow.locate_order.map((method, index) => ({
    order: index + 1,
    method,
    description: `Browser Skill Pack v2 governed ${method} strategy for ${workflow.id}.`,
    target: semanticTargets
  }));
  return validatePlatformSkill({
    version: 1,
    id: workflow.id,
    platform: workflow.platform,
    intent: workflow.intent,
    risk_class: workflow.risk_class,
    entry_fingerprints: entryFingerprints,
    required_context: {
      platform: workflow.platform,
      shop_context_required: workflow.required_context.shop_context_required,
      shop_context_visible_required: workflow.required_context.shop_context_visible_required,
      ...(workflow.required_context.business_object_type ? { business_object_type: workflow.required_context.business_object_type } : {}),
      business_object_visible_required: workflow.required_context.business_object_visible_required
    },
    locate_strategies: locateStrategies,
    steps: workflow.steps,
    assertions: uniqueFields.map((field) => ({
      id: `${field.key}-evidence`,
      description: `${field.metric_name} has direct redacted browser evidence.`,
      fact_key: field.key,
      required: requiredKeys.has(field.key) || field.required
    })),
    handoff: workflow.handoff,
    recovery: {
      on_fingerprint_mismatch: "stop",
      on_context_mismatch: "stop",
      auto_retry: false
    },
    outputs: {
      facts: uniqueFields.map((field) => ({
        key: field.key,
        label: field.metric_name,
        required: requiredKeys.has(field.key) || field.required,
        patterns: [...new Set(field.strategies.map((strategy) => strategy.target))]
      })),
      evidence: ["browser_snapshot", "browser_skill_pack", "redacted_fixture"],
      customer_questions: []
    }
  });
}

export function migratePlatformSkillV1ToV2Candidate(skillValue: unknown): {
  workflow: BrowserSkillWorkflowV2;
  original_contract_hash: string;
  candidate_contract_hash: string;
  automatic_long_term_write: false;
} {
  const skill = validatePlatformSkill(skillValue);
  if (skill.steps.some((step) => step.action === "prepare_draft")) {
    throw new CodexProError(`platform_skill ${skill.id} contains prepare_draft and cannot be migrated to Browser Skill Pack v2.`);
  }
  const workflow: BrowserSkillWorkflowV2 = {
    version: 2,
    id: skill.id,
    platform: skill.platform,
    intent: skill.intent,
    risk_class: skill.risk_class,
    page_ref: `${skill.id}.page`,
    extractor_refs: [`${skill.id}.extractor`],
    required_context: {
      shop_context_required: skill.required_context.shop_context_required,
      shop_context_visible_required: skill.required_context.shop_context_visible_required === true,
      ...(skill.required_context.business_object_type ? { business_object_type: skill.required_context.business_object_type } : {}),
      business_object_visible_required: skill.required_context.business_object_visible_required === true
    },
    locate_order: ["business_semantic_accessible_name", "stable_element_ref", "role_name", "stable_selector", "local_visual_confirmation"],
    steps: skill.steps.map((step) => ({
      ...step,
      action: step.action as Exclude<typeof step.action, "prepare_draft">,
      readonly: true as const,
      auto_retry: false as const
    })),
    handoff: {
      required: skill.handoff.required,
      trigger_conditions: skill.handoff.trigger_conditions,
      ...(skill.handoff.human_final_action ? { human_final_action: skill.handoff.human_final_action } : {})
    },
    recovery_ref: `${skill.id}.safe-recovery`
  };
  return {
    workflow,
    original_contract_hash: platformSkillHash(skill),
    candidate_contract_hash: agentTaskContractHash({ version: 2, browser_skill_workflow: workflow }),
    automatic_long_term_write: false
  };
}

export async function loadProjectPlatformSkills(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<LoadedPlatformSkill[]> {
  const packLoad = await loadBrowserSkillPacks(config, guard, workspace);
  const loadedById = new Map<string, LoadedPlatformSkill>();
  for (const layer of ["workspace", "user", "builtin"] as const) {
    const legacyRoot = packLoad.roots[layer];
    if (!await pathExists(legacyRoot)) continue;
    for (const absPath of await collectLegacyJsonFiles(legacyRoot)) {
      const raw = JSON.parse(await fsp.readFile(absPath, "utf8"));
      if (raw?.version !== PLATFORM_SKILL_VERSION || typeof raw?.id !== "string") continue;
      const skill = validatePlatformSkill(raw);
      if (layer === "builtin" && /^(?:wb|wildberries|ozon)$/i.test(skill.platform)) {
        throw new CodexProError(`Builtin legacy platform skill ${skill.id} must remain platform-neutral.`);
      }
      if (loadedById.has(skill.id)) continue;
      const runtimeHash = platformSkillHash(skill);
      loadedById.set(skill.id, {
        skill,
        path: layer === "workspace" ? path.relative(workspace.root, absPath).replace(/\\/g, "/") : absPath,
        skill_contract_hash: runtimeHash,
        source_contract_version: 1,
        layer,
        migration: { mode: "v1_compat", original_contract_hash: runtimeHash, runtime_contract_hash: runtimeHash }
      });
    }
    for (const source of packLoad.selected_workflows.filter((entry) => entry.layer === layer)) {
      if (loadedById.has(source.workflow.id)) continue;
      const skill = compileBrowserSkillPackWorkflow(source);
      const runtimeHash = platformSkillHash(skill);
      loadedById.set(skill.id, {
        skill,
        path: path.relative(workspace.root, path.join(source.pack.root, source.pack.manifest.resources.workflows[source.pack.workflows.indexOf(source.workflow)] ?? "manifest.json")).replace(/\\/g, "/"),
        skill_contract_hash: runtimeHash,
        source_contract_version: 2,
        layer,
        pack_id: source.pack.manifest.pack_id,
        pack_version: source.pack.manifest.pack_version,
        pack_status: source.pack.manifest.status,
        pack_contract_hash: source.pack.manifest.skill_contract_hash,
        pack_source: source,
        migration: {
          mode: "v2_compiled",
          original_contract_hash: source.pack.manifest.skill_contract_hash,
          runtime_contract_hash: runtimeHash
        }
      });
    }
  }
  return [...loadedById.values()].sort((left, right) => left.skill.id.localeCompare(right.skill.id));
}

export async function readProjectPlatformSkill(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  skillId: string
): Promise<LoadedPlatformSkill> {
  const skills = await loadProjectPlatformSkills(config, guard, workspace);
  const found = skills.find((entry) => entry.skill.id === skillId);
  if (!found) throw new CodexProError(`Platform skill not found: ${skillId}`);
  return found;
}

export function validateSkillForTask(skill: PlatformSkill, taskValue: unknown): BrowserBusinessTask {
  const task = validateBrowserBusinessTask(taskValue);
  assertBusinessContextMatches(task, {
    platform: skill.platform,
    shop_context: task.shop_context,
    business_object: task.business_object
  }, `platform_skill ${skill.id}`);
  if (normalize(skill.required_context.platform) !== normalize(task.platform)) {
    throw new CodexProError(`platform_skill ${skill.id} platform does not match task platform.`);
  }
  if (skill.required_context.shop_context_required && !task.shop_context) {
    throw new CodexProError(`platform_skill ${skill.id} requires shop_context.`);
  }
  if (skill.required_context.business_object_type && normalize(skill.required_context.business_object_type) !== normalize(task.business_object.type)) {
    throw new CodexProError(`platform_skill ${skill.id} requires business object type ${skill.required_context.business_object_type}.`);
  }
  if (businessRiskRank(skill.risk_class) > businessRiskRank(task.risk_class)) {
    throw new CodexProError(`platform_skill ${skill.id} risk ${skill.risk_class} exceeds task risk ${task.risk_class}.`);
  }
  for (const step of skill.steps) {
    assertBrowserBusinessActionPermitted(task, step.action, `platform_skill ${skill.id} step ${step.id}`);
  }
  return task;
}

function elementText(snapshot: BrowserSemanticSnapshot): string {
  return snapshot.elements
    .map((element) => [element.text, element.name, element.role, element.placeholder].filter(Boolean).join(" "))
    .join("\n");
}

function snapshotScanText(snapshot: BrowserSemanticSnapshot): string {
  return [
    snapshot.url,
    snapshot.title,
    snapshot.text,
    elementText(snapshot),
    ...(snapshot.accessibility ?? []).map((node) => [node.role, node.name].filter(Boolean).join(" "))
  ].filter(Boolean).join("\n");
}

function taskShopPatterns(task: BrowserBusinessTask): string[] {
  return unique([
    task.shop_context.shop_id ?? "",
    task.shop_context.shop_name ?? "",
    task.shop_context.display_name ?? "",
    task.shop_context.account_id ?? ""
  ]);
}

function taskBusinessObjectPatterns(task: BrowserBusinessTask): string[] {
  return unique([task.business_object.id, task.business_object.display_name]);
}

function taskScopedTableCandidates(task: BrowserBusinessTask, snapshot: BrowserSemanticSnapshot): string[] {
  const objectPatterns = taskBusinessObjectPatterns(task);
  return unique(snapshot.tables.flatMap((table) => table.sampleRows
    .filter((row) => objectPatterns.some((pattern) => row.some((cell) => safeIncludes(cell, pattern))))
    .flatMap((row) => [
      ...row,
      ...row.map((cell, index) => [table.headers[index], cell].filter(Boolean).join(" ")),
      row.join(" ")
    ])));
}

function taskScopedScanText(task: BrowserBusinessTask, snapshot: BrowserSemanticSnapshot): string {
  const scoped = taskScopedTableCandidates(task, snapshot);
  return scoped.length ? scoped.join("\n") : snapshotScanText(snapshot);
}

export function checkVisibleTaskContext(
  skill: PlatformSkill,
  task: BrowserBusinessTask,
  snapshot: BrowserSemanticSnapshot
): PlatformSkillContextResult {
  const scanText = snapshotScanText(snapshot);
  const shopRequired = skill.required_context.shop_context_visible_required === true;
  const objectRequired = skill.required_context.business_object_visible_required === true;
  const shopPatterns = taskShopPatterns(task);
  const objectPatterns = taskBusinessObjectPatterns(task);
  const shopMatched = !shopRequired || shopPatterns.some((pattern) => safeIncludes(scanText, pattern));
  const businessObjectMatched = !objectRequired || objectPatterns.some((pattern) => safeIncludes(scanText, pattern));
  const reasons: string[] = [];
  if (!shopMatched) reasons.push("Required shop context is not visible on the current page.");
  if (!businessObjectMatched) reasons.push("Required business object is not visible on the current page.");
  return {
    ok: shopMatched && businessObjectMatched,
    shop_matched: shopMatched,
    business_object_matched: businessObjectMatched,
    reasons
  };
}

function evaluateSkillDiagnostics(
  skill: PlatformSkill,
  task: BrowserBusinessTask,
  snapshot: BrowserSemanticSnapshot,
  facts: BusinessFact[]
): PlatformSkillDiagnosis[] {
  const factByKey = new Map(facts.map((fact) => [fact.key, fact]));
  return (skill.diagnostics ?? [])
    .filter((diagnostic) => {
      const scanText = diagnostic.fact_keys?.length
        ? diagnostic.fact_keys.map((key) => String(factByKey.get(key)?.value ?? "")).filter(Boolean).join("\n")
        : taskScopedScanText(task, snapshot);
      return diagnostic.match_any.some((pattern) => safeIncludes(scanText, pattern));
    })
    .map((diagnostic) => ({
      id: diagnostic.id,
      severity: diagnostic.severity,
      reason: diagnostic.reason,
      human_steps: diagnostic.human_steps,
      evidence_refs: unique([
        `browser_snapshot:${snapshot.snapshotId}`,
        ...(diagnostic.fact_keys ?? []).flatMap((key) => factByKey.get(key)?.evidence_refs ?? [])
      ])
    }));
}

function createSkillHumanActionPackage(input: {
  skill: PlatformSkill;
  task: BrowserBusinessTask;
  snapshot: BrowserSemanticSnapshot;
  facts: BusinessFact[];
  diagnoses: PlatformSkillDiagnosis[];
  evidenceRefs: string[];
}): HumanActionPackage | undefined {
  const actionPackage = input.skill.handoff.action_package;
  if (!actionPackage) return undefined;
  if (actionPackage.when_diagnosis_ids?.length
    && !input.diagnoses.some((diagnosis) => actionPackage.when_diagnosis_ids?.includes(diagnosis.id))) {
    return undefined;
  }
  if (actionPackage.unless_diagnosis_ids?.length
    && input.diagnoses.some((diagnosis) => actionPackage.unless_diagnosis_ids?.includes(diagnosis.id))) {
    return undefined;
  }
  const diagnosisReason = input.diagnoses.map((entry) => entry.reason).join(" ");
  const diagnosisSteps = input.diagnoses.flatMap((entry) => entry.human_steps);
  return createHumanActionPackage({
    task: input.task,
    current_facts: input.facts,
    recommended_action: actionPackage.recommended_action,
    reason: [actionPackage.reason, diagnosisReason].filter(Boolean).join(" "),
    current_page: {
      url: input.snapshot.url,
      title: input.snapshot.title,
      area: actionPackage.current_page_area
    },
    steps: unique([
      ...actionPackage.steps.map((step) => step.instruction),
      ...diagnosisSteps
    ]).map((instruction, index) => {
      const configured = actionPackage.steps.find((step) => step.instruction === instruction);
      return {
        index: index + 1,
        instruction,
        action: configured?.action,
        human_required: configured?.human_required ?? true
      };
    }),
    human_final_action: actionPackage.human_final_action,
    expected_result: actionPackage.expected_result,
    risk_warnings: actionPackage.risk_warnings,
    post_action_verification: actionPackage.post_action_verification,
    before_evidence: input.evidenceRefs
  });
}

export function checkEntryFingerprints(skill: PlatformSkill, snapshot: BrowserSemanticSnapshot): PlatformSkillFingerprintResult {
  const matches = skill.entry_fingerprints.map((fingerprint) => {
    let matched = false;
    if (fingerprint.type === "url_contains") matched = safeIncludes(snapshot.url, fingerprint.value);
    if (fingerprint.type === "hostname_contains") matched = hostnameIncludes(snapshot.url, fingerprint.value);
    if (fingerprint.type === "title_contains") matched = safeIncludes(snapshot.title, fingerprint.value);
    if (fingerprint.type === "text_contains") matched = safeIncludes(snapshot.text, fingerprint.value);
    if (fingerprint.type === "element_text_contains") matched = safeIncludes(elementText(snapshot), fingerprint.value);
    if (fingerprint.type === "accessible_name_contains") matched = snapshot.accessibility?.some((node) => safeIncludes(node.name, fingerprint.value)) ?? false;
    return {
      type: fingerprint.type,
      value: fingerprint.value,
      matched,
      required: fingerprint.required !== false
    };
  });
  const failedRequired = matches.filter((match) => match.required && !match.matched);
  return {
    ok: failedRequired.length === 0,
    matches,
    reasons: failedRequired.map((match) => `Required entry fingerprint did not match: ${match.type}=${match.value}`)
  };
}

function moneyLikeValue(text: string): string | undefined {
  return text.match(/[-+]?\d[\d\s,.]*(?:\.\d+)?\s*(?:RUB|RUR|USD|EUR|₽|руб\.?)?/i)?.[0]?.trim();
}

function taskPatternsForFact(task: BrowserBusinessTask, factKey: string): string[] {
  if (factKey === "shop_context") return taskShopPatterns(task);
  if (["report_period", "order_id", "order_number", "business_object", "business_object_id"].includes(factKey)) {
    return taskBusinessObjectPatterns(task);
  }
  return [];
}

function extractFact(
  snapshot: BrowserSemanticSnapshot,
  output: PlatformSkill["outputs"]["facts"][number],
  task: BrowserBusinessTask
): BusinessFact {
  const taskPatterns = taskPatternsForFact(task, output.key);
  const genericPatterns = output.patterns?.length ? output.patterns : [output.label, output.key];
  const scanText = snapshotScanText(snapshot);
  const allCandidates = unique([
    ...snapshot.text.split(/\r?\n/),
    ...snapshot.elements.flatMap((element) => [element.text ?? "", element.name ?? ""]),
    ...(snapshot.accessibility ?? []).map((node) => node.name ?? "")
  ]);
  const scopedCandidates = output.key === "shop_context" ? [] : taskScopedTableCandidates(task, snapshot);
  const candidates = scopedCandidates.length ? scopedCandidates : allCandidates;
  const taskScopedLine = taskPatterns.length
    ? candidates.find((candidate) => taskPatterns.some((pattern) => safeIncludes(candidate, pattern)))
    : undefined;
  const genericLine = candidates.find((candidate) => genericPatterns.some((pattern) => safeIncludes(candidate, pattern)));
  const line = taskScopedLine ?? genericLine;
  const monetaryFact = /(?:amount|balance|credit|recharge|deduction|fee|cost|price)/i.test(output.key);
  const exactContextValue = output.key === "shop_context"
    ? taskShopPatterns(task).find((pattern) => safeIncludes(scanText, pattern))
    : output.key === "business_object"
      ? taskBusinessObjectPatterns(task).find((pattern) => safeIncludes(scanText, pattern))
      : undefined;
  const semanticValue = ["metric_value", "status"].includes(output.key)
    ? extractSemanticValueByTargets(snapshot, genericPatterns)
    : undefined;
  const value = exactContextValue ?? semanticValue ?? (line
    ? monetaryFact
      ? moneyLikeValue(line) ?? line.slice(0, 300)
      : line.slice(0, 300)
    : undefined);
  return businessFactSchema.parse({
    key: output.key,
    label: output.label,
    value,
    evidence_refs: value === undefined ? [] : [`browser_snapshot:${snapshot.snapshotId}`],
    observed_at: snapshot.timestamp,
    source: "platform_skill"
  });
}

function verifySkillAssertions(skill: PlatformSkill, snapshot: BrowserSemanticSnapshot, facts: BusinessFact[]): PlatformSkillRunResult["verification"] {
  const factByKey = new Map(facts.map((fact) => [fact.key, fact]));
  const reasons: string[] = [];
  let failed = false;
  let unknown = false;
  for (const assertion of skill.assertions) {
    if (assertion.fact_key) {
      const fact = factByKey.get(assertion.fact_key);
      if (!fact?.evidence_refs.length || fact.value === undefined) {
        if (assertion.required !== false) unknown = true;
        reasons.push(`Missing or insufficient evidence for assertion ${assertion.id}.`);
      }
    }
    if (assertion.text_contains && !safeIncludes(snapshot.text, assertion.text_contains)) {
      if (assertion.required === false) continue;
      failed = true;
      reasons.push(`Text assertion ${assertion.id} did not match.`);
    }
  }
  if (failed) return { status: "failed", reasons };
  if (unknown) return { status: "unknown", reasons };
  return { status: "verified", reasons: [] };
}

export function runPlatformSkillWithObservation(input: {
  task: unknown;
  skill: unknown;
  observation: BrowserSemanticSnapshot;
  browser_report_refs?: string[];
}): PlatformSkillRunResult {
  const skill = validatePlatformSkill(input.skill);
  const task = validateSkillForTask(skill, input.task);
  const fingerprint = checkEntryFingerprints(skill, input.observation);
  const contextMatch = checkVisibleTaskContext(skill, task, input.observation);
  const browserReportRefs = input.browser_report_refs ?? [];
  const baseEvidenceRefs = unique([`browser_snapshot:${input.observation.snapshotId}`, ...browserReportRefs]);
  if (!fingerprint.ok) {
    return {
      version: 1,
      skill_id: skill.id,
      task_id: task.task_id,
      run_id: task.run_id,
      task_contract_hash: task.task_contract_hash,
      platform: task.platform,
      shop_context: task.shop_context,
      business_object: task.business_object,
      current_page: {
        url: input.observation.url,
        title: input.observation.title,
        snapshot_id: input.observation.snapshotId,
        session_id: input.observation.sessionId
      },
      status: "blocked",
      next_step: "Stop: page entry fingerprints do not match this platform skill.",
      facts: [],
      verification: { status: "unknown", reasons: fingerprint.reasons },
      evidence_refs: baseEvidenceRefs,
      browser_report_refs: browserReportRefs,
      fingerprint,
      context_match: contextMatch,
      diagnoses: [],
      executed_steps: [],
      deferred_steps: skill.steps.map((step) => ({
        id: step.id,
        action: step.action,
        description: step.description,
        reason: "entry_fingerprint_mismatch"
      })),
      completion_proof_fields: completionProofFieldsForBusinessTask(task)
    };
  }
  if (!contextMatch.ok) {
    return {
      version: 1,
      skill_id: skill.id,
      task_id: task.task_id,
      run_id: task.run_id,
      task_contract_hash: task.task_contract_hash,
      platform: task.platform,
      shop_context: task.shop_context,
      business_object: task.business_object,
      current_page: {
        url: input.observation.url,
        title: input.observation.title,
        snapshot_id: input.observation.snapshotId,
        session_id: input.observation.sessionId
      },
      status: "blocked",
      next_step: "Stop: visible shop or business-object context does not match this task.",
      facts: [],
      verification: { status: "unknown", reasons: contextMatch.reasons },
      evidence_refs: baseEvidenceRefs,
      browser_report_refs: browserReportRefs,
      fingerprint,
      context_match: contextMatch,
      diagnoses: [],
      executed_steps: [],
      deferred_steps: skill.steps.map((step) => ({
        id: step.id,
        action: step.action,
        description: step.description,
        reason: "visible_context_mismatch"
      })),
      completion_proof_fields: completionProofFieldsForBusinessTask(task)
    };
  }
  const facts = skill.outputs.facts.map((output) => extractFact(input.observation, output, task));
  const verification = verifySkillAssertions(skill, input.observation, facts);
  const diagnoses = evaluateSkillDiagnostics(skill, task, input.observation, facts);
  const evidenceRefs = unique([
    ...baseEvidenceRefs,
    ...facts.flatMap((fact) => fact.evidence_refs),
    ...diagnoses.flatMap((diagnosis) => diagnosis.evidence_refs)
  ]);
  const humanActionPackage = createSkillHumanActionPackage({
    skill,
    task,
    snapshot: input.observation,
    facts,
    diagnoses,
    evidenceRefs
  });
  const executedSteps = skill.steps
    .filter((step) => step.action === "observe"
      || step.action === "assert"
      || step.action === "record"
      || step.action === "report"
      || (step.action === "handoff" && humanActionPackage !== undefined))
    .map((step) => ({ id: step.id, action: step.action, description: step.description }));
  const deferredSteps = skill.steps
    .filter((step) => DEFERRED_SKILL_ACTIONS.has(step.action) && !(step.action === "handoff" && humanActionPackage !== undefined))
    .map((step) => ({
      id: step.id,
      action: step.action,
      description: step.description,
      reason: step.action === "handoff"
        ? "human_handoff_boundary"
        : step.action === "download"
          ? "requires_controlled_browser_download"
        : "requires_current_authorized_page_interaction"
    }));
  return {
    version: 1,
    skill_id: skill.id,
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object,
    current_page: {
      url: input.observation.url,
      title: input.observation.title,
      snapshot_id: input.observation.snapshotId,
      session_id: input.observation.sessionId
    },
    status: "completed",
    next_step: deferredSteps[0]?.description,
    facts,
    verification,
    evidence_refs: evidenceRefs,
    browser_report_refs: browserReportRefs,
    fingerprint,
    context_match: contextMatch,
    diagnoses,
    human_action_package: humanActionPackage,
    executed_steps: executedSteps,
    deferred_steps: deferredSteps,
    completion_proof_fields: completionProofFieldsForBusinessTask(task)
  };
}
