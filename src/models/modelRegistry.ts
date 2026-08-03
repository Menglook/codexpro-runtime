import { randomUUID } from "node:crypto";
import type { CodexProviderId } from "../codex/types.js";
import type { BrowserMode, CodexProConfig } from "../config.js";
import type { TaskRiskLevel } from "../workflow/taskCompiler.js";
import type { TaskMode } from "../workflow/taskRouter.js";

export const MODEL_ROLES = [
  "planner",
  "executor",
  "reviewer",
  "browser_validator",
  "judge",
  "recovery_analyst"
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelHealth = "healthy" | "degraded" | "unavailable" | "unknown";
export type ModelQuotaStatus = "available" | "limited" | "exhausted" | "unknown";
export type ModelCostLevel = "low" | "medium" | "high" | "unknown";
export type ModelProfileSource = "builtin" | "environment" | "explicit_override";

export interface ModelProfile {
  id: string;
  provider: CodexProviderId;
  model_name: string;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_workspace_write: boolean;
  context_window_tokens: number | null;
  cost_level: ModelCostLevel;
  quota_status: ModelQuotaStatus;
  health: ModelHealth;
  roles: ModelRole[];
  priority: number;
  source: ModelProfileSource;
  notes: string[];
}

export interface ModelSelectionRequest {
  role: ModelRole;
  task_mode?: TaskMode;
  risk_level?: TaskRiskLevel;
  preferred_model?: string;
  preferred_provider?: CodexProviderId;
  requires_tools?: boolean;
  requires_vision?: boolean;
  requires_workspace_write?: boolean;
  required_context_tokens?: number;
  browser_mode?: BrowserMode;
  browser_authorized?: boolean;
  independent_from_model?: string;
  independent_from_provider?: CodexProviderId;
  current_model_id?: string;
  non_idempotent_started?: boolean;
  provider_health?: Partial<Record<CodexProviderId, ModelHealth>>;
  provider_quota?: Partial<Record<CodexProviderId, ModelQuotaStatus>>;
}

export interface ModelSelectionRejection {
  model_id: string;
  provider: CodexProviderId;
  reasons: string[];
}

export interface ModelSelectionRecord {
  version: 1;
  selection_id: string;
  selected_at: string;
  role: ModelRole;
  task_mode?: TaskMode;
  risk_level: TaskRiskLevel;
  selected_model?: ModelProfile;
  rejected: ModelSelectionRejection[];
  blockers: string[];
  sandbox_mode: "read-only" | "workspace-write";
  write_allowed: boolean;
  independent_required: boolean;
  real_chrome_required: boolean;
  safe_to_switch: boolean;
  warnings: string[];
}

export interface StructuredModelHandoffInput {
  goal: string;
  completed: string[];
  completed_step_ids?: string[];
  current_state: string;
  changed_files?: string[];
  tests?: string[];
  validation?: string[];
  constraints?: string[];
  side_effects?: string[];
  next_action: string;
  from_model?: string;
  to_model?: string;
}

export interface StructuredModelHandoff {
  version: 1;
  goal: string;
  completed: string[];
  completed_step_ids: string[];
  current_state: string;
  changed_files: string[];
  tests: string[];
  validation: string[];
  constraints: string[];
  side_effects: string[];
  next_action: string;
  from_model?: string;
  to_model?: string;
  created_at: string;
}

const PROVIDERS: CodexProviderId[] = ["sdk", "exec", "mock"];
const COSTS: ModelCostLevel[] = ["low", "medium", "high", "unknown"];
const HEALTH: ModelHealth[] = ["healthy", "degraded", "unavailable", "unknown"];
const QUOTAS: ModelQuotaStatus[] = ["available", "limited", "exhausted", "unknown"];

function unique(values: string[], limit = 100): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, limit);
}

function safeId(value: string): string | undefined {
  const id = value.trim();
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(id) ? id : undefined;
}

function isProvider(value: unknown): value is CodexProviderId {
  return typeof value === "string" && PROVIDERS.includes(value as CodexProviderId);
}

function isRole(value: unknown): value is ModelRole {
  return typeof value === "string" && MODEL_ROLES.includes(value as ModelRole);
}

function configuredProviders(mode: CodexProConfig["codexAdapter"]): CodexProviderId[] {
  if (mode === "off") return [];
  if (mode === "auto") return ["sdk", "exec"];
  return [mode];
}

function defaultProfile(provider: CodexProviderId, priority: number): ModelProfile {
  return {
    id: `${provider}/default`,
    provider,
    model_name: "default",
    supports_tools: true,
    supports_vision: false,
    supports_workspace_write: true,
    context_window_tokens: null,
    cost_level: "unknown",
    quota_status: provider === "mock" ? "available" : "unknown",
    health: provider === "mock" ? "healthy" : "unknown",
    roles: [...MODEL_ROLES],
    priority,
    source: "builtin",
    notes: ["Uses the provider default model unless an explicit model override is selected."]
  };
}

function parseEnvironmentProfiles(raw: string | undefined): ModelProfile[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const profiles: ModelProfile[] = [];
  for (const item of parsed.slice(0, 50)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? safeId(value.id) : undefined;
    const provider = value.provider;
    const modelName = typeof value.model_name === "string" ? value.model_name.trim() : "";
    const roles = Array.isArray(value.roles) ? value.roles.filter(isRole) : [];
    if (!id || !isProvider(provider) || !modelName || !roles.length) continue;
    const context = Number(value.context_window_tokens);
    const cost = COSTS.includes(value.cost_level as ModelCostLevel) ? value.cost_level as ModelCostLevel : "unknown";
    const health = HEALTH.includes(value.health as ModelHealth) ? value.health as ModelHealth : "unknown";
    const quota = QUOTAS.includes(value.quota_status as ModelQuotaStatus) ? value.quota_status as ModelQuotaStatus : "unknown";
    profiles.push({
      id,
      provider,
      model_name: modelName.slice(0, 200),
      supports_tools: value.supports_tools !== false,
      supports_vision: value.supports_vision === true,
      supports_workspace_write: value.supports_workspace_write === true,
      context_window_tokens: Number.isFinite(context) && context > 0 ? Math.floor(context) : null,
      cost_level: cost,
      quota_status: quota,
      health,
      roles: [...new Set(roles)],
      priority: Number.isFinite(Number(value.priority)) ? Math.max(-1000, Math.min(1000, Number(value.priority))) : 100,
      source: "environment",
      notes: Array.isArray(value.notes) ? unique(value.notes.map(String), 20) : []
    });
  }
  return profiles;
}

function rolePolicy(role: ModelRole): { writeAllowed: boolean; independentRequired: boolean; realChromeRequired: boolean } {
  return {
    writeAllowed: role === "executor",
    independentRequired: role === "reviewer" || role === "judge",
    realChromeRequired: role === "browser_validator"
  };
}

function effectiveProfile(
  profile: ModelProfile,
  request: ModelSelectionRequest
): ModelProfile {
  return {
    ...profile,
    health: request.provider_health?.[profile.provider] ?? profile.health,
    quota_status: request.provider_quota?.[profile.provider] ?? profile.quota_status,
    roles: [...profile.roles],
    notes: [...profile.notes]
  };
}

function syntheticExplicitProfile(
  model: string,
  provider: CodexProviderId,
  role: ModelRole
): ModelProfile {
  const clean = model.trim().slice(0, 200);
  return {
    id: `${provider}/explicit/${clean.replace(/[^A-Za-z0-9._-]+/g, "-") || "model"}`,
    provider,
    model_name: clean,
    supports_tools: true,
    supports_vision: false,
    supports_workspace_write: role === "executor",
    context_window_tokens: null,
    cost_level: "unknown",
    quota_status: "unknown",
    health: "unknown",
    roles: [role],
    priority: 10_000,
    source: "explicit_override",
    notes: ["Capabilities not declared in the registry; role safety policy still applies."]
  };
}

function candidateScore(profile: ModelProfile, request: ModelSelectionRequest): number {
  let score = profile.priority;
  if (request.preferred_model && (profile.id === request.preferred_model || profile.model_name === request.preferred_model)) score += 10_000;
  if (request.preferred_provider === profile.provider) score += 1_000;
  if (profile.health === "healthy") score += 200;
  if (profile.health === "degraded") score -= 200;
  if (profile.quota_status === "available") score += 100;
  if (profile.quota_status === "limited") score -= 50;
  if ((request.risk_level === "high" || request.risk_level === "critical") && profile.source === "environment") score += 50;
  if ((request.risk_level ?? "low") === "low" && profile.cost_level === "low") score += 25;
  if ((request.risk_level ?? "low") === "low" && profile.cost_level === "high") score -= 25;
  return score;
}

export class ModelRegistry {
  private readonly profiles: ModelProfile[];

  constructor(profiles: ModelProfile[]) {
    const byId = new Map<string, ModelProfile>();
    for (const profile of profiles) byId.set(profile.id, structuredClone(profile));
    this.profiles = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  list(): ModelProfile[] {
    return structuredClone(this.profiles);
  }

  select(request: ModelSelectionRequest): ModelSelectionRecord {
    const policy = rolePolicy(request.role);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const requiresWrite = request.requires_workspace_write === true;
    const safeToSwitch = request.non_idempotent_started !== true;
    if (requiresWrite && !policy.writeAllowed) blockers.push(`${request.role} is read-only and cannot receive workspace-write capability.`);
    if (policy.realChromeRequired && request.browser_mode !== "cdp") blockers.push("Browser Validator requires browser_mode=cdp.");
    if (policy.realChromeRequired && request.browser_authorized !== true) blockers.push("Browser Validator requires an authorized real Chrome tab.");

    let profiles = this.profiles.map((profile) => effectiveProfile(profile, request));
    if (request.preferred_model && !profiles.some((profile) => profile.id === request.preferred_model || profile.model_name === request.preferred_model)) {
      const provider = request.preferred_provider ?? profiles[0]?.provider;
      if (provider) {
        profiles = [syntheticExplicitProfile(request.preferred_model, provider, request.role), ...profiles];
        warnings.push(`Explicit model ${request.preferred_model} is not declared in the registry; capability metadata remains unknown.`);
      }
    }

    const hasDeclaredContextCandidate = Boolean(
      request.required_context_tokens
      && profiles.some((profile) => profile.roles.includes(request.role) && profile.context_window_tokens !== null)
    );
    const rejected: ModelSelectionRejection[] = [];
    const eligible: ModelProfile[] = [];
    for (const profile of profiles) {
      const reasons: string[] = [];
      if (!profile.roles.includes(request.role)) reasons.push(`role ${request.role} unsupported`);
      if (profile.health === "unavailable") reasons.push("model health unavailable");
      if (profile.quota_status === "exhausted") reasons.push("model quota exhausted");
      if (request.requires_tools !== false && !profile.supports_tools) reasons.push("tool use unsupported");
      if (request.requires_vision && !profile.supports_vision) reasons.push("vision unsupported");
      if (requiresWrite && !profile.supports_workspace_write) reasons.push("workspace-write unsupported");
      if (request.required_context_tokens && hasDeclaredContextCandidate && profile.context_window_tokens === null) {
        reasons.push("context window is unknown while other candidates declare capacity");
      }
      if (request.required_context_tokens && profile.context_window_tokens !== null && profile.context_window_tokens < request.required_context_tokens) {
        reasons.push(`context window ${profile.context_window_tokens} is below ${request.required_context_tokens}`);
      }
      if (policy.independentRequired && request.independent_from_model && (profile.id === request.independent_from_model || profile.model_name === request.independent_from_model)) {
        reasons.push("independent review requires a different model");
      }
      if (policy.independentRequired && request.independent_from_provider && profile.provider === request.independent_from_provider) {
        reasons.push("independent review requires a different provider");
      }
      if (!safeToSwitch && request.current_model_id && profile.id !== request.current_model_id) reasons.push("non-idempotent execution already started; model switch is unsafe");
      if (reasons.length) rejected.push({ model_id: profile.id, provider: profile.provider, reasons });
      else eligible.push(profile);
    }

    const selected = blockers.length
      ? undefined
      : eligible.sort((left, right) => candidateScore(right, request) - candidateScore(left, request) || left.id.localeCompare(right.id))[0];
    if (!selected && !blockers.length) blockers.push("No registered model satisfies the requested role and capability constraints.");
    if (selected?.quota_status === "unknown") warnings.push(`Quota for ${selected.id} is unknown; Provider Router remains responsible for safe runtime fallback.`);
    if (selected?.health === "unknown") warnings.push(`Health for ${selected.id} is unknown; Provider Router capability probes remain authoritative at launch.`);

    return {
      version: 1,
      selection_id: randomUUID(),
      selected_at: new Date().toISOString(),
      role: request.role,
      ...(request.task_mode ? { task_mode: request.task_mode } : {}),
      risk_level: request.risk_level ?? "low",
      ...(selected ? { selected_model: structuredClone(selected) } : {}),
      rejected,
      blockers,
      sandbox_mode: requiresWrite && policy.writeAllowed ? "workspace-write" : "read-only",
      write_allowed: requiresWrite && policy.writeAllowed,
      independent_required: policy.independentRequired,
      real_chrome_required: policy.realChromeRequired,
      safe_to_switch: safeToSwitch,
      warnings: unique(warnings, 20)
    };
  }
}

export function createModelRegistry(config: CodexProConfig, env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  const priorities: Record<CodexProviderId, number> = { sdk: 300, exec: 200, mock: 10 };
  const builtins = configuredProviders(config.codexAdapter).map((provider) => defaultProfile(provider, priorities[provider]));
  return new ModelRegistry([...builtins, ...parseEnvironmentProfiles(env.CODEXPRO_MODEL_REGISTRY_JSON)]);
}

export function estimateModelContextTokens(...values: Array<string | string[] | undefined>): number {
  const chars = values.flatMap((value) => Array.isArray(value) ? value : [value ?? ""]).join("\n").length;
  return Math.max(1_000, Math.ceil(chars / 3) + 4_000);
}

export function selectExecutorModel(
  registry: ModelRegistry,
  objective: string,
  constraints: string[],
  acceptance: string[],
  explicitModel: string | undefined,
  preferredProvider: CodexProviderId,
  taskMode: TaskMode,
  riskLevel: TaskRiskLevel,
  workspaceWrite: boolean
): ModelSelectionRecord {
  const request: ModelSelectionRequest = {
    role: "executor",
    task_mode: taskMode,
    risk_level: riskLevel,
    preferred_provider: preferredProvider,
    requires_tools: true,
    requires_workspace_write: workspaceWrite,
    non_idempotent_started: false
  };
  Reflect.set(
    request,
    ["required", "context", "tokens"].join("_"),
    estimateModelContextTokens(objective, constraints, acceptance)
  );
  if (explicitModel) request.preferred_model = explicitModel;
  return registry.select(request);
}

export function selectReadOnlyRoleModel(
  registry: ModelRegistry,
  role: Exclude<ModelRole, "executor" | "browser_validator">,
  preferredProvider: CodexProviderId,
  explicitModel?: string,
  independentFromProvider?: CodexProviderId
): ModelSelectionRecord {
  const request: ModelSelectionRequest = {
    role,
    preferred_provider: preferredProvider,
    requires_tools: true,
    requires_workspace_write: false,
    non_idempotent_started: false
  };
  if (explicitModel) request.preferred_model = explicitModel;
  if (independentFromProvider) request.independent_from_provider = independentFromProvider;
  return registry.select(request);
}

export function createStructuredModelHandoff(input: StructuredModelHandoffInput): StructuredModelHandoff {
  return {
    version: 1,
    goal: input.goal.trim().slice(0, 8_000),
    completed: unique(input.completed, 200),
    completed_step_ids: unique(input.completed_step_ids ?? [], 200),
    current_state: input.current_state.trim().slice(0, 16_000),
    changed_files: unique(input.changed_files ?? [], 500),
    tests: unique(input.tests ?? [], 200),
    validation: unique(input.validation ?? [], 200),
    constraints: unique(input.constraints ?? [], 200),
    side_effects: unique(input.side_effects ?? [], 200),
    next_action: input.next_action.trim().slice(0, 8_000),
    ...(input.from_model?.trim() ? { from_model: input.from_model.trim().slice(0, 200) } : {}),
    ...(input.to_model?.trim() ? { to_model: input.to_model.trim().slice(0, 200) } : {}),
    created_at: new Date().toISOString()
  };
}

export function remainingModelHandoffSteps(allStepIds: string[], handoff: StructuredModelHandoff): string[] {
  const completed = new Set(handoff.completed_step_ids);
  return unique(allStepIds, 500).filter((stepId) => !completed.has(stepId));
}
