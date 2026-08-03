import { McpProtocolError } from "../protocolAdapter.js";

interface IdempotencyRecord<T> {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<T>;
}

export class ModernMcpIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord<unknown>>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 1_000
  ) {}

  async run<T>(key: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
    this.sweep();
    const existing = this.records.get(key) as IdempotencyRecord<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new McpProtocolError("Idempotency key was reused with a different request payload.", -32602, {
          idempotencyKey: key
        });
      }
      return existing.promise;
    }
    if (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest) this.records.delete(oldest);
    }
    const promise = action();
    this.records.set(key, {
      fingerprint,
      expiresAt: Date.now() + this.ttlMs,
      promise
    });
    try {
      return await promise;
    } catch (error) {
      this.records.delete(key);
      throw error;
    }
  }

  forget(key: string): void {
    this.records.delete(key);
  }

  clear(): void {
    this.records.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }
}

export const modernMcpIdempotencyStore = new ModernMcpIdempotencyStore();
