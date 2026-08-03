import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { PathGuard, type Workspace } from "../guard.js";
import { validateLatestAcceptanceReceipt } from "../workflow/acceptanceReceipt.js";
import {
  AGENT_COMPLETION_PROOF_V1_FIELDS,
  type AgentAcceptanceStatus,
  type AgentCompletionClass,
  type AgentCompletionProofV1,
  type AgentTerminalStatus
} from "./completionProofTypes.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function hashAgentValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export async function hashAgentFile(absPath: string): Promise<string | null> {
  try {
    const content = await fsp.readFile(absPath);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    return null;
  }
}

export function agentTaskContractHash(contract: unknown): string {
  return hashAgentValue({ version: 1, contract });
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return normalized || "unknown";
}

function proofRelPath(config: CodexProConfig, taskId: string, runId: string): string {
  return `${config.contextDir.replace(/\/+$/, "")}/agent-proofs/${safeSegment(taskId)}/${safeSegment(runId)}.json`;
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

function completionClassFor(input: {
  terminal_status: AgentTerminalStatus;
  sandbox_mode: string;
  workspace_boundary_valid: boolean;
  workspace_before_hash: string | null;
  workspace_after_hash: string | null;
  acceptance_status: AgentAcceptanceStatus;
  acceptance_receipt_path: string | null;
  acceptance_receipt_hash: string | null;
}): AgentCompletionClass {
  if (input.terminal_status !== "succeeded" || !input.workspace_boundary_valid) return "invalid";
  if (input.sandbox_mode === "read-only") {
    return input.workspace_before_hash !== null && input.workspace_before_hash === input.workspace_after_hash
      ? "verified"
      : "analysis_unverified";
  }
  if (input.sandbox_mode === "workspace-write") {
    return (input.acceptance_status === "passed" || input.acceptance_status === "skipped")
      && Boolean(input.acceptance_receipt_path)
      && Boolean(input.acceptance_receipt_hash)
      ? "verified"
      : "implemented_not_verified";
  }
  return "invalid";
}

export interface CreateAgentCompletionProofInput {
  parent_goal_id?: string | null;
  agent_id: string;
  agent_role: string;
  task_id: string;
  task_contract_hash: string;
  task_contract_version?: number;
  run_id: string;
  owner_fingerprint?: string | null;
  fencing_token?: number | null;
  provider: string;
  model_id?: string | null;
  sandbox_mode: string;
  started_at: string;
  terminal_at: string;
  terminal_status: AgentTerminalStatus;
  terminal_event_id?: string | null;
  input: unknown;
  output: unknown;
  structured_result: unknown;
  workspace_before_hash?: string | null;
  workspace_after_hash?: string | null;
  changed_files?: string[];
  allowed_paths?: string[];
  workspace_boundary_valid: boolean;
  acceptance_status: AgentAcceptanceStatus;
  acceptance_receipt_path?: string | null;
  acceptance_receipt_hash?: string | null;
  evidence_refs?: string[];
  uncovered_scope?: string[];
}

export interface CreatedAgentCompletionProof {
  proof: AgentCompletionProofV1;
  path: string;
}

export async function createAgentCompletionProof(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: CreateAgentCompletionProofInput
): Promise<CreatedAgentCompletionProof> {
  const changedFiles = uniqueSorted(input.changed_files);
  const allowedPaths = uniqueSorted(input.allowed_paths);
  const evidenceRefs = uniqueSorted(input.evidence_refs);
  const uncoveredScope = uniqueSorted(input.uncovered_scope);
  const base = {
    version: 1 as const,
    proof_id: `proof-${randomUUID()}`,
    parent_goal_id: input.parent_goal_id ?? null,
    agent_id: input.agent_id,
    agent_role: input.agent_role,
    task_id: input.task_id,
    task_contract_hash: input.task_contract_hash,
    task_contract_version: input.task_contract_version ?? 1,
    run_id: input.run_id,
    owner_fingerprint: input.owner_fingerprint ?? null,
    fencing_token: input.fencing_token ?? null,
    provider: input.provider,
    model_id: input.model_id ?? null,
    sandbox_mode: input.sandbox_mode,
    started_at: input.started_at,
    terminal_at: input.terminal_at,
    terminal_status: input.terminal_status,
    terminal_event_id: input.terminal_event_id ?? null,
    input_hash: hashAgentValue(input.input),
    output_hash: hashAgentValue(input.output),
    structured_result_hash: hashAgentValue(input.structured_result),
    workspace_before_hash: input.workspace_before_hash ?? null,
    workspace_after_hash: input.workspace_after_hash ?? null,
    changed_files: changedFiles,
    changed_files_hash: hashAgentValue(changedFiles),
    allowed_paths_hash: allowedPaths.length ? hashAgentValue(allowedPaths) : null,
    workspace_boundary_valid: input.workspace_boundary_valid,
    acceptance_status: input.acceptance_status,
    acceptance_receipt_path: input.acceptance_receipt_path ?? null,
    acceptance_receipt_hash: input.acceptance_receipt_hash ?? null,
    evidence_refs: evidenceRefs,
    evidence_hash: hashAgentValue(evidenceRefs),
    uncovered_scope: uncoveredScope,
    completion_class: completionClassFor({
      terminal_status: input.terminal_status,
      sandbox_mode: input.sandbox_mode,
      workspace_boundary_valid: input.workspace_boundary_valid,
      workspace_before_hash: input.workspace_before_hash ?? null,
      workspace_after_hash: input.workspace_after_hash ?? null,
      acceptance_status: input.acceptance_status,
      acceptance_receipt_path: input.acceptance_receipt_path ?? null,
      acceptance_receipt_hash: input.acceptance_receipt_hash ?? null
    }),
    written_at: new Date().toISOString()
  };
  const proof: AgentCompletionProofV1 = { ...base, proof_hash: hashAgentValue(base) };
  const relPath = proofRelPath(config, input.task_id, input.run_id);
  const resolved = guard.resolve(workspace, relPath);
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  const temporary = `${resolved.absPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, resolved.absPath);
  return { proof, path: resolved.relPath };
}

function isAgentCompletionProof(value: unknown): value is AgentCompletionProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (Object.keys(proof).sort().join("\0") !== [...AGENT_COMPLETION_PROOF_V1_FIELDS].sort().join("\0")) return false;
  return proof.version === 1
    && typeof proof.proof_id === "string"
    && typeof proof.agent_id === "string"
    && typeof proof.agent_role === "string"
    && typeof proof.task_id === "string"
    && typeof proof.task_contract_hash === "string"
    && typeof proof.task_contract_version === "number"
    && typeof proof.run_id === "string"
    && typeof proof.provider === "string"
    && typeof proof.sandbox_mode === "string"
    && typeof proof.started_at === "string"
    && typeof proof.terminal_at === "string"
    && ["succeeded", "failed", "blocked"].includes(String(proof.terminal_status))
    && typeof proof.input_hash === "string"
    && typeof proof.output_hash === "string"
    && typeof proof.structured_result_hash === "string"
    && Array.isArray(proof.changed_files)
    && proof.changed_files.every((item) => typeof item === "string")
    && typeof proof.workspace_boundary_valid === "boolean"
    && Array.isArray(proof.evidence_refs)
    && proof.evidence_refs.every((item) => typeof item === "string")
    && Array.isArray(proof.uncovered_scope)
    && proof.uncovered_scope.every((item) => typeof item === "string")
    && typeof proof.evidence_hash === "string"
    && typeof proof.written_at === "string"
    && typeof proof.proof_hash === "string";
}

export interface AgentCompletionProofExpectations {
  parent_goal_id?: string | null;
  agent_id?: string;
  agent_role?: string;
  task_id?: string;
  task_contract_hash?: string;
  run_id?: string;
  provider?: string;
  sandbox_mode?: string;
  input?: unknown;
  output?: unknown;
  structured_result?: unknown;
  workspace_before_hash?: string | null;
  workspace_after_hash?: string | null;
  changed_files?: string[];
  allowed_paths?: string[];
  evidence_refs?: string[];
  require_verified?: boolean;
}

export interface AgentCompletionProofValidationResult {
  valid: boolean;
  verified: boolean;
  path: string;
  reasons: string[];
  proof?: AgentCompletionProofV1;
}

export async function validateAgentCompletionProof(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  proofPath: string,
  expected: AgentCompletionProofExpectations = {}
): Promise<AgentCompletionProofValidationResult> {
  const reasons: string[] = [];
  let proof: AgentCompletionProofV1 | undefined;
  try {
    const resolved = guard.resolve(workspace, proofPath);
    const parsed: unknown = JSON.parse(await fsp.readFile(resolved.absPath, "utf8"));
    if (!isAgentCompletionProof(parsed)) reasons.push("proof_shape_invalid");
    else proof = parsed;
  } catch {
    reasons.push("proof_missing_or_unreadable");
  }
  if (!proof) return { valid: false, verified: false, path: proofPath, reasons };

  const { proof_hash: _proofHash, ...unsigned } = proof;
  if (hashAgentValue(unsigned) !== proof.proof_hash) reasons.push("proof_hash_mismatch");
  if (hashAgentValue(proof.changed_files) !== proof.changed_files_hash) reasons.push("changed_files_hash_mismatch");
  if (hashAgentValue(proof.evidence_refs) !== proof.evidence_hash) reasons.push("evidence_hash_mismatch");
  if (expected.parent_goal_id !== undefined && proof.parent_goal_id !== expected.parent_goal_id) reasons.push("parent_goal_id_mismatch");
  if (expected.agent_id !== undefined && proof.agent_id !== expected.agent_id) reasons.push("agent_id_mismatch");
  if (expected.agent_role !== undefined && proof.agent_role !== expected.agent_role) reasons.push("agent_role_mismatch");
  if (expected.task_id !== undefined && proof.task_id !== expected.task_id) reasons.push("task_id_mismatch");
  if (expected.task_contract_hash !== undefined && proof.task_contract_hash !== expected.task_contract_hash) reasons.push("task_contract_hash_mismatch");
  if (expected.run_id !== undefined && proof.run_id !== expected.run_id) reasons.push("run_id_mismatch");
  if (expected.provider !== undefined && proof.provider !== expected.provider) reasons.push("provider_mismatch");
  if (expected.sandbox_mode !== undefined && proof.sandbox_mode !== expected.sandbox_mode) reasons.push("sandbox_mode_mismatch");
  if (expected.input !== undefined && proof.input_hash !== hashAgentValue(expected.input)) reasons.push("input_hash_mismatch");
  if (expected.output !== undefined && proof.output_hash !== hashAgentValue(expected.output)) reasons.push("output_hash_mismatch");
  if (expected.structured_result !== undefined && proof.structured_result_hash !== hashAgentValue(expected.structured_result)) reasons.push("structured_result_hash_mismatch");
  if (expected.workspace_before_hash !== undefined && proof.workspace_before_hash !== expected.workspace_before_hash) reasons.push("workspace_before_hash_mismatch");
  if (expected.workspace_after_hash !== undefined && proof.workspace_after_hash !== expected.workspace_after_hash) reasons.push("workspace_after_hash_mismatch");
  if (expected.changed_files !== undefined && proof.changed_files_hash !== hashAgentValue(uniqueSorted(expected.changed_files))) reasons.push("expected_changed_files_mismatch");
  if (expected.allowed_paths !== undefined && proof.allowed_paths_hash !== (expected.allowed_paths.length ? hashAgentValue(uniqueSorted(expected.allowed_paths)) : null)) reasons.push("allowed_paths_hash_mismatch");
  if (expected.evidence_refs !== undefined && proof.evidence_hash !== hashAgentValue(uniqueSorted(expected.evidence_refs))) reasons.push("expected_evidence_mismatch");

  if (proof.acceptance_status === "passed" || proof.acceptance_status === "skipped") {
    if (!proof.acceptance_receipt_path || !proof.acceptance_receipt_hash) {
      reasons.push("acceptance_receipt_binding_missing");
    } else {
      const receiptPath = path.isAbsolute(proof.acceptance_receipt_path)
        ? proof.acceptance_receipt_path
        : guard.resolve(workspace, proof.acceptance_receipt_path).absPath;
      const currentReceiptHash = await hashAgentFile(receiptPath);
      if (currentReceiptHash !== proof.acceptance_receipt_hash) reasons.push("acceptance_receipt_hash_mismatch");
      try {
        const parsed = JSON.parse(await fsp.readFile(receiptPath, "utf8")) as { project_root?: unknown };
        if (typeof parsed.project_root !== "string" || !parsed.project_root.trim()) {
          reasons.push("acceptance_receipt_project_root_missing");
        } else {
          const receiptRoot = path.resolve(parsed.project_root);
          const receiptConfig: CodexProConfig = {
            ...config,
            defaultRoot: receiptRoot,
            allowedRoots: [receiptRoot],
            codexWorktreesEnabled: false,
            codexWritableImplementersEnabled: false
          };
          const receiptWorkspace: Workspace = {
            id: `${workspace.id}-receipt-validation`,
            root: receiptRoot,
            openedAt: new Date().toISOString()
          };
          const receiptGuard = new PathGuard(receiptConfig);
          const receiptValidation = await validateLatestAcceptanceReceipt(receiptConfig, receiptGuard, receiptWorkspace);
          if (!receiptValidation.valid) {
            reasons.push(...receiptValidation.reasons.map((reason) => `acceptance_receipt_${reason}`));
          }
          const expectedReceiptPath = receiptGuard.resolve(receiptWorkspace, receiptValidation.path).absPath;
          if (path.resolve(expectedReceiptPath) !== path.resolve(receiptPath)) reasons.push("acceptance_receipt_path_mismatch");
        }
      } catch {
        reasons.push("acceptance_receipt_invalid");
      }
    }
  }
  const computedClass = completionClassFor(proof);
  if (computedClass !== proof.completion_class) reasons.push("completion_class_mismatch");
  if (proof.sandbox_mode === "read-only" && proof.workspace_before_hash !== proof.workspace_after_hash) reasons.push("read_only_workspace_changed");
  if (proof.completion_class === "verified" && proof.terminal_status !== "succeeded") reasons.push("verified_terminal_status_invalid");
  if (expected.require_verified && proof.completion_class !== "verified") reasons.push("verified_completion_required");

  return {
    valid: reasons.length === 0,
    verified: reasons.length === 0 && proof.completion_class === "verified",
    path: proofPath,
    reasons,
    proof
  };
}

export async function invalidateAgentCompletionProof(
  guard: PathGuard,
  workspace: Workspace,
  proofPath: string
): Promise<void> {
  const resolved = guard.resolve(workspace, proofPath);
  await fsp.unlink(resolved.absPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
