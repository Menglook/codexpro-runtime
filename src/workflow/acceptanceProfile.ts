import path from "node:path";
import { minimatch } from "minimatch";
import type {
  AcceptanceConfigFile,
  ProjectAcceptanceProfile,
  ProjectCommand
} from "../project/types.js";
import {
  planImpactedTests,
  type TestImpactLevel,
  type TestImpactNode,
  type TestImpactPlan
} from "../testing/testImpactGraph.js";

export interface AcceptanceProfileSelection {
  requested_profile: string;
  configured_profile: string;
  effective_profile: string;
  alias_chain: string[];
  reason: string;
  changed_files: string[];
  ignored_changed_files: string[];
  allowed_targeted_smoke_commands: string[];
  commands: ProjectCommand[];
  test_impact_plan?: TestImpactPlan;
}

const DOCUMENTATION_PATTERNS = [
  "**/*.md",
  "**/*.mdx",
  "**/*.rst",
  "**/*.txt",
  "docs/**",
  "planning-local/**"
];

const RELEASE_PATTERNS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "templates/**",
  ".github/workflows/**",
  "scripts/release-gate.mjs",
  "scripts/pack-*.mjs",
  "schemas/**"
];

const FULL_PATTERNS = [
  ".codexpro/acceptance.yml",
  "src/goals/**",
  "src/jobs/**",
  "src/tasks/**",
  "src/events/**",
  "src/security/**",
  "src/runtime/**",
  "src/workflow/acceptanceEngine.ts",
  "src/workflow/acceptanceProfile.ts",
  "src/testing/testImpactGraph.ts",
  "scripts/final-control-plane-acceptance-smoke.mjs"
];

const BROWSER_PATTERNS = [
  "src/browser/**",
  "chrome-extension/**",
  "src/adapters/playwright-adapter.ts",
  "scripts/browser-*.mjs",
  "shared/browser-runtime-env.*"
];

const IGNORED_RUNTIME_CHANGE_PATTERNS = [
  ".ai-bridge",
  ".ai-bridge/**",
  ".codexpro/task-identities",
  ".codexpro/task-identities/**",
  ".codexpro/runs",
  ".codexpro/runs/**",
  ".codexpro/reports",
  ".codexpro/reports/**",
  ".codexpro/session-trees",
  ".codexpro/session-trees/**",
  ".codexpro/final-acceptance",
  ".codexpro/final-acceptance/**"
];

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(file, pattern, { dot: true, nocase: false, matchBase: false }));
}

export function partitionAcceptanceChangedFiles(files: string[]): { changed: string[]; ignored: string[] } {
  const normalized = unique(files);
  return {
    changed: normalized.filter((file) => !matchesAny(file, IGNORED_RUNTIME_CHANGE_PATTERNS)),
    ignored: normalized.filter((file) => matchesAny(file, IGNORED_RUNTIME_CHANGE_PATTERNS))
  };
}

function allDocumentation(files: string[]): boolean {
  return files.length > 0 && files.every((file) => matchesAny(file, DOCUMENTATION_PATTERNS));
}

function isDirectSmokeCommand(command: string): boolean {
  return /^node\s+scripts\/[A-Za-z0-9._-]+-smoke\.mjs$/.test(command.trim());
}

function directSmokeScript(files: string[]): string | undefined {
  if (files.length !== 1) return undefined;
  const file = files[0];
  if (!/^scripts\/[A-Za-z0-9._-]+-smoke\.mjs$/.test(file)) return undefined;
  return file;
}

function generatedCommand(name: string, command: string, timeoutMs: number, testScope: "targeted" | "full" = "targeted"): ProjectCommand {
  return {
    name,
    command,
    timeout_ms: timeoutMs,
    resource_profile: testScope === "full" ? "acceptance-full-test" : "acceptance-test",
    test_scope: testScope,
    require_non_watch_mode: true
  };
}

function buildCommand(): ProjectCommand {
  return generatedCommand("build", "npm run build", 120_000);
}

function docsCommand(): ProjectCommand {
  return generatedCommand("docs-diff-check", "git diff --check", 30_000);
}

function fullCommands(): ProjectCommand[] {
  return [
    buildCommand(),
    generatedCommand("smoke", "npm run smoke", 180_000, "full")
  ];
}

function browserCommands(): ProjectCommand[] {
  return [
    buildCommand(),
    generatedCommand("browser-smoke", "npm run browser-smoke", 180_000)
  ];
}

function releaseCommands(): ProjectCommand[] {
  return [
    buildCommand(),
    generatedCommand("smoke", "npm run smoke", 180_000, "full"),
    generatedCommand("browser-smoke", "npm run browser-smoke", 180_000, "full")
  ];
}

function commandFromNode(node: TestImpactNode): ProjectCommand {
  const full = node.level === "release" || node.resource_level === "cpu-heavy";
  return generatedCommand(node.id, node.command, node.timeout_ms, full ? "full" : "targeted");
}

function dedupeCommands(commands: ProjectCommand[]): ProjectCommand[] {
  const seen = new Set<string>();
  const out: ProjectCommand[] = [];
  for (const command of commands) {
    const key = `${command.cwd ?? "."}\n${command.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}

function configuredCommands(
  acceptance: AcceptanceConfigFile,
  profileName: string,
  fallback: ProjectCommand[]
): ProjectCommand[] {
  const commands = acceptance.profiles?.[profileName]?.commands ?? [];
  return commands.length ? commands.map((command) => ({ ...command })) : fallback;
}

function profileOrFallback(
  acceptance: AcceptanceConfigFile,
  requestedProfile: string,
  configuredProfile: string,
  aliasChain: string[],
  effectiveProfile: string,
  reason: string,
  changedFiles: string[],
  ignoredChangedFiles: string[],
  fallback: ProjectCommand[]
): AcceptanceProfileSelection {
  return {
    requested_profile: requestedProfile,
    configured_profile: configuredProfile,
    effective_profile: effectiveProfile,
    alias_chain: aliasChain,
    reason,
    changed_files: changedFiles,
    ignored_changed_files: ignoredChangedFiles,
    allowed_targeted_smoke_commands: [],
    commands: configuredCommands(acceptance, effectiveProfile, fallback)
  };
}

function resolveAlias(acceptance: AcceptanceConfigFile, requestedProfile: string): {
  profileName: string;
  profile: ProjectAcceptanceProfile;
  aliasChain: string[];
} {
  const profiles = acceptance.profiles ?? {};
  const aliasChain: string[] = [];
  let profileName = requestedProfile;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(profileName)) throw new Error(`Acceptance profile alias cycle: ${[...aliasChain, profileName].join(" -> ")}`);
    visited.add(profileName);
    const profile = profiles[profileName];
    if (!profile) throw new Error(`Acceptance profile not found: ${profileName}`);
    aliasChain.push(profileName);
    if (!profile.alias_profile) return { profileName, profile, aliasChain };
    profileName = profile.alias_profile;
  }
}

export function selectAcceptanceProfile(
  acceptance: AcceptanceConfigFile,
  requestedProfile: string,
  changedFilesInput: string[]
): AcceptanceProfileSelection {
  const { changed: changedFiles, ignored: ignoredChangedFiles } = partitionAcceptanceChangedFiles(changedFilesInput);
  const resolved = resolveAlias(acceptance, requestedProfile);
  const configuredProfile = resolved.profileName;
  const profile = resolved.profile;
  const aliasReason = resolved.aliasChain.length > 1 ? ` Alias: ${resolved.aliasChain.join(" -> ")}.` : "";
  const ignoredReason = ignoredChangedFiles.length ? ` Ignored generated runtime state: ${ignoredChangedFiles.join(", ")}.` : "";
  const selectionContext = `${aliasReason}${ignoredReason}`;

  if (!profile.dynamic_test_impact) {
    if (!profile.commands.length) throw new Error(`Acceptance profile has no commands: ${configuredProfile}`);
    return {
      requested_profile: requestedProfile,
      configured_profile: configuredProfile,
      effective_profile: configuredProfile,
      alias_chain: resolved.aliasChain,
      reason: `Explicit static profile selected.${selectionContext}`,
      changed_files: changedFiles,
      ignored_changed_files: ignoredChangedFiles,
      allowed_targeted_smoke_commands: [],
      commands: profile.commands.map((command) => ({ ...command }))
    };
  }

  if (!changedFiles.length) {
    return {
      requested_profile: requestedProfile,
      configured_profile: configuredProfile,
      effective_profile: "skipped",
      alias_chain: resolved.aliasChain,
      reason: `No applicable changed files remain after filtering generated runtime state.${selectionContext}`,
      changed_files: changedFiles,
      ignored_changed_files: ignoredChangedFiles,
      allowed_targeted_smoke_commands: [],
      commands: []
    };
  }

  if (changedFiles.some((file) => matchesAny(file, RELEASE_PATTERNS))) {
    return profileOrFallback(
      acceptance,
      requestedProfile,
      configuredProfile,
      resolved.aliasChain,
      "release",
      `Release-sensitive file changed; release validation is required.${selectionContext}`,
      changedFiles,
      ignoredChangedFiles,
      releaseCommands()
    );
  }

  if (changedFiles.some((file) => matchesAny(file, FULL_PATTERNS))) {
    return profileOrFallback(
      acceptance,
      requestedProfile,
      configuredProfile,
      resolved.aliasChain,
      "full",
      `Core control-plane or acceptance infrastructure changed; full validation is required.${selectionContext}`,
      changedFiles,
      ignoredChangedFiles,
      fullCommands()
    );
  }

  if (changedFiles.some((file) => matchesAny(file, BROWSER_PATTERNS))) {
    return profileOrFallback(
      acceptance,
      requestedProfile,
      configuredProfile,
      resolved.aliasChain,
      "browser",
      `Browser-owned file changed; browser validation is required.${selectionContext}`,
      changedFiles,
      ignoredChangedFiles,
      browserCommands()
    );
  }

  if (allDocumentation(changedFiles)) {
    return profileOrFallback(
      acceptance,
      requestedProfile,
      configuredProfile,
      resolved.aliasChain,
      "docs",
      `All changed files are documentation; deterministic diff validation is sufficient.${selectionContext}`,
      changedFiles,
      ignoredChangedFiles,
      [docsCommand()]
    );
  }

  const smokeScript = directSmokeScript(changedFiles);
  if (smokeScript) {
    const smoke = generatedCommand(path.basename(smokeScript, ".mjs"), `node ${smokeScript}`, 90_000);
    const commands = profile.include_build ? [buildCommand(), smoke] : [smoke];
    return {
      requested_profile: requestedProfile,
      configured_profile: configuredProfile,
      effective_profile: profile.include_build ? "targeted-build" : "targeted",
      alias_chain: resolved.aliasChain,
      reason: `Exactly one smoke script changed; run only its direct check${profile.include_build ? " plus build" : ""}.${selectionContext}`,
      changed_files: changedFiles,
      ignored_changed_files: ignoredChangedFiles,
      allowed_targeted_smoke_commands: [smoke.command],
      commands: dedupeCommands(commands)
    };
  }

  const level: TestImpactLevel = profile.test_impact_level ?? "targeted";
  const plan = planImpactedTests(changedFiles, { level });
  if (plan.uncovered_files.length) {
    return {
      ...profileOrFallback(
        acceptance,
        requestedProfile,
        configuredProfile,
        resolved.aliasChain,
        "full",
        `Test Impact Graph does not cover: ${plan.uncovered_files.join(", ")}; automatically upgraded to full validation.${selectionContext}`,
        changedFiles,
        ignoredChangedFiles,
        fullCommands()
      ),
      test_impact_plan: plan
    };
  }

  let commands = plan.nodes.map(commandFromNode);
  const planProvidesBuild = plan.nodes.some((node) => node.id === "build" || node.provides_build === true);
  if (profile.include_build && !planProvidesBuild) {
    commands = [buildCommand(), ...commands];
  }
  if (!commands.length) commands = profile.commands.length ? profile.commands : [buildCommand()];
  return {
    requested_profile: requestedProfile,
    configured_profile: configuredProfile,
    effective_profile: profile.include_build ? "targeted-build" : "targeted",
    alias_chain: resolved.aliasChain,
    reason: `Selected changed-file Test Impact Graph at ${level} level; matched nodes: ${plan.matched_node_ids.join(", ") || "build"}.${selectionContext}`,
    changed_files: changedFiles,
    ignored_changed_files: ignoredChangedFiles,
    allowed_targeted_smoke_commands: commands.map((command) => command.command).filter(isDirectSmokeCommand),
    commands: dedupeCommands(commands),
    test_impact_plan: plan
  };
}
