import {
  RUNTIME_PROBE_LAYERS,
  type RuntimeProbeCheck,
  type RuntimeProbeCheckResult,
  type RuntimeProbeComponentResult,
  type RuntimeProbeDefinition,
  type RuntimeProbeLayer,
  type RuntimeProbeLayerResult,
  type RuntimeProbeReport
} from "./probeTypes.js";

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeResult(value: RuntimeProbeCheckResult): RuntimeProbeCheckResult {
  if (value.status !== "pass" && value.status !== "fail" && value.status !== "unknown") {
    return {
      status: "unknown",
      reason: `Probe returned an unsupported status: ${String(value.status)}.`,
      recovery: "Fix the probe implementation before trusting this result."
    };
  }
  return value;
}

async function runLayer(layer: RuntimeProbeLayer, check?: RuntimeProbeCheck): Promise<RuntimeProbeLayerResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  if (!check) {
    return {
      layer,
      status: "unknown",
      checked_at: checkedAt,
      duration_ms: 0,
      reason: "No probe is registered for this layer.",
      recovery: "Register a real behavior probe; do not infer this layer from another layer."
    };
  }

  try {
    const result = normalizeResult(await check());
    return {
      layer,
      ...result,
      checked_at: checkedAt,
      duration_ms: Date.now() - started
    };
  } catch (error) {
    return {
      layer,
      status: "fail",
      checked_at: checkedAt,
      duration_ms: Date.now() - started,
      reason: safeMessage(error),
      recovery: "Inspect the component-specific probe evidence and repair the failing runtime layer."
    };
  }
}

export async function runRuntimeProbe(definition: RuntimeProbeDefinition): Promise<RuntimeProbeComponentResult> {
  const layers = {} as Record<RuntimeProbeLayer, RuntimeProbeLayerResult>;
  for (const layer of RUNTIME_PROBE_LAYERS) {
    layers[layer] = await runLayer(layer, definition.checks[layer]);
  }
  return {
    component: definition.component,
    display_name: definition.display_name ?? definition.component,
    checked_at: new Date().toISOString(),
    usable: layers.end_to_end_usable.status === "pass",
    layers
  };
}

export function summarizeRuntimeProbes(components: RuntimeProbeComponentResult[]): RuntimeProbeReport {
  const failedComponents = components
    .filter((component) => Object.values(component.layers).some((layer) => layer.status === "fail"))
    .map((component) => component.component);
  const unknownComponents = components
    .filter((component) => !component.usable && !failedComponents.includes(component.component))
    .map((component) => component.component);
  return {
    version: 1,
    checked_at: new Date().toISOString(),
    usable: components.length > 0 && components.every((component) => component.usable),
    components,
    failed_components: failedComponents,
    unknown_components: unknownComponents
  };
}

export async function runRuntimeProbes(definitions: RuntimeProbeDefinition[]): Promise<RuntimeProbeReport> {
  const components: RuntimeProbeComponentResult[] = [];
  for (const definition of definitions) components.push(await runRuntimeProbe(definition));
  return summarizeRuntimeProbes(components);
}
