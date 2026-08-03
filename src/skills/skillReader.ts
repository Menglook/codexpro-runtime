import fsp from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { CodexProError, isSubpath } from "../guard.js";
import { loadSkillsLock, verifyLockedSkillDigest } from "./skillLock.js";
import type {
  InstalledSkillSummary,
  ReadSkillResult,
  ResolvedSkillLockEntry,
  SkillReaderConfig
} from "./types.js";

const PRIVATE_KEY_NAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts"
]);
const PRIVATE_KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks"]);

function assertEnabled(config: SkillReaderConfig): void {
  if (!config.skillsEnabled) {
    throw new CodexProError("Skill reading is disabled. Set CODEXPRO_SKILLS_ENABLED=1 to enable it.");
  }
}

function normalizeResource(resource: string): string {
  if (resource.includes("\0") || /[\r\n]/.test(resource)) {
    throw new CodexProError("Skill resource must be one path without NUL bytes or line breaks.");
  }
  const portable = resource.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(resource)) {
    throw new CodexProError("Absolute Skill resource paths are not allowed.");
  }
  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError("Skill resource path escapes the locked Skill root.");
  }
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CodexProError("Skill resource path contains an unsafe path segment.");
  }
  return normalized;
}

function assertNonSensitiveResource(resource: string): void {
  const parts = resource.toLowerCase().split("/");
  for (const part of parts) {
    if (part === ".env" || part.startsWith(".env.")) {
      throw new CodexProError("Environment files cannot be read through read_skill.");
    }
  }
  const basename = parts.at(-1) ?? "";
  if (PRIVATE_KEY_NAMES.has(basename) || PRIVATE_KEY_EXTENSIONS.has(path.extname(basename))) {
    throw new CodexProError("Private key or credential files cannot be read through read_skill.");
  }
}

async function readUtf8TextBounded(filePath: string, maxBytes: number): Promise<{ content: string; bytes: number }> {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new CodexProError("Skill resource is not a regular file.");
  if (stat.size > maxBytes) {
    throw new CodexProError(`Skill resource is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
  }
  const bytes = await fsp.readFile(filePath);
  if (bytes.includes(0)) throw new CodexProError("Refusing to read binary Skill resource.");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CodexProError("Skill resource is not valid UTF-8 text.");
  }
  return { content, bytes: stat.size };
}

function summaryFor(entry: ResolvedSkillLockEntry, integrity: InstalledSkillSummary["integrity"], error?: string): InstalledSkillSummary {
  return {
    name: entry.name,
    enabled: entry.enabled,
    source_repository: entry.source_repository,
    source_commit: entry.source_commit,
    ...(entry.version ? { version: entry.version } : {}),
    entry_path: entry.entry,
    digest: `sha256:${entry.expected_digest}`,
    integrity,
    ...(error ? { integrity_error: error } : {})
  };
}

export async function listInstalledSkills(config: SkillReaderConfig): Promise<InstalledSkillSummary[]> {
  assertEnabled(config);
  const entries = await loadSkillsLock(config);
  return Promise.all(entries.map(async (entry) => {
    try {
      await verifyLockedSkillDigest(entry);
      return summaryFor(entry, "verified");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return summaryFor(entry, message.includes("expected") ? "mismatch" : "error", message);
    }
  }));
}

export async function readInstalledSkill(
  config: SkillReaderConfig,
  skillName: string,
  requestedResource?: string
): Promise<ReadSkillResult> {
  assertEnabled(config);
  const entries = await loadSkillsLock(config);
  const entry = entries.find((candidate) => candidate.name === skillName);
  if (!entry) throw new CodexProError(`Skill is not present in the approved lock file: ${skillName}`);
  if (!entry.enabled) throw new CodexProError(`Skill is disabled in the approved lock file: ${skillName}`);
  await verifyLockedSkillDigest(entry);

  const resource = normalizeResource(requestedResource?.trim() || entry.entry);
  assertNonSensitiveResource(resource);
  const lexicalPath = path.resolve(entry.canonical_root, resource);
  if (!isSubpath(lexicalPath, entry.canonical_root)) {
    throw new CodexProError("Skill resource path escapes the locked Skill root.");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await fsp.realpath(lexicalPath);
  } catch {
    throw new CodexProError(`Skill resource does not exist: ${resource}`);
  }
  if (!isSubpath(canonicalPath, entry.canonical_root)) {
    throw new CodexProError("Skill resource resolves outside the locked Skill root through a symlink.");
  }
  const { content, bytes } = await readUtf8TextBounded(canonicalPath, config.maxSkillReadBytes);
  return {
    skill: {
      ...summaryFor(entry, "verified"),
      integrity: "verified"
    },
    resource,
    bytes,
    content,
    loaded_at: new Date().toISOString()
  };
}
