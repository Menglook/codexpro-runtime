import path from "node:path";

export const SEARCH_LOOP_FAILURE_CODE = "repeated_search_blocked";
export const MAX_CONSECUTIVE_PROJECT_SEARCHES = 4;

export interface SearchLoopGuardResult {
  consecutive_search_count: number;
  max_consecutive_searches: number;
  repeated_query: boolean;
}

interface SearchLoopState {
  consecutive: number;
  signatures: string[];
  updatedAt: number;
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function signature(input: { queries: readonly string[]; path?: string; glob?: string }): string {
  return JSON.stringify({
    queries: [...new Set(input.queries.map(normalizedText).filter(Boolean))].sort(),
    path: normalizedText(input.path),
    glob: normalizedText(input.glob)
  });
}

export class SearchLoopBreaker {
  private readonly states = new Map<string, SearchLoopState>();

  constructor(
    private readonly maxConsecutive = MAX_CONSECUTIVE_PROJECT_SEARCHES,
    private readonly staleAfterMs = 10 * 60_000
  ) {}

  beforeSearch(
    workspaceRoot: string,
    input: { queries: readonly string[]; path?: string; glob?: string },
    now = Date.now()
  ): SearchLoopGuardResult {
    const key = path.resolve(workspaceRoot);
    const nextSignature = signature(input);
    const previous = this.states.get(key);
    const state = previous && now - previous.updatedAt <= this.staleAfterMs
      ? previous
      : { consecutive: 0, signatures: [], updatedAt: now };
    const repeatedQuery = state.signatures.includes(nextSignature);
    if (repeatedQuery || state.consecutive >= this.maxConsecutive) {
      state.updatedAt = now;
      this.states.set(key, state);
      const reason = repeatedQuery
        ? "the same search scope and query set was already completed without an intervening progress action"
        : `${state.consecutive} consecutive project searches completed without reading files, changing code, reviewing changes, or validating`;
      throw new Error(
        `${SEARCH_LOOP_FAILURE_CODE}: ${reason}. Stop searching. Use read_many_files on existing results, run_validation when the implementation already exists, or finish with a truthful blocked/failed outcome.`
      );
    }
    state.consecutive += 1;
    state.signatures.push(nextSignature);
    if (state.signatures.length > this.maxConsecutive) state.signatures.shift();
    state.updatedAt = now;
    this.states.set(key, state);
    return {
      consecutive_search_count: state.consecutive,
      max_consecutive_searches: this.maxConsecutive,
      repeated_query: false
    };
  }

  recordProgress(workspaceRoot: string): void {
    this.states.delete(path.resolve(workspaceRoot));
  }
}

// HTTP Connector clients may initialize a fresh MCP server for every tool
// request. Keep the breaker at process scope so those transports cannot reset
// loop history simply by opening a new MCP session.
export const sharedSearchLoopBreaker = new SearchLoopBreaker();
