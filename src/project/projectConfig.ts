import fsp from "node:fs/promises";
import { stringify, parse } from "yaml";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { readTextFile, writeTextFile } from "../fsOps.js";
import { detectProject } from "./projectDetector.js";
import { readAgentsRules } from "./agentsReader.js";
import { initProjectMemory, PROJECT_MEMORY_DIR, type ProjectMemoryInitResult } from "./projectMemory.js";
import { TASKS_CONFIG_PATH, taskConfigTemplate } from "./taskTemplatesConfig.js";
import type {
  AcceptanceConfigFile,
  DetectedProjectProfile,
  ProjectAcceptanceProfile,
  ProjectCommand,
  ProjectConfigFile,
  ProjectConfigLoadResult,
  ProjectConfigValidationIssue,
  ProjectPathConfig,
  ProjectBrowserConfig,
  ProjectContextBudget,
  ProjectReviewConfig
} from "./types.js";

export const PROJECT_CONFIG_PATH = ".codexpro/project.yml";
export const ACCEPTANCE_CONFIG_PATH = ".codexpro/acceptance.yml";

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return out.length ? out : undefined;
}

function asStringOrStringArray(value: unknown): string | string[] | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return asStringArray(value);
}

function asVisualPairs(value: unknown): ProjectBrowserConfig["visual_pairs"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const obj = item as Record<string, unknown>;
    if (typeof obj.before_url !== "string" || typeof obj.after_url !== "string") return [];
    const beforeUrl = obj.before_url.trim();
    const afterUrl = obj.after_url.trim();
    if (!beforeUrl || !afterUrl) return [];
    return [{
      ...(typeof obj.name === "string" && obj.name.trim() ? { name: obj.name.trim() } : {}),
      before_url: beforeUrl,
      after_url: afterUrl
    }];
  });
  return out.length ? out : undefined;
}

function asProjectCommand(value: unknown): ProjectCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.command !== "string" || !obj.command.trim()) return undefined;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : obj.command.trim();
  const command: ProjectCommand = { name, command: obj.command.trim() };
  if (typeof obj.cwd === "string" && obj.cwd.trim()) command.cwd = obj.cwd.trim();
  if (Number.isFinite(Number(obj.timeout_ms))) command.timeout_ms = Math.floor(Number(obj.timeout_ms));
  if (obj.resource_profile === "acceptance-test" || obj.resource_profile === "acceptance-full-test") {
    command.resource_profile = obj.resource_profile;
  }
  if (obj.test_scope === "targeted" || obj.test_scope === "full") command.test_scope = obj.test_scope;
  if (typeof obj.allow_full_test === "boolean") command.allow_full_test = obj.allow_full_test;
  if (Number.isFinite(Number(obj.max_workers))) command.max_workers = Math.max(1, Math.floor(Number(obj.max_workers)));
  if (typeof obj.require_non_watch_mode === "boolean") command.require_non_watch_mode = obj.require_non_watch_mode;
  return command;
}

function asCommandMap(value: unknown): Record<string, string[] | string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string[] | string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
    else {
      const list = asStringArray(raw);
      if (list) out[key] = list;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function asPathConfig(value: unknown): ProjectPathConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: ProjectPathConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    const list = asStringArray(raw);
    if (list) out[key] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

function asBrowserConfig(value: unknown): ProjectBrowserConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const out: ProjectBrowserConfig = {};
  if (typeof obj.base_url === "string" && obj.base_url.trim()) out.base_url = obj.base_url.trim();
  const smokeUrls = asStringArray(obj.smoke_urls);
  if (smokeUrls) out.smoke_urls = smokeUrls;
  const visualPairs = asVisualPairs(obj.visual_pairs);
  if (visualPairs) out.visual_pairs = visualPairs;
  if (Number.isFinite(Number(obj.visual_threshold_ratio))) out.visual_threshold_ratio = Math.max(0, Math.min(1, Number(obj.visual_threshold_ratio)));
  if (Number.isFinite(Number(obj.visual_pixel_delta_threshold))) out.visual_pixel_delta_threshold = Math.max(0, Math.min(255, Math.floor(Number(obj.visual_pixel_delta_threshold))));
  const allowed = asStringArray(obj.allowed_domains);
  if (allowed) out.allowed_domains = allowed;
  return Object.keys(out).length ? out : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined;
  return Math.floor(numberValue);
}

function asContextBudget(value: unknown): ProjectContextBudget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const out: ProjectContextBudget = {};
  const maxFilesPerTask = asPositiveInteger(obj.max_files_per_task ?? obj.maxFilesPerTask);
  const maxLinesPerFile = asPositiveInteger(obj.max_lines_per_file ?? obj.maxLinesPerFile);
  const maxTotalChars = asPositiveInteger(obj.max_total_chars ?? obj.maxTotalChars);
  if (maxFilesPerTask !== undefined) out.max_files_per_task = maxFilesPerTask;
  if (maxLinesPerFile !== undefined) out.max_lines_per_file = maxLinesPerFile;
  if (maxTotalChars !== undefined) out.max_total_chars = maxTotalChars;
  return Object.keys(out).length ? out : undefined;
}

function asConfidenceThreshold(value: unknown): number | null | undefined {
  if (value === null) return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  return Math.max(0, Math.min(1, numberValue));
}

function asReviewConfig(value: unknown): ProjectReviewConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const out: ProjectReviewConfig = {};
  if (obj.mode === "advisory" || obj.mode === "gated" || obj.mode === "independent") out.mode = obj.mode;
  const blockRaw = asObject(obj.block_on);
  if (blockRaw) {
    const blockOn: NonNullable<ProjectReviewConfig["block_on"]> = {};
    const p0 = asConfidenceThreshold(Object.hasOwn(blockRaw, "P0") ? blockRaw.P0 : blockRaw.p0);
    const p1 = asConfidenceThreshold(Object.hasOwn(blockRaw, "P1") ? blockRaw.P1 : blockRaw.p1);
    const p2 = asConfidenceThreshold(Object.hasOwn(blockRaw, "P2") ? blockRaw.P2 : blockRaw.p2);
    if (p0 !== undefined) blockOn.P0 = p0;
    if (p1 !== undefined) blockOn.P1 = p1;
    if (p2 !== undefined) blockOn.P2 = p2;
    if (Object.keys(blockOn).length) out.block_on = blockOn;
  }
  if (typeof obj.require_critical_scope_covered === "boolean") out.require_critical_scope_covered = obj.require_critical_scope_covered;
  if (typeof obj.independent_provider === "string" && obj.independent_provider.trim()) out.independent_provider = obj.independent_provider.trim();
  return Object.keys(out).length ? out : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeProjectConfig(value: unknown): ProjectConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  return {
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.kind === "string" ? { kind: obj.kind } : {}),
    ...(asStringOrStringArray(obj.type) ? { type: asStringOrStringArray(obj.type) } : {}),
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.package_manager === "string" ? { package_manager: obj.package_manager } : {}),
    ...(typeof obj.primary_language === "string" ? { primary_language: obj.primary_language } : {}),
    ...(asStringArray(obj.frameworks) ? { frameworks: asStringArray(obj.frameworks) } : {}),
    ...(asStringArray(obj.adapters) ? { adapters: asStringArray(obj.adapters) } : {}),
    ...(asStringArray(obj.important_paths) ? { important_paths: asStringArray(obj.important_paths) } : {}),
    ...(asStringArray(obj.blocked_paths) ? { blocked_paths: asStringArray(obj.blocked_paths) } : {}),
    ...(asStringArray(obj.risk_paths) ? { risk_paths: asStringArray(obj.risk_paths) } : {}),
    ...(asStringArray(obj.entrypoints) ? { entrypoints: asStringArray(obj.entrypoints) } : {}),
    ...(asStringArray(obj.env_files) ? { env_files: asStringArray(obj.env_files) } : {}),
    ...(asStringArray(obj.docker_services) ? { docker_services: asStringArray(obj.docker_services) } : {}),
    ...(asStringArray(obj.rules) ? { rules: asStringArray(obj.rules) } : {}),
    ...(asStringArray(obj.business_rules) ? { business_rules: asStringArray(obj.business_rules) } : {}),
    ...(asStringArray(obj.notes) ? { notes: asStringArray(obj.notes) } : {}),
    ...(asCommandMap(obj.commands) ? { commands: asCommandMap(obj.commands) } : {}),
    ...(asPathConfig(obj.paths) ? { paths: asPathConfig(obj.paths) } : {}),
    ...(asBrowserConfig(obj.browser) ? { browser: asBrowserConfig(obj.browser) } : {}),
    ...(asContextBudget(obj.context) ? { context: asContextBudget(obj.context) } : {}),
    ...(asReviewConfig(obj.review) ? { review: asReviewConfig(obj.review) } : {}),
    ...(asObject(obj.acceptance) ? { acceptance: asObject(obj.acceptance) } : {})
  };
}

export function normalizeAcceptanceConfig(value: unknown): AcceptanceConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const profilesRaw = obj.profiles;
  const profiles: Record<string, ProjectAcceptanceProfile> = {};
  if (profilesRaw && typeof profilesRaw === "object" && !Array.isArray(profilesRaw)) {
    for (const [name, profileRaw] of Object.entries(profilesRaw)) {
      if (!profileRaw || typeof profileRaw !== "object" || Array.isArray(profileRaw)) continue;
      const profileObj = profileRaw as Record<string, unknown>;
      const commandsRaw = profileObj.commands;
      const commands = Array.isArray(commandsRaw) ? commandsRaw.map(asProjectCommand).filter((item): item is ProjectCommand => Boolean(item)) : [];
      profiles[name] = {
        ...(typeof profileObj.description === "string" ? { description: profileObj.description } : {}),
        ...(typeof profileObj.alias_profile === "string" && profileObj.alias_profile.trim() ? { alias_profile: profileObj.alias_profile.trim() } : {}),
        ...(typeof profileObj.dynamic_test_impact === "boolean" ? { dynamic_test_impact: profileObj.dynamic_test_impact } : {}),
        ...(profileObj.test_impact_level === "targeted" || profileObj.test_impact_level === "component" || profileObj.test_impact_level === "release"
          ? { test_impact_level: profileObj.test_impact_level }
          : {}),
        ...(typeof profileObj.include_build === "boolean" ? { include_build: profileObj.include_build } : {}),
        commands
      };
    }
  }
  return {
    ...(typeof obj.default_profile === "string" ? { default_profile: obj.default_profile } : {}),
    ...(Object.keys(profiles).length ? { profiles } : {})
  };
}

function projectConfigFromProfile(profile: DetectedProjectProfile): ProjectConfigFile {
  return {
    name: profile.name,
    kind: profile.kind,
    description: "CodexPro project profile generated from local repository signals.",
    package_manager: profile.package_manager,
    primary_language: profile.primary_language,
    frameworks: profile.frameworks,
    adapters: profile.adapters,
    important_paths: profile.important_paths,
    blocked_paths: [".git", "node_modules", "dist", "build", ".next", "coverage", ".cache", "mysql", "mysql-data", "db_data"],
    risk_paths: profile.risk_paths,
    entrypoints: profile.entrypoints,
    env_files: profile.env_files,
    docker_services: profile.docker_services,
    rules: [
      "Read the task preflight rule summary before starting implementation.",
      "Keep durable project rules in .codexpro/project.yml or .codexpro/memory/rules.md, not in transient handoff files."
    ],
    commands: {
      start: profile.start_commands.map((command) => command.command),
      build: profile.build_commands.map((command) => command.command),
      test: profile.test_commands.map((command) => command.command),
      lint: profile.lint_commands.map((command) => command.command)
    },
    context: {
      max_files_per_task: 16,
      max_lines_per_file: 240,
      max_total_chars: 180_000
    },
    notes: ["Edit this file to teach CodexPro project-specific rules without changing global server config."]
  };
}

function browserSmokeCommand(): ProjectCommand {
  return { name: "browser-smoke", command: "npm run browser-smoke", timeout_ms: 180000 };
}

function commandListIncludesBrowserSmoke(commands: ProjectCommand[]): boolean {
  return commands.some((command) => command.name.toLowerCase().includes("browser-smoke") || /\bbrowser-smoke\b/.test(command.command));
}

function acceptanceConfigFromProfile(profile: DetectedProjectProfile): AcceptanceConfigFile {
  const fullCommands = profile.suggested_acceptance_commands.length
    ? profile.suggested_acceptance_commands
    : [{ name: "build", command: "npm run build", timeout_ms: 120000 }];
  const buildCommands = profile.build_commands.length
    ? profile.build_commands.slice(0, 1)
    : fullCommands.filter((command) => command.name.toLowerCase().includes("build")).slice(0, 1);
  const releaseCommands = profile.has_browser_app && !commandListIncludesBrowserSmoke(fullCommands)
    ? [...fullCommands, browserSmokeCommand()]
    : fullCommands;
  const profiles: Record<string, ProjectAcceptanceProfile> = {
    default: {
      description: "Changed-file based default acceptance. Compatibility alias for targeted-build.",
      alias_profile: "targeted-build",
      commands: []
    },
    quick: {
      description: "Compatibility alias for the targeted profile.",
      alias_profile: "targeted",
      commands: []
    },
    docs: {
      description: "Deterministic checks for documentation-only changes.",
      commands: [{ name: "docs-diff-check", command: "git diff --check", timeout_ms: 30000 }]
    },
    targeted: {
      description: "Changed-file Test Impact Graph without an unconditional build for a single smoke-script change.",
      dynamic_test_impact: true,
      test_impact_level: "targeted",
      include_build: false,
      commands: []
    },
    "targeted-build": {
      description: "Changed-file Test Impact Graph with build coverage.",
      dynamic_test_impact: true,
      test_impact_level: "targeted",
      include_build: true,
      commands: buildCommands
    },
    full: {
      description: "Full local checks for core control-plane or uncovered changes.",
      commands: fullCommands
    },
    release: {
      description: "Release-oriented local checks for this workspace.",
      commands: releaseCommands
    }
  };

  if (profile.has_browser_app) {
    profiles.browser = {
      description: "Browser acceptance smoke check for detected browser apps.",
      commands: [...buildCommands, browserSmokeCommand()]
    };
  }

  return {
    default_profile: "default",
    profiles
  };
}

export function projectConfigTemplate(profile: DetectedProjectProfile): string {
  return stringify(projectConfigFromProfile(profile), { lineWidth: 120 });
}

export function acceptanceConfigTemplate(profile: DetectedProjectProfile): string {
  return stringify(acceptanceConfigFromProfile(profile), { lineWidth: 120 });
}

async function readYamlIfExists(config: CodexProConfig, guard: PathGuard, workspace: Workspace, relPath: string): Promise<{ existed: boolean; raw: string; parsed: unknown }> {
  const resolved = guard.resolve(workspace, relPath);
  const exists = await fsp.access(resolved.absPath).then(() => true, () => false);
  if (!exists) return { existed: false, raw: "", parsed: undefined };
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  const raw = await fsp.readFile(resolved.absPath, "utf8");
  try {
    return { existed: true, raw, parsed: parse(raw) };
  } catch (error) {
    throw new CodexProError(`Invalid YAML in ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeProjectConfig(detected: DetectedProjectProfile, fileConfig: ProjectConfigFile): ProjectConfigFile {
  const base = projectConfigFromProfile(detected);
  return {
    ...base,
    ...fileConfig,
    frameworks: [...new Set([...(base.frameworks ?? []), ...(fileConfig.frameworks ?? [])])],
    adapters: [...new Set([...(base.adapters ?? []), ...(fileConfig.adapters ?? [])])],
    important_paths: [...new Set([...(base.important_paths ?? []), ...(fileConfig.important_paths ?? [])])],
    blocked_paths: [...new Set([...(base.blocked_paths ?? []), ...(fileConfig.blocked_paths ?? [])])],
    risk_paths: [...new Set([...(base.risk_paths ?? []), ...(fileConfig.risk_paths ?? [])])],
    entrypoints: [...new Set([...(base.entrypoints ?? []), ...(fileConfig.entrypoints ?? [])])],
    env_files: [...new Set([...(base.env_files ?? []), ...(fileConfig.env_files ?? [])])],
    docker_services: [...new Set([...(base.docker_services ?? []), ...(fileConfig.docker_services ?? [])])],
    rules: [...new Set([...(base.rules ?? []), ...(fileConfig.rules ?? [])])],
    business_rules: [...new Set([...(base.business_rules ?? []), ...(fileConfig.business_rules ?? [])])],
    notes: [...new Set([...(base.notes ?? []), ...(fileConfig.notes ?? [])])],
    commands: { ...(base.commands ?? {}), ...(fileConfig.commands ?? {}) },
    paths: { ...(base.paths ?? {}), ...(fileConfig.paths ?? {}) },
    browser: { ...(base.browser ?? {}), ...(fileConfig.browser ?? {}) },
    context: { ...(base.context ?? {}), ...(fileConfig.context ?? {}) },
    review: {
      ...(base.review ?? {}),
      ...(fileConfig.review ?? {}),
      block_on: { ...(base.review?.block_on ?? {}), ...(fileConfig.review?.block_on ?? {}) }
    },
    acceptance: { ...(base.acceptance ?? {}), ...(fileConfig.acceptance ?? {}) }
  };
}

export function validateProjectConfigShape(projectConfig: ProjectConfigFile): ProjectConfigValidationIssue[] {
  const issues: ProjectConfigValidationIssue[] = [];
  if (!projectConfig.name) issues.push({ level: "warning", path: "name", message: "Project name is missing; detected workspace basename will be used." });
  if (!projectConfig.kind && !projectConfig.type) issues.push({ level: "warning", path: "kind", message: "Project kind/type is missing; detector fallback will be used." });
  for (const envFile of projectConfig.env_files ?? []) {
    if (!envFile.startsWith(".env")) continue;
    issues.push({ level: "warning", path: "env_files", message: `Env file is listed by name only and must not be read for content: ${envFile}` });
  }
  for (const risky of projectConfig.risk_paths ?? []) {
    if (/\.env|secret|credential|password|private/i.test(risky)) {
      issues.push({ level: "warning", path: "risk_paths", message: `Sensitive risk path declared: ${risky}` });
    }
  }
  if (projectConfig.browser?.base_url && !/^https?:\/\//.test(projectConfig.browser.base_url)) {
    issues.push({ level: "error", path: "browser.base_url", message: "browser.base_url must be an http(s) URL." });
  }
  for (const [index, pair] of (projectConfig.browser?.visual_pairs ?? []).entries()) {
    if (!/^https?:\/\//.test(pair.before_url)) issues.push({ level: "error", path: `browser.visual_pairs[${index}].before_url`, message: "visual before_url must be an http(s) URL." });
    if (!/^https?:\/\//.test(pair.after_url)) issues.push({ level: "error", path: `browser.visual_pairs[${index}].after_url`, message: "visual after_url must be an http(s) URL." });
  }
  const review = projectConfig.review;
  if (review?.block_on?.P0 !== undefined && review.block_on.P0 !== null && (review.block_on.P0 < 0 || review.block_on.P0 > 1)) {
    issues.push({ level: "error", path: "review.block_on.P0", message: "Review P0 confidence threshold must be between 0 and 1 or null." });
  }
  if (review?.block_on?.P1 !== undefined && review.block_on.P1 !== null && (review.block_on.P1 < 0 || review.block_on.P1 > 1)) {
    issues.push({ level: "error", path: "review.block_on.P1", message: "Review P1 confidence threshold must be between 0 and 1 or null." });
  }
  if (review?.mode === "independent" && !review.independent_provider) {
    issues.push({ level: "warning", path: "review.independent_provider", message: "Independent review has no alternate provider configured; isolated context will be used with the active provider." });
  }
  const context = projectConfig.context;
  if (context?.max_files_per_task !== undefined && context.max_files_per_task < 1) {
    issues.push({ level: "error", path: "context.max_files_per_task", message: "context.max_files_per_task must be a positive integer." });
  }
  if (context?.max_lines_per_file !== undefined && context.max_lines_per_file < 20) {
    issues.push({ level: "warning", path: "context.max_lines_per_file", message: "Very small line budgets may make file previews unusable." });
  }
  if (context?.max_total_chars !== undefined && context.max_total_chars < 10000) {
    issues.push({ level: "warning", path: "context.max_total_chars", message: "Very small total character budgets may truncate task reports aggressively." });
  }
  return issues;
}

export async function readProjectProfile(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<ProjectConfigLoadResult> {
  const detected = await detectProject(config, guard, workspace);
  const read = await readYamlIfExists(config, guard, workspace, PROJECT_CONFIG_PATH);
  const fileConfig = normalizeProjectConfig(read.parsed);
  const merged = mergeProjectConfig(detected, fileConfig);
  const agents = await readAgentsRules(config, guard, workspace);
  const validation = validateProjectConfigShape(merged);
  return {
    path: PROJECT_CONFIG_PATH,
    existed: read.existed,
    config: merged,
    detected,
    agents,
    validation
  };
}

export async function readProjectConfig(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<ProjectConfigLoadResult> {
  return readProjectProfile(config, guard, workspace);
}

export async function validateProjectConfig(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<ProjectConfigLoadResult> {
  return readProjectProfile(config, guard, workspace);
}

export async function readAcceptanceConfig(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<AcceptanceConfigFile> {
  const detected = await detectProject(config, guard, workspace);
  const read = await readYamlIfExists(config, guard, workspace, ACCEPTANCE_CONFIG_PATH);
  if (!read.existed) return acceptanceConfigFromProfile(detected);
  const normalized = normalizeAcceptanceConfig(read.parsed);
  return normalized.profiles ? normalized : acceptanceConfigFromProfile(detected);
}

export async function initProjectConfig(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: { overwrite?: boolean } = {}): Promise<{
  profile: DetectedProjectProfile;
  project: { path: string; existed: boolean; changed: boolean };
  acceptance: { path: string; existed: boolean; changed: boolean };
  tasks: { path: string; existed: boolean; changed: boolean };
  memory: ProjectMemoryInitResult;
}> {
  const profile = await detectProject(config, guard, workspace);
  const projectResolved = guard.resolve(workspace, PROJECT_CONFIG_PATH, { forWrite: true });
  const acceptanceResolved = guard.resolve(workspace, ACCEPTANCE_CONFIG_PATH, { forWrite: true });
  const tasksResolved = guard.resolve(workspace, TASKS_CONFIG_PATH, { forWrite: true });
  guard.resolve(workspace, PROJECT_MEMORY_DIR, { forWrite: true });
  const projectExists = await fsp.access(projectResolved.absPath).then(() => true, () => false);
  const acceptanceExists = await fsp.access(acceptanceResolved.absPath).then(() => true, () => false);
  const tasksExists = await fsp.access(tasksResolved.absPath).then(() => true, () => false);

  let projectChanged = false;
  let acceptanceChanged = false;
  let tasksChanged = false;
  if (options.overwrite || !projectExists) {
    await writeTextFile(config, guard, workspace, PROJECT_CONFIG_PATH, projectConfigTemplate(profile), { createDirs: true, overwrite: true });
    projectChanged = true;
  }
  if (options.overwrite || !acceptanceExists) {
    await writeTextFile(config, guard, workspace, ACCEPTANCE_CONFIG_PATH, acceptanceConfigTemplate(profile), { createDirs: true, overwrite: true });
    acceptanceChanged = true;
  }
  if (options.overwrite || !tasksExists) {
    await writeTextFile(config, guard, workspace, TASKS_CONFIG_PATH, taskConfigTemplate(), { createDirs: true, overwrite: true });
    tasksChanged = true;
  }
  const memory = await initProjectMemory(config, guard, workspace, profile);

  return {
    profile,
    project: { path: PROJECT_CONFIG_PATH, existed: projectExists, changed: projectChanged },
    acceptance: { path: ACCEPTANCE_CONFIG_PATH, existed: acceptanceExists, changed: acceptanceChanged },
    tasks: { path: TASKS_CONFIG_PATH, existed: tasksExists, changed: tasksChanged },
    memory
  };
}

export async function readProjectConfigText(config: CodexProConfig, guard: PathGuard, workspace: Workspace, path = PROJECT_CONFIG_PATH) {
  return readTextFile(config, guard, workspace, path, { maxBytes: Math.min(config.maxReadBytes, 80_000) });
}

export function formatProjectConfigLoadResult(result: ProjectConfigLoadResult): string {
  return [
    "# Project Config",
    "",
    `Path: ${result.path}`,
    `Exists: ${result.existed ? "yes" : "no"}`,
    "",
    "## Merged config",
    "```yaml",
    stringify(result.config, { lineWidth: 120 }).trim(),
    "```",
    "",
    "## AGENTS / rules files",
    result.agents.files.length ? result.agents.files.map((file) => `- ${file.path}: ${file.title}`).join("\n") : "- none",
    "",
    "## Extracted rules",
    result.agents.rules.length ? result.agents.rules.map((rule) => `- ${rule}`).join("\n") : "- none",
    "",
    "## Validation",
    result.validation.length ? result.validation.map((issue) => `- ${issue.level.toUpperCase()} ${issue.path}: ${issue.message}`).join("\n") : "- no issues"
  ].join("\n");
}
