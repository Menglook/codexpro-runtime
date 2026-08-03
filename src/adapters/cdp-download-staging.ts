import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface CdpDownloadStagingPaths {
  browserBaseDir: string;
  hostBaseDir: string;
  crossOs: boolean;
}

export interface CdpDownloadStagingAttempt {
  browserDir: string;
  hostDir: string;
}

export interface StagedDownloadFile {
  absPath: string;
  filename: string;
  bytes: number;
}

export interface CdpBrowserDownloadWillBeginEvent {
  frameId?: string;
  guid?: string;
  url?: string;
  suggestedFilename?: string;
}

export interface CdpBrowserDownloadProgressEvent {
  guid?: string;
  totalBytes?: number;
  receivedBytes?: number;
  state?: "inProgress" | "completed" | "canceled";
  filePath?: string;
}

export interface CdpBrowserDownloadTerminalEvent {
  guid: string;
  state: "completed" | "canceled";
  frameId: string;
  url?: string;
  suggestedFilename?: string;
  totalBytes?: number;
  receivedBytes?: number;
  filePath?: string;
}

export class CdpBrowserDownloadTracker {
  private armed = false;
  private guid: string | undefined;
  private beginEvent: Required<Pick<CdpBrowserDownloadWillBeginEvent, "frameId" | "guid">> & CdpBrowserDownloadWillBeginEvent | undefined;
  private terminalEvent: CdpBrowserDownloadTerminalEvent | undefined;
  private readonly terminalPromise: Promise<CdpBrowserDownloadTerminalEvent>;
  private resolveTerminal!: (event: CdpBrowserDownloadTerminalEvent) => void;

  constructor(private readonly expectedFrameId: string) {
    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  arm(): void {
    this.armed = true;
  }

  onWillBegin(event: CdpBrowserDownloadWillBeginEvent): boolean {
    if (!this.armed || this.guid) return false;
    const frameId = String(event.frameId ?? "").trim();
    const guid = String(event.guid ?? "").trim();
    if (!frameId || frameId !== this.expectedFrameId || !guid) return false;
    this.guid = guid;
    this.beginEvent = {
      ...event,
      frameId,
      guid,
      url: String(event.url ?? "").trim() || undefined,
      suggestedFilename: String(event.suggestedFilename ?? "").trim() || undefined
    };
    return true;
  }

  onProgress(event: CdpBrowserDownloadProgressEvent): boolean {
    if (!this.beginEvent || String(event.guid ?? "").trim() !== this.guid) return false;
    if (event.state !== "completed" && event.state !== "canceled") return false;
    if (!this.terminalEvent) {
      this.terminalEvent = {
        guid: this.beginEvent.guid,
        state: event.state,
        frameId: this.beginEvent.frameId,
        url: this.beginEvent.url,
        suggestedFilename: this.beginEvent.suggestedFilename,
        totalBytes: Number.isFinite(event.totalBytes) ? Number(event.totalBytes) : undefined,
        receivedBytes: Number.isFinite(event.receivedBytes) ? Number(event.receivedBytes) : undefined,
        filePath: String(event.filePath ?? "").trim() || undefined
      };
      this.resolveTerminal(this.terminalEvent);
    }
    return true;
  }

  async waitForTerminal(timeoutMs: number): Promise<CdpBrowserDownloadTerminalEvent> {
    if (this.terminalEvent) return this.terminalEvent;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.terminalPromise,
        new Promise<CdpBrowserDownloadTerminalEvent>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out waiting for browser-level CDP download events after ${timeoutMs} ms.`)), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const PLAYWRIGHT_TEMP_PATTERN = /(?:^|[\\/])tmp[\\/]playwright-artifacts-|playwright-artifacts-/i;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;

function normalizedWindowsPath(value: string): string {
  return path.win32.normalize(String(value ?? "").trim().replaceAll("/", "\\"));
}

export function assertSafeWindowsBrowserDownloadPath(value: string): string {
  const normalized = normalizedWindowsPath(value);
  if (!WINDOWS_ABSOLUTE_PATTERN.test(normalized)) {
    throw new Error(`Windows Chrome download directory must be an absolute Windows path; got ${value}.`);
  }
  if (PLAYWRIGHT_TEMP_PATTERN.test(normalized) || normalized.startsWith("\\tmp\\")) {
    throw new Error(`Windows Chrome download directory must not use a WSL/Linux Playwright temporary path: ${value}.`);
  }
  return normalized;
}

export function windowsPathToWslMount(value: string, mountRoot = "/mnt"): string {
  const normalized = assertSafeWindowsBrowserDownloadPath(value);
  const match = /^([a-zA-Z]):\\(.*)$/.exec(normalized);
  if (!match) throw new Error(`Unable to map Windows download directory into WSL: ${value}.`);
  const drive = match[1].toLowerCase();
  const segments = match[2].split("\\").filter(Boolean);
  return path.posix.join(mountRoot, drive, ...segments);
}

export function resolveCdpDownloadStagingPaths(input: {
  profileDir: string;
  browserDownloadDir?: string;
  hostDownloadDir?: string;
  platform?: NodeJS.Platform;
}): CdpDownloadStagingPaths {
  const profileDir = assertSafeWindowsBrowserDownloadPath(input.profileDir);
  const browserBaseDir = assertSafeWindowsBrowserDownloadPath(
    input.browserDownloadDir?.trim() || path.win32.join(path.win32.dirname(profileDir), "BrowserDownloads")
  );
  const platform = input.platform ?? process.platform;
  const crossOs = platform === "linux";
  const hostBaseDir = input.hostDownloadDir?.trim()
    ? path.resolve(input.hostDownloadDir.trim())
    : crossOs
      ? windowsPathToWslMount(browserBaseDir)
      : browserBaseDir;
  if (!path.isAbsolute(hostBaseDir) && platform !== "win32") {
    throw new Error(`CodexPro download staging mount must be absolute; got ${hostBaseDir}.`);
  }
  if (PLAYWRIGHT_TEMP_PATTERN.test(hostBaseDir)) {
    throw new Error(`CodexPro download staging mount must not use Playwright temporary artifacts: ${hostBaseDir}.`);
  }
  return { browserBaseDir, hostBaseDir, crossOs };
}

export async function createCdpDownloadStagingAttempt(paths: CdpDownloadStagingPaths): Promise<CdpDownloadStagingAttempt> {
  const attemptId = `download-${Date.now()}-${randomUUID()}`;
  const browserDir = assertSafeWindowsBrowserDownloadPath(path.win32.join(paths.browserBaseDir, attemptId));
  const hostDir = path.join(paths.hostBaseDir, attemptId);
  await fsp.mkdir(hostDir, { recursive: true });
  return { browserDir, hostDir };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForStagedDownloadFile(input: {
  hostDir: string;
  suggestedFilename?: string;
  timeoutMs: number;
  pollMs?: number;
}): Promise<StagedDownloadFile> {
  const started = Date.now();
  const pollMs = Math.max(50, Math.min(input.pollMs ?? 100, 1000));
  const expected = input.suggestedFilename ? path.basename(input.suggestedFilename) : undefined;
  let lastPath = "";
  let lastSize = -1;
  let stableChecks = 0;
  while (Date.now() - started <= input.timeoutMs) {
    const entries = await fsp.readdir(input.hostDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const completed = entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".crdownload") && !entry.name.endsWith(".tmp"))
      .map((entry) => entry.name);
    let filename: string | undefined;
    if (expected && completed.includes(expected)) filename = expected;
    else if (completed.length === 1) filename = completed[0];
    else if (completed.length > 1) {
      throw new Error(`CDP download staging directory contains multiple completed files; refusing ambiguous pickup: ${completed.join(", ")}.`);
    }
    if (filename) {
      const absPath = path.join(input.hostDir, filename);
      const stat = await fsp.stat(absPath);
      if (stat.isFile() && stat.size > 0) {
        if (lastPath === absPath && lastSize === stat.size) stableChecks += 1;
        else stableChecks = 0;
        lastPath = absPath;
        lastSize = stat.size;
        if (stableChecks >= 1) return { absPath, filename, bytes: stat.size };
      }
    }
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for Windows Chrome download staging file in ${input.hostDir}.`);
}

export async function cleanupCdpDownloadStagingAttempt(attempt: CdpDownloadStagingAttempt): Promise<void> {
  await fsp.rm(attempt.hostDir, { recursive: true, force: true });
}
