export type GitRemoteProtocol = "https" | "http" | "ssh" | "local" | "unknown";
export type GitPushTransport = "https_wsl_proxy" | "https_direct" | "http_wsl_proxy" | "http_direct" | "ssh" | "local" | "unknown";
export type GitPushErrorCode =
  | "failed_tls"
  | "failed_dns"
  | "failed_remote_rejected"
  | "failed_authentication"
  | "failed_non_fast_forward"
  | "failed_proxy_unavailable"
  | "failed_remote_service"
  | "failed_network"
  | "failed_unknown";

export interface GitPushCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface GitPushEnvironment {
  env: NodeJS.ProcessEnv;
  transport: GitPushTransport;
  proxy_available: boolean;
  proxy_keys: string[];
}

export interface GitPushFailureClassification {
  error_code: GitPushErrorCode;
  retryable: boolean;
}

export interface GitPushExecutionResult {
  ok: boolean;
  attempts: number;
  transport: GitPushTransport;
  proxy_available: boolean;
  http_version_fallback_used: boolean;
  push_started_at: string;
  git_process_exited_at: string;
  push_duration_ms: number;
  final_result: GitPushCommandResult;
  error_code?: GitPushErrorCode;
}

export type GitPushRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => GitPushCommandResult;

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
] as const;

const PUSH_TIMEOUT_MS = 15_000;

function firstNonEmpty(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function detectGitRemoteProtocol(remoteUrl: string | undefined): GitRemoteProtocol {
  const value = remoteUrl?.trim() || "";
  if (/^https:\/\//i.test(value)) return "https";
  if (/^http:\/\//i.test(value)) return "http";
  if (/^(?:ssh:\/\/|git:\/\/)/i.test(value) || /^[^/@\s]+@[^:\s]+:.+/.test(value)) return "ssh";
  if (/^(?:file:\/\/|\/|\.\.?\/|[A-Za-z]:[\\/])/.test(value)) return "local";
  return "unknown";
}

export function prepareGitPushEnvironment(
  protocol: GitRemoteProtocol,
  sourceEnv: NodeJS.ProcessEnv = process.env
): GitPushEnvironment {
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C",
    LANG: "C"
  };
  const proxyKeys: string[] = [];
  for (const key of PROXY_KEYS) {
    const value = sourceEnv[key];
    if (value?.trim()) {
      env[key] = value;
      proxyKeys.push(key);
    }
  }

  if (protocol === "https") {
    const proxy = firstNonEmpty(sourceEnv, ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]);
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.https_proxy = proxy;
      return { env, transport: "https_wsl_proxy", proxy_available: true, proxy_keys: proxyKeys };
    }
    return { env, transport: "https_direct", proxy_available: false, proxy_keys: proxyKeys };
  }

  if (protocol === "http") {
    const proxy = firstNonEmpty(sourceEnv, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy"]);
    if (proxy) {
      env.HTTP_PROXY = proxy;
      env.http_proxy = proxy;
      return { env, transport: "http_wsl_proxy", proxy_available: true, proxy_keys: proxyKeys };
    }
    return { env, transport: "http_direct", proxy_available: false, proxy_keys: proxyKeys };
  }

  if (protocol === "ssh") return { env, transport: "ssh", proxy_available: false, proxy_keys: proxyKeys };
  if (protocol === "local") return { env, transport: "local", proxy_available: false, proxy_keys: proxyKeys };
  return { env, transport: "unknown", proxy_available: false, proxy_keys: proxyKeys };
}

function failureText(result: GitPushCommandResult): string {
  return [result.stderr, result.stdout, result.error].filter(Boolean).join("\n").toLowerCase();
}

function redactGitPushResult(result: GitPushCommandResult, sourceEnv: NodeJS.ProcessEnv): GitPushCommandResult {
  const secrets = PROXY_KEYS.map((key) => sourceEnv[key]?.trim()).filter((value): value is string => Boolean(value));
  const redact = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    let next = value;
    for (const secret of secrets) next = next.split(secret).join("[REDACTED_PROXY]");
    return next.replace(/\b((?:https?|socks5h?):\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
  };
  return {
    ...result,
    stdout: redact(result.stdout) ?? "",
    stderr: redact(result.stderr) ?? "",
    ...(result.error !== undefined ? { error: redact(result.error) } : {})
  };
}

export function classifyGitPushFailure(
  result: GitPushCommandResult,
  proxyAvailable: boolean
): GitPushFailureClassification {
  const text = failureText(result);

  if (/authentication failed|could not read (?:user(?:name)?|password)|terminal prompts disabled|permission denied \(publickey\)|invalid username or password|access denied|repository not found|(?:http|error):?\s*(?:401|403)\b/.test(text)) {
    return { error_code: "failed_authentication", retryable: false };
  }
  if (/non-fast-forward|fetch first|failed to push some refs|\[rejected\]|remote contains work|stale info/.test(text)) {
    return { error_code: "failed_non_fast_forward", retryable: false };
  }
  if (/remote rejected|hook declined|remote:.*rejected/.test(text)) {
    return { error_code: "failed_remote_rejected", retryable: false };
  }
  if (
    /could not resolve proxy|unable to connect to proxy|proxy connect aborted|proxy authentication required|\b407\b|failed to connect to .*proxy/.test(text)
    || (proxyAvailable && /failed to connect to (?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|connection refused.*(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(text))
  ) {
    return { error_code: "failed_proxy_unavailable", retryable: false };
  }
  if (/requested url returned error:\s*5\d\d|http code\s*=\s*5\d\d|internal server error|service unavailable|bad gateway|gateway timeout|remote:.*\b(?:500|502|503|504)\b/.test(text)) {
    return { error_code: "failed_remote_service", retryable: false };
  }
  if (/ssl certificate problem|certificate verify failed|unable to get local issuer certificate|self signed certificate|schannel.*certificate/.test(text)) {
    return { error_code: "failed_tls", retryable: false };
  }
  if (/tls connection was non-properly terminated|gnutls_handshake/.test(text) && !/gnutls recv error/.test(text)) {
    return { error_code: "failed_tls", retryable: true };
  }
  if (/could not resolve host|temporary failure in name resolution|name resolution/.test(text)) {
    return { error_code: "failed_dns", retryable: true };
  }
  if (/tls connection was non-properly terminated|gnutls_handshake|connection reset|recv failure|operation timed out|timed out|\btimeout\b|temporary failure in name resolution|could not resolve host|remote end hung up unexpectedly|unexpected disconnect|rpc failed|http\/2 stream .*not closed cleanly|connection was aborted|network is unreachable|connection refused|failed to connect|empty reply from server|early eof|etimedout|econnreset/.test(text)) {
    if (/gnutls recv error/.test(text)) return { error_code: "failed_network", retryable: false };
    if (proxyAvailable && /proxy/.test(text)) return { error_code: "failed_proxy_unavailable", retryable: false };
    return { error_code: "failed_network", retryable: false };
  }
  return { error_code: "failed_unknown", retryable: false };
}

export function executeGitPush(options: {
  protocol: GitRemoteProtocol;
  sourceEnv?: NodeJS.ProcessEnv;
  run: GitPushRunner;
  args?: string[];
}): GitPushExecutionResult {
  const prepared = prepareGitPushEnvironment(options.protocol, options.sourceEnv ?? process.env);
  const pushStartedMs = Date.now();
  const pushStartedAt = new Date(pushStartedMs).toISOString();
  const rawResult = options.run(options.args ?? ["push"], { env: prepared.env, timeoutMs: PUSH_TIMEOUT_MS });
  const result = redactGitPushResult(rawResult, prepared.env);
  const gitProcessExitedMs = Date.now();
  const gitProcessExitedAt = new Date(gitProcessExitedMs).toISOString();
  const timing = {
    push_started_at: pushStartedAt,
    git_process_exited_at: gitProcessExitedAt,
    push_duration_ms: Math.max(0, gitProcessExitedMs - pushStartedMs)
  };
  if (result.ok) {
    return {
      ok: true,
      attempts: 1,
      transport: prepared.transport,
      proxy_available: prepared.proxy_available,
      http_version_fallback_used: false,
      ...timing,
      final_result: result
    };
  }

  const failure = classifyGitPushFailure(rawResult, prepared.proxy_available);
  if (failure.retryable) {
    const rawRetry = options.run(options.args ?? ["push"], { env: prepared.env, timeoutMs: PUSH_TIMEOUT_MS });
    const retry = redactGitPushResult(rawRetry, prepared.env);
    const retryMs = Date.now();
    if (retry.ok) return { ok: true, attempts: 2, transport: prepared.transport, proxy_available: prepared.proxy_available, http_version_fallback_used: false, ...timing, git_process_exited_at: new Date(retryMs).toISOString(), push_duration_ms: Math.max(0, retryMs - pushStartedMs), final_result: retry };
    const retryFailure = classifyGitPushFailure(rawRetry, prepared.proxy_available);
    return { ok: false, attempts: 2, transport: prepared.transport, proxy_available: prepared.proxy_available, http_version_fallback_used: false, ...timing, git_process_exited_at: new Date(retryMs).toISOString(), push_duration_ms: Math.max(0, retryMs - pushStartedMs), final_result: retry, error_code: retryFailure.error_code };
  }
  return {
    ok: false,
    attempts: 1,
    transport: prepared.transport,
    proxy_available: prepared.proxy_available,
    http_version_fallback_used: false,
    ...timing,
    final_result: result,
    error_code: failure.error_code
  };
}
