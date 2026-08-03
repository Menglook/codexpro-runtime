import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";

export type ObservationEventStatus = "started" | "completed" | "failed";

export interface ObserverSessionV1 {
  version: 1;
  session_id: string;
  call_role: "observer";
  conversation_id: string | null;
  actor_id: string;
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  started_at: string;
  updated_at: string;
  event_count: number;
  failed_event_count: number;
}

export interface ObservationEventV1 {
  version: 1;
  event_id: string;
  call_role: "observer";
  session_id: string;
  correlation_id: string;
  tool_name: string;
  action: string;
  status: ObservationEventStatus;
  error_code: string | null;
  safe_summary: string;
  occurred_at: string;
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  actor_id: string;
  actor_role: "observer";
  objective_id: null;
  attempt_id: null;
  run_id: null;
}

export interface ObserverMonitoringReportV1 {
  version: 1;
  report_id: string;
  session_id: string;
  call_role: "observer";
  project_id: string;
  workspace_id: string;
  workspace_generation: number;
  generated_at: string;
  observation_count: number;
  failed_observation_count: number;
  last_status: ObservationEventStatus;
  last_error_code: string | null;
  last_tool_name: string;
  last_summary: string;
}

export interface StartObservationInput {
  correlation_id: string;
  tool_name: string;
  action: string;
  actor_id?: string | null;
  conversation_id?: string | null;
  occurred_at?: string;
}

export interface FinishObservationInput {
  session_id: string;
  correlation_id: string;
  tool_name: string;
  action: string;
  actor_id: string;
  status: "completed" | "failed";
  error_code?: string | null;
  safe_summary: string;
  occurred_at?: string;
}

function clean(value: unknown, fallback: string, max = 500): string {
  const text = redactSensitiveText(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, max);
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizedConversationId(value: string | null | undefined): string | null {
  const cleaned = clean(value, "", 300);
  if (!cleaned || cleaned === "server-default") return null;
  return cleaned;
}

export class ObserverEventStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly guard: PathGuard, private readonly workspace: Workspace) {}

  root(): string {
    return ".codexpro/observer-sessions";
  }

  sessionId(conversationId: string | null | undefined): string {
    const normalized = normalizedConversationId(conversationId);
    const material = normalized ?? `degraded:${this.workspace.id}:${this.workspace.workspaceGeneration ?? 1}`;
    return `observer:${digest(material)}`;
  }

  sessionPath(sessionId: string): string {
    return `${this.root()}/${digest(sessionId)}/session.json`;
  }

  eventPath(sessionId: string, eventId: string): string {
    return `${this.root()}/${digest(sessionId)}/events/${digest(eventId)}.json`;
  }

  reportPath(sessionId: string): string {
    return `${this.root()}/${digest(sessionId)}/monitoring-report.json`;
  }

  async start(input: StartObservationInput): Promise<{ session: ObserverSessionV1; event: ObservationEventV1 }> {
    const conversationId = normalizedConversationId(input.conversation_id ?? this.workspace.conversationId);
    const sessionId = this.sessionId(conversationId);
    const actorId = clean(input.actor_id, `observer:${sessionId}`, 300);
    const occurredAt = input.occurred_at ?? new Date().toISOString();
    return await this.append({
      session_id: sessionId,
      conversation_id: conversationId,
      correlation_id: input.correlation_id,
      tool_name: input.tool_name,
      action: input.action,
      actor_id: actorId,
      status: "started",
      error_code: null,
      safe_summary: `开始只读观察：${clean(input.action, "读取状态", 300)}`,
      occurred_at: occurredAt
    });
  }

  async finish(input: FinishObservationInput): Promise<{ session: ObserverSessionV1; event: ObservationEventV1 }> {
    return await this.append({
      session_id: clean(input.session_id, "observer:degraded", 300),
      conversation_id: normalizedConversationId(this.workspace.conversationId),
      correlation_id: input.correlation_id,
      tool_name: input.tool_name,
      action: input.action,
      actor_id: input.actor_id,
      status: input.status,
      error_code: input.status === "failed" ? clean(input.error_code, "tool_failed", 120) : null,
      safe_summary: input.safe_summary,
      occurred_at: input.occurred_at ?? new Date().toISOString()
    });
  }

  async list(sessionId: string, options: { limit?: number } = {}): Promise<ObservationEventV1[]> {
    const sessionRoot = this.guard.resolve(this.workspace, `${this.root()}/${digest(sessionId)}/events`);
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)));
    const names = await fsp.readdir(sessionRoot.absPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const events: ObservationEventV1[] = [];
    for (const name of names.filter((item) => /^[a-f0-9]{24}\.json$/.test(item)).sort()) {
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(sessionRoot.absPath, name), "utf8")) as ObservationEventV1;
        if (parsed.version === 1 && parsed.session_id === sessionId && parsed.actor_role === "observer") events.push(parsed);
      } catch {
        // Preserve malformed observation evidence but do not expose it as a valid event.
      }
    }
    return events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.event_id.localeCompare(right.event_id)).slice(-limit);
  }

  async readSession(sessionId: string): Promise<ObserverSessionV1 | null> {
    const target = this.guard.resolve(this.workspace, this.sessionPath(sessionId));
    try {
      const parsed = JSON.parse(await fsp.readFile(target.absPath, "utf8")) as ObserverSessionV1;
      return parsed.version === 1 && parsed.session_id === sessionId && parsed.call_role === "observer" ? parsed : null;
    } catch {
      return null;
    }
  }

  async readReport(sessionId: string): Promise<ObserverMonitoringReportV1 | null> {
    const target = this.guard.resolve(this.workspace, this.reportPath(sessionId));
    try {
      const parsed = JSON.parse(await fsp.readFile(target.absPath, "utf8")) as ObserverMonitoringReportV1;
      return parsed.version === 1 && parsed.session_id === sessionId && parsed.call_role === "observer" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async append(input: {
    session_id: string;
    conversation_id: string | null;
    correlation_id: string;
    tool_name: string;
    action: string;
    actor_id: string;
    status: ObservationEventStatus;
    error_code: string | null;
    safe_summary: string;
    occurred_at: string;
  }): Promise<{ session: ObserverSessionV1; event: ObservationEventV1 }> {
    const write = async (): Promise<{ session: ObserverSessionV1; event: ObservationEventV1 }> => {
      const eventId = `observation:${digest(`${input.session_id}\0${input.correlation_id}\0${input.status}\0${input.occurred_at}\0${randomUUID()}`)}`;
      const event: ObservationEventV1 = {
        version: 1,
        event_id: eventId,
        call_role: "observer",
        session_id: input.session_id,
        correlation_id: clean(input.correlation_id, "correlation", 300),
        tool_name: clean(input.tool_name, "tool", 160),
        action: clean(input.action, "读取状态", 300),
        status: input.status,
        error_code: input.error_code,
        safe_summary: clean(input.safe_summary, input.status === "failed" ? "只读观察失败" : "只读观察完成", 500),
        occurred_at: input.occurred_at,
        project_id: clean(this.workspace.projectId, path.basename(this.workspace.root) || "project", 240),
        workspace_id: clean(this.workspace.id, "workspace", 240),
        workspace_generation: Math.max(1, Math.floor(this.workspace.workspaceGeneration ?? 1)),
        actor_id: clean(input.actor_id, `observer:${input.session_id}`, 300),
        actor_role: "observer",
        objective_id: null,
        attempt_id: null,
        run_id: null
      };
      const previous = await this.readSession(input.session_id);
      const session: ObserverSessionV1 = {
        version: 1,
        session_id: input.session_id,
        call_role: "observer",
        conversation_id: input.conversation_id,
        actor_id: event.actor_id,
        project_id: event.project_id,
        workspace_id: event.workspace_id,
        workspace_generation: event.workspace_generation,
        started_at: previous?.started_at ?? input.occurred_at,
        updated_at: input.occurred_at,
        event_count: (previous?.event_count ?? 0) + 1,
        failed_event_count: (previous?.failed_event_count ?? 0) + (input.status === "failed" ? 1 : 0)
      };
      const report: ObserverMonitoringReportV1 = {
        version: 1,
        report_id: `monitoring:${digest(input.session_id)}`,
        session_id: input.session_id,
        call_role: "observer",
        project_id: event.project_id,
        workspace_id: event.workspace_id,
        workspace_generation: event.workspace_generation,
        generated_at: input.occurred_at,
        observation_count: session.event_count,
        failed_observation_count: session.failed_event_count,
        last_status: event.status,
        last_error_code: event.error_code,
        last_tool_name: event.tool_name,
        last_summary: event.safe_summary
      };
      await this.atomicJson(this.eventPath(input.session_id, eventId), event);
      await this.atomicJson(this.sessionPath(input.session_id), session);
      await this.atomicJson(this.reportPath(input.session_id), report);
      return { session, event };
    };
    const result = this.operationQueue.then(write, write);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return structuredClone(await result);
  }

  private async atomicJson(relativePath: string, value: unknown): Promise<void> {
    const target = this.guard.resolve(this.workspace, relativePath, { forWrite: true });
    await fsp.mkdir(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
    const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.rename(temporary, target.absPath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
