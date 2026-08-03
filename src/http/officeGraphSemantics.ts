export const OFFICE_ROUTE_SOURCES = ["code", "ai", "human", "runtime", "unknown"] as const;
export type OfficeRouteSource = typeof OFFICE_ROUTE_SOURCES[number];

export const OFFICE_RETRY_POLICIES = ["not_applicable", "automatic", "manual", "never", "unknown"] as const;
export type OfficeRetryPolicy = typeof OFFICE_RETRY_POLICIES[number];

export const OFFICE_STRUCTURAL_EDGE_KINDS = ["containment", "observation", "ownership"] as const;
export type OfficeStructuralEdgeKind = typeof OFFICE_STRUCTURAL_EDGE_KINDS[number];

export const OFFICE_EXECUTION_RELATION_KINDS = [
  "sequence",
  "dependency",
  "branch",
  "parallel",
  "join",
  "retry",
  "recovery",
  "handoff"
] as const;
export type OfficeExecutionRelationKind = typeof OFFICE_EXECUTION_RELATION_KINDS[number];
export type OfficeGraphEdgeKind = OfficeStructuralEdgeKind | OfficeExecutionRelationKind;
export type OfficeGraphEdgeClass = "structure" | "execution";

export const OFFICE_RELATION_SOURCE_KINDS = [
  "structured_runtime_event",
  "durable_job_step",
  "goal_checkpoint",
  "objective_projection",
  "execution_component_store",
  "handoff_state",
  "resource_governor"
] as const;
export type OfficeRelationSourceKind = typeof OFFICE_RELATION_SOURCE_KINDS[number];

export const OFFICE_ENTITY_BOUNDARIES_V1 = {
  objective: {
    identity: "objective_key",
    meaning: "用户希望完成的业务或工程目标，是办公室视图的一级业务主体。",
    forbidden_inference: "不得由单个节点、单次 Attempt、单个组件或模型文本直接覆盖 Objective 终态。"
  },
  attempt: {
    identity: "task_id/run_id",
    meaning: "Objective 的一次执行尝试；历史 Attempt 只进入历史档案，当前 Attempt 由 Objective 投影明确指定。",
    forbidden_inference: "不得把重复、已替代或旧 Handoff 当成新的 Objective。"
  },
  node: {
    identity: "node_id",
    meaning: "具有独立状态、证据和边界的可验证工作单元。",
    forbidden_inference: "没有稳定身份和证据引用时不得创建节点。"
  },
  person: {
    identity: "executor_id/subagent_id/component_id",
    meaning: "真实且稳定的执行器或子智能体身份。",
    forbidden_inference: "浏览器、验收器、Git 和普通工具进程默认是设备，不因名称像人而生成角色。"
  },
  component: {
    identity: "component_id",
    meaning: "模型流、工具进程或 Worker 等运行组件；组件可以属于人物，也可以只作为设备存在。",
    forbidden_inference: "owner_id 只能证明组件归属，不能单独证明执行顺序、依赖或父 Run。"
  }
} as const;

export const OFFICE_RELATION_ALLOWED_SOURCES: Readonly<Record<OfficeExecutionRelationKind, readonly OfficeRelationSourceKind[]>> = {
  sequence: ["structured_runtime_event", "durable_job_step"],
  dependency: ["structured_runtime_event", "durable_job_step", "goal_checkpoint"],
  branch: ["structured_runtime_event", "goal_checkpoint"],
  parallel: ["structured_runtime_event", "goal_checkpoint"],
  join: ["structured_runtime_event", "durable_job_step", "goal_checkpoint"],
  retry: ["structured_runtime_event", "durable_job_step"],
  recovery: ["structured_runtime_event", "goal_checkpoint", "handoff_state"],
  handoff: ["structured_runtime_event", "handoff_state"]
};

export interface OfficeRelationEvidenceV1 {
  version: 1;
  edge_kind: OfficeExecutionRelationKind;
  from_node_id: string;
  to_node_id: string;
  source_kind: OfficeRelationSourceKind;
  source_ref: string;
  evidence_ref: string;
  route_source: OfficeRouteSource;
  transition_reason: string | null;
  condition: string | null;
  selected: boolean | null;
  relation_group: string | null;
  dependency_satisfied: boolean | null;
  retry_policy: OfficeRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
  idempotency_key: string | null;
}

export interface OfficeResolvedExecutionEdgeV1 {
  edge_id: string;
  edge_class: "execution";
  edge_kind: OfficeExecutionRelationKind;
  from_node_id: string;
  to_node_id: string;
  condition: string | null;
  selected: boolean | null;
  relation_group: string | null;
  dependency_satisfied: boolean | null;
  route_source: OfficeRouteSource;
  transition_reason: string | null;
  retry_policy: OfficeRetryPolicy;
  replay_allowed: boolean | null;
  attempt: number | null;
  max_attempts: number | null;
  authority: string;
  evidence_refs: string[];
}

export type OfficeRelationResolutionCode =
  | "accepted"
  | "missing_evidence"
  | "invalid_evidence"
  | "conflicting_evidence";

export interface OfficeRelationResolutionV1 {
  status: "accepted" | "omitted";
  reason_code: OfficeRelationResolutionCode;
  reason: string;
  edge: OfficeResolvedExecutionEdgeV1 | null;
  accepted_evidence_refs: string[];
  rejected_evidence_refs: string[];
}

export interface OfficeRelationRequestV1 {
  edge_kind: OfficeExecutionRelationKind;
  from_node_id: string;
  to_node_id: string;
  evidence: OfficeRelationEvidenceV1[];
  known_node_ids?: readonly string[];
}

export interface OfficeJoinEvaluationV1 {
  state: "ready" | "waiting" | "unknown";
  reason_code: "all_dependencies_satisfied" | "dependency_unsatisfied" | "missing_or_conflicting_dependency";
  reason: string;
}

function cleanText(value: unknown, max = 1_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function officeGraphEdgeClass(edgeKind: OfficeGraphEdgeKind): OfficeGraphEdgeClass {
  return (OFFICE_STRUCTURAL_EDGE_KINDS as readonly string[]).includes(edgeKind) ? "structure" : "execution";
}

function validEvidence(candidate: OfficeRelationEvidenceV1, request: OfficeRelationRequestV1): string | null {
  if (candidate.version !== 1) return "unsupported evidence version";
  if (candidate.edge_kind !== request.edge_kind) return "edge kind does not match request";
  if (cleanText(candidate.from_node_id, 500) !== request.from_node_id || cleanText(candidate.to_node_id, 500) !== request.to_node_id) {
    return "edge endpoints do not match request";
  }
  if (!candidate.from_node_id || !candidate.to_node_id || candidate.from_node_id === candidate.to_node_id) return "edge endpoints are invalid";
  if (request.known_node_ids) {
    const known = new Set(request.known_node_ids);
    if (!known.has(candidate.from_node_id) || !known.has(candidate.to_node_id)) return "edge contains an unknown node";
  }
  if (!OFFICE_RELATION_ALLOWED_SOURCES[request.edge_kind].includes(candidate.source_kind)) return "source is not authoritative for this relation";
  if (!cleanText(candidate.source_ref, 1_000) || !cleanText(candidate.evidence_ref, 1_000)) return "source_ref and evidence_ref are required";
  if (!(OFFICE_ROUTE_SOURCES as readonly string[]).includes(candidate.route_source)) return "route_source is invalid";
  if (!(OFFICE_RETRY_POLICIES as readonly string[]).includes(candidate.retry_policy)) return "retry_policy is invalid";

  if (request.edge_kind === "branch" && !cleanText(candidate.condition, 1_000)) return "branch condition is required";
  if ((request.edge_kind === "parallel" || request.edge_kind === "join") && !cleanText(candidate.relation_group, 500)) {
    return `${request.edge_kind} relation_group is required`;
  }
  if (request.edge_kind === "handoff" && candidate.route_source === "unknown") return "handoff route_source must be explicit";
  if (request.edge_kind === "retry") {
    const attempt = optionalPositiveInteger(candidate.attempt);
    const maxAttempts = optionalPositiveInteger(candidate.max_attempts);
    if (attempt === null || attempt < 2) return "retry attempt must be at least 2";
    if (maxAttempts !== null && maxAttempts < attempt) return "max_attempts cannot be lower than attempt";
    if (candidate.retry_policy === "automatic" && candidate.replay_allowed !== true) {
      return "automatic retry requires explicit replay_allowed=true";
    }
    if (candidate.retry_policy === "never" && candidate.replay_allowed !== false) {
      return "retry_policy=never requires replay_allowed=false";
    }
    if (candidate.replay_allowed === true && !cleanText(candidate.idempotency_key, 1_000)) {
      return "replay_allowed=true requires an idempotency_key";
    }
  }
  return null;
}

function semanticFingerprint(candidate: OfficeRelationEvidenceV1): string {
  return JSON.stringify({
    edge_kind: candidate.edge_kind,
    from_node_id: candidate.from_node_id,
    to_node_id: candidate.to_node_id,
    route_source: candidate.route_source,
    transition_reason: candidate.transition_reason,
    condition: candidate.condition,
    selected: candidate.selected,
    relation_group: candidate.relation_group,
    dependency_satisfied: candidate.dependency_satisfied,
    retry_policy: candidate.retry_policy,
    replay_allowed: candidate.replay_allowed,
    attempt: candidate.attempt,
    max_attempts: candidate.max_attempts,
    idempotency_key: candidate.idempotency_key
  });
}

export function resolveOfficeGraphRelation(request: OfficeRelationRequestV1): OfficeRelationResolutionV1 {
  if (!request.evidence.length) {
    return {
      status: "omitted",
      reason_code: "missing_evidence",
      reason: `${request.edge_kind} 关系没有权威证据，已省略。`,
      edge: null,
      accepted_evidence_refs: [],
      rejected_evidence_refs: []
    };
  }

  const valid: OfficeRelationEvidenceV1[] = [];
  const rejected: OfficeRelationEvidenceV1[] = [];
  const rejectionReasons: string[] = [];
  for (const candidate of request.evidence) {
    const reason = validEvidence(candidate, request);
    if (reason) {
      rejected.push(candidate);
      rejectionReasons.push(reason);
    } else {
      valid.push(candidate);
    }
  }
  if (!valid.length) {
    return {
      status: "omitted",
      reason_code: "invalid_evidence",
      reason: `${request.edge_kind} 关系证据无效：${unique(rejectionReasons).join("；")}。`,
      edge: null,
      accepted_evidence_refs: [],
      rejected_evidence_refs: unique(rejected.map((item) => cleanText(item.evidence_ref, 1_000)))
    };
  }

  const fingerprints = new Map<string, OfficeRelationEvidenceV1[]>();
  for (const candidate of valid) {
    const fingerprint = semanticFingerprint(candidate);
    fingerprints.set(fingerprint, [...(fingerprints.get(fingerprint) ?? []), candidate]);
  }
  if (fingerprints.size > 1) {
    return {
      status: "omitted",
      reason_code: "conflicting_evidence",
      reason: `${request.edge_kind} 关系存在互相冲突的权威证据，整条关系已降级省略。`,
      edge: null,
      accepted_evidence_refs: [],
      rejected_evidence_refs: unique([...valid, ...rejected].map((item) => cleanText(item.evidence_ref, 1_000)))
    };
  }

  const candidate = valid[0];
  const evidenceRefs = unique(valid.map((item) => cleanText(item.evidence_ref, 1_000)));
  const sourceRefs = unique(valid.map((item) => cleanText(item.source_ref, 1_000)));
  return {
    status: "accepted",
    reason_code: "accepted",
    reason: valid.length > 1 ? "重复且一致的关系证据已合并。" : "关系由单一权威证据确认。",
    edge: {
      edge_id: `edge:${request.edge_kind}:${request.from_node_id}:${request.to_node_id}`,
      edge_class: "execution",
      edge_kind: request.edge_kind,
      from_node_id: request.from_node_id,
      to_node_id: request.to_node_id,
      condition: candidate.condition,
      selected: candidate.selected,
      relation_group: candidate.relation_group,
      dependency_satisfied: candidate.dependency_satisfied,
      route_source: candidate.route_source,
      transition_reason: candidate.transition_reason,
      retry_policy: candidate.retry_policy,
      replay_allowed: candidate.replay_allowed,
      attempt: candidate.attempt,
      max_attempts: candidate.max_attempts,
      authority: `${candidate.source_kind}:${sourceRefs.join(",")}`,
      evidence_refs: evidenceRefs
    },
    accepted_evidence_refs: evidenceRefs,
    rejected_evidence_refs: unique(rejected.map((item) => cleanText(item.evidence_ref, 1_000)))
  };
}

export function evaluateOfficeJoin(
  requiredIncoming: readonly OfficeRelationResolutionV1[]
): OfficeJoinEvaluationV1 {
  if (!requiredIncoming.length || requiredIncoming.some((item) => item.status !== "accepted" || item.edge?.edge_kind !== "join")) {
    return {
      state: "unknown",
      reason_code: "missing_or_conflicting_dependency",
      reason: "汇合节点缺少完整、无冲突的必需依赖证据。"
    };
  }
  if (requiredIncoming.some((item) => item.edge?.dependency_satisfied !== true)) {
    return {
      state: "waiting",
      reason_code: "dependency_unsatisfied",
      reason: "至少一个必需并行分支尚未明确满足汇合条件。"
    };
  }
  return {
    state: "ready",
    reason_code: "all_dependencies_satisfied",
    reason: "所有必需并行分支均已明确满足汇合条件。"
  };
}
