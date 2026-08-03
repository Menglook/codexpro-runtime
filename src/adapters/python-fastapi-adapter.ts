import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess as runManagedProcess } from "../runtime/processWrapper.js";

export type PythonToolSafety = "read" | "run";

export interface PythonToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface PythonToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: PythonToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<PythonToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;
type PythonManager = "uv" | "poetry" | "pip";

interface ProjectCwd {
  absPath: string;
  relPath: string;
}

interface PythonProjectInfo {
  cwd: string;
  package_manager: PythonManager;
  package_manager_source: string;
  primary_language: "Python";
  frameworks: string[];
  manifests: string[];
  test_config: string[];
  entrypoints: string[];
  route_files: string[];
  has_fastapi: boolean;
  has_pytest: boolean;
  has_alembic: boolean;
  suggested_test_command: { name: string; command: string; cwd: string; timeout_ms: number } | null;
  risk_paths: string[];
  dependency_hints: string[];
}

interface PythonRunResult {
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

interface FastApiRoute {
  method: string;
  path: string;
  source: string;
  line: number;
  handler?: string;
  owner: string;
}

const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_ROUTE_FILE_BYTES = 300_000;
const DEFAULT_OUTPUT_BYTES = 80_000;
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "poetry.lock", "uv.lock"];
const PYTHON_TEST_CONFIG = ["pytest.ini", "tox.ini", "noxfile.py", "conftest.py"];
const PYTHON_ENTRYPOINTS = ["app/main.py", "main.py", "src/main.py", "backend/app/main.py", "backend/main.py"];
const PYTHON_ROUTE_DIRS = ["app", "src", "backend/app", "api"];
const RISK_PATHS = ["alembic.ini", "migrations", "alembic", "db", "database", "mysql", "mysql-data", "db_data"];
const SAFE_TEST_TARGET_PATTERN = /^[A-Za-z0-9._/@:-]+$/;
const SAFE_KEYWORD_PATTERN = /^[A-Za-z0-9_ .:-]+$/;
const ROUTE_DECORATOR_PATTERN = /^\s*@(?:(\w+)\.)?(get|post|put|delete|patch|options|head|api_route|websocket)\(\s*(["'`])([^"'`]+)\3/;
const HANDLER_PATTERN = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function cwdArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Directory inside the workspace that contains Python manifests or FastAPI files. Default: workspace root.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function normalizeRelPath(value: string): string {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized || ".";
}

function relFromWorkspace(workspace: Workspace, absPath: string): string {
  return normalizeRelPath(path.relative(workspace.root, absPath));
}

function joinRel(base: string, child: string): string {
  const normalizedBase = normalizeRelPath(base);
  const normalizedChild = child.split(path.sep).join("/").replace(/^\.\//, "");
  return normalizedBase === "." ? normalizedChild : `${normalizedBase}/${normalizedChild}`;
}

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function readTextIfSmall(absPath: string, maxBytes = MAX_TEXT_FILE_BYTES): string | undefined {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveProjectCwd(guard: PathGuard, workspace: Workspace, cwdInput?: string): ProjectCwd {
  const resolved = guard.resolve(workspace, cwdInput ?? ".");
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isDirectory()) throw new CodexProError(`Python cwd is not a directory: ${resolved.relPath}`);
  return { absPath: resolved.absPath, relPath: normalizeRelPath(resolved.relPath) };
}

function collectExisting(cwd: ProjectCwd, candidates: string[]): string[] {
  return candidates.filter((candidate) => fileExists(path.join(cwd.absPath, candidate)) || dirExists(path.join(cwd.absPath, candidate))).map((candidate) => joinRel(cwd.relPath, candidate));
}

function manifestText(cwd: ProjectCwd): string {
  const parts: string[] = [];
  for (const rel of ["pyproject.toml", "requirements.txt", "requirements-dev.txt"]) {
    const raw = readTextIfSmall(path.join(cwd.absPath, rel));
    if (raw) parts.push(raw.toLowerCase());
  }
  return parts.join("\n");
}

function detectPackageManager(cwd: ProjectCwd): { packageManager: PythonManager; source: string } {
  if (fileExists(path.join(cwd.absPath, "uv.lock"))) return { packageManager: "uv", source: "uv.lock" };
  const pyproject = readTextIfSmall(path.join(cwd.absPath, "pyproject.toml"))?.toLowerCase() ?? "";
  if (/\[tool\.uv\]/.test(pyproject)) return { packageManager: "uv", source: "pyproject.toml [tool.uv]" };
  if (fileExists(path.join(cwd.absPath, "poetry.lock")) || /\[tool\.poetry\]/.test(pyproject)) return { packageManager: "poetry", source: fileExists(path.join(cwd.absPath, "poetry.lock")) ? "poetry.lock" : "pyproject.toml [tool.poetry]" };
  return { packageManager: "pip", source: fileExists(path.join(cwd.absPath, "requirements.txt")) ? "requirements.txt" : "Python fallback" };
}

function detectFrameworks(text: string, routeFiles: string[], manifests: string[], testConfig: string[]): string[] {
  const frameworks = new Set<string>();
  if (/\bfastapi\b/.test(text) || routeFiles.length) frameworks.add("FastAPI");
  if (/\buvicorn\b/.test(text)) frameworks.add("Uvicorn");
  if (/\bpytest\b/.test(text) || testConfig.some((file) => file.endsWith("pytest.ini") || file.endsWith("conftest.py"))) frameworks.add("pytest");
  if (/\balembic\b/.test(text) || manifests.some((file) => file.endsWith("alembic.ini"))) frameworks.add("Alembic");
  if (/\bsqlalchemy\b/.test(text)) frameworks.add("SQLAlchemy");
  if (/\bpydantic\b/.test(text)) frameworks.add("Pydantic");
  return [...frameworks];
}

function dependencyHints(text: string): string[] {
  const hints = ["fastapi", "uvicorn", "pytest", "alembic", "sqlalchemy", "pydantic", "httpx", "requests", "celery", "redis", "psycopg", "asyncpg"];
  return hints.filter((hint) => new RegExp(`\\b${hint}\\b`).test(text));
}

function walkPythonFiles(absDir: string, workspace: Workspace, out: string[], maxFiles: number, depth: number): void {
  if (out.length >= maxFiles || depth < 0 || !dirExists(absDir)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    if (entry.name.startsWith(".") || ["__pycache__", ".venv", "venv", "env", "node_modules"].includes(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkPythonFiles(absPath, workspace, out, maxFiles, depth - 1);
    } else if (entry.isFile() && entry.name.endsWith(".py")) {
      out.push(relFromWorkspace(workspace, absPath));
    }
  }
}

function discoverRouteFiles(workspace: Workspace, cwd: ProjectCwd, maxFiles = 80): string[] {
  const found = new Set<string>();
  for (const rel of PYTHON_ENTRYPOINTS) {
    const absPath = path.join(cwd.absPath, rel);
    if (fileExists(absPath)) found.add(joinRel(cwd.relPath, rel));
  }
  for (const dir of PYTHON_ROUTE_DIRS) {
    walkPythonFiles(path.join(cwd.absPath, dir), workspace, [...found], 0, 0);
    const files: string[] = [];
    walkPythonFiles(path.join(cwd.absPath, dir), workspace, files, maxFiles, 4);
    for (const file of files) found.add(file);
  }
  return [...found].sort().slice(0, maxFiles);
}

function inspectPythonProject(guard: PathGuard, workspace: Workspace, cwdInput?: string): PythonProjectInfo {
  const cwd = resolveProjectCwd(guard, workspace, cwdInput);
  const manifests = collectExisting(cwd, PYTHON_MANIFESTS);
  const testConfig = collectExisting(cwd, PYTHON_TEST_CONFIG);
  const entrypoints = collectExisting(cwd, PYTHON_ENTRYPOINTS);
  const routeFiles = discoverRouteFiles(workspace, cwd);
  const text = manifestText(cwd);
  const manager = detectPackageManager(cwd);
  const riskPaths = collectExisting(cwd, RISK_PATHS);
  const frameworks = detectFrameworks(text, routeFiles, [...manifests, ...riskPaths], testConfig);
  const hasPytest = frameworks.includes("pytest") || testConfig.length > 0 || dirExists(path.join(cwd.absPath, "tests"));
  const hasFastapi = frameworks.includes("FastAPI");
  const command = commandForTests(manager.packageManager, null, null).join(" ");
  return {
    cwd: cwd.relPath,
    package_manager: manager.packageManager,
    package_manager_source: manager.source,
    primary_language: "Python",
    frameworks,
    manifests,
    test_config: testConfig,
    entrypoints,
    route_files: routeFiles,
    has_fastapi: hasFastapi,
    has_pytest: hasPytest,
    has_alembic: frameworks.includes("Alembic") || riskPaths.some((file) => file.endsWith("alembic.ini") || file.endsWith("alembic")),
    suggested_test_command: hasPytest ? { name: "pytest", command, cwd: cwd.relPath, timeout_ms: 120_000 } : null,
    risk_paths: riskPaths,
    dependency_hints: dependencyHints(text)
  };
}

function commandForTests(manager: PythonManager, target: string | null, keyword: string | null): string[] {
  const base = manager === "uv"
    ? ["uv", "run", "pytest"]
    : manager === "poetry"
      ? ["poetry", "run", "pytest"]
      : [process.platform === "win32" ? "python.exe" : "python", "-m", "pytest"];
  if (target) base.push(target);
  if (keyword) base.push("-k", keyword);
  return base;
}

function displayCommand(args: string[]): string {
  return args.join(" ");
}

function assertSafeTarget(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!SAFE_TEST_TARGET_PATTERN.test(normalized)) throw new CodexProError("Invalid pytest target. Use a workspace-relative test path without shell characters.");
  if (normalized.includes("..")) throw new CodexProError("Invalid pytest target. Parent directory traversal is not allowed.");
  return normalized;
}

function assertSafeKeyword(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim();
  if (!SAFE_KEYWORD_PATTERN.test(normalized)) throw new CodexProError("Invalid pytest keyword expression. Use letters, numbers, spaces, underscore, dash, dot, or colon only.");
  return normalized;
}

function maxOutputBytes(config: CodexProConfig): number {
  return Math.max(1_000, Math.min(config.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 200_000));
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = config.inheritEnv
    ? { ...process.env }
    : {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? "",
        SHELL: process.env.SHELL ?? "/bin/bash",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TERM: "dumb"
      };
  return {
    ...base,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: base.CI ?? "1",
    CODEXPRO_PYTHON_ADAPTER: "1"
  };
}

function assertPythonRunAllowed(config: CodexProConfig, sessionId?: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("python_run_tests is disabled because CODEXPRO_BASH_MODE=off. Enable bash/shell execution to run pytest checks.");
  }
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    return;
  }
  if (!requested) {
    if (config.requireBashSession) throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    return;
  }
  if (requested !== config.bashSessionId) throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
}

async function runPythonCommand(config: CodexProConfig, workspace: Workspace, cwd: ProjectCwd, args: string[], timeoutMs: number): Promise<PythonRunResult> {
  const [executable, ...rest] = args;
  const started = Date.now();
  const outputLimit = maxOutputBytes(config);
  const timeout = Math.max(1_000, Math.min(timeoutMs, 180_000));
  const result = await runManagedProcess(executable, rest, {
    cwd: cwd.absPath,
    env: makeEnv(config),
    timeoutMs: timeout,
    killGraceMs: 1_500,
    maxOutputBytes: outputLimit,
    domain: "adapter",
    operation: "python_command",
    sideEffectLevel: "local_read",
    riskLevel: "low"
  });
  const stderr = result.timedOut
    ? `${result.stderr}\n[codexpro] Python command timed out after ${timeout} ms.`
    : result.stderr;
  const out = trimOutput(redactSensitiveText(result.stdout), outputLimit);
  const err = trimOutput(redactSensitiveText(stderr), outputLimit);
  return {
    command: displayCommand(args),
    cwd: cwd.relPath,
    durationMs: result.durationMs || Date.now() - started,
    stdout: out.value,
    stderr: err.value,
    truncated: out.truncated || err.truncated || result.truncated,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.spawnError ? { spawnError: result.stderr || result.errorClass || "spawn failed" } : {})
  };
}

function nextHandler(lines: string[], startIndex: number): string | undefined {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 8); index += 1) {
    const match = lines[index]?.match(HANDLER_PATTERN);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function extractRoutesFromFile(workspace: Workspace, relPath: string): FastApiRoute[] {
  const absPath = path.join(workspace.root, relPath);
  const raw = readTextIfSmall(absPath, MAX_ROUTE_FILE_BYTES);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const routes: FastApiRoute[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(ROUTE_DECORATOR_PATTERN);
    if (!match) continue;
    routes.push({
      owner: match[1] ?? "app/router",
      method: match[2].toUpperCase(),
      path: match[4],
      source: relPath,
      line: index + 1,
      handler: nextHandler(lines, index)
    });
  }
  return routes;
}

export function pythonFastApiToolNames(): string[] {
  return ["python_project_info", "python_run_tests", "fastapi_route_map"];
}

export function createPythonFastApiTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): PythonToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const cwdFor = (args: any) => resolveProjectCwd(guard, workspaceFor(args), args.cwd);
  const projectInfoFor = (args: any) => inspectPythonProject(guard, workspaceFor(args), args.cwd);

  return [
    {
      name: "python_project_info",
      title: "Python Project Info",
      description: "Inspect Python/FastAPI project manifests, package manager signals, pytest/Alembic markers, entrypoints, route files, and safe test command suggestions without running code.",
      inputSchema: { workspace_id: workspaceArg(), cwd: cwdArg() },
      safety: "read",
      invoking: "Inspecting Python project info...",
      invoked: "Python project info ready",
      async handler(args) {
        const info = projectInfoFor(args);
        const text = [
          "# Python Project Info",
          "",
          `CWD: ${info.cwd}`,
          `Package manager: ${info.package_manager} (${info.package_manager_source})`,
          `Frameworks: ${info.frameworks.length ? info.frameworks.join(", ") : "n/a"}`,
          `FastAPI: ${info.has_fastapi ? "yes" : "no"}`,
          `pytest: ${info.has_pytest ? "yes" : "no"}`,
          `Alembic risk marker: ${info.has_alembic ? "yes" : "no"}`,
          `Suggested test command: ${info.suggested_test_command?.command ?? "n/a"}`,
          `Risk paths: ${info.risk_paths.length ? info.risk_paths.join(", ") : "none"}`,
          formatJsonBlock(info)
        ].join("\n");
        return { text, structured: { ...info } };
      }
    },
    {
      name: "python_run_tests",
      title: "Python Run Tests",
      description: "Run one pytest-style validation command through uv, Poetry, or python -m pytest. It accepts only bounded structured args and never runs Alembic/database migrations by default.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        target: z.string().optional().describe("Optional workspace-relative pytest target such as tests/ or tests/test_api.py."),
        keyword: z.string().optional().describe("Optional safe pytest -k keyword expression."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Command timeout. Default: 120000."),
        session_id: z.string().optional().describe("Optional bash session id when this server requires one.")
      },
      safety: "run",
      invoking: "Running Python tests...",
      invoked: "Python tests complete",
      async handler(args) {
        assertPythonRunAllowed(config, args.session_id);
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const info = inspectPythonProject(guard, workspace, args.cwd);
        const target = assertSafeTarget(args.target);
        const keyword = assertSafeKeyword(args.keyword);
        const command = commandForTests(info.package_manager, target, keyword);
        const result = await runPythonCommand(config, workspace, cwd, command, args.timeout_ms ?? 120_000);
        const text = [
          "# Python Run Tests",
          "",
          `Package manager: ${info.package_manager} (${info.package_manager_source})`,
          `Command: \`${result.command}\``,
          `CWD: ${result.cwd}`,
          `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
          result.spawnError ? `Spawn error: ${result.spawnError}` : "",
          `Duration: ${result.durationMs} ms`,
          result.truncated ? "Output: truncated" : "Output: complete",
          "",
          "## stdout",
          "",
          "```text",
          result.stdout || "",
          "```",
          result.stderr ? ["", "## stderr", "", "```text", result.stderr, "```"].join("\n") : ""
        ].filter(Boolean).join("\n");
        return { text, structured: { project: info, target, keyword, result, status: result.exitCode === 0 ? "pass" : "fail" } };
      }
    },
    {
      name: "fastapi_route_map",
      title: "FastAPI Route Map",
      description: "Statically scan bounded Python files for FastAPI/APIRouter route decorators and return method/path/source/handler without importing or executing application code.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        max_files: z.number().int().min(1).max(120).optional().describe("Maximum Python files to scan. Default: 80.")
      },
      safety: "read",
      invoking: "Building FastAPI route map...",
      invoked: "FastAPI route map ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const info = inspectPythonProject(guard, workspace, args.cwd);
        const files = info.route_files.slice(0, args.max_files ?? 80);
        const routes = files.flatMap((file) => extractRoutesFromFile(workspace, file));
        const text = [
          "# FastAPI Route Map",
          "",
          `Files scanned: ${files.length}`,
          `Routes detected: ${routes.length}`,
          routes.length ? formatJsonBlock(routes) : "No FastAPI-style route decorators detected."
        ].join("\n");
        return { text, structured: { files_scanned: files, routes, project: info } };
      }
    }
  ];
}
