import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import {
  assertBrowserFlowStateMatchesContract,
  browserFlowResultSchema,
  browserFlowStateSchema,
  validateBrowserFlowContract,
  type BrowserFlowContract,
  type BrowserFlowResult,
  type BrowserFlowState
} from "./browser-flow-contract.js";

export const BROWSER_FLOW_RUN_ROOT = ".codexpro/runs";

function identifierSegment(value: string, label: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && value !== "." && value !== "..") return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${label}-${digest}`;
}

export function browserFlowRoot(runId: string, flowId: string): string {
  return `${BROWSER_FLOW_RUN_ROOT}/${identifierSegment(runId, "run")}/browser-flow/${identifierSegment(flowId, "flow")}`;
}

export function browserFlowContractPath(runId: string, flowId: string): string {
  return `${browserFlowRoot(runId, flowId)}/contract.json`;
}

export function browserFlowStatePath(runId: string, flowId: string): string {
  return `${browserFlowRoot(runId, flowId)}/state.json`;
}

export function browserFlowResultPath(runId: string, flowId: string): string {
  return `${browserFlowRoot(runId, flowId)}/result.json`;
}

function stepFileSegment(stepId: string): string {
  return identifierSegment(stepId, "step");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export class BrowserFlowStore {
  constructor(private readonly guard: PathGuard) {}

  private async writeJsonAtomic(workspace: Workspace, relPath: string, value: unknown): Promise<void> {
    const resolved = this.guard.resolve(workspace, relPath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    const temporary = `${resolved.absPath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, resolved.absPath);
  }

  private async readJson(workspace: Workspace, relPath: string): Promise<unknown> {
    const resolved = this.guard.resolve(workspace, relPath);
    return JSON.parse(await fsp.readFile(resolved.absPath, "utf8"));
  }

  async persistPrepared(workspace: Workspace, contractValue: unknown, stateValue: unknown): Promise<{
    contract: BrowserFlowContract;
    state: BrowserFlowState;
    contractPath: string;
    statePath: string;
  }> {
    const contract = validateBrowserFlowContract(contractValue);
    const state = assertBrowserFlowStateMatchesContract(stateValue, contract);
    const contractPath = browserFlowContractPath(contract.run_id, contract.flow_id);
    const statePath = browserFlowStatePath(contract.run_id, contract.flow_id);
    try {
      const existing = validateBrowserFlowContract(await this.readJson(workspace, contractPath));
      if (existing.contract_hash !== contract.contract_hash) {
        throw new Error(`Browser flow ${contract.flow_id} already exists with a different immutable contract.`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeJsonAtomic(workspace, contractPath, contract);
    }
    try {
      await this.readJson(workspace, statePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeJsonAtomic(workspace, statePath, state);
    }
    return { contract, state, contractPath, statePath };
  }

  async loadContract(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowContract> {
    const contract = validateBrowserFlowContract(await this.readJson(workspace, browserFlowContractPath(runId, flowId)));
    if (contract.run_id !== runId || contract.flow_id !== flowId) {
      throw new Error("Persisted browser flow contract reference does not match run_id/flow_id.");
    }
    return contract;
  }

  async loadState(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowState> {
    const contract = await this.loadContract(workspace, runId, flowId);
    return assertBrowserFlowStateMatchesContract(await this.readJson(workspace, browserFlowStatePath(runId, flowId)), contract);
  }

  async saveState(workspace: Workspace, contractValue: unknown, stateValue: unknown): Promise<string> {
    const contract = validateBrowserFlowContract(contractValue);
    const state = assertBrowserFlowStateMatchesContract(stateValue, contract);
    const relPath = browserFlowStatePath(contract.run_id, contract.flow_id);
    await this.writeJsonAtomic(workspace, relPath, browserFlowStateSchema.parse(state));
    return relPath;
  }

  async saveStepEvidence(
    workspace: Workspace,
    contractValue: unknown,
    stepId: string,
    attempt: number,
    evidence: Record<string, unknown>
  ): Promise<string> {
    const contract = validateBrowserFlowContract(contractValue);
    if (!contract.steps.some((step) => step.id === stepId)) throw new Error(`Unknown browser flow step ${stepId}.`);
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Browser flow step evidence attempt must be positive.");
    const index = contract.steps.findIndex((step) => step.id === stepId) + 1;
    const relPath = `${browserFlowRoot(contract.run_id, contract.flow_id)}/steps/${String(index).padStart(4, "0")}-${stepFileSegment(stepId)}-attempt-${String(attempt).padStart(4, "0")}.json`;
    await this.writeJsonAtomic(workspace, relPath, evidence);
    return relPath;
  }

  async loadStepEvidence(workspace: Workspace, contractValue: unknown, relPath: string): Promise<Record<string, unknown>> {
    const contract = validateBrowserFlowContract(contractValue);
    const prefix = `${browserFlowRoot(contract.run_id, contract.flow_id)}/steps/`;
    if (!relPath.startsWith(prefix) || relPath.includes("..")) throw new Error("Browser flow step evidence path is outside the current flow.");
    const parsed = await this.readJson(workspace, relPath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid browser flow evidence at ${relPath}.`);
    return parsed as Record<string, unknown>;
  }

  async saveResult(workspace: Workspace, contractValue: unknown, resultValue: unknown): Promise<string> {
    const contract = validateBrowserFlowContract(contractValue);
    const result = browserFlowResultSchema.parse(resultValue);
    if (result.flow_id !== contract.flow_id || result.contract_hash !== contract.contract_hash || result.run_id !== contract.run_id || result.task_id !== contract.task_id) {
      throw new Error("Browser flow result does not match its immutable contract.");
    }
    const relPath = browserFlowResultPath(contract.run_id, contract.flow_id);
    await this.writeJsonAtomic(workspace, relPath, result);
    return relPath;
  }

  async loadResult(workspace: Workspace, runId: string, flowId: string): Promise<BrowserFlowResult> {
    const contract = await this.loadContract(workspace, runId, flowId);
    const result = browserFlowResultSchema.parse(await this.readJson(workspace, browserFlowResultPath(runId, flowId)));
    if (result.flow_id !== contract.flow_id || result.contract_hash !== contract.contract_hash || result.run_id !== runId) {
      throw new Error("Persisted browser flow result does not match its immutable contract.");
    }
    return result;
  }
}
