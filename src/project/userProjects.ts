import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { CodexProConfig } from "../config.js";
import { expandHome } from "../config.js";
import { CodexProError, isSubpath } from "../guard.js";

export interface UserProjectEntry {
  root: string;
  type: string[];
  aliases?: string[];
}

export interface UserProjectsFile {
  active?: string;
  projects: Record<string, UserProjectEntry>;
}

export interface UserProjectRuntimeStatus {
  expanded_root: string;
  exists: boolean;
  is_directory: boolean;
  real_root: string | null;
  allowed: boolean;
  current_server_root: boolean;
  current_runtime_root: boolean;
}

export interface UserProjectSummary extends UserProjectEntry, UserProjectRuntimeStatus {
  name: string;
  active: boolean;
}

export interface UserProjectsLoadResult {
  config_path: string;
  exists: boolean;
  active?: string;
  projects: Record<string, UserProjectEntry>;
  issues: string[];
}

export interface UserProjectsToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface RuntimeWorkspaceRef {
  id?: string;
  root: string;
}

function defaultProjectsFilePath(): string {
  return path.join(os.homedir(), ".codexpro", "projects.yml");
}

export function userProjectsFilePath(): string {
  const override = process.env.CODEXPRO_PROJECTS_FILE?.trim();
  if (!override) return defaultProjectsFilePath();
  return path.resolve(expandHome(override));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTypes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeProjectEntry(name: string, raw: unknown, issues: string[]): UserProjectEntry | undefined {
  if (!isRecord(raw)) {
    issues.push(`Project ${name} is ignored because it is not an object.`);
    return undefined;
  }
  if (typeof raw.root !== "string" || !raw.root.trim()) {
    issues.push(`Project ${name} is ignored because root is missing.`);
    return undefined;
  }
  return {
    root: raw.root.trim(),
    type: normalizeTypes(raw.type ?? raw.types),
    ...(normalizeTypes(raw.aliases).length ? { aliases: normalizeTypes(raw.aliases) } : {})
  };
}

export function readUserProjectsFile(filePath = userProjectsFilePath()): UserProjectsLoadResult {
  if (!fs.existsSync(filePath)) {
    return { config_path: filePath, exists: false, projects: {}, issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CodexProError(`Could not parse projects config ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new CodexProError(`Projects config must be a YAML object: ${filePath}`);
  }

  const issues: string[] = [];
  const projects: Record<string, UserProjectEntry> = {};
  const rawProjects = parsed.projects;
  if (isRecord(rawProjects)) {
    for (const [name, rawProject] of Object.entries(rawProjects)) {
      const trimmedName = name.trim();
      if (!trimmedName) continue;
      const entry = normalizeProjectEntry(trimmedName, rawProject, issues);
      if (entry) projects[trimmedName] = entry;
    }
  } else if (rawProjects !== undefined) {
    issues.push("projects is ignored because it is not an object.");
  }

  const active = typeof parsed.active === "string" && parsed.active.trim() ? parsed.active.trim() : undefined;
  if (active && !projects[active]) issues.push(`active project is not defined under projects: ${active}`);

  return {
    config_path: filePath,
    exists: true,
    active,
    projects,
    issues
  };
}

function realRootOrNull(input: string): string | null {
  const expandedRoot = path.resolve(expandHome(input));
  if (!fs.existsSync(expandedRoot)) return null;
  const stat = fs.statSync(expandedRoot);
  if (!stat.isDirectory()) return null;
  return fs.realpathSync(expandedRoot);
}

function runtimeRoot(runtimeWorkspace?: RuntimeWorkspaceRef): string | undefined {
  return runtimeWorkspace?.root ? realRootOrNull(runtimeWorkspace.root) ?? path.resolve(expandHome(runtimeWorkspace.root)) : undefined;
}

function projectRuntimeStatus(config: CodexProConfig, entry: UserProjectEntry, runtimeWorkspace?: RuntimeWorkspaceRef): UserProjectRuntimeStatus {
  const expandedRoot = path.resolve(expandHome(entry.root));
  const currentRuntimeRoot = runtimeRoot(runtimeWorkspace) ?? config.defaultRoot;
  if (!fs.existsSync(expandedRoot)) {
    return {
      expanded_root: expandedRoot,
      exists: false,
      is_directory: false,
      real_root: null,
      allowed: false,
      current_server_root: false,
      current_runtime_root: false
    };
  }

  const stat = fs.statSync(expandedRoot);
  if (!stat.isDirectory()) {
    return {
      expanded_root: expandedRoot,
      exists: true,
      is_directory: false,
      real_root: null,
      allowed: false,
      current_server_root: false,
      current_runtime_root: false
    };
  }

  const realRoot = fs.realpathSync(expandedRoot);
  return {
    expanded_root: expandedRoot,
    exists: true,
    is_directory: true,
    real_root: realRoot,
    allowed: config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot)),
    current_server_root: realRoot === config.defaultRoot,
    current_runtime_root: realRoot === currentRuntimeRoot
  };
}

function projectSummaries(config: CodexProConfig, load: UserProjectsLoadResult, runtimeWorkspace?: RuntimeWorkspaceRef): UserProjectSummary[] {
  return Object.entries(load.projects)
    .map(([name, entry]) => ({
      name,
      active: load.active === name,
      root: entry.root,
      type: entry.type,
      ...projectRuntimeStatus(config, entry, runtimeWorkspace)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ResolvedUserProject {
  config_path: string;
  active: string | null;
  project: UserProjectSummary;
  issues: string[];
}

function configuredProjectName(load: UserProjectsLoadResult, requested: string): string | undefined {
  if (load.projects[requested]) return requested;
  const normalized = requested.toLowerCase();
  return Object.entries(load.projects).find(([name, entry]) =>
    name.toLowerCase() === normalized
    || entry.aliases?.some((alias) => alias.toLowerCase() === normalized)
    || path.basename(path.resolve(expandHome(entry.root))).toLowerCase() === normalized
  )?.[0];
}

export function resolveUserProject(config: CodexProConfig, projectName: string, runtimeWorkspace?: RuntimeWorkspaceRef): ResolvedUserProject {
  const requestedName = projectName.trim();
  if (!requestedName) throw new CodexProError("project name is required.");

  const load = readUserProjectsFile();
  if (!load.exists) throw new CodexProError(`Projects config not found: ${load.config_path}`);
  const name = configuredProjectName(load, requestedName);
  if (!name) {
    throw new CodexProError(`Project or alias is not defined in ${load.config_path}: ${requestedName}`);
  }
  const entry = load.projects[name];

  const status = projectRuntimeStatus(config, entry, runtimeWorkspace);
  if (!status.exists) throw new CodexProError(`Project root does not exist: ${status.expanded_root}`);
  if (!status.is_directory) throw new CodexProError(`Project root is not a directory: ${status.expanded_root}`);
  if (!status.allowed) {
    throw new CodexProError(
      `Project root is outside current allowed roots: ${status.real_root ?? status.expanded_root}\n` +
        `Allowed roots:\n${config.allowedRoots.map((root) => `- ${root}`).join("\n")}\n\n` +
        "Start CodexPro with an allowed parent root before switching to this project."
    );
  }

  return {
    config_path: load.config_path,
    active: load.active ?? null,
    project: {
      name,
      active: load.active === name,
      root: entry.root,
      type: entry.type,
      ...status
    },
    issues: load.issues
  };
}

export function resolveConfiguredActiveUserProject(config: CodexProConfig, runtimeWorkspace?: RuntimeWorkspaceRef): ResolvedUserProject | undefined {
  const load = readUserProjectsFile();
  if (!load.exists || !load.active) return undefined;
  const entry = load.projects[load.active];
  if (!entry) return undefined;
  return resolveUserProject(config, load.active, runtimeWorkspace);
}

export function isConfiguredProjectPoolRoot(config: CodexProConfig, rootInput: string): boolean {
  const load = readUserProjectsFile();
  if (!load.exists) return false;
  const realPoolRoot = realRootOrNull(rootInput);
  if (!realPoolRoot) return false;

  return Object.values(load.projects).some((entry) => {
    const realProjectRoot = realRootOrNull(entry.root);
    return Boolean(realProjectRoot && realProjectRoot !== realPoolRoot && isSubpath(realProjectRoot, realPoolRoot));
  });
}

function sampleConfigText(config: CodexProConfig): string {
  return [
    "active: current-project",
    "",
    "projects:",
    "  current-project:",
    `    root: ${config.defaultRoot}`,
    "    type:",
    "      - node"
  ].join("\n");
}

function formatProjectLine(project: UserProjectSummary): string {
  const marker = project.active ? "*" : "-";
  const runtime = project.current_runtime_root ? ", active runtime root" : "";
  const server = project.current_server_root ? ", configured server root" : "";
  const types = project.type.length ? project.type.join(", ") : "unknown";
  const allowed = project.allowed ? "allowed" : "not allowed";
  const availability = project.exists && project.is_directory ? allowed : "missing/non-directory";
  return `${marker} ${project.name} — ${project.root} [${types}] (${availability}${runtime}${server})`;
}

export function listUserProjects(config: CodexProConfig, runtimeWorkspace?: RuntimeWorkspaceRef): UserProjectsToolResult {
  const load = readUserProjectsFile();
  const projects = projectSummaries(config, load, runtimeWorkspace);
  const activeProject = projects.find((project) => project.active) ?? null;
  const runtimeProject = projects.find((project) => project.current_runtime_root) ?? null;
  const text = load.exists
    ? [
        "# CodexPro Projects",
        "",
        `Config: ${load.config_path}`,
        `Configured active project: ${load.active ?? "none"}`,
        `Runtime active project: ${runtimeProject?.name ?? "none"}`,
        `Configured server root: ${config.defaultRoot}`,
        `Runtime active root: ${runtimeWorkspace?.root ?? config.defaultRoot}`,
        "",
        projects.length ? projects.map(formatProjectLine).join("\n") : "No projects configured.",
        ...(load.issues.length ? ["", "## Issues", "", load.issues.map((issue) => `- ${issue}`).join("\n")] : [])
      ].join("\n")
    : [
        "# CodexPro Projects",
        "",
        `Config not found: ${load.config_path}`,
        "",
        "Create this file to manage named projects:",
        "",
        "```yaml",
        sampleConfigText(config),
        "```"
      ].join("\n");

  return {
    text,
    structured: {
      config_path: load.config_path,
      exists: load.exists,
      active: load.active ?? null,
      active_project: activeProject,
      runtime_active_project: runtimeProject,
      current_server_root: config.defaultRoot,
      runtime_active_root: runtimeWorkspace?.root ?? config.defaultRoot,
      projects,
      count: projects.length,
      issues: load.issues
    }
  };
}

export function showActiveUserProject(config: CodexProConfig, runtimeWorkspace?: RuntimeWorkspaceRef): UserProjectsToolResult {
  const load = readUserProjectsFile();
  const projects = projectSummaries(config, load, runtimeWorkspace);
  const activeProject = projects.find((project) => project.active) ?? null;
  const runtimeProject = projects.find((project) => project.current_runtime_root) ?? null;
  const runtimeRootText = runtimeWorkspace?.root ?? config.defaultRoot;
  const restartRequired = Boolean(activeProject && activeProject.real_root && activeProject.real_root !== runtimeRootText);
  const text = activeProject
    ? [
        "# Active CodexPro Project",
        "",
        `Config: ${load.config_path}`,
        `Configured active project: ${activeProject.name}`,
        `Runtime active project: ${runtimeProject?.name ?? "none"}`,
        `Configured project root: ${activeProject.root}`,
        `Configured project real root: ${activeProject.real_root ?? "unavailable"}`,
        `Runtime active root: ${runtimeRootText}`,
        `Allowed by current server: ${activeProject.allowed ? "yes" : "no"}`,
        `Runtime matches configured active project: ${activeProject.current_runtime_root ? "yes" : "no"}`,
        `Restart or switch required to make this the runtime active root: ${restartRequired ? "yes" : "no"}`,
        ...(load.issues.length ? ["", "## Issues", "", load.issues.map((issue) => `- ${issue}`).join("\n")] : [])
      ].join("\n")
    : [
        "# Active CodexPro Project",
        "",
        load.exists ? `No active project is configured in ${load.config_path}.` : `Config not found: ${load.config_path}`,
        "Runtime active root:",
        "",
        runtimeRootText,
        ...(load.issues.length ? ["", "## Issues", "", load.issues.map((issue) => `- ${issue}`).join("\n")] : [])
      ].join("\n");

  return {
    text,
    structured: {
      config_path: load.config_path,
      exists: load.exists,
      active: load.active ?? null,
      active_project: activeProject,
      runtime_active_project: runtimeProject,
      current_server_root: config.defaultRoot,
      runtime_active_root: runtimeRootText,
      runtime_matches_configured_active: Boolean(activeProject?.current_runtime_root),
      restart_required: restartRequired,
      issues: load.issues
    }
  };
}

function serializableProjectsFile(active: string, projects: Record<string, UserProjectEntry>): UserProjectsFile {
  const sortedProjects: Record<string, UserProjectEntry> = {};
  for (const name of Object.keys(projects).sort((a, b) => a.localeCompare(b))) {
    const entry = projects[name];
    sortedProjects[name] = {
      root: entry.root,
      type: entry.type,
      ...(entry.aliases?.length ? { aliases: [...entry.aliases] } : {})
    };
  }
  return { active, projects: sortedProjects };
}

export async function activateUserProject(config: CodexProConfig, projectName: string): Promise<UserProjectsToolResult> {
  const requestedName = projectName.trim();
  if (!requestedName) throw new CodexProError("activate_project requires a project name.");

  const load = readUserProjectsFile();
  if (!load.exists) throw new CodexProError(`Projects config not found: ${load.config_path}`);
  const name = configuredProjectName(load, requestedName);
  if (!name) {
    throw new CodexProError(`Project or alias is not defined in ${load.config_path}: ${requestedName}`);
  }
  const entry = load.projects[name];

  const status = projectRuntimeStatus(config, entry);
  if (!status.exists) throw new CodexProError(`Project root does not exist: ${status.expanded_root}`);
  if (!status.is_directory) throw new CodexProError(`Project root is not a directory: ${status.expanded_root}`);
  if (!status.allowed) {
    throw new CodexProError(
      `Project root is outside current allowed roots: ${status.real_root ?? status.expanded_root}\n` +
        `Allowed roots:\n${config.allowedRoots.map((root) => `- ${root}`).join("\n")}\n\n` +
        "Start CodexPro with an allowed parent root before activating this project."
    );
  }

  const nextFile = serializableProjectsFile(name, load.projects);
  await fsp.mkdir(path.dirname(load.config_path), { recursive: true });
  const temporary = `${load.config_path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fsp.writeFile(temporary, stringify(nextFile, { lineWidth: 0 }), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, load.config_path);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  const summary: UserProjectSummary = {
    name,
    active: true,
    root: entry.root,
    type: entry.type,
    ...status
  };
  const text = [
    "# Activate CodexPro Project",
    "",
    `Config updated: ${load.config_path}`,
    `Active project: ${name}`,
    `Root: ${entry.root}`,
    `Real root: ${status.real_root ?? "unavailable"}`,
    "",
    "Project config was updated. The server caller can now switch the runtime active workspace to this root."
  ].join("\n");

  return {
    text,
    structured: {
      config_path: load.config_path,
      active: name,
      active_project: summary,
      current_server_root: config.defaultRoot,
      restart_required: false,
      switched_runtime_root: false
    }
  };
}
