import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { expandHome } from "../config.js";
import {
  activeWorkspaceFilePath,
  CodexProError,
  readActiveWorkspaceState,
  type ActiveWorkspaceStateV2,
  type Workspace,
  type WorkspaceManager
} from "../guard.js";
import { readUserProjectsFile } from "../project/userProjects.js";

export interface ProjectIdentity {
  projectId: string;
  displayName: string;
  workspaceRoot: string;
  aliases: string[];
}

export interface ConversationWorkspaceBinding {
  version: 1;
  conversationId: string;
  projectId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceGeneration: number;
  boundAt: string;
  source: "explicit_open" | "explicit_activate" | "inherited_active";
}

export interface TaskWorkspaceBinding {
  version: 1;
  objectiveId: string;
  projectId: string;
  workspaceId: string;
  workspaceRoot: string;
  workspaceGeneration: number;
  sourceConversationId: string;
  immutableAfterStart: true;
}

interface ConversationBindingFileV1 {
  version: 1;
  updatedAt: string;
  bindings: Record<string, ConversationWorkspaceBinding>;
}

export interface WorkspaceActivationResult {
  workspace: Workspace;
  project: ProjectIdentity;
  activeState: ActiveWorkspaceStateV2;
  conversationBinding: ConversationWorkspaceBinding | null;
  activated: boolean;
  authorityScope: "global" | "conversation" | "inspection";
}

export interface ProjectWorkspaceAuthority {
  workspaceId: string;
  workspaceRoot: string;
  workspaceGeneration: number;
  activatedAt: string;
  source: "active_workspace" | "conversation_binding";
}

type ActivationListener = (result: WorkspaceActivationResult) => void | Promise<void>;

function cleanId(value: unknown, fallback: string, max = 240): string {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, max);
}

function canonicalRoot(root: string): string {
  return fs.realpathSync(path.resolve(expandHome(root)));
}

function rootKey(root: string): string {
  const normalized = path.resolve(root).split(path.sep).join("/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function workspaceId(root: string): string {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

function defaultConversationBindingsPath(): string {
  return path.join(path.dirname(activeWorkspaceFilePath()), "conversation-workspaces.json");
}

export function conversationWorkspaceBindingsPath(): string {
  const configured = process.env.CODEXPRO_CONVERSATION_WORKSPACE_FILE?.trim();
  return configured ? path.resolve(expandHome(configured)) : defaultConversationBindingsPath();
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function restoreFile(filePath: string, prior: string | null): void {
  if (prior === null) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort rollback */ }
    return;
  }
  atomicWrite(filePath, prior);
}

function readConversationBindings(filePath = conversationWorkspaceBindingsPath()): ConversationBindingFileV1 {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ConversationBindingFileV1>;
    if (parsed.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") throw new Error("invalid version");
    const bindings: Record<string, ConversationWorkspaceBinding> = {};
    for (const [key, value] of Object.entries(parsed.bindings)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<ConversationWorkspaceBinding>;
      if (
        candidate.version !== 1
        || candidate.conversationId !== key
        || typeof candidate.projectId !== "string"
        || typeof candidate.workspaceId !== "string"
        || typeof candidate.workspaceRoot !== "string"
        || !Number.isInteger(candidate.workspaceGeneration)
        || Number(candidate.workspaceGeneration) < 1
        || typeof candidate.boundAt !== "string"
        || !["explicit_open", "explicit_activate", "inherited_active"].includes(candidate.source ?? "")
      ) continue;
      bindings[key] = candidate as ConversationWorkspaceBinding;
    }
    return { version: 1, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(), bindings };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), bindings: {} };
  }
}

function activeFileText(filePath: string): string | null {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

export function latestWorkspaceAuthorityForRoot(root: string): ProjectWorkspaceAuthority | null {
  let canonical: string;
  try {
    canonical = canonicalRoot(root);
  } catch {
    return null;
  }
  const expectedWorkspaceId = workspaceId(canonical);
  const candidates: ProjectWorkspaceAuthority[] = [];
  const active = readActiveWorkspaceState();
  if (active && rootKey(active.workspaceRoot) === rootKey(canonical) && active.workspaceId === expectedWorkspaceId) {
    candidates.push({
      workspaceId: active.workspaceId,
      workspaceRoot: canonical,
      workspaceGeneration: active.generation,
      activatedAt: active.activatedAt,
      source: "active_workspace"
    });
  }
  for (const binding of Object.values(readConversationBindings().bindings)) {
    if (rootKey(binding.workspaceRoot) !== rootKey(canonical) || binding.workspaceId !== expectedWorkspaceId) continue;
    candidates.push({
      workspaceId: binding.workspaceId,
      workspaceRoot: canonical,
      workspaceGeneration: binding.workspaceGeneration,
      activatedAt: binding.boundAt,
      source: "conversation_binding"
    });
  }
  return candidates.sort((left, right) =>
    right.workspaceGeneration - left.workspaceGeneration
    || Date.parse(right.activatedAt) - Date.parse(left.activatedAt)
    || left.source.localeCompare(right.source))[0] ?? null;
}

export function resolveProjectIdentity(config: CodexProConfig, rootOrAlias: string): ProjectIdentity {
  const requested = rootOrAlias.trim();
  const projects = readUserProjectsFile();
  const normalizedRequested = requested.toLowerCase();
  const aliasEntry = requested && !path.isAbsolute(expandHome(requested))
    ? Object.entries(projects.projects).find(([name, entry]) =>
        name.toLowerCase() === normalizedRequested
        || entry.aliases?.some((alias) => alias.toLowerCase() === normalizedRequested)
        || path.basename(path.resolve(expandHome(entry.root))).toLowerCase() === normalizedRequested
      )?.[1]
    : undefined;
  const root = canonicalRoot(aliasEntry?.root ?? (requested || config.defaultRoot));
  const aliases = new Set<string>([root, path.basename(root)]);
  let displayName = path.basename(root) || "project";
  for (const [name, entry] of Object.entries(projects.projects)) {
    try {
      if (rootKey(canonicalRoot(entry.root)) !== rootKey(root)) continue;
      aliases.add(name);
      aliases.add(entry.root);
      for (const alias of entry.aliases ?? []) aliases.add(alias);
      displayName = path.basename(root) || name;
    } catch {
      // An invalid configured alias does not invalidate the selected real workspace.
    }
  }
  return {
    projectId: cleanId(path.basename(root), `project-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`),
    displayName,
    workspaceRoot: root,
    aliases: [...aliases].sort((left, right) => left.localeCompare(right))
  };
}

export class WorkspaceActivationService {
  private readonly listeners = new Set<ActivationListener>();
  private conversationBindings = readConversationBindings();

  constructor(private readonly config: CodexProConfig, private readonly manager: WorkspaceManager) {}

  onActivated(listener: ActivationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeState(): ActiveWorkspaceStateV2 | undefined {
    return readActiveWorkspaceState();
  }

  conversationBinding(conversationId: string | undefined): ConversationWorkspaceBinding | undefined {
    const id = conversationId?.trim();
    if (!id) return undefined;
    this.conversationBindings = readConversationBindings();
    return this.conversationBindings.bindings[id];
  }

  workspaceBinding(workspaceId: string | undefined): ConversationWorkspaceBinding | undefined {
    const id = workspaceId?.trim();
    if (!id) return undefined;
    this.conversationBindings = readConversationBindings();
    return Object.values(this.conversationBindings.bindings)
      .filter((binding) => binding.workspaceId === id)
      .sort((left, right) =>
        right.workspaceGeneration - left.workspaceGeneration
        || Date.parse(right.boundAt) - Date.parse(left.boundAt)
        || left.conversationId.localeCompare(right.conversationId))[0];
  }

  openAndActivate(
    rootOrAlias: string | undefined,
    options: {
      activate?: boolean;
      conversationId?: string;
      source?: ConversationWorkspaceBinding["source"];
      activatedBySessionId?: string;
      authorityScope?: "global" | "conversation";
    } = {}
  ): WorkspaceActivationResult {
    const project = resolveProjectIdentity(this.config, rootOrAlias?.trim() || this.config.defaultRoot);
    const workspace = this.manager.openWorkspace(project.workspaceRoot, { activate: false, persist: false });
    const existingAuthority = latestWorkspaceAuthorityForRoot(project.workspaceRoot);
    const generation = Math.max(1, existingAuthority?.workspaceGeneration ?? 1);
    const activatedAt = new Date().toISOString();
    const activeState: ActiveWorkspaceStateV2 = {
      version: 2,
      projectId: project.projectId,
      workspaceId: workspace.id,
      workspaceRoot: project.workspaceRoot,
      generation,
      activatedAt,
      ...(options.activatedBySessionId?.trim() ? { activatedBySessionId: options.activatedBySessionId.trim() } : {})
    };
    const conversationId = options.conversationId?.trim();
    const binding = conversationId ? this.bindingFor(activeState, conversationId, options.source ?? "explicit_open") : null;

    if (options.activate === false) {
      return {
        workspace: this.withAuthority(workspace, activeState, conversationId),
        project,
        activeState,
        conversationBinding: null,
        activated: false,
        authorityScope: "inspection"
      };
    }

    const authorityScope = options.authorityScope ?? "global";
    const activePath = activeWorkspaceFilePath();
    const bindingsPath = conversationWorkspaceBindingsPath();
    const priorActiveFile = activeFileText(activePath);
    const priorBindingsFile = activeFileText(bindingsPath);
    const previousWorkspace = this.manager.activeWorkspace();
    const previousBindings = this.conversationBindings;
    try {
      if (authorityScope === "conversation") {
        if (!binding) throw new CodexProError("Connector workspace binding requires a conversation id.");
        this.conversationBindings = {
          version: 1,
          updatedAt: activatedAt,
          bindings: { ...this.conversationBindings.bindings, [binding.conversationId]: binding }
        };
        atomicWrite(bindingsPath, `${JSON.stringify(this.conversationBindings, null, 2)}\n`);
      } else {
        atomicWrite(activePath, `${JSON.stringify(activeState, null, 2)}\n`);
        if (binding) {
          this.conversationBindings = {
            version: 1,
            updatedAt: activatedAt,
            bindings: { ...this.conversationBindings.bindings, [binding.conversationId]: binding }
          };
          atomicWrite(bindingsPath, `${JSON.stringify(this.conversationBindings, null, 2)}\n`);
        }
        this.manager.activateWorkspace(this.withAuthority(workspace, activeState, conversationId), { persist: false });
      }
    } catch (error) {
      this.manager.restoreActiveWorkspace(previousWorkspace);
      this.conversationBindings = previousBindings;
      restoreFile(activePath, priorActiveFile);
      restoreFile(bindingsPath, priorBindingsFile);
      throw new CodexProError(`Workspace activation transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }

    const result: WorkspaceActivationResult = {
      workspace: this.withAuthority(workspace, activeState, conversationId),
      project,
      activeState,
      conversationBinding: binding,
      activated: true,
      authorityScope
    };
    for (const listener of this.listeners) void Promise.resolve(listener(result)).catch(() => undefined);
    return result;
  }

  activate(
    workspace: Workspace,
    options: { conversationId?: string; source?: ConversationWorkspaceBinding["source"]; activatedBySessionId?: string } = {}
  ): WorkspaceActivationResult {
    return this.openAndActivate(workspace.root, { activate: true, ...options });
  }

  resolveCurrent(options: {
    taskBinding?: TaskWorkspaceBinding | null;
    workspaceId?: string;
    conversationId?: string;
    connectorRequest?: boolean;
  } = {}): Workspace {
    if (options.taskBinding) {
      const binding = options.taskBinding;
      const workspace = this.manager.openWorkspace(binding.workspaceRoot, { activate: false, persist: false });
      if (workspace.id !== binding.workspaceId) throw new CodexProError("Task workspace binding does not match the canonical workspace id.");
      return this.withAuthority(workspace, {
        version: 2,
        projectId: binding.projectId,
        workspaceId: binding.workspaceId,
        workspaceRoot: binding.workspaceRoot,
        generation: binding.workspaceGeneration,
        activatedAt: workspace.activatedAt ?? new Date(0).toISOString()
      }, binding.sourceConversationId, "task_binding");
    }

    const conversation = this.conversationBinding(options.conversationId);
    if (conversation) {
      if (options.workspaceId && options.workspaceId !== conversation.workspaceId) {
        throw new CodexProError(
          `Conversation workspace mismatch: ${conversation.conversationId} is bound to ${conversation.workspaceId}, received ${options.workspaceId}.`
        );
      }
      const workspace = this.manager.openWorkspace(conversation.workspaceRoot, { activate: false, persist: false });
      return this.withAuthority(workspace, {
        version: 2,
        projectId: conversation.projectId,
        workspaceId: conversation.workspaceId,
        workspaceRoot: conversation.workspaceRoot,
        generation: conversation.workspaceGeneration,
        activatedAt: conversation.boundAt
      }, conversation.conversationId, "conversation_binding");
    }

    if (options.workspaceId) {
      const workspace = this.manager.getWorkspace(options.workspaceId);
      const workspaceBinding = this.workspaceBinding(workspace.id);
      if (workspaceBinding) {
        return this.withAuthority(workspace, {
          version: 2,
          projectId: workspaceBinding.projectId,
          workspaceId: workspaceBinding.workspaceId,
          workspaceRoot: workspaceBinding.workspaceRoot,
          generation: workspaceBinding.workspaceGeneration,
          activatedAt: workspaceBinding.boundAt
        }, workspaceBinding.conversationId, "workspace_binding");
      }
      const authority = latestWorkspaceAuthorityForRoot(workspace.root);
      const state: ActiveWorkspaceStateV2 = authority
        ? {
            version: 2,
            projectId: workspace.projectId ?? (path.basename(workspace.root) || "project"),
            workspaceId: workspace.id,
            workspaceRoot: workspace.root,
            generation: authority.workspaceGeneration,
            activatedAt: authority.activatedAt
          }
        : {
            version: 2,
            projectId: workspace.projectId ?? (path.basename(workspace.root) || "project"),
            workspaceId: workspace.id,
            workspaceRoot: workspace.root,
            generation: Math.max(1, workspace.workspaceGeneration ?? 1),
            activatedAt: workspace.activatedAt ?? workspace.openedAt
          };
      return this.withAuthority(workspace, state, options.conversationId, "explicit_workspace");
    }

    if (options.connectorRequest || options.conversationId) {
      const project = resolveProjectIdentity(this.config, this.config.defaultRoot);
      const workspace = this.manager.openWorkspace(project.workspaceRoot, { activate: false, persist: false });
      const authority = latestWorkspaceAuthorityForRoot(project.workspaceRoot);
      return this.withAuthority(workspace, {
        version: 2,
        projectId: project.projectId,
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        generation: Math.max(1, authority?.workspaceGeneration ?? 1),
        activatedAt: authority?.activatedAt ?? workspace.openedAt
      }, options.conversationId, "default_root");
    }

    const persisted = readActiveWorkspaceState();
    if (persisted) {
      const workspace = this.manager.openWorkspace(persisted.workspaceRoot, { activate: true, persist: false });
      return this.withAuthority(workspace, persisted, undefined, "global_active");
    }
    const project = resolveProjectIdentity(this.config, this.config.defaultRoot);
    const workspace = this.manager.openWorkspace(project.workspaceRoot, { activate: false, persist: false });
    return this.withAuthority(workspace, {
      version: 2,
      projectId: project.projectId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      generation: 1,
      activatedAt: workspace.openedAt
    }, undefined, "default_root");
  }

  bindTask(objectiveId: string, workspace: Workspace, conversationId?: string): TaskWorkspaceBinding {
    const root = canonicalRoot(workspace.root);
    const authority = latestWorkspaceAuthorityForRoot(root);
    const generation = Math.max(1, workspace.workspaceGeneration ?? authority?.workspaceGeneration ?? 1);
    return {
      version: 1,
      objectiveId: cleanId(objectiveId, "objective"),
      projectId: workspace.projectId ?? cleanId(path.basename(root), "project"),
      workspaceId: workspace.id || workspaceId(root),
      workspaceRoot: root,
      workspaceGeneration: generation,
      sourceConversationId: conversationId?.trim() || workspace.conversationId?.trim() || "server-default",
      immutableAfterStart: true
    };
  }

  assertGeneration(workspace: Workspace, suppliedGeneration: number | undefined): void {
    const expected = Math.max(1, workspace.workspaceGeneration ?? latestWorkspaceAuthorityForRoot(workspace.root)?.workspaceGeneration ?? 1);
    if (suppliedGeneration === undefined || suppliedGeneration !== expected) {
      throw new CodexProError(
        `Stale workspace generation: expected ${expected}, received ${suppliedGeneration ?? "none"}. Re-open or rebind the workspace before creating a new task.`
      );
    }
  }

  private bindingFor(
    state: ActiveWorkspaceStateV2,
    conversationId: string,
    source: ConversationWorkspaceBinding["source"]
  ): ConversationWorkspaceBinding {
    return {
      version: 1,
      conversationId,
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      workspaceRoot: state.workspaceRoot,
      workspaceGeneration: state.generation,
      boundAt: state.activatedAt,
      source
    };
  }

  private withAuthority(
    workspace: Workspace,
    state: ActiveWorkspaceStateV2,
    conversationId?: string,
    authoritySource: Workspace["authoritySource"] = conversationId?.trim() ? "conversation_binding" : "global_active"
  ): Workspace {
    return {
      ...workspace,
      projectId: state.projectId,
      workspaceGeneration: state.generation,
      activatedAt: state.activatedAt,
      activatedBySessionId: state.activatedBySessionId,
      conversationId: conversationId?.trim() || workspace.conversationId,
      authoritySource
    };
  }
}

export function defaultConversationId(): string {
  return process.env.CODEXPRO_CONVERSATION_ID?.trim() || `conversation:${randomUUID()}`;
}
