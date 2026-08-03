import { randomUUID } from "node:crypto";
import { CodexProError } from "../guard.js";
import { loadSkillsLock, verifyLockedSkillDigest } from "./skillLock.js";
import type {
  ActiveSkillRecord,
  ReadSkillResult,
  SkillReaderConfig,
  SkillUsageReceipt
} from "./types.js";

const RECEIPT_TTL_MS = 8 * 60 * 60 * 1_000;
const RECEIPT_PATTERN = /^skill_[a-f0-9-]{36}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const receipts = new Map<string, { active_skill: ActiveSkillRecord; expires_at_ms: number }>();

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CodexProError(`${label} must be a non-empty string.`);
  const trimmed = value.trim();
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) throw new CodexProError(`${label} must be one line.`);
  return trimmed;
}

export function normalizeActiveSkillRecord(value: unknown): ActiveSkillRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexProError("active_skill must be an object created from a successful read_skill call.");
  }
  const record = value as Record<string, unknown>;
  const digest = nonEmpty(record.digest, "active_skill.digest").toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new CodexProError("active_skill.digest must be a SHA-256 digest.");
  const invocation = nonEmpty(record.invocation, "active_skill.invocation");
  if (invocation !== "explicit") throw new CodexProError("active_skill.invocation must be explicit.");
  const loadedAt = nonEmpty(record.loaded_at, "active_skill.loaded_at");
  if (!Number.isFinite(Date.parse(loadedAt))) throw new CodexProError("active_skill.loaded_at must be an ISO timestamp.");
  return {
    name: nonEmpty(record.name, "active_skill.name"),
    source_repository: nonEmpty(record.source_repository, "active_skill.source_repository"),
    source_commit: nonEmpty(record.source_commit, "active_skill.source_commit"),
    entry_path: nonEmpty(record.entry_path, "active_skill.entry_path"),
    digest,
    invocation: "explicit",
    loaded_at: loadedAt
  };
}

export function activeSkillFromReadResult(result: ReadSkillResult): ActiveSkillRecord {
  return {
    name: result.skill.name,
    source_repository: result.skill.source_repository,
    source_commit: result.skill.source_commit,
    entry_path: result.skill.entry_path,
    digest: result.skill.digest,
    invocation: "explicit",
    loaded_at: result.loaded_at
  };
}

export function issueSkillUsageReceipt(result: ReadSkillResult, nowMs = Date.now()): SkillUsageReceipt {
  const activeSkill = activeSkillFromReadResult(result);
  const receiptId = `skill_${randomUUID()}`;
  const expiresAtMs = nowMs + RECEIPT_TTL_MS;
  receipts.set(receiptId, { active_skill: activeSkill, expires_at_ms: expiresAtMs });
  return {
    receipt_id: receiptId,
    active_skill: activeSkill,
    expires_at: new Date(expiresAtMs).toISOString()
  };
}

export async function assertActiveSkillCurrent(
  config: SkillReaderConfig,
  value: ActiveSkillRecord | unknown
): Promise<ActiveSkillRecord> {
  if (!config.skillsEnabled) throw new CodexProError("The recorded Skill cannot be used because Skill reading is disabled.");
  const activeSkill = normalizeActiveSkillRecord(value);
  const entries = await loadSkillsLock(config);
  const entry = entries.find((candidate) => candidate.name === activeSkill.name);
  if (!entry || !entry.enabled) {
    throw new CodexProError(`Recorded Skill ${activeSkill.name} is no longer approved; the task must pause before continuing.`);
  }
  const expectedDigest = `sha256:${entry.expected_digest}`;
  const changed = entry.source_repository !== activeSkill.source_repository
    || entry.source_commit !== activeSkill.source_commit
    || entry.entry !== activeSkill.entry_path
    || expectedDigest !== activeSkill.digest;
  if (changed) {
    throw new CodexProError(`Recorded Skill ${activeSkill.name} no longer matches the approved fixed version; the task must pause before continuing.`);
  }
  try {
    await verifyLockedSkillDigest(entry);
  } catch {
    throw new CodexProError(`Recorded Skill ${activeSkill.name} failed its current fingerprint check; the task must pause before continuing.`);
  }
  return activeSkill;
}

export async function resolveSkillUsageReceipt(
  config: SkillReaderConfig,
  receiptIdInput: string,
  nowMs = Date.now()
): Promise<ActiveSkillRecord> {
  const receiptId = nonEmpty(receiptIdInput, "skill_receipt");
  if (!RECEIPT_PATTERN.test(receiptId)) throw new CodexProError("Invalid skill_receipt format.");
  const stored = receipts.get(receiptId);
  if (!stored) throw new CodexProError("skill_receipt is unknown or was issued by a previous server process. Call read_skill again.");
  if (stored.expires_at_ms <= nowMs) {
    receipts.delete(receiptId);
    throw new CodexProError("skill_receipt expired. Call read_skill again before starting the task.");
  }
  return await assertActiveSkillCurrent(config, stored.active_skill);
}

export function clearSkillUsageReceiptsForTesting(): void {
  receipts.clear();
}
