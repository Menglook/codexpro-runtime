import type { CodexProConfig } from "../config.js";
import { redactSensitiveText } from "../redact.js";
import { ProjectAggregationService, type DashboardResponse } from "./projectAggregationService.js";
import {
  emptyOfficeDashboard,
  projectOfficeDashboard,
  type OfficeProjectionOptions,
  type OfficeProjectionV1,
  type OfficeSnapshotObservabilityV1
} from "./officeProjectionService.js";

const DEFAULT_FRESH_MS = 4_000;

type DashboardLoader = () => Promise<DashboardResponse>;

export interface OfficeSnapshotServiceOptions {
  fresh_ms?: number;
  load_dashboard?: DashboardLoader;
}

function boundedFreshMs(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_FRESH_MS;
  return Math.max(1_000, Math.min(60_000, Math.floor(numeric)));
}

export class OfficeSnapshotService {
  private readonly freshMs: number;
  private readonly loadDashboard: DashboardLoader;
  private snapshot: DashboardResponse | null = null;
  private snapshotCompletedAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshScheduled = false;
  private refreshCount = 0;
  private refreshErrorCount = 0;
  private lastRefreshDurationMs: number | null = null;
  private lastRefreshError: string | null = null;

  constructor(config: CodexProConfig, options: OfficeSnapshotServiceOptions = {}) {
    this.freshMs = boundedFreshMs(options.fresh_ms);
    this.loadDashboard = options.load_dashboard ?? (async () => await new ProjectAggregationService(config).dashboard(
      { page_size: 100 },
      { profile: "office" }
    ));
  }

  async warm(): Promise<OfficeSnapshotObservabilityV1> {
    await this.refresh();
    return this.observability();
  }

  refreshInBackground(): void {
    if (this.refreshPromise || this.refreshScheduled) return;
    this.refreshScheduled = true;
    setImmediate(() => {
      this.refreshScheduled = false;
      void this.refresh().catch(() => undefined);
    });
  }

  async read(options: OfficeProjectionOptions = {}): Promise<OfficeProjectionV1> {
    if (!this.snapshot) {
      this.refreshInBackground();
      return {
        ...emptyOfficeDashboard(options),
        snapshot_observability: this.observability()
      };
    }

    if (Date.now() - this.snapshotCompletedAt >= this.freshMs) this.refreshInBackground();
    return {
      ...projectOfficeDashboard(this.snapshot, options),
      snapshot_observability: this.observability()
    };
  }

  observability(now = Date.now()): OfficeSnapshotObservabilityV1 {
    return {
      version: 1,
      mode: "stale_while_revalidate",
      fresh_for_ms: this.freshMs,
      snapshot_ready: Boolean(this.snapshot),
      snapshot_generated_at: this.snapshot?.generated_at ?? null,
      snapshot_completed_at: this.snapshotCompletedAt ? new Date(this.snapshotCompletedAt).toISOString() : null,
      age_ms: this.snapshotCompletedAt ? Math.max(0, now - this.snapshotCompletedAt) : null,
      refresh_in_flight: Boolean(this.refreshPromise) || this.refreshScheduled,
      refresh_count: this.refreshCount,
      refresh_error_count: this.refreshErrorCount,
      last_refresh_duration_ms: this.lastRefreshDurationMs,
      last_refresh_error: this.lastRefreshError
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) return await this.refreshPromise;
    const startedAt = Date.now();
    this.refreshPromise = (async () => {
      try {
        const dashboard = await this.loadDashboard();
        this.snapshot = dashboard;
        this.snapshotCompletedAt = Date.now();
        this.refreshCount += 1;
        this.lastRefreshDurationMs = Math.max(0, this.snapshotCompletedAt - startedAt);
        this.lastRefreshError = null;
      } catch (error) {
        this.refreshErrorCount += 1;
        this.lastRefreshDurationMs = Math.max(0, Date.now() - startedAt);
        this.lastRefreshError = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
        throw error;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return await this.refreshPromise;
  }
}
