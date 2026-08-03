import fsp from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import type { PatchBundleOperation, ReadManyFileInput } from "../compactExecution.js";

export const TASKS_CONFIG_PATH = ".codexpro/tasks.yml";

export interface TaskTemplateDefinition {
  description?: string;
  steps?: string[];
  search_queries?: string[];
  read_files?: ReadManyFileInput[];
  patches?: PatchBundleOperation[];
  commands?: string[];
  acceptance_profile?: string;
  include_rules?: boolean;
  start_snapshot?: boolean;
  finish_snapshot?: boolean;
  commit_assistant?: boolean;
  browser_before_after?: boolean;
}

export interface TaskTemplateConfigFile {
  version?: number;
  default_template?: string;
  templates: Record<string, TaskTemplateDefinition>;
}

export interface TaskTemplateConfigLoadResult {
  path: string;
  existed: boolean;
  config: TaskTemplateConfigFile;
  custom_templates: string[];
}

export const BUILTIN_TASK_TEMPLATES: Record<string, TaskTemplateDefinition> = {
  bugfix: {
    description: "Bugfix task template.",
    steps: ["read_rules", "start_snapshot", "fix", "acceptance", "finish_snapshot", "git_prepare"],
    acceptance_profile: "quick"
  },
  feature: {
    description: "Feature task template.",
    steps: ["read_rules", "start_snapshot", "implement", "acceptance", "finish_snapshot", "git_prepare"],
    acceptance_profile: "default"
  },
  "ui-fix": {
    description: "UI fix task template.",
    steps: ["read_rules", "start_snapshot", "browser_before", "fix", "browser_after", "acceptance", "finish_snapshot", "git_prepare"],
    acceptance_profile: "browser",
    browser_before_after: true,
    commands: ["npm run browser-visual-regression"]
  },
  "backend-debug": {
    description: "Backend debug task template.",
    steps: ["read_rules", "start_snapshot", "debug", "acceptance", "finish_snapshot", "git_prepare"],
    acceptance_profile: "quick"
  },
  "docker-debug": {
    description: "Docker debug task template.",
    steps: ["read_rules", "start_snapshot", "debug", "acceptance", "finish_snapshot", "git_prepare"],
    acceptance_profile: "quick"
  },
  "release-check": {
    description: "Release check task template.",
    steps: ["read_rules", "release_gate", "git_prepare"],
    commands: ["npm run release-gate"],
    commit_assistant: true
  }
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value.trim()) return value.split(/[\n,]+/g).map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return out.length ? out : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function normalizeReadFile(value: unknown): ReadManyFileInput | undefined {
  if (typeof value === "string" && value.trim()) return { path: value.trim() };
  const obj = asObject(value);
  if (!obj || typeof obj.path !== "string" || !obj.path.trim()) return undefined;
  return {
    path: obj.path.trim(),
    ...(asPositiveInteger(obj.start_line ?? obj.startLine) ? { start_line: asPositiveInteger(obj.start_line ?? obj.startLine) } : {}),
    ...(asPositiveInteger(obj.end_line ?? obj.endLine) ? { end_line: asPositiveInteger(obj.end_line ?? obj.endLine) } : {}),
    ...(asPositiveInteger(obj.max_bytes ?? obj.maxBytes) ? { max_bytes: asPositiveInteger(obj.max_bytes ?? obj.maxBytes) } : {})
  };
}

function normalizeReadFiles(value: unknown): ReadManyFileInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(normalizeReadFile).filter((item): item is ReadManyFileInput => Boolean(item));
  return out.length ? out : undefined;
}

function normalizePatchOperation(value: unknown): PatchBundleOperation | undefined {
  const obj = asObject(value);
  if (!obj || (obj.operation !== "write" && obj.operation !== "replace") || typeof obj.path !== "string" || !obj.path.trim()) return undefined;
  return {
    operation: obj.operation,
    path: obj.path.trim(),
    ...(typeof obj.content === "string" ? { content: obj.content } : {}),
    ...(typeof obj.old_text === "string" ? { old_text: obj.old_text } : {}),
    ...(typeof obj.new_text === "string" ? { new_text: obj.new_text } : {}),
    ...(asBoolean(obj.create_dirs ?? obj.createDirs) !== undefined ? { create_dirs: asBoolean(obj.create_dirs ?? obj.createDirs) } : {}),
    ...(asBoolean(obj.overwrite) !== undefined ? { overwrite: asBoolean(obj.overwrite) } : {}),
    ...(asBoolean(obj.replace_all ?? obj.replaceAll) !== undefined ? { replace_all: asBoolean(obj.replace_all ?? obj.replaceAll) } : {}),
    ...(asPositiveInteger(obj.expected_replacements ?? obj.expectedReplacements) ? { expected_replacements: asPositiveInteger(obj.expected_replacements ?? obj.expectedReplacements) } : {})
  };
}

function normalizePatchOperations(value: unknown): PatchBundleOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map(normalizePatchOperation).filter((item): item is PatchBundleOperation => Boolean(item));
  return out.length ? out : undefined;
}

function normalizeTemplateDefinition(value: unknown): TaskTemplateDefinition | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  const out: TaskTemplateDefinition = {};
  if (typeof obj.description === "string" && obj.description.trim()) out.description = obj.description.trim();
  const steps = asStringArray(obj.steps);
  if (steps) out.steps = steps;
  const searchQueries = asStringArray(obj.search_queries ?? obj.searchQueries);
  if (searchQueries) out.search_queries = searchQueries;
  const readFiles = normalizeReadFiles(obj.read_files ?? obj.readFiles);
  if (readFiles) out.read_files = readFiles;
  const patches = normalizePatchOperations(obj.patches);
  if (patches) out.patches = patches;
  const commands = asStringArray(obj.commands);
  if (commands) out.commands = commands;
  if (typeof obj.acceptance_profile === "string" && obj.acceptance_profile.trim()) out.acceptance_profile = obj.acceptance_profile.trim();
  else if (typeof obj.acceptanceProfile === "string" && obj.acceptanceProfile.trim()) out.acceptance_profile = obj.acceptanceProfile.trim();
  const includeRules = asBoolean(obj.include_rules ?? obj.includeRules);
  if (includeRules !== undefined) out.include_rules = includeRules;
  const startSnapshot = asBoolean(obj.start_snapshot ?? obj.startSnapshot);
  if (startSnapshot !== undefined) out.start_snapshot = startSnapshot;
  const finishSnapshot = asBoolean(obj.finish_snapshot ?? obj.finishSnapshot);
  if (finishSnapshot !== undefined) out.finish_snapshot = finishSnapshot;
  const commitAssistant = asBoolean(obj.commit_assistant ?? obj.commitAssistant);
  if (commitAssistant !== undefined) out.commit_assistant = commitAssistant;
  const browserBeforeAfter = asBoolean(obj.browser_before_after ?? obj.browserBeforeAfter);
  if (browserBeforeAfter !== undefined) out.browser_before_after = browserBeforeAfter;
  return Object.keys(out).length ? out : undefined;
}

function normalizeTemplates(value: unknown): Record<string, TaskTemplateDefinition> {
  const obj = asObject(value);
  if (!obj) return {};
  const out: Record<string, TaskTemplateDefinition> = {};
  for (const [name, raw] of Object.entries(obj)) {
    const safeName = name.trim();
    if (!safeName) continue;
    const normalized = normalizeTemplateDefinition(raw);
    if (normalized) out[safeName] = normalized;
  }
  return out;
}

export function normalizeTaskTemplateConfig(value: unknown): TaskTemplateConfigFile {
  const obj = asObject(value) ?? {};
  const templates = normalizeTemplates(obj.templates ?? obj.tasks);
  return {
    version: asPositiveInteger(obj.version) ?? 1,
    ...(typeof obj.default_template === "string" && obj.default_template.trim() ? { default_template: obj.default_template.trim() } : {}),
    templates
  };
}

function cloneBuiltins(): Record<string, TaskTemplateDefinition> {
  return JSON.parse(JSON.stringify(BUILTIN_TASK_TEMPLATES)) as Record<string, TaskTemplateDefinition>;
}

export function taskConfigTemplate(): string {
  return stringify({
    version: 1,
    default_template: "bugfix",
    templates: cloneBuiltins()
  }, { lineWidth: 0 });
}

export async function readTaskTemplateConfig(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<TaskTemplateConfigLoadResult> {
  const resolved = guard.resolve(workspace, TASKS_CONFIG_PATH);
  const existed = await fsp.access(resolved.absPath).then(() => true, () => false);
  let custom: TaskTemplateConfigFile = { version: 1, templates: {} };
  if (existed) {
    await guard.assertTextFile(resolved.absPath, Math.min(config.maxReadBytes, 120_000));
    const raw = await fsp.readFile(resolved.absPath, "utf8");
    try {
      custom = normalizeTaskTemplateConfig(parse(raw));
    } catch (error) {
      throw new CodexProError(`Invalid YAML in ${TASKS_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const customTemplates = Object.keys(custom.templates);
  return {
    path: TASKS_CONFIG_PATH,
    existed,
    custom_templates: customTemplates,
    config: {
      version: custom.version ?? 1,
      default_template: custom.default_template ?? "bugfix",
      templates: {
        ...cloneBuiltins(),
        ...custom.templates
      }
    }
  };
}
