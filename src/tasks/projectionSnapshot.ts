import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { PathGuard, type Workspace } from "../guard.js";
import { projectObjectives, type ObjectiveProjectionV1 } from "./objectiveProjectionService.js";
import { TaskProjectionService, type TaskProjectionListOptions } from "./taskProjectionService.js";
import type { TaskProjectionListObservability, TaskStatusProjection } from "./types.js";

export interface ProjectionSnapshotV1 {
  version: 1;
  request_id: string;
  project_root: string;
  generated_at: string;
  source_revision: string | null;
  tasks: TaskStatusProjection[];
  objectives: ObjectiveProjectionV1[];
  task_projection_observability: TaskProjectionListObservability;
}

export interface ProjectionSnapshotReadResult {
  snapshot: ProjectionSnapshotV1;
  cache_hit: boolean;
}

export type ProjectionSnapshotReadOptions = TaskProjectionListOptions;

export interface ProjectionSnapshotProviderObservabilityV1 {
  version: 1;
  request_id: string;
  project_count: number;
  task_projection_invocation_count: number;
  cache_hit: number;
  cache_miss: number;
}

export class ProjectionSnapshotProvider {
  private readonly snapshots = new Map<string, Promise<ProjectionSnapshotV1>>();
  private taskProjectionInvocationCount = 0;
  private cacheHitCount = 0;
  private cacheMissCount = 0;

  constructor(
    private readonly config: CodexProConfig,
    private readonly requestId = `projection-request-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ) {}

  async get(
    workspace: Workspace,
    options: ProjectionSnapshotReadOptions = {},
    projectionService?: TaskProjectionService
  ): Promise<ProjectionSnapshotReadResult> {
    const profile = options.profile ?? "full";
    const activeLimit = options.office_active_objective_limit ?? "default";
    const archiveLimit = options.office_archive_objective_limit ?? "default";
    const key = `${path.resolve(workspace.root)}\u0000${profile}\u0000${activeLimit}\u0000${archiveLimit}`;
    const existing = this.snapshots.get(key);
    if (existing) {
      this.cacheHitCount += 1;
      return { snapshot: await existing, cache_hit: true };
    }

    this.cacheMissCount += 1;
    const pending = this.build(workspace, options, projectionService);
    this.snapshots.set(key, pending);
    try {
      return { snapshot: await pending, cache_hit: false };
    } catch (error) {
      this.snapshots.delete(key);
      throw error;
    }
  }

  observability(): ProjectionSnapshotProviderObservabilityV1 {
    return {
      version: 1,
      request_id: this.requestId,
      project_count: this.snapshots.size,
      task_projection_invocation_count: this.taskProjectionInvocationCount,
      cache_hit: this.cacheHitCount,
      cache_miss: this.cacheMissCount
    };
  }

  private async build(
    workspace: Workspace,
    options: ProjectionSnapshotReadOptions,
    projectionService?: TaskProjectionService
  ): Promise<ProjectionSnapshotV1> {
    this.taskProjectionInvocationCount += 1;
    const guard = new PathGuard(this.config);
    const service = projectionService ?? new TaskProjectionService(this.config, guard, workspace, { readOnly: true });
    const projection = await service.listStatusesWithObservability(250, options);
    return {
      version: 1,
      request_id: this.requestId,
      project_root: path.resolve(workspace.root),
      generated_at: new Date().toISOString(),
      source_revision: null,
      tasks: projection.tasks,
      objectives: projectObjectives(projection.tasks),
      task_projection_observability: projection.observability
    };
  }
}
