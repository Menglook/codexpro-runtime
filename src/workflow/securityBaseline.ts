import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SECRET_RULE_METADATA,
  SENSITIVE_ASSIGNMENT_RULE_METADATA
} from "../../shared/security-rule-metadata.mjs";
import { findSecretValues } from "../redact.js";
import type {
  SecurityBaselineStatus,
  SecurityDisposition,
  SecurityFindingV2
} from "./securityAudit.js";

export const SECURITY_POLICY_SCHEMA_VERSION = 1 as const;
export const SECURITY_BASELINE_SCHEMA_VERSION = 1 as const;
export const SECURITY_BASELINE_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SECURITY_POLICY_PATH = ".codexpro/security-policy.json";
export const DEFAULT_SECURITY_BASELINE_PATH = ".codexpro/security-baseline.json";

const ISO_DATE_TIME_SCHEMA = z.string().datetime({ offset: true });
const NON_EMPTY_STRING_SCHEMA = z.string().trim().min(1);
const SHA256_SCHEMA = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const BASELINE_DISPOSITION_SCHEMA = z.enum(["false_positive", "accepted_risk"]);
const EVIDENCE_KIND_SCHEMA = z.enum([
  "literal",
  "path",
  "command",
  "sql",
  "console",
  "configuration",
  "syntax",
  "scan_metadata",
  "controlled_test_vector",
  "rule_definition",
  "static_text",
  "execution_sink",
  "database_sink"
]);
const EXPRESSION_KIND_SCHEMA = z.enum([
  "path_presence",
  "double_quoted_literal",
  "single_quoted_literal",
  "template_literal",
  "concatenation",
  "call_expression",
  "reference",
  "command_text",
  "sql_text",
  "console_call",
  "pattern"
]);

function uniqueStrings(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isWorkspaceRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value)) return false;
  return !value.replaceAll("\\", "/").split("/").some((segment) => segment === "..");
}

const WORKSPACE_RELATIVE_PATH_SCHEMA = NON_EMPTY_STRING_SCHEMA.refine(isWorkspaceRelativePath, {
  message: "must be a workspace-relative path without parent traversal"
});

export const SecurityPolicyFileSchema = z.object({
  kind: z.literal("codexpro_security_policy"),
  schema_version: z.literal(SECURITY_POLICY_SCHEMA_VERSION),
  policy_id: NON_EMPTY_STRING_SCHEMA,
  policy_version: NON_EMPTY_STRING_SCHEMA,
  updated_at: ISO_DATE_TIME_SCHEMA,
  baseline: z.object({
    default_path: WORKSPACE_RELATIVE_PATH_SCHEMA,
    allowed_dispositions: z.array(BASELINE_DISPOSITION_SCHEMA).min(1).refine(uniqueStrings, {
      message: "allowed_dispositions must be unique"
    }),
    forbidden_rules: z.array(NON_EMPTY_STRING_SCHEMA).refine(uniqueStrings, {
      message: "forbidden_rules must be unique"
    }),
    accepted_risk_requires_expiry: z.literal(true),
    proposal_requires_manual_approval: z.literal(true)
  }).strict()
}).strict();

export const SecurityBaselineFindingIdentitySchema = z.object({
  fingerprint: SHA256_SCHEMA,
  fingerprint_version: NON_EMPTY_STRING_SCHEMA,
  rule: NON_EMPTY_STRING_SCHEMA,
  rule_version: NON_EMPTY_STRING_SCHEMA,
  path: WORKSPACE_RELATIVE_PATH_SCHEMA,
  evidence_kind: EVIDENCE_KIND_SCHEMA,
  expression_kind: EXPRESSION_KIND_SCHEMA
}).strict();

export const SecurityBaselineEntrySchema = z.object({
  entry_id: NON_EMPTY_STRING_SCHEMA,
  finding: SecurityBaselineFindingIdentitySchema,
  disposition: BASELINE_DISPOSITION_SCHEMA,
  reason: NON_EMPTY_STRING_SCHEMA,
  owner: NON_EMPTY_STRING_SCHEMA,
  approved_at: ISO_DATE_TIME_SCHEMA,
  expires_at: ISO_DATE_TIME_SCHEMA.optional()
}).strict().superRefine((entry, context) => {
  if (entry.disposition === "accepted_risk" && !entry.expires_at) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "accepted_risk entries require expires_at"
    });
  }
});

const BASELINE_BODY_SHAPE = {
  kind: z.literal("codexpro_security_baseline"),
  schema_version: z.literal(SECURITY_BASELINE_SCHEMA_VERSION),
  baseline_id: NON_EMPTY_STRING_SCHEMA,
  policy_id: NON_EMPTY_STRING_SCHEMA,
  policy_version: NON_EMPTY_STRING_SCHEMA,
  created_at: ISO_DATE_TIME_SCHEMA,
  updated_at: ISO_DATE_TIME_SCHEMA,
  approval: z.object({
    mode: z.literal("manual"),
    approved_by: NON_EMPTY_STRING_SCHEMA,
    approved_at: ISO_DATE_TIME_SCHEMA
  }).strict(),
  entries: z.array(SecurityBaselineEntrySchema)
} as const;

function validateUniqueBaselineEntries(
  entries: Array<z.infer<typeof SecurityBaselineEntrySchema>>,
  context: z.RefinementCtx
): void {
  const entryIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entryIds.has(entry.entry_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "entry_id"],
        message: "entry_id must be unique"
      });
    }
    if (fingerprints.has(entry.finding.fingerprint)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "finding", "fingerprint"],
        message: "finding fingerprint must be unique"
      });
    }
    entryIds.add(entry.entry_id);
    fingerprints.add(entry.finding.fingerprint);
  }
}

export const SecurityBaselineBodySchema = z.object(BASELINE_BODY_SHAPE).strict().superRefine((body, context) => {
  validateUniqueBaselineEntries(body.entries, context);
});

export const SecurityBaselineFileSchema = z.object({
  ...BASELINE_BODY_SHAPE,
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: SHA256_SCHEMA
  }).strict()
}).strict().superRefine((document, context) => {
  validateUniqueBaselineEntries(document.entries, context);
});

export type SecurityPolicyFile = z.infer<typeof SecurityPolicyFileSchema>;
export type SecurityBaselineFindingIdentity = z.infer<typeof SecurityBaselineFindingIdentitySchema>;
export type SecurityBaselineEntry = z.infer<typeof SecurityBaselineEntrySchema>;
export type SecurityBaselineBody = z.infer<typeof SecurityBaselineBodySchema>;
export type SecurityBaselineFile = z.infer<typeof SecurityBaselineFileSchema>;
export type SecurityBaselineDisposition = z.infer<typeof BASELINE_DISPOSITION_SCHEMA>;

export const SECURITY_BASELINE_IMMUTABLE_FORBIDDEN_RULES = Object.freeze([
  ...new Set([
    ...SECRET_RULE_METADATA
      .filter((metadata) => metadata.confidence === "high")
      .map((metadata) => metadata.rule),
    SENSITIVE_ASSIGNMENT_RULE_METADATA.rule,
    "sensitive_file_path"
  ])
]);

export type SecurityBaselineErrorCode =
  | "json_invalid"
  | "schema_invalid"
  | "path_outside_workspace"
  | "policy_mismatch"
  | "integrity_mismatch"
  | "forbidden_rule"
  | "disposition_forbidden"
  | "secret_value_forbidden";

export class SecurityBaselineError extends Error {
  readonly code: SecurityBaselineErrorCode;

  constructor(code: SecurityBaselineErrorCode, message: string) {
    super(message);
    this.name = "SecurityBaselineError";
    this.code = code;
  }
}

function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "document"}: ${issue.message}`)
    .join("; ");
}

function parseJsonDocument(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SecurityBaselineError("json_invalid", `${label} is not valid JSON: ${reason}`);
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SecurityBaselineError("schema_invalid", `${label} schema validation failed: ${formatSchemaIssues(parsed.error)}`);
  }
  return parsed.data;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function baselineBodyFromFile(document: SecurityBaselineFile): SecurityBaselineBody {
  const { integrity: _integrity, ...body } = document;
  return body;
}

export function computeSecurityBaselineIntegrity(body: SecurityBaselineBody | Record<string, unknown>): string {
  const source = "integrity" in body
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "integrity"))
    : body;
  return sha256(canonicalJson(source));
}

function resolveWorkspaceFile(workspaceRoot: string, requestedPath: string, fallback: string): string {
  const root = path.resolve(workspaceRoot);
  const relativePath = requestedPath.trim() || fallback;
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new SecurityBaselineError("path_outside_workspace", `Security policy or baseline path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

export function createDefaultSecurityPolicy(input: {
  policy_id: string;
  policy_version: string;
  updated_at?: string;
  default_path?: string;
  forbidden_rules?: string[];
}): SecurityPolicyFile {
  return parseSchema(SecurityPolicyFileSchema, {
    kind: "codexpro_security_policy",
    schema_version: SECURITY_POLICY_SCHEMA_VERSION,
    policy_id: input.policy_id,
    policy_version: input.policy_version,
    updated_at: input.updated_at ?? new Date().toISOString(),
    baseline: {
      default_path: input.default_path ?? DEFAULT_SECURITY_BASELINE_PATH,
      allowed_dispositions: ["false_positive", "accepted_risk"],
      forbidden_rules: input.forbidden_rules ?? [],
      accepted_risk_requires_expiry: true,
      proposal_requires_manual_approval: true
    }
  }, "security policy");
}

export function parseSecurityPolicyFile(value: unknown): SecurityPolicyFile {
  return parseSchema(SecurityPolicyFileSchema, value, "security policy");
}

export async function loadSecurityPolicyFile(
  workspaceRoot: string,
  policyPath = DEFAULT_SECURITY_POLICY_PATH
): Promise<SecurityPolicyFile> {
  const absolutePath = resolveWorkspaceFile(workspaceRoot, policyPath, DEFAULT_SECURITY_POLICY_PATH);
  const text = await fsp.readFile(absolutePath, "utf8");
  return parseSecurityPolicyFile(parseJsonDocument(text, "security policy"));
}

function forbiddenRuleSet(policy: SecurityPolicyFile): Set<string> {
  return new Set([
    ...SECURITY_BASELINE_IMMUTABLE_FORBIDDEN_RULES,
    ...policy.baseline.forbidden_rules
  ]);
}

export function isSecurityBaselineRuleForbidden(rule: string, policy: SecurityPolicyFile): boolean {
  return forbiddenRuleSet(policy).has(rule);
}

function assertBaselineContainsNoSecretValues(document: SecurityBaselineBody | SecurityBaselineFile): void {
  const findings = findSecretValues(JSON.stringify(document), { path: "security-baseline.json" });
  if (findings.length > 0) {
    throw new SecurityBaselineError(
      "secret_value_forbidden",
      "Security baseline metadata contains a secret-looking value and cannot be stored"
    );
  }
}

function validateBaselineAgainstPolicy(document: SecurityBaselineBody | SecurityBaselineFile, policy: SecurityPolicyFile): void {
  if (document.policy_id !== policy.policy_id || document.policy_version !== policy.policy_version) {
    throw new SecurityBaselineError(
      "policy_mismatch",
      `Security baseline policy mismatch: expected ${policy.policy_id}@${policy.policy_version}`
    );
  }
  const forbiddenRules = forbiddenRuleSet(policy);
  const allowedDispositions = new Set(policy.baseline.allowed_dispositions);
  for (const entry of document.entries) {
    if (forbiddenRules.has(entry.finding.rule)) {
      throw new SecurityBaselineError(
        "forbidden_rule",
        `Security baseline entry ${entry.entry_id} uses forbidden rule ${entry.finding.rule}`
      );
    }
    if (!allowedDispositions.has(entry.disposition)) {
      throw new SecurityBaselineError(
        "disposition_forbidden",
        `Security baseline entry ${entry.entry_id} uses disallowed disposition ${entry.disposition}`
      );
    }
  }
}

export function sealSecurityBaseline(
  input: SecurityBaselineBody,
  policy: SecurityPolicyFile
): SecurityBaselineFile {
  const body = parseSchema(SecurityBaselineBodySchema, input, "security baseline");
  assertBaselineContainsNoSecretValues(body);
  validateBaselineAgainstPolicy(body, policy);
  return parseSchema(SecurityBaselineFileSchema, {
    ...body,
    integrity: {
      algorithm: "sha256",
      digest: computeSecurityBaselineIntegrity(body)
    }
  }, "security baseline");
}

export function parseSecurityBaselineFile(value: unknown, policy: SecurityPolicyFile): SecurityBaselineFile {
  const document = parseSchema(SecurityBaselineFileSchema, value, "security baseline");
  assertBaselineContainsNoSecretValues(document);
  const expectedDigest = computeSecurityBaselineIntegrity(baselineBodyFromFile(document));
  if (document.integrity.digest !== expectedDigest) {
    throw new SecurityBaselineError("integrity_mismatch", "Security baseline integrity digest does not match its content");
  }
  validateBaselineAgainstPolicy(document, policy);
  return document;
}

export async function loadSecurityBaselineFile(
  workspaceRoot: string,
  baselinePath: string,
  policy: SecurityPolicyFile
): Promise<SecurityBaselineFile> {
  const absolutePath = resolveWorkspaceFile(workspaceRoot, baselinePath, policy.baseline.default_path);
  const text = await fsp.readFile(absolutePath, "utf8");
  return parseSecurityBaselineFile(parseJsonDocument(text, "security baseline"), policy);
}

function identityFromFinding(finding: SecurityFindingV2): SecurityBaselineFindingIdentity {
  return {
    fingerprint: finding.fingerprint,
    fingerprint_version: finding.fingerprint_version,
    rule: finding.rule,
    rule_version: finding.rule_version,
    path: finding.path,
    evidence_kind: finding.evidence_kind,
    expression_kind: finding.expression_kind
  };
}

export function createSecurityBaselineEntry(
  finding: SecurityFindingV2,
  input: {
    entry_id?: string;
    disposition: SecurityBaselineDisposition;
    reason: string;
    owner: string;
    approved_at: string;
    expires_at?: string;
  },
  policy: SecurityPolicyFile
): SecurityBaselineEntry {
  if (isSecurityBaselineRuleForbidden(finding.rule, policy)) {
    throw new SecurityBaselineError("forbidden_rule", `Rule ${finding.rule} cannot be added to a security baseline`);
  }
  const identity = identityFromFinding(finding);
  const generatedEntryId = `baseline_${createHash("sha256")
    .update(`${finding.fingerprint}\u0000${input.owner}\u0000${input.approved_at}`, "utf8")
    .digest("hex")
    .slice(0, 20)}`;
  const entry = parseSchema(SecurityBaselineEntrySchema, {
    entry_id: input.entry_id ?? generatedEntryId,
    finding: identity,
    disposition: input.disposition,
    reason: input.reason,
    owner: input.owner,
    approved_at: input.approved_at,
    ...(input.expires_at ? { expires_at: input.expires_at } : {})
  }, "security baseline entry");
  if (!policy.baseline.allowed_dispositions.includes(entry.disposition)) {
    throw new SecurityBaselineError("disposition_forbidden", `Disposition ${entry.disposition} is not allowed by policy`);
  }
  return entry;
}

function identitiesMatch(left: SecurityBaselineFindingIdentity, right: SecurityBaselineFindingIdentity): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.fingerprint_version === right.fingerprint_version &&
    left.rule === right.rule &&
    left.rule_version === right.rule_version &&
    left.path === right.path &&
    left.evidence_kind === right.evidence_kind &&
    left.expression_kind === right.expression_kind
  );
}

function entryIsExpired(entry: SecurityBaselineEntry, now: Date): boolean {
  if (entry.disposition !== "accepted_risk" || !entry.expires_at) return false;
  return new Date(entry.expires_at).getTime() <= now.getTime();
}

export interface SecurityBaselineApplicationSummary {
  baseline_id: string;
  policy_id: string;
  matched: number;
  stale: number;
  expired: number;
  new: number;
  suppressed: number;
  unmatched_entries: number;
}

export interface SecurityBaselineApplication {
  findings: SecurityFindingV2[];
  summary: SecurityBaselineApplicationSummary;
}

export function applySecurityBaseline(
  findings: SecurityFindingV2[],
  baseline: SecurityBaselineFile,
  policy: SecurityPolicyFile,
  now = new Date()
): SecurityBaselineApplication {
  const verifiedBaseline = parseSecurityBaselineFile(baseline, policy);
  const relatedEntryIds = new Set<string>();
  const counts: Record<Exclude<SecurityBaselineStatus, "untracked">, number> = {
    new: 0,
    matched: 0,
    stale: 0,
    expired: 0
  };

  const evaluated = findings.map((finding) => {
    const identity = identityFromFinding(finding);
    const exact = verifiedBaseline.entries.find((entry) => identitiesMatch(entry.finding, identity));
    if (exact) {
      relatedEntryIds.add(exact.entry_id);
      const baselineStatus: SecurityBaselineStatus = entryIsExpired(exact, now) ? "expired" : "matched";
      counts[baselineStatus] += 1;
      return {
        ...finding,
        disposition: exact.disposition as SecurityDisposition,
        baseline_status: baselineStatus
      };
    }

    const related = verifiedBaseline.entries.find((entry) => (
      entry.finding.rule === finding.rule && entry.finding.path === finding.path
    ));
    if (related) {
      relatedEntryIds.add(related.entry_id);
      counts.stale += 1;
      return {
        ...finding,
        disposition: related.disposition as SecurityDisposition,
        baseline_status: "stale" as const
      };
    }

    counts.new += 1;
    return {
      ...finding,
      disposition: "unreviewed" as const,
      baseline_status: "new" as const
    };
  });

  return {
    findings: evaluated,
    summary: {
      baseline_id: verifiedBaseline.baseline_id,
      policy_id: policy.policy_id,
      matched: counts.matched,
      stale: counts.stale,
      expired: counts.expired,
      new: counts.new,
      suppressed: counts.matched,
      unmatched_entries: Math.max(0, verifiedBaseline.entries.length - relatedEntryIds.size)
    }
  };
}

export interface SecurityBaselineProposalEntry {
  finding: SecurityBaselineFindingIdentity;
  category: string;
  confidence: string;
  eligibility: "eligible" | "forbidden";
  blocked_reason?: "forbidden_rule";
  manual_fields_required: readonly string[];
}

export interface SecurityBaselineProposal {
  kind: "codexpro_security_baseline_proposal";
  schema_version: typeof SECURITY_BASELINE_PROPOSAL_SCHEMA_VERSION;
  proposal_id: string;
  generated_at: string;
  policy_id: string;
  policy_version: string;
  manual_approval_required: true;
  entries: SecurityBaselineProposalEntry[];
  text: string;
}

function renderSecurityBaselineProposalReport(proposal: Omit<SecurityBaselineProposal, "text">): string {
  const lines = [
    "# Security Baseline Proposal",
    "",
    `Proposal: ${proposal.proposal_id}`,
    `Policy: ${proposal.policy_id}@${proposal.policy_version}`,
    "Approval: manual approval is required; this proposal is not a baseline file.",
    "Values: matched values are never stored or printed.",
    "",
    "## Candidates",
    ""
  ];
  if (!proposal.entries.length) lines.push("- none");
  for (const entry of proposal.entries) {
    lines.push(`- ${entry.eligibility.toUpperCase()} ${entry.finding.rule} ${entry.finding.path} fingerprint=${entry.finding.fingerprint}`);
  }
  return lines.join("\n");
}

export function createSecurityBaselineProposal(
  findings: SecurityFindingV2[],
  policy: SecurityPolicyFile,
  generatedAt = new Date().toISOString()
): SecurityBaselineProposal {
  const entries = findings.map((finding): SecurityBaselineProposalEntry => {
    const forbidden = isSecurityBaselineRuleForbidden(finding.rule, policy);
    return {
      finding: identityFromFinding(finding),
      category: finding.category,
      confidence: finding.confidence,
      eligibility: forbidden ? "forbidden" : "eligible",
      ...(forbidden ? { blocked_reason: "forbidden_rule" as const } : {}),
      manual_fields_required: forbidden
        ? []
        : ["disposition", "reason", "owner", "approved_at", "expires_at_for_accepted_risk"]
    };
  });
  const proposalId = `proposal_${createHash("sha256")
    .update(canonicalJson({ generated_at: generatedAt, policy_id: policy.policy_id, entries: entries.map((entry) => entry.finding) }), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
  const data: Omit<SecurityBaselineProposal, "text"> = {
    kind: "codexpro_security_baseline_proposal",
    schema_version: SECURITY_BASELINE_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposalId,
    generated_at: generatedAt,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    manual_approval_required: true,
    entries
  };
  return { ...data, text: renderSecurityBaselineProposalReport(data) };
}

export interface SecurityBaselineDiffEntrySummary {
  entry_id: string;
  rule: string;
  path: string;
}

export interface SecurityBaselineChangedEntrySummary extends SecurityBaselineDiffEntrySummary {
  changed_fields: string[];
}

export interface SecurityBaselineDiffSummary {
  before_baseline_id: string;
  after_baseline_id: string;
  added: SecurityBaselineDiffEntrySummary[];
  removed: SecurityBaselineDiffEntrySummary[];
  changed: SecurityBaselineChangedEntrySummary[];
  unchanged: number;
  text: string;
}

function entrySummary(entry: SecurityBaselineEntry): SecurityBaselineDiffEntrySummary {
  return {
    entry_id: entry.entry_id,
    rule: entry.finding.rule,
    path: entry.finding.path
  };
}

function changedEntryFields(before: SecurityBaselineEntry, after: SecurityBaselineEntry): string[] {
  const fields: Array<[string, unknown, unknown]> = [
    ["finding.fingerprint", before.finding.fingerprint, after.finding.fingerprint],
    ["finding.fingerprint_version", before.finding.fingerprint_version, after.finding.fingerprint_version],
    ["finding.rule", before.finding.rule, after.finding.rule],
    ["finding.rule_version", before.finding.rule_version, after.finding.rule_version],
    ["finding.path", before.finding.path, after.finding.path],
    ["finding.evidence_kind", before.finding.evidence_kind, after.finding.evidence_kind],
    ["finding.expression_kind", before.finding.expression_kind, after.finding.expression_kind],
    ["disposition", before.disposition, after.disposition],
    ["reason", before.reason, after.reason],
    ["owner", before.owner, after.owner],
    ["approved_at", before.approved_at, after.approved_at],
    ["expires_at", before.expires_at, after.expires_at]
  ];
  return fields.filter(([, left, right]) => left !== right).map(([field]) => field);
}

function renderSecurityBaselineDiff(summary: Omit<SecurityBaselineDiffSummary, "text">): string {
  const lines = [
    "# Security Baseline Diff",
    "",
    `Before: ${summary.before_baseline_id}`,
    `After: ${summary.after_baseline_id}`,
    `Added: ${summary.added.length}`,
    `Removed: ${summary.removed.length}`,
    `Changed: ${summary.changed.length}`,
    `Unchanged: ${summary.unchanged}`,
    "Values: matched values and field contents are never printed."
  ];
  for (const entry of summary.added) lines.push(`- ADDED ${entry.entry_id} ${entry.rule} ${entry.path}`);
  for (const entry of summary.removed) lines.push(`- REMOVED ${entry.entry_id} ${entry.rule} ${entry.path}`);
  for (const entry of summary.changed) lines.push(`- CHANGED ${entry.entry_id} ${entry.rule} ${entry.path} fields=${entry.changed_fields.join(",")}`);
  return lines.join("\n");
}

export function summarizeSecurityBaselineDiff(
  before: SecurityBaselineFile,
  after: SecurityBaselineFile
): SecurityBaselineDiffSummary {
  const beforeById = new Map(before.entries.map((entry) => [entry.entry_id, entry]));
  const afterById = new Map(after.entries.map((entry) => [entry.entry_id, entry]));
  const added: SecurityBaselineDiffEntrySummary[] = [];
  const removed: SecurityBaselineDiffEntrySummary[] = [];
  const changed: SecurityBaselineChangedEntrySummary[] = [];
  let unchanged = 0;

  for (const [entryId, entry] of afterById) {
    const previous = beforeById.get(entryId);
    if (!previous) {
      added.push(entrySummary(entry));
      continue;
    }
    const changedFields = changedEntryFields(previous, entry);
    if (changedFields.length) changed.push({ ...entrySummary(entry), changed_fields: changedFields });
    else unchanged += 1;
  }
  for (const [entryId, entry] of beforeById) {
    if (!afterById.has(entryId)) removed.push(entrySummary(entry));
  }

  const data: Omit<SecurityBaselineDiffSummary, "text"> = {
    before_baseline_id: before.baseline_id,
    after_baseline_id: after.baseline_id,
    added,
    removed,
    changed,
    unchanged
  };
  return { ...data, text: renderSecurityBaselineDiff(data) };
}
