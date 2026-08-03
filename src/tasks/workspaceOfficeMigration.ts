import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import { RuntimeActivityEventStore } from "../runtime/activityEventStore.js";
import type { TaskActorIdentityV1, TaskIdentity, TaskWorkspaceBindingV1 } from "./types.js";
import { TaskIdentityStore } from "./taskIdentityStore.js";

export interface WorkspaceOfficeMigrationResultV1 {
  version: 1;
  dry_run: boolean;
  generated_at: string;
  workspace_root: string;
  scanned: number;
  upgraded: number;
  observer_classified: number;
  degraded_rebound: number;
  already_current: number;
  backups_written: number;
  runtime_events_replayed: number;
  originals_deleted: 0;
  report_path: string | null;
}

function actorFor(identity: TaskIdentity): TaskActorIdentityV1 {
  const observer = /(?:\bobserver\b|\bmonitor(?:ing)?\b|只读监控|办公室截图|状态巡检)/i.test(identity.title)
    && !/(?:implement|repair|fix|write|build|test|修改|修复|开发|验收)/i.test(identity.title);
  return {
    version: 1,
    actor_id: `actor:legacy:${identity.task_id}`,
    session_id: "legacy-migration",
    role: observer ? "observer" : "executor"
  };
}

function bindingFor(identity: TaskIdentity, workspace: Workspace): TaskWorkspaceBindingV1 {
  const root = path.resolve(identity.project_root);
  return {
    version: 1,
    objective_id: identity.objective?.objective_key ?? `legacy:${identity.kind}:${identity.domain_id}`,
    project_id: path.basename(root) || workspace.projectId || "project",
    workspace_id: root === path.resolve(workspace.root) ? workspace.id : `legacy:${path.basename(root) || "workspace"}`,
    workspace_root: root,
    workspace_generation: root === path.resolve(workspace.root) ? Math.max(1, workspace.workspaceGeneration ?? 1) : 1,
    source_conversation_id: "legacy-migration",
    immutable_after_start: true
  };
}

async function atomicJson(guard: PathGuard, workspace: Workspace, relativePath: string, value: unknown): Promise<void> {
  const target = guard.resolve(workspace, relativePath, { forWrite: true });
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

export async function migrateWorkspaceOfficeAuthority(
  guard: PathGuard,
  workspace: Workspace,
  options: { dry_run?: boolean } = {}
): Promise<WorkspaceOfficeMigrationResultV1> {
  const dryRun = options.dry_run !== false;
  const store = new TaskIdentityStore(guard, workspace);
  const identities = await store.listAll();
  const migrated: TaskIdentity[] = [];
  let upgraded = 0;
  let observerClassified = 0;
  let degradedRebound = 0;
  let alreadyCurrent = 0;
  let backupsWritten = 0;
  let runtimeEventsReplayed = 0;
  const runtimeEvents = new RuntimeActivityEventStore(guard, workspace);
  for (const identity of identities) {
    const degradedBinding = identity.actor?.session_id === "server-default"
      || identity.workspace_binding?.source_conversation_id === "server-default";
    if (identity.workspace_binding && identity.actor && !degradedBinding) {
      alreadyCurrent += 1;
      migrated.push(identity);
      continue;
    }
    if (degradedBinding) degradedRebound += 1;
    const next: TaskIdentity = {
      ...identity,
      workspace_binding: degradedBinding ? bindingFor(identity, workspace) : (identity.workspace_binding ?? bindingFor(identity, workspace)),
      actor: degradedBinding ? actorFor(identity) : (identity.actor ?? actorFor(identity)),
      identity_quality: "degraded",
      legacy_binding: true,
      updated_at: identity.updated_at
    };
    if (next.actor?.role === "observer") observerClassified += 1;
    upgraded += 1;
    migrated.push(next);
    if (dryRun) continue;
    const backupPath = `.codexpro/workspace-office-migration/originals/${identity.task_id}/identity.json`;
    const backup = guard.resolve(workspace, backupPath);
    try {
      await fsp.access(backup.absPath);
    } catch {
      await atomicJson(guard, workspace, backupPath, identity);
      backupsWritten += 1;
    }
    await atomicJson(guard, workspace, store.identityPath(identity.task_id), next);
    if (next.actor?.role !== "observer") {
      const objectiveId = next.workspace_binding?.objective_id ?? next.objective?.objective_key ?? `legacy:${next.kind}:${next.domain_id}`;
      await runtimeEvents.append({
        kind: "objective.created",
        objective_id: objectiveId,
        attempt_id: next.task_id,
        run_id: next.domain_id,
        actor_id: next.actor?.actor_id ?? null,
        actor_role: next.actor?.role ?? "executor",
        occurred_at: next.created_at,
        payload: { migrated: true, title: next.title }
      });
      await runtimeEvents.append({
        kind: "attempt.started",
        objective_id: objectiveId,
        attempt_id: next.task_id,
        run_id: next.domain_id,
        actor_id: next.actor?.actor_id ?? null,
        actor_role: next.actor?.role ?? "executor",
        occurred_at: next.created_at,
        payload: { migrated: true, previous_attempt_id: next.objective?.previous_attempt_id ?? null }
      });
      runtimeEventsReplayed += 2;
    }
  }
  if (!dryRun && upgraded > 0) await store.replaceOfficeIndex(migrated);
  const generatedAt = new Date().toISOString();
  const report: WorkspaceOfficeMigrationResultV1 = {
    version: 1,
    dry_run: dryRun,
    generated_at: generatedAt,
    workspace_root: workspace.root,
    scanned: identities.length,
    upgraded,
    observer_classified: observerClassified,
    degraded_rebound: degradedRebound,
    already_current: alreadyCurrent,
    backups_written: backupsWritten,
    runtime_events_replayed: runtimeEventsReplayed,
    originals_deleted: 0,
    report_path: dryRun ? null : ".codexpro/workspace-office-migration/report.json"
  };
  if (!dryRun) await atomicJson(guard, workspace, report.report_path!, report);
  return report;
}
