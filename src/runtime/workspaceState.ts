import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function expandHome(value: string): string {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const requested = path.resolve(workspaceRoot || process.cwd());
  let resolved = requested;
  try {
    resolved = fs.realpathSync.native(requested);
  } catch {
    // A not-yet-created workspace still needs a deterministic runtime-state key.
  }
  const normalized = resolved.split(path.sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function runtimeStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEXPRO_RUNTIME_STATE_DIR?.trim();
  return path.resolve(expandHome(configured || path.join(os.homedir(), ".codexpro", "runtime-state")));
}

export function workspaceRuntimeStateId(workspaceRoot: string): string {
  return createHash("sha256").update(canonicalWorkspaceRoot(workspaceRoot)).digest("hex").slice(0, 32);
}

export function workspaceRuntimeStateRoot(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(runtimeStateRoot(env), "workspaces", workspaceRuntimeStateId(workspaceRoot));
}

export function workspaceRuntimeStatePath(
  workspaceRoot: string,
  ...segments: string[]
): string {
  return path.join(workspaceRuntimeStateRoot(workspaceRoot), ...segments);
}
