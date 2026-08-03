import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, displayPath, normalizeRelPath, type PathGuard, type Workspace } from "../guard.js";
import { sha256, writeTextFile } from "../fsOps.js";
import type { DetectedProjectProfile } from "./types.js";

export const PROJECT_MEMORY_DIR = ".codexpro/memory";

export const PROJECT_MEMORY_STANDARD_FILES = [
  "README.md",
  "project.md",
  "rules.md",
  "decisions.md",
  "glossary.md",
  "handoff.md",
  "governance.yml"
] as const;

export interface ProjectMemoryFileResult {
  path: string;
  standard: boolean;
  existed: boolean;
  changed?: boolean;
  bytes?: number;
  sha256?: string;
  text?: string;
  truncated?: boolean;
}

export interface ProjectMemoryInitResult {
  path: string;
  existed: boolean;
  changed: boolean;
  files: ProjectMemoryFileResult[];
}

export interface ProjectMemoryReadOptions {
  includeCustom?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface ProjectMemoryReadResult {
  path: string;
  existed: boolean;
  files: ProjectMemoryFileResult[];
  missing_standard_files: string[];
  total_files: number;
  total_bytes: number;
  truncated: boolean;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function memoryPath(fileName: string): string {
  return `${PROJECT_MEMORY_DIR}/${fileName}`;
}

function bulletList(items: string[], fallback: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

export function projectMemoryTemplates(profile: DetectedProjectProfile): Record<string, string> {
  const frameworks = profile.frameworks.length ? profile.frameworks.join(", ") : "not detected yet";
  const packageManager = profile.package_manager ?? "not detected yet";
  const primaryLanguage = profile.primary_language ?? "not detected yet";

  return {
    "README.md": `# CodexPro Project Memory\n\nThis directory stores project-local memory for CodexPro-assisted work. It is intentionally separate from global assistant memory and from transient handoff files.\n\n## Standard files\n\n- \`project.md\`: stable project identity, stack, entry points, and important paths.\n- \`rules.md\`: project-specific engineering, product, safety, and review rules.\n- \`decisions.md\`: durable decisions with dates, rationale, and reversal notes.\n- \`glossary.md\`: domain vocabulary, acronyms, and naming conventions.\n- \`handoff.md\`: current stage, next actions, and operational notes for future sessions.\n\n## Policy\n\n- CodexPro reads and summarizes these files on request.\n- CodexPro does not automatically write long-term memory. Add or update entries deliberately.\n- Do not store secrets, API tokens, private keys, credentials, or sensitive personal data here.\n- Keep entries concise, dated when useful, and stable enough to help future work.\n`,
    "project.md": `# Project Memory: Project\n\n## Identity\n\n- Name: ${profile.name}\n- Kind: ${profile.kind}\n- Primary language: ${primaryLanguage}\n- Package manager: ${packageManager}\n- Frameworks: ${frameworks}\n\n## Purpose\n\nDescribe the durable purpose of this repository here. Keep this section stable and focused on what the project is for, not on temporary implementation tasks.\n\n## Important paths\n\n${bulletList(profile.important_paths, "Add important source, configuration, documentation, and workflow paths as they become stable.")}\n\n## Entrypoints\n\n${bulletList(profile.entrypoints, "Add runtime, CLI, server, worker, or build entrypoints when confirmed.")}\n\n## Detection notes\n\nThis file was initialized from local repository signals. Review and edit it when the detected profile is incomplete or too generic.\n`,
    "rules.md": `# Project Memory: Rules\n\n## Operating rules\n\n- Prefer small, reviewable changes over broad rewrites.\n- Preserve user-authored project memory unless explicitly asked to change it.\n- Keep generated examples free of secrets and live credentials.\n- Read the task preflight rule summary before changing files.\n- Run the relevant local verification command before considering a stage complete.\n\n## Engineering rules\n\n- Record durable project conventions here, such as naming, directory ownership, API boundaries, release gates, and migration rules.\n- Put temporary task instructions in \`.ai-bridge/current-plan.md\`, not in long-term memory.\n\n## Product / business rules\n\n- Add product-specific or business-specific constraints that should apply across future sessions.\n\n## Safety notes\n\n- Never store API keys, tokens, passwords, private keys, session cookies, or customer-sensitive data in project memory.\n`,
    "decisions.md": `# Project Memory: Decisions\n\nUse this file for decisions that should survive beyond one implementation session.\n\n| Date | Decision | Rationale | Reversal / revisit trigger |\n| --- | --- | --- | --- |\n| YYYY-MM-DD | Example: keep project memory local under \`.codexpro/memory\`. | Keeps durable project knowledge versionable and separate from transient handoff files. | Revisit if the project adopts a different memory backend. |\n`,
    "glossary.md": `# Project Memory: Glossary\n\nUse this file for project-specific terms, abbreviations, product names, internal names, and naming conventions.\n\n| Term | Meaning | Notes |\n| --- | --- | --- |\n| CodexPro project memory | Local, durable project knowledge stored under \`.codexpro/memory\`. | Read/summarized on request; not automatically written as long-term memory. |\n`,
    "handoff.md": `# Project Memory: Handoff\n\n## Current stage\n\nRecord the current durable project stage here when it should be visible in future sessions.\n\n## Next actions\n\n- Add the next confirmed stage or milestone after it is agreed.\n- Link to relevant docs, commands, or acceptance profiles.\n\n## Verification commands\n\n${bulletList(profile.suggested_acceptance_commands.map((command) => command.command), "Add the standard build, smoke, acceptance, or release-gate commands for this repository.")}\n\n## Notes\n\nUse this file for durable handoff context. Use \`.ai-bridge/\` for transient execution plans and agent status.\n`,
    "governance.yml": `version: 1\nentries: []\n`
  };
}

export async function initProjectMemory(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  profile: DetectedProjectProfile
): Promise<ProjectMemoryInitResult> {
  const dirResolved = guard.resolve(workspace, PROJECT_MEMORY_DIR, { forWrite: true });
  const existed = await fsp.access(dirResolved.absPath).then(() => true, () => false);
  await fsp.mkdir(dirResolved.absPath, { recursive: true });

  const templates = projectMemoryTemplates(profile);
  const files: ProjectMemoryFileResult[] = [];
  let changed = false;

  for (const fileName of PROJECT_MEMORY_STANDARD_FILES) {
    const relPath = memoryPath(fileName);
    const resolved = guard.resolve(workspace, relPath, { forWrite: true });
    const fileExists = await fsp.access(resolved.absPath).then(() => true, () => false);
    if (fileExists) {
      const stat = await fsp.stat(resolved.absPath);
      files.push({ path: relPath, standard: true, existed: true, changed: false, bytes: stat.size });
      continue;
    }

    const content = templates[fileName];
    const writeResult = await writeTextFile(config, guard, workspace, relPath, content, { createDirs: true, overwrite: false });
    files.push({ path: relPath, standard: true, existed: false, changed: true, bytes: writeResult.bytes, sha256: writeResult.sha256 });
    changed = true;
  }

  return { path: PROJECT_MEMORY_DIR, existed, changed, files };
}

async function collectMemoryFiles(guard: PathGuard, workspace: Workspace, includeCustom: boolean, maxFiles: number): Promise<string[]> {
  const dirResolved = guard.resolve(workspace, PROJECT_MEMORY_DIR);
  const standard = PROJECT_MEMORY_STANDARD_FILES.map(memoryPath);
  if (!includeCustom) return standard;

  const found = new Set<string>(standard);

  async function walk(absDir: string, depth: number): Promise<void> {
    if (found.size >= maxFiles || depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (found.size >= maxFiles) return;
      const abs = path.join(absDir, entry.name);
      const rel = normalizeRelPath(displayPath(abs, workspace.root));
      if (guard.isBlockedRelativePath(rel)) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(md|markdown|txt|ya?ml|json)$/i.test(entry.name)) continue;
      found.add(rel);
    }
  }

  await walk(dirResolved.absPath, 0);
  return [...found].slice(0, maxFiles).sort((a, b) => {
    const ai = standard.indexOf(a);
    const bi = standard.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
}

async function readRawMemoryFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  relPath: string,
  maxFileBytes: number
): Promise<ProjectMemoryFileResult> {
  const resolved = guard.resolve(workspace, relPath);
  const exists = await fsp.access(resolved.absPath).then(() => true, () => false);
  const standard = PROJECT_MEMORY_STANDARD_FILES.some((fileName) => relPath === memoryPath(fileName));
  if (!exists) return { path: relPath, standard, existed: false };

  const maxBytes = Math.min(maxFileBytes, config.maxReadBytes);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  const buffer = await fsp.readFile(resolved.absPath);
  const raw = buffer.toString("utf8");
  const truncated = buffer.byteLength > maxBytes;
  const text = truncated ? raw.slice(0, maxBytes) : raw;
  return {
    path: relPath,
    standard,
    existed: true,
    bytes: buffer.byteLength,
    sha256: sha256(raw),
    text,
    truncated
  };
}

export async function readProjectMemory(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProjectMemoryReadOptions = {}
): Promise<ProjectMemoryReadResult> {
  const includeCustom = options.includeCustom ?? true;
  const maxFiles = clampInt(options.maxFiles, 20, 1, 50);
  const maxFileBytes = clampInt(options.maxFileBytes, 20_000, 1_000, 80_000);
  const dirResolved = guard.resolve(workspace, PROJECT_MEMORY_DIR);
  const existed = await fsp.access(dirResolved.absPath).then(() => true, () => false);
  if (!existed) {
    return {
      path: PROJECT_MEMORY_DIR,
      existed: false,
      files: [],
      missing_standard_files: PROJECT_MEMORY_STANDARD_FILES.map(memoryPath),
      total_files: 0,
      total_bytes: 0,
      truncated: false
    };
  }

  const relPaths = await collectMemoryFiles(guard, workspace, includeCustom, maxFiles);
  const files = await Promise.all(relPaths.map((relPath) => readRawMemoryFile(config, guard, workspace, relPath, maxFileBytes)));
  const missing_standard_files = files.filter((file) => file.standard && !file.existed).map((file) => file.path);
  return {
    path: PROJECT_MEMORY_DIR,
    existed: true,
    files,
    missing_standard_files,
    total_files: files.filter((file) => file.existed).length,
    total_bytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0),
    truncated: files.some((file) => file.truncated) || relPaths.length >= maxFiles
  };
}

function extractMemoryHighlights(text: string, maxItems: number): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const highlights: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,3}\s+/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\|[^|]+\|/.test(trimmed)) {
      highlights.push(trimmed);
    }
    if (highlights.length >= maxItems) break;
  }
  if (!highlights.length) {
    const firstText = lines.map((line) => line.trim()).find((line) => line.length > 0);
    if (firstText) highlights.push(firstText);
  }
  return highlights;
}

export function formatProjectMemory(result: ProjectMemoryReadResult): string {
  if (!result.existed) {
    return [
      "# Project Memory",
      "",
      `Path: ${result.path}`,
      "Exists: no",
      "",
      "Run `init_project_config` to create the standard project memory structure."
    ].join("\n");
  }

  const lines = [
    "# Project Memory",
    "",
    `Path: ${result.path}`,
    "Exists: yes",
    `Files read: ${result.total_files}`,
    `Total bytes: ${result.total_bytes}`,
    result.missing_standard_files.length ? `Missing standard files: ${result.missing_standard_files.join(", ")}` : "Missing standard files: none"
  ];

  for (const file of result.files) {
    lines.push("", `## ${file.path}`, "", `Standard: ${file.standard ? "yes" : "no"}`, `Exists: ${file.existed ? "yes" : "no"}`);
    if (!file.existed) continue;
    lines.push(`Bytes: ${file.bytes ?? 0}`, file.truncated ? "Truncated: yes" : "Truncated: no", "", "```markdown", file.text?.trimEnd() ?? "", "```");
  }

  return lines.join("\n");
}

export function summarizeProjectMemory(result: ProjectMemoryReadResult): string {
  if (!result.existed) {
    return [
      "# Project Memory Summary",
      "",
      `Path: ${result.path}`,
      "Exists: no",
      "",
      "No project memory has been initialized yet. Run `init_project_config` to create `.codexpro/memory` with standard starter files."
    ].join("\n");
  }

  const lines = [
    "# Project Memory Summary",
    "",
    `Path: ${result.path}`,
    `Files read: ${result.total_files}`,
    `Total bytes: ${result.total_bytes}`,
    result.missing_standard_files.length ? `Missing standard files: ${result.missing_standard_files.join(", ")}` : "Missing standard files: none",
    "",
    "## Highlights"
  ];

  const existingFiles = result.files.filter((file) => file.existed && file.text);
  if (!existingFiles.length) {
    lines.push("- No readable memory files found.");
    return lines.join("\n");
  }

  for (const file of existingFiles) {
    lines.push("", `### ${file.path}`);
    const highlights = extractMemoryHighlights(file.text ?? "", 8);
    if (!highlights.length) {
      lines.push("- No summary-worthy lines found.");
      continue;
    }
    for (const highlight of highlights) lines.push(`- ${highlight}`);
    if (file.truncated) lines.push("- File was truncated during summary input.");
  }

  lines.push("", "## Write policy", "- Project memory is not automatically updated as long-term memory. Make deliberate edits when durable context changes.");
  return lines.join("\n");
}

export function assertProjectMemoryPath(relPath: string): void {
  const normalized = normalizeRelPath(relPath);
  if (normalized !== PROJECT_MEMORY_DIR && !normalized.startsWith(`${PROJECT_MEMORY_DIR}/`)) {
    throw new CodexProError(`Not a project memory path: ${relPath}`);
  }
}
