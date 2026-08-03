import type { CodexProConfig } from "../config.js";

export type SkillReaderConfig = Pick<
  CodexProConfig,
  "skillsEnabled" | "skillsRoot" | "skillsLockFile" | "maxSkillReadBytes"
>;

export interface SkillLockEntry {
  enabled: boolean;
  source_repository: string;
  source_commit: string;
  version?: string;
  root: string;
  entry: string;
  sha256: string;
}

export interface SkillsLockFile {
  schema_version: 1;
  skills: Record<string, SkillLockEntry>;
}

export interface ResolvedSkillLockEntry extends SkillLockEntry {
  name: string;
  canonical_root: string;
  canonical_entry_path: string;
  expected_digest: string;
}

export type SkillIntegrityStatus = "verified" | "mismatch" | "error";

export interface InstalledSkillSummary {
  name: string;
  enabled: boolean;
  source_repository: string;
  source_commit: string;
  version?: string;
  entry_path: string;
  digest: string;
  integrity: SkillIntegrityStatus;
  integrity_error?: string;
}

export interface ActiveSkillRecord {
  name: string;
  source_repository: string;
  source_commit: string;
  entry_path: string;
  digest: string;
  invocation: "explicit";
  loaded_at: string;
}

export interface SkillUsageReceipt {
  receipt_id: string;
  active_skill: ActiveSkillRecord;
  expires_at: string;
}

export interface SkillPlannedChange {
  path: string;
  reason: string;
  evidence: string[];
}

export interface SkillTaskPlanInput {
  planned_changes: SkillPlannedChange[];
  planned_commands?: string[];
  memory_action?: "proposal_only";
  cleanup_action?: "proposal_only";
}

export interface ReadSkillResult {
  skill: Omit<InstalledSkillSummary, "integrity_error"> & { integrity: "verified" };
  resource: string;
  bytes: number;
  content: string;
  loaded_at: string;
}
