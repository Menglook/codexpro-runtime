import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus } from "../events/eventBus.js";
import { CodexProError, PathGuard, type Workspace } from "../guard.js";
import { DurableJobManager, type DurableJobStepHandlers } from "../jobs/jobManager.js";
import { scanDurableJobs } from "../jobs/jobRecovery.js";
import { DurableJobStore } from "../jobs/jobStore.js";
import type { DurableJobRecord, DurableJobStep, DurableJobStepDefinition, TaskProgress } from "../jobs/jobSteps.js";
import { redactSensitiveText } from "../redact.js";
import { ResourceGovernor } from "../resources/resourceGovernor.js";
import { publishAcceptanceOutcome, publishAcceptanceStarted } from "../tasks/taskReportPublishers.js";
import { assertActiveSkillCurrent } from "../skills/skillUsage.js";
import type { ActiveSkillRecord } from "../skills/types.js";
import { classifyCommand } from "./commandSafetyPolicy.js";
import {
  acceptanceCacheRelPath,
  finalizeAcceptanceResult,
  prepareAcceptanceRun,
  runAcceptance,
  type AcceptanceInputFingerprint,
  type AcceptanceRunOptions,
  type AcceptanceRunPreparation,
  type AcceptanceRunProgress,
  type AcceptanceRunResult,
  type AcceptanceRunStatus
} from "./acceptanceEngine.js";
import { validateAcceptanceReceipt } from "./acceptanceReceipt.js";

export type AcceptanceExecutionMode = "auto" | "sync" | "async";
export type AsyncAcceptanceValidationStatus = AcceptanceRunStatus | "pending" | "not_completed";

interface PersistedAcceptanceOptions {
  profile?: string;
  stop_on_failure: boolean;
  session_id?: string;
  changed_files: string[];
  active_skill?: ActiveSkillRecord;
}

interface PersistedAcceptanceInput {
  task_type: "acceptance";
  acceptance_key: string;
  options: PersistedAcceptanceOptions;
  preparation: {
    requested_profile: string;
    configured_profile: string;
    effective_profile: string;
    selection_reason: string;
    cache_key: string;
    cache_rel_path: string;
    command_count: number;
    max_command_timeout_ms: number;
    input_fingerprint: AcceptanceInputFingerprint;
  };
}

export type AcceptanceOwnershipStatus = "claimed" | "coalesced" | "recovery_required";

export interface AcceptanceKeyIndex {
  version: 1;
  acceptance_key: string;
  run_id: string;
  workspace_root: string;
  profile: string;
  cache_key: string;
  stop_on_failure: boolean;
  active_skill_digest?: string;
  status: "claiming" | DurableJobRecord["status"];
  owner_pid: number;
  owner_token: string;
  fencing_token: number;
  created_at: string;
  heartbeat_at: string;
  report_path: string | null;
  result_path: string | null;
  input: PersistedAcceptanceInput;
}

export interface AsyncAcceptanceState {
  task_type: "acceptance";
  acceptance_key: string;
  run_id: string;
  execution_status: DurableJobRecord["status"];
  validation_status: AsyncAcceptanceValidationStatus;
  transport_status: "response_complete";
  ownership_status: AcceptanceOwnershipStatus;
  coalesced: boolean;
  cache_hit: boolean;
  requested_profile: string;
  configured_profile: string;
  profile: string;
  selection_reason: string;
  cache_key: string;
  command_count: number;
  max_command_timeout_ms: number;
  input_fingerprint: AcceptanceInputFingerprint;
  workspace_id: string;
  workspace_root: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  current_step_id: string | null;
  progress: TaskProgress;
  steps: DurableJobStep[];
  cancel_requested: boolean;
  result_available: boolean;
  report_path?: string;
  result_path?: string;
  error?: string;
  recovery_reason?: string;
  owner_token: string;
  fencing_token: number;
  resource_status: "admitted" | "queued_by_resource_policy" | "released" | "unknown";
  resource_pools: string[];
  queue_id: string | null;
  queue_position: number | null;
  blocking_reasons: string[];
  queued_at: string | null;
  queue_deadline: string | null;
  resource_wait_timeout_ms: number | null;
  lease_id: string | null;
  validation_started: boolean;
  start_status: "not_started" | "started" | "completed";
}

const SAFE_RUN_ID = /^[a-z0-9._-]{1,80}$/;
const SAFE_ACCEPTANCE_KEY = /^[a-f0-9]{64}$/;
const TERMINAL_JOB_STATUSES = new Set<DurableJobRecord["status"]>(["completed", "failed", "blocked", "cancelled"]);
const KNOWN_LONG_PROFILES = new Set(["runtime-certification", "full", "release", "browser"]);
const activeAcceptanceTasks = new Map<string, Promise<void>>();
const RESULT_TEXT_MAX_CHARS = 60_000;
const ACCEPTANCE_INDEX_WAIT_MS = 2_000;
const ACCEPTANCE_INDEX_POLL_MS = 20;

export interface CoalescedAcceptanceProgressReporter {
  report(progress: AcceptanceRunProgress): void;
  flush(): Promise<void>;
}

export function createCoalescedAcceptanceProgressReporter(
  write: (progress: AcceptanceRunProgress) => Promise<void>
): CoalescedAcceptanceProgressReporter {
  let latest: AcceptanceRunProgress | undefined;
  let active: Promise<void> | undefined;
  let failure: unknown;

  const start = (): void => {
    if (active || !latest || failure) return;
    active = (async () => {
      while (latest && !failure) {
        const progress = latest;
        latest = undefined;
        try {
          await write(progress);
        } catch (error) {
          failure = error;
          latest = undefined;
        }
      }
    })().finally(() => {
      active = undefined;
      if (latest && !failure) start();
    });
  };

  return {
    report(progress) {
      latest = progress;
      start();
    },
    async flush() {
      while (active || latest) {
        start();
        if (active) await active;
      }
      if (failure) throw failure;
    }
  };
}

function acceptanceIndexStaleMs(): number {
  const configured = Number(process.env.CODEXPRO_ACCEPTANCE_KEY_STALE_MS ?? 30_000);
  return Number.isFinite(configured) ? Math.max(100, Math.floor(configured)) : 30_000;
}

function acceptanceKeyFor(
  workspace: Workspace,
  preparation: AcceptanceRunPreparation,
  activeSkill?: ActiveSkillRecord
): string {
  return createHash("sha256").update(JSON.stringify({
    workspace_id: workspace.id,
    workspace_root: path.resolve(workspace.root),
    workspace_generation: workspace.workspaceGeneration ?? null,
    cache_key: preparation.cache_key,
    effective_profile: preparation.selection.effective_profile,
    stop_on_failure: preparation.stop_on_failure,
    active_skill_digest: activeSkill?.digest ?? preparation.input_fingerprint.active_skill_digest ?? null
  })).digest("hex");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function indexHeartbeatAgeMs(index: AcceptanceKeyIndex): number {
  const parsed = Date.parse(index.heartbeat_at);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : Number.POSITIVE_INFINITY;
}

function normalizeRunId(input?: string): string {
  const requested = input?.trim();
  const generated = `acceptance-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "z")}-${randomUUID().slice(0, 8)}`;
  const normalized = (requested || generated)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!SAFE_RUN_ID.test(normalized)) throw new CodexProError("Invalid acceptance run id.");
  return normalized;
}

function clip(value: string | undefined, maxChars = RESULT_TEXT_MAX_CHARS): string | undefined {
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`;
}

function executionKey(workspace: Workspace, runId: string): string {
  return `${workspace.root}\u0000${runId}`;
}

function isKnownLongPreparation(preparation: AcceptanceRunPreparation): boolean {
  return [
    preparation.selection.requested_profile,
    preparation.selection.configured_profile,
    preparation.selection.effective_profile
  ].some((profile) => KNOWN_LONG_PROFILES.has(profile.toLowerCase()));
}

export function shouldStartAsyncAcceptance(
  preparation: AcceptanceRunPreparation,
  mode: AcceptanceExecutionMode = "auto"
): boolean {
  if (preparation.command_count === 0) return false;
  if (mode === "async") return true;
  const knownLong = isKnownLongPreparation(preparation);
  if (mode === "sync") {
    if (knownLong) {
      throw new CodexProError(
        `Acceptance profile ${preparation.selection.effective_profile} is a known long-running profile and cannot hold a public MCP response open. Use execution_mode=async or auto.`
      );
    }
    return false;
  }
  return knownLong
    || preparation.command_count > 1
    || preparation.max_command_timeout_ms > 30_000;
}

export class AcceptanceJobStore extends DurableJobStore {
  private readonly acceptanceRunsRoot: string;

  constructor(
    guard: PathGuard,
    workspace: Workspace,
    readonly acceptanceConfig: CodexProConfig
  ) {
    super(guard, workspace, acceptanceConfig);
    this.acceptanceRunsRoot = `${acceptanceConfig.contextDir.replace(/\/+$/, "")}/acceptance-runs`;
  }

  override runRoot(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`Invalid acceptance run id: ${runId}`);
    return `${this.acceptanceRunsRoot}/${runId}`;
  }

  resultPath(runId: string): string {
    return `${this.runRoot(runId)}/result.json`;
  }

  draftResultPath(runId: string): string {
    return `${this.runRoot(runId)}/acceptance-result-draft.json`;
  }

  browserEvidencePath(runId: string): string {
    return `${this.runRoot(runId)}/browser-evidence.json`;
  }

  keyIndexRoot(): string {
    return `${this.acceptanceRunsRoot}/by-key`;
  }

  keyIndexPath(acceptanceKey: string): string {
    if (!SAFE_ACCEPTANCE_KEY.test(acceptanceKey)) throw new Error(`Invalid acceptance key: ${acceptanceKey}`);
    return `${this.keyIndexRoot()}/${acceptanceKey}.json`;
  }

  async readKeyIndex(acceptanceKey: string): Promise<AcceptanceKeyIndex | undefined> {
    return await this.readJson<AcceptanceKeyIndex>(this.keyIndexPath(acceptanceKey));
  }

  async claimKeyIndex(index: AcceptanceKeyIndex): Promise<boolean> {
    const relativePath = this.keyIndexPath(index.acceptance_key);
    const resolved = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const temporary = `${resolved.absPath}.claim-${process.pid}-${randomUUID().slice(0, 8)}`;
    await fsp.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await fsp.link(temporary, resolved.absPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async writeKeyIndex(index: AcceptanceKeyIndex): Promise<void> {
    await this.writeJson(this.keyIndexPath(index.acceptance_key), index);
  }

  private keyClaimLockPath(acceptanceKey: string): string {
    if (!SAFE_ACCEPTANCE_KEY.test(acceptanceKey)) throw new Error(`Invalid acceptance key: ${acceptanceKey}`);
    return `${this.acceptanceRunsRoot}/by-key-locks/${acceptanceKey}.lock`;
  }

  private keyHistoryPath(index: AcceptanceKeyIndex): string {
    return `${this.acceptanceRunsRoot}/by-key-history/${index.acceptance_key}/${index.run_id}.json`;
  }

  async withKeyClaimLock<T>(acceptanceKey: string, operation: () => Promise<T>): Promise<T> {
    const resolved = this.guard.resolve(this.workspace, this.keyClaimLockPath(acceptanceKey), { forWrite: true });
    const ownerPath = path.join(resolved.absPath, "owner.json");
    const ownerToken = randomUUID();
    const deadline = Date.now() + ACCEPTANCE_INDEX_WAIT_MS;
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    while (true) {
      try {
        await fsp.mkdir(resolved.absPath, { recursive: false, mode: 0o700 });
        try {
          await fsp.writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, owner_token: ownerToken, created_at: new Date().toISOString() }, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600
          });
        } catch (error) {
          await fsp.rm(resolved.absPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(await fsp.readFile(ownerPath, "utf8")) as { pid?: number; created_at?: string };
          const createdAt = Date.parse(String(owner.created_at ?? ""));
          const ageMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : Number.POSITIVE_INFINITY;
          stale = ageMs > acceptanceIndexStaleMs() && !isProcessAlive(Number(owner.pid ?? 0));
        } catch {
          const stat = await fsp.stat(resolved.absPath).catch(() => undefined);
          stale = Boolean(stat && Date.now() - stat.mtimeMs > acceptanceIndexStaleMs());
        }
        if (stale) {
          await fsp.rm(resolved.absPath, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) throw new CodexProError(`Timed out waiting to claim acceptance key ${acceptanceKey}.`);
        await new Promise((resolve) => setTimeout(resolve, ACCEPTANCE_INDEX_POLL_MS));
      }
    }
    try {
      return await operation();
    } finally {
      const owner = await fsp.readFile(ownerPath, "utf8").then((value) => JSON.parse(value) as { owner_token?: string }).catch(() => undefined);
      if (owner?.owner_token === ownerToken) {
        await fsp.rm(resolved.absPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async retireKeyIndex(index: AcceptanceKeyIndex): Promise<boolean> {
    const current = await this.readKeyIndex(index.acceptance_key);
    if (!current || current.run_id !== index.run_id) return false;
    await this.writeJson(this.keyHistoryPath(current), current);
    const confirmed = await this.readKeyIndex(index.acceptance_key);
    if (!confirmed || confirmed.run_id !== current.run_id) return false;
    const resolved = this.guard.resolve(this.workspace, this.keyIndexPath(index.acceptance_key), { forWrite: true });
    await fsp.rm(resolved.absPath, { force: true });
    return true;
  }

  override async listJobIds(): Promise<string[]> {
    const resolved = this.guard.resolve(this.workspace, this.acceptanceRunsRoot);
    try {
      const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !["by-key", "by-key-locks", "by-key-history"].includes(entry.name) && SAFE_RUN_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

function managerFor(config: CodexProConfig, guard: PathGuard, workspace: Workspace): DurableJobManager {
  return new DurableJobManager(new AcceptanceJobStore(guard, workspace, config), {
    deferSuccessfulTerminalReport: true
  });
}

function acceptanceStore(manager: DurableJobManager): AcceptanceJobStore {
  if (!(manager.store instanceof AcceptanceJobStore)) throw new Error("Acceptance Durable Job store is not configured.");
  return manager.store;
}

function preparationFromInput(input: PersistedAcceptanceInput): AcceptanceRunPreparation {
  return {
    selection: {
      requested_profile: input.preparation.requested_profile,
      configured_profile: input.preparation.configured_profile,
      effective_profile: input.preparation.effective_profile,
      alias_chain: [],
      reason: input.preparation.selection_reason,
      changed_files: input.options.changed_files,
      ignored_changed_files: [],
      allowed_targeted_smoke_commands: [],
      commands: []
    },
    stop_on_failure: input.options.stop_on_failure,
    cache_key: input.preparation.cache_key,
    cache_rel_path: input.preparation.cache_rel_path,
    input_fingerprint: input.preparation.input_fingerprint,
    input_changed_files: input.options.changed_files,
    command_count: input.preparation.command_count,
    max_command_timeout_ms: input.preparation.max_command_timeout_ms
  };
}

function normalizePersistedAcceptanceInput(
  config: CodexProConfig,
  workspace: Workspace,
  input: PersistedAcceptanceInput
): PersistedAcceptanceInput {
  const cacheRelPath = typeof input.preparation.cache_rel_path === "string" && input.preparation.cache_rel_path.trim()
    ? input.preparation.cache_rel_path
    : acceptanceCacheRelPath(config, input.preparation.cache_key);
  const withCachePath: PersistedAcceptanceInput = {
    ...input,
    acceptance_key: typeof input.acceptance_key === "string" ? input.acceptance_key : "",
    preparation: {
      ...input.preparation,
      cache_rel_path: cacheRelPath
    }
  };
  const acceptanceKey = SAFE_ACCEPTANCE_KEY.test(withCachePath.acceptance_key)
    ? withCachePath.acceptance_key
    : acceptanceKeyFor(workspace, preparationFromInput(withCachePath), input.options.active_skill);
  return {
    ...withCachePath,
    acceptance_key: acceptanceKey
  };
}

async function readPersistedAcceptanceInput(
  config: CodexProConfig,
  store: AcceptanceJobStore,
  runId: string
): Promise<PersistedAcceptanceInput | undefined> {
  const input = await store.readJson<PersistedAcceptanceInput>(store.inputPath(runId));
  if (!input || input.task_type !== "acceptance") return undefined;
  return normalizePersistedAcceptanceInput(config, store.workspace, input);
}

async function updateKeyIndex(
  store: AcceptanceJobStore,
  input: PersistedAcceptanceInput,
  patch: Partial<AcceptanceKeyIndex>
): Promise<void> {
  const current = await store.readKeyIndex(input.acceptance_key).catch(() => undefined);
  if (!current || (patch.run_id !== undefined && current.run_id !== patch.run_id)) return;
  await store.writeKeyIndex({
    ...current,
    ...patch,
    acceptance_key: current.acceptance_key,
    run_id: current.run_id,
    heartbeat_at: new Date().toISOString()
  });
}

async function ensureKeyIndexForExistingJob(
  store: AcceptanceJobStore,
  input: PersistedAcceptanceInput,
  job: DurableJobRecord
): Promise<AcceptanceKeyIndex> {
  const existing = await store.readKeyIndex(input.acceptance_key).catch(() => undefined);
  if (existing) return existing;
  const result = await store.readJson<AcceptanceRunResult>(store.resultPath(job.run_id)).catch(() => undefined);
  const heartbeatAt = job.progress.heartbeat_at || job.updated_at || job.created_at;
  const candidate: AcceptanceKeyIndex = {
    version: 1,
    acceptance_key: input.acceptance_key,
    run_id: job.run_id,
    workspace_root: job.workspace_root,
    profile: input.preparation.effective_profile,
    cache_key: input.preparation.cache_key,
    stop_on_failure: input.options.stop_on_failure,
    ...(input.options.active_skill?.digest ? { active_skill_digest: input.options.active_skill.digest } : {}),
    status: job.status,
    owner_pid: job.owner_pid ?? process.pid,
    owner_token: job.owner_token ?? randomUUID(),
    fencing_token: Math.max(1, Number(job.fencing_token ?? 0)),
    created_at: job.created_at,
    heartbeat_at: heartbeatAt,
    report_path: result?.report_path ?? job.report_path ?? null,
    result_path: result ? store.resultPath(job.run_id) : null,
    input
  };
  if (await store.claimKeyIndex(candidate)) return candidate;
  const winner = await store.readKeyIndex(input.acceptance_key);
  if (!winner) throw new CodexProError(`Acceptance key ${input.acceptance_key} was claimed but its persistent index is unavailable.`);
  return winner;
}

export function classifyAcceptanceReplayPolicy(preparation: AcceptanceRunPreparation): Pick<DurableJobStepDefinition, "idempotent" | "retryable" | "side_effect_level" | "retry_policy" | "rollback_method"> {
  const categories = preparation.selection.commands.map((command) => classifyCommand(command.command));
  if (categories.some((category) => category === "unknown")) {
    return {
      idempotent: false,
      retryable: false,
      side_effect_level: "unknown",
      retry_policy: "never",
      rollback_method: "Inspect the persisted acceptance report and external command state before issuing a new acceptance run."
    };
  }
  return {
    idempotent: true,
    retryable: true,
    side_effect_level: "local_write",
    retry_policy: "automatic",
    rollback_method: "Regenerate the local acceptance report and result from the same content-bound validation input."
  };
}

function stepDefinitions(preparation: AcceptanceRunPreparation): DurableJobStepDefinition[] {
  const longRunning = isKnownLongPreparation(preparation);
  const replay = classifyAcceptanceReplayPolicy(preparation);
  const stepTimeoutMs = Math.max(30 * 60_000, preparation.max_command_timeout_ms * Math.max(1, preparation.command_count));
  const automaticLocal = {
    idempotent: true,
    retryable: true,
    side_effect_level: "local_write" as const,
    retry_policy: "automatic" as const,
    rollback_method: "Regenerate this content-bound Acceptance artifact from persisted prior-step output."
  };
  return [
    {
      step_id: "01-prepare-acceptance",
      phase: "planning",
      action: `Prepare persisted acceptance profile ${preparation.selection.effective_profile}`,
      ...automaticLocal,
      step_timeout_ms: 60_000,
      no_progress_timeout_ms: 60_000
    },
    {
      step_id: "02-run-validation-commands",
      phase: "validating",
      action: `Run validation commands for ${preparation.selection.effective_profile}`,
      ...replay,
      step_timeout_ms: stepTimeoutMs,
      no_progress_timeout_ms: stepTimeoutMs,
      resource_category: longRunning ? "heavy" : "standard",
      resource_pools: longRunning ? ["global_standard", "full_acceptance"] : ["global_standard"]
    },
    {
      step_id: "03-run-browser-checks",
      phase: "validating",
      action: "Validate persisted browser evidence from Acceptance commands",
      ...automaticLocal,
      step_timeout_ms: 60_000,
      no_progress_timeout_ms: 60_000
    },
    {
      step_id: "04-write-acceptance-report",
      phase: "reporting",
      action: "Persist the final Acceptance result and verify its report",
      ...automaticLocal,
      step_timeout_ms: 60_000,
      no_progress_timeout_ms: 60_000
    },
    {
      step_id: "05-publish-acceptance-receipt",
      phase: "finalizing",
      action: "Publish the idempotent content-bound Acceptance receipt",
      ...automaticLocal,
      step_timeout_ms: 60_000,
      no_progress_timeout_ms: 60_000
    }
  ];
}

function buildHandlers(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  manager: DurableJobManager
): DurableJobStepHandlers {
  const loadInput = async (runId: string): Promise<{ store: AcceptanceJobStore; input: PersistedAcceptanceInput }> => {
    const store = acceptanceStore(manager);
    const input = await readPersistedAcceptanceInput(config, store, runId);
    if (!input) throw new Error(`Acceptance input not found: ${runId}`);
    return { store, input };
  };
  return {
    "01-prepare-acceptance": async ({ job, heartbeat }) => {
      const { store, input } = await loadInput(job.run_id);
      await updateKeyIndex(store, input, { run_id: job.run_id, status: "running", owner_pid: process.pid });
      await publishAcceptanceStarted(guard, workspace, job.run_id, input.preparation.effective_profile, job.input_path);
      await heartbeat("Acceptance preparation persisted", job.input_path);
      return {
        summary: `Acceptance ${input.preparation.effective_profile} prepared.`,
        data: { acceptance_key: input.acceptance_key, input_hash: input.preparation.cache_key },
        evidence_paths: [job.input_path]
      };
    },
    "02-run-validation-commands": async ({ job, heartbeat, signal, isCancellationRequested }) => {
      const { store, input } = await loadInput(job.run_id);
      if (signal.aborted || await isCancellationRequested()) {
        const error = new Error("Acceptance cancelled before validation started.");
        error.name = "AbortError";
        throw error;
      }
      const progressReporter = createCoalescedAcceptanceProgressReporter(async (progress) => {
        const ordinal = progress.command_index + 1;
        const action = progress.phase === "command_started" ? "started" : "completed";
        await heartbeat(`Acceptance command ${ordinal}/${progress.command_count} ${action}: ${progress.command_name}`, job.input_path);
      });
      const result = await runAcceptance(config, guard, workspace, {
        profile: input.options.profile,
        stopOnFailure: input.options.stop_on_failure,
        sessionId: input.options.session_id,
        changedFiles: input.options.changed_files,
        runId: job.run_id,
        activeSkill: input.options.active_skill,
        signal,
        allowCacheReuse: false,
        deferFinalization: true,
        acceptanceKey: input.acceptance_key,
        inputHash: input.preparation.cache_key,
        onProgress: (progress) => progressReporter.report(progress)
      });
      await progressReporter.flush();
      const draftPath = store.draftResultPath(job.run_id);
      await store.writeJson(draftPath, result);
      await heartbeat("Acceptance validation result persisted", draftPath);
      return {
        summary: `Acceptance commands completed with status ${result.status}.`,
        data: { acceptance_status: result.status, validation_ok: result.ok, draft_path: draftPath },
        evidence_paths: [result.report_path, draftPath]
      };
    },
    "03-run-browser-checks": async ({ job, heartbeat }) => {
      const { store } = await loadInput(job.run_id);
      const draft = await store.readJson<AcceptanceRunResult>(store.draftResultPath(job.run_id));
      if (!draft) throw new Error(`Acceptance draft result not found: ${job.run_id}`);
      const browserCommands = draft.commands.filter((command) => Boolean(command.browser_smoke_summary));
      const evidencePath = store.browserEvidencePath(job.run_id);
      await store.writeJson(evidencePath, {
        version: 1,
        run_id: job.run_id,
        browser_command_count: browserCommands.length,
        browser_summaries: browserCommands.map((command) => command.browser_smoke_summary),
        verified_at: new Date().toISOString()
      });
      await heartbeat("Acceptance browser evidence verified", evidencePath);
      return {
        summary: `Browser evidence checkpoint completed for ${browserCommands.length} command(s).`,
        data: { browser_command_count: browserCommands.length, browser_evidence_path: evidencePath },
        evidence_paths: [evidencePath]
      };
    },
    "04-write-acceptance-report": async ({ job, heartbeat }) => {
      const { store } = await loadInput(job.run_id);
      const draft = await store.readJson<AcceptanceRunResult>(store.draftResultPath(job.run_id));
      if (!draft) throw new Error(`Acceptance draft result not found: ${job.run_id}`);
      await fsp.access(guard.resolve(workspace, draft.report_path).absPath);
      const resultPath = store.resultPath(job.run_id);
      await store.writeJson(resultPath, draft);
      await heartbeat("Acceptance report and result persisted", resultPath);
      return {
        summary: `Acceptance report persisted with status ${draft.status}.`,
        data: { acceptance_status: draft.status, report_path: draft.report_path, result_path: resultPath },
        evidence_paths: [draft.report_path, resultPath]
      };
    },
    "05-publish-acceptance-receipt": async ({ job, heartbeat }) => {
      const { store, input } = await loadInput(job.run_id);
      const resultPath = store.resultPath(job.run_id);
      const result = await store.readJson<AcceptanceRunResult>(resultPath);
      if (!result) throw new Error(`Acceptance result not found: ${job.run_id}`);
      await finalizeAcceptanceResult(config, guard, workspace, result, {
        acceptanceKey: input.acceptance_key,
        inputHash: input.preparation.cache_key
      });
      await store.writeJson(resultPath, result);
      await updateKeyIndex(store, input, {
        run_id: job.run_id,
        status: "completed",
        owner_pid: process.pid,
        report_path: result.report_path,
        result_path: resultPath
      });
      await heartbeat("Acceptance receipt published", result.acceptance_receipt?.path ?? resultPath);
      return {
        summary: `Acceptance ${result.status}; receipt=${result.acceptance_receipt?.reason ?? "not_written"}.`,
        data: {
          acceptance_status: result.status,
          validation_ok: result.ok,
          report_path: result.report_path,
          result_path: resultPath,
          receipt_reason: result.acceptance_receipt?.reason ?? null
        },
        evidence_paths: [result.report_path, resultPath, ...(result.acceptance_receipt?.path ? [result.acceptance_receipt.path] : [])]
      };
    }
  };
}

async function executeAcceptanceTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string
): Promise<void> {
  const manager = managerFor(config, guard, workspace);
  const store = acceptanceStore(manager);
  const input = await readPersistedAcceptanceInput(config, store, runId);
  if (!input) throw new Error(`Acceptance input not found: ${runId}`);
  const definitions = stepDefinitions(preparationFromInput(input));
  const handlers = buildHandlers(config, guard, workspace, manager);
  const job = await manager.execute(runId, handlers, definitions);
  const result = await store.readJson<AcceptanceRunResult>(store.resultPath(runId));
  if (result) {
    job.report_path = result.report_path;
    job.result_summary = `Acceptance ${result.status}; validation_ok=${result.ok}; report=${result.report_path}`;
    await store.writeJob(job);
    await manager.publishTerminalReport(job);
    await publishAcceptanceOutcome(guard, workspace, runId, result, store.resultPath(runId), "finalized");
  } else await manager.publishTerminalReport(job);
  await updateKeyIndex(store, input, {
    run_id: runId,
    status: job.status,
    owner_pid: process.pid,
    report_path: result?.report_path ?? job.report_path ?? null,
    result_path: result ? store.resultPath(runId) : null
  });
}

function scheduleExecution(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string
): void {
  const key = executionKey(workspace, runId);
  if (activeAcceptanceTasks.has(key)) return;
  const promise = executeAcceptanceTask(config, guard, workspace, runId)
    .catch(async (error) => {
      const manager = managerFor(config, guard, workspace);
      const store = acceptanceStore(manager);
      const input = await readPersistedAcceptanceInput(config, store, runId).catch(() => undefined);
      if (input) {
        const current = await store.readJob(runId).catch(() => undefined);
        await updateKeyIndex(store, input, {
          run_id: runId,
          status: current && TERMINAL_JOB_STATUSES.has(current.status) ? current.status : "recovery_required",
          owner_pid: process.pid,
          report_path: current?.report_path ?? null
        }).catch(() => undefined);
      }
      console.error(`[CodexPro] durable acceptance ${runId} failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    })
    .finally(() => activeAcceptanceTasks.delete(key));
  activeAcceptanceTasks.set(key, promise);
}

interface StateProjectionOptions {
  coalesced?: boolean;
  cache_hit?: boolean;
  ownership_status?: AcceptanceOwnershipStatus;
}

interface AcceptanceResourceState {
  resource_status: AsyncAcceptanceState["resource_status"];
  resource_pools: string[];
  queue_id: string | null;
  queue_position: number | null;
  blocking_reasons: string[];
  queued_at: string | null;
  queue_deadline: string | null;
  resource_wait_timeout_ms: number | null;
  lease_id: string | null;
}

async function acceptanceResourceState(
  config: CodexProConfig,
  runId: string,
  executionStatus: DurableJobRecord["status"]
): Promise<AcceptanceResourceState> {
  const governor = new ResourceGovernor(config);
  const status = await governor.status();
  const taskId = `job-${runId}`;
  const lease = status.leases.find((entry) => entry.run_id === runId || entry.task_id === taskId || entry.request_id === `durable-job:${runId}`);
  if (lease) {
    return {
      resource_status: "admitted",
      resource_pools: lease.pools,
      queue_id: null,
      queue_position: null,
      blocking_reasons: [],
      queued_at: lease.queued_at ?? null,
      queue_deadline: lease.queue_deadline ?? null,
      resource_wait_timeout_ms: lease.resource_wait_timeout_ms ?? null,
      lease_id: lease.lease_id
    };
  }
  const queueIndex = status.queue.findIndex((entry) => entry.run_id === runId || entry.task_id === taskId || entry.request_id === `durable-job:${runId}`);
  const queue = queueIndex >= 0 ? status.queue[queueIndex] : undefined;
  if (queue) {
    return {
      resource_status: "queued_by_resource_policy",
      resource_pools: queue.pools,
      queue_id: queue.queue_id,
      queue_position: queueIndex + 1,
      blocking_reasons: queue.blocking_reasons,
      queued_at: queue.queued_at,
      queue_deadline: queue.queue_deadline ?? null,
      resource_wait_timeout_ms: queue.resource_wait_timeout_ms ?? null,
      lease_id: null
    };
  }
  return {
    resource_status: TERMINAL_JOB_STATUSES.has(executionStatus) ? "released" : "unknown",
    resource_pools: [],
    queue_id: null,
    queue_position: null,
    blocking_reasons: [],
    queued_at: null,
    queue_deadline: null,
    resource_wait_timeout_ms: null,
    lease_id: null
  };
}

async function stateFrom(
  manager: DurableJobManager,
  runId: string,
  options: StateProjectionOptions = {}
): Promise<AsyncAcceptanceState> {
  const store = acceptanceStore(manager);
  const { job, steps } = await manager.inspect(runId);
  const input = await readPersistedAcceptanceInput(store.acceptanceConfig, store, runId);
  if (!input) throw new CodexProError(`Acceptance run input not found: ${runId}`);
  const result = await store.readJson<AcceptanceRunResult>(store.resultPath(runId));
  const currentIndex = await store.readKeyIndex(input.acceptance_key).catch(() => undefined);
  const index = currentIndex?.run_id === runId ? currentIndex : undefined;
  const resource = await acceptanceResourceState(store.acceptanceConfig, runId, job.status);
  const validationStarted = steps.some((step) => step.attempts > 0);
  const validationStatus: AsyncAcceptanceValidationStatus = result?.status
    ?? (TERMINAL_JOB_STATUSES.has(job.status) || job.status === "recovery_required" || job.status === "stale" ? "not_completed" : "pending");
  const recoveryRequired = job.status === "recovery_required" || job.status === "stale";
  return {
    task_type: "acceptance",
    acceptance_key: input.acceptance_key,
    run_id: job.run_id,
    execution_status: job.status,
    validation_status: validationStatus,
    transport_status: "response_complete",
    ownership_status: options.ownership_status ?? (recoveryRequired ? "recovery_required" : "claimed"),
    coalesced: options.coalesced ?? false,
    cache_hit: options.cache_hit ?? result?.cache_hit ?? false,
    requested_profile: input.preparation.requested_profile,
    configured_profile: input.preparation.configured_profile,
    profile: input.preparation.effective_profile,
    selection_reason: input.preparation.selection_reason,
    cache_key: input.preparation.cache_key,
    command_count: input.preparation.command_count,
    max_command_timeout_ms: input.preparation.max_command_timeout_ms,
    input_fingerprint: input.preparation.input_fingerprint,
    workspace_id: job.workspace_id,
    workspace_root: job.workspace_root,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    duration_ms: job.duration_ms,
    current_step_id: job.current_step_id,
    progress: job.progress,
    steps,
    cancel_requested: job.cancel_requested,
    result_available: Boolean(result),
    report_path: result?.report_path ?? job.report_path,
    result_path: result ? store.resultPath(runId) : undefined,
    error: job.error,
    recovery_reason: job.recovery_reason,
    owner_token: index?.owner_token ?? "",
    fencing_token: index?.fencing_token ?? 0,
    ...resource,
    validation_started: validationStarted,
    start_status: result ? "completed" : validationStarted ? "started" : "not_started"
  };
}

function stateFromClaimingIndex(index: AcceptanceKeyIndex, workspace: Workspace): AsyncAcceptanceState {
  const now = new Date().toISOString();
  return {
    task_type: "acceptance",
    acceptance_key: index.acceptance_key,
    run_id: index.run_id,
    execution_status: "queued",
    validation_status: "pending",
    transport_status: "response_complete",
    ownership_status: "coalesced",
    coalesced: true,
    cache_hit: false,
    requested_profile: index.input.preparation.requested_profile,
    configured_profile: index.input.preparation.configured_profile,
    profile: index.input.preparation.effective_profile,
    selection_reason: index.input.preparation.selection_reason,
    cache_key: index.input.preparation.cache_key,
    command_count: index.input.preparation.command_count,
    max_command_timeout_ms: index.input.preparation.max_command_timeout_ms,
    input_fingerprint: index.input.preparation.input_fingerprint,
    workspace_id: workspace.id,
    workspace_root: workspace.root,
    created_at: index.created_at,
    current_step_id: "01-acceptance",
    progress: {
      phase: "claiming",
      current_step: 1,
      total_steps: 1,
      current_action: "Waiting for the original acceptance owner to finish task creation",
      heartbeat_at: index.heartbeat_at || now,
      liveness_at: index.heartbeat_at || now,
      progress_at: index.heartbeat_at || now,
      retries: 0,
      writer_active: false,
      browser_active: false,
      execution_state: "queued"
    },
    steps: [],
    cancel_requested: false,
    result_available: false,
    owner_token: index.owner_token,
    fencing_token: index.fencing_token,
    resource_status: "unknown",
    resource_pools: [],
    queue_id: null,
    queue_position: null,
    blocking_reasons: [],
    queued_at: null,
    queue_deadline: null,
    resource_wait_timeout_ms: null,
    lease_id: null,
    validation_started: false,
    start_status: "not_started"
  };
}

async function markIndexedRecoveryRequired(
  manager: DurableJobManager,
  index: AcceptanceKeyIndex,
  reason: string
): Promise<AsyncAcceptanceState> {
  const store = acceptanceStore(manager);
  let job = await store.readJob(index.run_id);
  if (!job) {
    job = await manager.create({
      run_id: index.run_id,
      kind: "task",
      title: `Acceptance recovery required: ${index.profile}`,
      workspace_id: store.workspace.id,
      workspace_root: store.workspace.root,
      input: index.input as unknown as Record<string, unknown>,
      ...(index.input.options.active_skill ? { active_skill: index.input.options.active_skill } : {}),
      steps: stepDefinitions(preparationFromInput(index.input)),
      loop_budget: {
        max_attempts_per_step: 1,
        max_repair_rounds: 0,
        max_same_failure_repeats: 1,
        max_full_validation_runs: 1,
        max_browser_reconnects: 0,
        max_elapsed_ms: 2 * 60 * 60_000,
        max_tool_calls: 10
      }
    });
  }
  job.status = "recovery_required";
  job.recovery_reason = reason;
  job.progress = {
    ...job.progress,
    phase: "acceptance_ownership",
    current_action: "Acceptance ownership requires manual recovery",
    wait_reason: reason,
    heartbeat_at: new Date().toISOString(),
    liveness_at: new Date().toISOString(),
    progress_at: new Date().toISOString(),
    writer_active: false,
    browser_active: false,
    execution_state: "blocked"
  };
  await store.writeJob(job);
  await store.writeKeyIndex({
    ...index,
    status: "recovery_required",
    heartbeat_at: new Date().toISOString()
  });
  return await stateFrom(manager, index.run_id, {
    coalesced: true,
    cache_hit: false,
    ownership_status: "recovery_required"
  });
}

async function resolveIndexedAcceptance(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  manager: DurableJobManager,
  index: AcceptanceKeyIndex
): Promise<AsyncAcceptanceState> {
  const store = acceptanceStore(manager);
  const deadline = Date.now() + ACCEPTANCE_INDEX_WAIT_MS;
  let job = await store.readJob(index.run_id);
  while (!job && Date.now() < deadline && isProcessAlive(index.owner_pid) && indexHeartbeatAgeMs(index) <= acceptanceIndexStaleMs()) {
    await new Promise((resolve) => setTimeout(resolve, ACCEPTANCE_INDEX_POLL_MS));
    job = await store.readJob(index.run_id);
  }
  if (!job) {
    if (isProcessAlive(index.owner_pid) && indexHeartbeatAgeMs(index) <= acceptanceIndexStaleMs()) {
      return stateFromClaimingIndex(index, workspace);
    }
    return await markIndexedRecoveryRequired(
      manager,
      index,
      `Acceptance key ${index.acceptance_key} has no durable job and its original owner cannot be confirmed active.`
    );
  }
  if (job.status === "queued") scheduleExecution(config, guard, workspace, index.run_id);
  if (
    (job.status === "running" || job.status === "recovering" || job.status === "stale")
    && !isProcessAlive(index.owner_pid)
    && indexHeartbeatAgeMs(index) > acceptanceIndexStaleMs()
  ) {
    const prepared = await manager.prepareRecovery(index.run_id);
    await store.writeKeyIndex({
      ...index,
      status: prepared.status,
      heartbeat_at: new Date().toISOString()
    });
  }
  const current = await store.readJob(index.run_id);
  const validCache = current?.status === "completed"
    ? await readValidPreparedCache(store, preparationFromInput(index.input), index.acceptance_key)
    : undefined;
  const cacheHit = Boolean(validCache);
  if (validCache) {
    await codexProEventBus.emit("acceptance_cache_hit", {
      source_run_id: index.run_id,
      requested_profile: validCache.requested_profile,
      profile: validCache.profile,
      report_path: validCache.report_path,
      receipt_path: validCache.acceptance_receipt?.path ?? null,
      cache_key: validCache.cache_key,
      cache_hit: true,
      reused: true,
      validation_status: "passed"
    }, {
      source: "async_acceptance",
      correlation_id: index.run_id,
      task_id: index.run_id
    });
  }
  return await stateFrom(manager, index.run_id, {
    coalesced: true,
    cache_hit: cacheHit,
    ownership_status: current?.status === "recovery_required" || current?.status === "stale" ? "recovery_required" : "coalesced"
  });
}

async function readValidPreparedCache(
  store: AcceptanceJobStore,
  preparation: AcceptanceRunPreparation,
  acceptanceKey?: string
): Promise<AcceptanceRunResult | undefined> {
  const cached = await store.readJson<AcceptanceRunResult>(preparation.cache_rel_path).catch(() => undefined);
  if (!cached?.ok || cached.status !== "passed" || !cached.artifact_digest) return undefined;
  if (cached.cache_key !== preparation.cache_key) return undefined;
  if ((cached.input_hash ?? cached.cache_key) !== preparation.cache_key) return undefined;
  if (acceptanceKey && (cached.acceptance_key ?? cached.cache_key) !== acceptanceKey) return undefined;
  if (cached.workspace_id !== undefined && cached.workspace_id !== store.workspace.id) return undefined;
  if (store.workspace.workspaceGeneration !== undefined && cached.workspace_generation !== store.workspace.workspaceGeneration) return undefined;
  const receipt = cached.acceptance_receipt?.receipt;
  if (!receipt || receipt.run_id !== cached.run_id || receipt.cache_key !== cached.cache_key || receipt.artifact_digest !== cached.artifact_digest) return undefined;
  if (acceptanceKey && (receipt.acceptance_key ?? receipt.cache_key) !== acceptanceKey) return undefined;
  try {
    const validation = await validateAcceptanceReceipt(store.acceptanceConfig, store.guard, store.workspace, receipt, {
      changedFiles: cached.changed_files,
      ...(cached.acceptance_receipt?.path ? { receiptPath: cached.acceptance_receipt.path } : {})
    });
    return validation.valid ? cached : undefined;
  } catch {
    return undefined;
  }
}

async function completeFromPreparedCache(
  manager: DurableJobManager,
  input: PersistedAcceptanceInput,
  cached: AcceptanceRunResult
): Promise<AsyncAcceptanceState> {
  const store = acceptanceStore(manager);
  const job = await manager.create({
    run_id: (await store.readKeyIndex(input.acceptance_key))!.run_id,
    kind: "task",
    title: `Acceptance cache: ${input.preparation.effective_profile}`,
    workspace_id: store.workspace.id,
    workspace_root: store.workspace.root,
    input: input as unknown as Record<string, unknown>,
    ...(input.options.active_skill ? { active_skill: input.options.active_skill } : {}),
    steps: stepDefinitions(preparationFromInput(input))
  });
  const result: AcceptanceRunResult = {
    ...cached,
    run_id: job.run_id,
    cache_hit: true,
    cache_key: input.preparation.cache_key
  };
  const resultPath = store.resultPath(job.run_id);
  await store.writeJson(resultPath, result);
  const step = await store.readStep(job.run_id, "01-acceptance");
  if (step) {
    step.status = "completed";
    step.attempts = 0;
    step.output_summary = "Reused a valid completed acceptance cache entry.";
    step.output_path = resultPath;
    step.evidence_paths = [result.report_path, resultPath];
    step.finished_at = new Date().toISOString();
    await store.writeStep(job.run_id, step);
  }
  job.status = "completed";
  job.current_step_id = null;
  job.report_path = result.report_path;
  job.result_summary = `Acceptance cache reused; validation_ok=${result.ok}; report=${result.report_path}`;
  job.finished_at = new Date().toISOString();
  job.duration_ms = 0;
  job.progress = {
    ...job.progress,
    phase: "completed",
    current_action: "Completed from valid acceptance cache",
    heartbeat_at: new Date().toISOString(),
    liveness_at: new Date().toISOString(),
    progress_at: new Date().toISOString(),
    writer_active: false,
    browser_active: false,
    execution_state: "terminal"
  };
  await store.writeJob(job);
  await manager.publishTerminalReport(job);
  await publishAcceptanceOutcome(store.guard, store.workspace, job.run_id, result, resultPath, "cache-reused");
  await updateKeyIndex(store, input, {
    run_id: job.run_id,
    status: "completed",
    report_path: result.report_path,
    result_path: resultPath
  });
  return await stateFrom(manager, job.run_id, {
    coalesced: true,
    cache_hit: true,
    ownership_status: "coalesced"
  });
}

export async function startAcceptanceTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: AcceptanceRunOptions,
  prepared?: AcceptanceRunPreparation
): Promise<AsyncAcceptanceState> {
  const activeSkill = options.activeSkill ? await assertActiveSkillCurrent(config, options.activeSkill) : undefined;
  const normalizedOptions: AcceptanceRunOptions = { ...options, ...(activeSkill ? { activeSkill } : {}) };
  const preparation = prepared ?? await prepareAcceptanceRun(config, guard, workspace, normalizedOptions);
  const acceptanceKey = acceptanceKeyFor(workspace, preparation, activeSkill);
  const manager = managerFor(config, guard, workspace);
  const store = acceptanceStore(manager);

  const claim = await store.withKeyClaimLock(acceptanceKey, async (): Promise<
    | { kind: "existing"; index: AcceptanceKeyIndex }
    | { kind: "created"; run_id: string; status: DurableJobRecord["status"] }
  > => {
    const firstExisting = await store.readKeyIndex(acceptanceKey);
    if (firstExisting) {
      const existingJob = await store.readJob(firstExisting.run_id);
      const reusableCache = existingJob?.status === "completed"
        ? await readValidPreparedCache(store, preparation, firstExisting.acceptance_key)
        : undefined;
      const terminalWithoutReusablePass = Boolean(
        existingJob
        && TERMINAL_JOB_STATUSES.has(existingJob.status)
        && !reusableCache
      );
      if (!terminalWithoutReusablePass) return { kind: "existing", index: firstExisting };
      const retired = await store.retireKeyIndex(firstExisting);
      if (!retired) {
        const winner = await store.readKeyIndex(acceptanceKey);
        if (winner) return { kind: "existing", index: winner };
      }
    }

    const runId = normalizeRunId(options.runId);
    const input: PersistedAcceptanceInput = {
      task_type: "acceptance",
      acceptance_key: acceptanceKey,
      options: {
        profile: preparation.selection.requested_profile,
        stop_on_failure: preparation.stop_on_failure,
        session_id: options.sessionId,
        changed_files: [...preparation.input_changed_files],
        ...(activeSkill ? { active_skill: activeSkill } : {})
      },
      preparation: {
        requested_profile: preparation.selection.requested_profile,
        configured_profile: preparation.selection.configured_profile,
        effective_profile: preparation.selection.effective_profile,
        selection_reason: preparation.selection.reason,
        cache_key: preparation.cache_key,
        cache_rel_path: preparation.cache_rel_path,
        command_count: preparation.command_count,
        max_command_timeout_ms: preparation.max_command_timeout_ms,
        input_fingerprint: preparation.input_fingerprint
      }
    };
    const now = new Date().toISOString();
    const index: AcceptanceKeyIndex = {
      version: 1,
      acceptance_key: acceptanceKey,
      run_id: runId,
      workspace_root: workspace.root,
      profile: preparation.selection.effective_profile,
      cache_key: preparation.cache_key,
      stop_on_failure: preparation.stop_on_failure,
      ...(activeSkill?.digest ? { active_skill_digest: activeSkill.digest } : {}),
      status: "claiming",
      owner_pid: process.pid,
      owner_token: randomUUID(),
      fencing_token: 1,
      created_at: now,
      heartbeat_at: now,
      report_path: null,
      result_path: null,
      input
    };
    const claimed = await store.claimKeyIndex(index);
    if (!claimed) {
      const claimedByOther = await store.readKeyIndex(acceptanceKey);
      if (!claimedByOther) throw new CodexProError(`Acceptance key ${acceptanceKey} was claimed but its persistent index is unavailable.`);
      return { kind: "existing", index: claimedByOther };
    }

    const job = await manager.create({
      run_id: runId,
      kind: "task",
      title: `Acceptance: ${preparation.selection.effective_profile}`,
      workspace_id: workspace.id,
      workspace_root: workspace.root,
      input: input as unknown as Record<string, unknown>,
      ...(activeSkill ? { active_skill: activeSkill } : {}),
      steps: stepDefinitions(preparation),
      loop_budget: {
        max_attempts_per_step: 1,
        max_repair_rounds: 0,
        max_same_failure_repeats: 1,
        max_full_validation_runs: 1,
        max_browser_reconnects: 0,
        max_elapsed_ms: 2 * 60 * 60_000,
        max_tool_calls: 10
      }
    });
    await store.writeKeyIndex({
      ...index,
      status: job.status,
      heartbeat_at: new Date().toISOString()
    });
    return { kind: "created", run_id: runId, status: job.status };
  });

  if (claim.kind === "existing") {
    return await resolveIndexedAcceptance(config, guard, workspace, manager, claim.index);
  }
  if (!TERMINAL_JOB_STATUSES.has(claim.status) && claim.status !== "recovery_required") {
    scheduleExecution(config, guard, workspace, claim.run_id);
  }
  return await stateFrom(manager, claim.run_id, {
    coalesced: false,
    cache_hit: false,
    ownership_status: "claimed"
  });
}

export async function getAcceptanceTaskStatus(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string
): Promise<AsyncAcceptanceState> {
  const runId = normalizeRunId(runIdInput);
  const manager = managerFor(config, guard, workspace);
  try {
    return await stateFrom(manager, runId);
  } catch (error) {
    if (/not found/i.test(error instanceof Error ? error.message : String(error))) {
      throw new CodexProError(`Acceptance run not found: ${runId}`);
    }
    throw error;
  }
}

export async function cancelAcceptanceTask(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string,
  ownerToken: string,
  fencingToken: number
): Promise<AsyncAcceptanceState> {
  const runId = normalizeRunId(runIdInput);
  const manager = managerFor(config, guard, workspace);
  const store = acceptanceStore(manager);
  const input = await readPersistedAcceptanceInput(config, store, runId);
  if (!input) throw new CodexProError(`Acceptance run not found: ${runId}`);
  const index = await store.readKeyIndex(input.acceptance_key);
  if (!index || index.run_id !== runId) throw new CodexProError(`Acceptance ownership index is unavailable for ${runId}.`);
  if (index.owner_token !== ownerToken || index.fencing_token !== fencingToken) {
    throw new CodexProError("Acceptance cancellation ownership token or fencing token does not match the persisted run owner.");
  }

  const governor = new ResourceGovernor(config);
  const inspected = await manager.inspect(runId, { markStale: false });
  if (TERMINAL_JOB_STATUSES.has(inspected.job.status)) return await stateFrom(manager, runId);

  if (inspected.job.status === "queued" || inspected.job.status === "recovery_required" || inspected.job.status === "stale") {
    const now = new Date().toISOString();
    for (const step of inspected.steps) {
      if (step.status === "completed") continue;
      step.status = "cancelled";
      step.pending_operation = null;
      step.owner_token = undefined;
      step.finished_at = now;
      step.termination_reason = "explicit_cancel";
      await store.writeStep(runId, step);
    }
    inspected.job.status = "cancelled";
    inspected.job.cancel_requested = true;
    inspected.job.owner_token = null;
    inspected.job.finished_at = now;
    inspected.job.duration_ms = inspected.job.started_at ? Math.max(0, Date.now() - Date.parse(inspected.job.started_at)) : 0;
    inspected.job.termination_reason = "explicit_cancel";
    inspected.job.progress = {
      ...inspected.job.progress,
      phase: "cancelled",
      current_action: "Cancelled before validation started",
      wait_reason: "Cancellation requested before validation process spawn.",
      heartbeat_at: now,
      liveness_at: now,
      progress_at: now,
      writer_active: false,
      browser_active: false,
      execution_state: "terminal",
      termination_reason: "explicit_cancel"
    };
    await store.writeJob(inspected.job);
    await updateKeyIndex(store, input, { run_id: runId, status: "cancelled", owner_pid: process.pid });
    return await stateFrom(manager, runId);
  }

  await manager.requestCancel(runId);
  await governor.cancelQueuedRun(runId, workspace.root);
  await updateKeyIndex(store, input, { run_id: runId, status: inspected.job.status, owner_pid: process.pid });
  return await stateFrom(manager, runId);
}

export async function readAcceptanceTaskResult(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runIdInput: string,
  maxChars = RESULT_TEXT_MAX_CHARS
): Promise<{ state: AsyncAcceptanceState; result?: AcceptanceRunResult; text?: string }> {
  const state = await getAcceptanceTaskStatus(config, guard, workspace, runIdInput);
  if (!state.result_available) return { state };
  const manager = managerFor(config, guard, workspace);
  const store = acceptanceStore(manager);
  const result = await store.readJson<AcceptanceRunResult>(store.resultPath(state.run_id));
  if (!result) return { state };
  const boundedText = clip(redactSensitiveText(result.text), Math.max(1_000, Math.min(maxChars, RESULT_TEXT_MAX_CHARS)));
  return {
    state,
    result: { ...result, text: boundedText ?? "" },
    text: boundedText
  };
}

export async function recoverAcceptanceTasks(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace
): Promise<{ scanned: number; resumed: string[]; recovery_required: string[]; stale: string[] }> {
  const manager = managerFor(config, guard, workspace);
  const store = acceptanceStore(manager);
  const report = await scanDurableJobs(manager);
  const resumed: string[] = [];
  const recoveryRequired = new Set(report.recovery_required);
  const inputsByRunId = new Map<string, PersistedAcceptanceInput>();
  const ownershipConflicts = new Set<string>();
  for (const current of report.jobs) {
    const input = await readPersistedAcceptanceInput(config, store, current.run_id);
    if (!input) continue;
    inputsByRunId.set(current.run_id, input);
    const keyIndex = await ensureKeyIndexForExistingJob(store, input, current);
    if (keyIndex.run_id === current.run_id) continue;
    ownershipConflicts.add(current.run_id);
    if (TERMINAL_JOB_STATUSES.has(current.status)) continue;
    const reason = `Acceptance key ${input.acceptance_key} is already owned by ${keyIndex.run_id}; automatic replay is forbidden.`;
    current.status = "recovery_required";
    current.recovery_reason = reason;
    current.progress = {
      ...current.progress,
      phase: "acceptance_ownership",
      current_action: "Acceptance recovery requires ownership review",
      wait_reason: reason,
      heartbeat_at: new Date().toISOString(),
      liveness_at: new Date().toISOString(),
      progress_at: new Date().toISOString(),
      writer_active: false,
      browser_active: false,
      execution_state: "blocked"
    };
    await store.writeJob(current);
    recoveryRequired.add(current.run_id);
  }
  for (const runId of report.recoverable) {
    if (ownershipConflicts.has(runId)) continue;
    const input = inputsByRunId.get(runId);
    if (!input) continue;
    const current = await store.readJob(runId);
    if (!current) continue;
    if (input.options.active_skill) {
      try {
        await assertActiveSkillCurrent(config, input.options.active_skill);
      } catch (error) {
        current.status = "recovery_required";
        current.recovery_reason = error instanceof Error ? error.message : String(error);
        current.progress = {
          ...current.progress,
          phase: "skill_verification",
          current_action: "Acceptance recovery requires the approved Skill version",
          wait_reason: current.recovery_reason,
          heartbeat_at: new Date().toISOString(),
          liveness_at: new Date().toISOString(),
          progress_at: new Date().toISOString(),
          writer_active: false,
          browser_active: false,
          execution_state: "blocked"
        };
        await store.writeJob(current);
        await updateKeyIndex(store, input, {
          run_id: runId,
          status: "recovery_required",
          owner_pid: process.pid
        });
        recoveryRequired.add(runId);
        continue;
      }
    }
    if (current.status === "queued") {
      scheduleExecution(config, guard, workspace, runId);
      resumed.push(runId);
      continue;
    }
    const prepared = await manager.prepareRecovery(runId);
    await updateKeyIndex(store, input, {
      run_id: runId,
      status: prepared.status,
      owner_pid: prepared.owner_pid ?? process.pid,
      report_path: prepared.report_path ?? null
    });
    if (prepared.status === "recovery_required") {
      recoveryRequired.add(runId);
      continue;
    }
    if (!TERMINAL_JOB_STATUSES.has(prepared.status)) {
      scheduleExecution(config, guard, workspace, runId);
      resumed.push(runId);
    }
  }
  return {
    scanned: report.scanned,
    resumed,
    recovery_required: [...recoveryRequired].sort(),
    stale: report.stale
  };
}

export async function waitForAcceptanceTaskForTesting(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  runId: string
): Promise<AsyncAcceptanceState> {
  await activeAcceptanceTasks.get(executionKey(workspace, runId));
  return await getAcceptanceTaskStatus(config, guard, workspace, runId);
}

export function acceptanceResultPath(config: CodexProConfig, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new CodexProError("Invalid acceptance run id.");
  return path.posix.join(config.contextDir, "acceptance-runs", runId, "result.json");
}
