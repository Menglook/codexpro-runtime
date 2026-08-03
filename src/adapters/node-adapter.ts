import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess as runManagedProcess } from "../runtime/processWrapper.js";

export type NodeToolSafety = "read" | "run";

export interface NodeToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface NodeToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: NodeToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<NodeToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface NodeRunResult {
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

interface PackageContext {
  absPath: string;
  relPath: string;
  manifestAbsPath: string;
  manifestRelPath: string;
}

interface NodePackageInfo {
  package_json_path: string;
  cwd: string;
  name?: string;
  version?: string;
  package_manager: PackageManager;
  package_manager_source: string;
  scripts: Record<string, string>;
  scripts_count: number;
}

interface NodeScriptInfo {
  name: string;
  command: string;
  category: string;
  runnable: boolean;
  recommended: boolean;
  risk_flags: string[];
}

const MAX_PACKAGE_BYTES = 512_000;
const DEFAULT_OUTPUT_BYTES = 80_000;
const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const ALLOWED_SCRIPT_PATTERN = /^(?:test|typecheck|lint|build|check|smoke|browser-smoke|browser-visual-regression|release-gate)(?::[A-Za-z0-9._-]+)*$/;
const RECOMMENDED_SCRIPT_NAMES = [
  "typecheck",
  "lint",
  "build",
  "test",
  "check",
  "smoke",
  "browser-smoke",
  "browser-visual-regression",
  "release-gate",
  "dev",
  "start",
  "start:http",
  "start:stdio"
];
const START_LIKE_SCRIPT_PATTERN = /^(?:dev|start)(?::[A-Za-z0-9._-]+)*$/;
const HIGH_RISK_SCRIPT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "package publish", pattern: /(^|\s)(?:npm|pnpm|yarn|bun)\s+publish\b/ },
  { label: "git push", pattern: /(^|\s)git\s+push\b/ },
  { label: "docker volume removal", pattern: /(^|\s)docker\s+compose\s+down\b(?=.*(?:^|\s)-v(?:\s|$))/ },
  { label: "docker prune", pattern: /(^|\s)docker\s+system\s+prune\b/ },
  { label: "root/home deletion", pattern: /(^|\s)rm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/ }
];

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function cwdArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Directory inside the workspace that contains package.json. Default: workspace root.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function compactOneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function maxOutputBytes(config: CodexProConfig): number {
  return Math.max(1_000, Math.min(config.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 200_000));
}

function joinRelPath(dirRelPath: string, fileName: string): string {
  const dir = dirRelPath.split(path.sep).join("/").replace(/^\.\/?$/, "").replace(/\/$/, "");
  return dir ? `${dir}/${fileName}` : fileName;
}

function resolvePackageCwd(guard: PathGuard, workspace: Workspace, cwdInput?: string): PackageContext {
  const resolved = guard.resolve(workspace, cwdInput ?? ".");
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isDirectory()) throw new CodexProError(`Node cwd is not a directory: ${resolved.relPath}`);
  const manifestAbsPath = path.join(resolved.absPath, "package.json");
  if (!fs.existsSync(manifestAbsPath)) {
    throw new CodexProError(`No package.json found in ${resolved.relPath || "."}. Pass cwd for the directory that owns the Node package manifest.`);
  }
  return {
    ...resolved,
    manifestAbsPath,
    manifestRelPath: joinRelPath(resolved.relPath, "package.json")
  };
}

function parsePackageJson(context: PackageContext): Record<string, unknown> {
  const stat = fs.statSync(context.manifestAbsPath);
  if (!stat.isFile()) throw new CodexProError(`package.json is not a file: ${context.manifestRelPath}`);
  if (stat.size > MAX_PACKAGE_BYTES) throw new CodexProError(`package.json is too large to inspect safely: ${context.manifestRelPath}`);
  const raw = fs.readFileSync(context.manifestAbsPath, "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexProError(`Failed to parse ${context.manifestRelPath}: ${detail}`);
  }
}

function scriptsFromPackageJson(packageJson: Record<string, unknown>): Record<string, string> {
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function packageManagerFromField(value: unknown): PackageManager | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().split("@")[0];
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  return undefined;
}

function detectPackageManager(context: PackageContext, packageJson: Record<string, unknown>): { packageManager: PackageManager; source: string } {
  const lockChecks: Array<{ file: string; manager: PackageManager; source: string }> = [
    { file: "pnpm-lock.yaml", manager: "pnpm", source: "pnpm-lock.yaml" },
    { file: "yarn.lock", manager: "yarn", source: "yarn.lock" },
    { file: "bun.lockb", manager: "bun", source: "bun.lockb" },
    { file: "bun.lock", manager: "bun", source: "bun.lock" },
    { file: "package-lock.json", manager: "npm", source: "package-lock.json" },
    { file: "npm-shrinkwrap.json", manager: "npm", source: "npm-shrinkwrap.json" }
  ];
  for (const check of lockChecks) {
    if (fs.existsSync(path.join(context.absPath, check.file))) return { packageManager: check.manager, source: check.source };
  }
  const fromField = packageManagerFromField(packageJson.packageManager);
  if (fromField) return { packageManager: fromField, source: "packageManager field" };
  return { packageManager: "npm", source: "package.json fallback" };
}

function readNodePackageInfo(guard: PathGuard, workspace: Workspace, cwdInput?: string): NodePackageInfo {
  const packageContext = resolvePackageCwd(guard, workspace, cwdInput);
  const packageJson = parsePackageJson(packageContext);
  const detected = detectPackageManager(packageContext, packageJson);
  return {
    package_json_path: packageContext.manifestRelPath,
    cwd: packageContext.relPath || ".",
    name: typeof packageJson.name === "string" ? packageJson.name : undefined,
    version: typeof packageJson.version === "string" ? packageJson.version : undefined,
    package_manager: detected.packageManager,
    package_manager_source: detected.source,
    scripts: scriptsFromPackageJson(packageJson),
    scripts_count: Object.keys(scriptsFromPackageJson(packageJson)).length
  };
}

function commandForPackageManager(packageManager: PackageManager, script: string): string {
  return `${packageManager} run ${script}`;
}

function scriptCategory(script: string): string {
  if (script === "browser-smoke" || script === "browser-visual-regression") return "smoke";
  const base = script.split(":")[0];
  if (["test", "typecheck", "lint", "build", "check", "smoke", "release-gate"].includes(base)) return base;
  if (START_LIKE_SCRIPT_PATTERN.test(script)) return "start";
  return "other";
}

function isRecommendedScript(script: string): boolean {
  return RECOMMENDED_SCRIPT_NAMES.includes(script) || ALLOWED_SCRIPT_PATTERN.test(script) || START_LIKE_SCRIPT_PATTERN.test(script);
}

export function isAllowedNodeScriptName(script: string): boolean {
  return SCRIPT_NAME_PATTERN.test(script) && ALLOWED_SCRIPT_PATTERN.test(script);
}

function assertSafeScriptName(script: unknown): string {
  const normalized = String(script ?? "").trim();
  if (!normalized) throw new CodexProError("script is required.");
  if (!SCRIPT_NAME_PATTERN.test(normalized)) {
    throw new CodexProError("Invalid package script name. Use only letters, numbers, dots, underscores, dashes, and colons; it must start with a letter or number.");
  }
  return normalized;
}

export function assertAllowedNodeScriptName(script: string): void {
  if (!isAllowedNodeScriptName(script)) {
    throw new CodexProError(
      `Node Adapter refused to run script: ${script}\n` +
        "Only validation-style package scripts are runnable: build/test/lint/typecheck/check/smoke/browser-smoke/browser-visual-regression/release-gate, plus colon suffixes such as build:clients. Long-running dev/start and arbitrary package scripts are listed but not executed."
    );
  }
}

function scriptRiskFlags(command: string): string[] {
  const normalized = compactOneLine(command);
  const flags: string[] = [];
  for (const item of HIGH_RISK_SCRIPT_PATTERNS) {
    if (item.pattern.test(normalized)) flags.push(item.label);
  }
  return flags;
}

function scriptInfos(info: NodePackageInfo): NodeScriptInfo[] {
  return Object.entries(info.scripts)
    .map(([name, command]) => ({
      name,
      command,
      category: scriptCategory(name),
      runnable: isAllowedNodeScriptName(name),
      recommended: isRecommendedScript(name),
      risk_flags: scriptRiskFlags(command)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function packageRecommendations(info: NodePackageInfo): Record<string, string | null> {
  const scripts = new Set(Object.keys(info.scripts));
  const first = (names: string[]) => names.find((name) => scripts.has(name)) ?? null;
  return {
    lint: first(["lint"]),
    build: first(["build"]),
    test: first(["test", "smoke", "check"]),
    typecheck: first(["typecheck"]),
    dev: first(["dev"]),
    start: first(["start", "start:http", "start:stdio"])
  };
}

function allowedScripts(info: NodePackageInfo): string[] {
  return Object.keys(info.scripts).filter(isAllowedNodeScriptName).sort();
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
    npm_config_color: "false"
  };
}

function assertNodeRunAllowed(config: CodexProConfig, sessionId?: string): string | undefined {
  if (config.bashMode === "off") {
    throw new CodexProError("node_run_script is disabled because CODEXPRO_BASH_MODE=off. Enable bash/shell execution to run package scripts.");
  }
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function executableForPackageManager(packageManager: PackageManager): string {
  if (process.platform === "win32") return `${packageManager}.cmd`;
  return packageManager;
}

async function runProcess(
  config: CodexProConfig,
  workspace: Workspace,
  cwd: PackageContext,
  executable: string,
  args: string[],
  timeoutMs: number,
  metadata: { operation?: string; sideEffectLevel?: "local_read" | "local_write"; riskLevel?: "low" | "medium" } = {}
): Promise<NodeRunResult> {
  const started = Date.now();
  const command = `${executable} ${args.join(" ")}`;
  const timeout = Math.max(1_000, Math.min(timeoutMs, 180_000));
  const outputLimit = maxOutputBytes(config);
  const result = await runManagedProcess(executable, args, {
    cwd: cwd.absPath,
    env: makeEnv(config),
    timeoutMs: timeout,
    killGraceMs: 1_500,
    maxOutputBytes: outputLimit,
    domain: "adapter",
    operation: metadata.operation ?? "node_command",
    sideEffectLevel: metadata.sideEffectLevel ?? "local_read",
    riskLevel: metadata.riskLevel ?? "low"
  });
  const stderr = result.timedOut
    ? `${result.stderr}\n[codexpro] Node command timed out after ${timeout} ms.`
    : result.stderr;
  const out = trimOutput(redactSensitiveText(result.stdout), outputLimit);
  const err = trimOutput(redactSensitiveText(stderr), outputLimit);
  return {
    command,
    cwd: path.relative(workspace.root, cwd.absPath) || ".",
    durationMs: result.durationMs || Date.now() - started,
    stdout: out.value,
    stderr: err.value,
    truncated: out.truncated || err.truncated || result.truncated,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.spawnError ? { spawnError: result.stderr || result.errorClass || "spawn failed" } : {})
  };
}

function formatCommandResult(result: NodeRunResult): string[] {
  return [
    `Command: \`${result.command}\``,
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    result.spawnError ? `Spawn error: ${result.spawnError}` : "",
    `Duration: ${result.durationMs} ms`,
    result.truncated ? "Output: truncated" : "Output: complete"
  ].filter(Boolean);
}

async function versionCheck(config: CodexProConfig, workspace: Workspace, cwd: PackageContext, executable: string, args: string[], timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const result = await runProcess(config, workspace, cwd, executable, args, timeoutMs);
  return {
    command: result.command,
    exit_code: result.exitCode,
    ok: result.exitCode === 0,
    version: result.stdout.trim().split(/\r?\n/)[0] || null,
    stderr: result.stderr.trim() || null,
    spawn_error: result.spawnError ?? null
  };
}

export function nodeToolNames(): string[] {
  return ["node_scripts", "node_run_script", "node_healthcheck"];
}

export function createNodeTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): NodeToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const cwdFor = (args: any) => resolvePackageCwd(guard, workspaceFor(args), args.cwd);
  const packageInfoFor = (args: any) => readNodePackageInfo(guard, workspaceFor(args), args.cwd);

  return [
    {
      name: "node_scripts",
      title: "Node Scripts",
      description: "List package.json scripts, detect npm/pnpm/yarn/bun, and show which scripts are recommended or runnable by the Node Adapter.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg()
      },
      safety: "read",
      invoking: "Reading Node package scripts...",
      invoked: "Node package scripts ready",
      async handler(args) {
        const info = packageInfoFor(args);
        const scripts = scriptInfos(info);
        const recommendations = packageRecommendations(info);
        const allowed = allowedScripts(info);
        const text = [
          "# Node Scripts",
          "",
          `Package: ${info.name ?? "(unnamed)"}${info.version ? `@${info.version}` : ""}`,
          `Manifest: ${info.package_json_path}`,
          `Package manager: ${info.package_manager} (${info.package_manager_source})`,
          `Scripts: ${scripts.length}`,
          `Runnable by node_run_script: ${allowed.length ? allowed.join(", ") : "none"}`,
          "",
          "## Recommendations",
          "",
          formatJsonBlock(recommendations),
          "",
          "## Scripts",
          formatJsonBlock(scripts)
        ].join("\n");
        return { text, structured: { ...info, scripts: scripts, recommendations, allowed_scripts: allowed } };
      }
    },
    {
      name: "node_run_script",
      title: "Node Run Script",
      description: "Run one existing validation-style package script through the detected package manager. Allows build/test/lint/typecheck/check/smoke/browser-smoke/release-gate and colon suffixes only; dev/start/arbitrary scripts are blocked.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        script: z.string().describe("Existing package.json script name to run, such as build, test, lint, typecheck, smoke, or build:clients."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Command timeout. Default: 120000."),
        session_id: z.string().optional().describe("Optional bash session id when this server requires one.")
      },
      safety: "run",
      invoking: "Running Node package script...",
      invoked: "Node package script finished",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const info = readNodePackageInfo(guard, workspace, args.cwd);
        const script = assertSafeScriptName(args.script);
        assertNodeRunAllowed(config, args.session_id);
        if (!Object.prototype.hasOwnProperty.call(info.scripts, script)) {
          throw new CodexProError(`package.json script not found: ${script}`);
        }
        assertAllowedNodeScriptName(script);
        const riskFlags = scriptRiskFlags(info.scripts[script]);
        if (riskFlags.length) {
          throw new CodexProError(`Node Adapter refused to run script ${script} because its body matched high-risk operation(s): ${riskFlags.join(", ")}.`);
        }
        const executable = executableForPackageManager(info.package_manager);
        const result = await runProcess(config, workspace, cwd, executable, ["run", script], args.timeout_ms ?? 120_000, {
          operation: `node_run_script:${script}`,
          sideEffectLevel: "local_write",
          riskLevel: "medium"
        });
        const text = [
          "# Node Run Script",
          "",
          `Package manager: ${info.package_manager} (${info.package_manager_source})`,
          `Script: ${script}`,
          `Script body: \`${info.scripts[script]}\``,
          ...formatCommandResult(result),
          "",
          "## stdout",
          "",
          "```text",
          result.stdout || "",
          "```",
          result.stderr ? ["", "## stderr", "", "```text", result.stderr, "```"].join("\n") : ""
        ].filter(Boolean).join("\n");
        return {
          text,
          structured: {
            package_manager: info.package_manager,
            package_manager_source: info.package_manager_source,
            package_json_path: info.package_json_path,
            cwd: info.cwd,
            script,
            script_body: info.scripts[script],
            result,
            acceptance_candidate: ["build", "test", "typecheck", "lint", "check", "smoke", "browser-smoke", "browser-visual-regression", "release-gate"].includes(scriptCategory(script))
          }
        };
      }
    },
    {
      name: "node_healthcheck",
      title: "Node Healthcheck",
      description: "Check Node and detected package-manager availability, summarize package scripts, and report recommended acceptance commands without running project scripts.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        timeout_ms: z.number().int().min(1000).max(30000).optional().describe("Version-check timeout. Default: 10000.")
      },
      safety: "read",
      invoking: "Checking Node package health...",
      invoked: "Node package health ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const info = readNodePackageInfo(guard, workspace, args.cwd);
        const scripts = scriptInfos(info);
        const recommendations = packageRecommendations(info);
        const allowed = allowedScripts(info);
        const versionTimeoutMs = args.timeout_ms ?? 10_000;
        const nodeCheck = await versionCheck(config, workspace, cwd, process.platform === "win32" ? "node.exe" : "node", ["--version"], versionTimeoutMs);
        const packageManagerCheck = await versionCheck(config, workspace, cwd, executableForPackageManager(info.package_manager), ["--version"], versionTimeoutMs);
        const missingRecommended = Object.entries(recommendations).filter(([, value]) => !value).map(([key]) => key);
        const riskScripts = scripts.filter((script) => script.risk_flags.length).map((script) => ({ name: script.name, risk_flags: script.risk_flags }));
        const status = !nodeCheck.ok || !packageManagerCheck.ok
          ? "fail"
          : allowed.length === 0
            ? "warn"
            : "pass";
        const acceptanceCommands = allowed.map((script) => ({ name: script, command: commandForPackageManager(info.package_manager, script), cwd: info.cwd, timeout_ms: 120_000 }));
        const health = {
          status,
          node: nodeCheck,
          package_manager: packageManagerCheck,
          missing_recommended: missingRecommended,
          risk_scripts: riskScripts,
          acceptance_commands: acceptanceCommands
        };
        const text = [
          "# Node Healthcheck",
          "",
          `Status: ${status}`,
          `Manifest: ${info.package_json_path}`,
          `Package manager: ${info.package_manager} (${info.package_manager_source})`,
          `Scripts: ${scripts.length}`,
          `Runnable validation scripts: ${allowed.length ? allowed.join(", ") : "none"}`,
          `Missing recommended groups: ${missingRecommended.length ? missingRecommended.join(", ") : "none"}`,
          `Risk-marked scripts: ${riskScripts.length}`,
          formatJsonBlock(health)
        ].join("\n");
        return { text, structured: { ...info, scripts, recommendations, allowed_scripts: allowed, health } };
      }
    }
  ];
}
