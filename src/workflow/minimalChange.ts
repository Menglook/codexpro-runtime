export type MinimalChangeReasonCategory =
  | "implementation"
  | "test"
  | "schema"
  | "migration"
  | "compatibility"
  | "documentation"
  | "blocker_fix"
  | "unknown";

export type MinimalSufficiencyDecision =
  | "sufficient_and_scoped"
  | "sufficient_with_explained_expansion"
  | "insufficient_missing_changes"
  | "scope_exceeded"
  | "not_assessable";

export interface MinimalChangePathReason {
  category: MinimalChangeReasonCategory;
  reason: string;
  objective_ref?: string | null;
  acceptance_refs?: string[];
}

export interface MinimalChangeContract {
  objective: string;
  expected_change_areas: string[];
  likely_paths: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  must_preserve: string[];
  required_acceptance: string[];
  non_goals: string[];
  uncertainty_notes: string[];
}

export interface MinimalChangeContractInput {
  objective?: string;
  expected_change_areas?: string[];
  likely_paths?: string[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  must_preserve?: string[];
  required_acceptance?: string[];
  non_goals?: string[];
  uncertainty_notes?: string[];
}

export interface ChangeOperationObservation {
  path: string;
  operation?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export interface ChangeScopeExpansion {
  path: string;
  reason: string;
  authorized: boolean;
}

export interface ChangeFootprint {
  planned_paths: string[];
  actual_paths: string[];
  added_files: string[];
  modified_files: string[];
  deleted_files: string[];
  reason_by_path: Record<string, MinimalChangePathReason>;
  scope_expansions: ChangeScopeExpansion[];
  out_of_scope_changes: string[];
  expected_but_unchanged: string[];
  preserved_boundaries: string[];
  unresolved_gaps: string[];
}

export interface MinimalSufficiencyReview {
  decision: MinimalSufficiencyDecision;
  findings: string[];
  missing_required_changes: string[];
  unexplained_changes: string[];
  accepted_scope_expansions: string[];
  rejected_scope_expansions: string[];
  evidence_refs: string[];
}

export interface BuildChangeFootprintInput {
  contract: MinimalChangeContract;
  operations?: ChangeOperationObservation[];
  actual_paths?: string[];
  path_reasons?: Record<string, string | MinimalChangePathReason>;
  preserved_boundaries?: string[];
  unresolved_gaps?: string[];
  evidence_refs?: string[];
}

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function pathMatchesRule(file: string, rule: string): boolean {
  const normalizedFile = file.replace(/^\.\//, "");
  const normalizedRule = rule.replace(/^\.\//, "").replace(/\*\*$/, "").replace(/\/$/, "");
  if (!normalizedRule) return false;
  return normalizedFile === normalizedRule || normalizedFile.startsWith(`${normalizedRule}/`);
}

function pathAllowed(path: string, contract: MinimalChangeContract): boolean {
  if (contract.forbidden_paths.some((rule) => pathMatchesRule(path, rule))) return false;
  if (!contract.allowed_paths.length) return true;
  return contract.allowed_paths.some((rule) => pathMatchesRule(path, rule));
}

function inferredCategory(path: string): MinimalChangeReasonCategory {
  const normalized = path.toLowerCase();
  if (/(^|\/)(tests?|__tests__)(\/|$)|(?:^|[-_.])(?:test|spec)\.[^.]+$|smoke\.mjs$/.test(normalized)) return "test";
  if (/(^|\/)(schemas?|contracts?)(\/|$)|\.schema\.json$/.test(normalized)) return "schema";
  if (/(^|\/)(migrations?|alembic)(\/|$)|migration/.test(normalized)) return "migration";
  if (/(^|\/)(docs?|planning-local|reports?)(\/|$)|\.(?:md|txt|rst)$/.test(normalized)) return "documentation";
  if (/compat|legacy|fallback|adapter/.test(normalized)) return "compatibility";
  return "implementation";
}

function normalizeReason(
  path: string,
  value: string | MinimalChangePathReason | undefined,
  contract: MinimalChangeContract
): MinimalChangePathReason {
  if (typeof value === "string" && value.trim()) {
    return {
      category: inferredCategory(path),
      reason: value.trim(),
      objective_ref: contract.objective,
      acceptance_refs: []
    };
  }
  if (value && typeof value === "object") {
    return {
      category: value.category,
      reason: value.reason.trim() || "Explicit reason was supplied without detail.",
      objective_ref: value.objective_ref ?? contract.objective,
      acceptance_refs: unique(value.acceptance_refs ?? [])
    };
  }
  const category = inferredCategory(path);
  const acceptanceRefs = category === "test" || category === "schema" || category === "migration"
    ? contract.required_acceptance
    : [];
  return {
    category,
    reason: `Inferred ${category} support from the path shape; no explicit path reason was supplied.`,
    objective_ref: contract.objective,
    acceptance_refs: acceptanceRefs
  };
}

function classifyObservedFiles(operations: ChangeOperationObservation[]): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const operation of operations) {
    const path = operation.path?.trim();
    if (!path || operation.status === "failed") continue;
    const kind = operation.operation?.toLowerCase();
    if (kind === "delete" || kind === "remove") {
      deleted.push(path);
      continue;
    }
    if (kind === "replace" || finiteNonNegative(operation.deletions) > 0) {
      modified.push(path);
      continue;
    }
    if (kind === "write") {
      // Patch bundle output does not currently prove whether the path existed before the write.
      // Keep the conservative classification instead of inventing an added-file fact.
      modified.push(path);
      continue;
    }
    modified.push(path);
  }
  return { added: unique(added), modified: unique(modified), deleted: unique(deleted) };
}

export function compileMinimalChangeContract(input: MinimalChangeContractInput): MinimalChangeContract {
  return {
    objective: input.objective?.trim() || "Unspecified task objective",
    expected_change_areas: unique(input.expected_change_areas ?? []),
    likely_paths: unique(input.likely_paths ?? []),
    allowed_paths: unique(input.allowed_paths ?? []),
    forbidden_paths: unique(input.forbidden_paths ?? []),
    must_preserve: unique(input.must_preserve ?? []),
    required_acceptance: unique(input.required_acceptance ?? []),
    non_goals: unique(input.non_goals ?? []),
    uncertainty_notes: unique(input.uncertainty_notes ?? [])
  };
}

export function buildChangeFootprint(input: BuildChangeFootprintInput): ChangeFootprint {
  const operations = input.operations ?? [];
  const observed = classifyObservedFiles(operations);
  const actualPaths = unique([
    ...operations.filter((operation) => operation.status !== "failed").map((operation) => operation.path),
    ...(input.actual_paths ?? [])
  ]);
  const plannedPaths = unique(input.contract.likely_paths);
  const reasonByPath: Record<string, MinimalChangePathReason> = {};
  for (const path of actualPaths) {
    reasonByPath[path] = normalizeReason(path, input.path_reasons?.[path], input.contract);
  }
  const scopeExpansions = actualPaths
    .filter((path) => !plannedPaths.some((planned) => pathMatchesRule(path, planned)))
    .map((path) => ({
      path,
      reason: reasonByPath[path]?.reason ?? "No reason recorded.",
      authorized: pathAllowed(path, input.contract)
    }));
  const outOfScopeChanges = actualPaths.filter((path) => !pathAllowed(path, input.contract));
  return {
    planned_paths: plannedPaths,
    actual_paths: actualPaths,
    added_files: observed.added,
    modified_files: observed.modified,
    deleted_files: observed.deleted,
    reason_by_path: reasonByPath,
    scope_expansions: scopeExpansions,
    out_of_scope_changes: outOfScopeChanges,
    expected_but_unchanged: plannedPaths.filter((planned) => !actualPaths.some((path) => pathMatchesRule(path, planned))),
    preserved_boundaries: unique([...(input.contract.must_preserve ?? []), ...(input.preserved_boundaries ?? [])]),
    unresolved_gaps: unique(input.unresolved_gaps ?? [])
  };
}

export function reviewMinimalSufficiency(
  footprint: ChangeFootprint,
  evidenceRefs: string[] = []
): MinimalSufficiencyReview {
  const rejected = footprint.scope_expansions.filter((item) => !item.authorized).map((item) => item.path);
  const accepted = footprint.scope_expansions.filter((item) => item.authorized).map((item) => item.path);
  const unexplained = footprint.actual_paths.filter((path) => !footprint.reason_by_path[path]?.reason.trim());
  let decision: MinimalSufficiencyDecision;
  if (!footprint.actual_paths.length || !footprint.planned_paths.length) decision = "not_assessable";
  else if (footprint.out_of_scope_changes.length || rejected.length) decision = "scope_exceeded";
  else if (footprint.unresolved_gaps.length) decision = "insufficient_missing_changes";
  else if (accepted.length) decision = "sufficient_with_explained_expansion";
  else decision = "sufficient_and_scoped";

  const findings: string[] = [];
  if (footprint.expected_but_unchanged.length) {
    findings.push(`Planned paths were not changed: ${footprint.expected_but_unchanged.join(", ")}.`);
  }
  if (accepted.length) findings.push(`Explained scope expansion: ${accepted.join(", ")}.`);
  if (footprint.out_of_scope_changes.length) findings.push(`Out-of-scope changes: ${footprint.out_of_scope_changes.join(", ")}.`);
  if (footprint.unresolved_gaps.length) findings.push(`Unresolved gaps: ${footprint.unresolved_gaps.join(", ")}.`);

  return {
    decision,
    findings,
    missing_required_changes: footprint.unresolved_gaps,
    unexplained_changes: unexplained,
    accepted_scope_expansions: accepted,
    rejected_scope_expansions: rejected,
    evidence_refs: unique(evidenceRefs)
  };
}

export function formatMinimalChangeSummary(
  contract: MinimalChangeContract,
  footprint: ChangeFootprint,
  review: MinimalSufficiencyReview
): string[] {
  const expansions = footprint.scope_expansions.map((item) => `${item.path}（${item.authorized ? "已授权" : "未授权"}：${item.reason}）`);
  return [
    `计划修改：${footprint.planned_paths.join(", ") || "未明确预测路径"}`,
    `实际修改：${footprint.actual_paths.join(", ") || "无"}`,
    `新增范围：${expansions.join("；") || "无"}`,
    `计划内但未修改：${footprint.expected_but_unchanged.join(", ") || "无"}`,
    `范围外修改：${footprint.out_of_scope_changes.join(", ") || "无"}`,
    `保持边界：${footprint.preserved_boundaries.join("；") || contract.must_preserve.join("；") || "未声明"}`,
    `最小充分性结论：${review.decision}`
  ];
}
