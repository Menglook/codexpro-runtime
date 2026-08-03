import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { codexProEventBus } from "../events/eventBus.js";
import { gitCurrentBranch, gitHeadSha, gitStatus } from "../gitOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { statusChangedFiles } from "../workflow/dirtyGuard.js";

export type SessionNodeKind = "root" | "decision" | "attempt" | "checkpoint" | "result";
export type SessionNodeStatus = "active" | "succeeded" | "failed" | "abandoned" | "superseded";

export interface SessionExecutionBindings {
  git_sha?: string;
  branch?: string;
  worktree_path?: string;
  worktree_branch?: string;
  changed_files: string[];
  docker_summary?: string;
  browser_session_id?: string;
  browser_report_path?: string;
  acceptance_artifacts: string[];
  task_snapshot_id?: string;
  task_snapshot_dir?: string;
  goal_checkpoint_path?: string;
  database_checkpoint?: string;
}

export interface SessionRollbackSemantics {
  conversation_context_selected: boolean;
  files_restored: false;
  database_restored: false;
  browser_state_restored: false;
}

export interface SessionTreeNode {
  node_id: string;
  task_id: string;
  parent_node_id: string | null;
  kind: SessionNodeKind;
  label: string;
  summary: string;
  tags: string[];
  status: SessionNodeStatus;
  bindings: SessionExecutionBindings;
  rollback: SessionRollbackSemantics;
  created_at: string;
  updated_at: string;
}

export interface SessionTreeRecord {
  version: 1;
  task_id: string;
  title: string;
  root_node_id: string;
  active_node_id: string;
  nodes: SessionTreeNode[];
  created_at: string;
  updated_at: string;
}

export interface EnsureSessionTreeInput {
  task_id: string;
  title: string;
  summary?: string;
  bindings?: Partial<SessionExecutionBindings>;
  root_node_id?: string;
}

export interface AddSessionNodeInput {
  parent_node_id: string;
  kind: Exclude<SessionNodeKind, "root">;
  label: string;
  summary: string;
  tags?: string[];
  status?: SessionNodeStatus;
  bindings?: Partial<SessionExecutionBindings>;
  node_id?: string;
}

export interface SessionBranchComparison {
  task_id: string;
  node_ids: string[];
  common_ancestor_id: string | null;
  nodes: Array<{
    node_id: string;
    label: string;
    status: SessionNodeStatus;
    summary: string;
    tags: string[];
    git_sha?: string;
    branch?: string;
    worktree_path?: string;
    changed_files: string[];
    acceptance_artifacts: string[];
  }>;
  differences: {
    git_sha: boolean;
    branch: boolean;
    worktree: boolean;
    changed_files: boolean;
    acceptance_artifacts: boolean;
    status: boolean;
  };
}

export interface SessionActivationPlan {
  task_id: string;
  selected_node_id: string;
  rollback: SessionRollbackSemantics;
  current_bindings: SessionExecutionBindings;
  selected_bindings: SessionExecutionBindings;
  required_actions: string[];
  warning: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function assertId(value: string, label: string): string {
  const clean = value.trim();
  if (!SAFE_ID.test(clean)) throw new Error(`Invalid ${label}: ${value}`);
  return clean;
}

function text(value: string, max = 8_000): string {
  return redactSensitiveText(value).trim().slice(0, max);
}

function unique(values: string[] | undefined, limit = 500): string[] {
  return [...new Set((values ?? []).map((value) => text(String(value), 2_000)).filter(Boolean))].slice(0, limit);
}

function bindings(value: Partial<SessionExecutionBindings> = {}): SessionExecutionBindings {
  return {
    ...(value.git_sha ? { git_sha: text(value.git_sha, 200) } : {}),
    ...(value.branch ? { branch: text(value.branch, 500) } : {}),
    ...(value.worktree_path ? { worktree_path: path.resolve(value.worktree_path) } : {}),
    ...(value.worktree_branch ? { worktree_branch: text(value.worktree_branch, 500) } : {}),
    changed_files: unique(value.changed_files),
    ...(value.docker_summary ? { docker_summary: text(value.docker_summary, 4_000) } : {}),
    ...(value.browser_session_id ? { browser_session_id: text(value.browser_session_id, 300) } : {}),
    ...(value.browser_report_path ? { browser_report_path: text(value.browser_report_path, 2_000) } : {}),
    acceptance_artifacts: unique(value.acceptance_artifacts),
    ...(value.task_snapshot_id ? { task_snapshot_id: text(value.task_snapshot_id, 300) } : {}),
    ...(value.task_snapshot_dir ? { task_snapshot_dir: text(value.task_snapshot_dir, 2_000) } : {}),
    ...(value.goal_checkpoint_path ? { goal_checkpoint_path: text(value.goal_checkpoint_path, 2_000) } : {}),
    ...(value.database_checkpoint ? { database_checkpoint: text(value.database_checkpoint, 2_000) } : {})
  };
}

function rollback(selected = false): SessionRollbackSemantics {
  return {
    conversation_context_selected: selected,
    files_restored: false,
    database_restored: false,
    browser_state_restored: false
  };
}

function sameList(left: string[], right: string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

export function captureSessionBindings(
  config: CodexProConfig,
  workspace: Workspace,
  extra: Partial<SessionExecutionBindings> = {}
): SessionExecutionBindings {
  const sha = gitHeadSha(config, workspace);
  const branch = gitCurrentBranch(config, workspace);
  return bindings({
    git_sha: /^git unavailable|^fatal:|^git exited/i.test(sha) ? undefined : sha,
    branch: /^git unavailable|^fatal:|^git exited/i.test(branch) ? undefined : branch,
    changed_files: statusChangedFiles(gitStatus(config, workspace)),
    ...extra
  });
}

export class SessionTreeStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    readonly workspace: Workspace
  ) {}

  root(): string {
    return ".codexpro/session-trees";
  }

  treePath(taskId: string): string {
    return `${this.root()}/${assertId(taskId, "task id")}/tree.json`;
  }

  async ensure(input: EnsureSessionTreeInput): Promise<SessionTreeRecord> {
    return await this.exclusive(async () => {
      const taskId = assertId(input.task_id, "task id");
      const existing = await this.load(taskId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const rootNodeId = assertId(input.root_node_id ?? `root-${randomUUID().slice(0, 12)}`, "root node id");
      const rootNode: SessionTreeNode = {
        node_id: rootNodeId,
        task_id: taskId,
        parent_node_id: null,
        kind: "root",
        label: text(input.title, 500) || taskId,
        summary: text(input.summary ?? input.title),
        tags: ["root"],
        status: "active",
        bindings: bindings(input.bindings),
        rollback: rollback(false),
        created_at: now,
        updated_at: now
      };
      const tree: SessionTreeRecord = {
        version: 1,
        task_id: taskId,
        title: rootNode.label,
        root_node_id: rootNodeId,
        active_node_id: rootNodeId,
        nodes: [rootNode],
        created_at: now,
        updated_at: now
      };
      await this.atomicJson(this.treePath(taskId), tree);
      return structuredClone(tree);
    });
  }

  async load(taskId: string): Promise<SessionTreeRecord | undefined> {
    const safeTask = assertId(taskId, "task id");
    const resolved = this.guard.resolve(this.workspace, this.treePath(safeTask));
    try {
      const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as SessionTreeRecord;
      if (parsed.version !== 1 || parsed.task_id !== safeTask || !Array.isArray(parsed.nodes)) {
        throw new Error(`Invalid session tree: ${safeTask}`);
      }
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async addNode(taskId: string, input: AddSessionNodeInput): Promise<SessionTreeNode> {
    const dispatch = await codexProEventBus.emit(
      "session_before_branch",
      {
        task_id: assertId(taskId, "task id"),
        parent_node_id: assertId(input.parent_node_id, "parent node id"),
        kind: input.kind,
        label: text(input.label, 500),
        tags: unique(input.tags, 50)
      },
      { source: "session_tree", task_id: taskId }
    );
    if (dispatch.blocked) throw new Error(`Session branch blocked: ${dispatch.block_reasons.join(" | ")}`);

    return await this.exclusive(async () => {
      const tree = await this.require(taskId);
      const parentId = assertId(input.parent_node_id, "parent node id");
      if (!tree.nodes.some((node) => node.node_id === parentId)) throw new Error(`Parent session node not found: ${parentId}`);
      const nodeId = assertId(input.node_id ?? `node-${randomUUID().slice(0, 12)}`, "node id");
      if (tree.nodes.some((node) => node.node_id === nodeId)) throw new Error(`Session node already exists: ${nodeId}`);
      const now = new Date().toISOString();
      const node: SessionTreeNode = {
        node_id: nodeId,
        task_id: tree.task_id,
        parent_node_id: parentId,
        kind: input.kind,
        label: text(input.label, 500) || nodeId,
        summary: text(input.summary),
        tags: unique(input.tags, 50),
        status: input.status ?? "active",
        bindings: bindings(input.bindings),
        rollback: rollback(false),
        created_at: now,
        updated_at: now
      };
      tree.nodes.push(node);
      tree.active_node_id = nodeId;
      tree.updated_at = now;
      await this.atomicJson(this.treePath(tree.task_id), tree);
      return structuredClone(node);
    });
  }

  async updateNode(
    taskId: string,
    nodeId: string,
    patch: Partial<Pick<SessionTreeNode, "label" | "summary" | "tags" | "status" | "bindings">>
  ): Promise<SessionTreeNode> {
    return await this.exclusive(async () => {
      const tree = await this.require(taskId);
      const safeNode = assertId(nodeId, "node id");
      const node = tree.nodes.find((item) => item.node_id === safeNode);
      if (!node) throw new Error(`Session node not found: ${safeNode}`);
      if (patch.label !== undefined) node.label = text(patch.label, 500) || node.label;
      if (patch.summary !== undefined) node.summary = text(patch.summary);
      if (patch.tags !== undefined) node.tags = unique(patch.tags, 50);
      if (patch.status !== undefined) node.status = patch.status;
      if (patch.bindings !== undefined) node.bindings = bindings({ ...node.bindings, ...patch.bindings });
      node.updated_at = new Date().toISOString();
      tree.updated_at = node.updated_at;
      await this.atomicJson(this.treePath(tree.task_id), tree);
      return structuredClone(node);
    });
  }

  async compare(taskId: string, nodeIds: string[]): Promise<SessionBranchComparison> {
    const tree = await this.require(taskId);
    const ids = unique(nodeIds, 20).map((value) => assertId(value, "node id"));
    if (ids.length < 2) throw new Error("Session branch comparison requires at least two node ids.");
    const selected = ids.map((id) => {
      const node = tree.nodes.find((item) => item.node_id === id);
      if (!node) throw new Error(`Session node not found: ${id}`);
      return node;
    });
    const values = <T>(reader: (node: SessionTreeNode) => T): T[] => selected.map(reader);
    const allSame = <T>(items: T[]): boolean => items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]));
    return {
      task_id: tree.task_id,
      node_ids: ids,
      common_ancestor_id: this.commonAncestor(tree, ids),
      nodes: selected.map((node) => ({
        node_id: node.node_id,
        label: node.label,
        status: node.status,
        summary: node.summary,
        tags: [...node.tags],
        ...(node.bindings.git_sha ? { git_sha: node.bindings.git_sha } : {}),
        ...(node.bindings.branch ? { branch: node.bindings.branch } : {}),
        ...(node.bindings.worktree_path ? { worktree_path: node.bindings.worktree_path } : {}),
        changed_files: [...node.bindings.changed_files],
        acceptance_artifacts: [...node.bindings.acceptance_artifacts]
      })),
      differences: {
        git_sha: !allSame(values((node) => node.bindings.git_sha ?? null)),
        branch: !allSame(values((node) => node.bindings.branch ?? null)),
        worktree: !allSame(values((node) => node.bindings.worktree_path ?? null)),
        changed_files: !selected.every((node) => sameList(node.bindings.changed_files, selected[0].bindings.changed_files)),
        acceptance_artifacts: !selected.every((node) => sameList(node.bindings.acceptance_artifacts, selected[0].bindings.acceptance_artifacts)),
        status: !allSame(values((node) => node.status))
      }
    };
  }

  async activate(taskId: string, nodeId: string, current?: Partial<SessionExecutionBindings>): Promise<SessionActivationPlan> {
    return await this.exclusive(async () => {
      const tree = await this.require(taskId);
      const safeNode = assertId(nodeId, "node id");
      const node = tree.nodes.find((item) => item.node_id === safeNode);
      if (!node) throw new Error(`Session node not found: ${safeNode}`);
      tree.active_node_id = safeNode;
      tree.updated_at = new Date().toISOString();
      await this.atomicJson(this.treePath(tree.task_id), tree);
      const currentBindings = current ? bindings(current) : captureSessionBindings(this.config, this.workspace);
      const actions: string[] = [];
      if (node.bindings.worktree_path && node.bindings.worktree_path !== currentBindings.worktree_path) {
        actions.push(`Open or recreate the managed Worktree at ${node.bindings.worktree_path}; selecting this node did not switch Worktrees.`);
      } else if (node.bindings.git_sha && node.bindings.git_sha !== currentBindings.git_sha) {
        actions.push(`Restore code explicitly with Git/Worktree to ${node.bindings.git_sha}; selecting this node did not checkout files.`);
      }
      if (node.bindings.branch && node.bindings.branch !== currentBindings.branch) {
        actions.push(`Switch branch explicitly to ${node.bindings.branch} only after Dirty Guard review.`);
      }
      if (!sameList(node.bindings.changed_files, currentBindings.changed_files)) {
        actions.push("Inspect current Git diff against the selected node bindings; conversation selection did not restore changed files.");
      }
      if (node.bindings.database_checkpoint && node.bindings.database_checkpoint !== currentBindings.database_checkpoint) {
        actions.push(`Use the database domain rollback/checkpoint ${node.bindings.database_checkpoint}; no database state was changed by activation.`);
      }
      if (node.bindings.browser_session_id && node.bindings.browser_session_id !== currentBindings.browser_session_id) {
        actions.push(`Rebind the authorized Browser Session ${node.bindings.browser_session_id}; no tab, URL, form, or cookie state was restored.`);
      }
      if (node.bindings.acceptance_artifacts.length) {
        actions.push("After restoring the execution environment, rerun or verify the bound Acceptance artifacts before declaring completion.");
      }
      if (!actions.length) actions.push("No external-state mismatch was detected, but activation still changes conversation context only.");
      return {
        task_id: tree.task_id,
        selected_node_id: safeNode,
        rollback: rollback(true),
        current_bindings: currentBindings,
        selected_bindings: structuredClone(node.bindings),
        required_actions: actions,
        warning: "Session activation selects a decision context only. It does not restore files, databases, browser state, processes, or external side effects."
      };
    });
  }

  private commonAncestor(tree: SessionTreeRecord, nodeIds: string[]): string | null {
    const chains = nodeIds.map((nodeId) => {
      const chain: string[] = [];
      let current: string | null = nodeId;
      while (current) {
        chain.push(current);
        current = tree.nodes.find((node) => node.node_id === current)?.parent_node_id ?? null;
      }
      return chain.reverse();
    });
    const shortest = Math.min(...chains.map((chain) => chain.length));
    let common: string | null = null;
    for (let index = 0; index < shortest; index += 1) {
      if (chains.every((chain) => chain[index] === chains[0][index])) common = chains[0][index];
      else break;
    }
    return common;
  }

  private async require(taskId: string): Promise<SessionTreeRecord> {
    const tree = await this.load(taskId);
    if (!tree) throw new Error(`Session tree not found: ${taskId}`);
    return tree;
  }

  private async atomicJson(relativePath: string, value: unknown): Promise<void> {
    const target = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
    const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, target.absPath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
