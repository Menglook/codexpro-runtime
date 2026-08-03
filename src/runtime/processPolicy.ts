import type { ProcessExecutionDomain, ProcessSideEffectLevel } from "./processTypes.js";

export const PROCESS_ERROR_CLASSES = [
  "spawn_unavailable",
  "permission_denied",
  "invalid_command",
  "execution_hard_limit",
  "no_progress_timeout",
  "explicit_cancel",
  "process_tree_termination_failed",
  "heartbeat_persistence_failed",
  "workspace_lease_busy",
  "owner_mismatch",
  "fencing_mismatch",
  "network_tls",
  "network_dns",
  "network_proxy",
  "remote_rejected",
  "nonzero_exit"
] as const;

export type ProcessErrorClass = typeof PROCESS_ERROR_CLASSES[number];

export interface ProcessPolicyInput {
  domain?: ProcessExecutionDomain;
  operation?: string;
  sideEffectLevel?: ProcessSideEffectLevel;
  riskLevel?: string;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessPolicy {
  domain: ProcessExecutionDomain;
  operation: string;
  sideEffectLevel: ProcessSideEffectLevel;
  riskLevel: string;
  timeoutMs: number;
  noProgressTimeoutMs?: number;
  maxOutputBytes: number;
}

export function processPolicy(input: ProcessPolicyInput = {}): ProcessPolicy {
  return {
    domain: input.domain ?? "shell",
    operation: input.operation?.trim() || "process",
    sideEffectLevel: input.sideEffectLevel ?? "none",
    riskLevel: input.riskLevel?.trim() || "low",
    timeoutMs: Math.max(1_000, Math.min(input.timeoutMs ?? 30_000, 24 * 60 * 60_000)),
    ...(input.noProgressTimeoutMs && input.noProgressTimeoutMs > 0
      ? { noProgressTimeoutMs: Math.max(100, Math.min(input.noProgressTimeoutMs, 24 * 60 * 60_000)) }
      : {}),
    maxOutputBytes: Math.max(1_024, Math.min(input.maxOutputBytes ?? 120_000, 10_000_000))
  };
}

export function isProcessErrorClass(value: unknown): value is ProcessErrorClass {
  return typeof value === "string" && (PROCESS_ERROR_CLASSES as readonly string[]).includes(value);
}
