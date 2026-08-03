import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { OfficeProjectionReceiptV1, PublicToolActorRole } from "../runtime/publicToolOutcome.js";
import { PublicToolOutcomeStore, type PublicToolOutcomeConsistencyV1, type PublicToolOutcomeListResultV1 } from "../runtime/publicToolOutcomeStore.js";
import { ToolOutcomeProjectionPublisher } from "../runtime/toolOutcomeProjectionPublisher.js";
import {
  discoverDashboardProjects,
  workspaceForDashboardProject,
  type DashboardProjectSummary
} from "./projectAggregationService.js";

export class OfficeToolOutcomeServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OfficeToolOutcomeServiceError";
  }
}

export interface OfficeToolOutcomeQuery {
  project: string;
  afterSequence?: number;
  taskId?: string;
  actorRole?: PublicToolActorRole;
  limit?: number;
}

export interface OfficeToolOutcomeResponse extends PublicToolOutcomeListResultV1 {
  ok: true;
  project_id: string;
  state_authority_changed: false;
}

export interface OfficeToolOutcomeReceiptResponse {
  ok: true;
  project_id: string;
  receipt: OfficeProjectionReceiptV1;
  state_authority_changed: false;
}

export interface OfficeToolOutcomeConsistencyResponse extends PublicToolOutcomeConsistencyV1 {
  project_id: string;
  state_authority_changed: false;
}

function finiteSequence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new OfficeToolOutcomeServiceError(400, "invalid_tool_outcome_query", "after_sequence must be a non-negative integer.");
  return value;
}

function boundedLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new OfficeToolOutcomeServiceError(400, "invalid_tool_outcome_query", "limit must be an integer from 1 to 200.");
  return value;
}

function validRole(value: PublicToolActorRole | undefined): PublicToolActorRole | undefined {
  if (value === undefined) return undefined;
  if (!["executor", "reviewer", "observer", "system"].includes(value)) throw new OfficeToolOutcomeServiceError(400, "invalid_tool_outcome_query", "actor_role is invalid.");
  return value;
}

export function officeToolOutcomeFeatureFlag(env: NodeJS.ProcessEnv = process.env): {
  projection_enabled: boolean;
  stream_enabled: boolean;
  assistant_updates_enabled: boolean;
  detail_enabled: boolean;
} {
  const enabled = (value: string | undefined, fallback: boolean) => {
    if (value === undefined || value.trim() === "") return fallback;
    return !["0", "false", "no", "off", "none"].includes(value.trim().toLowerCase());
  };
  return {
    projection_enabled: enabled(env.CODEXPRO_OFFICE_TOOL_OUTCOME_PROJECTION, true),
    stream_enabled: enabled(env.CODEXPRO_OFFICE_EVENT_STREAM, true),
    assistant_updates_enabled: enabled(env.CODEXPRO_OFFICE_ASSISTANT_UPDATES, true),
    detail_enabled: enabled(env.CODEXPRO_OFFICE_TOOL_DETAIL, true)
  };
}

export class OfficeToolOutcomeService {
  constructor(readonly config: CodexProConfig) {}

  private project(selector: string): DashboardProjectSummary {
    const requested = selector.trim();
    if (!requested) throw new OfficeToolOutcomeServiceError(400, "project_required", "project is required.");
    const matches = discoverDashboardProjects(this.config).filter((project) =>
      project.project_id === requested
      || project.name === requested
      || path.resolve(project.root) === path.resolve(requested)
    );
    if (matches.length !== 1 || !matches[0].available) throw new OfficeToolOutcomeServiceError(404, "project_not_found", "The requested Office project is unavailable or ambiguous.");
    return matches[0];
  }

  private context(selector: string): { project: DashboardProjectSummary; store: PublicToolOutcomeStore } {
    const project = this.project(selector);
    return { project, store: new PublicToolOutcomeStore(workspaceForDashboardProject(project)) };
  }

  async events(query: OfficeToolOutcomeQuery): Promise<OfficeToolOutcomeResponse> {
    const afterSequence = finiteSequence(query.afterSequence);
    const limit = boundedLimit(query.limit);
    const actorRole = validRole(query.actorRole);
    const { project, store } = this.context(query.project);
    const result = await store.list({
      after_sequence: afterSequence,
      task_id: query.taskId?.trim() || undefined,
      actor_role: actorRole,
      limit
    });
    return { ok: true, project_id: project.project_id, ...result, state_authority_changed: false };
  }

  async receipt(projectSelector: string, eventId: string): Promise<OfficeToolOutcomeReceiptResponse> {
    if (!/^tool-result:[a-f0-9]{24}$/.test(eventId)) throw new OfficeToolOutcomeServiceError(400, "invalid_event_id", "eventId is invalid.");
    const { project, store } = this.context(projectSelector);
    const receipt = await store.receipt(eventId);
    if (!receipt) throw new OfficeToolOutcomeServiceError(404, "projection_receipt_not_found", "The requested Office projection receipt was not found.");
    return { ok: true, project_id: project.project_id, receipt, state_authority_changed: false };
  }

  async recoverPending(limitPerProject = 100): Promise<{ project_id: string; recovered: number }[]> {
    const results: { project_id: string; recovered: number }[] = [];
    for (const project of discoverDashboardProjects(this.config).filter((item) => item.available)) {
      const workspace = workspaceForDashboardProject(project);
      const recovered = await new ToolOutcomeProjectionPublisher(this.config, workspace).drainPending(limitPerProject).catch(() => 0);
      results.push({ project_id: project.project_id, recovered });
    }
    return results;
  }

  async consistency(projectSelector: string): Promise<OfficeToolOutcomeConsistencyResponse> {
    const { project, store } = this.context(projectSelector);
    const result = await store.consistency();
    return { project_id: project.project_id, ...result, state_authority_changed: false };
  }
}
