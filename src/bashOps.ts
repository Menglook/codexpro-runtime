import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./runtime/processWrapper.js";
import type { ProcessSideEffectLevel } from "./runtime/processTypes.js";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";
import {
  compileCommandPlan,
  type CommandCategory,
  type CommandExecutionPlan,
  type CommandResourceProfile,
  type CommandSafetyOptions,
  type CommandSafetyPrincipal,
  type CommandSafetyScope,
  type CommandTestScope
} from "./workflow/commandSafetyPolicy.js";
import { parseCommandToIR, type CommandSegmentIR } from "./workflow/commandIr.js";

export interface BashResult {
  command: string;
  requestedCommand?: string;
  effectiveCommand?: string;
  rewriteReason?: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  spawnAttempted: boolean;
  processStarted: boolean;
  blockedBeforeSpawn?: boolean;
  bashSessionId?: string;
  blocked?: boolean;
  reason?: string;
  suggestion?: string;
  category?: CommandCategory;
  policyLayer?: "cpu_resource_policy" | "bash_allowlist";
  policyRule?: string;
  principal?: CommandSafetyPrincipal;
  resourceProfile?: CommandResourceProfile;
  testScope?: CommandTestScope;
  cancelled?: boolean;
  timedOut?: boolean;
  resourceWaitTimedOut?: boolean;
  treeTerminated?: boolean;
}

export interface BashRunOptions {
  cwd?: string;
  timeoutMs?: number;
  sessionId?: string;
  safety?: CommandSafetyOptions;
  requestedCommand?: string;
  rewriteReason?: string;
  returnPolicyBlocks?: boolean;
  allowTargetedSmokeScript?: boolean;
  allowFrozenValidationCommand?: boolean;
  taskId?: string;
  runId?: string;
  stepId?: string;
  signal?: AbortSignal;
  commandPlan?: CommandExecutionPlan;
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check"
];

const SAFE_SHELL_OPERATOR_PATTERN = /[;&|<>`]/;

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  SAFE_SHELL_OPERATOR_PATTERN,
  /[\r\n]/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isTargetedSmokeScript(command: string): boolean {
  return /^node\s+scripts\/[A-Za-z0-9._-]+-smoke\.mjs$/.test(compact(command));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern = /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check|smoke|browser-smoke|browser-visual-regression|release-gate)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:=,|>/-]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(
  config: CodexProConfig,
  command: string,
  options: { allowTargetedSmokeScript?: boolean; allowFrozenValidationCommand?: boolean } = {}
): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (
    !startsWithAllowedPrefix(normalized)
    && !(options.allowTargetedSmokeScript && isTargetedSmokeScript(normalized))
    && !options.allowFrozenValidationCommand
  ) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
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

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" };
  }
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    SHELL: process.env.SHELL ?? "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
}

function bashExecutable(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

interface SafeCommandStep {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  display: string;
}

function commandDisplay(command: string, args: string[]): string {
  return [command, ...args].map((value) => (/^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value))).join(" ");
}

function parseEnvAssignments(segment: CommandSegmentIR): { env: NodeJS.ProcessEnv; argv: string[] } {
  const env: NodeJS.ProcessEnv = {};
  let index = 0;
  while (index < segment.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(segment.argv[index] ?? "")) {
    const token = segment.argv[index] ?? "";
    const equals = token.indexOf("=");
    const key = token.slice(0, equals);
    const value = token.slice(equals + 1);
    if (/[;&|<>`$\r\n]/.test(value)) throw new CodexProError(`Unsafe environment assignment in safe mode: ${key}`);
    env[key] = value;
    index += 1;
  }
  return { env, argv: segment.argv.slice(index) };
}

const GIT_DELIVERY_ACTIONS = new Set(["add", "commit", "push"]);

function unwrapCommandPrefix(argv: string[]): string[] {
  let remaining = [...argv];
  while (remaining[0]?.toLowerCase() === "command") remaining = remaining.slice(1);
  if (remaining[0]?.toLowerCase() === "env") {
    remaining = remaining.slice(1);
    while (remaining.length) {
      const token = remaining[0] ?? "";
      if (token === "--") {
        remaining = remaining.slice(1);
        break;
      }
      if (token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
        remaining = remaining.slice(1);
        continue;
      }
      break;
    }
  }
  while (remaining[0] && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(remaining[0])) remaining = remaining.slice(1);
  return remaining;
}

function gitSubcommand(argv: string[]): string | undefined {
  const remaining = unwrapCommandPrefix(argv);
  const executable = path.basename(remaining[0] ?? "").toLowerCase();
  if (executable !== "git") return undefined;
  let index = 1;
  while (index < remaining.length) {
    const token = remaining[index] ?? "";
    if (token === "--") {
      index += 1;
      break;
    }
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(token)) {
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|config-env)=/.test(token) || token.startsWith("-")) {
      index += 1;
      continue;
    }
    return token.toLowerCase();
  }
  return remaining[index]?.toLowerCase();
}

function bashGitDeliveryAction(command: string): string | undefined {
  try {
    const ir = parseCommandToIR(command);
    for (const segment of ir.segments) {
      const parsed = parseEnvAssignments(segment);
      const subcommand = gitSubcommand(parsed.argv);
      if (subcommand && GIT_DELIVERY_ACTIONS.has(subcommand)) return subcommand;
    }
  } catch {
    // Fall through to the conservative text check for shell-wrapped commands.
  }
  const match = command.match(/(?:^|[\s"'`;&|()\r\n])(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|]+\s+)*)(?:(?:command|env)\s+)*(?:[^\s;&|"'`]*\/)?git\s+(?:-[^\s;&|]+\s+)*(add|commit|push)\b/i);
  return match?.[1]?.toLowerCase();
}

function assertNoBashGitDelivery(command: string): void {
  const action = bashGitDeliveryAction(command);
  if (!action) return;
  const dedicated = action === "push" ? "git_push_only or git_finalize" : "git_finalize";
  throw new CodexProError(
    `Git delivery command git ${action} is blocked in the generic bash tool. ` +
    `Use ${dedicated}; Bash is reserved for diagnostics and verification.`
  );
}

function packageScriptRequest(argv: string[]): { manager: string; script: string; extraArgs: string[] } | undefined {
  const manager = argv[0]?.toLowerCase();
  if (!manager || !["npm", "pnpm", "yarn", "bun"].includes(manager)) return undefined;
  if ((manager === "npm" || manager === "pnpm" || manager === "yarn" || manager === "bun") && argv[1]?.toLowerCase() === "run" && argv[2]) {
    const extra = argv.slice(3);
    return { manager, script: argv[2], extraArgs: extra[0] === "--" ? extra.slice(1) : extra };
  }
  if (argv[1]?.toLowerCase() === "test" || argv[1]?.toLowerCase() === "t") {
    const extra = argv.slice(2);
    return { manager, script: "test", extraArgs: extra[0] === "--" ? extra.slice(1) : extra };
  }
  return undefined;
}

function packageScripts(cwd: string): Record<string, string> {
  const packagePath = path.join(cwd, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new CodexProError(`Safe package script execution requires a readable package.json in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scripts = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { scripts?: unknown }).scripts
    : undefined;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function assertSafeScriptExecutable(argv: string[], cwd: string): void {
  const executable = argv[0]?.toLowerCase();
  if (!executable) throw new CodexProError("Safe command resolved to an empty executable.");
  if (["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"].includes(executable)) {
    throw new CodexProError(`Package script invokes a shell in safe mode: ${executable}`);
  }
  if ((executable === "node" || executable === "node.exe") && argv.some((value) => ["-e", "--eval", "-p", "--print"].includes(value))) {
    throw new CodexProError("Node eval/print flags are blocked in safe mode.");
  }
  if ((executable === "python" || executable === "python3" || executable === "py") && argv.includes("-c")) {
    throw new CodexProError("Python -c is blocked in safe mode.");
  }
  const scriptArg = ["node", "node.exe", "python", "python3", "py"].includes(executable)
    ? argv.find((value, index) => index > 0 && !value.startsWith("-"))
    : undefined;
  if (scriptArg) {
    if (path.isAbsolute(scriptArg) || scriptArg === ".." || scriptArg.startsWith("../") || scriptArg.includes("/../") || scriptArg.includes("\\..\\")) {
      throw new CodexProError(`Package script escapes the workspace in safe mode: ${scriptArg}`);
    }
    const resolved = path.resolve(cwd, scriptArg);
    const relative = path.relative(cwd, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CodexProError(`Package script escapes the workspace in safe mode: ${scriptArg}`);
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realRelative = path.relative(cwd, real);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new CodexProError(`Package script resolves outside the workspace in safe mode: ${scriptArg}`);
      }
    }
  }
}

function assertSafeIr(command: string): ReturnType<typeof parseCommandToIR> {
  const ir = parseCommandToIR(command);
  const unsupported = ir.shellOperators.filter((operator) => operator !== "&&");
  if (unsupported.length || ir.shellOperators.length !== Math.max(0, ir.segments.length - 1)) {
    throw new CodexProError(`Safe mode rejects shell operators and expansion: ${unsupported.join(", ") || "ambiguous shell syntax"}`);
  }
  if (!ir.segments.length) throw new CodexProError("Safe command is empty after parsing.");
  return ir;
}

function resolveSafeCommandPlan(
  command: string,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  depth = 0,
  options: { allowFrozenValidationCommand?: boolean } = {}
): SafeCommandStep[] {
  if (depth > 8) throw new CodexProError("Package script recursion exceeded the safe limit.");
  const ir = assertSafeIr(command);
  const steps: SafeCommandStep[] = [];
  for (const segment of ir.segments) {
    const parsed = parseEnvAssignments(segment);
    if (!parsed.argv.length) throw new CodexProError(`Safe command segment has no executable: ${segment.raw}`);
    const request = packageScriptRequest(parsed.argv);
    if (request) {
      const script = packageScripts(cwd)[request.script];
      if (!script) throw new CodexProError(`Package script is not defined: ${request.script}`);
      for (const pattern of SAFE_BLOCKED_PATTERNS) {
        if (options.allowFrozenValidationCommand && pattern === SAFE_SHELL_OPERATOR_PATTERN) continue;
        if (pattern.test(script)) throw new CodexProError(`Package script ${request.script} is blocked by the safe policy.`);
      }
      const nested = resolveSafeCommandPlan(
        script,
        cwd,
        { ...baseEnv, ...parsed.env },
        depth + 1,
        options
      );
      if (request.extraArgs.length) {
        if (request.extraArgs.some((value) => /[;&|<>`$\r\n]/.test(value))) {
          throw new CodexProError(`Unsafe package script arguments for ${request.script}.`);
        }
        const last = nested[nested.length - 1];
        if (!last) throw new CodexProError(`Package script ${request.script} resolved to no executable steps.`);
        last.args.push(...request.extraArgs);
        last.display = commandDisplay(last.command, last.args);
      }
      steps.push(...nested);
      continue;
    }
    assertSafeScriptExecutable(parsed.argv, cwd);
    const [executable, ...args] = parsed.argv;
    steps.push({
      command: executable,
      args,
      env: { ...baseEnv, ...parsed.env },
      display: commandDisplay(executable, args)
    });
  }
  return steps;
}

function safeExecutionEnv(config: CodexProConfig, cwd: string): NodeJS.ProcessEnv {
  const env = makeEnv(config);
  const localBin = path.join(cwd, "node_modules", ".bin");
  env.PATH = `${localBin}${path.delimiter}${env.PATH ?? ""}`;
  return env;
}

export function classifyBashProcessRisk(command: string, category: CommandCategory): {
  sideEffectLevel: ProcessSideEffectLevel;
  riskLevel: "low" | "medium" | "high";
} {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  const externalWrite = [
    /(?:^|\s)git\s+push\b/,
    /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?publish\b/,
    /(?:^|\s)docker\s+push\b/,
    /(?:^|\s)kubectl\s+(?:apply|create|delete|patch|replace|scale|rollout)\b/,
    /(?:^|\s)terraform\s+(?:apply|destroy|import)\b/,
    /(?:^|\s)(?:ssh|scp|rsync)\b/,
    /(?:^|\s)curl\b[^\n]*(?:-x\s*(?:post|put|patch|delete)\b|--request\s+(?:post|put|patch|delete)\b|(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?)\b)/
  ].some((pattern) => pattern.test(normalized));
  if (externalWrite) return { sideEffectLevel: "external_write", riskLevel: "high" };
  if (category === "safe") return { sideEffectLevel: "local_read", riskLevel: "low" };
  return { sideEffectLevel: "local_write", riskLevel: "medium" };
}

export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: BashRunOptions = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const safetyOptions: CommandSafetyOptions = {
    scope: "bash" as CommandSafetyScope,
    principal: "user_command",
    resourceProfile: "default",
    ...options.safety
  };
  const normalizedCommand = command.trim().replace(/\s+/g, " ");
  const commandPlan = options.commandPlan ?? compileCommandPlan(command, safetyOptions);
  if (commandPlan.command !== normalizedCommand) {
    throw new CodexProError("Precompiled command plan does not match the command being executed.");
  }
  const safety = commandPlan.safety;
  if (safety.blocked) {
    return {
      command,
      requestedCommand: options.requestedCommand ?? command,
      effectiveCommand: command,
      ...(options.rewriteReason ? { rewriteReason: options.rewriteReason } : {}),
      cwd: path.relative(workspace.root, cwd) || ".",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: [
        "[codexpro] command blocked before process start",
        "blocked=true",
        `category=${safety.category}`,
        `reason=${safety.reason ?? "Command blocked by pre-execution command sandbox."}`,
        `suggestion=${safety.suggestion ?? "Use a narrower, targeted command."}`
      ].join("\n"),
      truncated: false,
      spawnAttempted: false,
      processStarted: false,
      blockedBeforeSpawn: true,
      blocked: true,
      reason: safety.reason,
      suggestion: safety.suggestion,
      category: safety.category,
      policyLayer: "cpu_resource_policy",
      policyRule: safety.matched_rule,
      principal: safety.principal,
      resourceProfile: safety.resource_profile,
      testScope: safety.test_scope,
      ...(bashSessionId ? { bashSessionId } : {})
    };
  }
  try {
    assertNoBashGitDelivery(command);
    assertSafeCommand(config, command, {
      allowTargetedSmokeScript: options.allowTargetedSmokeScript,
      allowFrozenValidationCommand: options.allowFrozenValidationCommand
    });
  } catch (error) {
    if (!options.returnPolicyBlocks) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      command,
      requestedCommand: options.requestedCommand ?? command,
      effectiveCommand: command,
      ...(options.rewriteReason ? { rewriteReason: options.rewriteReason } : {}),
      cwd: path.relative(workspace.root, cwd) || ".",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: [
        "[codexpro] command blocked before process start",
        "blocked=true",
        "policy_layer=bash_allowlist",
        `reason=${message}`
      ].join("\n"),
      truncated: false,
      spawnAttempted: false,
      processStarted: false,
      blockedBeforeSpawn: true,
      blocked: true,
      reason: message,
      suggestion: "Use an allowlisted command or an explicitly approved trusted execution mode.",
      policyLayer: "bash_allowlist",
      policyRule: "safe_bash_allowlist",
      principal: safetyOptions.principal,
      resourceProfile: safetyOptions.resourceProfile,
      testScope: safetyOptions.testScope,
      ...(bashSessionId ? { bashSessionId } : {})
    };
  }
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 300_000));
  const started = Date.now();
  const baseEnv = safeExecutionEnv(config, cwd);
  const steps = config.bashMode === "safe"
    ? resolveSafeCommandPlan(command, cwd, baseEnv, 0, {
        allowFrozenValidationCommand: options.allowFrozenValidationCommand
      })
    : [{ command: bashExecutable(), args: ["-lc", command], env: baseEnv, display: command }];
  const processRisk = classifyBashProcessRisk(command, commandPlan.category);

  let stdout = "";
  let stderr = "";
  let truncated = false;
  let exitCode: number | null = 0;
  let signal: NodeJS.Signals | null = null;
  let processStarted = false;
  let cancelled = false;
  let timedOut = false;
  let treeTerminated = true;
  const deadline = started + timeoutMs;

  for (const step of steps) {
    const remaining = Math.max(1_000, deadline - Date.now());
    const result = await runProcess(step.command, step.args, {
      cwd,
      env: step.env,
      timeoutMs: remaining,
      maxOutputBytes: config.maxOutputBytes,
      signal: options.signal,
      domain: "shell",
      operation: step.command,
      sideEffectLevel: processRisk.sideEffectLevel,
      riskLevel: processRisk.riskLevel,
      taskId: options.taskId,
      runId: options.runId,
      stepId: options.stepId,
      recordRoot: options.allowFrozenValidationCommand ? workspace.root : undefined,
      contextDir: options.allowFrozenValidationCommand ? config.contextDir : undefined,
      evidenceCommand: options.allowFrozenValidationCommand ? command : undefined,
      secrets: [],
      returnRawStdout: false,
      returnRawStderr: false
    });
    processStarted ||= result.pid !== null;
    stdout += `${stdout && result.stdout ? "\n" : ""}${result.stdout}`;
    stderr += `${stderr && result.stderr ? "\n" : ""}${result.stderr}`;
    truncated ||= result.truncated;
    exitCode = result.exitCode;
    signal = result.signal;
    cancelled ||= result.cancelled;
    timedOut ||= result.timedOut;
    treeTerminated &&= result.treeTerminated;
    if (result.timedOut || result.cancelled || !result.treeTerminated || result.exitCode !== 0) break;
  }

  return {
    command,
    requestedCommand: options.requestedCommand ?? command,
    effectiveCommand: config.bashMode === "safe" ? steps.map((step) => step.display).join(" && ") : command,
    ...(options.rewriteReason ? { rewriteReason: options.rewriteReason } : {}),
    cwd: path.relative(workspace.root, cwd) || ".",
    exitCode,
    signal,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    truncated,
    spawnAttempted: true,
    processStarted,
    cancelled,
    timedOut,
    treeTerminated,
    principal: safetyOptions.principal,
    resourceProfile: safetyOptions.resourceProfile,
    testScope: safetyOptions.testScope,
    ...(bashSessionId ? { bashSessionId } : {})
  };
}
