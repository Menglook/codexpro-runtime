import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSemanticSnapshot } from "./browser-session.js";
import {
  BROWSER_EVIDENCE_CONFIDENCE_VALUES,
  browserFusedFactSchema,
  type BrowserEvidenceConflict,
  type BrowserFusedFact,
  type BrowserMultimodalEvidence,
  type BrowserObservationEvidenceFact,
  type BrowserVisualEvidence
} from "./evidence-fusion.js";

export const BROWSER_VISUAL_REASONS = ["layout", "image_crop", "responsive", "style", "canvas", "video", "cross_origin_frame", "semantic_empty", "semantic_conflict", "manual"] as const;
export const browserVisualReasonSchema = z.enum(BROWSER_VISUAL_REASONS);

const nonEmpty = z.string().trim().min(1);
const relativePath = nonEmpty.refine((value) => !value.startsWith("/") && !value.replace(/\\/g, "/").split("/").includes(".."), "path must be relative");

export const browserInspectionVisualScopeSchema = z.object({
  kind: z.enum(["viewport", "selector", "region", "frame"]),
  target: z.string().trim().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.kind !== "viewport" && !value.target) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `${value.kind} visual scope requires a stable ref or selector target` });
  }
});
export type BrowserInspectionVisualScope = z.infer<typeof browserInspectionVisualScopeSchema>;

export const browserInspectionResultSchema = z.object({
  version: z.literal(1),
  inspection_id: nonEmpty,
  session_id: nonEmpty,
  space_id: nonEmpty,
  page_id: nonEmpty,
  semantic_snapshot_id: nonEmpty,
  semantic_completeness: z.enum(["complete", "partial", "sampled", "unknown"]),
  visual_requested: z.boolean(),
  visual_reason: browserVisualReasonSchema.nullable(),
  visual_scope: browserInspectionVisualScopeSchema.nullable(),
  facts: z.array(browserFusedFactSchema),
  conflicts: z.array(nonEmpty),
  limitations: z.array(nonEmpty),
  redacted: z.literal(true),
  report_path: relativePath,
  created_at: z.string().datetime()
}).strict().superRefine((value, context) => {
  if (!value.visual_requested && (value.visual_reason !== null || value.visual_scope !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["visual_requested"], message: "semantic-only inspections must not declare visual reason or scope" });
  }
  if (value.visual_requested && (!value.visual_reason || !value.visual_scope)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["visual_requested"], message: "visual inspections require a reason and bounded scope" });
  }
});
export type BrowserInspectionResult = z.infer<typeof browserInspectionResultSchema>;

export interface BrowserObservationRouteDecision {
  semantic_completeness: BrowserInspectionResult["semantic_completeness"];
  visual_requested: boolean;
  visual_reason: typeof BROWSER_VISUAL_REASONS[number] | null;
  visual_scope: BrowserInspectionVisualScope | null;
  reasons: string[];
}

export interface BrowserInspectionArtifacts {
  inspection: BrowserInspectionResult;
  multimodal: BrowserMultimodalEvidence;
  conflicts: BrowserEvidenceConflict[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function firstElementRef(snapshot: BrowserSemanticSnapshot, tagNames: string[]): string | undefined {
  return snapshot.elements.find((element) => tagNames.includes(normalize(element.tagName ?? "")))?.ref;
}

export function semanticSnapshotCompleteness(snapshot: BrowserSemanticSnapshot): BrowserInspectionResult["semantic_completeness"] {
  if (!snapshot.text.trim() && !snapshot.elements.length && !snapshot.tables.length && !(snapshot.accessibility ?? []).length) return "unknown";
  if (snapshot.pagination.hasMore || snapshot.truncated) return "partial";
  if (snapshot.tables.some((table) => table.virtual || table.possibleMore)) return "sampled";
  return "complete";
}

function reasonFromRequest(request: string): typeof BROWSER_VISUAL_REASONS[number] | undefined {
  const value = normalize(request);
  if (/\b(canvas|graphical chart|pixel chart)\b|画布|图形图表/.test(value)) return "canvas";
  if (/\b(video|current frame|subtitle)\b|视频|当前帧|字幕/.test(value)) return "video";
  if (/cross[- ]?origin|iframe|跨域/.test(value)) return "cross_origin_frame";
  if (/image crop|cropp?ed|clipp?ed image|图片裁切|图像裁切/.test(value)) return "image_crop";
  if (/responsive|mobile layout|breakpoint|响应式|移动端布局/.test(value)) return "responsive";
  if (/\b(style|color|font|pixel)\b|样式|颜色|字体/.test(value)) return "style";
  if (/\b(layout|overlap|alignment|spacing)\b|布局|重叠|对齐|间距/.test(value)) return "layout";
  if (/semantic conflict|evidence conflict|语义冲突|证据冲突/.test(value)) return "semantic_conflict";
  if (/\b(screenshot|visual|image)\b|截图|视觉|图片/.test(value)) return "manual";
  return undefined;
}

function inferredScope(reason: typeof BROWSER_VISUAL_REASONS[number], snapshot: BrowserSemanticSnapshot): BrowserInspectionVisualScope {
  if (reason === "canvas") {
    const target = firstElementRef(snapshot, ["canvas"]);
    if (target) return { kind: "selector", target };
  }
  if (reason === "video") {
    const target = firstElementRef(snapshot, ["video"]);
    if (target) return { kind: "selector", target };
  }
  if (reason === "image_crop") {
    const target = firstElementRef(snapshot, ["img", "picture"]);
    if (target) return { kind: "selector", target };
  }
  return { kind: "viewport" };
}

export function routeBrowserObservation(input: {
  request: string;
  snapshot: BrowserSemanticSnapshot;
  visual_reason?: typeof BROWSER_VISUAL_REASONS[number];
  visual_scope?: BrowserInspectionVisualScope;
}): BrowserObservationRouteDecision {
  const completeness = semanticSnapshotCompleteness(input.snapshot);
  let reason = input.visual_reason ?? reasonFromRequest(input.request);
  const reasons: string[] = [];
  if (!reason && completeness === "unknown") reason = "semantic_empty";
  if (!reason) {
    const request = normalize(input.request);
    const asksForFrames = /frame|iframe|跨域|框架/.test(request);
    const unreadableFrame = input.snapshot.frames.some((frame) => !frame.readable || !frame.sameOrigin);
    if (asksForFrames && unreadableFrame) reason = "cross_origin_frame";
  }
  if (!reason) {
    reasons.push("Semantic evidence is sufficient for the requested text, table, form, URL, or structured-fact inspection.");
    return { semantic_completeness: completeness, visual_requested: false, visual_reason: null, visual_scope: null, reasons };
  }
  const scope = browserInspectionVisualScopeSchema.parse(input.visual_scope ?? inferredScope(reason, input.snapshot));
  reasons.push(`Visual evidence is required for ${reason}; semantic observation ${input.snapshot.snapshotId} remains the primary linked evidence.`);
  return { semantic_completeness: completeness, visual_requested: true, visual_reason: reason, visual_scope: scope, reasons };
}

function evidenceRef(snapshot: BrowserSemanticSnapshot): string {
  return `browser_snapshot:${snapshot.snapshotId}`;
}

export function semanticEvidenceFacts(request: string, snapshot: BrowserSemanticSnapshot): BrowserObservationEvidenceFact[] {
  const ref = evidenceRef(snapshot);
  const limitations = snapshot.pagination.hasMore ? ["Additional semantic chunks remain unread."] : [];
  const facts: BrowserObservationEvidenceFact[] = [
    { fact: "page_url", value: snapshot.url, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "page_title", value: snapshot.title, source: "semantic", confidence: snapshot.title ? "high" : "unknown", evidence_refs: [ref], structured: true },
    {
      fact: "requested_content",
      value: snapshot.text.trim() ? snapshot.text.slice(0, 4000) : null,
      source: "semantic",
      confidence: snapshot.text.trim() ? snapshot.pagination.hasMore ? "medium" : "high" : "unknown",
      evidence_refs: [ref],
      category: "text_value",
      limitations
    },
    { fact: "table_count", value: snapshot.tables.length, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "form_count", value: snapshot.forms.length, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true }
  ];
  for (const table of snapshot.tables.slice(0, 10)) {
    facts.push({
      fact: `table:${table.ref}`,
      value: { headers: table.headers.slice(0, 100), sample_rows: table.sampleRows.slice(0, 20) },
      source: "semantic",
      confidence: table.virtual || table.possibleMore ? "medium" : "high",
      evidence_refs: [ref],
      structured: true,
      limitations: table.virtual || table.possibleMore ? ["The table is virtual or sampled; use browser_extract_table before claiming completeness."] : []
    });
  }
  const canvasCount = snapshot.elements.filter((element) => normalize(element.tagName ?? "") === "canvas").length;
  const videoCount = snapshot.elements.filter((element) => normalize(element.tagName ?? "") === "video").length;
  const imageCount = snapshot.elements.filter((element) => ["img", "picture"].includes(normalize(element.tagName ?? ""))).length;
  const crossOriginFrames = snapshot.frames.filter((frame) => !frame.sameOrigin || !frame.readable).length;
  facts.push(
    { fact: "canvas_count", value: canvasCount, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "video_count", value: videoCount, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "image_count", value: imageCount, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "cross_origin_frame_count", value: crossOriginFrames, source: "semantic", confidence: "high", evidence_refs: [ref], structured: true },
    { fact: "layout_issue_count", value: snapshot.issues.length, source: "semantic", confidence: "medium", evidence_refs: [ref], category: "layout" }
  );
  void request;
  return facts;
}

export function visualCaptureEvidenceFact(input: { path: string; reason: typeof BROWSER_VISUAL_REASONS[number]; linked_snapshot_id: string }): BrowserObservationEvidenceFact {
  return {
    fact: "visual_frame_captured",
    value: true,
    source: "visual",
    confidence: "high",
    evidence_refs: [`browser_visual:${input.path}`],
    category: ["layout", "image_crop", "responsive", "style"].includes(input.reason) ? "layout" : input.reason === "canvas" ? "canvas_value" : input.reason === "semantic_empty" ? "semantic_missing" : "text_value",
    limitations: ["The captured frame is evidence only and cannot authorize clicking or any other interaction."]
  };
}

export function inspectionArtifactPaths(reportRoot: string, inspectionId: string): {
  inspection: string;
  multimodal: string;
  conflicts: string;
} {
  const root = `${reportRoot.replace(/\/$/, "")}/inspections/${inspectionId}`;
  return { inspection: `${root}/inspection.json`, multimodal: `${root}/multimodal-evidence.json`, conflicts: `${root}/conflicts.json` };
}

export function createBrowserInspectionResult(input: {
  inspection_id?: string;
  session_id: string;
  space_id: string;
  page_id: string;
  semantic_snapshot_id: string;
  route: BrowserObservationRouteDecision;
  facts: BrowserFusedFact[];
  conflicts: BrowserEvidenceConflict[];
  report_path: string;
  limitations?: string[];
  created_at?: string;
}): BrowserInspectionResult {
  return browserInspectionResultSchema.parse({
    version: 1,
    inspection_id: input.inspection_id ?? `browser-inspection-${randomUUID()}`,
    session_id: input.session_id,
    space_id: input.space_id,
    page_id: input.page_id,
    semantic_snapshot_id: input.semantic_snapshot_id,
    semantic_completeness: input.route.semantic_completeness,
    visual_requested: input.route.visual_requested,
    visual_reason: input.route.visual_reason,
    visual_scope: input.route.visual_scope,
    facts: input.facts,
    conflicts: input.conflicts.map((conflict) => conflict.conflict_id),
    limitations: [...new Set([...(input.limitations ?? []), ...input.route.reasons, ...input.conflicts.flatMap((conflict) => conflict.limitations)])],
    redacted: true,
    report_path: input.report_path,
    created_at: input.created_at ?? new Date().toISOString()
  });
}

export function assertVisualEvidenceCannotAuthorizeInteraction(evidence: BrowserVisualEvidence): void {
  if (evidence.may_authorize_interaction !== false) throw new Error("Visual evidence cannot authorize browser interaction.");
}

