import { codexProEventBus } from "../events/eventBus.js";
import {
  ProviderCapabilityCache,
  type ProviderCapabilityCacheOptions,
  type ProviderCapabilityCacheSnapshot,
  type ProviderCapabilityLookup
} from "./providerCapabilityCache.js";
import type {
  CodexAdapter,
  CodexCapabilities,
  CodexEventStreamOptions,
  CodexNormalizedEvent,
  CodexProviderId,
  CodexResumeInput,
  CodexRun,
  CodexTaskInput
} from "./types.js";
import { CodexAdapterError } from "./types.js";

export type ProviderFailureDomain =
  | "auth_failed"
  | "quota_exhausted"
  | "rate_limited"
  | "provider_unavailable"
  | "unsupported_capability"
  | "transient_transport_failure"
  | "execution_failed";

export interface ProviderCapabilityRecord {
  provider: CodexProviderId;
  available: boolean;
  authenticated: boolean;
  supports_read_only: boolean;
  supports_workspace_write: boolean;
  supports_resume: boolean;
  supports_cancel: boolean;
  supports_streaming: boolean;
  checked_at: string;
  notes: string[];
}

export interface ProviderHealthRecord {
  provider: CodexProviderId;
  usable: boolean;
  failure_domain?: ProviderFailureDomain;
  reason: string;
  checked_at: string;
}

export interface ProviderSelectionRequest {
  preferred_provider?: CodexProviderId;
  forced_provider?: CodexProviderId;
  sandbox_mode: "read-only" | "workspace-write";
  requires_resume?: boolean;
  requires_streaming?: boolean;
  non_idempotent_started?: boolean;
}

export interface ProviderSelectionRecord {
  version: 1;
  selection_id: string;
  selected_at: string;
  preferred_provider: CodexProviderId;
  effective_provider?: CodexProviderId;
  forced_provider?: CodexProviderId;
  fallback_used: boolean;
  fallback_reason?: ProviderFailureDomain;
  fallback_detail?: string;
  candidates: ProviderCapabilityRecord[];
  rejected: Array<{ provider: CodexProviderId; reason: string }>;
  safe_to_fallback: boolean;
  provider_probe_ms?: number;
  provider_cache_hit?: boolean;
  provider_cache_age_ms?: number;
  provider_cache_generation?: number;
  provider_probe_reason?: string;
  provider_cache_inflight_deduplicated?: boolean;
}

function stamp(): string {
  return new Date().toISOString();
}

function selectionId(): string {
  return `provider-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function providerCapabilityRecord(capabilities: CodexCapabilities): ProviderCapabilityRecord {
  return {
    provider: capabilities.provider,
    available: capabilities.available,
    authenticated: capabilities.authentication !== "auth_required",
    supports_read_only: capabilities.supports.read_only,
    supports_workspace_write: capabilities.supports.workspace_write,
    supports_resume: capabilities.supports.resume,
    supports_cancel: capabilities.supports.cancel,
    supports_streaming: capabilities.supports.streaming,
    checked_at: stamp(),
    notes: [...capabilities.notes]
  };
}

export function providerHealth(record: ProviderCapabilityRecord): ProviderHealthRecord {
  if (!record.available) {
    return { provider: record.provider, usable: false, failure_domain: "provider_unavailable", reason: "Provider capability probe reported unavailable.", checked_at: stamp() };
  }
  if (!record.authenticated) {
    return { provider: record.provider, usable: false, failure_domain: "auth_failed", reason: "Provider authentication is required.", checked_at: stamp() };
  }
  return { provider: record.provider, usable: true, reason: "Provider capability and authentication checks passed.", checked_at: stamp() };
}

function supportsRequest(candidate: ProviderCapabilityRecord, request: ProviderSelectionRequest): string | undefined {
  if (!candidate.available) return "provider unavailable";
  if (!candidate.authenticated) return "authentication required";
  if (request.sandbox_mode === "workspace-write" && !candidate.supports_workspace_write) return "workspace-write unsupported";
  if (request.sandbox_mode === "read-only" && !candidate.supports_read_only) return "read-only unsupported";
  if (request.requires_resume && !candidate.supports_resume) return "resume unsupported";
  if (request.requires_streaming && !candidate.supports_streaming) return "streaming unsupported";
  return undefined;
}

function selectionFailureDomain(reason: string | undefined): ProviderFailureDomain {
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.includes("auth")) return "auth_failed";
  if (normalized.includes("unsupported")) return "unsupported_capability";
  return "provider_unavailable";
}

export function selectProvider(
  candidates: ProviderCapabilityRecord[],
  request: ProviderSelectionRequest
): ProviderSelectionRecord {
  const preferred = request.forced_provider ?? request.preferred_provider ?? "sdk";
  const order = request.forced_provider
    ? [request.forced_provider]
    : [preferred, ...(["sdk", "exec", "mock"] as CodexProviderId[]).filter((provider) => provider !== preferred)];
  const candidateMap = new Map(candidates.map((candidate) => [candidate.provider, candidate]));
  const rejected: Array<{ provider: CodexProviderId; reason: string }> = [];
  let effective: CodexProviderId | undefined;
  for (const provider of order) {
    const candidate = candidateMap.get(provider);
    if (!candidate) {
      rejected.push({ provider, reason: "provider not registered" });
      continue;
    }
    const reason = supportsRequest(candidate, request);
    if (reason) {
      rejected.push({ provider, reason });
      continue;
    }
    effective = provider;
    break;
  }
  const fallbackUsed = Boolean(effective && effective !== preferred);
  const preferredRejection = rejected.find((item) => item.provider === preferred);
  return {
    version: 1,
    selection_id: selectionId(),
    selected_at: stamp(),
    preferred_provider: preferred,
    ...(effective ? { effective_provider: effective } : {}),
    ...(request.forced_provider ? { forced_provider: request.forced_provider } : {}),
    fallback_used: fallbackUsed,
    ...(fallbackUsed ? { fallback_reason: selectionFailureDomain(preferredRejection?.reason) } : {}),
    ...(fallbackUsed && preferredRejection ? { fallback_detail: preferredRejection.reason } : {}),
    candidates,
    rejected,
    safe_to_fallback: request.forced_provider === undefined && request.non_idempotent_started !== true
  };
}

export function classifyProviderFailure(error: unknown): ProviderFailureDomain {
  const code = error instanceof CodexAdapterError ? error.code : undefined;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (code === "auth_required" || /auth|login|unauthori[sz]ed|credential/.test(message)) return "auth_failed";
  if (/quota|usage limit|credits? exhausted|insufficient quota/.test(message)) return "quota_exhausted";
  if (/rate.?limit|too many requests|\b429\b/.test(message)) return "rate_limited";
  if (code === "provider_unavailable" || /unavailable|not found|enoent|cannot resolve/.test(message)) return "provider_unavailable";
  if (/unsupported|not supported|capability/.test(message)) return "unsupported_capability";
  if (/transport|websocket|connection|timeout|timed out|econn|socket|stream disconnected/.test(message)) return "transient_transport_failure";
  return "execution_failed";
}

export function fallbackAllowed(domain: ProviderFailureDomain, request: ProviderSelectionRequest): boolean {
  if (request.forced_provider) return false;
  if (request.non_idempotent_started) return false;
  return ["auth_failed", "quota_exhausted", "rate_limited", "provider_unavailable", "unsupported_capability", "transient_transport_failure"].includes(domain);
}

export interface RoutedCodexAdapterOptions {
  adapters: CodexAdapter[];
  preferred_provider?: CodexProviderId;
  capability_cache?: ProviderCapabilityCacheOptions & { warmup?: boolean };
}

interface CachedProviderCapability {
  provider: CodexProviderId;
  available: boolean;
  authenticated: boolean;
  record: ProviderCapabilityRecord;
  raw: CodexCapabilities;
}

interface CapabilityRecordBatch {
  records: ProviderCapabilityRecord[];
  lookups: ProviderCapabilityLookup<CachedProviderCapability>[];
}

export class RoutedCodexAdapter implements CodexAdapter {
  readonly provider: CodexProviderId;
  private readonly adapters: Map<CodexProviderId, CodexAdapter>;
  private readonly preferredProvider: CodexProviderId;
  private readonly capabilityCache: ProviderCapabilityCache<CachedProviderCapability>;
  private readonly runProviders = new Map<string, CodexProviderId>();
  private readonly selections = new Map<string, ProviderSelectionRecord>();

  constructor(options: RoutedCodexAdapterOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
    this.preferredProvider = options.preferred_provider ?? "sdk";
    this.provider = this.preferredProvider;
    this.capabilityCache = new ProviderCapabilityCache<CachedProviderCapability>(options.capability_cache);
    if (!this.adapters.size) throw new CodexAdapterError("provider_unavailable", "Provider Router requires at least one adapter.");
    if (options.capability_cache?.warmup === true) {
      void this.warmCapabilityCache().catch(() => {
        // Warmup is opportunistic; launch-time selection remains authoritative.
      });
    }
  }

  async capabilities(): Promise<CodexCapabilities> {
    const batch = await this.capabilityRecords("capabilities");
    const selection = this.withProbeTelemetry(
      selectProvider(batch.records, { preferred_provider: this.preferredProvider, sandbox_mode: "read-only" }),
      batch.lookups,
      "capabilities"
    );
    const effectiveLookup = selection.effective_provider
      ? batch.lookups.find((item) => item.record.provider === selection.effective_provider)
      : undefined;
    if (!effectiveLookup) {
      return {
        provider: this.preferredProvider,
        available: false,
        sdk_available: batch.records.some((item) => item.provider === "sdk" && item.available),
        cli_available: batch.records.some((item) => item.provider === "exec" && item.available),
        authentication: "unknown",
        exec_available: batch.records.some((item) => item.provider === "exec" && item.available),
        mcp_server_available: false,
        supports: { start: false, resume: false, cancel: false, streaming: false, read_only: false, workspace_write: false },
        notes: ["No registered provider passed capability selection.", ...selection.rejected.map((item) => `${item.provider}: ${item.reason}`)]
      };
    }
    const result = effectiveLookup.record.raw;
    return {
      ...result,
      provider: this.preferredProvider,
      notes: [
        ...result.notes,
        `Provider Router effective provider: ${effectiveLookup.record.provider}.`,
        `Capability cache hit: ${effectiveLookup.cache_hit}.`
      ]
    };
  }

  async startTask(input: CodexTaskInput): Promise<CodexRun> {
    const batch = await this.capabilityRecords("task_start", input.forced_provider ? [input.forced_provider] : undefined);
    const records = batch.records;
    const request: ProviderSelectionRequest = {
      preferred_provider: input.preferred_provider ?? this.preferredProvider,
      ...(input.forced_provider ? { forced_provider: input.forced_provider } : {}),
      sandbox_mode: input.sandbox_mode ?? "read-only",
      requires_streaming: true,
      non_idempotent_started: false
    };
    let selection = this.withProbeTelemetry(selectProvider(records, request), batch.lookups, "task_start");
    let provider = selection.effective_provider;
    if (!provider) throw new CodexAdapterError("provider_unavailable", `No provider can execute this task: ${selection.rejected.map((item) => `${item.provider}=${item.reason}`).join(", ")}`);
    let adapter = this.adapters.get(provider)!;
    try {
      await this.emitModelSwitchBefore(selection.preferred_provider, adapter.provider, selection);
      const run = await adapter.startTask(input);
      this.remember(run, adapter.provider, selection);
      await this.emitModelSwitchAfter(selection.preferred_provider, adapter.provider, selection, run.run_id);
      return run;
    } catch (error) {
      const domain = classifyProviderFailure(error);
      this.capabilityCache.invalidate(provider);
      const safeRequest = { ...request, non_idempotent_started: input.sandbox_mode === "workspace-write" };
      if (!fallbackAllowed(domain, safeRequest)) throw error;
      const remaining = records.filter((item) => item.provider !== provider);
      const fallbackSelection = this.withProbeTelemetry(
        selectProvider(remaining, { ...request, preferred_provider: remaining[0]?.provider ?? "exec" }),
        batch.lookups.filter((item) => item.record.provider !== provider),
        "start_failure_fallback"
      );
      const fallbackProvider = fallbackSelection.effective_provider;
      if (!fallbackProvider) throw error;
      adapter = this.adapters.get(fallbackProvider)!;
      selection = {
        ...fallbackSelection,
        preferred_provider: provider,
        fallback_used: true,
        fallback_reason: domain,
        fallback_detail: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        candidates: records
      };
      await this.emitModelSwitchBefore(provider, adapter.provider, selection);
      const run = await adapter.startTask(input);
      this.remember(run, adapter.provider, selection);
      await this.emitModelSwitchAfter(provider, adapter.provider, selection, run.run_id);
      return run;
    }
  }

  async resumeTask(input: CodexResumeInput): Promise<CodexRun> {
    const adapter = input.forced_provider
      ? this.adapters.get(input.forced_provider)
      : await this.adapterForRun(input.run_id, input.thread_id);
    if (!adapter) {
      throw new CodexAdapterError(
        input.forced_provider ? "provider_unavailable" : "run_not_found",
        input.forced_provider
          ? `Execution profile provider ${input.forced_provider} is not registered; recovery cannot substitute another provider.`
          : "Provider Router could not locate the run to resume."
      );
    }
    const run = await adapter.resumeTask(input);
    this.runProviders.set(run.run_id, adapter.provider);
    return run;
  }

  async cancelTask(runId: string): Promise<CodexRun> {
    const adapter = await this.adapterForRun(runId);
    if (!adapter) throw new CodexAdapterError("run_not_found", `Provider Router could not locate run ${runId}.`);
    return await adapter.cancelTask(runId);
  }

  async getRun(runId: string): Promise<CodexRun> {
    const adapter = await this.adapterForRun(runId);
    if (!adapter) throw new CodexAdapterError("run_not_found", `Provider Router could not locate run ${runId}.`);
    return await adapter.getRun(runId);
  }

  async *streamEvents(runId: string, options?: CodexEventStreamOptions): AsyncIterable<CodexNormalizedEvent> {
    const adapter = await this.adapterForRun(runId);
    if (!adapter) throw new CodexAdapterError("run_not_found", `Provider Router could not locate run ${runId}.`);
    yield* adapter.streamEvents(runId, options);
  }

  selectionForRun(runId: string): ProviderSelectionRecord | undefined {
    const record = this.selections.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  registeredProviders(): CodexProviderId[] {
    return [...this.adapters.keys()];
  }

  capabilityCacheSnapshot(): ProviderCapabilityCacheSnapshot {
    return this.capabilityCache.snapshot();
  }

  invalidateProviderCapabilities(provider: CodexProviderId): void {
    this.capabilityCache.invalidate(provider);
  }

  async warmCapabilityCache(): Promise<void> {
    await this.capabilityCache.warm(
      [...this.adapters.values()].map((adapter) => ({
        provider: adapter.provider,
        probe: () => this.probeAdapter(adapter)
      })),
      "startup_warmup"
    );
  }

  private async capabilityRecords(
    reason: string,
    providers?: CodexProviderId[]
  ): Promise<CapabilityRecordBatch> {
    const filter = providers?.length ? new Set(providers) : undefined;
    const adapters = [...this.adapters.values()].filter((adapter) => !filter || filter.has(adapter.provider));
    const lookups = await Promise.all(adapters.map((adapter) =>
      this.capabilityCache.get(adapter.provider, () => this.probeAdapter(adapter), reason)
    ));
    return {
      records: lookups.map((item) => structuredClone(item.record.record)),
      lookups
    };
  }

  private async probeAdapter(adapter: CodexAdapter): Promise<CachedProviderCapability> {
    try {
      const raw = await adapter.capabilities();
      const record = providerCapabilityRecord(raw);
      return {
        provider: adapter.provider,
        available: record.available,
        authenticated: record.authenticated,
        record,
        raw
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const record: ProviderCapabilityRecord = {
        provider: adapter.provider,
        available: false,
        authenticated: false,
        supports_read_only: false,
        supports_workspace_write: false,
        supports_resume: false,
        supports_cancel: false,
        supports_streaming: false,
        checked_at: stamp(),
        notes: [message]
      };
      return {
        provider: adapter.provider,
        available: false,
        authenticated: false,
        record,
        raw: {
          provider: adapter.provider,
          available: false,
          sdk_available: false,
          cli_available: false,
          authentication: "unknown",
          exec_available: false,
          mcp_server_available: false,
          supports: { start: false, resume: false, cancel: false, streaming: false, read_only: false, workspace_write: false },
          notes: [message]
        }
      };
    }
  }

  private withProbeTelemetry(
    selection: ProviderSelectionRecord,
    lookups: ProviderCapabilityLookup<CachedProviderCapability>[],
    reason: string
  ): ProviderSelectionRecord {
    return {
      ...selection,
      provider_probe_ms: lookups.reduce((total, item) => total + item.probe_ms, 0),
      provider_cache_hit: lookups.length > 0 && lookups.every((item) => item.cache_hit),
      provider_cache_age_ms: lookups.length ? Math.max(...lookups.map((item) => item.cache_age_ms)) : 0,
      provider_cache_generation: lookups.length ? Math.max(...lookups.map((item) => item.cache_generation)) : 0,
      provider_probe_reason: reason,
      provider_cache_inflight_deduplicated: lookups.some((item) => item.in_flight_deduplicated)
    };
  }

  private remember(run: CodexRun, provider: CodexProviderId, selection: ProviderSelectionRecord): void {
    this.runProviders.set(run.run_id, provider);
    this.selections.set(run.run_id, { ...selection, effective_provider: provider });
  }

  private async emitModelSwitchBefore(
    fromProvider: CodexProviderId,
    toProvider: CodexProviderId,
    selection: ProviderSelectionRecord
  ): Promise<void> {
    if (fromProvider === toProvider) return;
    const dispatch = await codexProEventBus.emit(
      "model_before_switch",
      {
        from_provider: fromProvider,
        to_provider: toProvider,
        fallback_used: selection.fallback_used,
        fallback_reason: selection.fallback_reason ?? null,
        safe_to_fallback: selection.safe_to_fallback
      },
      { source: "provider_router", correlation_id: selection.selection_id }
    );
    if (dispatch.blocked) {
      throw new Error(`Provider switch blocked: ${dispatch.block_reasons.join(" | ")}`);
    }
  }

  private async emitModelSwitchAfter(
    fromProvider: CodexProviderId,
    toProvider: CodexProviderId,
    selection: ProviderSelectionRecord,
    runId: string
  ): Promise<void> {
    if (fromProvider === toProvider) return;
    await codexProEventBus.emit(
      "model_after_switch",
      {
        from_provider: fromProvider,
        to_provider: toProvider,
        fallback_used: selection.fallback_used,
        fallback_reason: selection.fallback_reason ?? null,
        run_id: runId
      },
      { source: "provider_router", correlation_id: selection.selection_id }
    );
  }

  private async adapterForRun(runId?: string, threadId?: string): Promise<CodexAdapter | undefined> {
    if (runId) {
      const known = this.runProviders.get(runId);
      if (known) return this.adapters.get(known);
      for (const adapter of this.adapters.values()) {
        try {
          const run = await adapter.getRun(runId);
          this.runProviders.set(run.run_id, adapter.provider);
          return adapter;
        } catch {
          // Try the next provider. No mutation occurs during lookup.
        }
      }
    }
    if (threadId) {
      for (const adapter of this.adapters.values()) {
        if (adapter.provider === this.preferredProvider) return adapter;
      }
    }
    return undefined;
  }
}
