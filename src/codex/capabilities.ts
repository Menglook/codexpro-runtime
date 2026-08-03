import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "../redact.js";
import { runProcess } from "../runtime/processWrapper.js";
import type { CodexCapabilities, CodexProviderId } from "./types.js";

interface ProbeResult {
  available: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

function clip(value: string, max = 8_000): string {
  const redacted = redactSensitiveText(value);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…`;
}

async function runProbe(executable: string, args: string[], timeoutMs = 5_000): Promise<ProbeResult> {
  const result = await runProcess(executable, args, {
    env: process.env,
    timeoutMs,
    maxOutputBytes: 32_000,
    domain: "probe",
    operation: "codex_capability_probe",
    usageTracking: false,
    sideEffectLevel: "none",
    riskLevel: "low"
  });
  return {
    available: !result.spawnError || result.exitCode !== null,
    exit_code: result.exitCode,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    timed_out: result.timedOut
  };
}

async function sdkVersion(): Promise<string | undefined> {
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.resolve("@openai/codex-sdk")));
    for (let depth = 0; depth < 8; depth += 1) {
      const packagePath = path.join(cursor, "package.json");
      try {
        const parsed = JSON.parse(await fsp.readFile(packagePath, "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@openai/codex-sdk" && parsed.version) return parsed.version;
      } catch {
        // Keep walking toward the package root.
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseCliVersion(result: ProbeResult): string | undefined {
  const combined = `${result.stdout}\n${result.stderr}`;
  const match = combined.match(/codex(?:-cli)?\s+([^\s]+)/i);
  return match?.[1];
}

function parseAuthentication(result: ProbeResult): {
  authentication: CodexCapabilities["authentication"];
  method?: CodexCapabilities["authentication_method"];
} {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exit_code === 0 && combined.includes("logged in")) {
    if (combined.includes("chatgpt")) return { authentication: "authenticated", method: "chatgpt" };
    if (combined.includes("api key") || combined.includes("api_key")) return { authentication: "authenticated", method: "api_key" };
    return { authentication: "authenticated", method: "unknown" };
  }
  if (combined.includes("not logged in") || combined.includes("login required") || combined.includes("authentication required")) {
    return { authentication: "auth_required" };
  }
  return { authentication: "unknown" };
}

export async function detectCodexCapabilities(options: {
  provider: CodexProviderId;
  executable?: string;
}): Promise<CodexCapabilities> {
  if (options.provider === "mock") {
    return {
      provider: "mock",
      available: true,
      sdk_available: true,
      sdk_version: "mock",
      cli_available: false,
      authentication: "authenticated",
      authentication_method: "unknown",
      exec_available: false,
      mcp_server_available: false,
      supports: {
        start: true,
        resume: true,
        cancel: true,
        streaming: true,
        read_only: true,
        workspace_write: true
      },
      notes: ["Mock adapter is deterministic and does not call Codex or consume quota."]
    };
  }

  const executable = options.executable?.trim() || "codex";
  const [version, cliVersionProbe, authProbe, execProbe, mcpProbe] = await Promise.all([
    sdkVersion(),
    runProbe(executable, ["--version"]),
    runProbe(executable, ["login", "status"]),
    runProbe(executable, ["exec", "--help"]),
    runProbe(executable, ["mcp-server", "--help"])
  ]);
  const auth = parseAuthentication(authProbe);
  const sdkAvailable = Boolean(version);
  const cliAvailable = cliVersionProbe.available && cliVersionProbe.exit_code === 0;
  const execAvailable = execProbe.available && execProbe.exit_code === 0;
  const providerAvailable = options.provider === "exec" ? execAvailable : sdkAvailable;
  const notes = options.provider === "exec"
    ? [
        "Exec Runner is the non-interactive automation and fallback path; the SDK remains the default production engine.",
        "Exec uses explicit working-directory, sandbox, timeout, structured output, cancellation, concurrency, and redacted-log controls.",
        "Credential files and environment values are never read or returned."
      ]
    : [
        "The SDK is the default production execution path.",
        "Authentication probing reports whether a local login session exists; only a live read-only smoke can verify that the remote service currently accepts it.",
        "Credential files and environment values are never read or returned."
      ];
  if (auth.authentication === "auth_required") notes.push("Run `codex login` outside CodexPro before starting a task.");
  if (auth.authentication === "unknown") notes.push("Codex login status could not be confirmed without exposing credential data.");

  return {
    provider: options.provider,
    available: providerAvailable,
    sdk_available: sdkAvailable,
    ...(version ? { sdk_version: version } : {}),
    cli_available: cliAvailable,
    ...(parseCliVersion(cliVersionProbe) ? { cli_version: parseCliVersion(cliVersionProbe) } : {}),
    authentication: auth.authentication,
    ...(auth.method ? { authentication_method: auth.method } : {}),
    exec_available: execAvailable,
    mcp_server_available: mcpProbe.available && mcpProbe.exit_code === 0,
    supports: {
      start: providerAvailable,
      resume: providerAvailable,
      cancel: providerAvailable,
      streaming: providerAvailable,
      read_only: providerAvailable,
      workspace_write: providerAvailable
    },
    notes
  };
}
