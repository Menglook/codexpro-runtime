export type AgentTerminalStatus = "succeeded" | "failed" | "blocked";

export type AgentAcceptanceStatus =
  | "passed"
  | "skipped"
  | "not_required"
  | "not_run"
  | "failed";

export type AgentCompletionClass =
  | "verified"
  | "implemented_not_verified"
  | "analysis_unverified"
  | "invalid";

export interface AgentCompletionProofV1 {
  version: 1;
  proof_id: string;
  parent_goal_id: string | null;
  agent_id: string;
  agent_role: string;
  task_id: string;
  task_contract_hash: string;
  task_contract_version: number;
  run_id: string;
  owner_fingerprint: string | null;
  fencing_token: number | null;
  provider: string;
  model_id: string | null;
  sandbox_mode: string;
  started_at: string;
  terminal_at: string;
  terminal_status: AgentTerminalStatus;
  terminal_event_id: string | null;
  input_hash: string;
  output_hash: string;
  structured_result_hash: string;
  workspace_before_hash: string | null;
  workspace_after_hash: string | null;
  changed_files: string[];
  changed_files_hash: string | null;
  allowed_paths_hash: string | null;
  workspace_boundary_valid: boolean;
  acceptance_status: AgentAcceptanceStatus;
  acceptance_receipt_path: string | null;
  acceptance_receipt_hash: string | null;
  evidence_refs: string[];
  evidence_hash: string;
  uncovered_scope: string[];
  completion_class: AgentCompletionClass;
  written_at: string;
  proof_hash: string;
}

export const AGENT_COMPLETION_PROOF_V1_FIELDS = [
  "version",
  "proof_id",
  "parent_goal_id",
  "agent_id",
  "agent_role",
  "task_id",
  "task_contract_hash",
  "task_contract_version",
  "run_id",
  "owner_fingerprint",
  "fencing_token",
  "provider",
  "model_id",
  "sandbox_mode",
  "started_at",
  "terminal_at",
  "terminal_status",
  "terminal_event_id",
  "input_hash",
  "output_hash",
  "structured_result_hash",
  "workspace_before_hash",
  "workspace_after_hash",
  "changed_files",
  "changed_files_hash",
  "allowed_paths_hash",
  "workspace_boundary_valid",
  "acceptance_status",
  "acceptance_receipt_path",
  "acceptance_receipt_hash",
  "evidence_refs",
  "evidence_hash",
  "uncovered_scope",
  "completion_class",
  "written_at",
  "proof_hash"
] as const satisfies readonly (keyof AgentCompletionProofV1)[];
