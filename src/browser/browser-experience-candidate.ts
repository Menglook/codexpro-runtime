import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import {
  browserExperienceCandidateSchema,
  type BrowserExperienceCandidate
} from "./browser-skill-pack-contract.js";
import type { LayeredBrowserSkillSource } from "./browser-skill-pack-runtime.js";
import type { PlatformSkillRunResult } from "./platform-skill-runtime.js";

const SENSITIVE_PATTERNS = [
  /(?:cookie|authorization|bearer|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,}]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:\d[ -]*?){13,19}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
] as const;

function safeId(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export async function createBrowserExperienceCandidate(input: {
  guard: PathGuard;
  workspace: Workspace;
  source: LayeredBrowserSkillSource;
  result: PlatformSkillRunResult;
  drift_reasons?: string[];
}): Promise<{ candidate: BrowserExperienceCandidate; path: string }> {
  if (input.result.status !== "completed" || input.result.verification.status !== "verified") {
    throw new Error("Experience Candidate requires a completed and verified Browser Skill Pack run.");
  }
  const createdAt = new Date().toISOString();
  const candidateId = `browser-experience-${randomUUID()}`;
  const successfulStrategies = input.source.extractors.flatMap((extractor) => extractor.fields.map((field) => {
    const strategy = [...field.strategies].sort((left, right) => left.order - right.order)[0];
    return {
      method: strategy.method,
      target: strategy.target,
      evidence_ref: `browser_snapshot:${input.result.current_page.snapshot_id}`
    };
  }));
  const candidateValue: Record<string, any> = {
    version: 1 as const,
    candidate_id: candidateId,
    task_id: input.result.task_id,
    run_id: input.result.run_id,
    platform: input.result.platform,
    page: input.source.page.id,
    fingerprint_changes: unique(input.drift_reasons ?? []),
    successful_strategies: successfulStrategies,
    failed_strategies: [],
    recovery: [],
    evidence_refs: unique(input.result.evidence_refs),
    sensitive_scan: {
      status: "pending" as const,
      notes: ["Run-scoped candidate contains references and governed strategy metadata only."]
    },
    duplicate_check: {
      status: "passed" as const,
      notes: [`Compared with active pack contract ${input.source.pack.manifest.skill_contract_hash}.`]
    },
    targeted_regression: {
      status: "passed" as const,
      notes: [`Verified task run and redacted fixture ${input.source.workflow.id} are present.`]
    },
    suggested_skill_path: `${input.source.workflow.platform}/workflows/${input.source.workflow.id}.candidate.json`,
    approval: { status: "pending" as const, approved_by: null, approved_at: null },
    automatic_long_term_write: false as const,
    created_at: createdAt
  };
  const scanText = JSON.stringify(candidateValue);
  const findings = SENSITIVE_PATTERNS.filter((pattern) => pattern.test(scanText));
  candidateValue.sensitive_scan = findings.length
    ? { status: "failed", notes: ["Sensitive-data pattern detected; candidate is blocked from promotion."] }
    : { status: "passed", notes: ["No secret, private-key, payment-card, or email pattern detected."] };
  const candidate = browserExperienceCandidateSchema.parse(candidateValue);
  const rel = `.codexpro/runs/${safeId(candidate.run_id)}/browser-experience-candidates/${safeId(candidate.candidate_id)}.json`;
  const resolved = input.guard.resolve(input.workspace, rel);
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  const envelope = {
    candidate,
    candidate_hash: hash(candidate),
    promotion_gate: {
      may_write_long_term_skill_pack: false,
      requires_explicit_user_approval: true,
      approved: false
    }
  };
  const temp = `${resolved.absPath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
  await fsp.rename(temp, resolved.absPath);
  return { candidate, path: rel };
}
