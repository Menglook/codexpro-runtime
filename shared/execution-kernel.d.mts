export interface RunIdentity { version: number; runId: string; ownerId: string; fencingToken: number; kind: string; pid: number; }
export interface WorkspaceLease {
  version: number; name: string; run_id: string; owner_token: string; fencing_token: number; pid: number; managed_pid?: number; kind: string; workspace: string;
  acquired_at: string; heartbeat_at: string; expires_at: string; contextDir: string; leaseDir: string; leaseFile: string; ttlMs: number;
}
export type ManagedProcessTerminationReason =
  | "spawn_unavailable"
  | "permission_denied"
  | "invalid_command"
  | "execution_hard_limit"
  | "no_progress_timeout"
  | "explicit_cancel"
  | "cancel_grace_expired"
  | "heartbeat_persistence_failed"
  | "spawn_hook_failed"
  | "process_tree_termination_failed"
  | "termination_failed";
export interface ManagedProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number; noProgressTimeoutMs?: number; killGraceMs?: number; maxOutputBytes?: number;
  shell?: boolean;
  heartbeatIntervalMs?: number; heartbeatFailureThreshold?: number; redact?: (value: unknown) => string; onSpawn?: (pid: number) => void | Promise<void>;
  onHeartbeat?: () => void | Promise<void>; onHeartbeatError?: (error: unknown, consecutiveFailures: number) => void | Promise<void>;
  onOutput?: (event: { stream: "stdout" | "stderr"; bytes: number; at: string }) => void | Promise<void>;
  onProgress?: (event: { stream: "stdout" | "stderr"; bytes: number; at: string }) => void | Promise<void>; signal?: AbortSignal;
  executionId?: string; execution_id?: string; correlationId?: string | null; correlation_id?: string | null; taskId?: string | null; task_id?: string | null;
  runId?: string | null; run_id?: string | null; stepId?: string | null; step_id?: string | null; domain?: string; operation?: string;
  sideEffectLevel?: string; side_effect_level?: string; riskLevel?: string; risk_level?: string; ownerFingerprint?: string | null; owner_fingerprint?: string | null;
  ownerId?: string; owner_id?: string; fencingToken?: number | null; fencing_token?: number | null; retryCount?: number; retry_count?: number;
  recordRoot?: string; root?: string; contextDir?: string; recordPath?: string; evidencePath?: string; evidenceCommand?: string; secrets?: string[];
  recordTracking?: boolean;
  returnRawStdout?: boolean; returnRawStderr?: boolean;
  onLifecycle?: (event: Record<string, any>) => void | Promise<void>; onUsage?: (event: Record<string, any>) => void | Promise<void>;
}
export interface ManagedProcessResult {
  exitCode: number | null; signal: NodeJS.Signals | null; durationMs: number; timedOut: boolean; cancelled: boolean;
  stdout: string; stderr: string; truncated: boolean; spawnError: boolean; pid: number | null; treeTerminated: boolean;
  terminationReason: ManagedProcessTerminationReason | null; terminationRequestedAt: string | null; forceUsed: boolean;
  heartbeatFailures: number; lastProgressAt: string; lastHeartbeatAt?: string | null; errorClass?: string | null;
  executionId?: string; commandFingerprint?: string; recordPath?: string; evidencePath?: string;
}
export function atomicWriteFileSync(filePath: string, value: string | Buffer, options?: { mode?: number }): void;
export function atomicWriteJsonSync(filePath: string, value: unknown, options?: { mode?: number }): void;
export function appendJsonLineSync(filePath: string, value: unknown, options?: { mode?: number }): void;
export function readJsonFileSync(filePath: string): Record<string, any> | undefined;
export function createRunIdentity(kind?: string, runId?: string): RunIdentity;
export function createRunDirectorySync(root: string, contextDir: string, runId: string): string;
export function atomicWriteOwnedJsonSync(filePath: string, value: any, options?: { ownerId?: string; fencingToken?: number; replaceOwner?: boolean; mode?: number }): void;
export function isProcessAlive(pid: number): boolean;
export function isProcessTreeAlive(pid: number): boolean;
export function terminateProcessTree(pid: number, options?: { force?: boolean; signal?: NodeJS.Signals }): boolean;
export function waitForProcessTreeExit(pid: number, timeoutMs?: number): Promise<boolean>;
export function classifyProcessExecutionError(input?: Record<string, any>): string | null;
export function runManagedProcess(command: string, args: string[], options?: ManagedProcessOptions): Promise<ManagedProcessResult>;
export function runManagedProcessSync(command: string, args: string[], options?: ManagedProcessOptions & {
  timeout?: number; maxBuffer?: number; stdio?: "pipe" | "ignore" | "inherit" | Array<any>;
}): ManagedProcessResult & { status?: number | null; error?: string };
export function startManagedProcess(command: string, args: string[], options?: ManagedProcessOptions & {
  detached?: boolean; captureOutput?: boolean; stdio?: "pipe" | "ignore" | "inherit" | Array<any>;
  onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void;
}): {
  child: any | null;
  completion: Promise<ManagedProcessResult>;
  cancel: () => boolean;
  executionId: string;
  commandFingerprint: string;
  recordPath: string;
  evidencePath: string;
  errorClass: string | null;
};
export function readWorkspaceLeaseSync(root: string, options?: { contextDir?: string; name?: string }): {
  executionDir: string; leaseDir: string; leaseFile: string; lease?: Record<string, any>; active: boolean; stale: boolean;
  expired: boolean; owner_alive: boolean; managed_alive: boolean;
};
export function acquireWorkspaceLeaseSync(root: string, options?: {
  contextDir?: string; name?: string; ttlMs?: number; kind?: string; runId?: string; ownerId?: string; pid?: number; managedPid?: number;
}): WorkspaceLease;
export function heartbeatWorkspaceLeaseSync(root: string, lease: WorkspaceLease, options?: { contextDir?: string; name?: string; managedPid?: number }): WorkspaceLease;
export function releaseWorkspaceLeaseSync(root: string, lease?: WorkspaceLease, options?: { contextDir?: string; name?: string }): boolean;
export function assertNoActiveWorkspaceWriterSync(root: string, options?: { contextDir?: string; name?: string }): Record<string, any> | undefined;
