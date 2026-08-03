import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import { validateBrowserBusinessTask, type BrowserBusinessTask } from "./browser-business-contract.js";

export const BROWSER_BUSINESS_TASK_STORE = ".ai-bridge/browser-business-tasks";

function taskReferenceSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function browserBusinessTaskPath(taskId: string, runId: string): string {
  return `${BROWSER_BUSINESS_TASK_STORE}/${taskReferenceSegment(taskId)}/${taskReferenceSegment(runId)}.json`;
}

export async function persistBrowserBusinessTask(
  guard: PathGuard,
  workspace: Workspace,
  task: BrowserBusinessTask
): Promise<string> {
  const validated = validateBrowserBusinessTask(task);
  const relPath = browserBusinessTaskPath(validated.task_id, validated.run_id);
  const resolved = guard.resolve(workspace, relPath, { forWrite: true });
  await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  const temporary = `${resolved.absPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${JSON.stringify({ version: 1, task: validated }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, resolved.absPath);
  return relPath;
}

export async function loadPersistedBrowserBusinessTask(
  guard: PathGuard,
  workspace: Workspace,
  taskId: string,
  runId: string
): Promise<BrowserBusinessTask> {
  const relPath = browserBusinessTaskPath(taskId, runId);
  const resolved = guard.resolve(workspace, relPath);
  const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as { version?: unknown; task?: unknown };
  if (parsed.version !== 1) throw new Error(`Unsupported persisted browser business task version at ${relPath}.`);
  const task = validateBrowserBusinessTask(parsed.task);
  if (task.task_id !== taskId || task.run_id !== runId) {
    throw new Error("Persisted browser business task reference does not match the requested task_id/run_id.");
  }
  return task;
}
