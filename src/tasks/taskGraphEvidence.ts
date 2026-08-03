import type { GoalEvent, GoalRecord } from "../goals/types.js";
import type { HandoffStatusResult } from "../handoffStatus.js";
import type { DurableJobRecord, DurableJobStep } from "../jobs/jobSteps.js";
import {
  structuredRuntimeEventFromGoalEvent,
  type StructuredRuntimeEventEnvelopeV1
} from "../runtime/structuredRuntimeEvents.js";
import type {
  TaskExecutionGraphEvidenceV1,
  TaskGraphExecutionRelationKind,
  TaskGraphNodeEvidenceV1,
  TaskGraphNodeState,
  TaskGraphNodeType,
  TaskGraphRelationEvidenceV1,
  TaskGraphRetryPolicy,
  TaskGraphRouteSource
} from "./types.js";

const NODE_LIMIT = 50;
const RELATION_LIMIT = 100;
const RELATION_KINDS = new Set<TaskGraphExecutionRelationKind>([
  "sequence",
  "dependency",
  "branch",
  "parallel",
  "join",
  "retry",
  "recovery",
  "handoff"
]);
const ROUTE_SOURCES = new Set<TaskGraphRouteSource>(["code", "ai", "human", "runtime", "unknown"]);
const RETRY_POLICIES = new Set<TaskGraphRetryPolicy>(["not_applicable", "automatic", "manual", "never", "unknown"]);

type JsonRecord = Record<string, unknown>;

interface StructuredGoalEvent {
  event: GoalEvent;
  envelope: StructuredRuntimeEventEnvelopeV1;
  details: JsonRecord;
  source_ref: string;
  evidence_ref: string;
  node_id: string;
}

interface ExplicitGraphContext {
  attempt_node_id: string;
  source_kind: TaskGraphRelationEvidenceV1["source_kind"];
  source_ref: string;
  evidence_ref: string;
  fallback_route_source: TaskGraphRouteSource;
  fallback_transition_reason: string | null;
  resolve_node_id(value: unknown, relation?: JsonRecord, side?: "from" | "to"): string;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000\r\n]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function routeSource(value: unknown, fallback: TaskGraphRouteSource = "unknown"): TaskGraphRouteSource {
  const candidate = text(value, 30) as TaskGraphRouteSource | null;
  return candidate && ROUTE_SOURCES.has(candidate) ? candidate : fallback;
}

function retryPolicy(value: unknown, fallback: TaskGraphRetryPolicy = "unknown"): TaskGraphRetryPolicy {
  const candidate = text(value, 30) as TaskGraphRetryPolicy | null;
  return candidate && RETRY_POLICIES.has(candidate) ? candidate : fallback;
}

function unique(values: Array<string | null | undefined>, limit = 20): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, limit);
}

function relationKind(value: unknown): TaskGraphExecutionRelationKind | null {
  const candidate = text(value, 40) as TaskGraphExecutionRelationKind | null;
  return candidate && RELATION_KINDS.has(candidate) ? candidate : null;
}

function nodeTypeForEvent(eventName: string, componentId: string): TaskGraphNodeType {
  if (eventName.startsWith("subagent.") || componentId.startsWith("subagent:")) return "worker";
  if (eventName.startsWith("tool_") || componentId.startsWith("tool:") || componentId.startsWith("external_call:")) return "tool_process";
  if (componentId.startsWith("model_stream:")) return "model_stream";
  return "tool_process";
}

function stateForEvent(eventName: string, terminal: boolean): TaskGraphNodeState {
  if (terminal || ["completed", "failed", "cancelled", "subagent.completed", "subagent.failed", "subagent.cancelled"].includes(eventName)) {
    return "terminal";
  }
  if (eventName === "subagent.created") return "idle";
  if (eventName.includes("delivery_unknown") || eventName.includes("snapshot_mismatch")) return "stale";
  if (eventName.includes("started") || eventName.includes("progress") || eventName.includes("deliverable") || eventName.includes("proof_")) {
    return "active";
  }
  return "waiting";
}

function stateForStep(status: DurableJobStep["status"]): TaskGraphNodeState {
  if (["completed", "failed", "blocked", "cancelled"].includes(status)) return "terminal";
  if (status === "running") return "active";
  if (status === "recovery_required") return "stale";
  return "waiting";
}

function sourceRefForGoalEvent(goalId: string, sequence: number): string {
  return `goal-event:${goalId}:${sequence}`;
}

function goalCheckpointRef(goal: GoalRecord): string {
  return `goal-checkpoint:${goal.goal_id}:${goal.updated_at}`;
}

function durableStepRef(job: DurableJobRecord, step: DurableJobStep, attempt: number): string {
  return `.codexpro/runs/${job.run_id}/steps/${step.step_id}/step.json#attempt-${attempt}`;
}

function structuredDetails(event: GoalEvent): JsonRecord {
  const data = record(event.data) ?? {};
  return record(data.details) ?? {};
}

function eventTransitionReason(item: StructuredGoalEvent): string | null {
  return text(item.details.transition_reason, 1_000)
    ?? text(item.details.reason, 1_000)
    ?? text(item.envelope.retry_semantics.reason, 1_000);
}

function eventLabel(item: StructuredGoalEvent): string {
  return text(item.details.label, 180)
    ?? text(item.details.role, 120)
    ?? text(item.details.tool, 120)
    ?? item.envelope.component_id;
}

function mergeNode(current: TaskGraphNodeEvidenceV1 | undefined, incoming: TaskGraphNodeEvidenceV1): TaskGraphNodeEvidenceV1 {
  if (!current) return incoming;
  const currentSequence = current.sequence ?? -1;
  const incomingSequence = incoming.sequence ?? -1;
  const latest = incomingSequence >= currentSequence ? incoming : current;
  const earlier = latest === incoming ? current : incoming;
  return {
    ...earlier,
    ...latest,
    parent_run_id: latest.parent_run_id ?? earlier.parent_run_id,
    parent_node_id: latest.parent_node_id ?? earlier.parent_node_id,
    evidence_refs: unique([...current.evidence_refs, ...incoming.evidence_refs], 30),
    started_at: current.started_at ?? incoming.started_at,
    completed_at: incoming.completed_at ?? current.completed_at
  };
}

function boundedEvidence(
  authority: TaskExecutionGraphEvidenceV1["authority"],
  nodes: TaskGraphNodeEvidenceV1[],
  relations: TaskGraphRelationEvidenceV1[],
  degradedReasons: string[]
): TaskExecutionGraphEvidenceV1 {
  const visibleNodes = nodes.slice(0, NODE_LIMIT);
  const nodeIds = new Set(visibleNodes.map((node) => node.node_id));
  const visibleRelations = relations
    .filter((relation) => nodeIds.has(relation.from_node_id) && nodeIds.has(relation.to_node_id))
    .slice(0, RELATION_LIMIT);
  const truncated = nodes.length > visibleNodes.length || relations.length > visibleRelations.length;
  const reasons = unique([
    ...degradedReasons,
    ...(truncated ? ["执行图证据超过节点或关系上限，已安全截断并移除悬空关系。"] : [])
  ], 50);
  return {
    version: 1,
    authority,
    nodes: visibleNodes,
    relations: visibleRelations,
    degraded_reasons: reasons,
    truncated
  };
}

function graphRecords(details: JsonRecord): JsonRecord[] {
  const values = [
    details.office_relation,
    details.graph_relation,
    ...(Array.isArray(details.office_relations) ? details.office_relations : []),
    ...(Array.isArray(details.graph_relations) ? details.graph_relations : []),
    ...(Array.isArray(details.relations) ? details.relations : [])
  ];
  return values.map(record).filter((value): value is JsonRecord => Boolean(value));
}

function endpointValue(relation: JsonRecord, side: "from" | "to"): unknown {
  return relation[`${side}_node_id`]
    ?? relation[`${side}_component_id`]
    ?? relation[`${side}_step_id`]
    ?? relation[side];
}

function explicitRelation(relation: JsonRecord, context: ExplicitGraphContext): TaskGraphRelationEvidenceV1 | null {
  const edgeKind = relationKind(relation.edge_kind ?? relation.relation);
  if (!edgeKind) return null;
  const fromNodeId = context.resolve_node_id(endpointValue(relation, "from"), relation, "from");
  const toNodeId = context.resolve_node_id(endpointValue(relation, "to"), relation, "to");
  const evidenceRef = text(relation.evidence_ref, 1_000) ?? context.evidence_ref;
  if (!fromNodeId || !toNodeId || !evidenceRef) return null;
  return {
    version: 1,
    edge_kind: edgeKind,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    source_kind: context.source_kind,
    source_ref: text(relation.source_ref, 1_000) ?? context.source_ref,
    evidence_ref: evidenceRef,
    route_source: routeSource(relation.route_source, context.fallback_route_source),
    transition_reason: text(relation.transition_reason, 1_000) ?? context.fallback_transition_reason,
    condition: text(relation.condition, 1_000),
    selected: bool(relation.selected),
    relation_group: text(relation.relation_group ?? relation.group_id, 500),
    dependency_satisfied: bool(relation.dependency_satisfied ?? relation.satisfied),
    retry_policy: retryPolicy(relation.retry_policy, edgeKind === "retry" ? "unknown" : "not_applicable"),
    replay_allowed: bool(relation.replay_allowed),
    attempt: positiveInteger(relation.attempt),
    max_attempts: positiveInteger(relation.max_attempts),
    idempotency_key: text(relation.idempotency_key, 1_000)
  };
}

function explicitNode(value: JsonRecord, context: ExplicitGraphContext): TaskGraphNodeEvidenceV1 | null {
  const rawNodeId = text(value.node_id, 500);
  if (!rawNodeId) return null;
  const nodeId = context.resolve_node_id(rawNodeId);
  const rawType = text(value.node_type, 40);
  const nodeType: TaskGraphNodeType = rawType === "model_stream" || rawType === "tool_process" || rawType === "worker"
    ? rawType
    : "worker";
  const rawState = text(value.state, 40);
  const state: TaskGraphNodeState = rawState === "active" || rawState === "waiting" || rawState === "idle" || rawState === "stale" || rawState === "terminal" || rawState === "unknown"
    ? rawState
    : "unknown";
  const evidenceRef = text(value.evidence_ref, 1_000) ?? context.evidence_ref;
  return {
    version: 1,
    node_id: nodeId,
    node_type: nodeType,
    label: text(value.label, 180) ?? nodeId,
    state,
    task_id: text(value.task_id, 300) ?? context.attempt_node_id.replace(/^attempt:/, ""),
    run_id: text(value.run_id, 300),
    parent_run_id: text(value.parent_run_id, 300),
    parent_node_id: value.parent_node_id ? context.resolve_node_id(value.parent_node_id) : null,
    component_id: text(value.component_id, 500),
    source_kind: context.source_kind,
    source_ref: text(value.source_ref, 1_000) ?? context.source_ref,
    evidence_refs: unique([evidenceRef]),
    sequence: positiveInteger(value.sequence),
    updated_at: text(value.updated_at, 100),
    started_at: text(value.started_at, 100),
    completed_at: text(value.completed_at, 100),
    route_source: routeSource(value.route_source, context.fallback_route_source),
    transition_reason: text(value.transition_reason, 1_000) ?? context.fallback_transition_reason,
    retry_policy: retryPolicy(value.retry_policy, "unknown"),
    replay_allowed: bool(value.replay_allowed),
    attempt: positiveInteger(value.attempt),
    max_attempts: positiveInteger(value.max_attempts)
  };
}

function appendExplicitGraph(
  graphValue: unknown,
  context: ExplicitGraphContext,
  nodes: Map<string, TaskGraphNodeEvidenceV1>,
  relations: TaskGraphRelationEvidenceV1[],
  degradedReasons: string[]
): void {
  const graph = record(graphValue);
  if (!graph) return;
  for (const candidate of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const parsed = record(candidate);
    const node = parsed ? explicitNode(parsed, context) : null;
    if (!node) {
      degradedReasons.push(`${context.source_ref} 包含无法解析的显式节点，已省略。`);
      continue;
    }
    nodes.set(node.node_id, mergeNode(nodes.get(node.node_id), node));
  }
  for (const candidate of Array.isArray(graph.relations) ? graph.relations : Array.isArray(graph.edges) ? graph.edges : []) {
    const parsed = record(candidate);
    const relation = parsed ? explicitRelation(parsed, context) : null;
    if (!relation) {
      degradedReasons.push(`${context.source_ref} 包含无法解析的显式关系，已省略。`);
      continue;
    }
    relations.push(relation);
  }
}

export function taskGraphEvidenceFromGoal(goal: GoalRecord, events: GoalEvent[]): TaskExecutionGraphEvidenceV1 {
  const attemptNodeId = `attempt:goal-${goal.goal_id}`;
  const degradedReasons: string[] = [];
  const relations: TaskGraphRelationEvidenceV1[] = [];
  const nodes = new Map<string, TaskGraphNodeEvidenceV1>();
  const structured: StructuredGoalEvent[] = [];

  for (const event of events) {
    let envelope: StructuredRuntimeEventEnvelopeV1 | null = null;
    try {
      envelope = structuredRuntimeEventFromGoalEvent(event);
    } catch (error) {
      degradedReasons.push(`Goal 事件 ${event.sequence} 的结构化运行证据无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!envelope) continue;
    const sourceRef = sourceRefForGoalEvent(goal.goal_id, event.sequence);
    structured.push({
      event,
      envelope,
      details: structuredDetails(event),
      source_ref: sourceRef,
      evidence_ref: envelope.evidence_ref ?? sourceRef,
      node_id: ""
    });
  }

  const runsByComponent = new Map<string, Set<string>>();
  for (const item of structured) {
    const runs = runsByComponent.get(item.envelope.component_id) ?? new Set<string>();
    runs.add(item.envelope.run_id);
    runsByComponent.set(item.envelope.component_id, runs);
  }
  const keyToNodeId = new Map<string, string>();
  const runToNodeIds = new Map<string, Set<string>>();
  for (const item of structured) {
    const mainGoalEvent = item.envelope.component_id === `goal:${goal.goal_id}`
      || item.envelope.task_id === `goal-${goal.goal_id}`;
    const multipleRuns = (runsByComponent.get(item.envelope.component_id)?.size ?? 0) > 1;
    const nodeId = mainGoalEvent
      ? attemptNodeId
      : multipleRuns
        ? `runtime:${item.envelope.run_id}:${item.envelope.component_id}`
        : item.envelope.component_id;
    item.node_id = nodeId;
    keyToNodeId.set(`${item.envelope.run_id}\u0000${item.envelope.component_id}`, nodeId);
    const runNodes = runToNodeIds.get(item.envelope.run_id) ?? new Set<string>();
    runNodes.add(nodeId);
    runToNodeIds.set(item.envelope.run_id, runNodes);
  }

  const resolveComponentNode = (componentId: string, runId?: string | null): string => {
    if (componentId === "attempt" || componentId === attemptNodeId) return attemptNodeId;
    if (runId) return keyToNodeId.get(`${runId}\u0000${componentId}`) ?? componentId;
    const candidates = structured.filter((item) => item.envelope.component_id === componentId).map((item) => item.node_id);
    return unique(candidates, 2).length === 1 ? candidates[0] : componentId;
  };

  for (const item of structured) {
    const parentCandidates = item.envelope.parent_run_id ? [...(runToNodeIds.get(item.envelope.parent_run_id) ?? [])] : [];
    const parentNodeId = item.node_id === attemptNodeId
      ? null
      : item.envelope.parent_run_id === goal.run_id
        ? attemptNodeId
        : parentCandidates.length === 1
          ? parentCandidates[0]
          : null;
    const node: TaskGraphNodeEvidenceV1 = {
      version: 1,
      node_id: item.node_id,
      node_type: item.node_id === attemptNodeId ? "worker" : nodeTypeForEvent(item.envelope.event_name, item.envelope.component_id),
      label: item.node_id === attemptNodeId ? goal.objective : eventLabel(item),
      state: stateForEvent(item.envelope.event_name, item.envelope.terminal),
      task_id: item.envelope.task_id,
      run_id: item.envelope.run_id,
      parent_run_id: item.envelope.parent_run_id,
      parent_node_id: parentNodeId,
      component_id: item.envelope.component_id,
      source_kind: "structured_runtime_event",
      source_ref: item.source_ref,
      evidence_refs: unique([item.evidence_ref, item.source_ref]),
      sequence: item.envelope.sequence,
      updated_at: item.envelope.timestamp,
      started_at: item.envelope.event_name.includes("started") ? item.envelope.timestamp : null,
      completed_at: item.envelope.terminal ? item.envelope.timestamp : null,
      route_source: routeSource(item.details.route_source),
      transition_reason: eventTransitionReason(item),
      retry_policy: retryPolicy(item.envelope.retry_semantics.policy, "unknown"),
      replay_allowed: item.envelope.retry_semantics.replay_allowed,
      attempt: item.envelope.retry_semantics.attempt,
      max_attempts: item.envelope.retry_semantics.max_attempts
    };
    nodes.set(node.node_id, mergeNode(nodes.get(node.node_id), node));

    const context: ExplicitGraphContext = {
      attempt_node_id: attemptNodeId,
      source_kind: "structured_runtime_event",
      source_ref: item.source_ref,
      evidence_ref: item.evidence_ref,
      fallback_route_source: routeSource(item.details.route_source),
      fallback_transition_reason: eventTransitionReason(item),
      resolve_node_id(value, relation, side) {
        const raw = text(value, 500);
        if (!raw || raw === "attempt") return attemptNodeId;
        const runId = relation && side ? text(relation[`${side}_run_id`], 300) : null;
        return resolveComponentNode(raw, runId);
      }
    };
    for (const relationRecord of graphRecords(item.details)) {
      const relation = explicitRelation(relationRecord, context);
      if (relation) relations.push(relation);
      else degradedReasons.push(`${item.source_ref} 包含无法解析的执行关系，已省略。`);
    }
  }

  const latestByNode = new Map<string, StructuredGoalEvent>();
  for (const item of structured) {
    const current = latestByNode.get(item.node_id);
    if (!current || item.envelope.sequence > current.envelope.sequence) latestByNode.set(item.node_id, item);
  }
  const retryGroups = new Map<string, StructuredGoalEvent[]>();
  for (const item of latestByNode.values()) {
    if ((item.envelope.retry_semantics.attempt ?? 0) < 1) continue;
    const list = retryGroups.get(item.envelope.component_id) ?? [];
    list.push(item);
    retryGroups.set(item.envelope.component_id, list);
  }
  for (const items of retryGroups.values()) {
    items.sort((left, right) => (left.envelope.retry_semantics.attempt ?? 0) - (right.envelope.retry_semantics.attempt ?? 0));
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const current = items[index];
      const attempt = current.envelope.retry_semantics.attempt;
      if (!attempt || attempt < 2 || previous.node_id === current.node_id) continue;
      relations.push({
        version: 1,
        edge_kind: "retry",
        from_node_id: previous.node_id,
        to_node_id: current.node_id,
        source_kind: "structured_runtime_event",
        source_ref: current.source_ref,
        evidence_ref: current.evidence_ref,
        route_source: routeSource(current.details.route_source),
        transition_reason: eventTransitionReason(current),
        condition: null,
        selected: null,
        relation_group: text(current.details.relation_group, 500),
        dependency_satisfied: null,
        retry_policy: retryPolicy(current.envelope.retry_semantics.policy, "unknown"),
        replay_allowed: current.envelope.retry_semantics.replay_allowed,
        attempt,
        max_attempts: current.envelope.retry_semantics.max_attempts,
        idempotency_key: current.envelope.retry_semantics.idempotency_key
      });
    }
  }

  const checkpoint = record(goal.checkpoint) ?? {};
  const checkpointRef = goalCheckpointRef(goal);
  const checkpointContext: ExplicitGraphContext = {
    attempt_node_id: attemptNodeId,
    source_kind: "goal_checkpoint",
    source_ref: checkpointRef,
    evidence_ref: checkpointRef,
    fallback_route_source: routeSource(checkpoint.route_source),
    fallback_transition_reason: text(checkpoint.transition_reason, 1_000) ?? text(checkpoint.recovery_reason, 1_000),
    resolve_node_id(value) {
      const raw = text(value, 500);
      if (!raw || raw === "attempt") return attemptNodeId;
      return resolveComponentNode(raw);
    }
  };
  const attemptCheckpointNode: TaskGraphNodeEvidenceV1 = {
    version: 1,
    node_id: attemptNodeId,
    node_type: "worker",
    label: goal.objective,
    state: ["succeeded", "failed", "blocked", "cancelled"].includes(goal.status) ? "terminal" : "active",
    task_id: `goal-${goal.goal_id}`,
    run_id: text(checkpoint.codex_run_id, 300) ?? goal.run_id,
    parent_run_id: null,
    parent_node_id: null,
    component_id: `goal:${goal.goal_id}`,
    source_kind: "goal_checkpoint",
    source_ref: checkpointRef,
    evidence_refs: [checkpointRef],
    sequence: null,
    updated_at: goal.updated_at,
    started_at: goal.created_at,
    completed_at: ["succeeded", "failed", "blocked", "cancelled"].includes(goal.status) ? goal.updated_at : null,
    route_source: routeSource(checkpoint.route_source),
    transition_reason: text(checkpoint.transition_reason, 1_000) ?? text(checkpoint.recovery_reason, 1_000) ?? text(checkpoint.last_error, 1_000),
    retry_policy: retryPolicy(checkpoint.retry_policy, "unknown"),
    replay_allowed: bool(checkpoint.replay_allowed),
    attempt: positiveInteger(checkpoint.attempt),
    max_attempts: positiveInteger(checkpoint.max_attempts)
  };
  nodes.set(attemptNodeId, mergeNode(nodes.get(attemptNodeId), attemptCheckpointNode));

  appendExplicitGraph(checkpoint.office_graph ?? checkpoint.execution_graph, checkpointContext, nodes, relations, degradedReasons);
  const recoveryFromRunId = text(checkpoint.recovery_from_run_id, 300);
  if (recoveryFromRunId) {
    const sourceNodeId = `run:${recoveryFromRunId}`;
    nodes.set(sourceNodeId, {
      version: 1,
      node_id: sourceNodeId,
      node_type: "worker",
      label: `恢复来源 ${recoveryFromRunId}`,
      state: "terminal",
      task_id: `goal-${goal.goal_id}`,
      run_id: recoveryFromRunId,
      parent_run_id: null,
      parent_node_id: null,
      component_id: null,
      source_kind: "goal_checkpoint",
      source_ref: checkpointRef,
      evidence_refs: [checkpointRef],
      sequence: null,
      updated_at: goal.updated_at,
      started_at: null,
      completed_at: goal.updated_at,
      route_source: "runtime",
      transition_reason: text(checkpoint.recovery_reason, 1_000),
      retry_policy: "unknown",
      replay_allowed: bool(checkpoint.replay_allowed),
      attempt: null,
      max_attempts: null
    });
    relations.push({
      version: 1,
      edge_kind: "recovery",
      from_node_id: sourceNodeId,
      to_node_id: attemptNodeId,
      source_kind: "goal_checkpoint",
      source_ref: checkpointRef,
      evidence_ref: checkpointRef,
      route_source: "runtime",
      transition_reason: text(checkpoint.recovery_reason, 1_000),
      condition: null,
      selected: null,
      relation_group: null,
      dependency_satisfied: null,
      retry_policy: retryPolicy(checkpoint.retry_policy, "unknown"),
      replay_allowed: bool(checkpoint.replay_allowed),
      attempt: positiveInteger(checkpoint.attempt),
      max_attempts: positiveInteger(checkpoint.max_attempts),
      idempotency_key: text(checkpoint.last_resume_idempotency_key, 1_000)
    });
  }

  const hasExplicitRelations = relations.length > 0;
  const authority: TaskExecutionGraphEvidenceV1["authority"] = hasExplicitRelations && degradedReasons.length === 0 ? "explicit" : nodes.size > 1 || hasExplicitRelations ? "partial" : "unavailable";
  return boundedEvidence(authority, [...nodes.values()], relations, degradedReasons);
}

export function taskGraphEvidenceFromDurableJob(job: DurableJobRecord, steps: DurableJobStep[]): TaskExecutionGraphEvidenceV1 {
  const attemptNodeId = `attempt:job-${job.run_id}`;
  const nodes = new Map<string, TaskGraphNodeEvidenceV1>();
  const relations: TaskGraphRelationEvidenceV1[] = [];
  const degradedReasons: string[] = [];
  const maxAttempts = positiveInteger(job.loop_budget?.max_attempts_per_step);
  const currentNodeByStep = new Map<string, string>();

  nodes.set(attemptNodeId, {
    version: 1,
    node_id: attemptNodeId,
    node_type: "worker",
    label: job.title,
    state: ["completed", "failed", "blocked", "cancelled"].includes(job.status) ? "terminal" : job.status === "queued" ? "waiting" : "active",
    task_id: `job-${job.run_id}`,
    run_id: job.run_id,
    parent_run_id: null,
    parent_node_id: null,
    component_id: null,
    source_kind: "durable_job_step",
    source_ref: `.codexpro/runs/${job.run_id}/job.json`,
    evidence_refs: [`.codexpro/runs/${job.run_id}/job.json`],
    sequence: null,
    updated_at: job.updated_at,
    started_at: job.started_at ?? null,
    completed_at: job.finished_at ?? null,
    route_source: "runtime",
    transition_reason: text(job.recovery_reason, 1_000) ?? text(job.error, 1_000) ?? text(job.termination_reason, 1_000),
    retry_policy: "not_applicable",
    replay_allowed: null,
    attempt: 1,
    max_attempts: 1
  });

  for (const step of steps) {
    const attemptCount = Math.max(1, positiveInteger(step.attempts) ?? 1);
    const policy = retryPolicy(step.retry_policy, step.idempotent && step.retryable ? "automatic" : step.retryable ? "manual" : "never");
    const replayAllowed = policy === "automatic" && step.idempotent && step.retryable ? true : policy === "never" ? false : null;
    let previousAttemptNodeId: string | null = null;
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const nodeId = `step:${job.run_id}:${step.step_id}:attempt:${attempt}`;
      const evidenceRef = durableStepRef(job, step, attempt);
      const current = attempt === attemptCount;
      nodes.set(nodeId, {
        version: 1,
        node_id: nodeId,
        node_type: "tool_process",
        label: `${step.phase} · ${step.step_id}${attemptCount > 1 ? ` · 尝试 ${attempt}` : ""}`,
        state: current ? stateForStep(step.status) : "terminal",
        task_id: `job-${job.run_id}`,
        run_id: job.run_id,
        parent_run_id: job.run_id,
        parent_node_id: attemptNodeId,
        component_id: `step:${step.step_id}`,
        source_kind: "durable_job_step",
        source_ref: evidenceRef,
        evidence_refs: unique([evidenceRef, step.output_path, ...step.evidence_paths], 20),
        sequence: step.index,
        updated_at: current ? step.finished_at ?? step.heartbeat_at ?? step.started_at ?? job.updated_at : step.started_at ?? job.created_at,
        started_at: current ? step.started_at ?? null : null,
        completed_at: current ? step.finished_at ?? null : step.started_at ?? job.updated_at,
        route_source: "code",
        transition_reason: text(step.error, 1_000) ?? text(step.termination_reason, 1_000) ?? text(step.output_summary, 1_000),
        retry_policy: policy,
        replay_allowed: replayAllowed,
        attempt,
        max_attempts: maxAttempts
      });
      if (previousAttemptNodeId) {
        relations.push({
          version: 1,
          edge_kind: "retry",
          from_node_id: previousAttemptNodeId,
          to_node_id: nodeId,
          source_kind: "durable_job_step",
          source_ref: evidenceRef,
          evidence_ref: evidenceRef,
          route_source: policy === "automatic" ? "runtime" : policy === "manual" ? "human" : "unknown",
          transition_reason: text(step.error, 1_000) ?? `步骤 ${step.step_id} 进入第 ${attempt} 次尝试。`,
          condition: null,
          selected: null,
          relation_group: `retry:${job.run_id}:${step.step_id}`,
          dependency_satisfied: null,
          retry_policy: policy,
          replay_allowed: replayAllowed,
          attempt,
          max_attempts: maxAttempts,
          idempotency_key: replayAllowed === true ? step.input_hash : null
        });
      }
      previousAttemptNodeId = nodeId;
    }
    currentNodeByStep.set(step.step_id, previousAttemptNodeId as string);
  }

  for (const step of steps) {
    if (!step.previous_step) continue;
    const fromNodeId = currentNodeByStep.get(step.previous_step);
    const toNodeId = currentNodeByStep.get(step.step_id);
    const previous = steps.find((candidate) => candidate.step_id === step.previous_step);
    if (!fromNodeId || !toNodeId || !previous) {
      degradedReasons.push(`Durable Step ${step.step_id} 的 previous_step=${step.previous_step} 无法解析，关系已省略。`);
      continue;
    }
    const evidenceRef = durableStepRef(job, step, Math.max(1, step.attempts || 1));
    const common = {
      version: 1 as const,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      source_kind: "durable_job_step" as const,
      source_ref: evidenceRef,
      evidence_ref: evidenceRef,
      route_source: "code" as const,
      transition_reason: `步骤定义明确 ${step.previous_step} 在 ${step.step_id} 之前。`,
      condition: null,
      selected: null,
      relation_group: `steps:${job.run_id}`,
      retry_policy: "not_applicable" as const,
      replay_allowed: null,
      attempt: null,
      max_attempts: null,
      idempotency_key: null
    };
    relations.push({ ...common, edge_kind: "sequence", dependency_satisfied: previous.status === "completed" });
    relations.push({ ...common, edge_kind: "dependency", dependency_satisfied: previous.status === "completed" });
  }

  return boundedEvidence(steps.length && degradedReasons.length === 0 ? "explicit" : steps.length ? "partial" : "unavailable", [...nodes.values()], relations, degradedReasons);
}

export function taskGraphEvidenceFromHandoff(taskId: string, status: HandoffStatusResult): TaskExecutionGraphEvidenceV1 {
  const attemptNodeId = `attempt:${taskId}`;
  const evidenceRef = status.run_state_path || `${status.context_dir}/handoff-run-state.json`;
  const nodes = new Map<string, TaskGraphNodeEvidenceV1>();
  const relations: TaskGraphRelationEvidenceV1[] = [];
  const degradedReasons: string[] = [];
  nodes.set(attemptNodeId, {
    version: 1,
    node_id: attemptNodeId,
    node_type: "worker",
    label: status.executor ? `Handoff 执行器 ${status.executor}` : "Handoff 执行",
    state: status.run_state === "completed" || status.run_state === "failed" || status.run_state === "cancelled" ? "terminal" : status.progress.execution_state === "stale" ? "stale" : "active",
    task_id: taskId,
    run_id: status.run_id ?? null,
    parent_run_id: null,
    parent_node_id: null,
    component_id: status.executor ? `handoff-executor:${status.executor}` : null,
    source_kind: "handoff_state",
    source_ref: evidenceRef,
    evidence_refs: [evidenceRef],
    sequence: null,
    updated_at: status.finished_at ?? status.last_output_at ?? status.progress.heartbeat_at,
    started_at: status.started_at ?? null,
    completed_at: status.finished_at ?? null,
    route_source: "runtime",
    transition_reason: text(status.blocked_reason, 1_000) ?? text(status.recovery_action, 1_000) ?? text(status.progress.termination_reason, 1_000),
    retry_policy: "unknown",
    replay_allowed: false,
    attempt: status.restart_count === undefined ? null : Math.max(1, status.restart_count + 1),
    max_attempts: status.max_auto_restarts === undefined ? null : Math.max(1, status.max_auto_restarts + 1)
  });

  if (status.current_plan_hash && status.execution_acknowledged && status.run_id) {
    const controllerNodeId = `handoff-controller:${status.current_plan_hash}`;
    nodes.set(controllerNodeId, {
      version: 1,
      node_id: controllerNodeId,
      node_type: "worker",
      label: "Handoff 调度器",
      state: status.watcher_online ? "active" : "stale",
      task_id: taskId,
      run_id: status.current_plan_hash,
      parent_run_id: null,
      parent_node_id: null,
      component_id: `handoff-plan:${status.current_plan_hash}`,
      source_kind: "handoff_state",
      source_ref: evidenceRef,
      evidence_refs: [evidenceRef],
      sequence: null,
      updated_at: status.progress.heartbeat_at,
      started_at: status.started_at ?? null,
      completed_at: null,
      route_source: "runtime",
      transition_reason: "Watcher 已确认当前计划并将执行控制交给 Handoff 执行器。",
      retry_policy: "not_applicable",
      replay_allowed: false,
      attempt: null,
      max_attempts: null
    });
    relations.push({
      version: 1,
      edge_kind: "handoff",
      from_node_id: controllerNodeId,
      to_node_id: attemptNodeId,
      source_kind: "handoff_state",
      source_ref: evidenceRef,
      evidence_ref: evidenceRef,
      route_source: "runtime",
      transition_reason: "Watcher 已确认当前计划并将执行控制交给 Handoff 执行器。",
      condition: null,
      selected: true,
      relation_group: `handoff:${status.current_plan_hash}`,
      dependency_satisfied: status.execution_ready,
      retry_policy: "not_applicable",
      replay_allowed: false,
      attempt: null,
      max_attempts: null,
      idempotency_key: status.current_plan_hash
    });
  }

  if (status.recovery_from_run_id && status.run_id && status.recovery_from_run_id !== status.run_id) {
    const sourceNodeId = `run:${status.recovery_from_run_id}`;
    nodes.set(sourceNodeId, {
      version: 1,
      node_id: sourceNodeId,
      node_type: "worker",
      label: `恢复来源 ${status.recovery_from_run_id}`,
      state: "terminal",
      task_id: taskId,
      run_id: status.recovery_from_run_id,
      parent_run_id: null,
      parent_node_id: null,
      component_id: null,
      source_kind: "handoff_state",
      source_ref: evidenceRef,
      evidence_refs: [evidenceRef],
      sequence: null,
      updated_at: status.started_at ?? status.progress.heartbeat_at,
      started_at: null,
      completed_at: status.started_at ?? null,
      route_source: "runtime",
      transition_reason: text(status.recovery_action, 1_000),
      retry_policy: "unknown",
      replay_allowed: false,
      attempt: null,
      max_attempts: null
    });
    relations.push({
      version: 1,
      edge_kind: "recovery",
      from_node_id: sourceNodeId,
      to_node_id: attemptNodeId,
      source_kind: "handoff_state",
      source_ref: evidenceRef,
      evidence_ref: evidenceRef,
      route_source: "runtime",
      transition_reason: text(status.recovery_action, 1_000) ?? "Handoff 状态明确记录当前 Run 从旧 Run 恢复。",
      condition: null,
      selected: true,
      relation_group: `recovery:${status.run_id}`,
      dependency_satisfied: true,
      retry_policy: "unknown",
      replay_allowed: false,
      attempt: status.resume_count === undefined ? null : Math.max(1, status.resume_count + 1),
      max_attempts: null,
      idempotency_key: null
    });
  }

  return boundedEvidence(relations.length && degradedReasons.length === 0 ? "explicit" : nodes.size ? "partial" : "unavailable", [...nodes.values()], relations, degradedReasons);
}
