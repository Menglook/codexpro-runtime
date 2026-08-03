import { createHash } from "node:crypto";
import {
  agentTaskContractHash,
  createAgentCompletionProof,
  hashAgentValue,
  validateAgentCompletionProof
} from "./completionProof.js";
import { readFileSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import type { CodexAdapter, CodexProviderId, CodexRun } from "../codex/types.js";
import { gitDiff, gitStatus, gitUntrackedFiles } from "../gitOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { createModelRegistry, selectReadOnlyRoleModel, type ModelRegistry, type ModelRole, type ModelSelectionRecord } from "../models/modelRegistry.js";
import { buildRuleSummary } from "../project/ruleSummary.js";
import { redactSensitiveText } from "../redact.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import type {
  AdvisoryReviewReport,
  AgentObservation,
  AggregatedObservation,
  ReadOnlyAgentResult,
  ReadOnlyAgentTask,
  ReviewFinding,
  ReviewRequest,
  ReviewTarget,
  SubagentBatchReport
} from "./types.js";

interface AdapterResponse {
  run: CodexRun;
  text: string;
  model_selection: ModelSelectionRecord;
}

const READ_ONLY_AGENT_TIMEOUT_MS = 120_000;

function providerId(value: unknown): CodexProviderId | undefined {
  return value === "sdk" || value === "exec" || value === "mock" ? value : undefined;
}

function boundedText(value: unknown, max = 80_000): string {
  return redactSensitiveText(typeof value === "string" ? value : String(value ?? "")).slice(0, max);
}

function strictConfidence(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) return undefined;
  return number;
}

function positiveLine(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function cleanList(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => boundedText(item, 2_000).trim()).filter(Boolean))].slice(0, maxItems);
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) {
    throw new Error("Agent response did not contain one JSON object.");
  }
  const parsed = JSON.parse(candidate) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent response JSON must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseObservation(value: unknown): AgentObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const category = boundedText(item.category, 120).trim();
  const title = boundedText(item.title, 500).trim();
  const evidence = boundedText(item.evidence, 4_000).trim();
  if (!category || !title || !evidence) return null;
  const file = boundedText(item.file, 1_000).trim();
  const impact = boundedText(item.impact, 2_000).trim();
  const recommendation = boundedText(item.recommendation, 2_000).trim();
  const confidence = strictConfidence(item.confidence);
  if (confidence === undefined) return null;
  const line = positiveLine(item.line);
  return {
    category,
    title,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    evidence,
    ...(impact ? { impact } : {}),
    ...(recommendation ? { recommendation } : {}),
    confidence
  };
}

function parseAnalysisResponse(text: string): { summary: string; observations: AgentObservation[] } {
  const parsed = extractJsonObject(text);
  const summary = boundedText(parsed.summary, 8_000).trim();
  if (!summary) throw new Error("Agent response is missing summary.");
  if (!Array.isArray(parsed.observations)) throw new Error("Agent response is missing observations array.");
  const parsedObservations = parsed.observations.map(parseObservation);
  if (parsedObservations.some((item) => item === null)) {
    throw new Error("Agent response contains an invalid observation.");
  }
  const observations = parsedObservations.slice(0, 100) as AgentObservation[];
  return { summary, observations };
}

function parseFinding(value: unknown): ReviewFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const severity = boundedText(item.severity, 10).trim().toUpperCase();
  if (!(["P0", "P1", "P2", "P3"] as string[]).includes(severity)) return null;
  const file = boundedText(item.file, 1_000).trim();
  const issue = boundedText(item.issue, 2_000).trim();
  const impact = boundedText(item.impact, 2_000).trim();
  const evidence = boundedText(item.evidence, 4_000).trim();
  const recommendation = boundedText(item.recommendation, 2_000).trim();
  const confidence = strictConfidence(item.confidence);
  if (!file || !issue || !impact || !evidence || !recommendation || confidence === undefined) return null;
  const line = positiveLine(item.line);
  return {
    severity: severity as ReviewFinding["severity"],
    file,
    ...(line ? { line } : {}),
    issue,
    impact,
    evidence,
    recommendation,
    confidence
  };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N}._/ -]/gu, "").trim();
}

function aggregateObservations(results: ReadOnlyAgentResult[]): AggregatedObservation[] {
  const aggregated = new Map<string, AggregatedObservation>();
  for (const result of results) {
    for (const observation of result.observations) {
      const key = [
        normalizeKey(observation.category),
        normalizeKey(observation.file ?? ""),
        observation.line ?? "",
        normalizeKey(observation.title)
      ].join("|");
      const existing = aggregated.get(key);
      if (existing) {
        existing.duplicate_count += 1;
        if (!existing.source_task_ids.includes(result.task_id)) existing.source_task_ids.push(result.task_id);
        existing.confidence = Math.max(existing.confidence, observation.confidence);
        continue;
      }
      aggregated.set(key, {
        ...observation,
        source_task_ids: [result.task_id],
        duplicate_count: 1
      });
    }
  }
  return [...aggregated.values()].sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title));
}

function taskId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(trimmed)) {
    throw new Error(`Invalid subagent task_id: ${value}`);
  }
  return trimmed;
}

function safeRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed) || trimmed.startsWith("-")) {
    throw new Error(`Invalid git revision: ${value}`);
  }
  return trimmed;
}

function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    const file = match[2];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

function targetLabel(target: ReviewTarget): string {
  if (target.type === "working_tree") return "working tree against HEAD";
  if (target.type === "commit") return `commit ${target.commit}`;
  return `${target.base}...${target.head ?? "HEAD"}`;
}

export class ReadOnlyAgentCoordinator {
  private readonly modelRegistry: ModelRegistry;

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace,
    private readonly adapter: CodexAdapter
  ) {
    this.modelRegistry = createModelRegistry(config);
  }

  async runAnalysis(tasks: ReadOnlyAgentTask[]): Promise<SubagentBatchReport> {
    if (!this.config.codexSubagentsEnabled) {
      throw new Error("Read-only subagents are disabled. Enable CODEXPRO_CODEX_SUBAGENTS first.");
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("At least one Explorer or Implementer task is required.");
    }
    if (tasks.length > 20) throw new Error("A read-only subagent batch is limited to 20 tasks.");

    const normalized = tasks.map((task) => ({
      ...task,
      task_id: taskId(task.task_id),
      objective: task.objective.trim(),
      scope: cleanList(task.scope, 50),
      context: cleanList(task.context, 50)
    }));
    if (new Set(normalized.map((task) => task.task_id)).size !== normalized.length) {
      throw new Error("Subagent task_id values must be unique within one batch.");
    }
    for (const task of normalized) {
      if (!task.objective) throw new Error(`Subagent ${task.task_id} objective cannot be empty.`);
      if (task.role !== "explorer" && task.role !== "implementer") {
        throw new Error(`Subagent ${task.task_id} must use explorer or implementer role.`);
      }
    }

    const before = this.workspaceFingerprint();
    const maxParallel = Math.max(1, Math.min(2, this.config.codexSubagentsMaxParallel, normalized.length));
    const results = new Array<ReadOnlyAgentResult>(normalized.length);
    let cursor = 0;
    let active = 0;
    let peak = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= normalized.length) return;
        active += 1;
        peak = Math.max(peak, active);
        try {
          results[index] = await this.runAnalysisTask(normalized[index]);
        } finally {
          active -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: maxParallel }, () => worker()));
    const workspaceUnchanged = before === this.workspaceFingerprint();
    const failedTaskIds = results.filter((result) => result.status === "failed").map((result) => result.task_id);
    const invalidProofTaskIds = results.filter((result) => !result.proof_valid || !result.verified).map((result) => result.task_id);
    return {
      ok: failedTaskIds.length === 0 && invalidProofTaskIds.length === 0 && workspaceUnchanged,
      mode: "read-only",
      requested_tasks: normalized.length,
      max_parallel: maxParallel,
      peak_parallel: peak,
      results,
      observations: aggregateObservations(results),
      failed_task_ids: failedTaskIds,
      invalid_proof_task_ids: invalidProofTaskIds,
      proofs_valid: invalidProofTaskIds.length === 0,
      workspace_unchanged: workspaceUnchanged,
      completed_at: new Date().toISOString()
    };
  }

  async runReview(request: ReviewRequest): Promise<AdvisoryReviewReport> {
    if (!this.config.codexReviewEnabled) {
      throw new Error("Review is disabled. Enable CODEXPRO_CODEX_REVIEW first.");
    }
    const before = this.workspaceFingerprint();
    const policy = request.review_policy ?? {
      mode: this.config.codexReviewMode,
      p0_confidence_threshold: this.config.codexReviewP0Threshold,
      p1_confidence_threshold: this.config.codexReviewP1Threshold,
      require_critical_scope_covered: this.config.codexReviewRequireCriticalScopeCovered
    };
    const reviewContract = {
      version: 1,
      parent_goal_id: request.parent_goal_id ?? null,
      task_id: request.task_id ?? null,
      target: request.target,
      related_files: cleanList(request.related_files, 50),
      acceptance_result: request.acceptance_result ?? null,
      extra_context: cleanList(request.extra_context, 50),
      minimal_change_contract: request.minimal_change_contract ?? null,
      change_footprint: request.change_footprint ?? null,
      review_policy: policy
    };
    const taskContractHash = agentTaskContractHash(reviewContract);
    const reviewTaskId = request.task_id?.trim() || `review-${taskContractHash.replace(/^sha256:/, "").slice(0, 24)}`;
    let reviewerRunId: string | null = null;
    try {
      const diff = this.reviewDiff(request.target);
      const diffFiles = changedFilesFromDiff(diff);
      const requestedFiles = cleanList(request.related_files, 50);
      const reviewedFiles = [...new Set([...diffFiles, ...requestedFiles])].slice(0, 50);
      const sourceContext = await this.readFiles(reviewedFiles);
      const rules = await buildRuleSummary(this.config, this.guard, this.workspace, { maxRules: 100 });
      const prompt = this.reviewPrompt(request, diff, sourceContext, rules.preflight_rules);
      const requestedProvider = providerId(policy.independent_provider);
      const independentFrom = policy.mode === "independent" ? this.adapter.provider : undefined;
      const response = await this.runAdapter(prompt, "reviewer", requestedProvider ?? this.adapter.provider, independentFrom);
      reviewerRunId = response.run.run_id;
      const parsed = extractJsonObject(response.text);
      const summary = boundedText(parsed.summary, 8_000).trim();
      if (!summary) throw new Error("Reviewer response is missing summary.");
      if (!Array.isArray(parsed.findings)) throw new Error("Reviewer response is missing findings array.");
      const parsedFindings = parsed.findings.map(parseFinding);
      if (parsedFindings.some((item) => item === null)) {
        throw new Error("Reviewer response contains an invalid finding.");
      }
      const findings = parsedFindings.slice(0, 100) as ReviewFinding[];
      const modelReviewedFiles = cleanList(parsed.reviewed_files, 100);
      const uncoveredScope = cleanList(parsed.uncovered_scope, 100);
      if (uncoveredScope.length === 0) {
        uncoveredScope.push("Reviewer did not declare dynamic, integration, or environment coverage beyond the supplied diff, files, rules, and acceptance result.");
      }
      const criticalUncoveredScope = uncoveredScope.filter((item) => /^critical\s*:/i.test(item));
      const blockingFindings = findings.filter((finding) =>
        (finding.severity === "P0" && policy.p0_confidence_threshold !== null && finding.confidence >= policy.p0_confidence_threshold)
        || (finding.severity === "P1" && policy.p1_confidence_threshold !== null && finding.confidence >= policy.p1_confidence_threshold)
      );
      const gatePassed = policy.mode === "advisory"
        || (blockingFindings.length === 0
          && (!policy.require_critical_scope_covered || criticalUncoveredScope.length === 0));
      const workspaceAfter = this.workspaceFingerprint();
      const workspaceUnchanged = before === workspaceAfter;
      const completedAt = new Date().toISOString();
      const output = {
        ok: workspaceUnchanged,
        mode: policy.mode,
        summary,
        target: request.target,
        findings,
        reviewed_files: modelReviewedFiles.length ? modelReviewedFiles : reviewedFiles,
        uncovered_scope: uncoveredScope,
        workspace_unchanged: workspaceUnchanged,
        reviewer_run_id: reviewerRunId,
        gate_passed: gatePassed,
        blocking_findings: blockingFindings,
        critical_uncovered_scope: criticalUncoveredScope,
        review_policy: {
          mode: policy.mode,
          p0_confidence_threshold: policy.p0_confidence_threshold,
          p1_confidence_threshold: policy.p1_confidence_threshold,
          require_critical_scope_covered: policy.require_critical_scope_covered,
          ...(policy.independent_provider ? { independent_provider: policy.independent_provider } : {}),
          isolated_context: true,
          provider: response.run.provider,
          model_id: response.model_selection.selected_model?.id,
          model_name: response.model_selection.selected_model?.model_name
        },
        ...(!workspaceUnchanged ? { error: "Reviewer changed the workspace despite the read-only boundary." } : {}),
        completed_at: completedAt
      };
      const evidenceRefs = [
        ...findings.map((finding, index) => `${reviewTaskId}:finding:${index + 1}:${finding.file}:${finding.line ?? 0}:${hashAgentValue(finding)}`),
        ...output.reviewed_files.map((file) => `${reviewTaskId}:reviewed:${file}`)
      ];
      const created = await createAgentCompletionProof(this.config, this.guard, this.workspace, {
        parent_goal_id: request.parent_goal_id ?? null,
        agent_id: "reviewer",
        agent_role: "reviewer",
        task_id: reviewTaskId,
        task_contract_hash: taskContractHash,
        run_id: reviewerRunId,
        provider: response.run.provider,
        model_id: response.model_selection.selected_model?.id ?? null,
        sandbox_mode: response.run.sandbox_mode,
        started_at: response.run.started_at,
        terminal_at: response.run.completed_at || completedAt,
        terminal_status: "succeeded",
        input: reviewContract,
        output,
        structured_result: { summary, findings, reviewed_files: output.reviewed_files, uncovered_scope: uncoveredScope },
        workspace_before_hash: before,
        workspace_after_hash: workspaceAfter,
        changed_files: [],
        allowed_paths: [],
        workspace_boundary_valid: workspaceUnchanged,
        acceptance_status: "not_required",
        evidence_refs: evidenceRefs,
        uncovered_scope: uncoveredScope
      });
      const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, created.path, {
        parent_goal_id: request.parent_goal_id ?? null,
        agent_id: "reviewer",
        agent_role: "reviewer",
        task_id: reviewTaskId,
        task_contract_hash: taskContractHash,
        run_id: reviewerRunId,
        provider: response.run.provider,
        sandbox_mode: "read-only",
        input: reviewContract,
        output,
        structured_result: { summary, findings, reviewed_files: output.reviewed_files, uncovered_scope: uncoveredScope },
        workspace_before_hash: before,
        workspace_after_hash: workspaceAfter,
        changed_files: [],
        allowed_paths: [],
        evidence_refs: evidenceRefs,
        require_verified: true
      });
      return {
        ...output,
        ok: output.ok && validation.valid && validation.verified,
        task_contract_hash: taskContractHash,
        completion_class: created.proof.completion_class,
        verified: validation.verified,
        proof_path: created.path,
        proof_hash: created.proof.proof_hash,
        proof_valid: validation.valid,
        proof_invalid_reasons: validation.reasons,
        gate_passed: output.gate_passed && validation.verified
      };
    } catch (error) {
      const workspaceAfter = this.workspaceFingerprint();
      const workspaceUnchanged = before === workspaceAfter;
      const completedAt = new Date().toISOString();
      const fallbackRunId = reviewerRunId ?? `unstarted-${reviewTaskId}-${Date.now()}`;
      const message = boundedText(error instanceof Error ? error.message : error, 8_000);
      const uncovered = ["CRITICAL: Review execution did not complete; the selected diff and related code are not fully covered."];
      const output = {
        ok: false,
        mode: policy.mode,
        summary: "Reviewer execution failed before a trustworthy review report was produced.",
        target: request.target,
        findings: [] as ReviewFinding[],
        reviewed_files: [] as string[],
        uncovered_scope: uncovered,
        workspace_unchanged: workspaceUnchanged,
        reviewer_run_id: reviewerRunId,
        gate_passed: false,
        blocking_findings: [] as ReviewFinding[],
        critical_uncovered_scope: uncovered,
        review_policy: {
          mode: policy.mode,
          p0_confidence_threshold: policy.p0_confidence_threshold,
          p1_confidence_threshold: policy.p1_confidence_threshold,
          require_critical_scope_covered: policy.require_critical_scope_covered,
          ...(policy.independent_provider ? { independent_provider: policy.independent_provider } : {}),
          isolated_context: true,
          provider: this.adapter.provider
        },
        error: message,
        completed_at: completedAt
      };
      try {
        const created = await createAgentCompletionProof(this.config, this.guard, this.workspace, {
          parent_goal_id: request.parent_goal_id ?? null,
          agent_id: "reviewer",
          agent_role: "reviewer",
          task_id: reviewTaskId,
          task_contract_hash: taskContractHash,
          run_id: fallbackRunId,
          provider: this.adapter.provider,
          sandbox_mode: "read-only",
          started_at: completedAt,
          terminal_at: completedAt,
          terminal_status: "failed",
          input: reviewContract,
          output,
          structured_result: { summary: output.summary, findings: [], reviewed_files: [], uncovered_scope: uncovered, error: message },
          workspace_before_hash: before,
          workspace_after_hash: workspaceAfter,
          changed_files: [],
          allowed_paths: [],
          workspace_boundary_valid: workspaceUnchanged,
          acceptance_status: "not_required",
          evidence_refs: [],
          uncovered_scope: uncovered
        });
        const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, created.path, {
          task_id: reviewTaskId,
          task_contract_hash: taskContractHash,
          run_id: fallbackRunId
        });
        return {
          ...output,
          task_contract_hash: taskContractHash,
          completion_class: created.proof.completion_class,
          verified: false,
          proof_path: created.path,
          proof_hash: created.proof.proof_hash,
          proof_valid: validation.valid,
          proof_invalid_reasons: validation.reasons
        };
      } catch (proofError) {
        return {
          ...output,
          task_contract_hash: taskContractHash,
          completion_class: "invalid",
          verified: false,
          proof_path: null,
          proof_hash: null,
          proof_valid: false,
          proof_invalid_reasons: [`proof_write_failed:${boundedText(proofError instanceof Error ? proofError.message : proofError, 2_000)}`]
        };
      }
    }
  }

  private async runAnalysisTask(task: ReadOnlyAgentTask): Promise<ReadOnlyAgentResult> {
    const startedAt = new Date().toISOString();
    const workspaceBefore = this.workspaceFingerprint();
    const contract = {
      version: 1,
      parent_goal_id: task.parent_goal_id ?? null,
      task_id: task.task_id,
      role: task.role,
      objective: task.objective,
      scope: task.scope ?? [],
      context: task.context ?? []
    };
    const taskContractHash = agentTaskContractHash(contract);
    let runId: string | null = null;
    try {
      const role: Exclude<ModelRole, "executor" | "browser_validator" | "reviewer" | "judge"> = task.role === "explorer" ? "planner" : "recovery_analyst";
      const response = await this.runAdapter(this.analysisPrompt(task), role, this.adapter.provider);
      runId = response.run.run_id;
      const parsed = parseAnalysisResponse(response.text);
      const completedAt = new Date().toISOString();
      const workspaceAfter = this.workspaceFingerprint();
      const output = {
        task_id: task.task_id,
        role: task.role,
        run_id: runId,
        status: "succeeded" as const,
        summary: parsed.summary,
        observations: parsed.observations,
        started_at: startedAt,
        completed_at: completedAt
      };
      const evidenceRefs = parsed.observations.map((observation, index) =>
        `${task.task_id}:observation:${index + 1}:${observation.file ?? "no-file"}:${observation.line ?? 0}:${hashAgentValue(observation)}`
      );
      const created = await createAgentCompletionProof(this.config, this.guard, this.workspace, {
        parent_goal_id: task.parent_goal_id ?? null,
        agent_id: task.task_id,
        agent_role: task.role,
        task_id: task.task_id,
        task_contract_hash: taskContractHash,
        run_id: runId,
        provider: response.run.provider,
        model_id: response.model_selection.selected_model?.id ?? null,
        sandbox_mode: response.run.sandbox_mode,
        started_at: response.run.started_at || startedAt,
        terminal_at: response.run.completed_at || completedAt,
        terminal_status: "succeeded",
        input: contract,
        output,
        structured_result: parsed,
        workspace_before_hash: workspaceBefore,
        workspace_after_hash: workspaceAfter,
        changed_files: [],
        allowed_paths: [],
        workspace_boundary_valid: workspaceBefore === workspaceAfter,
        acceptance_status: "not_required",
        evidence_refs: evidenceRefs,
        uncovered_scope: []
      });
      const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, created.path, {
        parent_goal_id: task.parent_goal_id ?? null,
        agent_id: task.task_id,
        agent_role: task.role,
        task_id: task.task_id,
        task_contract_hash: taskContractHash,
        run_id: runId,
        provider: response.run.provider,
        sandbox_mode: "read-only",
        input: contract,
        output,
        structured_result: parsed,
        workspace_before_hash: workspaceBefore,
        workspace_after_hash: workspaceAfter,
        changed_files: [],
        allowed_paths: [],
        evidence_refs: evidenceRefs,
        require_verified: true
      });
      return {
        ...output,
        task_contract_hash: taskContractHash,
        completion_class: created.proof.completion_class,
        verified: validation.verified,
        proof_path: created.path,
        proof_hash: created.proof.proof_hash,
        proof_valid: validation.valid,
        proof_invalid_reasons: validation.reasons
      };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const workspaceAfter = this.workspaceFingerprint();
      const fallbackRunId = runId ?? `unstarted-${task.task_id}-${Date.now()}`;
      const message = boundedText(error instanceof Error ? error.message : error, 8_000);
      const output = {
        task_id: task.task_id,
        role: task.role,
        run_id: runId,
        status: "failed" as const,
        summary: "Read-only subagent failed before producing a trustworthy structured result.",
        observations: [] as AgentObservation[],
        error: message,
        started_at: startedAt,
        completed_at: completedAt
      };
      try {
        const created = await createAgentCompletionProof(this.config, this.guard, this.workspace, {
          parent_goal_id: task.parent_goal_id ?? null,
          agent_id: task.task_id,
          agent_role: task.role,
          task_id: task.task_id,
          task_contract_hash: taskContractHash,
          run_id: fallbackRunId,
          provider: this.adapter.provider,
          sandbox_mode: "read-only",
          started_at: startedAt,
          terminal_at: completedAt,
          terminal_status: "failed",
          input: contract,
          output,
          structured_result: { summary: output.summary, observations: [], error: message },
          workspace_before_hash: workspaceBefore,
          workspace_after_hash: workspaceAfter,
          changed_files: [],
          allowed_paths: [],
          workspace_boundary_valid: workspaceBefore === workspaceAfter,
          acceptance_status: "not_required",
          evidence_refs: [],
          uncovered_scope: ["Agent execution failed before trustworthy analysis completed."]
        });
        const validation = await validateAgentCompletionProof(this.config, this.guard, this.workspace, created.path, {
          task_id: task.task_id,
          task_contract_hash: taskContractHash,
          run_id: fallbackRunId
        });
        return {
          ...output,
          task_contract_hash: taskContractHash,
          completion_class: created.proof.completion_class,
          verified: false,
          proof_path: created.path,
          proof_hash: created.proof.proof_hash,
          proof_valid: validation.valid,
          proof_invalid_reasons: validation.reasons
        };
      } catch (proofError) {
        return {
          ...output,
          task_contract_hash: taskContractHash,
          completion_class: "invalid",
          verified: false,
          proof_path: null,
          proof_hash: null,
          proof_valid: false,
          proof_invalid_reasons: [`proof_write_failed:${boundedText(proofError instanceof Error ? proofError.message : proofError, 2_000)}`]
        };
      }
    }
  }

  private async runAdapter(
    prompt: string,
    role: Exclude<ModelRole, "executor" | "browser_validator">,
    preferredProvider: CodexProviderId,
    independentFromProvider?: CodexProviderId
  ): Promise<AdapterResponse> {
    const modelSelection = selectReadOnlyRoleModel(
      this.modelRegistry,
      role,
      preferredProvider,
      undefined,
      independentFromProvider
    );
    if (!modelSelection.selected_model) {
      throw new Error(`No read-only model satisfies role ${role}: ${modelSelection.blockers.join(" | ")}`);
    }
    const run = await this.adapter.startTask({
      prompt,
      working_directory: this.workspace.root,
      sandbox_mode: "read-only",
      preferred_provider: modelSelection.selected_model.provider,
      ...(modelSelection.selected_model.model_name === "default" ? {} : { model: modelSelection.selected_model.model_name }),
      approval_policy: "never",
      network_access_enabled: false,
      skip_git_repo_check: false
    });
    if (run.sandbox_mode !== "read-only") {
      await this.adapter.cancelTask(run.run_id).catch(() => undefined);
      throw new Error(`Adapter returned unsafe sandbox mode ${run.sandbox_mode}.`);
    }
    const output: string[] = [];
    let timeout: NodeJS.Timeout | undefined;
    const consume = async (): Promise<void> => {
      for await (const event of this.adapter.streamEvents(run.run_id, { follow: true })) {
        if (event.type === "task.output" && typeof event.data?.text === "string") output.push(event.data.text);
      }
    };
    try {
      await Promise.race([
        consume(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Read-only agent timed out after ${READ_ONLY_AGENT_TIMEOUT_MS} ms.`)),
            READ_ONLY_AGENT_TIMEOUT_MS
          );
        })
      ]);
    } catch (error) {
      await this.adapter.cancelTask(run.run_id).catch(() => undefined);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const completed = await this.adapter.getRun(run.run_id);
    if (completed.status !== "succeeded") {
      throw new Error(completed.error_message || `Read-only agent ended with status ${completed.status}.`);
    }
    const text = completed.final_response?.trim() || output.join("\n").trim();
    if (!text) throw new Error("Read-only agent returned no final response.");
    return { run: completed, text: boundedText(text, 100_000), model_selection: modelSelection };
  }

  private analysisPrompt(task: ReadOnlyAgentTask): string {
    const roleInstruction = task.role === "explorer"
      ? "Locate relevant code, dependencies, risks, and the smallest recommended modification scope."
      : "Produce an implementation plan only. Do not edit files, run write commands, or claim the Goal is complete.";
    return [
      `You are the CodexPro ${task.role} read-only subagent.`,
      roleInstruction,
      "You are strictly advisory. Do not modify any file. Do not commit, push, merge, or announce the parent Goal as complete.",
      `Objective: ${task.objective}`,
      task.scope?.length ? `Scope: ${task.scope.join(", ")}` : "Scope: inspect only what is necessary.",
      task.context?.length ? `Context:\n- ${task.context.join("\n- ")}` : "Context: none supplied.",
      "Return exactly one JSON object with this schema:",
      '{"summary":"...","observations":[{"category":"location|dependency|risk|scope|plan","title":"...","file":"optional/path","line":1,"evidence":"...","impact":"optional","recommendation":"optional","confidence":0.0}]}',
      "Use observations=[] when there is no evidence-backed observation. Confidence must be between 0 and 1."
    ].join("\n\n");
  }

  private reviewPrompt(
    request: ReviewRequest,
    diff: string,
    files: Array<{ path: string; content: string }>,
    rules: string[]
  ): string {
    const fileBlocks = files.length
      ? files.map((file) => `### ${file.path}\n${file.content}`).join("\n\n")
      : "No related source file content was available.";
    return [
      `You are the CodexPro Reviewer v1. Mode: ${request.review_policy?.mode ?? this.config.codexReviewMode}. You are strictly read-only.`,
      "Review only the explicitly selected diff, supplied related files, project rules, and acceptance result.",
      "Do not modify files. Do not invent issues. Every finding needs concrete evidence or a reproducible trigger condition.",
      "Severity: P0 security/data destruction/unreleasable; P1 definite functional bug/high-probability regression; P2 ordinary defect/maintenance risk; P3 suggestion.",
      `Review target: ${targetLabel(request.target)}`,
      `Project rules:\n- ${rules.join("\n- ") || "No project rules were found."}`,
      `Acceptance result:\n${JSON.stringify(request.acceptance_result ?? null, null, 2)}`,
      request.extra_context?.length ? `Extra context:\n- ${cleanList(request.extra_context, 50).join("\n- ")}` : "Extra context: none supplied.",
      `Selected diff:\n${boundedText(diff, 120_000) || "(empty diff)"}`,
      `Related files:\n${fileBlocks}`,
      "Return exactly one JSON object with this schema:",
      '{"summary":"...","findings":[{"severity":"P0|P1|P2|P3","file":"path","line":1,"issue":"...","impact":"...","evidence":"...","recommendation":"...","confidence":0.0}],"reviewed_files":["path"],"uncovered_scope":["..."]}',
      "When there are no findings, return findings=[] and still explain reviewed_files and uncovered_scope. Prefix any release-critical uncovered area with CRITICAL:. Do not return only PASS."
    ].join("\n\n");
  }

  private reviewDiff(target: ReviewTarget): string {
    if (target.type === "working_tree") {
      const tracked = this.runGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD"]);
      return [tracked, this.untrackedDiff()].filter(Boolean).join("\n");
    }
    if (target.type === "commit") {
      const commit = this.resolveCommit(target.commit);
      return this.runGit(["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", commit]);
    }
    const base = this.resolveCommit(target.base);
    const head = this.resolveCommit(target.head ?? "HEAD");
    return this.runGit(["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`]);
  }

  private resolveCommit(ref: string): string {
    const value = safeRef(ref);
    return this.runGit(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]).trim();
  }

  private untrackedDiff(): string {
    const contextPrefix = `${this.config.contextDir.replace(/\/+$/, "")}/`;
    const runtimePrefixes = [contextPrefix, ".codexpro/session-trees/"];
    const files = gitUntrackedFiles(this.config, this.workspace)
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter((file) => file
        && file !== "(no output)"
        && file !== this.config.contextDir
        && !runtimePrefixes.some((prefix) => file.startsWith(prefix)))
      .slice(0, 20);
    const patches: string[] = [];
    let remaining = Math.min(this.config.maxOutputBytes, 120_000);
    for (const file of files) {
      try {
        const resolved = this.guard.resolve(this.workspace, file);
        const stat = statSync(resolved.absPath);
        if (!stat.isFile() || stat.size > Math.min(this.config.maxReadBytes, 60_000)) continue;
        const content = readFileSync(resolved.absPath, "utf8");
        if (content.includes("\0")) continue;
        const lines = content.split(/\r?\n/);
        if (lines.at(-1) === "") lines.pop();
        const body = lines.map((line) => `+${line}`).join("\n");
        const patch = [
          `diff --git a/${resolved.relPath} b/${resolved.relPath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${resolved.relPath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          body
        ].join("\n");
        if (patch.length > remaining) break;
        patches.push(patch);
        remaining -= patch.length;
      } catch {
        // Blocked, binary, oversized, or concurrently removed untracked files are omitted.
      }
    }
    return patches.join("\n");
  }

  private runGit(args: string[]): string {
    const result = runProcessSync("git", args, {
      cwd: this.workspace.root,
      env: { ...process.env, NO_COLOR: "1" },
      maxOutputBytes: this.config.maxOutputBytes,
      domain: "git",
      operation: args[0] ?? "git",
      sideEffectLevel: "local_read",
      riskLevel: "low"
    });
    if (result.spawnError) throw new Error(boundedText(result.stderr?.trim() || result.errorClass || "git spawn failed", 8_000));
    if (result.exitCode !== 0) {
      throw new Error(boundedText(result.stderr?.trim() || result.stdout?.trim() || `git exited with ${result.exitCode}`, 8_000));
    }
    return boundedText(result.stdout ?? "", this.config.maxOutputBytes);
  }

  private async readFiles(files: string[]): Promise<Array<{ path: string; content: string }>> {
    const out: Array<{ path: string; content: string }> = [];
    for (const file of files.slice(0, 20)) {
      try {
        const resolved = this.guard.resolve(this.workspace, file);
        const stat = await fsp.stat(resolved.absPath);
        if (!stat.isFile() || stat.size > this.config.maxReadBytes) continue;
        const content = await fsp.readFile(resolved.absPath, "utf8");
        if (content.includes("\0")) continue;
        out.push({ path: resolved.relPath, content: boundedText(content, Math.min(this.config.maxReadBytes, 60_000)) });
      } catch {
        // A deleted, binary, blocked, or unreadable file remains represented by the diff.
      }
    }
    return out;
  }

  private workspaceFingerprint(): string {
    const contextDir = this.config.contextDir.replace(/^\.\//, "").replace(/\/+$/, "");
    const runtimePrefixes = [`${contextDir}/`, ".codexpro/session-trees/"];
    const withoutRuntimeState = (value: string, statusFormat = false): string => value
      .split(/\r?\n/)
      .filter((line) => {
        const normalized = line.replace(/\\/g, "/");
        const statusPath = statusFormat && /^..\s/.test(normalized)
          ? normalized.slice(3).trim()
          : normalized.trim();
        if (statusFormat && statusPath.endsWith("/")) return false;
        return statusPath !== contextDir
          && !runtimePrefixes.some((prefix) => statusPath.startsWith(prefix))
          && !runtimePrefixes.some((prefix) => normalized.includes(` a/${prefix}`))
          && !runtimePrefixes.some((prefix) => normalized.includes(` b/${prefix}`));
      })
      .join("\n");
    const value = [
      withoutRuntimeState(gitStatus(this.config, this.workspace), true),
      withoutRuntimeState(gitDiff(this.config, this.guard, this.workspace, undefined, false)),
      withoutRuntimeState(gitDiff(this.config, this.guard, this.workspace, undefined, true)),
      withoutRuntimeState(gitUntrackedFiles(this.config, this.workspace)),
      this.untrackedDiff()
    ].join("\n---\n");
    return createHash("sha256").update(value).digest("hex");
  }
}
