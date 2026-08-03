import { performance } from "node:perf_hooks";
import { gitTerminalToolSchemaEntries, type GitTerminalToolName, type GitTerminalToolSchemaEntry } from "../adapters/git-terminal-tool-schema.js";
import { CodexProError } from "../guard.js";
import { detectGitIntent } from "../security/gitIntent.js";

export interface DirectToolSchemaCacheEvidence {
  source: "startup_cache";
  cache_hit: true;
  initialized_at: string;
  startup_load_count: number;
  cache_entry_count: number;
  runtime_schema_retrieval_count: 0;
  required_arguments: readonly string[];
  optional_arguments: readonly string[];
}

export interface DirectToolInvocation {
  version: 1;
  dispatch_mode: "direct_tool_invocation";
  call_count: 1;
  call: {
    name: GitTerminalToolName;
    arguments: Record<string, unknown>;
  };
  schema_cache: DirectToolSchemaCacheEvidence;
  guardrails: {
    search_allowed: false;
    documentation_lookup_allowed: false;
    tool_instruction_read_allowed: false;
    pre_dispatch_tool_calls_allowed: false;
  };
  dispatch_ms: number;
}

export interface DirectToolSchemaCacheStats {
  initialized_at: string;
  startup_load_count: number;
  cache_entry_count: number;
  cache_hit_count: number;
  cache_miss_count: number;
  runtime_schema_retrieval_count: 0;
}

const CACHE_INITIALIZED_AT = new Date().toISOString();
const STARTUP_SCHEMA_ENTRIES = gitTerminalToolSchemaEntries();
const STARTUP_SCHEMA_CACHE = new Map<GitTerminalToolName, GitTerminalToolSchemaEntry>(
  STARTUP_SCHEMA_ENTRIES.map((entry) => [entry.name, entry])
);
const STARTUP_LOAD_COUNT = STARTUP_SCHEMA_CACHE.size;
let cacheHitCount = 0;
let cacheMissCount = 0;

function cachedSchema(name: GitTerminalToolName): GitTerminalToolSchemaEntry {
  const entry = STARTUP_SCHEMA_CACHE.get(name);
  if (!entry) {
    cacheMissCount += 1;
    throw new CodexProError(`Direct Tool Invocation schema was not cached at startup: ${name}.`);
  }
  cacheHitCount += 1;
  return entry;
}

export function directToolSchemaCacheStats(): DirectToolSchemaCacheStats {
  return {
    initialized_at: CACHE_INITIALIZED_AT,
    startup_load_count: STARTUP_LOAD_COUNT,
    cache_entry_count: STARTUP_SCHEMA_CACHE.size,
    cache_hit_count: cacheHitCount,
    cache_miss_count: cacheMissCount,
    runtime_schema_retrieval_count: 0
  };
}

export function buildDirectGitToolInvocation(instruction: string, name: GitTerminalToolName): DirectToolInvocation {
  const started = performance.now();
  const schema = cachedSchema(name);
  const intent = detectGitIntent(instruction);
  const args: Record<string, unknown> = name === "git_finalize"
    ? {
        user_intent: instruction,
        include_push: intent.actions.includes("push")
      }
    : { user_intent: instruction };

  for (const required of schema.requiredArguments) {
    if (!(required in args)) throw new CodexProError(`Direct Tool Invocation omitted required argument ${required} for ${name}.`);
  }

  return {
    version: 1,
    dispatch_mode: "direct_tool_invocation",
    call_count: 1,
    call: { name, arguments: args },
    schema_cache: {
      source: "startup_cache",
      cache_hit: true,
      initialized_at: CACHE_INITIALIZED_AT,
      startup_load_count: STARTUP_LOAD_COUNT,
      cache_entry_count: STARTUP_SCHEMA_CACHE.size,
      runtime_schema_retrieval_count: 0,
      required_arguments: schema.requiredArguments,
      optional_arguments: schema.optionalArguments
    },
    guardrails: {
      search_allowed: false,
      documentation_lookup_allowed: false,
      tool_instruction_read_allowed: false,
      pre_dispatch_tool_calls_allowed: false
    },
    dispatch_ms: Number((performance.now() - started).toFixed(3))
  };
}
