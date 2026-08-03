import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { BrowserMode } from "../config.js";
import { redactSensitiveText } from "../redact.js";
import { TOOL_LIMITS, clampToolLimit } from "../tools/toolLimits.js";
import {
  CdpBrowserDownloadTracker,
  cleanupCdpDownloadStagingAttempt,
  createCdpDownloadStagingAttempt,
  resolveCdpDownloadStagingPaths,
  waitForStagedDownloadFile,
  type CdpBrowserDownloadProgressEvent,
  type CdpBrowserDownloadWillBeginEvent,
  type CdpDownloadStagingAttempt,
  type CdpDownloadStagingPaths
} from "./cdp-download-staging.js";
import {
  createNativeCdpReadonlyClient,
  type NativeCdpPageTarget,
  type NativeCdpReadonlyClient
} from "./native-cdp-readonly.js";

export type BrowserDevicePreset = "desktop" | "mobile";
export type BrowserTextMatchMode = "contains" | "exact" | "regex";
export type BrowserUrlMatchMode = "contains" | "exact" | "regex";
export type BrowserHiddenMatchMode = "hidden";
export type BrowserExpectationMode = BrowserTextMatchMode | BrowserUrlMatchMode | BrowserHiddenMatchMode;
export type BrowserClickButton = "left" | "right" | "middle";
export type BrowserWaitState = "visible" | "hidden" | "attached" | "detached";
export type BrowserInteractionAction = "click" | "type" | "wait" | "select" | "check" | "scroll";
export type BrowserDownloadStatus = "completed" | "timeout" | "navigation_without_download" | "async_generation" | "unknown" | "failed";
export type PlaywrightWaitUntil = "load" | "domcontentloaded" | "networkidle";

export interface BrowserViewportPreset {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
}

export interface BrowserConsoleEntry {
  timestamp: string;
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

export interface BrowserNetworkEntry {
  timestamp: string;
  kind: "requestfailed" | "http-error";
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  failure?: string;
}

export interface BrowserOpenResult {
  url: string;
  title: string;
  device: BrowserDevicePreset;
  navigated: boolean;
}

export interface BrowserScreenshotResult {
  bytes: number;
  device: BrowserDevicePreset;
}

export interface BrowserElementSummary {
  ref?: string;
  selector: string;
  text: string;
  tagName?: string;
  role?: string;
  ariaLabel?: string;
  accessibleName?: string;
  type?: string;
  name?: string;
  id?: string;
  href?: string;
  placeholder?: string;
  disabled?: boolean;
  visible?: boolean;
  clickable?: boolean;
  containerRef?: string;
  containerRole?: string;
  containerText?: string;
  identitySignature?: string;
  source?: "playwright" | "native_cdp";
  actionable?: boolean;
  pageRevision?: string;
  frameId?: string;
  context?: string;
}

export interface BrowserDownloadElementFingerprint {
  ref: string;
  selector: string;
  tagName: string;
  role: string;
  name?: string;
  text?: string;
  hrefAbsent: boolean;
  visible: true;
  clickable: true;
  containerRef?: string;
  containerRole?: string;
  containerTextContains?: string;
}

export interface BrowserExpectationResult {
  passed: boolean;
  expected: string;
  actual: string;
  mode: BrowserExpectationMode;
  timeoutMs: number;
}

export interface BrowserInteractionResult {
  action: BrowserInteractionAction;
  selector: string;
  passed: boolean;
  timeoutMs: number;
  url: string;
  element?: BrowserElementSummary;
  state?: BrowserWaitState;
  textLength?: number;
  idempotentReplay?: boolean;
  error?: string;
}

export interface BrowserDownloadAdapterResult {
  status: BrowserDownloadStatus;
  selector: string;
  timeoutMs: number;
  sourceUrl: string;
  finalUrl: string;
  element?: BrowserElementSummary;
  suggestedFilename?: string;
  downloadUrl?: string;
  mime?: string;
  mimeSource?: "playwright" | "unknown";
  asyncEvidence?: string;
  error?: string;
  saveAs?: (absPath: string) => Promise<void>;
}

export interface BrowserBridgeStatus {
  requestedMode: BrowserMode;
  effectiveMode?: BrowserMode;
  connected: boolean;
  connectedAt?: string;
  disconnectedAt?: string;
  ownsBrowserProcess: boolean;
  fallbackReason?: string;
  isolatedProfileVerified?: boolean;
  reconnectAttempts: number;
  lastReconnectAt?: string;
  reconnectFailureReason?: string;
  currentUrl?: string;
  currentDevice?: BrowserDevicePreset;
  tabCount: number;
  navigationCount: number;
  authorizationId?: string;
  authorizationBoundAt?: string;
  downloadBridgeConfigured?: boolean;
  downloadBridgeBrowserDir?: string;
  downloadBridgeHostDir?: string;
}

export interface BrowserTabEntry {
  tabId: string;
  index: number;
  title: string;
  url: string;
  current: boolean;
  ownedByCodexPro: boolean;
}

export interface BrowserSemanticElement {
  ref: string;
  selector: string;
  identitySignature?: string;
  source?: "playwright" | "native_cdp";
  actionable?: boolean;
  pageRevision?: string;
  frameId?: string;
  context?: string;
  role?: string;
  name?: string;
  id?: string;
  tagName?: string;
  text?: string;
  type?: string;
  href?: string;
  placeholder?: string;
  valueState?: "empty" | "filled" | "masked";
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  visible: boolean;
  inViewport: boolean;
  editable: boolean;
  clickable: boolean;
  containerRef?: string;
  containerRole?: string;
  containerText?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserRegionSummary {
  ref: string;
  role: string;
  name?: string;
  text?: string;
}

export interface BrowserTableSummary {
  ref: string;
  headers: string[];
  rowCount: number;
  sampleRows: string[][];
  virtual?: boolean;
  loadedStart?: number;
  loadedEnd?: number;
  estimatedTotal?: number;
  possibleMore?: boolean;
}

export interface BrowserFrameSummary {
  frameId: string;
  parentFrameId?: string;
  origin: string;
  sameOrigin: boolean;
  shadowRoot: "none" | "open" | "closed";
  readable: boolean;
  visibleBounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserObservationPagination {
  nodeOffset: number;
  nextNodeOffset?: number;
  totalNodes: number;
  textOffset: number;
  nextTextOffset?: number;
  totalTextChars: number;
  hasMore: boolean;
}

export interface BrowserTableExtractionAdapterResult {
  url: string;
  title: string;
  tableRef: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
  uniqueKey?: string;
  deduplicatedRows: number;
  loadedRange: { start: number; end: number };
  maxRows: number;
  maxScrolls: number;
  scrollsUsed: number;
  completeness: "complete" | "partial" | "sampled" | "unknown";
  possibleMore: boolean;
  virtual: boolean;
  limitations: string[];
}

export interface BrowserFormSummary {
  ref: string;
  fieldCount: number;
  fields: Array<{ ref?: string; name?: string; type?: string; required: boolean; disabled: boolean; valueState: "empty" | "filled" | "masked" }>;
}

export interface BrowserLayoutIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  refs?: string[];
  requiresVisualConfirmation?: boolean;
}

export interface BrowserAccessibilityNode {
  role?: string;
  name?: string;
  description?: string;
  ignored: boolean;
  backendDOMNodeId?: number;
}

export interface BrowserSemanticSnapshotData {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxX: number; maxY: number };
  device: BrowserDevicePreset;
  text: string;
  source: "playwright" | "native_cdp";
  pageId: string;
  documentVersion: string;
  pageRevisionSeed: string;
  frames: BrowserFrameSummary[];
  pagination: BrowserObservationPagination;
  regions: BrowserRegionSummary[];
  elements: BrowserSemanticElement[];
  tables: BrowserTableSummary[];
  forms: BrowserFormSummary[];
  issues: BrowserLayoutIssue[];
  accessibility: BrowserAccessibilityNode[];
  domSnapshotNodeCount?: number;
  truncated: boolean;
}

interface PlaywrightAdapterEvents {
  onConsole(entry: BrowserConsoleEntry): void;
  onNetwork(entry: BrowserNetworkEntry): void;
}

export interface PlaywrightBrowserAdapterOptions {
  mode: BrowserMode;
  cdpUrl?: string;
  cdpProfileDir?: string;
  cdpDownloadDir?: string;
  cdpDownloadMountDir?: string;
  cdpConnectTimeoutMs: number;
  allowHeadlessFallback?: boolean;
  ensureCdpAvailable?: () => Promise<void>;
  playwrightModule?: any;
  nativeCdpClient?: NativeCdpReadonlyClient;
  spaceMode?: "shared_profile" | "isolated_context";
  assertMainFrameNavigationAllowed?: (url: string) => Promise<void>;
}

interface BrowserOpenOptions {
  device: BrowserDevicePreset;
  waitUntil?: PlaywrightWaitUntil;
  timeoutMs?: number;
}

interface BrowserScreenshotOptions {
  device?: BrowserDevicePreset;
  fullPage?: boolean;
}

interface BrowserClickOptions {
  button?: BrowserClickButton;
  timeoutMs: number;
}

interface BrowserTypeOptions {
  text: string;
  clear: boolean;
  delayMs: number;
  timeoutMs: number;
}

interface BrowserWaitOptions {
  state: BrowserWaitState;
  timeoutMs: number;
}

interface BrowserSelectOptions {
  value?: string;
  label?: string;
  timeoutMs: number;
}

interface BrowserCheckOptions {
  checked: boolean;
  timeoutMs: number;
}

interface BrowserDownloadOptions {
  timeoutMs: number;
  expectedElement: BrowserDownloadElementFingerprint;
}

interface BrowserExpectTextOptions {
  selector?: string;
  mode: BrowserTextMatchMode;
  timeoutMs: number;
  caseSensitive?: boolean;
}

interface BrowserExpectUrlOptions {
  mode: BrowserUrlMatchMode;
  timeoutMs: number;
}

interface BrowserExpectHiddenOptions {
  timeoutMs: number;
}

export interface BrowserObserveOptions {
  scope?: "viewport" | "document" | "selector";
  selector?: string;
  maxNodes?: number;
  maxTextChars?: number;
  includeTables?: boolean;
  includeForms?: boolean;
  includeLayoutIssues?: boolean;
  includeAccessibility?: boolean;
  nodeOffset?: number;
  textOffset?: number;
}

export interface BrowserExtractTableOptions {
  maxRows?: number;
  maxScrolls?: number;
  uniqueKeyHint?: string;
}

export interface BrowserVisualObserveOptions {
  scope?: "viewport" | "full_page" | "selector" | "region" | "frame";
  selector?: string;
}

const PLAYWRIGHT_PACKAGE = "playwright";
const DEFAULT_CHROME_PROFILE_PATTERN = /\/(?:google\/chrome(?: beta| dev| sxs)?|chromium|microsoft\/edge(?: beta| dev| sxs)?)\/user data(?:\/|$)/i;

function timestamp(): string {
  return new Date().toISOString();
}

function redactBrowserContent(value: string): string {
  return redactSensitiveText(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\w)(?:\+\d{7,15}|\+?\d{1,3}[\s().-]\d(?:[\s().-]*\d){6,12})(?!\w)/g, "[REDACTED_PHONE]");
}

function sensitiveScreenshotMask(page: any): any[] {
  return [page.locator([
    "input[type='password']",
    "input[autocomplete='current-password']",
    "input[autocomplete='new-password']",
    "input[autocomplete='one-time-code']",
    "input[autocomplete^='cc-']",
    "[data-sensitive='true']",
    "[data-codexpro-sensitive='true']"
  ].join(", "))];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function viewportForDevice(device: BrowserDevicePreset): BrowserViewportPreset {
  if (device === "mobile") {
    return { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  }
  return { width: 1440, height: 1100, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}

function normalizeText(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function textMatches(actual: string, expected: string, mode: BrowserTextMatchMode, caseSensitive = false): boolean {
  const actualValue = normalizeText(actual, caseSensitive);
  const expectedValue = normalizeText(expected, caseSensitive);
  if (mode === "exact") return actualValue.trim() === expectedValue.trim();
  if (mode === "regex") {
    const flags = caseSensitive ? "" : "i";
    return new RegExp(expected, flags).test(actual);
  }
  return actualValue.includes(expectedValue);
}

function urlMatches(actual: string, expected: string, mode: BrowserUrlMatchMode): boolean {
  if (mode === "exact") return actual === expected;
  if (mode === "regex") return new RegExp(expected).test(actual);
  return actual.includes(expected);
}

function classifyAsyncGenerationText(text: string): string | undefined {
  const compact = text.replace(/\s+/g, " ").trim();
  const match = compact.match(/(?:generating|preparing|queued|will be ready|available later|download center|export task|report request|формируется|подготавливается|готовится|正在生成|正在准备|已加入队列|稍后可下载|下载中心|导出任务|报表任务)/i);
  return match ? compact.slice(Math.max(0, (match.index ?? 0) - 120), Math.min(compact.length, (match.index ?? 0) + 380)) : undefined;
}

function normalizedIdentityText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function inferredElementRole(tagName: string | undefined, explicitRole: string | undefined): string {
  const role = normalizedIdentityText(explicitRole).toLowerCase();
  if (role) return role;
  const tag = normalizedIdentityText(tagName).toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  return "";
}

export function allocateUniqueElementRefs(existingRefs: Array<string | null | undefined>, refStart = 0): { refs: string[]; nextRef: number; changed: boolean } {
  let nextRef = Math.max(0, Math.trunc(refStart));
  const used = new Set<string>();
  let changed = false;
  const refs = existingRefs.map((raw) => {
    const current = String(raw ?? "").trim();
    const match = /^e(\d+)$/.exec(current);
    if (match && !used.has(current)) {
      used.add(current);
      nextRef = Math.max(nextRef, Number(match[1]));
      return current;
    }
    let replacement = "";
    do {
      nextRef += 1;
      replacement = `e${nextRef}`;
    } while (used.has(replacement));
    used.add(replacement);
    changed = true;
    return replacement;
  });
  return { refs, nextRef, changed };
}

function normalizeWindowsPath(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function commandLineUserDataDir(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] ?? "");
    if (value.startsWith("--user-data-dir=")) return value.slice("--user-data-dir=".length);
    if (value === "--user-data-dir" && args[index + 1]) return String(args[index + 1]);
  }
  return undefined;
}

export function isDefaultChromeProfileDir(value: string): boolean {
  return DEFAULT_CHROME_PROFILE_PATTERN.test(normalizeWindowsPath(value));
}

export class PlaywrightBrowserAdapter {
  private playwrightModule: any | undefined;
  private browser: any | undefined;
  private context: any | undefined;
  private page: any | undefined;
  private activeDevice: BrowserDevicePreset | undefined;
  private effectiveMode: BrowserMode | undefined;
  private ownsBrowserProcess = false;
  private fallbackReason: string | undefined;
  private isolatedProfileVerified: boolean | undefined;
  private reconnectAttempts = 0;
  private lastReconnectAt: string | undefined;
  private reconnectFailureReason: string | undefined;
  private cdpReconnectPending = false;
  private explicitDisconnecting = false;
  private connectionPromise: Promise<void> | undefined;
  private lastRequestedDevice: BrowserDevicePreset = "desktop";
  private connectedAt: string | undefined;
  private disconnectedAt: string | undefined;
  private navigationCount = 0;
  private elementRefCounter = 0;
  private readonly observedDocumentVersions = new WeakMap<object, string>();
  private authorizationId: string | undefined;
  private authorizationBoundAt: string | undefined;
  private nativeCdpTarget: NativeCdpPageTarget | undefined;
  private readonly nativeCdpClient: NativeCdpReadonlyClient;
  private readonly ownedPages = new Set<any>();
  private readonly pageTabIds = new WeakMap<object, string>();
  private readonly ownedPageLineage = new WeakSet<object>();
  private readonly listeningPages = new WeakSet<object>();
  private readonly cdpSessions = new Map<any, any>();
  private cdpDownloadStagingPaths: CdpDownloadStagingPaths | undefined;
  private downloadInProgress = false;
  private contextPageListener: ((page: any) => void) | undefined;

  constructor(
    private readonly events: PlaywrightAdapterEvents,
    private readonly options: PlaywrightBrowserAdapterOptions
  ) {
    this.playwrightModule = options.playwrightModule;
    this.nativeCdpClient = options.nativeCdpClient ?? createNativeCdpReadonlyClient();
  }

  async open(rawUrl: string, options: BrowserOpenOptions): Promise<BrowserOpenResult> {
    const page = await this.ensurePage(options.device);
    const currentUrl = String(page.url?.() ?? "");
    const sameUrl = currentUrl !== "about:blank" && this.urlsEquivalent(currentUrl, rawUrl);
    if (!sameUrl) {
      await page.goto(rawUrl, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30_000
      });
      this.navigationCount += 1;
    }
    const title = await page.title().catch(() => "");
    return { url: page.url(), title, device: options.device, navigated: !sameUrl };
  }

  async screenshot(absPath: string, options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    const page = await this.requirePage();
    const requestedDevice = options.device;
    if (requestedDevice && requestedDevice !== this.activeDevice) {
      if (this.effectiveMode === "cdp") {
        await this.applyCdpDevicePreset(page, requestedDevice);
        this.activeDevice = requestedDevice;
      } else {
        const currentUrl = page.url();
        await this.recreateOwnedPage(requestedDevice);
        if (currentUrl && currentUrl !== "about:blank") {
          const reloaded = await this.requirePage();
          await reloaded.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }
      }
    }
    const active = await this.requirePage();
    const buffer = await active.screenshot({ path: absPath, fullPage: options.fullPage ?? true, mask: sensitiveScreenshotMask(active), maskColor: "#808080" });
    return { bytes: buffer.length, device: this.activeDevice ?? "desktop" };
  }

  async elementSummary(selector: string, timeoutMs = 5000): Promise<BrowserElementSummary> {
    const page = await this.requirePage();
    return this.describeLocator(page, selector, timeoutMs);
  }

  async inputValueMatches(selector: string, expected: string, timeoutMs = 5000): Promise<boolean> {
    const page = await this.requirePage();
    const locator = page.locator(this.targetSelector(selector)).first();
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
    return await locator.inputValue({ timeout: timeoutMs }) === expected;
  }

  async click(selector: string, options: BrowserClickOptions): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      element = await this.describeLocator(page, selector, options.timeoutMs);
      await locator.waitFor({ state: "visible", timeout: options.timeoutMs });
      await locator.click({ button: options.button ?? "left", timeout: options.timeoutMs });
      return { action: "click", selector, passed: true, timeoutMs: options.timeoutMs, url: page.url(), element };
    } catch (error) {
      return { action: "click", selector, passed: false, timeoutMs: options.timeoutMs, url: page.url(), element, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async type(selector: string, options: BrowserTypeOptions): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      element = await this.describeLocator(page, selector, options.timeoutMs);
      await locator.waitFor({ state: "visible", timeout: options.timeoutMs });
      if (options.clear) {
        await locator.fill(options.text, { timeout: options.timeoutMs });
      } else {
        await locator.type(options.text, { delay: options.delayMs, timeout: options.timeoutMs });
      }
      return { action: "type", selector, passed: true, timeoutMs: options.timeoutMs, url: page.url(), element, textLength: options.text.length };
    } catch (error) {
      return { action: "type", selector, passed: false, timeoutMs: options.timeoutMs, url: page.url(), element, textLength: options.text.length, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async waitForSelector(selector: string, options: BrowserWaitOptions): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      if (options.state === "attached" || options.state === "visible") {
        element = await this.describeLocator(page, selector, options.timeoutMs);
      }
      await locator.waitFor({ state: options.state, timeout: options.timeoutMs });
      if (!element && (options.state === "hidden" || options.state === "detached")) {
        element = await this.describeLocator(page, selector, 250).catch(() => undefined);
      }
      return { action: "wait", selector, passed: true, timeoutMs: options.timeoutMs, url: page.url(), element, state: options.state };
    } catch (error) {
      return { action: "wait", selector, passed: false, timeoutMs: options.timeoutMs, url: page.url(), element, state: options.state, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async select(selector: string, options: BrowserSelectOptions): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      element = await this.describeLocator(page, selector, options.timeoutMs);
      await locator.waitFor({ state: "visible", timeout: options.timeoutMs });
      if (options.label !== undefined) await locator.selectOption({ label: options.label }, { timeout: options.timeoutMs });
      else if (options.value !== undefined) await locator.selectOption(options.value, { timeout: options.timeoutMs });
      else throw new Error("browser_select requires value or label.");
      return { action: "select", selector, passed: true, timeoutMs: options.timeoutMs, url: page.url(), element };
    } catch (error) {
      return { action: "select", selector, passed: false, timeoutMs: options.timeoutMs, url: page.url(), element, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async check(selector: string, options: BrowserCheckOptions): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      element = await this.describeLocator(page, selector, options.timeoutMs);
      await locator.waitFor({ state: "visible", timeout: options.timeoutMs });
      if (options.checked) await locator.check({ timeout: options.timeoutMs });
      else await locator.uncheck({ timeout: options.timeoutMs });
      return { action: "check", selector, passed: true, timeoutMs: options.timeoutMs, url: page.url(), element };
    } catch (error) {
      return { action: "check", selector, passed: false, timeoutMs: options.timeoutMs, url: page.url(), element, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async scrollIntoView(selector: string, timeoutMs: number): Promise<BrowserInteractionResult> {
    const page = await this.requirePage();
    let element: BrowserElementSummary | undefined;
    try {
      const locator = page.locator(this.targetSelector(selector)).first();
      element = await this.describeLocator(page, selector, timeoutMs);
      await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
      return { action: "scroll", selector, passed: true, timeoutMs, url: page.url(), element };
    } catch (error) {
      return { action: "scroll", selector, passed: false, timeoutMs, url: page.url(), element, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async currentPageMainFrameId(page: any): Promise<string> {
    if (!this.context?.newCDPSession) {
      throw new Error("CDP download correlation requires a page-level CDP session.");
    }
    const session = await this.context.newCDPSession(page);
    try {
      const result = await session.send("Page.getFrameTree");
      const frameId = String(result?.frameTree?.frame?.id ?? "").trim();
      if (!frameId) throw new Error("Page.getFrameTree did not return the current main frame id.");
      return frameId;
    } finally {
      await session.detach?.().catch(() => undefined);
    }
  }

  private async prepareCdpDownloadCapture(page: any): Promise<{
    attempt: CdpDownloadStagingAttempt;
    tracker: CdpBrowserDownloadTracker;
    dispose: () => Promise<void>;
  } | undefined> {
    if (this.effectiveMode !== "cdp") return undefined;
    if (!this.cdpDownloadStagingPaths) {
      throw new Error("CDP download staging bridge is not configured for the connected browser.");
    }
    const expectedFrameId = await this.currentPageMainFrameId(page);
    const attempt = await createCdpDownloadStagingAttempt(this.cdpDownloadStagingPaths);
    let session: any;
    try {
      session = await this.browser.newBrowserCDPSession();
    } catch (error) {
      await cleanupCdpDownloadStagingAttempt(attempt).catch(() => undefined);
      throw new Error(`Unable to create browser-level CDP download session: ${error instanceof Error ? error.message : String(error)}`);
    }
    const tracker = new CdpBrowserDownloadTracker(expectedFrameId);
    const onWillBegin = (event: CdpBrowserDownloadWillBeginEvent) => tracker.onWillBegin(event);
    const onProgress = (event: CdpBrowserDownloadProgressEvent) => tracker.onProgress(event);
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      session.off?.("Browser.downloadWillBegin", onWillBegin);
      session.removeListener?.("Browser.downloadWillBegin", onWillBegin);
      session.off?.("Browser.downloadProgress", onProgress);
      session.removeListener?.("Browser.downloadProgress", onProgress);
      await session.detach?.().catch(() => undefined);
    };
    session.on?.("Browser.downloadWillBegin", onWillBegin);
    session.on?.("Browser.downloadProgress", onProgress);
    try {
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: attempt.browserDir,
        eventsEnabled: true
      });
      return { attempt, tracker, dispose };
    } catch (error) {
      await dispose();
      await cleanupCdpDownloadStagingAttempt(attempt).catch(() => undefined);
      throw new Error(`Unable to configure Windows Chrome download staging: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async download(selector: string, options: BrowserDownloadOptions): Promise<BrowserDownloadAdapterResult> {
    const page = await this.requirePage();
    const timeoutMs = options.timeoutMs;
    const sourceUrl = page.url();
    let element: BrowserElementSummary | undefined;
    let cdpCapture: Awaited<ReturnType<PlaywrightBrowserAdapter["prepareCdpDownloadCapture"]>>;
    let preserveStagingForSave = false;
    const resolvedSelector = this.targetSelector(selector);
    if (this.downloadInProgress) {
      return {
        status: "failed",
        selector: resolvedSelector,
        timeoutMs,
        sourceUrl: redactSensitiveText(sourceUrl),
        finalUrl: redactSensitiveText(sourceUrl),
        error: "Another controlled browser download is already in progress."
      };
    }
    this.downloadInProgress = true;
    try {
      const locatorSet = page.locator(resolvedSelector);
      const locatorCount = await locatorSet.count();
      if (locatorCount !== 1) {
        throw new Error(`browser_download target must resolve to exactly one live element; selector ${resolvedSelector} matched ${locatorCount}.`);
      }
      const locator = locatorSet.first();
      element = await this.describeLocator(page, selector, timeoutMs);
      await locator.waitFor({ state: "visible", timeout: timeoutMs });
      this.assertDownloadElementIdentity(element, options.expectedElement);
      cdpCapture = await this.prepareCdpDownloadCapture(page);

      if (cdpCapture) {
        cdpCapture.tracker.arm();
        await locator.click({ button: "left", timeout: timeoutMs });
        let terminal;
        try {
          terminal = await cdpCapture.tracker.waitForTerminal(timeoutMs);
        } catch (eventError) {
          try {
            const staged = await waitForStagedDownloadFile({
              hostDir: cdpCapture.attempt.hostDir,
              timeoutMs: Math.min(2000, timeoutMs)
            });
            preserveStagingForSave = true;
            return {
              status: "completed",
              selector: resolvedSelector,
              timeoutMs,
              sourceUrl: redactSensitiveText(sourceUrl),
              finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
              element,
              suggestedFilename: staged.filename,
              mimeSource: "unknown",
              saveAs: async (absPath: string) => {
                try {
                  await fsp.copyFile(staged.absPath, absPath);
                } finally {
                  await cleanupCdpDownloadStagingAttempt(cdpCapture?.attempt as CdpDownloadStagingAttempt).catch(() => undefined);
                }
              }
            };
          } catch {
            const asyncEvidence = classifyAsyncGenerationText(await this.readText(page).catch(() => ""));
            return {
              status: asyncEvidence ? "async_generation" : "timeout",
              selector: resolvedSelector,
              timeoutMs,
              sourceUrl: redactSensitiveText(sourceUrl),
              finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
              element,
              asyncEvidence,
              error: redactSensitiveText(eventError instanceof Error ? eventError.message : String(eventError))
            };
          }
        }
        if (terminal.state === "canceled") {
          return {
            status: "failed",
            selector: resolvedSelector,
            timeoutMs,
            sourceUrl: redactSensitiveText(sourceUrl),
            finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
            element,
            suggestedFilename: terminal.suggestedFilename,
            downloadUrl: terminal.url ? redactSensitiveText(terminal.url) : undefined,
            mimeSource: "unknown",
            error: `Browser-level CDP download was canceled after receiving ${terminal.receivedBytes ?? 0} of ${terminal.totalBytes ?? 0} bytes.`
          };
        }
        let staged;
        try {
          staged = await waitForStagedDownloadFile({
            hostDir: cdpCapture.attempt.hostDir,
            suggestedFilename: terminal.suggestedFilename,
            timeoutMs
          });
        } catch (stagingError) {
          return {
            status: "failed",
            selector: resolvedSelector,
            timeoutMs,
            sourceUrl: redactSensitiveText(sourceUrl),
            finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
            element,
            suggestedFilename: terminal.suggestedFilename,
            downloadUrl: terminal.url ? redactSensitiveText(terminal.url) : undefined,
            mimeSource: "unknown",
            error: redactSensitiveText(`Browser-level CDP download completed but staged file pickup failed: ${stagingError instanceof Error ? stagingError.message : String(stagingError)}`)
          };
        }
        preserveStagingForSave = true;
        return {
          status: "completed",
          selector: resolvedSelector,
          timeoutMs,
          sourceUrl: redactSensitiveText(sourceUrl),
          finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
          element,
          suggestedFilename: terminal.suggestedFilename ?? staged.filename,
          downloadUrl: terminal.url ? redactSensitiveText(terminal.url) : undefined,
          mimeSource: "unknown",
          saveAs: async (absPath: string) => {
            try {
              await fsp.copyFile(staged.absPath, absPath);
            } finally {
              await cleanupCdpDownloadStagingAttempt(cdpCapture?.attempt as CdpDownloadStagingAttempt).catch(() => undefined);
            }
          }
        };
      }

      const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs })
        .then(async (download: any): Promise<BrowserDownloadAdapterResult> => {
          const failure = await download.failure?.().catch((error: unknown) => error instanceof Error ? error.message : String(error));
          const suggestedFilename = String(download.suggestedFilename?.() ?? "").trim() || undefined;
          const downloadUrl = typeof download.url === "function" ? redactSensitiveText(String(download.url())) : undefined;
          const mimeValue = typeof download.mimeType === "function"
            ? String(await download.mimeType().catch(() => "")).trim() || undefined
            : undefined;
          if (failure) {
            return {
              status: "failed",
              selector: resolvedSelector,
              timeoutMs,
              sourceUrl: redactSensitiveText(sourceUrl),
              finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
              element,
              suggestedFilename,
              downloadUrl,
              ...(mimeValue ? { mime: mimeValue, mimeSource: "playwright" as const } : { mimeSource: "unknown" as const }),
              error: redactSensitiveText(String(failure))
            };
          }
          return {
            status: "completed",
            selector: resolvedSelector,
            timeoutMs,
            sourceUrl: redactSensitiveText(sourceUrl),
            finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
            element,
            suggestedFilename,
            downloadUrl,
            ...(mimeValue ? { mime: mimeValue, mimeSource: "playwright" as const } : { mimeSource: "unknown" as const }),
            saveAs: async (absPath: string) => {
              await download.saveAs(absPath);
            }
          };
        })
        .catch((error: unknown): BrowserDownloadAdapterResult => ({
          status: "timeout",
          selector: resolvedSelector,
          timeoutMs,
          sourceUrl: redactSensitiveText(sourceUrl),
          finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
          element,
          error: redactSensitiveText(error instanceof Error ? error.message : String(error))
        }));

      const navigationPromise = page.waitForNavigation?.({ waitUntil: "domcontentloaded", timeout: timeoutMs })
        .then((): BrowserDownloadAdapterResult => ({
          status: "navigation_without_download",
          selector: resolvedSelector,
          timeoutMs,
          sourceUrl: redactSensitiveText(sourceUrl),
          finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
          element
        }))
        .catch(() => undefined);
      const timeoutPromise = delay(timeoutMs).then(async (): Promise<BrowserDownloadAdapterResult> => {
        const asyncEvidence = classifyAsyncGenerationText(await this.readText(page).catch(() => ""));
        return {
          status: asyncEvidence ? "async_generation" : "timeout",
          selector: resolvedSelector,
          timeoutMs,
          sourceUrl: redactSensitiveText(sourceUrl),
          finalUrl: redactSensitiveText(String(page.url?.() ?? "")),
          element,
          asyncEvidence
        };
      });

      await locator.click({ button: "left", timeout: timeoutMs });
      const result = await Promise.race([downloadPromise, navigationPromise, timeoutPromise]);
      return result ?? await timeoutPromise;
    } catch (error) {
      return {
        status: "failed",
        selector: resolvedSelector,
        timeoutMs,
        sourceUrl: redactSensitiveText(sourceUrl),
        finalUrl: redactSensitiveText(String(page.url?.() ?? sourceUrl)),
        element,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error))
      };
    } finally {
      await cdpCapture?.dispose().catch(() => undefined);
      if (cdpCapture && !preserveStagingForSave) {
        await cleanupCdpDownloadStagingAttempt(cdpCapture.attempt).catch(() => undefined);
      }
      this.downloadInProgress = false;
    }
  }

  async expectText(expected: string, options: BrowserExpectTextOptions): Promise<BrowserExpectationResult> {
    const page = await this.requirePage();
    const started = Date.now();
    let actual = "";
    while (Date.now() - started <= options.timeoutMs) {
      actual = await this.readText(page, options.selector);
      if (textMatches(actual, expected, options.mode, options.caseSensitive)) {
        return { passed: true, expected, actual: actual.slice(0, 2000), mode: options.mode, timeoutMs: options.timeoutMs };
      }
      await delay(250);
    }
    return { passed: false, expected, actual: actual.slice(0, 2000), mode: options.mode, timeoutMs: options.timeoutMs };
  }

  async expectUrl(expected: string, options: BrowserExpectUrlOptions): Promise<BrowserExpectationResult> {
    const page = await this.requirePage();
    const started = Date.now();
    let actual = page.url();
    while (Date.now() - started <= options.timeoutMs) {
      actual = page.url();
      if (urlMatches(actual, expected, options.mode)) {
        return { passed: true, expected, actual, mode: options.mode, timeoutMs: options.timeoutMs };
      }
      await delay(250);
    }
    return { passed: false, expected, actual, mode: options.mode, timeoutMs: options.timeoutMs };
  }

  async expectHidden(selector: string, options: BrowserExpectHiddenOptions): Promise<BrowserExpectationResult> {
    const page = await this.requirePage();
    const started = Date.now();
    let actual = "visible";
    while (Date.now() - started <= options.timeoutMs) {
      const locator = page.locator(this.targetSelector(selector)).first();
      const count = await locator.count().catch(() => 0);
      const visible = count > 0 ? await locator.isVisible().catch(() => false) : false;
      actual = visible ? "visible" : "hidden";
      if (!visible) {
        return { passed: true, expected: selector, actual, mode: "hidden", timeoutMs: options.timeoutMs };
      }
      await delay(250);
    }
    return { passed: false, expected: selector, actual, mode: "hidden", timeoutMs: options.timeoutMs };
  }

  async observe(options: BrowserObserveOptions = {}): Promise<BrowserSemanticSnapshotData> {
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 300, 1000));
    const maxTextChars = Math.max(1000, Math.min(options.maxTextChars ?? 20_000, 80_000));
    if (this.nativeCdpTarget) return await this.observeNativeCdpReadonly(options, maxTextChars);
    const page = await this.requirePage();
    const selector = options.scope === "selector" && options.selector ? this.targetSelector(options.selector) : undefined;
    const documentVersion = await page.evaluate(() => `${performance.timeOrigin}:${location.origin}:${document.characterSet}`);
    const priorDocumentVersion = this.observedDocumentVersions.get(page);
    if (priorDocumentVersion !== documentVersion) {
      await page.evaluate(() => {
        const roots: Array<Document | ShadowRoot> = [document];
        for (let index = 0; index < roots.length; index += 1) {
          for (const element of Array.from(roots[index].querySelectorAll("*"))) {
            element.removeAttribute("data-codexpro-ref");
            if ((element as HTMLElement).shadowRoot) roots.push((element as HTMLElement).shadowRoot!);
            if (element.tagName.toLowerCase() === "iframe") {
              try { if ((element as HTMLIFrameElement).contentDocument) roots.push((element as HTMLIFrameElement).contentDocument!); } catch { /* cross-origin boundary */ }
            }
          }
        }
      });
      this.observedDocumentVersions.set(page, documentVersion);
    }
    const existingRefs = await page.evaluate(() => Array.from(document.querySelectorAll("[data-codexpro-ref]")).map((element) => element.getAttribute("data-codexpro-ref")));
    const normalizedRefs = allocateUniqueElementRefs(existingRefs, this.elementRefCounter);
    if (normalizedRefs.changed) {
      await page.evaluate((refs: string[]) => {
        const elements = Array.from(document.querySelectorAll("[data-codexpro-ref]"));
        elements.forEach((element, index) => element.setAttribute("data-codexpro-ref", refs[index]));
      }, normalizedRefs.refs);
    }
    this.elementRefCounter = Math.max(this.elementRefCounter, normalizedRefs.nextRef);
    const refStart = this.elementRefCounter;
    const raw = await page.evaluate(
      ({ scope, selector: scopedSelector, maxNodes: nodeLimit, maxTextChars: textLimit, includeTables, includeForms, includeLayoutIssues, refStart: start, nodeOffset: rawNodeOffset, textOffset: rawTextOffset, documentVersion: currentDocumentVersion }: any) => {
        const doc = document;
        const nodeOffset = Math.max(0, Math.floor(Number(rawNodeOffset) || 0));
        const textOffset = Math.max(0, Math.floor(Number(rawTextOffset) || 0));
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let nextRef = start;
        const refOwners = new Map<string, Element>();
        for (const element of Array.from(doc.querySelectorAll("[data-codexpro-ref]"))) {
          const existing = element.getAttribute("data-codexpro-ref") || "";
          const match = /^e(\d+)$/.exec(existing);
          if (!match || refOwners.has(existing)) {
            element.removeAttribute("data-codexpro-ref");
            continue;
          }
          refOwners.set(existing, element);
          nextRef = Math.max(nextRef, Number(match[1]));
        }
        const assignRef = (element: Element, prefix = "e") => {
          const existing = element.getAttribute("data-codexpro-ref");
          if (existing && refOwners.get(existing) === element) return existing;
          let ref = "";
          do {
            nextRef += 1;
            ref = `${prefix}${nextRef}`;
          } while (refOwners.has(ref));
          element.setAttribute("data-codexpro-ref", ref);
          refOwners.set(ref, element);
          return ref;
        };
        const clean = (value: unknown, limit = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
        const isVisible = (element: Element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        };
        const inViewport = (rect: DOMRect) => rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
        type SemanticContext = { root: Element | ShadowRoot; frameId: string; parentFrameId?: string; origin: string; shadowRoot: "none" | "open"; readable: boolean; boundary?: HTMLIFrameElement };
        const contexts: SemanticContext[] = [];
        const frames: any[] = [];
        const seenRoots = new Set<Element | ShadowRoot>();
        const addContext = (contextRoot: Element | ShadowRoot, frameId: string, parentFrameId: string | undefined, origin: string, shadowRoot: "none" | "open", boundary?: HTMLIFrameElement) => {
          if (seenRoots.has(contextRoot)) return;
          seenRoots.add(contextRoot);
          contexts.push({ root: contextRoot, frameId, parentFrameId, origin, shadowRoot, readable: true, boundary });
          frames.push({
            frameId,
            parentFrameId,
            origin,
            sameOrigin: true,
            shadowRoot,
            readable: true,
            visibleBounds: boundary ? (() => { const rect = boundary.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; })() : undefined
          });
          const all = Array.from(contextRoot.querySelectorAll("*"));
          for (let index = 0; index < all.length; index += 1) {
            const element = all[index] as HTMLElement;
            if (element.shadowRoot) addContext(element.shadowRoot, `${frameId}:shadow:${index}`, frameId, origin, "open");
            if (element.tagName.toLowerCase() !== "iframe") continue;
            const iframe = element as HTMLIFrameElement;
            const childFrameId = `${frameId}:iframe:${index}`;
            let childRoot: HTMLElement | null = null;
            let childOrigin = "opaque";
            try {
              childRoot = iframe.contentDocument?.body ?? null;
              childOrigin = iframe.contentWindow?.location.origin || origin;
            } catch {
              childRoot = null;
              try { childOrigin = new URL(iframe.src, location.href).origin; } catch { childOrigin = "opaque"; }
            }
            if (childRoot) addContext(childRoot, childFrameId, frameId, childOrigin, "none", iframe);
            else {
              const rect = iframe.getBoundingClientRect();
              frames.push({ frameId: childFrameId, parentFrameId: frameId, origin: childOrigin, sameOrigin: false, shadowRoot: "none", readable: false, visibleBounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
            }
          }
        };
        addContext(doc.body, "main", undefined, location.origin, "none");
        let scopedRoot: Element | undefined;
        let scopedFrameId = "main";
        if (scopedSelector) {
          for (const context of contexts) {
            const match = context.root.querySelector(scopedSelector);
            if (match) { scopedRoot = match; scopedFrameId = context.frameId; break; }
          }
          if (!scopedRoot) throw new Error(`Observation selector not found: ${scopedSelector}`);
        }
        const scopedContext = contexts.find((context) => context.frameId === scopedFrameId) ?? contexts[0];
        const activeContexts: SemanticContext[] = scopedRoot
          ? [{ ...scopedContext, root: scopedRoot }]
          : contexts;
        for (const context of contexts) {
          for (const element of Array.from(context.root.querySelectorAll("[data-codexpro-ref]"))) {
            const existing = element.getAttribute("data-codexpro-ref") || "";
            const match = /^e(\d+)$/.exec(existing);
            if (refOwners.get(existing) === element) continue;
            if (!match || refOwners.has(existing)) { element.removeAttribute("data-codexpro-ref"); continue; }
            refOwners.set(existing, element);
            nextRef = Math.max(nextRef, Number(match[1]));
          }
        }
        const semanticSelector = "a,button,input,textarea,select,iframe,[role],[aria-modal='true'],[contenteditable='true'],summary,[tabindex],table,form,nav,main,header,footer,aside,section,h1,h2,h3,img";
        const candidates: Array<{ element: Element; frameId: string; contextLabel: string }> = [];
        for (const context of activeContexts) {
          const found = Array.from(context.root.querySelectorAll(semanticSelector));
          if ((context.root as Element).matches?.(semanticSelector)) found.unshift(context.root as Element);
          for (const element of found) candidates.push({ element, frameId: context.frameId, contextLabel: context.shadowRoot === "open" ? "open-shadow-root" : context.frameId });
        }
        const elements: any[] = [];
        const regions: any[] = [];
        const tables: any[] = [];
        const forms: any[] = [];
        const issues: any[] = [];
        const seen = new Set<Element>();
        for (const candidate of candidates.slice(nodeOffset, nodeOffset + nodeLimit)) {
          const { element, frameId, contextLabel } = candidate;
          if (seen.has(element)) continue;
          seen.add(element);
          const visible = isVisible(element);
          const rect = element.getBoundingClientRect();
          if (scope === "viewport" && (!visible || !inViewport(rect))) continue;
          const tagName = element.tagName.toLowerCase();
          const role = clean(element.getAttribute("role") || ({ nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", button: "button", a: "link", table: "table", form: "form" } as any)[tagName] || "", 80) || undefined;
          const ariaLabel = clean(element.getAttribute("aria-label"), 200);
          const labelledBy = element.getAttribute("aria-labelledby");
          const labelledText = labelledBy ? clean(labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent || "").join(" "), 200) : "";
          const text = clean((element as HTMLElement).innerText || element.textContent, 500);
          const name = ariaLabel || labelledText || clean(element.getAttribute("title"), 200) || (tagName === "input" ? clean((element as HTMLInputElement).placeholder, 200) : "") || text.slice(0, 200) || undefined;
          const ref = assignRef(element);
          const input = element as HTMLInputElement;
          const type = clean(element.getAttribute("type"), 80) || undefined;
          const sensitive = tagName === "input" && (type === "password" || /password|token|secret|authorization|cookie|cc-/i.test(`${input.name} ${input.autocomplete}`));
          const valueState = tagName === "input" || tagName === "textarea" || tagName === "select"
            ? sensitive ? "masked" : clean((element as HTMLInputElement).value, 1) ? "filled" : "empty"
            : undefined;
          const clickable = tagName === "a" || tagName === "button" || role === "button" || role === "link" || element.hasAttribute("onclick") || element.getAttribute("tabindex") === "0";
          const editable = tagName === "input" || tagName === "textarea" || tagName === "select" || (element as HTMLElement).isContentEditable;
          const container = element.closest("[role='dialog'],[role='tooltip'],[role='menu'],[aria-modal='true'],form");
          const containerRef = container && container !== element ? assignRef(container) : undefined;
          const containerTag = container?.tagName.toLowerCase();
          const containerRole = container && container !== element
            ? clean(container.getAttribute("role") || ({ form: "form" } as any)[containerTag || ""] || "", 80) || undefined
            : undefined;
          const containerText = container && container !== element ? clean((container as HTMLElement).innerText || container.textContent, 500) || undefined : undefined;
          elements.push({
            ref,
            selector: `[data-codexpro-ref="${ref}"]`,
            role,
            name,
            id: clean(element.id, 200) || undefined,
            tagName,
            text: text || undefined,
            type,
            href: tagName === "a" ? clean((element as HTMLAnchorElement).href, 500) || undefined : undefined,
            placeholder: tagName === "input" || tagName === "textarea" ? clean((element as HTMLInputElement).placeholder, 200) || undefined : undefined,
            valueState,
            checked: "checked" in input ? Boolean(input.checked) : undefined,
            selected: element.getAttribute("aria-selected") === null ? undefined : element.getAttribute("aria-selected") === "true",
            expanded: element.getAttribute("aria-expanded") === null ? undefined : element.getAttribute("aria-expanded") === "true",
            disabled: "disabled" in input ? Boolean(input.disabled) : element.getAttribute("aria-disabled") === "true",
            readonly: "readOnly" in input ? Boolean(input.readOnly) : undefined,
            visible,
            inViewport: inViewport(rect),
            editable,
            clickable,
            source: "playwright",
            actionable: frameId === "main" || frameId.includes(":shadow:"),
            frameId,
            context: contextLabel,
            containerRef,
            containerRole,
            containerText,
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
          });
          if (["nav", "main", "header", "footer", "aside", "section"].includes(tagName) || ["navigation", "main", "banner", "contentinfo", "complementary", "region"].includes(role || "")) {
            regions.push({ ref, role: role || tagName, name, text: text.slice(0, 500) || undefined });
          }
          if (includeLayoutIssues !== false && visible && clickable && (rect.width < 24 || rect.height < 24)) {
            issues.push({ severity: "warning", code: "small-click-target", message: `Clickable element ${ref} is smaller than 24px.`, refs: [ref], requiresVisualConfirmation: true });
          }
          if (includeLayoutIssues !== false && visible && clickable && !name) {
            issues.push({ severity: "warning", code: "missing-accessible-name", message: `Interactive element ${ref} has no accessible name.`, refs: [ref] });
          }
        }
        if (includeTables !== false) {
          const tableElements = activeContexts.flatMap((context) => Array.from(context.root.querySelectorAll("table")));
          for (const table of tableElements.slice(0, 20)) {
            const ref = assignRef(table);
            const rows = Array.from(table.querySelectorAll("tr"));
            const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((cell) => clean(cell.textContent, 200));
            const sampleRows = rows.slice(headers.length ? 1 : 0, 10 + (headers.length ? 1 : 0)).map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => clean(cell.textContent, 300)));
            const scrollHost = table.parentElement && table.parentElement.scrollHeight > table.parentElement.clientHeight ? table.parentElement : table;
            const virtual = scrollHost.scrollHeight > scrollHost.clientHeight + 1 || table.hasAttribute("aria-rowcount");
            const estimatedTotal = Number(table.getAttribute("aria-rowcount")) || undefined;
            tables.push({ ref, headers, rowCount: rows.length - (headers.length ? 1 : 0), sampleRows, virtual, loadedStart: 0, loadedEnd: Math.max(0, rows.length - (headers.length ? 1 : 0)), estimatedTotal, possibleMore: Boolean(virtual && (!estimatedTotal || rows.length < estimatedTotal)) });
          }
        }
        if (includeForms !== false) {
          const formElements = activeContexts.flatMap((context) => Array.from(context.root.querySelectorAll("form")));
          for (const form of formElements.slice(0, 20)) {
            const ref = assignRef(form);
            const fields = Array.from(form.querySelectorAll("input,textarea,select")).slice(0, 100).map((field) => {
              const fieldRef = assignRef(field);
              const input = field as HTMLInputElement;
              const fieldType = clean(field.getAttribute("type"), 80) || field.tagName.toLowerCase();
              const sensitive = fieldType === "password" || /password|token|secret|authorization|cookie|cc-/i.test(`${input.name} ${input.autocomplete}`);
              return { ref: fieldRef, name: clean(input.name || input.getAttribute("aria-label") || input.placeholder, 200) || undefined, type: fieldType, required: Boolean(input.required), disabled: Boolean(input.disabled), valueState: sensitive ? "masked" : clean(input.value, 1) ? "filled" : "empty" };
            });
            forms.push({ ref, fieldCount: fields.length, fields });
          }
        }
        if (includeLayoutIssues !== false && doc.documentElement.scrollWidth > viewportWidth + 1) {
          issues.push({ severity: "warning", code: "horizontal-overflow", message: `Document width ${doc.documentElement.scrollWidth}px exceeds viewport ${viewportWidth}px.`, requiresVisualConfirmation: true });
        }
        if (includeLayoutIssues !== false) {
          const brokenImages = activeContexts.flatMap((context) => Array.from(context.root.querySelectorAll("img"))).filter((image) => !(image as HTMLImageElement).complete || (image as HTMLImageElement).naturalWidth === 0).slice(0, 20);
          for (const image of brokenImages) {
            const ref = assignRef(image);
            issues.push({ severity: "error", code: "image-load-failed", message: `Image ${ref} failed to load.`, refs: [ref] });
          }
        }
        const rawVisibleText = activeContexts.map((context) => clean((context.root as HTMLElement).innerText || context.root.textContent, Number.MAX_SAFE_INTEGER)).filter(Boolean).join("\n");
        const visibleText = rawVisibleText.slice(textOffset, textOffset + textLimit);
        const nextNodeOffset = nodeOffset + nodeLimit < candidates.length ? nodeOffset + nodeLimit : undefined;
        const nextTextOffset = textOffset + visibleText.length < rawVisibleText.length ? textOffset + visibleText.length : undefined;
        return {
          nextRef,
          data: {
            url: location.href,
            title: doc.title,
            readyState: doc.readyState,
            viewport: { width: viewportWidth, height: viewportHeight },
            scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), maxX: Math.max(0, doc.documentElement.scrollWidth - viewportWidth), maxY: Math.max(0, doc.documentElement.scrollHeight - viewportHeight) },
            text: visibleText,
            source: "playwright",
            pageId: `${location.origin}${location.pathname}`,
            documentVersion: currentDocumentVersion,
            pageRevisionSeed: `${doc.title}|${doc.readyState}|${doc.getElementsByTagName("*").length}|${rawVisibleText.length}|${rawVisibleText.slice(0, 1024)}|${rawVisibleText.slice(-1024)}`,
            frames,
            pagination: { nodeOffset, nextNodeOffset, totalNodes: candidates.length, textOffset, nextTextOffset, totalTextChars: rawVisibleText.length, hasMore: nextNodeOffset !== undefined || nextTextOffset !== undefined },
            regions,
            elements,
            tables,
            forms,
            issues,
            truncated: nextNodeOffset !== undefined || nextTextOffset !== undefined
          }
        };
      },
      {
        scope: options.scope ?? "viewport",
        selector,
        maxNodes,
        maxTextChars,
        includeTables: options.includeTables,
        includeForms: options.includeForms,
        includeLayoutIssues: options.includeLayoutIssues,
        refStart,
        nodeOffset: options.nodeOffset,
        textOffset: options.textOffset,
        documentVersion
      }
    );
    this.elementRefCounter = Math.max(this.elementRefCounter, Number(raw.nextRef ?? this.elementRefCounter));
    const data = raw.data as BrowserSemanticSnapshotData;
    const cdpObservation = await this.readCdpObservation(page, options.includeAccessibility !== false, maxNodes);
    data.accessibility = cdpObservation.accessibility;
    data.domSnapshotNodeCount = cdpObservation.domSnapshotNodeCount;
    data.url = redactSensitiveText(data.url);
    data.title = redactBrowserContent(data.title);
    data.text = redactBrowserContent(data.text);
    data.pageRevisionSeed = `sha256:${createHash("sha256").update(data.pageRevisionSeed).digest("hex")}`;
    data.device = this.activeDevice ?? "desktop";
    data.elements = data.elements.map((element) => ({
      ...element,
      text: element.text ? redactBrowserContent(element.text) : undefined,
      name: element.name ? redactBrowserContent(element.name) : undefined,
      href: element.href ? redactBrowserContent(element.href) : undefined,
      placeholder: element.placeholder ? redactBrowserContent(element.placeholder) : undefined
    }));
    data.regions = data.regions.map((region) => ({ ...region, name: region.name ? redactBrowserContent(region.name) : undefined, text: region.text ? redactBrowserContent(region.text) : undefined }));
    data.tables = data.tables.map((table) => ({
      ...table,
      headers: table.headers.map((value) => redactBrowserContent(value)),
      sampleRows: table.sampleRows.map((row) => row.map((value) => redactBrowserContent(value)))
    }));
    data.forms = data.forms.map((form) => ({ ...form, fields: form.fields.map((field) => ({ ...field, name: field.name ? redactBrowserContent(field.name) : undefined })) }));
    data.issues = data.issues.map((issue) => ({ ...issue, message: redactBrowserContent(issue.message) }));
    data.frames = data.frames.map((frame) => ({ ...frame, origin: redactSensitiveText(frame.origin) }));
    return data;
  }

  private async observeNativeCdpReadonly(options: BrowserObserveOptions, maxTextChars: number): Promise<BrowserSemanticSnapshotData> {
    if (!this.nativeCdpTarget) throw new Error("Native CDP read-only target is not bound.");
    const raw = await this.nativeCdpClient.observeTarget(this.nativeCdpTarget, {
      scope: options.scope,
      selector: options.selector,
      maxNodes: Math.max(1, Math.min(options.maxNodes ?? 300, 1000)),
      nodeOffset: options.nodeOffset,
      textOffset: options.textOffset,
      maxTextChars,
      timeoutMs: this.options.cdpConnectTimeoutMs
    });
    return {
      ...raw,
      url: redactSensitiveText(raw.url),
      title: redactBrowserContent(raw.title),
      text: redactBrowserContent(raw.text),
      pageRevisionSeed: `sha256:${createHash("sha256").update(raw.pageRevisionSeed).digest("hex")}`,
      elements: raw.elements.map((element) => ({
        ...element,
        text: element.text ? redactBrowserContent(element.text) : undefined,
        name: element.name ? redactBrowserContent(element.name) : undefined,
        href: element.href ? redactBrowserContent(element.href) : undefined,
        placeholder: element.placeholder ? redactBrowserContent(element.placeholder) : undefined
      })),
      accessibility: raw.accessibility.map((node) => ({
        ...node,
        name: node.name ? redactBrowserContent(node.name) : undefined,
        description: node.description ? redactBrowserContent(node.description) : undefined
      })),
      regions: raw.regions.map((region) => ({ ...region, name: region.name ? redactBrowserContent(region.name) : undefined, text: region.text ? redactBrowserContent(region.text) : undefined })),
      tables: raw.tables.map((table) => ({ ...table, headers: table.headers.map((value) => redactBrowserContent(value)), sampleRows: table.sampleRows.map((row) => row.map((value) => redactBrowserContent(value))) })),
      forms: raw.forms.map((form) => ({ ...form, fields: form.fields.map((field) => ({ ...field, name: field.name ? redactBrowserContent(field.name) : undefined })) })),
      issues: raw.issues.map((issue) => ({ ...issue, message: redactBrowserContent(issue.message) })),
      frames: raw.frames.map((frame) => ({ ...frame, origin: redactSensitiveText(frame.origin) })),
      device: this.activeDevice ?? "desktop"
    };
  }

  async extractTable(target: string, options: BrowserExtractTableOptions = {}): Promise<BrowserTableExtractionAdapterResult> {
    const maxRows = clampToolLimit(
      options.maxRows,
      TOOL_LIMITS.browser.extract_table_default_rows,
      TOOL_LIMITS.browser.extract_table_max_rows
    );
    const maxScrolls = clampToolLimit(
      options.maxScrolls,
      TOOL_LIMITS.browser.extract_table_default_scrolls,
      TOOL_LIMITS.browser.extract_table_max_scrolls,
      0
    );
    const uniqueKeyHint = String(options.uniqueKeyHint ?? "").trim();
    if (this.nativeCdpTarget) {
      const snapshot = await this.observeNativeCdpReadonly({ scope: "document", maxNodes: 1000 }, 80_000);
      const table = snapshot.tables.find((entry) => entry.ref === target) ?? snapshot.tables[0];
      if (!table) throw new Error(`Native CDP read-only table not found: ${target}`);
      const columns = table.headers.map((label, index) => ({ key: label || `column_${index + 1}`, label: label || `Column ${index + 1}` }));
      const rows = table.sampleRows.slice(0, maxRows).map((cells) => Object.fromEntries(columns.map((column, index) => [column.key, redactBrowserContent(cells[index] ?? "")])));
      return {
        url: snapshot.url,
        title: snapshot.title,
        tableRef: table.ref,
        columns,
        rows,
        uniqueKey: uniqueKeyHint || undefined,
        deduplicatedRows: 0,
        loadedRange: { start: table.loadedStart ?? 0, end: table.loadedEnd ?? rows.length },
        maxRows,
        maxScrolls,
        scrollsUsed: 0,
        completeness: table.possibleMore || table.virtual ? "sampled" : "complete",
        possibleMore: Boolean(table.possibleMore || table.virtual),
        virtual: Boolean(table.virtual),
        limitations: ["Native CDP fallback is read-only; table extraction is limited to the currently loaded DOM sample."]
      };
    }
    const page = await this.requirePage();
    const selector = this.targetSelector(target);
    const rowsByKey = new Map<string, Record<string, string>>();
    let observedRowCount = 0;
    let columns: Array<{ key: string; label: string }> = [];
    let tableRef = target;
    let resolvedUniqueKey: string | undefined;
    let possibleMore = false;
    let virtual = false;
    let scrollsUsed = 0;
    let stoppedWithoutProgress = false;
    for (let attempt = 0; attempt <= maxScrolls && rowsByKey.size < maxRows; attempt += 1) {
      const sample = await page.evaluate(({ targetSelector, uniqueKey }: any) => {
        const roots: Array<Document | ShadowRoot | Element> = [document];
        for (let cursor = 0; cursor < roots.length; cursor += 1) {
          for (const element of Array.from(roots[cursor].querySelectorAll("*"))) {
            if ((element as HTMLElement).shadowRoot) roots.push((element as HTMLElement).shadowRoot!);
            if (element.tagName.toLowerCase() === "iframe") {
              try { if ((element as HTMLIFrameElement).contentDocument) roots.push((element as HTMLIFrameElement).contentDocument!); } catch { /* cross-origin boundary */ }
            }
          }
        }
        let table: Element | undefined;
        for (const root of roots) {
          const match = root.querySelector(targetSelector);
          if (match) { table = match; break; }
        }
        if (!table) throw new Error(`Table selector not found: ${targetSelector}`);
        const clean = (value: unknown, limit = 1000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
        const rowElements = Array.from(table.querySelectorAll("tbody tr,[role='row']")).filter((row) => !row.closest("thead"));
        const headerCells = Array.from(table.querySelectorAll("thead th,[role='columnheader']"));
        if (!headerCells.length) {
          const first = table.querySelector("tr");
          if (first) headerCells.push(...Array.from(first.querySelectorAll("th")));
        }
        const labels = headerCells.map((cell, index) => clean(cell.textContent, 200) || `Column ${index + 1}`);
        const width = Math.max(labels.length, ...rowElements.map((row) => row.querySelectorAll("th,td,[role='cell'],[role='gridcell']").length), 0);
        while (labels.length < width) labels.push(`Column ${labels.length + 1}`);
        const keys: string[] = [];
        const used = new Set<string>();
        for (let index = 0; index < labels.length; index += 1) {
          const base = labels[index].toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").replace(/^_+|_+$/g, "") || `column_${index + 1}`;
          let key = base;
          let suffix = 1;
          while (used.has(key)) { suffix += 1; key = `${base}_${suffix}`; }
          used.add(key);
          keys.push(key);
        }
        const rows = rowElements.map((row) => {
          const cells = Array.from(row.querySelectorAll("th,td,[role='cell'],[role='gridcell']")).map((cell) => clean(cell.textContent));
          return Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ""]));
        });
        const scrollHost = [table, table.parentElement, table.closest("[role='region'],[role='grid'],[data-virtualized],.virtual-list,.virtualized")].find((entry) => entry && entry.scrollHeight > entry.clientHeight + 1) as HTMLElement | undefined;
        const ariaTotal = Number(table.getAttribute("aria-rowcount")) || undefined;
        const isVirtual = Boolean(scrollHost || ariaTotal || table.matches("[role='grid'],[data-virtualized],.virtual-list,.virtualized"));
        const before = scrollHost?.scrollTop ?? 0;
        const atEnd = !scrollHost || before + scrollHost.clientHeight >= scrollHost.scrollHeight - 1;
        const canAdvance = Boolean(scrollHost && !atEnd);
        if (canAdvance) scrollHost!.scrollTop = Math.min(scrollHost!.scrollHeight, before + Math.max(1, Math.floor(scrollHost!.clientHeight * 0.8)));
        const after = scrollHost?.scrollTop ?? before;
        const ref = table.getAttribute("data-codexpro-ref") || targetSelector;
        return { ref, labels, keys, rows, uniqueKey, virtual: isVirtual, ariaTotal, canAdvance, advanced: after > before, atEnd };
      }, { targetSelector: selector, uniqueKey: uniqueKeyHint });
      tableRef = sample.ref || tableRef;
      columns = sample.keys.map((key: string, index: number) => ({ key, label: redactBrowserContent(sample.labels[index] ?? key) }));
      const normalizedHint = uniqueKeyHint.toLowerCase();
      const hintedKey = columns.find((column) => column.key.toLowerCase() === normalizedHint || column.label.toLowerCase() === normalizedHint)?.key;
      if (hintedKey) resolvedUniqueKey = hintedKey;
      const beforeSize = rowsByKey.size;
      for (const row of sample.rows as Array<Record<string, string>>) {
        observedRowCount += 1;
        const redactedRow = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, redactBrowserContent(value)]));
        const dedupeKey = hintedKey && redactedRow[hintedKey] ? `${hintedKey}:${redactedRow[hintedKey]}` : JSON.stringify(redactedRow);
        if (!rowsByKey.has(dedupeKey)) rowsByKey.set(dedupeKey, redactedRow);
        if (rowsByKey.size >= maxRows) break;
      }
      virtual ||= Boolean(sample.virtual);
      possibleMore = Boolean(sample.canAdvance || (sample.ariaTotal && rowsByKey.size < sample.ariaTotal));
      if (!possibleMore) break;
      if (attempt >= maxScrolls) break;
      scrollsUsed += 1;
      if (!sample.advanced || rowsByKey.size === beforeSize) {
        stoppedWithoutProgress = true;
        break;
      }
      await delay(100);
    }
    const rows = [...rowsByKey.values()].slice(0, maxRows);
    const reachedRowLimit = rowsByKey.size >= maxRows;
    const limitations: string[] = [];
    if (reachedRowLimit) limitations.push(`Extraction stopped at max_rows=${maxRows}.`);
    if (possibleMore && scrollsUsed >= maxScrolls) limitations.push(`Extraction stopped at max_scrolls=${maxScrolls}.`);
    if (stoppedWithoutProgress) limitations.push("Virtual collection stopped because a bounded scroll produced no new rows or scroll progress.");
    if (uniqueKeyHint && !resolvedUniqueKey) limitations.push(`unique_key_hint=${uniqueKeyHint} did not match a column; full-row deduplication was used.`);
    return {
      url: redactSensitiveText(String(page.url?.() ?? "")),
      title: redactBrowserContent(await page.title().catch(() => "")),
      tableRef,
      columns,
      rows,
      uniqueKey: resolvedUniqueKey,
      deduplicatedRows: Math.max(0, observedRowCount - rowsByKey.size),
      loadedRange: { start: 0, end: rows.length },
      maxRows,
      maxScrolls,
      scrollsUsed,
      completeness: stoppedWithoutProgress ? "partial" : possibleMore || reachedRowLimit ? "sampled" : "complete",
      possibleMore: Boolean(possibleMore || reachedRowLimit),
      virtual,
      limitations
    };
  }

  private async readCdpObservation(page: any, includeAccessibility: boolean, maxNodes: number): Promise<{ accessibility: BrowserAccessibilityNode[]; domSnapshotNodeCount?: number }> {
    if (!this.context?.newCDPSession) return { accessibility: [] };
    const session = await this.context.newCDPSession(page).catch(() => undefined);
    if (!session) return { accessibility: [] };
    try {
      const accessibility: BrowserAccessibilityNode[] = [];
      if (includeAccessibility) {
        const result = await session.send("Accessibility.getFullAXTree").catch(() => undefined);
        const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
        for (const node of nodes) {
          if (accessibility.length >= Math.min(maxNodes, 300)) break;
          const role = String(node?.role?.value ?? "").trim();
          const name = String(node?.name?.value ?? "").trim();
          const description = String(node?.description?.value ?? "").trim();
          if (node?.ignored && !role && !name && !description) continue;
          accessibility.push({
            role: role || undefined,
            name: name ? redactBrowserContent(name).slice(0, 300) : undefined,
            description: description ? redactBrowserContent(description).slice(0, 500) : undefined,
            ignored: Boolean(node?.ignored),
            backendDOMNodeId: Number.isInteger(node?.backendDOMNodeId) ? Number(node.backendDOMNodeId) : undefined
          });
        }
      }
      const snapshot = await session.send("DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: false, includePaintOrder: false }).catch(() => undefined);
      const domSnapshotNodeCount = Array.isArray(snapshot?.documents)
        ? snapshot.documents.reduce((total: number, document: any) => total + (Array.isArray(document?.nodes?.nodeType) ? document.nodes.nodeType.length : 0), 0)
        : undefined;
      return { accessibility, domSnapshotNodeCount };
    } finally {
      await session.detach?.().catch(() => undefined);
    }
  }

  async visualScreenshot(absPath: string, options: BrowserVisualObserveOptions = {}): Promise<BrowserScreenshotResult> {
    const page = await this.requirePage();
    const screenshotOptions = { path: absPath, mask: sensitiveScreenshotMask(page), maskColor: "#808080" };
    if (options.scope === "selector" || options.scope === "region" || options.scope === "frame") {
      if (!options.selector) throw new Error(`selector is required when visual scope is ${options.scope}`);
      const locator = page.locator(this.targetSelector(options.selector)).first();
      const buffer = await locator.screenshot(screenshotOptions);
      return { bytes: buffer.length, device: this.activeDevice ?? "desktop" };
    }
    const buffer = await page.screenshot({ ...screenshotOptions, fullPage: options.scope === "full_page" });
    return { bytes: buffer.length, device: this.activeDevice ?? "desktop" };
  }

  currentUrl(): string | undefined {
    if (this.nativeCdpTarget) return redactSensitiveText(this.nativeCdpTarget.url) || undefined;
    if (!this.page || this.page.isClosed?.()) return undefined;
    return redactSensitiveText(String(this.page.url?.() ?? "")) || undefined;
  }

  status(): BrowserBridgeStatus {
    return {
      requestedMode: this.options.mode,
      effectiveMode: this.effectiveMode,
      connected: this.isConnected(),
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      ownsBrowserProcess: this.ownsBrowserProcess,
      fallbackReason: this.fallbackReason ? redactSensitiveText(this.fallbackReason) : undefined,
      isolatedProfileVerified: this.isolatedProfileVerified,
      reconnectAttempts: this.reconnectAttempts,
      lastReconnectAt: this.lastReconnectAt,
      reconnectFailureReason: this.reconnectFailureReason ? redactSensitiveText(this.reconnectFailureReason) : undefined,
      currentUrl: this.currentUrl(),
      currentDevice: this.activeDevice,
      tabCount: this.countTabs(),
      navigationCount: this.navigationCount,
      authorizationId: this.authorizationId,
      authorizationBoundAt: this.authorizationBoundAt,
      downloadBridgeConfigured: Boolean(this.cdpDownloadStagingPaths),
      downloadBridgeBrowserDir: this.cdpDownloadStagingPaths?.browserBaseDir,
      downloadBridgeHostDir: this.cdpDownloadStagingPaths?.hostBaseDir
    };
  }

  async bindAuthorizedTab(authorizationId: string): Promise<BrowserTabEntry> {
    await this.ensureBrowser();
    if (this.effectiveMode !== "cdp") throw new Error("Authorized-tab binding requires CDP mode.");
    const cdpUrl = this.options.cdpUrl?.trim();
    if (!cdpUrl) throw new Error("CDP URL is not configured.");
    const pages = this.browser?.contexts?.().flatMap((context: any) => context.pages?.() ?? []) ?? [];
    for (let index = 0; index < pages.length; index += 1) {
      const candidate = pages[index];
      const candidateUrl = String(candidate.url?.() ?? "").trim();
      if (!candidateUrl) continue;
      const marker = await Promise.race([
        candidate.evaluate((id: string) => document.documentElement?.getAttribute("data-codexpro-authorization") === id, authorizationId).catch(() => false),
        delay(Math.min(this.options.cdpConnectTimeoutMs, 2_000)).then(() => false)
      ]);
      if (!marker) continue;
      this.page = candidate;
      this.nativeCdpTarget = undefined;
      this.context = candidate.context?.() ?? this.context;
      await this.applyCdpDevicePreset(candidate, "desktop");
      this.activeDevice = "desktop";
      this.authorizationId = authorizationId;
      this.authorizationBoundAt = timestamp();
      await this.attachListeners(candidate);
      return {
        tabId: this.tabIdForPage(candidate),
        index,
        title: redactSensitiveText(String(await candidate.title?.().catch(() => "") ?? "")),
        url: redactSensitiveText(candidateUrl),
        current: true,
        ownedByCodexPro: this.ownedPages.has(candidate)
      };
    }
    const nativeTarget = await this.nativeCdpClient.findAuthorizedTarget(cdpUrl, authorizationId, this.options.cdpConnectTimeoutMs);
    if (nativeTarget) {
      this.page = undefined;
      this.nativeCdpTarget = nativeTarget;
      this.activeDevice = "desktop";
      this.authorizationId = authorizationId;
      this.authorizationBoundAt = timestamp();
      return {
        tabId: `external-cdp-${nativeTarget.id}`,
        index: 0,
        title: redactSensitiveText(nativeTarget.title),
        url: redactSensitiveText(nativeTarget.url),
        current: true,
        ownedByCodexPro: false
      };
    }
    throw new Error("The authorized Chrome tab was not found. Re-authorize the current tab in the Chrome extension.");
  }

  releaseAuthorization(): void {
    this.authorizationId = undefined;
    this.authorizationBoundAt = undefined;
    this.nativeCdpTarget = undefined;
    if (this.page && !this.ownedPages.has(this.page)) this.page = undefined;
  }

  async listTabs(): Promise<BrowserTabEntry[]> {
    if (this.nativeCdpTarget) return [{
      tabId: `external-cdp-${this.nativeCdpTarget.id}`,
      index: 0,
      title: redactSensitiveText(this.nativeCdpTarget.title),
      url: redactSensitiveText(this.nativeCdpTarget.url),
      current: true,
      ownedByCodexPro: false
    }];
    if (!this.browser || !this.isConnected()) return [];
    const pages = this.options.spaceMode === "isolated_context"
      ? this.context?.pages?.() ?? []
      : this.browser.contexts?.().flatMap((context: any) => context.pages?.() ?? []) ?? [];
    const entries: BrowserTabEntry[] = [];
    for (let index = 0; index < pages.length; index += 1) {
      const candidate = pages[index];
      const url = redactSensitiveText(String(candidate.url?.() ?? ""));
      entries.push({
        tabId: this.tabIdForPage(candidate, this.ownedPages.has(candidate)),
        index,
        title: url ? redactSensitiveText(String(await candidate.title?.().catch(() => "") ?? "")) : "",
        url,
        current: candidate === this.page,
        ownedByCodexPro: this.ownedPages.has(candidate)
      });
    }
    return entries;
  }

  async createOwnedPage(device: BrowserDevicePreset = "desktop"): Promise<BrowserTabEntry> {
    this.lastRequestedDevice = device;
    await this.ensureBrowser();
    if (this.nativeCdpTarget) {
      throw new Error("The authorized Chrome tab is using the native CDP read-only fallback. A task-owned verification tab cannot be created.");
    }
    if (this.effectiveMode === "cdp") await this.createCdpOwnedPage(device);
    else await this.recreateOwnedPage(device);
    const page = await this.requirePage();
    const url = redactSensitiveText(String(page.url?.() ?? ""));
    return {
      tabId: this.tabIdForPage(page, true),
      index: Math.max(0, (this.context?.pages?.() ?? []).indexOf(page)),
      title: url ? redactSensitiveText(String(await page.title?.().catch(() => "") ?? "")) : "",
      url,
      current: true,
      ownedByCodexPro: true
    };
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    const context = this.context;
    const external = this.effectiveMode === "cdp" || !this.ownsBrowserProcess;
    this.explicitDisconnecting = true;
    this.cdpReconnectPending = false;

    try {
      await this.closeOwnedPages();
      await this.detachCdpSessions();
      this.unbindContextPageListener();

      if (external) {
        if (this.options.spaceMode === "isolated_context") await context?.close?.().catch(() => undefined);
        await this.closeExternalTransport(browser);
      } else {
        await context?.close?.().catch(() => undefined);
        await browser?.close?.().catch(() => undefined);
      }

      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.nativeCdpTarget = undefined;
      this.activeDevice = undefined;
      this.ownsBrowserProcess = false;
      this.authorizationId = undefined;
      this.authorizationBoundAt = undefined;
      this.disconnectedAt = timestamp();
    } finally {
      this.explicitDisconnecting = false;
    }
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  private async ensurePage(device: BrowserDevicePreset): Promise<any> {
    this.lastRequestedDevice = device;
    await this.ensureBrowser();
    if (this.nativeCdpTarget) {
      throw new Error("The authorized Chrome tab is using the native CDP read-only fallback. Navigation, new pages, clicks, typing, downloads, and other page mutations are blocked.");
    }
    const pageClosed = !this.page || Boolean(this.page.isClosed?.());
    if (this.effectiveMode === "cdp") {
      if (pageClosed) await this.createCdpOwnedPage(device);
      else if (this.activeDevice !== device) {
        await this.applyCdpDevicePreset(this.page, device);
        this.activeDevice = device;
      }
    } else if (!this.context || pageClosed || this.activeDevice !== device) {
      await this.recreateOwnedPage(device);
    }
    return this.requirePage();
  }

  private async recreateOwnedPage(device: BrowserDevicePreset): Promise<void> {
    await this.context?.close?.().catch(() => undefined);
    const viewport = viewportForDevice(device);
    this.context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      ignoreHTTPSErrors: false
    });
    this.page = await this.context.newPage();
    this.activeDevice = device;
    this.ownedPages.clear();
    this.ownedPages.add(this.page);
    this.tabIdForPage(this.page, true);
    this.ownedPageLineage.add(this.page);
    await this.attachListeners(this.page);
  }

  private async createCdpOwnedPage(device: BrowserDevicePreset): Promise<void> {
    if (!this.context) throw new Error("CDP connection did not provide a persistent browser context.");
    if (this.page && this.ownedPages.has(this.page) && !this.page.isClosed?.()) {
      await this.page.close?.().catch(() => undefined);
    }
    const page = await this.context.newPage();
    this.page = page;
    this.ownedPages.add(page);
    this.tabIdForPage(page, true);
    this.ownedPageLineage.add(page);
    await this.attachListeners(page);
    await this.applyCdpDevicePreset(page, device);
    this.activeDevice = device;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectionPromise) {
      await this.connectionPromise;
      return;
    }

    this.connectionPromise = (async () => {
      await this.loadPlaywright();
      this.disconnectedAt = undefined;

      if (this.options.mode === "cdp") {
        await this.connectCdp(this.cdpReconnectPending);
        return;
      }
      await this.launchOwnedBrowser(this.options.mode);
    })();

    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  private async loadPlaywright(): Promise<void> {
    if (this.playwrightModule) return;
    try {
      this.playwrightModule = await import(PLAYWRIGHT_PACKAGE);
    } catch (error) {
      throw new Error(
        `Playwright is not installed. Add it with npm install playwright, then install the Chromium browser with npx playwright install chromium. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async launchOwnedBrowser(mode: "headless" | "headed"): Promise<void> {
    try {
      const browser = await this.playwrightModule.chromium.launch({ headless: mode === "headless" });
      this.browser = browser;
      this.context = undefined;
      this.page = undefined;
      this.activeDevice = undefined;
      this.effectiveMode = mode;
      this.ownsBrowserProcess = true;
      if (this.options.mode !== "cdp") this.isolatedProfileVerified = undefined;
      this.connectedAt = timestamp();
      this.bindBrowserDisconnect(browser);
    } catch (error) {
      throw new Error(
        `Unable to launch Playwright Chromium. Run npx playwright install chromium if browsers are missing; run npx playwright install-deps chromium if Linux shared libraries are missing. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async connectCdp(isReconnect = false): Promise<void> {
    const cdpUrl = this.options.cdpUrl?.trim();
    const profileDir = this.options.cdpProfileDir?.trim();
    if (isReconnect) {
      this.reconnectAttempts += 1;
      this.lastReconnectAt = timestamp();
    }
    if (!cdpUrl) {
      await this.failCdpConnection("CDP URL is not configured.", isReconnect);
      return;
    }
    if (!profileDir) {
      await this.failCdpConnection("CDP isolated profile directory is not configured.", isReconnect);
      return;
    }
    if (isDefaultChromeProfileDir(profileDir)) {
      await this.failCdpConnection("Configured CDP profile points to a default browser User Data directory.", isReconnect);
      return;
    }

    try {
      await this.options.ensureCdpAvailable?.();
      const browser = await this.playwrightModule.chromium.connectOverCDP(cdpUrl, {
        timeout: this.options.cdpConnectTimeoutMs
      });
      this.browser = browser;
      this.effectiveMode = "cdp";
      this.ownsBrowserProcess = false;
      this.bindBrowserDisconnect(browser);

      const verification = await this.verifyCdpProfile(browser, profileDir);
      this.isolatedProfileVerified = verification.verified;
      if (!verification.verified) throw new Error(verification.reason);

      const contexts = browser.contexts?.() ?? [];
      if (!contexts.length) throw new Error("CDP connection did not expose a persistent browser context.");
      this.cdpDownloadStagingPaths = /^[A-Za-z]:[\\/]/.test(profileDir)
        ? resolveCdpDownloadStagingPaths({
            profileDir,
            browserDownloadDir: this.options.cdpDownloadDir,
            hostDownloadDir: this.options.cdpDownloadMountDir
          })
        : undefined;
      this.context = this.options.spaceMode === "isolated_context"
        ? await browser.newContext({ ignoreHTTPSErrors: false })
        : contexts[0];
      this.bindCdpContextPages(this.context);
      this.connectedAt = timestamp();
      this.fallbackReason = undefined;
      this.cdpReconnectPending = false;
      if (isReconnect) this.reconnectFailureReason = undefined;
    } catch (error) {
      const reason = redactSensitiveText(error instanceof Error ? error.message : String(error));
      await this.failCdpConnection(`CDP connection failed: ${reason}`, isReconnect);
    }
  }

  private async failCdpConnection(reason: string, isReconnect: boolean): Promise<void> {
    const redactedReason = redactSensitiveText(reason);
    await this.cleanupFailedCdpConnection();
    this.cdpReconnectPending = false;
    if (isReconnect) this.reconnectFailureReason = redactedReason;
    if (!this.options.allowHeadlessFallback) {
      this.fallbackReason = undefined;
      this.effectiveMode = undefined;
      throw new Error(isReconnect ? `CDP reconnect failed: ${redactedReason}` : redactedReason);
    }
    if (isReconnect) {
      await this.fallbackToHeadless(`CDP reconnect failed after 1 automatic attempt: ${redactedReason}`);
      return;
    }
    await this.fallbackToHeadless(redactedReason);
  }

  private async verifyCdpProfile(browser: any, expectedProfileDir: string): Promise<{ verified: boolean; reason: string }> {
    try {
      const session = await browser.newBrowserCDPSession();
      try {
        const result = await session.send("Browser.getBrowserCommandLine");
        const args = Array.isArray(result?.arguments) ? result.arguments.map(String) : [];
        const actualProfileDir = commandLineUserDataDir(args);
        if (!actualProfileDir) return { verified: false, reason: "isolated Chrome profile verification failed: --user-data-dir was not reported" };
        if (isDefaultChromeProfileDir(actualProfileDir)) {
          return { verified: false, reason: "isolated Chrome profile verification failed: Chrome is using a default User Data directory" };
        }
        if (normalizeWindowsPath(actualProfileDir) !== normalizeWindowsPath(expectedProfileDir)) {
          return { verified: false, reason: "isolated Chrome profile verification failed: configured and actual user-data-dir values differ" };
        }
        return { verified: true, reason: "" };
      } finally {
        await session.detach?.().catch(() => undefined);
      }
    } catch (error) {
      const rawReason = error instanceof Error ? error.message : String(error);
      const redactedReason = redactSensitiveText(rawReason);
      const commandLineUnavailableWithoutAutomation = /command line not returned because --enable-automation not set/i.test(rawReason);
      if (commandLineUnavailableWithoutAutomation && !isDefaultChromeProfileDir(expectedProfileDir) && Boolean(this.options.cdpUrl)) {
        return {
          verified: true,
          reason: "isolated Chrome profile accepted from validated dedicated CDP configuration because Chrome command-line inspection is unavailable without the automation flag"
        };
      }
      return {
        verified: false,
        reason: `isolated Chrome profile verification failed: ${redactedReason}`
      };
    }
  }

  private async fallbackToHeadless(reason: string): Promise<void> {
    this.fallbackReason = redactSensitiveText(reason);
    this.isolatedProfileVerified = false;
    await this.launchOwnedBrowser("headless");
  }

  private bindBrowserDisconnect(browser: any): void {
    browser.on?.("disconnected", () => {
      if (this.browser !== browser) return;
      const disconnectedMode = this.effectiveMode;
      const disconnectedContext = this.context;
      const pageListener = this.contextPageListener;
      if (disconnectedContext && pageListener) {
        disconnectedContext.off?.("page", pageListener);
        disconnectedContext.removeListener?.("page", pageListener);
      }
      this.contextPageListener = undefined;
      const sessions = [...this.cdpSessions.values()];
      this.cdpSessions.clear();
      for (const session of sessions) void session.detach?.().catch(() => undefined);
      this.ownedPages.clear();
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.nativeCdpTarget = undefined;
      this.activeDevice = undefined;
      this.ownsBrowserProcess = false;
      this.authorizationId = undefined;
      this.authorizationBoundAt = undefined;
      this.disconnectedAt = timestamp();
      this.cdpReconnectPending = !this.explicitDisconnecting && this.options.mode === "cdp" && disconnectedMode === "cdp";
    });
  }

  private bindCdpContextPages(context: any): void {
    this.unbindContextPageListener();
    this.contextPageListener = (candidate: any) => {
      Promise.resolve(candidate.opener?.())
        .then(async (opener) => {
          if (!opener || !this.ownedPageLineage.has(opener)) return;
          this.ownedPages.add(candidate);
          this.tabIdForPage(candidate, true);
          this.ownedPageLineage.add(candidate);
          await this.attachListeners(candidate);
          candidate.on?.("close", () => this.ownedPages.delete(candidate));
        })
        .catch(() => undefined);
    };
    context.on?.("page", this.contextPageListener);
  }

  private unbindContextPageListener(): void {
    if (this.context && this.contextPageListener) {
      this.context.off?.("page", this.contextPageListener);
      this.context.removeListener?.("page", this.contextPageListener);
    }
    this.contextPageListener = undefined;
  }

  private async applyCdpDevicePreset(page: any, device: BrowserDevicePreset): Promise<void> {
    if (!this.context?.newCDPSession) return;
    let session = this.cdpSessions.get(page);
    if (!session) {
      session = await this.context.newCDPSession(page);
      this.cdpSessions.set(page, session);
      page.on?.("close", () => {
        const existing = this.cdpSessions.get(page);
        this.cdpSessions.delete(page);
        existing?.detach?.().catch(() => undefined);
        this.ownedPages.delete(page);
        if (this.page === page) {
          this.page = undefined;
          this.authorizationId = undefined;
          this.authorizationBoundAt = undefined;
        }
      });
    }
    if (device === "mobile") {
      const viewport = viewportForDevice("mobile");
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 2,
        mobile: true,
        screenWidth: viewport.width,
        screenHeight: viewport.height
      });
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      return;
    }
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
  }

  private async cleanupFailedCdpConnection(): Promise<void> {
    const browser = this.browser;
    await this.closeOwnedPages();
    await this.detachCdpSessions();
    this.unbindContextPageListener();
    await this.closeExternalTransport(browser);
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.nativeCdpTarget = undefined;
    this.activeDevice = undefined;
    this.ownsBrowserProcess = false;
    this.authorizationId = undefined;
    this.authorizationBoundAt = undefined;
  }

  private async closeOwnedPages(): Promise<void> {
    const pages = [...this.ownedPages];
    this.ownedPages.clear();
    for (const page of pages) {
      if (!page?.isClosed?.()) await page.close?.().catch(() => undefined);
    }
  }

  private async detachCdpSessions(): Promise<void> {
    const sessions = [...this.cdpSessions.values()];
    this.cdpSessions.clear();
    for (const session of sessions) await session.detach?.().catch(() => undefined);
  }

  private async closeExternalTransport(browser: any): Promise<void> {
    if (!browser) return;
    // Playwright connect/connectOverCDP handles must be closed through the public
    // Browser API. Closing the private shared connection poisons the in-process
    // Playwright driver and makes every later CDP reconnect fail until restart.
    if (typeof browser.close === "function") {
      await browser.close().catch(() => undefined);
    }
  }

  private isConnected(): boolean {
    if (!this.browser) return false;
    if (typeof this.browser.isConnected === "function") return Boolean(this.browser.isConnected());
    return true;
  }

  private countTabs(): number {
    if (!this.browser || !this.isConnected()) return 0;
    try {
      if (this.options.spaceMode === "isolated_context") return this.context?.pages?.()?.length ?? 0;
      return (this.browser.contexts?.() ?? []).reduce((total: number, context: any) => total + (context.pages?.()?.length ?? 0), 0);
    } catch {
      return 0;
    }
  }

  private tabIdForPage(page: object, owned = false): string {
    const existing = this.pageTabIds.get(page);
    if (existing) return existing;
    const id = `${owned ? "tab" : "external"}-${randomUUID()}`;
    this.pageTabIds.set(page, id);
    return id;
  }

  private async requirePage(): Promise<any> {
    if (this.nativeCdpTarget) {
      throw new Error("The authorized Chrome tab is using the native CDP read-only fallback. Navigation, clicks, typing, downloads, and other page mutations are blocked.");
    }
    if (!this.isConnected() && this.options.mode === "cdp" && this.effectiveMode === "cdp" && !this.explicitDisconnecting) {
      this.cdpReconnectPending = true;
      await this.ensurePage(this.lastRequestedDevice);
    }
    if (!this.page || this.page.isClosed?.()) {
      throw new Error("No browser page is open yet. Call browser_open first.");
    }
    return this.page;
  }

  private targetSelector(target: string): string {
    return /^e\d+$/.test(target) ? `[data-codexpro-ref="${target}"]` : target;
  }

  private urlsEquivalent(current: string, requested: string): boolean {
    try {
      const a = new URL(current);
      const b = new URL(requested);
      a.hash = "";
      b.hash = "";
      return a.toString() === b.toString();
    } catch {
      return current === requested;
    }
  }

  private async describeLocator(page: any, selector: string, timeoutMs: number): Promise<BrowserElementSummary> {
    const resolvedSelector = this.targetSelector(selector);
    const locator = page.locator(resolvedSelector).first();
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
    const [text, tagName, explicitRole, ariaLabel, title, type, name, id, href, placeholder, disabled, visible, ref, container] = await Promise.all([
      locator.textContent({ timeout: 1000 }).catch(() => ""),
      locator.evaluate((element: any) => element.tagName?.toLowerCase?.() ?? "").catch(() => ""),
      locator.getAttribute("role").catch(() => null),
      locator.getAttribute("aria-label").catch(() => null),
      locator.getAttribute("title").catch(() => null),
      locator.getAttribute("type").catch(() => null),
      locator.getAttribute("name").catch(() => null),
      locator.getAttribute("id").catch(() => null),
      locator.getAttribute("href").catch(() => null),
      locator.getAttribute("placeholder").catch(() => null),
      locator.isDisabled().catch(() => false),
      locator.isVisible().catch(() => false),
      locator.getAttribute("data-codexpro-ref").catch(() => null),
      locator.evaluate((element: any) => {
        const owner = element.closest?.("[role='dialog'],[role='tooltip'],[role='menu'],[aria-modal='true'],form");
        if (!owner || owner === element) return null;
        const clean = (value: unknown, limit = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
        const tag = String(owner.tagName ?? "").toLowerCase();
        const role = clean(owner.getAttribute?.("role") || (tag === "form" ? "form" : ""), 80) || undefined;
        return {
          ref: clean(owner.getAttribute?.("data-codexpro-ref"), 80) || undefined,
          role,
          text: clean(owner.innerText || owner.textContent, 500) || undefined
        };
      }).catch(() => null)
    ]);
    const compactText = normalizedIdentityText(text).slice(0, 500);
    const effectiveRole = inferredElementRole(String(tagName || ""), explicitRole ?? undefined) || undefined;
    const accessibleName = normalizedIdentityText(ariaLabel || title || placeholder || compactText).slice(0, 500) || undefined;
    const clickable = ["button", "link"].includes(effectiveRole ?? "") || ["button", "a"].includes(String(tagName || "").toLowerCase());
    return {
      ref: ref ?? undefined,
      selector: resolvedSelector,
      text: compactText,
      tagName: String(tagName || "") || undefined,
      role: effectiveRole,
      ariaLabel: ariaLabel ?? undefined,
      accessibleName,
      type: type ?? undefined,
      name: name ?? undefined,
      id: id ?? undefined,
      href: href ? redactSensitiveText(String(href)) : undefined,
      placeholder: placeholder ?? undefined,
      disabled: Boolean(disabled),
      visible: Boolean(visible),
      clickable,
      containerRef: container?.ref,
      containerRole: container?.role,
      containerText: container?.text
    };
  }

  private assertDownloadElementIdentity(actual: BrowserElementSummary, expected: BrowserDownloadElementFingerprint): void {
    const mismatches: string[] = [];
    if (actual.selector !== expected.selector) mismatches.push(`selector expected ${expected.selector} got ${actual.selector}`);
    if (actual.ref !== expected.ref) mismatches.push(`ref expected ${expected.ref} got ${actual.ref ?? ""}`);
    if (normalizedIdentityText(actual.tagName).toLowerCase() !== normalizedIdentityText(expected.tagName).toLowerCase()) mismatches.push(`tagName expected ${expected.tagName} got ${actual.tagName ?? ""}`);
    if (normalizedIdentityText(actual.role).toLowerCase() !== normalizedIdentityText(expected.role).toLowerCase()) mismatches.push(`role expected ${expected.role} got ${actual.role ?? ""}`);
    if (expected.name && normalizedIdentityText(actual.accessibleName) !== normalizedIdentityText(expected.name)) mismatches.push(`name expected ${expected.name} got ${actual.accessibleName ?? ""}`);
    if (expected.text && normalizedIdentityText(actual.text) !== normalizedIdentityText(expected.text)) mismatches.push(`text expected ${expected.text} got ${actual.text ?? ""}`);
    if (expected.hrefAbsent && actual.href) mismatches.push(`href must be absent but got ${actual.href}`);
    if (actual.disabled) mismatches.push("element is disabled");
    if (!actual.visible) mismatches.push("element is not visible");
    if (!actual.clickable) mismatches.push("element is not clickable");
    if (expected.containerRef && actual.containerRef !== expected.containerRef) mismatches.push(`containerRef expected ${expected.containerRef} got ${actual.containerRef ?? ""}`);
    if (expected.containerRole && normalizedIdentityText(actual.containerRole).toLowerCase() !== normalizedIdentityText(expected.containerRole).toLowerCase()) mismatches.push(`containerRole expected ${expected.containerRole} got ${actual.containerRole ?? ""}`);
    if (expected.containerTextContains && !normalizedIdentityText(actual.containerText).includes(normalizedIdentityText(expected.containerTextContains))) mismatches.push(`container text no longer contains ${expected.containerTextContains}`);
    if (mismatches.length) {
      throw new Error(`browser_download element identity mismatch; click blocked: ${mismatches.join("; ")}.`);
    }
  }

  private async attachCdpMainFrameNavigationGuard(page: any): Promise<boolean> {
    const assertAllowed = this.options.assertMainFrameNavigationAllowed;
    if (!assertAllowed || !this.context?.newCDPSession) return false;

    let session = this.cdpSessions.get(page);
    let createdSession = false;
    if (!session) {
      session = await this.context.newCDPSession(page);
      this.cdpSessions.set(page, session);
      createdSession = true;
      page.on?.("close", () => {
        const existing = this.cdpSessions.get(page);
        if (existing !== session) return;
        this.cdpSessions.delete(page);
        existing?.detach?.().catch(() => undefined);
      });
    }

    const frameTree = await session.send("Page.getFrameTree");
    const mainFrameId = String(frameTree?.frameTree?.frame?.id ?? "").trim();
    if (!mainFrameId) {
      if (createdSession) {
        this.cdpSessions.delete(page);
        await session.detach?.().catch(() => undefined);
      }
      return false;
    }

    const onRequestPaused = (event: any) => {
      void (async () => {
        const requestId = String(event?.requestId ?? "");
        if (!requestId) return;
        const isMainDocument = event?.resourceType === "Document" && String(event?.frameId ?? "") === mainFrameId;
        if (!isMainDocument) {
          await session.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
          return;
        }
        try {
          await assertAllowed(String(event?.request?.url ?? ""));
          await session.send("Fetch.continueRequest", { requestId });
        } catch {
          await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
        }
      })();
    };

    session.on("Fetch.requestPaused", onRequestPaused);
    try {
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }]
      });
      return true;
    } catch {
      session.off?.("Fetch.requestPaused", onRequestPaused);
      session.removeListener?.("Fetch.requestPaused", onRequestPaused);
      if (createdSession) {
        this.cdpSessions.delete(page);
        await session.detach?.().catch(() => undefined);
      }
      return false;
    }
  }

  private async attachListeners(page: any): Promise<void> {
    if (!page || (typeof page === "object" && this.listeningPages.has(page))) return;
    if (typeof page === "object") this.listeningPages.add(page);
    const cdpNavigationGuardAttached = await this.attachCdpMainFrameNavigationGuard(page).catch(() => false);
    if (!cdpNavigationGuardAttached && this.options.assertMainFrameNavigationAllowed && typeof page.route === "function") {
      await page.route("**/*", async (route: any) => {
        const request = route.request?.();
        const frame = request?.frame?.();
        const mainFrame = page.mainFrame?.();
        const isMainFrame = Boolean(frame) && (frame === mainFrame || frame?.parentFrame?.() === null);
        const isDocumentRequest = request?.resourceType?.() === "document";
        const isMainFrameNavigation = isMainFrame && (Boolean(request?.isNavigationRequest?.()) || isDocumentRequest);
        if (!isMainFrameNavigation) {
          await route.continue();
          return;
        }
        try {
          await this.options.assertMainFrameNavigationAllowed?.(String(request.url?.() ?? ""));
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }
    page.on("console", (message: any) => {
      const location = message.location?.();
      this.events.onConsole({
        timestamp: timestamp(),
        type: String(message.type?.() ?? "unknown"),
        text: redactSensitiveText(String(message.text?.() ?? "")),
        location: location
          ? {
              ...location,
              url: location.url ? redactSensitiveText(String(location.url)) : undefined
            }
          : undefined
      });
    });
    page.on("requestfailed", (request: any) => {
      const resourceType = String(request.resourceType?.() ?? "");
      const failure = String(request.failure?.()?.errorText ?? "request failed");
      if (resourceType === "document" && failure === "net::ERR_ABORTED") return;
      this.events.onNetwork({
        timestamp: timestamp(),
        kind: "requestfailed",
        url: redactSensitiveText(String(request.url?.() ?? "")),
        method: String(request.method?.() ?? "GET"),
        resourceType,
        failure: redactSensitiveText(failure)
      });
    });
    page.on("response", (response: any) => {
      const status = Number(response.status?.() ?? 0);
      if (status < 400) return;
      const request = response.request?.();
      this.events.onNetwork({
        timestamp: timestamp(),
        kind: "http-error",
        url: redactSensitiveText(String(response.url?.() ?? "")),
        method: String(request?.method?.() ?? "GET"),
        resourceType: String(request?.resourceType?.() ?? ""),
        status,
        statusText: redactSensitiveText(String(response.statusText?.() ?? ""))
      });
    });
  }

  private async readText(page: any, selector?: string): Promise<string> {
    if (selector?.trim()) {
      const locator = page.locator(this.targetSelector(selector.trim())).first();
      return String(await locator.textContent({ timeout: 1000 }).catch(() => ""));
    }
    return String(await page.locator("body").textContent({ timeout: 1000 }).catch(() => ""));
  }
}
