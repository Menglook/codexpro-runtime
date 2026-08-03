import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import { TOOL_LIMITS } from "../tools/toolLimits.js";
import { BrowserSessionManager, isTerminalVerificationRunStatus, type BrowserVerificationCleanupState, type BrowserVerificationRunState } from "./browser-session.js";
import { loadPersistedBrowserBusinessTask } from "./browser-business-task-store.js";
import {
  browserBusinessTaskSchema,
  businessObjectSchema,
  shopContextSchema,
  validateBrowserBusinessTask
} from "./browser-business-contract.js";
import { BrowserFlowEngine, browserFlowPaths } from "./browser-flow-engine.js";
import { browserFlowStepSchema, type BrowserFlowResult, type BrowserFlowState } from "./browser-flow-contract.js";
import { readProjectPlatformSkill, validateSkillForTask } from "./platform-skill-runtime.js";
import { BrowserSpaceManager } from "./browser-space-manager.js";
import { BROWSER_SPACE_DEFAULT_ID, browserSpaceIdSchema, browserSpaceModeSchema } from "./browser-space.js";
import {
  browserInspectionVisualScopeSchema,
  browserVisualReasonSchema,
  createBrowserInspectionResult,
  inspectionArtifactPaths,
  routeBrowserObservation,
  semanticEvidenceFacts,
  visualCaptureEvidenceFact
} from "./observation-router.js";
import { browserVisualEvidenceSchema, fuseBrowserEvidence } from "./evidence-fusion.js";

export type BrowserToolSafety = "read" | "write";

export interface BrowserToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface BrowserToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: BrowserToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<BrowserToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

const deviceSchema = z.enum(["desktop", "mobile"]);
const waitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle"]);
const textModeSchema = z.enum(["contains", "exact", "regex"]);
const urlModeSchema = z.enum(["contains", "exact", "regex"]);
const clickButtonSchema = z.enum(["left", "right", "middle"]);
const waitStateSchema = z.enum(["visible", "hidden", "attached", "detached"]);
const observeScopeSchema = z.enum(["viewport", "document", "selector"]);
const visualScopeSchema = z.enum(["viewport", "full_page", "selector"]);
const visualReasonSchema = browserVisualReasonSchema;
const downloadFingerprintSchema = z.object({
  type: z.enum(["url_contains", "hostname_contains", "title_contains", "text_contains", "element_text_contains", "accessible_name_contains"]),
  value: z.string().min(1),
  required: z.boolean().optional()
}).strict();
const downloadElementFingerprintSchema = z.object({
  ref: z.string().regex(/^e\d+$/),
  selector: z.string().min(1),
  tag_name: z.string().min(1),
  role: z.string().min(1),
  name: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  href_absent: z.literal(true),
  visible: z.literal(true),
  clickable: z.literal(true),
  container_ref: z.string().regex(/^e\d+$/).optional(),
  container_role: z.string().min(1).optional(),
  container_text_contains: z.string().min(1).optional()
}).strict();

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function spaceArg(): z.ZodOptional<z.ZodString> {
  return browserSpaceIdSchema.optional().describe("Browser Task Space id. Omit to preserve legacy behavior in the default space.");
}

function resourceForTool(name: string): "interactive_profile" | "visual" | "download" | undefined {
  if (["browser_visual_observe", "browser_screenshot", "browser_visual_regression"].includes(name)) return "visual";
  if (name === "browser_download") return "download";
  if (["browser_open", "browser_click", "browser_type", "browser_select", "browser_check", "browser_scroll_into_view", "browser_wait"].includes(name)) return "interactive_profile";
  return undefined;
}

function formatCountLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function formatVisualComparisonSummary(entry: { label: string; device: string; passed: boolean; mismatchRatio?: number; diffPath?: string; error?: string }): string {
  const mismatch = entry.mismatchRatio === undefined ? "n/a" : `${(entry.mismatchRatio * 100).toFixed(4)}%`;
  return `- ${entry.label} / ${entry.device}: ${entry.passed ? "PASS" : "FAIL"}, mismatch=${mismatch}${entry.diffPath ? `, diff=${entry.diffPath}` : ""}${entry.error ? `, error=${entry.error}` : ""}`;
}

function serializeBridgeStatus(status: any): Record<string, unknown> {
  return {
    connected: status.connected,
    requested_mode: status.requestedMode,
    effective_mode: status.effectiveMode,
    connected_at: status.connectedAt,
    disconnected_at: status.disconnectedAt,
    owns_browser_process: status.ownsBrowserProcess,
    fallback_reason: status.fallbackReason,
    isolated_profile_verified: status.isolatedProfileVerified,
    reconnect_attempts: status.reconnectAttempts,
    last_reconnect_at: status.lastReconnectAt,
    reconnect_failure_reason: status.reconnectFailureReason,
    current_url: status.currentUrl,
    current_device: status.currentDevice,
    tab_count: status.tabCount,
    navigation_count: status.navigationCount,
    download_bridge_configured: status.downloadBridgeConfigured,
    download_bridge_browser_dir: status.downloadBridgeBrowserDir,
    download_bridge_host_dir: status.downloadBridgeHostDir,
    session_id: status.sessionId,
    session_created_at: status.sessionCreatedAt,
    last_used_at: status.lastUsedAt,
    space_id: status.spaceId,
    space_mode: status.spaceMode,
    report_root: status.reportRoot
  };
}

function serializeTabs(tabs: any[]): Array<Record<string, unknown>> {
  return tabs.map((tab) => ({
    tab_id: tab.tabId,
    index: tab.index,
    title: tab.title,
    url: tab.url,
    current: tab.current,
    owned_by_codexpro: tab.ownedByCodexPro
  }));
}

function compactDownload(entry: any): Record<string, unknown> {
  return {
    download_id: entry.download_id,
    status: entry.status,
    original_filename: entry.original_filename,
    safe_filename: entry.safe_filename,
    relative_path: entry.relative_path,
    credential_path: entry.credential_path,
    bytes: entry.bytes,
    mime: entry.mime,
    mime_source: entry.mime_source,
    sha256: entry.sha256,
    source_page: entry.source_page,
    downloaded_at: entry.downloaded_at,
    trigger_element: {
      selector: entry.trigger_element?.selector,
      requested: entry.trigger_element?.requested
    },
    task_id: entry.task_id,
    run_id: entry.run_id,
    session_id: entry.session_id,
    error: entry.error,
    async_evidence: entry.async_evidence,
    replayed: entry.replayed,
    durable_message: entry.durable_message
  };
}

function serializeSemanticObservation(snapshot: any): Record<string, unknown> {
  return {
    snapshot_version: snapshot.snapshotVersion,
    snapshot_id: snapshot.snapshotId,
    previous_snapshot_id: snapshot.previousSnapshotId,
    session_id: snapshot.sessionId,
    space_id: snapshot.spaceId,
    page_id: snapshot.pageId,
    page_revision: snapshot.pageRevision,
    document_version: snapshot.documentVersion,
    source: snapshot.source,
    redacted: snapshot.redacted,
    created_at: snapshot.timestamp,
    scope: snapshot.observationScope,
    page: {
      url: snapshot.url,
      title: snapshot.title,
      ready_state: snapshot.readyState,
      viewport: snapshot.viewport,
      scroll: snapshot.scroll,
      device: snapshot.device
    },
    frames: snapshot.frames,
    regions: snapshot.regions,
    elements: snapshot.elements,
    tables: snapshot.tables,
    forms: snapshot.forms,
    issues: snapshot.issues,
    accessibility: snapshot.accessibility,
    dom_snapshot_node_count: snapshot.domSnapshotNodeCount,
    text: snapshot.text,
    changes: snapshot.changes,
    pagination: {
      has_more: snapshot.pagination?.hasMore,
      next_cursor: snapshot.pagination?.nextCursor,
      chunk_index: snapshot.pagination?.chunkIndex,
      node_offset: snapshot.pagination?.nodeOffset,
      next_node_offset: snapshot.pagination?.nextNodeOffset,
      total_nodes: snapshot.pagination?.totalNodes,
      text_offset: snapshot.pagination?.textOffset,
      next_text_offset: snapshot.pagination?.nextTextOffset,
      total_text_chars: snapshot.pagination?.totalTextChars
    },
    completeness: snapshot.pagination?.hasMore ? "partial" : "complete",
    evidence_path: snapshot.evidencePath,
    truncated: snapshot.truncated
  };
}

function serializeFlowState(state: BrowserFlowState): Record<string, unknown> {
  const counts = Object.fromEntries([
    "pending", "running", "passed", "failed", "blocked", "skipped", "waiting_human", "cancelled"
  ].map((status) => [status, state.steps.filter((step) => step.status === status).length]));
  return {
    version: state.version,
    flow_id: state.flow_id,
    contract_hash: state.contract_hash,
    task_id: state.task_id,
    run_id: state.run_id,
    space_id: state.space_id,
    status: state.status,
    current_step_id: state.current_step_id,
    resume_count: state.resume_count,
    blocking_reason: state.blocking_reason,
    resource_wait: state.resource_wait,
    counts,
    steps: state.steps.map((step) => ({
      step_id: step.step_id,
      status: step.status,
      attempt_count: step.attempt_count,
      recoverable: step.recoverable,
      retryable: step.retryable,
      started_at: step.started_at,
      finished_at: step.finished_at,
      before_snapshot_id: step.before_snapshot_id,
      after_snapshot_id: step.after_snapshot_id,
      error_class: step.error_class,
      error_message: step.error_message,
      evidence_paths: step.evidence_paths
    })),
    created_at: state.created_at,
    updated_at: state.updated_at
  };
}

function serializeFlowResult(result: BrowserFlowResult): Record<string, unknown> {
  const facts = result.facts.map((fact) => ({
    ...fact,
    value: typeof fact.value === "string"
      ? fact.value.slice(0, 4000)
      : Array.isArray(fact.value)
        ? fact.value.slice(0, 100)
        : fact.value
  }));
  return { ...result, facts, truncated: JSON.stringify(facts) !== JSON.stringify(result.facts) };
}

function bridgeText(status: any): string[] {
  return [
    `Connected: ${status.connected ? "yes" : "no"}`,
    `Requested browser mode: ${status.requestedMode}`,
    `Effective browser mode: ${status.effectiveMode ?? "not connected"}`,
    `Owns browser process: ${status.ownsBrowserProcess ? "yes" : "no"}`,
    `Automatic CDP reconnect attempts: ${status.reconnectAttempts ?? 0}`,
    `Navigations: ${status.navigationCount ?? 0}`,
    status.sessionId ? `Browser session: ${status.sessionId}` : "",
    `Tabs: ${status.tabCount}`,
    status.lastReconnectAt ? `Last reconnect attempt: ${status.lastReconnectAt}` : "",
    status.reconnectFailureReason ? `Reconnect failure: ${status.reconnectFailureReason}` : "",
    status.fallbackReason ? `Fallback: ${status.fallbackReason}` : ""
  ].filter(Boolean);
}

export function browserToolNames(): string[] {
  return [
    "browser_space_create",
    "browser_space_list",
    "browser_space_status",
    "browser_space_activate",
    "browser_space_close",
    "browser_space_reset",
    "browser_status",
    "browser_runtime_probe",
    "browser_tabs",
    "browser_observe",
    "browser_inspect",
    "browser_observe_continue",
    "browser_extract_table",
    "browser_flow_prepare",
    "browser_flow_run",
    "browser_flow_status",
    "browser_flow_resume",
    "browser_flow_result",
    "browser_flow_cancel",
    "browser_observe_region",
    "browser_get_element",
    "browser_select",
    "browser_check",
    "browser_scroll_into_view",
    "browser_visual_observe",
    "browser_verification_run",
    "browser_verification_status",
    "browser_verification_resume",
    "browser_verification_cancel",
    "browser_verification_result",
    "browser_disconnect",
    "browser_open",
    "browser_click",
    "browser_type",
    "browser_wait",
    "browser_download",
    "browser_screenshot",
    "browser_visual_regression",
    "browser_console",
    "browser_network",
    "browser_expect_text",
    "browser_expect_url",
    "browser_expect_hidden",
    "browser_report"
  ];
}

export function createBrowserTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): BrowserToolDefinition[] {
  const sessions = new BrowserSessionManager(config, guard);
  const spaces = new BrowserSpaceManager(config, guard, sessions);
  const flows = new BrowserFlowEngine(
    config,
    guard,
    (workspace, spaceId) => spaces.sessionFor(workspace, spaceId),
    {
      waiting: (workspace, spaceId, flowId) => spaces.markFlow(workspace, spaceId, flowId, true),
      started: (workspace, spaceId, flowId) => spaces.markFlow(workspace, spaceId, flowId, false),
      finished: async (workspace, spaceId, flowId, status, taskId, runId) => {
        await spaces.finishFlow(workspace, spaceId, flowId, status, taskId, runId);
      },
      acquire: (workspace, spaceId, flowId, resource) => spaces.acquireResource(workspace, spaceId, flowId, resource),
      release: (workspace, spaceId, flowId, resource) => spaces.releaseResource(workspace, spaceId, flowId, resource)
    }
  );
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const sessionFor = (args: any) => spaces.sessionFor(workspaceFor(args), args.space_id ?? BROWSER_SPACE_DEFAULT_ID);
  const targetFor = (args: any): string => {
    const target = typeof args.ref === "string" && args.ref.trim() ? args.ref.trim() : typeof args.selector === "string" ? args.selector.trim() : "";
    if (!target) throw new Error("Provide ref or selector.");
    return target;
  };
  const assertFlowSpace = (args: any, state: { space_id: string }): void => {
    if (args.space_id !== undefined && args.space_id !== state.space_id) {
      throw new CodexProError(`Browser flow is bound to space ${state.space_id}, not requested space ${args.space_id}.`);
    }
  };

  type VerificationBinding = { workspace: Workspace; spaceId: string; retainBrowser: boolean; timeoutMs: number };
  type ResolvedVerificationBinding = { binding: VerificationBinding; state: BrowserVerificationRunState; spaceStatus: string };
  const verificationBindings = new Map<string, VerificationBinding>();
  const verificationWatchers = new Map<string, Promise<void>>();
  const verificationSpaceId = (runId: string): string => `verify-${runId.replace(/-/g, "").slice(0, 24)}`;
  const verificationKey = (workspace: Workspace, runId: string): string => `${workspace.root}\0${runId}`;
  const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const resolveVerificationBinding = async (workspace: Workspace, runId: string, requestedSpaceId?: string): Promise<ResolvedVerificationBinding> => {
    const key = verificationKey(workspace, runId);
    const existing = verificationBindings.get(key);
    const manifest = requestedSpaceId
      ? await spaces.status(workspace, requestedSpaceId, false)
      : existing
        ? await spaces.status(workspace, existing.spaceId, false)
        : await spaces.findByOwnerRunId(workspace, runId);
    if (!manifest) throw new CodexProError(`Browser verification run ${runId} does not have a dedicated Browser Space.`);
    if (manifest.owner_run_id !== runId) throw new CodexProError(`Browser Space ${manifest.space_id} does not belong to verification run ${runId}.`);
    const session = spaces.sessionFor(workspace, manifest.space_id);
    const state = await session.verificationStatus(runId);
    const binding = {
      workspace,
      spaceId: manifest.space_id,
      retainBrowser: Boolean(state.retainBrowser),
      timeoutMs: state.timeoutMs ?? 600_000
    };
    verificationBindings.set(key, binding);
    if (manifest.status === "closed") {
      await sessions.disconnect(workspace, {
        spaceId: manifest.space_id,
        mode: manifest.mode === "isolated_context" ? "isolated_context" : "shared_profile"
      }).catch(() => undefined);
    }
    return { binding, state, spaceStatus: manifest.status };
  };

  const cleanupVerification = async (binding: VerificationBinding, runId: string, initialState?: BrowserVerificationRunState): Promise<BrowserVerificationRunState> => {
    let state = initialState;
    if (state && !isTerminalVerificationRunStatus(state.status)) return state;
    if (state?.cleanup?.status === "completed" || state?.cleanup?.status === "retained") return state;
    const manifestBefore = await spaces.status(binding.workspace, binding.spaceId, false);
    const session = spaces.sessionFor(binding.workspace, binding.spaceId);
    state = state ?? await session.verificationStatus(runId);
    if (!isTerminalVerificationRunStatus(state.status)) return state;
    const requestedAt = new Date().toISOString();
    const refreshed = manifestBefore.status === "closed"
      ? undefined
      : await spaces.refreshTabs(binding.workspace, binding.spaceId).catch(() => undefined);
    const createdTabIds = [...new Set([...(state.createdTabIds ?? []), ...(refreshed?.controlled_tab_ids ?? [])])];
    if (manifestBefore.status === "closed") {
      await sessions.disconnect(binding.workspace, {
        spaceId: binding.spaceId,
        mode: manifestBefore.mode === "isolated_context" ? "isolated_context" : "shared_profile"
      }).catch(() => undefined);
    }
    if ((binding.retainBrowser || state.retainBrowser) && manifestBefore.status !== "closed") {
      const retainedCleanup: BrowserVerificationCleanupState = {
        required: false,
        status: "retained",
        requestedAt,
        completedAt: new Date().toISOString(),
        reason: "explicit_retain_browser",
        createdTabIds,
        closedTabIds: [],
        spaceClosed: false,
        resourceReleased: false,
        leakDetected: false,
        leakReasons: []
      };
      return await session.recordVerificationCleanup(runId, retainedCleanup);
    }
    const retainAlreadyClosed = (binding.retainBrowser || state.retainBrowser) && manifestBefore.status === "closed";
    let closeError: string | undefined;
    if (manifestBefore.status !== "closed") {
      try {
        await spaces.close(binding.workspace, binding.spaceId);
      } catch (error) {
        closeError = error instanceof Error ? error.message : String(error);
      }
    }
    const audit = await spaces.auditReleasedResources(binding.workspace, binding.spaceId);
    const leakReasons = [...audit.reasons, ...(closeError ? [`close_error_${closeError}`] : [])];
    const remainingIds = new Set(audit.controlled_tab_ids);
    const cleanup: BrowserVerificationCleanupState = {
      required: true,
      status: !retainAlreadyClosed && audit.released && !closeError ? "completed" : "failed",
      requestedAt,
      completedAt: new Date().toISOString(),
      reason: closeError ?? (retainAlreadyClosed ? "explicit_retain_browser_could_not_be_honored_after_space_was_already_closed" : undefined),
      createdTabIds,
      closedTabIds: createdTabIds.filter((tabId) => !remainingIds.has(tabId)),
      spaceClosed: audit.status === "closed",
      resourceReleased: audit.released && !closeError,
      leakDetected: leakReasons.length > 0,
      leakReasons
    };
    state = await session.recordVerificationCleanup(runId, cleanup);
    return state;
  };

  const scheduleVerificationWatcher = (binding: VerificationBinding, runId: string): void => {
    const key = verificationKey(binding.workspace, runId);
    if (verificationWatchers.has(key)) return;
    const watcher = (async () => {
      const session = spaces.sessionFor(binding.workspace, binding.spaceId);
      const initialState = await session.verificationStatus(runId);
      const createdAt = Date.parse(initialState.createdAt);
      const deadline = Number.isFinite(createdAt) ? createdAt + binding.timeoutMs : Date.now() + binding.timeoutMs;
      let state = initialState;
      while (true) {
        if (!isTerminalVerificationRunStatus(state.status) && Date.now() >= deadline) {
          state = await session.cancelVerification(runId, `Browser verification exceeded ${binding.timeoutMs} ms.`, "timed_out");
        }
        if (isTerminalVerificationRunStatus(state.status)) {
          await cleanupVerification(binding, runId, state);
          return;
        }
        await delay(100);
        state = await session.verificationStatus(runId);
      }
    })().catch(async (error) => {
      const manifest = await spaces.status(binding.workspace, binding.spaceId, false).catch(() => undefined);
      const session = spaces.sessionFor(binding.workspace, binding.spaceId);
      const state = await session.verificationStatus(runId).catch(() => undefined);
      if (!state || !isTerminalVerificationRunStatus(state.status)) return;
      if ((binding.retainBrowser || state.retainBrowser) && manifest && manifest.status !== "closed") {
        await session.recordVerificationCleanup(runId, {
          required: false,
          status: "retained",
          requestedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
          createdTabIds: [...(state.createdTabIds ?? [])],
          closedTabIds: [],
          spaceClosed: false,
          resourceReleased: false,
          leakDetected: false,
          leakReasons: []
        }).catch(() => undefined);
        return;
      }
      if (manifest?.status === "closed") {
        await sessions.disconnect(binding.workspace, {
          spaceId: binding.spaceId,
          mode: manifest.mode === "isolated_context" ? "isolated_context" : "shared_profile"
        }).catch(() => undefined);
      } else if (!binding.retainBrowser && !state.retainBrowser) {
        await spaces.close(binding.workspace, binding.spaceId).catch(() => undefined);
      }
      const audit = await spaces.auditReleasedResources(binding.workspace, binding.spaceId).catch(() => undefined);
      const cleanup: BrowserVerificationCleanupState = {
        required: !binding.retainBrowser,
        status: audit?.released ? "completed" : "failed",
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
        createdTabIds: [...(state.createdTabIds ?? [])],
        closedTabIds: audit?.released ? [...(state.createdTabIds ?? [])] : [],
        spaceClosed: audit?.status === "closed",
        resourceReleased: Boolean(audit?.released),
        leakDetected: !audit?.released,
        leakReasons: audit?.reasons?.length ? audit.reasons : audit?.released ? [] : ["cleanup_watcher_failed"]
      };
      await session.recordVerificationCleanup(runId, cleanup).catch(() => undefined);
    }).finally(() => verificationWatchers.delete(key));
    verificationWatchers.set(key, watcher);
  };

  const reconcileVerification = async (workspace: Workspace, runId: string, requestedSpaceId?: string): Promise<{ binding: VerificationBinding; state: BrowserVerificationRunState }> => {
    const resolved = await resolveVerificationBinding(workspace, runId, requestedSpaceId);
    let state = resolved.state;
    if (isTerminalVerificationRunStatus(state.status)) state = await cleanupVerification(resolved.binding, runId, state);
    else scheduleVerificationWatcher(resolved.binding, runId);
    return { binding: resolved.binding, state };
  };

  const definitions: BrowserToolDefinition[] = [
    {
      name: "browser_space_create",
      title: "Create Browser Space",
      description: "Create a named Browser Task Space with isolated tabs, flows, snapshots, downloads, reports, and resource state. shared_profile reuses login state; isolated_context starts without profile cookies.",
      inputSchema: {
        workspace_id: workspaceArg(),
        space_id: browserSpaceIdSchema.describe("Unique space id within the workspace."),
        mode: browserSpaceModeSchema.optional().describe("shared_profile (default), isolated_context, or disabled isolated_profile."),
        owner_task_id: z.string().min(1).optional(),
        owner_run_id: browserSpaceIdSchema.optional().describe("Run identity used for the persisted manifest path. Omit for workspace-scoped use.")
      },
      safety: "write",
      invoking: "Creating Browser Task Space...",
      invoked: "Browser Task Space created",
      async handler(args) {
        const manifest = await spaces.create(workspaceFor(args), {
          space_id: args.space_id,
          mode: args.mode,
          owner_task_id: args.owner_task_id,
          owner_run_id: args.owner_run_id
        });
        return {
          text: ["# Browser Space Created", "", `Space: ${manifest.space_id}`, `Mode: ${manifest.mode}`, `Status: ${manifest.status}`, `Manifest: .codexpro/runs/${manifest.owner_run_id ?? "workspace"}/browser-spaces/${manifest.space_id}/manifest.json`].join("\n"),
          structured: { browser_space: manifest }
        };
      }
    },
    {
      name: "browser_space_list",
      title: "List Browser Spaces",
      description: "List persisted Browser Task Spaces for the workspace without exposing cookies, tokens, passwords, or browser storage.",
      inputSchema: { workspace_id: workspaceArg() },
      safety: "read",
      invoking: "Listing Browser Task Spaces...",
      invoked: "Browser Task Spaces ready",
      async handler(args) {
        const manifests = await spaces.list(workspaceFor(args));
        return {
          text: ["# Browser Spaces", "", `${manifests.length} space(s).`, formatJsonBlock(manifests)].join("\n"),
          structured: { browser_spaces: manifests, count: manifests.length }
        };
      }
    },
    {
      name: "browser_space_status",
      title: "Browser Space Status",
      description: "Read one Browser Task Space manifest and rescan its visible tabs to refresh owned versus external tab metadata.",
      inputSchema: { workspace_id: workspaceArg(), space_id: spaceArg() },
      safety: "read",
      invoking: "Reading Browser Task Space status...",
      invoked: "Browser Task Space status ready",
      async handler(args) {
        const manifest = await spaces.status(workspaceFor(args), args.space_id ?? BROWSER_SPACE_DEFAULT_ID, true);
        return {
          text: ["# Browser Space Status", "", `Space: ${manifest.space_id}`, `Mode: ${manifest.mode}`, `Status: ${manifest.status}`, `Owned tabs: ${manifest.controlled_tab_ids.length}`, `Active flow: ${manifest.active_flow_id ?? "none"}`, `Report root: ${manifest.report_root}`].join("\n"),
          structured: { browser_space: manifest }
        };
      }
    },
    {
      name: "browser_space_activate",
      title: "Activate Browser Space",
      description: "Mark a Browser Task Space active for operator visibility. Existing tools still default to the literal default space unless space_id is supplied.",
      inputSchema: { workspace_id: workspaceArg(), space_id: browserSpaceIdSchema },
      safety: "write",
      invoking: "Activating Browser Task Space...",
      invoked: "Browser Task Space activated",
      async handler(args) {
        const manifest = await spaces.activate(workspaceFor(args), args.space_id);
        return { text: ["# Browser Space Activated", "", `Space: ${manifest.space_id}`, `Status: ${manifest.status}`].join("\n"), structured: { browser_space: manifest } };
      }
    },
    {
      name: "browser_space_close",
      title: "Close Browser Space",
      description: "Close only pages owned by this space, release its resource lease, and preserve other spaces and external tabs.",
      inputSchema: { workspace_id: workspaceArg(), space_id: browserSpaceIdSchema },
      safety: "write",
      invoking: "Closing Browser Task Space...",
      invoked: "Browser Task Space closed",
      async handler(args) {
        const manifest = await spaces.close(workspaceFor(args), args.space_id);
        return { text: ["# Browser Space Closed", "", `Space: ${manifest.space_id}`, `Status: ${manifest.status}`, "Other spaces and external tabs were preserved."].join("\n"), structured: { browser_space: manifest } };
      }
    },
    {
      name: "browser_space_reset",
      title: "Reset Browser Space",
      description: "Reset one space after verifying that it has no active flow. Its owned pages and ephemeral context are discarded while other spaces remain intact.",
      inputSchema: { workspace_id: workspaceArg(), space_id: browserSpaceIdSchema },
      safety: "write",
      invoking: "Resetting Browser Task Space...",
      invoked: "Browser Task Space reset",
      async handler(args) {
        const manifest = await spaces.reset(workspaceFor(args), args.space_id);
        return { text: ["# Browser Space Reset", "", `Space: ${manifest.space_id}`, `Status: ${manifest.status}`, `Session: ${manifest.browser_session_id}`].join("\n"), structured: { browser_space: manifest } };
      }
    },
    {
      name: "browser_status",
      title: "Browser Status",
      description: "Return Browser Bridge connection state, requested/effective mode, fallback reason, profile verification, and tab count without starting a browser.",
      inputSchema: {
        workspace_id: workspaceArg()
      },
      safety: "read",
      invoking: "Reading Browser Bridge status...",
      invoked: "Browser Bridge status ready",
      async handler(args) {
        const status = sessionFor(args).status();
        return {
          text: ["# Browser Status", "", ...bridgeText(status)].join("\n"),
          structured: { bridge: serializeBridgeStatus(status) }
        };
      }
    },
    {
      name: "browser_runtime_probe",
      title: "Browser Runtime Probe",
      description: "Run a layered, read-only Browser Bridge probe against the current dedicated Chrome page. It may connect and create a controlled blank tab when needed, but it never navigates, refreshes, clicks, types, or captures screenshots.",
      inputSchema: {
        workspace_id: workspaceArg(),
        max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.runtime_probe_max_nodes).optional().describe(`Maximum semantic nodes for the final observe probe. Default: ${TOOL_LIMITS.browser.runtime_probe_default_nodes}.`)
      },
      safety: "read",
      invoking: "Probing Browser Bridge runtime layers...",
      invoked: "Browser Bridge runtime probe ready",
      async handler(args) {
        const checkedAt = new Date().toISOString();
        const session = sessionFor(args);
        const layers: Record<string, Record<string, unknown>> = {
          configured: config.browserMode === "cdp" && Boolean(config.browserCdpUrl)
            ? { status: "pass", reason: "CDP mode and endpoint are configured." }
            : { status: "fail", reason: "CDP mode or endpoint is not configured.", recovery: "Configure the dedicated Chrome CDP endpoint." },
          process_alive: { status: "unknown", reason: "The dedicated Chrome session has not been connected by this probe yet." },
          transport_reachable: { status: "unknown", reason: "The CDP endpoint has not been contacted by this probe yet." },
          capability_available: { status: "unknown", reason: "Direct page control has not been proven yet." },
          end_to_end_usable: { status: "unknown", reason: "The semantic observe probe has not run yet." }
        };
        let observation: Record<string, unknown> | null = null;
        try {
          const snapshot = await session.observe({
            scope: "viewport",
            maxNodes: args.max_nodes ?? TOOL_LIMITS.browser.runtime_probe_default_nodes,
            maxTextChars: TOOL_LIMITS.browser.runtime_probe_text_chars,
            includeTables: false,
            includeForms: false,
            includeLayoutIssues: false,
            includeAccessibility: false
          });
          const bridge = session.status();
          layers.process_alive = bridge.connected
            ? { status: "pass", reason: "The dedicated Chrome Browser Bridge session is connected." }
            : { status: "fail", reason: "The Browser Bridge session did not connect.", recovery: "Repair the dedicated Chrome process and CDP endpoint." };
          layers.transport_reachable = bridge.connected
            ? { status: "pass", reason: "The dedicated Chrome CDP endpoint is reachable." }
            : { status: "fail", reason: "The dedicated Chrome CDP endpoint could not be reached.", recovery: "Repair the CDP endpoint." };
          layers.capability_available = bridge.connected
            ? { status: "pass", reason: "Direct CodexPro page control is available without extension authorization." }
            : { status: "fail", reason: "Direct CodexPro page control is unavailable.", recovery: "Repair the Browser Bridge connection." };
          observation = {
            snapshot_id: snapshot.snapshotId,
            session_id: snapshot.sessionId,
            url: snapshot.url,
            title: snapshot.title,
            ready_state: snapshot.readyState,
            element_count: snapshot.elements.length,
            text_chars: snapshot.text.length,
            truncated: snapshot.truncated
          };
          layers.end_to_end_usable = {
            status: "pass",
            reason: "A real semantic observe completed on the current controlled page without navigation or refresh.",
            evidence: observation
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const bridge = session.status();
          layers.process_alive = bridge.connected
            ? { status: "pass", reason: "The dedicated Chrome Browser Bridge session is connected." }
            : { status: "fail", reason: "The Browser Bridge session did not connect.", recovery: "Repair the dedicated Chrome process and CDP endpoint." };
          layers.transport_reachable = bridge.connected
            ? { status: "pass", reason: "The dedicated Chrome CDP endpoint is reachable." }
            : { status: "fail", reason: message, recovery: "Repair the CDP endpoint." };
          layers.capability_available = { status: "fail", reason: message, recovery: "Open a controlled page with browser_open and rerun the probe." };
          layers.end_to_end_usable = { status: "fail", reason: message, recovery: "Open a controlled page with browser_open and rerun the probe." };
        }
        const usable = layers.end_to_end_usable.status === "pass";
        const result = {
          version: 1,
          checked_at: checkedAt,
          usable,
          navigation_performed: false,
          refresh_performed: false,
          observation,
          layers
        };
        return {
          text: [
            "# Browser Runtime Probe",
            "",
            `Usable: ${usable ? "yes" : "no"}`,
            `Observe: ${layers.end_to_end_usable.status}`,
            "Extension authorization: not required",
            "Navigation/refresh performed: no"
          ].join("\n"),
          structured: { runtime_probe: result }
        };
      }
    },
    {
      name: "browser_tabs",
      title: "Browser Tabs",
      description: "Return redacted metadata for tabs visible to Browser Bridge. This does not navigate, switch to, or take control of external tabs.",
      inputSchema: {
        workspace_id: workspaceArg()
      },
      safety: "read",
      invoking: "Reading browser tabs...",
      invoked: "Browser tabs ready",
      async handler(args) {
        const tabs = await sessionFor(args).tabs();
        const serialized = serializeTabs(tabs);
        return {
          text: ["# Browser Tabs", "", `${formatCountLabel(tabs.length, "tab")} visible.`, formatJsonBlock(serialized)].join("\n"),
          structured: { tabs: serialized, count: tabs.length }
        };
      }
    },
    {
      name: "browser_observe",
      title: "Browser Observe",
      description: "Read a bounded, redacted semantic snapshot from the current controlled Chrome page. Returns visible structure, interactive elements with stable refs, tables, forms, layout issues, and optional delta from a prior snapshot without navigating or refreshing.",
      inputSchema: {
        workspace_id: workspaceArg(),
        scope: observeScopeSchema.optional().describe("viewport, document, or selector. Default: viewport."),
        selector: z.string().optional().describe("Required when scope=selector. Stable element refs are also accepted."),
        max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.observe_max_nodes).optional().describe(`Maximum semantic elements. Default: ${TOOL_LIMITS.browser.observe_default_nodes}.`),
        max_text_chars: z.number().int().min(1000).max(TOOL_LIMITS.browser.observe_max_text_chars).optional().describe(`Maximum visible text characters. Default: ${TOOL_LIMITS.browser.observe_default_text_chars}.`),
        include_tables: z.boolean().optional(),
        include_forms: z.boolean().optional(),
        include_layout_issues: z.boolean().optional(),
        include_accessibility: z.boolean().optional(),
        since_snapshot_id: z.string().uuid().optional().describe("Return a delta against a recent snapshot from the same browser session.")
      },
      safety: "read",
      invoking: "Observing current Chrome page...",
      invoked: "Chrome semantic observation ready",
      async handler(args) {
        const snapshot = await sessionFor(args).observe({
          scope: args.scope,
          selector: args.selector,
          maxNodes: args.max_nodes,
          maxTextChars: args.max_text_chars,
          includeTables: args.include_tables,
          includeForms: args.include_forms,
          includeLayoutIssues: args.include_layout_issues,
          includeAccessibility: args.include_accessibility,
          sinceSnapshotId: args.since_snapshot_id
        });
        const session = sessionFor(args);
        let compact: any = serializeSemanticObservation(snapshot);
        let reportPath: string | undefined;
        const initialBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
        if (initialBytes > config.browserObserveMaxResponseBytes) {
          const report = await session.writeReport();
          reportPath = report.path;
          compact = {
            ...compact,
            regions: compact.regions.slice(0, 30),
            elements: compact.elements.slice(0, 100),
            tables: compact.tables.slice(0, 5),
            forms: compact.forms.slice(0, 5),
            issues: compact.issues.slice(0, 50),
            accessibility: compact.accessibility.slice(0, 100),
            text: compact.text.slice(0, 2000),
            truncated: true,
            truncation_reason: `Observation response exceeded ${config.browserObserveMaxResponseBytes} bytes. Full redacted evidence was saved to the Browser Report.`,
            report_path: report.path
          };
        }
        return {
          text: [
            "# Browser Observe",
            "",
            `Snapshot: ${snapshot.snapshotId}`,
            `Session: ${snapshot.sessionId}`,
            `URL: ${snapshot.url}`,
            `Elements: ${snapshot.elements.length}`,
            `Tables: ${snapshot.tables.length}`,
            `Forms: ${snapshot.forms.length}`,
            `Issues: ${snapshot.issues.length}`,
            snapshot.changes ? `Delta: ${snapshot.changes.addedRefs.length} added, ${snapshot.changes.removedRefs.length} removed, ${snapshot.changes.changed.length} changed` : "Delta: full snapshot",
            reportPath ? `Report: ${reportPath}` : ""
          ].filter(Boolean).join("\n"),
          structured: { observation: compact }
        };
      }
    },
    {
      name: "browser_inspect",
      title: "Browser Inspect",
      description: "Run a semantic-first, read-only inspection. It captures bounded visual evidence only for an explicit governed reason, fuses evidence without pseudo-precision, records conflicts and limitations, and never authorizes interaction.",
      inputSchema: {
        workspace_id: workspaceArg(),
        request: z.string().min(1).max(2000).describe("What should be inspected. Text/table/form/URL requests stay semantic-only; visual needs are routed by governed reasons."),
        semantic_scope: observeScopeSchema.optional().describe("Semantic observation scope. Default: document."),
        semantic_selector: z.string().optional().describe("Required when semantic_scope=selector."),
        max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.observe_max_nodes).optional(),
        max_text_chars: z.number().int().min(1000).max(TOOL_LIMITS.browser.observe_max_text_chars).optional(),
        visual_reason: visualReasonSchema.optional().describe("Optional explicit governed visual reason. Omit to let the semantic-first router decide."),
        visual_scope: browserInspectionVisualScopeSchema.optional().describe("Optional bounded viewport, selector, region, or frame scope. Non-viewport scopes require a stable ref or selector target.")
      },
      safety: "read",
      invoking: "Inspecting browser evidence...",
      invoked: "Browser inspection ready",
      async handler(args) {
        const session = sessionFor(args);
        const snapshot = await session.observe({
          scope: args.semantic_scope ?? "document",
          selector: args.semantic_selector,
          maxNodes: args.max_nodes ?? Math.min(config.browserObserveMaxNodes, TOOL_LIMITS.browser.inspect_default_nodes),
          maxTextChars: args.max_text_chars ?? Math.min(config.browserObserveMaxTextChars, TOOL_LIMITS.browser.inspect_default_text_chars),
          includeTables: true,
          includeForms: true,
          includeLayoutIssues: true,
          includeAccessibility: true
        });
        const route = routeBrowserObservation({
          request: args.request,
          snapshot,
          visual_reason: args.visual_reason,
          visual_scope: args.visual_scope
        });
        const inspectionId = `browser-inspection-${randomUUID()}`;
        const createdAt = new Date().toISOString();
        const evidence = semanticEvidenceFacts(args.request, snapshot);
        const visualEvidence = [];
        if (route.visual_requested && route.visual_reason && route.visual_scope) {
          const workspace = workspaceFor(args);
          const spaceId = args.space_id ?? BROWSER_SPACE_DEFAULT_ID;
          const owner = `tool-browser_inspect-${randomUUID()}`;
          if (!await spaces.acquireResource(workspace, spaceId, owner, "visual")) {
            throw new CodexProError(`Browser Space ${spaceId} is waiting_resource for visual; retry after the active lease is released.`);
          }
          try {
            const scope = route.visual_scope;
            const visual = await session.visualObserve({
              scope: scope.kind,
              selector: scope.target,
              reason: route.visual_reason,
              linkedSnapshotId: snapshot.snapshotId,
              name: `${inspectionId}-${route.visual_reason}`
            });
            const governed = browserVisualEvidenceSchema.parse({
              evidence_ref: `browser_visual:${visual.path}`,
              reason: route.visual_reason,
              scope: `${scope.kind}${scope.target ? `:${scope.target}` : ""}`,
              image_path: visual.path,
              linked_snapshot_id: snapshot.snapshotId,
              may_authorize_interaction: false
            });
            visualEvidence.push(governed);
            evidence.push(visualCaptureEvidenceFact({ path: visual.path, reason: route.visual_reason, linked_snapshot_id: snapshot.snapshotId }));
          } finally {
            await spaces.releaseResource(workspace, spaceId, owner, "visual");
          }
        }
        const fused = fuseBrowserEvidence({
          inspection_id: inspectionId,
          semantic_snapshot_id: snapshot.snapshotId,
          evidence,
          visual_evidence: visualEvidence,
          created_at: createdAt
        });
        const paths = inspectionArtifactPaths(session.reportRoot(), inspectionId);
        const limitations = route.visual_requested
          ? ["Visual evidence is redacted and linked to the semantic snapshot, but it cannot provide interaction authority or replace a stable DOM reference."]
          : [];
        const inspection = createBrowserInspectionResult({
          inspection_id: inspectionId,
          session_id: snapshot.sessionId,
          space_id: snapshot.spaceId,
          page_id: snapshot.pageId,
          semantic_snapshot_id: snapshot.snapshotId,
          route,
          facts: fused.facts,
          conflicts: fused.conflicts,
          report_path: paths.inspection,
          limitations,
          created_at: createdAt
        });
        const persisted = await session.persistInspectionArtifacts({ inspection, multimodal: fused.multimodal, conflicts: fused.conflicts });
        const report = await session.writeReport();
        return {
          text: [
            "# Browser Inspect",
            "",
            `Inspection: ${inspection.inspection_id}`,
            `Snapshot: ${inspection.semantic_snapshot_id}`,
            `Semantic completeness: ${inspection.semantic_completeness}`,
            `Visual requested: ${inspection.visual_requested ? "yes" : "no"}`,
            inspection.visual_reason ? `Visual reason: ${inspection.visual_reason}` : "",
            inspection.visual_scope ? `Visual scope: ${inspection.visual_scope.kind}${inspection.visual_scope.target ? `:${inspection.visual_scope.target}` : ""}` : "",
            `Facts: ${inspection.facts.length}`,
            `Conflicts: ${inspection.conflicts.length}`,
            `Inspection evidence: ${persisted.inspectionPath}`,
            `Browser Report: ${report.path}`
          ].filter(Boolean).join("\n"),
          structured: {
            inspection,
            multimodal_evidence: fused.multimodal,
            evidence_conflicts: fused.conflicts,
            evidence_paths: persisted,
            browser_report_path: report.path,
            interaction_authorized_by_visual: false
          }
        };
      }
    },
    {
      name: "browser_observe_continue",
      title: "Browser Observe Continue",
      description: "Continue a Semantic Snapshot v3 document observation from an opaque cursor. The cursor is single-use and fails closed after navigation or semantic revision changes.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cursor: z.string().uuid().describe("Opaque next_cursor returned by browser_observe or browser_observe_continue.")
      },
      safety: "read",
      invoking: "Reading the next semantic snapshot chunk...",
      invoked: "Semantic snapshot chunk ready",
      async handler(args) {
        const snapshot = await sessionFor(args).observeContinue(args.cursor);
        let observation: any = serializeSemanticObservation(snapshot);
        if (Buffer.byteLength(JSON.stringify(observation), "utf8") > config.browserObserveMaxResponseBytes) {
          observation = {
            ...observation,
            regions: observation.regions.slice(0, 30),
            elements: observation.elements.slice(0, 100),
            tables: observation.tables.slice(0, 5),
            forms: observation.forms.slice(0, 5),
            issues: observation.issues.slice(0, 50),
            accessibility: observation.accessibility.slice(0, 100),
            text: observation.text.slice(0, 2000),
            truncated: true,
            truncation_reason: `Observation response exceeded ${config.browserObserveMaxResponseBytes} bytes; full redacted chunk is at ${snapshot.evidencePath}.`
          };
        }
        return {
          text: ["# Browser Observe Continue", "", `Snapshot: ${snapshot.snapshotId}`, `Chunk: ${snapshot.pagination.chunkIndex}`, `URL: ${snapshot.url}`, `Has more: ${snapshot.pagination.hasMore ? "yes" : "no"}`, `Evidence: ${snapshot.evidencePath}`].join("\n"),
          structured: { observation }
        };
      }
    },
    {
      name: "browser_extract_table",
      title: "Browser Extract Table",
      description: "Extract a bounded, redacted table or virtualized grid from a table ref in a Semantic Snapshot v3. Reports sampling limits and never claims a sample is complete.",
      inputSchema: {
        workspace_id: workspaceArg(),
        snapshot_id: z.string().uuid(),
        table_ref: z.string().regex(/^[er]\d+$/),
        max_rows: z.number().int().min(1).max(TOOL_LIMITS.browser.extract_table_max_rows).optional().describe(`Maximum deduplicated rows. Default: ${TOOL_LIMITS.browser.extract_table_default_rows}.`),
        max_scrolls: z.number().int().min(0).max(TOOL_LIMITS.browser.extract_table_max_scrolls).optional().describe(`Maximum bounded scroll samples. Default: ${TOOL_LIMITS.browser.extract_table_default_scrolls}.`),
        unique_key_hint: z.string().min(1).optional().describe("Optional column label or key used for row deduplication.")
      },
      safety: "read",
      invoking: "Extracting bounded browser table data...",
      invoked: "Browser table extraction ready",
      async handler(args) {
        const extraction = await sessionFor(args).extractTable({
          snapshotId: args.snapshot_id,
          tableRef: args.table_ref,
          maxRows: args.max_rows,
          maxScrolls: args.max_scrolls,
          uniqueKeyHint: args.unique_key_hint
        });
        const structured = {
          version: extraction.version,
          extraction_id: extraction.extractionId,
          snapshot_id: extraction.snapshotId,
          session_id: extraction.sessionId,
          space_id: extraction.spaceId,
          table_ref: extraction.tableRef,
          columns: extraction.columns,
          rows: extraction.rows,
          unique_key: extraction.uniqueKey,
          deduplicated_rows: extraction.deduplicatedRows,
          loaded_range: extraction.loadedRange,
          limits: { max_rows: extraction.maxRows, max_scrolls: extraction.maxScrolls, scrolls_used: extraction.scrollsUsed },
          completeness: extraction.completeness,
          possible_more: extraction.possibleMore,
          virtual: extraction.virtual,
          limitations: extraction.limitations,
          redacted: extraction.redacted,
          evidence_path: extraction.evidencePath
        };
        const response = Buffer.byteLength(JSON.stringify(structured), "utf8") > config.browserObserveMaxResponseBytes
          ? { ...structured, rows: extraction.rows.slice(0, 20), response_truncated: true }
          : structured;
        return {
          text: ["# Browser Extract Table", "", `Rows: ${extraction.rows.length}`, `Completeness: ${extraction.completeness}`, `Possible more: ${extraction.possibleMore ? "yes" : "no"}`, `Evidence: ${extraction.evidencePath}`].join("\n"),
          structured: { extraction: response }
        };
      }
    },
    {
      name: "browser_flow_prepare",
      title: "Prepare Browser Flow",
      description: "Validate and freeze a declarative multi-step browser flow against an existing Browser Business Task, platform skill, risk boundary, branch facts, repeat bounds, and permanent final-action blocks.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task: browserBusinessTaskSchema.optional().describe("Full prepared browser_business_task. Use either this or task_id+run_id."),
        task_id: z.string().min(1).optional().describe("Persisted task id. Must be paired with run_id."),
        run_id: z.string().min(1).optional().describe("Persisted run id. Must be paired with task_id."),
        space_id: spaceArg(),
        skill_ref: z.string().min(1).optional().describe("Optional existing platform skill id to validate against the task."),
        steps: z.array(browserFlowStepSchema).min(1).max(TOOL_LIMITS.browser.flow_max_steps),
        success_criteria: z.array(z.string().min(1)).min(1).optional()
      },
      safety: "read",
      invoking: "Preparing immutable browser flow...",
      invoked: "Browser flow prepared",
      async handler(args) {
        const workspace = workspaceFor(args);
        const hasFullTask = args.task !== undefined;
        const hasTaskReference = Boolean(args.task_id || args.run_id);
        if (hasFullTask === hasTaskReference) throw new Error("Provide exactly one browser task source: full task, or task_id together with run_id.");
        if (hasTaskReference && (!args.task_id || !args.run_id)) throw new Error("Both task_id and run_id are required for a persisted browser task reference.");
        const task = hasFullTask
          ? validateBrowserBusinessTask(args.task)
          : await loadPersistedBrowserBusinessTask(guard, workspace, String(args.task_id), String(args.run_id));
        await spaces.bindTask(workspace, args.space_id ?? BROWSER_SPACE_DEFAULT_ID, task.task_id, task.run_id);
        if (args.skill_ref) {
          const loaded = await readProjectPlatformSkill(config, guard, workspace, args.skill_ref);
          validateSkillForTask(loaded.skill, task);
        }
        const prepared = await flows.prepare(workspace, task, {
          space_id: args.space_id ?? "default",
          skill_ref: args.skill_ref,
          steps: args.steps,
          success_criteria: args.success_criteria
        });
        return {
          text: [
            "# Browser Flow Prepared",
            "",
            `Flow ID: ${prepared.contract.flow_id}`,
            `Run ID: ${prepared.contract.run_id}`,
            `Contract: ${prepared.contractPath}`,
            `State: ${prepared.statePath}`,
            `Steps: ${prepared.contract.steps.length}`,
            `Risk: ${prepared.contract.risk_class}`
          ].join("\n"),
          structured: {
            browser_flow: prepared.contract,
            state: serializeFlowState(prepared.state),
            contract_path: prepared.contractPath,
            state_path: prepared.statePath
          }
        };
      }
    },
    {
      name: "browser_flow_run",
      title: "Run Browser Flow",
      description: "Queue a prepared browser flow for bounded background execution and return immediately with its flow id. Detailed evidence remains on disk.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().min(1),
        flow_id: z.string().uuid()
      },
      safety: "write",
      invoking: "Starting browser flow...",
      invoked: "Browser flow started",
      async handler(args) {
        const preparedState = await flows.status(workspaceFor(args), args.run_id, args.flow_id);
        assertFlowSpace(args, preparedState);
        const state = await flows.run(workspaceFor(args), args.run_id, args.flow_id);
        const paths = browserFlowPaths(args.run_id, args.flow_id);
        return {
          text: ["# Browser Flow Started", "", `Flow ID: ${state.flow_id}`, `Run ID: ${state.run_id}`, `Status: ${state.status}`, `State: ${paths.statePath}`].join("\n"),
          structured: { flow_id: state.flow_id, run_id: state.run_id, status: state.status, state_path: paths.statePath }
        };
      }
    },
    {
      name: "browser_flow_status",
      title: "Browser Flow Status",
      description: "Read compact persisted progress, current step, completed steps, recovery eligibility, blocking reason, and evidence references for a browser flow.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().min(1),
        flow_id: z.string().uuid()
      },
      safety: "read",
      invoking: "Reading browser flow status...",
      invoked: "Browser flow status ready",
      async handler(args) {
        const state = await flows.status(workspaceFor(args), args.run_id, args.flow_id);
        assertFlowSpace(args, state);
        const compact = serializeFlowState(state);
        return {
          text: [
            "# Browser Flow Status",
            "",
            `Flow ID: ${state.flow_id}`,
            `Status: ${state.status}`,
            `Current step: ${state.current_step_id ?? "none"}`,
            `Completed: ${state.steps.filter((step) => step.status === "passed" || step.status === "skipped").length}/${state.steps.length}`,
            `Resume count: ${state.resume_count}`,
            state.blocking_reason ? `Blocking reason: ${state.blocking_reason}` : ""
          ].filter(Boolean).join("\n"),
          structured: { flow_state: compact, state_path: browserFlowPaths(args.run_id, args.flow_id).statePath }
        };
      }
    },
    {
      name: "browser_flow_resume",
      title: "Resume Browser Flow",
      description: "Resume only unfinished recoverable steps. Passed steps and non-retryable browser side effects are preserved and never repeated.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().min(1),
        flow_id: z.string().uuid()
      },
      safety: "write",
      invoking: "Resuming browser flow...",
      invoked: "Browser flow resumed",
      async handler(args) {
        const current = await flows.status(workspaceFor(args), args.run_id, args.flow_id);
        assertFlowSpace(args, current);
        const state = await flows.resume(workspaceFor(args), args.run_id, args.flow_id);
        return {
          text: ["# Browser Flow Resumed", "", `Flow ID: ${state.flow_id}`, `Status: ${state.status}`, `Resume count: ${state.resume_count}`].join("\n"),
          structured: { flow_id: state.flow_id, run_id: state.run_id, status: state.status, resume_count: state.resume_count, state_path: browserFlowPaths(args.run_id, args.flow_id).statePath }
        };
      }
    },
    {
      name: "browser_flow_result",
      title: "Browser Flow Result",
      description: "Return the final structured facts, completion proof or human handoff package, limitations, report, and evidence paths for a terminal browser flow.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().min(1),
        flow_id: z.string().uuid()
      },
      safety: "read",
      invoking: "Reading browser flow result...",
      invoked: "Browser flow result ready",
      async handler(args) {
        const current = await flows.status(workspaceFor(args), args.run_id, args.flow_id);
        assertFlowSpace(args, current);
        const result = await flows.result(workspaceFor(args), args.run_id, args.flow_id);
        const compact = serializeFlowResult(result);
        return {
          text: [
            "# Browser Flow Result",
            "",
            `Flow ID: ${result.flow_id}`,
            `Status: ${result.status}`,
            `Completed steps: ${result.completed_step_ids.length}`,
            `Unresolved steps: ${result.unresolved_step_ids.length}`,
            `Facts: ${result.facts.length}`,
            result.report_path ? `Report: ${result.report_path}` : "",
            `Result: ${browserFlowPaths(args.run_id, args.flow_id).resultPath}`
          ].filter(Boolean).join("\n"),
          structured: { flow_result: compact, result_path: browserFlowPaths(args.run_id, args.flow_id).resultPath }
        };
      }
    },
    {
      name: "browser_flow_cancel",
      title: "Cancel Browser Flow",
      description: "Safely stop future browser flow steps without rolling back completed browser reads, local evidence, or already completed low-risk interactions.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().min(1),
        flow_id: z.string().uuid()
      },
      safety: "write",
      invoking: "Cancelling browser flow...",
      invoked: "Browser flow cancelled",
      async handler(args) {
        const current = await flows.status(workspaceFor(args), args.run_id, args.flow_id);
        assertFlowSpace(args, current);
        const state = await flows.cancel(workspaceFor(args), args.run_id, args.flow_id);
        return {
          text: ["# Browser Flow Cancelled", "", `Flow ID: ${state.flow_id}`, `Status: ${state.status}`, "Completed steps and evidence were preserved."].join("\n"),
          structured: { flow_state: serializeFlowState(state), state_path: browserFlowPaths(args.run_id, args.flow_id).statePath }
        };
      }
    },
    {
      name: "browser_observe_region",
      title: "Browser Observe Region",
      description: "Read a bounded semantic snapshot for one selector or stable element ref without navigating or refreshing.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional(),
        ref: z.string().regex(/^[er]\d+$/).optional(),
        max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.observe_max_nodes).optional(),
        max_text_chars: z.number().int().min(1000).max(TOOL_LIMITS.browser.observe_max_text_chars).optional(),
        since_snapshot_id: z.string().uuid().optional()
      },
      safety: "read",
      invoking: "Observing browser region...",
      invoked: "Browser region observation ready",
      async handler(args) {
        const session = sessionFor(args);
        if (typeof args.ref === "string" && /^r\d+$/.test(args.ref)) {
          const element = await session.getElement(args.ref);
          return {
            text: ["# Browser Observe Region", "", `Read-only ref: ${args.ref}`, formatJsonBlock(element)].join("\n"),
            structured: { observation: { snapshot_version: 3, source: "native_cdp", element, actionable: false } }
          };
        }
        const snapshot = await session.observe({
          scope: "selector",
          selector: targetFor(args),
          maxNodes: args.max_nodes ?? Math.min(config.browserObserveMaxNodes, TOOL_LIMITS.browser.region_default_nodes),
          maxTextChars: args.max_text_chars ?? Math.min(config.browserObserveMaxTextChars, TOOL_LIMITS.browser.region_default_text_chars),
          sinceSnapshotId: args.since_snapshot_id
        });
        let observation: any = snapshot;
        let reportPath: string | undefined;
        if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > config.browserObserveMaxResponseBytes) {
          const report = await session.writeReport();
          reportPath = report.path;
          observation = {
            snapshotId: snapshot.snapshotId,
            previousSnapshotId: snapshot.previousSnapshotId,
            timestamp: snapshot.timestamp,
            sessionId: snapshot.sessionId,
            url: snapshot.url,
            title: snapshot.title,
            readyState: snapshot.readyState,
            viewport: snapshot.viewport,
            scroll: snapshot.scroll,
            device: snapshot.device,
            regions: snapshot.regions.slice(0, 20),
            elements: snapshot.elements.slice(0, 100),
            tables: snapshot.tables.slice(0, 5),
            forms: snapshot.forms.slice(0, 5),
            issues: snapshot.issues.slice(0, 50),
            accessibility: snapshot.accessibility.slice(0, 100),
            domSnapshotNodeCount: snapshot.domSnapshotNodeCount,
            text: snapshot.text.slice(0, 2000),
            changes: snapshot.changes,
            truncated: true,
            truncationReason: `Region observation exceeded ${config.browserObserveMaxResponseBytes} bytes.`,
            reportPath: report.path
          };
        }
        return {
          text: ["# Browser Observe Region", "", `Snapshot: ${snapshot.snapshotId}`, `Session: ${snapshot.sessionId}`, `URL: ${snapshot.url}`, `Elements: ${snapshot.elements.length}`, `Issues: ${snapshot.issues.length}`, reportPath ? `Report: ${reportPath}` : ""].filter(Boolean).join("\n"),
          structured: { observation }
        };
      }
    },
    {
      name: "browser_get_element",
      title: "Browser Get Element",
      description: "Return a redacted semantic summary for one selector or stable element ref from the current page.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional(),
        ref: z.string().regex(/^[er]\d+$/).optional(),
        timeout_ms: z.number().int().min(250).max(60000).optional()
      },
      safety: "read",
      invoking: "Reading browser element...",
      invoked: "Browser element ready",
      async handler(args) {
        const element = await sessionFor(args).getElement(targetFor(args), args.timeout_ms ?? 5000);
        return { text: ["# Browser Get Element", "", formatJsonBlock(element)].join("\n"), structured: { element } };
      }
    },
    {
      name: "browser_select",
      title: "Browser Select",
      description: "Select a low-risk option by value or label using a selector or stable element ref.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional(),
        ref: z.string().regex(/^e\d+$/).optional(),
        value: z.string().optional(),
        label: z.string().optional(),
        timeout_ms: z.number().int().min(250).max(60000).optional()
      },
      safety: "write",
      invoking: "Selecting browser option...",
      invoked: "Browser option selected",
      async handler(args) {
        if (args.value === undefined && args.label === undefined) throw new Error("Provide value or label.");
        const entry = await sessionFor(args).select(targetFor(args), { value: args.value, label: args.label, timeoutMs: args.timeout_ms });
        return { text: ["# Browser Select", "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"), structured: { interaction: entry } };
      }
    },
    {
      name: "browser_check",
      title: "Browser Check",
      description: "Check or uncheck a low-risk checkbox using a selector or stable element ref.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional(),
        ref: z.string().regex(/^e\d+$/).optional(),
        checked: z.boolean().optional().describe("Default: true."),
        timeout_ms: z.number().int().min(250).max(60000).optional()
      },
      safety: "write",
      invoking: "Updating browser checkbox...",
      invoked: "Browser checkbox updated",
      async handler(args) {
        const entry = await sessionFor(args).check(targetFor(args), args.checked !== false, args.timeout_ms ?? 5000);
        return { text: ["# Browser Check", "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"), structured: { interaction: entry } };
      }
    },
    {
      name: "browser_scroll_into_view",
      title: "Browser Scroll Into View",
      description: "Scroll one selector or stable element ref into view without clicking it.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional(),
        ref: z.string().regex(/^e\d+$/).optional(),
        timeout_ms: z.number().int().min(250).max(60000).optional()
      },
      safety: "read",
      invoking: "Scrolling browser element into view...",
      invoked: "Browser element in view",
      async handler(args) {
        const entry = await sessionFor(args).scrollIntoView(targetFor(args), args.timeout_ms ?? 5000);
        return { text: ["# Browser Scroll Into View", "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"), structured: { interaction: entry } };
      }
    },
    {
      name: "browser_visual_observe",
      title: "Browser Visual Observe",
      description: "Automatically capture the current Chrome rendering only when pixel-level evidence is required. Does not navigate or refresh the page.",
      inputSchema: {
        workspace_id: workspaceArg(),
        scope: visualScopeSchema.optional().describe("viewport, full_page, or selector. Default: viewport."),
        selector: z.string().optional().describe("Required when scope=selector; stable element refs are accepted."),
        reason: visualReasonSchema.describe("Why pixel evidence is required."),
        name: z.string().optional().describe("Optional artifact filename stem.")
      },
      safety: "write",
      invoking: "Capturing necessary visual evidence...",
      invoked: "Visual evidence captured",
      async handler(args) {
        const session = sessionFor(args);
        const semantic = await session.observe({
          scope: args.scope === "selector" ? "selector" : "viewport",
          selector: args.scope === "selector" ? args.selector : undefined,
          maxNodes: Math.min(config.browserObserveMaxNodes, 300),
          maxTextChars: Math.min(config.browserObserveMaxTextChars, 16_000),
          includeTables: true,
          includeForms: true,
          includeLayoutIssues: true,
          includeAccessibility: true
        });
        const entry = await session.visualObserve({
          scope: args.scope,
          selector: args.selector,
          reason: args.reason,
          name: args.name,
          linkedSnapshotId: semantic.snapshotId
        });
        return {
          text: ["# Browser Visual Observe", "", `Path: ${entry.path}`, `Reason: ${entry.reason}`, `Scope: ${entry.scope}`, `Device: ${entry.device}`, `URL: ${entry.url ?? "unknown"}`].join("\n"),
          structured: { visual: entry }
        };
      }
    },
    {
      name: "browser_verification_run",
      title: "Browser Verification Run",
      description: "Start a bounded, serial, resumable verification in a newly created dedicated Browser Space. Task-owned tabs and the space are closed on every terminal outcome by default; retain_browser must be explicitly true to keep them.",
      inputSchema: {
        workspace_id: workspaceArg(),
        pages: z.array(z.object({
          url: z.string().url(),
          label: z.string().optional(),
          expect_text: z.string().optional(),
          visual: z.boolean().optional(),
          visual_reason: visualReasonSchema.optional()
        })).min(1).max(config.browserVerificationMaxPages),
        devices: z.array(deviceSchema).min(1).max(TOOL_LIMITS.browser.verification_max_devices).optional().describe("Default: desktop."),
        timeout_ms: z.number().int().min(1_000).max(1_800_000).optional().describe("Maximum execution time. Default: 600000 ms."),
        retain_browser: z.boolean().optional().describe("Explicit opt-in to keep the verification space and its tabs after completion. Default: false.")
      },
      safety: "write",
      invoking: "Starting bounded browser verification...",
      invoked: "Browser verification started",
      async handler(args) {
        const workspace = workspaceFor(args);
        const runId = randomUUID();
        const spaceId = verificationSpaceId(runId);
        const retainBrowser = Boolean(args.retain_browser);
        const timeoutMs = args.timeout_ms ?? 600_000;
        await spaces.create(workspace, {
          space_id: spaceId,
          mode: "shared_profile",
          owner_task_id: `browser-verification-${runId.slice(0, 8)}`,
          owner_run_id: runId
        });
        try {
          const session = spaces.sessionFor(workspace, spaceId);
          const state = await session.startVerification({
            runId,
            spaceId,
            retainBrowser,
            timeoutMs,
            pages: args.pages.map((page: any) => ({
              url: page.url,
              label: page.label,
              expectText: page.expect_text,
              visual: page.visual,
              visualReason: page.visual_reason
            })),
            devices: args.devices
          });
          const binding = { workspace, spaceId, retainBrowser, timeoutMs };
          verificationBindings.set(verificationKey(workspace, runId), binding);
          await spaces.refreshTabs(workspace, spaceId).catch(() => undefined);
          scheduleVerificationWatcher(binding, runId);
          return {
            text: ["# Browser Verification Run", "", `Run ID: ${state.runId}`, `Browser Space: ${spaceId}`, `Session ID: ${state.sessionId}`, `Steps: ${state.steps.length}`, `Retain browser: ${retainBrowser ? "yes" : "no"}`, `Timeout: ${timeoutMs} ms`, `Created tabs: ${(state.createdTabIds ?? []).join(", ") || "pending"}`, `State: ${state.statePath}`, `Report: ${state.reportPath}`].join("\n"),
            structured: { run_id: state.runId, space_id: spaceId, status: state.status, step_count: state.steps.length, retain_browser: retainBrowser, timeout_ms: timeoutMs, created_tab_ids: state.createdTabIds ?? [], cleanup_status: state.cleanup?.status ?? "pending", state_path: state.statePath, report_path: state.reportPath }
          };
        } catch (error) {
          if (!retainBrowser) await spaces.close(workspace, spaceId).catch(() => undefined);
          throw error;
        }
      }
    },
    {
      name: "browser_verification_status",
      title: "Browser Verification Status",
      description: "Read the compact status of a bounded browser verification run without repeating completed pages.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().uuid(),
        space_id: spaceArg()
      },
      safety: "read",
      invoking: "Reading browser verification status...",
      invoked: "Browser verification status ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const { binding, state } = await reconcileVerification(workspace, args.run_id, args.space_id);
        const failures = state.steps
          .filter((step) => step.status === "failed" || step.status === "blocked")
          .map((step) => ({ index: step.index, page_id: step.pageId, label: step.label, device: step.device, status: step.status, recovery_status: step.recoveryStatus, error: step.error }));
        return {
          text: [
            "# Browser Verification Status",
            "",
            `Run ID: ${state.runId}`,
            `Browser Space: ${binding.spaceId}`,
            `Status: ${state.status}`,
            `Cleanup: ${state.cleanup?.status ?? "pending"}`,
            `Resources released: ${state.cleanup?.resourceReleased ? "yes" : "no"}`,
            `Resource leak: ${state.cleanup?.leakDetected ? "yes" : "no"}`,
            `Recovery: ${state.recoveryStatus ?? "not_needed"}`,
            `Completed: ${state.completedSteps}/${state.steps.length}`,
            `Failed: ${state.failedSteps}`,
            `Blocked: ${state.blockedSteps ?? 0}`,
            `Pending: ${state.pendingSteps ?? 0}`,
            `Original Session: ${state.originalSessionId ?? state.sessionId}`,
            `Current Session: ${state.currentSessionId ?? state.sessionId}`,
            `Recovery Attempts: ${state.recoveryAttempts ?? 0}`,
            `Session Rebuilds: ${state.sessionRebuildCount ?? 0}`,
            `Unexpected Refreshes: ${state.unexpectedRefreshCount ?? 0}`,
            `Console Errors: ${state.consoleErrorCount ?? 0}`,
            `Network Failures: ${state.networkFailureCount ?? 0}`,
            `State: ${state.statePath}`,
            failures.length ? formatJsonBlock(failures) : ""
          ].filter(Boolean).join("\n"),
          structured: {
            run_id: state.runId,
            space_id: binding.spaceId,
            status: state.status,
            cleanup_status: state.cleanup?.status ?? "pending",
            resource_released: Boolean(state.cleanup?.resourceReleased),
            resource_leak_detected: Boolean(state.cleanup?.leakDetected),
            resource_leak_reasons: state.cleanup?.leakReasons ?? [],
            created_tab_ids: state.createdTabIds ?? [],
            closed_tab_ids: state.cleanup?.closedTabIds ?? [],
            recovery_status: state.recoveryStatus,
            recovery_reason: state.lastRecoveryReason ?? state.recoveryBlockedReason,
            completed_steps: state.completedSteps,
            total_steps: state.steps.length,
            failed_steps: state.failedSteps,
            blocked_steps: state.blockedSteps ?? 0,
            pending_steps: state.pendingSteps ?? 0,
            original_session_id: state.originalSessionId ?? state.sessionId,
            current_session_id: state.currentSessionId ?? state.sessionId,
            recovery_attempts: state.recoveryAttempts ?? 0,
            session_rebuild_count: state.sessionRebuildCount ?? 0,
            unexpected_refresh_count: state.unexpectedRefreshCount ?? 0,
            console_error_count: state.consoleErrorCount ?? 0,
            network_failure_count: state.networkFailureCount ?? 0,
            failures,
            state_path: state.statePath,
            report_path: state.reportPath
          }
        };
      }
    },
    {
      name: "browser_verification_resume",
      title: "Browser Verification Resume",
      description: "Resume an interrupted or failed bounded verification run from its unfinished steps. Passed steps are preserved and are not repeated.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().uuid(),
        space_id: spaceArg()
      },
      safety: "write",
      invoking: "Resuming browser verification...",
      invoked: "Browser verification resumed",
      async handler(args) {
        const workspace = workspaceFor(args);
        let manifest = args.space_id
          ? await spaces.status(workspace, args.space_id, false)
          : await spaces.findByOwnerRunId(workspace, args.run_id);
        if (!manifest || manifest.owner_run_id !== args.run_id) throw new CodexProError(`Browser verification run ${args.run_id} does not have a matching Browser Space.`);
        let session = spaces.sessionFor(workspace, manifest.space_id);
        const current = await session.verificationStatus(args.run_id);
        if (["completed", "cancelled", "timed_out"].includes(current.status)) {
          if (manifest.status === "closed") {
            await sessions.disconnect(workspace, {
              spaceId: manifest.space_id,
              mode: manifest.mode === "isolated_context" ? "isolated_context" : "shared_profile"
            }).catch(() => undefined);
          }
          return {
            text: ["# Browser Verification Resume", "", `Run ID: ${current.runId}`, `Browser Space: ${manifest.space_id}`, `Status: ${current.status}`, "This terminal run was not reopened."].join("\n"),
            structured: { run_id: current.runId, space_id: manifest.space_id, status: current.status, cleanup_status: current.cleanup?.status ?? "pending", resumed: false, state_path: current.statePath, report_path: current.reportPath }
          };
        }
        if (manifest.status === "closed") {
          await sessions.disconnect(workspace, {
            spaceId: manifest.space_id,
            mode: manifest.mode === "isolated_context" ? "isolated_context" : "shared_profile"
          }).catch(() => undefined);
          manifest = await spaces.reset(workspace, manifest.space_id);
          session = spaces.sessionFor(workspace, manifest.space_id);
        }
        const state = await session.resumeVerification(args.run_id);
        const binding = { workspace, spaceId: manifest.space_id, retainBrowser: Boolean(state.retainBrowser), timeoutMs: state.timeoutMs ?? 600_000 };
        verificationBindings.set(verificationKey(workspace, args.run_id), binding);
        await spaces.refreshTabs(workspace, manifest.space_id).catch(() => undefined);
        scheduleVerificationWatcher(binding, args.run_id);
        return {
          text: [
            "# Browser Verification Resume",
            "",
            `Run ID: ${state.runId}`,
            `Browser Space: ${manifest.space_id}`,
            `Status: ${state.status}`,
            `Cleanup: ${state.cleanup?.status ?? "pending"}`,
            `Recovery: ${state.recoveryStatus ?? "not_needed"}`,
            `Completed: ${state.completedSteps}/${state.steps.length}`,
            `Pending: ${state.pendingSteps ?? 0}`,
            `Recovery Attempts: ${state.recoveryAttempts ?? 0}`,
            `Session Rebuilds: ${state.sessionRebuildCount ?? 0}`,
            `State: ${state.statePath}`,
            `Report: ${state.reportPath}`
          ].join("\n"),
          structured: {
            run_id: state.runId,
            space_id: manifest.space_id,
            status: state.status,
            cleanup_status: state.cleanup?.status ?? "pending",
            resource_released: Boolean(state.cleanup?.resourceReleased),
            resource_leak_detected: Boolean(state.cleanup?.leakDetected),
            created_tab_ids: state.createdTabIds ?? [],
            recovery_status: state.recoveryStatus,
            recovery_reason: state.lastRecoveryReason ?? state.recoveryBlockedReason,
            completed_steps: state.completedSteps,
            total_steps: state.steps.length,
            pending_steps: state.pendingSteps ?? 0,
            recovery_attempts: state.recoveryAttempts ?? 0,
            session_rebuild_count: state.sessionRebuildCount ?? 0,
            original_session_id: state.originalSessionId ?? state.sessionId,
            current_session_id: state.currentSessionId ?? state.sessionId,
            resumed: true,
            state_path: state.statePath,
            report_path: state.reportPath
          }
        };
      }
    },
    {
      name: "browser_verification_cancel",
      title: "Browser Verification Cancel",
      description: "Cancel an active browser verification run and immediately clean up its task-owned tabs and dedicated Browser Space unless retain_browser was explicitly enabled when the run started.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().uuid(),
        space_id: spaceArg(),
        reason: z.string().min(1).max(500).optional()
      },
      safety: "write",
      invoking: "Cancelling browser verification...",
      invoked: "Browser verification cancelled",
      async handler(args) {
        const workspace = workspaceFor(args);
        const resolved = await resolveVerificationBinding(workspace, args.run_id, args.space_id);
        const binding = resolved.binding;
        let state = resolved.state;
        if (!isTerminalVerificationRunStatus(state.status)) {
          const session = spaces.sessionFor(workspace, binding.spaceId);
          state = await session.cancelVerification(args.run_id, args.reason ?? "Browser verification cancelled by user.", "cancelled");
        }
        state = await cleanupVerification(binding, args.run_id, state);
        return {
          text: [
            "# Browser Verification Cancel",
            "",
            `Run ID: ${state.runId}`,
            `Browser Space: ${binding.spaceId}`,
            `Status: ${state.status}`,
            `Cleanup: ${state.cleanup?.status ?? "pending"}`,
            `Resources released: ${state.cleanup?.resourceReleased ? "yes" : "no"}`,
            `Resource leak: ${state.cleanup?.leakDetected ? "yes" : "no"}`
          ].join("\n"),
          structured: {
            run_id: state.runId,
            space_id: binding.spaceId,
            status: state.status,
            cleanup_status: state.cleanup?.status ?? "pending",
            resource_released: Boolean(state.cleanup?.resourceReleased),
            resource_leak_detected: Boolean(state.cleanup?.leakDetected),
            resource_leak_reasons: state.cleanup?.leakReasons ?? [],
            created_tab_ids: state.createdTabIds ?? [],
            closed_tab_ids: state.cleanup?.closedTabIds ?? [],
            state_path: state.statePath,
            report_path: state.reportPath
          }
        };
      }
    },
    {
      name: "browser_verification_result",
      title: "Browser Verification Result",
      description: "Return a compact final summary and report path for a bounded browser verification run. Detailed per-step evidence remains on disk.",
      inputSchema: {
        workspace_id: workspaceArg(),
        run_id: z.string().uuid(),
        space_id: spaceArg()
      },
      safety: "read",
      invoking: "Reading browser verification result...",
      invoked: "Browser verification result ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const resolved = await resolveVerificationBinding(workspace, args.run_id, args.space_id);
        const binding = resolved.binding;
        let state = resolved.state;
        if (!isTerminalVerificationRunStatus(state.status)) {
          const session = spaces.sessionFor(workspace, binding.spaceId);
          state = await session.verificationResult(args.run_id);
        }
        if (isTerminalVerificationRunStatus(state.status)) state = await cleanupVerification(binding, args.run_id, state);
        return {
          text: [
            "# Browser Verification Result",
            "",
            `Run ID: ${state.runId}`,
            `Browser Space: ${binding.spaceId}`,
            `Status: ${state.status}`,
            `Cleanup: ${state.cleanup?.status ?? "pending"}`,
            `Resources released: ${state.cleanup?.resourceReleased ? "yes" : "no"}`,
            `Resource leak: ${state.cleanup?.leakDetected ? "yes" : "no"}`,
            `Recovery: ${state.recoveryStatus ?? "not_needed"}`,
            `Completed: ${state.completedSteps}/${state.steps.length}`,
            `Failed: ${state.failedSteps}`,
            `Blocked: ${state.blockedSteps ?? 0}`,
            `Pending: ${state.pendingSteps ?? 0}`,
            `Recovery Attempts: ${state.recoveryAttempts ?? 0}`,
            `Session Rebuilds: ${state.sessionRebuildCount ?? 0}`,
            `Unexpected Refreshes: ${state.unexpectedRefreshCount ?? 0}`,
            `Console Errors: ${state.consoleErrorCount ?? 0}`,
            `Network Failures: ${state.networkFailureCount ?? 0}`,
            `State: ${state.statePath}`,
            `Report: ${state.reportPath}`
          ].join("\n"),
          structured: {
            run_id: state.runId,
            space_id: binding.spaceId,
            status: state.status,
            cleanup_status: state.cleanup?.status ?? "pending",
            resource_released: Boolean(state.cleanup?.resourceReleased),
            resource_leak_detected: Boolean(state.cleanup?.leakDetected),
            resource_leak_reasons: state.cleanup?.leakReasons ?? [],
            created_tab_ids: state.createdTabIds ?? [],
            closed_tab_ids: state.cleanup?.closedTabIds ?? [],
            acceptance_resource_check_passed: Boolean(state.retainBrowser ? state.cleanup?.status === "retained" : state.cleanup?.status === "completed" && state.cleanup.resourceReleased && !state.cleanup.leakDetected),
            recovery_status: state.recoveryStatus,
            recovery_reason: state.lastRecoveryReason ?? state.recoveryBlockedReason,
            completed_steps: state.completedSteps,
            total_steps: state.steps.length,
            failed_steps: state.failedSteps,
            blocked_steps: state.blockedSteps ?? 0,
            pending_steps: state.pendingSteps ?? 0,
            recovery_attempts: state.recoveryAttempts ?? 0,
            session_rebuild_count: state.sessionRebuildCount ?? 0,
            unexpected_refresh_count: state.unexpectedRefreshCount ?? 0,
            console_error_count: state.consoleErrorCount ?? 0,
            network_failure_count: state.networkFailureCount ?? 0,
            original_session_id: state.originalSessionId ?? state.sessionId,
            current_session_id: state.currentSessionId ?? state.sessionId,
            state_path: state.statePath,
            report_path: state.reportPath
          }
        };
      }
    },
    {
      name: "browser_disconnect",
      title: "Browser Disconnect",
      description: "Disconnect Browser Bridge safely. Owned pages are closed, and the dedicated CodexPro Chrome process is stopped when no other browser session is using it.",
      inputSchema: {
        workspace_id: workspaceArg()
      },
      safety: "write",
      invoking: "Disconnecting Browser Bridge...",
      invoked: "Browser Bridge disconnected",
      async handler(args) {
        const session = sessionFor(args);
        const beforeDisconnect = session.status();
        const manifest = await spaces.close(workspaceFor(args), args.space_id ?? BROWSER_SPACE_DEFAULT_ID);
        const status = { ...beforeDisconnect, connected: false, disconnectedAt: new Date().toISOString(), currentUrl: undefined, tabCount: 0 };
        return {
          text: ["# Browser Disconnect", "", ...bridgeText(status), `Space: ${manifest.space_id}`, `Space status: ${manifest.status}`, "Only this space's owned pages were closed."].join("\n"),
          structured: { bridge: serializeBridgeStatus(status), browser_space: manifest }
        };
      }
    },
    {
      name: "browser_open",
      title: "Browser Open",
      description:
        "Open an http/https URL through the persistent Browser Bridge session, including localhost, private-network, and Docker-internal addresses. Reuses the current page when the normalized URL is unchanged. Unsupported schemes, URL credentials, cloud metadata, and non-navigable addresses are rejected.",
      inputSchema: {
        workspace_id: workspaceArg(),
        url: z.string().url().describe("URL to open. Public, localhost, private-network, and Docker-internal http/https addresses are allowed; cloud metadata, credentialed URLs, unsupported schemes, and non-navigable addresses are blocked."),
        device: deviceSchema.optional().describe("Viewport preset. Default: desktop."),
        wait_until: waitUntilSchema.optional().describe("Playwright navigation wait condition. Default: domcontentloaded."),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe("Navigation timeout. Default: 30000.")
      },
      safety: "write",
      invoking: "Opening browser page...",
      invoked: "Browser page opened",
      async handler(args) {
        const session = sessionFor(args);
        const entry = await session.open(args.url, {
          device: args.device,
          waitUntil: args.wait_until,
          timeoutMs: args.timeout_ms
        });
        const status = session.status();
        return {
          text: [
            `# Browser Open`,
            "",
            `Requested: ${entry.requestedUrl}`,
            `Final URL: ${entry.finalUrl}`,
            `Title: ${entry.title || "(none)"}`,
            `Device: ${entry.device}`,
            `Navigated: ${entry.navigated === false ? "no — existing page reused" : "yes"}`,
            ...bridgeText(status).slice(1)
          ].join("\n"),
          structured: { open: entry, bridge: serializeBridgeStatus(status) }
        };
      }
    },
    {
      name: "browser_click",
      title: "Browser Click",
      description: "Click a low-risk element on the current page. High-risk browser actions are blocked by policy and recorded in the browser report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional().describe("CSS selector or Playwright locator string such as text=Save."),
        ref: z.string().regex(/^e\d+$/).optional().describe("Stable element reference returned by browser_observe."),
        button: clickButtonSchema.optional().describe("Mouse button. Default: left."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Click timeout. Default: 5000.")
      },
      safety: "write",
      invoking: "Clicking browser element...",
      invoked: "Browser click completed",
      async handler(args) {
        const entry = await sessionFor(args).click(targetFor(args), {
          button: args.button,
          timeoutMs: args.timeout_ms
        });
        return {
          text: [`# Browser Click`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, `URL: ${entry.url}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"),
          structured: { interaction: entry }
        };
      }
    },
    {
      name: "browser_type",
      title: "Browser Type",
      description: "Type into a low-risk form field on the current page. High-risk fields are blocked by policy, and typed values are not echoed in reports.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional().describe("CSS selector or Playwright locator string for the target field."),
        ref: z.string().regex(/^e\d+$/).optional().describe("Stable element reference returned by browser_observe."),
        text: z.string().describe("Text to type or fill. Stored only as textLength in browser reports."),
        clear: z.boolean().optional().describe("Clear/fill the field before typing. Default: true."),
        delay_ms: z.number().int().min(0).max(500).optional().describe("Delay between keystrokes when clear=false. Default: 0."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Typing timeout. Default: 5000.")
      },
      safety: "write",
      invoking: "Typing into browser field...",
      invoked: "Browser type completed",
      async handler(args) {
        const entry = await sessionFor(args).type(targetFor(args), args.text, {
          clear: args.clear,
          delayMs: args.delay_ms,
          timeoutMs: args.timeout_ms
        });
        return {
          text: [`# Browser Type`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, `Text length: ${entry.textLength ?? 0}`, `URL: ${entry.url}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"),
          structured: { interaction: entry }
        };
      }
    },
    {
      name: "browser_wait",
      title: "Browser Wait",
      description: "Wait for an element to become visible, hidden, attached, or detached.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional().describe("CSS selector or Playwright locator string."),
        ref: z.string().regex(/^e\d+$/).optional().describe("Stable element reference returned by browser_observe."),
        state: waitStateSchema.optional().describe("visible, hidden, attached, or detached. Default: visible."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Wait timeout. Default: 5000.")
      },
      safety: "read",
      invoking: "Waiting for browser element...",
      invoked: "Browser wait completed",
      async handler(args) {
        const entry = await sessionFor(args).wait(targetFor(args), {
          state: args.state,
          timeoutMs: args.timeout_ms
        });
        return {
          text: [`# Browser Wait`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector}`, `State: ${entry.state}`, entry.error ? `Error: ${entry.error}` : ""].filter(Boolean).join("\n"),
          structured: { interaction: entry }
        };
      }
    },
    {
      name: "browser_download",
      title: "Controlled Browser Download",
      description: "Click one verified download trigger on the current authorized page, wait for a real Playwright download event, save the file under .ai-bridge/browser-downloads/<task-id>/, and persist a compact credential without opening or parsing the file.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task_id: z.string().min(1).describe("Must match task.task_id."),
        run_id: z.string().min(1).describe("Must match task.run_id."),
        task: browserBusinessTaskSchema.optional().describe("Prepared browser_business_task. Omit to load the persisted task identified by task_id and run_id."),
        selector: z.string().min(1).optional().describe("Deprecated for controlled downloads; browser_download is ref-bound and rejects selector targeting."),
        ref: z.string().regex(/^e\d+$/).describe("Stable element reference returned by the latest browser_observe."),
        snapshot_id: z.string().uuid().describe("Snapshot id from the latest browser_observe. Older snapshots are rejected."),
        element_fingerprint: downloadElementFingerprintSchema.describe("Exact element identity captured from the same snapshot, including modal/container identity when present."),
        page_fingerprints: z.array(downloadFingerprintSchema).min(1).describe("Required current-page fingerprints verified immediately before clicking."),
        expected_context: z.object({
          platform: z.string().min(1).optional(),
          shop_context: shopContextSchema.optional(),
          business_object: businessObjectSchema.optional(),
          required_visible_text: z.array(z.string().min(1)).optional()
        }).strict().optional(),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe("Download wait timeout. Default: 30000.")
      },
      safety: "write",
      invoking: "Running controlled browser download...",
      invoked: "Controlled browser download finished",
      async handler(args) {
        const workspace = workspaceFor(args);
        const task = args.task === undefined
          ? await loadPersistedBrowserBusinessTask(guard, workspace, args.task_id, args.run_id)
          : browserBusinessTaskSchema.parse(args.task);
        if (args.task_id !== task.task_id) throw new Error(`task_id mismatch: expected ${task.task_id}, got ${args.task_id}.`);
        if (args.run_id !== task.run_id) throw new Error(`run_id mismatch: expected ${task.run_id}, got ${args.run_id}.`);
        const session = sessionFor(args);
        const entry = await session.download({
          task,
          ref: args.ref,
          selector: args.selector,
          snapshotId: args.snapshot_id,
          elementFingerprint: {
            ref: args.element_fingerprint.ref,
            selector: args.element_fingerprint.selector,
            tagName: args.element_fingerprint.tag_name,
            role: args.element_fingerprint.role,
            name: args.element_fingerprint.name,
            text: args.element_fingerprint.text,
            hrefAbsent: args.element_fingerprint.href_absent,
            visible: args.element_fingerprint.visible,
            clickable: args.element_fingerprint.clickable,
            containerRef: args.element_fingerprint.container_ref,
            containerRole: args.element_fingerprint.container_role,
            containerTextContains: args.element_fingerprint.container_text_contains
          },
          timeoutMs: args.timeout_ms,
          context: {
            platform: args.expected_context?.platform,
            shop_context: args.expected_context?.shop_context,
            business_object: args.expected_context?.business_object,
            page_fingerprints: args.page_fingerprints,
            required_visible_text: args.expected_context?.required_visible_text
          }
        });
        const report = await session.writeReport();
        const compact = compactDownload(entry);
        return {
          text: [
            "# Browser Download",
            "",
            `Status: ${entry.status}`,
            `Credential: ${entry.credential_path}`,
            entry.relative_path ? `File: ${entry.relative_path}` : "",
            `Bytes: ${entry.bytes}`,
            entry.sha256 ? `SHA-256: ${entry.sha256}` : "",
            `Report: ${report.path}`,
            entry.error ? `Error: ${entry.error}` : "",
            entry.async_evidence ? `Async evidence: ${entry.async_evidence.slice(0, 240)}` : ""
          ].filter(Boolean).join("\n"),
          structured: { download: compact, report_path: report.path, downloads_path: report.downloadsPath }
        };
      }
    },
    {
      name: "browser_screenshot",
      title: "Browser Screenshot",
      description: "Save a screenshot of the current Playwright page under .ai-bridge/browser-reports/. Call browser_open first.",
      inputSchema: {
        workspace_id: workspaceArg(),
        name: z.string().optional().describe("Optional screenshot filename stem. Unsafe path characters are sanitized."),
        device: deviceSchema.optional().describe("Optional viewport preset to capture before saving: desktop or mobile."),
        full_page: z.boolean().optional().describe("Capture full page. Default: true.")
      },
      safety: "write",
      invoking: "Saving browser screenshot...",
      invoked: "Browser screenshot saved",
      async handler(args) {
        const entry = await sessionFor(args).screenshot({
          name: args.name,
          device: args.device,
          fullPage: args.full_page
        });
        return {
          text: [`# Browser Screenshot`, "", `Path: ${entry.path}`, `Device: ${entry.device}`, `Bytes: ${entry.bytes}`, `URL: ${entry.url ?? "unknown"}`].join("\n"),
          structured: { screenshot: entry }
        };
      }
    },
    {
      name: "browser_visual_regression",
      title: "Browser Visual Regression",
      description: "Open before/after URLs, capture before/after screenshots for desktop and mobile, compare PNG pixels, save diff images, and append results to the browser report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        before_url: z.string().url().describe("Baseline URL to capture before screenshot(s) from."),
        after_url: z.string().url().describe("Candidate URL to capture after screenshot(s) from."),
        label: z.string().optional().describe("Optional report label and filename stem. Unsafe path characters are sanitized."),
        devices: z.array(deviceSchema).min(1).max(2).optional().describe("Devices to compare. Default: desktop and mobile."),
        threshold_ratio: z.number().min(0).max(1).optional().describe("Allowed mismatched pixel ratio before failing. Default: 0.001."),
        pixel_delta_threshold: z.number().int().min(0).max(255).optional().describe("Per-channel pixel delta ignored during comparison. Default: 0."),
        full_page: z.boolean().optional().describe("Capture full page. Default: true."),
        wait_until: waitUntilSchema.optional().describe("Playwright navigation wait condition. Default: domcontentloaded."),
        timeout_ms: z.number().int().min(1000).max(120000).optional().describe("Navigation timeout. Default: 30000.")
      },
      safety: "write",
      invoking: "Running browser visual regression...",
      invoked: "Browser visual regression completed",
      async handler(args) {
        const session = sessionFor(args);
        const comparisons = await session.visualRegression({
          beforeUrl: args.before_url,
          afterUrl: args.after_url,
          label: args.label,
          devices: args.devices,
          thresholdRatio: args.threshold_ratio,
          pixelDeltaThreshold: args.pixel_delta_threshold,
          fullPage: args.full_page,
          waitUntil: args.wait_until,
          timeoutMs: args.timeout_ms
        });
        const report = await session.writeReport();
        return {
          text: [
            "# Browser Visual Regression",
            "",
            `Report: ${report.path}`,
            `Console JSON: ${report.consolePath}`,
            `Network JSON: ${report.networkPath}`,
            "",
            ...comparisons.map(formatVisualComparisonSummary)
          ].join("\n"),
          structured: { comparisons, report_path: report.path, console_path: report.consolePath, network_path: report.networkPath }
        };
      }
    },
    {
      name: "browser_console",
      title: "Browser Console",
      description: "Return console messages captured from the current browser session, with optional level filtering.",
      inputSchema: {
        workspace_id: workspaceArg(),
        level: z.string().optional().describe("Optional console level filter such as error, warning, warn, log, info.")
      },
      safety: "read",
      invoking: "Reading browser console...",
      invoked: "Browser console ready",
      async handler(args) {
        const captured = sessionFor(args).console(args.level);
        const entries = captured.slice(-100);
        return {
          text: [`# Browser Console`, "", `${formatCountLabel(captured.length, "message")} captured.`, captured.length > entries.length ? `Returning the latest ${entries.length}; full redacted evidence remains in browser_report.` : ""].filter(Boolean).join("\n"),
          structured: { console: entries, count: captured.length, returned_count: entries.length, truncated: captured.length > entries.length }
        };
      }
    },
    {
      name: "browser_network",
      title: "Browser Network",
      description: "Return failed network requests and HTTP errors captured from the current browser session.",
      inputSchema: {
        workspace_id: workspaceArg(),
        failed_only: z.boolean().optional().describe("Return failed requests / HTTP errors only. First version captures those events. Default: true.")
      },
      safety: "read",
      invoking: "Reading browser network events...",
      invoked: "Browser network events ready",
      async handler(args) {
        const captured = sessionFor(args).network(args.failed_only !== false);
        const entries = captured.slice(-100);
        return {
          text: [`# Browser Network`, "", `${formatCountLabel(captured.length, "failed request or HTTP error")} captured.`, captured.length > entries.length ? `Returning the latest ${entries.length}; full redacted evidence remains in browser_report.` : ""].filter(Boolean).join("\n"),
          structured: { network: entries, count: captured.length, returned_count: entries.length, truncated: captured.length > entries.length }
        };
      }
    },
    {
      name: "browser_expect_text",
      title: "Browser Expect Text",
      description: "Validate that text exists on the current page or inside a selector. Records the result in the browser report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        text: z.string().min(1).describe("Expected text or regex pattern."),
        selector: z.string().optional().describe("Optional CSS selector. Defaults to body text."),
        ref: z.string().regex(/^e\d+$/).optional().describe("Stable element reference returned by browser_observe."),
        mode: textModeSchema.optional().describe("contains, exact, or regex. Default: contains."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Polling timeout. Default: 5000."),
        case_sensitive: z.boolean().optional().describe("Case-sensitive matching. Default: false.")
      },
      safety: "read",
      invoking: "Checking page text...",
      invoked: "Page text checked",
      async handler(args) {
        const entry = await sessionFor(args).expectText(args.text, {
          selector: args.ref ?? args.selector,
          mode: args.mode,
          timeoutMs: args.timeout_ms,
          caseSensitive: args.case_sensitive
        });
        return {
          text: [`# Browser Expect Text`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Mode: ${entry.mode}`, `Expected: ${entry.expected}`, `Actual preview: ${entry.actual.slice(0, 500)}`].join("\n"),
          structured: { expectation: entry }
        };
      }
    },
    {
      name: "browser_expect_url",
      title: "Browser Expect URL",
      description: "Validate the current page URL. Records the result in the browser report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        url: z.string().min(1).describe("Expected URL, substring, or regex pattern depending on mode."),
        mode: urlModeSchema.optional().describe("contains, exact, or regex. Default: contains."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Polling timeout. Default: 5000.")
      },
      safety: "read",
      invoking: "Checking browser URL...",
      invoked: "Browser URL checked",
      async handler(args) {
        const entry = await sessionFor(args).expectUrl(args.url, {
          mode: args.mode,
          timeoutMs: args.timeout_ms
        });
        return {
          text: [`# Browser Expect URL`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Mode: ${entry.mode}`, `Expected: ${entry.expected}`, `Actual: ${entry.actual}`].join("\n"),
          structured: { expectation: entry }
        };
      }
    },
    {
      name: "browser_expect_hidden",
      title: "Browser Expect Hidden",
      description: "Validate that an element is hidden or detached. Records the result in the browser report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        selector: z.string().min(1).optional().describe("CSS selector or Playwright locator string."),
        ref: z.string().regex(/^e\d+$/).optional().describe("Stable element reference returned by browser_observe."),
        timeout_ms: z.number().int().min(250).max(60000).optional().describe("Polling timeout. Default: 5000.")
      },
      safety: "read",
      invoking: "Checking hidden browser element...",
      invoked: "Hidden browser element checked",
      async handler(args) {
        const entry = await sessionFor(args).expectHidden(targetFor(args), {
          timeoutMs: args.timeout_ms
        });
        return {
          text: [`# Browser Expect Hidden`, "", `Result: ${entry.passed ? "PASS" : "FAIL"}`, `Selector: ${entry.selector ?? targetFor(args)}`, `Actual: ${entry.actual}`].join("\n"),
          structured: { expectation: entry }
        };
      }
    },
    {
      name: "browser_report",
      title: "Browser Report",
      description: "Generate a session-wide diagnostic report, or an acceptance-eligible report scoped to one bounded browser verification run.",
      inputSchema: {
        workspace_id: workspaceArg(),
        verification_run_id: z.string().uuid().optional().describe("Bounded browser verification run id. When omitted, the report is session-wide diagnostic evidence only.")
      },
      safety: "write",
      invoking: "Generating browser report...",
      invoked: "Browser report generated",
      async handler(args) {
        const result = await sessionFor(args).writeReport({ verificationRunId: args.verification_run_id });
        return {
          text: [
            `# Browser Report`,
            "",
            `Kind: ${result.reportKind}`,
            `Acceptance Eligible: ${result.acceptanceEligible ? "yes" : "no"}`,
            `Verification Run: ${result.verificationRunId ?? "none"}`,
            `Requested URL: ${result.requestedUrl ?? "none"}`,
            `Final URL: ${result.finalUrl ?? "none"}`,
            `Screenshot: ${result.screenshotRef ?? "none"}`,
            `Text Assertion: ${result.textExpectationPassed ? "PASS" : "MISSING/FAIL"}`,
            `URL Assertion: ${result.urlExpectationPassed ? "PASS" : "MISSING/FAIL"}`,
            `Console Errors: ${result.consoleErrorCount}`,
            `Network Failures: ${result.networkFailureCount}`,
            `Conclusion: ${result.conclusion}`,
            `Path: ${result.path}`,
            `Console JSON: ${result.consolePath}`,
            `Network JSON: ${result.networkPath}`,
            `Downloads JSON: ${result.downloadsPath}`
          ].join("\n"),
          structured: {
            report_kind: result.reportKind,
            acceptance_eligible: result.acceptanceEligible,
            verification_run_id: result.verificationRunId ?? null,
            browser_session_id: result.browserSessionId ?? null,
            page_id: result.pageId ?? null,
            requested_url: result.requestedUrl ?? null,
            final_url: result.finalUrl ?? null,
            device: result.device ?? null,
            expectation_result: result.expectationResult,
            text_expectation_passed: result.textExpectationPassed,
            url_expectation_passed: result.urlExpectationPassed,
            console_error_count: result.consoleErrorCount,
            network_failure_count: result.networkFailureCount,
            screenshot_ref: result.screenshotRef ?? null,
            acceptance_conclusion: result.conclusion,
            browser_acceptance_status: result.conclusion === "passed" ? "passed" : result.conclusion === "failed" ? "failed" : "not_requested",
            report_path: result.path,
            console_path: result.consolePath,
            network_path: result.networkPath,
            downloads_path: result.downloadsPath
          }
        };
      }
    }
  ];
  const spaceToolNames = new Set([
    "browser_space_create",
    "browser_space_list",
    "browser_space_status",
    "browser_space_activate",
    "browser_space_close",
    "browser_space_reset"
  ]);
  const flowLifecycleToolNames = new Set([
    "browser_flow_prepare",
    "browser_flow_run",
    "browser_flow_status",
    "browser_flow_resume",
    "browser_flow_result",
    "browser_flow_cancel"
  ]);
  const verificationLifecycleToolNames = new Set([
    "browser_verification_run",
    "browser_verification_status",
    "browser_verification_resume",
    "browser_verification_cancel",
    "browser_verification_result"
  ]);
  return definitions.map((definition) => {
    if (spaceToolNames.has(definition.name)) return definition;
    const originalHandler = definition.handler;
    const scopedDefinition = {
      ...definition,
      inputSchema: {
        ...definition.inputSchema,
        space_id: definition.inputSchema.space_id ?? spaceArg()
      }
    };
    if (flowLifecycleToolNames.has(definition.name) || verificationLifecycleToolNames.has(definition.name)) return scopedDefinition;
    return {
      ...scopedDefinition,
      async handler(args: any) {
        const workspace = workspaceFor(args);
        const spaceId = args.space_id ?? BROWSER_SPACE_DEFAULT_ID;
        await spaces.ensureUsable(workspace, spaceId);
        const resource = resourceForTool(definition.name);
        const resourceOwner = resource ? `tool-${definition.name}-${randomUUID()}` : undefined;
        if (resource && resourceOwner && !await spaces.acquireResource(workspace, spaceId, resourceOwner, resource)) {
          throw new CodexProError(`Browser Space ${spaceId} is waiting_resource for ${resource}; retry after the active lease is released.`);
        }
        try {
          return await originalHandler(args);
        } finally {
          if (resource && resourceOwner) await spaces.releaseResource(workspace, spaceId, resourceOwner, resource);
        }
      }
    };
  });
}
