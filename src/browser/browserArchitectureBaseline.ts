export type BrowserArchitectureLayer = "extension" | "adapter" | "session" | "task_contract";
export type BrowserCapabilityStatus = "implemented" | "partial" | "missing";

export interface BrowserLayerBaseline {
  id: BrowserArchitectureLayer;
  responsibility: string;
  owns: readonly string[];
  must_not_own: readonly string[];
}

export interface BrowserToolRuntimeMapping {
  tool: string;
  primary_layer: Exclude<BrowserArchitectureLayer, "extension">;
  capability: string;
}

export interface BrowserCapabilityBaseline {
  id: string;
  status: BrowserCapabilityStatus;
  owner: BrowserArchitectureLayer;
  evidence: readonly string[];
}

export type BrowserPhase0ActivationStage = 1 | 2 | 3 | 4 | 5;

export interface BrowserPlannedToolContract {
  tool: string;
  primary_layer: Exclude<BrowserArchitectureLayer, "extension">;
  activation_stage: BrowserPhase0ActivationStage;
  safety: "read" | "write";
  capability: string;
}

export const BROWSER_FIVE_CAPABILITY_CONTRACT_VERSION = 1;
export const BROWSER_FIVE_CAPABILITY_IMPLEMENTED_STAGE = 5;

export const BROWSER_FLOW_STEP_TYPES_V1 = [
  "open",
  "observe",
  "observe_continue",
  "assert",
  "click",
  "input",
  "select",
  "check",
  "scroll",
  "wait",
  "extract_table",
  "extract_facts",
  "download",
  "visual_observe",
  "branch",
  "repeat_bounded",
  "handoff",
  "report"
] as const;

export const BROWSER_FLOW_STEP_STATUSES_V1 = [
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "waiting_human",
  "cancelled"
] as const;

export const BROWSER_FLOW_RECOVERY_RULES_V1 = {
  passed_steps_are_replayed: false,
  readonly_steps_may_resume: true,
  input_requires_current_value_check: true,
  download_requires_credential_url_hash_and_task_check: true,
  click_requires_context_and_identity_revalidation: true,
  final_business_actions_are_blocked_during_prepare: true,
  disconnect_never_causes_unconditional_replay: true,
  write_steps_auto_retry: false,
  default_repeat_limit: 20,
  maximum_repeat_limit: 20,
  repeat_requires_progress_evidence: true
} as const;

export const BROWSER_PERMANENTLY_BLOCKED_FLOW_ACTIONS_V1 = [
  "payment",
  "recharge",
  "checkout",
  "submit_order",
  "confirm_fulfillment",
  "cancel_order",
  "refund",
  "resend",
  "change_price",
  "change_inventory",
  "change_ad_budget",
  "change_campaign_state",
  "delete",
  "clear",
  "publish",
  "send_message",
  "send_email",
  "send_support_reply",
  "change_password",
  "change_account",
  "change_production_configuration"
] as const;

export const BROWSER_SPACE_MODES_V1 = ["shared_profile", "isolated_context", "isolated_profile"] as const;

export const BROWSER_SPACE_DEFAULTS_V1 = {
  default_space_id: "default",
  default_mode: "shared_profile",
  isolated_profile_enabled_by_default: false,
  maximum_created_spaces: 3,
  maximum_running_flows: 2,
  maximum_flows_per_space: 1,
  maximum_interactive_steps_per_profile: 1,
  maximum_visual_captures: 1,
  maximum_downloads: 1
} as const;

export const BROWSER_SPACE_COMPATIBILITY_V1 = {
  parameter: "space_id",
  required: false,
  default: "default",
  applies_to_existing_browser_tools: true,
  activation_stage: 3
} as const;

export const BROWSER_SPACE_LIFECYCLE_RULES_V1 = {
  close_task_owned_tabs_on_flow_passed: true,
  close_task_owned_tabs_on_flow_cancelled: true,
  preserve_tabs_for_recoverable_failure: true,
  preserve_tabs_for_human_handoff: true,
  preserve_external_tabs: true,
  preserve_dedicated_chrome_process: true,
  tab_cleanup_uses_idle_timeout: false
} as const;

export const BROWSER_VERIFICATION_RESOURCE_LIFECYCLE_V1 = {
  create_dedicated_space_per_run: true,
  record_created_tab_ids: true,
  cleanup_on_completed: true,
  cleanup_on_failed: true,
  cleanup_on_timed_out: true,
  cleanup_on_cancelled: true,
  retain_only_when_explicit: true,
  acceptance_requires_resource_release: true,
  preserve_external_tabs: true,
  preserve_dedicated_chrome_process: true
} as const;

export const BROWSER_SKILL_PACK_LOAD_ORDER_V2 = ["workspace", "user", "builtin"] as const;

export const BROWSER_EXPERIENCE_PROMOTION_V1 = {
  automatic_long_term_write: false,
  requires_redaction_scan: true,
  requires_duplicate_check: true,
  requires_targeted_regression: true,
  requires_explicit_user_approval: true
} as const;

export const BROWSER_VISUAL_TRIGGER_REASONS_V1 = [
  "layout",
  "image_crop",
  "responsive",
  "style",
  "canvas",
  "video",
  "cross_origin_frame",
  "semantic_empty",
  "semantic_conflict",
  "manual"
] as const;

export const BROWSER_OBSERVATION_ROUTING_RULES_V1 = {
  semantic_first: true,
  visual_requires_semantic_observation: true,
  visual_requires_reason: true,
  visual_requires_bounded_scope: true,
  visual_may_expand_permissions: false,
  visual_may_produce_click_coordinates: false,
  interaction_requires_dom_reference_or_human_handoff: true,
  confidence_values: ["high", "medium", "low", "unknown"]
} as const;

export const BROWSER_UNTRUSTED_PAGE_CONTENT_RULES_V1 = {
  page_content_is_trusted_instruction: false,
  may_change_task_contract: false,
  may_expand_permissions: false,
  may_disable_risk_gate: false,
  may_request_cookie_token_or_password_disclosure: false,
  may_trigger_system_commands: false,
  may_promote_experience: false
} as const;

export const BROWSER_EVIDENCE_PROTECTION_RULES_V1 = {
  semantic_evidence_redacted: true,
  visual_evidence_redacted: true,
  secret_form_values_persisted: false,
  cookies_or_local_storage_persisted_in_space_manifest: false,
  experience_fixtures_redacted: true
} as const;

export const BROWSER_PLANNED_TOOL_CONTRACTS_V1: readonly BrowserPlannedToolContract[] = [
  { tool: "browser_observe_continue", primary_layer: "session", activation_stage: 1, safety: "read", capability: "continue a paginated semantic snapshot" },
  { tool: "browser_extract_table", primary_layer: "session", activation_stage: 1, safety: "read", capability: "bounded table and virtual-list extraction" },
  { tool: "browser_flow_prepare", primary_layer: "task_contract", activation_stage: 2, safety: "read", capability: "validate and freeze an immutable browser flow contract" },
  { tool: "browser_flow_run", primary_layer: "task_contract", activation_stage: 2, safety: "write", capability: "enqueue a browser flow and return its flow id" },
  { tool: "browser_flow_status", primary_layer: "task_contract", activation_stage: 2, safety: "read", capability: "read browser flow progress" },
  { tool: "browser_flow_resume", primary_layer: "task_contract", activation_stage: 2, safety: "write", capability: "resume only incomplete recoverable flow steps" },
  { tool: "browser_flow_result", primary_layer: "task_contract", activation_stage: 2, safety: "read", capability: "read a browser flow result and evidence summary" },
  { tool: "browser_flow_cancel", primary_layer: "task_contract", activation_stage: 2, safety: "write", capability: "stop future browser flow steps without rollback" },
  { tool: "browser_space_create", primary_layer: "session", activation_stage: 3, safety: "write", capability: "create an isolated browser task space" },
  { tool: "browser_space_list", primary_layer: "session", activation_stage: 3, safety: "read", capability: "list browser task spaces" },
  { tool: "browser_space_status", primary_layer: "session", activation_stage: 3, safety: "read", capability: "read browser task space state" },
  { tool: "browser_space_activate", primary_layer: "session", activation_stage: 3, safety: "write", capability: "select the active browser task space" },
  { tool: "browser_space_close", primary_layer: "session", activation_stage: 3, safety: "write", capability: "close owned resources for a browser task space" },
  { tool: "browser_space_reset", primary_layer: "session", activation_stage: 3, safety: "write", capability: "reset recoverable state in a browser task space" },
  { tool: "browser_inspect", primary_layer: "session", activation_stage: 5, safety: "read", capability: "route and fuse semantic and bounded visual evidence" }
] as const;

export const BROWSER_ARCHITECTURE_LAYERS_V1: readonly BrowserLayerBaseline[] = [
  {
    id: "extension",
    responsibility: "Optional legacy compatibility for installations that still keep the Chrome extension; normal dedicated-Chrome control does not depend on extension authorization.",
    owns: ["legacy trust metadata", "legacy authorization lease compatibility"],
    must_not_own: ["normal tab control", "LLM reasoning", "platform business logic", "task state machine", "business result verification"]
  },
  {
    id: "adapter",
    responsibility: "Browser transport and page primitives across headless, headed, and CDP modes.",
    owns: ["Playwright/CDP connection", "navigation", "DOM interaction", "console/network capture", "screenshots"],
    must_not_own: ["platform policy", "business object identity", "parent task completion", "business action ledger"]
  },
  {
    id: "session",
    responsibility: "Persistent workspace-scoped browser state, directly controlled tabs, semantic snapshots, verification checkpoints, and Browser Report evidence.",
    owns: ["session lifecycle", "controlled tab state", "semantic observation", "stable element refs", "verification recovery", "browser report"],
    must_not_own: ["parallel global task state machine", "platform-specific business rules", "business action ledger"]
  },
  {
    id: "task_contract",
    responsibility: "Task identity, platform/shop/business-object preconditions, risk boundary, success criteria, proof, and acceptance.",
    owns: ["task contract", "risk gate", "run identity", "completion proof", "acceptance receipt", "human handoff boundary"],
    must_not_own: ["browser transport", "Chrome authorization storage", "platform page selectors", "WB Dashboard business ledger"]
  }
] as const;

export const BROWSER_TOOL_RUNTIME_MAPPINGS_V1: readonly BrowserToolRuntimeMapping[] = [
  { tool: "browser_status", primary_layer: "session", capability: "runtime status" },
  { tool: "browser_runtime_probe", primary_layer: "session", capability: "runtime usability probe" },
  { tool: "browser_tabs", primary_layer: "session", capability: "controlled tab inventory" },
  { tool: "browser_observe", primary_layer: "session", capability: "semantic observation" },
  { tool: "browser_inspect", primary_layer: "session", capability: "semantic-first observation routing, bounded visual evidence, fusion, conflicts, and limitations" },
  { tool: "browser_observe_continue", primary_layer: "session", capability: "Semantic Snapshot v3 pagination" },
  { tool: "browser_extract_table", primary_layer: "session", capability: "bounded table and virtual-list extraction" },
  { tool: "browser_flow_prepare", primary_layer: "task_contract", capability: "immutable declarative browser flow preparation" },
  { tool: "browser_flow_run", primary_layer: "task_contract", capability: "bounded asynchronous browser flow execution" },
  { tool: "browser_flow_status", primary_layer: "task_contract", capability: "persisted browser flow progress and blocking state" },
  { tool: "browser_flow_resume", primary_layer: "task_contract", capability: "explicit idempotent recovery of unfinished flow steps" },
  { tool: "browser_flow_result", primary_layer: "task_contract", capability: "structured flow facts, proof, handoff, and evidence" },
  { tool: "browser_flow_cancel", primary_layer: "task_contract", capability: "safe cancellation of future flow steps" },
  { tool: "browser_space_create", primary_layer: "session", capability: "persistent Browser Task Space creation with explicit isolation mode" },
  { tool: "browser_space_list", primary_layer: "session", capability: "workspace Browser Task Space inventory" },
  { tool: "browser_space_status", primary_layer: "session", capability: "space manifest, owned-tab, flow, and resource status" },
  { tool: "browser_space_activate", primary_layer: "session", capability: "explicit Browser Task Space activation" },
  { tool: "browser_space_close", primary_layer: "session", capability: "owned-resource-only Browser Task Space shutdown" },
  { tool: "browser_space_reset", primary_layer: "session", capability: "bounded Browser Task Space reset without cross-space cleanup" },
  { tool: "browser_observe_region", primary_layer: "session", capability: "bounded semantic observation" },
  { tool: "browser_get_element", primary_layer: "session", capability: "stable element lookup" },
  { tool: "browser_select", primary_layer: "adapter", capability: "low-risk selection" },
  { tool: "browser_check", primary_layer: "adapter", capability: "low-risk checkbox interaction" },
  { tool: "browser_scroll_into_view", primary_layer: "adapter", capability: "viewport navigation" },
  { tool: "browser_visual_observe", primary_layer: "session", capability: "on-demand visual evidence" },
  { tool: "browser_verification_run", primary_layer: "session", capability: "checkpointed verification" },
  { tool: "browser_verification_status", primary_layer: "session", capability: "verification status and browser resource release gate" },
  { tool: "browser_verification_resume", primary_layer: "session", capability: "verification recovery in the run-owned Browser Space" },
  { tool: "browser_verification_cancel", primary_layer: "session", capability: "verification cancellation with immediate owned-resource cleanup" },
  { tool: "browser_verification_result", primary_layer: "session", capability: "verification result with resource leak acceptance check" },
  { tool: "browser_disconnect", primary_layer: "session", capability: "safe disconnect" },
  { tool: "browser_open", primary_layer: "adapter", capability: "navigation" },
  { tool: "browser_click", primary_layer: "adapter", capability: "low-risk click" },
  { tool: "browser_type", primary_layer: "adapter", capability: "bounded text entry" },
  { tool: "browser_wait", primary_layer: "adapter", capability: "page wait" },
  { tool: "browser_download", primary_layer: "session", capability: "controlled download evidence" },
  { tool: "browser_screenshot", primary_layer: "adapter", capability: "pixel evidence" },
  { tool: "browser_visual_regression", primary_layer: "session", capability: "visual regression" },
  { tool: "browser_console", primary_layer: "adapter", capability: "console evidence" },
  { tool: "browser_network", primary_layer: "adapter", capability: "network evidence" },
  { tool: "browser_expect_text", primary_layer: "adapter", capability: "text assertion" },
  { tool: "browser_expect_url", primary_layer: "adapter", capability: "URL assertion" },
  { tool: "browser_expect_hidden", primary_layer: "adapter", capability: "visibility assertion" },
  { tool: "browser_report", primary_layer: "session", capability: "evidence report" },
  { tool: "browser_business_prepare_task", primary_layer: "task_contract", capability: "browser business task contract preparation" },
  { tool: "browser_business_validate_task", primary_layer: "task_contract", capability: "browser business task contract validation" },
  { tool: "browser_business_list_skills", primary_layer: "task_contract", capability: "project platform skill inventory" },
  { tool: "browser_business_read_skill", primary_layer: "task_contract", capability: "project platform skill read" },
  { tool: "browser_business_validate_skill", primary_layer: "task_contract", capability: "platform skill schema and boundary validation" },
  { tool: "browser_business_run_skill", primary_layer: "task_contract", capability: "read-only platform skill execution over BrowserSession evidence" },
  { tool: "browser_business_generate_handoff", primary_layer: "task_contract", capability: "human action package generation" },
  { tool: "browser_business_verify_result", primary_layer: "task_contract", capability: "business result verification" }
] as const;

export const BROWSER_CAPABILITY_BASELINE_V1: readonly BrowserCapabilityBaseline[] = [
  { id: "explicit_chrome_authorization", status: "implemented", owner: "extension", evidence: ["chrome-extension/", "src/browser/browser-session.ts"] },
  { id: "three_runtime_modes", status: "implemented", owner: "adapter", evidence: ["src/adapters/playwright-adapter.ts"] },
  { id: "persistent_browser_session", status: "implemented", owner: "session", evidence: ["src/browser/browser-session.ts"] },
  { id: "semantic_observation", status: "implemented", owner: "session", evidence: ["src/browser/browser-tools.ts"] },
  { id: "low_risk_interaction", status: "implemented", owner: "adapter", evidence: ["src/browser/browser-tools.ts"] },
  { id: "checkpointed_verification", status: "implemented", owner: "session", evidence: ["src/browser/browser-session.ts"] },
  { id: "browser_business_task_contract", status: "implemented", owner: "task_contract", evidence: ["src/browser/browser-business-contract.ts", "schemas/browser-business-task.schema.json"] },
  { id: "human_action_package", status: "implemented", owner: "task_contract", evidence: ["src/browser/browser-business-contract.ts", "schemas/human-action-package.schema.json"] },
  { id: "controlled_download", status: "implemented", owner: "session", evidence: ["src/adapters/playwright-adapter.ts", "src/browser/browser-session.ts", "src/browser/browser-tools.ts", "src/browser/browser-report.ts", "scripts/browser-download-smoke.mjs"] },
  { id: "platform_skill_runtime", status: "implemented", owner: "task_contract", evidence: ["src/browser/platform-skill-runtime.ts", "schemas/platform-skill.schema.json", ".codexpro/browser-skills/wb/wb.promotion.credit_balance_audit.json", ".codexpro/browser-skills/ozon/ozon.finance.report_download.json"] },
  { id: "business_result_verification", status: "implemented", owner: "task_contract", evidence: ["src/browser/browser-business-contract.ts", "src/browser/browser-business-tools.ts"] },
  { id: "semantic_snapshot_v3", status: "implemented", owner: "session", evidence: ["src/browser/semantic-snapshot-v3.ts", "src/browser/browser-session.ts", "src/browser/browser-tools.ts", "src/adapters/playwright-adapter.ts", "src/adapters/native-cdp-readonly.ts", "schemas/browser-semantic-snapshot-v3.schema.json", "schemas/browser-table-extraction.schema.json"] },
  { id: "browser_flow_engine", status: "implemented", owner: "task_contract", evidence: ["src/browser/browser-flow-contract.ts", "src/browser/browser-flow-engine.ts", "src/browser/browser-flow-store.ts", "src/browser/browser-tools.ts", "schemas/browser-flow.schema.json", "schemas/browser-flow-state.schema.json", "schemas/browser-flow-result.schema.json", "scripts/browser-flow-contract-smoke.mjs", "scripts/browser-flow-recovery-smoke.mjs", "scripts/browser-flow-engine-smoke.mjs"] },
  { id: "task_space", status: "implemented", owner: "session", evidence: ["src/browser/browser-space.ts", "src/browser/browser-space-manager.ts", "src/browser/browser-session.ts", "src/browser/browser-tools.ts", "src/adapters/playwright-adapter.ts", "schemas/browser-space.schema.json", "schemas/browser-tab-ownership.schema.json", "scripts/browser-space-contract-smoke.mjs", "scripts/browser-space-resource-smoke.mjs", "scripts/browser-space-isolation-smoke.mjs"] },
  { id: "browser_skill_pack_v2", status: "implemented", owner: "task_contract", evidence: ["src/browser/browser-skill-pack-contract.ts", "src/browser/browser-skill-pack-runtime.ts", "src/browser/browser-experience-candidate.ts", "src/browser/platform-skill-runtime.ts", "schemas/browser-skill-pack.schema.json", "schemas/browser-page-fingerprint.schema.json", "schemas/browser-navigation-map.schema.json", "schemas/browser-extractor.schema.json", "schemas/browser-experience-candidate.schema.json", ".codexpro/browser-skills/wb/manifest.json", ".codexpro/browser-skills/ozon/manifest.json", "browser-skills-builtin/generic-demo/manifest.json", "scripts/browser-skill-pack-v2-smoke.mjs", "scripts/browser-skill-pack-layering-smoke.mjs", "scripts/browser-skill-pack-runtime-smoke.mjs"] },
  { id: "semantic_visual_dual_channel", status: "implemented", owner: "session", evidence: ["src/browser/observation-router.ts", "src/browser/evidence-fusion.ts", "src/browser/browser-tools.ts", "src/browser/browser-session.ts", "src/browser/browser-report.ts", "src/adapters/playwright-adapter.ts", "schemas/browser-inspection-result.schema.json", "schemas/browser-multimodal-evidence.schema.json", "schemas/browser-evidence-conflict.schema.json", "scripts/browser-observation-router-smoke.mjs", "scripts/browser-evidence-fusion-smoke.mjs", "scripts/browser-inspect-smoke.mjs"] }
] as const;

export const BROWSER_BE0_GAPS_V1 = [] as const;
