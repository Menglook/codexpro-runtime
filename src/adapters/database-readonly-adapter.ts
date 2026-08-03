import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess as runManagedProcess } from "../runtime/processWrapper.js";

export type DatabaseDriver = "sqlite" | "postgres" | "mysql";
export type DatabaseToolSafety = "read";

export interface DatabaseToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface DatabaseToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: DatabaseToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<DatabaseToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

interface SqlPolicyDecision {
  allowed: boolean;
  operation?: string;
  reason?: string;
  normalized: string;
}

interface DatabaseConnection {
  driver: DatabaseDriver;
  display: string;
  url?: string;
  sqlitePath?: { absPath: string; relPath: string };
  secrets: string[];
}

interface ProcessRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  spawnError?: string;
}

interface QueryExecutionResult extends ProcessRunResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  row_count?: number;
  rows_truncated?: boolean;
}

const READONLY_OPERATIONS = new Set(["SELECT", "SHOW", "EXPLAIN"]);
const FORBIDDEN_SQL_PATTERN = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER|CREATE|GRANT|REVOKE|MERGE|CALL|EXEC|EXECUTE|COPY|ATTACH|DETACH|REINDEX|VACUUM)\b/i;
const DANGEROUS_READ_PATTERN = /\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 100;
const SQLITE_PYTHON = process.env.CODEXPRO_DATABASE_SQLITE_PYTHON || "python3";

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function driverArg(): z.ZodDefault<z.ZodEnum<["sqlite", "postgres", "mysql"]>> {
  return z.enum(["sqlite", "postgres", "mysql"]).default("sqlite").describe("Database driver. sqlite uses a workspace-relative database file; postgres/mysql use a connection URL from an environment variable or redacted inline database_url.");
}

function sqlitePathArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace-relative SQLite database path. Required when driver=sqlite.");
}

function connectionEnvArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Environment variable name containing a postgres/mysql connection URL. Preferred over database_url so passwords are never placed in prompts or logs.");
}

function databaseUrlArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Optional postgres/mysql connection URL. Prefer connection_env. The adapter never echoes this value and redacts URL passwords from output.");
}

function maxRowsArg(defaultValue = DEFAULT_MAX_ROWS): z.ZodDefault<z.ZodOptional<z.ZodNumber>> {
  return z.number().int().min(1).max(500).optional().default(defaultValue).describe("Maximum rows/objects to return. Default: 100; max: 500.");
}

function timeoutArg(): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1000).max(120000).optional().describe("Query timeout in milliseconds. Default: 30000.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/#[^\r\n]*/g, " ");
}

function trimTrailingStatementTerminator(sql: string): string {
  return sql.trim().replace(/;+\s*$/g, "").trim();
}

export function classifyReadOnlySql(sql: string): SqlPolicyDecision {
  const withoutComments = stripSqlComments(sql);
  const normalized = trimTrailingStatementTerminator(withoutComments).replace(/\s+/g, " ").trim();
  if (!normalized) return { allowed: false, reason: "SQL is empty.", normalized };
  if (normalized.includes(";")) return { allowed: false, reason: "Only one SQL statement is allowed.", normalized };
  if (FORBIDDEN_SQL_PATTERN.test(normalized)) return { allowed: false, reason: "SQL contains a forbidden write or DDL keyword.", normalized };
  if (DANGEROUS_READ_PATTERN.test(normalized)) return { allowed: false, reason: "SQL contains a dangerous read-side clause.", normalized };

  const operation = normalized.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (!operation || !READONLY_OPERATIONS.has(operation)) {
    return { allowed: false, operation, reason: "Only SELECT, SHOW, and EXPLAIN statements are allowed.", normalized };
  }
  return { allowed: true, operation, normalized };
}

export function assertReadOnlySql(sql: string): SqlPolicyDecision {
  const decision = classifyReadOnlySql(sql);
  if (!decision.allowed) {
    throw new CodexProError(`Database Read-only Adapter refused SQL: ${decision.reason}`);
  }
  return decision;
}

function normalizeRelPath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "") || ".";
}

function assertEnvName(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ENV_NAME_PATTERN.test(value)) {
    throw new CodexProError("connection_env must be a simple environment variable name.");
  }
  return value;
}

function resolveSqliteConnection(guard: PathGuard, workspace: Workspace, sqlitePath: unknown): DatabaseConnection {
  if (typeof sqlitePath !== "string" || !sqlitePath.trim()) {
    throw new CodexProError("sqlite_path is required when driver=sqlite.");
  }
  const resolved = guard.resolve(workspace, sqlitePath.trim());
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isFile()) throw new CodexProError(`SQLite database path is not a file: ${resolved.relPath}`);
  return {
    driver: "sqlite",
    display: `workspace:${normalizeRelPath(resolved.relPath)}`,
    sqlitePath: { absPath: resolved.absPath, relPath: normalizeRelPath(resolved.relPath) },
    secrets: []
  };
}

function assertConnectionUrl(driver: DatabaseDriver, raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CodexProError(`${driver} database URL is invalid.`);
  }
  const allowedProtocols = driver === "postgres" ? new Set(["postgres:", "postgresql:"]) : new Set(["mysql:", "mariadb:"]);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new CodexProError(`${driver} database URL must use one of: ${[...allowedProtocols].join(", ")}`);
  }
  return parsed;
}

function resolveUrlConnection(driver: DatabaseDriver, args: any): DatabaseConnection {
  const connectionEnv = assertEnvName(args.connection_env);
  const inlineUrl = typeof args.database_url === "string" && args.database_url.trim() ? args.database_url.trim() : undefined;
  if (connectionEnv && inlineUrl) throw new CodexProError("Use either connection_env or database_url, not both.");
  if (!connectionEnv && !inlineUrl) throw new CodexProError(`${driver} requires connection_env or database_url.`);

  const rawUrl = connectionEnv ? process.env[connectionEnv] : inlineUrl;
  if (!rawUrl || !rawUrl.trim()) throw new CodexProError(`Database URL was not found in ${connectionEnv ? `env:${connectionEnv}` : "database_url"}.`);
  const url = rawUrl.trim();
  const parsed = assertConnectionUrl(driver, url);
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  return {
    driver,
    display: connectionEnv ? `env:${connectionEnv}` : "database_url:[REDACTED]",
    url,
    secrets: [url, password].filter((item): item is string => Boolean(item))
  };
}

function resolveDatabaseConnection(guard: PathGuard, workspace: Workspace, args: any): DatabaseConnection {
  const driver = (args.driver ?? "sqlite") as DatabaseDriver;
  if (driver === "sqlite") return resolveSqliteConnection(guard, workspace, args.sqlite_path);
  if (driver === "postgres" || driver === "mysql") return resolveUrlConnection(driver, args);
  throw new CodexProError(`Unsupported database driver: ${String(args.driver)}`);
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return { value: current, truncated: true };
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return { value: next, truncated: false };
  let value = current;
  for (const char of chunk.toString("utf8")) {
    if (Buffer.byteLength(value + char, "utf8") > maxBytes) return { value, truncated: true };
    value += char;
  }
  return { value, truncated: false };
}

async function runProcess(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number; secrets?: string[] }): Promise<ProcessRunResult> {
  const started = Date.now();
  const result = await runManagedProcess(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    secrets: options.secrets,
    domain: "adapter",
    operation: "database_readonly",
    sideEffectLevel: "local_read",
    riskLevel: "low"
  });
  const secrets = options.secrets ?? [];
  return {
    command,
    cwd: options.cwd,
    exitCode: result.exitCode,
    signal: result.timedOut ? "SIGTERM" : result.signal,
    durationMs: result.durationMs || Date.now() - started,
    stdout: redactDatabaseText(result.stdout, secrets),
    stderr: result.timedOut
      ? `${redactDatabaseText(result.stderr, secrets)}\nProcess timed out after ${options.timeoutMs} ms.`.trim()
      : redactDatabaseText(result.stderr, secrets),
    truncated: result.truncated,
    spawnError: result.spawnError ? redactDatabaseText(result.stderr || result.errorClass || "spawn failed", secrets) : undefined
  };
}

function redactDatabaseText(input: string, secrets: string[] = []): string {
  let out = input;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(secret.includes("://") ? "[REDACTED_DATABASE_URL]" : "[REDACTED]");
  }
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/?#]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
  return redactSensitiveText(out);
}

function isSensitiveColumn(column: string): boolean {
  return /(pass(word)?|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|session|cookie|credential|auth|jwt|refresh|bearer)/i.test(column);
}

function maskEmail(value: string): string {
  return value.replace(/\b([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, (_match, prefix: string, domain: string) => `${prefix}***@${domain}`);
}

function redactDatabaseValue(value: unknown, column?: string): unknown {
  if (column && isSensitiveColumn(column)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactDatabaseValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDatabaseValue(item, key);
    return out;
  }
  const raw = String(value);
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(raw)) return "[REDACTED]";
  let redacted = maskEmail(redactDatabaseText(raw));
  if (redacted.length > 800) redacted = `${redacted.slice(0, 800)}...[truncated]`;
  return redacted;
}

export function redactDatabaseRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[key] = redactDatabaseValue(value, key);
    return out;
  });
}

function parseSqliteJson(stdout: string): Pick<QueryExecutionResult, "columns" | "rows" | "row_count" | "rows_truncated"> | undefined {
  try {
    const parsed = JSON.parse(stdout) as { columns?: unknown; rows?: unknown; row_count?: unknown; truncated?: unknown };
    const columns = Array.isArray(parsed.columns) ? parsed.columns.filter((item): item is string => typeof item === "string") : [];
    const rawRows = Array.isArray(parsed.rows) ? parsed.rows.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    const rows = redactDatabaseRows(rawRows);
    return {
      columns,
      rows,
      row_count: typeof parsed.row_count === "number" ? parsed.row_count : rows.length,
      rows_truncated: parsed.truncated === true
    };
  } catch {
    return undefined;
  }
}

async function runSqliteQuery(config: CodexProConfig, workspace: Workspace, connection: DatabaseConnection, sql: string, maxRows: number, timeoutMs: number): Promise<QueryExecutionResult> {
  if (!connection.sqlitePath) throw new CodexProError("SQLite connection was not resolved.");
  const script = [
    "import json, sqlite3, sys",
    "db_path, sql, max_rows = sys.argv[1], sys.argv[2], int(sys.argv[3])",
    "def safe(value):",
    "    if isinstance(value, bytes):",
    "        return {'type': 'bytes', 'length': len(value)}",
    "    return value",
    "conn = sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)",
    "conn.row_factory = sqlite3.Row",
    "conn.execute('PRAGMA query_only = ON')",
    "cur = conn.execute(sql)",
    "columns = [item[0] for item in cur.description] if cur.description else []",
    "rows = []",
    "if columns:",
    "    for row in cur.fetchmany(max_rows + 1):",
    "        rows.append({key: safe(row[key]) for key in row.keys()})",
    "truncated = len(rows) > max_rows",
    "if truncated:",
    "    rows = rows[:max_rows]",
    "print(json.dumps({'columns': columns, 'rows': rows, 'row_count': len(rows), 'truncated': truncated}, ensure_ascii=False))"
  ].join("\n");
  const result = await runProcess(SQLITE_PYTHON, ["-c", script, connection.sqlitePath.absPath, sql, String(maxRows)], {
    cwd: workspace.root,
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    secrets: connection.secrets
  });
  const parsed = result.exitCode === 0 ? parseSqliteJson(result.stdout) : undefined;
  return { ...result, ...(parsed ?? {}) };
}

async function runPostgresQuery(config: CodexProConfig, workspace: Workspace, connection: DatabaseConnection, sql: string, timeoutMs: number): Promise<QueryExecutionResult> {
  if (!connection.url) throw new CodexProError("Postgres connection URL was not resolved.");
  const args = ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--csv", connection.url, "--command", sql];
  return await runProcess("psql", args, {
    cwd: workspace.root,
    env: process.env,
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    secrets: connection.secrets
  });
}

async function runMysqlQuery(config: CodexProConfig, workspace: Workspace, connection: DatabaseConnection, sql: string, timeoutMs: number): Promise<QueryExecutionResult> {
  if (!connection.url) throw new CodexProError("MySQL connection URL was not resolved.");
  const parsed = assertConnectionUrl("mysql", connection.url);
  const args = ["--batch", "--raw", "--protocol=TCP"];
  if (parsed.hostname) args.push("--host", parsed.hostname);
  if (parsed.port) args.push("--port", parsed.port);
  if (parsed.username) args.push("--user", decodeURIComponent(parsed.username));
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database) args.push("--database", database);
  args.push("--execute", sql);
  const env = { ...process.env };
  if (parsed.password) env.MYSQL_PWD = decodeURIComponent(parsed.password);
  return await runProcess("mysql", args, {
    cwd: workspace.root,
    env,
    timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    secrets: connection.secrets
  });
}

async function executeReadonlyQuery(config: CodexProConfig, workspace: Workspace, connection: DatabaseConnection, sql: string, maxRows: number, timeoutMs: number): Promise<QueryExecutionResult> {
  if (connection.driver === "sqlite") return await runSqliteQuery(config, workspace, connection, sql, maxRows, timeoutMs);
  if (connection.driver === "postgres") return await runPostgresQuery(config, workspace, connection, sql, timeoutMs);
  return await runMysqlQuery(config, workspace, connection, sql, timeoutMs);
}

function schemaSqlFor(driver: DatabaseDriver): string {
  if (driver === "sqlite") {
    return "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";
  }
  if (driver === "postgres") {
    return "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position";
  }
  return "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position";
}

function formatExecutionText(title: string, connection: DatabaseConnection, policy: SqlPolicyDecision, result: QueryExecutionResult, details: Record<string, unknown>): string {
  const outputLines = [
    `# ${title}`,
    "",
    `Driver: ${connection.driver}`,
    `Connection: ${connection.display}`,
    `Operation: ${policy.operation ?? "n/a"}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    result.spawnError ? `Spawn error: ${result.spawnError}` : "",
    `Duration: ${result.durationMs} ms`,
    result.truncated ? "Output: truncated" : "Output: complete"
  ].filter(Boolean);

  if (result.rows) {
    outputLines.push(`Rows returned: ${result.row_count ?? result.rows.length}${result.rows_truncated ? " (truncated)" : ""}`);
    outputLines.push(formatJsonBlock({ ...details, columns: result.columns ?? [], rows: result.rows, row_count: result.row_count ?? result.rows.length, truncated: result.rows_truncated === true }));
  } else if (result.stdout) {
    outputLines.push("", "## stdout", "", "```text", result.stdout, "```");
  }
  if (result.stderr) outputLines.push("", "## stderr", "", "```text", result.stderr, "```");
  return outputLines.join("\n");
}

function structuredExecution(connection: DatabaseConnection, policy: SqlPolicyDecision, result: QueryExecutionResult, details: Record<string, unknown>): Record<string, unknown> {
  return {
    status: result.exitCode === 0 ? "pass" : "fail",
    driver: connection.driver,
    connection: connection.display,
    operation: policy.operation,
    ...details,
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      truncated: result.truncated,
      spawnError: result.spawnError,
      stdout: result.rows ? undefined : result.stdout,
      stderr: result.stderr,
      columns: result.columns,
      rows: result.rows,
      row_count: result.row_count,
      rows_truncated: result.rows_truncated
    }
  };
}

export function databaseReadonlyToolNames(): string[] {
  return ["database_readonly_query", "database_schema_summary"];
}

export function createDatabaseReadonlyTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): DatabaseToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const connectionFor = (args: any) => resolveDatabaseConnection(guard, workspaceFor(args), args);

  return [
    {
      name: "database_readonly_query",
      title: "Database Read-only Query",
      description: "Execute one read-only SQL statement for local database audit. Only SELECT, SHOW, and EXPLAIN are allowed; write/DDL SQL is rejected and result rows are redacted.",
      inputSchema: {
        workspace_id: workspaceArg(),
        driver: driverArg(),
        sqlite_path: sqlitePathArg(),
        connection_env: connectionEnvArg(),
        database_url: databaseUrlArg(),
        sql: z.string().min(1).max(12000).describe("Single SQL statement. Only SELECT, SHOW, and EXPLAIN are allowed."),
        max_rows: maxRowsArg(),
        timeout_ms: timeoutArg()
      },
      safety: "read",
      invoking: "Running read-only database query...",
      invoked: "Read-only database query complete",
      async handler(args) {
        const workspace = workspaceFor(args);
        const connection = connectionFor(args);
        const policy = assertReadOnlySql(args.sql);
        const maxRows = Number(args.max_rows ?? DEFAULT_MAX_ROWS);
        const result = await executeReadonlyQuery(config, workspace, connection, policy.normalized, maxRows, args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
        const details = { sql_policy: "SELECT/SHOW/EXPLAIN only", max_rows: maxRows };
        return {
          text: formatExecutionText("Database Read-only Query", connection, policy, result, details),
          structured: structuredExecution(connection, policy, result, details)
        };
      }
    },
    {
      name: "database_schema_summary",
      title: "Database Schema Summary",
      description: "Return a read-only schema summary for SQLite, Postgres, or MySQL without exposing database passwords. Uses system catalog/information_schema SELECT queries only.",
      inputSchema: {
        workspace_id: workspaceArg(),
        driver: driverArg(),
        sqlite_path: sqlitePathArg(),
        connection_env: connectionEnvArg(),
        database_url: databaseUrlArg(),
        max_objects: maxRowsArg(200),
        timeout_ms: timeoutArg()
      },
      safety: "read",
      invoking: "Reading database schema summary...",
      invoked: "Database schema summary ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const connection = connectionFor(args);
        const sql = schemaSqlFor(connection.driver);
        const policy = assertReadOnlySql(sql);
        const maxObjects = Number(args.max_objects ?? 200);
        const result = await executeReadonlyQuery(config, workspace, connection, policy.normalized, maxObjects, args.timeout_ms ?? DEFAULT_TIMEOUT_MS);
        const details = { sql_policy: "internal schema SELECT only", max_objects: maxObjects };
        return {
          text: formatExecutionText("Database Schema Summary", connection, policy, result, details),
          structured: structuredExecution(connection, policy, result, details)
        };
      }
    }
  ];
}
