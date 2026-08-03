import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "../config.js";
import { ExecCodexAdapter } from "./execAdapter.js";
import { MockCodexAdapter } from "./mockAdapter.js";
import { RoutedCodexAdapter } from "./providerRouter.js";
import { SdkCodexAdapter } from "./sdkAdapter.js";
import type { CodexAdapter } from "./types.js";

const sharedAdapters = new Map<string, CodexAdapter | null>();

function adapterKey(config: CodexProConfig): string {
  return [
    config.defaultRoot,
    config.contextDir,
    config.codexAdapter,
    config.codexExecutable,
    config.providerCapabilityCacheEnabled,
    config.providerCapabilityCacheAvailableTtlMs,
    config.providerCapabilityCacheUnavailableTtlMs,
    config.providerCapabilityCacheWarmup
  ].join("\u0000");
}

function schemaPath(name: string): string {
  return fileURLToPath(new URL(`../../schemas/${name}`, import.meta.url));
}

function execAdapter(config: CodexProConfig): ExecCodexAdapter {
  return new ExecCodexAdapter({
    executable: config.codexExecutable,
    working_directory: config.defaultRoot,
    state_directory: path.join(config.defaultRoot, config.contextDir, "exec-runs"),
    result_schema_path: schemaPath("exec-result.schema.json"),
    review_schema_path: schemaPath("exec-review-result.schema.json"),
    slot_wait_timeout_ms: config.resourceWaitTimeoutMs
  });
}

export function createCodexAdapter(config: CodexProConfig): CodexAdapter | undefined {
  const key = adapterKey(config);
  if (sharedAdapters.has(key)) return sharedAdapters.get(key) ?? undefined;

  const adapter = config.codexAdapter === "off"
    ? undefined
    : config.codexAdapter === "mock"
      ? new MockCodexAdapter()
      : config.codexAdapter === "exec"
        ? execAdapter(config)
        : config.codexAdapter === "auto"
          ? new RoutedCodexAdapter({
              preferred_provider: "sdk",
              adapters: [
                new SdkCodexAdapter({
                  executable: config.codexExecutable,
                  codexPathOverride: config.codexExecutable
                })
              ],
              capability_cache: {
                enabled: config.providerCapabilityCacheEnabled,
                available_ttl_ms: config.providerCapabilityCacheAvailableTtlMs,
                unavailable_ttl_ms: config.providerCapabilityCacheUnavailableTtlMs,
                warmup: config.providerCapabilityCacheWarmup
              }
            })
          : new SdkCodexAdapter({
              executable: config.codexExecutable,
              codexPathOverride: config.codexExecutable
            });

  sharedAdapters.set(key, adapter ?? null);
  return adapter;
}
