import path from "node:path";
import { CodexProError } from "../guard.js";
import type { ActiveSkillRecord } from "./types.js";

export interface SkillExecutionPolicy {
  skill_name: string;
  allowed_write_paths: string[];
  forbidden_write_paths: string[];
  blocked_actions: string[];
}

const NEAT_FREAK_ALLOWED_WRITE_PATHS = [
  "README.md",
  "README_*.md",
  "docs/**",
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".ai-bridge/neat-freak/reports/**"
];

const NEAT_FREAK_FORBIDDEN_WRITE_PATHS = [
  "src/**",
  "app/**",
  "server/**",
  "api/**",
  "database/**",
  "migrations/**",
  "package.json",
  "package-lock.json",
  ".env*",
  ".git/**"
];

const NETWORK_COMMAND_PATTERN = /(?:^|[;&|]\s*|\s)(?:curl|wget|aria2c|scp|sftp|ssh|telnet|nc|ncat)\b|https?:\/\/|\bgit\s+(?:push|pull|fetch|clone|ls-remote|submodule\s+update)\b|\b(?:npm|pnpm|yarn)\s+(?:install|add|ci)\b|\bpip(?:3)?\s+install\b|\bapt(?:-get)?\s+(?:install|update|upgrade)\b/i;
const GIT_MUTATION_PATTERN = /\bgit\s+(?:commit|push|merge|rebase|cherry-pick|reset|checkout|switch|clean|rm|tag|stash|worktree\s+(?:add|move|remove|prune)|branch\s+(?:-[dD]|--delete))\b/i;
const DELETE_COMMAND_PATTERN = /(?:^|[;&|]\s*|\s)(?:rm|rmdir|unlink|del)\b|\bfind\b[^\n]*\s-delete\b|\bremove-item\b|\bgit\s+(?:rm|clean)\b/i;
const DEPLOY_COMMAND_PATTERN = /\b(?:deploy|vercel|netlify|flyctl|railway|kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|docker\s+push)\b/i;

function normalizeWorkspaceRelativePath(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new CodexProError("neat-freak write path must be one line without NUL bytes.");
  const portable = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) {
    throw new CodexProError(`neat-freak cannot modify an absolute path: ${value}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`neat-freak write path escapes the current project: ${value}`);
  }
  return normalized;
}

function matchesNeatFreakAllowedPath(filePath: string): boolean {
  if (filePath === "README.md") return true;
  if (/^README_[^/]+\.md$/i.test(filePath)) return true;
  if (filePath === "docs" || filePath.startsWith("docs/")) return true;
  if (["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"].includes(filePath)) return true;
  return filePath === ".ai-bridge/neat-freak/reports" || filePath.startsWith(".ai-bridge/neat-freak/reports/");
}

export function skillExecutionPolicy(activeSkill: ActiveSkillRecord | undefined): SkillExecutionPolicy | undefined {
  if (activeSkill?.name !== "neat-freak") return undefined;
  return {
    skill_name: "neat-freak",
    allowed_write_paths: [...NEAT_FREAK_ALLOWED_WRITE_PATHS],
    forbidden_write_paths: [...NEAT_FREAK_FORBIDDEN_WRITE_PATHS],
    blocked_actions: ["network", "deploy", "git_write", "delete", "memory_write", "cross_project_write"]
  };
}

export function assertSkillWritePathAllowed(policy: SkillExecutionPolicy | undefined, value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value);
  if (policy?.skill_name === "neat-freak" && !matchesNeatFreakAllowedPath(normalized)) {
    throw new CodexProError(
      `neat-freak write denied for ${normalized}. It may only modify README files, docs/**, AGENTS/CLAUDE rule files, or .ai-bridge/neat-freak/reports/**.`
    );
  }
  return normalized;
}

export function assertSkillExecutionPolicy(
  policy: SkillExecutionPolicy | undefined,
  options: { patches?: Array<{ path: string }>; commands?: string[] }
): void {
  if (!policy) return;
  for (const patch of options.patches ?? []) assertSkillWritePathAllowed(policy, patch.path);
  for (const command of options.commands ?? []) {
    if (NETWORK_COMMAND_PATTERN.test(command)) throw new CodexProError("neat-freak command denied: network access is not allowed.");
    if (GIT_MUTATION_PATTERN.test(command)) throw new CodexProError("neat-freak command denied: Git commit, push, merge, branch, worktree, and other Git mutations are not allowed.");
    if (DELETE_COMMAND_PATTERN.test(command)) throw new CodexProError("neat-freak command denied: deleting files or directories is not allowed.");
    if (DEPLOY_COMMAND_PATTERN.test(command)) throw new CodexProError("neat-freak command denied: deployment is not allowed.");
  }
}
