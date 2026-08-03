import { createHash } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import type { BrowserElementSummary, BrowserSemanticElement } from "../adapters/playwright-adapter.js";
import type { BrowserSemanticSnapshot, BrowserSession } from "./browser-session.js";
import {
  BROWSER_FLOW_RESULT_VERSION,
  assertBrowserFlowStateMatchesContract,
  browserFlowResultSchema,
  browserFlowStateSchema,
  createInitialBrowserFlowState,
  prepareBrowserFlowContract,
  validateBrowserFlowContract,
  type BrowserFlowCondition,
  type BrowserFlowContract,
  type BrowserFlowFact,
  type BrowserFlowPrepareInput,
  type BrowserFlowResult,
  type BrowserFlowState,
  type BrowserFlowStatus,
  type BrowserFlowStep,
  type BrowserFlowStepState
} from "./browser-flow-contract.js";
import { BrowserFlowStore, browserFlowContractPath, browserFlowResultPath, browserFlowStatePath } from "./browser-flow-store.js";
import {
  assertBusinessContextMatches,
  validateBrowserBusinessTask,
  type BrowserBusinessTask
} from "./browser-business-contract.js";
import { loadPersistedBrowserBusinessTask } from "./browser-business-task-store.js";

type BrowserSessionResolver = (workspace: Workspace, spaceId: string) => BrowserSession;

export interface BrowserFlowLifecycle {
  waiting?(workspace: Workspace, spaceId: string, flowId: string): Promise<void> | void;
  started?(workspace: Workspace, spaceId: string, flowId: string): Promise<void> | void;
  finished?(
    workspace: Workspace,
    spaceId: string,
    flowId: string,
    status: BrowserFlowStatus | undefined,
    taskId: string,
    runId: string
  ): Promise<void> | void;
  acquire?(workspace: Workspace, spaceId: string, flowId: string, resource: BrowserFlowResourceKind): Promise<boolean> | boolean;
  release?(workspace: Workspace, spaceId: string, flowId: string, resource: BrowserFlowResourceKind): Promise<void> | void;
}

export type BrowserFlowResourceKind = "interactive_profile" | "visual" | "download";

interface InternalFlowFact extends BrowserFlowFact {
  verified: true;
  public: boolean;
}

interface FlowFactDraft {
  key: string;
  value: unknown;
  confidence?: BrowserFlowFact["confidence"];
  public?: boolean;
}

interface FlowActionResult {
  fullOutput: Record<string, unknown>;
  compactOutput?: Record<string, unknown>;
  facts?: FlowFactDraft[];
  evidencePaths?: string[];
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
  terminalStatus?: "waiting_human";
  nextStepId?: string;
}

class BrowserFlowBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserFlowBlockedError";
  }
}

class BrowserFlowResourceWaitError extends Error {
  constructor(readonly resource: BrowserFlowResourceKind) {
    super(`Browser flow is waiting for the ${resource} resource lease.`);
    this.name = "BrowserFlowResourceWaitError";
  }
}

const PROCESS_BROWSER_FLOW_EXECUTIONS = new Map<string, Promise<void>>();
const PROCESS_CANCELLED_BROWSER_FLOWS = new Set<string>();
const PROCESS_WORKSPACE_ACTIVE_FLOWS = new Map<string, Set<string>>();
const PROCESS_SPACE_ACTIVE_FLOWS = new Map<string, string>();

function now(): string {
  return new Date().toISOString();
}

function flowExecutionKey(workspace: Workspace, runId: string, flowId: string): string {
  return createHash("sha256").update(`${workspace.root}\0${runId}\0${flowId}`).digest("hex");
}

function workspaceExecutionKey(workspace: Workspace): string {
  return createHash("sha256").update(workspace.root).digest("hex");
}

function spaceExecutionKey(workspace: Workspace, spaceId: string): string {
  return createHash("sha256").update(`${workspace.root}\0${spaceId}`).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactUnknown(entry)]));
  return value;
}

function cloneState(state: BrowserFlowState): BrowserFlowState {
  return structuredClone(state);
}

function stateStep(state: BrowserFlowState, stepId: string): BrowserFlowStepState {
  const step = state.steps.find((entry) => entry.step_id === stepId);
  if (!step) throw new Error(`Browser flow state is missing step ${stepId}.`);
  return step;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function wildcardMatches(actual: string, pattern: string): boolean {
  if (pattern.length > 500) throw new BrowserFlowBlockedError("Browser flow URL match pattern exceeds 500 characters.");
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(actual) || actual.toLowerCase().includes(pattern.toLowerCase());
}

function conditionMatches(condition: BrowserFlowCondition, facts: Map<string, InternalFlowFact>): boolean {
  const fact = facts.get(condition.fact_ref);
  if (!fact?.verified) throw new BrowserFlowBlockedError(`Condition references missing or unverified fact ${condition.fact_ref}.`);
  if (condition.operator === "text_contains") return normalizedText(fact.value).includes(normalizedText(condition.expected));
  if (condition.operator === "url_matches") return wildcardMatches(String(fact.value ?? ""), String(condition.expected ?? ""));
  if (condition.operator === "equals" || condition.operator === "step_status") return valuesEqual(fact.value, condition.expected);
  if (condition.operator === "element_exists") {
    if (Array.isArray(fact.value)) return condition.expected === undefined ? fact.value.length > 0 : fact.value.some((value) => valuesEqual(value, condition.expected));
    if (isRecord(fact.value) && "exists" in fact.value) return fact.value.exists === (condition.expected ?? true);
    return Boolean(fact.value) === (condition.expected ?? true);
  }
  if (condition.operator === "element_hidden") {
    if (isRecord(fact.value) && "hidden" in fact.value) return fact.value.hidden === (condition.expected ?? true);
    return !Boolean(fact.value) === (condition.expected ?? true);
  }
  return false;
}

function factsFromState(state: BrowserFlowState): Map<string, InternalFlowFact> {
  const facts = new Map<string, InternalFlowFact>();
  for (const step of state.steps) {
    const entries = Array.isArray(step.output?.facts) ? step.output.facts : [];
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.key !== "string" || !Array.isArray(entry.evidence_refs) || entry.verified !== true) continue;
      facts.set(entry.key, {
        key: entry.key,
        value: entry.value,
        evidence_refs: entry.evidence_refs.filter((item): item is string => typeof item === "string"),
        confidence: entry.confidence === "medium" || entry.confidence === "low" || entry.confidence === "unknown" ? entry.confidence : "high",
        verified: true,
        public: entry.public === true
      });
    }
  }
  return facts;
}

function classifyError(error: unknown): { status: "failed" | "blocked"; errorClass: string; message: string } {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  const lowered = message.toLowerCase();
  if (error instanceof BrowserFlowBlockedError || lowered.includes("blocked") || lowered.includes("mismatch") || lowered.includes("stale") ||
      lowered.includes("authorization") || lowered.includes("not allowed") || lowered.includes("final business") || lowered.includes("unverified fact")) {
    return { status: "blocked", errorClass: error instanceof Error ? error.name : "BrowserFlowBlockedError", message };
  }
  return { status: "failed", errorClass: error instanceof Error ? error.name : "Error", message };
}

function targetForInput(input: Record<string, unknown>): string {
  const ref = typeof input.ref === "string" ? input.ref : "";
  const selector = typeof input.selector === "string" ? input.selector : "";
  if (!ref && !selector) throw new BrowserFlowBlockedError("Browser flow interaction is missing a target ref or selector.");
  return ref || selector;
}

function factValue(facts: Map<string, InternalFlowFact>, ref: unknown, label: string): unknown {
  if (typeof ref !== "string" || !ref.trim()) throw new BrowserFlowBlockedError(`${label} fact reference is missing.`);
  const fact = facts.get(ref);
  if (!fact?.verified) throw new BrowserFlowBlockedError(`${label} references missing or unverified fact ${ref}.`);
  return fact.value;
}

function stringFactValue(facts: Map<string, InternalFlowFact>, ref: unknown, label: string): string {
  const value = factValue(facts, ref, label);
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string" && entry.trim());
    if (typeof first === "string") return first;
  }
  if (typeof value !== "string" || !value.trim()) throw new BrowserFlowBlockedError(`${label} fact must contain a non-empty string.`);
  return value;
}

function valueAtPath(value: unknown, dottedPath: string | undefined): unknown {
  if (!dottedPath) return value;
  return dottedPath.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (isRecord(current)) return current[segment];
    return undefined;
  }, value);
}

function numericValues(value: unknown, column?: string): number[] {
  const entries = Array.isArray(value) ? value : [];
  return entries.map((entry) => {
    const candidate = column && isRecord(entry) ? entry[column] : entry;
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string") return Number(candidate.replace(/[\s,]/g, ""));
    return Number.NaN;
  }).filter(Number.isFinite);
}

function aggregateValue(value: unknown, operation: string, column?: string): unknown {
  if (operation === "copy") return value;
  const candidates = column && Array.isArray(value) ? value.map((entry) => isRecord(entry) ? entry[column] : undefined) : value;
  if (operation === "count") return Array.isArray(candidates) ? candidates.length : isRecord(candidates) ? Object.keys(candidates).length : candidates == null ? 0 : 1;
  if (operation === "unique") return [...new Set((Array.isArray(candidates) ? candidates : [candidates]).map((entry) => JSON.stringify(entry)))].map((entry) => JSON.parse(entry));
  const numbers = numericValues(value, column);
  if (!numbers.length) throw new BrowserFlowBlockedError(`Cannot apply ${operation} to a source without numeric values.`);
  if (operation === "sum") return numbers.reduce((sum, entry) => sum + entry, 0);
  if (operation === "min") return Math.min(...numbers);
  if (operation === "max") return Math.max(...numbers);
  throw new BrowserFlowBlockedError(`Unsupported extract_facts operation ${operation}.`);
}

function isTerminalStatus(status: BrowserFlowStatus): boolean {
  return status === "passed" || status === "failed" || status === "blocked" || status === "waiting_human" || status === "cancelled";
}

function resourceForStep(step: BrowserFlowStep): BrowserFlowResourceKind | undefined {
  if (step.type === "visual_observe") return "visual";
  if (step.type === "download") return "download";
  if (["open", "click", "input", "select", "check", "scroll", "wait"].includes(step.type)) return "interactive_profile";
  return undefined;
}

export class BrowserFlowEngine {
  private readonly store: BrowserFlowStore;

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly sessionFor: BrowserSessionResolver,
    private readonly lifecycle: BrowserFlowLifecycle = {}
  ) {
    this.store = new BrowserFlowStore(guard);
  }

  async prepare(workspace: Workspace, taskValue: unknown, input: BrowserFlowPrepareInput): Promise<{
    contract: BrowserFlowContract;
    state: BrowserFlowState;
    contractPath: string;
    statePath: string;
  }> {
    const task = validateBrowserBusinessTask(taskValue);
    const contract = prepareBrowserFlowContract(task, input);
    const state = createInitialBrowserFlowState(contract);
    return this.store.persistPrepared(workspace, contract, state);
  }

  async status(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowState> {
    let state = await this.store.loadState(workspace, runId, flowId);
    const active = PROCESS_BROWSER_FLOW_EXECUTIONS.get(flowExecutionKey(workspace, runId, flowId));
    if (active && isTerminalStatus(state.status)) {
      await active.catch(() => undefined);
      state = await this.store.loadState(workspace, runId, flowId);
    }
    return state;
  }

  async run(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowState> {
    const contract = await this.store.loadContract(workspace, runId, flowId);
    let state = await this.store.loadState(workspace, runId, flowId);
    if (state.status !== "prepared" && state.status !== "queued" && state.status !== "waiting_resource") {
      throw new Error(`Browser flow ${flowId} cannot start from status ${state.status}.`);
    }
    const active = PROCESS_BROWSER_FLOW_EXECUTIONS.get(flowExecutionKey(workspace, runId, flowId));
    if (active) return state;
    const workspaceKey = workspaceExecutionKey(workspace);
    const spaceKey = spaceExecutionKey(workspace, contract.space_id);
    const otherFlow = PROCESS_SPACE_ACTIVE_FLOWS.get(spaceKey);
    const workspaceFlows = PROCESS_WORKSPACE_ACTIVE_FLOWS.get(workspaceKey) ?? new Set<string>();
    if ((otherFlow && otherFlow !== flowId) || (!workspaceFlows.has(flowId) && workspaceFlows.size >= 2)) {
      const resourceOwner = otherFlow ?? [...workspaceFlows].join(", ");
      state = browserFlowStateSchema.parse({
        ...state,
        status: "waiting_resource",
        resource_wait: otherFlow
          ? `Browser flow ${resourceOwner} currently owns the ${contract.space_id} space execution lease.`
          : `Browser flow limit reached (2); active flows: ${resourceOwner}.`,
        updated_at: now()
      });
      await this.store.saveState(workspace, contract, state);
      await this.lifecycle.waiting?.(workspace, contract.space_id, contract.flow_id);
      return state;
    }
    state = browserFlowStateSchema.parse({ ...state, status: "queued", resource_wait: undefined, updated_at: now() });
    await this.store.saveState(workspace, contract, state);
    this.startBackgroundExecution(workspace, contract);
    return state;
  }

  async resume(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowState> {
    const contract = await this.store.loadContract(workspace, runId, flowId);
    let state = await this.store.loadState(workspace, runId, flowId);
    if (PROCESS_BROWSER_FLOW_EXECUTIONS.has(flowExecutionKey(workspace, runId, flowId))) return state;
    if (state.status === "passed" || state.status === "cancelled") throw new Error(`Browser flow ${flowId} cannot resume from terminal status ${state.status}.`);

    let resetCount = 0;
    const steps = state.steps.map((step) => {
      if (step.status === "passed" || step.status === "skipped") return step;
      const interrupted = step.status === "running";
      const retryableFailure = (step.status === "failed" || step.status === "blocked") && step.retryable;
      if ((interrupted || retryableFailure) && step.recoverable) {
        resetCount += 1;
        const { started_at: _startedAt, finished_at: _finishedAt, error_class: _errorClass, error_message: _errorMessage, ...preserved } = step;
        return { ...preserved, status: "pending" as const };
      }
      return step;
    });
    if (!resetCount && state.status !== "waiting_resource") {
      throw new Error(`Browser flow ${flowId} has no incomplete recoverable step. Passed steps and non-retryable side effects will not be repeated.`);
    }
    state = browserFlowStateSchema.parse({
      ...state,
      status: "queued",
      current_step_id: null,
      steps,
      resume_count: state.resume_count + 1,
      blocking_reason: undefined,
      resource_wait: undefined,
      updated_at: now()
    });
    await this.store.saveState(workspace, contract, state);
    return this.run(workspace, runId, flowId);
  }

  async cancel(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowState> {
    const contract = await this.store.loadContract(workspace, runId, flowId);
    const executionKey = flowExecutionKey(workspace, runId, flowId);
    let state = await this.store.loadState(workspace, runId, flowId);
    if (state.status === "passed" || state.status === "cancelled") return state;
    PROCESS_CANCELLED_BROWSER_FLOWS.add(executionKey);
    const cancelledAt = now();
    state = browserFlowStateSchema.parse({
      ...state,
      status: "cancelled",
      current_step_id: null,
      blocking_reason: "Cancelled by explicit browser_flow_cancel request. Completed browser steps and local evidence were preserved.",
      steps: state.steps.map((step) => step.status === "pending" || step.status === "running"
        ? { ...step, status: "cancelled", finished_at: cancelledAt }
        : step),
      updated_at: cancelledAt
    });
    await this.store.saveState(workspace, contract, state);
    await this.finalize(workspace, contract, state);
    if (!PROCESS_BROWSER_FLOW_EXECUTIONS.has(executionKey)) {
      await this.lifecycle.finished?.(workspace, contract.space_id, contract.flow_id, state.status, contract.task_id, contract.run_id);
      PROCESS_CANCELLED_BROWSER_FLOWS.delete(executionKey);
    }
    return state;
  }

  async result(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowResult> {
    await PROCESS_BROWSER_FLOW_EXECUTIONS.get(flowExecutionKey(workspace, runId, flowId))?.catch(() => undefined);
    const state = await this.store.loadState(workspace, runId, flowId);
    if (!isTerminalStatus(state.status)) throw new Error(`Browser flow ${flowId} is ${state.status}; a final result is not available yet.`);
    return this.store.loadResult(workspace, runId, flowId);
  }

  private startBackgroundExecution(workspace: Workspace, contract: BrowserFlowContract): void {
    const key = flowExecutionKey(workspace, contract.run_id, contract.flow_id);
    const workspaceKey = workspaceExecutionKey(workspace);
    const spaceKey = spaceExecutionKey(workspace, contract.space_id);
    const workspaceFlows = PROCESS_WORKSPACE_ACTIVE_FLOWS.get(workspaceKey) ?? new Set<string>();
    workspaceFlows.add(contract.flow_id);
    PROCESS_WORKSPACE_ACTIVE_FLOWS.set(workspaceKey, workspaceFlows);
    PROCESS_SPACE_ACTIVE_FLOWS.set(spaceKey, contract.flow_id);
    const promise = Promise.resolve()
      .then(() => this.lifecycle.started?.(workspace, contract.space_id, contract.flow_id))
      .then(() => this.execute(workspace, contract))
      .catch((error) => this.failUnexpected(workspace, contract, error))
      .finally(async () => {
        const activeFlows = PROCESS_WORKSPACE_ACTIVE_FLOWS.get(workspaceKey);
        activeFlows?.delete(contract.flow_id);
        if (!activeFlows?.size) PROCESS_WORKSPACE_ACTIVE_FLOWS.delete(workspaceKey);
        if (PROCESS_SPACE_ACTIVE_FLOWS.get(spaceKey) === contract.flow_id) PROCESS_SPACE_ACTIVE_FLOWS.delete(spaceKey);
        const finalState = await this.store.loadState(workspace, contract.run_id, contract.flow_id).catch(() => undefined);
        if (finalState?.status === "waiting_resource") await this.lifecycle.waiting?.(workspace, contract.space_id, contract.flow_id);
        else await this.lifecycle.finished?.(
          workspace,
          contract.space_id,
          contract.flow_id,
          finalState?.status,
          contract.task_id,
          contract.run_id
        );
        PROCESS_BROWSER_FLOW_EXECUTIONS.delete(key);
        PROCESS_CANCELLED_BROWSER_FLOWS.delete(key);
      });
    PROCESS_BROWSER_FLOW_EXECUTIONS.set(key, promise);
  }

  private async loadTask(workspace: Workspace, contract: BrowserFlowContract): Promise<BrowserBusinessTask> {
    const task = await loadPersistedBrowserBusinessTask(this.guard, workspace, contract.task_id, contract.run_id);
    if (task.task_contract_hash !== contract.task_contract_hash) {
      throw new BrowserFlowBlockedError("Browser flow contract is bound to a different Browser Business Task contract hash.");
    }
    if (task.platform.toLowerCase() !== contract.platform.toLowerCase() || task.risk_class !== contract.risk_class) {
      throw new BrowserFlowBlockedError("Browser flow contract conflicts with the persisted business task platform or risk class.");
    }
    return task;
  }

  private async execute(workspace: Workspace, contractValue: BrowserFlowContract): Promise<void> {
    const contract = validateBrowserFlowContract(contractValue);
    const executionKey = flowExecutionKey(workspace, contract.run_id, contract.flow_id);
    await this.loadTask(workspace, contract);
    let state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
    if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return;
    state = browserFlowStateSchema.parse({ ...state, status: "running", current_step_id: null, resource_wait: undefined, updated_at: now() });
    await this.store.saveState(workspace, contract, state);
    const repeatBodyIds = new Set(contract.steps.flatMap((step) => step.repeat?.body_step_ids ?? []));

    let index = 0;
    while (index < contract.steps.length) {
      state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return;
      const step = contract.steps[index];
      const stepState = stateStep(state, step.id);
      if (stepState.status === "passed" || stepState.status === "skipped") {
        index += 1;
        continue;
      }
      if (repeatBodyIds.has(step.id)) {
        stepState.status = "skipped";
        stepState.finished_at = now();
        stepState.output = { skipped_reason: "repeat_body_not_selected" };
        state.updated_at = now();
        await this.store.saveState(workspace, contract, state);
        index += 1;
        continue;
      }
      const dependencyFailure = step.depends_on.find((dependency) => {
        const status = stateStep(state, dependency).status;
        return status !== "passed" && status !== "skipped";
      });
      if (dependencyFailure) {
        await this.blockStep(workspace, contract, state, step, `Dependency ${dependencyFailure} is not passed or skipped.`);
        return;
      }
      const facts = factsFromState(state);
      try {
        for (const condition of step.preconditions) {
          if (!conditionMatches(condition, facts)) throw new BrowserFlowBlockedError(`Precondition failed for step ${step.id}: ${condition.fact_ref} ${condition.operator}.`);
        }
      } catch (error) {
        await this.blockStep(workspace, contract, state, step, error instanceof Error ? error.message : String(error));
        return;
      }
      let outcome: Awaited<ReturnType<BrowserFlowEngine["executeContractStep"]>>;
      try {
        outcome = await this.executeContractStep(workspace, contract, step, false);
      } catch (error) {
        if (error instanceof BrowserFlowResourceWaitError) return;
        throw error;
      }
      state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return;
      if (!outcome.passed) {
        await this.finalize(workspace, contract, state);
        return;
      }
      if (outcome.waitingHuman) {
        await this.finalize(workspace, contract, state);
        return;
      }
      if (outcome.nextStepId) {
        const targetIndex = contract.steps.findIndex((entry) => entry.id === outcome.nextStepId);
        if (targetIndex <= index) {
          await this.blockStep(workspace, contract, state, step, `Branch target ${outcome.nextStepId} is not a later step.`);
          return;
        }
        for (let skippedIndex = index + 1; skippedIndex < targetIndex; skippedIndex += 1) {
          const skipped = stateStep(state, contract.steps[skippedIndex].id);
          if (skipped.status === "pending") {
            skipped.status = "skipped";
            skipped.finished_at = now();
            skipped.output = { skipped_reason: `branch_to:${outcome.nextStepId}` };
          }
        }
        state.updated_at = now();
        await this.store.saveState(workspace, contract, state);
        index = targetIndex;
        continue;
      }
      index += 1;
    }

    state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
    if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return;
    const unresolved = state.steps.filter((step) => step.status !== "passed" && step.status !== "skipped");
    state = browserFlowStateSchema.parse({
      ...state,
      status: unresolved.length ? "failed" : "passed",
      current_step_id: null,
      ...(unresolved.length ? { blocking_reason: `Unresolved steps remain: ${unresolved.map((step) => step.step_id).join(", ")}.` } : {}),
      updated_at: now()
    });
    await this.store.saveState(workspace, contract, state);
    await this.finalize(workspace, contract, state);
  }

  private async executeContractStep(
    workspace: Workspace,
    contract: BrowserFlowContract,
    step: BrowserFlowStep,
    force: boolean
  ): Promise<{ passed: boolean; waitingHuman: boolean; nextStepId?: string }> {
    const executionKey = flowExecutionKey(workspace, contract.run_id, contract.flow_id);
    let state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
    const persistedStep = stateStep(state, step.id);
    if (!force && (persistedStep.status === "passed" || persistedStep.status === "skipped")) return { passed: true, waitingHuman: false };
    const startedAt = now();
    persistedStep.status = "running";
    persistedStep.started_at = startedAt;
    persistedStep.finished_at = undefined;
    persistedStep.error_class = undefined;
    persistedStep.error_message = undefined;
    persistedStep.attempt_count += 1;
    state.status = "running";
    state.current_step_id = step.id;
    state.updated_at = startedAt;
    await this.store.saveState(workspace, contract, state);

    const resource = resourceForStep(step);
    let resourceAcquired = false;
    if (resource && this.lifecycle.acquire) {
      resourceAcquired = await this.lifecycle.acquire(workspace, contract.space_id, contract.flow_id, resource);
      if (!resourceAcquired) {
        state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
        const waitingStep = stateStep(state, step.id);
        waitingStep.status = "pending";
        waitingStep.attempt_count = Math.max(0, waitingStep.attempt_count - 1);
        waitingStep.started_at = undefined;
        state.status = "waiting_resource";
        state.current_step_id = null;
        state.resource_wait = `Browser flow ${contract.flow_id} is waiting for the ${resource} lease in space ${contract.space_id}.`;
        state.updated_at = now();
        await this.store.saveState(workspace, contract, state);
        throw new BrowserFlowResourceWaitError(resource);
      }
    }

    try {
      const result = step.type === "repeat_bounded"
        ? await this.executeRepeat(workspace, contract, step)
        : await this.executeAction(workspace, contract, step);
      const finishedAt = now();
      const evidencePath = await this.store.saveStepEvidence(workspace, contract, step.id, persistedStep.attempt_count, {
        version: 1,
        flow_id: contract.flow_id,
        contract_hash: contract.contract_hash,
        step_id: step.id,
        step_type: step.type,
        attempt: persistedStep.attempt_count,
        input_hash: persistedStep.input_hash,
        started_at: startedAt,
        finished_at: finishedAt,
        status: result.terminalStatus ?? "passed",
        output: redactUnknown(result.fullOutput)
      });
      state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return { passed: false, waitingHuman: false };
      const current = stateStep(state, step.id);
      const evidencePaths = [...new Set([evidencePath, ...(result.evidencePaths ?? [])])];
      const facts: InternalFlowFact[] = [
        ...(result.facts ?? []).map((fact) => ({
          key: fact.key,
          value: redactUnknown(fact.value),
          evidence_refs: evidencePaths,
          confidence: fact.confidence ?? "high",
          verified: true as const,
          public: fact.public === true
        })),
        {
          key: `${step.id}.status`,
          value: result.terminalStatus ?? "passed",
          evidence_refs: [evidencePath],
          confidence: "high",
          verified: true,
          public: false
        }
      ];
      current.status = result.terminalStatus ?? "passed";
      current.finished_at = finishedAt;
      current.before_snapshot_id = result.beforeSnapshotId;
      current.after_snapshot_id = result.afterSnapshotId;
      current.output = { ...(result.compactOutput ?? redactUnknown(result.fullOutput) as Record<string, unknown>), facts };
      current.evidence_paths = [...new Set([...current.evidence_paths, ...evidencePaths])];
      state.current_step_id = result.terminalStatus === "waiting_human" ? step.id : null;
      state.status = result.terminalStatus === "waiting_human" ? "waiting_human" : "running";
      state.blocking_reason = result.terminalStatus === "waiting_human" ? String(result.fullOutput.reason ?? "Human action is required.") : undefined;
      state.updated_at = finishedAt;
      await this.store.saveState(workspace, contract, state);
      return { passed: result.terminalStatus !== "waiting_human", waitingHuman: result.terminalStatus === "waiting_human", nextStepId: result.nextStepId };
    } catch (error) {
      if (error instanceof BrowserFlowResourceWaitError) throw error;
      const classified = classifyError(error);
      const finishedAt = now();
      const evidencePath = await this.store.saveStepEvidence(workspace, contract, step.id, persistedStep.attempt_count, {
        version: 1,
        flow_id: contract.flow_id,
        contract_hash: contract.contract_hash,
        step_id: step.id,
        step_type: step.type,
        attempt: persistedStep.attempt_count,
        input_hash: persistedStep.input_hash,
        started_at: startedAt,
        finished_at: finishedAt,
        status: classified.status,
        error_class: classified.errorClass,
        error_message: classified.message
      });
      state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(executionKey)) return { passed: false, waitingHuman: false };
      const current = stateStep(state, step.id);
      current.status = classified.status;
      current.finished_at = finishedAt;
      current.error_class = classified.errorClass;
      current.error_message = classified.message;
      current.evidence_paths = [...new Set([...current.evidence_paths, evidencePath])];
      current.output = {
        facts: [{
          key: `${step.id}.status`,
          value: classified.status,
          evidence_refs: [evidencePath],
          confidence: "high",
          verified: true,
          public: false
        }]
      };
      state.status = classified.status;
      state.current_step_id = step.id;
      state.blocking_reason = classified.message;
      state.updated_at = finishedAt;
      await this.store.saveState(workspace, contract, state);
      return { passed: false, waitingHuman: false };
    } finally {
      if (resource && resourceAcquired) await this.lifecycle.release?.(workspace, contract.space_id, contract.flow_id, resource);
    }
  }

  private async executeRepeat(workspace: Workspace, contract: BrowserFlowContract, step: BrowserFlowStep): Promise<FlowActionResult> {
    if (!step.repeat) throw new BrowserFlowBlockedError(`Repeat step ${step.id} is missing its bounded repeat contract.`);
    const iterations: Array<Record<string, unknown>> = [];
    let previousProgress: unknown = Symbol("initial");
    for (let iteration = 1; iteration <= step.repeat.max_iterations; iteration += 1) {
      for (const bodyStepId of step.repeat.body_step_ids) {
        const bodyStep = contract.steps.find((entry) => entry.id === bodyStepId);
        if (!bodyStep) throw new BrowserFlowBlockedError(`Repeat body step ${bodyStepId} is missing.`);
        const beforeBody = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
        const bodyFacts = factsFromState(beforeBody);
        const failedDependency = bodyStep.depends_on.find((dependency) => {
          const status = stateStep(beforeBody, dependency).status;
          return status !== "passed" && status !== "skipped";
        });
        if (failedDependency) throw new BrowserFlowBlockedError(`Repeat body step ${bodyStepId} dependency ${failedDependency} is not passed or skipped.`);
        for (const condition of bodyStep.preconditions) {
          if (!conditionMatches(condition, bodyFacts)) throw new BrowserFlowBlockedError(`Repeat body precondition failed for ${bodyStepId}: ${condition.fact_ref} ${condition.operator}.`);
        }
        const outcome = await this.executeContractStep(workspace, contract, bodyStep, true);
        if (!outcome.passed) {
          const afterBody = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
          const bodyStatus = stateStep(afterBody, bodyStepId).status;
          if (bodyStatus === "blocked") throw new BrowserFlowBlockedError(`Repeat body step ${bodyStepId} was blocked.`);
          throw new Error(`Repeat body step ${bodyStepId} did not pass.`);
        }
      }
      const state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(flowExecutionKey(workspace, contract.run_id, contract.flow_id))) throw new Error("Browser flow was cancelled during its bounded repeat.");
      const facts = factsFromState(state);
      const progress = factValue(facts, step.repeat.progress_fact_ref, `repeat ${step.id} progress`);
      if (iteration > 1 && valuesEqual(progress, previousProgress)) {
        throw new BrowserFlowBlockedError(`Repeat step ${step.id} stopped because ${step.repeat.progress_fact_ref} did not change.`);
      }
      previousProgress = structuredClone(progress);
      const until = isRecord(step.input) ? step.input.until : undefined;
      const complete = until ? conditionMatches(until as BrowserFlowCondition, facts) : progress === null || progress === undefined || progress === false || progress === "";
      iterations.push({ iteration, progress: redactUnknown(progress), complete });
      if (complete) {
        return {
          fullOutput: { iterations, completed_by: "until_condition", max_iterations: step.repeat.max_iterations },
          compactOutput: { iterations_used: iteration, completed_by: "until_condition" },
          facts: [
            { key: `${step.id}.iterations_used`, value: iteration, public: true },
            { key: `${step.id}.complete`, value: true, public: true }
          ]
        };
      }
    }
    return {
      fullOutput: { iterations, completed_by: "iteration_limit", max_iterations: step.repeat.max_iterations },
      compactOutput: { iterations_used: step.repeat.max_iterations, completed_by: "iteration_limit" },
      facts: [
        { key: `${step.id}.iterations_used`, value: step.repeat.max_iterations, public: true },
        { key: `${step.id}.complete`, value: false, confidence: "medium", public: true }
      ]
    };
  }

  private async verifyTarget(session: BrowserSession, input: Record<string, unknown>): Promise<BrowserElementSummary | BrowserSemanticElement> {
    const target = targetForInput(input);
    const element = await session.getElement(target, typeof input.timeout_ms === "number" ? input.timeout_ms : 5000);
    if (element.source === "native_cdp" || element.actionable === false) throw new BrowserFlowBlockedError(`Target ${target} is read-only and cannot be used by a flow interaction.`);
    const expectedName = normalizedText(input.target_name);
    const accessibleName = "accessibleName" in element ? element.accessibleName : undefined;
    const ariaLabel = "ariaLabel" in element ? element.ariaLabel : undefined;
    const actual = normalizedText([accessibleName, ariaLabel, element.name, element.id, element.placeholder, element.text, element.role, element.selector].filter(Boolean).join(" "));
    if (!actual.includes(expectedName)) throw new BrowserFlowBlockedError(`Browser flow target identity mismatch for ${target}; expected ${String(input.target_name)}.`);
    if (typeof input.identity_signature === "string" && element.identitySignature !== input.identity_signature) {
      throw new BrowserFlowBlockedError(`Browser flow target identity signature mismatch for ${target}.`);
    }
    return element;
  }

  private async captureInteractionSnapshot(session: BrowserSession): Promise<BrowserSemanticSnapshot> {
    const snapshot = await session.observe({
      scope: "viewport",
      maxNodes: Math.min(this.config.browserObserveMaxNodes, 120),
      maxTextChars: Math.min(this.config.browserObserveMaxTextChars, 6000),
      includeTables: false,
      includeForms: true,
      includeLayoutIssues: false,
      includeAccessibility: true
    });
    return snapshot;
  }

  private assertInteractionContext(task: BrowserBusinessTask, input: Record<string, unknown>, snapshot: BrowserSemanticSnapshot): void {
    const expectedContext = input.expected_context;
    if (!isRecord(expectedContext)) throw new BrowserFlowBlockedError("Browser flow interaction is missing expected_context.");
    assertBusinessContextMatches(task, expectedContext as Parameters<typeof assertBusinessContextMatches>[1], "browser flow live interaction context");
    const required = Array.isArray(expectedContext.required_visible_text)
      ? expectedContext.required_visible_text.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [];
    const observed = normalizedText(`${snapshot.title}\n${snapshot.url}\n${snapshot.text}`);
    const missing = required.find((value) => !observed.includes(normalizedText(value)));
    if (missing) throw new BrowserFlowBlockedError(`Browser flow page fact conflict: required context text ${missing} is not visible.`);
  }

  private async executeAction(workspace: Workspace, contract: BrowserFlowContract, step: BrowserFlowStep): Promise<FlowActionResult> {
    const session = this.sessionFor(workspace, contract.space_id);
    const input = step.input as Record<string, unknown>;
    const state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
    const facts = factsFromState(state);
    if (step.type === "open") {
      const entry = await session.open(String(input.url), {
        device: input.device as "desktop" | "mobile" | undefined,
        waitUntil: input.wait_until as "load" | "domcontentloaded" | "networkidle" | undefined,
        timeoutMs: input.timeout_ms as number | undefined
      });
      if (!entry.opened) throw new Error(entry.error ?? `Failed to open ${String(input.url)}.`);
      return {
        fullOutput: { open: entry },
        compactOutput: { final_url: entry.finalUrl, title: entry.title, navigated: entry.navigated !== false },
        facts: [
          { key: `${step.id}.url`, value: entry.finalUrl },
          { key: `${step.id}.title`, value: entry.title },
          { key: `${step.id}.navigated`, value: entry.navigated !== false }
        ]
      };
    }
    if (step.type === "observe") {
      const snapshot = await session.observe({
        scope: input.scope as "viewport" | "document" | "selector" | undefined,
        selector: input.selector as string | undefined,
        maxNodes: input.max_nodes as number | undefined,
        maxTextChars: input.max_text_chars as number | undefined,
        includeTables: input.include_tables as boolean | undefined,
        includeForms: input.include_forms as boolean | undefined,
        includeLayoutIssues: input.include_layout_issues as boolean | undefined,
        includeAccessibility: input.include_accessibility as boolean | undefined
      });
      return {
        fullOutput: { snapshot },
        compactOutput: {
          snapshot_id: snapshot.snapshotId,
          page_id: snapshot.pageId,
          page_revision: snapshot.pageRevision,
          url: snapshot.url,
          title: snapshot.title,
          element_count: snapshot.elements.length,
          table_count: snapshot.tables.length,
          has_more: snapshot.pagination.hasMore,
          next_cursor: snapshot.pagination.nextCursor,
          evidence_path: snapshot.evidencePath
        },
        evidencePaths: [snapshot.evidencePath],
        afterSnapshotId: snapshot.snapshotId,
        facts: [
          { key: `${step.id}.snapshot_id`, value: snapshot.snapshotId },
          { key: `${step.id}.page_id`, value: snapshot.pageId },
          { key: `${step.id}.page_revision`, value: snapshot.pageRevision },
          { key: `${step.id}.url`, value: snapshot.url },
          { key: `${step.id}.title`, value: snapshot.title },
          { key: `${step.id}.text`, value: snapshot.text },
          { key: `${step.id}.element_refs`, value: snapshot.elements.map((element) => element.ref) },
          { key: `${step.id}.table_refs`, value: snapshot.tables.map((table) => table.ref) },
          { key: `${step.id}.has_more`, value: snapshot.pagination.hasMore },
          { key: `${step.id}.next_cursor`, value: snapshot.pagination.nextCursor ?? null },
          { key: `${step.id}.next_node_offset`, value: snapshot.pagination.nextNodeOffset }
        ]
      };
    }
    if (step.type === "observe_continue") {
      const cursor = typeof input.cursor === "string" ? input.cursor : (() => {
        const primary = typeof input.cursor_fact_ref === "string" ? facts.get(input.cursor_fact_ref)?.value : undefined;
        if (typeof primary === "string" && primary) return primary;
        return stringFactValue(facts, input.initial_cursor_fact_ref, `observe_continue ${step.id} initial cursor`);
      })();
      const snapshot = await session.observeContinue(cursor);
      return {
        fullOutput: { snapshot },
        compactOutput: {
          snapshot_id: snapshot.snapshotId,
          chunk_index: snapshot.pagination.chunkIndex,
          has_more: snapshot.pagination.hasMore,
          next_cursor: snapshot.pagination.nextCursor,
          evidence_path: snapshot.evidencePath
        },
        evidencePaths: [snapshot.evidencePath],
        afterSnapshotId: snapshot.snapshotId,
        facts: [
          { key: `${step.id}.snapshot_id`, value: snapshot.snapshotId },
          { key: `${step.id}.text`, value: snapshot.text },
          { key: `${step.id}.table_refs`, value: snapshot.tables.map((table) => table.ref) },
          { key: `${step.id}.has_more`, value: snapshot.pagination.hasMore },
          { key: `${step.id}.next_cursor`, value: snapshot.pagination.nextCursor ?? null },
          { key: `${step.id}.next_node_offset`, value: snapshot.pagination.nextNodeOffset }
        ]
      };
    }
    if (step.type === "assert") {
      const conditions = input.conditions as BrowserFlowCondition[];
      for (const condition of conditions) {
        if (!conditionMatches(condition, facts)) throw new BrowserFlowBlockedError(`Assertion failed: ${condition.fact_ref} ${condition.operator}.`);
      }
      return { fullOutput: { assertions: conditions.map((condition) => ({ ...condition, passed: true })) } };
    }
    if (["click", "input", "select", "check", "scroll"].includes(step.type)) {
      const before = await this.captureInteractionSnapshot(session);
      if (step.type !== "scroll") this.assertInteractionContext(await this.loadTask(workspace, contract), input, before);
      await this.verifyTarget(session, input);
      const target = targetForInput(input);
      let interaction;
      if (step.type === "click") interaction = await session.click(target, { button: input.button as "left" | "right" | "middle" | undefined, timeoutMs: input.timeout_ms as number | undefined });
      else if (step.type === "input") interaction = await session.type(target, String(input.text), { clear: input.clear as boolean | undefined, delayMs: input.delay_ms as number | undefined, timeoutMs: input.timeout_ms as number | undefined, skipIfValueMatches: true });
      else if (step.type === "select") interaction = await session.select(target, { value: input.value as string | undefined, label: input.label as string | undefined, timeoutMs: input.timeout_ms as number | undefined });
      else if (step.type === "check") interaction = await session.check(target, input.checked !== false, input.timeout_ms as number | undefined);
      else interaction = await session.scrollIntoView(target, input.timeout_ms as number | undefined);
      if (!interaction.passed) throw new Error(interaction.error ?? `${step.type} interaction failed.`);
      const after = await this.captureInteractionSnapshot(session);
      return {
        fullOutput: { interaction },
        compactOutput: { action: interaction.action, passed: interaction.passed, url: interaction.url },
        evidencePaths: [before.evidencePath, after.evidencePath],
        beforeSnapshotId: before.snapshotId,
        afterSnapshotId: after.snapshotId,
        facts: [
          { key: `${step.id}.passed`, value: interaction.passed },
          { key: `${step.id}.url`, value: interaction.url }
        ]
      };
    }
    if (step.type === "wait") {
      const target = targetForInput(input);
      const interaction = await session.wait(target, { state: input.state as "visible" | "hidden" | "attached" | "detached" | undefined, timeoutMs: input.timeout_ms as number | undefined });
      if (!interaction.passed) throw new Error(interaction.error ?? "Browser wait failed.");
      return { fullOutput: { interaction }, compactOutput: { passed: true, state: interaction.state }, facts: [{ key: `${step.id}.passed`, value: true }] };
    }
    if (step.type === "extract_table") {
      const snapshotId = typeof input.snapshot_id === "string" ? input.snapshot_id : stringFactValue(facts, input.snapshot_fact_ref, `extract_table ${step.id} snapshot`);
      const tableRef = typeof input.table_ref === "string" ? input.table_ref : stringFactValue(facts, input.table_ref_fact_ref, `extract_table ${step.id} table`);
      const extraction = await session.extractTable({
        snapshotId,
        tableRef,
        maxRows: input.max_rows as number | undefined,
        maxScrolls: input.max_scrolls as number | undefined,
        uniqueKeyHint: input.unique_key_hint as string | undefined
      });
      return {
        fullOutput: { table_extraction: extraction },
        compactOutput: {
          extraction_id: extraction.extractionId,
          table_ref: extraction.tableRef,
          row_count: extraction.rows.length,
          columns: extraction.columns,
          completeness: extraction.completeness,
          possible_more: extraction.possibleMore,
          evidence_path: extraction.evidencePath
        },
        evidencePaths: [extraction.evidencePath],
        facts: [
          { key: `${step.id}.row_count`, value: extraction.rows.length },
          { key: `${step.id}.columns`, value: extraction.columns },
          { key: `${step.id}.completeness`, value: extraction.completeness },
          { key: `${step.id}.possible_more`, value: extraction.possibleMore },
          { key: `${step.id}.loaded_end`, value: extraction.loadedRange.end }
        ]
      };
    }
    if (step.type === "extract_facts") {
      const extracted: FlowFactDraft[] = [];
      for (const specValue of input.facts as Array<Record<string, unknown>>) {
        let source: unknown;
        let sourceEvidence: string[] = [];
        if (typeof specValue.source_fact_ref === "string") {
          const sourceFact = facts.get(specValue.source_fact_ref);
          if (!sourceFact?.verified) throw new BrowserFlowBlockedError(`extract_facts references missing or unverified fact ${specValue.source_fact_ref}.`);
          source = sourceFact.value;
          sourceEvidence = sourceFact.evidence_refs;
        } else if (typeof specValue.source_step_id === "string") {
          const sourceState = stateStep(state, specValue.source_step_id);
          const evidencePath = [...sourceState.evidence_paths].reverse()
            .find((entry) => entry.includes(`/browser-flow/${contract.flow_id}/steps/`));
          if (!evidencePath) throw new BrowserFlowBlockedError(`extract_facts source step ${specValue.source_step_id} has no verified evidence.`);
          const evidence = await this.store.loadStepEvidence(workspace, contract, evidencePath);
          source = evidence.output;
          sourceEvidence = [evidencePath];
        }
        const selected = valueAtPath(source, specValue.path as string | undefined);
        const value = aggregateValue(selected, String(specValue.operation ?? "copy"), specValue.column as string | undefined);
        extracted.push({
          key: String(specValue.key),
          value,
          confidence: specValue.confidence as BrowserFlowFact["confidence"] | undefined,
          public: true
        });
        void sourceEvidence;
      }
      return {
        fullOutput: { extracted_facts: extracted },
        compactOutput: { extracted_count: extracted.length },
        facts: extracted
      };
    }
    if (step.type === "download") {
      const task = await this.loadTask(workspace, contract);
      const snapshotId = typeof input.snapshot_id === "string" ? input.snapshot_id : stringFactValue(facts, input.snapshot_fact_ref, `download ${step.id} snapshot`);
      const fingerprint = input.element_fingerprint as Record<string, unknown>;
      const context = (input.expected_context ?? {}) as Record<string, unknown>;
      const download = await session.download({
        task,
        ref: String(input.ref),
        snapshotId,
        elementFingerprint: {
          ref: String(fingerprint.ref),
          selector: String(fingerprint.selector),
          tagName: String(fingerprint.tag_name),
          role: String(fingerprint.role),
          name: typeof fingerprint.name === "string" ? fingerprint.name : undefined,
          text: typeof fingerprint.text === "string" ? fingerprint.text : undefined,
          hrefAbsent: fingerprint.href_absent === true,
          visible: true,
          clickable: true,
          containerRef: typeof fingerprint.container_ref === "string" ? fingerprint.container_ref : undefined,
          containerRole: typeof fingerprint.container_role === "string" ? fingerprint.container_role : undefined,
          containerTextContains: typeof fingerprint.container_text_contains === "string" ? fingerprint.container_text_contains : undefined
        },
        timeoutMs: input.timeout_ms as number | undefined,
        context: {
          platform: typeof context.platform === "string" ? context.platform : task.platform,
          shop_context: isRecord(context.shop_context) ? context.shop_context as BrowserBusinessTask["shop_context"] : task.shop_context,
          business_object: isRecord(context.business_object) ? context.business_object as BrowserBusinessTask["business_object"] : task.business_object,
          page_fingerprints: input.page_fingerprints as any,
          required_visible_text: Array.isArray(context.required_visible_text) ? context.required_visible_text.filter((value): value is string => typeof value === "string") : undefined
        }
      });
      if (download.status !== "completed") throw new Error(download.error ?? `Browser download ended with status ${download.status}.`);
      return {
        fullOutput: { download },
        compactOutput: { download_id: download.download_id, status: download.status, credential_path: download.credential_path, sha256: download.sha256 },
        evidencePaths: [download.credential_path],
        facts: [
          { key: `${step.id}.download_id`, value: download.download_id, public: true },
          { key: `${step.id}.sha256`, value: download.sha256, public: true }
        ]
      };
    }
    if (step.type === "visual_observe") {
      const semantic = await session.observe({
        scope: input.scope === "selector" ? "selector" : "viewport",
        selector: input.scope === "selector" ? input.selector as string | undefined : undefined,
        maxNodes: 300,
        maxTextChars: 16_000,
        includeTables: true,
        includeForms: true,
        includeLayoutIssues: true,
        includeAccessibility: true
      });
      const screenshot = await session.visualObserve({
        reason: input.reason as "layout" | "image_crop" | "responsive" | "style" | "canvas" | "video" | "cross_origin_frame" | "semantic_empty" | "semantic_conflict" | "manual",
        scope: input.scope as "viewport" | "full_page" | "selector" | undefined,
        selector: input.selector as string | undefined,
        name: input.name as string | undefined,
        linkedSnapshotId: semantic.snapshotId
      });
      return {
        fullOutput: { screenshot },
        compactOutput: { path: screenshot.path, bytes: screenshot.bytes, reason: screenshot.reason, linked_snapshot_id: semantic.snapshotId, may_authorize_interaction: false },
        evidencePaths: [semantic.evidencePath, screenshot.path],
        beforeSnapshotId: semantic.snapshotId,
        facts: [
          { key: `${step.id}.path`, value: screenshot.path, public: true },
          { key: `${step.id}.linked_snapshot_id`, value: semantic.snapshotId, public: true },
          { key: `${step.id}.may_authorize_interaction`, value: false, public: true }
        ]
      };
    }
    if (step.type === "branch") {
      const selected = step.branch_cases?.find((branchCase) => conditionMatches(branchCase.condition, facts));
      if (!selected) throw new BrowserFlowBlockedError(`Browser flow branch ${step.id} has no matching verified case.`);
      return {
        fullOutput: { selected_next_step_id: selected.next_step_id, condition: selected.condition },
        compactOutput: { selected_next_step_id: selected.next_step_id },
        facts: [{ key: `${step.id}.selected_next_step_id`, value: selected.next_step_id }],
        nextStepId: selected.next_step_id
      };
    }
    if (step.type === "handoff") {
      return {
        fullOutput: {
          reason: input.reason,
          instructions: input.instructions ?? [],
          human_required: true,
          contract_hash: contract.contract_hash
        },
        compactOutput: { reason: input.reason, human_required: true },
        terminalStatus: "waiting_human",
        facts: [{ key: `${step.id}.human_required`, value: true, public: true }]
      };
    }
    if (step.type === "report") {
      const report = await session.writeReport();
      return {
        fullOutput: { report, requested_title: input.title },
        compactOutput: { report_path: report.path },
        evidencePaths: [report.path],
        facts: [{ key: `${step.id}.report_path`, value: report.path, public: true }]
      };
    }
    throw new BrowserFlowBlockedError(`Browser flow step type ${step.type} is not executable.`);
  }

  private async blockStep(workspace: Workspace, contract: BrowserFlowContract, stateValue: BrowserFlowState, step: BrowserFlowStep, reason: string): Promise<void> {
    const state = cloneState(stateValue);
    const current = stateStep(state, step.id);
    const blockedAt = now();
    current.attempt_count += 1;
    const evidencePath = await this.store.saveStepEvidence(workspace, contract, step.id, current.attempt_count, {
      version: 1,
      flow_id: contract.flow_id,
      contract_hash: contract.contract_hash,
      step_id: step.id,
      step_type: step.type,
      attempt: current.attempt_count,
      input_hash: current.input_hash,
      started_at: blockedAt,
      finished_at: blockedAt,
      status: "blocked",
      error_class: "BrowserFlowBlockedError",
      error_message: redactSensitiveText(reason)
    });
    current.status = "blocked";
    current.started_at = blockedAt;
    current.finished_at = blockedAt;
    current.error_class = "BrowserFlowBlockedError";
    current.error_message = redactSensitiveText(reason);
    current.evidence_paths = [...new Set([...current.evidence_paths, evidencePath])];
    state.status = "blocked";
    state.current_step_id = step.id;
    state.blocking_reason = redactSensitiveText(reason);
    state.updated_at = blockedAt;
    await this.store.saveState(workspace, contract, state);
    await this.finalize(workspace, contract, state);
  }

  private async failUnexpected(workspace: Workspace, contract: BrowserFlowContract, error: unknown): Promise<void> {
    try {
      let state = await this.store.loadState(workspace, contract.run_id, contract.flow_id);
      if (state.status === "cancelled" || PROCESS_CANCELLED_BROWSER_FLOWS.has(flowExecutionKey(workspace, contract.run_id, contract.flow_id))) return;
      const classified = classifyError(error);
      state = browserFlowStateSchema.parse({
        ...state,
        status: classified.status,
        blocking_reason: classified.message,
        updated_at: now()
      });
      await this.store.saveState(workspace, contract, state);
      await this.finalize(workspace, contract, state);
    } catch {
      // The immutable persisted state remains the recovery source when even failure persistence is unavailable.
    }
  }

  private async finalize(workspace: Workspace, contract: BrowserFlowContract, stateValue: BrowserFlowState): Promise<BrowserFlowResult> {
    const state = assertBrowserFlowStateMatchesContract(stateValue, contract);
    if (!isTerminalStatus(state.status)) throw new Error(`Cannot finalize non-terminal browser flow status ${state.status}.`);
    const facts = [...factsFromState(state).values()]
      .filter((fact) => fact.public)
      .map(({ public: _public, verified: _verified, ...fact }) => fact);
    const completedStepIds = state.steps.filter((step) => step.status === "passed" || step.status === "skipped").map((step) => step.step_id);
    const unresolvedStepIds = state.steps.filter((step) => step.status !== "passed" && step.status !== "skipped").map((step) => step.step_id);
    const evidencePaths = [...new Set(state.steps.flatMap((step) => step.evidence_paths))];
    const reportPath = state.steps.map((step) => step.output?.report_path).find((entry): entry is string => typeof entry === "string");
    const handoffState = state.steps.find((step) => step.status === "waiting_human");
    const task = state.status === "passed" ? await this.loadTask(workspace, contract) : undefined;
    const result = browserFlowResultSchema.parse({
      version: BROWSER_FLOW_RESULT_VERSION,
      flow_id: contract.flow_id,
      contract_hash: contract.contract_hash,
      task_id: contract.task_id,
      run_id: contract.run_id,
      space_id: contract.space_id,
      status: state.status,
      facts,
      completed_step_ids: completedStepIds,
      unresolved_step_ids: unresolvedStepIds,
      ...(state.status === "passed" ? {
        completion_proof: {
          flow_id: contract.flow_id,
          contract_hash: contract.contract_hash,
          task_contract_hash: task!.task_contract_hash,
          run_identity: {
            run_id: task!.run_identity.runId,
            owner_fingerprint: task!.run_identity.ownerId,
            ["fencing_" + "token"]: task!.run_identity.fencingToken
          },
          success_criteria: contract.success_criteria,
          completed_step_input_hashes: state.steps.filter((step) => step.status === "passed").map((step) => ({ step_id: step.step_id, input_hash: step.input_hash }))
        }
      } : {}),
      ...(handoffState ? { human_action_package: handoffState.output ?? { human_required: true } } : {}),
      ...(reportPath ? { report_path: reportPath } : {}),
      evidence_paths: evidencePaths,
      ...(state.blocking_reason ? { limitations: [state.blocking_reason] } : {}),
      completed_at: now()
    });
    await this.store.saveResult(workspace, contract, result);
    return result;
  }
}

export function browserFlowPaths(runId: string, flowId: string): { contractPath: string; statePath: string; resultPath: string } {
  return {
    contractPath: browserFlowContractPath(runId, flowId),
    statePath: browserFlowStatePath(runId, flowId),
    resultPath: browserFlowResultPath(runId, flowId)
  };
}
