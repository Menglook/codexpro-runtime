export interface ModernMcpMetricSnapshot {
  protocolVersion: string;
  totalRequests: number;
  failedRequests: number;
  downgradeCount: number;
  deprecationCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  byMethod: Record<string, { total: number; failed: number }>;
}

export class ModernMcpMetrics {
  private totalRequests = 0;
  private failedRequests = 0;
  private downgradeCount = 0;
  private deprecationCount = 0;
  private readonly durations: number[] = [];
  private readonly byMethod = new Map<string, { total: number; failed: number }>();

  record(method: string, durationMs: number, failed: boolean): void {
    this.totalRequests += 1;
    if (failed) this.failedRequests += 1;
    const entry = this.byMethod.get(method) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (failed) entry.failed += 1;
    this.byMethod.set(method, entry);
    this.durations.push(Math.max(0, durationMs));
    if (this.durations.length > 2_000) this.durations.shift();
  }

  recordDeprecation(): void {
    this.deprecationCount += 1;
  }

  recordDowngrade(): void {
    this.downgradeCount += 1;
  }

  snapshot(protocolVersion: string): ModernMcpMetricSnapshot {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      return Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))].toFixed(3));
    };
    return {
      protocolVersion,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      downgradeCount: this.downgradeCount,
      deprecationCount: this.deprecationCount,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
      byMethod: Object.fromEntries(this.byMethod)
    };
  }
}

export const modernMcpMetrics = new ModernMcpMetrics();
