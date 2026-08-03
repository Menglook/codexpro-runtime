export const TRUST_STORAGE_KEY = "trustedTabAuthorizations";
export const TRUST_UPGRADE_HANDOFF_KEY = "trustedTabUpgradeHandoffV1";
export const TRUST_UPGRADE_HANDOFF_TTL_MS = 2 * 60_000;
export const RECONCILE_ALARM_NAME = "codexpro-browser-trust-reconcile";
export const RECONCILE_PERIOD_MINUTES = 1;
export const AUTHORIZATION_RENEW_WINDOW_MS = 10 * 60_000;

export function httpOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function authorizationNeedsRenewal(authorization, nowMs = Date.now(), renewWindowMs = AUTHORIZATION_RENEW_WINDOW_MS) {
  const expiresAtMs = Date.parse(String(authorization?.expiresAt || ""));
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + renewWindowMs;
}

export function trustMatchesTab(trust, tab) {
  if (!trust || !Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return false;
  const origin = httpOrigin(tab.url);
  const trustedWindowId = Number(trust.windowId);
  const sameWindow = !Number.isInteger(trustedWindowId) || trustedWindowId < 0 || trustedWindowId === tab.windowId;
  return Boolean(origin && origin === trust.origin && sameWindow);
}

export function serverAuthorizationMatchesTab(authorization, tab) {
  return Boolean(
    authorization
      && Number.isInteger(tab?.id)
      && Number.isInteger(tab?.windowId)
      && Number(authorization.tabId) === tab.id
      && Number(authorization.windowId) === tab.windowId
      && authorization.origin === httpOrigin(tab.url)
  );
}

export function createTrustRecord(tab, authorization, previous = {}) {
  const origin = httpOrigin(tab?.url);
  if (!origin) throw new Error("Only http/https tabs can be trusted.");
  const authorizationId = String(authorization?.authorizationId || previous.authorizationId || "").trim();
  if (!authorizationId) throw new Error("Trusted tab authorization id is missing.");
  return {
    authorizationId,
    ...(authorization?.browserInstanceId || previous.browserInstanceId || previous.authorization?.browserInstanceId
      ? { browserInstanceId: String(authorization?.browserInstanceId || previous.browserInstanceId || previous.authorization?.browserInstanceId) }
      : {}),
    tabId: Number(tab.id),
    windowId: Number(tab.windowId),
    origin,
    url: String(tab.url || ""),
    title: String(tab.title || "").slice(0, 500),
    trustedAt: previous.trustedAt || new Date().toISOString(),
    lastRegisteredAt: new Date().toISOString(),
    authorization: authorization || previous.authorization || null
  };
}

export function matchingServerAuthorization(authorizations, trust, browserInstanceId) {
  if (!Array.isArray(authorizations) || !trust) return null;
  return authorizations.find((authorization) =>
    authorization?.authorizationId === trust.authorizationId
    && authorization?.browserInstanceId === browserInstanceId
    && authorization?.origin === trust.origin
  ) || null;
}

export function trustFromLegacyAuthorization(authorization, tab, browserInstanceId, nowMs = Date.now()) {
  if (!authorization || !Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return null;
  const createdAtMs = Date.parse(String(authorization.createdAt || ""));
  const origin = httpOrigin(tab.url);
  const authorizationId = String(authorization.authorizationId || "").trim();
  if (
    authorizationId.length < 16
    || !Number.isFinite(createdAtMs)
    || createdAtMs > nowMs + 5_000
    || authorization.browserInstanceId !== browserInstanceId
    || Number(authorization.tabId) !== tab.id
    || Number(authorization.windowId) !== tab.windowId
    || authorization.origin !== origin
  ) return null;

  try {
    return createTrustRecord(tab, authorization, {
      browserInstanceId,
      trustedAt: authorization.createdAt
    });
  } catch {
    return null;
  }
}

export function trustFromUpgradeHandoff(handoff, tab, browserInstanceId, nowMs = Date.now()) {
  if (!handoff || handoff.version !== 1 || !Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return null;
  const createdAtMs = Date.parse(String(handoff.createdAt || ""));
  const expiresAtMs = Date.parse(String(handoff.expiresAt || ""));
  if (
    !Number.isFinite(createdAtMs)
    || !Number.isFinite(expiresAtMs)
    || createdAtMs > nowMs + 5_000
    || expiresAtMs <= nowMs
    || expiresAtMs - createdAtMs > TRUST_UPGRADE_HANDOFF_TTL_MS + 5_000
  ) return null;

  const authorization = handoff.authorization;
  const origin = httpOrigin(tab.url);
  const authorizationId = String(authorization?.authorizationId || "").trim();
  if (
    authorizationId.length < 16
    || authorization?.browserInstanceId !== browserInstanceId
    || Number(authorization?.tabId) !== tab.id
    || Number(authorization?.windowId) !== tab.windowId
    || authorization?.origin !== origin
  ) return null;

  try {
    return createTrustRecord(tab, authorization, {
      browserInstanceId,
      trustedAt: authorization.createdAt || new Date(createdAtMs).toISOString()
    });
  } catch {
    return null;
  }
}
