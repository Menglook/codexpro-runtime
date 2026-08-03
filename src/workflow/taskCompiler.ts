import { createHash } from "node:crypto";
import {
  evaluateTaskRiskProfile,
  taskRiskLevelFromUnified,
  type UnifiedRiskDecision
} from "../security/riskGate.js";
import {
  authorizationDecisionPayload,
  createAuthorizationPayloadBinding,
  verifyAuthorizationPayloadBinding,
  type AuthorizationPayloadBindingV1
} from "../security/authorizationIntegrity.js";
import {
  mergePermissionDecisions,
  verifyPermissionDecision,
  type MonotonicPermissionDecision,
  type PermissionDecisionSource
} from "../security/permissionDecision.js";
import { compileMinimalChangeContract, type MinimalChangeContract, type MinimalChangeContractInput } from "./minimalChange.js";

export type SourceWritePolicy = "none" | "scoped" | "workspace";
export type TaskRiskLevel = "low" | "medium" | "high" | "critical";
export type TaskPhaseKind = "inspect" | "plan" | "execute" | "validate" | "review" | "git_prepare" | "report";

export interface TaskCapabilityMatrix {
  read_workspace: boolean;
  write_source: boolean;
  write_artifacts: boolean;
  run_bash: boolean;
  use_browser: boolean;
  use_network: boolean;
  use_git: boolean;
  read_database: boolean;
  write_database: boolean;
}

export type TaskAllowedAction =
  | "read_workspace"
  | "write_source"
  | "write_artifacts"
  | "run_bash"
  | "use_browser"
  | "use_network"
  | "git_local"
  | "git_push"
  | "read_database"
  | "write_database"
  | "external_write"
  | "deployment";

export type TaskValidationLevel = "none" | "targeted" | "full" | "release";

export interface TaskAuthorizationDecision {
  version: 1;
  decision_id: string;
  allowed_actions: TaskAllowedAction[];
  allowed_paths: string[];
  forbidden_paths: string[];
  git_permission: "none" | "local" | "remote";
  network_permission: "none" | "read" | "write";
  browser_permission: "none" | "read" | "interactive";
  external_side_effects: Array<{ action: string; target: string; maximum_loss: "local" | "remote" | "production" | "business_critical"; reversible: boolean }>;
  validation_level: TaskValidationLevel;
  authorization_evidence: string[];
  issued_at: string;
  payload_binding?: AuthorizationPayloadBindingV1;
  permission_decision?: MonotonicPermissionDecision;
}

export interface CompiledTaskPhase {
  id: string;
  kind: TaskPhaseKind;
  description: string;
  requires_approval: boolean;
  idempotent: boolean;
}

export interface CompiledTask {
  version: 1;
  intent: string;
  deliverables: string[];
  scope: string[];
  constraints: string[];
  source_write_policy: SourceWritePolicy;
  artifact_write_paths: string[];
  bash_required: boolean;
  browser_required: boolean;
  network_required: boolean;
  fresh_information_required: boolean;
  risk_level: TaskRiskLevel;
  risk_decision: UnifiedRiskDecision;
  approval_points: string[];
  acceptance: string[];
  assumptions: string[];
  confidence: number;
  capabilities: TaskCapabilityMatrix;
  phases: CompiledTaskPhase[];
  signals: string[];
  minimal_change_contract: MinimalChangeContract;
  authorization_decision: TaskAuthorizationDecision;
}

export interface CompileTaskOptions {
  explicitAcceptance?: string[];
  explicitConstraints?: string[];
  explicitScope?: string[];
  explicitAllowedPaths?: string[];
  explicitForbiddenPaths?: string[];
  minimalChange?: MinimalChangeContractInput;
}

const SOURCE_WRITE_SIGNALS = [
  "开始修", "直接修", "修一下", "改掉", "修复", "修改代码", "改代码", "修改页面", "修改前端", "修改样式", "实现", "落地", "重构", "补丁", "新增功能", "删除代码",
  "帮我处理", "处理一下", "解决一下", "再改", "然后执行", "并执行",
  "fix", "patch", "implement", "refactor", "change code", "edit source"
];
const WORKSPACE_WRITE_SIGNALS = ["全站", "所有页面", "整个项目", "全量", "完整 stage", "大阶段", "whole project", "all pages", "stage"];
const READ_ONLY_SIGNALS = [
  "只读", "只审计", "不要修改", "不修改代码", "不改代码", "不修改源代码", "不要修改源代码", "不改源代码", "只看", "仅检查",
  "read only", "audit only", "do not modify", "do not edit", "no source changes"
];
const ARTIFACT_SIGNALS = ["写入 md", "写入markdown", "形成计划", "修改计划", "更新计划", "生成报告", "输出报告", "保存报告", "write a report", "write markdown", "create a plan", "edit plan", "update plan"];
const BASH_SIGNALS = [
  "运行测试", "执行测试", "编译", "构建", "lint", "typecheck", "npm run", "pytest", "test", "build",
  "release gate", "release-gate", "发布门禁", "浏览器验收", "页面验收", "browser validation", "browser smoke", "browser-smoke", "visual regression"
];
const BROWSER_SIGNALS = ["浏览器", "页面", "截图", "视觉", "移动端", "点击", "登录态", "browser", "screenshot", "visual", "viewport"];
const NETWORK_SIGNALS = ["联网", "最新", "搜索网页", "远程", "api 请求", "network", "latest", "web search", "remote"];
const FRESH_SIGNALS = ["最新", "当前", "今天", "现在", "实时", "latest", "current", "today", "real-time"];
const GIT_SIGNALS = ["提交", "推送", "合并", "commit", "push", "merge", "git add"];
const DATABASE_SIGNALS = ["数据库", "sql", "select", "表结构", "database", "query table"];
const DATABASE_WRITE_SIGNALS = ["update ", "delete from", "insert into", "写数据库", "改数据库", "迁移数据", "database write"];
const DESTRUCTIVE_SIGNALS = ["删除数据", "清空", "销毁", "覆盖生产", "drop table", "truncate", "delete data", "destroy"];
const CRITICAL_SIGNALS = ["付款", "支付", "转账", "生产密钥", "真实订单", "payment", "transfer money", "production secret"];
const APPROVAL_SIGNALS: Array<[string[], string]> = [
  [["提交", "commit"], "Approve Git commit"],
  [["推送", "push"], "Approve Git push"],
  [["合并", "merge"], "Approve branch merge"],
  [["删除", "drop", "truncate", "destroy"], "Approve destructive operation"],
  [["付款", "支付", "payment", "transfer"], "Approve payment or financial operation"],
  [["生产", "production"], "Approve production-impacting operation"]
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function nonExecutableReferenceClause(clause: string): boolean {
  return /(do not execute|不要执行)/i.test(clause)
    || /(?:文档|报告|说明)(?:中|里|中的|里的).*(?:示例|例如|样例|sample|example)/i.test(clause)
    || /^(?:示例|例如|样例|sample|example)\s*[:：-]/i.test(clause);
}

function executionIntentText(instruction: string): string {
  const withoutFences = instruction.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, " ");
  return clauses(withoutFences)
    .filter((clause) => !nonExecutableReferenceClause(clause))
    .join("\n");
}

function directAuthorizationEvidence(instruction: string): string[] {
  return clauses(instruction).filter((clause) =>
    /(直接提交推送|提交并推送|直接推送|确认推送|授权(?:执行|推送|重启)|批准(?:执行|推送)|proceed with push|push directly|approved)/i.test(clause)
    && !nonExecutableReferenceClause(clause)
    && !/(不要|不得|禁止|不允许|do not|must not)/i.test(clause)
  );
}

function validationLevel(instruction: string, sourceWrite: boolean, acceptance: string[]): TaskValidationLevel {
  if (/(release gate|发布验收|release profile|发布门禁)/i.test(instruction)) return "release";
  if (/(完整 smoke|full smoke|全量验收|全量回归)/i.test(instruction)) return "full";
  if (sourceWrite || acceptance.length || /(测试|验收|build|lint|typecheck)/i.test(instruction)) return "targeted";
  return "none";
}

function permissionSourceFromRisk(decision: UnifiedRiskDecision): PermissionDecisionSource {
  if (!decision.allowed) {
    const requiresApproval = decision.level !== "L3"
      && decision.explicit_authorization_required
      && !decision.authorization_detected;
    return {
      source: "risk_gate",
      decision: requiresApproval ? "ask" : "deny",
      reason: decision.reason,
      constraints: decision.matched_signals
    };
  }
  return {
    source: "risk_gate",
    decision: decision.level === "L0" ? "allow" : "constrained",
    reason: decision.reason,
    constraints: decision.level === "L0" ? [] : [
      ...(decision.checkpoint_required ? ["checkpoint_required"] : []),
      ...(!decision.automatic_replay_allowed ? ["automatic_replay_forbidden"] : [])
    ]
  };
}

export function bindTaskAuthorizationDecision(
  decision: TaskAuthorizationDecision,
  options: {
    approvedBy?: string;
    approvedAt?: string;
    manualConfirmation?: boolean;
  } = {}
): TaskAuthorizationDecision {
  const payload = authorizationDecisionPayload(decision);
  return {
    ...decision,
    payload_binding: createAuthorizationPayloadBinding(payload, {
      payloadVersion: decision.version,
      scope: "task_authorization_decision",
      approvedBy: options.approvedBy ?? "task_instruction",
      approvedAt: options.approvedAt ?? decision.issued_at,
      manualConfirmation: options.manualConfirmation === true
    })
  };
}

export function verifyTaskAuthorizationDecision(decision: TaskAuthorizationDecision): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!decision.payload_binding) reasons.push("payload_binding_missing");
  else {
    const verification = verifyAuthorizationPayloadBinding(authorizationDecisionPayload(decision), decision.payload_binding);
    reasons.push(...verification.reasons.map((reason) => `payload_${reason}`));
  }
  if (!decision.permission_decision) reasons.push("permission_decision_missing");
  else {
    const verification = verifyPermissionDecision(decision.permission_decision);
    reasons.push(...verification.reasons.map((reason) => `permission_${reason}`));
  }
  return { valid: reasons.length === 0, reasons };
}

function authorizationDecision(input: {
  instruction: string;
  paths: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  capabilities: TaskCapabilityMatrix;
  artifactPaths: string[];
  acceptance: string[];
  directIntent: string;
  riskDecision: UnifiedRiskDecision;
}): TaskAuthorizationDecision {
  const actions: TaskAllowedAction[] = ["read_workspace"];
  if (input.capabilities.write_source) actions.push("write_source");
  if (input.capabilities.write_artifacts) actions.push("write_artifacts");
  if (input.capabilities.run_bash) actions.push("run_bash");
  if (input.capabilities.use_browser) actions.push("use_browser");
  if (input.capabilities.use_network) actions.push("use_network");
  if (input.capabilities.read_database) actions.push("read_database");
  if (input.capabilities.write_database) actions.push("write_database");
  const evidence = directAuthorizationEvidence(input.instruction);
  const pushRequested = /(?:git\s+push|push\s+origin|提交并推送|直接提交推送|直接推送)/i.test(input.directIntent);
  if (input.capabilities.use_git) actions.push("git_local");
  if (pushRequested && evidence.length) actions.push("git_push");
  const externalWrite = /(?:-X\s*(?:POST|PUT|PATCH|DELETE)|发送消息|发送邮件|创建远端资源|修改远端配置)/i.test(input.directIntent);
  const deployment = /(?:部署|发布到生产|kubectl\s+apply|terraform\s+apply|npm\s+publish)/i.test(input.directIntent);
  if (externalWrite && evidence.length) actions.push("external_write");
  if (deployment && evidence.length) actions.push("deployment");
  const externalSideEffects = [
    ...(actions.includes("git_push") ? [{ action: "git_push", target: "configured git remote", maximum_loss: "remote" as const, reversible: true }] : []),
    ...(actions.includes("external_write") ? [{ action: "external_write", target: "explicit external target", maximum_loss: "remote" as const, reversible: false }] : []),
    ...(actions.includes("deployment") ? [{ action: "deployment", target: "explicit deployment target", maximum_loss: "production" as const, reversible: false }] : [])
  ];
  const canonical = JSON.stringify({
    actions: [...new Set(actions)].sort(),
    paths: [...new Set([...input.allowedPaths, ...input.paths, ...input.artifactPaths])].sort(),
    forbidden: [...new Set(input.forbiddenPaths)].sort(),
    evidence,
    externalSideEffects,
    validation: validationLevel(input.instruction, input.capabilities.write_source, input.acceptance)
  });
  const issuedAt = new Date().toISOString();
  const taskDecision: PermissionDecisionSource = {
    source: "task_contract",
    decision: input.riskDecision.level === "L0" ? "allow" : "constrained",
    reason: input.riskDecision.level === "L0"
      ? "Compiled task is read-only."
      : "Compiled task is limited to declared actions, paths, and side effects.",
    constraints: [
      ...input.forbiddenPaths.map((value) => `forbidden_path:${value}`),
      ...(!input.riskDecision.automatic_replay_allowed ? ["automatic_replay_forbidden"] : [])
    ]
  };
  const userDecision: PermissionDecisionSource = {
    source: "user_authorization",
    decision: externalSideEffects.length && !evidence.length ? "ask" : "allow",
    reason: externalSideEffects.length
      ? evidence.length
        ? "Explicit authorization evidence is attached for declared external side effects."
        : "Declared external side effects require explicit authorization evidence."
      : "No external side effect requires separate user authorization.",
    evidence_refs: evidence
  };
  const permissionDecision = mergePermissionDecisions([
    permissionSourceFromRisk(input.riskDecision),
    taskDecision,
    userDecision,
    {
      source: "runtime_policy",
      decision: input.riskDecision.level === "L3" ? "deny" : "allow",
      reason: input.riskDecision.level === "L3"
        ? "Runtime policy prohibits automatic irreversible or business-critical execution."
        : "Runtime policy adds no broader permission than the task and risk decisions."
    }
  ]);
  const decision: TaskAuthorizationDecision = {
    version: 1,
    decision_id: "auth_" + createHash("sha256").update(canonical).digest("hex").slice(0, 24),
    allowed_actions: [...new Set(actions)],
    allowed_paths: [...new Set([...input.allowedPaths, ...input.paths, ...input.artifactPaths])],
    forbidden_paths: [...new Set(input.forbiddenPaths)],
    git_permission: actions.includes("git_push") ? "remote" : actions.includes("git_local") ? "local" : "none",
    network_permission: actions.includes("external_write") || actions.includes("deployment") ? "write" : actions.includes("use_network") ? "read" : "none",
    browser_permission: input.capabilities.use_browser ? "interactive" : "none",
    external_side_effects: externalSideEffects,
    validation_level: validationLevel(input.instruction, input.capabilities.write_source, input.acceptance),
    authorization_evidence: evidence,
    issued_at: issuedAt,
    permission_decision: permissionDecision
  };
  return bindTaskAuthorizationDecision(decision, {
    approvedBy: "task_instruction",
    approvedAt: issuedAt,
    manualConfirmation: false
  });
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function containsAny(text: string, signals: string[]): string[] {
  return signals.filter((signal) => text.includes(signal.toLowerCase()));
}

function clauses(instruction: string): string[] {
  return uniq(instruction
    .split(/[\n。；;!?！？]+/)
    .map((value) => value.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean));
}

function extractPaths(instruction: string): string[] {
  const values: string[] = [];
  for (const match of instruction.matchAll(/`([^`]+)`/g)) values.push(match[1]);
  for (const match of instruction.matchAll(/(?:^|[\s（(])([./\w-]+\.(?:md|json|ya?ml|ts|tsx|js|mjs|cjs|py|php|css|scss|html|vue|sql))(?:$|[\s，。；;)）])/gim)) {
    values.push(match[1]);
  }
  for (const match of instruction.matchAll(/(?:^|\s)((?:planning-local|docs|src|scripts|tests?|\.ai-bridge|\.codexpro)\/[\w./\-\u4e00-\u9fff]+)/gim)) {
    values.push(match[1]);
  }
  return uniq(values);
}

function artifactPaths(instruction: string, paths: string[], artifactRequested: boolean): string[] {
  const explicit = paths.filter((value) => /(?:^|\/)(?:planning-local|docs|reports?|\.ai-bridge|\.codexpro)(?:\/|$)|\.(?:md|json|ya?ml|txt|html)$/i.test(value));
  if (explicit.length) return explicit;
  if (/planning-local/i.test(instruction)) return ["planning-local/**"];
  if (/\.ai-bridge/i.test(instruction)) return [".ai-bridge/**"];
  return artifactRequested ? ["reports/**"] : [];
}

function extractConstraints(instruction: string, options: CompileTaskOptions): string[] {
  const negative = clauses(instruction).filter((value) => /(不要|不得|禁止|不允许|不能|无需|without|do not|must not|never|no\s+)/i.test(value));
  return uniq([...(options.explicitConstraints ?? []), ...negative]);
}

function extractAcceptance(instruction: string, options: CompileTaskOptions): string[] {
  const acceptanceClauses = clauses(instruction).filter((value) => /(验收|确保|必须|通过|不得出现|保持|兼容|verify|ensure|must|pass|preserve|compatible)/i.test(value));
  return uniq([...(options.explicitAcceptance ?? []), ...acceptanceClauses]);
}

function extractMustPreserve(instruction: string): string[] {
  return clauses(instruction).filter((value) => /(保持|保留|不得改变|不能改变|兼容|preserve|keep|remain|compatible|must not change)/i.test(value));
}

function extractNonGoals(instruction: string): string[] {
  return clauses(instruction).filter((value) => /(不做|不包含|无需|不要(?:顺手)?(?:重构|扩展|新增)|不得新增|do not|must not|without|out of scope|non-goal)/i.test(value));
}

function expectedChangeAreas(paths: string[], sourceWrite: boolean, artifactRequested: boolean, bashRequired: boolean, browserRequired: boolean): string[] {
  const areas = paths.map((value) => `Path: ${value}`);
  if (sourceWrite && !paths.length) areas.push("Narrowly discovered source implementation");
  if (artifactRequested) areas.push("Requested plan or report artifacts");
  if (bashRequired) areas.push("Targeted validation evidence");
  if (browserRequired) areas.push("Browser validation evidence");
  return uniq(areas);
}

function extractDeliverables(instruction: string, paths: string[], artifactRequested: boolean, sourceWrite: boolean): string[] {
  const result: string[] = [];
  if (artifactRequested) result.push("A persisted plan or report artifact");
  if (sourceWrite) result.push("Scoped source-code changes");
  if (/审计|audit|review/i.test(instruction)) result.push("Audit findings with evidence");
  if (/截图|screenshot/i.test(instruction)) result.push("Browser screenshots or visual evidence");
  if (/测试|验收|validate|test/i.test(instruction)) result.push("Validation results");
  if (/提交|推送|commit|push/i.test(instruction)) result.push("Approval-gated Git preparation");
  result.push(...paths.map((value) => `Artifact or scope: ${value}`));
  return uniq(result.length ? result : ["A concise task result"]);
}

function buildPhases(instruction: string, sourceWrite: boolean, artifactRequested: boolean, browser: boolean, git: boolean): CompiledTaskPhase[] {
  const phases: CompiledTaskPhase[] = [];
  const auditFirst = /(先审计|先检查|先分析|audit first|inspect first)/i.test(instruction);
  const validateBeforeGit = /(验收通过后|验证通过后|测试通过后|after validation|after tests pass)/i.test(instruction);
  if (auditFirst || !sourceWrite) phases.push({ id: "inspect", kind: "inspect", description: "Inspect the relevant scope without mutation.", requires_approval: false, idempotent: true });
  if (artifactRequested && !sourceWrite) phases.push({ id: "plan", kind: "plan", description: "Write only the requested plan/report artifact.", requires_approval: false, idempotent: true });
  if (sourceWrite) phases.push({ id: "execute", kind: "execute", description: "Apply scoped implementation changes.", requires_approval: false, idempotent: false });
  if (browser || /测试|验收|validate|test/i.test(instruction) || validateBeforeGit) phases.push({ id: "validate", kind: "validate", description: "Validate the requested behavior and persist evidence.", requires_approval: false, idempotent: true });
  if (/review|审查|复核/i.test(instruction)) phases.push({ id: "review", kind: "review", description: "Review changes and blocking findings independently from execution.", requires_approval: false, idempotent: true });
  if (git) phases.push({ id: "git_prepare", kind: "git_prepare", description: "Prepare Git actions only after prior gates pass.", requires_approval: true, idempotent: false });
  if (!phases.some((phase) => phase.kind === "report")) phases.push({ id: "report", kind: "report", description: "Report completed, incomplete, and unverified scope with evidence.", requires_approval: false, idempotent: true });
  return phases;
}

function taskIntent(instruction: string): string {
  return clauses(instruction)[0]?.slice(0, 500) || instruction.trim().slice(0, 500) || "Unspecified task";
}

export function compileTask(instruction: string, options: CompileTaskOptions = {}): CompiledTask {
  const raw = instruction.trim();
  const directIntent = executionIntentText(raw);
  const text = normalize(directIntent);
  const signals: string[] = [];
  const readOnlyHits = containsAny(text, READ_ONLY_SIGNALS);
  const sourceHits = containsAny(text, SOURCE_WRITE_SIGNALS);
  const workspaceHits = containsAny(text, WORKSPACE_WRITE_SIGNALS);
  const artifactHits = containsAny(text, ARTIFACT_SIGNALS);
  const bashHits = containsAny(text, BASH_SIGNALS);
  const browserHits = containsAny(text, BROWSER_SIGNALS);
  const networkHits = containsAny(text, NETWORK_SIGNALS);
  const freshHits = containsAny(text, FRESH_SIGNALS);
  const gitHits = containsAny(text, GIT_SIGNALS);
  const databaseHits = containsAny(text, DATABASE_SIGNALS);
  const databaseWriteHits = containsAny(text, DATABASE_WRITE_SIGNALS);
  signals.push(...readOnlyHits, ...sourceHits, ...workspaceHits, ...artifactHits, ...bashHits, ...browserHits, ...networkHits, ...freshHits, ...gitHits, ...databaseHits, ...databaseWriteHits);

  const explicitReadOnly = readOnlyHits.length > 0;
  const stageExecution = /(?:开始|进入|执行|继续)\s*stage|(?:start|begin|continue)\s+stage/i.test(raw);
  const sourceWriteRequested = (sourceHits.length > 0 || stageExecution) && !explicitReadOnly;
  const artifactRequested = artifactHits.length > 0 || /(?:^|\s)(?:planning-local|docs|\.ai-bridge)\//i.test(raw);
  const paths = uniq([...(options.explicitScope ?? []), ...extractPaths(raw)]);
  const artifactWritePaths = artifactPaths(raw, paths, artifactRequested);
  const sourceWritePolicy: SourceWritePolicy = sourceWriteRequested
    ? workspaceHits.length ? "workspace" : "scoped"
    : "none";
  const bashRequired = bashHits.length > 0 || sourceWriteRequested;
  const browserRequired = browserHits.length > 0;
  const networkRequired = networkHits.length > 0;
  const freshInformationRequired = freshHits.length > 0;
  const gitRequired = gitHits.length > 0;
  const databaseRead = databaseHits.length > 0;
  const databaseWrite = databaseWriteHits.length > 0;
  const approvalPoints = uniq(APPROVAL_SIGNALS.flatMap(([needles, message]) => containsAny(text, needles).length ? [message] : []));

  const explicitSignalGroups = [readOnlyHits, sourceHits, artifactHits, bashHits, browserHits, networkHits, gitHits, databaseHits].filter((group) => group.length).length;
  const assumptions: string[] = [];
  if (!raw) assumptions.push("No instruction text was supplied; all mutation capabilities are disabled.");
  if (!paths.length) assumptions.push("No explicit file scope was provided; source writes must remain narrowly discovered and reviewed.");
  if (sourceWriteRequested && explicitReadOnly) assumptions.push("Conflicting write and read-only wording was resolved in favor of read-only safety.");
  if (networkRequired && !freshInformationRequired) assumptions.push("Network access is required only for the explicitly requested remote capability.");
  const confidence = Math.max(0.35, Math.min(0.99,
    (explicitReadOnly || sourceWriteRequested || artifactRequested ? 0.68 : 0.5)
    + explicitSignalGroups * 0.04
    + (paths.length ? 0.05 : 0)
    - (sourceWriteRequested && explicitReadOnly ? 0.18 : 0)
  ));

  const effectiveWritePolicy = confidence < 0.6 ? "none" : sourceWritePolicy;
  const constraints = extractConstraints(raw, options);
  if (confidence < 0.6) constraints.push("Low-confidence compilation: remain read-only until scope and write intent are clarified.");
  if (explicitReadOnly) constraints.push("Do not modify source code.");
  if (artifactWritePaths.length && effectiveWritePolicy === "none") constraints.push(`Writes are limited to artifacts matching: ${artifactWritePaths.join(", ")}.`);

  const intent = taskIntent(raw);
  const acceptance = extractAcceptance(raw, options);
  const minimalChangeContract = compileMinimalChangeContract({
    objective: options.minimalChange?.objective ?? intent,
    expected_change_areas: options.minimalChange?.expected_change_areas
      ?? expectedChangeAreas(paths, sourceWriteRequested, artifactRequested, bashRequired, browserRequired),
    likely_paths: options.minimalChange?.likely_paths ?? paths,
    allowed_paths: options.explicitAllowedPaths ?? options.minimalChange?.allowed_paths ?? [],
    forbidden_paths: options.explicitForbiddenPaths ?? options.minimalChange?.forbidden_paths ?? [],
    must_preserve: options.minimalChange?.must_preserve ?? extractMustPreserve(raw),
    required_acceptance: options.minimalChange?.required_acceptance ?? acceptance,
    non_goals: options.minimalChange?.non_goals ?? extractNonGoals(raw),
    uncertainty_notes: options.minimalChange?.uncertainty_notes ?? assumptions
  });

  const capabilities: TaskCapabilityMatrix = {
    read_workspace: true,
    write_source: effectiveWritePolicy !== "none",
    write_artifacts: artifactWritePaths.length > 0,
    run_bash: bashRequired,
    use_browser: browserRequired,
    use_network: networkRequired,
    use_git: gitRequired,
    read_database: databaseRead,
    write_database: databaseWrite
  };
  const plannedActions = [
    ...(databaseWrite ? [{ action: "database_write" as const, target: paths[0] ?? "database", scope: "external" as const }] : []),
    ...(/(?:付款|支付|转账|提交订单|真实订单|payment|transfer money|place order)/i.test(directIntent)
      ? [{ action: "business_critical" as const, target: "business transaction", scope: "business_critical" as const }]
      : []),
    ...(/(?:删除生产数据|drop\s+table|truncate\s+table|覆盖生产备份)/i.test(directIntent)
      ? [{ action: "destructive" as const, target: "production data", scope: "production" as const }]
      : [])
  ];
  const riskDecision = evaluateTaskRiskProfile({
    instruction: directIntent,
    scope_paths: paths,
    source_write: capabilities.write_source,
    artifact_write: capabilities.write_artifacts,
    run_bash: capabilities.run_bash,
    use_browser: capabilities.use_browser,
    use_network: capabilities.use_network,
    use_git: capabilities.use_git,
    write_database: capabilities.write_database,
    workspace_scope: effectiveWritePolicy === "workspace",
    planned_actions: plannedActions,
    explicit_authorization: directAuthorizationEvidence(raw).length > 0,
    authorization_text: directAuthorizationEvidence(raw).join("\n")
  });
  const risk = taskRiskLevelFromUnified(riskDecision);
  if ((risk === "high" || risk === "critical") && !approvalPoints.length) {
    approvalPoints.push("Approve high-risk execution before mutation");
  }
  const authorization = authorizationDecision({
    instruction: raw,
    directIntent,
    paths,
    allowedPaths: options.explicitAllowedPaths ?? minimalChangeContract.allowed_paths,
    forbiddenPaths: options.explicitForbiddenPaths ?? minimalChangeContract.forbidden_paths,
    capabilities,
    artifactPaths: artifactWritePaths,
    acceptance,
    riskDecision
  });

  return {
    version: 1,
    intent,
    deliverables: extractDeliverables(raw, paths, artifactRequested, capabilities.write_source),
    scope: paths,
    constraints: uniq(constraints),
    source_write_policy: effectiveWritePolicy,
    artifact_write_paths: artifactWritePaths,
    bash_required: bashRequired,
    browser_required: browserRequired,
    network_required: networkRequired,
    fresh_information_required: freshInformationRequired,
    risk_level: risk,
    risk_decision: riskDecision,
    approval_points: approvalPoints,
    acceptance,
    assumptions: uniq(assumptions),
    confidence: Number(confidence.toFixed(2)),
    capabilities,
    phases: buildPhases(raw, capabilities.write_source, capabilities.write_artifacts, browserRequired, gitRequired),
    signals: uniq(signals),
    minimal_change_contract: minimalChangeContract,
    authorization_decision: authorization
  };
}

export function compiledTaskFingerprint(task: CompiledTask): Record<string, unknown> {
  return {
    version: task.version,
    intent: task.intent,
    deliverables: task.deliverables,
    scope: task.scope,
    constraints: task.constraints,
    source_write_policy: task.source_write_policy,
    artifact_write_paths: task.artifact_write_paths,
    capabilities: task.capabilities,
    risk_level: task.risk_level,
    risk_decision: task.risk_decision,
    approval_points: task.approval_points,
    acceptance: task.acceptance,
    assumptions: task.assumptions,
    confidence: task.confidence,
    phases: task.phases,
    minimal_change_contract: task.minimal_change_contract,
    authorization_decision: task.authorization_decision
  };
}
