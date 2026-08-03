import type { AgentCompletionClass } from "./completionProofTypes.js";
import type { ChangeFootprint, MinimalChangeContract, MinimalSufficiencyReview } from "../workflow/minimalChange.js";

export type ReadOnlyAgentRole = "explorer" | "implementer" | "reviewer";
export type AnalysisAgentRole = Exclude<ReadOnlyAgentRole, "reviewer">;
export type ReviewSeverity = "P0" | "P1" | "P2" | "P3";
export type ReviewMode = "advisory" | "gated" | "independent";

export interface ReadOnlyAgentTask {
  task_id: string;
  parent_goal_id?: string | null;
  role: AnalysisAgentRole;
  objective: string;
  scope?: string[];
  context?: string[];
}

export interface AgentObservation {
  category: string;
  title: string;
  file?: string;
  line?: number;
  evidence: string;
  impact?: string;
  recommendation?: string;
  confidence: number;
}

export interface ReadOnlyAgentResult {
  task_id: string;
  role: AnalysisAgentRole;
  run_id: string | null;
  status: "succeeded" | "failed";
  summary: string;
  observations: AgentObservation[];
  task_contract_hash?: string;
  completion_class?: AgentCompletionClass;
  verified?: boolean;
  proof_path?: string | null;
  proof_hash?: string | null;
  proof_valid?: boolean;
  proof_invalid_reasons?: string[];
  error?: string;
  started_at: string;
  completed_at: string;
}

export interface AggregatedObservation extends AgentObservation {
  source_task_ids: string[];
  duplicate_count: number;
}

export interface SubagentBatchReport extends Record<string, unknown> {
  ok: boolean;
  mode: "read-only";
  requested_tasks: number;
  max_parallel: number;
  peak_parallel: number;
  results: ReadOnlyAgentResult[];
  observations: AggregatedObservation[];
  failed_task_ids: string[];
  invalid_proof_task_ids?: string[];
  proofs_valid?: boolean;
  workspace_unchanged: boolean;
  completed_at: string;
}

export type ReviewTarget =
  | { type: "working_tree" }
  | { type: "commit"; commit: string }
  | { type: "range"; base: string; head?: string };

export interface ReviewPolicyInput {
  mode: ReviewMode;
  p0_confidence_threshold: number | null;
  p1_confidence_threshold: number | null;
  require_critical_scope_covered: boolean;
  independent_provider?: string;
}

export interface ReviewRequest {
  task_id?: string;
  parent_goal_id?: string | null;
  target: ReviewTarget;
  related_files?: string[];
  acceptance_result?: Record<string, unknown> | null;
  extra_context?: string[];
  minimal_change_contract?: MinimalChangeContract;
  change_footprint?: ChangeFootprint;
  review_policy?: ReviewPolicyInput;
}

export interface ReviewFinding {
  severity: ReviewSeverity;
  file: string;
  line?: number;
  issue: string;
  impact: string;
  evidence: string;
  recommendation: string;
  confidence: number;
}

export interface AdvisoryReviewReport extends Record<string, unknown> {
  ok: boolean;
  mode: ReviewMode;
  summary: string;
  target: ReviewTarget;
  findings: ReviewFinding[];
  reviewed_files: string[];
  uncovered_scope: string[];
  workspace_unchanged: boolean;
  reviewer_run_id: string | null;
  task_contract_hash?: string;
  completion_class?: AgentCompletionClass;
  verified?: boolean;
  proof_path?: string | null;
  proof_hash?: string | null;
  proof_valid?: boolean;
  proof_invalid_reasons?: string[];
  gate_passed: boolean;
  blocking_findings: ReviewFinding[];
  critical_uncovered_scope: string[];
  review_policy: {
    mode: ReviewMode;
    p0_confidence_threshold: number | null;
    p1_confidence_threshold: number | null;
    require_critical_scope_covered: boolean;
    independent_provider?: string;
    isolated_context: boolean;
    provider: string;
    model_id?: string;
    model_name?: string;
  };
  minimal_sufficiency_review?: MinimalSufficiencyReview;
  change_footprint?: ChangeFootprint;
  error?: string;
  completed_at: string;
}
