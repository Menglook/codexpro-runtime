import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { AdvisoryReviewReport } from "../agents/types.js";
import type {
  AcceptanceCategory,
  AcceptanceContract,
  AcceptanceContractInput,
  AcceptanceEvaluationSummary,
  AcceptanceItem,
  AcceptanceItemInput,
  AcceptanceItemStatus,
  AcceptanceVerifier,
  GoalEvidenceRecord,
  GoalValidationResult
} from "./types.js";

const ACCEPTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

function clean(value: unknown, max = 4_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, 1_000)).filter(Boolean))].slice(0, maxItems);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value as Record<string, unknown>)
    : undefined;
}

function acceptanceId(index: number, description: string): string {
  const digest = createHash("sha256").update(description).digest("hex").slice(0, 10);
  return `acceptance-${index + 1}-${digest}`;
}

function categoryFor(description: string): AcceptanceCategory {
  const text = description.toLowerCase();
  if (/不得|禁止|不要|不允许|do not|must not|forbidden|只读|read[- ]?only/.test(text)) return "forbidden";
  if (/视觉|布局|样式|截图|响应式|横向溢出|visual|layout|responsive|screenshot|overflow/.test(text)) return "visual";
  if (/安全|权限|认证|密钥|隐私|security|permission|auth|secret|privacy/.test(text)) return "security";
  if (/性能|耗时|延迟|内存|cpu|performance|latency|memory/.test(text)) return "performance";
  if (/回归|保留|兼容|不影响|regression|preserve|compatib/.test(text)) return "regression";
  if (/证据|报告路径|日志路径|evidence|report path|log path/.test(text)) return "evidence";
  return "functional";
}

function verifierFor(description: string): AcceptanceVerifier {
  const text = description.toLowerCase();
  if (/人工|手工|manual/.test(text)) return "manual";
  if (/review|reviewer|p0|p1|审查|复核|评审|回归|保留|兼容|不影响|regression|preserve|compatib/.test(text)) return "review";
  if (/页面|浏览器|url|截图|移动端|桌面端|视觉|布局|样式|响应式|横向溢出|browser|page|viewport|responsive|overflow|screenshot|layout|visual/.test(text)) return "browser";
  if (/不修改|不得修改|禁止修改|不要修改|只允许修改|工作区干净|do not modify|no changes|allowed paths|forbidden paths|clean working tree/.test(text)) return "diff";
  if (/\b(?:npm|pnpm|yarn|bun|pytest|vitest|jest|playwright|tsc)\b|构建|测试|烟测|验收|acceptance|lint|typecheck|build|test|smoke/.test(text)) return "command";
  if (/证据|状态|结果文件|报告路径|evidence|state|report path/.test(text)) return "state";
  return "manual";
}

function blockingFor(description: string): boolean {
  return !/^(?:建议|可选|非阻断|optional|non[- ]blocking)\s*[:：-]?/i.test(description.trim());
}

function pathPatterns(description: string): string[] {
  const candidates = [
    ...[...description.matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    ...description.split(/\s+/).filter((part) => /^(?:\.?\.?\/)?[A-Za-z0-9_*?.-]+(?:\/[A-Za-z0-9_*?.-]+)+$/.test(part))
  ];
  return [...new Set(candidates.map((value) => value.replace(/[，。；;,:：]+$/g, "").trim()).filter(Boolean))].slice(0, 50);
}

function inferredVerifierConfig(description: string, verifier: AcceptanceVerifier): Record<string, unknown> | undefined {
  if (verifier === "command") {
    const quoted = [...description.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim())
      .find((value) => /^(?:npm|pnpm|yarn|bun|pytest|vitest|jest|playwright|tsc)\b/i.test(value));
    const inline = description.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[A-Za-z0-9:_.-]+|\b(?:pytest|vitest|jest|tsc)\b[^，。；;]*/i)?.[0]?.trim();
    const command = quoted ?? inline;
    return command ? { command } : undefined;
  }
  if (verifier === "browser") {
    const config: Record<string, unknown> = {};
    const url = description.match(/https?:\/\/[^\s`，。；;]+/i)?.[0];
    if (url) config.expected_url = url;
    if (/截图|screenshot/i.test(description)) config.require_screenshot = true;
    if (/无横向溢出|不得横向溢出|no horizontal overflow/i.test(description)) config.check_no_horizontal_overflow = true;
    const quoted = [...description.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
    if (/不出现|不得出现|消失|must not appear|not present/i.test(description) && quoted.length) config.text_absent = quoted[0];
    else if (/出现|显示|包含|appear|present|contains/i.test(description) && quoted.length) config.text_present = quoted[0];
    return Object.keys(config).length ? config : undefined;
  }
  if (verifier === "review") {
    if (/p0|p1|不得|不出现|无阻断|no blocking|must not/i.test(description)) return { block_on_findings: true };
  }
  if (verifier === "diff") {
    if (/工作区干净|clean working tree|no changes/i.test(description)) return { must_be_clean: true };
    const paths = pathPatterns(description);
    if (!paths.length) return undefined;
    if (/只允许修改|allowed paths/i.test(description)) return { allowed_paths: paths };
    if (/不修改|不得修改|禁止修改|不要修改|do not modify|forbidden paths/i.test(description)) return { forbidden_paths: paths };
  }
  return undefined;
}

function normalizeItem(item: AcceptanceItemInput, index: number): AcceptanceItem {
  const description = clean(item.description);
  if (!description) throw new Error(`Acceptance item ${index + 1} is missing description.`);
  const id = clean(item.id, 120) || acceptanceId(index, description);
  if (!ACCEPTANCE_ID_PATTERN.test(id)) throw new Error(`Invalid acceptance item id: ${id}`);
  const allowedCategories: AcceptanceCategory[] = ["functional", "visual", "regression", "security", "performance", "forbidden", "evidence"];
  const allowedVerifiers: AcceptanceVerifier[] = ["command", "browser", "diff", "review", "manual", "state"];
  const category = item.category !== undefined && allowedCategories.includes(item.category)
    ? item.category
    : categoryFor(description);
  const verifier = item.verifier !== undefined && allowedVerifiers.includes(item.verifier)
    ? item.verifier
    : verifierFor(description);
  const verifierConfig = recordValue(item.verifier_config) ?? inferredVerifierConfig(description, verifier);
  return {
    id,
    category,
    description,
    blocking: item.blocking ?? blockingFor(description),
    verifier,
    ...(verifierConfig ? { verifier_config: verifierConfig } : {}),
    status: "pending",
    evidence_ids: [],
    evidence_paths: []
  };
}

export function compileAcceptanceContract(
  acceptance: string[] = [],
  explicit?: AcceptanceContractInput
): AcceptanceContract {
  if (explicit) {
    if (explicit.version !== 1) throw new Error(`Unsupported acceptance contract version: ${String(explicit.version)}`);
    if (!Array.isArray(explicit.items) || explicit.items.length > 100) throw new Error("Acceptance contract must contain at most 100 items.");
    const items = explicit.items.map(normalizeItem);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Acceptance item ids must be unique.");
    return {
      version: 1,
      items,
      compiled_at: new Date().toISOString(),
      source: explicit.source ?? "user"
    };
  }

  const descriptions = stringList(acceptance);
  return {
    version: 1,
    items: descriptions.map((description, index) => {
      const verifier = verifierFor(description);
      const verifierConfig = inferredVerifierConfig(description, verifier);
      return {
        id: acceptanceId(index, description),
        category: categoryFor(description),
        description,
        blocking: blockingFor(description),
        verifier,
        ...(verifierConfig ? { verifier_config: verifierConfig } : {}),
        status: "pending" as const,
        evidence_ids: [],
        evidence_paths: []
      };
    }),
    compiled_at: new Date().toISOString(),
    source: "user"
  };
}

export function acceptanceContractFingerprint(contract: AcceptanceContract): Record<string, unknown> {
  return {
    version: contract.version,
    source: contract.source,
    items: contract.items.map((item) => ({
      id: item.id,
      category: item.category,
      description: item.description,
      blocking: item.blocking,
      verifier: item.verifier,
      verifier_config: item.verifier_config ?? null
    }))
  };
}

function statusFromValidation(validation: GoalValidationResult | null | undefined): AcceptanceItemStatus {
  if (!validation) return "not_covered";
  if (validation.status === "resource_wait_timeout") return "not_covered";
  if (validation.status === "blocked_by_bash_policy" || validation.status === "blocked_by_resource_policy") return "blocked";
  return validation.ok ? "passed" : "failed";
}

function commandStatus(item: AcceptanceItem, validation: GoalValidationResult | null | undefined): AcceptanceItemStatus {
  if (!validation) return "not_covered";
  const selector = clean(item.verifier_config?.command_name ?? item.verifier_config?.command, 1_000);
  if (!selector) return statusFromValidation(validation);
  const command = validation.commands.find((candidate) =>
    [candidate.name, candidate.command, candidate.requested_command, candidate.effective_command]
      .some((value) => value === selector || value.includes(selector))
  );
  if (!command) return "not_covered";
  if (command.resource_wait_timed_out) return "not_covered";
  if (command.blocked || command.blocked_before_spawn) return "blocked";
  return command.process_started && command.exit_code === 0 ? "passed" : "failed";
}

function browserStatus(item: AcceptanceItem, validation: GoalValidationResult | null | undefined): AcceptanceItemStatus {
  if (!validation) return "not_covered";
  if (validation.status === "resource_wait_timeout") return "not_covered";
  if (validation.status === "blocked_by_bash_policy" || validation.status === "blocked_by_resource_policy") return "blocked";
  const summaries = validation.commands
    .map((command) => command.browser_smoke_summary)
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object"));
  if (!summaries.length) return "not_covered";
  const allResults: Record<string, unknown>[] = [];
  for (const summary of summaries) {
    const skipped = Array.isArray(summary.skippedTargets) ? summary.skippedTargets : [];
    const policyBlocked = Array.isArray(summary.policyBlockedTargets) ? summary.policyBlockedTargets : [];
    if (policyBlocked.length) return "blocked";
    if (skipped.length) return "not_covered";
    const results = Array.isArray(summary.results) ? summary.results : [];
    if (!results.length) return "not_covered";
    for (const result of results) {
      if (!result || typeof result !== "object") return "failed";
      const browserResult = result as Record<string, unknown>;
      const urlFailed = browserResult.urlExpectation === false || browserResult.urlExpectation === "fail";
      const consoleErrors = typeof browserResult.consoleErrors === "number" ? browserResult.consoleErrors : 0;
      const networkFailures = typeof browserResult.networkFailures === "number" ? browserResult.networkFailures : 0;
      if (Boolean(browserResult.error) || browserResult.opened === false || urlFailed || consoleErrors > 0 || networkFailures > 0) return "failed";
      allResults.push(browserResult);
    }
  }
  const config = item.verifier_config ?? {};
  const expectedUrl = clean(config.expected_url, 2_000);
  if (expectedUrl && !allResults.some((result) => clean(result.finalUrl, 4_000).includes(expectedUrl))) return "failed";
  if (config.require_screenshot === true && !allResults.some((result) => Array.isArray(result.screenshots) && result.screenshots.length > 0)) return "not_covered";
  if (config.check_no_horizontal_overflow === true) {
    const checked = allResults.filter((result) => typeof result.horizontalOverflow === "boolean" || typeof result.overflowExpectation === "string");
    if (!checked.length) return "not_covered";
    if (checked.some((result) => result.horizontalOverflow === true || result.overflowExpectation === "fail")) return "failed";
  }
  if (clean(config.text_present, 2_000) || clean(config.text_absent, 2_000)) {
    const checked = allResults.filter((result) => result.textExpectation === "pass" || result.textExpectation === "fail");
    if (!checked.length) return "not_covered";
    if (checked.some((result) => result.textExpectation === "fail")) return "failed";
  }
  return validation.ok ? "passed" : "failed";
}

function diffStatus(item: AcceptanceItem, changedFiles: string[]): AcceptanceItemStatus {
  const config = item.verifier_config;
  if (!config) return "not_covered";
  if (config.must_be_clean === true) return changedFiles.length ? "failed" : "passed";
  const forbidden = stringList(config.forbidden_paths, 200);
  const allowed = stringList(config.allowed_paths, 200);
  if (!forbidden.length && !allowed.length) return "not_covered";
  if (forbidden.some((pattern) => changedFiles.some((file) => minimatch(file, pattern, { dot: true })))) return "failed";
  if (allowed.length && changedFiles.some((file) => !allowed.some((pattern) => minimatch(file, pattern, { dot: true })))) return "failed";
  return "passed";
}

function reviewStatus(item: AcceptanceItem, review: AdvisoryReviewReport | null | undefined): AcceptanceItemStatus {
  if (!review) return "not_covered";
  if (!review.ok || !review.workspace_unchanged) return "failed";
  if (item.verifier_config?.block_on_findings === true
    && (review.blocking_findings.length > 0 || review.critical_uncovered_scope.length > 0)) return "failed";
  if (review.gate_passed === false) return "failed";
  return "passed";
}

export interface AcceptanceEvaluationContext {
  phase: "validation" | "review";
  validation?: GoalValidationResult | null;
  review?: AdvisoryReviewReport | null;
  changed_files?: string[];
  evidence?: GoalEvidenceRecord[];
}

function evaluatedStatus(item: AcceptanceItem, context: AcceptanceEvaluationContext): AcceptanceItemStatus {
  if (item.status === "passed") return "passed";
  let status: AcceptanceItemStatus;
  switch (item.verifier) {
    case "command":
      status = commandStatus(item, context.validation);
      break;
    case "browser":
      status = browserStatus(item, context.validation);
      break;
    case "diff":
      status = diffStatus(item, context.changed_files ?? []);
      break;
    case "review":
      status = context.phase === "review" ? reviewStatus(item, context.review) : "pending";
      break;
    case "state": {
      if (item.category === "evidence") {
        const related = (context.evidence ?? []).some((evidence) => evidence.related_acceptance_ids.includes(item.id) && evidence.trustworthy);
        status = related ? "passed" : "not_covered";
      } else {
        status = item.verifier_config?.validation_ok === true ? statusFromValidation(context.validation) : "not_covered";
      }
      break;
    }
    case "manual":
    default:
      status = "not_covered";
      break;
  }
  if (status !== "passed") return status;
  const hasTrustworthyEvidence = (context.evidence ?? []).some((evidence) =>
    item.evidence_ids.includes(evidence.evidence_id)
    && evidence.related_acceptance_ids.includes(item.id)
    && evidence.trustworthy
  );
  return hasTrustworthyEvidence ? "passed" : "not_covered";
}

export function summarizeAcceptanceContract(contract: AcceptanceContract): AcceptanceEvaluationSummary {
  const blocking = contract.items.filter((item) => item.blocking);
  const ids = (status: AcceptanceItemStatus) => contract.items.filter((item) => item.status === status).map((item) => item.id);
  const blockingIds = (status: AcceptanceItemStatus) => blocking.filter((item) => item.status === status).map((item) => item.id);
  const blockingFailedIds = [...blockingIds("failed"), ...blockingIds("blocked")];
  const blockingNotCoveredIds = blockingIds("not_covered");
  const pendingIds = blockingIds("pending");
  return {
    blocking_passed: blockingFailedIds.length === 0 && blockingNotCoveredIds.length === 0 && pendingIds.length === 0,
    blocking_failed_ids: blockingFailedIds,
    blocking_not_covered_ids: blockingNotCoveredIds,
    pending_ids: pendingIds,
    passed_ids: ids("passed"),
    evaluated_at: new Date().toISOString()
  };
}

export function evaluateAcceptanceContract(
  contract: AcceptanceContract,
  context: AcceptanceEvaluationContext
): { contract: AcceptanceContract; summary: AcceptanceEvaluationSummary } {
  const next: AcceptanceContract = {
    ...structuredClone(contract),
    items: contract.items.map((item) => {
      const status = evaluatedStatus(item, context);
      return {
        ...structuredClone(item),
        status,
        ...(status === "failed" || status === "blocked" || status === "not_covered"
          ? { failure_reason: `Verifier ${item.verifier} returned ${status} during ${context.phase}.` }
          : { failure_reason: undefined })
      };
    })
  };
  return { contract: next, summary: summarizeAcceptanceContract(next) };
}

function evidenceId(seed: string): string {
  return `evidence-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function validationEvidence(
  validation: GoalValidationResult,
  relatedAcceptanceIds: string[],
  options: {
    type?: GoalEvidenceRecord["type"];
    path?: string;
    path_exists: boolean;
    summary?: string;
    limitations?: string[];
  }
): GoalEvidenceRecord {
  const evidenceType = options.type ?? "command_log";
  const evidencePath = options.path ?? validation.report_path;
  const limitations = validation.commands.some((command) => command.blocked_before_spawn)
    ? ["One or more commands were blocked before process startup."]
    : [];
  limitations.push(...(options.limitations ?? []));
  if (!options.path_exists) limitations.push("The evidence path does not exist or is outside the guarded workspace.");
  return {
    evidence_id: evidenceId(`validation:${evidenceType}:${evidencePath}:${validation.completed_at}`),
    type: evidenceType,
    created_at: validation.completed_at,
    source: `acceptance:${validation.profile}`,
    ...(evidencePath ? { path: evidencePath } : {}),
    summary: options.summary ?? `Acceptance profile ${validation.profile} completed with status ${validation.status}.`,
    related_acceptance_ids: [...new Set(relatedAcceptanceIds)],
    trustworthy: Boolean(evidencePath) && options.path_exists,
    limitations: [...new Set(limitations)]
  };
}

export function reviewEvidence(
  review: AdvisoryReviewReport,
  relatedAcceptanceIds: string[],
  path?: string
): GoalEvidenceRecord {
  return {
    evidence_id: evidenceId(`review:${review.reviewer_run_id ?? "none"}:${review.completed_at}`),
    type: "review",
    created_at: review.completed_at,
    source: `review:${review.mode}`,
    ...(path ? { path } : {}),
    summary: review.summary,
    related_acceptance_ids: [...new Set(relatedAcceptanceIds)],
    trustworthy: review.ok && review.workspace_unchanged,
    limitations: review.uncovered_scope
  };
}

export function mergeEvidence(current: GoalEvidenceRecord[], additions: GoalEvidenceRecord[]): GoalEvidenceRecord[] {
  const merged = new Map(current.map((item) => [item.evidence_id, structuredClone(item)]));
  for (const item of additions) merged.set(item.evidence_id, structuredClone(item));
  return [...merged.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function linkEvidence(
  contract: AcceptanceContract,
  evidence: GoalEvidenceRecord,
  accepts: (item: AcceptanceItem) => boolean
): AcceptanceContract {
  return {
    ...structuredClone(contract),
    items: contract.items.map((item) => accepts(item)
      ? {
          ...structuredClone(item),
          evidence_ids: [...new Set([...item.evidence_ids, evidence.evidence_id])],
          evidence_paths: evidence.path ? [...new Set([...item.evidence_paths, evidence.path])] : [...item.evidence_paths]
        }
      : structuredClone(item))
  };
}

export function unresolvedBlockingItems(
  contract: AcceptanceContract,
  options: { ignorePendingReview?: boolean } = {}
): AcceptanceItem[] {
  return contract.items.filter((item) => {
    if (!item.blocking || item.status === "passed") return false;
    if (options.ignorePendingReview && item.status === "pending" && item.verifier === "review") return false;
    return true;
  });
}
