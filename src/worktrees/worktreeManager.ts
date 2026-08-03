import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { expandHome } from "../config.js";
import { CodexProError, isSubpath, normalizeRelPath, type PathGuard, type Workspace } from "../guard.js";
import { runProcessSync } from "../runtime/processWrapper.js";
import { partitionAcceptanceChangedFiles } from "../workflow/acceptanceProfile.js";
import type {
  CreateWorktreeInput,
  MainWorkspaceBaselineComparison,
  MainWorkspaceBaselineV1,
  MainWorkspaceUntrackedFileV1,
  ManagedWorktreeRecord,
  WorktreeCleanupResult,
  WorktreeIndex,
  WorktreeWriterLease
} from "./types.js";

const INDEX_PATH = ".codexpro-local/worktrees.json";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function safeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) throw new CodexProError(`Invalid ${label}: ${value}`);
  return trimmed;
}

function safeSlug(value: string | undefined): string {
  const normalized = (value ?? "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || "task";
}

function safeRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new CodexProError(`Invalid git revision: ${value}`);
  }
  return trimmed;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeAllowedPath(value: string, guard: PathGuard): string {
  const normalized = normalizeRelPath(value.trim().replace(/^\.\//, ""));
  if (!normalized || path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) {
    throw new CodexProError(`Allowed path escapes the worktree: ${value}`);
  }
  guard.assertNotBlocked(normalized);
  return normalized;
}

function parseChangedFiles(status: string): string[] {
  const files: string[] = [];
  for (const raw of status.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const value = raw.slice(3).trim();
    const file = value.includes(" -> ") ? value.split(" -> ").at(-1)?.trim() ?? value : value;
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

export interface WorktreeCreationWorkspaceState {
  tracked_changes: string[];
  untracked_files: string[];
}

export function classifyWorktreeCreationStatus(status: string): WorktreeCreationWorkspaceState {
  const trackedChanges: string[] = [];
  const untrackedFiles: string[] = [];
  for (const raw of status.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const value = raw.slice(3).trim();
    const file = value.includes(" -> ") ? value.split(" -> ").at(-1)?.trim() ?? value : value;
    if (!file) continue;
    const target = code === "??" ? untrackedFiles : trackedChanges;
    if (!target.includes(file)) target.push(file);
  }
  return {
    tracked_changes: trackedChanges.sort(),
    untracked_files: untrackedFiles.sort()
  };
}

const MAX_BASELINE_HASH_BYTES = 4 * 1024 * 1024;

function snapshotUntrackedFile(root: string, relativePath: string): MainWorkspaceUntrackedFileV1 {
  const target = path.resolve(root, relativePath);
  try {
    const stat = fs.lstatSync(target);
    const contentHash = stat.isFile() && stat.size <= MAX_BASELINE_HASH_BYTES
      ? createHash("sha256").update(fs.readFileSync(target)).digest("hex")
      : null;
    return {
      path: relativePath,
      size: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs),
      content_hash: contentHash
    };
  } catch {
    return { path: relativePath, size: -1, mtime_ms: -1, content_hash: null };
  }
}

function baselineComparable(value: MainWorkspaceBaselineV1): Record<string, unknown> {
  return {
    head: value.head,
    tracked_changes: value.tracked_changes,
    untracked_files: value.untracked_files
  };
}

function baselineId(value: Omit<MainWorkspaceBaselineV1, "baseline_id">): string {
  return `workspace-baseline-${createHash("sha256").update(JSON.stringify(baselineComparable({ ...value, baseline_id: "" }))).digest("hex").slice(0, 24)}`;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WorktreeManager {
  readonly managedRoot: string;
  readonly projectId: string;
  readonly indexPath: string;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace
  ) {
    this.managedRoot = path.resolve(expandHome(config.codexWorktreeRoot || path.join(os.homedir(), ".codexpro", "worktrees")));
    const base = path.basename(workspace.root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    const digest = createHash("sha256").update(workspace.root).digest("hex").slice(0, 10);
    this.projectId = `${base}-${digest}`;
    this.indexPath = path.join(workspace.root, INDEX_PATH);
    if (isSubpath(this.managedRoot, workspace.root) || isSubpath(workspace.root, this.managedRoot)) {
      throw new CodexProError("Managed worktree root must be outside the project workspace.");
    }
  }

  async create(input: CreateWorktreeInput): Promise<ManagedWorktreeRecord> {
    return await this.serialize(async () => {
      this.assertEnabled();
      const goalId = safeId(input.goal_id, "goal_id");
      const agentId = safeId(input.agent_id, "agent_id");
      const allowedPaths = unique(input.allowed_paths.map((item) => normalizeAllowedPath(item, this.guard)));
      if (!allowedPaths.length) throw new CodexProError("A writable worktree requires at least one allowed path.");
      this.assertIndexIgnored();
      const before = this.captureMainWorkspaceBaseline();
      if (before.tracked_changes.length > 0) {
        throw new CodexProError(`Tracked changes blocked worktree creation: ${before.tracked_changes.join(", ")}. Commit, stash, or revert them first.`);
      }

      const index = await this.loadIndex();
      const existing = index.worktrees.find((record) => record.goal_id === goalId && record.status !== "removed");
      if (existing) throw new CodexProError(`Goal ${goalId} already owns managed worktree ${existing.path}.`);

      const baseCommit = this.resolveCommit(input.base_ref ?? "HEAD");
      const branch = `codexpro/${goalId}-${safeSlug(input.slug)}`;
      const worktreePath = path.join(this.managedRoot, this.projectId, goalId, agentId);
      this.assertManagedPath(worktreePath);
      if (fs.existsSync(worktreePath)) throw new CodexProError(`Managed worktree path already exists: ${worktreePath}`);
      await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
      this.runGit(["worktree", "add", "-b", branch, worktreePath, baseCommit], this.workspace.root);

      const now = new Date().toISOString();
      const record: ManagedWorktreeRecord = {
        version: 1,
        project_id: this.projectId,
        project_root: this.workspace.root,
        goal_id: goalId,
        agent_id: agentId,
        path: worktreePath,
        branch,
        base_commit: baseCommit,
        created_at: now,
        updated_at: now,
        status: "active",
        allowed_paths: allowedPaths,
        has_uncommitted_changes: false,
        changed_files: [],
        writer_lease: null,
        main_workspace_baseline: before
      };
      index.worktrees.push(record);
      await this.writeIndex(index);

      const creationComparison = this.compareMainWorkspaceBaseline(before);
      if (!creationComparison.unchanged) {
        await this.markRetained(index, record, `Main workspace changed during worktree creation: ${creationComparison.reasons.join("; ")}`);
        throw new CodexProError("Main workspace changed during worktree creation; the worktree was retained for manual inspection.");
      }
      return { ...record };
    });
  }

  async list(options: { include_removed?: boolean } = {}): Promise<ManagedWorktreeRecord[]> {
    return await this.serialize(async () => {
      const index = await this.loadIndex();
      let changed = false;
      for (const record of index.worktrees) {
        if (record.status === "removed") continue;
        const refreshed = this.refreshRecord(record);
        if (JSON.stringify(refreshed) !== JSON.stringify(record)) {
          Object.assign(record, refreshed);
          changed = true;
        }
      }
      if (changed) await this.writeIndex(index);
      return index.worktrees
        .filter((record) => options.include_removed || record.status !== "removed")
        .map((record) => ({ ...record, allowed_paths: [...record.allowed_paths], changed_files: [...record.changed_files] }));
    });
  }

  async get(goalId: string, agentId?: string): Promise<ManagedWorktreeRecord> {
    const safeGoal = safeId(goalId, "goal_id");
    const safeAgent = agentId ? safeId(agentId, "agent_id") : undefined;
    const records = await this.list({ include_removed: true });
    const record = records.find((item) => item.goal_id === safeGoal && (!safeAgent || item.agent_id === safeAgent));
    if (!record) throw new CodexProError(`Managed worktree not found for Goal ${safeGoal}${safeAgent ? ` and agent ${safeAgent}` : ""}.`);
    return record;
  }

  async acquireWriter(goalId: string, agentId: string, owner: string): Promise<ManagedWorktreeRecord> {
    return await this.serialize(async () => {
      const index = await this.loadIndex();
      const record = this.findRecord(index, goalId, agentId);
      Object.assign(record, this.refreshRecord(record));
      if (record.status !== "active") throw new CodexProError(`Worktree ${record.path} is not active; current status is ${record.status}.`);
      const lease = record.writer_lease;
      if (lease && processAlive(lease.pid)) {
        throw new CodexProError(`Worktree already has active writer ${lease.owner} (pid ${lease.pid}).`);
      }
      const baseline = record.main_workspace_baseline ?? this.captureMainWorkspaceBaseline();
      const comparison = this.compareMainWorkspaceBaseline(baseline);
      if (!comparison.unchanged) {
        throw new CodexProError(`Main workspace changed since worktree creation: ${comparison.reasons.join("; ")}`);
      }
      record.main_workspace_baseline = baseline;
      record.writer_lease = { owner: safeId(owner, "writer owner"), pid: process.pid, acquired_at: new Date().toISOString() };
      record.updated_at = new Date().toISOString();
      await this.writeIndex(index);
      return { ...record, allowed_paths: [...record.allowed_paths], changed_files: [...record.changed_files] };
    });
  }

  async releaseWriter(goalId: string, agentId: string, owner: string): Promise<ManagedWorktreeRecord> {
    return await this.serialize(async () => {
      const index = await this.loadIndex();
      const record = this.findRecord(index, goalId, agentId);
      if (record.writer_lease && record.writer_lease.owner !== owner) {
        throw new CodexProError(`Writer lease belongs to ${record.writer_lease.owner}, not ${owner}.`);
      }
      record.writer_lease = null;
      Object.assign(record, this.refreshRecord(record));
      record.updated_at = new Date().toISOString();
      await this.writeIndex(index);
      return { ...record, allowed_paths: [...record.allowed_paths], changed_files: [...record.changed_files] };
    });
  }

  async deliver(goalId: string, agentId: string): Promise<ManagedWorktreeRecord> {
    return await this.serialize(async () => {
      const index = await this.loadIndex();
      const record = this.findRecord(index, goalId, agentId);
      Object.assign(record, this.refreshRecord(record));
      if (record.writer_lease && processAlive(record.writer_lease.pid)) {
        throw new CodexProError(`Cannot deliver while writer ${record.writer_lease.owner} is active.`);
      }
      record.writer_lease = null;
      record.status = "delivered";
      record.delivered_at = new Date().toISOString();
      record.updated_at = record.delivered_at;
      await this.writeIndex(index);
      return { ...record, allowed_paths: [...record.allowed_paths], changed_files: [...record.changed_files] };
    });
  }

  async retain(goalId: string, agentId: string, reason: string): Promise<ManagedWorktreeRecord> {
    return await this.serialize(async () => {
      const index = await this.loadIndex();
      const record = this.findRecord(index, goalId, agentId);
      Object.assign(record, this.refreshRecord(record));
      record.status = "retained";
      record.retained_reason = reason.trim().slice(0, 2_000) || "Retained for manual inspection.";
      record.writer_lease = null;
      record.updated_at = new Date().toISOString();
      await this.writeIndex(index);
      return { ...record, allowed_paths: [...record.allowed_paths], changed_files: [...record.changed_files] };
    });
  }

  async cleanup(goalId: string, agentId: string, options: { dry_run?: boolean } = {}): Promise<WorktreeCleanupResult> {
    return await this.serialize(async () => {
      const dryRun = options.dry_run !== false;
      const index = await this.loadIndex();
      const record = this.findRecord(index, goalId, agentId);
      Object.assign(record, this.refreshRecord(record));
      const reason = this.cleanupBlocker(record);
      if (reason) return { ok: false, dry_run: dryRun, blocked: true, reason, record: { ...record } };
      if (dryRun) return { ok: true, dry_run: true, blocked: false, record: { ...record } };

      this.runGit(["worktree", "remove", record.path], this.workspace.root);
      record.status = "removed";
      record.removed_at = new Date().toISOString();
      record.updated_at = record.removed_at;
      record.writer_lease = null;
      await this.writeIndex(index);
      return { ok: true, dry_run: false, blocked: false, record: { ...record } };
    });
  }

  mainWorkspaceClean(): boolean {
    const current = this.captureMainWorkspaceBaseline();
    return current.tracked_changes.length === 0 && current.untracked_files.length === 0;
  }

  captureMainWorkspaceBaseline(): MainWorkspaceBaselineV1 {
    const state = this.worktreeCreationWorkspaceState();
    const captured: Omit<MainWorkspaceBaselineV1, "baseline_id"> = {
      version: 1,
      head: this.resolveCommit("HEAD"),
      tracked_changes: [...state.tracked_changes],
      untracked_files: state.untracked_files.map((file) => snapshotUntrackedFile(this.workspace.root, file)),
      captured_at: new Date().toISOString()
    };
    return { ...captured, baseline_id: baselineId(captured) };
  }

  compareMainWorkspaceBaseline(expected: MainWorkspaceBaselineV1): MainWorkspaceBaselineComparison {
    const current = this.captureMainWorkspaceBaseline();
    const reasons: string[] = [];
    if (current.head !== expected.head) reasons.push(`HEAD changed from ${expected.head} to ${current.head}`);
    if (JSON.stringify(current.tracked_changes) !== JSON.stringify(expected.tracked_changes)) {
      reasons.push(`tracked changes changed from [${expected.tracked_changes.join(", ")}] to [${current.tracked_changes.join(", ")}]`);
    }
    if (JSON.stringify(current.untracked_files) !== JSON.stringify(expected.untracked_files)) {
      reasons.push("untracked file set or fingerprint changed");
    }
    return { unchanged: reasons.length === 0, reasons, current };
  }

  worktreeCreationWorkspaceState(): WorktreeCreationWorkspaceState {
    const status = this.runGit(["status", "--porcelain=v1", "--untracked-files=all"], this.workspace.root);
    return classifyWorktreeCreationStatus(status);
  }

  pathAllowed(record: ManagedWorktreeRecord, changedPath: string): boolean {
    const normalized = normalizeRelPath(changedPath.replace(/^\.\//, ""));
    if (normalized === ".." || normalized.startsWith("../") || this.guard.isBlockedRelativePath(normalized)) return false;
    return record.allowed_paths.some((allowed) => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`));
  }

  private assertEnabled(): void {
    if (!this.config.codexWorktreesEnabled) {
      throw new CodexProError("Managed worktrees are disabled. Enable CODEXPRO_CODEX_WORKTREES first.");
    }
  }

  private assertIndexIgnored(): void {
    const result = runProcessSync("git", ["check-ignore", "-q", INDEX_PATH], {
      cwd: this.workspace.root,
      maxOutputBytes: 8_000,
      domain: "git",
      operation: "check-ignore",
      sideEffectLevel: "local_read",
      riskLevel: "low"
    });
    if (result.exitCode !== 0) {
      throw new CodexProError(`${INDEX_PATH} must be ignored by Git before managed worktrees can be created.`);
    }
  }

  private assertManagedPath(candidate: string): void {
    const resolved = path.resolve(candidate);
    if (!isSubpath(resolved, this.managedRoot) || isSubpath(resolved, this.workspace.root)) {
      throw new CodexProError(`Worktree path is outside the managed root or inside the project: ${resolved}`);
    }
  }

  private resolveCommit(ref: string): string {
    return this.runGit(["rev-parse", "--verify", "--end-of-options", `${safeRef(ref)}^{commit}`], this.workspace.root).trim();
  }

  private refreshRecord(record: ManagedWorktreeRecord): ManagedWorktreeRecord {
    if (record.status === "removed") return record;
    if (!fs.existsSync(record.path)) {
      const changed = record.status !== "missing"
        || record.has_uncommitted_changes
        || record.changed_files.length > 0
        || record.writer_lease !== null;
      return changed
        ? { ...record, status: "missing", has_uncommitted_changes: false, changed_files: [], writer_lease: null, updated_at: new Date().toISOString() }
        : record;
    }
    this.assertManagedPath(record.path);
    const status = this.runGit(["status", "--porcelain=v1", "--untracked-files=all"], record.path);
    const changedFiles = partitionAcceptanceChangedFiles(parseChangedFiles(status)).changed;
    const hasChanges = changedFiles.length > 0;
    const lease: WorktreeWriterLease | null = record.writer_lease && processAlive(record.writer_lease.pid) ? record.writer_lease : null;
    const changed = record.has_uncommitted_changes !== hasChanges
      || JSON.stringify(record.changed_files) !== JSON.stringify(changedFiles)
      || JSON.stringify(record.writer_lease) !== JSON.stringify(lease);
    return changed
      ? {
          ...record,
          has_uncommitted_changes: hasChanges,
          changed_files: changedFiles,
          writer_lease: lease,
          updated_at: new Date().toISOString()
        }
      : record;
  }

  private cleanupBlocker(record: ManagedWorktreeRecord): string | undefined {
    if (record.status === "removed") return "Worktree is already removed.";
    if (record.status === "missing") return "Worktree directory is missing; manual Git worktree repair is required.";
    if (record.status === "retained") return "Retained worktrees require explicit human resolution before cleanup.";
    if (record.status !== "delivered") return `Worktree must be delivered before cleanup; current status is ${record.status}.`;
    if (record.writer_lease && processAlive(record.writer_lease.pid)) return `Writer ${record.writer_lease.owner} is still active.`;
    if (record.has_uncommitted_changes) return "Worktree has uncommitted or untracked changes and cannot be cleaned automatically.";
    return undefined;
  }

  private async loadIndex(): Promise<WorktreeIndex> {
    try {
      const raw = await fsp.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as WorktreeIndex;
      if (parsed.version !== 1 || parsed.project_root !== this.workspace.root || !Array.isArray(parsed.worktrees)) {
        throw new CodexProError(`Invalid managed worktree index: ${this.indexPath}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        project_id: this.projectId,
        project_root: this.workspace.root,
        updated_at: new Date().toISOString(),
        worktrees: []
      };
    }
  }

  private async writeIndex(index: WorktreeIndex): Promise<void> {
    index.updated_at = new Date().toISOString();
    await fsp.mkdir(path.dirname(this.indexPath), { recursive: true });
    const temp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await fsp.rename(temp, this.indexPath);
  }

  private findRecord(index: WorktreeIndex, goalId: string, agentId: string): ManagedWorktreeRecord {
    const safeGoal = safeId(goalId, "goal_id");
    const safeAgent = safeId(agentId, "agent_id");
    const record = index.worktrees.find((item) => item.goal_id === safeGoal && item.agent_id === safeAgent && item.status !== "removed");
    if (!record) throw new CodexProError(`Managed worktree not found for Goal ${safeGoal} and agent ${safeAgent}.`);
    return record;
  }

  private async markRetained(index: WorktreeIndex, record: ManagedWorktreeRecord, reason: string): Promise<void> {
    record.status = "retained";
    record.retained_reason = reason;
    record.updated_at = new Date().toISOString();
    await this.writeIndex(index);
  }

  private runGit(args: string[], cwd: string): string {
    const result = runProcessSync("git", args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      maxOutputBytes: this.config.maxOutputBytes,
      domain: "git",
      operation: args[0] ?? "git",
      sideEffectLevel: args[0] === "worktree" ? "local_write" : "local_read",
      riskLevel: args[0] === "worktree" ? "medium" : "low"
    });
    if (result.spawnError) throw new CodexProError((result.stderr?.trim() || result.errorClass || "git spawn failed").slice(0, 8_000));
    if (result.exitCode !== 0) {
      throw new CodexProError((result.stderr?.trim() || result.stdout?.trim() || `git exited with ${result.exitCode}`).slice(0, 8_000));
    }
    return result.stdout ?? "";
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release: (() => void) | undefined;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
