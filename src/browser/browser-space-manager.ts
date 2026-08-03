import * as fsp from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import type { BrowserTabEntry } from "../adapters/playwright-adapter.js";
import { BrowserSessionManager, type BrowserSession } from "./browser-session.js";
import {
  BROWSER_SPACE_DEFAULT_ID,
  BROWSER_SPACE_MAX_CREATED,
  browserSpaceIdSchema,
  browserSpaceManifestPath,
  browserSpaceManifestSchema,
  browserSpaceTabPath,
  browserTabOwnershipSchema,
  createBrowserSpaceManifest,
  emptyBrowserSpaceResourceLease,
  type BrowserSpaceCreateInput,
  type BrowserSpaceManifest,
  type BrowserSpaceMode,
  type BrowserTabOwnership
} from "./browser-space.js";

interface WorkspaceSpaceRegistry {
  loaded: boolean;
  loading?: Promise<void>;
  spaces: Map<string, BrowserSpaceManifest>;
  activeSpaceId: string;
}

export type BrowserSpaceResourceKind = "interactive_profile" | "visual" | "download";
export type BrowserSpaceFlowStatus = "prepared" | "queued" | "running" | "waiting_resource" | "passed" | "failed" | "blocked" | "waiting_human" | "cancelled";

interface ProcessSpaceResourceLease {
  owner: string;
  spaceId: string;
}

const PROCESS_SPACE_RESOURCE_LEASES = new Map<string, ProcessSpaceResourceLease>();
const PROCESS_BROWSER_SPACE_REGISTRIES = new Map<string, WorkspaceSpaceRegistry>();
const PROCESS_SPACE_WRITE_QUEUE = new Map<string, Promise<void>>();

export function resetBrowserSpaceProcessStateForTests(): void {
  PROCESS_BROWSER_SPACE_REGISTRIES.clear();
  PROCESS_SPACE_RESOURCE_LEASES.clear();
  PROCESS_SPACE_WRITE_QUEUE.clear();
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function now(): string {
  return new Date().toISOString();
}

function withoutSecrets<T>(value: T): T {
  const forbidden = /cookie|token|password|secret|local[_-]?storage|session[_-]?storage/i;
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .filter(([key]) => !forbidden.test(key))
      .map(([key, child]) => [key, visit(child)]));
  };
  return visit(value) as T;
}

export class BrowserSpaceManager {
  private readonly registries = PROCESS_BROWSER_SPACE_REGISTRIES;
  private readonly writeQueue = PROCESS_SPACE_WRITE_QUEUE;

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly sessions: BrowserSessionManager
  ) {}

  async ensureLoaded(workspace: Workspace): Promise<void> {
    const registry = this.registry(workspace);
    if (registry.loaded) return;
    if (registry.loading) return await registry.loading;
    const loading = this.loadPersistedRegistry(workspace, registry);
    registry.loading = loading;
    try {
      await loading;
      registry.loaded = true;
    } finally {
      if (registry.loading === loading) registry.loading = undefined;
    }
  }

  private async loadPersistedRegistry(workspace: Workspace, registry: WorkspaceSpaceRegistry): Promise<void> {
    const root = this.guard.resolve(workspace, ".codexpro/runs").absPath;
    let runEntries: Dirent[];
    try {
      runEntries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory()) continue;
      const spacesRoot = path.join(root, runEntry.name, "browser-spaces");
      let spaceEntries: Dirent[];
      try {
        spaceEntries = await fsp.readdir(spacesRoot, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const spaceEntry of spaceEntries) {
        if (!spaceEntry.isDirectory()) continue;
        const manifestFile = path.join(spacesRoot, spaceEntry.name, "manifest.json");
        try {
          const manifest = browserSpaceManifestSchema.parse(JSON.parse(await fsp.readFile(manifestFile, "utf8")));
          if (manifest.workspace_id !== workspace.id) continue;
          const previous = registry.spaces.get(manifest.space_id);
          if (!previous || Date.parse(previous.last_used_at) < Date.parse(manifest.last_used_at)) {
            registry.spaces.set(manifest.space_id, manifest);
          }
        } catch (error) {
          if (!isMissing(error)) console.warn(`[CodexPro] Ignored invalid Browser Space manifest ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const manifest of [...registry.spaces.values()]) await this.recoverPersistedSpace(workspace, manifest);
  }

  async create(workspace: Workspace, input: BrowserSpaceCreateInput = {}): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    const registry = this.registry(workspace);
    const spaceId = browserSpaceIdSchema.parse(input.space_id ?? `space-${registry.spaces.size + 1}`);
    const mode = input.mode ?? "shared_profile";
    if (mode === "isolated_profile") {
      throw new CodexProError("Browser Space mode isolated_profile is disabled in stage 3. Configure an approved profile root in a later stage before enabling it.");
    }
    const existing = registry.spaces.get(spaceId);
    if (existing && existing.status !== "closed") throw new CodexProError(`Browser Space ${spaceId} already exists with status ${existing.status}.`);
    if (spaceId !== BROWSER_SPACE_DEFAULT_ID && this.createdSpaceCount(registry) >= BROWSER_SPACE_MAX_CREATED) {
      throw new CodexProError(`Browser Space limit reached (${BROWSER_SPACE_MAX_CREATED}). Close an existing named space before creating another.`);
    }
    const session = this.sessions.get(workspace, { spaceId, mode });
    const manifest = createBrowserSpaceManifest({
      config: this.config,
      workspace,
      spaceId,
      mode,
      ownerTaskId: input.owner_task_id,
      ownerRunId: input.owner_run_id,
      browserSessionId: session.sessionId,
      reportRoot: session.reportRoot()
    });
    registry.spaces.set(spaceId, manifest);
    await this.persistManifest(workspace, manifest);
    return structuredClone(manifest);
  }

  async list(workspace: Workspace): Promise<BrowserSpaceManifest[]> {
    await this.ensureLoaded(workspace);
    return [...this.registry(workspace).spaces.values()]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map((manifest) => structuredClone(manifest));
  }

  async findByOwnerRunId(workspace: Workspace, runId: string): Promise<BrowserSpaceManifest | undefined> {
    await this.ensureLoaded(workspace);
    const matches = [...this.registry(workspace).spaces.values()].filter((manifest) => manifest.owner_run_id === runId);
    if (matches.length > 1) throw new CodexProError(`Browser verification run ${runId} owns multiple Browser Spaces.`);
    return matches[0] ? structuredClone(matches[0]) : undefined;
  }

  async auditReleasedResources(workspace: Workspace, spaceId: string): Promise<{
    released: boolean;
    reasons: string[];
    status: BrowserSpaceManifest["status"];
    controlled_tab_ids: string[];
    session_present: boolean;
    active_flow_id: string | null;
    resource_lease_status: BrowserSpaceManifest["resource_lease"]["status"];
  }> {
    await this.ensureLoaded(workspace);
    const manifest = this.requireManifest(workspace, spaceId);
    const reasons: string[] = [];
    if (manifest.status !== "closed") reasons.push(`space_status_${manifest.status}`);
    if (manifest.controlled_tab_ids.length) reasons.push(`owned_tabs_${manifest.controlled_tab_ids.length}`);
    if (manifest.active_flow_id) reasons.push(`active_flow_${manifest.active_flow_id}`);
    if (manifest.resource_lease.status !== "none" || manifest.resource_lease.interactive_profile_slot || manifest.resource_lease.visual_slot || manifest.resource_lease.download_slot) {
      reasons.push(`resource_lease_${manifest.resource_lease.status}`);
    }
    const sessionPresent = Boolean(this.sessions.peek(workspace, spaceId));
    if (sessionPresent) reasons.push("browser_session_still_registered");
    return {
      released: reasons.length === 0,
      reasons,
      status: manifest.status,
      controlled_tab_ids: [...manifest.controlled_tab_ids],
      session_present: sessionPresent,
      active_flow_id: manifest.active_flow_id,
      resource_lease_status: manifest.resource_lease.status
    };
  }

  async status(workspace: Workspace, spaceId = BROWSER_SPACE_DEFAULT_ID, refreshTabs = true): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    let manifest = this.registry(workspace).spaces.get(browserSpaceIdSchema.parse(spaceId));
    if (!manifest && spaceId === BROWSER_SPACE_DEFAULT_ID) manifest = await this.ensureUsable(workspace, spaceId);
    if (!manifest) throw new CodexProError(`Unknown Browser Space ${spaceId}.`);
    if (refreshTabs && !["closed", "closing", "failed", "orphaned"].includes(manifest.status)) await this.refreshTabs(workspace, manifest.space_id);
    return structuredClone(this.requireManifest(workspace, manifest.space_id));
  }

  async activate(workspace: Workspace, spaceId: string): Promise<BrowserSpaceManifest> {
    const manifest = await this.ensureUsable(workspace, spaceId);
    const registry = this.registry(workspace);
    for (const candidate of registry.spaces.values()) {
      if (candidate.status === "active" && candidate.space_id !== manifest.space_id) {
        candidate.status = "ready";
        await this.persistManifest(workspace, candidate);
      }
    }
    manifest.status = "active";
    manifest.last_used_at = now();
    registry.activeSpaceId = manifest.space_id;
    await this.persistManifest(workspace, manifest);
    return structuredClone(manifest);
  }

  async bindTask(workspace: Workspace, spaceId: string, taskId: string, runId: string): Promise<BrowserSpaceManifest> {
    const manifest = await this.ensureUsable(workspace, spaceId);
    if (manifest.active_flow_id) {
      throw new CodexProError(`Browser Space ${spaceId} already has active flow ${manifest.active_flow_id}.`);
    }
    if ((manifest.owner_task_id && manifest.owner_task_id !== taskId) || (manifest.owner_run_id && manifest.owner_run_id !== runId)) {
      await this.refreshTabs(workspace, spaceId).catch(() => undefined);
      if (manifest.controlled_tab_ids.length) {
        throw new CodexProError(`Browser Space ${spaceId} still owns tabs from task ${manifest.owner_task_id ?? "unknown"}; close or reset it before binding task ${taskId}.`);
      }
    }
    manifest.owner_task_id = taskId;
    manifest.owner_run_id = runId;
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
    return structuredClone(manifest);
  }

  async finishFlow(
    workspace: Workspace,
    spaceId: string,
    flowId: string,
    status: BrowserSpaceFlowStatus | undefined,
    taskId: string,
    runId: string
  ): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    const manifest = this.requireManifest(workspace, spaceId);
    if (manifest.status === "closed") return structuredClone(manifest);
    if (manifest.owner_task_id !== taskId || manifest.owner_run_id !== runId) {
      throw new CodexProError(`Browser Space ${spaceId} task ownership does not match terminal flow ${flowId}; owned tabs were preserved.`);
    }
    if (manifest.active_flow_id && manifest.active_flow_id !== flowId) {
      throw new CodexProError(`Browser Space ${spaceId} is now owned by active flow ${manifest.active_flow_id}; terminal flow ${flowId} cannot close it.`);
    }
    manifest.active_flow_id = null;
    manifest.status = "ready";
    manifest.resource_lease = emptyBrowserSpaceResourceLease();
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
    if (status !== "passed" && status !== "cancelled") return structuredClone(manifest);
    const closed = await this.close(workspace, spaceId);
    closed.recovery_notes = [
      ...(closed.recovery_notes ?? []),
      `${closed.last_used_at}: flow ${flowId} reached ${status}; task-owned tabs closed immediately without an idle timeout.`
    ].slice(-20);
    const stored = this.requireManifest(workspace, spaceId);
    stored.recovery_notes = closed.recovery_notes;
    await this.persistManifest(workspace, stored);
    return structuredClone(stored);
  }

  async close(workspace: Workspace, spaceId: string): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    const manifest = this.requireManifest(workspace, spaceId);
    if (manifest.status === "closed") return structuredClone(manifest);
    if (manifest.active_flow_id) throw new CodexProError(`Browser Space ${spaceId} has active flow ${manifest.active_flow_id}; cancel it before close.`);
    manifest.status = "closing";
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
    await this.refreshTabs(workspace, spaceId).catch(() => undefined);
    await this.sessions.disconnect(workspace, { spaceId, mode: this.sessionMode(manifest.mode) });
    manifest.controlled_tab_ids = [];
    manifest.active_page_id = null;
    manifest.active_flow_id = null;
    manifest.resource_lease = emptyBrowserSpaceResourceLease();
    manifest.status = "closed";
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
    return structuredClone(manifest);
  }

  async reset(workspace: Workspace, spaceId: string): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    const manifest = this.requireManifest(workspace, spaceId);
    if (manifest.active_flow_id) throw new CodexProError(`Browser Space ${spaceId} has active flow ${manifest.active_flow_id}; cancel it before reset.`);
    await this.sessions.disconnect(workspace, { spaceId, mode: this.sessionMode(manifest.mode) }).catch(() => undefined);
    const session = this.sessions.get(workspace, { spaceId, mode: this.sessionMode(manifest.mode) });
    manifest.browser_session_id = session.sessionId;
    manifest.report_root = session.reportRoot();
    manifest.controlled_tab_ids = [];
    manifest.active_page_id = null;
    manifest.resource_lease = emptyBrowserSpaceResourceLease();
    manifest.status = "ready";
    manifest.last_used_at = now();
    manifest.recovery_notes = [...(manifest.recovery_notes ?? []), `${manifest.last_used_at}: explicit reset created a fresh browser session.`].slice(-20);
    await this.persistManifest(workspace, manifest);
    return structuredClone(manifest);
  }

  async ensureUsable(workspace: Workspace, requestedSpaceId = BROWSER_SPACE_DEFAULT_ID): Promise<BrowserSpaceManifest> {
    await this.ensureLoaded(workspace);
    const spaceId = browserSpaceIdSchema.parse(requestedSpaceId || BROWSER_SPACE_DEFAULT_ID);
    let manifest = this.registry(workspace).spaces.get(spaceId);
    if (!manifest && spaceId === BROWSER_SPACE_DEFAULT_ID) {
      manifest = await this.create(workspace, { space_id: BROWSER_SPACE_DEFAULT_ID, mode: "shared_profile" });
      return this.requireManifest(workspace, manifest.space_id);
    }
    if (!manifest) throw new CodexProError(`Unknown Browser Space ${spaceId}. Create it with browser_space_create first.`);
    if (manifest.status === "closed") {
      if (spaceId !== BROWSER_SPACE_DEFAULT_ID) throw new CodexProError(`Browser Space ${spaceId} is closed. Reset it before use.`);
      await this.reset(workspace, spaceId);
      manifest = this.requireManifest(workspace, spaceId);
    }
    if (manifest.status === "closing" || manifest.status === "failed" || manifest.status === "orphaned") {
      throw new CodexProError(`Browser Space ${spaceId} is ${manifest.status} and cannot execute browser actions.`);
    }
    this.session(workspace, manifest);
    manifest.last_used_at = now();
    if (manifest.status === "recovering") manifest.status = "ready";
    await this.persistManifest(workspace, manifest);
    return manifest;
  }

  sessionFor(workspace: Workspace, spaceId = BROWSER_SPACE_DEFAULT_ID): BrowserSession {
    const manifest = this.requireManifest(workspace, spaceId);
    return this.session(workspace, manifest);
  }

  async refreshTabs(workspace: Workspace, spaceId: string): Promise<BrowserSpaceManifest> {
    const manifest = this.requireManifest(workspace, spaceId);
    const session = this.session(workspace, manifest);
    const tabs = await session.tabs();
    const owned = tabs.filter((tab) => tab.ownedByCodexPro);
    manifest.controlled_tab_ids = [...new Set(owned.map((tab) => tab.tabId))];
    manifest.active_page_id = owned.find((tab) => tab.current)?.tabId ?? owned.at(-1)?.tabId ?? null;
    manifest.browser_session_id = session.sessionId;
    manifest.report_root = session.reportRoot();
    manifest.last_used_at = now();
    await Promise.all(tabs.map((tab) => this.persistTab(workspace, manifest, tab)));
    await this.persistManifest(workspace, manifest);
    return manifest;
  }

  async markFlow(workspace: Workspace, spaceId: string, flowId: string | null, waiting = false): Promise<void> {
    const manifest = await this.ensureUsable(workspace, spaceId);
    manifest.active_flow_id = flowId;
    manifest.status = waiting ? "waiting_resource" : flowId ? "active" : "ready";
    manifest.resource_lease = waiting
        ? { status: "waiting", interactive_profile_slot: false, visual_slot: false, download_slot: false, lease_owner: flowId ?? undefined }
        : emptyBrowserSpaceResourceLease();
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
  }

  async acquireResource(workspace: Workspace, spaceId: string, owner: string, resource: BrowserSpaceResourceKind): Promise<boolean> {
    const manifest = await this.ensureUsable(workspace, spaceId);
    const resourceKey = this.resourceKey(workspace, manifest, resource);
    const existing = PROCESS_SPACE_RESOURCE_LEASES.get(resourceKey);
    if (existing && existing.owner !== owner) {
      manifest.status = "waiting_resource";
      manifest.resource_lease = {
        ...manifest.resource_lease,
        status: "waiting",
        lease_owner: owner
      };
      manifest.last_used_at = now();
      await this.persistManifest(workspace, manifest);
      return false;
    }
    PROCESS_SPACE_RESOURCE_LEASES.set(resourceKey, { owner, spaceId });
    manifest.status = manifest.active_flow_id ? "active" : "ready";
    manifest.resource_lease = {
      status: "leased",
      interactive_profile_slot: manifest.resource_lease.interactive_profile_slot || resource === "interactive_profile",
      visual_slot: manifest.resource_lease.visual_slot || resource === "visual",
      download_slot: manifest.resource_lease.download_slot || resource === "download",
      leased_at: now(),
      lease_owner: owner
    };
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
    return true;
  }

  async releaseResource(workspace: Workspace, spaceId: string, owner: string, resource: BrowserSpaceResourceKind): Promise<void> {
    await this.ensureLoaded(workspace);
    const manifest = this.registry(workspace).spaces.get(spaceId);
    if (!manifest) return;
    const resourceKey = this.resourceKey(workspace, manifest, resource);
    const existing = PROCESS_SPACE_RESOURCE_LEASES.get(resourceKey);
    if (existing?.owner !== owner) return;
    PROCESS_SPACE_RESOURCE_LEASES.delete(resourceKey);
    const next = {
      ...manifest.resource_lease,
      interactive_profile_slot: resource === "interactive_profile" ? false : manifest.resource_lease.interactive_profile_slot,
      visual_slot: resource === "visual" ? false : manifest.resource_lease.visual_slot,
      download_slot: resource === "download" ? false : manifest.resource_lease.download_slot
    };
    const anyLease = next.interactive_profile_slot || next.visual_slot || next.download_slot;
    manifest.resource_lease = anyLease
      ? { ...next, status: "leased", leased_at: now(), lease_owner: owner }
      : emptyBrowserSpaceResourceLease();
    manifest.status = manifest.active_flow_id ? "active" : "ready";
    manifest.last_used_at = now();
    await this.persistManifest(workspace, manifest);
  }

  private registry(workspace: Workspace): WorkspaceSpaceRegistry {
    let registry = this.registries.get(workspace.root);
    if (!registry) {
      registry = { loaded: false, spaces: new Map(), activeSpaceId: BROWSER_SPACE_DEFAULT_ID };
      this.registries.set(workspace.root, registry);
    }
    return registry;
  }

  private requireManifest(workspace: Workspace, spaceId: string): BrowserSpaceManifest {
    const manifest = this.registry(workspace).spaces.get(browserSpaceIdSchema.parse(spaceId));
    if (!manifest) throw new CodexProError(`Unknown Browser Space ${spaceId}.`);
    return manifest;
  }

  private createdSpaceCount(registry: WorkspaceSpaceRegistry): number {
    return [...registry.spaces.values()].filter((manifest) => manifest.space_id !== BROWSER_SPACE_DEFAULT_ID && manifest.status !== "closed").length;
  }

  private sessionMode(mode: BrowserSpaceMode): "shared_profile" | "isolated_context" {
    if (mode === "isolated_profile") throw new CodexProError("isolated_profile Browser Spaces are disabled.");
    return mode;
  }

  private session(workspace: Workspace, manifest: BrowserSpaceManifest): BrowserSession {
    const session = this.sessions.get(workspace, { spaceId: manifest.space_id, mode: this.sessionMode(manifest.mode) });
    manifest.browser_session_id = session.sessionId;
    manifest.report_root = session.reportRoot();
    return session;
  }

  private resourceKey(workspace: Workspace, manifest: BrowserSpaceManifest, resource: BrowserSpaceResourceKind): string {
    if (resource === "interactive_profile") {
      const identity = manifest.mode === "shared_profile" ? manifest.profile_identity_hash : `${manifest.mode}:${manifest.space_id}`;
      return `${workspace.root}\0interactive_profile\0${identity}`;
    }
    return `${workspace.root}\0${resource}`;
  }

  private async recoverPersistedSpace(workspace: Workspace, manifest: BrowserSpaceManifest): Promise<void> {
    if (manifest.status === "closed") return;
    const liveSession = this.sessions.peek(workspace, manifest.space_id);
    if (liveSession?.sessionId === manifest.browser_session_id) {
      manifest.report_root = liveSession.reportRoot();
      return;
    }
    const recoveredAt = now();
    const staleTabIds = [...manifest.controlled_tab_ids];
    for (const tabId of staleTabIds) {
      const orphan: BrowserTabOwnership = {
        version: 1,
        tab_id: tabId,
        space_id: manifest.space_id,
        created_by_codexpro: true,
        ownership: "orphaned",
        url: "",
        title: "",
        last_seen_at: recoveredAt,
        transfer_state: "none",
        close_with_space: false
      };
      await this.writeJsonAtomic(workspace, browserSpaceTabPath(manifest.owner_run_id, manifest.space_id, tabId), browserTabOwnershipSchema.parse(orphan));
    }
    const notes = [...(manifest.recovery_notes ?? [])];
    if (staleTabIds.length) notes.push(`${recoveredAt}: ${staleTabIds.length} previously controlled tab(s) became orphaned pending identity revalidation.`);
    if (manifest.mode === "isolated_context") notes.push(`${recoveredAt}: isolated context must be rebuilt; login and ephemeral storage were not restored.`);
    else notes.push(`${recoveredAt}: shared profile identity retained; login state may be reused after page revalidation.`);
    if (manifest.active_flow_id) notes.push(`${recoveredAt}: flow ${manifest.active_flow_id} requires explicit resume and live business-context validation.`);
    const session = this.session(workspace, manifest);
    manifest.status = "recovering";
    manifest.controlled_tab_ids = [];
    manifest.active_page_id = null;
    manifest.active_flow_id = null;
    manifest.browser_session_id = session.sessionId;
    manifest.report_root = session.reportRoot();
    manifest.resource_lease = emptyBrowserSpaceResourceLease();
    manifest.last_used_at = recoveredAt;
    manifest.recovery_notes = notes.slice(-20);
    await this.persistManifest(workspace, manifest);
  }

  private async persistTab(workspace: Workspace, manifest: BrowserSpaceManifest, tab: BrowserTabEntry): Promise<void> {
    const ownership: BrowserTabOwnership = browserTabOwnershipSchema.parse({
      version: 1,
      tab_id: tab.tabId,
      space_id: manifest.space_id,
      created_by_codexpro: tab.ownedByCodexPro,
      ownership: tab.ownedByCodexPro ? "owned" : "external",
      url: tab.url,
      title: tab.title,
      last_seen_at: now(),
      transfer_state: "none",
      close_with_space: tab.ownedByCodexPro
    });
    await this.writeJsonAtomic(workspace, browserSpaceTabPath(manifest.owner_run_id, manifest.space_id, tab.tabId), ownership);
  }

  private async persistManifest(workspace: Workspace, manifest: BrowserSpaceManifest): Promise<void> {
    const parsed = browserSpaceManifestSchema.parse(withoutSecrets(manifest));
    await this.writeJsonAtomic(workspace, browserSpaceManifestPath(parsed.owner_run_id, parsed.space_id), parsed);
  }

  private async writeJsonAtomic(workspace: Workspace, relPath: string, value: unknown): Promise<void> {
    const resolved = this.guard.resolve(workspace, relPath, { forWrite: true });
    const prior = this.writeQueue.get(resolved.absPath) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async () => {
      await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
      const temporary = `${resolved.absPath}.tmp-${process.pid}-${randomUUID()}`;
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, resolved.absPath);
    });
    this.writeQueue.set(resolved.absPath, operation);
    try {
      await operation;
    } finally {
      if (this.writeQueue.get(resolved.absPath) === operation) this.writeQueue.delete(resolved.absPath);
    }
  }
}
