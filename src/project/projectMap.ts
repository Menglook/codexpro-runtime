import type { CodexProConfig } from "../config.js";
import { writeTextFile } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { detectProject } from "./projectDetector.js";
import { readAgentsRules } from "./agentsReader.js";
import type { DetectedProjectProfile, ProjectMapResult, ProjectCommand } from "./types.js";

export const PROJECT_MAP_PATH = ".codexpro/project-map.md";

function section(title: string, body: string): string {
  return [`## ${title}`, "", body.trim() || "n/a", ""].join("\n");
}

function bulletList(values: string[]): string {
  return values.length ? values.map((item) => `- ${item}`).join("\n") : "- none";
}

function commandList(commands: ProjectCommand[]): string {
  return commands.length ? commands.map((command) => `- ${command.name}: \`${command.command}\``).join("\n") : "- none";
}

export function buildProjectMap(profile: DetectedProjectProfile, rules: { files: Array<{ path: string; title: string }>; rules: string[] } = { files: [], rules: [] }): string {
  const commands = profile.suggested_acceptance_commands.length
    ? profile.suggested_acceptance_commands.map((command) => `- ${command.name}: \`${command.command}\``).join("\n")
    : "- Configure `.codexpro/acceptance.yml` before using `run_acceptance`.";

  return [
    "# CodexPro Project Map",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Workspace: ${profile.root}`,
    "",
    section("Project identity", [
      `- Name: ${profile.name}`,
      `- Kind: ${profile.kind}`,
      `- Adapters: ${profile.adapters.length ? profile.adapters.join(", ") : "n/a"}`,
      `- Package manager: ${profile.package_manager ?? "n/a"}`,
      `- Primary language: ${profile.primary_language ?? "n/a"}`,
      `- Frameworks: ${profile.frameworks.length ? profile.frameworks.join(", ") : "n/a"}`,
      `- Docker: ${profile.has_docker ? "yes" : "no"}`,
      `- Database signals: ${profile.has_database ? "yes" : "no"}`,
      `- Frontend signals: ${profile.has_frontend ? "yes" : "no"}`,
      `- Backend signals: ${profile.has_backend ? "yes" : "no"}`,
      `- Browser app signals: ${profile.has_browser_app ? "yes" : "no"}`
    ].join("\n")),
    section("Detected signals", profile.signals.length
      ? profile.signals.map((signal) => `- ${signal.path}: ${signal.detail}`).join("\n")
      : "- No strong project signals found."),
    section("Important paths", bulletList(profile.important_paths)),
    section("Entrypoints", bulletList(profile.entrypoints)),
    section("Docker services", bulletList(profile.docker_services)),
    section("Env files detected", profile.env_files.length
      ? profile.env_files.map((file) => `- ${file} (name only; content is not read)`).join("\n")
      : "- none"),
    section("Risk paths", bulletList(profile.risk_paths)),
    section("Start commands", commandList(profile.start_commands)),
    section("Build commands", commandList(profile.build_commands)),
    section("Test commands", commandList(profile.test_commands)),
    section("Lint/typecheck commands", commandList(profile.lint_commands)),
    section("Suggested acceptance", commands),
    section("Rule files", rules.files.length
      ? rules.files.map((file) => `- ${file.path}: ${file.title}`).join("\n")
      : "- none"),
    section("Extracted project rules", rules.rules.length
      ? rules.rules.slice(0, 20).map((rule) => `- ${rule}`).join("\n")
      : "- none"),
    section("Safety notes", [
      "- Keep project rules in `.codexpro/project.yml`.",
      "- Keep runnable checks in `.codexpro/acceptance.yml`.",
      "- Store task-scoped execution artifacts in `.ai-bridge/` instead of source directories.",
      "- Do not put real secret values in project maps, acceptance reports, logs, or handoff files.",
      "- Env files are listed by filename only; contents must not be read or exported."
    ].join("\n"))
  ].join("\n");
}

export async function generateProjectMap(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<ProjectMapResult> {
  const profile = await detectProject(config, guard, workspace);
  const rules = await readAgentsRules(config, guard, workspace);
  const content = buildProjectMap(profile, { files: rules.files, rules: rules.rules });
  const write = await writeTextFile(config, guard, workspace, PROJECT_MAP_PATH, content, { createDirs: true, overwrite: true });
  return { path: write.path, profile, content };
}
