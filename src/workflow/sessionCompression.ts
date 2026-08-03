import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { writeTextFile } from "../fsOps.js";
import { type PathGuard, type Workspace } from "../guard.js";
import { hasSecretValue, redactMemoryCandidateText } from "../redact.js";

export const SESSION_SUMMARY_DIR = ".codexpro/session-summaries";
export const SESSION_SUMMARY_INDEX_PATH = `${SESSION_SUMMARY_DIR}/index.json`;

const RUNS_DIR = ".codexpro/runs";
const TASK_SNAPSHOTS_DIR = ".ai-bridge/task-snapshots";
const DEFAULT_RECENT_COUNT = 5;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_SUMMARY_CHARS = 4_000;
const DEFAULT_MAX_DETAIL_BYTES = 80_000;
const MAX_LOG_SCAN_BYTES = 80_000;
const MAX_ARTIFACT_SCAN_BYTES = 60_000;

type SessionSourceType = "run" | "task-snapshot";

interface SourceDir {
  id: string;
  sourceType: SessionSourceType;
  relDir: string;
  absDir: string;
  updatedAt: string;
  updatedMs: number;
}

interface SourceFile {
  relPath: string;
  absPath: string;
  basename: string;
  size: number;
}

interface BoundedText {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface SessionDiffSummary {
  files: string[];
  additions: number;
  deletions: number;
  hunks: number;
  truncated: boolean;
}

export interface SessionLogSummary {
  commands: string[];
  error_types: string[];
  file_paths: string[];
  stack_frames: string[];
  truncated: boolean;
}

export interface SessionSummaryRecord {
  session_id: string;
  source_type: SessionSourceType;
  source_dir: string;
  summary_path?: string;
  is_recent: boolean;
  detail_available: boolean;
  updated_at: string;
  final_report: string;
  diff_summary: SessionDiffSummary;
  memory_candidate: string;
  log_summary: SessionLogSummary;
  retained_artifacts: string[];
  searchable_text: string;
}

export interface SessionCompressionOptions {
  maxSessions?: number;
  recentCount?: number;
  maxSummaryChars?: number;
}

export interface SessionCompressionResult {
  summary_dir: string;
  index_path: string;
  sessions_scanned: number;
  summaries_written: number;
  recent_count: number;
  old_count: number;
  records: SessionSummaryRecord[];
  warnings: string[];
}

export interface SessionSummaryQueryOptions {
  query?: string;
  sessionId?: string;
  limit?: number;
  includeDetail?: boolean;
  recentCount?: number;
  maxSessions?: number;
  maxDetailBytes?: number;
}

export interface SessionSummaryQueryMatch extends SessionSummaryRecord {
  detail_text?: string;
  detail_note?: string;
}

export interface SessionSummaryQueryResult {
  summary_dir: string;
  index_path: string;
  index_existed: boolean;
  filters: {
    query?: string;
    session_id?: string;
    limit: number;
    include_detail: boolean;
  };
  matches: SessionSummaryQueryMatch[];
  total_matches: number;
  warnings: string[];
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function slug(value: string, fallback = "session"): string {
  const out = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return out || fallback;
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function relFromAbs(workspace: Workspace, absPath: string): string {
  return path.relative(workspace.root, absPath).split(path.sep).join("/");
}

function clip(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 36)).trimEnd()}\n[TRUNCATED_SESSION_SUMMARY]`;
}

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function safeSummaryText(value: string, maxChars: number): string {
  const redacted = redactMemoryCandidateText(value, Math.max(maxChars, 1_000));
  const clipped = clip(redacted, maxChars);
  return hasSecretValue(clipped) ? "[REDACTED_SENSITIVE_SESSION_SUMMARY]" : clipped;
}

async function readHeadTail(absPath: string, maxBytes: number): Promise<BoundedText> {
  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) return { text: "", truncated: false, bytes: 0 };
  if (stat.size <= maxBytes) {
    return { text: await fsp.readFile(absPath, "utf8"), truncated: false, bytes: stat.size };
  }

  const headBytes = Math.max(1, Math.floor(maxBytes / 2));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const handle = await fsp.open(absPath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await handle.read(head, 0, headBytes, 0);
    const tailOffset = Math.max(0, stat.size - tailBytes);
    const tailRead = await handle.read(tail, 0, tailBytes, tailOffset);
    return {
      text: [
        head.subarray(0, headRead.bytesRead).toString("utf8"),
        `\n[TRUNCATED_FILE ${stat.size} bytes; showing head/tail only]\n`,
        tail.subarray(0, tailRead.bytesRead).toString("utf8")
      ].join(""),
      truncated: true,
      bytes: stat.size
    };
  } finally {
    await handle.close();
  }
}

async function listImmediateSourceDirs(guard: PathGuard, workspace: Workspace, relRoot: string, sourceType: SessionSourceType): Promise<SourceDir[]> {
  const root = guard.resolve(workspace, relRoot).absPath;
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>;
  } catch {
    return [];
  }

  const dirs: SourceDir[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absDir = path.join(root, entry.name);
    const stat = await fsp.stat(absDir).catch(() => undefined);
    if (!stat) continue;
    dirs.push({
      id: entry.name,
      sourceType,
      relDir: posixJoin(relRoot, entry.name),
      absDir,
      updatedAt: stat.mtime.toISOString(),
      updatedMs: stat.mtimeMs
    });
  }
  return dirs;
}

async function listFiles(absDir: string, workspace: Workspace, maxDepth = 2, depth = 0): Promise<SourceFile[]> {
  if (depth > maxDepth) return [];
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  } catch {
    return [];
  }

  const files: SourceFile[] = [];
  for (const entry of entries) {
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absPath, workspace, maxDepth, depth + 1));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fsp.stat(absPath).catch(() => undefined);
    if (!stat) continue;
    files.push({ relPath: relFromAbs(workspace, absPath), absPath, basename: entry.name, size: stat.size });
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function chooseFirst(files: SourceFile[], basenames: string[]): SourceFile | undefined {
  const wanted = new Set(basenames);
  return files.find((file) => wanted.has(file.basename));
}

function stripHeavyMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "```text\n[large code/log block omitted from session summary]\n```")
    .replace(/\n{3,}/g, "\n\n");
}

function summarizeFinalReport(raw: string, maxChars: number): string {
  const stripped = stripHeavyMarkdown(raw);
  const preferred = stripped.match(/##\s+(?:结论|Conclusion|Validation|验收结果|已修复|Fixes|风险|Risk|提交|Commit)[\s\S]{0,2400}/i)?.[0];
  return safeSummaryText(preferred || stripped, maxChars);
}

function summarizeDiffText(raw: string, truncated: boolean): SessionDiffSummary {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  let hunks = 0;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const diffFile = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffFile) files.push(diffFile[2] || diffFile[1]);
    if (line.startsWith("@@")) hunks += 1;
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }

  return { files: unique(files, 80), additions, deletions, hunks, truncated };
}

function mergeDiffSummaries(values: SessionDiffSummary[]): SessionDiffSummary {
  return {
    files: unique(values.flatMap((item) => item.files), 120),
    additions: values.reduce((sum, item) => sum + item.additions, 0),
    deletions: values.reduce((sum, item) => sum + item.deletions, 0),
    hunks: values.reduce((sum, item) => sum + item.hunks, 0),
    truncated: values.some((item) => item.truncated)
  };
}

function summarizeLogText(raw: string, truncated: boolean): SessionLogSummary {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const joined = lines.join("\n");
  const commands = unique(lines.filter((line) => /^#\s+(?:npm|pnpm|yarn|bun|node|npx|tsc|git)\b/i.test(line)).map((line) => line.replace(/^#\s+/, "")), 20);
  const errors = unique([
    ...(joined.match(/\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|CodexProError|Error|Exception|ERR_[A-Z0-9_]+)\b[:\s][^\n]{0,180}/g) ?? []),
    ...(joined.match(/\b(?:failed|failure|fatal)\b[^\n]{0,180}/gi) ?? [])
  ], 30);
  const filePaths = unique(joined.match(/(?:src|scripts|docs|templates|schemas|planning-local|\.codexpro|\.ai-bridge)\/[A-Za-z0-9._/@:+-][^\s:`'")\]]{0,180}/g) ?? [], 60);
  const stackFrames = unique(lines.filter((line) => /^\s*at\s+.+:\d+:\d+\)?\s*$/.test(line) || /(?:src|scripts)\/[^:\s]+:\d+:\d+/.test(line)), 30);
  return { commands, error_types: errors, file_paths: filePaths, stack_frames: stackFrames, truncated };
}

function mergeLogSummaries(values: SessionLogSummary[]): SessionLogSummary {
  return {
    commands: unique(values.flatMap((item) => item.commands), 30),
    error_types: unique(values.flatMap((item) => item.error_types), 40),
    file_paths: unique(values.flatMap((item) => item.file_paths), 80),
    stack_frames: unique(values.flatMap((item) => item.stack_frames), 40),
    truncated: values.some((item) => item.truncated)
  };
}

async function summarizeSource(source: SourceDir, workspace: Workspace, isRecent: boolean, maxSummaryChars: number): Promise<SessionSummaryRecord> {
  const files = await listFiles(source.absDir, workspace, 2);
  const retainedArtifacts: string[] = [];

  const finalReportFile = chooseFirst(files, ["final-report.md", "task-report.md", "task-template-report.md", "summary.md"]);
  let finalReport = "No final report artifact found.";
  if (finalReportFile) {
    const raw = await readHeadTail(finalReportFile.absPath, MAX_ARTIFACT_SCAN_BYTES);
    finalReport = summarizeFinalReport(raw.text, maxSummaryChars);
    retainedArtifacts.push(finalReportFile.relPath);
  }

  const diffFiles = files.filter((file) => /\.patch$/i.test(file.basename) && !/rollback/i.test(file.basename)).slice(0, 8);
  const diffSummaries: SessionDiffSummary[] = [];
  for (const file of diffFiles) {
    const raw = await readHeadTail(file.absPath, MAX_ARTIFACT_SCAN_BYTES);
    diffSummaries.push(summarizeDiffText(raw.text, raw.truncated));
    retainedArtifacts.push(file.relPath);
  }
  const diffSummary = mergeDiffSummaries(diffSummaries);

  const memoryCandidateFile = chooseFirst(files, ["memory-candidate.md"]);
  let memoryCandidate = "No memory-candidate artifact found.";
  if (memoryCandidateFile) {
    const raw = await readHeadTail(memoryCandidateFile.absPath, MAX_ARTIFACT_SCAN_BYTES);
    memoryCandidate = safeSummaryText(raw.text, Math.min(maxSummaryChars, 3_000));
    retainedArtifacts.push(memoryCandidateFile.relPath);
  }

  const logFiles = files.filter((file) => /\.(log|txt)$/i.test(file.basename) && !/(status|branch|untracked)$/i.test(file.basename)).slice(0, 12);
  const logSummaries: SessionLogSummary[] = [];
  for (const file of logFiles) {
    const raw = await readHeadTail(file.absPath, MAX_LOG_SCAN_BYTES);
    logSummaries.push(summarizeLogText(raw.text, raw.truncated));
    retainedArtifacts.push(file.relPath);
  }
  const logSummary = mergeLogSummaries(logSummaries);

  const searchableText = safeSummaryText([
    source.id,
    source.sourceType,
    source.relDir,
    finalReport,
    diffSummary.files.join("\n"),
    memoryCandidate,
    logSummary.commands.join("\n"),
    logSummary.error_types.join("\n"),
    logSummary.file_paths.join("\n"),
    logSummary.stack_frames.join("\n")
  ].join("\n\n"), 16_000);

  return {
    session_id: source.id,
    source_type: source.sourceType,
    source_dir: source.relDir,
    is_recent: isRecent,
    detail_available: isRecent,
    updated_at: source.updatedAt,
    final_report: finalReport,
    diff_summary: diffSummary,
    memory_candidate: memoryCandidate,
    log_summary: logSummary,
    retained_artifacts: unique(retainedArtifacts, 80),
    searchable_text: searchableText
  };
}

async function collectSessionSources(guard: PathGuard, workspace: Workspace, maxSessions: number): Promise<SourceDir[]> {
  const runs = await listImmediateSourceDirs(guard, workspace, RUNS_DIR, "run");
  const snapshots = await listImmediateSourceDirs(guard, workspace, TASK_SNAPSHOTS_DIR, "task-snapshot");
  return [...runs, ...snapshots]
    .sort((a, b) => b.updatedMs - a.updatedMs)
    .slice(0, maxSessions);
}

async function buildSessionRecords(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: Required<SessionCompressionOptions>): Promise<SessionSummaryRecord[]> {
  void config;
  const sources = await collectSessionSources(guard, workspace, options.maxSessions);
  const recentIds = new Set(sources.slice(0, options.recentCount).map((source) => `${source.sourceType}:${source.id}`));
  const records: SessionSummaryRecord[] = [];
  for (const source of sources) {
    records.push(await summarizeSource(source, workspace, recentIds.has(`${source.sourceType}:${source.id}`), options.maxSummaryChars));
  }
  return records;
}

function recordSummaryMarkdown(record: SessionSummaryRecord): string {
  const diff = record.diff_summary;
  const logs = record.log_summary;
  return [
    "# Session Summary",
    "",
    `Session: ${record.session_id}`,
    `Source type: ${record.source_type}`,
    `Source dir: ${record.source_dir}`,
    `Updated: ${record.updated_at}`,
    `Recent detail available: ${record.detail_available ? "yes" : "no"}`,
    "",
    "## Final report",
    "",
    record.final_report || "No final report artifact found.",
    "",
    "## Diff summary",
    "",
    `- Files changed: ${diff.files.length}`,
    `- Additions: ${diff.additions}`,
    `- Deletions: ${diff.deletions}`,
    `- Hunks: ${diff.hunks}`,
    `- Truncated while scanning: ${diff.truncated ? "yes" : "no"}`,
    "",
    diff.files.length ? diff.files.map((file) => `- ${file}`).join("\n") : "- No patch artifact found.",
    "",
    "## Memory candidate",
    "",
    record.memory_candidate || "No memory-candidate artifact found.",
    "",
    "## Log summary",
    "",
    "### Commands",
    logs.commands.length ? logs.commands.map((command) => `- ${command}`).join("\n") : "- none",
    "",
    "### Error types / failure lines",
    logs.error_types.length ? logs.error_types.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "### File paths",
    logs.file_paths.length ? logs.file_paths.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "### Key stack frames",
    logs.stack_frames.length ? logs.stack_frames.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    `Long log scan truncated: ${logs.truncated ? "yes" : "no"}`,
    "",
    "## Retained artifacts",
    "",
    record.retained_artifacts.length ? record.retained_artifacts.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Context policy",
    "",
    "- Recent sessions may be opened with bounded detail.",
    "- Old sessions should be retrieved through this summary instead of loading full transcripts, patches, or logs.",
    "- Raw long logs are reduced to command status, error type, file path, and key stack-frame clues."
  ].join("\n");
}

async function writeSummaryArtifacts(config: CodexProConfig, guard: PathGuard, workspace: Workspace, records: SessionSummaryRecord[]): Promise<SessionSummaryRecord[]> {
  const withPaths: SessionSummaryRecord[] = [];
  for (const record of records) {
    const summaryPath = posixJoin(SESSION_SUMMARY_DIR, `${record.source_type}-${slug(record.session_id)}.md`);
    await writeTextFile(config, guard, workspace, summaryPath, `${recordSummaryMarkdown(record)}\n`, { createDirs: true, overwrite: true });
    withPaths.push({ ...record, summary_path: summaryPath });
  }

  const indexContent = JSON.stringify({ generated_at: new Date().toISOString(), records: withPaths }, null, 2);
  await writeTextFile(config, guard, workspace, SESSION_SUMMARY_INDEX_PATH, `${indexContent}\n`, { createDirs: true, overwrite: true });

  const indexMarkdown = [
    "# Session Summary Index",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Session | Type | Recent | Updated | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...withPaths.map((record) => `| ${record.session_id} | ${record.source_type} | ${record.is_recent ? "yes" : "no"} | ${record.updated_at} | ${record.summary_path ?? ""} |`)
  ].join("\n");
  await writeTextFile(config, guard, workspace, posixJoin(SESSION_SUMMARY_DIR, "index.md"), `${indexMarkdown}\n`, { createDirs: true, overwrite: true });

  return withPaths;
}

export async function compressOldSessions(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SessionCompressionOptions = {}
): Promise<SessionCompressionResult> {
  const resolvedOptions = {
    maxSessions: clampInt(options.maxSessions, DEFAULT_MAX_SESSIONS, 1, 500),
    recentCount: clampInt(options.recentCount, DEFAULT_RECENT_COUNT, 1, 30),
    maxSummaryChars: clampInt(options.maxSummaryChars, DEFAULT_MAX_SUMMARY_CHARS, 1_000, 12_000)
  };
  const warnings: string[] = [];
  const records = await buildSessionRecords(config, guard, workspace, resolvedOptions);
  const written = await writeSummaryArtifacts(config, guard, workspace, records);
  const oldCount = written.filter((record) => !record.is_recent).length;
  if (!written.length) warnings.push("No .codexpro/runs or .ai-bridge/task-snapshots sessions were found.");

  return {
    summary_dir: SESSION_SUMMARY_DIR,
    index_path: SESSION_SUMMARY_INDEX_PATH,
    sessions_scanned: written.length,
    summaries_written: written.length,
    recent_count: written.length - oldCount,
    old_count: oldCount,
    records: written,
    warnings
  };
}

async function loadIndexedRecords(guard: PathGuard, workspace: Workspace): Promise<{ existed: boolean; records: SessionSummaryRecord[] }> {
  const resolved = guard.resolve(workspace, SESSION_SUMMARY_INDEX_PATH);
  try {
    const raw = await fsp.readFile(resolved.absPath, "utf8");
    const parsed = JSON.parse(raw) as { records?: SessionSummaryRecord[] };
    return { existed: true, records: Array.isArray(parsed.records) ? parsed.records : [] };
  } catch {
    return { existed: false, records: [] };
  }
}

async function detailForRecentRecord(record: SessionSummaryRecord, guard: PathGuard, workspace: Workspace, maxDetailBytes: number): Promise<string> {
  const sourceAbs = guard.resolve(workspace, record.source_dir).absPath;
  const files = await listFiles(sourceAbs, workspace, 2);
  const wanted = new Set(record.retained_artifacts);
  const detailSections: string[] = [
    "# Recent Session Detail",
    "",
    `Session: ${record.session_id}`,
    `Source: ${record.source_dir}`,
    "",
    "Recent-session detail is bounded; old sessions stay summary-only.",
    ""
  ];
  let remaining = maxDetailBytes;
  for (const file of files) {
    if (!wanted.has(file.relPath)) continue;
    if (remaining <= 0) {
      detailSections.push("## Detail budget exhausted", "", "Additional retained artifacts were omitted.");
      break;
    }
    const raw = await readHeadTail(file.absPath, Math.min(remaining, 30_000));
    const body = safeSummaryText(raw.text, Math.min(remaining, 30_000));
    remaining -= body.length;
    detailSections.push(`## ${file.relPath}`, "", raw.truncated ? "[bounded head/tail preview]" : "[bounded full artifact preview]", "", body, "");
  }
  return detailSections.join("\n");
}

export async function querySessionSummaries(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: SessionSummaryQueryOptions = {}
): Promise<SessionSummaryQueryResult> {
  const limit = clampInt(options.limit, 10, 1, 50);
  const includeDetail = Boolean(options.includeDetail);
  const maxDetailBytes = clampInt(options.maxDetailBytes, DEFAULT_MAX_DETAIL_BYTES, 4_000, 120_000);
  const query = options.query?.trim().toLowerCase() || undefined;
  const sessionId = options.sessionId?.trim() || undefined;
  const warnings: string[] = [];
  const indexed = await loadIndexedRecords(guard, workspace);
  let records = indexed.records;

  if (!indexed.existed) {
    warnings.push(`No ${SESSION_SUMMARY_INDEX_PATH} found; built a read-only in-memory summary. Run compress_old_sessions to persist searchable summaries.`);
    records = await buildSessionRecords(config, guard, workspace, {
      maxSessions: clampInt(options.maxSessions, DEFAULT_MAX_SESSIONS, 1, 500),
      recentCount: clampInt(options.recentCount, DEFAULT_RECENT_COUNT, 1, 30),
      maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS
    });
  }

  const filtered = records.filter((record) => {
    if (sessionId && record.session_id !== sessionId) return false;
    if (!query) return true;
    return [
      record.session_id,
      record.source_type,
      record.source_dir,
      record.final_report,
      record.memory_candidate,
      record.searchable_text,
      record.diff_summary.files.join("\n"),
      record.log_summary.error_types.join("\n"),
      record.log_summary.file_paths.join("\n")
    ].join("\n").toLowerCase().includes(query);
  });

  const matches: SessionSummaryQueryMatch[] = [];
  for (const record of filtered.slice(0, limit)) {
    if (!includeDetail) {
      matches.push(record);
      continue;
    }
    if (!record.detail_available) {
      matches.push({ ...record, detail_note: "Old session detail is summary-only to avoid loading full historical context." });
      continue;
    }
    matches.push({ ...record, detail_text: await detailForRecentRecord(record, guard, workspace, maxDetailBytes) });
  }

  return {
    summary_dir: SESSION_SUMMARY_DIR,
    index_path: SESSION_SUMMARY_INDEX_PATH,
    index_existed: indexed.existed,
    filters: {
      ...(query ? { query: options.query?.trim() } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      limit,
      include_detail: includeDetail
    },
    matches,
    total_matches: filtered.length,
    warnings
  };
}

export function formatSessionCompressionResult(result: SessionCompressionResult): string {
  const lines = [
    "# Context Compression / Old Session Summary",
    "",
    `Summary dir: ${result.summary_dir}`,
    `Index path: ${result.index_path}`,
    `Sessions scanned: ${result.sessions_scanned}`,
    `Summaries written: ${result.summaries_written}`,
    `Recent sessions with bounded detail: ${result.recent_count}`,
    `Old sessions summary-only: ${result.old_count}`,
    "",
    "## Policy",
    "",
    "- Recent sessions can still be read with bounded detail.",
    "- Old sessions are retrieved through summaries rather than full logs, diffs, or transcripts.",
    "- Long logs are compressed into commands, error types, file paths, and key stack frames.",
    "",
    "## Sessions",
    ...result.records.slice(0, 30).map((record) => `- ${record.session_id} (${record.source_type}) — ${record.is_recent ? "recent detail" : "summary-only"} — ${record.summary_path ?? record.source_dir}`)
  ];
  if (result.records.length > 30) lines.push(`- ... ${result.records.length - 30} more`);
  if (result.warnings.length) lines.push("", "## Warnings", ...result.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

export function formatSessionSummaryQueryResult(result: SessionSummaryQueryResult): string {
  const lines = [
    "# Session Summary Query",
    "",
    `Summary dir: ${result.summary_dir}`,
    `Index path: ${result.index_path}`,
    `Index existed: ${result.index_existed ? "yes" : "no"}`,
    `Matches: ${result.total_matches}`,
    `Filters: ${JSON.stringify(result.filters)}`,
    ""
  ];
  if (result.warnings.length) lines.push("## Warnings", ...result.warnings.map((warning) => `- ${warning}`), "");

  if (!result.matches.length) {
    lines.push("## Matches", "", "- No matching session summaries found.");
    return lines.join("\n");
  }

  lines.push("## Matches");
  for (const record of result.matches) {
    lines.push(
      "",
      `### ${record.session_id}`,
      `- Type: ${record.source_type}`,
      `- Source: ${record.source_dir}`,
      `- Updated: ${record.updated_at}`,
      `- Detail: ${record.detail_available ? "recent bounded detail available" : "summary-only"}`,
      record.summary_path ? `- Summary: ${record.summary_path}` : "",
      "",
      "#### Final report",
      "",
      record.final_report || "No final report artifact found.",
      "",
      "#### Diff",
      "",
      `- Files: ${record.diff_summary.files.length}`,
      `- Additions: ${record.diff_summary.additions}`,
      `- Deletions: ${record.diff_summary.deletions}`,
      record.diff_summary.files.length ? record.diff_summary.files.slice(0, 20).map((file) => `- ${file}`).join("\n") : "- No diff files recorded.",
      "",
      "#### Log clues",
      "",
      record.log_summary.error_types.length ? record.log_summary.error_types.slice(0, 12).map((item) => `- ${item}`).join("\n") : "- No error lines found.",
      record.detail_note ? `\nDetail note: ${record.detail_note}` : "",
      record.detail_text ? `\n${record.detail_text}` : ""
    );
  }
  return lines.filter((line) => line !== "").join("\n");
}
