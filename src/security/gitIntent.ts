export type GitIntentAction = "commit" | "push";

export interface GitIntentDecision {
  detected: boolean;
  actions: GitIntentAction[];
  matched_signals: string[];
  negated: boolean;
}

const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/(不要|别|禁止|无需|不需要|暂不|不自动|不要自动|不能|请勿).{0,18}(提交|推送|推一下|commit|push)/iu, "git_intent_denied_before"],
  [/(提交|推送|commit|push).{0,18}(不要|禁止|无需|不需要|暂不|不自动|不能|请勿)/iu, "git_intent_denied_after"],
  [/\b(do\s+not|don't|dont|never|no|skip|without)\s+(?:git\s+)?(commit|push)\b/i, "git_intent_denied_en"],
  [/\b(commit|push)\b.{0,24}\b(not|disabled|forbidden)\b/i, "git_intent_denied_en_after"]
];

const COMMIT_PUSH_PATTERNS: Array<[RegExp, string]> = [
  [/提交\s*(?:并|和|及|&|\/)?\s*推送/iu, "git_intent_commit_push_zh"],
  [/提交.{0,12}\bpush\b/iu, "git_intent_commit_push_mixed"],
  [/\bcommit\s*(?:and|&|\+|\/|then)?\s*push\b/i, "git_intent_commit_push_en"]
];

const COMMIT_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s，,。；;！!：:])(?:仅|只|直接|现在|马上|请|帮我|帮忙|麻烦|可以)?\s*提交(?:代码|改动|更改|修改|变更|这次|一下|吧)?(?=$|[\s，,。；;！!：:])/iu, "git_intent_commit_zh"],
  [/(^|[\s，,。；;！!：:])(?:仅|只|直接|现在|马上|请|帮我|帮忙|麻烦|可以)?\s*提交(?:当前|本次|上述|这些|现有)\s*(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,63}\s*)?(?:代码|改动|更改|修改|变更|文件|内容|结果)(?=$|[\s，,。；;！!：:])/iu, "git_intent_commit_named_scope_zh"],
  [/\b(?:git\s+)?commit\b/i, "git_intent_commit_en"],
  [/\bready to commit\b/i, "git_intent_commit_ready_en"]
];

const PUSH_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s，,。；;！!：:])(?:直接|现在|马上|请|帮我|帮忙|麻烦|可以|重新|重试|再次|只)?\s*推送(?:当前|本次|上述|这些|现有)\s*(?:提交|代码|改动|更改|修改|变更|文件|内容|结果)(?=$|[\s，,。；;！!：:])/iu, "git_intent_push_named_scope_zh"],
  [/(^|[\s，,。；;！!：:])(?:直接|现在|马上|请|帮我|帮忙|麻烦|可以|重新|重试|再次|只)?\s*推送(?:代码|改动|更改|修改|变更|这次|一下|吧|到远端|到\s*origin|到\s*remote)?(?=$|[\s，,。；;！!：:])/iu, "git_intent_push_zh"],
  [/(?:帮我|帮忙|请|麻烦|直接|现在|马上)?\s*推(?:一下|一把)(?:代码|改动|更改|修改|变更)?/iu, "git_intent_push_short_zh"],
  [/\b(?:git\s+)?push\b/i, "git_intent_push_en"]
];

const INTENT_CONTEXT_KEYS = new Set([
  "approval",
  "approvaltext",
  "approval_text",
  "authorization",
  "authorizationcontext",
  "authorization_context",
  "confirmation",
  "confirmationtext",
  "confirmation_text",
  "confirm",
  "goal",
  "instruction",
  "intent",
  "prompt",
  "request",
  "task",
  "taskinstruction",
  "task_instruction",
  "userintent",
  "user_intent",
  "usermessage",
  "user_message",
  "userrequest",
  "user_request"
]);

const COMMAND_CONTEXT_KEYS = new Set([
  "args",
  "argv",
  "cmd",
  "command",
  "commands",
  "script",
  "shell"
]);

function normalizedKey(key: string): string {
  return key.replace(/[-\s]/g, "_").toLowerCase();
}

function compactKey(key: string): string {
  return normalizedKey(key).replace(/_/g, "");
}

function isIntentContextKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return INTENT_CONTEXT_KEYS.has(normalized) || INTENT_CONTEXT_KEYS.has(compactKey(key));
}

function isCommandContextKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return COMMAND_CONTEXT_KEYS.has(normalized) || COMMAND_CONTEXT_KEYS.has(compactKey(key));
}

function matchSignals(text: string, patterns: Array<[RegExp, string]>): string[] {
  return patterns.filter(([pattern]) => pattern.test(text)).map(([, signal]) => signal);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function detectGitIntent(input: string | string[] | undefined): GitIntentDecision {
  const text = Array.isArray(input) ? input.filter(Boolean).join("\n") : input ?? "";
  const trimmed = text.trim();
  if (!trimmed) return { detected: false, actions: [], matched_signals: [], negated: false };

  const denySignals = matchSignals(trimmed, DENY_PATTERNS);
  if (denySignals.length) {
    return { detected: false, actions: [], matched_signals: unique(denySignals), negated: true };
  }

  const matchedSignals: string[] = [];
  const actions = new Set<GitIntentAction>();
  const commitPushSignals = matchSignals(trimmed, COMMIT_PUSH_PATTERNS);
  if (commitPushSignals.length) {
    matchedSignals.push(...commitPushSignals);
    actions.add("commit");
    actions.add("push");
  }
  const commitSignals = matchSignals(trimmed, COMMIT_PATTERNS);
  if (commitSignals.length) {
    matchedSignals.push(...commitSignals);
    actions.add("commit");
  }
  const pushSignals = matchSignals(trimmed, PUSH_PATTERNS);
  if (pushSignals.length) {
    matchedSignals.push(...pushSignals);
    actions.add("push");
  }

  const matched = unique(matchedSignals);
  return {
    detected: matched.length > 0,
    actions: [...actions],
    matched_signals: matched,
    negated: false
  };
}

export function collectGitIntentContext(args: unknown, depth = 0, inIntentContext = false): string[] {
  if (depth > 6 || args === null || args === undefined) return [];
  if (typeof args === "string") return inIntentContext ? [args] : [];
  if (typeof args === "number" || typeof args === "boolean") return [];
  if (Array.isArray(args)) return args.flatMap((item) => collectGitIntentContext(item, depth + 1, inIntentContext));
  if (typeof args !== "object") return [];

  const out: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (/token|secret|password|cookie/i.test(key)) continue;
    if (isCommandContextKey(key)) continue;
    const childIntentContext = inIntentContext || isIntentContextKey(key);
    out.push(...collectGitIntentContext(value, depth + 1, childIntentContext));
  }
  return out;
}

export function detectGitIntentFromArgs(args: unknown): GitIntentDecision {
  return detectGitIntent(collectGitIntentContext(args));
}

export function hasGitIntent(input: string | string[] | undefined): boolean {
  return detectGitIntent(input).detected;
}
