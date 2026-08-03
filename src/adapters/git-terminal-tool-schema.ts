import { z } from "zod";
import { TOOL_LIMITS } from "../tools/toolLimits.js";

export type GitTerminalToolName = "git_finalize" | "git_push_only";

export interface GitTerminalToolSchemaEntry {
  name: GitTerminalToolName;
  inputSchema: Record<string, z.ZodTypeAny>;
  requiredArguments: readonly string[];
  optionalArguments: readonly string[];
}

const conversationId = z.string().min(1).optional().describe("Authoritative Connector conversation id. CodexPro auto-binds this from the resolved conversation/workspace authority when omitted.");
const workspaceId = z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
const workspaceGeneration = z.number().int().min(1).optional().describe("Authoritative workspace generation returned by open_current_workspace/open_workspace.");

const GIT_FINALIZE_INPUT_SCHEMA: Record<string, z.ZodTypeAny> = Object.freeze({
  conversation_id: conversationId,
  workspace_id: workspaceId,
  workspace_generation: workspaceGeneration,
  user_intent: z.string().min(1).describe("Original user wording that explicitly requests commit, and push when include_push=true."),
  selected_paths: z.array(z.string().min(1)).max(TOOL_LIMITS.git.max_selected_paths).optional().describe("Workspace-relative candidate paths eligible for this commit. Explicitly selected untracked paths are eligible automatically. When expected_paths is also provided, both lists are merged so expected task outputs omitted here can still be included."),
  include_untracked: z.boolean().optional().describe("Legacy compatibility flag. Explicitly named untracked paths in selected_paths or expected_paths are eligible without this flag; unrelated untracked paths are never selected implicitly."),
  commit_message: z.string().max(TOOL_LIMITS.git.max_commit_message_chars).optional().describe("Optional commit subject. When provided, it is passed to Git unchanged."),
  expected_paths: z.array(z.string().min(1)).max(TOOL_LIMITS.git.max_expected_paths).optional().describe("Authoritative exact paths expected in the new commit. These paths are merged into the eligible scope even when selected_paths omitted them. Missing or extra candidates block before a local commit and committed paths are checked again afterward."),
  security_mode: z.enum(["incremental", "full"]).optional().describe("Security evidence mode for push. Local commits always use a bounded candidate-path scan. Default push mode: incremental; a missing baseline defers push instead of running a synchronous full scan. Explicit full mode retains the release-grade gate."),
  include_push: z.boolean().optional().describe("Push after commit. Defaults to whether user_intent explicitly includes push.")
});

const GIT_PUSH_ONLY_INPUT_SCHEMA: Record<string, z.ZodTypeAny> = Object.freeze({
  conversation_id: conversationId,
  workspace_id: workspaceId,
  workspace_generation: workspaceGeneration,
  user_intent: z.string().min(1).describe("Original user wording that explicitly requests push or retry push.")
});

const GIT_TERMINAL_TOOL_SCHEMA_ENTRIES: readonly GitTerminalToolSchemaEntry[] = Object.freeze([
  Object.freeze({
    name: "git_finalize" as const,
    inputSchema: GIT_FINALIZE_INPUT_SCHEMA,
    requiredArguments: Object.freeze(["user_intent"]),
    optionalArguments: Object.freeze(["conversation_id", "workspace_id", "workspace_generation", "selected_paths", "include_untracked", "commit_message", "expected_paths", "security_mode", "include_push"])
  }),
  Object.freeze({
    name: "git_push_only" as const,
    inputSchema: GIT_PUSH_ONLY_INPUT_SCHEMA,
    requiredArguments: Object.freeze(["user_intent"]),
    optionalArguments: Object.freeze(["conversation_id", "workspace_id", "workspace_generation"])
  })
]);

export function gitFinalizeInputSchema(): Record<string, z.ZodTypeAny> {
  return GIT_FINALIZE_INPUT_SCHEMA;
}

export function gitPushOnlyInputSchema(): Record<string, z.ZodTypeAny> {
  return GIT_PUSH_ONLY_INPUT_SCHEMA;
}

export function gitTerminalToolSchemaEntries(): readonly GitTerminalToolSchemaEntry[] {
  return GIT_TERMINAL_TOOL_SCHEMA_ENTRIES;
}
