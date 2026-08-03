import { createHash } from "node:crypto";
import { parseCommandToIR, type CommandCategory, type CommandIR, type CommandSegmentIR } from "./commandIr.js";

export type { CommandCategory, CommandIR, CommandSegmentIR } from "./commandIr.js";

export type CommandSafetyScope = "bash" | "run_task" | "run_validation" | "acceptance";
export type CommandSafetyPrincipal = "codex_agent" | "acceptance_verifier" | "developer_hook" | "user_command" | "system_maintenance";
export type CommandResourceProfile = "default" | "acceptance-test" | "acceptance-full-test";
export type CommandTestScope = "targeted" | "full";

export interface CommandSafetyOptions {
  scope?: CommandSafetyScope;
  principal?: CommandSafetyPrincipal;
  resourceProfile?: CommandResourceProfile;
  testScope?: CommandTestScope;
  allowFullTest?: boolean;
  timeoutMs?: number;
  maxWorkers?: number;
  requireNonWatchMode?: boolean;
}

export interface CommandSafetyDecision {
  blocked: boolean;
  category: CommandCategory;
  command?: string;
  commands?: string[];
  reason?: string;
  suggestion?: string;
  matched_rule?: string;
  test_files?: string[];
  frontend_test_command_count?: number;
  checks?: CommandSafetyDecision[];
  scope?: CommandSafetyScope;
  principal?: CommandSafetyPrincipal;
  resource_profile?: CommandResourceProfile;
  test_scope?: CommandTestScope;
  policy_layer?: "cpu_resource_policy";
  resource_cost?: "light" | "standard" | "heavy";
  resource_reasons?: string[];
  ir?: CommandIR;
}

export interface CommandExecutionPlan {
  version: 1;
  plan_id: string;
  command: string;
  safety: CommandSafetyDecision;
  category: CommandCategory;
  resource_cost: "light" | "standard" | "heavy";
  resource_reasons: string[];
  ir: CommandIR;
}

export interface CommandBatchPlan {
  version: 1;
  plans: CommandExecutionPlan[];
  safety: CommandSafetyDecision;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const FRONTEND_TEST_RUNNERS = new Set(["jest", "vitest"]);
const VALUE_FLAGS = new Set([
  "--config",
  "-c",
  "--maxworkers",
  "--testnamepattern",
  "-t",
  "--project",
  "--grep",
  "-g",
  "--reporter",
  "--timeout",
  "--workers",
  "--shard",
  "--filter",
  "-k",
  "--keyword",
  "--testmatch",
  "--testpathpattern",
  "--testpathpatterns",
  "--testregex"
]);
const IGNORED_RUNNER_WORDS = new Set(["run", "watch"]);
const TEST_TARGET_PATTERN = /[/\\]|\.(?:[cm]?[jt]sx?|py)$|\.(?:test|spec)\.[A-Za-z0-9]+$/i;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function lower(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let index = 0;
  while (index < argv.length && isEnvAssignment(argv[index] ?? "")) index += 1;
  return argv.slice(index);
}

function stripEnvWrapper(argv: string[]): string[] {
  if (lower(argv[0]) !== "env") return argv;
  let index = 1;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (isEnvAssignment(token) || token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function stripTimeoutWrapper(argv: string[]): string[] {
  if (lower(argv[0]) !== "timeout") return argv;
  let index = 1;
  while (index < argv.length && (argv[index] ?? "").startsWith("-")) {
    const flag = lower(argv[index]);
    index += ["-k", "--kill-after", "-s", "--signal"].includes(flag) ? 2 : 1;
  }
  if (index < argv.length) index += 1;
  return argv.slice(index);
}

function effectiveArgv(argv: string[]): string[] {
  let current = stripLeadingEnvAssignments(argv);
  current = stripEnvWrapper(current);
  current = stripLeadingEnvAssignments(current);
  current = stripTimeoutWrapper(current);
  current = stripLeadingEnvAssignments(current);
  return current;
}

function executableIndex(argv: string[], executable: string): number {
  const tokens = argv.map(lower);
  if (tokens[0] === executable) return 0;
  if (tokens[0] === "npx" || tokens[0] === "bunx") {
    let index = 1;
    while (tokens[index]?.startsWith("-")) index += 1;
    return tokens[index] === executable ? index : -1;
  }
  if ((tokens[0] === "npm" || tokens[0] === "pnpm" || tokens[0] === "bun") && tokens[1] === "exec") {
    let index = 2;
    while (tokens[index]?.startsWith("-")) index += 1;
    return tokens[index] === executable ? index : -1;
  }
  if ((tokens[0] === "yarn" || tokens[0] === "pnpm" || tokens[0] === "bun") && tokens[1] === executable) return 1;
  return -1;
}

function isPackageRunScript(argv: string[], script: string): boolean {
  const bin = lower(argv[0]);
  if (!PACKAGE_MANAGERS.has(bin)) return false;
  if (bin === "npm" && lower(argv[1]) === script && script === "test") return true;
  if (lower(argv[1]) === script) return true;
  return lower(argv[1]) === "run" && lower(argv[2]) === script;
}

function isPackageTestCommand(argv: string[]): boolean {
  const bin = lower(argv[0]);
  if (!PACKAGE_MANAGERS.has(bin)) return false;
  if (lower(argv[1]) === "test" || lower(argv[1]) === "t") return true;
  return lower(argv[1]) === "run" && lower(argv[2]) === "test";
}

function packageTestArgs(argv: string[]): string[] {
  if (lower(argv[1]) === "test" || lower(argv[1]) === "t") return argv.slice(2);
  if (lower(argv[1]) === "run" && lower(argv[2]) === "test") return argv.slice(3);
  return [];
}

function runnerArgs(argv: string[], runner: string): string[] {
  const index = executableIndex(argv, runner);
  return index === -1 ? [] : argv.slice(index + 1);
}

function isDirectRunner(argv: string[], runner: string): boolean {
  return executableIndex(argv, runner) !== -1;
}

function isPlaywrightTestCommand(argv: string[]): boolean {
  const index = executableIndex(argv, "playwright");
  return index !== -1 && lower(argv[index + 1]) === "test";
}

function playwrightArgs(argv: string[]): string[] {
  const index = executableIndex(argv, "playwright");
  return index === -1 ? [] : argv.slice(index + 2);
}

function pytestIndex(argv: string[]): number {
  const direct = executableIndex(argv, "pytest");
  if (direct !== -1) return direct;
  if ((lower(argv[0]) === "python" || lower(argv[0]) === "python3") && lower(argv[1]) === "-m" && lower(argv[2]) === "pytest") return 2;
  if (lower(argv[0]) === "uv" && lower(argv[1]) === "run" && lower(argv[2]) === "pytest") return 2;
  return -1;
}

function isPytestCommand(argv: string[]): boolean {
  return pytestIndex(argv) !== -1;
}

function pytestArgs(argv: string[]): string[] {
  const index = pytestIndex(argv);
  return index === -1 ? [] : argv.slice(index + 1);
}

function isNextBuildArgv(argv: string[]): boolean {
  const index = executableIndex(argv, "next");
  return index !== -1 && lower(argv[index + 1]) === "build";
}

function isBoundedNodeValidationScript(argv: string[]): boolean {
  if (lower(argv[0]) !== "node") return false;
  let index = 1;
  while (index < argv.length && (argv[index] ?? "").startsWith("-")) index += 1;
  const script = (argv[index] ?? "").replace(/\\/g, "/");
  if (!/^(?:\.\/)?scripts\/[^/]+\.(?:mjs|cjs|js)$/i.test(script)) return false;
  const basename = script.split("/").pop()?.toLowerCase() ?? "";
  return /(?:^|[-_.])(?:smoke|test|check|verify|validation|typecheck|lint|audit|healthcheck)(?:[-_.]|$)/i.test(basename);
}

export function isNextBuildCommand(command: string): boolean {
  const ir = parseCommandToIR(command);
  return ir.segments.some((segment) => isNextBuildArgv(effectiveArgv(segment.argv)));
}

function isSafeArgv(argv: string[]): boolean {
  const bin = lower(argv[0]);
  if (["pwd", "ls", "find"].includes(bin)) return true;
  if (bin === "git" && ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files"].includes(lower(argv[1]))) return true;
  if (isPackageRunScript(argv, "typecheck") || isPackageRunScript(argv, "lint") || isPackageRunScript(argv, "check") || isPackageRunScript(argv, "smoke") || isPackageRunScript(argv, "browser-smoke") || isPackageRunScript(argv, "release-gate")) return true;
  if (isBoundedNodeValidationScript(argv)) return true;
  if (executableIndex(argv, "tsc") !== -1 || executableIndex(argv, "eslint") !== -1) return true;
  const biome = executableIndex(argv, "biome");
  return biome !== -1 && lower(argv[biome + 1]) === "check";
}

function frontendArgs(argv: string[]): string[] | undefined {
  if (isPackageTestCommand(argv)) return packageTestArgs(argv);
  for (const runner of FRONTEND_TEST_RUNNERS) {
    if (isDirectRunner(argv, runner)) return runnerArgs(argv, runner);
  }
  if (isPlaywrightTestCommand(argv)) return playwrightArgs(argv);
  return undefined;
}

function backendArgs(argv: string[]): string[] | undefined {
  if (isPytestCommand(argv)) return pytestArgs(argv);
  return undefined;
}

function classifySegment(segment: CommandSegmentIR): CommandCategory {
  const argv = effectiveArgv(segment.argv);
  if (!argv.length) return "unknown";
  if (frontendArgs(argv)) return "frontend_test";
  if (backendArgs(argv)) return "backend_test";
  if (isNextBuildArgv(argv) || isPackageRunScript(argv, "build")) return "build";
  if (isSafeArgv(argv)) return "safe";
  return "unknown";
}

function firstCategory(categories: CommandCategory[]): CommandCategory {
  if (categories.includes("build")) return "build";
  if (categories.includes("frontend_test")) return "frontend_test";
  if (categories.includes("backend_test")) return "backend_test";
  if (categories.length && categories.every((category) => category === "safe")) return "safe";
  return "unknown";
}

export function classifyCommandIR(ir: CommandIR): CommandCategory {
  return firstCategory(ir.segments.map(classifySegment));
}

export function classifyCommand(command: string): CommandCategory {
  return classifyCommandIR(parseCommandToIR(command));
}

export function extractFrontendTestFiles(command: string): string[] {
  return unique(parseCommandToIR(command).testFiles);
}

function isFlagWithValue(token: string): boolean {
  const normalized = lower(token.split("=", 1)[0]);
  return VALUE_FLAGS.has(normalized);
}

function isTargetToken(token: string): boolean {
  if (!token || token === "--" || token.startsWith("-")) return false;
  if (/^\d+$/.test(token)) return false;
  const basename = token.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? token.toLowerCase();
  return TEST_DIRS.has(basename) || TEST_TARGET_PATTERN.test(token);
}

function hasTargetArgument(args: string[]): boolean {
  let sawRunnerWord = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    const normalized = lower(token);
    if (token === "--") continue;
    if (!sawRunnerWord && IGNORED_RUNNER_WORDS.has(normalized)) {
      sawRunnerWord = true;
      continue;
    }
    if (token.startsWith("-")) {
      if (isFlagWithValue(token) && !token.includes("=")) index += 1;
      continue;
    }
    if (isTargetToken(token)) return true;
  }
  return false;
}

function blockedDecision(
  command: string,
  category: CommandCategory,
  matchedRule: string,
  reason: string,
  suggestion: string,
  ir: CommandIR,
  options: CommandSafetyOptions
): CommandSafetyDecision {
  return {
    blocked: true,
    category,
    command,
    reason,
    suggestion,
    matched_rule: matchedRule,
    test_files: unique(ir.testFiles),
    scope: options.scope,
    principal: options.principal,
    resource_profile: options.resourceProfile,
    test_scope: options.testScope,
    policy_layer: "cpu_resource_policy",
    ir
  };
}

function allowsBoundedFullAcceptance(options: CommandSafetyOptions): boolean {
  return options.scope === "acceptance"
    && options.principal === "acceptance_verifier"
    && options.resourceProfile === "acceptance-full-test"
    && options.testScope === "full"
    && options.allowFullTest === true
    && typeof options.timeoutMs === "number"
    && options.timeoutMs >= 1_000
    && options.timeoutMs <= 300_000
    && typeof options.maxWorkers === "number"
    && options.maxWorkers >= 1
    && options.maxWorkers <= 2
    && options.requireNonWatchMode !== false;
}

export function evaluateCommandSafety(command: string, options: CommandSafetyOptions = {}): CommandSafetyDecision {
  const normalized = compact(command);
  const ir = parseCommandToIR(normalized);
  const categories = ir.segments.map(classifySegment);
  const category = firstCategory(categories);
  const testFiles = unique(ir.testFiles);

  const resourceReasons: string[] = [];
  if (testFiles.length > 1) resourceReasons.push("multiple_test_files");
  if (isNextBuildCommand(normalized)) resourceReasons.push("next_build");

  for (const segment of ir.segments) {
    const argv = effectiveArgv(segment.argv);
    const frontend = frontendArgs(argv);
    if (frontend && !hasTargetArgument(frontend) && !allowsBoundedFullAcceptance(options)) {
      if (options.scope === "acceptance") {
        return blockedDecision(
          normalized,
          "frontend_test",
          "unscoped_frontend_test",
          `Blocked unscoped frontend acceptance command without an explicit bounded full-test budget: ${normalized}`,
          "Declare acceptance-full-test, full scope, a bounded timeout, max workers, and non-watch mode.",
          ir,
          options
        );
      }
      resourceReasons.push("unscoped_frontend_test");
    }
    const backend = backendArgs(argv);
    if (backend && !hasTargetArgument(backend) && !allowsBoundedFullAcceptance(options)) {
      if (options.scope === "acceptance") {
        return blockedDecision(
          normalized,
          "backend_test",
          "unscoped_backend_test",
          `Blocked unscoped backend acceptance command without an explicit bounded full-test budget: ${normalized}`,
          "Declare acceptance-full-test, full scope, a bounded timeout, max workers, and non-watch mode.",
          ir,
          options
        );
      }
      resourceReasons.push("unscoped_backend_test");
    }
  }

  const frontendTestCommandCount = categories.filter((item) => item === "frontend_test").length;
  if (frontendTestCommandCount > 1) resourceReasons.push("multiple_frontend_tests_in_one_command");
  const resourceCost = resourceReasons.length > 0 || category === "build" ? "heavy" : category === "safe" ? "light" : "standard";

  return {
    blocked: false,
    category,
    command: normalized,
    test_files: testFiles,
    scope: options.scope,
    principal: options.principal,
    resource_profile: options.resourceProfile,
    test_scope: options.testScope,
    policy_layer: "cpu_resource_policy",
    resource_cost: resourceCost,
    resource_reasons: resourceReasons,
    ir
  };
}

export const evaluateCommandSafetyPolicy = evaluateCommandSafety;

export function evaluateCommandBatchSafety(commands: string[], options: CommandSafetyOptions = {}): CommandSafetyDecision {
  const normalized = commands.map(compact).filter(Boolean);
  const checks = normalized.map((command) => evaluateCommandSafety(command, options));
  const firstBlocked = checks.find((check) => check.blocked);
  if (firstBlocked) return { ...firstBlocked, commands: normalized, checks };

  const frontendTests = checks.filter((check) => check.category === "frontend_test");
  const resourceReasons = unique([
    ...checks.flatMap((check) => check.resource_reasons ?? []),
    ...(frontendTests.length > 1 ? ["multiple_frontend_tests_in_task"] : [])
  ]);
  const resourceCost = checks.some((check) => check.resource_cost === "heavy") || resourceReasons.length > 0
    ? "heavy"
    : checks.every((check) => check.resource_cost === "light") ? "light" : "standard";

  return {
    blocked: false,
    category: firstCategory(checks.map((check) => check.category)),
    commands: normalized,
    checks,
    scope: options.scope,
    principal: options.principal,
    resource_profile: options.resourceProfile,
    test_scope: options.testScope,
    policy_layer: "cpu_resource_policy",
    resource_cost: resourceCost,
    resource_reasons: resourceReasons,
    ...(frontendTests.length > 1 ? { frontend_test_command_count: frontendTests.length } : {})
  };
}

export function compileCommandPlan(command: string, options: CommandSafetyOptions = {}): CommandExecutionPlan {
  const safety = evaluateCommandSafety(command, options);
  const normalized = safety.command ?? compact(command);
  const ir = safety.ir ?? parseCommandToIR(normalized);
  const resourceCost = safety.resource_cost ?? (safety.category === "build" ? "heavy" : safety.category === "safe" ? "light" : "standard");
  const resourceReasons = [...new Set(safety.resource_reasons ?? [])];
  const digest = createHash("sha256").update(JSON.stringify({ normalized, options, resourceCost, resourceReasons })).digest("hex");
  return {
    version: 1,
    plan_id: `cmd_${digest.slice(0, 24)}`,
    command: normalized,
    safety,
    category: safety.category,
    resource_cost: resourceCost,
    resource_reasons: resourceReasons,
    ir
  };
}

export function compileCommandBatchPlan(commands: string[], options: CommandSafetyOptions = {}): CommandBatchPlan {
  const plans = commands.map((command) => compileCommandPlan(command, options));
  const safety = evaluateCommandBatchSafetyFromPlans(plans, options);
  return { version: 1, plans, safety };
}

export function evaluateCommandBatchSafetyFromPlans(plans: CommandExecutionPlan[], options: CommandSafetyOptions = {}): CommandSafetyDecision {
  const normalized = plans.map((plan) => plan.command);
  const checks = plans.map((plan) => plan.safety);
  const firstBlocked = checks.find((check) => check.blocked);
  if (firstBlocked) return { ...firstBlocked, commands: normalized, checks };
  const frontendTests = checks.filter((check) => check.category === "frontend_test");
  const resourceReasons = unique([
    ...plans.flatMap((plan) => plan.resource_reasons),
    ...(frontendTests.length > 1 ? ["multiple_frontend_tests_in_task"] : [])
  ]);
  const resourceCost = plans.some((plan) => plan.resource_cost === "heavy") || resourceReasons.length > 0
    ? "heavy"
    : plans.every((plan) => plan.resource_cost === "light") ? "light" : "standard";
  return {
    blocked: false,
    category: firstCategory(checks.map((check) => check.category)),
    commands: normalized,
    checks,
    scope: options.scope,
    principal: options.principal,
    resource_profile: options.resourceProfile,
    test_scope: options.testScope,
    policy_layer: "cpu_resource_policy",
    resource_cost: resourceCost,
    resource_reasons: resourceReasons,
    ...(frontendTests.length > 1 ? { frontend_test_command_count: frontendTests.length } : {})
  };
}

export function formatCommandSafetyBlock(title: string, decision: CommandSafetyDecision): string {
  const lines = [
    `# ${title}`,
    "",
    "blocked=true",
    `reason: ${decision.reason ?? "Command blocked by CPU safety policy."}`,
    `suggestion: ${decision.suggestion ?? "Use a targeted, low-CPU command."}`,
    decision.matched_rule ? `matched_rule: ${decision.matched_rule}` : "",
    decision.category ? `category: ${decision.category}` : "",
    decision.policy_layer ? `policy_layer: ${decision.policy_layer}` : "",
    decision.principal ? `principal: ${decision.principal}` : "",
    decision.resource_profile ? `resource_profile: ${decision.resource_profile}` : "",
    decision.test_scope ? `test_scope: ${decision.test_scope}` : ""
  ].filter(Boolean);

  if (decision.command) lines.push("", "command:", "```bash", decision.command, "```");
  if (decision.commands?.length) lines.push("", "commands:", ...decision.commands.map((command) => `- ${command}`));
  if (decision.test_files?.length) lines.push("", `test_files: ${decision.test_files.join(", ")}`);
  if (decision.frontend_test_command_count !== undefined) lines.push(`frontend_test_command_count: ${decision.frontend_test_command_count}`);
  return lines.join("\n");
}
