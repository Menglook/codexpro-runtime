import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { sha256 } from "../fsOps.js";
import { hasSecretValue, redactMemoryCandidateText, redactSensitiveText } from "../redact.js";
import { PROJECT_MEMORY_DIR, readProjectMemory } from "./projectMemory.js";

export const PROJECT_MEMORY_INDEX_PATH = `${PROJECT_MEMORY_DIR}/index.sqlite`;

const SQLITE_RUNTIME = "node:sqlite";
const DEFAULT_MAX_BODY_CHARS = 12_000;
const MAX_INDEXED_SECTIONS_PER_FILE = 80;
const MAX_INDEXED_EVENTS = 400;

type SqliteValue = string | number | null;

interface SqliteStatement {
  run: (...params: SqliteValue[]) => unknown;
  all: (...params: SqliteValue[]) => Record<string, unknown>[];
  get: (...params: SqliteValue[]) => Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

interface IndexedMemoryItem {
  sourcePath: string;
  itemType: "file" | "section";
  title: string;
  body: string;
  tags: string[];
  sessionId?: string;
  sourceSha256?: string;
}

interface IndexedFileEvent {
  sessionId?: string;
  filePath: string;
  eventType: string;
  summary: string;
}

interface IndexedCommandEvent {
  sessionId?: string;
  command: string;
  exitCode?: number;
  summary: string;
}

export interface MemoryIndexBuildOptions {
  includeCustom?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxBodyChars?: number;
  rebuild?: boolean;
}

export interface MemoryIndexBuildResult {
  path: string;
  existed_before: boolean;
  rebuilt: boolean;
  project_id: string;
  project_root: string;
  files_indexed: number;
  memory_items: number;
  sessions: number;
  file_events: number;
  command_events: number;
  skipped_files: string[];
  warnings: string[];
  sqlite_runtime: string;
}

export interface MemoryIndexQueryOptions {
  query?: string;
  tag?: string;
  sessionId?: string;
  sourcePath?: string;
  limit?: number;
}

export interface MemoryIndexQueryItem {
  source_path: string;
  item_type: string;
  title: string;
  body_preview: string;
  tags: string[];
  session_id?: string;
  updated_at: string;
}

export interface MemoryIndexQueryResult {
  path: string;
  existed: boolean;
  project_id: string;
  project_root: string;
  filters: {
    query?: string;
    tag?: string;
    session_id?: string;
    source_path?: string;
    limit: number;
  };
  matches: MemoryIndexQueryItem[];
  total_matches: number;
  sessions: Array<{ id: string; source_path?: string; title?: string; summary?: string; updated_at?: string }>;
  file_events: Array<{ session_id?: string; path: string; event_type: string; summary: string }>;
  command_events: Array<{ session_id?: string; command: string; exit_code?: number; summary: string }>;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeTag(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/gi, "-").replace(/^-+|-+$/g, "");
  if (normalized.length < 2 || normalized.length > 64) return undefined;
  return normalized;
}

function uniqueTags(values: string[]): string[] {
  const tags = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTag(value);
    if (normalized) tags.add(normalized);
  }
  return [...tags].sort();
}

function clipText(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 30)).trimEnd()}\n[TRUNCATED_FOR_MEMORY_INDEX]`;
}

async function openSqliteDatabase(absPath: string): Promise<SqliteDatabase> {
  let sqliteModule: { DatabaseSync?: new (path: string) => SqliteDatabase } | undefined;
  try {
    sqliteModule = await import("node:sqlite") as unknown as { DatabaseSync?: new (path: string) => SqliteDatabase };
  } catch {
    sqliteModule = undefined;
  }

  if (!sqliteModule?.DatabaseSync) {
    throw new CodexProError("SQLite memory index requires a Node.js runtime with node:sqlite available. Use Node 24+ for this feature, or skip rebuilding the local memory index on older runtimes.");
  }

  return new sqliteModule.DatabaseSync(absPath);
}

function schemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  item_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  session_id TEXT,
  source_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_project ON memory_items(project_root, project_id);
CREATE INDEX IF NOT EXISTS idx_memory_items_source ON memory_items(source_path);
CREATE INDEX IF NOT EXISTS idx_memory_items_session ON memory_items(session_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  source_path TEXT,
  title TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  summary TEXT,
  PRIMARY KEY (project_root, id)
);

CREATE TABLE IF NOT EXISTS file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  session_id TEXT,
  path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_events_project ON file_events(project_root);
CREATE INDEX IF NOT EXISTS idx_file_events_session ON file_events(session_id);
CREATE INDEX IF NOT EXISTS idx_file_events_path ON file_events(path);

CREATE TABLE IF NOT EXISTS command_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_root TEXT NOT NULL,
  session_id TEXT,
  command TEXT NOT NULL,
  exit_code INTEGER,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_command_events_project ON command_events(project_root);
CREATE INDEX IF NOT EXISTS idx_command_events_session ON command_events(session_id);
CREATE INDEX IF NOT EXISTS idx_command_events_command ON command_events(command);
`;
}

function projectId(workspace: Workspace): string {
  const name = path.basename(workspace.root).trim();
  return name || "workspace";
}

function firstHeading(text: string, fallback: string): string {
  const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  return heading ? clipText(redactSensitiveText(heading), 180) : fallback;
}

function extractTags(text: string, sourcePath: string, title?: string): string[] {
  const tags: string[] = [path.basename(sourcePath).replace(/\.(md|markdown|txt)$/i, "")];
  const tagLine = text.match(/^tags\s*:\s*(.+)$/im)?.[1];
  if (tagLine) {
    for (const part of tagLine.replace(/[\[\]]/g, "").split(/[\s,]+/)) tags.push(part);
  }

  for (const match of text.matchAll(/(^|\s)#([A-Za-z0-9][A-Za-z0-9_.:-]{1,63})\b/g)) tags.push(match[2]);
  for (const match of text.matchAll(/\bStage\s+([0-9]+(?:\.[0-9]+)?)\b/gi)) tags.push(`stage-${match[1]}`);
  if (title) {
    for (const word of title.split(/\s+/).slice(0, 6)) tags.push(word);
  }

  return uniqueTags(tags);
}

function extractSessionId(text: string): string | undefined {
  const direct = text.match(/\b(?:session|snapshot|run)[ _-]?(?:id)?\s*[:=]\s*`?([A-Za-z0-9][A-Za-z0-9._:-]{4,95})`?/i)?.[1];
  if (direct) return direct;
  return text.match(/(?:\.codexpro\/runs|\.ai-bridge\/task-snapshots)\/([A-Za-z0-9._:-]{6,120})/i)?.[1];
}

function splitMarkdownSections(sourcePath: string, redactedText: string, sourceSha256: string | undefined, maxBodyChars: number): IndexedMemoryItem[] {
  const items: IndexedMemoryItem[] = [];
  const fileTitle = firstHeading(redactedText, sourcePath);
  const fileSessionId = extractSessionId(redactedText);
  items.push({
    sourcePath,
    itemType: "file",
    title: fileTitle,
    body: clipText(redactedText, maxBodyChars),
    tags: extractTags(redactedText, sourcePath, fileTitle),
    sessionId: fileSessionId,
    sourceSha256
  });

  const headingMatches = [...redactedText.matchAll(/^#{1,3}\s+(.+)$/gm)].slice(0, MAX_INDEXED_SECTIONS_PER_FILE);
  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index];
    const next = headingMatches[index + 1];
    const title = clipText(redactSensitiveText(match[1]?.trim() || sourcePath), 180);
    const start = match.index ?? 0;
    const end = next?.index ?? redactedText.length;
    const body = clipText(redactedText.slice(start, end), maxBodyChars);
    if (!body) continue;
    items.push({
      sourcePath,
      itemType: "section",
      title,
      body,
      tags: extractTags(body, sourcePath, title),
      sessionId: extractSessionId(body) ?? fileSessionId,
      sourceSha256
    });
  }

  return items;
}

function isSensitivePathReference(value: string): boolean {
  return /(^|\/)(\.env(?:\.|$)|id_rsa|id_dsa|id_ed25519|[^/]*(?:token|secret|password|private-key|private_key|cookie)[^/]*)/i.test(value);
}

function extractFileEvents(items: IndexedMemoryItem[]): IndexedFileEvent[] {
  const events: IndexedFileEvent[] = [];
  const seen = new Set<string>();
  const pathPattern = /`((?:src|scripts|docs|templates|schemas|planning-local|\.codexpro|\.ai-bridge)\/[A-Za-z0-9._/@:+-][^`\s]{0,180})`/g;

  for (const item of items) {
    for (const match of item.body.matchAll(pathPattern)) {
      const filePath = match[1];
      if (isSensitivePathReference(filePath)) continue;
      const key = `${item.sessionId ?? ""}\0${filePath}\0${item.sourcePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        sessionId: item.sessionId,
        filePath,
        eventType: "memory_reference",
        summary: clipText(`${item.title} (${item.sourcePath})`, 300)
      });
      if (events.length >= MAX_INDEXED_EVENTS) return events;
    }
  }

  return events;
}

function extractCommandEvents(items: IndexedMemoryItem[]): IndexedCommandEvent[] {
  const events: IndexedCommandEvent[] = [];
  const seen = new Set<string>();
  const commandPattern = /`((?:npm|pnpm|yarn|bun|node|npx|tsc|git)\s+[^`\n]{1,180})`/g;

  for (const item of items) {
    for (const match of item.body.matchAll(commandPattern)) {
      const command = clipText(redactMemoryCandidateText(match[1], 240), 240);
      if (!command || hasSecretValue(command)) continue;
      const key = `${item.sessionId ?? ""}\0${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        sessionId: item.sessionId,
        command,
        summary: clipText(`${item.title} (${item.sourcePath})`, 300)
      });
      if (events.length >= MAX_INDEXED_EVENTS) return events;
    }
  }

  return events;
}

function readCount(db: SqliteDatabase, table: string, projectRoot: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_root = ?`).get(projectRoot);
  return Number(row?.count ?? 0);
}

export async function buildMemoryIndex(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: MemoryIndexBuildOptions = {}
): Promise<MemoryIndexBuildResult> {
  const includeCustom = options.includeCustom ?? true;
  const maxFiles = clampInt(options.maxFiles, 30, 1, 50);
  const maxFileBytes = clampInt(options.maxFileBytes, 40_000, 1_000, 80_000);
  const maxBodyChars = clampInt(options.maxBodyChars, DEFAULT_MAX_BODY_CHARS, 1_000, 40_000);
  const indexResolved = guard.resolve(workspace, PROJECT_MEMORY_INDEX_PATH, { forWrite: true });
  const existedBefore = await fsp.access(indexResolved.absPath).then(() => true, () => false);
  await fsp.mkdir(path.dirname(indexResolved.absPath), { recursive: true });

  const db = await openSqliteDatabase(indexResolved.absPath);
  const now = new Date().toISOString();
  const project_id = projectId(workspace);
  const warnings: string[] = [];
  const skippedFiles: string[] = [];

  try {
    db.exec(schemaSql());
    const memory = await readProjectMemory(config, guard, workspace, { includeCustom, maxFiles, maxFileBytes });
    const readableFiles = memory.files.filter((file) => file.existed && file.text && /\.(md|markdown|txt)$/i.test(file.path));
    const items: IndexedMemoryItem[] = [];

    for (const file of readableFiles) {
      const raw = file.text ?? "";
      const redacted = redactMemoryCandidateText(raw, maxFileBytes);
      if (hasSecretValue(redacted)) {
        skippedFiles.push(file.path);
        warnings.push(`Skipped ${file.path} because it still looked sensitive after redaction.`);
        continue;
      }
      items.push(...splitMarkdownSections(file.path, redacted, file.sha256 ?? sha256(raw), maxBodyChars));
    }

    const fileEvents = extractFileEvents(items);
    const commandEvents = extractCommandEvents(items);
    const sessions = new Map<string, { sourcePath: string; title: string; summary: string }>();
    for (const item of items) {
      if (!item.sessionId) continue;
      if (!sessions.has(item.sessionId)) {
        sessions.set(item.sessionId, {
          sourcePath: item.sourcePath,
          title: item.title,
          summary: clipText(item.body, 800)
        });
      }
    }

    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      db.prepare("DELETE FROM memory_items WHERE project_root = ?").run(workspace.root);
      db.prepare("DELETE FROM sessions WHERE project_root = ?").run(workspace.root);
      db.prepare("DELETE FROM file_events WHERE project_root = ?").run(workspace.root);
      db.prepare("DELETE FROM command_events WHERE project_root = ?").run(workspace.root);

      const insertMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
      insertMeta.run("schema_version", "1");
      insertMeta.run("updated_at", now);
      insertMeta.run("project_root", workspace.root);

      const insertItem = db.prepare(`
        INSERT INTO memory_items (project_root, project_id, source_path, item_type, title, body, tags_json, session_id, source_sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          workspace.root,
          project_id,
          item.sourcePath,
          item.itemType,
          item.title,
          item.body,
          JSON.stringify(item.tags),
          item.sessionId ?? null,
          item.sourceSha256 ?? null,
          now,
          now
        );
      }

      const insertSession = db.prepare("INSERT OR REPLACE INTO sessions (id, project_root, source_path, title, started_at, updated_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const [id, session] of sessions.entries()) {
        insertSession.run(id, workspace.root, session.sourcePath, session.title, null, now, session.summary);
      }

      const insertFileEvent = db.prepare("INSERT INTO file_events (project_root, session_id, path, event_type, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const event of fileEvents) {
        insertFileEvent.run(workspace.root, event.sessionId ?? null, event.filePath, event.eventType, event.summary, now);
      }

      const insertCommandEvent = db.prepare("INSERT INTO command_events (project_root, session_id, command, exit_code, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const event of commandEvents) {
        insertCommandEvent.run(workspace.root, event.sessionId ?? null, event.command, event.exitCode ?? null, event.summary, now);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      path: PROJECT_MEMORY_INDEX_PATH,
      existed_before: existedBefore,
      rebuilt: true,
      project_id,
      project_root: workspace.root,
      files_indexed: readableFiles.length - skippedFiles.length,
      memory_items: readCount(db, "memory_items", workspace.root),
      sessions: readCount(db, "sessions", workspace.root),
      file_events: readCount(db, "file_events", workspace.root),
      command_events: readCount(db, "command_events", workspace.root),
      skipped_files: skippedFiles,
      warnings,
      sqlite_runtime: SQLITE_RUNTIME
    };
  } finally {
    db.close();
  }
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function rowNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function queryMemoryIndex(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: MemoryIndexQueryOptions = {}
): Promise<MemoryIndexQueryResult> {
  void config;
  const limit = clampInt(options.limit, 10, 1, 50);
  const indexResolved = guard.resolve(workspace, PROJECT_MEMORY_INDEX_PATH);
  const existed = await fsp.access(indexResolved.absPath).then(() => true, () => false);
  const project_id = projectId(workspace);
  const filters = {
    query: options.query?.trim() || undefined,
    tag: options.tag ? normalizeTag(options.tag) : undefined,
    session_id: options.sessionId?.trim() || undefined,
    source_path: options.sourcePath?.trim() || undefined,
    limit
  };

  if (!existed) {
    return {
      path: PROJECT_MEMORY_INDEX_PATH,
      existed: false,
      project_id,
      project_root: workspace.root,
      filters,
      matches: [],
      total_matches: 0,
      sessions: [],
      file_events: [],
      command_events: []
    };
  }

  const db = await openSqliteDatabase(indexResolved.absPath);
  try {
    const clauses = ["project_root = ?"];
    const params: SqliteValue[] = [workspace.root];
    if (filters.query) {
      const like = `%${escapeLike(filters.query.toLowerCase())}%`;
      clauses.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\' OR lower(source_path) LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    if (filters.session_id) {
      clauses.push("session_id = ?");
      params.push(filters.session_id);
    }
    if (filters.source_path) {
      clauses.push("source_path = ?");
      params.push(filters.source_path);
    }

    const where = clauses.join(" AND ");
    const rows = db.prepare(`
      SELECT source_path, item_type, title, body, tags_json, session_id, updated_at
      FROM memory_items
      WHERE ${where}
      ORDER BY updated_at DESC, source_path ASC, id ASC
      LIMIT ?
    `).all(...params, limit * (filters.tag ? 4 : 1));

    const matches = rows
      .map((row) => ({
        source_path: rowString(row, "source_path") ?? "",
        item_type: rowString(row, "item_type") ?? "memory",
        title: rowString(row, "title") ?? "",
        body_preview: clipText(rowString(row, "body") ?? "", 700),
        tags: parseTags(row.tags_json),
        session_id: rowString(row, "session_id"),
        updated_at: rowString(row, "updated_at") ?? ""
      }))
      .filter((item) => !filters.tag || item.tags.includes(filters.tag))
      .slice(0, limit);

    const sessionRows = db.prepare(`
      SELECT id, source_path, title, summary, updated_at
      FROM sessions
      WHERE project_root = ? ${filters.session_id ? "AND id = ?" : ""}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...(filters.session_id ? [workspace.root, filters.session_id, limit] : [workspace.root, limit]));

    const eventSessionClause = filters.session_id ? "AND session_id = ?" : "";
    const fileRows = db.prepare(`
      SELECT session_id, path, event_type, summary
      FROM file_events
      WHERE project_root = ? ${eventSessionClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...(filters.session_id ? [workspace.root, filters.session_id, limit] : [workspace.root, limit]));

    const commandRows = db.prepare(`
      SELECT session_id, command, exit_code, summary
      FROM command_events
      WHERE project_root = ? ${eventSessionClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...(filters.session_id ? [workspace.root, filters.session_id, limit] : [workspace.root, limit]));

    return {
      path: PROJECT_MEMORY_INDEX_PATH,
      existed: true,
      project_id,
      project_root: workspace.root,
      filters,
      matches,
      total_matches: matches.length,
      sessions: sessionRows.map((row) => ({
        id: rowString(row, "id") ?? "",
        source_path: rowString(row, "source_path"),
        title: rowString(row, "title"),
        summary: rowString(row, "summary") ? clipText(rowString(row, "summary") ?? "", 500) : undefined,
        updated_at: rowString(row, "updated_at")
      })),
      file_events: fileRows.map((row) => ({
        session_id: rowString(row, "session_id"),
        path: rowString(row, "path") ?? "",
        event_type: rowString(row, "event_type") ?? "memory_reference",
        summary: rowString(row, "summary") ?? ""
      })),
      command_events: commandRows.map((row) => ({
        session_id: rowString(row, "session_id"),
        command: rowString(row, "command") ?? "",
        exit_code: rowNumber(row, "exit_code"),
        summary: rowString(row, "summary") ?? ""
      }))
    };
  } finally {
    db.close();
  }
}

export function formatMemoryIndexBuildResult(result: MemoryIndexBuildResult): string {
  const lines = [
    "# SQLite Memory Index",
    "",
    `Path: ${result.path}`,
    `SQLite runtime: ${result.sqlite_runtime}`,
    `Project: ${result.project_id}`,
    `Rebuilt: ${result.rebuilt ? "yes" : "no"}`,
    `Existed before: ${result.existed_before ? "yes" : "no"}`,
    "",
    "## Indexed counts",
    `- Memory files: ${result.files_indexed}`,
    `- Memory items: ${result.memory_items}`,
    `- Sessions: ${result.sessions}`,
    `- File events: ${result.file_events}`,
    `- Command events: ${result.command_events}`
  ];

  if (result.skipped_files.length) {
    lines.push("", "## Skipped files", ...result.skipped_files.map((file) => `- ${file}`));
  }
  if (result.warnings.length) {
    lines.push("", "## Warnings", ...result.warnings.map((warning) => `- ${warning}`));
  }
  lines.push("", "## Safety", "- Markdown remains the human-readable source of truth; this SQLite file is a local generated index.", "- Indexed text is redacted before storage, and files that still look sensitive after redaction are skipped.");
  return lines.join("\n");
}

export function formatMemoryIndexQueryResult(result: MemoryIndexQueryResult): string {
  if (!result.existed) {
    return [
      "# Memory Index Query",
      "",
      `Path: ${result.path}`,
      "Exists: no",
      "",
      "Run `rebuild_memory_index` before querying the local SQLite memory index."
    ].join("\n");
  }

  const lines = [
    "# Memory Index Query",
    "",
    `Path: ${result.path}`,
    `Project: ${result.project_id}`,
    `Matches: ${result.total_matches}`,
    `Filters: ${JSON.stringify(result.filters)}`,
    "",
    "## Memory items"
  ];

  if (!result.matches.length) {
    lines.push("- No matching memory items found.");
  } else {
    for (const item of result.matches) {
      lines.push(
        "",
        `### ${item.title || item.source_path}`,
        `- Source: ${item.source_path}`,
        `- Type: ${item.item_type}`,
        `- Tags: ${item.tags.length ? item.tags.join(", ") : "none"}`,
        item.session_id ? `- Session: ${item.session_id}` : "- Session: none",
        "",
        item.body_preview
      );
    }
  }

  if (result.sessions.length) {
    lines.push("", "## Sessions", ...result.sessions.map((session) => `- ${session.id}${session.title ? ` — ${session.title}` : ""}${session.source_path ? ` (${session.source_path})` : ""}`));
  }
  if (result.file_events.length) {
    lines.push("", "## File events", ...result.file_events.map((event) => `- ${event.path} — ${event.event_type}${event.session_id ? ` (${event.session_id})` : ""}`));
  }
  if (result.command_events.length) {
    lines.push("", "## Command events", ...result.command_events.map((event) => `- ${event.command}${event.session_id ? ` (${event.session_id})` : ""}`));
  }

  return lines.join("\n");
}
