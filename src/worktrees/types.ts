import type { AgentCompletionClass } from "../agents/completionProofTypes.js";

export type ManagedWorktreeStatus = "active" | "delivered" | "retained" | "removed" | "missing";

export interface MainWorkspaceUntrackedFileV1 {
  path: string;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
}

export interface MainWorkspaceBaselineV1 {
  version: 1;
  baseline_id: string;
  head: string;
  tracked_changes: string[];
  untracked_files: MainWorkspaceUntrackedFileV1[];
  captured_at: string;
}

export interface MainWorkspaceBaselineComparison {
  unchanged: boolean;
  reasons: string[];
  current: MainWorkspaceBaselineV1;
}

export interface WorktreeWriterLease {
  owner: string;
  pid: number;
  acquired_at: string;
}

export interface ManagedWorktreeRecord {
  version: 1;
  project_id: string;
  project_root: string;
  goal_id: string;
  agent_id: string;
  path: string;
  branch: string;
  base_commit: string;
  created_at: string;
  updated_at: string;
  status: ManagedWorktreeStatus;
  allowed_paths: string[];
  has_uncommitted_changes: boolean;
  changed_files: string[];
  writer_lease: WorktreeWriterLease | null;
  main_workspace_baseline?: MainWorkspaceBaselineV1;
  retained_reason?: string;
  delivered_at?: string;
  removed_at?: string;
}

export interface WorktreeIndex {
  version: 1;
  project_id: string;
  project_root: string;
  updated_at: string;
  worktrees: ManagedWorktreeRecord[];
}

export interface CreateWorktreeInput {
  goal_id: string;
  agent_id: string;
  slug?: string;
  allowed_paths: string[];
  base_ref?: string;
}

export interface WorktreeCleanupResult {
  ok: boolean;
  dry_run: boolean;
  blocked: boolean;
  reason?: string;
  record: ManagedWorktreeRecord;
}

export interface WritableImplementerRequest {
  goal_id: string;
  agent_id: string;
  objective: string;
  constraints?: string[];
  acceptance_commands?: string[];
}

export interface WritableImplementerReport extends Record<string, unknown> {
  ok: boolean;
  mode: "workspace-write";
  goal_id: string;
  agent_id: string;
  run_id: string | null;
  worktree_path: string;
  branch: string;
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  changed_files: string[];
  allowed_paths: string[];
  out_of_scope_files: string[];
  main_workspace_unchanged: boolean;
  task_contract_hash: string;
  completion_class: AgentCompletionClass;
  verified: boolean;
  proof_path: string | null;
  proof_hash: string | null;
  proof_valid: boolean;
  proof_invalid_reasons: string[];
  acceptance_status: "passed" | "skipped" | "not_run" | "failed";
  acceptance_receipt_path: string | null;
  error?: string;
  started_at: string;
  completed_at: string;
}
