import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus, type CodexProEventName } from "../events/eventBus.js";
import { writeTextFile } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { GOAL_LATENCY_STAGE_FIELD } from "../observability/goalLatency.js";
import { findSecretValues, redactSensitiveText } from "../redact.js";
import { deriveTaskOutcome } from "../runtime/taskOutcome.js";
import {
  ensureOfficeProjectionIndex,
  readOfficeProjectionIndex,
  replaceOfficeProjectionIndex,
  upsertOfficeProjectionIndex,
  type OfficeProjectionIndexLoadResult
} from "../tasks/officeProjectionIndex.js";
import {
  assertNoForbiddenStructuredRuntimePayload,
  createStructuredRuntimeEventEnvelope,
  type CreateStructuredRuntimeEventInput,
  type StructuredRuntimeEventEnvelopeV1,
  type StructuredRuntimeEventName,
  type StructuredRuntimeRetrySemanticsV1
} from "../runtime/structuredRuntimeEvents.js";
import {
  applyLoopDecision,
  classifyLoopFailure,
  createLoopState,
  evaluateLoopPolicy,
  normalizeLoopBudget
} from "../workflow/loopPolicy.js";
import { compileAcceptanceContract } from "./acceptanceContract.js";
import {
  amendGoalContract,
  compatibilityGoalContract,
  compileGoalContract,
  goalContractFingerprint,
  type GoalContractAmendmentInput,
  type GoalContractInput
} from "./goalContract.js";
import {
  GoalStoreError,
  isGoalTerminal,
  type AcceptanceContract,
  type GoalCheckpoint,
  type GoalCreateResult,
  type GoalEvent,
  type GoalHookDeliveryState,
  type GoalHookEventType,
  type GoalLatencyStage,
  type GoalRecord,
  type GoalStatus,
  type GoalValidationResult,
  type GoalReviewResult
} from "./types.js";

const GOAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GOAL_STORE_LOCK_TIMEOUT_MS = 30_000;
const GOAL_STORE_LOCK_STALE_MS = 120_000;
const GOAL_STORE_LOCK_POLL_MS = 20;
const GOAL_READ_BATCH_SIZE = 32;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALLOWED_TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  queued: new Set(["running", "waiting_input", "failed", "blocked", "cancelled"]),
  running: new Set(["waiting_input", "waiting_approval", "validating", "failed", "blocked", "cancelled"]),
  waiting_input: new Set(["running", "validating", "failed", "blocked", "cancelled"]),
  waiting_approval: new Set(["running", "failed", "blocked", "cancelled"]),
  validating: new Set(["reviewing", "waiting_input", "succeeded", "failed", "blocked", "cancelled"]),
  reviewing: new Set(["waiting_input", "succeeded", "failed", "blocked", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  blocked: new Set(),
  cancelled: new Set()
};

export interface GoalOfficeIndexEntry {
  goal_id: string;
  project_root: string;
  title: string;
  status: GoalStatus;
  task_objective: unknown;
  structured_task: unknown;
  recovery_required: boolean;
  replay_allowed: boolean;
  failure_retryable: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  goal_id?: string;
  project_root: string;
  base_branch: string;
  objective: string;
  constraints: string[];
  acceptance: string[];
  acceptance_contract: AcceptanceContract;
  baseline_git_sha: string;
  original_instruction_ref: string;
  goal_contract?: GoalContractInput;
  idempotency_key: string;
  request_fingerprint: string;
  checkpoint: GoalCheckpoint;
}

export interface GoalRecordMutation {
  event_type: string;
  event_data?: Record<string, unknown>;
  mutate(goal: GoalRecord): void;
}

export interface GoalStructuredRuntimeEventInput {
  event_name: StructuredRuntimeEventName;
  task_id: string;
  run_id?: string | null;
  parent_run_id?: string | null;
  component_id: string;
  execution_profile_version?: number | null;
  evidence_ref?: string | null;
  terminal: boolean;
  retry_semantics?: Partial<StructuredRuntimeRetrySemanticsV1>;
  idempotency_key?: string;
  details?: Record<string, unknown>;
}

export interface GoalStructuredRuntimeEventResult {
  goal: GoalRecord;
  event: GoalEvent;
  envelope: StructuredRuntimeEventEnvelopeV1;
  appended: boolean;
}

function cloneGoal(goal: GoalRecord): GoalRecord {
  return structuredClone(goal);
}

function reconcileGoalTaskOutcome(goal: GoalRecord): void {
  const current = goal.checkpoint?.task_outcome;
  const derived = deriveTaskOutcome({
    domain_status: goal.status,
    validation_status: goal.checkpoint?.acceptance_status ?? goal.validation_result?.status,
    validation_ok: goal.validation_result?.ok,
    failure_domain: goal.failure?.failure_domain,
    failure_code: goal.failure?.code,
    failure_retryable: goal.failure?.retryable,
    receipt_status: goal.checkpoint?.receipt_status,
    hook_delivery_status: goal.checkpoint?.hook_delivery_status,
    has_evidence: goal.evidence.length > 0 || Boolean(goal.validation_result?.report_path),
    delivery_status: current?.delivery_status,
    blocked_capability: current?.blocked_capability,
    updated_at: goal.updated_at
  });
  goal.checkpoint = {
    ...(goal.checkpoint ?? {}),
    task_outcome: derived
  };
}

export function goalOfficeIndexEntry(goal: GoalRecord): GoalOfficeIndexEntry {
  return {
    goal_id: goal.goal_id,
    project_root: goal.project_root,
    title: goal.objective,
    status: goal.status,
    task_objective: goal.checkpoint?.task_objective ?? null,
    structured_task: goal.checkpoint?.structured_task ?? null,
    recovery_required: goal.checkpoint?.recovery_required === true,
    replay_allowed: goal.checkpoint?.replay_allowed === true,
    failure_retryable: goal.failure?.retryable === true,
    created_at: goal.created_at,
    updated_at: goal.updated_at
  };
}

function isGoalOfficeIndexEntry(key: string, value: unknown): value is GoalOfficeIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<GoalOfficeIndexEntry>;
  return candidate.goal_id === key
    && GOAL_ID_PATTERN.test(key)
    && typeof candidate.project_root === "string"
    && typeof candidate.title === "string"
    && ["queued", "running", "waiting_input", "waiting_approval", "validating", "reviewing", "succeeded", "failed", "blocked", "cancelled"].includes(candidate.status ?? "")
    && typeof candidate.recovery_required === "boolean"
    && typeof candidate.replay_allowed === "boolean"
    && typeof candidate.failure_retryable === "boolean"
    && typeof candidate.created_at === "string"
    && Number.isFinite(Date.parse(candidate.created_at))
    && typeof candidate.updated_at === "string"
    && Number.isFinite(Date.parse(candidate.updated_at));
}

function emptyHookDeliveryState(now = new Date().toISOString()): GoalHookDeliveryState {
  return {
    claimed_event_keys: [],
    delivered_event_keys: [],
    attempts: 0,
    last_event_type: null,
    last_event_key: null,
    last_error: null,
    final_notification_claimed_at: null,
    final_notification_sent_at: null,
    updated_at: now
  };
}

function safeGoalId(goalId: string): string {
  const value = goalId.trim();
  if (!GOAL_ID_PATTERN.test(value)) {
    throw new GoalStoreError("invalid_goal_id", `Invalid goal id: ${goalId}`);
  }
  return value;
}

function hashValue(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const SENSITIVE_KEY_PATTERN = /\b(?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|secret|token|webhook|bark[_-]?url)\b/i;

function sanitized<T>(value: T, depth = 0): T {
  if (depth > 10) return "[CodexPro structured value truncated: depth limit]" as T;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitized(item, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED_SECRET]" : sanitized(item, depth + 1);
  }
  return out as T;
}

async function emitGoalLifecycle(
  previousStatus: GoalStatus | undefined,
  goal: GoalRecord,
  sourceEventType: string
): Promise<void> {
  const events: CodexProEventName[] = [];
  if (sourceEventType === "goal.created") events.push("run_created", "task_created");
  if (previousStatus !== undefined && previousStatus !== goal.status) {
    if (goal.status === "running") {
      if (previousStatus === "queued") events.push("task_assigned");
      events.push("task_started", "execution_started");
    }
    if (goal.status === "waiting_input" || goal.status === "waiting_approval") events.push("task_interrupted");
    if (goal.status === "validating") events.push("validation_started");
    if (previousStatus === "validating" && goal.status !== "validating") events.push("validation_completed");
    if (isGoalTerminal(goal.status)) events.push("task_completed", "execution_exited");
  }
  for (const name of events) {
    try {
      await codexProEventBus.emit(
        name,
        {
          domain: "goal",
          goal_id: goal.goal_id,
          run_id: goal.run_id,
          status: goal.status,
          previous_status: previousStatus ?? null,
          source_event_type: sourceEventType
        },
        { source: "goal_store", correlation_id: goal.run_id, task_id: `goal-${goal.goal_id}` }
      );
    } catch {
      // The event bus is an observational/delegation layer; Goal persistence remains authoritative.
    }
  }
}

async function emitGoalLatencyEvents(
  previous: GoalRecord | undefined,
  goal: GoalRecord,
  sourceEventType: string
): Promise<void> {
  const current = goal.checkpoint?.latency;
  if (!current) return;
  const previousLatency = previous?.checkpoint?.latency;
  const stages = Object.keys(GOAL_LATENCY_STAGE_FIELD) as GoalLatencyStage[];
  for (const stage of stages) {
    const field = GOAL_LATENCY_STAGE_FIELD[stage];
    const previousActive = previousLatency?.active_stage_started_at[stage];
    const currentActive = current.active_stage_started_at[stage];
    const previousDuration = previousLatency?.breakdown[field] ?? 0;
    const currentDuration = current.breakdown[field] ?? 0;
    const started = !previousActive && Boolean(currentActive);
    const terminalReportCompleted = stage === "report"
      && isGoalTerminal(goal.status)
      && !currentActive;
    const completed = !currentActive && (currentDuration > previousDuration || terminalReportCompleted);
    if (!started && !completed) continue;
    try {
      await codexProEventBus.emit(
        started ? "goal_stage_started" : "goal_stage_completed",
        {
          domain: "goal_latency",
          goal_id: goal.goal_id,
          run_id: goal.run_id,
          stage,
          metric: field,
          duration_ms: started ? null : Math.max(0, currentDuration - previousDuration),
          cumulative_duration_ms: currentDuration,
          total_ms: current.breakdown.total_ms,
          source_event_type: sourceEventType
        },
        { source: "goal_store", correlation_id: goal.run_id, task_id: `goal-${goal.goal_id}` }
      );
    } catch {
      // Latency events are observational and must never affect Goal persistence.
    }
  }
}

export class GoalStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace
  ) {}

  goalsRoot(): string {
    return `${this.config.contextDir}/goals`;
  }

  goalDir(goalId: string): string {
    return `${this.goalsRoot()}/${safeGoalId(goalId)}`;
  }

  hashIdempotencyKey(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new GoalStoreError("invalid_input", "idempotency_key cannot be empty.");
    if (trimmed.length > 1_000) throw new GoalStoreError("invalid_input", "idempotency_key is too long.");
    return hashValue(trimmed);
  }

  async createGoal(input: CreateGoalInput): Promise<GoalCreateResult> {
    const result = await this.exclusive(async () => {
      const idempotencyHash = this.hashIdempotencyKey(input.idempotency_key);
      const requestedGoalId = input.goal_id ? safeGoalId(input.goal_id) : undefined;
      const existing = await this.findByIdempotencyHash(idempotencyHash);
      if (existing) {
        const previousFingerprint = existing.checkpoint?.request_fingerprint;
        if (previousFingerprint !== input.request_fingerprint) {
          throw new GoalStoreError(
            "idempotency_conflict",
            `The idempotency key is already bound to goal ${existing.goal_id} with a different request.`
          );
        }
        if (requestedGoalId && requestedGoalId !== existing.goal_id) {
          throw new GoalStoreError(
            "idempotency_conflict",
            `The idempotency key is already bound to goal ${existing.goal_id}, not requested goal ${requestedGoalId}.`
          );
        }
        return { goal: existing, created: false };
      }
      if (requestedGoalId) {
        const existingById = await this.readJson<GoalRecord>(`${this.goalDir(requestedGoalId)}/goal.json`);
        if (existingById) {
          throw new GoalStoreError(
            "idempotency_conflict",
            `Requested goal id ${requestedGoalId} is already bound to a different idempotency key.`
          );
        }
      }

      const now = new Date().toISOString();
      const goalId = requestedGoalId ?? randomUUID();
      const requiredAcceptance = input.acceptance_contract.items.filter((item) => item.blocking).map((item) => item.id);
      const optionalAcceptance = input.acceptance_contract.items.filter((item) => !item.blocking).map((item) => item.id);
      const goalContract = compileGoalContract({
        goal_id: goalId,
        objective: input.objective,
        workspace_root: input.project_root,
        baseline_git_sha: input.baseline_git_sha,
        original_instruction_ref: input.original_instruction_ref,
        required_acceptance: requiredAcceptance,
        optional_acceptance: optionalAcceptance,
        created_at: now,
        contract: input.goal_contract
      });
      const goal: GoalRecord = sanitized({
        goal_id: goalId,
        run_id: randomUUID(),
        status: "queued",
        project_root: input.project_root,
        base_branch: input.base_branch,
        codex_thread_id: null,
        objective: input.objective,
        constraints: input.constraints,
        acceptance: input.acceptance,
        acceptance_contract: input.acceptance_contract,
        goal_contract: goalContract,
        contract_amendments: [],
        active_run_contract_version: goalContract.contract_version,
        loop_state: createLoopState(goalContract.retry_budget, now),
        evidence: [],
        snapshot_id: null,
        last_event_sequence: 0,
        checkpoint: {
          ...input.checkpoint,
          contract_version: goalContract.contract_version,
          plan_sha256: goalContract.plan_sha256
        },
        idempotency_key: idempotencyHash,
        changed_files: [],
        subagent_result: null,
        validation_result: null,
        review_result: null,
        failure: null,
        hook_delivery: emptyHookDeliveryState(now),
        final_notification_sent: false,
        created_at: now,
        updated_at: now
      } satisfies GoalRecord);

      const event: GoalEvent = {
        sequence: 1,
        goal_id: goal.goal_id,
        run_id: goal.run_id,
        contract_version: goal.goal_contract.contract_version,
        type: "goal.created",
        timestamp: now,
        status: goal.status,
        data: { idempotency_key: idempotencyHash }
      };
      goal.last_event_sequence = event.sequence;
      await this.appendEventFile(goal.goal_id, event);
      await this.persistGoal(goal);
      return { goal: cloneGoal(goal), created: true };
    });
    if (result.created) {
      await emitGoalLifecycle(undefined, result.goal, "goal.created");
      await emitGoalLatencyEvents(undefined, result.goal, "goal.created");
    }
    return result;
  }

  async loadGoal(goalId: string, options: { events?: GoalEvent[] } = {}): Promise<GoalRecord> {
    const id = safeGoalId(goalId);
    const goal = await this.readJson<GoalRecord>(`${this.goalDir(id)}/goal.json`);
    if (!goal) throw new GoalStoreError("goal_not_found", `Goal not found: ${id}`);
    const events = options.events ?? await this.readEvents(id);
    const lastSequence = events.at(-1)?.sequence ?? 0;
    if (lastSequence > goal.last_event_sequence) goal.last_event_sequence = lastSequence;
    if (goal.acceptance_contract === undefined || goal.acceptance_contract === null) {
      goal.acceptance_contract = {
        ...compileAcceptanceContract(goal.acceptance ?? []),
        compiled_at: goal.created_at
      };
    }
    if (goal.goal_contract === undefined || goal.goal_contract === null) {
      goal.goal_contract = compatibilityGoalContract({
        goal_id: goal.goal_id,
        objective: goal.objective,
        workspace_root: goal.project_root,
        created_at: goal.created_at,
        acceptance_ids: goal.acceptance_contract.items.filter((item) => item.blocking).map((item) => item.id)
      });
    }
    if (goal.contract_amendments === undefined || !Array.isArray(goal.contract_amendments)) goal.contract_amendments = [];
    if (goal.active_run_contract_version === undefined) {
      goal.active_run_contract_version = goal.checkpoint?.contract_version ?? goal.goal_contract.contract_version;
    }
    if (goal.loop_state === undefined || goal.loop_state === null) {
      goal.loop_state = createLoopState(goal.goal_contract.retry_budget, goal.created_at);
    }
    goal.checkpoint = {
      ...(goal.checkpoint ?? {}),
      contract_version: goal.checkpoint?.contract_version ?? goal.goal_contract.contract_version,
      plan_sha256: goal.checkpoint?.plan_sha256 ?? goal.goal_contract.plan_sha256
    };
    if (goal.evidence === undefined || !Array.isArray(goal.evidence)) goal.evidence = [];
    goal.evidence = goal.evidence.map((item) => ({
      ...item,
      contract_version: item.contract_version ?? goal.goal_contract.contract_version
    }));
    if (goal.subagent_result === undefined) goal.subagent_result = null;
    if (goal.hook_delivery === undefined || goal.hook_delivery === null) goal.hook_delivery = emptyHookDeliveryState(goal.updated_at);
    if (goal.final_notification_sent === undefined) goal.final_notification_sent = false;
    reconcileGoalTaskOutcome(goal);
    return sanitized(goal);
  }

  async listGoals(): Promise<GoalRecord[]> {
    const root = this.guard.resolve(this.workspace, this.goalsRoot());
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await fsp.readdir(root.absPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && GOAL_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const goals: GoalRecord[] = [];
    for (let index = 0; index < names.length; index += GOAL_READ_BATCH_SIZE) {
      const batch = await Promise.all(names.slice(index, index + GOAL_READ_BATCH_SIZE).map(async (name) => {
        try {
          return await this.loadGoal(name);
        } catch {
          // A corrupt or half-created goal directory is not allowed to hide healthy goals.
          return undefined;
        }
      }));
      for (const goal of batch) {
        if (goal) goals.push(goal);
      }
    }
    return goals.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async listOfficeIndex(): Promise<GoalOfficeIndexEntry[] | null> {
    const indexed = await readOfficeProjectionIndex<GoalOfficeIndexEntry>(
      this.guard,
      this.workspace,
      "goals",
      isGoalOfficeIndexEntry
    );
    if (!indexed) return null;
    return [...indexed.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }

  async ensureOfficeIndex(): Promise<OfficeProjectionIndexLoadResult<GoalOfficeIndexEntry>> {
    return await ensureOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "goals",
      async () => (await this.listGoals()).map((goal) => [goal.goal_id, goalOfficeIndexEntry(goal)] as const),
      isGoalOfficeIndexEntry
    );
  }

  async readGoals(goalIds: string[]): Promise<GoalRecord[]> {
    return (await this.readGoalsWithEvents(goalIds)).map((item) => item.goal);
  }

  async readGoalsWithEvents(goalIds: string[]): Promise<Array<{ goal: GoalRecord; events: GoalEvent[] }>> {
    const names = [...new Set(goalIds.map(safeGoalId))];
    const goals: Array<{ goal: GoalRecord; events: GoalEvent[] }> = [];
    for (let index = 0; index < names.length; index += GOAL_READ_BATCH_SIZE) {
      const batch = await Promise.all(names.slice(index, index + GOAL_READ_BATCH_SIZE).map(async (name) => {
        try {
          const events = await this.readEvents(name);
          return { goal: await this.loadGoal(name, { events }), events };
        } catch {
          return undefined;
        }
      }));
      for (const goal of batch) {
        if (goal) goals.push(goal);
      }
    }
    return goals;
  }

  async replaceOfficeIndex(goals: GoalRecord[]): Promise<void> {
    await replaceOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "goals",
      goals.map((goal) => [goal.goal_id, goalOfficeIndexEntry(goal)] as const)
    );
  }

  async readEvents(goalId: string, afterSequence = 0): Promise<GoalEvent[]> {
    const id = safeGoalId(goalId);
    const resolved = this.guard.resolve(this.workspace, `${this.goalDir(id)}/events.jsonl`);
    let text = "";
    try {
      text = await fsp.readFile(resolved.absPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: GoalEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as GoalEvent;
        if (Number.isInteger(event.sequence) && event.sequence > afterSequence) events.push(sanitized(event));
      } catch {
        // A process can stop between bytes of the final append. Ignore invalid JSONL lines.
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  async record(goalId: string, mutation: GoalRecordMutation): Promise<GoalRecord> {
    const outcome = await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const next = cloneGoal(current);
      const contractFingerprint = goalContractFingerprint(current.goal_contract);
      mutation.mutate(next);
      if (goalContractFingerprint(next.goal_contract) !== contractFingerprint) {
        throw new GoalStoreError(
          "invalid_input",
          `Goal ${current.goal_id} contract cannot be changed through a normal mutation; use an explicit amendment.`
        );
      }
      if (isGoalTerminal(current.status)) {
        if (next.status !== current.status) {
          throw new GoalStoreError(
            "terminal_conflict",
            `Goal ${current.goal_id} already has terminal status ${current.status}; cannot transition to ${next.status}.`
          );
        }
        return { goal: cloneGoal(current), previousGoal: cloneGoal(current), previousStatus: current.status, persisted: false };
      }
      this.assertStatusChange(current.status, next.status);
      const events = await this.readEvents(current.goal_id);
      const sequence = Math.max(current.last_event_sequence, events.at(-1)?.sequence ?? 0) + 1;
      const now = new Date().toISOString();
      next.last_event_sequence = sequence;
      next.updated_at = now;
      const event: GoalEvent = sanitized({
        sequence,
        goal_id: current.goal_id,
        run_id: current.run_id,
        contract_version: current.goal_contract.contract_version,
        type: mutation.event_type,
        timestamp: now,
        status: next.status,
        ...(mutation.event_data ? { data: mutation.event_data } : {})
      });
      await this.appendEventFile(current.goal_id, event);
      await this.persistGoal(next);
      return { goal: cloneGoal(next), previousGoal: cloneGoal(current), previousStatus: current.status, persisted: true };
    });
    if (outcome.persisted) {
      await emitGoalLifecycle(outcome.previousStatus, outcome.goal, mutation.event_type);
      await emitGoalLatencyEvents(outcome.previousGoal, outcome.goal, mutation.event_type);
    }
    return outcome.goal;
  }

  async transition(
    goalId: string,
    status: GoalStatus,
    eventType: string,
    options: {
      data?: Record<string, unknown>;
      patch?: (goal: GoalRecord) => void;
    } = {}
  ): Promise<GoalRecord> {
    const current = await this.loadGoal(goalId);
    if (isGoalTerminal(current.status)) {
      if (current.status === status) return current;
      throw new GoalStoreError(
        "terminal_conflict",
        `Goal ${current.goal_id} already has terminal status ${current.status}; cannot transition to ${status}.`
      );
    }
    return await this.record(goalId, {
      event_type: eventType,
      event_data: options.data,
      mutate: (goal) => {
        goal.status = status;
        options.patch?.(goal);
      }
    });
  }

  async patch(
    goalId: string,
    eventType: string,
    patch: (goal: GoalRecord) => void,
    data?: Record<string, unknown>
  ): Promise<GoalRecord> {
    return await this.record(goalId, { event_type: eventType, event_data: data, mutate: patch });
  }

  async patchMetadata(
    goalId: string,
    eventType: string,
    patch: (goal: GoalRecord) => void,
    data: Record<string, unknown> = {}
  ): Promise<GoalRecord> {
    return await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const next = cloneGoal(current);
      const contractFingerprint = goalContractFingerprint(current.goal_contract);
      patch(next);
      if (goalContractFingerprint(next.goal_contract) !== contractFingerprint) {
        throw new GoalStoreError(
          "invalid_input",
          `Goal ${current.goal_id} contract cannot be changed through a metadata patch; use an explicit amendment.`
        );
      }
      if (next.goal_id !== current.goal_id || next.run_id !== current.run_id || next.status !== current.status) {
        throw new GoalStoreError(
          "terminal_conflict",
          `Metadata patch cannot change Goal identity or status for ${current.goal_id}.`
        );
      }
      return await this.persistMetadataEvent(next, eventType, data);
    });
  }

  async recordStructuredRuntimeEvent(
    goalId: string,
    input: GoalStructuredRuntimeEventInput
  ): Promise<GoalStructuredRuntimeEventResult> {
    assertNoForbiddenStructuredRuntimePayload(input.details ?? {});
    return await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const events = await this.readEvents(current.goal_id);
      const idempotencyKey = input.idempotency_key?.trim()
        || [
          input.event_name,
          current.goal_id,
          input.task_id,
          input.run_id ?? current.run_id,
          input.component_id,
          input.evidence_ref ?? "no-evidence"
        ].join(":");
      const existing = events.find((event) => {
        const structured = event.data?.structured_runtime_event;
        return event.type === input.event_name
          && structured
          && typeof structured === "object"
          && !Array.isArray(structured)
          && (structured as Record<string, unknown>).idempotency_key === idempotencyKey;
      });
      if (existing) {
        const envelope = createStructuredRuntimeEventEnvelope({
          ...((existing.data?.structured_runtime_event ?? {}) as Omit<CreateStructuredRuntimeEventInput, "sequence" | "timestamp">),
          event_name: input.event_name,
          authority: "goal_events",
          source_kind: "goal_event",
          goal_id: current.goal_id,
          task_id: input.task_id,
          run_id: input.run_id ?? current.run_id,
          parent_run_id: input.parent_run_id ?? null,
          component_id: input.component_id,
          sequence: existing.sequence,
          timestamp: existing.timestamp,
          execution_profile_version: input.execution_profile_version ?? null,
          evidence_ref: input.evidence_ref ?? null,
          terminal: input.terminal,
          retry_semantics: input.retry_semantics,
          idempotency_key: idempotencyKey
        });
        return { goal: cloneGoal(current), event: existing, envelope, appended: false };
      }

      const sequence = Math.max(current.last_event_sequence, events.at(-1)?.sequence ?? 0) + 1;
      const timestamp = new Date().toISOString();
      const envelope = createStructuredRuntimeEventEnvelope({
        event_name: input.event_name,
        authority: "goal_events",
        source_kind: "goal_event",
        goal_id: current.goal_id,
        task_id: input.task_id,
        run_id: input.run_id ?? current.run_id,
        parent_run_id: input.parent_run_id ?? null,
        component_id: input.component_id,
        sequence,
        timestamp,
        execution_profile_version: input.execution_profile_version ?? null,
        evidence_ref: input.evidence_ref ?? null,
        terminal: input.terminal,
        retry_semantics: input.retry_semantics,
        idempotency_key: idempotencyKey
      });
      const next = cloneGoal(current);
      next.last_event_sequence = sequence;
      next.updated_at = timestamp;
      const event: GoalEvent = sanitized({
        sequence,
        goal_id: current.goal_id,
        run_id: current.run_id,
        contract_version: current.goal_contract.contract_version,
        type: input.event_name,
        timestamp,
        status: current.status,
        data: {
          structured_runtime_event: envelope,
          ...(input.details ? { details: input.details } : {})
        }
      });
      await this.appendEventFile(current.goal_id, event);
      await this.persistGoal(next);
      return { goal: cloneGoal(next), event, envelope, appended: true };
    });
  }

  async amendContract(
    goalId: string,
    input: GoalContractAmendmentInput,
    expectedContractVersion?: number
  ): Promise<GoalRecord> {
    const outcome = await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      if (isGoalTerminal(current.status)) {
        throw new GoalStoreError("terminal_conflict", `Goal ${current.goal_id} is terminal and its contract cannot be amended.`);
      }
      if (
        expectedContractVersion !== undefined
        && expectedContractVersion !== current.goal_contract.contract_version
      ) {
        throw new GoalStoreError(
          "contract_changed",
          `Goal ${current.goal_id} contract is v${current.goal_contract.contract_version}, not expected v${expectedContractVersion}.`
        );
      }
      const now = new Date().toISOString();
      const { contract, amendment } = amendGoalContract(current.goal_contract, input, now);
      const next = cloneGoal(current);
      const previousStatus = current.status;
      next.goal_contract = contract;
      next.contract_amendments = [...current.contract_amendments, amendment];
      next.active_run_contract_version = null;
      next.objective = contract.objective;
      const loopBudget = normalizeLoopBudget(contract.retry_budget);
      const contractClassification = classifyLoopFailure({
        code: "contract_changed",
        message: input.reason,
        contract_changed: true
      });
      const loopDecision = evaluateLoopPolicy({
        state: current.loop_state,
        budget: loopBudget,
        classification: contractClassification,
        phase: "contract_changed",
        now
      });
      next.loop_state = applyLoopDecision(current.loop_state, loopBudget, loopDecision);
      next.checkpoint = {
        ...(next.checkpoint ?? {}),
        contract_version: contract.contract_version,
        plan_sha256: contract.plan_sha256,
        pending_operation: null,
        recovery_required: true,
        recovery_reason: "Goal Contract changed; the previous execution is invalid and must not continue writing.",
        replay_allowed: false,
        codex_turn_terminal: true
      };
      if (["queued", "running", "validating", "reviewing"].includes(next.status)) next.status = "waiting_input";
      this.assertStatusChange(previousStatus, next.status);
      const events = await this.readEvents(current.goal_id);
      const sequence = Math.max(current.last_event_sequence, events.at(-1)?.sequence ?? 0) + 1;
      next.last_event_sequence = sequence;
      next.updated_at = now;
      const event: GoalEvent = sanitized({
        sequence,
        goal_id: current.goal_id,
        run_id: current.run_id,
        contract_version: contract.contract_version,
        type: "goal.contract_amended",
        timestamp: now,
        status: next.status,
        data: {
          amendment_id: amendment.amendment_id,
          source: amendment.source,
          reason: amendment.reason,
          from_version: amendment.from_version,
          to_version: amendment.to_version,
          previous_plan_sha256: amendment.previous_plan_sha256,
          next_plan_sha256: amendment.next_plan_sha256
        }
      });
      await this.appendEventFile(current.goal_id, event);
      await this.persistGoal(next);
      return { goal: cloneGoal(next), previousStatus };
    });
    await emitGoalLifecycle(outcome.previousStatus, outcome.goal, "goal.contract_amended");
    return outcome.goal;
  }

  async claimHookDelivery(
    goalId: string,
    eventKey: string,
    eventType: GoalHookEventType,
    options: { terminal_notification?: boolean; allow_replay?: boolean } = {}
  ): Promise<{ goal: GoalRecord; claimed: boolean }> {
    const safeEventKey = eventKey.trim();
    if (!safeEventKey || safeEventKey.length > 300) {
      throw new GoalStoreError("invalid_input", "Hook delivery event key must be 1-300 characters.");
    }
    return await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const state = current.hook_delivery ?? emptyHookDeliveryState(current.updated_at);
      if (state.delivered_event_keys.includes(safeEventKey)) return { goal: current, claimed: false };
      if (state.claimed_event_keys.includes(safeEventKey) && options.allow_replay !== true) {
        return { goal: current, claimed: false };
      }
      const now = new Date().toISOString();
      const next = cloneGoal(current);
      const nextState = next.hook_delivery ?? emptyHookDeliveryState(now);
      if (!nextState.claimed_event_keys.includes(safeEventKey)) nextState.claimed_event_keys.push(safeEventKey);
      nextState.claimed_event_keys = nextState.claimed_event_keys.slice(-200);
      nextState.attempts += 1;
      nextState.last_event_type = eventType;
      nextState.last_event_key = safeEventKey;
      nextState.last_error = null;
      nextState.updated_at = now;
      if (options.terminal_notification) nextState.final_notification_claimed_at = now;
      next.hook_delivery = nextState;
      next.checkpoint = {
        ...(next.checkpoint ?? {}),
        hook_delivery_started_at: now,
        hook_delivery_status: "pending"
      };
      const saved = await this.persistMetadataEvent(next, "hook.delivery_claimed", {
        hook_event_type: eventType,
        event_key: safeEventKey,
        terminal_notification: options.terminal_notification === true,
        manual_replay: options.allow_replay === true
      }, now);
      return { goal: saved, claimed: true };
    });
  }

  async completeHookDelivery(
    goalId: string,
    eventKey: string,
    eventType: GoalHookEventType,
    options: {
      notification_sent: boolean;
      task_state_updated: boolean;
      context_card_written: boolean;
      ok: boolean;
      errors?: string[];
    }
  ): Promise<GoalRecord> {
    return await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const now = new Date().toISOString();
      const next = cloneGoal(current);
      const state = next.hook_delivery ?? emptyHookDeliveryState(now);
      if (!state.delivered_event_keys.includes(eventKey)) state.delivered_event_keys.push(eventKey);
      state.delivered_event_keys = state.delivered_event_keys.slice(-200);
      state.last_event_type = eventType;
      state.last_event_key = eventKey;
      state.last_error = options.errors?.length ? options.errors.join(" | ").slice(0, 8_000) : null;
      state.updated_at = now;
      if (options.notification_sent && (eventType === "task.succeeded" || eventType === "task.failed")) {
        next.final_notification_sent = true;
        state.final_notification_sent_at = now;
      }
      next.hook_delivery = state;
      next.checkpoint = {
        ...(next.checkpoint ?? {}),
        hook_delivery_settled_at: now,
        hook_delivery_status: "delivered"
      };
      return await this.persistMetadataEvent(next, "hook.delivery_completed", {
        hook_event_type: eventType,
        event_key: eventKey,
        ok: options.ok,
        notification_sent: options.notification_sent,
        task_state_updated: options.task_state_updated,
        context_card_written: options.context_card_written,
        errors: options.errors ?? []
      }, now);
    });
  }

  async failHookDelivery(
    goalId: string,
    eventKey: string,
    eventType: GoalHookEventType,
    error: string,
    data: Record<string, unknown> = {}
  ): Promise<GoalRecord> {
    return await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      const now = new Date().toISOString();
      const next = cloneGoal(current);
      const state = next.hook_delivery ?? emptyHookDeliveryState(now);
      state.last_event_type = eventType;
      state.last_event_key = eventKey;
      state.last_error = redactSensitiveText(error).slice(0, 8_000);
      state.updated_at = now;
      next.hook_delivery = state;
      next.checkpoint = {
        ...(next.checkpoint ?? {}),
        hook_delivery_settled_at: now,
        hook_delivery_status: "failed"
      };
      return await this.persistMetadataEvent(next, "hook.delivery_failed", {
        hook_event_type: eventType,
        event_key: eventKey,
        error: state.last_error,
        ...data
      }, now);
    });
  }

  async writeResult(goalId: string, result: Record<string, unknown>): Promise<void> {
    const goal = await this.loadGoal(goalId);
    await this.atomicJson(`${this.goalDir(goalId)}/result.json`, {
      ...result,
      contract_version: goal.goal_contract.contract_version
    });
  }

  async finalizeGoal(
    goalId: string,
    status: Extract<GoalStatus, "succeeded" | "failed" | "blocked" | "cancelled">,
    eventType: string,
    result: Record<string, unknown>,
    options: {
      data?: Record<string, unknown>;
      patch?: (goal: GoalRecord) => void;
    } = {}
  ): Promise<GoalRecord> {
    const outcome = await this.exclusive(async () => {
      const current = await this.loadGoal(goalId);
      if (isGoalTerminal(current.status)) {
        return { goal: cloneGoal(current), previousGoal: cloneGoal(current), previousStatus: current.status, persisted: false };
      }
      this.assertStatusChange(current.status, status);

      const next = cloneGoal(current);
      const contractFingerprint = goalContractFingerprint(current.goal_contract);
      next.status = status;
      options.patch?.(next);
      if (goalContractFingerprint(next.goal_contract) !== contractFingerprint) {
        throw new GoalStoreError(
          "invalid_input",
          `Goal ${current.goal_id} contract cannot be changed while finalizing; use an explicit amendment.`
        );
      }
      const events = await this.readEvents(current.goal_id);
      const sequence = Math.max(current.last_event_sequence, events.at(-1)?.sequence ?? 0) + 1;
      const now = new Date().toISOString();
      next.last_event_sequence = sequence;
      next.updated_at = now;
      const event: GoalEvent = sanitized({
        sequence,
        goal_id: current.goal_id,
        run_id: current.run_id,
        contract_version: current.goal_contract.contract_version,
        type: eventType,
        timestamp: now,
        status,
        ...(options.data ? { data: options.data } : {})
      });

      await this.atomicJson(`${this.goalDir(current.goal_id)}/result.json`, {
        ...result,
        status,
        contract_version: current.goal_contract.contract_version
      });
      await this.appendEventFile(current.goal_id, event);
      await this.persistGoal(next);
      return {
        goal: cloneGoal(next),
        previousGoal: cloneGoal(current),
        previousStatus: current.status,
        persisted: true
      };
    });
    if (outcome.persisted) {
      await emitGoalLifecycle(outcome.previousStatus, outcome.goal, eventType);
      await emitGoalLatencyEvents(outcome.previousGoal, outcome.goal, eventType);
    }
    return outcome.goal;
  }

  async readInspection(goalId: string): Promise<{
    goal: GoalRecord;
    events: GoalEvent[];
    validation: GoalValidationResult | null;
    review: GoalReviewResult | null;
    result: Record<string, unknown> | null;
  }> {
    const goal = await this.loadGoal(goalId);
    const dir = this.goalDir(goal.goal_id);
    return {
      goal,
      events: await this.readEvents(goal.goal_id),
      validation: await this.readJson<GoalValidationResult>(`${dir}/validation.json`),
      review: await this.readJson<GoalReviewResult>(`${dir}/review.json`),
      result: await this.readJson<Record<string, unknown>>(`${dir}/result.json`)
    };
  }

  private async findByIdempotencyHash(hash: string): Promise<GoalRecord | undefined> {
    return (await this.listGoals()).find((goal) => goal.idempotency_key === hash);
  }

  private assertStatusChange(previous: GoalStatus, next: GoalStatus): void {
    if (previous === next) return;
    if (isGoalTerminal(previous)) {
      throw new GoalStoreError("terminal_conflict", `Goal already has terminal status ${previous}.`);
    }
    if (!ALLOWED_TRANSITIONS[previous].has(next)) {
      throw new GoalStoreError("invalid_transition", `Invalid Goal transition: ${previous} -> ${next}.`);
    }
  }

  private async persistMetadataEvent(
    goal: GoalRecord,
    eventType: string,
    data: Record<string, unknown>,
    timestamp = new Date().toISOString()
  ): Promise<GoalRecord> {
    const events = await this.readEvents(goal.goal_id);
    const sequence = Math.max(goal.last_event_sequence, events.at(-1)?.sequence ?? 0) + 1;
    goal.last_event_sequence = sequence;
    goal.updated_at = timestamp;
    const event: GoalEvent = sanitized({
      sequence,
      goal_id: goal.goal_id,
      run_id: goal.run_id,
      contract_version: goal.goal_contract.contract_version,
      type: eventType,
      timestamp,
      status: goal.status,
      data
    });
    await this.appendEventFile(goal.goal_id, event);
    await this.persistGoal(goal);
    return cloneGoal(goal);
  }

  private async persistGoal(goal: GoalRecord): Promise<void> {
    reconcileGoalTaskOutcome(goal);
    const safe = sanitized(goal);
    const dir = this.goalDir(safe.goal_id);
    await this.atomicJson(`${dir}/goal.json`, safe);
    await upsertOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "goals",
      safe.goal_id,
      goalOfficeIndexEntry(safe)
    ).catch(() => undefined);
    if (safe.checkpoint) await this.atomicJson(`${dir}/checkpoint.json`, safe.checkpoint);
    if (safe.validation_result) await this.atomicJson(`${dir}/validation.json`, safe.validation_result);
    if (safe.review_result) await this.atomicJson(`${dir}/review.json`, safe.review_result);
  }

  private async atomicJson(relPath: string, value: unknown): Promise<void> {
    const safeValue = sanitized(value);
    const content = `${JSON.stringify(safeValue, null, 2)}\n`;
    const tempPath = `${relPath}.tmp-${process.pid}-${randomUUID()}`;
    await writeTextFile(this.config, this.guard, this.workspace, tempPath, content, { createDirs: true, overwrite: true });
    const temp = this.guard.resolve(this.workspace, tempPath, { forWrite: true });
    const target = this.guard.resolve(this.workspace, relPath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
    try {
      await fsp.rename(temp.absPath, target.absPath);
    } catch (error) {
      await fsp.rm(temp.absPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async appendEventFile(goalId: string, event: GoalEvent): Promise<void> {
    const relPath = `${this.goalDir(goalId)}/events.jsonl`;
    const line = `${JSON.stringify(sanitized(event))}\n`;
    if (findSecretValues(line, { path: relPath }).length) {
      throw new GoalStoreError("invalid_input", "Goal event contains secret-looking content after redaction.");
    }
    const resolved = this.guard.resolve(this.workspace, relPath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const handle = await fsp.open(resolved.absPath, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readJson<T>(relPath: string): Promise<T | null> {
    const resolved = this.guard.resolve(this.workspace, relPath);
    try {
      return sanitized(JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async withStoreFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const root = this.guard.resolve(this.workspace, this.goalsRoot());
    await fsp.mkdir(root.absPath, { recursive: true });
    const lockPath = path.join(root.absPath, ".store-lock");
    const deadline = Date.now() + GOAL_STORE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await fsp.mkdir(lockPath);
        await fsp.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString()
        })}\n`, "utf8").catch(() => undefined);
        try {
          return await operation();
        } finally {
          await fsp.rm(lockPath, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 20
          }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fsp.stat(lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > GOAL_STORE_LOCK_STALE_MS) {
          await fsp.rm(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new GoalStoreError("invalid_transition", "Goal Store write lock timed out while waiting for another runtime instance.");
        }
        await sleep(GOAL_STORE_LOCK_POLL_MS);
      }
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => await this.withStoreFileLock(operation);
    const result = this.operationQueue.then(execute, execute);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
