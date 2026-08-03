import type { OfficeObjectiveV1, OfficeZone } from "./officeProjectionService.js";
import type { OfficePlainLanguageFeatureFlag, OfficePlainSummaryV1 } from "./officePlainLanguageTypes.js";

const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  incomplete: "尚未完成",
  running: "正在执行",
  working: "正在执行",
  queued: "正在排队",
  queued_by_resource_policy: "正在等待执行资源",
  waiting: "正在等待",
  waiting_input: "等待补充信息",
  waiting_approval: "等待老板批准",
  validating: "正在测试验收",
  pending: "尚未开始",
  passed: "已通过",
  failed: "执行失败",
  recovering: "正在恢复",
  completed: "已完成",
  delivered: "已交付",
  cancelled: "已取消",
  interrupted: "已中断",
  stale: "后台状态失联",
  fresh: "进展正常",
  quiet: "暂时没有新进展",
  stalled: "疑似停滞",
  severe: "长时间没有新进展",
  no_progress: "暂无新进展",
  not_requested: "尚未提交代码",
  committed: "已提交到本地版本库",
  pushed: "已同步到远端仓库",
  not_ready: "尚未达到交付条件",
  ready: "已达到交付条件",
  active: "正在使用",
  inactive: "当前未使用",
  idle: "当前空闲",
  stopped: "已经停止",
  terminal: "已经结束",
  unknown: "状态暂时无法确认",
  not_required: "无需验收",
  implemented_not_verified: "已完成修改，尚未验收",
  admitted: "已获得执行资源"
});

const ZONE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  waiting_user: "等待老板区",
  incident: "故障处理室",
  recovering: "恢复处理区",
  validation: "测试验收室",
  browser: "浏览器操作室",
  development: "开发工作区",
  delivery: "提交交付区",
  dispatch: "任务分派台",
  archive: "已完成归档区",
  writer_queue: "等待写入区",
  writer: "文件写入台"
});

const EVIDENCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  resource_governor: "资源调度记录",
  task_resource_projection: "任务资源记录",
  task_writer_activity: "文件写入记录",
  no_writer_activity: "当前任务记录",
  no_current_attempt: "任务历史记录",
  execution_component_store: "后台执行记录",
  objective_projection: "任务状态记录",
  durable_job_store: "持续执行任务记录",
  goal_store: "任务目标记录",
  handoff_status: "任务交接记录",
  runtime: "实时执行记录",
  browser: "浏览器操作记录",
  acceptance: "测试验收记录",
  git: "代码交付记录"
});

const COMPONENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  model_stream: "智能体思考步骤",
  tool_process: "工具执行步骤",
  worker: "后台执行步骤",
  mcp_tool_result: "工具执行结果"
});

const EXECUTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: "开发智能体",
  worker: "执行智能体",
  browser: "浏览器智能体",
  acceptance: "验收智能体",
  resource_lease_holder: "文件写入智能体",
  handoff: "任务交接智能体",
  agent: "执行智能体"
});

const ACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/apply[_ -]?patch|patch bundle|批量.*(?:文件|修改)/i, "批量修改项目文件"],
  [/\b(?:edit|write|modify|update)\b.*(?:file|workspace|source)|修改.*文件/i, "修改项目文件"],
  [/\b(?:read|inspect)\b.*(?:file|project|source)|读取.*(?:资料|文件)/i, "读取项目资料"],
  [/\b(?:search|grep|rg)\b|搜索.*(?:代码|项目|内容)/i, "搜索项目内容"],
  [/\b(?:test|smoke|validation)\b|运行.*(?:测试|验收)/i, "运行测试验收"],
  [/\b(?:build|compile|tsc)\b|构建检查/i, "运行构建检查"],
  [/browser.*open|open.*browser|打开.*网页/i, "打开网页"],
  [/browser.*(?:inspect|observe)|检查.*网页/i, "检查网页内容"],
  [/browser.*click|点击.*网页|操作.*网页/i, "操作网页"],
  [/browser.*(?:verify|accept)|验证.*网页/i, "验证网页结果"],
  [/git.*commit|提交代码/i, "提交代码"],
  [/git.*push|同步代码|推送代码/i, "同步代码到远端"],
  [/waiting.*(?:next|step)|等待下一步/i, "等待下一步"],
  [/waiting.*(?:user|approval|input)|等待.*(?:老板|批准|输入)/i, "等待老板处理"],
  [/recover|恢复.*任务/i, "正在恢复任务"],
  [/deliver|upload|交付|上传/i, "正在整理并提交交付结果"],
  [/queue|dispatch|排队|调度/i, "等待任务调度"],
  [/diagnos|incident|故障|异常/i, "检查并处理异常"],
  [/document|资料|文档/i, "查看任务资料"]
]);

function booleanFlag(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function officePlainLanguageFeatureFlag(env: NodeJS.ProcessEnv = process.env): OfficePlainLanguageFeatureFlag {
  return {
    enabled: booleanFlag(env.CODEXPRO_OFFICE_PLAIN_LANGUAGE) !== false,
    tech_view_enabled: booleanFlag(env.CODEXPRO_OFFICE_TECH_VIEW) !== false
  };
}

function normalized(value: unknown): string {
  return String(value ?? "").trim();
}

function hasChinese(value: unknown): boolean {
  return /[\u3400-\u9fff]/u.test(normalized(value));
}

const BOSS_HIDDEN_TECHNICAL_TERM = /\b(?:objective|attempt|owner|writer\s+lease|managed_pid|handoff\s+worker|agent\s+run|tool_process|mcp_tool_result|incomplete|fresh|not_requested)\b|(?:worker|direct-tool|tool_process):/iu;

function safeChinese(value: unknown, fallback: string, max = 180): string {
  const text = normalized(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ");
  return text && hasChinese(text) && !BOSS_HIDDEN_TECHNICAL_TERM.test(text) ? text.slice(0, max) : fallback;
}

export function plainTaskStatus(value: unknown): string {
  const raw = normalized(value).toLowerCase();
  return STATUS_LABELS[raw] ?? "状态待识别";
}

export function plainZoneName(value: unknown): string {
  return ZONE_LABELS[normalized(value)] ?? "区域待识别";
}

export function plainExecutorName(value: unknown): string {
  return EXECUTOR_LABELS[normalized(value).toLowerCase()] ?? "执行智能体";
}

export function plainComponentName(value: unknown): string {
  return COMPONENT_LABELS[normalized(value).toLowerCase()] ?? "后台执行步骤";
}

export function plainEvidenceName(value: unknown): string {
  const raw = normalized(value).toLowerCase();
  if (EVIDENCE_LABELS[raw]) return EVIDENCE_LABELS[raw];
  if (raw.includes("browser")) return "浏览器操作记录";
  if (raw.includes("accept") || raw.includes("validation")) return "测试验收记录";
  if (raw.includes("writer") || raw.includes("lease")) return "文件写入记录";
  if (raw.includes("git")) return "代码交付记录";
  if (raw.includes("runtime") || raw.includes("component")) return "后台执行记录";
  return "证据来源待识别";
}

export function plainCurrentWork(value: unknown, zone?: OfficeZone | string): string {
  const raw = normalized(value);
  for (const [pattern, label] of ACTION_PATTERNS) if (pattern.test(raw)) return label;
  const fallbackByZone: Readonly<Record<string, string>> = {
    waiting_user: "等待老板处理",
    incident: "检查并处理异常",
    recovering: "正在恢复任务",
    validation: "运行测试验收",
    browser: "操作并检查网页",
    development: "处理项目修改",
    delivery: "整理并提交交付结果",
    dispatch: "等待任务调度",
    archive: "任务已结束，不再执行工作动作",
    writer: "正在写入项目文件",
    writer_queue: "正在等待文件写入权"
  };
  return fallbackByZone[normalized(zone)] ?? "执行步骤待识别";
}

export function plainLatestResult(objective: Pick<OfficeObjectiveV1, "current_attempt" | "zone">): string {
  const attempt = objective.current_attempt;
  if (attempt?.git?.push_status === "pushed" || attempt?.delivery_status === "pushed") return "代码已同步到远端仓库";
  if (attempt?.git?.commit_status === "committed" || attempt?.delivery_status === "committed") return "代码已提交到本地版本库";
  if (attempt?.validation_status === "passed" || attempt?.acceptance_status === "passed") return "测试验收已经通过";
  if (["failed", "cancelled"].includes(attempt?.status ?? "")) return attempt?.status === "failed" ? "本次执行没有成功" : "本次执行已取消";
  if (objective.zone === "archive") return "任务已经结束并进入归档";
  const report = attempt?.report_summary?.current_summary;
  if (report) return "已有新的可核验进展";
  if ((attempt?.progress.current ?? 0) > 0) {
    const total = attempt?.progress.total;
    return total ? `已完成 ${attempt!.progress.current} / ${total} 个已记录步骤` : `已记录 ${attempt!.progress.current} 个进展步骤`;
  }
  return "尚无新的已完成结果";
}

export function plainNextStep(objective: Pick<OfficeObjectiveV1, "user_action_required" | "system_next_action">): string {
  if (objective.user_action_required?.required) {
    return safeChinese(objective.user_action_required.prompt, "等待老板完成所需处理");
  }
  const next = objective.system_next_action;
  if (!next) return "尚无已确认的下一步";
  return plainCurrentWork(next);
}

export function plainOwnerAction(objective: Pick<OfficeObjectiveV1, "requires_human" | "user_action_required">): string {
  if (!objective.requires_human && objective.user_action_required?.required !== true) return "暂时不需要老板处理";
  return safeChinese(objective.user_action_required?.prompt, "需要老板查看并处理当前待办");
}

export function plainBackgroundContinuation(objective: Pick<OfficeObjectiveV1, "current_attempt">): string {
  const attempt = objective.current_attempt;
  if (!attempt) return "当前没有正在执行的后台任务";
  if (attempt.safe_to_close_chat.safe) return "可以关闭当前对话，任务会继续运行";
  return "此任务目前依赖当前对话，关闭对话后可能不会继续执行";
}

export function plainDeliveryStatus(objective: Pick<OfficeObjectiveV1, "current_attempt">): string {
  const attempt = objective.current_attempt;
  const value = attempt?.git?.delivery_status ?? attempt?.delivery_status ?? "not_requested";
  return `代码交付：${plainTaskStatus(value)}`;
}

export function plainValidationStatus(objective: Pick<OfficeObjectiveV1, "current_attempt">): string {
  const attempt = objective.current_attempt;
  const value = attempt?.validation_status ?? attempt?.acceptance_status ?? "not_requested";
  return `测试验收：${plainTaskStatus(value)}`;
}

export function plainRiskStatus(objective: Pick<OfficeObjectiveV1, "resource_alerts" | "no_progress_level" | "current_attempt">): string {
  if (objective.resource_alerts.length) return `发现 ${objective.resource_alerts.length} 项需要关注的问题`;
  if (["stalled", "severe"].includes(objective.no_progress_level)) return "任务长时间没有新的真实进展，需要关注";
  if (objective.current_attempt?.latest_error) return "最近一次执行记录包含错误，需要检查";
  if (objective.current_attempt?.observability.owner_alive === false) return "后台执行已经失联，需要检查";
  return "当前没有发现需要老板立即处理的风险";
}

export function plainRelativeTime(value: unknown, now = Date.now()): string {
  const timestamp = Date.parse(normalized(value));
  if (!Number.isFinite(timestamp)) return "时间暂时无法确认";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function createOfficePlainSummary(objective: Omit<OfficeObjectiveV1, "plain_summary">): OfficePlainSummaryV1 {
  const attempt = objective.current_attempt;
  const taskStatus = objective.user_action_required?.required === true || objective.requires_human
    ? "等待老板处理"
    : plainTaskStatus(objective.objective_status === "incomplete" && attempt?.status
      ? attempt.status === "active" ? "running" : attempt.status
      : objective.objective_status);
  return {
    version: 1,
    task_status: taskStatus,
    current_work: plainCurrentWork(attempt?.action || attempt?.safe_progress_summary || objective.summary, objective.zone),
    latest_result: plainLatestResult(objective),
    next_step: plainNextStep(objective),
    owner_action: plainOwnerAction(objective),
    background_continuation: plainBackgroundContinuation(objective),
    delivery_status: plainDeliveryStatus(objective),
    validation_status: plainValidationStatus(objective),
    risk_status: plainRiskStatus(objective)
  };
}
