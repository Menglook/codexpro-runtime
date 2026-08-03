import {
  AUTHORIZATION_RENEW_WINDOW_MS,
  RECONCILE_ALARM_NAME,
  RECONCILE_PERIOD_MINUTES,
  TRUST_STORAGE_KEY,
  TRUST_UPGRADE_HANDOFF_KEY,
  authorizationNeedsRenewal,
  createTrustRecord,
  httpOrigin,
  matchingServerAuthorization,
  serverAuthorizationMatchesTab,
  trustFromLegacyAuthorization,
  trustFromUpgradeHandoff,
  trustMatchesTab
} from "./trust-policy.js";

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";
const BRIDGE_PROTOCOL_VERSION = "1";
globalThis.__CODEXPRO_BRIDGE_PROTOCOL_VERSION__ = BRIDGE_PROTOCOL_VERSION;

function uuidToken() {
  return crypto.randomUUID().replaceAll("-", "");
}

async function localStorageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function localStorageSet(value) {
  return chrome.storage.local.set(value);
}

async function sessionStorageGet(keys) {
  return chrome.storage.session.get(keys);
}

async function sessionStorageSet(value) {
  return chrome.storage.session.set(value);
}

async function bridgeUrl() {
  const stored = await localStorageGet(["bridgeUrl"]);
  return String(stored.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/$/, "");
}

async function browserInstanceId() {
  const stored = await localStorageGet(["browserInstanceId"]);
  if (stored.browserInstanceId) return stored.browserInstanceId;
  const id = uuidToken();
  await localStorageSet({ browserInstanceId: id });
  return id;
}

async function trustedTabMap() {
  const stored = await sessionStorageGet([TRUST_STORAGE_KEY]);
  if (stored[TRUST_STORAGE_KEY] && typeof stored[TRUST_STORAGE_KEY] === "object") {
    return stored[TRUST_STORAGE_KEY];
  }

  const local = await localStorageGet(["tabAuthorizations", TRUST_UPGRADE_HANDOFF_KEY]);
  const handoff = local[TRUST_UPGRADE_HANDOFF_KEY];
  const legacyMap = local.tabAuthorizations && typeof local.tabAuthorizations === "object"
    ? local.tabAuthorizations
    : {};
  const instanceId = await browserInstanceId();
  const restored = {};

  await chrome.storage.local.remove(["tabAuthorizations", TRUST_UPGRADE_HANDOFF_KEY]);
  if (handoff?.authorization) {
    const tab = await tabById(Number(handoff.authorization.tabId));
    const trust = trustFromUpgradeHandoff(handoff, tab, instanceId);
    if (trust) restored[String(tab.id)] = trust;
  }

  for (const authorization of Object.values(legacyMap)) {
    const tab = await tabById(Number(authorization?.tabId));
    const trust = trustFromLegacyAuthorization(authorization, tab, instanceId);
    if (!trust || !await pageHasAuthorizationMarker(tab.id, trust.authorizationId)) continue;
    restored[String(tab.id)] = trust;
  }

  await sessionStorageSet({ [TRUST_STORAGE_KEY]: restored });
  return restored;
}

async function saveTrustedTabMap(map) {
  await sessionStorageSet({ [TRUST_STORAGE_KEY]: map });
}

function trustEntries(map) {
  return Object.entries(map || {}).filter(([, trust]) => trust && typeof trust === "object");
}

async function tabById(tabId) {
  return Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined;
}

async function pageHasAuthorizationMarker(tabId, authorizationId) {
  if (!Number.isInteger(tabId) || !authorizationId) return false;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => document.documentElement?.getAttribute("data-codexpro-authorization") === id,
    args: [authorizationId]
  }).catch(() => []);
  return results.some((result) => result?.result === true);
}

async function replacementTabForTrust(trust) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  return tabs.find((tab) => trustMatchesTab(trust, tab));
}

async function trustEntryForTab(map, tab) {
  if (!Number.isInteger(tab?.id)) return null;
  const directKey = String(tab.id);
  const direct = map[directKey];
  if (direct && trustMatchesTab(direct, tab)) return { key: directKey, trust: direct };

  for (const [key, trust] of trustEntries(map)) {
    if (!trustMatchesTab(trust, tab)) continue;
    const storedTabId = Number(trust.tabId ?? key);
    if (storedTabId === tab.id) return { key, trust };
    const storedTab = await tabById(storedTabId);
    if (storedTab) continue;
    return { key, trust };
  }
  return null;
}

async function setPageMarker(tabId, authorizationId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => {
      if (document.documentElement) document.documentElement.setAttribute("data-codexpro-authorization", id);
    },
    args: [authorizationId]
  });
}

async function removePageMarker(tabId, authorizationId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => {
      if (document.documentElement?.getAttribute("data-codexpro-authorization") === id) {
        document.documentElement.removeAttribute("data-codexpro-authorization");
      }
    },
    args: [authorizationId]
  }).catch(() => undefined);
}

async function setBadge(tabId, state) {
  const text = state === "trusted" ? "ON" : state === "waiting" ? "…" : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (state === "trusted") {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e7d32" }).catch(() => undefined);
  } else if (state === "waiting") {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b26a00" }).catch(() => undefined);
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
      "x-codexpro-extension-id": chrome.runtime.id,
      "x-codexpro-extension-version": chrome.runtime.getManifest().version,
      "x-codexpro-extension-protocol": BRIDGE_PROTOCOL_VERSION
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Bridge request failed (${response.status})`);
  return payload;
}

async function registerTrustedTab(tab, trust, { force = false } = {}) {
  if (!trustMatchesTab(trust, tab)) throw new Error("Trusted tab moved to a different origin or is no longer available.");
  const baseUrl = await bridgeUrl();
  const instanceId = await browserInstanceId();

  await setPageMarker(tab.id, trust.authorizationId);

  if (!force) {
    try {
      const status = await requestJson(`${baseUrl}/browser-extension/status`);
      const current = matchingServerAuthorization(status.authorizations, trust, instanceId);
      if (
        current
        && serverAuthorizationMatchesTab(current, tab)
        && !authorizationNeedsRenewal(current, Date.now(), AUTHORIZATION_RENEW_WINDOW_MS)
      ) {
        return createTrustRecord(tab, current, trust);
      }
    } catch {
      // The local Bridge may be restarting. Fall through to challenge/authorize;
      // if it is still unavailable the caller retains trust and retries later.
    }
  }

  const challengeResult = await requestJson(`${baseUrl}/browser-extension/challenge?browser_instance_id=${encodeURIComponent(instanceId)}`);
  const result = await requestJson(`${baseUrl}/browser-extension/authorize`, {
    method: "POST",
    body: JSON.stringify({
      challenge: challengeResult.challenge,
      authorization_id: trust.authorizationId,
      browser_instance_id: instanceId,
      tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url,
      title: tab.title || ""
    })
  });
  return createTrustRecord(tab, result.authorization, trust);
}

async function authorizeTab(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId) || !httpOrigin(tab.url)) {
    throw new Error("Open an http/https page before trusting it.");
  }
  const map = await trustedTabMap();
  const previous = map[String(tab.id)];
  if (previous && previous.origin !== httpOrigin(tab.url)) {
    await releaseTab(tab.id);
  }
  const currentMap = await trustedTabMap();
  const existingEntry = await trustEntryForTab(currentMap, tab);
  const existing = existingEntry?.trust;
  const authorizationId = existing?.authorizationId || uuidToken();
  const provisional = createTrustRecord(tab, { authorizationId }, existing || {});
  try {
    const trust = await registerTrustedTab(tab, provisional, { force: true });
    if (existingEntry?.key && existingEntry.key !== String(tab.id)) delete currentMap[existingEntry.key];
    currentMap[String(tab.id)] = trust;
    await saveTrustedTabMap(currentMap);
    await setBadge(tab.id, "trusted");
    return trust.authorization;
  } catch (error) {
    await removePageMarker(tab.id, authorizationId);
    throw error;
  }
}

async function releaseTab(tabId) {
  const map = await trustedTabMap();
  let key = String(tabId);
  let trust = map[key];
  if (!trust) {
    const tab = await tabById(tabId);
    const entry = tab ? await trustEntryForTab(map, tab) : null;
    if (entry) {
      key = entry.key;
      trust = entry.trust;
    }
  }
  if (!trust) {
    await setBadge(tabId, "off");
    return false;
  }
  const baseUrl = await bridgeUrl();
  await requestJson(`${baseUrl}/browser-extension/release`, {
    method: "POST",
    body: JSON.stringify({ authorization_id: trust.authorizationId })
  }).catch(() => undefined);
  await removePageMarker(tabId, trust.authorizationId);
  delete map[key];
  if (key !== String(tabId)) delete map[String(tabId)];
  await saveTrustedTabMap(map);
  await setBadge(tabId, "off");
  return true;
}

async function reconcileTrustedTab(tabId) {
  const map = await trustedTabMap();
  let key = String(tabId);
  let trust = map[key];
  let tab = await tabById(tabId);
  if (!trust && tab) {
    const entry = await trustEntryForTab(map, tab);
    if (entry) {
      key = entry.key;
      trust = entry.trust;
    }
  }
  if (!trust) return null;
  if (!tab) {
    tab = await replacementTabForTrust(trust);
  }
  if (!tab || !trustMatchesTab(trust, tab)) {
    await releaseTab(Number(key));
    return null;
  }
  if (key !== String(tab.id)) {
    const moved = createTrustRecord(
      tab,
      trust.authorization || { authorizationId: trust.authorizationId, browserInstanceId: trust.browserInstanceId },
      trust
    );
    delete map[key];
    map[String(tab.id)] = moved;
    await saveTrustedTabMap(map);
    key = String(tab.id);
    trust = moved;
  }
  try {
    const renewed = await registerTrustedTab(tab, trust);
    map[String(tab.id)] = renewed;
    await saveTrustedTabMap(map);
    await setBadge(Number(tab.id), "trusted");
    return renewed;
  } catch {
    // Preserve the browser-session trust while CodexPro is temporarily offline.
    // The one-minute alarm will retry and re-register after the service returns.
    await setBadge(Number(tab.id), "waiting");
    return trust;
  }
}

let reconcileQueue = Promise.resolve();

function queueReconcile(tabId) {
  reconcileQueue = reconcileQueue.catch(() => undefined).then(async () => {
    if (Number.isInteger(tabId)) {
      await reconcileTrustedTab(tabId);
      return;
    }
    const map = await trustedTabMap();
    for (const [id, trust] of trustEntries(map)) await reconcileTrustedTab(Number(trust.tabId ?? id));
  });
  return reconcileQueue;
}

async function ensureReconcileAlarm() {
  const alarm = await chrome.alarms.get(RECONCILE_ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(RECONCILE_ALARM_NAME, {
      delayInMinutes: RECONCILE_PERIOD_MINUTES,
      periodInMinutes: RECONCILE_PERIOD_MINUTES
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "authorize-active-tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const authorization = await authorizeTab(tab);
      sendResponse({ ok: true, authorization, trusted: true });
      return;
    }
    if (message?.type === "release-active-tab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const released = Number.isInteger(tab?.id) ? await releaseTab(tab.id) : false;
      sendResponse({ ok: true, released });
      return;
    }
    if (message?.type === "get-active-status") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (Number.isInteger(tab?.id)) await queueReconcile(tab.id);
      const map = await trustedTabMap();
      const trust = Number.isInteger(tab?.id) ? map[String(tab.id)] || null : null;
      sendResponse({
        ok: true,
        tab,
        trusted: Boolean(trust),
        trust,
        authorization: trust?.authorization || null,
        bridgeUrl: await bridgeUrl()
      });
      return;
    }
    if (message?.type === "set-bridge-url") {
      const normalized = new URL(String(message.url || ""));
      if (normalized.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(normalized.hostname)) {
        throw new Error("Bridge URL must use local http://127.0.0.1 or http://localhost.");
      }
      await localStorageSet({ bridgeUrl: normalized.origin });
      await queueReconcile();
      sendResponse({ ok: true, bridgeUrl: normalized.origin });
      return;
    }
    sendResponse({ ok: false, error: "Unsupported request." });
  })().catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void queueReconcile(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseTab(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void (async () => {
    const map = await trustedTabMap();
    const trust = map[String(removedTabId)];
    if (!trust) return;
    const tab = await chrome.tabs.get(addedTabId).catch(() => undefined);
    if (!tab || !trustMatchesTab(trust, tab)) {
      await releaseTab(removedTabId);
      return;
    }
    delete map[String(removedTabId)];
    map[String(addedTabId)] = { ...trust, tabId: addedTabId, windowId: tab.windowId, url: tab.url, title: tab.title || trust.title };
    await saveTrustedTabMap(map);
    await queueReconcile(addedTabId);
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM_NAME) void queueReconcile();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureReconcileAlarm().then(() => queueReconcile());
});

chrome.runtime.onStartup.addListener(() => {
  // storage.session is cleared when the dedicated Chrome process exits, so a
  // fresh Chrome runtime intentionally requires a new explicit trust click.
  void ensureReconcileAlarm().then(() => queueReconcile());
});

void ensureReconcileAlarm().then(() => queueReconcile());
