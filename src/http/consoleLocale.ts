export const CONSOLE_LOCALE = "zh-CN";

export const CONSOLE_ENUM_LABELS: Record<string, string> = {
  unknown: "未知",
  none: "无",
  queued: "排队中",
  running: "运行中",
  validating: "验收中",
  waiting: "等待中",
  waiting_input: "等待输入",
  waiting_approval: "等待批准",
  completed: "已完成",
  timed_out: "已超时",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  recovering: "恢复中",
  recovery_required: "需要恢复",
  stale: "已失联",
  implemented_not_verified: "已实现未验收",
  blocked: "已阻塞",
  working: "工作中",
  silent: "静默",
  terminal: "已结束",
  planning: "规划中",
  context_collecting: "收集上下文",
  executing: "执行中",
  reporting: "生成报告",
  watching: "监视中",
  stopped: "已停止",
  not_started: "未开始",
  not_requested: "未请求",
  not_ready: "尚不可交付",
  ready: "可交付",
  committed: "已提交",
  pushed: "已推送",
  delivery_unknown: "交付状态未知",
  complete: "完整",
  partial: "部分缺失",
  already_synced: "已同步",
  pending: "待处理",
  passed: "通过",
  not_required: "无需验收",
  critical: "紧急",
  warning: "警告",
  info: "信息",
  attention: "需要处理",
  heavy_activity: "高负载活动",
  skipped: "已跳过",
  goal: "Goal",
  durable_job: "持久任务",
  job: "持久任务",
  alive: "存活",
  dead: "已停止",
  active: "活跃",
  idle: "空闲",
  available: "可用",
  unavailable: "不可用",
  execution_hard_limit: "达到绝对执行上限",
  no_progress_timeout: "真实进展超时",
  step_timeout: "步骤执行超时",
  explicit_cancel: "显式取消",
  cancel_grace_expired: "取消宽限期已用尽",
  heartbeat_persistence_failed: "心跳状态连续写入失败",
  spawn_hook_failed: "进程启动钩子失败",
  process_exit: "进程退出",
  resource_limit: "资源限制",
  termination_failed: "终止失败",
  unknown_timeout: "未知超时",
  clean: "干净",
  safe: "安全",
  unsafe: "不安全",
  read_only: "只读",
  local_write: "本地写入",
  external_write: "外部写入",
  automatic: "自动",
  manual: "手动",
  agent: "代理模式",
  handoff: "交接模式",
  pro: "专业包模式",
  off: "关闭",
  full: "完整",
  compact: "精简",
  metadata: "仅元数据",
  read: "只读",
  workspace: "工作区",
  minimal: "最小",
  progressive: "渐进",
  not_applicable: "不适用",
  multi_project_container: "多项目聚合工作区",
  standard: "标准",
  lightweight: "轻量",
  heavy: "高负载",
  urgent: "紧急",
  normal: "普通",
  background: "后台",
  admitted: "已准入",
  queued_by_resource_policy: "按资源策略排队",
  resource_wait_timeout: "等待资源超时",
  blocked_by_resource_policy: "被资源策略阻塞",
  workspace_write: "工作区写入",
  workspace_read: "工作区只读",
  https_wsl_proxy: "HTTPS · WSL 代理",
  https_direct: "HTTPS · 直连",
  http_proxy: "HTTP · 代理",
  http_direct: "HTTP · 直连",
  ssh: "SSH",
  local: "本地 Remote",
  failed_authentication: "认证失败",
  failed_non_fast_forward: "远端冲突",
  failed_proxy_unavailable: "代理不可用",
  failed_remote_service: "远端服务异常",
  failed_network: "网络失败",
  failed_unknown: "未知推送失败",
  remote_sha_mismatch: "远端 SHA 不一致",
  global_standard: "全局标准任务",
  global_heavy: "全局高负载任务",
  browser_live_verification: "真实浏览器验收",
  docker_rebuild: "Docker 重建",
  full_acceptance: "完整验收",
  database_maintenance: "数据库维护",
  cloudflare: "Cloudflare 快速隧道",
  ngrok: "ngrok 固定地址",
  "cloudflare-named": "Cloudflare 命名隧道"
};

export const CONSOLE_ACTION_LABELS: Record<string, string> = {
  resume: "继续任务",
  cancel: "取消任务",
  retry_step: "重试当前步骤",
  retry_push: "重新推送",
  timeline: "查看时间线",
  evidence: "查看证据",
  recovery: "查看恢复方案",
  quick_acceptance: "运行快速验收",
  docker_status: "检查 Docker 状态",
  generate_project_map: "生成项目地图",
  copy_git_add: "复制 git add 命令"
};

export const CONSOLE_TEXT_LABELS: Record<string, string> = {
  "Current handoff execution": "当前 Handoff 执行",
  "Handoff execution completed, but completion must be established by validation evidence rather than replay.": "Handoff 执行已完成，但必须通过验收证据确认结果，不能直接重放。",
  "Run or review validation evidence before accepting the task.": "运行或审查验收证据后，再确认接受该任务。",
  "Open the task recovery view before creating a replacement or retrying.": "创建替代任务或重试前，先打开任务恢复视图。",
  "Task identity and authority state are durable; the projection is no longer derived from the current browser page.": "任务标识和权威状态已持久化；当前投影不再依赖此浏览器页面。",
  "Inspect recovery and evidence before retrying.": "重试前先检查恢复方案和任务证据。",
  "Open the recovery plan and reconcile authority state before resuming.": "继续任务前，先打开恢复方案并核对权威状态。"
};

export const CONSOLE_ATTENTION_TYPE_LABELS: Record<string, string> = {
  attention: "待处理事项",
  approval_required: "需要批准",
  decision_required: "需要决策",
  browser_authorization: "需要浏览器授权",
  recovery_required: "需要恢复确认",
  resource_blocked: "资源受限",
  task_failed: "任务失败",
  task_completed: "任务完成",
  external_service_wait: "等待外部服务",
  remote_sync_succeeded: "远端同步成功",
  remote_sync_failed: "远端同步失败",
  local_version_recorded: "本地版本已记录"
};

export function consoleEnumLabel(value: unknown, fallback = "未知"): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return fallback;
  return CONSOLE_ENUM_LABELS[raw] ?? raw;
}

export function consoleActionLabel(value: unknown, fallback = "操作"): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return fallback;
  return CONSOLE_ACTION_LABELS[raw] ?? raw;
}

export function consoleAttentionTypeLabel(value: unknown, fallback = "待处理事项"): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return fallback;
  return CONSOLE_ATTENTION_TYPE_LABELS[raw] ?? raw;
}

export function formatConsoleDateTime(value: unknown, fallback = "未知"): string {
  const raw = typeof value === "string" || typeof value === "number" ? value : "";
  if (raw === "") return fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(raw);
  return new Intl.DateTimeFormat(CONSOLE_LOCALE, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}
