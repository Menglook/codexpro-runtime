import { createHash } from "node:crypto";
import type {
  BrowserFrameSummary,
  BrowserObservationPagination,
  BrowserSemanticElement,
  BrowserSemanticSnapshotData
} from "../adapters/playwright-adapter.js";

export const BROWSER_SEMANTIC_SNAPSHOT_VERSION = 3;
export const BROWSER_DEFAULT_SPACE_ID = "default";

export interface BrowserSnapshotV3Metadata {
  snapshotVersion: 3;
  spaceId: string;
  pageId: string;
  pageRevision: string;
  documentVersion: string;
  source: "playwright" | "native_cdp";
  redacted: true;
  frames: BrowserFrameSummary[];
  pagination: BrowserObservationPagination & {
    chunkIndex: number;
    nextCursor?: string;
  };
  evidencePath?: string;
}

function compact(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

export function semanticPageId(url: string): string {
  try {
    const parsed = new URL(url);
    return sha256(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return sha256(url);
  }
}

export function semanticPageRevision(data: BrowserSemanticSnapshotData): string {
  const pagination = data.pagination ?? {
    nodeOffset: 0,
    totalNodes: data.elements?.length ?? 0,
    textOffset: 0,
    totalTextChars: data.text?.length ?? 0,
    hasMore: Boolean(data.truncated)
  };
  return sha256({
    page_id: data.pageId || semanticPageId(data.url),
    document_version: data.documentVersion,
    revision_seed: data.pageRevisionSeed,
    total_nodes: pagination.totalNodes,
    total_text_chars: pagination.totalTextChars
  });
}

export function elementIdentitySignature(element: BrowserSemanticElement, pageId: string): string {
  return sha256({
    page_id: pageId,
    frame_id: element.frameId ?? "main",
    role: compact(element.role),
    accessible_name: compact(element.name),
    stable_attributes: {
      id: compact(element.id),
      type: compact(element.type),
      placeholder: compact(element.placeholder),
      href: compact(element.href)
    },
    context: compact(element.context ?? element.containerText),
    ancestor: {
      role: compact(element.containerRole),
      ref: compact(element.containerRef)
    }
  });
}

export function enrichSemanticSnapshotData(data: BrowserSemanticSnapshotData): BrowserSemanticSnapshotData & { pageRevision: string } {
  const pageId = semanticPageId(data.url);
  const source = data.source ?? "playwright";
  const documentVersion = data.documentVersion || sha256(`${data.url}|${data.title}|legacy-document`);
  const rawRevisionSeed = data.pageRevisionSeed || `${data.title}|${data.readyState}|${data.domSnapshotNodeCount ?? data.elements.length}|${data.text.length}`;
  const pageRevisionSeed = rawRevisionSeed.startsWith("sha256:") ? rawRevisionSeed : sha256(rawRevisionSeed);
  const pagination = data.pagination ?? {
    nodeOffset: 0,
    totalNodes: data.elements.length,
    textOffset: 0,
    totalTextChars: data.text.length,
    hasMore: Boolean(data.truncated)
  };
  const normalized = { ...data, pageId, source, documentVersion, pageRevisionSeed, pagination };
  const pageRevision = semanticPageRevision(normalized);
  return {
    ...normalized,
    pageId,
    source,
    pageRevision,
    frames: data.frames?.length
      ? data.frames
      : [{ frameId: "main", origin: safeOrigin(data.url), sameOrigin: true, shadowRoot: "none", readable: true }],
    elements: data.elements.map((element) => ({
      ...element,
      source: element.source ?? source,
      actionable: element.actionable ?? (source === "playwright" && element.ref.startsWith("e")),
      pageRevision,
      frameId: element.frameId ?? "main",
      identitySignature: element.identitySignature ?? elementIdentitySignature(element, pageId)
    }))
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "opaque";
  }
}
