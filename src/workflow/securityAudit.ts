import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import {
  SECRET_RULE_METADATA,
  SENSITIVE_ASSIGNMENT_PREFIX_SOURCE,
  SENSITIVE_ASSIGNMENT_RULE_METADATA,
  SENSITIVE_IDENTIFIER_PATTERN_SOURCE,
  createSecretPatternRules,
  findSensitiveAssignmentCandidates,
  isControlledSyntheticTestVector,
  isPlaceholderSecretValue,
  isPlausibleSecretLiteral,
  isSecurityTestOrFixturePath
} from "../../shared/security-rule-metadata.mjs";
import type { CodexProConfig } from "../config.js";
import { CodexProError, displayPath, isSubpath, normalizeRelPath, type PathGuard, type Workspace } from "../guard.js";
import {
  applySecurityBaseline,
  loadSecurityBaselineFile,
  loadSecurityPolicyFile,
  type SecurityBaselineApplicationSummary
} from "./securityBaseline.js";
import {
  BoundedContentHashCache,
  type SecurityCacheSnapshot
} from "./securityScanCache.js";

export const SECURITY_FINDING_SCHEMA_VERSION = 2 as const;
export const SECURITY_RULE_SET_VERSION = "3.0.0";
export const SECURITY_FINGERPRINT_VERSION = "1";

export type SecuritySeverity = "info" | "warn" | "error";
export type SecurityCategory = "secret" | "command" | "docker" | "sql" | "large_file" | "debug" | "scan";
export type SecurityFileRole = "runtime_entry" | "production_source" | "execution_script" | "test_fixture" | "documentation" | "scanner_definition" | "configuration" | "unknown";
export type SecurityEvidenceKind =
  | "literal"
  | "path"
  | "command"
  | "sql"
  | "console"
  | "configuration"
  | "syntax"
  | "scan_metadata"
  | "controlled_test_vector"
  | "rule_definition"
  | "static_text"
  | "execution_sink"
  | "database_sink";
export type SecurityExpressionKind =
  | "path_presence"
  | "double_quoted_literal"
  | "single_quoted_literal"
  | "template_literal"
  | "concatenation"
  | "call_expression"
  | "reference"
  | "command_text"
  | "sql_text"
  | "console_call"
  | "pattern";
export type SecurityConfidence = "low" | "medium" | "high";
export type SecurityDisposition = "unreviewed" | "accepted_risk" | "false_positive" | "remediated";
export type SecurityBaselineStatus = "untracked" | "new" | "matched" | "stale" | "expired";

export interface SecurityFinding {
  severity: SecuritySeverity;
  category: SecurityCategory;
  rule: string;
  path: string;
  line?: number;
  column?: number;
  message: string;
}

export interface SecurityFindingV2 extends SecurityFinding {
  schema_version: typeof SECURITY_FINDING_SCHEMA_VERSION;
  rule_version: string;
  file_role: SecurityFileRole;
  evidence_kind: SecurityEvidenceKind;
  expression_kind: SecurityExpressionKind;
  confidence: SecurityConfidence;
  disposition: SecurityDisposition;
  baseline_status: SecurityBaselineStatus;
  fingerprint_version: string;
  fingerprint: string;
}

export interface SecurityScanOptions {
  path?: string;
  max_files?: number;
  max_file_bytes?: number;
  large_file_bytes?: number;
  include_generated?: boolean;
  fail_on_warnings?: boolean;
  policy_path?: string;
  baseline_path?: string;
  cache_enabled?: boolean;
}

export interface SecurityScanCacheSummary {
  enabled: boolean;
  generation: string;
  hits: number;
  misses: number;
  joined: number;
  stores: number;
  evictions: number;
  entries: number;
  bytes: number;
  max_entries: number;
  max_bytes: number;
}

export interface SecurityScanResult {
  ok: boolean;
  status: "pass" | "warn" | "fail";
  scan_type: "secret_scan" | "security_audit" | "release_safety_check";
  schema_version: typeof SECURITY_FINDING_SCHEMA_VERSION;
  rule_set_version: string;
  root: string;
  target_path: string;
  scanned_files: number;
  skipped_files: number;
  unread_sensitive_files: number;
  truncated: boolean;
  scan_truncated: boolean;
  findings_truncated: boolean;
  scan_complete: boolean;
  counts: Record<SecuritySeverity, number>;
  category_counts: Record<SecurityCategory, number>;
  effective_counts: Record<SecuritySeverity, number>;
  effective_category_counts: Record<SecurityCategory, number>;
  baseline?: SecurityBaselineApplicationSummary;
  cache?: SecurityScanCacheSummary;
  findings: SecurityFindingV2[];
  text: string;
}

interface InternalScanOptions extends SecurityScanOptions {
  scanType: SecurityScanResult["scan_type"];
  includeAuditRules: boolean;
}

interface TextFileCandidate {
  absPath: string;
  relPath: string;
  size: number;
}

interface CachedFileAnalysis {
  findings: SecurityFindingV2[];
  findingsTruncated: boolean;
}

interface ScanState {
  scanType: SecurityScanResult["scan_type"];
  findings: SecurityFindingV2[];
  seenFingerprints: Set<string>;
  scannedFiles: number;
  skippedFiles: number;
  unreadSensitiveFiles: number;
  scanTruncated: boolean;
  findingsTruncated: boolean;
  cacheHits: number;
  cacheMisses: number;
  cacheJoined: number;
  cacheStores: number;
  cacheEvictions: number;
}

interface LineRule {
  category: SecurityCategory;
  rule: string;
  severity: SecuritySeverity;
  pattern: RegExp;
  message: string;
  placeholderAware?: boolean;
  pathFilter?: (relPath: string) => boolean;
}

interface FindingEvidenceContext {
  lineText?: string;
  matchText?: string;
  matchIndex?: number;
  occurrence?: number;
  expressionKind?: SecurityExpressionKind;
  evidenceKind?: SecurityEvidenceKind;
}

interface LineSemanticDecision {
  matchText?: string;
  matchIndex?: number;
  severity?: SecuritySeverity;
  message?: string;
  expressionKind?: SecurityExpressionKind;
  evidenceKind?: SecurityEvidenceKind;
}

const DEFAULT_MAX_FILES = 4_000;
const DEFAULT_MAX_FILE_BYTES = 256_000;
const DEFAULT_LARGE_FILE_BYTES = 1_000_000;
const MAX_FINDINGS = 500;
const SECURITY_SCAN_CACHE_MAX_ENTRIES = 4_096;
const SECURITY_SCAN_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const SECURITY_RULE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(SECRET_RULE_METADATA.map((metadata) => [metadata.rule, metadata.version])),
  [SENSITIVE_ASSIGNMENT_RULE_METADATA.rule]: SENSITIVE_ASSIGNMENT_RULE_METADATA.version,
  sensitive_console_output: "2",
  debugger_statement: "1",
  debug_flag_true: "1",
  dangerous_rm_rf_root: "2",
  curl_pipe_shell: "2",
  chmod_world_writable: "2",
  disk_destructive_command: "2",
  docker_socket_mount: "2",
  docker_root_bind_mount: "2",
  docker_home_bind_mount: "2",
  sql_write_operation: "2",
  symlink_skipped: "1",
  sensitive_file_path: "1",
  large_file: "1"
});

const SECURITY_SCAN_CACHE_GENERATION = `sha256:${createHash("sha256")
  .update(JSON.stringify({
    finding_schema: SECURITY_FINDING_SCHEMA_VERSION,
    fingerprint_version: SECURITY_FINGERPRINT_VERSION,
    rule_set_version: SECURITY_RULE_SET_VERSION,
    rule_versions: Object.entries(SECURITY_RULE_VERSIONS).sort(([left], [right]) => left.localeCompare(right))
  }), "utf8")
  .digest("hex")}`;

function cloneCachedFileAnalysis(value: CachedFileAnalysis): CachedFileAnalysis {
  return {
    findings: value.findings.map((finding) => ({ ...finding })),
    findingsTruncated: value.findingsTruncated
  };
}

const SECURITY_FILE_SCAN_CACHE = new BoundedContentHashCache<CachedFileAnalysis>({
  maxEntries: SECURITY_SCAN_CACHE_MAX_ENTRIES,
  maxBytes: SECURITY_SCAN_CACHE_MAX_BYTES,
  estimateSize: (value, key) => Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(value), "utf8"),
  cloneValue: cloneCachedFileAnalysis
});

export function resetSecurityScanCache(): void {
  SECURITY_FILE_SCAN_CACHE.reset();
}

export function getSecurityScanCacheSnapshot(): SecurityCacheSnapshot {
  return SECURITY_FILE_SCAN_CACHE.snapshot();
}

const HIGH_CONFIDENCE_RULES = new Set([
  "private_key_block",
  "openai_api_key",
  "github_token",
  "npm_token",
  "aws_access_key_id",
  "google_api_key",
  "bearer_token_literal",
  "database_url_credentials",
  "secret_assignment_literal",
  "sensitive_file_path",
  "dangerous_rm_rf_root",
  "disk_destructive_command"
]);

const LOW_CONFIDENCE_RULES = new Set(["sensitive_console_output", "debugger_statement", "debug_flag_true", "symlink_skipped"]);
const RUNTIME_ENTRY_PATHS = new Set([
  "src/http.ts",
  "src/stdio.ts",
  "src/index.ts",
  "src/main.ts",
  "src/server.ts",
  "scripts/codexpro-cli.mjs"
]);
const SCANNER_DEFINITION_PATHS = new Set([
  "src/workflow/securityaudit.ts",
  "src/redact.ts",
  "shared/redaction.mjs",
  "shared/security-rule-metadata.mjs"
]);
const GENERATED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache"
]);

const TEXT_DOTFILE_BASENAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".npmignore"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const SECRET_LINE_RULES: LineRule[] = [
  ...createSecretPatternRules("audit").map((metadata) => ({
    category: "secret" as const,
    rule: metadata.rule,
    severity: metadata.severity,
    pattern: metadata.pattern,
    message: metadata.message,
    placeholderAware: metadata.rule !== "private_key_block"
  })),
  {
    category: "secret",
    rule: SENSITIVE_ASSIGNMENT_RULE_METADATA.rule,
    severity: SENSITIVE_ASSIGNMENT_RULE_METADATA.severity,
    pattern: new RegExp(SENSITIVE_ASSIGNMENT_PREFIX_SOURCE, "gi"),
    message: SENSITIVE_ASSIGNMENT_RULE_METADATA.message,
    placeholderAware: true
  },
  {
    category: "secret",
    rule: "sensitive_console_output",
    severity: "warn",
    pattern: /\bconsole\.(?:log|debug|info|warn|error)\s*\(/gi,
    message: "console output exposes a sensitive value"
  }
];

const AUDIT_LINE_RULES: LineRule[] = [
  {
    category: "debug",
    rule: "debugger_statement",
    severity: "warn",
    pattern: /\bdebugger\b/,
    message: "debugger statement detected"
  },
  {
    category: "debug",
    rule: "debug_flag_true",
    severity: "warn",
    pattern: /\bDEBUG\s*=\s*(?:true|1|yes|on)\b/i,
    message: "debug flag appears enabled"
  },
  {
    category: "command",
    rule: "dangerous_rm_rf_root",
    severity: "error",
    pattern: /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|\$\{?\w+\}?\/?)(?:\s|$)/,
    message: "dangerous recursive delete command pattern detected"
  },
  {
    category: "command",
    rule: "curl_pipe_shell",
    severity: "warn",
    pattern: /\b(?:curl|wget)\b[^\r\n|]*(?:\||\$\()\s*(?:sudo\s+)?(?:sh|bash)\b/i,
    message: "network download piped to shell detected"
  },
  {
    category: "command",
    rule: "chmod_world_writable",
    severity: "warn",
    pattern: /\bchmod\s+(?:-[A-Za-z]+\s+)*777\b/,
    message: "world-writable chmod pattern detected"
  },
  {
    category: "command",
    rule: "disk_destructive_command",
    severity: "error",
    pattern: /\b(?:mkfs(?:\.\w+)?|dd\s+if=|wipefs\b|shred\b)/i,
    message: "destructive disk command pattern detected"
  },
  {
    category: "docker",
    rule: "docker_socket_mount",
    severity: "warn",
    pattern: /\/var\/run\/docker\.sock/i,
    message: "Docker socket mount/reference detected"
  },
  {
    category: "docker",
    rule: "docker_root_bind_mount",
    severity: "warn",
    pattern: /\bdocker\s+run\b[^\r\n]*(?:-v|--volume)\s+(?:\/|['"]\/):/i,
    message: "Docker bind mount from host root detected"
  },
  {
    category: "docker",
    rule: "docker_home_bind_mount",
    severity: "warn",
    pattern: /\b(?:-v|--volume)\s+(?:~|\$HOME|\/home\/[^:\s]+|\/Users\/[^:\s]+):/i,
    message: "Docker bind mount from user home detected"
  },
  {
    category: "sql",
    rule: "sql_write_operation",
    severity: "warn",
    pattern: /\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|INDEX|VIEW)|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(?:TABLE|DATABASE|INDEX|USER)|GRANT\s+|REVOKE\s+)/i,
    message: "SQL write/DDL operation pattern detected",
    pathFilter: (relPath) => /\.(?:sql|ts|tsx|js|jsx|mjs|cjs|py|php|md)$/i.test(relPath)
  }
];

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeScanPath(input: unknown): string {
  const raw = String(input ?? ".").trim() || ".";
  return raw.replaceAll("\\", "/");
}

function resolveScanRoot(workspace: Workspace, input: unknown): { absPath: string; relPath: string } {
  const requested = normalizeScanPath(input);
  const candidate = path.isAbsolute(requested) ? requested : path.join(workspace.root, requested);
  const absPath = path.resolve(candidate);
  if (!isSubpath(absPath, workspace.root)) {
    throw new CodexProError(`Scan path escapes workspace root: ${requested}`);
  }
  const relPath = displayPath(absPath, workspace.root);
  return { absPath, relPath };
}

function isGeneratedDir(relPath: string, config: CodexProConfig): boolean {
  const normalized = normalizeRelPath(relPath).replace(/^\.\//, "");
  const base = path.posix.basename(normalized);
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  if (GENERATED_DIR_NAMES.has(base)) return true;
  if (normalized === contextDir || normalized.startsWith(`${contextDir}/`)) return true;
  if (normalized === ".codexpro/runs" || normalized.startsWith(".codexpro/runs/")) return true;
  return false;
}

function isConfigBlocked(relPath: string, config: CodexProConfig): boolean {
  const normalized = normalizeRelPath(relPath).replace(/^\.\//, "");
  return config.blockedGlobs.some((glob) =>
    minimatch(normalized, glob, { dot: true, nocase: false, matchBase: false }) ||
    minimatch(path.posix.basename(normalized), glob, { dot: true, nocase: false, matchBase: true })
  );
}

function isSensitivePath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath).replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    base === "id_rsa" ||
    base.startsWith("id_rsa.") ||
    base === "id_ed25519" ||
    base.startsWith("id_ed25519.") ||
    lower.includes("/.ssh/") ||
    lower === ".ssh"
  );
}

function isProbablyTextPath(relPath: string): boolean {
  const base = path.posix.basename(relPath).toLowerCase();
  if (TEXT_DOTFILE_BASENAMES.has(base)) return true;
  if (["dockerfile", "makefile", "gemfile", "rakefile", "procfile"].includes(base)) return true;
  if (base.endsWith("rc") || base.includes("config")) return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(base));
}

function normalizeSecurityPath(relPath: string): string {
  return normalizeRelPath(relPath).replace(/^\.\//, "").toLowerCase();
}

function isDocumentationPath(relPath: string): boolean {
  const rel = normalizeSecurityPath(relPath);
  const extension = path.posix.extname(rel);
  return rel.startsWith("docs/") || rel.startsWith("planning-local/") || [".md", ".mdx", ".rst", ".adoc"].includes(extension);
}

function isFixturePath(relPath: string): boolean {
  return isSecurityTestOrFixturePath(normalizeSecurityPath(relPath));
}

function isScannerImplementationPath(relPath: string): boolean {
  return SCANNER_DEFINITION_PATHS.has(normalizeSecurityPath(relPath));
}

function isRuntimeEntryPath(relPath: string): boolean {
  return RUNTIME_ENTRY_PATHS.has(normalizeSecurityPath(relPath));
}

function isExecutionScriptPath(relPath: string): boolean {
  const rel = normalizeSecurityPath(relPath);
  const base = path.posix.basename(rel);
  return rel.startsWith("scripts/") || rel.endsWith(".sh") || rel.endsWith(".ps1") || base === "dockerfile" || base === "makefile";
}

function isLocalMemoryIndexImplementationPath(relPath: string): boolean {
  return normalizeSecurityPath(relPath) === "src/project/memoryindex.ts";
}

export function classifySecurityFileRole(relPath: string): SecurityFileRole {
  const rel = normalizeSecurityPath(relPath);
  const base = path.posix.basename(rel);
  if (isScannerImplementationPath(rel)) return "scanner_definition";
  if (isDocumentationPath(rel)) return "documentation";
  if (isFixturePath(rel)) return "test_fixture";
  if (isRuntimeEntryPath(rel)) return "runtime_entry";
  if (isExecutionScriptPath(rel)) return "execution_script";
  if (/^(?:config|settings|tsconfig|package|docker-compose|compose)(?:\.|$)/.test(base) || /\.(?:env|ya?ml|json)$/.test(base)) return "configuration";
  if (rel.startsWith("src/") || rel.startsWith("shared/") || rel.startsWith("chrome-extension/") || rel.startsWith("browser-skills-builtin/")) {
    return "production_source";
  }
  return "unknown";
}

function isScannerRuleDefinitionMatch(relPath: string, lineText: string): boolean {
  if (!isScannerImplementationPath(relPath)) return false;
  const line = lineText.trim();
  const sourceField = /\bsource\s*:/i.test(line);
  const hasRegexStructure = line.includes("String.raw")
    || line.includes("\\b")
    || line.includes("(?:")
    || /\[[^\]]{2,}\]/.test(line)
    || /\{\d+(?:,\d*)?\}/.test(line);
  return (
    /\bpattern\s*:\s*\//i.test(line) ||
    (sourceField && hasRegexStructure) ||
    /\b[A-Za-z0-9_]*(?:PATTERN|RULES?)\b\s*=\s*\//i.test(line) ||
    /\bnew\s+RegExp\s*\(/i.test(line)
  );
}

function isInsideQuotedText(line: string, index: number): boolean {
  let quote = "";
  let escaped = false;
  for (let cursor = 0; cursor < Math.min(index, line.length); cursor += 1) {
    const character = line[cursor] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
  }
  return Boolean(quote);
}

function consoleCallContainsSensitiveValue(line: string, callIndex: number): boolean {
  const openIndex = line.indexOf("(", callIndex);
  if (openIndex < 0) return false;
  const argumentsText = line.slice(openIndex + 1);
  const templateExpressions = [...argumentsText.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1] ?? "").join(" ");
  const unquoted = argumentsText
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ");
  const sensitiveReference = new RegExp(SENSITIVE_IDENTIFIER_PATTERN_SOURCE, "i");
  const sensitiveObjectKey = new RegExp(`["']?${SENSITIVE_IDENTIFIER_PATTERN_SOURCE}["']?\\s*:`, "i");
  const objectLiteralText = argumentsText.includes("{") ? argumentsText : "";
  return sensitiveReference.test(`${unquoted} ${templateExpressions}`) || sensitiveObjectKey.test(objectLiteralText);
}

function isShellExecutionPath(relPath: string): boolean {
  const normalized = normalizeSecurityPath(relPath);
  const base = path.posix.basename(normalized);
  return /\.(?:sh|bash|zsh|fish|ps1|cmd|bat)$/.test(base) || base === "makefile";
}

function isCommandExecutionSink(relPath: string, line: string, matchIndex: number): boolean {
  const prefix = line.slice(0, matchIndex);
  const callPatterns = [
    /(?:child_process\.)?(?:exec|execSync|spawn|spawnSync)\s*\([^)]*$/i,
    /(?:execa|execaCommand|shell\.exec)\s*\([^)]*$/i,
    /(?:subprocess\.(?:run|call|Popen)|os\.system)\s*\([^)]*$/i
  ];
  for (const pattern of callPatterns) {
    const call = prefix.match(pattern);
    if (call?.index !== undefined && !isInsideQuotedText(line, call.index)) return true;
  }
  if (/(?:^|\s)\$\s*`[^`]*$/i.test(prefix)) return true;
  if (isInsideQuotedText(line, matchIndex)) return false;
  const trimmed = line.trim();
  return isShellExecutionPath(relPath) && !/^\s*(?:#|\/\/|echo\b|printf\b)/i.test(trimmed);
}

function isDockerConfigurationPath(relPath: string): boolean {
  const normalized = normalizeSecurityPath(relPath);
  const base = path.posix.basename(normalized);
  return base === "dockerfile" || /^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/.test(base);
}

function isDatabaseExecutionSink(relPath: string, line: string, matchIndex: number): boolean {
  if (/\.sql$/i.test(relPath)) return true;
  const prefix = line.slice(0, matchIndex);
  const call = prefix.match(/(?:\$queryRaw|\$executeRaw|sequelize\.query|knex\.raw|db\.(?:query|execute|exec|run|prepare)|\.(?:query|execute|exec|run|prepare|raw))\s*\([^)]*$/i);
  if (call?.index !== undefined && !isInsideQuotedText(line, call.index)) return true;
  return false;
}

function semanticDecisionForMatch(rule: LineRule, relPath: string, line: string, match: RegExpExecArray): LineSemanticDecision | undefined {
  if (isScannerRuleDefinitionMatch(relPath, line)) {
    return { severity: "info", evidenceKind: "rule_definition" };
  }

  if (rule.rule === SENSITIVE_ASSIGNMENT_RULE_METADATA.rule) {
    const candidate = findSensitiveAssignmentCandidates(line).find((item) => item.start === match.index);
    if (!candidate || candidate.kind !== "literal" || !isPlausibleSecretLiteral(candidate.literalValue, candidate.name)) return undefined;
    if (isPlaceholderSecretValue(candidate.raw)) return undefined;
    return {
      matchText: candidate.raw,
      matchIndex: candidate.start,
      expressionKind: candidate.expressionKind as SecurityExpressionKind
    };
  }

  if (rule.rule === "sensitive_console_output") {
    if (isInsideQuotedText(line, match.index) || !consoleCallContainsSensitiveValue(line, match.index)) return undefined;
    return { evidenceKind: "console", expressionKind: "console_call" };
  }

  if (rule.category === "command") {
    if (isCommandExecutionSink(relPath, line, match.index)) return { evidenceKind: "execution_sink" };
    return {
      severity: "info",
      evidenceKind: "static_text",
      message: `${rule.message}; static command text outside an execution sink`
    };
  }

  if (rule.category === "docker") {
    if (isDockerConfigurationPath(relPath)) return { evidenceKind: "configuration" };
    if (isCommandExecutionSink(relPath, line, match.index)) return { evidenceKind: "execution_sink" };
    return {
      severity: "info",
      evidenceKind: "static_text",
      message: `${rule.message}; Docker example or static reference`
    };
  }

  if (rule.category === "sql") {
    if (isDatabaseExecutionSink(relPath, line, match.index)) return { evidenceKind: "database_sink" };
    return {
      severity: "info",
      evidenceKind: "static_text",
      message: `${rule.message}; SQL text outside a database execution sink`
    };
  }

  return {};
}

function evidenceKindForFinding(finding: SecurityFinding): SecurityEvidenceKind {
  if (finding.rule === "sensitive_file_path") return "path";
  if (finding.rule === "sensitive_console_output") return "console";
  if (finding.rule === "symlink_skipped" || finding.rule === "large_file") return "scan_metadata";
  if (finding.category === "command") return "command";
  if (finding.category === "docker") return "configuration";
  if (finding.category === "sql") return "sql";
  if (finding.category === "debug") return "syntax";
  if (finding.category === "secret") return "literal";
  return "scan_metadata";
}

function confidenceForRule(rule: string): SecurityConfidence {
  if (HIGH_CONFIDENCE_RULES.has(rule)) return "high";
  if (LOW_CONFIDENCE_RULES.has(rule)) return "low";
  return "medium";
}

function expressionKindForEvidence(
  finding: SecurityFinding,
  lineText = "",
  matchText = "",
  matchIndex = 0
): SecurityExpressionKind {
  if (finding.rule === "sensitive_file_path") return "path_presence";
  if (finding.category === "command") return "command_text";
  if (finding.category === "sql") return "sql_text";
  if (finding.rule === "sensitive_console_output") return "console_call";

  const assignmentMatch = matchText.match(/^[\s\S]*?[:=]\s*([\s\S]*)$/);
  const rhs = assignmentMatch?.[1]?.trim() ?? "";
  if (rhs.includes("+") && /["'`]/.test(rhs)) return "concatenation";
  if (rhs.startsWith('"')) return "double_quoted_literal";
  if (rhs.startsWith("'")) return "single_quoted_literal";
  if (rhs.startsWith("`")) return "template_literal";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/.test(rhs)) return "call_expression";
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(rhs)) return "reference";

  const before = lineText[matchIndex - 1] ?? "";
  if (before === '"') return "double_quoted_literal";
  if (before === "'") return "single_quoted_literal";
  if (before === "`") return "template_literal";
  const localWindow = lineText.slice(Math.max(0, matchIndex - 80), Math.min(lineText.length, matchIndex + matchText.length + 80));
  if (localWindow.includes("+") && /["'`]/.test(localWindow)) return "concatenation";
  return "pattern";
}

function canonicalizeEvidence(
  finding: SecurityFinding,
  lineText: string,
  matchText: string,
  expressionKind: SecurityExpressionKind
): string {
  if (!lineText) return `${finding.category}:${finding.rule}:${expressionKind}`;
  if (finding.rule === "secret_assignment_literal") {
    const assignment = matchText.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*([:=])/);
    return assignment ? `${assignment[1]}${assignment[2]}<${expressionKind}>` : `assignment:<${expressionKind}>`;
  }

  let normalized = lineText.normalize("NFKC");
  if (matchText) normalized = normalized.split(matchText).join("<match>");
  normalized = normalized
    .replace(/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi, "<private-key>")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<credential>")
    .replace(/\b(?:gh[opsru]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, "<credential>")
    .replace(/\bnpm_[A-Za-z0-9_-]{20,}\b/g, "<credential>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<credential>")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "<credential>")
    .replace(/`(?:\\.|[^`])*`/g, "`<template>`")
    .replace(/"(?:\\.|[^"\\])*"/g, '"<string>"')
    .replace(/'(?:\\.|[^'\\])*'/g, "'<string>'")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([=,:;(){}\[\]+])\s*/g, "$1");
  return normalized || `${finding.category}:${finding.rule}:${expressionKind}`;
}

function buildFindingFingerprint(
  finding: SecurityFinding,
  ruleVersion: string,
  evidenceKind: SecurityEvidenceKind,
  expressionKind: SecurityExpressionKind,
  canonicalEvidence: string,
  occurrence: number
): string {
  const identity = JSON.stringify({
    fingerprint_version: SECURITY_FINGERPRINT_VERSION,
    rule: finding.rule,
    rule_version: ruleVersion,
    path: normalizeRelPath(finding.path).replace(/^\.\//, ""),
    evidence_kind: evidenceKind,
    expression_kind: expressionKind,
    canonical_evidence: canonicalEvidence,
    occurrence
  });
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function enrichFinding(finding: SecurityFinding, context: FindingEvidenceContext = {}): SecurityFindingV2 {
  const ruleVersion = SECURITY_RULE_VERSIONS[finding.rule] ?? "1";
  const evidenceKind = context.evidenceKind ?? evidenceKindForFinding(finding);
  const expressionKind = context.expressionKind ?? expressionKindForEvidence(finding, context.lineText, context.matchText, context.matchIndex);
  const canonicalEvidence = canonicalizeEvidence(finding, context.lineText ?? "", context.matchText ?? "", expressionKind);
  const occurrence = Math.max(0, Math.floor(context.occurrence ?? 0));
  return {
    ...finding,
    schema_version: SECURITY_FINDING_SCHEMA_VERSION,
    rule_version: ruleVersion,
    file_role: classifySecurityFileRole(finding.path),
    evidence_kind: evidenceKind,
    expression_kind: expressionKind,
    confidence: confidenceForRule(finding.rule),
    disposition: "unreviewed",
    baseline_status: "untracked",
    fingerprint_version: SECURITY_FINGERPRINT_VERSION,
    fingerprint: buildFindingFingerprint(finding, ruleVersion, evidenceKind, expressionKind, canonicalEvidence, occurrence)
  };
}

function normalizeFindingForScan(state: ScanState, finding: SecurityFindingV2): SecurityFindingV2 | undefined {
  if (state.scanType !== "release_safety_check") return finding;
  if (finding.rule === "sql_write_operation" && isLocalMemoryIndexImplementationPath(finding.path)) return undefined;
  if (finding.evidence_kind === "controlled_test_vector") {
    return {
      ...finding,
      severity: "info",
      message: `${finding.message}; controlled synthetic test vector`
    };
  }
  if (
    finding.file_role === "scanner_definition"
    && (
      finding.evidence_kind === "rule_definition"
      || (
        finding.category === "debug"
        && (
          finding.expression_kind === "pattern"
          || finding.expression_kind === "double_quoted_literal"
          || finding.expression_kind === "single_quoted_literal"
        )
      )
    )
  ) {
    return {
      ...finding,
      severity: "info",
      message: `${finding.message}; scanner rule definition self-reference`
    };
  }
  if ((finding.file_role === "documentation" || finding.file_role === "test_fixture") && finding.severity === "error" && finding.confidence !== "high") {
    return {
      ...finding,
      severity: "warn",
      message: `${finding.message}; non-high-confidence documentation or test evidence`
    };
  }
  return finding;
}

function pushFinding(state: ScanState, finding: SecurityFinding, context: FindingEvidenceContext = {}): void {
  const normalizedFinding = normalizeFindingForScan(state, enrichFinding(finding, context));
  if (!normalizedFinding) return;
  if (state.seenFingerprints.has(normalizedFinding.fingerprint)) return;
  if (state.findings.length >= MAX_FINDINGS) {
    state.findingsTruncated = true;
    return;
  }
  state.seenFingerprints.add(normalizedFinding.fingerprint);
  state.findings.push(normalizedFinding);
}

function safeColumn(line: string, matchIndex: number): number {
  return Math.max(1, Math.min(line.length + 1, matchIndex + 1));
}

function isPlaceholderMatch(match: string): boolean {
  const normalized = match.toLowerCase();
  return (
    isPlaceholderSecretValue(match) ||
    normalized.includes("token=$(cat") ||
    normalized.includes("--cloudflare-token-file") ||
    normalized.includes("cloudflare-token-file") ||
    normalized.includes("optionvalue(") ||
    normalized.includes("stabletoken(") ||
    normalized.includes("preference.") ||
    normalized.includes("args.") ||
    normalized.includes("profile.") ||
    normalized.includes("data.") ||
    normalized.includes("resolveconfigpath(") ||
    normalized.includes("profilecloudflare") ||
    normalized.includes("cloudflaretokenfile") ||
    normalized.includes("tunnel_token") ||
    normalized.includes("textfield(")
  );
}

function analyzeLine(
  state: ScanState,
  relPath: string,
  line: string,
  previousLine: string,
  lineNumber: number,
  rules: LineRule[],
  occurrenceCounts: Map<string, number>
): void {
  for (const rule of rules) {
    if (rule.pathFilter && !rule.pathFilter(relPath)) continue;
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(line)) !== null) {
      const semantic = semanticDecisionForMatch(rule, relPath, line, match);
      if (!semantic) {
        if (!rule.pattern.global) break;
        continue;
      }
      const matchText = semantic.matchText ?? match[0];
      const matchIndex = semantic.matchIndex ?? match.index;
      const controlledTestVector = isControlledSyntheticTestVector({
        filePath: relPath,
        matchedText: matchText,
        currentLine: line,
        previousLine
      });
      if (rule.placeholderAware && isPlaceholderMatch(matchText)) {
        if (!rule.pattern.global) break;
        continue;
      }
      const baseFinding: SecurityFinding = {
        severity: controlledTestVector ? rule.severity : semantic.severity ?? rule.severity,
        category: rule.category,
        rule: rule.rule,
        path: relPath,
        line: lineNumber,
        column: safeColumn(line, matchIndex),
        message: semantic.message ?? rule.message
      };
      const expressionKind = semantic.expressionKind ?? expressionKindForEvidence(baseFinding, line, matchText, matchIndex);
      const evidenceKind: SecurityEvidenceKind = controlledTestVector
        ? "controlled_test_vector"
        : semantic.evidenceKind ?? evidenceKindForFinding(baseFinding);
      const canonicalEvidence = canonicalizeEvidence(baseFinding, line, matchText, expressionKind);
      const occurrenceKey = `${rule.rule}\u0000${evidenceKind}\u0000${expressionKind}\u0000${canonicalEvidence}`;
      const occurrence = occurrenceCounts.get(occurrenceKey) ?? 0;
      occurrenceCounts.set(occurrenceKey, occurrence + 1);
      pushFinding(state, baseFinding, {
        lineText: line,
        matchText,
        matchIndex,
        occurrence,
        expressionKind,
        evidenceKind
      });
      if (!rule.pattern.global) break;
    }
  }
}

async function collectCandidates(
  config: CodexProConfig,
  workspace: Workspace,
  scanRoot: { absPath: string; relPath: string },
  options: Required<Pick<InternalScanOptions, "max_files" | "max_file_bytes" | "large_file_bytes" | "include_generated">>,
  state: ScanState
): Promise<TextFileCandidate[]> {
  const candidates: TextFileCandidate[] = [];
  const stack = [scanRoot.absPath];
  while (stack.length) {
    const absPath = stack.pop();
    if (!absPath) continue;
    const relPath = displayPath(absPath, workspace.root);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(absPath);
    } catch {
      state.skippedFiles += 1;
      continue;
    }

    if (stat.isSymbolicLink()) {
      pushFinding(state, { severity: "warn", category: "scan", rule: "symlink_skipped", path: relPath, message: "symlink skipped during security scan" });
      state.skippedFiles += 1;
      continue;
    }

    if (isSensitivePath(relPath)) {
      pushFinding(state, {
        severity: "error",
        category: "secret",
        rule: "sensitive_file_path",
        path: relPath,
        message: "sensitive file path present; contents were not read"
      });
      state.unreadSensitiveFiles += 1;
      state.skippedFiles += 1;
      if (stat.isDirectory()) continue;
      continue;
    }

    if (stat.isDirectory()) {
      if (!options.include_generated && isGeneratedDir(relPath, config)) {
        state.skippedFiles += 1;
        continue;
      }
      let entries: string[];
      try {
        entries = await fsp.readdir(absPath);
      } catch {
        state.skippedFiles += 1;
        continue;
      }
      for (const entry of entries.reverse()) stack.push(path.join(absPath, entry));
      continue;
    }

    if (!stat.isFile()) {
      state.skippedFiles += 1;
      continue;
    }

    if (stat.size > options.large_file_bytes) {
      pushFinding(state, {
        severity: "warn",
        category: "large_file",
        rule: "large_file",
        path: relPath,
        message: `file is larger than ${options.large_file_bytes} bytes`
      });
    }

    if (!isProbablyTextPath(relPath)) {
      state.skippedFiles += 1;
      continue;
    }

    if (stat.size > options.max_file_bytes) {
      state.skippedFiles += 1;
      continue;
    }

    if (isConfigBlocked(relPath, config)) {
      state.skippedFiles += 1;
      continue;
    }

    if (candidates.length >= options.max_files) {
      state.scanTruncated = true;
      break;
    }

    candidates.push({ absPath, relPath, size: stat.size });
  }
  return candidates;
}

function analyzeRawFile(
  scanType: SecurityScanResult["scan_type"],
  relPath: string,
  raw: string,
  rules: LineRule[]
): CachedFileAnalysis {
  const local: ScanState = {
    scanType,
    findings: [],
    seenFingerprints: new Set<string>(),
    scannedFiles: 1,
    skippedFiles: 0,
    unreadSensitiveFiles: 0,
    scanTruncated: false,
    findingsTruncated: false,
    cacheHits: 0,
    cacheMisses: 0,
    cacheJoined: 0,
    cacheStores: 0,
    cacheEvictions: 0
  };
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const occurrenceCounts = new Map<string, number>();
  for (let index = 0; index < lines.length; index += 1) {
    analyzeLine(
      local,
      relPath,
      lines[index] ?? "",
      lines.slice(Math.max(0, index - 8), index).join("\n"),
      index + 1,
      rules,
      occurrenceCounts
    );
  }
  return { findings: local.findings, findingsTruncated: local.findingsTruncated };
}

function appendFileAnalysis(state: ScanState, analysis: CachedFileAnalysis): void {
  if (analysis.findingsTruncated) state.findingsTruncated = true;
  for (const finding of analysis.findings) {
    if (state.seenFingerprints.has(finding.fingerprint)) continue;
    if (state.findings.length >= MAX_FINDINGS) {
      state.findingsTruncated = true;
      return;
    }
    state.seenFingerprints.add(finding.fingerprint);
    state.findings.push({ ...finding });
  }
}

function fileAnalysisCacheKey(scanType: SecurityScanResult["scan_type"], relPath: string, contentHash: string): string {
  return `${scanType}\u0000${normalizeRelPath(relPath).replace(/^\.\//, "")}\u0000${contentHash}`;
}

async function analyzeFile(
  state: ScanState,
  candidate: TextFileCandidate,
  rules: LineRule[],
  cacheEnabled: boolean
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(candidate.absPath);
  } catch {
    state.skippedFiles += 1;
    return;
  }
  if (bytes.subarray(0, Math.min(bytes.length, 4_096)).includes(0)) {
    state.skippedFiles += 1;
    return;
  }

  state.scannedFiles += 1;
  const raw = bytes.toString("utf8");
  if (!cacheEnabled) {
    appendFileAnalysis(state, analyzeRawFile(state.scanType, candidate.relPath, raw, rules));
    return;
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const resolution = await SECURITY_FILE_SCAN_CACHE.resolve(
    fileAnalysisCacheKey(state.scanType, candidate.relPath, contentHash),
    SECURITY_SCAN_CACHE_GENERATION,
    () => {
      const analysis = analyzeRawFile(state.scanType, candidate.relPath, raw, rules);
      return { value: analysis, cacheable: !analysis.findingsTruncated };
    }
  );
  if (resolution.outcome === "hit") state.cacheHits += 1;
  if (resolution.outcome === "joined") state.cacheJoined += 1;
  if (resolution.outcome === "miss" || resolution.outcome === "uncached") state.cacheMisses += 1;
  if (resolution.stored && resolution.outcome === "miss") state.cacheStores += 1;
  state.cacheEvictions += resolution.evictions;
  appendFileAnalysis(state, resolution.value);
}

function countFindings(findings: SecurityFinding[]): { counts: Record<SecuritySeverity, number>; categoryCounts: Record<SecurityCategory, number> } {
  const counts: Record<SecuritySeverity, number> = { error: 0, warn: 0, info: 0 };
  const categoryCounts: Record<SecurityCategory, number> = { secret: 0, command: 0, docker: 0, sql: 0, large_file: 0, debug: 0, scan: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
    categoryCounts[finding.category] += 1;
  }
  return { counts, categoryCounts };
}

function statusFromCounts(counts: Record<SecuritySeverity, number>, failOnWarnings: boolean): { ok: boolean; status: SecurityScanResult["status"] } {
  if (counts.error > 0) return { ok: false, status: "fail" };
  if (counts.warn > 0) return { ok: !failOnWarnings, status: "warn" };
  return { ok: true, status: "pass" };
}

function formatLocation(finding: SecurityFinding): string {
  if (finding.line && finding.column) return `${finding.path}:${finding.line}:${finding.column}`;
  if (finding.line) return `${finding.path}:${finding.line}`;
  return finding.path;
}

function formatCategoryCounts(counts: Record<SecurityCategory, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${category}=${count}`)
    .join(", ") || "none";
}

function formatScanText(result: Omit<SecurityScanResult, "text">): string {
  const heading = result.scan_type === "secret_scan" ? "Secret Scan" : result.scan_type === "release_safety_check" ? "Release Safety Check" : "Security Audit";
  const shown = result.findings.slice(0, 80);
  const lines = [
    `# ${heading}`,
    "",
    `Status: ${result.status.toUpperCase()}${result.ok ? "" : " (release-blocking errors present)"}`,
    `Target: ${result.target_path}`,
    `Scanned files: ${result.scanned_files}`,
    `Skipped files: ${result.skipped_files}`,
    `Sensitive files not read: ${result.unread_sensitive_files}`,
    `Findings: error=${result.counts.error}, warn=${result.counts.warn}, info=${result.counts.info}`,
    `Categories: ${formatCategoryCounts(result.category_counts)}`,
    ...(result.baseline ? [
      `Effective findings: error=${result.effective_counts.error}, warn=${result.effective_counts.warn}, info=${result.effective_counts.info}`,
      `Effective categories: ${formatCategoryCounts(result.effective_category_counts)}`,
      `Baseline: matched=${result.baseline.matched}, stale=${result.baseline.stale}, expired=${result.baseline.expired}, new=${result.baseline.new}, suppressed=${result.baseline.suppressed}`
    ] : []),
    `Values: never printed; findings show locations only.`,
    "",
    "## Findings",
    "",
    shown.length ? shown.map((finding) => {
      const baselineSuffix = finding.baseline_status === "untracked"
        ? ""
        : ` [baseline=${finding.baseline_status}, disposition=${finding.disposition}]`;
      return `- ${finding.severity.toUpperCase()} ${finding.category}/${finding.rule} ${formatLocation(finding)}${baselineSuffix} — ${finding.message}`;
    }).join("\n") : "- none"
  ];
  if (result.findings.length > shown.length) {
    lines.push("", `Report preview limited: showing ${shown.length} of ${result.findings.length} retained findings.`);
  }
  if (result.scan_truncated) lines.push("", "Scan truncated: candidate file limit was reached.");
  if (result.findings_truncated) lines.push("", `Findings truncated: scanner retained the first ${MAX_FINDINGS} unique findings.`);
  return lines.join("\n");
}

async function runScan(
  config: CodexProConfig,
  _guard: PathGuard,
  workspace: Workspace,
  options: InternalScanOptions
): Promise<SecurityScanResult> {
  const scanRoot = resolveScanRoot(workspace, options.path);
  try {
    const stat = await fsp.stat(scanRoot.absPath);
    if (!stat.isDirectory() && !stat.isFile()) throw new CodexProError(`Scan target is not a file or directory: ${scanRoot.relPath}`);
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError(`Scan target does not exist: ${scanRoot.relPath}`);
  }

  const normalizedOptions = {
    max_files: limitInt(options.max_files, DEFAULT_MAX_FILES, 1, 50_000),
    max_file_bytes: limitInt(options.max_file_bytes, DEFAULT_MAX_FILE_BYTES, 1_000, 200_000_000),
    large_file_bytes: limitInt(options.large_file_bytes, DEFAULT_LARGE_FILE_BYTES, 10_000, 200_000_000),
    include_generated: Boolean(options.include_generated),
    cache_enabled: options.cache_enabled !== false
  };
  const state: ScanState = {
    scanType: options.scanType,
    findings: [],
    seenFingerprints: new Set<string>(),
    scannedFiles: 0,
    skippedFiles: 0,
    unreadSensitiveFiles: 0,
    scanTruncated: false,
    findingsTruncated: false,
    cacheHits: 0,
    cacheMisses: 0,
    cacheJoined: 0,
    cacheStores: 0,
    cacheEvictions: 0
  };
  const candidates = await collectCandidates(config, workspace, scanRoot, normalizedOptions, state);
  const rules = options.includeAuditRules ? [...SECRET_LINE_RULES, ...AUDIT_LINE_RULES] : SECRET_LINE_RULES;
  for (const candidate of candidates) await analyzeFile(state, candidate, rules, normalizedOptions.cache_enabled);

  let findings = state.findings;
  let baseline: SecurityBaselineApplicationSummary | undefined;
  if (options.baseline_path) {
    const policy = await loadSecurityPolicyFile(workspace.root, options.policy_path);
    const baselineFile = await loadSecurityBaselineFile(workspace.root, options.baseline_path, policy);
    const application = applySecurityBaseline(findings, baselineFile, policy);
    findings = application.findings;
    baseline = application.summary;
  }

  const { counts, categoryCounts } = countFindings(findings);
  const actionableFindings = findings.filter((finding) => finding.baseline_status !== "matched");
  const { counts: effectiveCounts, categoryCounts: effectiveCategoryCounts } = countFindings(actionableFindings);
  const status = statusFromCounts(effectiveCounts, Boolean(options.fail_on_warnings));
  const cacheSnapshot = SECURITY_FILE_SCAN_CACHE.snapshot();
  const cache: SecurityScanCacheSummary = {
    enabled: normalizedOptions.cache_enabled,
    generation: SECURITY_SCAN_CACHE_GENERATION,
    hits: state.cacheHits,
    misses: state.cacheMisses,
    joined: state.cacheJoined,
    stores: state.cacheStores,
    evictions: state.cacheEvictions,
    entries: cacheSnapshot.entries,
    bytes: cacheSnapshot.bytes,
    max_entries: cacheSnapshot.max_entries,
    max_bytes: cacheSnapshot.max_bytes
  };
  const data: Omit<SecurityScanResult, "text"> = {
    ok: status.ok,
    status: status.status,
    scan_type: options.scanType,
    schema_version: SECURITY_FINDING_SCHEMA_VERSION,
    rule_set_version: SECURITY_RULE_SET_VERSION,
    root: workspace.root,
    target_path: scanRoot.relPath,
    scanned_files: state.scannedFiles,
    skipped_files: state.skippedFiles,
    unread_sensitive_files: state.unreadSensitiveFiles,
    truncated: state.scanTruncated || state.findingsTruncated,
    scan_truncated: state.scanTruncated,
    findings_truncated: state.findingsTruncated,
    scan_complete: !state.scanTruncated && !state.findingsTruncated,
    counts,
    category_counts: categoryCounts,
    effective_counts: effectiveCounts,
    effective_category_counts: effectiveCategoryCounts,
    ...(baseline ? { baseline } : {}),
    cache,
    findings
  };
  return { ...data, text: formatScanText(data) };
}

export async function runSecretScan(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SecurityScanOptions = {}
): Promise<SecurityScanResult> {
  return runScan(config, guard, workspace, { ...options, scanType: "secret_scan", includeAuditRules: false });
}

export async function runSecurityAudit(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SecurityScanOptions = {}
): Promise<SecurityScanResult> {
  return runScan(config, guard, workspace, { ...options, scanType: "security_audit", includeAuditRules: true });
}

export async function runReleaseTargetScan(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SecurityScanOptions = {}
): Promise<SecurityScanResult> {
  return runScan(config, guard, workspace, { ...options, scanType: "release_safety_check", includeAuditRules: true });
}

export async function runReleaseSafetyCheck(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SecurityScanOptions & Record<string, unknown> = {}
): Promise<import("./securityReleaseGate.js").ReleaseSafetyCheckResult> {
  const { runReleaseSafetyDecisionGate } = await import("./securityReleaseGate.js");
  return runReleaseSafetyDecisionGate(config, guard, workspace, options);
}
