import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import type { BrowserSemanticSnapshot } from "./browser-session.js";
import {
  BROWSER_SKILL_PACK_LAYERS,
  BROWSER_SKILL_PACK_RUNTIME_VERSION,
  browserExtractorSchema,
  browserNavigationMapSchema,
  browserPageFingerprintSchema,
  browserRecoveryPolicySchema,
  browserRedactedSkillFixtureSchema,
  browserSkillPackContractHash,
  browserSkillPackManifestSchema,
  browserSkillWorkflowV2Schema,
  type BrowserExtractor,
  type BrowserNavigationMap,
  type BrowserPageFingerprint,
  type BrowserRecoveryPolicy,
  type BrowserRedactedSkillFixture,
  type BrowserSkillPackManifest,
  type BrowserSkillWorkflowV2
} from "./browser-skill-pack-contract.js";

export const BROWSER_BUILTIN_SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../browser-skills-builtin");

export interface BrowserSkillPackRoots {
  workspace: string;
  user: string;
  builtin: string;
}

export interface LoadedBrowserSkillPack {
  manifest: BrowserSkillPackManifest;
  root: string;
  manifest_path: string;
  pages: BrowserPageFingerprint[];
  navigation: BrowserNavigationMap[];
  extractors: BrowserExtractor[];
  workflows: BrowserSkillWorkflowV2[];
  recovery: BrowserRecoveryPolicy[];
  fixtures: BrowserRedactedSkillFixture[];
  resources: Record<string, unknown>;
  calculated_contract_hash: string;
}

export interface LayeredBrowserSkillSource {
  workflow: BrowserSkillWorkflowV2;
  pack: LoadedBrowserSkillPack;
  page: BrowserPageFingerprint;
  extractors: BrowserExtractor[];
  recovery: BrowserRecoveryPolicy;
  layer: typeof BROWSER_SKILL_PACK_LAYERS[number];
  shadowed: Array<{ layer: typeof BROWSER_SKILL_PACK_LAYERS[number]; pack_id: string; path: string }>;
}

export interface BrowserSkillPackLoadResult {
  roots: BrowserSkillPackRoots;
  packs: LoadedBrowserSkillPack[];
  selected_workflows: LayeredBrowserSkillSource[];
  shadowed_packs: Array<{ pack_id: string; selected_layer: string; shadowed_layer: string; shadowed_path: string }>;
}

export interface BrowserPageFingerprintMatch {
  type: BrowserPageFingerprint["signals"][number]["type"];
  value: string;
  required: boolean;
  matched: boolean;
}

export interface BrowserPageFingerprintEvaluation {
  ok: boolean;
  matches: BrowserPageFingerprintMatch[];
  required_matches: number;
  required_total: number;
  reasons: string[];
}

export interface BrowserSkillDriftState {
  version: 1;
  pack_id: string;
  page_id: string;
  run_id: string;
  status: "active" | "warning" | "quarantined";
  consecutive_failures: number;
  last_checked_at: string;
  last_snapshot_id: string;
  reasons: string[];
  interaction_allowed: boolean;
}

export interface BrowserSkillPackFact {
  platform: string;
  shop: string;
  business_object: string;
  metric_name: string;
  value?: string;
  unit: string;
  period: string;
  source_page: string;
  observed_at: string;
  evidence_ref: string;
  completeness: "complete" | "partial" | "missing";
  confidence: "high" | "medium" | "low";
}

function userSkillsRoot(): string {
  const override = process.env.CODEXPRO_BROWSER_USER_SKILLS_ROOT?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".codexpro", "browser-skills");
}

function builtinSkillsRoot(): string {
  const override = process.env.CODEXPRO_BROWSER_BUILTIN_SKILLS_ROOT?.trim();
  return override ? path.resolve(override) : BROWSER_BUILTIN_SKILLS_ROOT;
}

export function browserSkillPackRoots(guard: PathGuard, workspace: Workspace): BrowserSkillPackRoots {
  return {
    workspace: guard.resolve(workspace, ".codexpro/browser-skills").absPath,
    user: userSkillsRoot(),
    builtin: builtinSkillsRoot()
  };
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function findManifestFiles(root: string): Promise<string[]> {
  if (!await exists(root)) return [];
  const out: string[] = [];
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
      out.push(path.join(current, "manifest.json"));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(current, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return out.sort((left, right) => left.localeCompare(right));
}

function assertContainedResource(packRoot: string, relative: string): string {
  const abs = path.resolve(packRoot, relative);
  const relation = path.relative(packRoot, abs);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new CodexProError(`Browser Skill Pack resource escapes pack root: ${relative}`);
  return abs;
}

async function readResourceJson(packRoot: string, relative: string): Promise<unknown> {
  const abs = assertContainedResource(packRoot, relative);
  const realPackRoot = await fsp.realpath(packRoot);
  const real = await fsp.realpath(abs).catch(() => { throw new CodexProError(`Browser Skill Pack resource is missing: ${relative}`); });
  const relation = path.relative(realPackRoot, real);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new CodexProError(`Browser Skill Pack resource resolves outside pack root: ${relative}`);
  return JSON.parse(await fsp.readFile(real, "utf8"));
}

function assertPlatform(pack: BrowserSkillPackManifest, resource: { platform?: string; id?: string }): void {
  if (resource.platform && resource.platform.toLowerCase() !== pack.platform.toLowerCase()) {
    throw new CodexProError(`Browser Skill Pack ${pack.pack_id} resource ${resource.id ?? "unknown"} has mismatched platform.`);
  }
}

async function loadPack(manifestPath: string, expectedLayer: BrowserSkillPackManifest["layer"]): Promise<LoadedBrowserSkillPack> {
  const root = path.dirname(manifestPath);
  const manifest = browserSkillPackManifestSchema.parse(JSON.parse(await fsp.readFile(manifestPath, "utf8")));
  if (manifest.layer !== expectedLayer) throw new CodexProError(`Browser Skill Pack ${manifest.pack_id} declares layer ${manifest.layer}, expected ${expectedLayer}.`);
  if (expectedLayer === "builtin" && /^(?:wb|wildberries|ozon)$/i.test(manifest.platform)) {
    throw new CodexProError(`Builtin Browser Skill Pack ${manifest.pack_id} must remain platform-neutral.`);
  }
  if (manifest.compatible_runtime !== BROWSER_SKILL_PACK_RUNTIME_VERSION) {
    throw new CodexProError(`Browser Skill Pack ${manifest.pack_id} requires ${manifest.compatible_runtime}; current runtime is ${BROWSER_SKILL_PACK_RUNTIME_VERSION}.`);
  }

  const resources: Record<string, unknown> = {};
  for (const group of Object.values(manifest.resources)) {
    for (const relative of group) resources[relative] = await readResourceJson(root, relative);
  }
  const pages = manifest.resources.pages.map((relative) => browserPageFingerprintSchema.parse(resources[relative]));
  const navigation = manifest.resources.navigation.map((relative) => browserNavigationMapSchema.parse(resources[relative]));
  const extractors = manifest.resources.extractors.map((relative) => browserExtractorSchema.parse(resources[relative]));
  const workflows = manifest.resources.workflows.map((relative) => browserSkillWorkflowV2Schema.parse(resources[relative]));
  const recovery = manifest.resources.recovery.map((relative) => browserRecoveryPolicySchema.parse(resources[relative]));
  const fixtures = manifest.resources.fixtures.map((relative) => browserRedactedSkillFixtureSchema.parse(resources[relative]));
  for (const resource of [...pages, ...navigation, ...extractors, ...workflows]) assertPlatform(manifest, resource);

  const pageIds = new Set(pages.map((entry) => entry.id));
  const extractorIds = new Set(extractors.map((entry) => entry.id));
  const routeIds = new Set(navigation.flatMap((entry) => entry.routes.map((route) => route.id)));
  const recoveryIds = new Set(recovery.map((entry) => entry.id));
  const workflowIds = new Set<string>();
  for (const workflow of workflows) {
    if (workflowIds.has(workflow.id)) throw new CodexProError(`Browser Skill Pack ${manifest.pack_id} duplicates workflow ${workflow.id}.`);
    workflowIds.add(workflow.id);
    if (!pageIds.has(workflow.page_ref)) throw new CodexProError(`Workflow ${workflow.id} references unknown page ${workflow.page_ref}.`);
    for (const ref of workflow.extractor_refs) if (!extractorIds.has(ref)) throw new CodexProError(`Workflow ${workflow.id} references unknown extractor ${ref}.`);
    if (workflow.route_ref && !routeIds.has(workflow.route_ref)) throw new CodexProError(`Workflow ${workflow.id} references unknown route ${workflow.route_ref}.`);
    if (!recoveryIds.has(workflow.recovery_ref)) throw new CodexProError(`Workflow ${workflow.id} references unknown recovery policy ${workflow.recovery_ref}.`);
  }
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.skill_id));
  for (const workflow of workflows) if (!fixtureIds.has(workflow.id)) throw new CodexProError(`Workflow ${workflow.id} has no declared redacted fixture.`);

  const calculated = browserSkillPackContractHash(manifest, resources);
  if (calculated !== manifest.skill_contract_hash) {
    throw new CodexProError(`Browser Skill Pack ${manifest.pack_id} contract hash mismatch: expected ${manifest.skill_contract_hash}, calculated ${calculated}.`);
  }
  return { manifest, root, manifest_path: manifestPath, pages, navigation, extractors, workflows, recovery, fixtures, resources, calculated_contract_hash: calculated };
}

export async function loadBrowserSkillPacks(
  _config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<BrowserSkillPackLoadResult> {
  const roots = browserSkillPackRoots(guard, workspace);
  const packs: LoadedBrowserSkillPack[] = [];
  for (const layer of BROWSER_SKILL_PACK_LAYERS) {
    for (const manifestPath of await findManifestFiles(roots[layer])) packs.push(await loadPack(manifestPath, layer));
  }

  const selectedPackById = new Map<string, LoadedBrowserSkillPack>();
  const shadowedPacks: BrowserSkillPackLoadResult["shadowed_packs"] = [];
  for (const pack of packs) {
    const selected = selectedPackById.get(pack.manifest.pack_id);
    if (!selected) selectedPackById.set(pack.manifest.pack_id, pack);
    else shadowedPacks.push({
      pack_id: pack.manifest.pack_id,
      selected_layer: selected.manifest.layer,
      shadowed_layer: pack.manifest.layer,
      shadowed_path: pack.manifest_path
    });
  }

  const selectedByWorkflow = new Map<string, LayeredBrowserSkillSource>();
  for (const pack of packs) {
    if (selectedPackById.get(pack.manifest.pack_id) !== pack) continue;
    for (const workflow of pack.workflows) {
      const existing = selectedByWorkflow.get(workflow.id);
      if (existing) {
        existing.shadowed.push({ layer: pack.manifest.layer, pack_id: pack.manifest.pack_id, path: pack.manifest_path });
        continue;
      }
      selectedByWorkflow.set(workflow.id, {
        workflow,
        pack,
        page: pack.pages.find((entry) => entry.id === workflow.page_ref)!,
        extractors: workflow.extractor_refs.map((ref) => pack.extractors.find((entry) => entry.id === ref)!),
        recovery: pack.recovery.find((entry) => entry.id === workflow.recovery_ref)!,
        layer: pack.manifest.layer,
        shadowed: []
      });
    }
  }
  return { roots, packs, selected_workflows: [...selectedByWorkflow.values()], shadowed_packs: shadowedPacks };
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function signalText(signal: BrowserPageFingerprint["signals"][number], snapshot: BrowserSemanticSnapshot): string[] {
  const accessible = (snapshot.accessibility ?? []).map((node) => node.name ?? "");
  const elements = snapshot.elements.flatMap((element) => [element.name ?? "", element.text ?? "", element.role ?? ""]);
  if (signal.type === "hostname") {
    try { return [new URL(snapshot.url).hostname]; } catch { return [""]; }
  }
  if (signal.type === "url_path") {
    try { return [new URL(snapshot.url).pathname]; } catch { return [""]; }
  }
  if (signal.type === "title") return [snapshot.title];
  if (signal.type === "navigation_item") return [...accessible, ...elements];
  if (signal.type === "accessible_name") return accessible;
  if (signal.type === "layout_feature") return [...elements, snapshot.text];
  return [snapshot.text, ...elements, ...accessible];
}

function boundedPattern(value: string): RegExp | undefined {
  if (value.length > 200 || /\(\?[:=!<]|\\[1-9]|\{\d{4,}/.test(value)) return undefined;
  try { return new RegExp(value, "i"); } catch { return undefined; }
}

function matchesSignal(signal: BrowserPageFingerprint["signals"][number], snapshot: BrowserSemanticSnapshot): boolean {
  const values = signalText(signal, snapshot);
  const match = signal.match ?? "contains";
  const present = values.some((candidate) => {
    if (match === "exact") return normalize(candidate) === normalize(signal.value);
    if (match === "pattern") return boundedPattern(signal.value)?.test(candidate) ?? false;
    return normalize(candidate).includes(normalize(signal.value));
  });
  return signal.type === "text_absent" ? !present : present;
}

export function evaluateBrowserPageFingerprint(page: BrowserPageFingerprint, snapshot: BrowserSemanticSnapshot): BrowserPageFingerprintEvaluation {
  const matches = page.signals.map((signal) => ({ ...signal, matched: matchesSignal(signal, snapshot) }));
  const required = matches.filter((entry) => entry.required);
  const requiredMatches = required.filter((entry) => entry.matched).length;
  const failed = required.filter((entry) => !entry.matched);
  const ok = failed.length === 0 && requiredMatches >= page.minimum_required_matches;
  return {
    ok,
    matches: matches.map(({ type, value, required: isRequired, matched }) => ({ type, value, required: isRequired, matched })),
    required_matches: requiredMatches,
    required_total: required.length,
    reasons: failed.map((entry) => `Required page fingerprint did not match: ${entry.type}=${entry.value}`)
  };
}

function snapshotLines(snapshot: BrowserSemanticSnapshot): string[] {
  return [
    ...snapshot.text.split(/\r?\n/),
    ...snapshot.elements.flatMap((element) => [element.name ?? "", element.text ?? ""]),
    ...(snapshot.accessibility ?? []).map((entry) => entry.name ?? ""),
    ...snapshot.tables.flatMap((table) => table.sampleRows.flatMap((row) => [row.join(" "), ...row]))
  ].map((line) => line.trim()).filter(Boolean);
}

function metricToken(text: string): string | undefined {
  return text.match(/[-+]?(?:(?:\d{1,3}(?:[\s,]\d{3})+)|\d+)(?:[.,]\d+)?\s*(?:%|RUB|RUR|USD|EUR|CNY|₽|¥|Ұ|\$|€|руб\.?|件|个|天|小时)?/i)?.[0]?.trim();
}

function tableMetricForTarget(snapshot: BrowserSemanticSnapshot, target: string): string | undefined {
  for (const table of snapshot.tables) {
    const normalizedTarget = normalize(target);
    const headerIndex = table.headers.findIndex((header) => normalize(header).includes(normalizedTarget));
    const rowHeaderIndexes = table.sampleRows
      .map((row) => row.findIndex((cell) => normalize(cell).includes(normalizedTarget)))
      .filter((index) => index >= 0);
    const candidateIndexes = [...new Set([
      ...rowHeaderIndexes,
      headerIndex,
      headerIndex > 0 ? headerIndex - 1 : -1,
      headerIndex >= 0 ? headerIndex + 1 : -1
    ].filter((index) => index >= 0))];
    for (const columnIndex of candidateIndexes) {
      for (const row of table.sampleRows) {
        const cell = row[columnIndex]?.trim();
        if (!cell || normalize(cell).includes(normalizedTarget)) continue;
        const value = metricToken(cell);
        if (value !== undefined) return value;
      }
    }
  }
  return undefined;
}

function metricTokenAfterTarget(line: string, target: string): string | undefined {
  const index = normalize(line).indexOf(normalize(target));
  if (index < 0) return undefined;
  const after = line.slice(index + target.length).trim();
  if (!after) return undefined;
  const metric = metricToken(after);
  if (metric) return metric;
  return `${target} ${after}`.slice(0, 300);
}

export function extractSemanticValueByTargets(snapshot: BrowserSemanticSnapshot, targets: string[]): string | undefined {
  const lines = snapshotLines(snapshot);
  for (const target of [...new Set(targets.map((entry) => entry.trim()).filter(Boolean))]) {
    const tableValue = tableMetricForTarget(snapshot, target);
    if (tableValue !== undefined) return tableValue;
    for (const line of lines) {
      const value = metricTokenAfterTarget(line, target);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function extractBrowserSkillPackFacts(input: {
  source: LayeredBrowserSkillSource;
  snapshot: BrowserSemanticSnapshot;
  shop: string;
  business_object: string;
}): BrowserSkillPackFact[] {
  const lines = snapshotLines(input.snapshot);
  return input.source.extractors.flatMap((extractor) => extractor.fields.map((field) => {
    const strategies = [...field.strategies].sort((left, right) => left.order - right.order);
    let value: string | undefined;
    let matchedMethod: typeof strategies[number]["method"] | undefined;
    const exactContextValue = field.key === "shop_context"
      ? input.shop
      : field.key === "business_object"
        ? input.business_object
        : undefined;
    if (exactContextValue && lines.some((candidate) => normalize(candidate).includes(normalize(exactContextValue)))) {
      value = exactContextValue;
      matchedMethod = "business_semantic";
    }
    for (const strategy of strategies) {
      if (value !== undefined) break;
      const extracted = extractSemanticValueByTargets(input.snapshot, [strategy.target]);
      if (extracted !== undefined) {
        value = extracted;
        matchedMethod = strategy.method;
        break;
      }
      const line = lines.find((candidate) => normalize(candidate).includes(normalize(strategy.target)));
      if (!line) continue;
      value = line.slice(0, 500);
      matchedMethod = strategy.method;
      break;
    }
    const sampleLimited = field.source === "table" && input.snapshot.tables.length > 0;
    return {
      platform: input.source.workflow.platform,
      shop: input.shop,
      business_object: input.business_object,
      metric_name: field.metric_name,
      ...(value ? { value } : {}),
      unit: field.unit ?? "",
      period: field.period ?? "",
      source_page: input.source.page.id,
      observed_at: input.snapshot.timestamp,
      evidence_ref: `browser_snapshot:${input.snapshot.snapshotId}`,
      completeness: value ? sampleLimited ? "partial" as const : "complete" as const : "missing" as const,
      confidence: value ? matchedMethod === "business_semantic" ? "high" as const : "medium" as const : "low" as const
    };
  }));
}

function safeStateId(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

export async function recordBrowserSkillDrift(input: {
  guard: PathGuard;
  workspace: Workspace;
  run_id: string;
  pack: LoadedBrowserSkillPack;
  page: BrowserPageFingerprint;
  snapshot: BrowserSemanticSnapshot;
}): Promise<{ state: BrowserSkillDriftState; evaluation: BrowserPageFingerprintEvaluation; path: string }> {
  const rel = `.codexpro/browser-skill-state/${safeStateId(input.pack.manifest.pack_id)}--${safeStateId(input.page.id)}.json`;
  const resolved = input.guard.resolve(input.workspace, rel);
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  let previous: BrowserSkillDriftState | undefined;
  try { previous = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as BrowserSkillDriftState; } catch { previous = undefined; }
  const evaluation = evaluateBrowserPageFingerprint(input.page, input.snapshot);
  const failures = evaluation.ok ? 0 : (previous?.consecutive_failures ?? 0) + 1;
  const manifestQuarantined = input.pack.manifest.status === "quarantined" || input.pack.manifest.status === "retired";
  const status: BrowserSkillDriftState["status"] = manifestQuarantined || previous?.status === "quarantined"
    || (!evaluation.ok && (input.page.on_mismatch === "quarantine" || failures >= 2))
      ? "quarantined"
      : !evaluation.ok || input.pack.manifest.status === "warning"
        ? "warning"
        : "active";
  const state: BrowserSkillDriftState = {
    version: 1,
    pack_id: input.pack.manifest.pack_id,
    page_id: input.page.id,
    run_id: input.run_id,
    status,
    consecutive_failures: failures,
    last_checked_at: new Date().toISOString(),
    last_snapshot_id: input.snapshot.snapshotId,
    reasons: evaluation.reasons,
    interaction_allowed: status === "active"
  };
  const temp = `${resolved.absPath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(temp, resolved.absPath);
  return { state, evaluation, path: rel };
}
