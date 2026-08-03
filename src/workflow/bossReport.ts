import { redactSensitiveText } from "../redact.js";
import { buildStableReport, type ReportSection } from "./reportBuilder.js";

export type BossReportKind = "task" | "stage" | "template";
export type BossReportFormat = "compact" | "full";

export interface BossModeReportInput {
  title: string;
  goal?: string | null;
  runId?: string;
  kind?: BossReportKind;
  data: Record<string, unknown>;
  technicalReportPath?: string;
  format?: BossReportFormat;
}

type ValidationState = "passed" | "failed" | "not_run" | "unknown";
type GateState = "passed" | "failed" | "not_required" | "not_run" | "unknown";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return asArray(value).map(asString).filter((item): item is string => Boolean(item));
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function patchPaths(data: Record<string, unknown>): string[] {
  const patches = asObject(data.patches);
  const operations = asArray(patches?.operations);
  return unique(operations.map((operation) => asString(asObject(operation)?.path)).filter((value): value is string => Boolean(value)));
}

function patchCount(data: Record<string, unknown>): number {
  const patches = asObject(data.patches);
  const count = patches?.operation_count;
  if (typeof count === "number" && Number.isFinite(count)) return count;
  return asArray(patches?.operations).length;
}

function validationObject(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(data.validation_result) ?? asObject(data.validation);
}

function validationCommands(data: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(validationObject(data)?.commands).map(asObject).filter((value): value is Record<string, unknown> => Boolean(value));
}

function validationState(data: Record<string, unknown>): ValidationState {
  const validation = validationObject(data);
  if (!validation) return "not_run";
  if (validation.status === "passed" || validation.ok === true) return "passed";
  if (validation.status === "failed" || validation.ok === false) return "failed";
  const commands = validationCommands(data);
  if (!commands.length) return "unknown";
  if (commands.some((command) => command.status === "failed" || (typeof command.exit_code === "number" && command.exit_code !== 0))) return "failed";
  if (commands.every((command) => command.status === "passed")) return "passed";
  return "unknown";
}

function acceptanceSummary(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(data.acceptance_summary)
    ?? asObject(validationObject(data)?.acceptance_evaluation)
    ?? asObject(asObject(data.review_result)?.acceptance_evaluation)
    ?? asObject(asObject(data.review)?.acceptance_evaluation);
}

function acceptanceState(data: Record<string, unknown>): GateState {
  const summary = acceptanceSummary(data);
  if (!summary && !asObject(data.acceptance_contract)) return "not_required";
  if (!summary) return "not_run";
  if (summary.blocking_passed === true) return "passed";
  if (summary.blocking_passed === false) return "failed";
  return "unknown";
}

function reviewObject(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return asObject(data.review_result) ?? asObject(data.review);
}

function reviewState(data: Record<string, unknown>): GateState {
  const review = reviewObject(data);
  if (!review && data.review_required !== true) return "not_required";
  if (!review) return "not_run";
  if (review.ok === false || review.gate_passed === false || review.workspace_unchanged === false) return "failed";
  if (review.ok === true && review.gate_passed === true && review.workspace_unchanged !== false) return "passed";
  return "unknown";
}

function budgetExceeded(data: Record<string, unknown>): boolean {
  const search = asObject(data.search);
  const read = asObject(data.read);
  return search?.budget_exceeded === true || read?.budget_exceeded === true;
}

function formatCommand(command: Record<string, unknown>): string {
  const name = asString(command.command) ?? "unknown command";
  const status = command.status === "passed"
    ? "PASS"
    : command.status === "failed" || (typeof command.exit_code === "number" && command.exit_code !== 0)
      ? "FAIL"
      : "UNKNOWN";
  const exitCode = typeof command.exit_code === "number" ? ` exit=${command.exit_code}` : "";
  const logPath = asString(command.log_path);
  return `\`${name}\`：${status}${exitCode}${logPath ? `；日志：${logPath}` : ""}`;
}

function validationLines(state: ValidationState, data: Record<string, unknown>, technicalReportPath?: string): string[] {
  const commands = validationCommands(data);
  const lines = commands.length
    ? commands.map(formatCommand)
    : state === "not_run"
      ? ["未运行自动验收。"]
      : ["自动验收状态未知；不能据此声称通过。"];
  const acceptance = acceptanceSummary(data);
  if (acceptance) {
    const failed = stringArray(acceptance.blocking_failed_ids);
    const uncovered = stringArray(acceptance.blocking_not_covered_ids);
    const pending = stringArray(acceptance.pending_ids);
    lines.push(`Acceptance Contract：${acceptance.blocking_passed === true ? "PASS" : "BLOCKED"}。`);
    if (failed.length) lines.push(`失败条目：${failed.join(", ")}`);
    if (uncovered.length) lines.push(`未覆盖条目：${uncovered.join(", ")}`);
    if (pending.length) lines.push(`待处理条目：${pending.join(", ")}`);
  }
  if (technicalReportPath) lines.push(`完整技术归档：${technicalReportPath}`);
  return lines;
}

function impactLines(paths: string[], data: Record<string, unknown>, technicalReportPath?: string): string[] {
  const lines: string[] = [];
  if (paths.length) lines.push(`代码影响文件：${paths.join(", ")}`);
  const read = asObject(data.read);
  const search = asObject(data.search);
  const readCount = typeof read?.file_count === "number" ? read.file_count : 0;
  const queryCount = typeof search?.query_count === "number" ? search.query_count : 0;
  if (readCount || queryCount) lines.push(`上下文检查：读取 ${readCount} 个文件，搜索 ${queryCount} 组关键词。`);
  if (technicalReportPath) lines.push(`技术细节归档：${technicalReportPath}`);
  return lines.length ? lines : ["无代码影响；本次主要为只读检查或报告生成。"];
}

function unfinishedLines(validation: ValidationState, acceptance: GateState, review: GateState, data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (validation === "failed") lines.push("修复失败的自动验收项并重新运行。");
  if (validation === "not_run" || validation === "unknown") lines.push("补充可信的自动验收结果。");
  if (acceptance === "failed") lines.push("解决 Acceptance Contract 中失败或未覆盖的 blocking 条目。");
  if (acceptance === "not_run" || acceptance === "unknown") lines.push("完成 Acceptance Contract 的逐条评估。");
  if (review === "failed") lines.push("解决 Review Gate 的阻断 finding 或关键未覆盖范围。");
  if (review === "not_run" || review === "unknown") lines.push("完成要求的 Review Gate。");
  lines.push(...stringArray(data.user_action_required).map((item) => `用户操作：${item}`));
  return lines.length ? unique(lines) : ["没有已知的阻断性未完成项。"];
}

function evidenceLines(data: Record<string, unknown>, technicalReportPath?: string): string[] {
  const paths: string[] = [];
  if (technicalReportPath) paths.push(technicalReportPath);
  paths.push(...stringArray([
    data.report_path,
    data.technical_report_path,
    data.boss_report_path,
    validationObject(data)?.report_path,
    data.test_impact_state_path,
    asObject(data.browser_session)?.report_path,
    asObject(data.browser_runtime_probe)?.report_path
  ]));
  for (const command of validationCommands(data)) {
    const logPath = asString(command.log_path);
    if (logPath) paths.push(logPath);
  }
  for (const evidence of asArray(data.evidence).map(asObject).filter((item): item is Record<string, unknown> => Boolean(item))) {
    const evidencePath = asString(evidence.path);
    if (evidencePath) paths.push(evidencePath);
  }
  const contract = asObject(data.acceptance_contract);
  for (const item of asArray(contract?.items).map(asObject).filter((value): value is Record<string, unknown> => Boolean(value))) {
    paths.push(...stringArray(item.evidence_paths));
  }
  const uniquePaths = unique(paths);
  return uniquePaths.length ? uniquePaths : ["暂无可引用的证据路径。"];
}

function acceptanceLines(state: GateState, data: Record<string, unknown>): string[] {
  const summary = acceptanceSummary(data);
  if (state === "not_required") return ["本次任务未配置 Acceptance Contract。"];
  if (!summary) return ["要求 Acceptance Contract，但尚未产生逐条评估结果。"];
  const failed = stringArray(summary.blocking_failed_ids);
  const uncovered = stringArray(summary.blocking_not_covered_ids);
  const pending = stringArray(summary.pending_ids);
  return [
    `Blocking Gate：${state === "passed" ? "PASS" : state === "failed" ? "FAIL" : "UNKNOWN"}。`,
    `失败：${failed.join(", ") || "none"}；未覆盖：${uncovered.join(", ") || "none"}；待处理：${pending.join(", ") || "none"}。`
  ];
}

function reviewLines(state: GateState, data: Record<string, unknown>): string[] {
  const review = reviewObject(data);
  if (state === "not_required") return ["本次任务未配置 Review Gate。"];
  if (!review) return ["要求 Review Gate，但尚未产生 Review 结果。"];
  const findings = asArray(review.findings);
  const blocking = asArray(review.blocking_findings);
  const reviewPolicy = asObject(review.review_policy);
  const mode = asString(review.mode) ?? asString(reviewPolicy?.routing_mode) ?? "unknown";
  const modelReviewRun = reviewPolicy?.model_review_run === true || Boolean(review.reviewer_run_id);
  const lines = [
    `模式：${mode}；模型 Review：${modelReviewRun ? "是" : "否"}；执行可信：${review.ok === true ? "是" : "否"}；Gate：${review.gate_passed === true ? "PASS" : "FAIL/UNKNOWN"}。`,
    `Findings：${findings.length}；阻断 Findings：${blocking.length}。`
  ];
  const summary = asString(review.summary);
  if (summary) lines.push(summary);
  return lines;
}

function uncoveredLines(data: Record<string, unknown>): string[] {
  const review = reviewObject(data);
  const acceptance = acceptanceSummary(data);
  const lines = unique([
    ...stringArray(data.uncovered_scope),
    ...stringArray(review?.uncovered_scope),
    ...stringArray(review?.critical_uncovered_scope),
    ...stringArray(acceptance?.blocking_not_covered_ids).map((id) => `Acceptance 未覆盖：${id}`),
    ...stringArray(acceptance?.pending_ids).map((id) => `Acceptance 待处理：${id}`)
  ]);
  return lines.length ? lines : ["没有已声明的未覆盖范围。"];
}

function uncertaintyLines(validation: ValidationState, data: Record<string, unknown>): string[] {
  const lines = stringArray(data.uncertainties);
  if (validation === "not_run" || validation === "unknown") lines.push("自动验收不足，最终行为仍存在不确定性。");
  if (data.unknown_external_state === true || asObject(data.report_policy)?.reason_code === "report_policy_unknown_external_state_full") {
    lines.push("存在未知外部状态；报告减重没有将其隐藏。 ");
  }
  if (budgetExceeded(data)) lines.push("上下文摘要可能因预算截断而遗漏细节。");
  return unique(lines).length ? unique(lines) : ["没有已声明的不确定性。"];
}

function rootCauseLines(data: Record<string, unknown>): string[] {
  const cause = asString(data.root_cause);
  const evidence = stringArray(data.root_cause_evidence);
  if (!cause || !evidence.length) return ["未形成有证据支持的根因结论。"];
  return [cause, ...evidence.map((item) => `证据：${item}`)];
}

function rollbackLines(paths: string[]): string[] {
  if (!paths.length) return ["未修改代码，无需代码回滚。"];
  return [
    `提交前回滚：\`git checkout -- ${paths.join(" ")}\``,
    "提交后回滚：使用 `git revert <commit>` 生成反向提交。"
  ];
}

function commitMessage(title: string): string {
  const normalized = title.toLowerCase();
  if (normalized.includes("boss") && normalized.includes("report")) return "feat: add boss mode report";
  if (normalized.includes("security") || normalized.includes("secret")) return "feat: add security audit checks";
  if (normalized.includes("stage")) return "feat: complete codexpro stage";
  return "chore: update codexpro task";
}

function submitLines(canSubmit: "yes" | "no" | "review" | "none", paths: string[], title: string): string[] {
  if (canSubmit === "none") return ["无代码修改，无需提交。"];
  if (canSubmit === "no") return ["暂不提交：先修复失败项并重新验收通过。"];
  if (canSubmit === "review") return ["暂不建议直接提交：先补充自动验收，再执行提交。"];
  return [
    "可以提交，建议命令：",
    "`git status`",
    `\`git add ${paths.join(" ")}\``,
    `\`git commit -m "${commitMessage(title)}"\``,
    "`git push`"
  ];
}

function activeSkillLines(data: Record<string, unknown>): string[] {
  const skill = asObject(data.active_skill);
  if (!skill) return ["本次任务没有实际加载 Skill。"];
  const name = asString(skill.name) ?? "unknown";
  const repository = asString(skill.source_repository) ?? "unknown";
  const commit = asString(skill.source_commit) ?? "unknown";
  const entryPath = asString(skill.entry_path) ?? "unknown";
  const digest = asString(skill.digest) ?? "unknown";
  const loadedAt = asString(skill.loaded_at) ?? "unknown";
  return [
    `名称：${name}`,
    `固定来源：${repository}@${commit}`,
    `入口：${entryPath}`,
    `指纹：${digest}`,
    `加载时间：${loadedAt}`
  ];
}

function observedChangeLines(paths: string[], operations: number): string[] {
  if (!paths.length && operations === 0) return ["执行记录中未观察到代码修改。"];
  return [
    `执行记录中观察到 ${operations} 个修改操作；该数量本身不证明任务已经完成。`,
    ...paths.map((path) => `变更文件：${path}`)
  ];
}

function minimalChangeLines(data: Record<string, unknown>): string[] {
  const compiledTask = asObject(data.compiled_task);
  const contract = asObject(data.minimal_change_contract) ?? asObject(compiledTask?.minimal_change_contract);
  const footprint = asObject(data.change_footprint) ?? asObject(asObject(data.review_result)?.change_footprint);
  const review = asObject(data.minimal_sufficiency_review)
    ?? asObject(asObject(data.review_result)?.minimal_sufficiency_review)
    ?? asObject(asObject(data.review)?.minimal_sufficiency_review);
  if (!contract && !footprint && !review) return ["未生成最小充分变更数据；本次结论为 not_assessable。"];
  const expansions = asArray(footprint?.scope_expansions)
    .map(asObject)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const path = asString(item.path) ?? "unknown";
      const reason = asString(item.reason) ?? "未记录原因";
      return `${path}（${item.authorized === false ? "未授权" : "已解释"}：${reason}）`;
    });
  return [
    `计划修改：${stringArray(footprint?.planned_paths ?? contract?.likely_paths).join(", ") || "未明确预测路径"}`,
    `实际修改：${stringArray(footprint?.actual_paths).join(", ") || "无"}`,
    `新增范围：${expansions.join("；") || "无"}`,
    `计划内但未修改：${stringArray(footprint?.expected_but_unchanged).join(", ") || "无"}`,
    `范围外修改：${stringArray(footprint?.out_of_scope_changes).join(", ") || "无"}`,
    `保持边界：${stringArray(footprint?.preserved_boundaries ?? contract?.must_preserve).join("；") || "未声明"}`,
    `最小充分性结论：${asString(review?.decision) ?? "not_assessable"}`
  ];
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function executionLaneLines(data: Record<string, unknown>): string[] {
  const goal = asObject(data.goal);
  const checkpoint = asObject(data.checkpoint) ?? asObject(goal?.checkpoint);
  const lane = asObject(data.execution_lane) ?? asObject(checkpoint?.execution_lane);
  const reviewRouting = asObject(data.review_routing) ?? asObject(checkpoint?.review_routing);
  const executionOptions = asObject(checkpoint?.execution_options);
  if (!lane) return ["没有持久化的 Execution Lane 决策；按旧版 Standard 兼容路径解释。"];
  const risk = asObject(lane.risk_decision);
  return [
    `Lane：${asString(lane.lane) ?? "unknown"}；Reasoning：${asString(lane.reasoning_effort) ?? asString(executionOptions?.reasoning_effort) ?? "unknown"}。`,
    `Acceptance：${asString(lane.acceptance_profile) ?? "unknown"}；Reviewer：${asString(lane.reviewer_mode) ?? "unknown"}；模型 Review 已运行：${reviewRouting?.model_review_run === true ? "是" : "否"}。`,
    `风险：${asString(risk?.level) ?? "unknown"} / ${asString(risk?.reason_code) ?? "unknown"}；原因代码：${stringArray(lane.reason_codes).join(", ") || "none"}。`,
    ...(asString(lane.escalated_from) ? [`运行中升级：${asString(lane.escalated_from)} → ${asString(lane.lane)}，不允许自动降级。`] : [])
  ];
}

function latencyBreakdown(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const goal = asObject(data.goal);
  const checkpoint = asObject(data.checkpoint) ?? asObject(goal?.checkpoint);
  const latency = asObject(checkpoint?.latency);
  return asObject(data.latency_breakdown) ?? asObject(latency?.breakdown);
}

function latencyLines(data: Record<string, unknown>): string[] {
  const latency = latencyBreakdown(data);
  if (!latency) return ["没有可用的 Goal latency breakdown。"];
  const ms = (field: string) => Math.max(0, Math.round(numberValue(latency[field]) ?? 0));
  return [
    `总耗时：${ms("total_ms")} ms；编译：${ms("task_compile_ms")} ms；上下文：${ms("context_prepare_ms")} ms。`,
    `模型：${ms("model_total_ms")} ms（首事件 ${ms("model_first_event_ms")} ms）；验证：${ms("validation_ms")} ms；Review：${ms("review_ms")} ms。`,
    `工具：${ms("tool_execution_ms")} ms；Browser：${ms("browser_ms")} ms；报告：${ms("report_ms")} ms；编排开销：${ms("orchestration_overhead_ms")} ms。`
  ];
}

function providerLines(data: Record<string, unknown>): string[] {
  const goal = asObject(data.goal);
  const checkpoint = asObject(data.checkpoint) ?? asObject(goal?.checkpoint);
  const selection = asObject(data.provider_selection) ?? asObject(checkpoint?.provider_selection) ?? asObject(asObject(data.job)?.provider_selection);
  const preferred = asString(selection?.preferred_provider) ?? asString(data.preferred_provider);
  const effective = asString(selection?.effective_provider)
    ?? asString(checkpoint?.execution_provider)
    ?? asString(data.effective_provider)
    ?? asString(data.execution_provider);
  const fallbackUsed = selection?.fallback_used === true || data.fallback_used === true;
  const fallbackReason = asString(selection?.fallback_reason) ?? asString(data.fallback_reason);
  const fallbackDetail = asString(selection?.fallback_detail) ?? asString(data.fallback_detail);
  if (!preferred && !effective && !fallbackUsed) return ["没有可追溯的 Provider 选择记录。"];
  return [
    `首选 Provider：${preferred ?? "未知"}；实际 Provider：${effective ?? "未知"}。`,
    `发生回退：${fallbackUsed ? "是" : "否"}${fallbackReason ? `；原因：${fallbackReason}` : ""}。`,
    ...(fallbackDetail ? [`回退详情：${fallbackDetail}`] : [])
  ];
}

function browserSessionLines(data: Record<string, unknown>): string[] {
  const browser = asObject(data.browser_session) ?? asObject(data.browser) ?? asObject(data.browser_runtime_probe);
  const authorization = asObject(data.browser_authorization) ?? asObject(browser?.authorization);
  if (!browser && !authorization) return ["没有浏览器会话或授权状态证据。"];
  const mode = asString(browser?.mode) ?? asString(browser?.browser_mode);
  const session = asString(browser?.session_id) ?? asString(browser?.id);
  const authorized = authorization?.authorized === true || browser?.authorized === true;
  const usable = browser?.usable === true || browser?.status === "passed";
  const tab = asString(browser?.tab_id) ?? asString(authorization?.tab_id);
  const url = asString(browser?.url) ?? asString(browser?.current_url);
  return [
    `浏览器模式：${mode ?? "未知"}；会话：${session ?? "未记录"}。`,
    `授权：${authorized ? "有效" : "未知/无效"}；真实可用：${usable ? "是" : "未知"}${tab ? `；标签页：${tab}` : ""}。`,
    ...(url ? [`当前页面：${url}`] : [])
  ];
}

function retryAndRecoveryLines(data: Record<string, unknown>): string[] {
  const job = asObject(data.job) ?? asObject(data.durable_job);
  const progress = asObject(data.progress) ?? asObject(job?.progress);
  const steps = asArray(job?.steps).map(asObject).filter((item): item is Record<string, unknown> => Boolean(item));
  const retryCount = numberValue(data.retry_count, job?.retry_count, progress?.retry_count, progress?.retries)
    ?? steps.reduce((sum, step) => sum + Math.max(0, (numberValue(step.retry_count, step.attempts) ?? 0) - 1), 0);
  const recoveryHistory = [
    ...stringArray(data.recovery_history),
    ...stringArray(job?.recovery_history),
    ...stringArray(progress?.recovery_history)
  ];
  const recoveryState = asString(data.recovery_state)
    ?? asString(job?.recovery_state)
    ?? asString(job?.status)
    ?? asString(progress?.state)
    ?? asString(progress?.execution_state);
  const waitingReason = asString(data.waiting_reason)
    ?? asString(job?.waiting_reason)
    ?? asString(job?.recovery_reason)
    ?? asString(progress?.waiting_reason)
    ?? asString(progress?.wait_reason);
  return [
    `自动重试次数：${retryCount ?? 0}。`,
    `恢复状态：${recoveryState ?? "未记录"}${waitingReason ? `；等待原因：${waitingReason}` : ""}。`,
    ...(recoveryHistory.length ? recoveryHistory.map((item) => `恢复记录：${item}`) : ["没有可追溯的恢复历史。"])
  ];
}

function userActionLines(data: Record<string, unknown>): string[] {
  const actions = unique([
    ...stringArray(data.user_action_required),
    ...stringArray(data.next_actions),
    ...stringArray(asObject(data.progress)?.user_action_required)
  ]);
  return actions.length ? actions : ["当前没有已声明的用户必做操作。"];
}

function weakestConfidenceLines(
  validation: ValidationState,
  acceptance: GateState,
  review: GateState,
  data: Record<string, unknown>
): string[] {
  const explicit = asString(data.least_confident_area) ?? asString(data.current_least_confident);
  if (explicit) return [explicit];
  const uncertainties = stringArray(data.uncertainties);
  if (uncertainties.length) return [uncertainties[0]];
  if (validation !== "passed") return ["自动验收尚未形成明确 PASS 证据。"];
  if (acceptance !== "passed" && acceptance !== "not_required") return ["Acceptance Contract 尚未形成完整结论。"];
  if (review !== "passed" && review !== "not_required") return ["Review Gate 尚未形成完整结论。"];
  if (evidenceLines(data).length === 1 && evidenceLines(data)[0] === "暂无可引用的证据路径。") return ["重要结论缺少独立证据路径。"];
  return ["没有已声明的高不确定区域；仍应以证据索引和未覆盖范围为准。"];
}

function scopeLines(goal: string | undefined, paths: string[], data: Record<string, unknown>): string[] {
  const scope = unique([
    ...stringArray(data.scope),
    ...stringArray(asObject(data.compiled_task)?.scope),
    ...paths
  ]);
  return [
    `目标：${goal ?? "未单独声明，使用报告标题作为目标。"}`,
    `范围：${scope.length ? scope.join(", ") : "未明确声明"}`
  ];
}

function reportPolicyLines(data: Record<string, unknown>): string[] {
  const policy = asObject(data.report_policy);
  if (!policy) return ["旧版报告未记录分级策略；按兼容模式读取，不据此推断日志是否完整。"];
  const omitted = stringArray(policy.omitted_artifacts);
  const reasons = stringArray(policy.reasons);
  return [
    `响应：${asString(policy.response_mode) ?? "compact"}；持久化：${asString(policy.persistence_mode) ?? asString(policy.archive_mode) ?? "unknown"}；完整命令日志：${policy.save_command_logs === true ? "已保存" : "未保存"}。`,
    `Technical Report：${policy.save_technical_report === true ? "已保存" : "未保存"}；Full Boss Report：${policy.save_full_boss_report === true ? "已保存" : "未保存"}。`,
    `策略原因：${asString(policy.reason_code) ?? "unknown"}${reasons.length ? `；${reasons.join("；")}` : ""}。`,
    ...(omitted.length ? [`按策略省略：${omitted.join(", ")}。`] : [])
  ];
}

function usageLedgerLines(data: Record<string, unknown>): string[] {
  const usage = asObject(data.usage_summary);
  if (!usage || usage.availability !== "available") {
    return ["Usage Ledger：不可用；当前没有可复核的终态用量记录，缺失值不会显示为 0。"];
  }
  const measurement = asObject(usage.token_measurement) ?? {};
  const totals = asObject(usage.tokens);
  const cache = asObject(usage.cache) ?? {};
  const browser = asObject(usage.browser) ?? {};
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  const nullableDuration = (value: unknown): string => typeof value === "number" && Number.isFinite(value) ? `${Math.max(0, Math.round(value))} ms` : "不可用";
  const efficiency = typeof usage.verified_completion_efficiency === "number" && Number.isFinite(usage.verified_completion_efficiency)
    ? `${(Math.max(0, usage.verified_completion_efficiency) * 100).toFixed(1)}%`
    : "不可用";
  return [
    `账本条目：${number(usage.entry_count)}；告警：${number(usage.warning_count)}。`,
    `耗时：总计 ${nullableDuration(usage.total_wall_duration_ms)}；排队 ${nullableDuration(usage.queue_duration_ms)}；活跃 ${nullableDuration(usage.active_duration_ms)}；静默 ${nullableDuration(usage.silent_duration_ms)}；验收 ${nullableDuration(usage.acceptance_duration_ms)}。`,
    `模型计量：实测 ${number(measurement.measured)}；估算 ${number(measurement.estimated)}；不可用 ${number(measurement.unavailable)}${totals ? `；输入 ${number(totals.input)}，缓存输入 ${number(totals.cached_input)}，输出 ${number(totals.output)}，推理输出 ${number(totals.reasoning_output)}` : "；总量不可用"}。`,
    `执行效率：进程 ${number(usage.process_count)}；重试 ${number(usage.retry_count)}；有效完成率 ${efficiency}。`,
    `缓存：命中 ${number(cache.hit)}；未命中 ${number(cache.miss)}；不可用 ${number(cache.unavailable)}。`,
    `Browser：成功 ${number(browser.success)}；失败 ${number(browser.failed)}；未知 ${number(browser.unknown)}；刷新 ${number(browser.refresh_count)}；重绑 ${number(browser.rebind_count)}；重连 ${number(browser.reconnect_count)}；恢复 ${number(browser.recovery_count)}。`
  ];
}

function statusReasonLines(data: Record<string, unknown>): string[] {
  const validation = validationObject(data);
  const commands = validationCommands(data);
  const reasonCodes = unique([
    asString(data.reason_code) ?? "",
    asString(validation?.reason_code) ?? "",
    ...commands.map((command) => asString(command.reason_code) ?? "")
  ]);
  const status = asString(data.status) ?? asString(asObject(data.job)?.status) ?? "unknown";
  const reason = asString(data.reason) ?? asString(validation?.reason);
  return [
    `状态：${status}；主 reason code：${reasonCodes[0] ?? "none"}。`,
    ...(reasonCodes.length > 1 ? [`相关 reason codes：${reasonCodes.slice(1).join(", ")}。`] : []),
    ...(reason ? [`原因：${reason}`] : [])
  ];
}

function compactSections(sections: ReportSection[], format: BossReportFormat, data: Record<string, unknown>): ReportSection[] {
  if (format === "full") return sections;
  const compactSuccess = asObject(data.report_policy)?.compact_success === true;
  const successTitles = new Set([
    "结论",
    "状态与原因代码",
    "完成内容",
    "影响范围",
    "执行分级",
    "耗时分解",
    "真实用量与执行效率",
    "Acceptance Contract",
    "验收结果",
    "Review 结果",
    "报告与日志策略",
    "已知风险",
    "未覆盖范围",
    "当前不确定性",
    "用户需要执行的操作",
    "是否可提交"
  ]);
  const selected = compactSuccess ? sections.filter((section) => successTitles.has(section.title)) : sections;
  return selected.map((section) => ({
    ...section,
    lines: section.lines.slice(0, compactSuccess
      ? section.title === "真实用量与执行效率"
        ? 6
        : section.title === "是否可提交"
          ? 6
          : section.title === "报告与日志策略"
            ? 4
            : section.title === "验收结果"
              ? 3
              : 2
      : section.title === "真实用量与执行效率"
        ? 6
        : section.title === "证据路径"
          ? 6
          : section.title === "是否可提交"
            ? 12
            : 3)
  }));
}

function riskLines(
  validation: ValidationState,
  acceptance: GateState,
  review: GateState,
  data: Record<string, unknown>,
  paths: string[]
): string[] {
  const lines: string[] = [];
  if (validation === "failed") lines.push("自动验收失败。");
  if ((validation === "not_run" || validation === "unknown") && paths.length) lines.push("存在代码修改，但自动验收不足。");
  if (acceptance === "failed" || acceptance === "not_run" || acceptance === "unknown") lines.push("Acceptance Contract 尚未形成可信闭环。");
  if (review === "failed" || review === "not_run" || review === "unknown") lines.push("Review Gate 尚未通过。");
  if (budgetExceeded(data)) lines.push("上下文预算触发，聊天摘要可能不完整；应以技术归档为准。");
  lines.push(...stringArray(data.known_risks));
  return lines.length ? unique(lines) : ["未发现有证据支持的阻断性风险。"];
}

export function buildBossModeReport(input: BossModeReportInput): string {
  const data = input.data;
  const format = input.format ?? "compact";
  const paths = patchPaths(data);
  const operations = patchCount(data);
  const validation = validationState(data);
  const acceptance = acceptanceState(data);
  const review = reviewState(data);
  const hasPatches = paths.length > 0 || operations > 0;
  const gatesPassed = validation === "passed"
    && (acceptance === "passed" || acceptance === "not_required")
    && (review === "passed" || review === "not_required");
  const gatesFailed = validation === "failed" || acceptance === "failed" || review === "failed";
  const canSubmit: "yes" | "no" | "review" | "none" = !hasPatches
    ? "none"
    : gatesFailed
      ? "no"
      : gatesPassed
        ? "yes"
        : "review";
  const goal = input.goal?.trim();
  const conclusion = canSubmit === "yes"
    ? "可以提交：自动验收、Acceptance Contract 和要求的 Review Gate 均已通过。"
    : canSubmit === "no"
      ? "不能提交：存在失败验收或阻断门禁。"
      : canSubmit === "review"
        ? "暂不建议提交：仍缺少可信验收或门禁结论。"
        : "无需提交：本次没有代码修改。";

  const compactSuccess = format === "compact" && asObject(data.report_policy)?.compact_success === true;
  const sections: ReportSection[] = compactSuccess
    ? [
        { title: "结论", lines: [conclusion] },
        { title: "状态与原因代码", lines: statusReasonLines(data) },
        { title: "完成内容", lines: observedChangeLines(paths, operations) },
        ...(data.active_skill ? [{ title: "使用的 Skill", lines: activeSkillLines(data) }] : []),
        { title: "影响范围", lines: impactLines(paths, data, input.technicalReportPath) },
        { title: "执行分级", lines: executionLaneLines(data) },
        { title: "耗时分解", lines: latencyLines(data) },
        { title: "真实用量与执行效率", lines: usageLedgerLines(data) },
        { title: "Acceptance Contract", lines: acceptanceLines(acceptance, data) },
        { title: "验收结果", lines: validationLines(validation, data, input.technicalReportPath) },
        { title: "Review 结果", lines: reviewLines(review, data) },
        { title: "证据路径", lines: evidenceLines(data, input.technicalReportPath) },
        { title: "报告与日志策略", lines: reportPolicyLines(data) },
        { title: "已知风险", lines: riskLines(validation, acceptance, review, data, paths) },
        { title: "未覆盖范围", lines: uncoveredLines(data) },
        { title: "当前不确定性", lines: uncertaintyLines(validation, data) },
        { title: "用户需要执行的操作", lines: userActionLines(data) },
        { title: "是否可提交", lines: submitLines(canSubmit, paths, input.title) }
      ]
    : [
        { title: "结论", lines: [conclusion] },
        { title: "状态与原因代码", lines: statusReasonLines(data) },
        { title: "任务目标", lines: scopeLines(goal ?? input.title, paths, data) },
        ...(data.active_skill ? [{ title: "使用的 Skill", lines: activeSkillLines(data) }] : []),
        { title: "根因", lines: rootCauseLines(data) },
        { title: "完成内容", lines: observedChangeLines(paths, operations) },
        { title: "未完成内容", lines: unfinishedLines(validation, acceptance, review, data) },
        { title: "关键变更", lines: observedChangeLines(paths, operations) },
        { title: "最小充分变更", lines: minimalChangeLines(data) },
        { title: "影响范围", lines: impactLines(paths, data, input.technicalReportPath) },
        { title: "执行分级", lines: executionLaneLines(data) },
        { title: "耗时分解", lines: latencyLines(data) },
        { title: "真实用量与执行效率", lines: usageLedgerLines(data) },
        { title: "Acceptance Contract", lines: acceptanceLines(acceptance, data) },
        { title: "验收结果", lines: validationLines(validation, data, input.technicalReportPath) },
        { title: "Review 结果", lines: reviewLines(review, data) },
        { title: "证据路径", lines: evidenceLines(data, input.technicalReportPath) },
        { title: "Provider 与回退", lines: providerLines(data) },
        { title: "浏览器会话与授权", lines: browserSessionLines(data) },
        { title: "恢复与自动重试", lines: retryAndRecoveryLines(data) },
        { title: "报告与日志策略", lines: reportPolicyLines(data) },
        { title: "已知风险", lines: riskLines(validation, acceptance, review, data, paths) },
        { title: "未覆盖范围", lines: uncoveredLines(data) },
        { title: "当前不确定性", lines: uncertaintyLines(validation, data) },
        { title: "当前最没把握的地方", lines: weakestConfidenceLines(validation, acceptance, review, data) },
        { title: "用户需要执行的操作", lines: userActionLines(data) },
        { title: "回滚", lines: rollbackLines(paths) },
        { title: "是否可提交", lines: submitLines(canSubmit, paths, input.title) }
      ];

  const report = buildStableReport({
    title: `${input.kind === "stage" ? "Boss Mode Stage Report" : "Boss Mode Report"}: ${input.title}`,
    runId: input.runId,
    sections: compactSections(sections, format, data)
  });
  return redactSensitiveText(report);
}
