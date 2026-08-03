import { createHash } from "node:crypto";
import { MCP_PROFILE_V1, MCP_PROFILE_V1_PROTOCOL_VERSION } from "../mcp/profiles/v1.js";
import { MCP_PROFILE_V2, MCP_PROFILE_V2_PROTOCOL_VERSION } from "../mcp/profiles/v2.js";
import type {
  GoalExecutionLaneProfile,
  GoalExecutionOptions,
  GoalExecutionPermissionPolicy,
  GoalExecutionProfileReason,
  GoalExecutionProfileSnapshot,
  GoalExecutionProfileUpgrade,
  GoalModelResolution
} from "../goals/types.js";
import type { ToolMode } from "../config.js";
import type { CodexAdapterMode, CodexApprovalPolicy, CodexProviderId, CodexReasoningEffort, CodexSandboxMode } from "../codex/types.js";
import type { GoalContractV1 } from "../goals/goalContract.js";
import type { ContextProfile } from "./contextProfiles.js";
import type { ExecutionLaneDecision } from "./executionLane.js";
import type { ToolPolicy } from "./taskRouter.js";

export const EXECUTION_PROFILE_POLICY_VERSION = "goal-execution-policy-v1";
export const EXECUTION_PROFILE_ADAPTER_CONTRACT_VERSION = "codex-adapter-contract-v1";

export function defaultExecutionMcpProfile(toolMode: ToolMode): GoalExecutionProfileSnapshot["mcp_profile"] {
  return {
    profile: MCP_PROFILE_V1,
    protocol_version: MCP_PROFILE_V1_PROTOCOL_VERSION,
    tool_mode: toolMode
  };
}

export function executionMcpProfileFromAdapter(
  adapter: { profile: "v1" | "v2"; supportedProtocolVersions: readonly string[] },
  toolMode: ToolMode
): GoalExecutionProfileSnapshot["mcp_profile"] {
  const expectedProtocolVersion = adapter.profile === MCP_PROFILE_V2
    ? MCP_PROFILE_V2_PROTOCOL_VERSION
    : MCP_PROFILE_V1_PROTOCOL_VERSION;
  if (!adapter.supportedProtocolVersions.includes(expectedProtocolVersion)) {
    throw new Error(`MCP Profile ${adapter.profile} does not advertise its required protocol version ${expectedProtocolVersion}.`);
  }
  return {
    profile: adapter.profile,
    protocol_version: expectedProtocolVersion,
    tool_mode: toolMode
  };
}
export const EXECUTION_PROFILE_SNAPSHOT_V1_FIELDS = [
  "version",
  "snapshot_id",
  "snapshot_version",
  "parent_snapshot_id",
  "reason",
  "created_at",
  "goal_id",
  "run_id",
  "provider",
  "model",
  "model_profile_id",
  "model_resolution",
  "reasoning_effort",
  "execution_lane",
  "reviewer_mode",
  "tool_policy",
  "permission_policy",
  "sandbox_policy",
  "mcp_profile",
  "context_profile",
  "working_directory",
  "environment_policy",
  "policy_version",
  "adapter_version",
  "task_contract_hash",
  "profile_hash"
] as const satisfies readonly (keyof GoalExecutionProfileSnapshot)[];

interface ExecutionProfileBody {
  version: 1;
  snapshot_version: number;
  parent_snapshot_id: string | null;
  reason: GoalExecutionProfileReason;
  created_at: string;
  goal_id: string;
  run_id: string;
  provider: CodexProviderId;
  model: string | null;
  model_profile_id: string | null;
  model_resolution: GoalModelResolution;
  reasoning_effort: CodexReasoningEffort | null;
  execution_lane: GoalExecutionLaneProfile;
  reviewer_mode: ExecutionLaneDecision["reviewer_mode"];
  tool_policy: ToolPolicy;
  permission_policy: GoalExecutionPermissionPolicy;
  sandbox_policy: GoalExecutionProfileSnapshot["sandbox_policy"];
  mcp_profile: GoalExecutionProfileSnapshot["mcp_profile"];
  context_profile: ContextProfile;
  working_directory: string;
  environment_policy: GoalExecutionProfileSnapshot["environment_policy"];
  policy_version: string;
  adapter_version: GoalExecutionProfileSnapshot["adapter_version"];
  task_contract_hash: string;
}

export interface CreateExecutionProfileSnapshotInput {
  goal_id: string;
  run_id: string;
  provider: CodexProviderId;
  model?: string | null;
  model_profile_id?: string | null;
  model_resolution: GoalModelResolution;
  reasoning_effort?: CodexReasoningEffort | null;
  execution_lane: ExecutionLaneDecision;
  tool_policy: ToolPolicy;
  goal_contract: GoalContractV1;
  sandbox_mode: CodexSandboxMode;
  approval_policy: CodexApprovalPolicy;
  mcp_profile: GoalExecutionProfileSnapshot["mcp_profile"];
  context_profile: ContextProfile;
  working_directory: string;
  inherit_env: boolean;
  network_access_enabled: boolean;
  skip_git_repo_check: boolean;
  adapter_mode: CodexAdapterMode;
  task_contract_hash: string;
  reason?: GoalExecutionProfileReason;
  parent?: GoalExecutionProfileSnapshot;
  created_at?: string;
}

export interface ExecutionProfileVerification {
  valid: boolean;
  compatible: boolean;
  reasons: string[];
  expected_hash: string;
  expected_snapshot_id: string;
}

export interface ExecutionProfileRevisionInput {
  reason: Exclude<GoalExecutionProfileReason, "goal_start" | "legacy_migration">;
  provider?: CodexProviderId;
  model?: string | null;
  model_profile_id?: string | null;
  model_resolution?: GoalModelResolution;
  reasoning_effort?: CodexReasoningEffort | null;
  execution_lane?: ExecutionLaneDecision | GoalExecutionLaneProfile;
  tool_policy?: ToolPolicy;
  permission_policy?: GoalExecutionPermissionPolicy;
  sandbox_mode?: CodexSandboxMode;
  approval_policy?: CodexApprovalPolicy;
  mcp_profile?: GoalExecutionProfileSnapshot["mcp_profile"];
  context_profile?: ContextProfile;
  working_directory?: string;
  environment_policy?: GoalExecutionProfileSnapshot["environment_policy"];
  policy_version?: string;
  adapter_version?: GoalExecutionProfileSnapshot["adapter_version"];
  task_contract_hash?: string;
  created_at?: string;
}

const PERSISTED_SENSITIVE_KEY_PATTERN = /\b(?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|secret|token|webhook|bark[_-]?url)\b/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [
          key,
          PERSISTED_SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED_SECRET]" : canonical(item)
        ])
    );
  }
  return value;
}

function hashBody(body: ExecutionProfileBody): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex")}`;
}

function snapshotId(version: number, hash: string): string {
  return `exec-profile-v${version}-${hash.replace(/^sha256:/, "").slice(0, 20)}`;
}

function laneProfile(lane: ExecutionLaneDecision | GoalExecutionLaneProfile): GoalExecutionLaneProfile {
  return {
    version: 1,
    enabled: lane.enabled,
    lane: lane.lane,
    forced_deep: lane.forced_deep,
    fast_eligible: lane.fast_eligible,
    reason_codes: [...lane.reason_codes],
    reasons: [...lane.reasons],
    reasoning_effort: lane.reasoning_effort,
    acceptance_profile: lane.acceptance_profile,
    reviewer_mode: lane.reviewer_mode,
    scope_size: lane.scope_size,
    escalation_only: true,
    ...(lane.escalated_from ? { escalated_from: lane.escalated_from } : {})
  };
}

function permissionPolicy(contract: GoalContractV1, approvalPolicy: CodexApprovalPolicy): GoalExecutionPermissionPolicy {
  return {
    approval_policy: approvalPolicy,
    tool_permissions: structuredClone(contract.tool_permissions),
    side_effect_permissions: structuredClone(contract.side_effect_permissions),
    commit_policy: contract.commit_policy,
    push_policy: contract.push_policy,
    deploy_policy: contract.deploy_policy,
    database_policy: contract.database_policy
  };
}

function bodyFromSnapshot(snapshot: GoalExecutionProfileSnapshot): ExecutionProfileBody {
  const { snapshot_id: _snapshotId, profile_hash: _profileHash, ...body } = snapshot;
  return body;
}

function createFromBody(body: ExecutionProfileBody): GoalExecutionProfileSnapshot {
  const profileHash = hashBody(body);
  return {
    ...structuredClone(body),
    snapshot_id: snapshotId(body.snapshot_version, profileHash),
    profile_hash: profileHash
  };
}

export function createExecutionProfileSnapshot(input: CreateExecutionProfileSnapshotInput): GoalExecutionProfileSnapshot {
  const version = input.parent ? input.parent.snapshot_version + 1 : 1;
  const parentSnapshotId = input.parent?.snapshot_id ?? null;
  const body: ExecutionProfileBody = {
    version: 1,
    snapshot_version: version,
    parent_snapshot_id: parentSnapshotId,
    reason: input.reason ?? "goal_start",
    created_at: input.created_at ?? new Date().toISOString(),
    goal_id: input.goal_id,
    run_id: input.run_id,
    provider: input.provider,
    model: input.model?.trim() || null,
    model_profile_id: input.model_profile_id?.trim() || null,
    model_resolution: input.model_resolution,
    reasoning_effort: input.reasoning_effort ?? null,
    execution_lane: laneProfile(input.execution_lane),
    reviewer_mode: input.execution_lane.reviewer_mode,
    tool_policy: structuredClone(input.tool_policy),
    permission_policy: permissionPolicy(input.goal_contract, input.approval_policy),
    sandbox_policy: {
      sandbox_mode: input.sandbox_mode,
      workspace_write: input.sandbox_mode === "workspace-write"
    },
    mcp_profile: structuredClone(input.mcp_profile),
    context_profile: structuredClone(input.context_profile),
    working_directory: input.working_directory,
    environment_policy: {
      inherit_env: input.inherit_env,
      network_access_enabled: input.network_access_enabled,
      skip_git_repo_check: input.skip_git_repo_check
    },
    policy_version: EXECUTION_PROFILE_POLICY_VERSION,
    adapter_version: {
      contract_version: EXECUTION_PROFILE_ADAPTER_CONTRACT_VERSION,
      adapter_mode: input.adapter_mode
    },
    task_contract_hash: input.task_contract_hash
  };
  return createFromBody(body);
}

export function reviseExecutionProfileSnapshot(
  previous: GoalExecutionProfileSnapshot,
  input: ExecutionProfileRevisionInput
): GoalExecutionProfileSnapshot {
  const previousBody = bodyFromSnapshot(previous);
  const nextLane = input.execution_lane ? laneProfile(input.execution_lane) : structuredClone(previous.execution_lane);
  const approvalPolicy = input.approval_policy ?? previous.permission_policy.approval_policy;
  const sandboxMode = input.sandbox_mode ?? previous.sandbox_policy.sandbox_mode;
  const body: ExecutionProfileBody = {
    ...previousBody,
    snapshot_version: previous.snapshot_version + 1,
    parent_snapshot_id: previous.snapshot_id,
    reason: input.reason,
    created_at: input.created_at ?? new Date().toISOString(),
    provider: input.provider ?? previous.provider,
    model: input.model === undefined ? previous.model : input.model?.trim() || null,
    model_profile_id: input.model_profile_id === undefined
      ? previous.model_profile_id
      : input.model_profile_id?.trim() || null,
    model_resolution: input.model_resolution ?? previous.model_resolution,
    reasoning_effort: input.reasoning_effort === undefined ? previous.reasoning_effort : input.reasoning_effort,
    execution_lane: nextLane,
    reviewer_mode: nextLane.reviewer_mode,
    tool_policy: input.tool_policy ? structuredClone(input.tool_policy) : structuredClone(previous.tool_policy),
    permission_policy: input.permission_policy
      ? structuredClone(input.permission_policy)
      : {
          ...structuredClone(previous.permission_policy),
          approval_policy: approvalPolicy
        },
    sandbox_policy: {
      sandbox_mode: sandboxMode,
      workspace_write: sandboxMode === "workspace-write"
    },
    mcp_profile: input.mcp_profile ? structuredClone(input.mcp_profile) : structuredClone(previous.mcp_profile),
    context_profile: input.context_profile ? structuredClone(input.context_profile) : structuredClone(previous.context_profile),
    working_directory: input.working_directory ?? previous.working_directory,
    environment_policy: input.environment_policy
      ? structuredClone(input.environment_policy)
      : structuredClone(previous.environment_policy),
    policy_version: input.policy_version ?? previous.policy_version,
    adapter_version: input.adapter_version ? structuredClone(input.adapter_version) : structuredClone(previous.adapter_version),
    task_contract_hash: input.task_contract_hash ?? previous.task_contract_hash
  };
  return createFromBody(body);
}

export function upgradeExecutionProfileSnapshot(
  previous: GoalExecutionProfileSnapshot,
  upgrade: GoalExecutionProfileUpgrade,
  createdAt?: string
): GoalExecutionProfileSnapshot {
  const hasModel = Object.hasOwn(upgrade, "model");
  const providerChanged = Boolean(upgrade.provider && upgrade.provider !== previous.provider);
  const lane = structuredClone(previous.execution_lane);
  if (upgrade.reasoning_effort) lane.reasoning_effort = upgrade.reasoning_effort;
  return reviseExecutionProfileSnapshot(previous, {
    reason: "explicit_upgrade",
    ...(upgrade.provider ? { provider: upgrade.provider } : {}),
    ...(hasModel ? { model: upgrade.model ?? null } : providerChanged ? { model: null } : {}),
    ...(hasModel || providerChanged ? { model_profile_id: null } : {}),
    ...(hasModel
      ? { model_resolution: upgrade.model ? "explicit" : "provider_default" }
      : providerChanged
        ? { model_resolution: "provider_default" }
        : {}),
    ...(upgrade.reasoning_effort ? { reasoning_effort: upgrade.reasoning_effort, execution_lane: lane } : {}),
    created_at: createdAt
  });
}

export function verifyExecutionProfileSnapshot(
  snapshot: GoalExecutionProfileSnapshot,
  expected: {
    goal_id?: string;
    run_id?: string;
    working_directory?: string;
    task_contract_hash?: string;
    mcp_profile?: Pick<GoalExecutionProfileSnapshot["mcp_profile"], "profile" | "protocol_version">;
  } = {}
): ExecutionProfileVerification {
  const reasons: string[] = [];
  const body = bodyFromSnapshot(snapshot);
  const expectedHash = hashBody(body);
  const expectedSnapshotId = snapshotId(snapshot.snapshot_version, expectedHash);
  if (snapshot.version !== 1) reasons.push("unsupported_snapshot_schema_version");
  if (!Number.isInteger(snapshot.snapshot_version) || snapshot.snapshot_version < 1) reasons.push("invalid_snapshot_version");
  if (snapshot.snapshot_version === 1 && snapshot.parent_snapshot_id !== null) reasons.push("unexpected_parent_for_initial_snapshot");
  if (snapshot.snapshot_version > 1 && !snapshot.parent_snapshot_id) reasons.push("missing_parent_snapshot_id");
  if (snapshot.profile_hash !== expectedHash) reasons.push("profile_hash_mismatch");
  if (snapshot.snapshot_id !== expectedSnapshotId) reasons.push("snapshot_id_mismatch");
  if (snapshot.reviewer_mode !== snapshot.execution_lane.reviewer_mode) reasons.push("reviewer_mode_mismatch");
  if (snapshot.sandbox_policy.workspace_write !== (snapshot.sandbox_policy.sandbox_mode === "workspace-write")) {
    reasons.push("sandbox_policy_mismatch");
  }
  if (expected.goal_id && snapshot.goal_id !== expected.goal_id) reasons.push("goal_id_mismatch");
  if (expected.run_id && snapshot.run_id !== expected.run_id) reasons.push("run_id_mismatch");
  if (expected.working_directory && snapshot.working_directory !== expected.working_directory) reasons.push("working_directory_mismatch");
  if (expected.task_contract_hash && snapshot.task_contract_hash !== expected.task_contract_hash) reasons.push("task_contract_hash_mismatch");
  const compatibilityReasons: string[] = [];
  if (snapshot.policy_version !== EXECUTION_PROFILE_POLICY_VERSION) compatibilityReasons.push("policy_version_unavailable");
  if (snapshot.adapter_version.contract_version !== EXECUTION_PROFILE_ADAPTER_CONTRACT_VERSION) {
    compatibilityReasons.push("adapter_contract_version_unavailable");
  }
  const supportedMcpProfile =
    (snapshot.mcp_profile.profile === MCP_PROFILE_V1
      && snapshot.mcp_profile.protocol_version === MCP_PROFILE_V1_PROTOCOL_VERSION)
    || (snapshot.mcp_profile.profile === MCP_PROFILE_V2
      && snapshot.mcp_profile.protocol_version === MCP_PROFILE_V2_PROTOCOL_VERSION);
  if (!supportedMcpProfile) compatibilityReasons.push("mcp_profile_unavailable");
  if (expected.mcp_profile
    && (snapshot.mcp_profile.profile !== expected.mcp_profile.profile
      || snapshot.mcp_profile.protocol_version !== expected.mcp_profile.protocol_version)) {
    compatibilityReasons.push("mcp_profile_runtime_mismatch");
  }
  return {
    valid: reasons.length === 0,
    compatible: compatibilityReasons.length === 0,
    reasons: [...reasons, ...compatibilityReasons],
    expected_hash: expectedHash,
    expected_snapshot_id: expectedSnapshotId
  };
}

export function executionOptionsFromProfile(snapshot: GoalExecutionProfileSnapshot): GoalExecutionOptions {
  return {
    sandbox_mode: snapshot.sandbox_policy.sandbox_mode,
    approval_policy: snapshot.permission_policy.approval_policy,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    preferred_provider: snapshot.provider,
    forced_provider: snapshot.provider,
    ...(snapshot.reasoning_effort ? { reasoning_effort: snapshot.reasoning_effort } : {}),
    network_access_enabled: snapshot.environment_policy.network_access_enabled,
    skip_git_repo_check: snapshot.environment_policy.skip_git_repo_check
  };
}

export function executionProfileRunMismatch(
  snapshot: GoalExecutionProfileSnapshot,
  run: { provider: CodexProviderId; working_directory: string; sandbox_mode: CodexSandboxMode }
): string[] {
  const reasons: string[] = [];
  if (run.provider !== snapshot.provider) reasons.push("provider_mismatch");
  if (run.working_directory !== snapshot.working_directory) reasons.push("working_directory_mismatch");
  if (run.sandbox_mode !== snapshot.sandbox_policy.sandbox_mode) reasons.push("sandbox_mode_mismatch");
  return reasons;
}
