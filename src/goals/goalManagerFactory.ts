import type { CodexProConfig } from "../config.js";
import type { CodexAdapter } from "../codex/types.js";
import type { PathGuard, Workspace } from "../guard.js";
import { GoalManager } from "./goalManager.js";

const sharedManagers = new Map<string, GoalManager>();

function managerKey(config: CodexProConfig, workspace: Workspace, adapter: CodexAdapter): string {
  return [
    config.defaultRoot,
    workspace.root,
    config.contextDir,
    config.writeMode,
    adapter.provider,
    config.codexExecutable,
    String(config.codexHooksEnabled),
    config.codexHookKitRoot,
    config.codexHookProfile ?? "",
    config.codexHookProjectName ?? "",
    config.codexHookWorklogDir
  ].join("\u0000");
}

export function getGoalManager(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  adapter: CodexAdapter
): GoalManager {
  const key = managerKey(config, workspace, adapter);
  const existing = sharedManagers.get(key);
  if (existing) return existing;
  const manager = new GoalManager(config, guard, workspace, adapter);
  sharedManagers.set(key, manager);
  return manager;
}
