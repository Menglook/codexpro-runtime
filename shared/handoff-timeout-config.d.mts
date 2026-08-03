export const HANDOFF_EXECUTION_TIMEOUT_DEFAULT_MS: number;
export const HANDOFF_EXECUTION_TIMEOUT_ENV: string;

export type HandoffExecutionTimeoutSource = "cli" | "config" | "environment" | "default";

export interface HandoffExecutionTimeoutResolution {
  timeoutMs: number;
  source: HandoffExecutionTimeoutSource;
  sourceLabel: string;
}

export interface HandoffExecutionTimeoutOptions {
  cliValue?: unknown;
  configValue?: unknown;
  configSource?: string;
  env?: Record<string, string | undefined>;
}

export function parseHandoffExecutionTimeoutMs(value: unknown, sourceLabel: string): number;
export function extractHandoffExecutionTimeoutConfig(config: unknown): unknown;
export function readProjectHandoffExecutionTimeoutConfig(root: string): unknown;
export function resolveHandoffExecutionTimeoutMs(options?: HandoffExecutionTimeoutOptions): HandoffExecutionTimeoutResolution;
export function formatHandoffExecutionTimeout(timeoutMs: number): string;
