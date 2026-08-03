export function redactSensitiveText(value: unknown): string;
export function redactStructured<T>(value: T, depth?: number): T;
export function redactEnvironmentObject(env: Record<string, unknown> | NodeJS.ProcessEnv): Record<string, string>;
