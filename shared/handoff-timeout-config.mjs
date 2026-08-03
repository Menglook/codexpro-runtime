import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const HANDOFF_EXECUTION_TIMEOUT_DEFAULT_MS = 14_400_000;
export const HANDOFF_EXECUTION_TIMEOUT_ENV = 'CODEXPRO_HANDOFF_EXECUTION_TIMEOUT_MS';

const HANDOFF_EXECUTION_TIMEOUT_MIN_MS = 1_000;
const HANDOFF_EXECUTION_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;
const PROJECT_CONFIG_PATH = '.codexpro/project.yml';

function configuredValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function firstConfigured(values) {
  for (const value of values) {
    const configured = configuredValue(value);
    if (configured !== undefined) return configured;
  }
  return undefined;
}

export function parseHandoffExecutionTimeoutMs(value, sourceLabel) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || !Number.isInteger(parsed)
    || parsed < HANDOFF_EXECUTION_TIMEOUT_MIN_MS
    || parsed > HANDOFF_EXECUTION_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `Invalid Handoff absolute execution limit from ${sourceLabel}: expected an integer between `
      + `${HANDOFF_EXECUTION_TIMEOUT_MIN_MS} and ${HANDOFF_EXECUTION_TIMEOUT_MAX_MS} ms, got ${JSON.stringify(value)}.`
    );
  }
  return parsed;
}

export function extractHandoffExecutionTimeoutConfig(config) {
  const root = objectValue(config);
  if (!root) return undefined;
  const handoff = objectValue(root.handoff);
  return firstConfigured([
    handoff?.execution_timeout_ms,
    handoff?.executionTimeoutMs,
    handoff?.timeout_ms,
    handoff?.timeoutMs,
    handoff?.absolute_timeout_ms,
    handoff?.absoluteTimeoutMs,
    root.handoff_execution_timeout_ms,
    root.handoffExecutionTimeoutMs
  ]);
}

export function readProjectHandoffExecutionTimeoutConfig(root) {
  const filePath = path.join(root, PROJECT_CONFIG_PATH);
  if (!fs.existsSync(filePath)) return undefined;
  let parsed;
  try {
    parsed = parseYaml(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${PROJECT_CONFIG_PATH} for Handoff timeout configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  return extractHandoffExecutionTimeoutConfig(parsed);
}

export function resolveHandoffExecutionTimeoutMs(options = {}) {
  const {
    cliValue,
    configValue,
    configSource = 'configuration',
    env = process.env
  } = options;
  const cliConfigured = configuredValue(cliValue);
  if (cliConfigured !== undefined) {
    return {
      timeoutMs: parseHandoffExecutionTimeoutMs(cliConfigured, 'CLI --timeout-ms'),
      source: 'cli',
      sourceLabel: 'CLI --timeout-ms'
    };
  }

  const configConfigured = configuredValue(configValue);
  if (configConfigured !== undefined) {
    return {
      timeoutMs: parseHandoffExecutionTimeoutMs(configConfigured, configSource),
      source: 'config',
      sourceLabel: configSource
    };
  }

  const envConfigured = configuredValue(env?.[HANDOFF_EXECUTION_TIMEOUT_ENV]);
  if (envConfigured !== undefined) {
    return {
      timeoutMs: parseHandoffExecutionTimeoutMs(envConfigured, HANDOFF_EXECUTION_TIMEOUT_ENV),
      source: 'environment',
      sourceLabel: HANDOFF_EXECUTION_TIMEOUT_ENV
    };
  }

  return {
    timeoutMs: HANDOFF_EXECUTION_TIMEOUT_DEFAULT_MS,
    source: 'default',
    sourceLabel: 'built-in safety default'
  };
}

export function formatHandoffExecutionTimeout(timeoutMs) {
  const ms = Number(timeoutMs);
  const hours = ms / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1) return `${ms} ms (${hours} hour${hours === 1 ? '' : 's'})`;
  return `${ms} ms`;
}
