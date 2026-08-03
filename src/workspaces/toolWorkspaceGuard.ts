import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, PathGuard, type Workspace } from "../guard.js";
import { RuntimeActivityEventStore } from "../runtime/activityEventStore.js";
import { TaskIdentityStore } from "../tasks/taskIdentityStore.js";
import type { ToolContractMetadataV1 } from "../tools/toolContract.js";

function sameRoot(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function emitConflict(config: CodexProConfig, workspace: Workspace, args: Record<string, unknown>, reason: string): Promise<void> {
  const events = new RuntimeActivityEventStore(new PathGuard(config), workspace);
  await events.append({
    kind: "office.workspace_conflict",
    objective_id: typeof args.task_id === "string" ? args.task_id : null,
    attempt_id: typeof args.task_id === "string" ? args.task_id : null,
    run_id: typeof args.run_id === "string" ? args.run_id : null,
    actor_id: typeof args.executor_id === "string" ? args.executor_id : null,
    actor_role: "system",
    payload: {
      supplied_conversation_id: typeof args.conversation_id === "string" ? args.conversation_id : null,
      supplied_workspace_id: typeof args.workspace_id === "string" ? args.workspace_id : null,
      supplied_workspace_generation: Number.isInteger(args.workspace_generation) ? args.workspace_generation : null,
      authoritative_conversation_id: workspace.conversationId ?? null,
      authoritative_workspace_id: workspace.id,
      authoritative_workspace_generation: workspace.workspaceGeneration ?? null,
      reason,
      side_effects_blocked: true
    }
  }).catch(() => undefined);
}

function conflict(message: string): CodexProError {
  return new CodexProError(`office.workspace_conflict: ${message}`);
}

export async function assertToolWorkspaceBinding(input: {
  config: CodexProConfig;
  workspace: Workspace | null;
  contract: ToolContractMetadataV1;
  args: Record<string, unknown>;
}): Promise<{ warning: string | null }> {
  const { config, workspace, contract, args } = input;
  if (!contract.workspace_required) return { warning: null };
  if (!workspace) throw conflict(`${contract.tool_name} could not resolve an authoritative workspace.`);
  if (typeof args.workspace_id !== "string" || !args.workspace_id.trim()) {
    if (!contract.workspace_generation_required) {
      return {
        warning: `${contract.tool_name} used the conversation workspace compatibility path; explicit workspace_id is recommended.`
      };
    }
    await emitConflict(config, workspace, args, `${contract.tool_name} requires workspace_id.`);
    throw conflict(`${contract.tool_name} requires explicit workspace_id and workspace_generation.`);
  }
  if (args.workspace_id !== workspace.id) {
    await emitConflict(config, workspace, args, `workspace_id ${args.workspace_id} does not match ${workspace.id}.`);
    throw conflict(`workspace_id ${args.workspace_id} does not match the authoritative workspace ${workspace.id}.`);
  }
  if (!contract.workspace_generation_required) return { warning: null };
  const suppliedConversationId = typeof args.conversation_id === "string" ? args.conversation_id.trim() : "";
  if (!suppliedConversationId) {
    await emitConflict(config, workspace, args, `${contract.tool_name} requires conversation_id.`);
    throw conflict(`${contract.tool_name} requires explicit conversation_id, workspace_id, and workspace_generation.`);
  }
  if (!workspace.conversationId || suppliedConversationId !== workspace.conversationId) {
    await emitConflict(config, workspace, args, `conversation_id ${suppliedConversationId} does not match ${workspace.conversationId ?? "an authoritative conversation binding"}.`);
    throw conflict(`conversation_id ${suppliedConversationId} does not match the authoritative conversation binding.`);
  }
  if (!['conversation_binding', 'workspace_binding', 'task_binding'].includes(workspace.authoritySource ?? '')) {
    await emitConflict(config, workspace, args, `${contract.tool_name} resolved workspace authority from ${workspace.authoritySource ?? "an unbound source"}.`);
    throw conflict(`${contract.tool_name} requires a conversation-bound or immutable task-bound workspace before side effects.`);
  }
  const suppliedGeneration = Number(args.workspace_generation);
  if (!Number.isInteger(suppliedGeneration) || suppliedGeneration < 1) {
    await emitConflict(config, workspace, args, `${contract.tool_name} requires workspace_generation.`);
    throw conflict(`${contract.tool_name} requires explicit workspace_generation.`);
  }
  const authoritativeGeneration = workspace.workspaceGeneration;
  if (!authoritativeGeneration || suppliedGeneration !== authoritativeGeneration) {
    await emitConflict(config, workspace, args, `generation ${suppliedGeneration} does not match ${authoritativeGeneration ?? "unknown"}.`);
    throw conflict(`stale workspace generation: expected ${authoritativeGeneration ?? "a conversation-bound generation"}, received ${suppliedGeneration}.`);
  }

  const taskId = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : null;
  if (taskId) {
    const identity = await new TaskIdentityStore(new PathGuard(config), workspace).load(taskId).catch(() => undefined);
    const binding = identity?.workspace_binding;
    if (binding && (
      binding.workspace_id !== workspace.id
      || binding.workspace_generation !== suppliedGeneration
      || binding.source_conversation_id !== suppliedConversationId
      || !sameRoot(binding.workspace_root, workspace.root)
    )) {
      await emitConflict(config, workspace, args, `task ${taskId} has another immutable workspace binding.`);
      throw conflict(`task ${taskId} is immutably bound to ${binding.workspace_id}@${binding.workspace_generation}.`);
    }
  }
  return { warning: null };
}
