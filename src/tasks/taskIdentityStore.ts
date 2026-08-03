import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import { RuntimeActivityEventStore } from "../runtime/activityEventStore.js";
import {
  ensureOfficeProjectionIndex,
  readOfficeProjectionIndex,
  replaceOfficeProjectionIndex,
  upsertOfficeProjectionIndex,
  type OfficeProjectionIndexLoadResult
} from "./officeProjectionIndex.js";
import type {
  TaskActorIdentityV1,
  TaskDomainKind,
  TaskIdentity,
  TaskObjectiveMetadataV1,
  TaskWorkspaceBindingV1
} from "./types.js";

const SAFE_TASK_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_DOMAIN_ID = /^[A-Za-z0-9._-]{1,110}$/;
const SAFE_OBJECTIVE_KEY = /^[A-Za-z0-9._:-]{1,500}$/;
const IDENTITY_READ_BATCH_SIZE = 64;
const MAX_IDENTITY_READ_CACHE_ENTRIES = 1_024;

interface IdentityReadCacheEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  identity: TaskIdentity;
}

const identityReadCache = new Map<string, IdentityReadCacheEntry>();

function cacheIdentity(filePath: string, stat: { mtimeMs: number; ctimeMs: number; size: number }, identity: TaskIdentity): void {
  identityReadCache.delete(filePath);
  identityReadCache.set(filePath, {
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    identity: structuredClone(identity)
  });
  while (identityReadCache.size > MAX_IDENTITY_READ_CACHE_ENTRIES) {
    const oldest = identityReadCache.keys().next().value;
    if (typeof oldest !== "string") break;
    identityReadCache.delete(oldest);
  }
}

function assertSafeId(value: string, label: string, pattern: RegExp): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`Invalid ${label}: ${value}`);
  return normalized;
}

function isTaskIdentityIndexEntry(key: string, value: unknown): value is TaskIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TaskIdentity>;
  return candidate.version === 1
    && candidate.task_id === key
    && typeof candidate.task_id === "string"
    && SAFE_TASK_ID.test(candidate.task_id)
    && ["goal", "durable_job", "handoff"].includes(candidate.kind ?? "")
    && typeof candidate.domain_id === "string"
    && SAFE_DOMAIN_ID.test(candidate.domain_id)
    && typeof candidate.project_root === "string"
    && typeof candidate.title === "string"
    && typeof candidate.created_at === "string"
    && Number.isFinite(Date.parse(candidate.created_at))
    && typeof candidate.updated_at === "string"
    && Number.isFinite(Date.parse(candidate.updated_at))
    && (!candidate.workspace_binding
      || (candidate.workspace_binding.version === 1
        && candidate.workspace_binding.immutable_after_start === true
        && candidate.workspace_binding.workspace_root === candidate.project_root
        && Number.isInteger(candidate.workspace_binding.workspace_generation)
        && candidate.workspace_binding.workspace_generation >= 1));
}

export function taskIdFor(kind: TaskDomainKind, domainId: string): string {
  const safeDomainId = assertSafeId(domainId, "task domain id", SAFE_DOMAIN_ID);
  const prefix = kind === "durable_job" ? "job" : kind;
  return assertSafeId(`${prefix}-${safeDomainId}`, "task id", SAFE_TASK_ID);
}

function normalizeObjectiveMetadata(value: TaskObjectiveMetadataV1 | undefined): TaskObjectiveMetadataV1 | undefined {
  if (!value) return undefined;
  const stageKey = value.stage_key?.trim() || null;
  if (stageKey && stageKey.length > 240) throw new Error("Task objective stage key is too long.");
  return {
    version: 1,
    objective_key: assertSafeId(value.objective_key, "objective key", SAFE_OBJECTIVE_KEY),
    stage_key: stageKey,
    previous_attempt_id: value.previous_attempt_id
      ? assertSafeId(value.previous_attempt_id, "previous attempt id", SAFE_TASK_ID)
      : null,
    source: value.source
  };
}

export interface EnsureTaskIdentityInput {
  kind: TaskDomainKind;
  domain_id: string;
  project_root: string;
  title: string;
  parent_task_id?: string;
  objective?: TaskObjectiveMetadataV1;
  workspace_binding?: TaskWorkspaceBindingV1;
  actor?: TaskActorIdentityV1;
  created_at?: string;
  updated_at?: string;
}

function normalizeActor(value: TaskActorIdentityV1 | undefined, workspace: Workspace): TaskActorIdentityV1 {
  const sessionId = value?.session_id?.trim() || workspace.conversationId?.trim() || workspace.activatedBySessionId?.trim() || "server-default";
  const role = value?.role ?? "executor";
  if (!["executor", "reviewer", "observer", "system"].includes(role)) throw new Error(`Invalid task actor role: ${role}`);
  const actorId = value?.actor_id?.trim() || `actor:${sessionId}`;
  if (!actorId || actorId.length > 300 || !sessionId || sessionId.length > 300) throw new Error("Task actor identity is invalid.");
  return { version: 1, actor_id: actorId, session_id: sessionId, role };
}

function workspaceBinding(
  workspace: Workspace,
  objectiveId: string,
  explicit?: TaskWorkspaceBindingV1
): TaskWorkspaceBindingV1 {
  const root = path.resolve(workspace.root);
  const binding = explicit ?? {
    version: 1 as const,
    objective_id: objectiveId,
    project_id: workspace.projectId?.trim() || path.basename(root) || "project",
    workspace_id: workspace.id,
    workspace_root: root,
    workspace_generation: Math.max(1, Math.floor(workspace.workspaceGeneration ?? 1)),
    source_conversation_id: workspace.conversationId?.trim() || workspace.activatedBySessionId?.trim() || "server-default",
    immutable_after_start: true as const
  };
  if (
    binding.version !== 1
    || binding.immutable_after_start !== true
    || path.resolve(binding.workspace_root) !== root
    || binding.workspace_id !== workspace.id
    || !Number.isInteger(binding.workspace_generation)
    || binding.workspace_generation < 1
  ) throw new Error("Task workspace binding does not match the authoritative workspace context.");
  return { ...binding, workspace_root: root };
}

function assertNewIdentityGeneration(workspace: Workspace): void {
  const supplied = Number(workspace.workspaceGeneration);
  if (!Number.isInteger(supplied) || supplied < 1) {
    throw new Error("Task creation requires an authoritative workspace generation.");
  }
  if (["conversation_binding", "workspace_binding", "task_binding"].includes(workspace.authoritySource ?? "") && !workspace.conversationId?.trim()) {
    throw new Error("Conversation-bound task creation requires an authoritative conversation id.");
  }
}

export class TaskIdentityStore {
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly runtimeEvents: RuntimeActivityEventStore;

  constructor(private readonly guard: PathGuard, readonly workspace: Workspace) {
    this.runtimeEvents = new RuntimeActivityEventStore(guard, workspace);
  }

  root(): string {
    return ".codexpro/task-identities";
  }

  identityPath(taskId: string): string {
    return `${this.root()}/${assertSafeId(taskId, "task id", SAFE_TASK_ID)}/identity.json`;
  }

  async ensure(input: EnsureTaskIdentityInput): Promise<TaskIdentity> {
    return await this.exclusive(async () => {
      const taskId = taskIdFor(input.kind, input.domain_id);
      const objective = normalizeObjectiveMetadata(input.objective);
      const actor = normalizeActor(input.actor, this.workspace);
      if (actor.role === "observer") {
        throw new Error("Observer actors cannot create or mutate a business Task Identity.");
      }
      const binding = workspaceBinding(this.workspace, objective?.objective_key ?? taskId, input.workspace_binding);
      const existing = await this.load(taskId);
      if (existing) {
        if (
          existing.kind !== input.kind
          || existing.domain_id !== input.domain_id
          || path.resolve(existing.project_root) !== path.resolve(input.project_root)
        ) {
          throw new Error(`Task identity ${taskId} is already bound to another domain object.`);
        }
        const degradedExisting = existing.actor?.session_id === "server-default"
          || existing.workspace_binding?.source_conversation_id === "server-default";
        const next: TaskIdentity = {
          ...existing,
          title: input.title.trim() || existing.title,
          ...(input.parent_task_id ? { parent_task_id: input.parent_task_id } : {}),
          ...(objective ? { objective } : {}),
          workspace_binding: existing.workspace_binding ?? binding,
          actor: existing.actor ?? actor,
          identity_quality: existing.identity_quality ?? (degradedExisting ? "degraded" : "authoritative"),
          legacy_binding: existing.legacy_binding ?? degradedExisting,
          updated_at: input.updated_at ?? new Date().toISOString()
        };
        if (
          input.workspace_binding
          && existing.workspace_binding
          && (
            existing.workspace_binding.workspace_id !== binding.workspace_id
            || path.resolve(existing.workspace_binding.workspace_root) !== path.resolve(binding.workspace_root)
            || existing.workspace_binding.workspace_generation !== binding.workspace_generation
          )
        ) {
          throw new Error(`Task identity ${taskId} has an immutable workspace binding and cannot be rebound.`);
        }
        await this.atomicJson(this.identityPath(taskId), next);
        await upsertOfficeProjectionIndex(this.guard, this.workspace, "identities", taskId, next).catch(() => undefined);
        return structuredClone(next);
      }

      assertNewIdentityGeneration(this.workspace);

      const now = new Date().toISOString();
      const identity: TaskIdentity = {
        version: 1,
        task_id: taskId,
        kind: input.kind,
        domain_id: assertSafeId(input.domain_id, "task domain id", SAFE_DOMAIN_ID),
        project_root: path.resolve(input.project_root),
        title: input.title.trim() || taskId,
        ...(input.parent_task_id ? { parent_task_id: assertSafeId(input.parent_task_id, "parent task id", SAFE_TASK_ID) } : {}),
        ...(objective ? { objective } : {}),
        workspace_binding: binding,
        actor,
        identity_quality: "authoritative",
        legacy_binding: false,
        created_at: input.created_at ?? now,
        updated_at: input.updated_at ?? now
      };
      await this.atomicJson(this.identityPath(taskId), identity);
      await upsertOfficeProjectionIndex(this.guard, this.workspace, "identities", taskId, identity).catch(() => undefined);
      const objectiveId = identity.objective?.objective_key ?? taskId;
      if (!identity.objective?.previous_attempt_id) {
        await this.runtimeEvents.append({
          kind: "objective.created",
          objective_id: objectiveId,
          attempt_id: taskId,
          run_id: input.domain_id,
          actor_id: actor.actor_id,
          actor_role: actor.role,
          occurred_at: identity.created_at,
          payload: { title: identity.title, stage_key: identity.objective?.stage_key ?? null }
        }).catch(() => undefined);
      }
      await this.runtimeEvents.append({
        kind: "attempt.started",
        objective_id: objectiveId,
        attempt_id: taskId,
        run_id: input.domain_id,
        actor_id: actor.actor_id,
        actor_role: actor.role,
        occurred_at: identity.created_at,
        payload: { previous_attempt_id: identity.objective?.previous_attempt_id ?? null, task_kind: identity.kind }
      }).catch(() => undefined);
      return structuredClone(identity);
    });
  }

  async list(limit = 200): Promise<TaskIdentity[]> {
    return (await this.listAll()).slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  async listAll(): Promise<TaskIdentity[]> {
    const resolved = this.guard.resolve(this.workspace, this.root());
    try {
      const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
      const names = entries
        .filter((entry) => entry.isDirectory() && SAFE_TASK_ID.test(entry.name))
        .map((entry) => entry.name);
      const identities: TaskIdentity[] = [];
      for (let index = 0; index < names.length; index += IDENTITY_READ_BATCH_SIZE) {
        const batch = await Promise.all(names.slice(index, index + IDENTITY_READ_BATCH_SIZE).map((name) => this.load(name)));
        for (const identity of batch) {
          if (identity) identities.push(identity);
        }
      }
      return identities
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async listOfficeIndex(): Promise<TaskIdentity[] | null> {
    const indexed = await readOfficeProjectionIndex<TaskIdentity>(
      this.guard,
      this.workspace,
      "identities",
      isTaskIdentityIndexEntry
    );
    if (!indexed) return null;
    return [...indexed.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  }

  async ensureOfficeIndex(): Promise<OfficeProjectionIndexLoadResult<TaskIdentity>> {
    return await ensureOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "identities",
      async () => (await this.listAll()).map((identity) => [identity.task_id, identity] as const),
      isTaskIdentityIndexEntry
    );
  }

  async replaceOfficeIndex(identities: TaskIdentity[]): Promise<void> {
    await replaceOfficeProjectionIndex(
      this.guard,
      this.workspace,
      "identities",
      identities.map((identity) => [identity.task_id, identity] as const)
    );
  }

  async load(taskId: string): Promise<TaskIdentity | undefined> {
    const resolved = this.guard.resolve(this.workspace, this.identityPath(taskId));
    try {
      const before = await fsp.stat(resolved.absPath);
      const cached = identityReadCache.get(resolved.absPath);
      if (
        cached
        && cached.mtime_ms === before.mtimeMs
        && cached.ctime_ms === before.ctimeMs
        && cached.size === before.size
      ) {
        identityReadCache.delete(resolved.absPath);
        identityReadCache.set(resolved.absPath, cached);
        return structuredClone(cached.identity);
      }
      const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as TaskIdentity;
      if (parsed.version !== 1 || parsed.task_id !== taskId) throw new Error(`Invalid task identity record: ${taskId}`);
      const after = await fsp.stat(resolved.absPath);
      if (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size) {
        cacheIdentity(resolved.absPath, after, parsed);
      }
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        identityReadCache.delete(resolved.absPath);
        return undefined;
      }
      throw error;
    }
  }

  async readMany(taskIds: string[]): Promise<TaskIdentity[]> {
    const uniqueTaskIds = [...new Set(taskIds.map((taskId) => assertSafeId(taskId, "task id", SAFE_TASK_ID)))];
    const identities: TaskIdentity[] = [];
    for (let index = 0; index < uniqueTaskIds.length; index += IDENTITY_READ_BATCH_SIZE) {
      const batch = await Promise.all(uniqueTaskIds.slice(index, index + IDENTITY_READ_BATCH_SIZE).map((taskId) => this.load(taskId)));
      for (const identity of batch) {
        if (identity) identities.push(identity);
      }
    }
    return identities;
  }

  private async atomicJson(relativePath: string, value: unknown): Promise<void> {
    const target = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
    const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, target.absPath);
      if (value && typeof value === "object" && (value as Partial<TaskIdentity>).version === 1 && typeof (value as Partial<TaskIdentity>).task_id === "string") {
        cacheIdentity(target.absPath, await fsp.stat(target.absPath), value as TaskIdentity);
      } else {
        identityReadCache.delete(target.absPath);
      }
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
