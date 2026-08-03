import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PathGuard, Workspace } from "../guard.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess } from "../runtime/processWrapper.js";

export type DockerToolSafety = "read" | "write";

export interface DockerToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface DockerToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: DockerToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<DockerToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

interface DockerRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface ComposePsRow {
  id?: string;
  name?: string;
  service?: string;
  state?: string;
  status?: string;
  health?: string;
  ports?: string[];
  raw: Record<string, unknown>;
}

const MAX_OUTPUT_BYTES = 80_000;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function cwdArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Directory inside the workspace that contains docker-compose.yml/compose.yml. Default: workspace root.");
}

function serviceArg(required = false): z.ZodTypeAny {
  const schema = z.string().regex(SERVICE_PATTERN, "service must contain only letters, numbers, dot, underscore, or dash and must not start with punctuation");
  return required ? schema.describe("Compose service name to operate on.") : schema.optional().describe("Optional Compose service name filter.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function trimOutput(value: string): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= MAX_OUTPUT_BYTES) return { value, truncated: false };
  const sliced = buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${MAX_OUTPUT_BYTES} bytes]`, truncated: true };
}

function dockerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    COMPOSE_ANSI: "never",
    DOCKER_CLI_HINTS: "false"
  };
}

function assertSafeService(service: string | undefined): string | undefined {
  if (!service) return undefined;
  const normalized = service.trim();
  if (!SERVICE_PATTERN.test(normalized)) {
    throw new CodexProError("Invalid Docker Compose service name. Use only letters, numbers, dot, underscore, or dash.");
  }
  return normalized;
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

export function assertSafeDockerComposeArgs(args: string[]): void {
  const [command, ...rest] = args;
  if (!command) throw new CodexProError("Docker Compose command is required.");

  if (command === "ps") {
    const allowed = rest.length === 0 || rest.join("\0") === "--format\0json";
    if (allowed) return;
  }

  if (command === "logs") {
    const service = rest[0] === "--no-color" && rest[1] === "--tail" && isPositiveInteger(rest[2] ?? "")
      ? rest[3]
      : undefined;
    const allowed = rest[0] === "--no-color" && rest[1] === "--tail" && isPositiveInteger(rest[2] ?? "") && (rest.length === 3 || (rest.length === 4 && Boolean(assertSafeService(service))));
    if (allowed) return;
  }

  if (command === "restart") {
    if (rest.length === 1 && Boolean(assertSafeService(rest[0]))) return;
  }

  throw new CodexProError(
    `Docker Compose command is not allowed by the Docker Adapter: docker compose ${args.join(" ")}\n` +
      "Allowed tool operations are status, bounded logs, and restart of one explicit service. Dangerous operations such as down -v, volume rm, and system prune are blocked."
  );
}

function resolveComposeCwd(guard: PathGuard, workspace: Workspace, cwdInput?: string): { absPath: string; relPath: string; composeFiles: string[] } {
  const resolved = guard.resolve(workspace, cwdInput ?? ".");
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isDirectory()) throw new CodexProError(`Docker cwd is not a directory: ${resolved.relPath}`);
  const composeFiles = COMPOSE_FILES.filter((file) => fs.existsSync(path.join(resolved.absPath, file)));
  if (!composeFiles.length) {
    throw new CodexProError(
      `No Docker Compose file found in ${resolved.relPath}. Expected one of: ${COMPOSE_FILES.join(", ")}. ` +
        "Pass cwd for the directory that owns the Compose file."
    );
  }
  return { ...resolved, composeFiles };
}

async function runDockerCompose(workspace: Workspace, cwd: { absPath: string; relPath: string }, args: string[], timeoutMs: number): Promise<DockerRunResult> {
  assertSafeDockerComposeArgs(args);
  const command = `docker compose ${args.join(" ")}`;
  const start = Date.now();
  const result = await runProcess("docker", ["compose", ...args], {
    cwd: cwd.absPath,
    env: dockerEnv(),
    timeoutMs: Math.max(1_000, Math.min(timeoutMs, 180_000)),
    killGraceMs: 1_500,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    domain: "adapter",
    operation: `docker_compose_${args[0] ?? "command"}`,
    sideEffectLevel: args[0] === "restart" ? "external_write" : "local_read",
    riskLevel: args[0] === "restart" ? "medium" : "low"
  });
  if (result.spawnError && result.exitCode === null) {
    throw new CodexProError(`Failed to run docker. Is Docker installed and available on PATH? ${result.stderr || result.errorClass || "spawn failed"}`);
  }
  const out = trimOutput(redactSensitiveText(result.stdout));
  const err = trimOutput(redactSensitiveText(result.timedOut ? `${result.stderr}\n[codexpro] Docker command timed out after ${timeoutMs} ms.` : result.stderr));
  return {
    command,
    cwd: cwd.relPath || path.relative(workspace.root, cwd.absPath) || ".",
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs || Date.now() - start,
    stdout: out.value,
    stderr: err.value,
    truncated: out.truncated || err.truncated || result.truncated
  };
}

function normalizeRowValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function portsFromPublishers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ports: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const published = normalizeRowValue(row.PublishedPort ?? row.published_port ?? row.published);
    const target = normalizeRowValue(row.TargetPort ?? row.target_port ?? row.target);
    const protocol = normalizeRowValue(row.Protocol ?? row.protocol) ?? "tcp";
    const url = normalizeRowValue(row.URL ?? row.url);
    if (published && target) ports.push(`${published}->${target}/${protocol}`);
    else if (url) ports.push(url);
  }
  return ports;
}

function parseComposePsRows(stdout: string): ComposePsRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rawRows = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ComposePsRow[] = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const service = normalizeRowValue(item.Service ?? item.service ?? item.Name ?? item.name);
    const row: ComposePsRow = {
      id: normalizeRowValue(item.ID ?? item.Id ?? item.id),
      name: normalizeRowValue(item.Name ?? item.name),
      service,
      state: normalizeRowValue(item.State ?? item.state),
      status: normalizeRowValue(item.Status ?? item.status),
      health: normalizeRowValue(item.Health ?? item.health),
      ports: [
        ...portsFromPublishers(item.Publishers ?? item.publishers),
        ...(normalizeRowValue(item.Ports ?? item.ports) ? [normalizeRowValue(item.Ports ?? item.ports)!] : [])
      ],
      raw: item
    };
    rows.push(row);
  }
  return rows.sort((a, b) => (a.service ?? a.name ?? "").localeCompare(b.service ?? b.name ?? ""));
}

function healthLabel(row: ComposePsRow): string {
  const health = row.health?.trim();
  if (health) return health;
  const status = row.status?.toLowerCase() ?? "";
  const state = row.state?.toLowerCase() ?? "";
  if (status.includes("healthy")) return "healthy";
  if (status.includes("unhealthy")) return "unhealthy";
  if (state.includes("running")) return "running/no-healthcheck";
  if (state) return state;
  return "unknown";
}

function formatCommandResult(result: DockerRunResult): string[] {
  return [
    `Command: \`${result.command}\``,
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    result.truncated ? "Output: truncated" : "Output: complete"
  ];
}

export function dockerToolNames(): string[] {
  return ["docker_status", "docker_logs", "docker_restart_service", "docker_healthcheck"];
}

export function createDockerTools(guard: PathGuard, resolveWorkspace: WorkspaceResolver): DockerToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const cwdFor = (args: any) => resolveComposeCwd(guard, workspaceFor(args), args.cwd);

  return [
    {
      name: "docker_status",
      title: "Docker Status",
      description: "Run a safe Docker Compose status check in the workspace and list services, states, ports, and raw compose ps data when available.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("Command timeout. Default: 30000.")
      },
      safety: "read",
      invoking: "Reading Docker Compose status...",
      invoked: "Docker Compose status ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const result = await runDockerCompose(workspace, cwd, ["ps", "--format", "json"], args.timeout_ms ?? 30_000);
        const services = parseComposePsRows(result.stdout);
        const summary = services.map((row) => ({
          service: row.service ?? row.name ?? "unknown",
          name: row.name,
          state: row.state,
          status: row.status,
          health: healthLabel(row),
          ports: row.ports ?? []
        }));
        const text = [
          "# Docker Status",
          "",
          ...formatCommandResult(result),
          `Compose files: ${cwd.composeFiles.join(", ")}`,
          `Services: ${summary.length}`,
          summary.length ? formatJsonBlock(summary) : `\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\``
        ].join("\n");
        return { text, structured: { result, compose_files: cwd.composeFiles, services: summary, raw_services: services } };
      }
    },
    {
      name: "docker_logs",
      title: "Docker Logs",
      description: "Return bounded Docker Compose logs with --tail. Defaults to the last 120 lines and optionally filters to one safe service name.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        service: serviceArg(false),
        tail: z.number().int().min(1).max(500).optional().describe("Number of log lines to request with --tail. Default: 120."),
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("Command timeout. Default: 30000.")
      },
      safety: "read",
      invoking: "Reading Docker Compose logs...",
      invoked: "Docker Compose logs ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const tail = String(args.tail ?? 120);
        const service = assertSafeService(args.service);
        const result = await runDockerCompose(workspace, cwd, ["logs", "--no-color", "--tail", tail, ...(service ? [service] : [])], args.timeout_ms ?? 30_000);
        const text = [
          "# Docker Logs",
          "",
          ...formatCommandResult(result),
          `Compose files: ${cwd.composeFiles.join(", ")}`,
          `Tail: ${tail}`,
          `Service: ${service ?? "all"}`,
          "",
          "## stdout",
          "",
          "```text",
          result.stdout || "",
          "```",
          result.stderr ? ["", "## stderr", "", "```text", result.stderr, "```"].join("\n") : ""
        ].filter(Boolean).join("\n");
        return { text, structured: { result, compose_files: cwd.composeFiles, service: service ?? null, tail: Number(tail) } };
      }
    },
    {
      name: "docker_restart_service",
      title: "Docker Restart Service",
      description: "Restart one explicit Docker Compose service. This does not accept arbitrary Docker arguments and will not run volume or prune operations.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        service: serviceArg(true),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Command timeout. Default: 120000.")
      },
      safety: "write",
      invoking: "Restarting Docker Compose service...",
      invoked: "Docker Compose service restart complete",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const service = assertSafeService(args.service);
        if (!service) throw new CodexProError("service is required.");
        const result = await runDockerCompose(workspace, cwd, ["restart", service], args.timeout_ms ?? 120_000);
        const text = [
          "# Docker Restart Service",
          "",
          ...formatCommandResult(result),
          `Compose files: ${cwd.composeFiles.join(", ")}`,
          `Service: ${service}`,
          "",
          "## stdout",
          "",
          "```text",
          result.stdout || "",
          "```",
          result.stderr ? ["", "## stderr", "", "```text", result.stderr, "```"].join("\n") : ""
        ].filter(Boolean).join("\n");
        return { text, structured: { result, compose_files: cwd.composeFiles, service } };
      }
    },
    {
      name: "docker_healthcheck",
      title: "Docker Healthcheck",
      description: "Summarize Docker Compose service health from docker compose ps --format json. Optionally filter to one safe service name.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        service: serviceArg(false),
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("Command timeout. Default: 30000.")
      },
      safety: "read",
      invoking: "Checking Docker Compose health...",
      invoked: "Docker Compose health ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const cwd = cwdFor(args);
        const service = assertSafeService(args.service);
        const result = await runDockerCompose(workspace, cwd, ["ps", "--format", "json"], args.timeout_ms ?? 30_000);
        const rows = parseComposePsRows(result.stdout).filter((row) => !service || row.service === service || row.name === service);
        const health = rows.map((row) => ({
          service: row.service ?? row.name ?? "unknown",
          name: row.name,
          state: row.state,
          status: row.status,
          health: healthLabel(row)
        }));
        const failing = health.filter((row) => !["healthy", "running/no-healthcheck", "running"].includes(String(row.health).toLowerCase()));
        const text = [
          "# Docker Healthcheck",
          "",
          ...formatCommandResult(result),
          `Compose files: ${cwd.composeFiles.join(", ")}`,
          `Service filter: ${service ?? "all"}`,
          `Services checked: ${health.length}`,
          `Potential issues: ${failing.length}`,
          formatJsonBlock(health)
        ].join("\n");
        return { text, structured: { result, compose_files: cwd.composeFiles, service: service ?? null, health, failing } };
      }
    }
  ];
}
