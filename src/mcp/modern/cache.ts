import { createHash } from "node:crypto";
import type { McpCacheScope } from "./requestContext.js";

export interface ModernMcpCachePolicy {
  ttlMs: number;
  cacheScope: McpCacheScope;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class ModernMcpResponseCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maxEntries = 256) {}

  key(parts: unknown[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function cachePolicyForModernMethod(method: string, readOnly = false): ModernMcpCachePolicy {
  if (method === "server/discover") return { ttlMs: 5_000, cacheScope: "public" };
  if (method === "tools/list" || method === "apps/list") return { ttlMs: 2_000, cacheScope: "client" };
  if (readOnly) return { ttlMs: 500, cacheScope: "workspace" };
  return { ttlMs: 0, cacheScope: "private" };
}

export function withCacheMetadata<T extends Record<string, unknown>>(value: T, policy: ModernMcpCachePolicy): T & {
  ttlMs: number;
  cacheScope: McpCacheScope;
} {
  return { ...value, ttlMs: policy.ttlMs, cacheScope: policy.cacheScope };
}
