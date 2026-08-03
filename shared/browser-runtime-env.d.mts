export interface BrowserRuntimeEnvReadOptions {
  path?: string;
  homeDir?: string;
}

export interface BrowserRuntimeEnvResult {
  path: string;
  loaded: boolean;
  values: Record<string, string>;
}

export interface BrowserRuntimeEnvApplyResult extends BrowserRuntimeEnvResult {
  applied: string[];
}

export function defaultBrowserRuntimeEnvPath(homeDir?: string): string;
export function parseBrowserRuntimeEnv(text: string): Record<string, string>;
export function readBrowserRuntimeEnv(options?: BrowserRuntimeEnvReadOptions): BrowserRuntimeEnvResult;
export function ensureBrowserCdpNoProxy(target?: NodeJS.ProcessEnv, cdpUrl?: string): string[];
export function applyBrowserRuntimeEnv(target?: NodeJS.ProcessEnv, options?: BrowserRuntimeEnvReadOptions): BrowserRuntimeEnvApplyResult;
