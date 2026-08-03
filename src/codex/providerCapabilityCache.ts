import type { CodexProviderId } from "./types.js";

export interface CacheableProviderCapability {
  provider: CodexProviderId;
  available: boolean;
  authenticated: boolean;
}

export interface ProviderCapabilityCacheOptions {
  enabled?: boolean;
  available_ttl_ms?: number;
  unavailable_ttl_ms?: number;
  now?: () => number;
}

export interface ProviderCapabilityLookup<T extends CacheableProviderCapability> {
  record: T;
  cache_hit: boolean;
  cache_age_ms: number;
  cache_generation: number;
  probe_reason: string;
  probe_ms: number;
  in_flight_deduplicated: boolean;
}

export interface ProviderCapabilityCacheSnapshot {
  enabled: boolean;
  entries: Array<{
    provider: CodexProviderId;
    checked_at_ms: number;
    expires_at_ms: number;
    cache_age_ms: number;
    cache_generation: number;
    available: boolean;
    authenticated: boolean;
  }>;
  hits: number;
  misses: number;
  probes: number;
  invalidations: number;
  in_flight_deduplicated: number;
}

interface CacheEntry<T extends CacheableProviderCapability> {
  record: T;
  checked_at_ms: number;
  expires_at_ms: number;
  generation: number;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

export class ProviderCapabilityCache<T extends CacheableProviderCapability> {
  private readonly enabled: boolean;
  private readonly availableTtlMs: number;
  private readonly unavailableTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<CodexProviderId, CacheEntry<T>>();
  private readonly inflight = new Map<CodexProviderId, Promise<ProviderCapabilityLookup<T>>>();
  private readonly generations = new Map<CodexProviderId, number>();
  private hits = 0;
  private misses = 0;
  private probes = 0;
  private invalidations = 0;
  private inflightDeduplicated = 0;

  constructor(options: ProviderCapabilityCacheOptions = {}) {
    this.enabled = options.enabled !== false;
    this.availableTtlMs = positiveMs(options.available_ttl_ms, 60_000);
    this.unavailableTtlMs = positiveMs(options.unavailable_ttl_ms, 10_000);
    this.now = options.now ?? (() => Date.now());
  }

  async get(
    provider: CodexProviderId,
    probe: () => Promise<T>,
    probeReason = "selection"
  ): Promise<ProviderCapabilityLookup<T>> {
    const now = this.now();
    const cached = this.entries.get(provider);
    if (this.enabled && cached && cached.expires_at_ms > now) {
      this.hits += 1;
      return {
        record: structuredClone(cached.record),
        cache_hit: true,
        cache_age_ms: Math.max(0, now - cached.checked_at_ms),
        cache_generation: cached.generation,
        probe_reason: probeReason,
        probe_ms: 0,
        in_flight_deduplicated: false
      };
    }

    if (this.enabled) {
      const pending = this.inflight.get(provider);
      if (pending) {
        this.inflightDeduplicated += 1;
        const result = await pending;
        return { ...structuredClone(result), in_flight_deduplicated: true };
      }
    }

    this.misses += 1;
    const generation = this.generations.get(provider) ?? 0;
    const executeProbe = async (): Promise<ProviderCapabilityLookup<T>> => {
      const started = performance.now();
      this.probes += 1;
      const record = await probe();
      const checkedAt = this.now();
      const ttl = record.available && record.authenticated ? this.availableTtlMs : this.unavailableTtlMs;
      if (this.enabled) {
        this.entries.set(provider, {
          record: structuredClone(record),
          checked_at_ms: checkedAt,
          expires_at_ms: checkedAt + ttl,
          generation
        });
      }
      return {
        record: structuredClone(record),
        cache_hit: false,
        cache_age_ms: 0,
        cache_generation: generation,
        probe_reason: probeReason,
        probe_ms: Math.max(0, performance.now() - started),
        in_flight_deduplicated: false
      };
    };

    const promise = executeProbe();
    if (this.enabled) this.inflight.set(provider, promise);
    try {
      return await promise;
    } finally {
      if (this.enabled && this.inflight.get(provider) === promise) this.inflight.delete(provider);
    }
  }

  invalidate(provider: CodexProviderId): void {
    this.entries.delete(provider);
    this.inflight.delete(provider);
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.invalidations += 1;
  }

  invalidateAll(): void {
    for (const provider of new Set([...this.entries.keys(), ...this.inflight.keys(), ...this.generations.keys()])) {
      this.invalidate(provider);
    }
  }

  async warm(
    probes: Array<{ provider: CodexProviderId; probe: () => Promise<T> }>,
    probeReason = "startup_warmup"
  ): Promise<ProviderCapabilityLookup<T>[]> {
    return await Promise.all(probes.map(({ provider, probe }) => this.get(provider, probe, probeReason)));
  }

  snapshot(): ProviderCapabilityCacheSnapshot {
    const now = this.now();
    return {
      enabled: this.enabled,
      entries: [...this.entries.entries()].map(([provider, entry]) => ({
        provider,
        checked_at_ms: entry.checked_at_ms,
        expires_at_ms: entry.expires_at_ms,
        cache_age_ms: Math.max(0, now - entry.checked_at_ms),
        cache_generation: entry.generation,
        available: entry.record.available,
        authenticated: entry.record.authenticated
      })).sort((left, right) => left.provider.localeCompare(right.provider)),
      hits: this.hits,
      misses: this.misses,
      probes: this.probes,
      invalidations: this.invalidations,
      in_flight_deduplicated: this.inflightDeduplicated
    };
  }
}
