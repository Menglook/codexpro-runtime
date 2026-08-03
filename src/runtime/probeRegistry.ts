import { runRuntimeProbes } from "./probeRunner.js";
import type { RuntimeProbeDefinition, RuntimeProbeReport } from "./probeTypes.js";

export class RuntimeProbeRegistry {
  private readonly definitions = new Map<string, RuntimeProbeDefinition>();

  register(definition: RuntimeProbeDefinition): void {
    const component = definition.component.trim();
    if (!component) throw new Error("Runtime probe component cannot be empty.");
    if (this.definitions.has(component)) throw new Error(`Runtime probe already registered: ${component}`);
    this.definitions.set(component, { ...definition, component });
  }

  has(component: string): boolean {
    return this.definitions.has(component);
  }

  list(): string[] {
    return [...this.definitions.keys()].sort();
  }

  async run(components?: string[]): Promise<RuntimeProbeReport> {
    const requested = components?.length ? [...new Set(components.map((item) => item.trim()).filter(Boolean))] : this.list();
    const definitions = requested.map((component) => {
      const definition = this.definitions.get(component);
      if (!definition) throw new Error(`Runtime probe is not registered: ${component}`);
      return definition;
    });
    return await runRuntimeProbes(definitions);
  }
}
