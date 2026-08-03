import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
  /** Snapshot of the workspace authority at the time this context was resolved. */
  projectId?: string;
  workspaceGeneration?: number;
  activatedAt?: string;
  activatedBySessionId?: string;
  conversationId?: string;
  authoritySource?: "conversation_binding" | "workspace_binding" | "task_binding" | "explicit_workspace" | "global_active" | "default_root";
}

export interface ActiveWorkspaceStateV2 {
  version: 2;
  projectId: string;
  workspaceId: string;
  workspaceRoot: string;
  generation: number;
  activatedAt: string;
  activatedBySessionId?: string;
}

export class CodexProError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync(existingPath);
  } catch {
    return undefined;
  }
}

function defaultActiveWorkspaceFilePath(): string {
  const configuredHome = process.env.CODEXPRO_HOME?.trim();
  const codexProHome = configuredHome
    ? path.resolve(expandHome(configuredHome))
    : path.join(os.homedir(), ".codexpro");
  return path.join(codexProHome, "active-workspace");
}

export function activeWorkspaceFilePath(): string {
  const override = process.env.CODEXPRO_ACTIVE_WORKSPACE_FILE?.trim();
  return override ? path.resolve(expandHome(override)) : defaultActiveWorkspaceFilePath();
}

export function readActiveWorkspaceRoot(filePath = activeWorkspaceFilePath()): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return undefined;
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as Partial<ActiveWorkspaceStateV2>;
      if (parsed.version === 2 && typeof parsed.workspaceRoot === "string" && parsed.workspaceRoot.trim()) {
        return path.resolve(expandHome(parsed.workspaceRoot));
      }
    } catch {
      return undefined;
    }
  }
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? path.resolve(expandHome(firstLine)) : undefined;
}

export function readActiveWorkspaceState(filePath = activeWorkspaceFilePath()): ActiveWorkspaceStateV2 | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return undefined;
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as Partial<ActiveWorkspaceStateV2>;
      if (
        parsed.version === 2
        && typeof parsed.projectId === "string"
        && typeof parsed.workspaceId === "string"
        && typeof parsed.workspaceRoot === "string"
        && Number.isInteger(parsed.generation)
        && Number(parsed.generation) >= 1
        && typeof parsed.activatedAt === "string"
        && Number.isFinite(Date.parse(parsed.activatedAt))
      ) {
        return {
          version: 2,
          projectId: parsed.projectId,
          workspaceId: parsed.workspaceId,
          workspaceRoot: path.resolve(expandHome(parsed.workspaceRoot)),
          generation: Number(parsed.generation),
          activatedAt: parsed.activatedAt,
          ...(typeof parsed.activatedBySessionId === "string" && parsed.activatedBySessionId.trim()
            ? { activatedBySessionId: parsed.activatedBySessionId.trim() }
            : {})
        };
      }
    } catch {
      return undefined;
    }
  }
  const root = readActiveWorkspaceRoot(filePath);
  if (!root) return undefined;
  const realRoot = maybeRealpath(root) ?? root;
  return {
    version: 2,
    projectId: path.basename(realRoot) || "project",
    workspaceId: workspaceIdForRoot(realRoot),
    workspaceRoot: realRoot,
    generation: 1,
    activatedAt: new Date(fs.statSync(filePath).mtimeMs).toISOString()
  };
}

export function writeActiveWorkspaceRoot(root: string, filePath = activeWorkspaceFilePath()): void {
  const realRoot = fs.realpathSync(path.resolve(expandHome(root)));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${realRoot}\n`, "utf8");
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private activeWorkspaceId: string | undefined;

  constructor(private readonly config: CodexProConfig) {}

  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    return existing ?? this.openWorkspace(this.config.defaultRoot);
  }

  activeWorkspace(): Workspace | undefined {
    return this.activeWorkspaceId ? this.workspaces.get(this.activeWorkspaceId) : undefined;
  }

  activatePersistedWorkspaceIfAvailable(): Workspace | undefined {
    const state = readActiveWorkspaceState();
    if (!state) return undefined;
    try {
      const realRoot = fs.realpathSync(state.workspaceRoot);
      const active = this.activeWorkspace();
      if (active?.root === realRoot) return active;
      const workspace = this.openWorkspace(realRoot, { activate: true, persist: false });
      Object.assign(workspace, {
        projectId: state.projectId,
        workspaceGeneration: state.generation,
        activatedAt: state.activatedAt,
        activatedBySessionId: state.activatedBySessionId
      });
      return workspace;
    } catch {
      return undefined;
    }
  }

  private persistActiveWorkspace(workspace: Workspace): void {
    writeActiveWorkspaceRoot(workspace.root);
  }

  openWorkspace(rootInput?: string, options: { activate?: boolean; persist?: boolean } = {}): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new CodexProError(`Workspace root is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new CodexProError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) {
      if (options.activate) {
        this.activeWorkspaceId = existing.id;
        if (options.persist !== false) this.persistActiveWorkspace(existing);
      }
      return existing;
    }

    const id = workspaceIdForRoot(realRoot);
    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    this.workspaces.set(id, workspace);
    if (options.activate) {
      this.activeWorkspaceId = workspace.id;
      if (options.persist !== false) this.persistActiveWorkspace(workspace);
    }
    return workspace;
  }

  activateWorkspace(workspace: Workspace, options: { persist?: boolean } = {}): Workspace {
    this.workspaces.set(workspace.id, workspace);
    this.activeWorkspaceId = workspace.id;
    if (options.persist !== false) this.persistActiveWorkspace(workspace);
    return workspace;
  }

  restoreActiveWorkspace(workspace: Workspace | undefined): void {
    if (!workspace) {
      this.activeWorkspaceId = undefined;
      return;
    }
    this.workspaces.set(workspace.id, workspace);
    this.activeWorkspaceId = workspace.id;
  }

  getWorkspace(id?: string): Workspace {
    if (!id) return this.activeWorkspace() ?? this.defaultWorkspace();
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }
}

export class PathGuard {
  constructor(private readonly config: CodexProConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new CodexProError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new CodexProError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new CodexProError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof CodexProError) throw error;
      }
      const writeAnchor = fs.existsSync(absPath) ? absPath : path.dirname(absPath);
      const parent = closestExistingParent(writeAnchor);
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new CodexProError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(
    absPath: string,
    maxBytes: number,
    options: { allowLarger?: boolean } = {}
  ): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new CodexProError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes && !options.allowLarger) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      if (sample.subarray(0, bytesRead).includes(0)) {
        throw new CodexProError("Refusing to read binary file.");
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
