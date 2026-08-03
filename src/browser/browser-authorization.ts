import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeDir } from "../profileStore.js";
import { redactSensitiveText } from "../redact.js";

export interface BrowserTabAuthorizationInput {
  challenge: string;
  authorizationId: string;
  browserInstanceId: string;
  tabId: number;
  windowId: number;
  url: string;
  title?: string;
  extensionId?: string;
  extensionVersion?: string;
  extensionProtocolVersion?: string;
}

export interface BrowserTabAuthorization {
  authorizationId: string;
  browserInstanceId: string;
  tabId: number;
  windowId: number;
  url: string;
  origin: string;
  title?: string;
  extensionId?: string;
  extensionVersion?: string;
  extensionProtocolVersion?: string;
  createdAt: string;
  expiresAt: string;
}

interface BrowserAuthorizationChallenge {
  value: string;
  expiresAtMs: number;
}

interface PersistedBrowserAuthorizations {
  version: 1;
  updatedAt: string;
  authorizations: BrowserTabAuthorization[];
}

function timestamp(): string {
  return new Date().toISOString();
}

function normalizeAuthorizationId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(normalized)) {
    throw new Error("Invalid browser authorization id.");
  }
  return normalized;
}

function normalizeInstanceId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(normalized)) {
    throw new Error("Invalid browser instance id.");
  }
  return normalized;
}

function safePageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https tabs can be authorized.");
  }
  if (url.username || url.password) throw new Error("Credentialed tab URLs cannot be authorized.");
  return url;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return redactSensitiveText(String(value)).slice(0, maxLength);
}

function restoreAuthorization(value: unknown): BrowserTabAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<BrowserTabAuthorization>;
  try {
    const authorizationId = normalizeAuthorizationId(String(input.authorizationId ?? ""));
    const browserInstanceId = normalizeInstanceId(String(input.browserInstanceId ?? ""));
    const tabId = Number(input.tabId);
    const windowId = Number(input.windowId);
    if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(windowId) || windowId < 0) return undefined;
    const originUrl = safePageUrl(String(input.origin ?? ""));
    if (originUrl.origin !== String(input.origin)) return undefined;
    const expiresAtMs = Date.parse(String(input.expiresAt ?? ""));
    const createdAtMs = Date.parse(String(input.createdAt ?? ""));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || !Number.isFinite(createdAtMs)) return undefined;
    const rawUrl = String(input.url || input.origin || "");
    const pageUrl = safePageUrl(rawUrl);
    if (pageUrl.origin !== originUrl.origin) return undefined;
    return {
      authorizationId,
      browserInstanceId,
      tabId,
      windowId,
      url: redactSensitiveText(pageUrl.toString()),
      origin: originUrl.origin,
      title: optionalText(input.title, 300),
      extensionId: optionalText(input.extensionId, 128),
      extensionVersion: optionalText(input.extensionVersion, 64),
      extensionProtocolVersion: optionalText(input.extensionProtocolVersion, 64),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  } catch {
    return undefined;
  }
}

export class BrowserAuthorizationStore {
  private readonly authorizations = new Map<string, BrowserTabAuthorization>();
  private readonly challenges = new Map<string, BrowserAuthorizationChallenge>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly challengeTtlMs = 60_000,
    private readonly persistencePath?: string
  ) {
    this.loadPersisted();
  }

  createChallenge(browserInstanceId: string): { challenge: string; expiresAt: string } {
    this.prune();
    const instanceId = normalizeInstanceId(browserInstanceId);
    const challenge = randomUUID();
    const expiresAtMs = Date.now() + this.challengeTtlMs;
    this.challenges.set(instanceId, { value: challenge, expiresAtMs });
    return { challenge, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  authorize(input: BrowserTabAuthorizationInput): BrowserTabAuthorization {
    this.prune();
    const browserInstanceId = normalizeInstanceId(input.browserInstanceId);
    const challenge = this.challenges.get(browserInstanceId);
    if (!challenge || challenge.expiresAtMs < Date.now() || challenge.value !== input.challenge) {
      throw new Error("Browser extension authorization challenge is missing, expired, or invalid.");
    }
    this.challenges.delete(browserInstanceId);
    const url = safePageUrl(input.url);
    const createdAt = timestamp();
    const authorization: BrowserTabAuthorization = {
      authorizationId: normalizeAuthorizationId(input.authorizationId),
      browserInstanceId,
      tabId: Number(input.tabId),
      windowId: Number(input.windowId),
      url: redactSensitiveText(url.toString()),
      origin: url.origin,
      title: optionalText(input.title, 300),
      extensionId: optionalText(input.extensionId, 128),
      extensionVersion: optionalText(input.extensionVersion, 64),
      extensionProtocolVersion: optionalText(input.extensionProtocolVersion, 64),
      createdAt,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString()
    };
    if (!Number.isInteger(authorization.tabId) || authorization.tabId < 0) throw new Error("Invalid Chrome tab id.");
    if (!Number.isInteger(authorization.windowId) || authorization.windowId < 0) throw new Error("Invalid Chrome window id.");
    this.authorizations.set(authorization.authorizationId, authorization);
    this.persist();
    return { ...authorization };
  }

  get(authorizationId: string): BrowserTabAuthorization | undefined {
    this.prune();
    const authorization = this.authorizations.get(String(authorizationId ?? "").trim());
    return authorization ? { ...authorization } : undefined;
  }

  latest(): BrowserTabAuthorization | undefined {
    this.prune();
    const latest = [...this.authorizations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? { ...latest } : undefined;
  }

  list(): BrowserTabAuthorization[] {
    this.prune();
    return [...this.authorizations.values()].map((authorization) => ({ ...authorization }));
  }

  release(authorizationId: string): boolean {
    const released = this.authorizations.delete(String(authorizationId ?? "").trim());
    if (released) this.persist();
    return released;
  }

  releaseInstance(browserInstanceId: string): number {
    const instanceId = String(browserInstanceId ?? "").trim();
    let count = 0;
    for (const [authorizationId, authorization] of this.authorizations) {
      if (authorization.browserInstanceId !== instanceId) continue;
      this.authorizations.delete(authorizationId);
      count += 1;
    }
    if (count) this.persist();
    return count;
  }

  private loadPersisted(): void {
    if (!this.persistencePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistencePath, "utf8")) as Partial<PersistedBrowserAuthorizations>;
      if (raw.version !== 1 || !Array.isArray(raw.authorizations)) return;
      for (const value of raw.authorizations) {
        const authorization = restoreAuthorization(value);
        if (authorization) this.authorizations.set(authorization.authorizationId, authorization);
      }
      this.persist();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      // Corrupt or unreadable runtime state must never prevent CodexPro startup.
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const payload: PersistedBrowserAuthorizations = {
        version: 1,
        updatedAt: timestamp(),
        authorizations: [...this.authorizations.values()].map((authorization) => ({
          ...authorization,
          url: authorization.origin,
          title: undefined
        }))
      };
      const temporaryPath = `${this.persistencePath}.tmp-${process.pid}-${randomUUID()}`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.persistencePath);
      fs.chmodSync(this.persistencePath, 0o600);
    } catch {
      // Persistence is a restart-recovery aid. The active in-memory lease remains valid
      // even if the runtime directory is temporarily unavailable.
    }
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [instanceId, challenge] of this.challenges) {
      if (challenge.expiresAtMs <= now) this.challenges.delete(instanceId);
    }
    for (const [authorizationId, authorization] of this.authorizations) {
      if (Date.parse(authorization.expiresAt) <= now) {
        this.authorizations.delete(authorizationId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

export const browserAuthorizationStore = new BrowserAuthorizationStore(
  30 * 60_000,
  60_000,
  path.join(runtimeDir(), "browser-authorizations.json")
);
