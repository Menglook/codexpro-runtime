import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createCodexAdapter } from "../codex/adapterFactory.js";
import type { CodexProConfig } from "../config.js";
import { PathGuard } from "../guard.js";
import { getGoalManager } from "../goals/goalManagerFactory.js";
import { GoalStore } from "../goals/goalStore.js";
import { GoalStoreError, isGoalTerminal, type GoalRecord, type GoalStartInput } from "../goals/types.js";
import { ResourceGovernor, type ResourceProjection } from "../resources/resourceGovernor.js";
import { evaluateTaskRiskProfile, type TaskRiskPlannedAction, type UnifiedRiskDecision } from "../security/riskGate.js";
import {
  discoverDashboardProjects,
  matchesProjectFilter,
  workspaceForDashboardProject,
  type DashboardProjectSummary
} from "./projectAggregationService.js";

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const PROTECTED_TASK_IDENTITIES = ".codexpro/task-identities";

const PrioritySchema = z.enum(["urgent", "normal", "background"]).default("normal");
const ExecutionProfileSchema = z.enum(["read_only", "lightweight", "standard", "heavy", "fast", "deep"]).default("standard");
const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]).optional();

const RelativePathSchema = z.string().min(1).max(4096).transform((value, ctx) => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path cannot be empty" });
    return z.NEVER;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "path must stay inside the selected workspace" });
    return z.NEVER;
  }
  if (normalized === PROTECTED_TASK_IDENTITIES || normalized.startsWith(`${PROTECTED_TASK_IDENTITIES}/`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: ".codexpro/task-identities is a protected runtime directory" });
    return z.NEVER;
  }
  return normalized;
});

const ScopePathSchema = z.string().min(1).max(4096).transform((value, ctx) => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope path cannot be empty" });
    return z.NEVER;
  }
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope path must stay inside the selected workspace" });
    return z.NEVER;
  }
  if (normalized === PROTECTED_TASK_IDENTITIES || normalized.startsWith(`${PROTECTED_TASK_IDENTITIES}/`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: ".codexpro/task-identities is outside the CC5 task scope" });
    return z.NEVER;
  }
  return normalized;
});

const ScopeListSchema = z.array(ScopePathSchema).max(80).default([]);
const AcceptanceSchema = z.array(z.string().trim().min(1).max(1_000)).max(80).default([]);
const OptionalIdempotencySchema = z.string().trim().regex(SAFE_IDEMPOTENCY_KEY).optional();

const ExistingPlanRequestSchema = z.object({
  mode: z.literal("existing_plan"),
  project: z.string().trim().min(1).max(200),
  plan_file: RelativePathSchema,
  stage: z.string().trim().min(1).max(240),
  scope_limit: z.union([z.string().trim().min(1).max(2_000), ScopeListSchema]).optional(),
  record_after_acceptance: z.boolean().default(false),
  remote_sync_after_record: z.boolean().default(false),
  browser_required: z.boolean().default(false),
  priority: PrioritySchema,
  new_run: z.boolean().default(false),
  idempotency_key: OptionalIdempotencySchema
}).strict();

const FixedTaskRequestSchema = z.object({
  mode: z.literal("fixed_task"),
  project: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(8_000),
  include: ScopeListSchema,
  exclude: ScopeListSchema,
  acceptance: AcceptanceSchema,
  risk_level: RiskLevelSchema,
  execution_profile: ExecutionProfileSchema,
  local_record_permission: z.boolean().default(false),
  remote_sync_permission: z.boolean().default(false),
  production_change_permission: z.boolean().default(false),
  browser_verification: z.boolean().default(false),
  priority: PrioritySchema,
  new_run: z.boolean().default(false),
  idempotency_key: OptionalIdempotencySchema
}).strict();

const StructuredTaskRequestSchema = z.discriminatedUnion("mode", [
  ExistingPlanRequestSchema,
  FixedTaskRequestSchema
]);

type StructuredTaskRequest = z.infer<typeof StructuredTaskRequestSchema>;
type ExistingPlanRequest = z.infer<typeof ExistingPlanRequestSchema>;

export interface StructuredTaskHttpResult {
  status: number;
  body: Record<string, unknown>;
}

interface StructuredPermissions {
  source_edit: boolean;
  migration: boolean;
  local_record: boolean;
  remote_sync: boolean;
  production_change: boolean;
}

interface CompiledStructuredTask {
  request: StructuredTaskRequest;
  project: DashboardProjectSummary;
  objective: string;
  normalized_objective: string;
  plan_file: string | null;
  stage: string | null;
  include: string[];
  exclude: string[];
  acceptance: string[];
  permissions: StructuredPermissions;
  execution_profile: string;
  priority: "urgent" | "normal" | "background";
  browser_verification: boolean;
  resource_request: {
    resource_class: "lightweight" | "standard" | "heavy";
    priority: "urgent" | "normal" | "background";
    execution_mode: "read" | "write";
    pools: string[];
  };
  completion: {
    diff_required: boolean;
    acceptance_report_required: boolean;
    notify_on: string[];
  };
}

export class StructuredTaskError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly issues?: unknown) {
    super(message);
    this.name = "StructuredTaskError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizedObjective(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function taskIdForGoal(goalId: string): string {
  return `goal-${goalId}`;
}

function normalizeScopeItem(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) throw new StructuredTaskError(400, "invalid_scope_limit", "Scope limit contains an empty item.");
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    throw new StructuredTaskError(400, "invalid_scope_limit", "Scope limit must stay inside the selected workspace.");
  }
  if (normalized === PROTECTED_TASK_IDENTITIES || normalized.startsWith(`${PROTECTED_TASK_IDENTITIES}/`)) {
    throw new StructuredTaskError(400, "protected_scope_limit", ".codexpro/task-identities is outside the CC5 task scope.");
  }
  return normalized;
}

function scopeLimitList(value: ExistingPlanRequest["scope_limit"]): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  const items = value
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeScopeItem(item));
  if (items.length > 80) {
    throw new StructuredTaskError(400, "too_many_scope_limits", "scope_limit may contain at most 80 paths.");
  }
  return items;
}

function ensurePlanFile(project: DashboardProjectSummary, relPath: string): void {
  const abs = path.resolve(project.root, relPath);
  const root = path.resolve(project.root);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new StructuredTaskError(400, "plan_path_escapes_workspace", "Plan file must stay inside the selected project.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new StructuredTaskError(404, "plan_file_not_found", "Plan file was not found in the selected project.");
  }
  if (!stat.isFile()) throw new StructuredTaskError(400, "plan_file_not_file", "Plan file must be a regular file.");
  if (stat.size > 2 * 1024 * 1024) throw new StructuredTaskError(413, "plan_file_too_large", "Plan file is too large for direct structured task creation.");
}

function permissionGate(compiled: CompiledStructuredTask): void {
  if (compiled.permissions.remote_sync && !compiled.permissions.local_record) {
    throw new StructuredTaskError(400, "remote_sync_requires_local_record", "Remote sync permission requires local record permission first.");
  }
  if (compiled.permissions.production_change) {
    throw new StructuredTaskError(403, "production_change_not_supported", "Direct structured tasks do not grant production change permission.");
  }
}

function riskPlannedActions(compiled: CompiledStructuredTask): TaskRiskPlannedAction[] {
  const actions: TaskRiskPlannedAction[] = [];
  if (compiled.permissions.source_edit) actions.push({ action: "local_write", target: compiled.project.root, scope: "workspace" });
  if (compiled.acceptance.length) actions.push({ action: "command_execution", target: "acceptance", scope: "workspace" });
  if (compiled.browser_verification) actions.push({ action: "browser_action", target: "browser_verification", scope: "workspace" });
  if (compiled.permissions.remote_sync) actions.push({ action: "git_remote_update", target: "remote", scope: "external" });
  if (compiled.permissions.production_change) actions.push({ action: "deployment", target: "production", scope: "production" });
  return actions;
}

function riskGate(compiled: CompiledStructuredTask): UnifiedRiskDecision {
  const risk = evaluateTaskRiskProfile({
    instruction: compiled.objective,
    scope_paths: compiled.include,
    source_write: compiled.permissions.source_edit,
    artifact_write: compiled.include.some((item) => /^(?:planning-local|docs|\.ai-bridge|reports?)(?:\/|$)|\.(?:md|json|ya?ml|txt)$/i.test(item)),
    run_bash: compiled.acceptance.length > 0 || compiled.permissions.source_edit,
    use_browser: compiled.browser_verification,
    use_network: false,
    use_git: compiled.permissions.local_record || compiled.permissions.remote_sync,
    write_database: compiled.permissions.migration,
    workspace_scope: compiled.include.length === 0 && compiled.permissions.source_edit,
    planned_actions: riskPlannedActions(compiled),
    explicit_authorization: compiled.permissions.remote_sync,
    authorization_text: compiled.permissions.remote_sync ? "Explicit remote sync permission was provided for this structured task." : undefined
  });
  if (!risk.allowed) throw new StructuredTaskError(403, "risk_gate_denied", risk.reason);
  return risk;
}

function resourceRequestFor(compiled: {
  permissions: StructuredPermissions;
  execution_profile: string;
  priority: "urgent" | "normal" | "background";
  browser_verification: boolean;
}): CompiledStructuredTask["resource_request"] {
  const resourceClass = compiled.browser_verification || compiled.execution_profile === "heavy" || compiled.execution_profile === "deep"
    ? "heavy"
    : compiled.permissions.source_edit
      ? "standard"
      : "lightweight";
  return {
    resource_class: resourceClass,
    priority: compiled.priority,
    execution_mode: compiled.permissions.source_edit ? "write" : "read",
    pools: compiled.browser_verification ? ["browser_live_verification"] : []
  };
}

function compileRequest(project: DashboardProjectSummary, request: StructuredTaskRequest): CompiledStructuredTask {
  if (request.mode === "existing_plan") {
    ensurePlanFile(project, request.plan_file);
    const include = uniq(scopeLimitList(request.scope_limit));
    const objective = [
      `执行既有计划 ${request.plan_file} 中的 ${request.stage} 阶段。`,
      include.length ? `范围限制：${include.join("、")}。` : "",
      request.browser_required ? "需要浏览器验证。" : "",
      "不要自动提交、推送或执行生产变更。"
    ].filter(Boolean).join("\n");
    const acceptance = [
      `完成 ${request.stage} 阶段的定向验收。`,
      "生成或更新对应验收证据，并报告未验证项。"
    ];
    const compiled: CompiledStructuredTask = {
      request,
      project,
      objective,
      normalized_objective: normalizedObjective(objective),
      plan_file: request.plan_file,
      stage: request.stage,
      include,
      exclude: [PROTECTED_TASK_IDENTITIES, `${PROTECTED_TASK_IDENTITIES}/**`],
      acceptance,
      permissions: {
        source_edit: true,
        migration: false,
        local_record: request.record_after_acceptance,
        remote_sync: request.remote_sync_after_record,
        production_change: false
      },
      execution_profile: "standard",
      priority: request.priority,
      browser_verification: request.browser_required,
      resource_request: {
        resource_class: request.browser_required ? "heavy" : "standard",
        priority: request.priority,
        execution_mode: "write",
        pools: request.browser_required ? ["browser_live_verification"] : []
      },
      completion: {
        diff_required: true,
        acceptance_report_required: true,
        notify_on: ["task_completed", "task_failed", "resource_blocked"]
      }
    };
    return compiled;
  }

  const sourceEdit = request.execution_profile !== "read_only";
  const compiled: CompiledStructuredTask = {
    request,
    project,
    objective: request.objective,
    normalized_objective: normalizedObjective(request.objective),
    plan_file: null,
    stage: null,
    include: request.include,
    exclude: uniq([...request.exclude, PROTECTED_TASK_IDENTITIES, `${PROTECTED_TASK_IDENTITIES}/**`]),
    acceptance: request.acceptance,
    permissions: {
      source_edit: sourceEdit,
      migration: false,
      local_record: request.local_record_permission,
      remote_sync: request.remote_sync_permission,
      production_change: request.production_change_permission
    },
    execution_profile: request.execution_profile,
    priority: request.priority,
    browser_verification: request.browser_verification,
    resource_request: {
      resource_class: "standard",
      priority: request.priority,
      execution_mode: sourceEdit ? "write" : "read",
      pools: request.browser_verification ? ["browser_live_verification"] : []
    },
    completion: {
      diff_required: sourceEdit,
      acceptance_report_required: request.acceptance.length > 0,
      notify_on: ["task_completed", "task_failed", "resource_blocked"]
    }
  };
  compiled.resource_request = resourceRequestFor(compiled);
  return compiled;
}

function dedupeMaterial(compiled: CompiledStructuredTask): Record<string, unknown> {
  return {
    project: compiled.project.project_id,
    plan: compiled.plan_file,
    stage: compiled.stage,
    normalized_objective: compiled.normalized_objective,
    active_status: "active"
  };
}

function statusForResponse(goal: GoalRecord): string {
  return goal.status;
}

function activeStructuredDuplicate(goals: GoalRecord[], dedupeKey: string): GoalRecord | undefined {
  return goals.find((goal) => {
    const checkpoint = goal.checkpoint?.structured_task;
    return checkpoint && typeof checkpoint === "object"
      && (
        (checkpoint as Record<string, unknown>).dedupe_key === dedupeKey
        || (checkpoint as Record<string, unknown>).duplicate_key === dedupeKey
      )
      && !isGoalTerminal(goal.status);
  });
}

function taskDashboardHref(projectId: string, taskId?: string): string {
  const params = new URLSearchParams();
  params.set("project", projectId);
  if (taskId) params.set("task", taskId);
  return `/?${params.toString()}#dashboard`;
}

export class StructuredTaskService {
  constructor(private readonly config: CodexProConfig) {}

  private resolveProject(projectSelector: string): DashboardProjectSummary {
    const project = discoverDashboardProjects(this.config)
      .find((candidate) => candidate.available && matchesProjectFilter(candidate, projectSelector));
    if (!project) throw new StructuredTaskError(404, "project_not_found", "Structured task project is not available.");
    return project;
  }

  async create(rawBody: unknown): Promise<StructuredTaskHttpResult> {
    const parsed = StructuredTaskRequestSchema.safeParse(rawBody ?? {});
    if (!parsed.success) {
      throw new StructuredTaskError(400, "invalid_structured_task", "Structured task request is invalid.", parsed.error.flatten());
    }

    const project = this.resolveProject(parsed.data.project);
    const workspace = workspaceForDashboardProject(project);
    const guard = new PathGuard(this.config);
    const compiled = compileRequest(project, parsed.data);
    permissionGate(compiled);
    const risk = riskGate(compiled);
    const newRun = parsed.data.new_run === true;
    if (newRun && !parsed.data.idempotency_key) {
      throw new StructuredTaskError(400, "new_run_idempotency_required", "new_run=true requires an explicit idempotency_key.");
    }

    const dedupeKey = `sha256:${sha256(stableStringify(dedupeMaterial(compiled)))}`;
    const goalStore = new GoalStore(this.config, guard, workspace);
    const existingDuplicate = activeStructuredDuplicate(await goalStore.listGoals(), dedupeKey);
    if (existingDuplicate && !newRun) {
      const duplicateTaskId = taskIdForGoal(existingDuplicate.goal_id);
      return {
        status: 200,
        body: {
          ok: true,
          created: false,
          duplicate: true,
          requires_new_run: true,
          message: "检测到同一项目、计划、阶段和目标的活跃任务；未创建新任务。明确 new_run=true 后才会再建。",
          project_id: project.project_id,
          workspace_id: workspace.id,
          task_id: duplicateTaskId,
          goal_id: existingDuplicate.goal_id,
          status: statusForResponse(existingDuplicate),
          duplicate_key: dedupeKey,
          dedupe_key: dedupeKey,
          dedupe_material: dedupeMaterial(compiled),
          task_dashboard_url: taskDashboardHref(project.project_id, duplicateTaskId),
          risk_gate: risk,
          permissions: compiled.permissions,
          execution: {
            profile: compiled.execution_profile,
            priority: compiled.priority,
            browser_verification: compiled.browser_verification
          },
          resource_request: compiled.resource_request,
          resource_policy: await new ResourceGovernor(this.config).projectionFor(duplicateTaskId) ?? null
        }
      };
    }

    const adapter = createCodexAdapter(this.config);
    if (!adapter) {
      throw new StructuredTaskError(409, "goal_adapter_unavailable", "Structured task creation requires a configured Codex provider adapter.");
    }
    const runKey = newRun ? parsed.data.idempotency_key! : "primary";
    const goalId = `direct-${sha256(stableStringify({ dedupe_key: dedupeKey, run: runKey })).slice(0, 48)}`;
    const taskId = taskIdForGoal(goalId);
    const idempotencyKey = parsed.data.idempotency_key ?? `structured:${sha256(stableStringify({ dedupe_key: dedupeKey, run: "primary" }))}`;

    const goalInput: GoalStartInput = {
      goal_id: goalId,
      objective: compiled.objective,
      constraints: [
        "Use the existing Goal Manager, risk gate, permission gate, resource governance and persistent execution chain.",
        "Do not create a second task state machine or Task Store.",
        "Do not read, modify, stage or commit .codexpro/task-identities/**.",
        "Do not automatically commit, push, deploy or perform production changes.",
        compiled.permissions.source_edit
          ? `Source edits are explicitly limited to the structured scope: ${compiled.include.length ? compiled.include.join(", ") : "the selected workspace under the Goal Contract"}.`
          : "This structured task is read-only and must not modify source files.",
        compiled.browser_verification ? "Browser verification is required by the structured task execution configuration." : "Browser verification is not required by this structured task.",
        `Resource request expectation: ${compiled.resource_request.resource_class}/${compiled.resource_request.execution_mode}/${compiled.priority}.`,
        ...compiled.exclude.map((item) => `Excluded scope: ${item}`)
      ],
      acceptance: compiled.acceptance,
      idempotency_key: idempotencyKey,
      sandbox_mode: compiled.permissions.source_edit ? "workspace-write" : "read-only",
      approval_policy: "never",
      network_access_enabled: false,
      goal_contract: {
        task_id: taskId,
        project_id: project.project_id,
        workspace_id: workspace.id,
        scope: {
          include: compiled.include,
          exclude: compiled.exclude
        },
        permissions: compiled.permissions,
        execution: {
          profile: compiled.execution_profile,
          priority: compiled.priority,
          browser_verification: compiled.browser_verification,
          retry_policy: "bounded"
        },
        completion: compiled.completion,
        plan_path: compiled.plan_file,
        allowed_paths: compiled.include,
        forbidden_paths: compiled.exclude,
        required_acceptance: compiled.acceptance,
        tool_permissions: {
          read_workspace: true,
          write_source: compiled.permissions.source_edit,
          write_artifacts: false,
          run_bash: compiled.acceptance.length > 0 || compiled.permissions.source_edit,
          use_browser: compiled.browser_verification,
          use_network: false
        },
        side_effect_permissions: {
          local_write: compiled.permissions.source_edit,
          external_write: compiled.permissions.remote_sync,
          network: false
        },
        commit_policy: compiled.permissions.local_record ? "manual" : "forbidden",
        push_policy: compiled.permissions.remote_sync ? "manual" : "forbidden",
        deploy_policy: "forbidden",
        database_policy: "forbidden",
        deliverables: [
          "Structured task execution result",
          ...(compiled.completion.acceptance_report_required ? ["Acceptance evidence"] : []),
          ...(compiled.permissions.source_edit ? ["Scoped diff"] : [])
        ],
        stop_conditions: [
          "Stop if requested scope or permissions need to expand.",
          "Stop before local record, remote sync or production change unless explicitly re-approved by the corresponding existing gate."
        ]
      },
      initial_checkpoint: {
        structured_task: {
          schema_version: 1,
          entry_mode: compiled.request.mode,
          duplicate_key: dedupeKey,
          dedupe_key: dedupeKey,
          dedupe_material: dedupeMaterial(compiled),
          requested_new_run: newRun,
          risk_level_requested: compiled.request.mode === "fixed_task" ? compiled.request.risk_level ?? null : null,
          risk_gate: {
            allowed: risk.allowed,
            level: risk.level,
            reason_code: risk.reason_code,
            reason: risk.reason
          },
          permissions: compiled.permissions,
          execution: {
            profile: compiled.execution_profile,
            priority: compiled.priority,
            browser_verification: compiled.browser_verification
          },
          resource_request: compiled.resource_request
        }
      }
    };

    let goal: GoalRecord;
    try {
      goal = await getGoalManager(this.config, guard, workspace, adapter).start(goalInput);
    } catch (error) {
      if (error instanceof GoalStoreError && error.code === "idempotency_conflict") {
        throw new StructuredTaskError(409, "structured_task_idempotency_conflict", error.message);
      }
      throw error;
    }
    const resourcePolicy: ResourceProjection | null = await new ResourceGovernor(this.config).projectionFor(taskId) ?? null;
    return {
      status: 201,
      body: {
        ok: true,
        created: true,
        duplicate: false,
        requires_new_run: false,
        project_id: project.project_id,
        workspace_id: workspace.id,
        task_id: taskId,
        goal_id: goal.goal_id,
        status: statusForResponse(goal),
        duplicate_key: dedupeKey,
        dedupe_key: dedupeKey,
        dedupe_material: dedupeMaterial(compiled),
        new_run: newRun,
        task_dashboard_url: taskDashboardHref(project.project_id, taskId),
        risk_gate: risk,
        permissions: compiled.permissions,
        execution: {
          profile: compiled.execution_profile,
          priority: compiled.priority,
          browser_verification: compiled.browser_verification
        },
        resource_request: compiled.resource_request,
        resource_policy: resourcePolicy,
        goal_contract: {
          schema_version: goal.goal_contract.schema_version,
          task_id: goal.goal_contract.task_id,
          project_id: goal.goal_contract.project_id,
          workspace_id: goal.goal_contract.workspace_id,
          objective: goal.goal_contract.objective,
          plan_path: goal.goal_contract.plan_path,
          scope: goal.goal_contract.scope,
          acceptance: goal.goal_contract.required_acceptance,
          permissions: goal.goal_contract.permissions,
          execution: goal.goal_contract.execution,
          completion: goal.goal_contract.completion,
          tool_permissions: goal.goal_contract.tool_permissions,
          side_effect_permissions: goal.goal_contract.side_effect_permissions,
          commit_policy: goal.goal_contract.commit_policy,
          push_policy: goal.goal_contract.push_policy,
          deploy_policy: goal.goal_contract.deploy_policy,
          database_policy: goal.goal_contract.database_policy
        }
      }
    };
  }
}
