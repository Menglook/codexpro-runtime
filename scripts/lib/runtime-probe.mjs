export const RUNTIME_PROBE_LAYERS = [
  'configured',
  'process_alive',
  'transport_reachable',
  'protocol_compatible',
  'capability_available',
  'end_to_end_usable'
];

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeResult(value) {
  if (!value || !['pass', 'fail', 'unknown'].includes(value.status)) {
    return {
      status: 'unknown',
      reason: `Probe returned an unsupported result: ${JSON.stringify(value)}`,
      recovery: 'Fix the probe implementation before trusting this result.'
    };
  }
  return value;
}

async function runLayer(layer, check) {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  if (typeof check !== 'function') {
    return {
      layer,
      status: 'unknown',
      checked_at: checkedAt,
      duration_ms: 0,
      reason: 'No probe is registered for this layer.',
      recovery: 'Register a real behavior probe; do not infer this layer from another layer.'
    };
  }
  try {
    return {
      layer,
      ...normalizeResult(await check()),
      checked_at: checkedAt,
      duration_ms: Date.now() - started
    };
  } catch (error) {
    return {
      layer,
      status: 'fail',
      checked_at: checkedAt,
      duration_ms: Date.now() - started,
      reason: safeMessage(error),
      recovery: 'Inspect the component-specific probe evidence and repair the failing runtime layer.'
    };
  }
}

export async function runRuntimeProbe(definition) {
  const layers = {};
  for (const layer of RUNTIME_PROBE_LAYERS) layers[layer] = await runLayer(layer, definition.checks?.[layer]);
  return {
    component: definition.component,
    display_name: definition.display_name || definition.component,
    checked_at: new Date().toISOString(),
    usable: layers.end_to_end_usable.status === 'pass',
    layers
  };
}

export function summarizeRuntimeProbes(components) {
  const failedComponents = components
    .filter((component) => Object.values(component.layers).some((layer) => layer.status === 'fail'))
    .map((component) => component.component);
  const unknownComponents = components
    .filter((component) => !component.usable && !failedComponents.includes(component.component))
    .map((component) => component.component);
  const allUsable = components.length > 0 && components.every((component) => component.usable);
  const status = failedComponents.length
    ? components.some((component) => component.usable) ? 'degraded' : 'failed'
    : allUsable
      ? 'healthy'
      : 'partially_verified';
  return {
    version: 1,
    checked_at: new Date().toISOString(),
    status,
    usable: allUsable,
    components,
    failed_components: failedComponents,
    unknown_components: unknownComponents
  };
}

export async function runRuntimeProbes(definitions) {
  const components = [];
  for (const definition of definitions) components.push(await runRuntimeProbe(definition));
  return summarizeRuntimeProbes(components);
}
