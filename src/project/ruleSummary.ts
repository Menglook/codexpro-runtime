import { createHash } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { readProjectProfile } from "./projectConfig.js";
import { PROJECT_MEMORY_DIR, readProjectMemory, type ProjectMemoryReadResult } from "./projectMemory.js";
import type { AgentsRulesSummary, ProjectConfigFile, ProjectConfigLoadResult } from "./types.js";

export type RuleSummarySourceKind = "global" | "project_config" | "agents" | "memory" | "task";

export interface RuleSummarySource {
  kind: RuleSummarySourceKind;
  title: string;
  path?: string;
  loaded: boolean;
  rules: string[];
  warnings: string[];
}

export interface RuleProvenanceV1 {
  source_kind: RuleSummarySourceKind;
  path?: string;
  priority: number;
  original_body: string;
}

export interface EffectiveRuleV1 {
  rule_id: string;
  body: string;
  source_kind: RuleSummarySourceKind;
  priority: number;
  provenance: RuleProvenanceV1[];
}

export interface RuleSummaryResult {
  workspace_id: string;
  root: string;
  generated_at: string;
  sources: RuleSummarySource[];
  effective_rules: EffectiveRuleV1[];
  preflight_rules: string[];
  warnings: string[];
  files: string[];
  memory_existed: boolean;
  project_config_existed: boolean;
  truncated: boolean;
}

export interface RuleSummaryOptions {
  maxRules?: number;
  maxMemoryFileBytes?: number;
  explicitTaskRules?: string[];
}

const SOURCE_PRIORITY: Record<RuleSummarySourceKind, number> = {
  global: 10,
  project_config: 20,
  memory: 25,
  agents: 30,
  task: 40
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeRule(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueLimited(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeRule(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function listConfigRules(configFile: ProjectConfigFile): string[] {
  const rules: string[] = [];
  rules.push(...(configFile.rules ?? []).map((rule) => `project.yml rule: ${rule}`));
  rules.push(...(configFile.business_rules ?? []).map((rule) => `business rule: ${rule}`));
  rules.push(...(configFile.notes ?? []).map((note) => `project note: ${note}`));
  rules.push(...(configFile.risk_paths ?? []).map((riskPath) => `review-sensitive path: ${riskPath}`));
  rules.push(...(configFile.blocked_paths ?? []).map((blockedPath) => `avoid blocked path unless explicitly required: ${blockedPath}`));
  rules.push(...(configFile.env_files ?? []).map((envFile) => `never read or expose secret values from env file: ${envFile}`));
  for (const [name, value] of configFile.commands ? Object.entries(configFile.commands) : []) {
    for (const command of Array.isArray(value) ? value : [value]) {
      if (typeof command === "string" && command.trim()) rules.push(`project command hint (${name}): ${command.trim()}`);
    }
  }
  rules.push(...(configFile.browser?.smoke_urls ?? []).map((url) => `browser smoke target: ${url}`));
  rules.push(...(configFile.browser?.visual_pairs ?? []).map((pair) => `browser visual pair: ${pair.before_url} -> ${pair.after_url}`));
  return rules;
}

function globalRules(config: CodexProConfig): string[] {
  const writeRule = config.writeMode === "workspace"
    ? "source edits are allowed only through bounded workspace write/edit tools"
    : config.writeMode === "handoff"
      ? "source edits are disabled; use handoff files for implementation plans"
      : "source edits are disabled in this server mode";
  const bashRule = config.bashMode === "off"
    ? "bash is disabled; do not attempt terminal verification"
    : "use bash only for meaningful verification commands, not for file inspection";
  return [
    "open the workspace and read task preflight rules before changing files",
    "follow AGENTS, project.yml, and project memory rules before making project decisions",
    "inspect with tree, search, and read instead of shell file readers",
    bashRule,
    writeRule,
    "after edits, use show_changes for git status, diff stats, and review diff",
    "never store or print secrets, credentials, API tokens, private keys, or session cookies"
  ];
}

function agentRuleItems(agents: AgentsRulesSummary): string[] {
  return [
    ...agents.rules.map((rule) => `AGENTS rule: ${rule}`),
    ...agents.high_risk_paths.map((item) => `AGENTS high-risk path: ${item}`),
    ...agents.test_commands.map((item) => `AGENTS validation hint: ${item}`),
    ...agents.commit_rules.map((item) => `AGENTS commit rule: ${item}`)
  ];
}

function cleanMemoryLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/.test(trimmed)) return undefined;
  if (/^[-*]\s+/.test(trimmed)) return trimmed.replace(/^[-*]\s+/, "");
  if (/^\|[^|]+\|/.test(trimmed) && !/^\|\s*-/.test(trimmed)) return trimmed.replace(/^\|/, "").replace(/\|$/, "").trim();
  return undefined;
}

function memoryRuleItems(memory: ProjectMemoryReadResult): string[] {
  const rulesFilePath = `${PROJECT_MEMORY_DIR}/rules.md`;
  const ruleFiles = memory.files.filter((file) => file.existed && file.text && (file.path === rulesFilePath || /(^|\/)rules\.(md|markdown|txt)$/i.test(file.path)));
  const lines = ruleFiles.flatMap((file) => (file.text ?? "").split(/\r?\n/).map(cleanMemoryLine).filter((line): line is string => Boolean(line)));
  const useful = lines.filter((line) => /(must|never|always|prefer|avoid|forbid|do not|禁止|不要|不允许|必须|只允许|优先|验收|提交|测试|风险|rule|rules|规则)/i.test(line));
  return (useful.length ? useful : lines).map((rule) => `memory rule: ${rule}`);
}

function buildSources(config: CodexProConfig, profile: ProjectConfigLoadResult, memory: ProjectMemoryReadResult, maxRules: number, taskRules: string[]): RuleSummarySource[] {
  const agentsFiles = profile.agents.files.map((file) => file.path);
  const memoryFiles = memory.files.filter((file) => file.existed).map((file) => file.path);
  return [
    { kind: "global", title: "CodexPro global operating rules", loaded: true, rules: uniqueLimited(globalRules(config), Math.min(maxRules, 40)), warnings: [] },
    { kind: "project_config", title: ".codexpro/project.yml rules", path: profile.path, loaded: profile.existed, rules: uniqueLimited(listConfigRules(profile.config), Math.min(maxRules, 80)), warnings: profile.validation.map((issue) => `${issue.level.toUpperCase()} ${issue.path}: ${issue.message}`) },
    { kind: "agents", title: "AGENTS/rules files", path: agentsFiles.join(", ") || undefined, loaded: profile.agents.files.length > 0, rules: uniqueLimited(agentRuleItems(profile.agents), Math.min(maxRules, 80)), warnings: profile.agents.warnings },
    { kind: "memory", title: `${PROJECT_MEMORY_DIR}/rules.md rule memory`, path: memoryFiles.filter((file) => /(^|\/)rules\.(md|markdown|txt)$/i.test(file)).join(", ") || `${PROJECT_MEMORY_DIR}/rules.md`, loaded: memory.existed, rules: uniqueLimited(memoryRuleItems(memory), Math.min(maxRules, 80)), warnings: memory.missing_standard_files.length ? [`Missing standard memory files: ${memory.missing_standard_files.join(", ")}`] : [] },
    { kind: "task", title: "Explicit task constraints", loaded: taskRules.length > 0, rules: uniqueLimited(taskRules, Math.min(maxRules, 80)), warnings: [] }
  ];
}

function effectiveBody(raw: string): string {
  return normalizeRule(raw.replace(/^(?:project\.yml|AGENTS|memory) rule:\s*/i, ""));
}

function semanticRuleKey(body: string): string {
  const normalized = body.toLowerCase().replace(/[\s.,;:!?`'"()[\]{}_-]+/g, " ").trim();
  if (/(?:open|read).*(?:workspace|preflight).*(?:rule)|(?:preflight rule).*(?:before).*(?:chang|edit)/.test(normalized)) return "preflight.read_before_change";
  if (/(?:show changes|show_changes).*(?:after|review|diff|status)/.test(normalized)) return "changes.review_after_edit";
  if (/(?:never|do not).*(?:secret|credential|api token|private key|session cookie)/.test(normalized)) return "security.never_expose_secrets";
  if (/(?:tree|search|read).*(?:instead|not).*(?:shell|cat|file inspection)/.test(normalized)) return "inspection.use_project_read_tools";
  return `rule:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function mergeEffectiveRules(sources: RuleSummarySource[], maxRules: number): EffectiveRuleV1[] {
  const merged = new Map<string, EffectiveRuleV1>();
  for (const source of sources) {
    const priority = SOURCE_PRIORITY[source.kind];
    for (const original of source.rules) {
      const body = effectiveBody(original);
      if (!body) continue;
      const ruleId = semanticRuleKey(body);
      const provenance: RuleProvenanceV1 = { source_kind: source.kind, ...(source.path ? { path: source.path } : {}), priority, original_body: original };
      const current = merged.get(ruleId);
      if (!current) {
        merged.set(ruleId, { rule_id: ruleId, body, source_kind: source.kind, priority, provenance: [provenance] });
      } else {
        current.provenance.push(provenance);
        if (priority >= current.priority) {
          current.body = body;
          current.source_kind = source.kind;
          current.priority = priority;
        }
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.priority - a.priority || a.rule_id.localeCompare(b.rule_id)).slice(0, maxRules);
}

export async function buildRuleSummary(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: RuleSummaryOptions = {}): Promise<RuleSummaryResult> {
  const maxRules = clampInt(options.maxRules, 80, 10, 200);
  const profile = await readProjectProfile(config, guard, workspace);
  const memory = await readProjectMemory(config, guard, workspace, { includeCustom: true, maxFiles: 30, maxFileBytes: clampInt(options.maxMemoryFileBytes, 20_000, 1_000, 80_000) });
  const sources = buildSources(config, profile, memory, maxRules, options.explicitTaskRules ?? []);
  const effectiveRules = mergeEffectiveRules(sources, maxRules);
  const warnings = uniqueLimited(sources.flatMap((source) => source.warnings), 80);
  const files = uniqueLimited([profile.existed ? profile.path : "", ...profile.agents.files.map((file) => file.path), ...memory.files.filter((file) => file.existed).map((file) => file.path)], 120);
  return {
    workspace_id: workspace.id,
    root: workspace.root,
    generated_at: new Date().toISOString(),
    sources,
    effective_rules: effectiveRules,
    preflight_rules: effectiveRules.map((rule) => rule.body),
    warnings,
    files,
    memory_existed: memory.existed,
    project_config_existed: profile.existed,
    truncated: memory.truncated || sources.some((source) => source.rules.length >= maxRules)
  };
}

export function formatRuleSummary(summary: RuleSummaryResult): string {
  const sourceLines = summary.sources.map((source) => `- ${source.title}: ${source.loaded ? "loaded" : "not found"}${source.path ? ` — ${source.path}` : ""}`);
  const ruleLines = summary.effective_rules.map((rule) => `- [${rule.rule_id}] ${rule.body} (authority=${rule.source_kind}, sources=${rule.provenance.length})`);
  const lines = [
    "# Task Preflight Rule Summary", "", `Workspace: ${summary.workspace_id}`, `Root: ${summary.root}`, `Generated: ${summary.generated_at}`, "",
    "## Sources", sourceLines.length ? sourceLines.join("\n") : "- none", "", "## Effective preflight rules", ruleLines.length ? ruleLines.join("\n") : "- none", "",
    "## Warnings", summary.warnings.length ? summary.warnings.map((warning) => `- ${warning}`).join("\n") : "- none"
  ];
  if (summary.truncated) lines.push("", "Note: some rule inputs were truncated or rule limits were reached.");
  return lines.join("\n");
}
