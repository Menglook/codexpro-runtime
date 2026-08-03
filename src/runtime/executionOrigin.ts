import type { CodexProConfig } from "../config.js";

export type IntelligenceOrigin =
  | "chatgpt_connector"
  | "codex_cli"
  | "codex_sdk"
  | "openai_api"
  | "local_model"
  | "none";

export type ExecutionOrigin =
  | "codexpro_local"
  | "codex_cli"
  | "codex_sdk"
  | "test_mock";

export interface ExecutionOriginReceiptV1 {
  version: 1;
  intelligence_origin: IntelligenceOrigin;
  execution_origin: ExecutionOrigin;
  local_codex_process_started: boolean;
  codex_thread_created: boolean | null;
  api_key_used: boolean | null;
  external_model_invocation: boolean;
  codex_quota_risk: boolean;
  evidence_basis: "local_tool_contract" | "configured_provider_and_tool_contract";
}

export interface NativeRuntimePolicyV1 {
  version: 1;
  mode: "chatgpt_native" | "delegated_model" | "test_mock";
  intelligence_origin: "chatgpt_connector";
  execution_origin: "codexpro_local";
  model_delegation: "denied" | "explicitly_configured" | "test_only";
  codex_adapter: CodexProConfig["codexAdapter"];
  codex_cli_allowed: boolean;
  codex_sdk_allowed: boolean;
  provider_fallback_allowed: false;
  direct_openai_api_calls_allowed: false;
  external_model_invocation_allowed: boolean;
  codex_quota_risk: boolean;
}

const PROVIDER_TOOL_NAMES = new Set([
  "codex_capabilities",
  "codex_start_task",
  "codex_resume_task",
  "codex_cancel_task",
  "codex_task_status",
  "codex_task_events",
  "goal_start",
  "goal_status",
  "goal_resume",
  "goal_cancel",
  "goal_events"
]);

const MODEL_INVOCATION_TOOL_NAMES = new Set([
  "codex_start_task",
  "codex_resume_task",
  "goal_start",
  "goal_resume"
]);

const CODEX_PROCESS_TOOL_NAMES = new Set([
  "codex_capabilities",
  ...MODEL_INVOCATION_TOOL_NAMES
]);

function delegatedMode(config: CodexProConfig): boolean {
  return config.codexAdapter === "auto" || config.codexAdapter === "sdk" || config.codexAdapter === "exec";
}

function providerIntelligenceOrigin(config: CodexProConfig): IntelligenceOrigin {
  if (config.codexAdapter === "exec") return "codex_cli";
  if (config.codexAdapter === "auto" || config.codexAdapter === "sdk") return "codex_sdk";
  return "none";
}

function providerExecutionOrigin(config: CodexProConfig): ExecutionOrigin {
  if (config.codexAdapter === "exec") return "codex_cli";
  if (config.codexAdapter === "auto" || config.codexAdapter === "sdk") return "codex_sdk";
  return "test_mock";
}

export function nativeRuntimePolicy(config: CodexProConfig): NativeRuntimePolicyV1 {
  const delegated = delegatedMode(config);
  const mock = config.codexAdapter === "mock";
  return {
    version: 1,
    mode: mock ? "test_mock" : delegated ? "delegated_model" : "chatgpt_native",
    intelligence_origin: "chatgpt_connector",
    execution_origin: "codexpro_local",
    model_delegation: mock ? "test_only" : delegated ? "explicitly_configured" : "denied",
    codex_adapter: config.codexAdapter,
    codex_cli_allowed: config.codexAdapter === "exec",
    codex_sdk_allowed: config.codexAdapter === "auto" || config.codexAdapter === "sdk",
    provider_fallback_allowed: false,
    direct_openai_api_calls_allowed: false,
    external_model_invocation_allowed: delegated,
    codex_quota_risk: delegated
  };
}

export function executionOriginReceipt(
  config: CodexProConfig,
  toolName: string,
  outcome: { handlerInvoked?: boolean; handlerSucceeded?: boolean } = {}
): ExecutionOriginReceiptV1 {
  const providerTool = PROVIDER_TOOL_NAMES.has(toolName) && config.codexAdapter !== "off";
  if (!providerTool) {
    return {
      version: 1,
      intelligence_origin: "chatgpt_connector",
      execution_origin: "codexpro_local",
      local_codex_process_started: false,
      codex_thread_created: false,
      api_key_used: false,
      external_model_invocation: false,
      codex_quota_risk: false,
      evidence_basis: "local_tool_contract"
    };
  }

  const modelInvocation = MODEL_INVOCATION_TOOL_NAMES.has(toolName) && delegatedMode(config) && outcome.handlerInvoked === true;
  const processStarted = CODEX_PROCESS_TOOL_NAMES.has(toolName) && delegatedMode(config) && outcome.handlerInvoked === true;
  const directSdkStart = toolName === "codex_start_task"
    && (config.codexAdapter === "auto" || config.codexAdapter === "sdk")
    && outcome.handlerSucceeded === true;
  return {
    version: 1,
    intelligence_origin: modelInvocation ? providerIntelligenceOrigin(config) : "none",
    execution_origin: providerExecutionOrigin(config),
    local_codex_process_started: processStarted,
    codex_thread_created: toolName === "goal_start" && modelInvocation
      ? null
      : directSdkStart,
    api_key_used: modelInvocation ? null : false,
    external_model_invocation: modelInvocation,
    codex_quota_risk: modelInvocation,
    evidence_basis: "configured_provider_and_tool_contract"
  };
}
