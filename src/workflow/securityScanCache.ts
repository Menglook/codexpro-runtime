export type SecurityCacheResolveOutcome = "hit" | "miss" | "joined" | "uncached";

export interface SecurityCacheComputation<T> {
  value: T;
  cacheable: boolean;
}

export interface SecurityCacheResolveResult<T> {
  value: T;
  outcome: SecurityCacheResolveOutcome;
  stored: boolean;
  evictions: number;
  generation_reset: boolean;
}

export interface SecurityCacheSnapshot {
  generation: string;
  entries: number;
  bytes: number;
  max_entries: number;
  max_bytes: number;
  in_flight: number;
  hits: number;
  misses: number;
  joined: number;
  stores: number;
  evictions: number;
  failures: number;
  oversized: number;
  generation_resets: number;
}

interface SecurityCacheEntry<T> {
  value: T;
  size: number;
}

export interface BoundedContentHashCacheOptions<T> {
  maxEntries: number;
  maxBytes: number;
  estimateSize: (value: T, key: string) => number;
  cloneValue: (value: T) => T;
}

/**
 * Process-local LRU cache for deterministic content-hash keyed analysis.
 * Values are inserted only after a successful, explicitly cacheable computation.
 */
export class BoundedContentHashCache<T> {
  readonly maxEntries: number;
  readonly maxBytes: number;

  private readonly estimateSize: (value: T, key: string) => number;
  private readonly cloneValue: (value: T) => T;
  private readonly entries = new Map<string, SecurityCacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<SecurityCacheComputation<T>>>();
  private generation = "";
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private joined = 0;
  private stores = 0;
  private evictions = 0;
  private failures = 0;
  private oversized = 0;
  private generationResets = 0;

  constructor(options: BoundedContentHashCacheOptions<T>) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes));
    this.estimateSize = options.estimateSize;
    this.cloneValue = options.cloneValue;
  }

  private ensureGeneration(generation: string): boolean {
    if (this.generation === generation) return false;
    if (this.generation) this.generationResets += 1;
    this.entries.clear();
    this.bytes = 0;
    this.generation = generation;
    return true;
  }

  private lookup(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return this.cloneValue(entry.value);
  }

  private store(key: string, value: T): { stored: boolean; evictions: number } {
    const storedValue = this.cloneValue(value);
    const size = Math.max(1, Math.floor(this.estimateSize(storedValue, key)));
    if (size > this.maxBytes) {
      this.oversized += 1;
      return { stored: false, evictions: 0 };
    }

    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.size;
      this.entries.delete(key);
    }
    this.entries.set(key, { value: storedValue, size });
    this.bytes += size;
    this.stores += 1;

    let evictions = 0;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, SecurityCacheEntry<T>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.bytes = Math.max(0, this.bytes - oldest[1].size);
      this.evictions += 1;
      evictions += 1;
    }
    return { stored: this.entries.has(key), evictions };
  }

  async resolve(
    key: string,
    generation: string,
    compute: () => Promise<SecurityCacheComputation<T>> | SecurityCacheComputation<T>
  ): Promise<SecurityCacheResolveResult<T>> {
    const generationReset = this.ensureGeneration(generation);
    const cached = this.lookup(key);
    if (cached !== undefined) {
      this.hits += 1;
      return {
        value: cached,
        outcome: "hit",
        stored: true,
        evictions: 0,
        generation_reset: generationReset
      };
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      this.joined += 1;
      const computed = await existing;
      return {
        value: this.cloneValue(computed.value),
        outcome: "joined",
        stored: computed.cacheable && this.entries.has(key),
        evictions: 0,
        generation_reset: generationReset
      };
    }

    this.misses += 1;
    const pending = Promise.resolve().then(compute);
    this.inFlight.set(key, pending);
    try {
      const computed = await pending;
      const storage = computed.cacheable
        ? this.store(key, computed.value)
        : { stored: false, evictions: 0 };
      return {
        value: this.cloneValue(computed.value),
        outcome: computed.cacheable ? "miss" : "uncached",
        stored: storage.stored,
        evictions: storage.evictions,
        generation_reset: generationReset
      };
    } catch (error) {
      this.failures += 1;
      throw error;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  reset(): void {
    if (this.inFlight.size) throw new Error("Cannot reset a security scan cache while computations are in flight");
    this.entries.clear();
    this.bytes = 0;
    this.generation = "";
    this.hits = 0;
    this.misses = 0;
    this.joined = 0;
    this.stores = 0;
    this.evictions = 0;
    this.failures = 0;
    this.oversized = 0;
    this.generationResets = 0;
  }

  snapshot(): SecurityCacheSnapshot {
    return {
      generation: this.generation,
      entries: this.entries.size,
      bytes: this.bytes,
      max_entries: this.maxEntries,
      max_bytes: this.maxBytes,
      in_flight: this.inFlight.size,
      hits: this.hits,
      misses: this.misses,
      joined: this.joined,
      stores: this.stores,
      evictions: this.evictions,
      failures: this.failures,
      oversized: this.oversized,
      generation_resets: this.generationResets
    };
  }
}
