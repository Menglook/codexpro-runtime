import fs, { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { CodexProError, isSubpath, type PathGuard, type Workspace } from "../guard.js";
import { readProjectConfig } from "../project/projectConfig.js";
import { redactSensitiveText } from "../redact.js";
import {
  PlaywrightBrowserAdapter,
  type BrowserBridgeStatus,
  type BrowserClickButton,
  type BrowserConsoleEntry,
  type BrowserDevicePreset,
  type BrowserDownloadAdapterResult,
  type BrowserDownloadElementFingerprint,
  type BrowserDownloadStatus,
  type BrowserElementSummary,
  type BrowserExpectationResult,
  type BrowserInteractionAction,
  type BrowserNetworkEntry,
  type BrowserObserveOptions,
  type BrowserSemanticElement,
  type BrowserSemanticSnapshotData,
  type BrowserTableExtractionAdapterResult,
  type BrowserTabEntry,
  type BrowserTextMatchMode,
  type BrowserUrlMatchMode,
  type BrowserVisualObserveOptions,
  type BrowserWaitState,
  type PlaywrightWaitUntil
} from "../adapters/playwright-adapter.js";
import {
  formatBrowserReport,
  type BrowserDownloadEntry,
  type BrowserExpectationEntry,
  type BrowserInteractionEntry,
  type BrowserOpenedUrlEntry,
  type BrowserReportSnapshot,
  type BrowserScreenshotEntry,
  type BrowserVisualComparisonEntry
} from "./browser-report.js";
import { comparePngFiles } from "./visual-regression.js";
import { ensureDedicatedBrowserBridge } from "./browser-bridge-process.js";
import { browserAuthorizationStore, type BrowserTabAuthorization } from "./browser-authorization.js";
import {
  assertBrowserBusinessActionPermitted,
  assertBusinessContextMatches,
  completionProofFieldsForBusinessTask,
  validateBrowserBusinessTask,
  type BrowserBusinessObject,
  type BrowserBusinessTask,
  type BrowserShopContext
} from "./browser-business-contract.js";
import { publishBrowserDownloadMessage } from "./browser-message-producers.js";
import {
  BROWSER_DEFAULT_SPACE_ID,
  BROWSER_SEMANTIC_SNAPSHOT_VERSION,
  enrichSemanticSnapshotData,
  type BrowserSnapshotV3Metadata
} from "./semantic-snapshot-v3.js";
import { inspectionArtifactPaths, type BrowserInspectionArtifacts } from "./observation-router.js";

export const BROWSER_REPORT_ROOT = ".ai-bridge/browser-reports";
export const BROWSER_DOWNLOAD_ROOT = ".ai-bridge/browser-downloads";
export const BROWSER_EXTENSION_PROTOCOL_VERSION = "1";
const BROWSER_VERIFICATION_STATE_SCHEMA_VERSION = 2;
const BROWSER_VERIFICATION_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BrowserSpaceMode = "shared_profile" | "isolated_context";

export interface BrowserSessionScopeOptions {
  spaceId?: string;
  mode?: BrowserSpaceMode;
}

export interface BrowserOpenSessionOptions {
  device?: BrowserDevicePreset;
  waitUntil?: PlaywrightWaitUntil;
  timeoutMs?: number;
}

export interface BrowserScreenshotOptions {
  name?: string;
  device?: BrowserDevicePreset;
  fullPage?: boolean;
  reason?: BrowserVisualObserveSessionOptions["reason"];
  linkedSnapshotId?: string;
}

export interface BrowserObserveSessionOptions extends BrowserObserveOptions {
  sinceSnapshotId?: string;
}

export interface BrowserSnapshotChange {
  ref: string;
  fields: string[];
  before?: Partial<BrowserSemanticElement>;
  after?: Partial<BrowserSemanticElement>;
}

export interface BrowserSemanticSnapshot extends BrowserSemanticSnapshotData {
  snapshotId: string;
  previousSnapshotId?: string;
  timestamp: string;
  sessionId: string;
  snapshotVersion: 3;
  spaceId: string;
  pageRevision: string;
  redacted: true;
  evidencePath: string;
  observationScope: "viewport" | "document" | "selector";
  pagination: BrowserSnapshotV3Metadata["pagination"];
  changes?: {
    addedRefs: string[];
    removedRefs: string[];
    changed: BrowserSnapshotChange[];
    pageChanges: string[];
  };
}

interface BrowserObserveCursorState {
  cursor: string;
  snapshotId: string;
  sessionId: string;
  spaceId: string;
  pageId: string;
  url: string;
  documentVersion: string;
  pageRevision: string;
  chunkIndex: number;
  options: BrowserObserveSessionOptions;
  nodeOffset: number;
  textOffset: number;
}

export interface BrowserTableExtraction extends BrowserTableExtractionAdapterResult {
  version: 1;
  extractionId: string;
  snapshotId: string;
  sessionId: string;
  spaceId: string;
  redacted: true;
  evidencePath: string;
}

export interface BrowserVisualObserveSessionOptions extends BrowserVisualObserveOptions {
  name?: string;
  reason: "layout" | "image_crop" | "responsive" | "style" | "canvas" | "video" | "cross_origin_frame" | "semantic_empty" | "semantic_conflict" | "manual";
  linkedSnapshotId?: string;
}

export interface BrowserVerificationPage {
  url: string;
  label?: string;
  expectText?: string;
  visual?: boolean;
  visualReason?: BrowserVisualObserveSessionOptions["reason"];
}

export interface BrowserVerificationRunOptions {
  pages: BrowserVerificationPage[];
  devices?: BrowserDevicePreset[];
  runId?: string;
  spaceId?: string;
  retainBrowser?: boolean;
  timeoutMs?: number;
}

export interface BrowserVerificationPersistedPage extends BrowserVerificationPage {
  url: string;
  label: string;
  visual: boolean;
}

export interface BrowserVerificationRecoveryOptions {
  schemaVersion: number;
  pages: BrowserVerificationPersistedPage[];
  devices: BrowserDevicePreset[];
  spaceId?: string;
  retainBrowser?: boolean;
  timeoutMs?: number;
  browser: {
    requestedMode: CodexProConfig["browserMode"];
    requireExtensionAuth: boolean;
    allowHeadlessFallback: boolean;
  };
}

export interface BrowserVerificationStepExpectation {
  url: string;
  expectText?: string;
  visual: boolean;
  visualReason?: BrowserVisualObserveSessionOptions["reason"];
}

export interface BrowserVerificationStepEvidence {
  opened?: boolean;
  finalUrl?: string;
  snapshotId?: string;
  visualPath?: string;
  consoleErrorCount: number;
  networkFailureCount: number;
  unexpectedRefreshCount: number;
}

export interface BrowserVerificationSessionRebuild {
  at: string;
  fromSessionId?: string;
  toSessionId: string;
  reason: "process_restart" | "session_recreated" | "cdp_reconnect";
}

export type BrowserVerificationStepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";
export type BrowserVerificationRunStatus = "pending" | "running" | "completed" | "failed" | "interrupted" | "blocked" | "recoverable" | "cancelled" | "timed_out";
export type BrowserVerificationRecoveryStatus = "not_needed" | "recoverable" | "blocked";
export type BrowserVerificationCleanupStatus = "pending" | "completed" | "retained" | "failed";

export interface BrowserVerificationCleanupState {
  required: boolean;
  status: BrowserVerificationCleanupStatus;
  requestedAt?: string;
  completedAt?: string;
  reason?: string;
  createdTabIds: string[];
  closedTabIds: string[];
  spaceClosed: boolean;
  resourceReleased: boolean;
  leakDetected: boolean;
  leakReasons: string[];
}

export interface BrowserVerificationStep {
  index: number;
  pageId?: string;
  pageIndex: number;
  url: string;
  label: string;
  device: BrowserDevicePreset;
  status: BrowserVerificationStepStatus;
  startedAt?: string;
  finishedAt?: string;
  snapshotId?: string;
  visualPath?: string;
  expectation?: BrowserVerificationStepExpectation;
  evidence?: BrowserVerificationStepEvidence;
  consoleErrorCount?: number;
  networkFailureCount?: number;
  unexpectedRefreshCount?: number;
  sessionRebuildCount?: number;
  recoveryStatus?: BrowserVerificationRecoveryStatus;
  recoveryReason?: string;
  error?: string;
}

export interface BrowserVerificationCaptureOffsets {
  console: number;
  network: number;
  openedUrls: number;
  interactions: number;
  downloads: number;
  screenshots: number;
  visualComparisons: number;
  expectations: number;
  semanticSnapshots: number;
}

export interface BrowserVerificationCaptureWindow {
  startedAt: string;
  endedAt?: string;
  sessionId: string;
  start: BrowserVerificationCaptureOffsets;
  end?: BrowserVerificationCaptureOffsets;
  targetUrls: string[];
  pageIds: string[];
}

export interface BrowserVerificationRunState {
  schemaVersion?: number;
  runId: string;
  sessionId: string;
  originalSessionId?: string;
  currentSessionId?: string;
  status: BrowserVerificationRunStatus;
  createdAt: string;
  updatedAt: string;
  reportPath: string;
  statePath: string;
  options?: BrowserVerificationRecoveryOptions;
  capture?: BrowserVerificationCaptureWindow;
  spaceId?: string;
  retainBrowser?: boolean;
  timeoutMs?: number;
  createdTabIds?: string[];
  cleanup?: BrowserVerificationCleanupState;
  steps: BrowserVerificationStep[];
  completedSteps: number;
  failedSteps: number;
  blockedSteps?: number;
  pendingSteps?: number;
  consoleErrorCount?: number;
  networkFailureCount?: number;
  unexpectedRefreshCount?: number;
  sessionRebuildCount?: number;
  sessionRebuilds?: BrowserVerificationSessionRebuild[];
  recoveryAttempts?: number;
  recoveryStatus?: BrowserVerificationRecoveryStatus;
  lastRecoveryReason?: string;
  recoveryBlockedReason?: string;
  browser?: {
    requestedMode: CodexProConfig["browserMode"];
    effectiveMode?: CodexProConfig["browserMode"];
    requireExtensionAuth: boolean;
    allowHeadlessFallback: boolean;
    fallbackReason?: string;
    reconnectAttempts: number;
    lastReconnectAt?: string;
    reconnectFailureReason?: string;
  };
}

export interface BrowserVisualRegressionSessionOptions {
  beforeUrl: string;
  afterUrl: string;
  label?: string;
  devices?: BrowserDevicePreset[];
  fullPage?: boolean;
  waitUntil?: PlaywrightWaitUntil;
  timeoutMs?: number;
  thresholdRatio?: number;
  pixelDeltaThreshold?: number;
}

export interface BrowserClickSessionOptions {
  button?: BrowserClickButton;
  timeoutMs?: number;
}

export interface BrowserTypeSessionOptions {
  clear?: boolean;
  delayMs?: number;
  timeoutMs?: number;
  skipIfValueMatches?: boolean;
}

export interface BrowserWaitSessionOptions {
  state?: BrowserWaitState;
  timeoutMs?: number;
}

export interface BrowserExpectTextSessionOptions {
  selector?: string;
  mode?: BrowserTextMatchMode;
  timeoutMs?: number;
  caseSensitive?: boolean;
}

export interface BrowserExpectUrlSessionOptions {
  mode?: BrowserUrlMatchMode;
  timeoutMs?: number;
}

export interface BrowserExpectHiddenSessionOptions {
  timeoutMs?: number;
}

export interface BrowserReportWriteOptions {
  verificationRunId?: string;
}

export interface BrowserReportWriteResult {
  path: string;
  content: string;
  consolePath: string;
  networkPath: string;
  downloadsPath: string;
  reportKind: "session_diagnostic" | "verification_evidence";
  acceptanceEligible: boolean;
  verificationRunId?: string;
  browserSessionId?: string;
  pageId?: string;
  requestedUrl?: string;
  finalUrl?: string;
  device?: string;
  expectationResult: "passed" | "failed" | "not_run";
  textExpectationPassed: boolean;
  urlExpectationPassed: boolean;
  consoleErrorCount: number;
  networkFailureCount: number;
  screenshotRef?: string;
  conclusion: "passed" | "failed" | "diagnostic_only";
}

export interface BrowserDownloadFingerprint {
  type: "url_contains" | "hostname_contains" | "title_contains" | "text_contains" | "element_text_contains" | "accessible_name_contains";
  value: string;
  required?: boolean;
}

export interface BrowserDownloadContextExpectation {
  platform?: string;
  shop_context?: BrowserShopContext;
  business_object?: BrowserBusinessObject;
  page_fingerprints: BrowserDownloadFingerprint[];
  required_visible_text?: string[];
}

export interface BrowserDownloadSessionOptions {
  task: BrowserBusinessTask;
  ref: string;
  selector?: string;
  snapshotId: string;
  elementFingerprint: BrowserDownloadElementFingerprint;
  timeoutMs?: number;
  context: BrowserDownloadContextExpectation;
  prevalidatedSnapshot?: BrowserSemanticSnapshot;
}

export function browserDownloadFingerprintFromElement(element: BrowserSemanticElement): BrowserDownloadElementFingerprint {
  const ref = String(element.ref ?? "").trim();
  const selector = String(element.selector ?? "").trim();
  const tagName = String(element.tagName ?? "").trim().toLowerCase();
  const role = String(element.role ?? "").trim().toLowerCase();
  if (!/^e\d+$/.test(ref) || !selector || !tagName || !role) {
    throw new CodexProError("browser_download requires a complete observed element fingerprint with ref, selector, tagName, and role.");
  }
  if (!element.visible || !element.clickable || element.disabled) {
    throw new CodexProError("browser_download target must be visible, clickable, and enabled in the bound snapshot.");
  }
  return {
    ref,
    selector,
    tagName,
    role,
    name: element.name,
    text: element.text,
    hrefAbsent: !element.href,
    visible: true,
    clickable: true,
    containerRef: element.containerRef,
    containerRole: element.containerRole,
    containerTextContains: element.containerText
  };
}

interface BrowserPolicy {
  allowedDomains: string[];
}

const HIGH_RISK_BROWSER_CLICK_WORDS = [
  "pay",
  "payment",
  "purchase",
  "checkout",
  "submit order",
  "order submit",
  "clear data",
  "production config",
  "prod config",
  "delete",
  "remove",
  "publish",
  "send message",
  "send reply",
  "reply to customer",
  "submit message",
  "send email",
  "send mail",
  ["pass", "word"].join(""),
  ["付", "款"].join(""),
  ["删", "除"].join(""),
  ["发", "布"].join(""),
  ["发送", "消息"].join(""),
  ["发送", "回复"].join(""),
  ["回复", "客户"].join(""),
  ["提交", "消息"].join(""),
  ["发", "邮件"].join(""),
  ["发送", "邮件"].join(""),
  ["密", "码"].join(""),
  ["改", "密码"].join(""),
  ["修改", "密码"].join(""),
  ["提交", "订单"].join(""),
  ["清空", "数据"].join(""),
  ["清除", "数据"].join(""),
  ["生产", "配置"].join(""),
  "оплатить",
  "удалить",
  "опубликовать",
  "отправить сообщение",
  "ответить",
  "отправить ответ",
  "пароль"
];

const HIGH_RISK_BROWSER_TYPE_WORDS = [
  "production config",
  "prod config",
  ["pass", "word"].join(""),
  ["密", "码"].join(""),
  ["改", "密码"].join(""),
  ["修改", "密码"].join(""),
  ["生产", "配置"].join(""),
  "пароль"
];

function browserElementRiskText(action: BrowserInteractionAction, selector: string, element?: Partial<BrowserElementSummary>): string {
  return [action, selector, element?.text, element?.ariaLabel, element?.role, element?.type, element?.name, element?.id, element?.href, element?.placeholder].filter(Boolean).join(" ").toLowerCase();
}

export function detectHighRiskBrowserInteraction(action: BrowserInteractionAction, selector: string, element?: Partial<BrowserElementSummary>): string | undefined {
  const haystack = browserElementRiskText(action, selector, element);
  const words = action === "type" ? HIGH_RISK_BROWSER_TYPE_WORDS : action === "click" ? HIGH_RISK_BROWSER_CLICK_WORDS : [];
  const matched = words.find((word) => haystack.includes(word));
  return matched ? `matched high-risk browser interaction keyword: ${matched}` : undefined;
}

function highRiskBrowserBlockMessage(action: BrowserInteractionAction, reason: string): string {
  return `Blocked browser_${action}: ${reason}. This final high-risk action is prohibited by browser safety policy.`;
}

function createBlockedBrowserInteractionEntry(args: {
  action: BrowserInteractionAction;
  selector: string;
  timeoutMs: number;
  url: string;
  element?: BrowserElementSummary;
  textLength?: number;
  reason: string;
}): Omit<BrowserInteractionEntry, "timestamp"> {
  return {
    action: args.action,
    selector: args.selector,
    passed: false,
    timeoutMs: args.timeoutMs,
    url: args.url,
    element: args.element,
    textLength: args.textLength,
    error: highRiskBrowserBlockMessage(args.action, args.reason)
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const CLOUD_METADATA_HOSTS = new Set(["metadata", "metadata.google.internal"]);
const CLOUD_METADATA_IPS = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);
const NON_NAVIGABLE_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32]
];

function timestamp(): string {
  return new Date().toISOString();
}

function reportStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function normalizeAllowedDomain(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const wildcard = trimmed.startsWith("*.") ? "*." : "";
  const withoutWildcard = wildcard ? trimmed.slice(2) : trimmed;
  try {
    const parsed = new URL(withoutWildcard.includes("://") ? withoutWildcard : `http://${withoutWildcard}`);
    if (!parsed.hostname) return undefined;
    return `${wildcard}${normalizeHost(parsed.hostname)}`;
  } catch {
    return undefined;
  }
}

function hostMatchesDomain(host: string, allowedDomain: string): boolean {
  const normalizedHost = normalizeHost(host);
  const domain = normalizeAllowedDomain(allowedDomain);
  if (!domain) return false;
  if (domain.startsWith("*.")) {
    const root = domain.slice(2);
    return normalizedHost === root || normalizedHost.endsWith(`.${root}`);
  }
  return normalizedHost === domain;
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host));
}

function isCloudMetadataHost(host: string): boolean {
  const normalizedHost = normalizeHost(host);
  return CLOUD_METADATA_HOSTS.has(normalizedHost) || CLOUD_METADATA_IPS.has(normalizedHost);
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    out = (out << 8) + value;
  }
  return out >>> 0;
}

function ipv4InCidr(address: string, base: string, prefix: number): boolean {
  const value = ipv4ToInt(address);
  const baseValue = ipv4ToInt(base);
  if (value === undefined || baseValue === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isForbiddenIPv4Address(address: string): boolean {
  return CLOUD_METADATA_IPS.has(address) || NON_NAVIGABLE_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function isForbiddenIPv6Address(address: string): boolean {
  const normalized = normalizeHost(address);
  const firstHextet = normalized.split(":")[0] ?? "";
  if (CLOUD_METADATA_IPS.has(normalized)) return true;
  if (normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  if (/^ff[0-9a-f]{0,2}$/i.test(firstHextet)) return true;
  if (normalized.startsWith("::ffff:")) {
    const embedded = normalized.slice("::ffff:".length);
    return net.isIP(embedded) === 4 ? isForbiddenIPv4Address(embedded) : false;
  }
  return false;
}

function isForbiddenAddress(hostOrAddress: string, _options: { allowLoopback?: boolean } = {}): boolean {
  const normalized = normalizeHost(hostOrAddress);
  if (isLoopbackHost(normalized)) return false;
  if (isCloudMetadataHost(normalized)) return true;
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isForbiddenIPv4Address(normalized);
  if (ipVersion === 6) return isForbiddenIPv6Address(normalized);
  return false;
}

async function resolveHostAddresses(host: string): Promise<string[]> {
  const normalized = normalizeHost(host);
  if (net.isIP(normalized) || isLoopbackHost(normalized) || isCloudMetadataHost(normalized)) return [];
  try {
    const records = await lookup(normalized, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

function sanitizeFileStem(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  const sanitized = raw
    .replace(/\.[A-Za-z0-9]{1,8}$/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function relJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function safePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed) || trimmed.includes("\0")) {
    throw new CodexProError(`Invalid ${label}: path traversal is not allowed.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(trimmed)) {
    throw new CodexProError(`Invalid ${label}: use only letters, numbers, dot, dash, colon, or underscore.`);
  }
  return trimmed;
}

function sanitizeDownloadFilename(value: string | undefined, fallback: string): string {
  const base = path.basename(String(value ?? "").replaceAll("\\", "/")).trim() || fallback;
  const withoutControls = base.replace(/[\0-\x1f\x7f]/g, "");
  const sanitized = withoutControls
    .replace(/^\.+/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return sanitized || fallback;
}

function splitFileName(fileName: string): { stem: string; ext: string } {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || "download";
  return { stem, ext };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html"
};

function mimeFromFilename(fileName: string): { mime: string; source: "playwright" | "extension" | "fallback" } {
  const ext = path.extname(fileName).toLowerCase();
  const mime = MIME_BY_EXTENSION[ext];
  return mime
    ? { mime, source: "extension" }
    : { mime: "application/octet-stream", source: "fallback" };
}

async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  const tmpPath = `${absPath}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, jsonReplacer, 2), "utf8");
  await fsp.rename(tmpPath, absPath);
}

function normalizeForMatch(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function textIncludes(haystack: string | undefined, needle: string): boolean {
  return normalizeForMatch(haystack).includes(normalizeForMatch(needle));
}

function snapshotSearchText(snapshot: BrowserSemanticSnapshot): string {
  return [
    snapshot.url,
    snapshot.title,
    snapshot.text,
    ...snapshot.elements.map((element) => [element.text, element.name, element.role, element.placeholder].filter(Boolean).join(" ")),
    ...(snapshot.accessibility ?? []).map((node) => [node.name, node.description, node.role].filter(Boolean).join(" "))
  ].filter(Boolean).join("\n");
}

function fingerprintMatched(fingerprint: BrowserDownloadFingerprint, snapshot: BrowserSemanticSnapshot): boolean {
  if (fingerprint.type === "url_contains") return textIncludes(snapshot.url, fingerprint.value);
  if (fingerprint.type === "hostname_contains") {
    try {
      return textIncludes(new URL(snapshot.url).hostname, fingerprint.value);
    } catch {
      return false;
    }
  }
  if (fingerprint.type === "title_contains") return textIncludes(snapshot.title, fingerprint.value);
  if (fingerprint.type === "text_contains") return textIncludes(snapshot.text, fingerprint.value);
  if (fingerprint.type === "element_text_contains") {
    return textIncludes(snapshot.elements.map((element) => [element.text, element.name, element.role, element.placeholder].filter(Boolean).join(" ")).join("\n"), fingerprint.value);
  }
  if (fingerprint.type === "accessible_name_contains") {
    return (snapshot.accessibility ?? []).some((node) => textIncludes(node.name, fingerprint.value));
  }
  return false;
}

function requiredContextValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function visualLabelFromUrls(beforeUrl: string, afterUrl: string): string {
  try {
    const before = new URL(beforeUrl);
    const after = new URL(afterUrl);
    const beforePath = before.pathname && before.pathname !== "/" ? before.pathname : "home";
    const afterPath = after.pathname && after.pathname !== "/" ? after.pathname : "home";
    return sanitizeFileStem(`${before.hostname}${beforePath}-vs-${after.hostname}${afterPath}`, "visual-regression");
  } catch {
    return "visual-regression";
  }
}

function normalizeDevices(devices: BrowserDevicePreset[] | undefined): BrowserDevicePreset[] {
  const selected = devices?.length ? devices : ["desktop", "mobile"];
  return [...new Set(selected)].filter((device): device is BrowserDevicePreset => device === "desktop" || device === "mobile");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (isRecord(value)) return value;
  return value;
}

function assertVerificationRunId(runId: string): void {
  if (!BROWSER_VERIFICATION_RUN_ID_PATTERN.test(runId)) {
    throw new CodexProError("Invalid browser verification run_id. Verification runs use UUID identifiers.");
  }
}

function verificationPageId(runId: string, pageIndex: number, device: BrowserDevicePreset): string {
  return `page-${pageIndex + 1}-${device}-${hashShort(`${runId}:${pageIndex}:${device}`)}`;
}

function isTerminalVerificationStep(status: BrowserVerificationStepStatus): boolean {
  return status === "passed" || status === "failed" || status === "skipped" || status === "blocked";
}

export function isTerminalVerificationRunStatus(status: BrowserVerificationRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "blocked" || status === "recoverable" || status === "cancelled" || status === "timed_out";
}

function isSuccessfulVerificationStep(status: BrowserVerificationStepStatus): boolean {
  return status === "passed" || status === "skipped";
}

function countConsoleErrors(entries: BrowserConsoleEntry[]): number {
  return entries.filter((entry) => entry.type.toLowerCase() === "error").length;
}

function assertNoPersistedVerificationUrlSecret(rawUrl: string): void {
  if (redactSensitiveText(rawUrl) !== rawUrl) {
    throw new CodexProError("browser_verification_run refuses URLs containing token-like query parameters because recovery state persists executable URLs.");
  }
}

function browserVerificationErrorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function classifyBrowserVerificationError(error: unknown): {
  stepStatus: BrowserVerificationStepStatus;
  recoveryStatus: BrowserVerificationRecoveryStatus;
  reason: string;
} {
  const message = browserVerificationErrorMessage(error);
  const lowered = message.toLowerCase();
  if (
    lowered.includes("authorization") ||
    lowered.includes("authorize") ||
    lowered.includes("protocol") ||
    lowered.includes("blocked browser url") ||
    lowered.includes("refuses urls containing") ||
    lowered.includes("only supports http") ||
    lowered.includes("username/password") ||
    lowered.includes("cloud metadata") ||
    lowered.includes("private, reserved")
  ) {
    return { stepStatus: "blocked", recoveryStatus: "blocked", reason: message };
  }
  if (
    lowered.includes("cdp") ||
    lowered.includes("target closed") ||
    lowered.includes("browser closed") ||
    lowered.includes("page closed") ||
    lowered.includes("has been closed") ||
    lowered.includes("connection") ||
    lowered.includes("disconnected") ||
    lowered.includes("connect") ||
    lowered.includes("websocket")
  ) {
    return { stepStatus: "failed", recoveryStatus: "recoverable", reason: message };
  }
  return { stepStatus: "failed", recoveryStatus: "not_needed", reason: message };
}

function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertReportWriteAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  throw new CodexProError(`Browser reports cannot be written because CODEXPRO_WRITE_MODE=${config.writeMode}.`);
}

async function readBrowserPolicy(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<BrowserPolicy> {
  const project = await readProjectConfig(config, guard, workspace);
  const configuredDomains = (project.config.browser?.allowed_domains ?? []).map((item) => item.trim()).filter(Boolean);
  if (configuredDomains.length === 0) return { allowedDomains: [] };

  const allowedDomains = configuredDomains.map((item) => {
    const normalized = normalizeAllowedDomain(item);
    if (!normalized) throw new CodexProError(`Invalid browser.allowed_domains entry: ${redactSensitiveText(item)}`);
    return normalized;
  });
  return { allowedDomains: [...new Set(allowedDomains)] };
}

async function assertUrlAllowed(rawUrl: string, policy: BrowserPolicy): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CodexProError(`Invalid browser URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CodexProError("browser_open only supports http(s) URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new CodexProError("browser_open refuses URLs containing username/password credentials.");
  }

  const host = normalizeHost(parsed.hostname);
  if (policy.allowedDomains.length > 0 && !policy.allowedDomains.some((domain) => hostMatchesDomain(host, domain))) {
    throw new CodexProError(`Blocked browser URL because ${host} is not included in browser.allowed_domains.`);
  }
  if (isForbiddenAddress(host)) {
    throw new CodexProError(`Blocked browser URL targeting cloud metadata or a non-navigable address: ${host}`);
  }

  const forbiddenResolvedAddress = (await resolveHostAddresses(host)).find((address) => isForbiddenAddress(address));
  if (forbiddenResolvedAddress) {
    throw new CodexProError(`Blocked browser URL because ${host} resolves to cloud metadata or a non-navigable address ${forbiddenResolvedAddress}.`);
  }

  return parsed.toString();
}

export async function assertBrowserUrlAllowed(config: CodexProConfig, guard: PathGuard, workspace: Workspace, rawUrl: string): Promise<string> {
  const policy = await readBrowserPolicy(config, guard, workspace);
  return assertUrlAllowed(rawUrl, policy);
}

export class BrowserSession {
  readonly sessionId = randomUUID();
  readonly createdAt = timestamp();
  private lastUsedAt = this.createdAt;
  private policy: BrowserPolicy = { allowedDomains: [] };
  private readonly adapter: PlaywrightBrowserAdapter;
  private readonly runDir: string;
  private readonly consoleEntries: BrowserConsoleEntry[] = [];
  private readonly networkEntries: BrowserNetworkEntry[] = [];
  private readonly openedUrls: BrowserOpenedUrlEntry[] = [];
  private readonly interactions: BrowserInteractionEntry[] = [];
  private readonly downloads: BrowserDownloadEntry[] = [];
  private readonly screenshots: BrowserScreenshotEntry[] = [];
  private readonly visualComparisons: BrowserVisualComparisonEntry[] = [];
  private readonly inspections: BrowserInspectionArtifacts["inspection"][] = [];
  private readonly multimodalEvidence: BrowserInspectionArtifacts["multimodal"][] = [];
  private readonly evidenceConflicts: BrowserInspectionArtifacts["conflicts"] = [];
  private readonly expectations: BrowserExpectationEntry[] = [];
  private readonly semanticSnapshots = new Map<string, BrowserSemanticSnapshot>();
  private readonly semanticSnapshotOrder: string[] = [];
  private readonly semanticObserveCursors = new Map<string, BrowserObserveCursorState>();
  private readonly readonlySemanticElements = new Map<string, BrowserSemanticElement>();
  private readonly semanticTables = new Map<string, Map<string, BrowserSemanticSnapshotData["tables"][number]>>();
  private readonly verificationRuns = new Map<string, BrowserVerificationRunState>();
  private readonly verificationOptions = new Map<string, BrowserVerificationRecoveryOptions>();
  private readonly verificationCancellationRequests = new Map<string, { status: "cancelled" | "timed_out"; reason: string }>();
  private readonly verificationExecution = new AsyncLocalStorage<string>();
  private activeVerificationRunId: string | undefined;
  private activeVerificationPromise: Promise<void> | undefined;
  private authorization: BrowserTabAuthorization | undefined;
  readonly spaceId: string;
  readonly spaceMode: BrowserSpaceMode;

  constructor(
    private readonly config: CodexProConfig,
    private readonly guard: PathGuard,
    private readonly workspace: Workspace,
    options: BrowserSessionScopeOptions = {}
  ) {
    this.spaceId = options.spaceId ?? BROWSER_DEFAULT_SPACE_ID;
    this.spaceMode = options.mode ?? "shared_profile";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(this.spaceId)) {
      throw new CodexProError("Invalid browser space id: use 1-80 letters, numbers, dot, dash, or underscore.");
    }
    const reportIdentity = this.spaceId === BROWSER_DEFAULT_SPACE_ID ? workspace.root : `${workspace.root}\0${this.spaceId}`;
    this.runDir = relJoin(BROWSER_REPORT_ROOT, `${reportStamp()}-${hashShort(reportIdentity)}`);
    this.adapter = new PlaywrightBrowserAdapter(
      {
        onConsole: (entry) => this.consoleEntries.push(entry),
        onNetwork: (entry) => this.networkEntries.push(entry)
      },
      {
        mode: config.browserMode,
        cdpUrl: config.browserCdpUrl,
        cdpProfileDir: config.browserCdpProfileDir,
        cdpDownloadDir: config.browserCdpDownloadDir,
        cdpDownloadMountDir: config.browserCdpDownloadMountDir,
        cdpConnectTimeoutMs: config.browserCdpConnectTimeoutMs,
        allowHeadlessFallback: config.browserAllowHeadlessFallback,
        spaceMode: this.spaceMode,
        ensureCdpAvailable: () => ensureDedicatedBrowserBridge(config, workspace.root),
        assertMainFrameNavigationAllowed: async (url) => {
          await this.assertNavigationAllowed(url);
        }
      }
    );
  }

  async bindAuthorization(authorizationId?: string): Promise<{ authorization: BrowserTabAuthorization; tab: BrowserTabEntry }> {
    this.touch();
    const authorization = authorizationId ? browserAuthorizationStore.get(authorizationId) : browserAuthorizationStore.latest();
    if (!authorization) throw new CodexProError("No active Chrome extension authorization. Authorize the current tab in the CodexPro Chrome extension first.");
    const tab = await this.adapter.bindAuthorizedTab(authorization.authorizationId);
    await this.assertNavigationAllowed(tab.url);
    this.authorization = authorization;
    return { authorization, tab };
  }

  authorizationStatus(): {
    required: boolean;
    authorized: boolean;
    authorization?: BrowserTabAuthorization;
    bound: boolean;
    expiresInMs: number | null;
    expectedProtocolVersion: string;
    actualProtocolVersion: string | null;
    protocolCompatible: boolean | null;
  } {
    const currentAuthorization = this.authorization
      ? browserAuthorizationStore.get(this.authorization.authorizationId)
      : undefined;
    const authorization = currentAuthorization ?? browserAuthorizationStore.latest();
    this.authorization = currentAuthorization;
    const adapterStatus = this.adapter.status();
    const actualProtocolVersion = authorization?.extensionProtocolVersion ?? null;
    return {
      required: this.config.browserMode === "cdp" && this.config.browserRequireExtensionAuth,
      authorized: Boolean(authorization),
      authorization,
      bound: Boolean(authorization && adapterStatus.authorizationId === authorization.authorizationId),
      expiresInMs: authorization ? Math.max(0, Date.parse(authorization.expiresAt) - Date.now()) : null,
      expectedProtocolVersion: BROWSER_EXTENSION_PROTOCOL_VERSION,
      actualProtocolVersion,
      protocolCompatible: actualProtocolVersion ? actualProtocolVersion === BROWSER_EXTENSION_PROTOCOL_VERSION : null
    };
  }

  async recoverAuthorizationBinding(): Promise<ReturnType<BrowserSession["authorizationStatus"]>> {
    this.touch();
    const status = this.authorizationStatus();
    if (!status.required || !status.authorized || status.bound || status.protocolCompatible === false) return status;
    try {
      await this.bindAuthorization(status.authorization?.authorizationId);
    } catch {
      // Binding is a best-effort status recovery path. Callers still receive the
      // current authorization state and can use browser_runtime_probe for details.
    }
    return this.authorizationStatus();
  }

  releaseAuthorization(authorizationId?: string): boolean {
    this.touch();
    const targetId = authorizationId ?? this.authorization?.authorizationId;
    if (!targetId) return false;
    const released = browserAuthorizationStore.release(targetId);
    if (this.authorization?.authorizationId === targetId) this.authorization = undefined;
    this.adapter.releaseAuthorization();
    return released;
  }

  private async assertNavigationAllowed(rawUrl: string): Promise<string> {
    this.policy = await readBrowserPolicy(this.config, this.guard, this.workspace);
    return assertUrlAllowed(rawUrl, this.policy);
  }

  private async assertCurrentPageAllowed(): Promise<string> {
    const currentUrl = this.adapter.currentUrl();
    if (!currentUrl) throw new CodexProError("Browser interaction requires an open http(s) page.");
    return this.assertNavigationAllowed(currentUrl);
  }

  async open(rawUrl: string, options: BrowserOpenSessionOptions = {}): Promise<BrowserOpenedUrlEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const device = options.device ?? "desktop";
    const requestedUrl = redactSensitiveText(rawUrl);
    try {
      const allowedUrl = await this.assertNavigationAllowed(rawUrl);
      const result = await this.adapter.open(allowedUrl, {
        device,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs
      });
      const finalUrl = await this.assertNavigationAllowed(result.url);
      const entry: BrowserOpenedUrlEntry = {
        timestamp: timestamp(),
        requestedUrl,
        finalUrl: redactSensitiveText(finalUrl),
        title: result.title,
        device: result.device,
        opened: true,
        navigated: result.navigated
      };
      this.openedUrls.push(entry);
      return entry;
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const entry: BrowserOpenedUrlEntry = {
        timestamp: timestamp(),
        requestedUrl,
        finalUrl: "",
        title: "",
        device,
        opened: false,
        error: redactSensitiveText(message)
      };
      this.openedUrls.push(entry);
      throw error;
    }
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const linkedSnapshot = options.linkedSnapshotId
      ? this.semanticSnapshots.get(options.linkedSnapshotId)
      : await this.observe({ scope: "viewport", maxNodes: 250, maxTextChars: 16_000, includeTables: true, includeForms: true, includeLayoutIssues: true, includeAccessibility: true });
    if (!linkedSnapshot || linkedSnapshot.sessionId !== this.sessionId || linkedSnapshot.url !== this.adapter.currentUrl()) {
      throw new CodexProError("Browser screenshot requires a current semantic snapshot from the same session and page.");
    }
    const fallback = `screenshot-${options.device ?? "current"}-${reportStamp()}`;
    const fileName = `${sanitizeFileStem(options.name, fallback)}.png`;
    const relPath = relJoin(this.reportRoot(), fileName);
    const absPath = await this.resolveReportPath(relPath);
    const result = await this.adapter.screenshot(absPath, { device: options.device, fullPage: options.fullPage });
    const entry: BrowserScreenshotEntry = {
      timestamp: timestamp(),
      path: relPath,
      device: result.device,
      url: this.adapter.currentUrl(),
      bytes: result.bytes,
      reason: options.reason ?? "manual",
      scope: options.fullPage === false ? "viewport" : "full_page",
      linkedSnapshotId: linkedSnapshot.snapshotId,
      redacted: true,
      sensitiveMaskApplied: true,
      mayAuthorizeInteraction: false
    };
    this.screenshots.push(entry);
    return entry;
  }

  async visualRegression(options: BrowserVisualRegressionSessionOptions): Promise<BrowserVisualComparisonEntry[]> {
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const label = sanitizeFileStem(options.label, visualLabelFromUrls(options.beforeUrl, options.afterUrl));
    const devices = normalizeDevices(options.devices);
    if (!devices.length) throw new CodexProError("browser_visual_regression requires at least one device: desktop or mobile.");

    const comparisons: BrowserVisualComparisonEntry[] = [];
    for (const device of devices) {
      const before = await this.open(options.beforeUrl, {
        device,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs
      });
      const beforeScreenshot = await this.screenshot({
        name: `before-${label}-${device}`,
        device,
        fullPage: options.fullPage
      });

      const after = await this.open(options.afterUrl, {
        device,
        waitUntil: options.waitUntil,
        timeoutMs: options.timeoutMs
      });
      const afterScreenshot = await this.screenshot({
        name: `after-${label}-${device}`,
        device,
        fullPage: options.fullPage
      });

      const diffRelPath = relJoin(this.reportRoot(), `diff-${label}-${device}.png`);
      const comparison = await comparePngFiles({
        timestamp: timestamp(),
        label,
        device,
        beforeUrl: before.finalUrl,
        afterUrl: after.finalUrl,
        beforePath: this.resolveWorkspacePath(beforeScreenshot.path),
        afterPath: this.resolveWorkspacePath(afterScreenshot.path),
        beforeRelPath: beforeScreenshot.path,
        afterRelPath: afterScreenshot.path,
        diffPath: await this.resolveReportPath(diffRelPath),
        diffRelPath,
        thresholdRatio: options.thresholdRatio,
        pixelDeltaThreshold: options.pixelDeltaThreshold
      });
      this.visualComparisons.push(comparison);
      comparisons.push(comparison);
    }
    return comparisons;
  }

  async click(selector: string, options: BrowserClickSessionOptions = {}): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const timeoutMs = options.timeoutMs ?? 5000;
    const element = await this.adapter.elementSummary(selector, timeoutMs);
    const riskReason = detectHighRiskBrowserInteraction("click", selector, element);
    if (riskReason) {
      const entry: BrowserInteractionEntry = {
        ...createBlockedBrowserInteractionEntry({
          action: "click",
          selector,
          timeoutMs,
          url: this.adapter.currentUrl() ?? "",
          element,
          reason: riskReason
        }),
        timestamp: timestamp()
      };
      this.interactions.push(entry);
      throw new CodexProError(entry.error ?? highRiskBrowserBlockMessage("click", riskReason));
    }
    const result = await this.adapter.click(selector, { button: options.button, timeoutMs });
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async type(selector: string, text: string, options: BrowserTypeSessionOptions = {}): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const timeoutMs = options.timeoutMs ?? 5000;
    const element = await this.adapter.elementSummary(selector, timeoutMs);
    const riskReason = detectHighRiskBrowserInteraction("type", selector, element);
    if (riskReason) {
      const entry: BrowserInteractionEntry = {
        ...createBlockedBrowserInteractionEntry({
          action: "type",
          selector,
          timeoutMs,
          url: this.adapter.currentUrl() ?? "",
          element,
          textLength: text.length,
          reason: riskReason
        }),
        timestamp: timestamp()
      };
      this.interactions.push(entry);
      throw new CodexProError(entry.error ?? highRiskBrowserBlockMessage("type", riskReason));
    }
    if (options.skipIfValueMatches && await this.adapter.inputValueMatches(selector, text, timeoutMs)) {
      const entry: BrowserInteractionEntry = {
        action: "type",
        selector,
        passed: true,
        timeoutMs,
        url: this.adapter.currentUrl() ?? "",
        element,
        textLength: text.length,
        idempotentReplay: true,
        timestamp: timestamp()
      };
      this.interactions.push(entry);
      return entry;
    }
    const result = await this.adapter.type(selector, {
      text,
      clear: options.clear !== false,
      delayMs: options.delayMs ?? 0,
      timeoutMs
    });
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async wait(selector: string, options: BrowserWaitSessionOptions = {}): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const result = await this.adapter["waitForSelector"](selector, { state: options.state ?? "visible", timeoutMs: options.timeoutMs ?? 5000 });
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async select(selector: string, options: { value?: string; label?: string; timeoutMs?: number } = {}): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const result = await this.adapter.select(selector, { value: options.value, label: options.label, timeoutMs: options.timeoutMs ?? 5000 });
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async check(selector: string, checked = true, timeoutMs = 5000): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const result = await this.adapter.check(selector, { checked, timeoutMs });
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async scrollIntoView(selector: string, timeoutMs = 5000): Promise<BrowserInteractionEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const result = await this.adapter.scrollIntoView(selector, timeoutMs);
    const entry: BrowserInteractionEntry = { ...result, timestamp: timestamp() };
    this.interactions.push(entry);
    return entry;
  }

  async download(options: BrowserDownloadSessionOptions): Promise<BrowserDownloadEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    await this.assertCurrentPageAllowed();
    const task = validateBrowserBusinessTask(options.task);
    assertBrowserBusinessActionPermitted(task, "download", "browser_download");
    const target = options.ref?.trim();
    if (!target || !/^e\d+$/.test(target)) throw new CodexProError("browser_download requires a stable e* ref from browser_observe.");
    if (options.selector) throw new CodexProError("browser_download is ref-bound; selector-only or mixed targeting is not allowed.");
    if (!options.snapshotId?.trim()) throw new CodexProError("browser_download requires snapshot_id from the latest browser_observe result.");
    if (options.elementFingerprint.ref !== target) throw new CodexProError(`browser_download ref mismatch: target ${target} does not match element_fingerprint.ref ${options.elementFingerprint.ref}.`);
    safePathSegment(task.task_id, "browser_download task_id");
    if (task.run_id !== task.run_identity.runId) throw new CodexProError("browser_download task run_id must match run_identity.runId.");
    const timeoutMs = options.timeoutMs ?? 30_000;
    const context = {
      ...options.context,
      platform: options.context.platform ?? task.platform,
      shop_context: options.context.shop_context ?? task.shop_context,
      business_object: options.context.business_object ?? task.business_object
    };
    const storedSnapshot = this.semanticSnapshots.get(options.snapshotId);
    const snapshot = options.prevalidatedSnapshot ?? storedSnapshot;
    if (!snapshot || snapshot.snapshotId !== options.snapshotId || snapshot.sessionId !== this.sessionId) {
      throw new CodexProError("browser_download snapshot_id is unknown or belongs to another browser session; observe again.");
    }
    const latestSnapshotId = this.semanticSnapshotOrder[this.semanticSnapshotOrder.length - 1];
    if (latestSnapshotId !== options.snapshotId) {
      throw new CodexProError(`browser_download stale snapshot_id ${options.snapshotId}; latest snapshot is ${latestSnapshotId ?? "none"}. Observe again before downloading.`);
    }
    this.assertDownloadContext(task, context, snapshot);
    this.assertDownloadElementFingerprint(snapshot, target, options.elementFingerprint, "bound snapshot");

    const liveData = enrichSemanticSnapshotData(await this.adapter.observe({
      scope: "document",
      maxNodes: Math.min(this.config.browserObserveMaxNodes, 700),
      maxTextChars: Math.min(this.config.browserObserveMaxTextChars, 50_000),
      includeTables: true,
      includeForms: true,
      includeLayoutIssues: true,
      includeAccessibility: true
    }));
    const liveSnapshot: BrowserSemanticSnapshot = {
      ...liveData,
      snapshotId: snapshot.snapshotId,
      timestamp: timestamp(),
      sessionId: this.sessionId,
      snapshotVersion: BROWSER_SEMANTIC_SNAPSHOT_VERSION,
      spaceId: snapshot.spaceId,
      redacted: true,
      evidencePath: snapshot.evidencePath,
      observationScope: "document",
      pagination: { ...liveData.pagination, chunkIndex: 0 }
    };
    if (liveSnapshot.url !== snapshot.url || liveSnapshot.title !== snapshot.title || liveSnapshot.documentVersion !== snapshot.documentVersion) {
      throw new CodexProError("browser_download page changed after browser_observe; stale ref blocked.");
    }
    this.assertDownloadContext(task, context, liveSnapshot);
    this.assertDownloadElementFingerprint(liveSnapshot, target, options.elementFingerprint, "live page");

    const downloadId = this.downloadIdFor({
      task,
      target,
      context,
      snapshotUrl: snapshot.url,
      snapshotId: snapshot.snapshotId,
      elementFingerprint: options.elementFingerprint
    });
    const taskDownloadDir = relJoin(BROWSER_DOWNLOAD_ROOT, safePathSegment(task.task_id, "browser_download task_id"));
    const downloadDir = this.spaceId === BROWSER_DEFAULT_SPACE_ID
      ? taskDownloadDir
      : relJoin(taskDownloadDir, "spaces", this.spaceId);
    const credentialPath = relJoin(downloadDir, `download-${downloadId}.json`);
    const existing = await this.readDownloadCredential(credentialPath);
    if (existing) {
      const recovered = await this.ensureDownloadDurableMessage(existing);
      const replayed = { ...recovered, replayed: true };
      this.downloads.push(replayed);
      return replayed;
    }

    let adapterResult: BrowserDownloadAdapterResult;
    try {
      adapterResult = await this.adapter.download(target, { timeoutMs, expectedElement: options.elementFingerprint });
    } catch (error) {
      adapterResult = {
        status: "failed",
        selector: target,
        timeoutMs,
        sourceUrl: snapshot.url,
        finalUrl: this.adapter.currentUrl() ?? snapshot.url,
        error: browserVerificationErrorMessage(error)
      };
    }

    const entry = adapterResult.status === "completed"
      ? await this.persistCompletedDownload({
          task,
          target,
          downloadId,
          downloadDir,
          credentialPath,
          adapterResult,
          snapshot
        })
      : await this.persistNonCompletedDownload({
          task,
          target,
          downloadId,
          credentialPath,
          adapterResult,
          snapshot
        });
    this.downloads.push(entry);
    return entry;
  }

  async getElement(selector: string, timeoutMs = 5000): Promise<BrowserElementSummary | BrowserSemanticElement> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    if (/^r\d+$/.test(selector)) {
      const latest = [...this.semanticSnapshotOrder].reverse()
        .map((snapshotId) => this.semanticSnapshots.get(snapshotId))
        .find((snapshot): snapshot is BrowserSemanticSnapshot => snapshot?.source === "native_cdp");
      if (!latest) throw new CodexProError(`Read-only element ref ${selector} is unknown or expired. Run browser_observe again.`);
      const ordinal = Number(selector.slice(1));
      const live = enrichSemanticSnapshotData(await this.adapter.observe({
        scope: "document",
        maxNodes: 1000,
        nodeOffset: Math.floor(Math.max(0, ordinal - 1) / 1000) * 1000,
        maxTextChars: 1000,
        includeTables: false,
        includeForms: false,
        includeLayoutIssues: false,
        includeAccessibility: true
      }));
      if (live.url !== latest.url || live.documentVersion !== latest.documentVersion || live.pageRevision !== latest.pageRevision) {
        this.readonlySemanticElements.clear();
        throw new CodexProError(`Read-only element ref ${selector} is stale after page navigation or semantic revision. Run browser_observe again.`);
      }
      for (const element of live.elements) this.readonlySemanticElements.set(element.ref, element);
      const observed = this.readonlySemanticElements.get(selector);
      if (observed) return { ...observed };
      throw new CodexProError(`Read-only element ref ${selector} no longer exists in the current page revision. Run browser_observe again.`);
    }
    return this.adapter.elementSummary(selector, timeoutMs);
  }

  console(level?: string): BrowserConsoleEntry[] {
    this.touch();
    this.assertAuthorizedIfRequired();
    const normalized = level?.trim().toLowerCase();
    if (!normalized) return [...this.consoleEntries];
    return this.consoleEntries.filter((entry) => entry.type.toLowerCase() === normalized);
  }

  network(failedOnly = true): BrowserNetworkEntry[] {
    this.touch();
    this.assertAuthorizedIfRequired();
    if (failedOnly) return [...this.networkEntries];
    return [...this.networkEntries];
  }

  async expectText(expected: string, options: BrowserExpectTextSessionOptions = {}): Promise<BrowserExpectationEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const result: BrowserExpectationResult = await this.adapter.expectText(expected, {
      selector: options.selector,
      mode: options.mode ?? "contains",
      timeoutMs: options.timeoutMs ?? 5000,
      caseSensitive: options.caseSensitive
    });
    const entry: BrowserExpectationEntry = {
      ...result,
      timestamp: timestamp(),
      type: "text",
      selector: options.selector
    };
    this.expectations.push(entry);
    return entry;
  }

  async expectUrl(expected: string, options: BrowserExpectUrlSessionOptions = {}): Promise<BrowserExpectationEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const result: BrowserExpectationResult = await this.adapter.expectUrl(expected, {
      mode: options.mode ?? "contains",
      timeoutMs: options.timeoutMs ?? 5000
    });
    const entry: BrowserExpectationEntry = {
      ...result,
      timestamp: timestamp(),
      type: "url"
    };
    this.expectations.push(entry);
    return entry;
  }

  async expectHidden(selector: string, options: BrowserExpectHiddenSessionOptions = {}): Promise<BrowserExpectationEntry> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const result = await this.adapter.expectHidden(selector, { timeoutMs: options.timeoutMs ?? 5000 });
    const entry: BrowserExpectationEntry = { ...result, timestamp: timestamp(), type: "hidden", selector };
    this.expectations.push(entry);
    return entry;
  }

  async observe(options: BrowserObserveSessionOptions = {}): Promise<BrowserSemanticSnapshot> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const rawData = await this.adapter.observe({
      ...options,
      nodeOffset: 0,
      textOffset: 0,
      maxNodes: options.maxNodes ?? this.config.browserObserveMaxNodes,
      maxTextChars: options.maxTextChars ?? this.config.browserObserveMaxTextChars
    });
    const data = enrichSemanticSnapshotData(rawData);
    const refCounts = new Map<string, number>();
    for (const element of data.elements) refCounts.set(element.ref, (refCounts.get(element.ref) ?? 0) + 1);
    const duplicateRefs = [...refCounts.entries()].filter(([, count]) => count > 1).map(([ref]) => ref);
    if (duplicateRefs.length) {
      throw new CodexProError(`browser_observe produced duplicate semantic refs: ${duplicateRefs.join(", ")}. Snapshot rejected.`);
    }
    const previous = options.sinceSnapshotId ? this.semanticSnapshots.get(options.sinceSnapshotId) : undefined;
    const snapshotId = randomUUID();
    const evidencePath = this.semanticSnapshotEvidencePath(snapshotId, 0);
    const snapshot: BrowserSemanticSnapshot = {
      ...data,
      snapshotId,
      previousSnapshotId: previous?.snapshotId,
      timestamp: timestamp(),
      sessionId: this.sessionId,
      snapshotVersion: BROWSER_SEMANTIC_SNAPSHOT_VERSION,
      spaceId: this.spaceId,
      redacted: true,
      evidencePath,
      observationScope: options.scope ?? "viewport",
      pagination: {
        ...data.pagination,
        chunkIndex: 0
      },
      changes: previous ? this.diffSemanticSnapshots(previous, data) : undefined
    };
    if (snapshot.source === "native_cdp") {
      this.readonlySemanticElements.clear();
      for (const element of snapshot.elements) this.readonlySemanticElements.set(element.ref, element);
    }
    if (data.pagination.hasMore) snapshot.pagination.nextCursor = this.issueObserveCursor(snapshot, options, 1);
    this.semanticSnapshots.set(snapshot.snapshotId, snapshot);
    this.semanticTables.set(snapshot.snapshotId, new Map(snapshot.tables.map((table) => [table.ref, table])));
    this.semanticSnapshotOrder.push(snapshot.snapshotId);
    while (this.semanticSnapshotOrder.length > 10) {
      const oldest = this.semanticSnapshotOrder.shift();
      if (oldest) {
        this.semanticSnapshots.delete(oldest);
        this.semanticTables.delete(oldest);
      }
    }
    await this.persistSemanticSnapshot(snapshot);
    return snapshot;
  }

  async observeContinue(cursor: string): Promise<BrowserSemanticSnapshot> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const state = this.semanticObserveCursors.get(cursor);
    if (!state || state.sessionId !== this.sessionId) {
      throw new CodexProError("browser_observe_continue cursor is unknown, expired, already consumed, or belongs to another browser session.");
    }
    const rawData = await this.adapter.observe({
      ...state.options,
      nodeOffset: state.nodeOffset,
      textOffset: state.textOffset,
      maxNodes: state.options.maxNodes ?? this.config.browserObserveMaxNodes,
      maxTextChars: state.options.maxTextChars ?? this.config.browserObserveMaxTextChars
    });
    const data = enrichSemanticSnapshotData(rawData);
    if (data.url !== state.url || data.pageId !== state.pageId || data.documentVersion !== state.documentVersion || data.pageRevision !== state.pageRevision) {
      this.semanticObserveCursors.delete(cursor);
      throw new CodexProError("browser_observe_continue cursor is stale because the page URL, document, or semantic revision changed. Start a new browser_observe.");
    }
    this.semanticObserveCursors.delete(cursor);
    const evidencePath = this.semanticSnapshotEvidencePath(state.snapshotId, state.chunkIndex);
    const chunk: BrowserSemanticSnapshot = {
      ...data,
      snapshotId: state.snapshotId,
      timestamp: timestamp(),
      sessionId: this.sessionId,
      snapshotVersion: BROWSER_SEMANTIC_SNAPSHOT_VERSION,
      spaceId: state.spaceId,
      redacted: true,
      evidencePath,
      observationScope: state.options.scope ?? "viewport",
      pagination: {
        ...data.pagination,
        chunkIndex: state.chunkIndex
      }
    };
    if (chunk.source === "native_cdp") {
      for (const element of chunk.elements) this.readonlySemanticElements.set(element.ref, element);
    }
    const knownTables = this.semanticTables.get(chunk.snapshotId) ?? new Map();
    for (const table of chunk.tables) knownTables.set(table.ref, table);
    this.semanticTables.set(chunk.snapshotId, knownTables);
    if (data.pagination.hasMore) chunk.pagination.nextCursor = this.issueObserveCursor(chunk, state.options, state.chunkIndex + 1);
    await this.persistSemanticSnapshot(chunk);
    return chunk;
  }

  async extractTable(options: { snapshotId: string; tableRef: string; maxRows?: number; maxScrolls?: number; uniqueKeyHint?: string }): Promise<BrowserTableExtraction> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const snapshot = this.semanticSnapshots.get(options.snapshotId);
    if (!snapshot || snapshot.sessionId !== this.sessionId) throw new CodexProError("browser_extract_table snapshot_id is unknown or belongs to another browser session.");
    if (snapshot.url !== this.adapter.currentUrl()) throw new CodexProError("browser_extract_table snapshot is stale after navigation. Observe the current page again.");
    const table = this.semanticTables.get(snapshot.snapshotId)?.get(options.tableRef) ?? snapshot.tables.find((entry) => entry.ref === options.tableRef);
    if (!table) throw new CodexProError(`browser_extract_table ref ${options.tableRef} is not a table in snapshot ${options.snapshotId}.`);
    const adapterResult = await this.adapter.extractTable(options.tableRef, {
      maxRows: options.maxRows,
      maxScrolls: options.maxScrolls,
      uniqueKeyHint: options.uniqueKeyHint
    });
    const extractionId = randomUUID();
    const evidencePath = relJoin(this.snapshotEvidenceRoot(), "snapshots", `${snapshot.snapshotId}-table-${extractionId}.json`);
    const result: BrowserTableExtraction = {
      ...adapterResult,
      version: 1,
      extractionId,
      snapshotId: snapshot.snapshotId,
      sessionId: this.sessionId,
      spaceId: this.spaceId,
      redacted: true,
      evidencePath
    };
    await writeJsonAtomic(await this.resolveReportPath(evidencePath), {
      version: result.version,
      extraction_id: result.extractionId,
      snapshot_id: result.snapshotId,
      session_id: result.sessionId,
      space_id: result.spaceId,
      page_id: snapshot.pageId,
      table_ref: result.tableRef,
      columns: result.columns,
      rows: result.rows,
      unique_key: result.uniqueKey ?? null,
      deduplicated_rows: result.deduplicatedRows,
      loaded_range: result.loadedRange,
      limits: { max_rows: result.maxRows, max_scrolls: result.maxScrolls, scrolls_used: result.scrollsUsed },
      completeness: result.completeness,
      possible_more: result.possibleMore,
      redacted: result.redacted,
      limitations: result.limitations,
      evidence_path: result.evidencePath
    });
    return result;
  }

  async visualObserve(options: BrowserVisualObserveSessionOptions): Promise<BrowserScreenshotEntry & { reason: string; scope: string }> {
    this.touch();
    this.assertVerificationAccess();
    await this.ensureAuthorizedIfRequired();
    const linkedSnapshot = options.linkedSnapshotId
      ? this.semanticSnapshots.get(options.linkedSnapshotId)
      : await this.observe({ scope: "viewport", maxNodes: 250, maxTextChars: 16_000, includeTables: true, includeForms: true, includeLayoutIssues: true, includeAccessibility: true });
    if (!linkedSnapshot || linkedSnapshot.sessionId !== this.sessionId) {
      throw new CodexProError("Visual evidence requires a semantic snapshot from the current browser session.");
    }
    if (linkedSnapshot.url !== this.adapter.currentUrl()) {
      throw new CodexProError("Visual evidence semantic snapshot is stale after page navigation.");
    }
    if (["selector", "region", "frame"].includes(options.scope ?? "") && !options.selector) {
      throw new CodexProError(`${options.scope} visual evidence requires a bounded stable ref or selector.`);
    }
    const fallback = `visual-${options.reason}-${reportStamp()}`;
    const fileName = `${sanitizeFileStem(options.name, fallback)}.png`;
    const relPath = relJoin(this.reportRoot(), fileName);
    const absPath = await this.resolveReportPath(relPath);
    const result = await this.adapter.visualScreenshot(absPath, options);
    const entry: BrowserScreenshotEntry & { reason: string; scope: string } = {
      timestamp: timestamp(),
      path: relPath,
      device: result.device,
      url: this.adapter.currentUrl(),
      bytes: result.bytes,
      reason: options.reason,
      scope: options.scope ?? "viewport",
      linkedSnapshotId: linkedSnapshot.snapshotId,
      redacted: true,
      sensitiveMaskApplied: true,
      mayAuthorizeInteraction: false
    };
    this.screenshots.push(entry);
    return entry;
  }

  async persistInspectionArtifacts(artifacts: BrowserInspectionArtifacts): Promise<{ inspectionPath: string; multimodalPath: string; conflictsPath: string }> {
    const paths = inspectionArtifactPaths(this.reportRoot(), artifacts.inspection.inspection_id);
    if (artifacts.inspection.report_path !== paths.inspection) throw new CodexProError("Browser inspection report path does not match the session report root.");
    for (const evidence of artifacts.multimodal.visual_evidence) {
      if (evidence.linked_snapshot_id !== artifacts.inspection.semantic_snapshot_id) throw new CodexProError("Visual evidence must link to the inspection semantic snapshot.");
      if (evidence.may_authorize_interaction !== false) throw new CodexProError("Visual evidence cannot authorize browser interaction.");
    }
    await writeJsonAtomic(await this.resolveReportPath(paths.inspection), artifacts.inspection);
    await writeJsonAtomic(await this.resolveReportPath(paths.multimodal), artifacts.multimodal);
    await writeJsonAtomic(await this.resolveReportPath(paths.conflicts), artifacts.conflicts);
    this.inspections.push(artifacts.inspection);
    this.multimodalEvidence.push(artifacts.multimodal);
    this.evidenceConflicts.push(...artifacts.conflicts);
    return { inspectionPath: paths.inspection, multimodalPath: paths.multimodal, conflictsPath: paths.conflicts };
  }

  private verificationCaptureOffsets(): BrowserVerificationCaptureOffsets {
    return {
      console: this.consoleEntries.length,
      network: this.networkEntries.length,
      openedUrls: this.openedUrls.length,
      interactions: this.interactions.length,
      downloads: this.downloads.length,
      screenshots: this.screenshots.length,
      visualComparisons: this.visualComparisons.length,
      expectations: this.expectations.length,
      semanticSnapshots: this.semanticSnapshotOrder.length
    };
  }

  private completeVerificationCapture(state: BrowserVerificationRunState): void {
    if (!state.capture) return;
    state.capture.endedAt = state.capture.endedAt ?? timestamp();
    state.capture.end = state.capture.end ?? this.verificationCaptureOffsets();
  }

  async startVerification(options: BrowserVerificationRunOptions): Promise<BrowserVerificationRunState> {
    this.touch();
    if (this.activeVerificationRunId) throw new CodexProError(`Browser verification run is already active: ${this.activeVerificationRunId}`);
    await this.ensureAuthorizedIfRequired();
    const recoveryOptions = await this.normalizeVerificationRecoveryOptions(options);
    const devices = recoveryOptions.devices;
    const runId = options.runId ?? randomUUID();
    assertVerificationRunId(runId);
    const tabsBefore = await this.adapter.listTabs().catch(() => []);
    let preparedTabId: string | undefined;
    const createOwnedPage = (this.adapter as any).createOwnedPage;
    if (typeof createOwnedPage === "function") {
      const prepared = await createOwnedPage.call(this.adapter, devices[0] ?? "desktop");
      preparedTabId = prepared?.tabId;
    }
    const tabsAfter = await this.adapter.listTabs().catch(() => []);
    const beforeIds = new Set(tabsBefore.map((tab) => tab.tabId));
    const createdTabIds = [...new Set([
      ...tabsAfter.filter((tab) => tab.ownedByCodexPro && !beforeIds.has(tab.tabId)).map((tab) => tab.tabId),
      ...(preparedTabId ? [preparedTabId] : [])
    ])];
    const runDir = relJoin(this.reportRoot(), `verification-${runId}`);
    const statePath = relJoin(runDir, "state.json");
    const reportPath = relJoin(runDir, "report.md");
    const steps: BrowserVerificationStep[] = [];
    let index = 0;
    for (let pageIndex = 0; pageIndex < recoveryOptions.pages.length; pageIndex += 1) {
      const page = recoveryOptions.pages[pageIndex];
      for (const device of devices) {
        steps.push({
          index: index++,
          pageId: verificationPageId(runId, pageIndex, device),
          pageIndex,
          url: redactSensitiveText(page.url),
          label: page.label,
          device,
          status: "pending",
          expectation: {
            url: redactSensitiveText(page.url),
            expectText: page.expectText ? redactSensitiveText(page.expectText) : undefined,
            visual: page.visual,
            visualReason: page.visualReason
          },
          consoleErrorCount: 0,
          networkFailureCount: 0,
          unexpectedRefreshCount: 0,
          sessionRebuildCount: 0
        });
      }
    }
    const createdAt = timestamp();
    const state: BrowserVerificationRunState = {
      schemaVersion: BROWSER_VERIFICATION_STATE_SCHEMA_VERSION,
      runId,
      sessionId: this.sessionId,
      originalSessionId: this.sessionId,
      currentSessionId: this.sessionId,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      reportPath,
      statePath,
      options: recoveryOptions,
      spaceId: recoveryOptions.spaceId ?? this.spaceId,
      retainBrowser: Boolean(recoveryOptions.retainBrowser),
      timeoutMs: recoveryOptions.timeoutMs,
      createdTabIds,
      cleanup: {
        required: !recoveryOptions.retainBrowser,
        status: "pending",
        createdTabIds: [...createdTabIds],
        closedTabIds: [],
        spaceClosed: false,
        resourceReleased: false,
        leakDetected: false,
        leakReasons: []
      },
      capture: {
        startedAt: createdAt,
        sessionId: this.sessionId,
        start: this.verificationCaptureOffsets(),
        targetUrls: [...new Set(steps.map((step) => step.url))],
        pageIds: steps.map((step) => step.pageId).filter((value): value is string => Boolean(value))
      },
      steps,
      completedSteps: 0,
      failedSteps: 0,
      blockedSteps: 0,
      pendingSteps: steps.length,
      consoleErrorCount: 0,
      networkFailureCount: 0,
      unexpectedRefreshCount: 0,
      sessionRebuildCount: 0,
      sessionRebuilds: [],
      recoveryAttempts: 0,
      recoveryStatus: "not_needed"
    };
    this.captureVerificationBrowserContext(state);
    this.verificationRuns.set(runId, state);
    this.verificationOptions.set(runId, structuredClone(recoveryOptions));
    await this.persistVerificationState(state);
    this.launchVerificationRun(state, recoveryOptions);
    return this.cloneVerificationState(state);
  }

  async verificationStatus(runId: string): Promise<BrowserVerificationRunState> {
    this.touch();
    const state = await this.getOrLoadVerificationRun(runId);
    this.syncVerificationCounts(state);
    return this.cloneVerificationState(state);
  }

  async verificationResult(runId: string): Promise<BrowserVerificationRunState> {
    const state = await this.getOrLoadVerificationRun(runId);
    this.syncVerificationCounts(state);
    if (isTerminalVerificationRunStatus(state.status)) {
      await this.writeVerificationReport(state);
    }
    return this.cloneVerificationState(state);
  }

  async recordVerificationCleanup(runId: string, cleanup: BrowserVerificationCleanupState): Promise<BrowserVerificationRunState> {
    const state = await this.getOrLoadVerificationRun(runId);
    state.createdTabIds = [...new Set([...(state.createdTabIds ?? []), ...cleanup.createdTabIds])];
    state.cleanup = {
      ...cleanup,
      createdTabIds: [...state.createdTabIds],
      closedTabIds: [...new Set(cleanup.closedTabIds)]
    };
    state.updatedAt = timestamp();
    await this.persistVerificationState(state);
    if (isTerminalVerificationRunStatus(state.status)) await this.writeVerificationReport(state).catch(() => undefined);
    return this.cloneVerificationState(state);
  }

  async cancelVerification(runId: string, reason = "Browser verification cancelled by user.", status: "cancelled" | "timed_out" = "cancelled"): Promise<BrowserVerificationRunState> {
    const state = await this.getOrLoadVerificationRun(runId);
    if (isTerminalVerificationRunStatus(state.status)) return this.cloneVerificationState(state);
    const safeReason = redactSensitiveText(reason);
    this.verificationCancellationRequests.set(runId, { status, reason: safeReason });
    if (this.activeVerificationRunId === runId) {
      await this.adapter.disconnect().catch(() => undefined);
      const active = this.activeVerificationPromise;
      if (active) await Promise.race([active.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
    const current = await this.getOrLoadVerificationRun(runId);
    if (!isTerminalVerificationRunStatus(current.status)) await this.markVerificationCancelled(current, status, safeReason);
    return this.cloneVerificationState(current);
  }

  async resumeVerification(runId: string): Promise<BrowserVerificationRunState> {
    this.touch();
    const state = await this.getOrLoadVerificationRun(runId);
    const activeSameRun = this.activeVerificationRunId === runId;
    if (activeSameRun && (state.status === "running" || state.status === "pending")) return this.cloneVerificationState(state);
    if (state.status === "completed") {
      await this.writeVerificationReport(state).catch(() => undefined);
      return this.cloneVerificationState(state);
    }
    if (this.activeVerificationRunId && this.activeVerificationRunId !== runId) throw new CodexProError(`Browser verification run is already active: ${this.activeVerificationRunId}`);
    state.recoveryAttempts = (state.recoveryAttempts ?? 0) + 1;
    state.lastRecoveryReason = state.lastRecoveryReason ?? "resume_requested";
    const options = state.options ?? this.verificationOptions.get(runId);
    if (!options) {
      await this.markVerificationBlocked(state, "Persisted verification state does not include recovery options; this pre-L4 run is not safely resumable after process restart.");
      return this.cloneVerificationState(state);
    }
    try {
      await this.ensureAuthorizedIfRequired();
      await this.validateVerificationRecoveryOptions(options);
    } catch (error) {
      const classification = classifyBrowserVerificationError(error);
      await this.markVerificationBlocked(state, classification.reason);
      return this.cloneVerificationState(state);
    }
    this.verificationCancellationRequests.delete(runId);
    const createOwnedPage = (this.adapter as any).createOwnedPage;
    if (typeof createOwnedPage === "function") {
      const prepared = await createOwnedPage.call(this.adapter, state.steps.find((step) => !isSuccessfulVerificationStep(step.status))?.device ?? "desktop");
      if (prepared?.tabId) state.createdTabIds = [...new Set([...(state.createdTabIds ?? []), prepared.tabId])];
    }
    state.cleanup = {
      required: !state.retainBrowser,
      status: "pending",
      createdTabIds: [...(state.createdTabIds ?? [])],
      closedTabIds: [],
      spaceClosed: false,
      resourceReleased: false,
      leakDetected: false,
      leakReasons: []
    };
    for (const step of state.steps) {
      if (step.status === "passed" || step.status === "skipped") continue;
      step.status = "pending";
      step.startedAt = undefined;
      step.finishedAt = undefined;
      step.snapshotId = undefined;
      step.visualPath = undefined;
      step.evidence = undefined;
      step.consoleErrorCount = 0;
      step.networkFailureCount = 0;
      step.unexpectedRefreshCount = 0;
      step.recoveryStatus = "recoverable";
      step.recoveryReason = "reset_for_resume";
      step.error = undefined;
    }
    const resumedAt = timestamp();
    state.capture = {
      startedAt: resumedAt,
      sessionId: this.sessionId,
      start: this.verificationCaptureOffsets(),
      targetUrls: [...new Set(state.steps.map((step) => step.url))],
      pageIds: state.steps.map((step) => step.pageId).filter((value): value is string => Boolean(value))
    };
    state.status = "pending";
    state.recoveryStatus = "recoverable";
    state.recoveryBlockedReason = undefined;
    state.lastRecoveryReason = "resume_requested";
    this.syncVerificationCounts(state);
    state.updatedAt = resumedAt;
    this.captureVerificationBrowserContext(state);
    await this.persistVerificationState(state);
    this.launchVerificationRun(state, options);
    return this.cloneVerificationState(state);
  }

  status(): BrowserBridgeStatus & { sessionId: string; sessionCreatedAt: string; lastUsedAt: string; spaceId: string; spaceMode: BrowserSpaceMode; reportRoot: string } {
    return {
      ...this.adapter.status(),
      sessionId: this.sessionId,
      sessionCreatedAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      spaceId: this.spaceId,
      spaceMode: this.spaceMode,
      reportRoot: this.reportRoot(),
      authorization: this.authorizationStatus()
    } as BrowserBridgeStatus & { sessionId: string; sessionCreatedAt: string; lastUsedAt: string; spaceId: string; spaceMode: BrowserSpaceMode; reportRoot: string; authorization: ReturnType<BrowserSession["authorizationStatus"]> };
  }

  reportRoot(): string {
    return this.spaceId === BROWSER_DEFAULT_SPACE_ID ? this.runDir : relJoin(this.runDir, "spaces", this.spaceId);
  }

  async tabs(): Promise<BrowserTabEntry[]> {
    const tabs = await this.adapter.listTabs();
    if (this.config.browserMode !== "cdp" || !this.config.browserRequireExtensionAuth) return tabs;
    const status = this.authorizationStatus();
    if (!status.bound) return [];
    return tabs.filter((tab) => tab.current);
  }

  hasActiveWork(): boolean {
    return Boolean(this.activeVerificationPromise);
  }

  async disconnect(): Promise<ReturnType<BrowserSession["status"]>> {
    this.touch();
    const activeVerification = this.activeVerificationPromise;
    await this.adapter.disconnect();
    if (activeVerification) await activeVerification.catch(() => undefined);
    return this.status();
  }

  private capturedSlice<T>(items: T[], start: number, end: number | undefined): T[] {
    const safeStart = Math.max(0, Math.min(items.length, start));
    const safeEnd = Math.max(safeStart, Math.min(items.length, end ?? items.length));
    return items.slice(safeStart, safeEnd);
  }

  private async verificationSnapshot(state: BrowserVerificationRunState): Promise<BrowserReportSnapshot> {
    const capture = state.capture;
    if (!capture) throw new CodexProError(`Browser verification run ${state.runId} does not contain an isolated capture window.`);
    const currentOffsets = this.verificationCaptureOffsets();
    const end = capture.end ?? currentOffsets;
    const allSemanticSnapshots = this.semanticSnapshotOrder.map((id) => this.semanticSnapshots.get(id)).filter(Boolean) as BrowserSemanticSnapshot[];
    const terminal = isTerminalVerificationRunStatus(state.status);
    const sameSession = capture.sessionId === (state.currentSessionId ?? state.sessionId);
    const cleanupVerified = state.retainBrowser
      ? state.cleanup?.status === "retained"
      : state.cleanup?.status === "completed" && state.cleanup.resourceReleased && !state.cleanup.leakDetected;
    const screenshots = this.capturedSlice(this.screenshots, capture.start.screenshots, end.screenshots);
    const expectations = this.capturedSlice(this.expectations, capture.start.expectations, end.expectations);
    const consoleEntries = this.capturedSlice(this.consoleEntries, capture.start.console, end.console);
    const networkEntries = this.capturedSlice(this.networkEntries, capture.start.network, end.network);
    const hasTextExpectation = expectations.some((entry) => entry.type === "text" && entry.passed);
    const hasUrlExpectation = expectations.some((entry) => entry.type === "url" && entry.passed);
    const acceptanceEligible = terminal
      && state.status === "completed"
      && Boolean(capture.endedAt && capture.end)
      && sameSession
      && cleanupVerified
      && screenshots.length > 0
      && hasTextExpectation
      && hasUrlExpectation
      && expectations.every((entry) => entry.passed)
      && consoleEntries.filter((entry) => entry.type === "error").length === 0
      && networkEntries.length === 0;
    const finalUrl = [...state.steps].reverse().find((step) => step.evidence?.finalUrl)?.evidence?.finalUrl
      ?? [...state.steps].reverse().find((step) => step.url)?.url
      ?? this.adapter.currentUrl();
    return {
      generatedAt: timestamp(),
      scope: {
        kind: "verification_evidence",
        acceptanceEligible,
        browserSessionId: state.currentSessionId ?? state.sessionId,
        verificationRunId: state.runId,
        captureStartedAt: capture.startedAt,
        captureEndedAt: capture.endedAt,
        targetUrls: capture.targetUrls,
        pageIds: capture.pageIds
      },
      workspaceId: this.workspace.id,
      root: this.workspace.root,
      reportDir: path.dirname(state.statePath).split(path.sep).join("/"),
      currentUrl: finalUrl,
      allowedDomains: this.policy.allowedDomains,
      bridge: this.status(),
      tabs: (await this.adapter.listTabs()).filter((tab) => tab.current),
      semanticSnapshots: this.capturedSlice(allSemanticSnapshots, capture.start.semanticSnapshots, end.semanticSnapshots),
      verificationRuns: [this.cloneVerificationState(state)],
      openedUrls: this.capturedSlice(this.openedUrls, capture.start.openedUrls, end.openedUrls),
      interactions: this.capturedSlice(this.interactions, capture.start.interactions, end.interactions),
      downloads: this.capturedSlice(this.downloads, capture.start.downloads, end.downloads),
      screenshots,
      visualComparisons: this.capturedSlice(this.visualComparisons, capture.start.visualComparisons, end.visualComparisons),
      console: consoleEntries,
      network: networkEntries,
      expectations
    };
  }

  async writeReport(options: BrowserReportWriteOptions = {}): Promise<BrowserReportWriteResult> {
    const state = options.verificationRunId ? await this.getOrLoadVerificationRun(options.verificationRunId) : undefined;
    const snapshot = state ? await this.verificationSnapshot(state) : await this.snapshot();
    const content = formatBrowserReport(snapshot);
    const reportKind = snapshot.scope?.kind ?? "session_diagnostic";
    const reportDir = state ? path.dirname(state.statePath).split(path.sep).join("/") : this.reportRoot();
    const prefix = state ? "evidence-" : "";
    const relPath = relJoin(reportDir, `${prefix}report.md`);
    const consolePath = relJoin(reportDir, `${prefix}console.json`);
    const networkPath = relJoin(reportDir, `${prefix}network.json`);
    const downloadsPath = relJoin(reportDir, `${prefix}downloads.json`);
    const absPath = await this.resolveReportPath(relPath);
    const absConsolePath = await this.resolveReportPath(consolePath);
    const absNetworkPath = await this.resolveReportPath(networkPath);
    const absDownloadsPath = await this.resolveReportPath(downloadsPath);
    await fsp.writeFile(absPath, content, "utf8");
    await fsp.writeFile(absConsolePath, JSON.stringify(snapshot.console, jsonReplacer, 2), "utf8");
    await fsp.writeFile(absNetworkPath, JSON.stringify(snapshot.network, jsonReplacer, 2), "utf8");
    await fsp.writeFile(absDownloadsPath, JSON.stringify(snapshot.downloads ?? [], jsonReplacer, 2), "utf8");
    const firstOpen = snapshot.openedUrls[0];
    const lastOpen = snapshot.openedUrls.at(-1);
    const lastScreenshot = snapshot.screenshots.at(-1);
    const expectationResult = snapshot.expectations.length === 0
      ? "not_run"
      : snapshot.expectations.every((entry) => entry.passed) ? "passed" : "failed";
    const textExpectationPassed = snapshot.expectations.some((entry) => entry.type === "text" && entry.passed);
    const urlExpectationPassed = snapshot.expectations.some((entry) => entry.type === "url" && entry.passed);
    const consoleErrorCount = snapshot.console.filter((entry) => entry.type === "error").length;
    const networkFailureCount = snapshot.network.length;
    const acceptanceEligible = snapshot.scope?.acceptanceEligible ?? false;
    return {
      path: relPath,
      content,
      consolePath,
      networkPath,
      downloadsPath,
      reportKind,
      acceptanceEligible,
      browserSessionId: snapshot.scope?.browserSessionId,
      pageId: snapshot.scope?.pageIds?.[0],
      requestedUrl: firstOpen?.requestedUrl ?? snapshot.scope?.targetUrls?.[0],
      finalUrl: lastOpen?.finalUrl ?? snapshot.currentUrl,
      device: lastScreenshot?.device ?? lastOpen?.device,
      expectationResult,
      textExpectationPassed,
      urlExpectationPassed,
      consoleErrorCount,
      networkFailureCount,
      screenshotRef: lastScreenshot?.path,
      conclusion: reportKind === "session_diagnostic" ? "diagnostic_only" : acceptanceEligible ? "passed" : "failed",
      ...(state ? { verificationRunId: state.runId } : {})
    };
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  async snapshot(): Promise<BrowserReportSnapshot> {
    return {
      generatedAt: timestamp(),
      scope: {
        kind: "session_diagnostic",
        acceptanceEligible: false,
        browserSessionId: this.sessionId
      },
      workspaceId: this.workspace.id,
      root: this.workspace.root,
      reportDir: this.reportRoot(),
      currentUrl: this.adapter.currentUrl(),
      allowedDomains: this.policy.allowedDomains,
      bridge: this.status(),
      tabs: await this.adapter.listTabs(),
      semanticSnapshots: this.semanticSnapshotOrder.map((id) => this.semanticSnapshots.get(id)).filter(Boolean) as BrowserSemanticSnapshot[],
      verificationRuns: [...this.verificationRuns.values()].map((state) => this.cloneVerificationState(state)),
      openedUrls: [...this.openedUrls],
      interactions: [...this.interactions],
      downloads: [...this.downloads],
      screenshots: [...this.screenshots],
      visualComparisons: [...this.visualComparisons],
      inspections: [...this.inspections],
      multimodalEvidence: [...this.multimodalEvidence],
      evidenceConflicts: [...this.evidenceConflicts],
      console: [...this.consoleEntries],
      network: [...this.networkEntries],
      expectations: [...this.expectations]
    };
  }

  private assertDownloadElementFingerprint(
    snapshot: BrowserSemanticSnapshot,
    target: string,
    expected: BrowserDownloadElementFingerprint,
    source: string
  ): void {
    const matches = snapshot.elements.filter((element) => element.ref === target);
    if (matches.length !== 1) {
      throw new CodexProError(`browser_download ${source} must contain exactly one element for ${target}; found ${matches.length}.`);
    }
    const actual = matches[0];
    const actualFingerprint = browserDownloadFingerprintFromElement(actual);
    const mismatches: string[] = [];
    if (actualFingerprint.selector !== expected.selector) mismatches.push("selector");
    if (actualFingerprint.tagName !== expected.tagName.toLowerCase()) mismatches.push("tagName");
    if (actualFingerprint.role !== expected.role.toLowerCase()) mismatches.push("role");
    if (expected.name && String(actualFingerprint.name ?? "").replace(/\s+/g, " ").trim() !== String(expected.name).replace(/\s+/g, " ").trim()) mismatches.push("name");
    if (expected.text && String(actualFingerprint.text ?? "").replace(/\s+/g, " ").trim() !== String(expected.text).replace(/\s+/g, " ").trim()) mismatches.push("text");
    if (expected.hrefAbsent && actual.href) mismatches.push("href");
    if (actualFingerprint.containerRef !== expected.containerRef) mismatches.push("containerRef");
    if (expected.containerRole && String(actualFingerprint.containerRole ?? "").toLowerCase() !== expected.containerRole.toLowerCase()) mismatches.push("containerRole");
    if (expected.containerTextContains && !String(actual.containerText ?? "").replace(/\s+/g, " ").trim().includes(String(expected.containerTextContains).replace(/\s+/g, " ").trim())) mismatches.push("containerText");
    if (mismatches.length) {
      throw new CodexProError(`browser_download ${source} element fingerprint changed (${mismatches.join(", ")}); click blocked.`);
    }
    if (expected.containerRef) {
      const containerMatches = snapshot.elements.filter((element) => element.ref === expected.containerRef);
      if (containerMatches.length !== 1) {
        throw new CodexProError(`browser_download ${source} export container ${expected.containerRef} is missing or ambiguous.`);
      }
    }
  }

  private assertDownloadContext(
    task: BrowserBusinessTask,
    context: BrowserDownloadContextExpectation,
    snapshot: BrowserSemanticSnapshot
  ): void {
    if (!context.page_fingerprints?.length) {
      throw new CodexProError("browser_download requires at least one page fingerprint before clicking.");
    }
    assertBusinessContextMatches(task, {
      platform: context.platform,
      shop_context: context.shop_context,
      business_object: context.business_object
    }, "browser_download expected context");

    const searchText = snapshotSearchText(snapshot);
    if (!textIncludes(searchText, context.platform ?? task.platform)) {
      throw new CodexProError(`browser_download page platform mismatch: expected visible ${context.platform ?? task.platform}.`);
    }
    const shopValues = requiredContextValues([
      context.shop_context?.shop_id,
      context.shop_context?.shop_name,
      context.shop_context?.display_name,
      context.shop_context?.account_id
    ]);
    if (!shopValues.some((value) => textIncludes(searchText, value))) {
      throw new CodexProError("browser_download shop context is not visible on the current page; stop instead of downloading across shops.");
    }
    const businessObjectValues = requiredContextValues([
      context.business_object?.id,
      context.business_object?.display_name,
      context.business_object?.type
    ]);
    if (!businessObjectValues.some((value) => textIncludes(searchText, value))) {
      throw new CodexProError("browser_download business object is not visible on the current page; stop instead of guessing.");
    }
    const missingFingerprints = context.page_fingerprints
      .filter((fingerprint) => fingerprint.required !== false && !fingerprintMatched(fingerprint, snapshot))
      .map((fingerprint) => `${fingerprint.type}:${fingerprint.value}`);
    if (missingFingerprints.length) {
      throw new CodexProError(`browser_download page fingerprint mismatch: ${missingFingerprints.join(", ")}.`);
    }
    const missingVisibleText = (context.required_visible_text ?? [])
      .filter((value) => !textIncludes(searchText, value));
    if (missingVisibleText.length) {
      throw new CodexProError(`browser_download required page text is missing: ${missingVisibleText.join(", ")}.`);
    }
  }

  private downloadIdFor(input: {
    task: BrowserBusinessTask;
    target: string;
    context: BrowserDownloadContextExpectation;
    snapshotUrl: string;
    snapshotId: string;
    elementFingerprint: BrowserDownloadElementFingerprint;
  }): string {
    return hashShort(JSON.stringify({
      task_id: input.task.task_id,
      run_id: input.task.run_id,
      task_contract_hash: input.task.task_contract_hash,
      target: input.target,
      platform: input.context.platform,
      shop_context: input.context.shop_context,
      business_object: input.context.business_object,
      page_fingerprints: input.context.page_fingerprints,
      required_visible_text: input.context.required_visible_text,
      snapshot_id: input.snapshotId,
      element_fingerprint: input.elementFingerprint,
      page_origin: (() => {
        try {
          const url = new URL(input.snapshotUrl);
          return `${url.origin}${url.pathname}`;
        } catch {
          return input.snapshotUrl;
        }
      })()
    }));
  }

  private async readDownloadCredential(relPath: string): Promise<BrowserDownloadEntry | undefined> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.resolveWorkspacePath(relPath), "utf8")) as BrowserDownloadEntry;
      if (!parsed || typeof parsed !== "object" || parsed.credential_path !== relPath || !parsed.download_id) return undefined;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async uniqueDownloadFilePath(downloadDir: string, safeFilename: string): Promise<{ relPath: string; absPath: string; finalName: string; collisionRenamed: boolean }> {
    const { stem, ext } = splitFileName(safeFilename);
    for (let index = 0; index < 1000; index += 1) {
      const finalName = index === 0 ? safeFilename : `${stem}-${index}${ext}`;
      const relPath = relJoin(downloadDir, finalName);
      const absPath = await this.resolveReportPath(relPath);
      try {
        await fsp.access(absPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { relPath, absPath, finalName, collisionRenamed: index > 0 };
        }
        throw error;
      }
    }
    throw new CodexProError("browser_download could not allocate a non-overwriting filename.");
  }

  private async persistCompletedDownload(input: {
    task: BrowserBusinessTask;
    target: string;
    downloadId: string;
    downloadDir: string;
    credentialPath: string;
    adapterResult: BrowserDownloadAdapterResult;
    snapshot: BrowserSemanticSnapshot;
  }): Promise<BrowserDownloadEntry> {
    const now = timestamp();
    const originalFilename = input.adapterResult.suggestedFilename ?? `download-${input.downloadId}.bin`;
    const safeFilename = sanitizeDownloadFilename(originalFilename, `download-${input.downloadId}.bin`);
    const allocated = await this.uniqueDownloadFilePath(input.downloadDir, safeFilename);
    const tmpRelPath = relJoin(input.downloadDir, `.tmp-${input.downloadId}-${randomUUID()}.download`);
    const tmpAbsPath = await this.resolveReportPath(tmpRelPath);
    try {
      if (!input.adapterResult.saveAs) throw new CodexProError("Playwright download event did not provide a saveAs handle.");
      await input.adapterResult.saveAs(tmpAbsPath);
      await fsp.copyFile(tmpAbsPath, allocated.absPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      await fsp.rm(tmpAbsPath, { force: true }).catch(() => undefined);
      return this.persistNonCompletedDownload({
        task: input.task,
        target: input.target,
        downloadId: input.downloadId,
        credentialPath: input.credentialPath,
        adapterResult: {
          ...input.adapterResult,
          status: "failed",
          error: browserVerificationErrorMessage(error)
        },
        snapshot: input.snapshot
      });
    } finally {
      await fsp.rm(tmpAbsPath, { force: true }).catch(() => undefined);
    }
    const stat = await fsp.stat(allocated.absPath);
    const sha256 = await sha256File(allocated.absPath);
    const inferredMime = input.adapterResult.mime
      ? { mime: input.adapterResult.mime, source: input.adapterResult.mimeSource ?? "playwright" }
      : mimeFromFilename(allocated.finalName);
    const entry: BrowserDownloadEntry = {
      version: 1,
      download_id: input.downloadId,
      status: "completed",
      original_filename: originalFilename,
      safe_filename: allocated.finalName,
      relative_path: allocated.relPath,
      credential_path: input.credentialPath,
      bytes: stat.size,
      mime: inferredMime.mime,
      mime_source: inferredMime.source,
      sha256,
      source_page: {
        url: input.snapshot.url,
        title: input.snapshot.title,
        snapshot_id: input.snapshot.snapshotId
      },
      download_url: input.adapterResult.downloadUrl,
      downloaded_at: now,
      trigger_element: {
        selector: input.adapterResult.selector,
        requested: input.target,
        element: input.adapterResult.element
      },
      task_id: input.task.task_id,
      run_id: input.task.run_id,
      task_contract_hash: input.task.task_contract_hash,
      session_id: this.sessionId,
      completion_proof_fields: completionProofFieldsForBusinessTask(input.task),
      collision_renamed: allocated.collisionRenamed
    };
    await this.persistDownloadCredential(entry);
    return entry;
  }

  private async persistNonCompletedDownload(input: {
    task: BrowserBusinessTask;
    target: string;
    downloadId: string;
    credentialPath: string;
    adapterResult: BrowserDownloadAdapterResult;
    snapshot: BrowserSemanticSnapshot;
  }): Promise<BrowserDownloadEntry> {
    const originalFilename = input.adapterResult.suggestedFilename;
    const safeFilename = originalFilename ? sanitizeDownloadFilename(originalFilename, `download-${input.downloadId}.bin`) : undefined;
    const entry: BrowserDownloadEntry = {
      version: 1,
      download_id: input.downloadId,
      status: input.adapterResult.status,
      original_filename: originalFilename,
      safe_filename: safeFilename,
      credential_path: input.credentialPath,
      bytes: 0,
      mime: input.adapterResult.mime ?? "application/octet-stream",
      mime_source: input.adapterResult.mimeSource ?? "fallback",
      source_page: {
        url: input.snapshot.url,
        title: input.snapshot.title,
        snapshot_id: input.snapshot.snapshotId
      },
      download_url: input.adapterResult.downloadUrl,
      downloaded_at: timestamp(),
      trigger_element: {
        selector: input.adapterResult.selector,
        requested: input.target,
        element: input.adapterResult.element
      },
      task_id: input.task.task_id,
      run_id: input.task.run_id,
      task_contract_hash: input.task.task_contract_hash,
      session_id: this.sessionId,
      completion_proof_fields: completionProofFieldsForBusinessTask(input.task),
      error: input.adapterResult.error,
      async_evidence: input.adapterResult.asyncEvidence
    };
    await this.persistDownloadCredential(entry);
    return entry;
  }

  private async ensureDownloadDurableMessage(entry: BrowserDownloadEntry): Promise<BrowserDownloadEntry> {
    if (entry.durable_message?.message_id) return entry;
    const durable = await publishBrowserDownloadMessage(this.workspace, {
      status: entry.status,
      credential_path: entry.credential_path,
      download_id: entry.download_id,
      task_id: entry.task_id,
      run_id: entry.run_id,
      task_contract_hash: entry.task_contract_hash,
      session_id: entry.session_id,
      relative_path: entry.relative_path,
      bytes: entry.bytes,
      mime: entry.mime,
      sha256: entry.sha256,
      completion_proof_fields: entry.completion_proof_fields
    });
    entry.durable_message = durable;
    await writeJsonAtomic(await this.resolveReportPath(entry.credential_path), entry);
    return entry;
  }

  private async persistDownloadCredential(entry: BrowserDownloadEntry): Promise<void> {
    const absCredentialPath = await this.resolveReportPath(entry.credential_path);
    await writeJsonAtomic(absCredentialPath, entry);
    await this.ensureDownloadDurableMessage(entry);
  }

  private touch(): void {
    this.lastUsedAt = timestamp();
  }

  private assertVerificationAccess(): void {
    if (!this.activeVerificationRunId) return;
    if (this.verificationExecution.getStore() === this.activeVerificationRunId) return;
    throw new CodexProError(`Browser verification run ${this.activeVerificationRunId} is active. Use browser_verification_status/result instead of issuing competing page operations.`);
  }

  private assertAuthorizedIfRequired(): void {
    if (this.config.browserMode !== "cdp" || !this.config.browserRequireExtensionAuth) return;
    if (!this.authorizationStatus().bound) {
      throw new CodexProError("No active bound Chrome extension authorization. Authorize and bind the current tab first.");
    }
  }

  private async ensureAuthorizedIfRequired(): Promise<void> {
    if (this.config.browserMode !== "cdp" || !this.config.browserRequireExtensionAuth) return;
    const status = this.authorizationStatus();
    if (status.bound) return;
    await this.bindAuthorization(status.authorization?.authorizationId);
  }

  private semanticSnapshotEvidencePath(snapshotId: string, chunkIndex: number): string {
    return relJoin(
      this.snapshotEvidenceRoot(),
      "snapshots",
      `${snapshotId}-chunk-${String(chunkIndex).padStart(4, "0")}.json`
    );
  }

  private snapshotEvidenceRoot(): string {
    return this.spaceId === BROWSER_DEFAULT_SPACE_ID
      ? relJoin(this.runDir, "spaces", BROWSER_DEFAULT_SPACE_ID)
      : this.reportRoot();
  }

  private issueObserveCursor(snapshot: BrowserSemanticSnapshot, options: BrowserObserveSessionOptions, nextChunkIndex: number): string {
    const cursor = randomUUID();
    const state: BrowserObserveCursorState = {
      cursor,
      snapshotId: snapshot.snapshotId,
      sessionId: this.sessionId,
      spaceId: snapshot.spaceId,
      pageId: snapshot.pageId,
      url: snapshot.url,
      documentVersion: snapshot.documentVersion,
      pageRevision: snapshot.pageRevision,
      chunkIndex: nextChunkIndex,
      options: {
        scope: options.scope,
        selector: options.selector,
        maxNodes: options.maxNodes,
        maxTextChars: options.maxTextChars,
        includeTables: options.includeTables,
        includeForms: options.includeForms,
        includeLayoutIssues: options.includeLayoutIssues,
        includeAccessibility: options.includeAccessibility
      },
      nodeOffset: snapshot.pagination.nextNodeOffset ?? snapshot.pagination.totalNodes,
      textOffset: snapshot.pagination.nextTextOffset ?? snapshot.pagination.totalTextChars
    };
    this.semanticObserveCursors.set(cursor, state);
    while (this.semanticObserveCursors.size > 100) {
      const oldest = this.semanticObserveCursors.keys().next().value as string | undefined;
      if (!oldest) break;
      this.semanticObserveCursors.delete(oldest);
    }
    return cursor;
  }

  private async persistSemanticSnapshot(snapshot: BrowserSemanticSnapshot): Promise<void> {
    await writeJsonAtomic(await this.resolveReportPath(snapshot.evidencePath), {
      version: snapshot.snapshotVersion,
      snapshot_id: snapshot.snapshotId,
      session_id: snapshot.sessionId,
      space_id: snapshot.spaceId,
      page_id: snapshot.pageId,
      page_revision: snapshot.pageRevision,
      document_version: snapshot.documentVersion,
      url: snapshot.url,
      title: snapshot.title,
      scope: snapshot.observationScope,
      source: snapshot.source,
      created_at: snapshot.timestamp,
      redacted: snapshot.redacted,
      content: {
        text: snapshot.text,
        headings: snapshot.elements
          .filter((element) => element.role === "heading" || /^h[1-6]$/.test(element.tagName ?? ""))
          .map((element) => element.name ?? element.text ?? "")
          .filter(Boolean),
        landmarks: snapshot.regions.map((region) => region.name ?? region.text ?? region.role).filter(Boolean)
      },
      frames: snapshot.frames.map((frame) => ({
        frame_id: frame.frameId,
        parent_frame_id: frame.parentFrameId ?? null,
        origin: frame.origin,
        same_origin: frame.sameOrigin,
        shadow_root: frame.shadowRoot,
        readable: frame.readable,
        visible_bounds: frame.visibleBounds
      })),
      elements: snapshot.elements.map((element) => ({
        ref: element.ref,
        identity_signature: element.identitySignature,
        frame_id: element.frameId ?? "main",
        role: element.role ?? "",
        accessible_name: element.name ?? "",
        text: element.text,
        source: element.source ?? snapshot.source,
        actionable: Boolean(element.actionable),
        page_revision: snapshot.pageRevision,
        context: element.context,
        states: [
          element.visible ? "visible" : "hidden",
          element.inViewport ? "in_viewport" : "out_of_viewport",
          element.disabled ? "disabled" : "enabled",
          element.valueState ? `value_${element.valueState}` : ""
        ].filter(Boolean)
      })),
      virtual_collections: snapshot.tables.filter((table) => table.virtual).map((table) => ({
        ref: table.ref,
        kind: "dynamic_table",
        loaded_start: table.loadedStart ?? 0,
        loaded_end: table.loadedEnd ?? table.rowCount,
        estimated_total: table.estimatedTotal,
        sampled: true,
        possible_more: Boolean(table.possibleMore)
      })),
      pagination: {
        has_more: snapshot.pagination.hasMore,
        next_cursor: snapshot.pagination.nextCursor ?? null,
        chunk_index: snapshot.pagination.chunkIndex,
        cursor_binding: {
          session_id: snapshot.sessionId,
          space_id: snapshot.spaceId,
          page_id: snapshot.pageId,
          url: snapshot.url,
          document_version: snapshot.documentVersion
        }
      },
      completeness: snapshot.pagination.hasMore ? "partial" : "complete",
      limitations: snapshot.pagination.hasMore ? ["Additional semantic content is available through browser_observe_continue."] : [],
      evidence_path: snapshot.evidencePath
    });
  }

  private diffSemanticSnapshots(previous: BrowserSemanticSnapshot, current: BrowserSemanticSnapshotData): BrowserSemanticSnapshot["changes"] {
    const before = new Map(previous.elements.map((element) => [element.ref, element]));
    const after = new Map(current.elements.map((element) => [element.ref, element]));
    const addedRefs = [...after.keys()].filter((ref) => !before.has(ref));
    const removedRefs = [...before.keys()].filter((ref) => !after.has(ref));
    const changed: BrowserSnapshotChange[] = [];
    for (const [ref, next] of after) {
      const prior = before.get(ref);
      if (!prior) continue;
      const fields = ["text", "name", "checked", "selected", "expanded", "disabled", "visible", "inViewport", "valueState", "bounds"].filter(
        (field) => JSON.stringify((prior as any)[field]) !== JSON.stringify((next as any)[field])
      );
      if (fields.length) changed.push({ ref, fields, before: prior, after: next });
    }
    const pageChanges: string[] = [];
    if (previous.url !== current.url) pageChanges.push("url");
    if (previous.title !== current.title) pageChanges.push("title");
    if (previous.readyState !== current.readyState) pageChanges.push("readyState");
    if (JSON.stringify(previous.scroll) !== JSON.stringify(current.scroll)) pageChanges.push("scroll");
    return { addedRefs, removedRefs, changed, pageChanges };
  }

  private async normalizeVerificationRecoveryOptions(options: BrowserVerificationRunOptions): Promise<BrowserVerificationRecoveryOptions> {
    if (!options.pages.length) throw new CodexProError("browser_verification_run requires at least one page.");
    if (options.pages.length > this.config.browserVerificationMaxPages) {
      throw new CodexProError(`browser_verification_run accepts at most ${this.config.browserVerificationMaxPages} pages.`);
    }
    const devices = [...new Set(options.devices?.length ? options.devices : ["desktop"])] as BrowserDevicePreset[];
    if (!devices.length || devices.some((device) => device !== "desktop" && device !== "mobile")) {
      throw new CodexProError("Unsupported verification device.");
    }
    this.policy = await readBrowserPolicy(this.config, this.guard, this.workspace);
    const pages: BrowserVerificationPersistedPage[] = [];
    for (let index = 0; index < options.pages.length; index += 1) {
      const page = options.pages[index];
      const rawUrl = page.url.trim();
      assertNoPersistedVerificationUrlSecret(rawUrl);
      const url = await assertUrlAllowed(rawUrl, this.policy);
      const expectText = page.expectText?.trim();
      if (expectText && redactSensitiveText(expectText) !== expectText) {
        throw new CodexProError("browser_verification_run refuses token-like expectation text because recovery state is persisted.");
      }
      pages.push({
        url,
        label: page.label?.trim() || `page-${index + 1}`,
        expectText: expectText || undefined,
        visual: Boolean(page.visual),
        visualReason: page.visualReason
      });
    }
    return {
      schemaVersion: BROWSER_VERIFICATION_STATE_SCHEMA_VERSION,
      pages,
      devices,
      spaceId: options.spaceId ?? this.spaceId,
      retainBrowser: Boolean(options.retainBrowser),
      timeoutMs: Math.max(1_000, Math.min(options.timeoutMs ?? 600_000, 1_800_000)),
      browser: {
        requestedMode: this.config.browserMode,
        requireExtensionAuth: this.config.browserRequireExtensionAuth,
        allowHeadlessFallback: this.config.browserAllowHeadlessFallback
      }
    };
  }

  private async validateVerificationRecoveryOptions(options: BrowserVerificationRecoveryOptions): Promise<void> {
    if (!isRecord(options) || !Array.isArray(options.pages) || !Array.isArray(options.devices) || !isRecord(options.browser)) {
      throw new CodexProError("Persisted browser verification recovery options are malformed.");
    }
    if (options.schemaVersion !== BROWSER_VERIFICATION_STATE_SCHEMA_VERSION) {
      throw new CodexProError(`Unsupported browser verification recovery schema: ${options.schemaVersion}.`);
    }
    if (options.pages.some((page) => !isRecord(page) || typeof page.url !== "string" || typeof page.label !== "string" || typeof page.visual !== "boolean")) {
      throw new CodexProError("Persisted browser verification pages are malformed.");
    }
    if (options.devices.some((device) => device !== "desktop" && device !== "mobile")) {
      throw new CodexProError("Persisted browser verification devices are malformed.");
    }
    if (options.browser.requestedMode !== this.config.browserMode) {
      throw new CodexProError(`Browser verification was created for ${options.browser.requestedMode} mode but the current runtime uses ${this.config.browserMode}.`);
    }
    if (options.browser.requireExtensionAuth !== this.config.browserRequireExtensionAuth) {
      throw new CodexProError("Browser verification extension authorization policy changed after the run was created.");
    }
    if (options.browser.allowHeadlessFallback !== this.config.browserAllowHeadlessFallback) {
      throw new CodexProError("Browser verification fallback policy changed after the run was created.");
    }
    await this.normalizeVerificationRecoveryOptions({ pages: options.pages, devices: options.devices });
  }

  private captureVerificationBrowserContext(state: BrowserVerificationRunState): void {
    const status = this.adapter.status();
    state.currentSessionId = this.sessionId;
    state.browser = {
      requestedMode: status.requestedMode,
      effectiveMode: status.effectiveMode,
      requireExtensionAuth: this.config.browserRequireExtensionAuth,
      allowHeadlessFallback: this.config.browserAllowHeadlessFallback,
      fallbackReason: status.fallbackReason ? redactSensitiveText(status.fallbackReason) : undefined,
      reconnectAttempts: status.reconnectAttempts,
      lastReconnectAt: status.lastReconnectAt,
      reconnectFailureReason: status.reconnectFailureReason ? redactSensitiveText(status.reconnectFailureReason) : undefined
    };
  }

  private syncVerificationCounts(state: BrowserVerificationRunState): void {
    state.completedSteps = state.steps.filter((step) => isTerminalVerificationStep(step.status)).length;
    state.failedSteps = state.steps.filter((step) => step.status === "failed").length;
    state.blockedSteps = state.steps.filter((step) => step.status === "blocked").length;
    state.pendingSteps = state.steps.filter((step) => step.status === "pending" || step.status === "running").length;
    state.consoleErrorCount = state.steps.reduce((total, step) => total + (step.consoleErrorCount ?? step.evidence?.consoleErrorCount ?? 0), 0);
    state.networkFailureCount = state.steps.reduce((total, step) => total + (step.networkFailureCount ?? step.evidence?.networkFailureCount ?? 0), 0);
    state.unexpectedRefreshCount = state.steps.reduce((total, step) => total + (step.unexpectedRefreshCount ?? step.evidence?.unexpectedRefreshCount ?? 0), 0);
  }

  private async findVerificationStatePath(runId: string): Promise<string> {
    assertVerificationRunId(runId);
    const rootPath = this.resolveWorkspacePath(BROWSER_REPORT_ROOT);
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodexProError(`Browser verification run not found: ${runId}`);
      throw error;
    }
    const matches: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4 || matches.length > 1) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(directory, entry.name);
        if (!isSubpath(child, realRoot)) continue;
        if (entry.name === `verification-${runId}`) {
          const candidate = path.join(child, "state.json");
          try {
            const realCandidate = await fsp.realpath(candidate);
            if (!isSubpath(realCandidate, realRoot)) continue;
            const stat = await fsp.stat(realCandidate);
            if (stat.isFile()) matches.push(realCandidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          continue;
        }
        await visit(child, depth + 1);
      }
    };
    await visit(realRoot, 0);
    if (!matches.length) throw new CodexProError(`Browser verification run not found: ${runId}`);
    if (matches.length > 1) throw new CodexProError(`Browser verification run is ambiguous on disk: ${runId}`);
    return matches[0];
  }

  private async getOrLoadVerificationRun(runId: string): Promise<BrowserVerificationRunState> {
    assertVerificationRunId(runId);
    const existing = this.verificationRuns.get(runId);
    if (existing) return existing;

    const absStatePath = await this.findVerificationStatePath(runId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(absStatePath, "utf8"));
    } catch (error) {
      throw new CodexProError(`Browser verification state is unreadable for ${runId}: ${browserVerificationErrorMessage(error)}`);
    }
    if (!isRecord(parsed) || parsed.runId !== runId || !Array.isArray(parsed.steps)) {
      throw new CodexProError(`Browser verification state is malformed for ${runId}.`);
    }
    const state = parsed as unknown as BrowserVerificationRunState;
    const relStatePath = path.relative(this.workspace.root, absStatePath).split(path.sep).join("/");
    if (relStatePath.startsWith("../") || path.isAbsolute(relStatePath)) {
      throw new CodexProError(`Browser verification state escaped the workspace report root: ${runId}`);
    }
    state.statePath = relStatePath;
    state.reportPath = relJoin(path.dirname(relStatePath), "report.md");
    state.originalSessionId = state.originalSessionId ?? state.sessionId;
    state.currentSessionId = state.currentSessionId ?? state.sessionId;
    state.schemaVersion = state.schemaVersion ?? 1;
    state.sessionRebuilds = Array.isArray(state.sessionRebuilds) ? state.sessionRebuilds : [];
    state.sessionRebuildCount = state.sessionRebuildCount ?? state.sessionRebuilds.length;
    state.recoveryAttempts = state.recoveryAttempts ?? 0;
    state.recoveryStatus = state.recoveryStatus ?? "not_needed";
    state.spaceId = state.spaceId ?? state.options?.spaceId ?? this.spaceId;
    state.retainBrowser = state.retainBrowser ?? Boolean(state.options?.retainBrowser);
    state.timeoutMs = state.timeoutMs ?? state.options?.timeoutMs ?? 600_000;
    state.createdTabIds = Array.isArray(state.createdTabIds) ? state.createdTabIds : [];
    state.cleanup = state.cleanup ?? {
      required: !state.retainBrowser,
      status: isTerminalVerificationRunStatus(state.status) && state.retainBrowser ? "retained" : "pending",
      createdTabIds: [...state.createdTabIds],
      closedTabIds: [],
      spaceClosed: false,
      resourceReleased: false,
      leakDetected: false,
      leakReasons: []
    };

    const allowedStepStatuses: BrowserVerificationStepStatus[] = ["pending", "running", "passed", "failed", "skipped", "blocked"];
    for (const step of state.steps) {
      if (!Number.isInteger(step.index) || !Number.isInteger(step.pageIndex) || typeof step.url !== "string" || typeof step.label !== "string") {
        throw new CodexProError(`Browser verification step is malformed for ${runId}.`);
      }
      if (step.device !== "desktop" && step.device !== "mobile") throw new CodexProError(`Browser verification step has an unsupported device for ${runId}.`);
      if (!allowedStepStatuses.includes(step.status)) throw new CodexProError(`Browser verification step has an unsupported status for ${runId}.`);
      step.pageId = step.pageId ?? verificationPageId(runId, step.pageIndex, step.device);
      step.consoleErrorCount = step.consoleErrorCount ?? step.evidence?.consoleErrorCount ?? 0;
      step.networkFailureCount = step.networkFailureCount ?? step.evidence?.networkFailureCount ?? 0;
      step.unexpectedRefreshCount = step.unexpectedRefreshCount ?? step.evidence?.unexpectedRefreshCount ?? 0;
      step.sessionRebuildCount = step.sessionRebuildCount ?? 0;
    }

    if (state.options) {
      await this.validateVerificationRecoveryOptions(state.options);
      this.verificationOptions.set(runId, structuredClone(state.options));
    } else if (state.status !== "completed") {
      state.status = "blocked";
      state.recoveryStatus = "blocked";
      state.recoveryBlockedReason = "Persisted verification state predates Stage L4 and does not contain executable recovery options.";
      state.lastRecoveryReason = "legacy_state_missing_options";
      for (const step of state.steps) {
        if (isSuccessfulVerificationStep(step.status)) continue;
        step.status = "blocked";
        step.recoveryStatus = "blocked";
        step.recoveryReason = state.recoveryBlockedReason;
      }
    }

    if (state.currentSessionId !== this.sessionId && state.status !== "completed" && state.status !== "cancelled" && state.status !== "timed_out") {
      const priorSessionId = state.currentSessionId;
      state.currentSessionId = this.sessionId;
      state.sessionRebuildCount = (state.sessionRebuildCount ?? 0) + 1;
      state.sessionRebuilds.push({
        at: timestamp(),
        fromSessionId: priorSessionId,
        toSessionId: this.sessionId,
        reason: "session_recreated"
      });
      for (const step of state.steps) {
        if (isSuccessfulVerificationStep(step.status)) continue;
        step.sessionRebuildCount = (step.sessionRebuildCount ?? 0) + 1;
      }
      if (state.options && state.status !== "blocked") {
        state.status = "recoverable";
        state.recoveryStatus = "recoverable";
        state.lastRecoveryReason = "session_recreated";
      }
    }

    this.captureVerificationBrowserContext(state);
    this.syncVerificationCounts(state);
    state.updatedAt = timestamp();
    this.verificationRuns.set(runId, state);
    await this.persistVerificationState(state);
    return state;
  }

  private async markVerificationCancelled(state: BrowserVerificationRunState, status: "cancelled" | "timed_out", reason: string): Promise<void> {
    const finishedAt = timestamp();
    for (const step of state.steps) {
      if (isTerminalVerificationStep(step.status)) continue;
      step.status = "skipped";
      step.finishedAt = finishedAt;
      step.recoveryStatus = "not_needed";
      step.recoveryReason = reason;
      step.error = reason;
    }
    state.status = status;
    state.recoveryStatus = "not_needed";
    state.lastRecoveryReason = reason;
    this.captureVerificationBrowserContext(state);
    this.syncVerificationCounts(state);
    this.completeVerificationCapture(state);
    state.updatedAt = finishedAt;
    this.verificationCancellationRequests.delete(state.runId);
    await this.persistVerificationState(state).catch(() => undefined);
    await this.writeVerificationReport(state).catch(() => undefined);
  }

  private async markVerificationBlocked(state: BrowserVerificationRunState, reason: string): Promise<void> {
    const safeReason = redactSensitiveText(reason);
    state.status = "blocked";
    state.recoveryStatus = "blocked";
    state.recoveryBlockedReason = safeReason;
    state.lastRecoveryReason = safeReason;
    for (const step of state.steps) {
      if (isSuccessfulVerificationStep(step.status)) continue;
      step.status = "blocked";
      step.finishedAt = step.finishedAt ?? timestamp();
      step.recoveryStatus = "blocked";
      step.recoveryReason = safeReason;
      step.error = step.error ?? safeReason;
    }
    this.captureVerificationBrowserContext(state);
    this.syncVerificationCounts(state);
    this.completeVerificationCapture(state);
    state.updatedAt = timestamp();
    await this.persistVerificationState(state).catch(() => undefined);
    await this.writeVerificationReport(state).catch(() => undefined);
  }

  private async markVerificationInterrupted(state: BrowserVerificationRunState, error: unknown): Promise<void> {
    const cancellation = this.verificationCancellationRequests.get(state.runId);
    if (cancellation) {
      await this.markVerificationCancelled(state, cancellation.status, cancellation.reason);
      return;
    }
    const classification = classifyBrowserVerificationError(error);
    const running = state.steps.find((step) => step.status === "running");
    if (running) {
      running.status = classification.stepStatus;
      running.finishedAt = timestamp();
      running.error = classification.reason;
      running.recoveryStatus = classification.recoveryStatus;
      running.recoveryReason = classification.reason;
    }
    state.status = classification.recoveryStatus === "blocked" ? "blocked" : classification.recoveryStatus === "recoverable" ? "recoverable" : "interrupted";
    state.recoveryStatus = classification.recoveryStatus;
    state.lastRecoveryReason = classification.reason;
    if (classification.recoveryStatus === "blocked") state.recoveryBlockedReason = classification.reason;
    this.captureVerificationBrowserContext(state);
    this.syncVerificationCounts(state);
    this.completeVerificationCapture(state);
    state.updatedAt = timestamp();
    await this.persistVerificationState(state).catch(() => undefined);
    await this.writeVerificationReport(state).catch(() => undefined);
  }

  private launchVerificationRun(state: BrowserVerificationRunState, options: BrowserVerificationRunOptions): void {
    let tracked: Promise<void>;
    tracked = this.executeVerificationRun(state, options)
      .catch((error) => this.markVerificationInterrupted(state, error))
      .finally(() => {
        if (this.activeVerificationPromise === tracked) this.activeVerificationPromise = undefined;
      });
    this.activeVerificationPromise = tracked;
  }

  private async executeVerificationRun(state: BrowserVerificationRunState, options: BrowserVerificationRunOptions): Promise<void> {
    if (this.activeVerificationRunId && this.activeVerificationRunId !== state.runId) {
      throw new CodexProError(`Browser verification run is already active: ${this.activeVerificationRunId}`);
    }
    this.activeVerificationRunId = state.runId;
    await this.verificationExecution.run(state.runId, async () => {
      try {
        state.status = "running";
        state.recoveryStatus = "not_needed";
        state.currentSessionId = this.sessionId;
        state.updatedAt = timestamp();
        this.captureVerificationBrowserContext(state);
        await this.persistVerificationState(state);
        for (const step of state.steps) {
          if (this.verificationCancellationRequests.has(state.runId)) break;
          if (step.status === "passed" || step.status === "skipped") continue;
          const pageOptions = options.pages[step.pageIndex];
          if (!pageOptions) throw new Error(`Verification page options missing for page index ${step.pageIndex}.`);
          const consoleStart = this.consoleEntries.length;
          const networkStart = this.networkEntries.length;
          const navigationBefore = this.adapter.status().navigationCount;
          let opened: BrowserOpenedUrlEntry | undefined;
          step.status = "running";
          step.startedAt = timestamp();
          step.finishedAt = undefined;
          step.error = undefined;
          step.recoveryStatus = "not_needed";
          step.recoveryReason = undefined;
          state.updatedAt = timestamp();
          await this.persistVerificationState(state);
          try {
            opened = await this.open(pageOptions.url, { device: step.device });
            const snapshot = await this.observe({ scope: "viewport", maxNodes: 250, maxTextChars: 16_000 });
            step.snapshotId = snapshot.snapshotId;
            if (pageOptions.expectText) {
              const expectation = await this.expectText(pageOptions.expectText, { timeoutMs: 5000 });
              if (!expectation.passed) throw new Error(`Expected text not found: ${pageOptions.expectText}`);
            }
            if (pageOptions.visual) {
              const visual = await this.visualObserve({
                name: `${sanitizeFileStem(step.label, `step-${step.index}`)}-${step.device}`,
                reason: pageOptions.visualReason ?? "manual",
                scope: "viewport",
                linkedSnapshotId: snapshot.snapshotId
              });
              step.visualPath = visual.path;
            }
            step.status = "passed";
          } catch (error) {
            const cancellation = this.verificationCancellationRequests.get(state.runId);
            if (cancellation) {
              step.status = "skipped";
              step.error = cancellation.reason;
              step.recoveryStatus = "not_needed";
              step.recoveryReason = cancellation.reason;
            } else {
              const classification = classifyBrowserVerificationError(error);
              step.status = classification.stepStatus;
              step.error = classification.reason;
              step.recoveryStatus = classification.recoveryStatus;
              step.recoveryReason = classification.reason;
            }
          }
          const navigationAfter = this.adapter.status().navigationCount;
          const expectedNavigation = opened?.navigated ? 1 : 0;
          const unexpectedRefreshCount = Math.max(0, navigationAfter - navigationBefore - expectedNavigation);
          const consoleErrorCount = countConsoleErrors(this.consoleEntries.slice(consoleStart));
          const networkFailureCount = this.networkEntries.slice(networkStart).length;
          step.consoleErrorCount = consoleErrorCount;
          step.networkFailureCount = networkFailureCount;
          step.unexpectedRefreshCount = unexpectedRefreshCount;
          step.evidence = {
            opened: opened?.opened,
            finalUrl: opened?.finalUrl,
            snapshotId: step.snapshotId,
            visualPath: step.visualPath,
            consoleErrorCount,
            networkFailureCount,
            unexpectedRefreshCount
          };
          step.finishedAt = timestamp();
          this.captureVerificationBrowserContext(state);
          this.syncVerificationCounts(state);
          state.updatedAt = timestamp();
          await this.persistVerificationState(state);
          if (step.recoveryStatus === "blocked" || step.recoveryStatus === "recoverable") break;
        }
        const cancellation = this.verificationCancellationRequests.get(state.runId);
        if (cancellation) {
          const finishedAt = timestamp();
          for (const step of state.steps) {
            if (isTerminalVerificationStep(step.status)) continue;
            step.status = "skipped";
            step.finishedAt = finishedAt;
            step.error = cancellation.reason;
            step.recoveryStatus = "not_needed";
            step.recoveryReason = cancellation.reason;
          }
        }
        const blocked = state.steps.some((step) => step.status === "blocked");
        const recoverable = state.steps.some((step) => step.status === "failed" && step.recoveryStatus === "recoverable");
        const failed = state.steps.some((step) => step.status === "failed");
        const terminalStatus: BrowserVerificationRunStatus = cancellation?.status ?? (blocked ? "blocked" : recoverable ? "recoverable" : failed ? "failed" : "completed");
        const terminalRecoveryStatus = cancellation ? "not_needed" : blocked ? "blocked" : recoverable ? "recoverable" : "not_needed";
        this.captureVerificationBrowserContext(state);
        this.syncVerificationCounts(state);
        this.completeVerificationCapture(state);
        state.updatedAt = timestamp();
        const reportState = this.cloneVerificationState(state);
        reportState.status = terminalStatus;
        reportState.recoveryStatus = terminalRecoveryStatus;
        await this.writeVerificationReport(reportState);
        state.status = terminalStatus;
        state.recoveryStatus = terminalRecoveryStatus;
        if (cancellation) state.lastRecoveryReason = cancellation.reason;
        await this.persistVerificationState(state);
        this.verificationCancellationRequests.delete(state.runId);
      } finally {
        if (this.activeVerificationRunId === state.runId) this.activeVerificationRunId = undefined;
      }
    });
  }

  private cloneVerificationState(state: BrowserVerificationRunState): BrowserVerificationRunState {
    return JSON.parse(JSON.stringify(state)) as BrowserVerificationRunState;
  }

  private async persistVerificationState(state: BrowserVerificationRunState): Promise<void> {
    const absPath = await this.resolveReportPath(state.statePath);
    const tmpPath = `${absPath}.tmp-${process.pid}-${randomUUID()}`;
    await fsp.writeFile(tmpPath, JSON.stringify(state, jsonReplacer, 2), "utf8");
    await fsp.rename(tmpPath, absPath);
  }

  private async writeVerificationReport(state: BrowserVerificationRunState): Promise<void> {
    this.syncVerificationCounts(state);
    const escapeCell = (value: unknown): string => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    const rebuildReasons = (state.sessionRebuilds ?? []).map((item) => item.reason).join(", ") || "none";
    const lines = [
      "# Browser Verification Run",
      "",
      `Run ID: ${state.runId}`,
      `Original Session ID: ${state.originalSessionId ?? state.sessionId}`,
      `Current Session ID: ${state.currentSessionId ?? state.sessionId}`,
      `Status: ${state.status}`,
      `Browser Space: ${state.spaceId ?? this.spaceId}`,
      `Retain Browser: ${state.retainBrowser ? "yes" : "no"}`,
      `Created Tab IDs: ${(state.createdTabIds ?? []).join(", ") || "none"}`,
      `Cleanup Status: ${state.cleanup?.status ?? "pending"}`,
      `Browser Resources Released: ${state.cleanup?.resourceReleased ? "yes" : "no"}`,
      `Browser Resource Leak Detected: ${state.cleanup?.leakDetected ? "yes" : "no"}`,
      `Browser Resource Leak Reasons: ${(state.cleanup?.leakReasons ?? []).map(escapeCell).join(", ") || "none"}`,
      `Recovery Status: ${state.recoveryStatus ?? "not_needed"}`,
      `Recovery Attempts: ${state.recoveryAttempts ?? 0}`,
      `Last Recovery Reason: ${escapeCell(state.lastRecoveryReason ?? "none")}`,
      `Session Rebuild Count: ${state.sessionRebuildCount ?? 0}`,
      `Session Rebuild Reasons: ${escapeCell(rebuildReasons)}`,
      `Unexpected Refresh Count: ${state.unexpectedRefreshCount ?? 0}`,
      `Console Error Count: ${state.consoleErrorCount ?? 0}`,
      `Network Failure Count: ${state.networkFailureCount ?? 0}`,
      `Browser Mode: ${state.browser?.requestedMode ?? "unknown"} -> ${state.browser?.effectiveMode ?? "unknown"}`,
      `Fallback Reason: ${escapeCell(state.browser?.fallbackReason ?? "none")}`,
      `Reconnect Attempts: ${state.browser?.reconnectAttempts ?? 0}`,
      `Reconnect Failure: ${escapeCell(state.browser?.reconnectFailureReason ?? "none")}`,
      `Created: ${state.createdAt}`,
      `Updated: ${state.updatedAt}`,
      `Completed: ${state.completedSteps}/${state.steps.length}`,
      `Failed: ${state.failedSteps}`,
      `Blocked: ${state.blockedSteps ?? 0}`,
      `Pending: ${state.pendingSteps ?? 0}`,
      "",
      "| # | Page ID | Label | Device | Status | URL | Snapshot | Visual | Console | Network | Refresh | Rebuild | Recovery | Error |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...state.steps.map((step) => `| ${step.index + 1} | ${escapeCell(step.pageId)} | ${escapeCell(step.label)} | ${step.device} | ${step.status} | ${escapeCell(step.url)} | ${escapeCell(step.snapshotId)} | ${escapeCell(step.visualPath)} | ${step.consoleErrorCount ?? 0} | ${step.networkFailureCount ?? 0} | ${step.unexpectedRefreshCount ?? 0} | ${step.sessionRebuildCount ?? 0} | ${escapeCell(step.recoveryStatus ?? "not_needed")} | ${escapeCell(step.error)} |`)
    ];
    const absPath = await this.resolveReportPath(state.reportPath);
    await fsp.writeFile(absPath, lines.join("\n"), "utf8");
  }

  private async resolveReportPath(relPath: string): Promise<string> {
    assertReportWriteAllowed(this.config, relPath);
    const resolved = this.guard.resolve(this.workspace, relPath, { forWrite: true });
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    return resolved.absPath;
  }

  private resolveWorkspacePath(relPath: string): string {
    return this.guard.resolve(this.workspace, relPath).absPath;
  }
}

interface ProcessBrowserSessionEntry {
  session: BrowserSession;
  managedSession: BrowserSession;
  closing?: Promise<ReturnType<BrowserSession["status"]>>;
}

const PROCESS_BROWSER_SESSIONS = new Map<string, ProcessBrowserSessionEntry>();

function browserSessionKey(config: CodexProConfig, workspace: Workspace, spaceId = BROWSER_DEFAULT_SPACE_ID): string {
  return [
    workspace.root,
    spaceId,
    config.browserMode,
    config.browserCdpUrl ?? "",
    config.browserCdpProfileDir ?? ""
  ].join("::");
}

async function closeProcessBrowserSession(
  key: string,
  entry: ProcessBrowserSessionEntry
): Promise<ReturnType<BrowserSession["status"]>> {
  if (entry.closing) return await entry.closing;
  const closing = (async () => {
    const status = await entry.session.disconnect();
    if (PROCESS_BROWSER_SESSIONS.get(key) === entry) PROCESS_BROWSER_SESSIONS.delete(key);
    return status;
  })();
  entry.closing = closing;
  return await closing;
}

export class BrowserSessionManager {
  constructor(private readonly config: CodexProConfig, private readonly guard: PathGuard) {}

  get(workspace: Workspace, options: BrowserSessionScopeOptions = {}): BrowserSession {
    const spaceId = options.spaceId ?? BROWSER_DEFAULT_SPACE_ID;
    const key = browserSessionKey(this.config, workspace, spaceId);
    const existing = PROCESS_BROWSER_SESSIONS.get(key);
    if (existing) return existing.managedSession;
    const session = new BrowserSession(this.config, this.guard, workspace, { ...options, spaceId });
    const entry: ProcessBrowserSessionEntry = {
      session,
      managedSession: session
    };
    PROCESS_BROWSER_SESSIONS.set(key, entry);
    return entry.managedSession;
  }

  peek(workspace: Workspace, spaceId = BROWSER_DEFAULT_SPACE_ID): BrowserSession | undefined {
    return PROCESS_BROWSER_SESSIONS.get(browserSessionKey(this.config, workspace, spaceId))?.managedSession;
  }

  async disconnect(workspace: Workspace, options: BrowserSessionScopeOptions = {}): Promise<ReturnType<BrowserSession["status"]>> {
    const spaceId = options.spaceId ?? BROWSER_DEFAULT_SPACE_ID;
    const key = browserSessionKey(this.config, workspace, spaceId);
    const entry = PROCESS_BROWSER_SESSIONS.get(key);
    if (!entry) {
      const ephemeral = new BrowserSession(this.config, this.guard, workspace, { ...options, spaceId });
      const status = ephemeral.status();
      await ephemeral.close().catch(() => undefined);
      return status;
    }
    return await closeProcessBrowserSession(key, entry);
  }
}

export function processBrowserSessionCount(): number {
  return PROCESS_BROWSER_SESSIONS.size;
}
