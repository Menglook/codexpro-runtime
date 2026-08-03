import type { CodexProConfig } from "../config.js";
import type { CodexAdapter, CodexRun } from "../codex/types.js";
import { gitDiff, gitStatus, gitUntrackedFiles } from "../gitOps.js";
import { PathGuard, type Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { validateLatestAcceptanceReceipt } from "../workflow/acceptanceReceipt.js";
import { WorktreeManager } from "../worktrees/worktreeManager.js";
import type { MainWorkspaceBaselineV1, WritableImplementerReport, WritableImplementerRequest } from "../worktrees/types.js";
import {
  agentTaskContractHash,
  createAgentCompletionProof,
  hashAgentFile,
  hashAgentValue,
  validateAgentCompletionProof
} from "./completionProof.js";

const WRITABLE_AGENT_TIMEOUT_MS = 120_000;

interface WritableImplementerReportBase {
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
  error?: string;
  started_at: string;
  completed_at: string;
}

function bounded(value: unknown, max = 8_000): string {
  return redactSensitiveText(typeof value === "string" ? value : String(value ?? "")).slice(0, max);
}

function cleanList(value: string[] | undefined, maxItems = 50): string[] {
  return [...new Set((value ?? []).map((item) => bounded(item, 2_000).trim()).filter(Boolean))].slice(0, maxItems);
}

export class WritableImplementer {
  constructor(
    private readonly config: CodexProConfig,
    private readonly manager: WorktreeManager,
    private readonly adapter: CodexAdapter
  ) {}

  async run(request: WritableImplementerRequest): Promise<WritableImplementerReport> {
    const startedAt = new Date().toISOString();
    const objective = request.objective.trim();
    if (!objective) throw new Error("Writable Implementer objective cannot be empty.");
    if (!this.config.codexWritableImplementersEnabled) {
      throw new Error("Writable Implementers are disabled. Enable CODEXPRO_CODEX_WRITABLE_IMPLEMENTERS first.");
    }

    const owner = `${request.agent_id}-${Date.now()}`;
    let runId: string | null = null;
    let leased = false;
    let worktreeBefore: string | null = null;
    let mainWorkspaceBaseline: MainWorkspaceBaselineV1 | null = null;
    try {
      const record = await this.manager.acquireWriter(request.goal_id, request.agent_id, owner);
      leased = true;
      worktreeBefore = this.worktreeFingerprint(record.path);
      mainWorkspaceBaseline = record.main_workspace_baseline ?? this.manager.captureMainWorkspaceBaseline();
      const capabilities = await this.adapter.capabilities();
      if (!capabilities.available || !capabilities.supports.workspace_write) {
        throw new Error("The configured Codex adapter does not support workspace-write mode.");
      }

      const run = await this.adapter.startTask({
        prompt: this.prompt(request, record.allowed_paths),
        working_directory: record.path,
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        network_access_enabled: false,
        skip_git_repo_check: false
      });
      runId = run.run_id;
      if (run.sandbox_mode !== "workspace-write") {
        await this.adapter.cancelTask(run.run_id).catch(() => undefined);
        throw new Error(`Adapter returned unsafe sandbox mode ${run.sandbox_mode}.`);
      }
      if (run.working_directory !== record.path) {
        await this.adapter.cancelTask(run.run_id).catch(() => undefined);
        throw new Error("Adapter did not bind the writable task to the managed worktree.");
      }

      const response = await this.waitForRun(run);
      const refreshed = await this.manager.releaseWriter(request.goal_id, request.agent_id, owner);
      leased = false;
      const outOfScope = refreshed.changed_files.filter((file) => !this.manager.pathAllowed(refreshed, file));
      const mainWorkspaceComparison = mainWorkspaceBaseline
        ? this.manager.compareMainWorkspaceBaseline(mainWorkspaceBaseline)
        : null;
      const mainWorkspaceUnchanged = mainWorkspaceComparison?.unchanged === true;
      if (outOfScope.length || !mainWorkspaceUnchanged) {
        const reason = outOfScope.length
          ? `Writable Implementer changed paths outside the Goal allowlist: ${outOfScope.join(", ")}`
          : `Writable Implementer changed the main workspace: ${mainWorkspaceComparison?.reasons.join("; ") || "baseline unavailable"}.`;
        await this.manager.retain(request.goal_id, request.agent_id, reason);
        return await this.attachProof(request, {
          ok: false,
          mode: "workspace-write",
          goal_id: request.goal_id,
          agent_id: request.agent_id,
          run_id: runId,
          worktree_path: refreshed.path,
          branch: refreshed.branch,
          status: "blocked",
          summary: "Writable execution completed but violated an isolation boundary; the worktree was retained.",
          changed_files: refreshed.changed_files,
          allowed_paths: refreshed.allowed_paths,
          out_of_scope_files: outOfScope,
          main_workspace_unchanged: mainWorkspaceUnchanged,
          error: reason,
          started_at: startedAt,
          completed_at: new Date().toISOString()
        }, worktreeBefore, response);
      }

      return await this.attachProof(request, {
        ok: response.status === "succeeded",
        mode: "workspace-write",
        goal_id: request.goal_id,
        agent_id: request.agent_id,
        run_id: runId,
        worktree_path: refreshed.path,
        branch: refreshed.branch,
        status: response.status === "succeeded" ? "succeeded" : "failed",
        summary: bounded(response.final_response || `Writable Implementer ended with ${response.status}.`, 12_000),
        changed_files: refreshed.changed_files,
        allowed_paths: refreshed.allowed_paths,
        out_of_scope_files: [],
        main_workspace_unchanged: true,
        ...(response.status === "succeeded" ? {} : { error: bounded(response.error_message || response.status) }),
        started_at: startedAt,
        completed_at: new Date().toISOString()
      }, worktreeBefore, response);
    } catch (error) {
      if (leased) {
        await this.manager.releaseWriter(request.goal_id, request.agent_id, owner).catch(() => undefined);
      }
      let record = await this.manager.get(request.goal_id, request.agent_id).catch(() => undefined);
      const outOfScope = record?.changed_files.filter((file) => !this.manager.pathAllowed(record!, file)) ?? [];
      const mainWorkspaceComparison = mainWorkspaceBaseline
        ? this.manager.compareMainWorkspaceBaseline(mainWorkspaceBaseline)
        : null;
      const isolationBindingFailure = /unsafe sandbox mode|did not bind the writable task/i.test(bounded(error));
      const retainRequired = outOfScope.length > 0
        || mainWorkspaceComparison?.unchanged === false
        || isolationBindingFailure;
      if (record && record.status !== "retained" && retainRequired) {
        record = await this.manager.retain(request.goal_id, request.agent_id, bounded(error)).catch(() => record);
      }
      const retained = record?.status === "retained";
      return await this.attachProof(request, {
        ok: false,
        mode: "workspace-write",
        goal_id: request.goal_id,
        agent_id: request.agent_id,
        run_id: runId,
        worktree_path: record?.path ?? "",
        branch: record?.branch ?? "",
        status: "failed",
        summary: retained
          ? "Writable Implementer failed after an isolation boundary became uncertain; the worktree was retained."
          : "Writable Implementer failed without violating the workspace boundary; the worktree remains available for retry.",
        changed_files: record?.changed_files ?? [],
        allowed_paths: record?.allowed_paths ?? [],
        out_of_scope_files: outOfScope,
        main_workspace_unchanged: mainWorkspaceComparison?.unchanged ?? this.manager.mainWorkspaceClean(),
        error: bounded(error),
        started_at: startedAt,
        completed_at: new Date().toISOString()
      }, worktreeBefore);
    }
  }

  private async attachProof(
    request: WritableImplementerRequest,
    report: WritableImplementerReportBase,
    worktreeBefore: string | null,
    run?: CodexRun
  ): Promise<WritableImplementerReport> {
    const taskId = `${request.goal_id}-${request.agent_id}`;
    const contract = {
      version: 1,
      parent_goal_id: request.goal_id,
      task_id: taskId,
      goal_id: request.goal_id,
      agent_id: request.agent_id,
      objective: request.objective.trim(),
      constraints: cleanList(request.constraints),
      acceptance_commands: cleanList(request.acceptance_commands)
    };
    const taskContractHash = agentTaskContractHash(contract);
    const fallbackRunId = report.run_id ?? `unstarted-${taskId}-${Date.now()}`;
    const controlGuard = new PathGuard(this.config);
    let worktreeAfter: string | null = null;
    let acceptanceStatus: WritableImplementerReport["acceptance_status"] = report.status === "succeeded" ? "not_run" : "failed";
    let acceptanceReceiptPath: string | null = null;
    let acceptanceReceiptHash: string | null = null;
    const evidenceRefs: string[] = [];

    try {
      if (report.worktree_path) {
        worktreeAfter = this.worktreeFingerprint(report.worktree_path);
        const childConfig: CodexProConfig = {
          ...this.config,
          defaultRoot: report.worktree_path,
          allowedRoots: [report.worktree_path],
          codexWorktreesEnabled: false,
          codexWritableImplementersEnabled: false
        };
        const childWorkspace: Workspace = {
          id: `${this.manager.workspace.id}-proof-${request.goal_id}-${request.agent_id}`,
          root: report.worktree_path,
          openedAt: new Date().toISOString()
        };
        const childGuard = new PathGuard(childConfig);
        if (report.status === "succeeded") {
          const receiptValidation = await validateLatestAcceptanceReceipt(childConfig, childGuard, childWorkspace);
          if (receiptValidation.valid && receiptValidation.receipt) {
            acceptanceStatus = receiptValidation.receipt.validation_status;
            acceptanceReceiptPath = childGuard.resolve(childWorkspace, receiptValidation.path).absPath;
            acceptanceReceiptHash = await hashAgentFile(acceptanceReceiptPath);
          }
        }
        for (const file of report.changed_files) {
          let fileHash: string | null = null;
          try {
            fileHash = await hashAgentFile(childGuard.resolve(childWorkspace, file).absPath);
          } catch {
            fileHash = null;
          }
          evidenceRefs.push(`${taskId}:changed:${file}:${fileHash ?? "missing"}`);
        }
      }

      const structuredResult = {
        status: report.status,
        summary: report.summary,
        changed_files: report.changed_files,
        out_of_scope_files: report.out_of_scope_files,
        main_workspace_unchanged: report.main_workspace_unchanged
      };
      const created = await createAgentCompletionProof(this.config, controlGuard, this.manager.workspace, {
        parent_goal_id: request.goal_id,
        agent_id: request.agent_id,
        agent_role: "implementer",
        task_id: taskId,
        task_contract_hash: taskContractHash,
        run_id: fallbackRunId,
        provider: run?.provider ?? this.adapter.provider,
        model_id: null,
        sandbox_mode: run?.sandbox_mode ?? "workspace-write",
        started_at: run?.started_at ?? report.started_at,
        terminal_at: run?.completed_at ?? report.completed_at,
        terminal_status: report.status,
        input: contract,
        output: report,
        structured_result: structuredResult,
        workspace_before_hash: worktreeBefore,
        workspace_after_hash: worktreeAfter,
        changed_files: report.changed_files,
        allowed_paths: report.allowed_paths,
        workspace_boundary_valid:
          report.main_workspace_unchanged
          && report.out_of_scope_files.length === 0
          && worktreeBefore !== null
          && worktreeAfter !== null,
        acceptance_status: acceptanceStatus,
        acceptance_receipt_path: acceptanceReceiptPath,
        acceptance_receipt_hash: acceptanceReceiptHash,
        evidence_refs: evidenceRefs,
        uncovered_scope: acceptanceStatus === "not_run" ? ["Targeted acceptance was not proven for the writable worktree."] : []
      });
      const validation = await validateAgentCompletionProof(this.config, controlGuard, this.manager.workspace, created.path, {
        parent_goal_id: request.goal_id,
        agent_id: request.agent_id,
        agent_role: "implementer",
        task_id: taskId,
        task_contract_hash: taskContractHash,
        run_id: fallbackRunId,
        provider: run?.provider ?? this.adapter.provider,
        sandbox_mode: "workspace-write",
        input: contract,
        output: report,
        structured_result: structuredResult,
        workspace_before_hash: worktreeBefore,
        workspace_after_hash: worktreeAfter,
        changed_files: report.changed_files,
        allowed_paths: report.allowed_paths,
        evidence_refs: evidenceRefs,
        require_verified: acceptanceStatus === "passed" || acceptanceStatus === "skipped"
      });
      return {
        ...report,
        task_contract_hash: taskContractHash,
        completion_class: created.proof.completion_class,
        verified: validation.verified,
        proof_path: created.path,
        proof_hash: created.proof.proof_hash,
        proof_valid: validation.valid,
        proof_invalid_reasons: validation.reasons,
        acceptance_status: acceptanceStatus,
        acceptance_receipt_path: acceptanceReceiptPath
      };
    } catch (error) {
      return {
        ...report,
        task_contract_hash: taskContractHash,
        completion_class: "invalid",
        verified: false,
        proof_path: null,
        proof_hash: null,
        proof_valid: false,
        proof_invalid_reasons: [`proof_generation_failed:${bounded(error, 2_000)}`],
        acceptance_status: acceptanceStatus,
        acceptance_receipt_path: acceptanceReceiptPath
      };
    }
  }

  private worktreeFingerprint(worktreePath: string): string {
    const childConfig: CodexProConfig = {
      ...this.config,
      defaultRoot: worktreePath,
      allowedRoots: [worktreePath],
      codexWorktreesEnabled: false,
      codexWritableImplementersEnabled: false
    };
    const childWorkspace: Workspace = {
      id: `${this.manager.workspace.id}-fingerprint`,
      root: worktreePath,
      openedAt: new Date().toISOString()
    };
    const childGuard = new PathGuard(childConfig);
    return hashAgentValue({
      status: gitStatus(childConfig, childWorkspace),
      unstaged: gitDiff(childConfig, childGuard, childWorkspace, undefined, false),
      staged: gitDiff(childConfig, childGuard, childWorkspace, undefined, true),
      untracked: gitUntrackedFiles(childConfig, childWorkspace)
    });
  }

  private async waitForRun(run: CodexRun): Promise<CodexRun> {
    let timeout: NodeJS.Timeout | undefined;
    const consume = async (): Promise<void> => {
      for await (const _event of this.adapter.streamEvents(run.run_id, { follow: true })) {
        // The durable adapter run is the source of truth; streaming is consumed to terminal state.
      }
    };
    try {
      await Promise.race([
        consume(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Writable Implementer timed out after ${WRITABLE_AGENT_TIMEOUT_MS} ms.`)),
            WRITABLE_AGENT_TIMEOUT_MS
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
      throw new Error(completed.error_message || `Writable Implementer ended with status ${completed.status}.`);
    }
    return completed;
  }

  private prompt(request: WritableImplementerRequest, allowedPaths: string[]): string {
    const constraints = cleanList(request.constraints);
    const acceptance = cleanList(request.acceptance_commands);
    return [
      "You are the CodexPro Implementer v2 operating inside one exclusive managed Git worktree.",
      `Goal ID: ${request.goal_id}`,
      `Agent ID: ${request.agent_id}`,
      `Objective: ${request.objective.trim()}`,
      `Allowed write paths:\n- ${allowedPaths.join("\n- ")}`,
      constraints.length ? `Constraints:\n- ${constraints.join("\n- ")}` : "Constraints: none supplied.",
      acceptance.length ? `Targeted acceptance commands available for this Goal:\n- ${acceptance.join("\n- ")}` : "Targeted acceptance commands: none supplied.",
      "Modify only files under the allowed write paths. Do not write through symlinks or touch blocked secret/build/database paths.",
      "Do not commit, push, merge, publish, modify the main workspace, modify long-term memory, or delete the worktree/branch.",
      "Do not claim the parent Goal is complete. Report what changed and any remaining risk in the final response."
    ].join("\n\n");
  }
}
