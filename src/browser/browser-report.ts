import { redactSensitiveText } from "../redact.js";
import type {
  BrowserBridgeStatus,
  BrowserConsoleEntry,
  BrowserDownloadStatus,
  BrowserElementSummary,
  BrowserExpectationResult,
  BrowserInteractionResult,
  BrowserNetworkEntry,
  BrowserTabEntry
} from "../adapters/playwright-adapter.js";
import type { BrowserSemanticSnapshot, BrowserVerificationRunState } from "./browser-session.js";
import type { BrowserInspectionResult } from "./observation-router.js";
import type { BrowserEvidenceConflict, BrowserMultimodalEvidence } from "./evidence-fusion.js";

export interface BrowserScreenshotEntry {
  timestamp: string;
  path: string;
  device: string;
  url?: string;
  bytes: number;
  reason?: string;
  scope?: string;
  linkedSnapshotId?: string;
  redacted?: true;
  sensitiveMaskApplied?: boolean;
  mayAuthorizeInteraction?: false;
}

export interface BrowserVisualComparisonEntry {
  timestamp: string;
  label: string;
  device: string;
  beforePath: string;
  afterPath: string;
  diffPath?: string;
  beforeUrl?: string;
  afterUrl?: string;
  beforeBytes: number;
  afterBytes: number;
  beforeHash: string;
  afterHash: string;
  width?: number;
  height?: number;
  totalPixels?: number;
  mismatchedPixels?: number;
  mismatchRatio?: number;
  thresholdRatio: number;
  pixelDeltaThreshold: number;
  passed: boolean;
  error?: string;
}

export interface BrowserOpenedUrlEntry {
  timestamp: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  device: string;
  opened?: boolean;
  navigated?: boolean;
  error?: string;
}

export interface BrowserDownloadEntry {
  version: 1;
  download_id: string;
  status: BrowserDownloadStatus;
  original_filename?: string;
  safe_filename?: string;
  relative_path?: string;
  credential_path: string;
  bytes: number;
  mime: string;
  mime_source: "playwright" | "extension" | "fallback" | "unknown";
  sha256?: string;
  source_page: {
    url: string;
    title: string;
    snapshot_id: string;
  };
  download_url?: string;
  downloaded_at: string;
  trigger_element: {
    selector: string;
    requested: string;
    element?: BrowserElementSummary;
  };
  task_id: string;
  run_id: string;
  task_contract_hash: string;
  session_id: string;
  completion_proof_fields: Record<string, unknown>;
  collision_renamed?: boolean;
  error?: string;
  async_evidence?: string;
  replayed?: boolean;
  durable_message?: {
    message_id: string;
    dedupe_key: string;
    message_type: string;
  };
}

export interface BrowserExpectationEntry extends BrowserExpectationResult {
  timestamp: string;
  type: "text" | "url" | "hidden";
  selector?: string;
}

export interface BrowserInteractionEntry extends BrowserInteractionResult {
  timestamp: string;
}

export interface BrowserReportScope {
  kind: "session_diagnostic" | "verification_evidence";
  acceptanceEligible: boolean;
  browserSessionId?: string;
  verificationRunId?: string;
  captureStartedAt?: string;
  captureEndedAt?: string;
  targetUrls?: string[];
  pageIds?: string[];
}

export interface BrowserReportSnapshot {
  generatedAt: string;
  scope?: BrowserReportScope;
  workspaceId: string;
  root: string;
  reportDir: string;
  currentUrl?: string;
  allowedDomains: string[];
  bridge?: BrowserBridgeStatus;
  tabs?: BrowserTabEntry[];
  semanticSnapshots?: BrowserSemanticSnapshot[];
  verificationRuns?: BrowserVerificationRunState[];
  openedUrls: BrowserOpenedUrlEntry[];
  interactions: BrowserInteractionEntry[];
  downloads?: BrowserDownloadEntry[];
  screenshots: BrowserScreenshotEntry[];
  visualComparisons?: BrowserVisualComparisonEntry[];
  inspections?: BrowserInspectionResult[];
  multimodalEvidence?: BrowserMultimodalEvidence[];
  evidenceConflicts?: BrowserEvidenceConflict[];
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  expectations: BrowserExpectationEntry[];
}

function bullet(value: string): string {
  return `- ${redactSensitiveText(value).replace(/\r?\n/g, " ")}`;
}

function tableCell(value: unknown): string {
  return redactSensitiveText(String(value ?? "")).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatConsole(entries: BrowserConsoleEntry[]): string {
  if (!entries.length) return "- no console messages captured";
  return [
    "| Time | Type | Message | Location |",
    "| --- | --- | --- | --- |",
    ...entries.map((entry) => {
      const location = entry.location?.url
        ? `${entry.location.url}:${entry.location.lineNumber ?? 0}:${entry.location.columnNumber ?? 0}`
        : "";
      return `| ${tableCell(entry.timestamp)} | ${tableCell(entry.type)} | ${tableCell(entry.text)} | ${tableCell(location)} |`;
    })
  ].join("\n");
}

function formatNetwork(entries: BrowserNetworkEntry[]): string {
  if (!entries.length) return "- no failed network requests or HTTP errors captured";
  return [
    "| Time | Kind | Method | Status | URL | Failure |",
    "| --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.timestamp)} | ${tableCell(entry.kind)} | ${tableCell(entry.method)} | ${tableCell(entry.status ?? "")} | ${tableCell(entry.url)} | ${tableCell(entry.failure ?? entry.statusText ?? "")} |`)
  ].join("\n");
}

function formatScreenshots(entries: BrowserScreenshotEntry[]): string {
  if (!entries.length) return "- no screenshots saved";
  return entries
    .map((entry) => bullet(`${entry.device}: ${entry.path} (${entry.bytes} bytes)${entry.url ? ` — ${entry.url}` : ""}${entry.reason ? `; reason=${entry.reason}` : ""}${entry.scope ? `; scope=${entry.scope}` : ""}${entry.linkedSnapshotId ? `; linked_snapshot=${entry.linkedSnapshotId}` : ""}${entry.mayAuthorizeInteraction === false ? "; interaction_authority=false" : ""}`))
    .join("\n");
}

function formatInspections(entries: BrowserInspectionResult[], conflicts: BrowserEvidenceConflict[]): string {
  if (!entries.length) return "- no unified inspections executed";
  const conflictByInspection = new Map<string, BrowserEvidenceConflict[]>();
  for (const conflict of conflicts) conflictByInspection.set(conflict.inspection_id, [...(conflictByInspection.get(conflict.inspection_id) ?? []), conflict]);
  return [
    "| Time | Inspection | Snapshot | Semantic | Visual | Reason | Scope | Facts | Conflicts | Report |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.created_at)} | ${tableCell(entry.inspection_id)} | ${tableCell(entry.semantic_snapshot_id)} | ${entry.semantic_completeness} | ${entry.visual_requested ? "yes" : "no"} | ${tableCell(entry.visual_reason ?? "")} | ${tableCell(entry.visual_scope ? `${entry.visual_scope.kind}:${entry.visual_scope.target ?? ""}` : "")} | ${entry.facts.length} | ${(conflictByInspection.get(entry.inspection_id) ?? []).length} | ${tableCell(entry.report_path)} |`)
  ].join("\n");
}

function formatEvidenceConflicts(entries: BrowserEvidenceConflict[]): string {
  if (!entries.length) return "- no semantic/visual evidence conflicts recorded";
  return [
    "| Time | Fact | Type | Resolution | Confidence | Stop | Limitations | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.created_at)} | ${tableCell(entry.fact)} | ${entry.type} | ${entry.resolution} | ${entry.confidence} | ${entry.stop_required ? "yes" : "no"} | ${tableCell(entry.limitations.join("; "))} | ${tableCell(entry.evidence_refs.join("; "))} |`)
  ].join("\n");
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return `${(value * 100).toFixed(4)}%`;
}

function formatVisualComparisons(entries: BrowserVisualComparisonEntry[]): string {
  if (!entries.length) return "- no visual comparisons executed";
  return [
    "| Time | Label | Device | Result | Mismatch | Threshold | Before | After | Diff | Error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => {
      const mismatch = entry.mismatchRatio === undefined
        ? ""
        : `${entry.mismatchedPixels ?? 0}/${entry.totalPixels ?? 0} (${formatPercent(entry.mismatchRatio)})`;
      return `| ${tableCell(entry.timestamp)} | ${tableCell(entry.label)} | ${tableCell(entry.device)} | ${entry.passed ? "PASS" : "FAIL"} | ${tableCell(mismatch)} | ${tableCell(formatPercent(entry.thresholdRatio))} | ${tableCell(entry.beforePath)} | ${tableCell(entry.afterPath)} | ${tableCell(entry.diffPath ?? "")} | ${tableCell(entry.error ?? "")} |`;
    })
  ].join("\n");
}

function formatExpectations(entries: BrowserExpectationEntry[]): string {
  if (!entries.length) return "- no expectations executed";
  return [
    "| Time | Type | Result | Mode | Expected | Actual |",
    "| --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.timestamp)} | ${tableCell(entry.type)} | ${entry.passed ? "PASS" : "FAIL"} | ${tableCell(entry.mode)} | ${tableCell(entry.expected)} | ${tableCell(entry.actual.slice(0, 300))} |`)
  ].join("\n");
}

function formatInteractions(entries: BrowserInteractionEntry[]): string {
  if (!entries.length) return "- no interactions executed";
  return [
    "| Time | Action | Result | Selector | Details | URL |",
    "| --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => {
      const details = [
        entry.state ? `state=${entry.state}` : "",
        entry.textLength !== undefined ? `textLength=${entry.textLength}` : "",
        entry.element?.text ? `text=${entry.element.text.slice(0, 120)}` : "",
        entry.error ? `error=${entry.error}` : ""
      ].filter(Boolean).join("; ");
      return `| ${tableCell(entry.timestamp)} | ${tableCell(entry.action)} | ${entry.passed ? "PASS" : "FAIL"} | ${tableCell(entry.selector)} | ${tableCell(details)} | ${tableCell(entry.url)} |`;
    })
  ].join("\n");
}

function formatOpenedUrls(entries: BrowserOpenedUrlEntry[]): string {
  if (!entries.length) return "- no pages opened";
  return entries
    .map((entry) => {
      if (entry.error) return bullet(`${entry.device}: ${entry.requestedUrl} -> FAILED: ${entry.error}`);
      return bullet(`${entry.device}: ${entry.requestedUrl} -> ${entry.finalUrl}${entry.title ? ` (${entry.title})` : ""}${entry.navigated === false ? " [reused without navigation]" : ""}`);
    })
    .join("\n");
}

function formatDownloads(entries: BrowserDownloadEntry[]): string {
  if (!entries.length) return "- no controlled downloads recorded";
  return [
    "| Time | Status | Task | File | Bytes | MIME | SHA-256 | Credential | Source | Error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => {
      const file = entry.relative_path ?? entry.safe_filename ?? entry.original_filename ?? "";
      const task = `${entry.task_id}/${entry.run_id}`;
      const source = `${entry.source_page.title || "untitled"} ${entry.source_page.url}`;
      const error = entry.error ?? entry.async_evidence ?? (entry.replayed ? "replayed existing credential" : "");
      return `| ${tableCell(entry.downloaded_at)} | ${tableCell(entry.status)} | ${tableCell(task)} | ${tableCell(file)} | ${entry.bytes} | ${tableCell(`${entry.mime} (${entry.mime_source})`)} | ${tableCell(entry.sha256 ?? "")} | ${tableCell(entry.credential_path)} | ${tableCell(source)} | ${tableCell(error)} |`;
    })
  ].join("\n");
}

function defaultBridge(snapshot: BrowserReportSnapshot): BrowserBridgeStatus {
  const tabs = snapshot.tabs ?? [];
  return {
    requestedMode: "headless",
    connected: false,
    ownsBrowserProcess: false,
    reconnectAttempts: 0,
    currentUrl: snapshot.currentUrl,
    tabCount: tabs.length,
    navigationCount: 0
  };
}

function formatBridge(snapshot: BrowserReportSnapshot): string {
  const bridge = snapshot.bridge ?? defaultBridge(snapshot);
  const lines = [
    `Requested mode: ${tableCell(bridge.requestedMode)}`,
    `Effective mode: ${tableCell(bridge.effectiveMode ?? "not connected")}`,
    `Connection: ${bridge.connected ? "connected" : "disconnected"}`,
    `Owns browser process: ${yesNo(bridge.ownsBrowserProcess)}`,
    `CDP isolated profile: ${bridge.isolatedProfileVerified === undefined ? "not applicable / unknown" : bridge.isolatedProfileVerified ? "verified" : "not verified"}`,
    `CDP download staging bridge: ${bridge.downloadBridgeConfigured ? "configured" : "not configured"}`,
    `Automatic CDP reconnect attempts: ${bridge.reconnectAttempts}`,
    `Navigations: ${bridge.navigationCount}`,
    `Current device: ${bridge.currentDevice ?? "unknown"}`,
    `Extension authorization: ${bridge.authorizationId ? `bound (${tableCell(bridge.authorizationId)})` : "not bound"}`,
    `Tabs: ${bridge.tabCount}`
  ];
  if (bridge.downloadBridgeBrowserDir) lines.push(`Browser download staging: ${tableCell(bridge.downloadBridgeBrowserDir)}`);
  if (bridge.downloadBridgeHostDir) lines.push(`Host download staging: ${tableCell(bridge.downloadBridgeHostDir)}`);
  if (bridge.connectedAt) lines.push(`Connected at: ${tableCell(bridge.connectedAt)}`);
  if (bridge.disconnectedAt) lines.push(`Disconnected at: ${tableCell(bridge.disconnectedAt)}`);
  if (bridge.currentUrl) lines.push(`Current CodexPro page: ${tableCell(bridge.currentUrl)}`);
  if (bridge.lastReconnectAt) lines.push(`Last reconnect attempt: ${tableCell(bridge.lastReconnectAt)}`);
  if (bridge.reconnectFailureReason) lines.push(`Reconnect failure: ${tableCell(bridge.reconnectFailureReason)}`);
  if (bridge.fallbackReason) lines.push(`Fallback reason: ${tableCell(bridge.fallbackReason)}`);
  return lines.join("\n");
}

function formatSemanticSnapshots(entries: BrowserSemanticSnapshot[]): string {
  if (!entries.length) return "- no semantic snapshots captured";
  return [
    "| Time | Version | Source | Snapshot | Chunk | URL | Device | Frames | Elements | AX nodes | DOM nodes | Tables | Forms | Issues | Completeness | Delta | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.timestamp)} | ${entry.snapshotVersion} | ${tableCell(entry.source)} | ${tableCell(entry.snapshotId)} | ${entry.pagination.chunkIndex} | ${tableCell(entry.url)} | ${tableCell(entry.device)} | ${entry.frames.length} | ${entry.elements.length} | ${entry.accessibility?.length ?? 0} | ${entry.domSnapshotNodeCount ?? ""} | ${entry.tables.length} | ${entry.forms.length} | ${entry.issues.length} | ${entry.pagination.hasMore ? "partial" : "complete"} | ${entry.changes ? `${entry.changes.addedRefs.length} added / ${entry.changes.removedRefs.length} removed / ${entry.changes.changed.length} changed` : "full"} | ${tableCell(entry.evidencePath)} |`)
  ].join("\n");
}

function formatVerificationRuns(entries: BrowserVerificationRunState[]): string {
  if (!entries.length) return "- no bounded verification runs started";
  return [
    "| Run | Status | Completed | Failed | State | Report |",
    "| --- | --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${tableCell(entry.runId)} | ${tableCell(entry.status)} | ${entry.completedSteps}/${entry.steps.length} | ${entry.failedSteps} | ${tableCell(entry.statePath)} | ${tableCell(entry.reportPath)} |`)
  ].join("\n");
}

function formatTabs(entries: BrowserTabEntry[]): string {
  if (!entries.length) return "- no tabs visible to Browser Bridge";
  return [
    "| Index | Current | Owned by CodexPro | Title | URL |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map((entry) => `| ${entry.index} | ${yesNo(entry.current)} | ${yesNo(entry.ownedByCodexPro)} | ${tableCell(entry.title)} | ${tableCell(entry.url)} |`)
  ].join("\n");
}

export function formatBrowserReport(snapshot: BrowserReportSnapshot): string {
  const visualComparisons = snapshot.visualComparisons ?? [];
  const semanticSnapshots = snapshot.semanticSnapshots ?? [];
  const verificationRuns = snapshot.verificationRuns ?? [];
  const tabs = snapshot.tabs ?? [];
  const downloads = snapshot.downloads ?? [];
  const inspections = snapshot.inspections ?? [];
  const evidenceConflicts = snapshot.evidenceConflicts ?? [];
  const consoleErrors = snapshot.console.filter((entry) => ["error", "warning", "warn"].includes(entry.type));
  const failedExpectations = snapshot.expectations.filter((entry) => !entry.passed);
  const failedInteractions = snapshot.interactions.filter((entry) => !entry.passed);
  const failedDownloads = downloads.filter((entry) => entry.status !== "completed");
  const failedVisualComparisons = visualComparisons.filter((entry) => !entry.passed);
  const failedOpens = snapshot.openedUrls.filter((entry) => entry.error || entry.opened === false);
  const status = failedOpens.length || failedExpectations.length || failedInteractions.length || failedDownloads.length || failedVisualComparisons.length || consoleErrors.some((entry) => entry.type === "error") || snapshot.network.length ? "attention" : "pass";
  const scope = snapshot.scope ?? { kind: "session_diagnostic" as const, acceptanceEligible: false };
  const ownedTabCount = tabs.filter((tab) => tab.ownedByCodexPro).length;
  const hasFunctionalEvidence = semanticSnapshots.length > 0 || snapshot.expectations.length > 0 || snapshot.interactions.length > 0 || downloads.length > 0;
  const hasVisualEvidence = snapshot.screenshots.length > 0 || visualComparisons.length > 0;
  const conclusion = status === "attention"
    ? "Validation needs attention; see failed interactions, expectations, console, network, or visual evidence below."
    : hasFunctionalEvidence && hasVisualEvidence
      ? "Functional and visual validation passed for the captured scope."
      : hasFunctionalEvidence
        ? "Functional validation passed for the captured scope; visual validation was not performed."
        : hasVisualEvidence
          ? "Visual evidence was captured, but functional evidence is insufficient."
          : "Insufficient browser evidence was captured to claim validation.";
  const scopedConclusion = scope.acceptanceEligible
    ? conclusion
    : `Diagnostic session report only; it is not eligible as acceptance evidence. ${conclusion}`;

  return [
    "# Browser Validation Report",
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Report Kind: ${scope.kind}`,
    `Acceptance Eligible: ${yesNo(scope.acceptanceEligible)}`,
    `Verification Run ID: ${scope.verificationRunId ?? "none"}`,
    `Browser Session ID: ${scope.browserSessionId ?? "unknown"}`,
    `Capture Window: ${scope.captureStartedAt ?? "session start"} -> ${scope.captureEndedAt ?? "report generation"}`,
    `Target URLs: ${scope.targetUrls?.join(", ") || "session-wide"}`,
    `Page IDs: ${scope.pageIds?.join(", ") || "session-wide"}`,
    `Status: ${status}`,
    `Workspace: ${snapshot.root}`,
    `Workspace ID: ${snapshot.workspaceId}`,
    `Report directory: ${snapshot.reportDir}`,
    `Current URL: ${snapshot.currentUrl ?? "not open"}`,
    `Conclusion: ${scopedConclusion}`,
    "",
    "## Browser Bridge",
    "",
    formatBridge(snapshot),
    `Owned tabs: ${ownedTabCount}`,
    `External tabs: ${Math.max(0, tabs.length - ownedTabCount)}`,
    "",
    "## Tabs",
    "",
    formatTabs(tabs),
    "",
    "## Safety boundary",
    "",
    "Public, localhost, private-network, and Docker-internal http/https URLs are allowed; unsupported schemes, credentialed URLs, cloud metadata, and non-navigable addresses remain blocked.",
    "Final payment, order submission, deletion, publication, password/configuration, and message-send actions are prohibited before execution and recorded as failed interactions.",
    "Typing a non-sensitive draft is allowed; clicking the final send/submit action remains blocked.",
    snapshot.allowedDomains.length ? `Project allowed domains: ${snapshot.allowedDomains.join(", ")}` : "Project allowed domains: none",
    "",
    "## Semantic observations",
    "",
    formatSemanticSnapshots(semanticSnapshots),
    "",
    "## Bounded verification runs",
    "",
    formatVerificationRuns(verificationRuns),
    "",
    "## Opened pages",
    "",
    formatOpenedUrls(snapshot.openedUrls),
    "",
    "## Interactions",
    "",
    formatInteractions(snapshot.interactions),
    "",
    "## Controlled downloads",
    "",
    formatDownloads(downloads),
    "",
    "## Screenshots",
    "",
    formatScreenshots(snapshot.screenshots),
    "",
    "## Unified semantic/visual inspections",
    "",
    formatInspections(inspections, evidenceConflicts),
    "",
    "## Evidence conflicts",
    "",
    formatEvidenceConflicts(evidenceConflicts),
    "",
    "## Visual comparisons",
    "",
    formatVisualComparisons(visualComparisons),
    "",
    "## Console messages",
    "",
    formatConsole(snapshot.console),
    "",
    "## Failed network requests / HTTP errors",
    "",
    formatNetwork(snapshot.network),
    "",
    "## Expectations",
    "",
    formatExpectations(snapshot.expectations),
    ""
  ].join("\n");
}
