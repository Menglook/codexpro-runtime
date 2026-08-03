import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_DEPENDENCY_PATHS = [
  ".bin/tsc",
  "typescript/package.json",
  "@types/node/package.json",
  "zod/package.json",
  "yaml/package.json"
];

function gitCommonDirectory(controlRoot) {
  const run = (args) => execFileSync("git", args, {
    cwd: controlRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  try {
    return path.resolve(run(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    return path.resolve(controlRoot, run(["rev-parse", "--git-common-dir"]));
  }
}

function existingDirectory(target) {
  try {
    return fsSync.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function resolveGoldTaskDependencyRoot(controlRoot) {
  const candidates = [{
    source: "control_root",
    root: path.join(controlRoot, "node_modules")
  }];
  try {
    const commonDirectory = gitCommonDirectory(controlRoot);
    candidates.push({
      source: "git_common_dir",
      root: path.join(path.dirname(commonDirectory), "node_modules")
    });
  } catch {
    // A clear dependency error is raised below when no candidate exists.
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (existingDirectory(resolved)) return { ...candidate, root: resolved };
  }
  return null;
}

export async function prepareGoldTaskDependencies(controlRoot, worktreePath) {
  const resolved = resolveGoldTaskDependencyRoot(controlRoot);
  if (!resolved) {
    throw new Error(
      "Gold Task dependencies are unavailable. Install node_modules in the control root or primary Git worktree before prepare."
    );
  }

  const dependencyLink = path.join(worktreePath, "node_modules");
  if (fsSync.existsSync(dependencyLink)) {
    const [existingRealPath, dependencyRealPath] = await Promise.all([
      fs.realpath(dependencyLink),
      fs.realpath(resolved.root)
    ]);
    if (existingRealPath !== dependencyRealPath) {
      throw new Error(`Gold Task worktree already contains a different node_modules target: ${dependencyLink}.`);
    }
  } else {
    await fs.symlink(resolved.root, dependencyLink, "dir");
  }

  const missing = [];
  for (const relativePath of REQUIRED_DEPENDENCY_PATHS) {
    const target = path.join(dependencyLink, ...relativePath.split("/"));
    try {
      const mode = relativePath === ".bin/tsc"
        ? fsSync.constants.R_OK | fsSync.constants.X_OK
        : fsSync.constants.R_OK;
      await fs.access(target, mode);
    } catch {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Gold Task dependency preflight failed; missing: ${missing.join(", ")}.`);
  }

  return {
    source: resolved.source,
    dependency_root: resolved.root,
    dependency_link: "node_modules",
    verified_paths: [...REQUIRED_DEPENDENCY_PATHS]
  };
}
