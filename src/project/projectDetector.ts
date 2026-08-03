import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { type Workspace, PathGuard } from "../guard.js";
import { detectProjectWithAdapters, resolveProjectKind } from "../adapters/adapter-registry.js";
import type { AdapterProfile } from "../adapters/types.js";
import type { DetectedProjectProfile, ProjectCommand } from "./types.js";

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(absPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fsp.readFile(absPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function collectEnvFiles(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /^\.env(?:\.|$)|^env\.example$|^\.env\.example$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function projectNameFromPackage(packageJson: Record<string, unknown> | undefined, workspace: Workspace): string {
  const name = packageJson?.name;
  return typeof name === "string" && name.trim() ? name.trim() : path.basename(workspace.root);
}

async function genericImportantPaths(root: string): Promise<string[]> {
  const candidates = [
    "src",
    "app",
    "pages",
    "components",
    "backend",
    "frontend",
    "scripts",
    "templates",
    "schemas",
    "README.md",
    "README_ZH.md",
    "AGENTS.md",
    "AGENTS.example.md"
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(path.join(root, candidate))) found.push(candidate);
  }
  return found;
}

function mergeStrings(...groups: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function riskPaths(adapterProfile: AdapterProfile, envFiles: string[]): string[] {
  return mergeStrings([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
    ".cache",
    ...envFiles,
    "mysql",
    "mysql-data",
    "db_data"
  ], adapterProfile.risk_paths);
}

export async function detectProject(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<DetectedProjectProfile> {
  void config;
  const root = guard.resolve(workspace, ".").absPath;
  const adapterProfile = await detectProjectWithAdapters(root);
  const packageJson = await readJsonFile(path.join(root, "package.json"));
  const envFiles = await collectEnvFiles(root);
  const importantPaths = mergeStrings(adapterProfile.important_paths, await genericImportantPaths(root));

  return {
    name: projectNameFromPackage(packageJson, workspace),
    root: workspace.root,
    kind: resolveProjectKind(adapterProfile.signals),
    adapters: adapterProfile.adapters,
    package_manager: adapterProfile.package_manager,
    primary_language: adapterProfile.primary_language,
    frameworks: adapterProfile.frameworks,
    signals: adapterProfile.signals,
    important_paths: importantPaths,
    suggested_acceptance_commands: adapterProfile.commands.suggested,
    start_commands: adapterProfile.commands.start,
    build_commands: adapterProfile.commands.build,
    test_commands: adapterProfile.commands.test,
    lint_commands: adapterProfile.commands.lint,
    docker_services: adapterProfile.docker_services,
    env_files: envFiles,
    risk_paths: riskPaths(adapterProfile, envFiles),
    entrypoints: adapterProfile.entrypoints,
    has_docker: adapterProfile.has_docker,
    has_database: adapterProfile.has_database,
    has_frontend: adapterProfile.has_frontend,
    has_backend: adapterProfile.has_backend,
    has_browser_app: adapterProfile.has_browser_app
  };
}

function commandList(title: string, commands: ProjectCommand[]): string[] {
  return [
    `## ${title}`,
    "",
    commands.length ? commands.map((command) => `- ${command.name}: ${command.command}`).join("\n") : "- none",
    ""
  ];
}

export function formatDetectedProject(profile: DetectedProjectProfile): string {
  const lines = [
    "# Detected Project",
    "",
    `Name: ${profile.name}`,
    `Kind: ${profile.kind}`,
    `Root: ${profile.root}`,
    `Adapters: ${profile.adapters.length ? profile.adapters.join(", ") : "n/a"}`,
    `Package manager: ${profile.package_manager ?? "n/a"}`,
    `Primary language: ${profile.primary_language ?? "n/a"}`,
    `Frameworks: ${profile.frameworks.length ? profile.frameworks.join(", ") : "n/a"}`,
    `Docker: ${profile.has_docker ? "yes" : "no"}`,
    `Database signals: ${profile.has_database ? "yes" : "no"}`,
    `Frontend signals: ${profile.has_frontend ? "yes" : "no"}`,
    `Backend signals: ${profile.has_backend ? "yes" : "no"}`,
    "",
    "## Signals",
    profile.signals.length ? profile.signals.map((signal) => `- ${signal.path}: ${signal.detail}`).join("\n") : "- No strong project signals found.",
    "",
    "## Docker services",
    profile.docker_services.length ? profile.docker_services.map((service) => `- ${service}`).join("\n") : "- none",
    "",
    "## Entrypoints",
    profile.entrypoints.length ? profile.entrypoints.map((entry) => `- ${entry}`).join("\n") : "- none",
    "",
    "## Env files detected",
    profile.env_files.length ? profile.env_files.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "## Risk paths",
    profile.risk_paths.length ? profile.risk_paths.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    ...commandList("Start commands", profile.start_commands),
    ...commandList("Build commands", profile.build_commands),
    ...commandList("Test commands", profile.test_commands),
    ...commandList("Lint/typecheck commands", profile.lint_commands),
    "## Suggested acceptance commands",
    "",
    profile.suggested_acceptance_commands.length
      ? profile.suggested_acceptance_commands.map((command) => `- ${command.name}: ${command.command}`).join("\n")
      : "- No commands detected. Configure .codexpro/acceptance.yml manually."
  ];
  return lines.join("\n");
}
