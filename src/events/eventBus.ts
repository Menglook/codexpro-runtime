import { randomUUID } from "node:crypto";
import type { PermissionDecisionKind } from "../security/permissionDecision.js";

export type CodexProEventName =
  | "external_call.created"
  | "external_call.updated"
  | "external_call.delivery_unknown"
  | "external_call.recovery_planned"
  | "mcp.connection.changed"
  | "mcp.capabilities.rebound"
  | "task_created"
  | "task_assigned"
  | "task_started"
  | "task_interrupted"
  | "task_completed"
  | "run_created"
  | "resource_wait_started"
  | "resource_granted"
  | "resource_released"
  | "owner_acquired"
  | "owner_released"
  | "progress_recorded"
  | "acceptance_started"
  | "acceptance_completed"
  | "acceptance_cache_hit"
  | "execution_started"
  | "execution_heartbeat"
  | "execution_exited"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "tool_before_call"
  | "tool_after_call"
  | "model_before_switch"
  | "model_after_switch"
  | "git_before_commit"
  | "git_after_commit"
  | "git_before_push"
  | "git_after_push"
  | "browser_before_action"
  | "browser_after_action"
  | "validation_started"
  | "validation_completed"
  | "goal_stage_started"
  | "goal_stage_completed"
  | "context_before_compact"
  | "context_expanded"
  | "session_before_branch";

export interface CodexProEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  event_id: string;
  name: CodexProEventName;
  timestamp: string;
  source: string;
  correlation_id?: string;
  task_id?: string;
  step_id?: string;
  data: T;
}

export interface ExecutionObservation {
  observation_id: string;
  event_name: CodexProEventName;
  task_id: string | null;
  execution_id: string | null;
  step_id: string | null;
  executor: string | null;
  model: string | null;
  tool: string | null;
  start_time: string;
  duration_ms: number | null;
  input_size: number;
  output_size: number;
  exit_code: number | null;
  error_type: string | null;
  retry_count: number;
  heartbeat: string | null;
  side_effect: boolean;
  risk_level: string | null;
  artifact: string | null;
  source: string;
}

export interface EventDecision {
  block?: boolean;
  reason?: string;
  permission?: PermissionDecisionKind;
  constraints?: string[];
}

export type EventListenerRole = "observer" | "policy_advisor" | "security_controller";

export interface EventPermissionDecision {
  decision: PermissionDecisionKind;
  reason: string;
  constraints: string[];
  listener_id: string;
  listener_role: EventListenerRole;
}

export type EventListener = (event: CodexProEvent) => void | EventDecision | Promise<void | EventDecision>;

export interface EventListenerOptions {
  role?: EventListenerRole;
  listener_id?: string;
}

interface EventListenerRegistration {
  listener: EventListener;
  role: EventListenerRole;
  listener_id: string;
}

export interface EventDispatchResult {
  event: CodexProEvent;
  blocked: boolean;
  block_reasons: string[];
  permission_decisions: EventPermissionDecision[];
  listener_errors: string[];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstArtifact(data: Record<string, unknown>): string | null {
  const direct = stringValue(data.artifact) ?? stringValue(data.artifact_path) ?? stringValue(data.report_path) ?? stringValue(data.last_evidence);
  if (direct) return direct;
  const values = data.evidence_paths ?? data.artifacts;
  if (Array.isArray(values)) return values.map(stringValue).find((value): value is string => Boolean(value)) ?? null;
  return null;
}

function observationFromEvent(event: CodexProEvent): ExecutionObservation {
  const data = event.data;
  const serialized = JSON.stringify(data);
  const errorType = stringValue(data.error_type)
    ?? stringValue(data.failure_domain)
    ?? stringValue(data.error_code)
    ?? (data.outcome === "error" ? "tool_error" : null);
  return {
    observation_id: event.event_id,
    event_name: event.name,
    task_id: event.task_id ?? stringValue(data.task_id),
    execution_id: event.correlation_id ?? stringValue(data.execution_id) ?? stringValue(data.run_id),
    step_id: stringValue(data.step_id) ?? stringValue(data.current_step_id),
    executor: stringValue(data.executor) ?? stringValue(data.provider) ?? stringValue(data.domain) ?? event.source,
    model: stringValue(data.model) ?? stringValue(data.model_name) ?? stringValue(data.model_id),
    tool: stringValue(data.tool),
    start_time: stringValue(data.start_time) ?? event.timestamp,
    duration_ms: numberValue(data.duration_ms),
    input_size: Math.min(Buffer.byteLength(serialized, "utf8"), 1_000_000),
    output_size: Math.max(0, numberValue(data.output_size) ?? numberValue(data.output_bytes) ?? 0),
    exit_code: numberValue(data.exit_code),
    error_type: errorType,
    retry_count: Math.max(0, Math.floor(numberValue(data.retry_count) ?? numberValue(data.retries) ?? 0)),
    heartbeat: stringValue(data.heartbeat) ?? stringValue(data.heartbeat_at) ?? (event.name === "execution_heartbeat" ? event.timestamp : null),
    side_effect: data.side_effect === true || data.side_effect_level === "external_write" || data.side_effect_level === "local_write",
    risk_level: stringValue(data.risk_level),
    artifact: firstArtifact(data),
    source: event.source
  };
}

export class CodexProEventBus {
  private readonly listeners = new Map<CodexProEventName | "*", Set<EventListenerRegistration>>();
  private readonly events: CodexProEvent[] = [];
  private readonly observations: ExecutionObservation[] = [];
  private listenerSequence = 0;

  constructor(
    private readonly historyLimit = 200,
    private readonly listenerTimeoutMs = 1_000
  ) {}

  on(name: CodexProEventName | "*", listener: EventListener, options: EventListenerOptions = {}): () => void {
    const role = options.role ?? "policy_advisor";
    const bucket = this.listeners.get(name) ?? new Set<EventListenerRegistration>();
    this.listenerSequence += 1;
    const listenerId = String(options.listener_id ?? `${name}:${role}:${this.listenerSequence}`).trim();
    if (!listenerId) throw new Error("Event listener registration requires listener_id.");
    const registration: EventListenerRegistration = { listener, role, listener_id: listenerId };
    bucket.add(registration);
    this.listeners.set(name, bucket);
    return () => {
      bucket.delete(registration);
      if (!bucket.size) this.listeners.delete(name);
    };
  }

  async emit(
    name: CodexProEventName,
    data: Record<string, unknown> = {},
    metadata: { source?: string; correlation_id?: string; task_id?: string; step_id?: string } = {}
  ): Promise<EventDispatchResult> {
    const event: CodexProEvent = {
      event_id: randomUUID(),
      name,
      timestamp: new Date().toISOString(),
      source: metadata.source ?? "codexpro",
      ...(metadata.correlation_id ? { correlation_id: metadata.correlation_id } : {}),
      ...(metadata.task_id ? { task_id: metadata.task_id } : {}),
      ...(metadata.step_id ? { step_id: metadata.step_id } : {}),
      data: structuredClone(data)
    };
    this.events.push(event);
    this.observations.push(observationFromEvent(event));
    if (this.events.length > this.historyLimit) this.events.splice(0, this.events.length - this.historyLimit);
    if (this.observations.length > this.historyLimit) this.observations.splice(0, this.observations.length - this.historyLimit);

    const blockReasons: string[] = [];
    const permissionDecisions: EventPermissionDecision[] = [];
    const listenerErrors: string[] = [];
    const listeners = [
      ...(this.listeners.get(name) ?? []),
      ...(this.listeners.get("*") ?? [])
    ];
    for (const registration of listeners) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Event listener timed out after ${this.listenerTimeoutMs} ms.`)), this.listenerTimeoutMs);
        });
        const decision = await Promise.race([
          Promise.resolve(registration.listener(structuredClone(event))),
          timeout
        ]);
        const constraints = [...new Set((decision?.constraints ?? []).map((value) => String(value).trim()).filter(Boolean))];
        if (decision?.block) {
          const reason = decision.reason?.trim() || `Blocked by ${name} listener.`;
          if (registration.role === "security_controller") {
            blockReasons.push(reason);
          } else if (registration.role === "policy_advisor") {
            permissionDecisions.push({
              decision: "ask",
              reason: `${reason} Advisory block requests require explicit confirmation unless emitted by a security_controller.`,
              constraints: [...new Set([...constraints, "hook_block_advisory"])],
              listener_id: registration.listener_id,
              listener_role: registration.role
            });
          }
        } else if (decision?.permission && registration.role !== "observer") {
          permissionDecisions.push({
            decision: decision.permission,
            reason: decision.reason?.trim() || `${name} listener returned ${decision.permission}.`,
            constraints,
            listener_id: registration.listener_id,
            listener_role: registration.role
          });
        }
      } catch (error) {
        listenerErrors.push(error instanceof Error ? error.message : String(error));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    const uniqueBlockReasons = [...new Set(blockReasons)];
    const uniquePermissionDecisions = permissionDecisions.filter((decision, index, values) => {
      const key = JSON.stringify([
        decision.listener_role,
        decision.decision,
        decision.reason,
        [...decision.constraints].sort()
      ]);
      return values.findIndex((candidate) => JSON.stringify([
        candidate.listener_role,
        candidate.decision,
        candidate.reason,
        [...candidate.constraints].sort()
      ]) === key) === index;
    });
    return {
      event: structuredClone(event),
      blocked: uniqueBlockReasons.length > 0,
      block_reasons: uniqueBlockReasons,
      permission_decisions: uniquePermissionDecisions,
      listener_errors: [...new Set(listenerErrors)]
    };
  }

  snapshot(options: { name?: CodexProEventName; limit?: number } = {}): CodexProEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, this.historyLimit));
    const filtered = options.name ? this.events.filter((event) => event.name === options.name) : this.events;
    return structuredClone(filtered.slice(-limit));
  }

  snapshotObservations(options: {
    task_id?: string;
    execution_id?: string;
    error_type?: string;
    limit?: number;
  } = {}): ExecutionObservation[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, this.historyLimit));
    const filtered = this.observations.filter((observation) =>
      (!options.task_id || observation.task_id === options.task_id)
      && (!options.execution_id || observation.execution_id === options.execution_id)
      && (!options.error_type || observation.error_type === options.error_type)
    );
    return structuredClone(filtered.slice(-limit));
  }

  resetForTests(): void {
    this.listeners.clear();
    this.events.splice(0, this.events.length);
    this.observations.splice(0, this.observations.length);
  }
}

export const codexProEventBus = new CodexProEventBus();
