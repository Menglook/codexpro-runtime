import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "../config.js";
import { runProcess } from "../runtime/processWrapper.js";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizedEndpoint(config: CodexProConfig): URL | undefined {
  if (!config.browserCdpUrl) return undefined;
  try {
    return new URL(config.browserCdpUrl);
  } catch {
    return undefined;
  }
}

async function endpointReachable(config: CodexProConfig): Promise<boolean> {
  const endpoint = normalizedEndpoint(config);
  if (!endpoint) return false;
  try {
    const base = endpoint.toString().replace(/\/$/, "");
    const response = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(Math.min(config.browserCdpConnectTimeoutMs, 2_000)),
      headers: { accept: "application/json" }
    });
    if (!response.ok) return false;
    const payload = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

export function browserBridgeLifecycleArgs(action: "start" | "stop", config: CodexProConfig): string[] {
  const root = repoRoot();
  const args = [path.join(root, "scripts", "browser-bridge.mjs"), action, "--json"];
  const endpoint = normalizedEndpoint(config);
  if (endpoint?.port) args.push("--port", endpoint.port);
  if (config.browserCdpProfileDir) args.push("--profile", config.browserCdpProfileDir);
  if (endpoint?.hostname) args.push("--address", endpoint.hostname);
  return args;
}

async function runLifecycleAction(action: "start" | "stop", config: CodexProConfig, workspaceRoot: string): Promise<void> {
  const root = repoRoot();
  const result = await runProcess(process.execPath, browserBridgeLifecycleArgs(action, config), {
    cwd: root,
    recordRoot: workspaceRoot,
    domain: "worker",
    operation: `browser_bridge_auto_${action}`,
    sideEffectLevel: "local_write",
    riskLevel: action === "stop" ? "medium" : "low",
    timeoutMs: 25_000,
    maxOutputBytes: 512 * 1024,
    componentTracking: false,
    usageTracking: false
  });
  if (result.exitCode !== 0) {
    const reason = String(result.stderr || result.stdout || result.errorClass || "unknown error").trim();
    throw new Error(`Browser Bridge ${action} failed: ${reason}`);
  }
}

export async function ensureDedicatedBrowserBridge(config: CodexProConfig, workspaceRoot: string): Promise<void> {
  if (config.browserMode !== "cdp") return;
  if (await endpointReachable(config)) return;
  await runLifecycleAction("start", config, workspaceRoot);
  if (!(await endpointReachable(config))) {
    throw new Error("Dedicated CodexPro Chrome did not become reachable after automatic start.");
  }
}

export async function stopDedicatedBrowserBridge(config: CodexProConfig, workspaceRoot: string): Promise<void> {
  if (config.browserMode !== "cdp") return;
  await runLifecycleAction("stop", config, workspaceRoot);
}
