export const RUNTIME_PROBE_LAYERS = [
  "configured",
  "process_alive",
  "transport_reachable",
  "protocol_compatible",
  "capability_available",
  "end_to_end_usable"
] as const;

export type RuntimeProbeLayer = typeof RUNTIME_PROBE_LAYERS[number];
export type RuntimeProbeStatus = "pass" | "fail" | "unknown";

export interface RuntimeProbeCheckResult {
  status: RuntimeProbeStatus;
  reason?: string;
  recovery?: string;
  actual_version?: string;
  expected_version?: string;
  evidence?: Record<string, unknown>;
}

export interface RuntimeProbeLayerResult extends RuntimeProbeCheckResult {
  layer: RuntimeProbeLayer;
  checked_at: string;
  duration_ms: number;
}

export interface RuntimeProbeComponentResult {
  component: string;
  display_name: string;
  checked_at: string;
  usable: boolean;
  layers: Record<RuntimeProbeLayer, RuntimeProbeLayerResult>;
}

export interface RuntimeProbeReport {
  version: 1;
  checked_at: string;
  usable: boolean;
  components: RuntimeProbeComponentResult[];
  failed_components: string[];
  unknown_components: string[];
}

export type RuntimeProbeCheck = () => RuntimeProbeCheckResult | Promise<RuntimeProbeCheckResult>;

export interface RuntimeProbeDefinition {
  component: string;
  display_name?: string;
  checks: Partial<Record<RuntimeProbeLayer, RuntimeProbeCheck>>;
}
