#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { applyBrowserRuntimeEnv } from "../shared/browser-runtime-env.mjs";
import { recoverConfiguredDurableJobs } from "./jobs/jobStartup.js";
import { createCodexProServer } from "./server.js";

const CODEXPRO_VERSION = "0.1.0";

function printHelp(): void {
  console.log(`CodexPro MCP stdio server

Usage:
  codexpro-mcp --root /path/to/repo [--allow-root /path]
  codexpro-mcp --version
  codexpro-mcp --help

Most users should run: codexpro start`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  applyBrowserRuntimeEnv(process.env);
  const config = loadConfig();
  const recovery = await recoverConfiguredDurableJobs(config);
  if (recovery.resumed.length || recovery.recovery_required.length || recovery.stale.length || recovery.errors.length) {
    console.error(`[CodexPro] durable job recovery scanned=${recovery.scanned} resumed=${recovery.resumed.length} recovery_required=${recovery.recovery_required.length} stale=${recovery.stale.length} errors=${recovery.errors.length}`);
  }
  const server = createCodexProServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
