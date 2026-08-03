import type {
  BrowserAccessibilityNode,
  BrowserFormSummary,
  BrowserFrameSummary,
  BrowserLayoutIssue,
  BrowserObservationPagination,
  BrowserRegionSummary,
  BrowserSemanticElement,
  BrowserTableSummary
} from "./playwright-adapter.js";

export interface NativeCdpPageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface NativeCdpReadonlyObservation {
  url: string;
  title: string;
  readyState: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxX: number; maxY: number };
  text: string;
  source: "native_cdp";
  pageId: string;
  documentVersion: string;
  pageRevisionSeed: string;
  frames: BrowserFrameSummary[];
  pagination: BrowserObservationPagination;
  regions: BrowserRegionSummary[];
  elements: BrowserSemanticElement[];
  tables: BrowserTableSummary[];
  forms: BrowserFormSummary[];
  issues: BrowserLayoutIssue[];
  accessibility: BrowserAccessibilityNode[];
  domSnapshotNodeCount?: number;
  truncated: boolean;
}

export interface NativeCdpReadonlyClient {
  listPageTargets(cdpUrl: string, timeoutMs: number): Promise<NativeCdpPageTarget[]>;
  findAuthorizedTarget(cdpUrl: string, authorizationId: string, timeoutMs: number): Promise<NativeCdpPageTarget | undefined>;
  observeTarget(target: NativeCdpPageTarget, options: {
    scope?: "viewport" | "document" | "selector";
    selector?: string;
    maxNodes: number;
    nodeOffset?: number;
    textOffset?: number;
    maxTextChars: number;
    timeoutMs: number;
  }): Promise<NativeCdpReadonlyObservation>;
}

function boundedTimeout(value: number, fallback = 5_000): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(250, Math.min(Math.floor(value), 30_000));
}

function jsonListUrl(cdpUrl: string): string {
  const url = new URL(cdpUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Native CDP read-only fallback requires an HTTP(S) CDP endpoint.");
  }
  url.pathname = "/json/list";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTarget(value: unknown): NativeCdpPageTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = String(raw.id ?? "").trim();
  const type = String(raw.type ?? "").trim();
  const webSocketDebuggerUrl = String(raw.webSocketDebuggerUrl ?? "").trim();
  if (!id || type !== "page" || !webSocketDebuggerUrl) return undefined;
  return {
    id,
    type,
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    webSocketDebuggerUrl
  };
}

async function evaluateTarget<T>(target: NativeCdpPageTarget, expression: string, timeoutMs: number): Promise<T> {
  const timeout = boundedTimeout(timeoutMs);
  return await new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* no-op */ }
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Native CDP evaluation timed out for ${target.url || target.id}.`))), timeout);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
    socket.addEventListener("message", (event) => {
      let payload: any;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload?.id !== 1) return;
      if (payload.error) {
        finish(() => reject(new Error(String(payload.error.message ?? "Native CDP evaluation failed."))));
        return;
      }
      if (payload.result?.exceptionDetails) {
        const text = payload.result.exceptionDetails.text
          ?? payload.result.exceptionDetails.exception?.description
          ?? "Native CDP page expression failed.";
        finish(() => reject(new Error(String(text))));
        return;
      }
      finish(() => resolve(payload.result?.result?.value as T));
    });
    socket.addEventListener("error", () => finish(() => reject(new Error(`Native CDP websocket failed for ${target.url || target.id}.`))));
  });
}

export function nativeCdpReadonlyObservationExpression(options: {
  scope?: "viewport" | "document" | "selector";
  selector?: string;
  maxNodes: number;
  nodeOffset?: number;
  textOffset?: number;
  maxTextChars: number;
}): string {
  const input = JSON.stringify(options);
  return `(() => {
    const options = ${input};
    const doc = document;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const contexts = [];
    const frames = [];
    const seenRoots = new Set();
    const addContext = (root, frameId, parentFrameId, origin, shadowRoot, boundary) => {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);
      contexts.push({ root, frameId, parentFrameId, origin, shadowRoot });
      const rect = boundary && boundary.getBoundingClientRect ? boundary.getBoundingClientRect() : undefined;
      frames.push({
        frameId,
        parentFrameId,
        origin,
        sameOrigin: true,
        shadowRoot,
        readable: true,
        visibleBounds: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined
      });
      const descendants = Array.from(root.querySelectorAll("*"));
      descendants.forEach((element, index) => {
        if (element.shadowRoot) addContext(element.shadowRoot, frameId + ":shadow:" + index, frameId, origin, "open");
        if (element.tagName.toLowerCase() !== "iframe") return;
        const childFrameId = frameId + ":iframe:" + index;
        let childRoot = null;
        let childOrigin = "opaque";
        try {
          childRoot = element.contentDocument && element.contentDocument.body;
          childOrigin = (element.contentWindow && element.contentWindow.location.origin) || origin;
        } catch {
          try { childOrigin = new URL(element.src, location.href).origin; } catch { childOrigin = "opaque"; }
        }
        if (childRoot) addContext(childRoot, childFrameId, frameId, childOrigin, "none", element);
        else {
          const childRect = element.getBoundingClientRect();
          frames.push({ frameId: childFrameId, parentFrameId: frameId, origin: childOrigin, sameOrigin: false, shadowRoot: "none", readable: false, visibleBounds: { x: Math.round(childRect.x), y: Math.round(childRect.y), width: Math.round(childRect.width), height: Math.round(childRect.height) } });
        }
      });
    };
    addContext(doc.body, "main", undefined, location.origin, "none");
    let scopedRoot;
    let scopedFrameId = "main";
    if (options.scope === "selector") {
      for (const context of contexts) {
        const match = context.root.querySelector(options.selector || "");
        if (match) { scopedRoot = match; scopedFrameId = context.frameId; break; }
      }
      if (!scopedRoot) throw new Error("Observation selector not found: " + String(options.selector || ""));
    }
    const activeContexts = scopedRoot ? [{ root: scopedRoot, frameId: scopedFrameId, origin: location.origin, shadowRoot: "none" }] : contexts;
    const rawText = activeContexts.map((context) => String(context.root.innerText || context.root.textContent || "").replace(/\\r/g, "")).filter(Boolean).join("\\n");
    const maxTextChars = Math.max(1000, Math.min(Number(options.maxTextChars) || 20000, 80000));
    const maxNodes = Math.max(1, Math.min(Number(options.maxNodes) || 300, 1000));
    const nodeOffset = Math.max(0, Math.floor(Number(options.nodeOffset) || 0));
    const textOffset = Math.max(0, Math.floor(Number(options.textOffset) || 0));
    const text = rawText.slice(textOffset, textOffset + maxTextChars);
    const clean = (value, limit = 500) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
    const semanticSelector = "a,button,input,textarea,select,iframe,[role],[aria-modal='true'],[contenteditable='true'],summary,[tabindex],table,form,nav,main,header,footer,aside,section,h1,h2,h3,img";
    const candidates = [];
    for (const context of activeContexts) {
      const found = Array.from(context.root.querySelectorAll(semanticSelector));
      if (context.root.matches && context.root.matches(semanticSelector)) found.unshift(context.root);
      for (const element of found) candidates.push({ element, frameId: context.frameId, contextLabel: context.shadowRoot === "open" ? "open-shadow-root" : context.frameId });
    }
    const elements = [];
    const regions = [];
    const accessibility = [];
    for (let index = nodeOffset; index < Math.min(candidates.length, nodeOffset + maxNodes); index += 1) {
      const candidate = candidates[index];
      const element = candidate.element;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
      if (options.scope === "viewport" && (!visible || !inViewport)) continue;
      const tagName = element.tagName.toLowerCase();
      const inferredRoles = { nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", button: "button", a: "link", table: "table", form: "form" };
      const role = clean(element.getAttribute("role") || inferredRoles[tagName] || "", 80) || undefined;
      const elementText = clean(element.innerText || element.textContent, 500);
      const name = clean(element.getAttribute("aria-label"), 200) || clean(element.getAttribute("title"), 200) || (tagName === "input" ? clean(element.placeholder, 200) : "") || elementText.slice(0, 200) || undefined;
      const inputType = clean(element.getAttribute("type"), 80) || undefined;
      const sensitive = tagName === "input" && (inputType === "password" || /password|token|secret|authorization|cookie|cc-/i.test(String(element.name || "") + " " + String(element.autocomplete || "")));
      const valueState = ["input", "textarea", "select"].includes(tagName) ? (sensitive ? "masked" : clean(element.value, 1) ? "filled" : "empty") : undefined;
      const ref = "r" + (index + 1);
      elements.push({
        ref,
        selector: "readonly:" + ref,
        role,
        name,
        id: clean(element.id, 200) || undefined,
        tagName,
        text: elementText || undefined,
        type: inputType,
        href: tagName === "a" ? clean(element.href, 500) || undefined : undefined,
        placeholder: ["input", "textarea"].includes(tagName) ? clean(element.placeholder, 200) || undefined : undefined,
        valueState,
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        selected: element.getAttribute("aria-selected") === null ? undefined : element.getAttribute("aria-selected") === "true",
        expanded: element.getAttribute("aria-expanded") === null ? undefined : element.getAttribute("aria-expanded") === "true",
        disabled: "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true",
        readonly: "readOnly" in element ? Boolean(element.readOnly) : undefined,
        visible,
        inViewport,
        editable: false,
        clickable: false,
        source: "native_cdp",
        actionable: false,
        frameId: candidate.frameId,
        context: candidate.contextLabel,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      });
      accessibility.push({ role, name, description: clean(element.getAttribute("aria-description"), 500) || undefined, ignored: false });
      if (["nav", "main", "header", "footer", "aside", "section"].includes(tagName) || ["navigation", "main", "banner", "contentinfo", "complementary", "region"].includes(role || "")) regions.push({ ref, role: role || tagName, name, text: elementText.slice(0, 500) || undefined });
    }
    const tables = [];
    for (const table of activeContexts.flatMap((context) => Array.from(context.root.querySelectorAll("table"))).slice(0, 20)) {
      const tableIndex = candidates.findIndex((candidate) => candidate.element === table);
      const rows = Array.from(table.querySelectorAll("tr"));
      const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((cell) => clean(cell.textContent, 200));
      const sampleRows = rows.slice(headers.length ? 1 : 0, 10 + (headers.length ? 1 : 0)).map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => clean(cell.textContent, 300)));
      const scrollHost = table.parentElement && table.parentElement.scrollHeight > table.parentElement.clientHeight ? table.parentElement : table;
      const virtual = scrollHost.scrollHeight > scrollHost.clientHeight + 1 || table.hasAttribute("aria-rowcount");
      const estimatedTotal = Number(table.getAttribute("aria-rowcount")) || undefined;
      tables.push({ ref: "r" + (Math.max(0, tableIndex) + 1), headers, rowCount: rows.length - (headers.length ? 1 : 0), sampleRows, virtual, loadedStart: 0, loadedEnd: Math.max(0, rows.length - (headers.length ? 1 : 0)), estimatedTotal, possibleMore: Boolean(virtual && (!estimatedTotal || rows.length < estimatedTotal)) });
    }
    const forms = [];
    for (const form of activeContexts.flatMap((context) => Array.from(context.root.querySelectorAll("form"))).slice(0, 20)) {
      const formIndex = candidates.findIndex((candidate) => candidate.element === form);
      const fields = Array.from(form.querySelectorAll("input,textarea,select")).slice(0, 100).map((field) => {
        const fieldIndex = candidates.findIndex((candidate) => candidate.element === field);
        const fieldType = clean(field.getAttribute("type"), 80) || field.tagName.toLowerCase();
        const sensitive = fieldType === "password" || /password|token|secret|authorization|cookie|cc-/i.test(String(field.name || "") + " " + String(field.autocomplete || ""));
        return { ref: fieldIndex >= 0 ? "r" + (fieldIndex + 1) : undefined, name: clean(field.name || field.getAttribute("aria-label") || field.placeholder, 200) || undefined, type: fieldType, required: Boolean(field.required), disabled: Boolean(field.disabled), valueState: sensitive ? "masked" : clean(field.value, 1) ? "filled" : "empty" };
      });
      forms.push({ ref: "r" + (Math.max(0, formIndex) + 1), fieldCount: fields.length, fields });
    }
    const nextNodeOffset = nodeOffset + maxNodes < candidates.length ? nodeOffset + maxNodes : undefined;
    const nextTextOffset = textOffset + text.length < rawText.length ? textOffset + text.length : undefined;
    const documentVersion = String(performance.timeOrigin) + ":" + location.origin + ":" + doc.characterSet;
    return {
      url: location.href,
      title: doc.title,
      readyState: doc.readyState,
      viewport: { width: viewportWidth, height: viewportHeight },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxX: Math.max(0, doc.documentElement.scrollWidth - viewportWidth),
        maxY: Math.max(0, doc.documentElement.scrollHeight - viewportHeight)
      },
      text,
      source: "native_cdp",
      pageId: location.origin + location.pathname,
      documentVersion,
      pageRevisionSeed: doc.title + "|" + doc.readyState + "|" + doc.getElementsByTagName("*").length + "|" + rawText.length + "|" + rawText.slice(0, 1024) + "|" + rawText.slice(-1024),
      frames,
      pagination: { nodeOffset, nextNodeOffset, totalNodes: candidates.length, textOffset, nextTextOffset, totalTextChars: rawText.length, hasMore: nextNodeOffset !== undefined || nextTextOffset !== undefined },
      regions,
      elements,
      tables,
      forms,
      issues: [],
      accessibility,
      domSnapshotNodeCount: doc.getElementsByTagName("*").length,
      truncated: nextNodeOffset !== undefined || nextTextOffset !== undefined
    };
  })()`;
}

export function createNativeCdpReadonlyClient(): NativeCdpReadonlyClient {
  return {
    async listPageTargets(cdpUrl, timeoutMs) {
      const payload = await fetchJson(jsonListUrl(cdpUrl), timeoutMs);
      if (!Array.isArray(payload)) return [];
      return payload.map(normalizeTarget).filter((target): target is NativeCdpPageTarget => Boolean(target));
    },

    async findAuthorizedTarget(cdpUrl, authorizationId, timeoutMs) {
      const targets = await this.listPageTargets(cdpUrl, timeoutMs);
      for (const target of targets) {
        const matched = await evaluateTarget<boolean>(
          target,
          `document.documentElement?.getAttribute("data-codexpro-authorization") === ${JSON.stringify(authorizationId)}`,
          Math.min(timeoutMs, 5_000)
        ).catch(() => false);
        if (matched) return target;
      }
      return undefined;
    },

    async observeTarget(target, options) {
      return await evaluateTarget<NativeCdpReadonlyObservation>(
        target,
        nativeCdpReadonlyObservationExpression(options),
        options.timeoutMs
      );
    }
  };
}
