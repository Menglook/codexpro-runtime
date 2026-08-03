import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { TOOL_LIMITS } from "../tools/toolLimits.js";
import { gitFinalizeInputSchema, gitPushOnlyInputSchema } from "./git-terminal-tool-schema.js";
import { gitFinalize, gitPushOnly } from "../workflow/gitFinalize.js";
import { buildGitPrepare, buildGitSummary, type GitValidationStatus } from "../workflow/gitWorkflow.js";
import { gitCommitExact, gitGetRemoteState, gitPrepareCommit, gitPushExact } from "../workflow/gitContractTools.js";

export type GitToolSafety = "read" | "run";

export interface GitToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface GitToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: GitToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<GitToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function workspaceGenerationArg(): z.ZodOptional<z.ZodNumber> {
  return z.number().int().min(1).optional().describe("Authoritative workspace generation returned by open_current_workspace/open_workspace.");
}

function validationStatusArg(): z.ZodOptional<z.ZodEnum<["pass", "fail", "unknown"]>> {
  return z.enum(["pass", "fail", "unknown"]).optional().describe("Pre-commit validation status. Use pass only after build/smoke/release-gate or equivalent checks passed. Default: unknown.");
}

function structuredWithoutText<T extends { text: string }>(value: T): Omit<T, "text"> {
  const { text: _text, ...rest } = value;
  return rest;
}

const GIT_FINALIZE_ARGUMENTS = new Set([
  "conversation_id",
  "workspace_id",
  "workspace_generation",
  "user_intent",
  "selected_paths",
  "include_untracked",
  "commit_message",
  "expected_paths",
  "security_mode",
  "include_push"
]);

function assertKnownGitFinalizeArguments(args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((key) => !GIT_FINALIZE_ARGUMENTS.has(key)).sort();
  if (unknown.length) throw new CodexProError(`Unknown arguments for git_finalize: ${unknown.join(", ")}.`);
}

export function gitToolNames(): string[] {
  return [
    "git_summary",
    "git_prepare_commit",
    "git_commit",
    "git_get_remote_state",
    "git_push",
    "git_prepare",
    "git_finalize",
    "git_push_only"
  ];
}

export function createGitTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): GitToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  return [
    {
      name: "git_summary",
      title: "Git Summary",
      description: "Summarize Git branch, staged changes, unstaged changes, untracked files, risk files, and diff stats without preparing commit commands.",
      inputSchema: {
        workspace_id: workspaceArg()
      },
      safety: "read",
      invoking: "Summarizing Git state...",
      invoked: "Git summary ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = buildGitSummary(config, guard, workspace);
        return {
          text: result.text,
          structured: {
            workspace_id: workspace.id,
            root: workspace.root,
            ...structuredWithoutText(result)
          }
        };
      }
    },
    {
      name: "git_prepare_commit",
      title: "准备真实提交",
      description: "Read the exact current change set, bind it to the current HEAD and validation evidence, and report blockers. This tool never stages, commits, or pushes.",
      inputSchema: {
        workspace_id: workspaceArg(),
        workspace_generation: workspaceGenerationArg(),
        selected_paths: z.array(z.string().min(1)).min(1).max(TOOL_LIMITS.git.max_selected_paths).optional().describe("Exact changed file paths to prepare. Default: every current changed path."),
        validation_refs: z.array(z.string().min(1)).min(1).max(TOOL_LIMITS.git.max_validation_refs).describe("Validation, Acceptance, browser, run, event, or workspace-relative evidence references."),
        commit_message: z.string().min(1).max(TOOL_LIMITS.git.max_prepare_commit_message_chars).optional().describe("Proposed commit message; no commit is executed.")
      },
      safety: "read",
      invoking: "Preparing an exact Git commit contract...",
      invoked: "Git commit contract prepared",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = gitPrepareCommit(config, guard, workspace, {
          selectedPaths: args.selected_paths,
          validationRefs: args.validation_refs,
          commitMessage: args.commit_message
        });
        return { text: result.summary, structured: { workspace_id: workspace.id, root: workspace.root, ...result } };
      }
    },
    {
      name: "git_commit",
      title: "创建真实提交",
      description: "Run a secret safety scan, stage only the exact selected paths, reject stale HEAD/branch or unrelated staged files, create one real commit, and verify the committed path set. This tool never pushes.",
      inputSchema: {
        workspace_id: workspaceArg(),
        workspace_generation: workspaceGenerationArg(),
        selected_paths: z.array(z.string().min(1)).min(1).max(TOOL_LIMITS.git.max_selected_paths).describe("Exact changed file paths to stage and commit."),
        expected_head_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).describe("Full HEAD SHA returned by git_prepare_commit."),
        expected_branch: z.string().min(1).max(255).describe("Branch returned by git_prepare_commit."),
        commit_message: z.string().min(1).max(TOOL_LIMITS.git.max_prepare_commit_message_chars).describe("Exact commit message."),
        validation_refs: z.array(z.string().min(1)).min(1).max(TOOL_LIMITS.git.max_validation_refs).describe("Validation evidence references previously checked by git_prepare_commit."),
        authorization_ref: z.string().min(1).max(500).describe("Reference to the explicit user or task authorization for this commit.")
      },
      safety: "run",
      invoking: "Creating an exact Git commit...",
      invoked: "Exact Git commit finished",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = await gitCommitExact(config, guard, workspace, {
          selectedPaths: args.selected_paths,
          expectedHeadSha: args.expected_head_sha,
          expectedBranch: args.expected_branch,
          commitMessage: args.commit_message,
          validationRefs: args.validation_refs
        });
        return { text: result.summary, structured: { workspace_id: workspace.id, root: workspace.root, authorization_ref: args.authorization_ref, ...result } };
      }
    },
    {
      name: "git_get_remote_state",
      title: "核对 Git 远端状态",
      description: "Read the exact local HEAD and remote branch head and calculate ahead/behind state without modifying the repository or remote.",
      inputSchema: {
        workspace_id: workspaceArg(),
        workspace_generation: workspaceGenerationArg(),
        remote: z.string().min(1).max(100).optional().describe("Remote name. Default: origin."),
        branch: z.string().min(1).max(255).optional().describe("Branch name. Default: current branch.")
      },
      safety: "read",
      invoking: "Reading exact Git remote state...",
      invoked: "Git remote state ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = gitGetRemoteState(config, workspace, { remote: args.remote, branch: args.branch });
        return { text: `Local ${result.local_head_sha}; remote ${result.remote_head_sha ?? "not created"}; ahead=${result.ahead ?? "unknown"}; behind=${result.behind ?? "unknown"}.`, structured: { workspace_id: workspace.id, root: workspace.root, ...result } };
      }
    },
    {
      name: "git_push",
      title: "推送精确提交",
      description: "Push exactly one full commit SHA to one named remote branch, reject unexpected remote advancement or non-fast-forward state, forbid force, and verify the remote SHA after push.",
      inputSchema: {
        workspace_id: workspaceArg(),
        workspace_generation: workspaceGenerationArg(),
        commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).describe("Exact full commit SHA to push."),
        branch: z.string().min(1).max(255).describe("Exact target branch."),
        remote: z.string().min(1).max(100).optional().describe("Remote name. Default: origin."),
        expected_remote_sha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().describe("Remote SHA observed before authorization, or null when the branch did not exist."),
        authorization_ref: z.string().min(1).max(500).describe("Reference to the explicit user or task authorization for this push.")
      },
      safety: "run",
      invoking: "Pushing and verifying one exact Git commit...",
      invoked: "Exact Git push finished",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = gitPushExact(config, workspace, {
          commitSha: args.commit_sha,
          branch: args.branch,
          remote: args.remote || "origin",
          expectedRemoteSha: args.expected_remote_sha
        });
        return { text: result.summary, structured: { workspace_id: workspace.id, root: workspace.root, authorization_ref: args.authorization_ref, ...result } };
      }
    },
    {
      name: "git_prepare",
      title: "Git Prepare",
      description: "Prepare an approval-gated Git workflow. It only suggests exact git add / commit / push commands when validation_status=pass and the workspace safety checks pass; user_intent is recorded for observability but is not an authorization gate. It never runs git commit or git push.",
      inputSchema: {
        workspace_id: workspaceArg(),
        workspace_generation: workspaceGenerationArg(),
        include_untracked: z.boolean().optional().describe("Include untracked files in recommended commit candidates. Default: true."),
        validation_status: validationStatusArg(),
        validation_summary: z.string().optional().describe("Brief validation summary, such as npm run build/smoke/release-gate results."),
        user_intent: z.string().optional().describe("Original user wording. User wording is recorded for observability. It does not block command preparation after validation_status=pass."),
        include_push: z.boolean().optional().describe("Include git push in suggested commands when policy allows commit flow. Default: true.")
      },
      safety: "read",
      invoking: "Preparing Git workflow...",
      invoked: "Git workflow ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = buildGitPrepare(config, guard, workspace, {
          includeUntracked: args.include_untracked !== false,
          validationStatus: args.validation_status as GitValidationStatus | undefined,
          validationSummary: args.validation_summary,
          userIntent: args.user_intent,
          includePush: args.include_push !== false
        });
        return {
          text: result.text,
          structured: {
            workspace_id: workspace.id,
            root: workspace.root,
            ...structuredWithoutText(result)
          }
        };
      }
    },
    {
      name: "git_finalize",
      title: "Git Finalize",
      description: "Precisely finalize Git changes after a scoped release safety check: merge selected_paths with authoritative expected_paths so omitted task outputs are still eligible, include explicitly named untracked files without a second hidden switch, exclude unrelated untracked files, block missing or extra paths before creating a local commit, create and validate a content-bound security receipt, block sensitive paths or unsafe/incomplete scans, verify the committed path set again, and optionally push the exact commit. Build, tests, browser validation, Acceptance, and formal certification are not rerun.",
      inputSchema: gitFinalizeInputSchema(),
      safety: "run",
      invoking: "Committing and pushing current Git changes...",
      invoked: "Git finalization finished",
      async handler(args) {
        assertKnownGitFinalizeArguments(args ?? {});
        const workspace = workspaceFor(args);
        const result = await gitFinalize(config, guard, workspace, {
          userIntent: args.user_intent,
          selectedPaths: args.selected_paths,
          includeUntracked: args.include_untracked,
          commitMessage: args.commit_message,
          expectedPaths: args.expected_paths,
          securityMode: args.security_mode,
          includePush: args.include_push
        });
        return {
          text: result.text,
          structured: {
            workspace_id: workspace.id,
            root: workspace.root,
            ...structuredWithoutText(result)
          }
        };
      }
    },
    {
      name: "git_push_only",
      title: "Git Push Only",
      description: "Push an already-created local commit exactly once without staging, committing, rerunning Acceptance, or requiring a clean workspace. Requires explicit push-only intent; failure returns the original Git error and a manual command.",
      inputSchema: gitPushOnlyInputSchema(),
      safety: "run",
      invoking: "Pushing existing Git commit...",
      invoked: "Git push finished",
      async handler(args) {
        const workspace = workspaceFor(args);
        const result = await gitPushOnly(config, workspace, { userIntent: args.user_intent }, guard);
        return {
          text: result.text,
          structured: {
            workspace_id: workspace.id,
            root: workspace.root,
            ...structuredWithoutText(result)
          }
        };
      }
    }
  ];
}
