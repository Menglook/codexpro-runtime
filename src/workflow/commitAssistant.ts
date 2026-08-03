import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { buildGitPrepare } from "./gitWorkflow.js";

export interface CommitAssistantResult {
  deprecated: true;
  replacement: "git_prepare";
  removal_target: "1.0.0";
  changed_files: string[];
  recommended_files: string[];
  risk_files: string[];
  untracked_files: string[];
  suggested_add: string[];
  suggested_commit_message: string;
  suggested_commands: string[];
  commit_flow_allowed: boolean;
  commit_flow_blockers: string[];
  text: string;
}

export function buildCommitAssistant(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: { includeUntracked?: boolean } = {}): CommitAssistantResult {
  const result = buildGitPrepare(config, guard, workspace, {
    includeUntracked: options.includeUntracked,
    validationStatus: "unknown",
    validationSummary: "Legacy commit_assistant call did not supply validation results.",
    userIntent: "",
    includePush: true
  });
  return {
    deprecated: true,
    replacement: "git_prepare",
    removal_target: "1.0.0",
    changed_files: result.changed_files,
    recommended_files: result.recommended_files,
    risk_files: result.risk_files,
    untracked_files: result.groups.untracked.map((entry) => entry.path),
    suggested_add: result.suggested_add,
    suggested_commit_message: result.suggested_commit_message,
    suggested_commands: result.suggested_commands,
    commit_flow_allowed: result.commit_flow_allowed,
    commit_flow_blockers: result.commit_flow_blockers,
    text: result.text.replace(
      "# Git Prepare",
      "# Commit Assistant\n\nDeprecated alias for `git_prepare`. Removal target: CodexPro 1.0.0. Commit/push commands require validation_status=pass and workspace safety checks; user wording is informational and does not block preparation."
    )
  };
}
