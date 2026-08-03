import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentTaskContractHash,
  createAgentCompletionProof,
  hashAgentValue
} from "../agents/completionProof.js";
import type { AdvisoryReviewReport, ReviewRequest } from "../agents/types.js";
import type { CodexProConfig } from "../config.js";
import { ExecCodexAdapter } from "../codex/execAdapter.js";
import type { CodexReasoningEffort, CodexSandboxMode } from "../codex/types.js";
import { gitStatus } from "../gitOps.js";
import { PathGuard, type Workspace } from "../guard.js";
import type { HookBridgeLike } from "../hooks/hookBridge.js";
import { GoalManager } from "../goals/goalManager.js";
import { isGoalTerminal, type GoalCheckpoint, type GoalExecutionProfileUpgrade, type GoalInspection, type GoalRecord } from "../goals/types.js";
import { runAcceptance, type AcceptanceRunResult } from "./acceptanceEngine.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import type { ManagedWorktreeRecord } from "../worktrees/types.js";

export interface ExecManagedWorktreeInput {
  agent_id?: string;
  slug?: string;
  allowed_paths: string[];
  base_ref?: string;
}

export interface ExecManagedAcceptanceContext {
  config: CodexProConfig;
  guard: PathGuard;
  workspace: Workspace;
  record: ManagedWorktreeRecord;
}

export interface ExecRunnerOptions {
  executable?: string;
  timeout_ms?: number;
  review_timeout_ms?: number;
  max_parallel?: number;
  resource_wait_timeout_ms?: number;
  review_enabled?: boolean;
  poll_interval_ms?: number;
  max_log_bytes?: number;
  hook_bridge?: HookBridgeLike | null;
  acceptance_runner?: () => Promise<AcceptanceRunResult>;
  managed_acceptance_runner?: (context: ExecManagedAcceptanceContext) => Promise<AcceptanceRunResult>;
  prepare_managed_worktree?: (record: ManagedWorktreeRecord) => Promise<void>;
}

export interface ExecTaskRunInput {
  goal_id?: string;
  objective: string;
  constraints?: string[];
  acceptance?: string[];
  initial_checkpoint?: GoalCheckpoint;
  idempotency_key: string;
  sandbox_mode?: CodexSandboxMode;
  model?: string;
  reasoning_effort?: CodexReasoningEffort;
  skip_git_repo_check?: boolean;
  managed_worktree?: ExecManagedWorktreeInput;
}

export interface ExecTaskResumeInput {
  goal_id: string;
  prompt: string;
  idempotency_key?: string;
  execution_profile_upgrade?: GoalExecutionProfileUpgrade;
}

function schemasPath(name: string): string {
  return fileURLToPath(new URL(`../../schemas/${name}`, import.meta.url));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proofList(value: unknown, maxItems = 50): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, maxItems);
}

export class ExecRunner {
  readonly adapter: ExecCodexAdapter;
  readonly manager: GoalManager;
  private readonly config: CodexProConfig;
  private readonly pollIntervalMs: number;

  constructor(
    config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace,
    private readonly options: ExecRunnerOptions = {}
  ) {
    this.config = config.codexAdapter === "exec" ? config : { ...config, codexAdapter: "exec" };
    this.pollIntervalMs = Math.max(25, Math.min(options.poll_interval_ms ?? 100, 2_000));
    this.adapter = new ExecCodexAdapter({
      executable: options.executable ?? this.config.codexExecutable,
      working_directory: workspace.root,
      state_directory: path.join(workspace.root, this.config.contextDir, "exec-runs"),
      result_schema_path: schemasPath("exec-result.schema.json"),
      review_schema_path: schemasPath("exec-review-result.schema.json"),
      timeout_ms: options.timeout_ms,
      review_timeout_ms: options.review_timeout_ms,
      max_parallel: options.max_parallel,
      slot_wait_timeout_ms: options.resource_wait_timeout_ms ?? this.config.resourceWaitTimeoutMs,
      poll_interval_ms: options.poll_interval_ms,
      max_log_bytes: options.max_log_bytes
    });
    const reviewEnabled = options.review_enabled ?? true;
    this.manager = new GoalManager(this.config, guard, workspace, this.adapter, {
      recoverOnStart: false,
      hookBridge: options.hook_bridge,
      ...(options.acceptance_runner ? { runAcceptance: options.acceptance_runner } : {}),
      ...(reviewEnabled ? { runReview: (request: ReviewRequest) => this.runReadOnlyReview(request) } : {})
    });
  }

  async start(input: ExecTaskRunInput): Promise<GoalRecord> {
    if (input.managed_worktree) {
      throw new Error("Managed worktree execution must use ExecRunner.run() so the worktree lifecycle can be finalized safely.");
    }
    return await this.manager.start({
      goal_id: input.goal_id,
      objective: input.objective,
      constraints: input.constraints,
      acceptance: input.acceptance,
      initial_checkpoint: input.initial_checkpoint,
      idempotency_key: input.idempotency_key,
      sandbox_mode: input.sandbox_mode ?? "workspace-write",
      approval_policy: "never",
      model: input.model,
      reasoning_effort: input.reasoning_effort,
      network_access_enabled: false,
      skip_git_repo_check: input.skip_git_repo_check ?? false
    });
  }

  async run(input: ExecTaskRunInput): Promise<GoalInspection> {
    if (input.managed_worktree) return await this.runManaged(input);
    const goal = await this.start(input);
    return await this.wait(goal.goal_id);
  }

  async resume(input: ExecTaskResumeInput): Promise<GoalInspection> {
    const goal = await this.manager.resume(input);
    return await this.wait(goal.goal_id);
  }

  async cancel(goalId: string): Promise<GoalInspection> {
    await this.manager.cancel(goalId);
    return await this.manager.status(goalId);
  }

  async replayHooks(goalId: string): Promise<GoalInspection> {
    await this.manager.replayTerminalHooks(goalId);
    return await this.manager.status(goalId);
  }

  async status(goalId: string): Promise<GoalInspection> {
    return await this.manager.status(goalId);
  }

  async list(): Promise<GoalRecord[]> {
    await this.manager.ready();
    return await this.manager.store.listGoals();
  }

  async review(goalId: string): Promise<{
    goal: GoalRecord;
    review: GoalInspection["review"];
    validation: GoalInspection["validation"];
    result: GoalInspection["result"];
  }> {
    const inspection = await this.manager.status(goalId);
    return {
      goal: inspection.goal,
      review: inspection.review,
      validation: inspection.validation,
      result: inspection.result
    };
  }

  async wait(goalId: string, timeoutMs = 24 * 60 * 60_000): Promise<GoalInspection> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() <= deadline) {
      const inspection = await this.manager.status(goalId);
      if (isGoalTerminal(inspection.goal.status)) {
        const runnerWaitReturnedAt = new Date().toISOString();
        const runnerWaitAlreadyRecorded = Boolean(inspection.goal.checkpoint?.runner_wait_returned_at);
        inspection.goal.checkpoint = {
          ...(inspection.goal.checkpoint ?? {}),
          runner_wait_returned_at: inspection.goal.checkpoint?.runner_wait_returned_at ?? runnerWaitReturnedAt
        };
        if (!runnerWaitAlreadyRecorded) {
          void this.manager.store.patchMetadata(goalId, "goal.runner_wait_returned", (goal) => {
            if (goal.checkpoint?.runner_wait_returned_at) return;
            goal.checkpoint = {
              ...(goal.checkpoint ?? {}),
              runner_wait_returned_at: runnerWaitReturnedAt
            };
          }, { runner_wait_returned_at: runnerWaitReturnedAt }).catch(() => undefined);
        }
        return inspection;
      }
      if (
        (inspection.goal.status === "waiting_input" || inspection.goal.status === "waiting_approval") &&
        inspection.goal.checkpoint?.codex_turn_terminal === true
      ) return inspection;
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for Goal ${goalId} to reach a stable state.`);
  }

  private async runManaged(input: ExecTaskRunInput): Promise<GoalInspection> {
    const managed = input.managed_worktree;
    if (!managed) throw new Error("Managed worktree configuration is missing.");
    if ((input.sandbox_mode ?? "workspace-write") !== "workspace-write") {
      throw new Error("Managed worktree execution requires workspace-write sandbox mode.");
    }
    const allowedPaths = [...new Set(managed.allowed_paths.map((item) => item.trim()).filter(Boolean))];
    if (!allowedPaths.length) throw new Error("Managed worktree execution requires at least one allowed path.");

    const goalId = input.goal_id?.trim() || randomUUID();
    const agentId = managed.agent_id?.trim() || "implementer";
    const worktreeManager = new WorktreeManager(this.config, this.guard, this.workspace);
    const baselineStatus = gitStatus(this.config, this.workspace);
    const record = await worktreeManager.create({
      goal_id: goalId,
      agent_id: agentId,
      slug: managed.slug ?? "exec-task",
      allowed_paths: allowedPaths,
      base_ref: managed.base_ref
    });

    try {
      await this.options.prepare_managed_worktree?.(record);
      const childConfig: CodexProConfig = {
        ...this.config,
        defaultRoot: record.path,
        allowedRoots: [record.path],
        codexWorktreesEnabled: false,
        codexWritableImplementersEnabled: false
      };
      const childWorkspace: Workspace = {
        id: `${this.workspace.id}-worktree-${goalId}`,
        root: record.path,
        openedAt: new Date().toISOString()
      };
      const childGuard = new PathGuard(childConfig);
      let childRunner!: ExecRunner;
      const acceptanceRunner = async (): Promise<AcceptanceRunResult> => {
        const result = this.options.managed_acceptance_runner
          ? await this.options.managed_acceptance_runner({ config: childConfig, guard: childGuard, workspace: childWorkspace, record })
          : await runAcceptance(childConfig, childGuard, childWorkspace);
        const refreshed = await worktreeManager.get(goalId, agentId);
        const outOfScope = refreshed.changed_files.filter((file) => !worktreeManager.pathAllowed(refreshed, file));
        const mainWorkspaceUnchanged = gitStatus(this.config, this.workspace) === baselineStatus;
        if (!mainWorkspaceUnchanged) {
          throw new Error("Managed worktree boundary failed: the control workspace changed during execution.");
        }
        if (outOfScope.length) {
          throw new Error(`Managed worktree boundary failed: out-of-scope files changed: ${outOfScope.join(", ")}`);
        }
        if (result.ok) {
          const delivered = refreshed.status === "delivered"
            ? refreshed
            : await worktreeManager.deliver(goalId, agentId);
          await childRunner.manager.store.patch(goalId, "goal.worktree_delivered", (goal) => {
            goal.checkpoint = {
              ...(goal.checkpoint ?? {}),
              managed_worktree: {
                project_root: this.workspace.root,
                path: delivered.path,
                branch: delivered.branch,
                base_commit: delivered.base_commit,
                agent_id: delivered.agent_id,
                allowed_paths: delivered.allowed_paths,
                changed_files: delivered.changed_files,
                status: delivered.status,
                main_workspace_unchanged: true,
                out_of_scope_files: []
              }
            };
          }, {
            worktree_status: delivered.status,
            changed_files: delivered.changed_files,
            main_workspace_unchanged: true,
            out_of_scope_files: []
          });
        }
        return result;
      };
      childRunner = new ExecRunner(childConfig, childGuard, childWorkspace, {
        executable: this.options.executable,
        timeout_ms: this.options.timeout_ms,
        review_timeout_ms: this.options.review_timeout_ms,
        max_parallel: this.options.max_parallel,
        resource_wait_timeout_ms: this.options.resource_wait_timeout_ms,
        review_enabled: this.options.review_enabled,
        poll_interval_ms: this.options.poll_interval_ms,
        max_log_bytes: this.options.max_log_bytes,
        acceptance_runner: acceptanceRunner,
        ...(this.options.hook_bridge !== undefined ? { hook_bridge: this.options.hook_bridge } : {})
      });
      const { managed_worktree: _managedWorktree, ...childInput } = input;
      const inspection = await childRunner.run({
        ...childInput,
        goal_id: goalId,
        initial_checkpoint: {
          ...(input.initial_checkpoint ?? {}),
          managed_worktree: {
            project_root: this.workspace.root,
            path: record.path,
            branch: record.branch,
            base_commit: record.base_commit,
            agent_id: agentId,
            allowed_paths: allowedPaths,
            status: "active"
          }
        }
      });

      const refreshed = await worktreeManager.get(goalId, agentId);
      const outOfScope = refreshed.changed_files.filter((file) => !worktreeManager.pathAllowed(refreshed, file));
      const mainWorkspaceUnchanged = gitStatus(this.config, this.workspace) === baselineStatus;
      const deliverable = inspection.goal.status === "succeeded" && mainWorkspaceUnchanged && outOfScope.length === 0;
      const finalRecord = deliverable
        ? refreshed.status === "delivered"
          ? refreshed
          : await worktreeManager.deliver(goalId, agentId)
        : await worktreeManager.retain(
          goalId,
          agentId,
          outOfScope.length
            ? `Out-of-scope files changed: ${outOfScope.join(", ")}`
            : !mainWorkspaceUnchanged
              ? "The control workspace changed during managed execution."
              : `Goal ended with ${inspection.goal.status}; retained for inspection.`
        );
      await childRunner.manager.store.patchMetadata(goalId, "goal.worktree_finalized", (goal) => {
        goal.checkpoint = {
          ...(goal.checkpoint ?? {}),
          managed_worktree: {
            project_root: this.workspace.root,
            path: finalRecord.path,
            branch: finalRecord.branch,
            base_commit: finalRecord.base_commit,
            agent_id: finalRecord.agent_id,
            allowed_paths: finalRecord.allowed_paths,
            changed_files: finalRecord.changed_files,
            status: finalRecord.status,
            main_workspace_unchanged: mainWorkspaceUnchanged,
            out_of_scope_files: outOfScope
          }
        };
      }, {
        worktree_status: finalRecord.status,
        changed_files: finalRecord.changed_files,
        main_workspace_unchanged: mainWorkspaceUnchanged,
        out_of_scope_files: outOfScope
      });
      return await childRunner.manager.status(goalId);
    } catch (error) {
      await worktreeManager.retain(
        goalId,
        agentId,
        error instanceof Error ? error.message : String(error)
      ).catch(() => undefined);
      throw error;
    }
  }

  private async runReadOnlyReview(request: ReviewRequest): Promise<AdvisoryReviewReport> {
    const before = gitStatus(this.config, this.workspace);
    const report = await this.adapter.runReview(request);
    const after = gitStatus(this.config, this.workspace);
    const workspaceUnchanged = before === after;
    const baseReport: AdvisoryReviewReport = {
      ...report,
      ok: report.ok && workspaceUnchanged,
      workspace_unchanged: workspaceUnchanged,
      ...(!workspaceUnchanged
        ? { error: "Exec review changed the Git-visible workspace and was rejected." }
        : {})
    };
    const taskId = request.task_id?.trim() || `review-${baseReport.reviewer_run_id ?? randomUUID()}`;
    const policy = request.review_policy ?? {
      mode: this.config.codexReviewMode,
      p0_confidence_threshold: this.config.codexReviewP0Threshold,
      p1_confidence_threshold: this.config.codexReviewP1Threshold,
      require_critical_scope_covered: this.config.codexReviewRequireCriticalScopeCovered
    };
    const contract = {
      version: 1,
      parent_goal_id: request.parent_goal_id ?? null,
      task_id: taskId,
      target: request.target,
      related_files: proofList(request.related_files),
      acceptance_result: request.acceptance_result ?? null,
      extra_context: proofList(request.extra_context),
      minimal_change_contract: request.minimal_change_contract ?? null,
      change_footprint: request.change_footprint ?? null,
      review_policy: policy
    };
    const structuredResult = {
      summary: baseReport.summary,
      findings: baseReport.findings,
      reviewed_files: baseReport.reviewed_files,
      uncovered_scope: baseReport.uncovered_scope
    };
    const evidenceRefs = [
      ...baseReport.findings.map((finding, index) => `${taskId}:finding:${index + 1}:${finding.file}:${finding.line ?? 0}:${hashAgentValue(finding)}`),
      ...baseReport.reviewed_files.map((file) => `${taskId}:reviewed:${file}`)
    ];
    try {
      const created = await createAgentCompletionProof(this.config, this.guard, this.workspace, {
        parent_goal_id: request.parent_goal_id ?? null,
        agent_id: "reviewer",
        agent_role: "reviewer",
        task_id: taskId,
        task_contract_hash: agentTaskContractHash(contract),
        run_id: baseReport.reviewer_run_id ?? `unstarted-${taskId}`,
        provider: baseReport.review_policy.provider ?? this.adapter.provider,
        model_id: null,
        sandbox_mode: "read-only",
        started_at: baseReport.completed_at,
        terminal_at: baseReport.completed_at,
        terminal_status: baseReport.error ? "failed" : "succeeded",
        input: contract,
        output: baseReport,
        structured_result: structuredResult,
        workspace_before_hash: hashAgentValue(before),
        workspace_after_hash: hashAgentValue(after),
        changed_files: [],
        allowed_paths: [],
        workspace_boundary_valid: workspaceUnchanged,
        acceptance_status: "not_required",
        evidence_refs: evidenceRefs,
        uncovered_scope: baseReport.uncovered_scope
      });
      return {
        ...baseReport,
        task_contract_hash: agentTaskContractHash(contract),
        completion_class: created.proof.completion_class,
        verified: created.proof.completion_class === "verified",
        proof_path: created.path,
        proof_valid: true,
        proof_invalid_reasons: []
      };
    } catch (error) {
      return {
        ...baseReport,
        ok: false,
        gate_passed: false,
        task_contract_hash: agentTaskContractHash(contract),
        completion_class: "invalid",
        verified: false,
        proof_path: null,
        proof_valid: false,
        proof_invalid_reasons: [`proof_generation_failed:${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }
}
