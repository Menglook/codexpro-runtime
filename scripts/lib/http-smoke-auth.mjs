export function inheritedHttpToken(env = process.env) {
  return env.CODEXPRO_HTTP_TOKEN?.trim()
    || env.CODEBASE_BRIDGE_HTTP_TOKEN?.trim()
    || '';
}

export function withInheritedHttpAuthorization(options = {}, env = process.env) {
  const token = inheritedHttpToken(env);
  if (!token) return options;

  const headers = new Headers(options.headers ?? {});
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return { ...options, headers };
}

export function authenticatedLoopbackFetch(url, options = {}, env = process.env) {
  return fetch(url, withInheritedHttpAuthorization(options, env));
}
