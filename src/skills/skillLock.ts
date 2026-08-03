import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { CodexProError, isSubpath } from "../guard.js";
import type {
  ResolvedSkillLockEntry,
  SkillLockEntry,
  SkillReaderConfig,
  SkillsLockFile
} from "./types.js";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexProError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexProError(`${label}.${key} must be a non-empty string.`);
  }
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new CodexProError(`${label}.${key} must be one line without NUL bytes.`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  if (record[key] === undefined) return undefined;
  return requiredString(record, key, label);
}

function normalizeDigest(value: string, label: string): string {
  const normalized = value.toLowerCase().replace(/^sha256:/, "");
  if (!SHA256_PATTERN.test(normalized)) {
    throw new CodexProError(`${label}.sha256 must be a 64-character SHA-256 digest.`);
  }
  return normalized;
}

function normalizeSafeRelativePath(value: string, label: string): string {
  const portable = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) {
    throw new CodexProError(`${label} must be relative to the locked Skill root.`);
  }
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`${label} escapes the locked Skill root.`);
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CodexProError(`${label} contains an unsafe path segment.`);
  }
  return normalized;
}

async function canonicalSkillsRoot(config: SkillReaderConfig): Promise<string> {
  try {
    const stat = await fsp.stat(config.skillsRoot);
    if (!stat.isDirectory()) throw new CodexProError(`Skills root is not a directory: ${config.skillsRoot}`);
    return await fsp.realpath(config.skillsRoot);
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError(`Skills root is unavailable: ${config.skillsRoot}`);
  }
}

async function assertLockFileInsideRoot(config: SkillReaderConfig, skillsRoot: string): Promise<string> {
  const lexicalLockPath = path.resolve(config.skillsLockFile);
  if (!isSubpath(lexicalLockPath, path.resolve(config.skillsRoot))) {
    throw new CodexProError("Skills lock file must stay inside CODEXPRO_SKILLS_ROOT.");
  }
  try {
    const canonicalLockPath = await fsp.realpath(lexicalLockPath);
    if (!isSubpath(canonicalLockPath, skillsRoot)) {
      throw new CodexProError("Skills lock file resolves outside CODEXPRO_SKILLS_ROOT through a symlink.");
    }
    const stat = await fsp.stat(canonicalLockPath);
    if (!stat.isFile()) throw new CodexProError("Skills lock path is not a file.");
    return canonicalLockPath;
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError(`Skills lock file is unavailable: ${lexicalLockPath}`);
  }
}

function parseLockEntry(name: string, value: unknown): SkillLockEntry {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new CodexProError(`Invalid Skill name in lock file: ${name}`);
  }
  const label = `skills.${name}`;
  const record = asRecord(value, label);
  if (typeof record.enabled !== "boolean") {
    throw new CodexProError(`${label}.enabled must be boolean.`);
  }
  return {
    enabled: record.enabled,
    source_repository: requiredString(record, "source_repository", label),
    source_commit: requiredString(record, "source_commit", label),
    version: optionalString(record, "version", label),
    root: requiredString(record, "root", label),
    entry: normalizeSafeRelativePath(requiredString(record, "entry", label), `${label}.entry`),
    sha256: normalizeDigest(requiredString(record, "sha256", label), label)
  };
}

async function resolveLockEntry(
  name: string,
  entry: SkillLockEntry,
  skillsRoot: string
): Promise<ResolvedSkillLockEntry> {
  if (!path.isAbsolute(entry.root)) {
    throw new CodexProError(`skills.${name}.root must be an absolute path.`);
  }
  const lexicalRoot = path.resolve(entry.root);
  if (!isSubpath(lexicalRoot, skillsRoot)) {
    throw new CodexProError(`Locked Skill root escapes CODEXPRO_SKILLS_ROOT: ${name}`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await fsp.realpath(lexicalRoot);
  } catch {
    throw new CodexProError(`Locked Skill root is unavailable: ${name}`);
  }
  if (!isSubpath(canonicalRoot, skillsRoot)) {
    throw new CodexProError(`Locked Skill root resolves outside CODEXPRO_SKILLS_ROOT: ${name}`);
  }
  const canonicalEntryPath = await fsp.realpath(path.resolve(canonicalRoot, entry.entry)).catch(() => "");
  if (!canonicalEntryPath || !isSubpath(canonicalEntryPath, canonicalRoot)) {
    throw new CodexProError(`Locked Skill entry is unavailable or escapes its root: ${name}`);
  }
  const stat = await fsp.stat(canonicalEntryPath);
  if (!stat.isFile()) throw new CodexProError(`Locked Skill entry is not a file: ${name}`);
  return {
    ...entry,
    name,
    canonical_root: canonicalRoot,
    canonical_entry_path: canonicalEntryPath,
    expected_digest: entry.sha256
  };
}

export async function loadSkillsLock(config: SkillReaderConfig): Promise<ResolvedSkillLockEntry[]> {
  const skillsRoot = await canonicalSkillsRoot(config);
  const lockPath = await assertLockFileInsideRoot(config, skillsRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  } catch (error) {
    throw new CodexProError(`Skills lock file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asRecord(parsed, "skills-lock.json");
  if (root.schema_version !== 1) {
    throw new CodexProError("skills-lock.json schema_version must be 1.");
  }
  const skills = asRecord(root.skills, "skills-lock.json.skills");
  const entries = Object.entries(skills).sort(([a], [b]) => a.localeCompare(b));
  return Promise.all(entries.map(async ([name, value]) => resolveLockEntry(name, parseLockEntry(name, value), skillsRoot)));
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await fsp.readFile(filePath)).digest("hex");
}

export async function verifyLockedSkillDigest(entry: ResolvedSkillLockEntry): Promise<string> {
  const actual = await computeFileSha256(entry.canonical_entry_path);
  if (actual !== entry.expected_digest) {
    throw new CodexProError(
      `Skill integrity check failed for ${entry.name}: expected ${entry.expected_digest}, got ${actual}.`
    );
  }
  return actual;
}

export function skillsLockShape(entries: ResolvedSkillLockEntry[]): SkillsLockFile {
  return {
    schema_version: 1,
    skills: Object.fromEntries(entries.map((entry) => [entry.name, {
      enabled: entry.enabled,
      source_repository: entry.source_repository,
      source_commit: entry.source_commit,
      ...(entry.version ? { version: entry.version } : {}),
      root: entry.root,
      entry: entry.entry,
      sha256: entry.sha256
    }]))
  };
}
