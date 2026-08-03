import type { CodexProConfig } from "../config.js";
import { PathGuard, WorkspaceManager } from "../guard.js";
import { recoverAsyncCompactTasks } from "../asyncCompactTasks.js";
import { recoverAcceptanceTasks } from "../workflow/asyncAcceptance.js";

export interface DurableStartupRecoverySummary {
  workspace_roots: string[];
  scanned: number;
  resumed: string[];
  recovery_required: string[];
  stale: string[];
  acceptance_scanned: number;
  acceptance_resumed: string[];
  acceptance_recovery_required: string[];
  acceptance_stale: string[];
  errors: string[];
}

export async function recoverConfiguredDurableJobs(config: CodexProConfig): Promise<DurableStartupRecoverySummary> {
  const manager = new WorkspaceManager(config);
  const workspaces = [manager.defaultWorkspace(), manager.activatePersistedWorkspaceIfAvailable()].filter(Boolean);
  const unique = [...new Map(workspaces.map((workspace) => [workspace!.root, workspace!])).values()];
  const guard = new PathGuard(config);
  const summary: DurableStartupRecoverySummary = {
    workspace_roots: unique.map((workspace) => workspace.root),
    scanned: 0,
    resumed: [],
    recovery_required: [],
    stale: [],
    acceptance_scanned: 0,
    acceptance_resumed: [],
    acceptance_recovery_required: [],
    acceptance_stale: [],
    errors: []
  };
  for (const workspace of unique) {
    try {
      const result = await recoverAsyncCompactTasks(config, guard, workspace);
      summary.scanned += result.scanned;
      summary.resumed.push(...result.resumed.map((runId) => `${workspace.root}:${runId}`));
      summary.recovery_required.push(...result.recovery_required.map((runId) => `${workspace.root}:${runId}`));
      summary.stale.push(...result.stale.map((runId) => `${workspace.root}:${runId}`));
    } catch (error) {
      summary.errors.push(`${workspace.root}: compact tasks: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const acceptance = await recoverAcceptanceTasks(config, guard, workspace);
      summary.acceptance_scanned += acceptance.scanned;
      summary.acceptance_resumed.push(...acceptance.resumed.map((runId) => `${workspace.root}:${runId}`));
      summary.acceptance_recovery_required.push(...acceptance.recovery_required.map((runId) => `${workspace.root}:${runId}`));
      summary.acceptance_stale.push(...acceptance.stale.map((runId) => `${workspace.root}:${runId}`));
    } catch (error) {
      summary.errors.push(`${workspace.root}: acceptance tasks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
