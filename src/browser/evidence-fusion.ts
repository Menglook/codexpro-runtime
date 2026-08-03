import { randomUUID } from "node:crypto";
import { z } from "zod";

export const BROWSER_EVIDENCE_CONFIDENCE_VALUES = ["high", "medium", "low", "unknown"] as const;
export const BROWSER_EVIDENCE_SOURCES = ["semantic", "visual", "network"] as const;
export const BROWSER_EVIDENCE_CONFLICT_TYPES = ["text_value", "layout", "crop", "color", "canvas_value", "semantic_missing", "unresolved"] as const;

const nonEmpty = z.string().trim().min(1);
const relativePath = nonEmpty.refine((value) => !value.startsWith("/") && !value.replace(/\\/g, "/").split("/").includes(".."), "path must be relative");
const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(jsonValueSchema)]));

export const browserFusedFactSchema = z.object({
  fact: nonEmpty,
  value: jsonValueSchema,
  source: z.array(z.enum(BROWSER_EVIDENCE_SOURCES)).min(1).refine((values) => new Set(values).size === values.length),
  confidence: z.enum(BROWSER_EVIDENCE_CONFIDENCE_VALUES),
  semantic_evidence_refs: z.array(nonEmpty),
  visual_evidence_refs: z.array(nonEmpty),
  conflict: z.boolean(),
  limitations: z.array(nonEmpty)
}).strict();
export type BrowserFusedFact = z.infer<typeof browserFusedFactSchema>;

export const browserVisualEvidenceSchema = z.object({
  evidence_ref: nonEmpty,
  reason: z.enum(["layout", "image_crop", "responsive", "style", "canvas", "video", "cross_origin_frame", "semantic_empty", "semantic_conflict", "manual"]),
  scope: nonEmpty,
  image_path: relativePath,
  linked_snapshot_id: nonEmpty,
  may_authorize_interaction: z.literal(false)
}).strict();
export type BrowserVisualEvidence = z.infer<typeof browserVisualEvidenceSchema>;

export const browserMultimodalEvidenceSchema = z.object({
  version: z.literal(1),
  evidence_id: nonEmpty,
  inspection_id: nonEmpty,
  semantic_snapshot_id: nonEmpty,
  visual_evidence: z.array(browserVisualEvidenceSchema),
  facts: z.array(browserFusedFactSchema),
  redacted: z.literal(true),
  created_at: z.string().datetime()
}).strict();
export type BrowserMultimodalEvidence = z.infer<typeof browserMultimodalEvidenceSchema>;

export const browserEvidenceConflictSchema = z.object({
  version: z.literal(1),
  conflict_id: nonEmpty,
  inspection_id: nonEmpty,
  fact: nonEmpty,
  type: z.enum(BROWSER_EVIDENCE_CONFLICT_TYPES),
  semantic_value: jsonValueSchema,
  visual_value: jsonValueSchema,
  resolution: z.enum(["prefer_structured", "prefer_visual", "estimated", "unknown", "human_required"]),
  confidence: z.enum(BROWSER_EVIDENCE_CONFIDENCE_VALUES),
  stop_required: z.boolean(),
  limitations: z.array(nonEmpty),
  evidence_refs: z.array(nonEmpty).min(1),
  created_at: z.string().datetime()
}).strict();
export type BrowserEvidenceConflict = z.infer<typeof browserEvidenceConflictSchema>;

export interface BrowserObservationEvidenceFact {
  fact: string;
  value: JsonValue;
  source: typeof BROWSER_EVIDENCE_SOURCES[number];
  confidence: typeof BROWSER_EVIDENCE_CONFIDENCE_VALUES[number];
  evidence_refs: string[];
  category?: typeof BROWSER_EVIDENCE_CONFLICT_TYPES[number];
  limitations?: string[];
  structured?: boolean;
}

const confidenceRank = { unknown: 0, low: 1, medium: 2, high: 3 } as const;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function valuesEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function strongest(entries: BrowserObservationEvidenceFact[]): BrowserObservationEvidenceFact {
  return [...entries].sort((left, right) => confidenceRank[right.confidence] - confidenceRank[left.confidence])[0];
}

function evidenceRefs(entries: BrowserObservationEvidenceFact[]): string[] {
  return unique(entries.flatMap((entry) => entry.evidence_refs));
}

function resolutionFor(input: {
  inspectionId: string;
  fact: string;
  category: typeof BROWSER_EVIDENCE_CONFLICT_TYPES[number];
  semantic?: BrowserObservationEvidenceFact;
  visual?: BrowserObservationEvidenceFact;
  network?: BrowserObservationEvidenceFact;
  createdAt: string;
}): { value: JsonValue; confidence: BrowserFusedFact["confidence"]; limitation: string; resolution: BrowserEvidenceConflict["resolution"]; stop: boolean } {
  const structured = input.network ?? input.semantic;
  if (["layout", "crop", "color"].includes(input.category) && input.visual) {
    return {
      value: input.visual.value,
      confidence: input.visual.confidence === "high" ? "high" : "medium",
      limitation: "Visual evidence governs rendering, layout, crop, and color conclusions; it does not authorize interaction.",
      resolution: "prefer_visual",
      stop: false
    };
  }
  if (input.category === "canvas_value") {
    if (structured) {
      return {
        value: structured.value,
        confidence: structured.confidence,
        limitation: "Canvas pixels were secondary; the structured page or network fact governs the numeric value.",
        resolution: "prefer_structured",
        stop: false
      };
    }
    return {
      value: input.visual?.value ?? null,
      confidence: input.visual ? "low" : "unknown",
      limitation: "The Canvas value has no structured corroboration and remains an estimate or unknown.",
      resolution: input.visual ? "estimated" : "unknown",
      stop: !input.visual
    };
  }
  if (input.category === "semantic_missing") {
    return {
      value: input.visual?.value ?? null,
      confidence: input.visual ? "low" : "unknown",
      limitation: "Visual presence has no stable DOM identity; interaction requires a new semantic reference or human handoff.",
      resolution: input.visual ? "human_required" : "unknown",
      stop: true
    };
  }
  if (structured) {
    return {
      value: structured.value,
      confidence: structured.confidence === "high" ? "high" : "medium",
      limitation: "Structured DOM or network evidence governs the conflicting text value; visual rendering may be scaled, clipped, or obscured.",
      resolution: "prefer_structured",
      stop: false
    };
  }
  return {
    value: null,
    confidence: "unknown",
    limitation: "The available evidence cannot resolve this fact without guessing.",
    resolution: "unknown",
    stop: true
  };
}

export function fuseBrowserEvidence(input: {
  inspection_id: string;
  semantic_snapshot_id: string;
  evidence: BrowserObservationEvidenceFact[];
  visual_evidence?: BrowserVisualEvidence[];
  created_at?: string;
}): { multimodal: BrowserMultimodalEvidence; facts: BrowserFusedFact[]; conflicts: BrowserEvidenceConflict[] } {
  const createdAt = input.created_at ?? new Date().toISOString();
  const byFact = new Map<string, BrowserObservationEvidenceFact[]>();
  for (const raw of input.evidence) {
    const entry = {
      ...raw,
      fact: raw.fact.trim(),
      evidence_refs: unique(raw.evidence_refs),
      limitations: unique(raw.limitations ?? [])
    };
    if (!entry.fact || !entry.evidence_refs.length) throw new Error("Browser evidence facts require a name and evidence reference.");
    byFact.set(entry.fact, [...(byFact.get(entry.fact) ?? []), entry]);
  }

  const facts: BrowserFusedFact[] = [];
  const conflicts: BrowserEvidenceConflict[] = [];
  for (const [fact, entries] of byFact) {
    const semantic = strongest(entries.filter((entry) => entry.source === "semantic"));
    const visual = strongest(entries.filter((entry) => entry.source === "visual"));
    const network = strongest(entries.filter((entry) => entry.source === "network"));
    const present = [semantic, visual, network].filter((entry): entry is BrowserObservationEvidenceFact => Boolean(entry));
    const distinct = [...new Set(present.map((entry) => JSON.stringify(entry.value)))];
    const category = present.find((entry) => entry.category)?.category ?? "text_value";
    const semanticMissing = category === "semantic_missing" && !semantic && Boolean(visual);
    const isConflict = distinct.length > 1 || semanticMissing;
    const sources = [...new Set(present.map((entry) => entry.source))];
    if (!isConflict) {
      const selected = network ?? semantic ?? visual;
      if (!selected) continue;
      const visualOnlyCanvas = category === "canvas_value" && selected.source === "visual";
      facts.push(browserFusedFactSchema.parse({
        fact,
        value: selected.value,
        source: sources,
        confidence: visualOnlyCanvas ? "low" : sources.length > 1 && selected.confidence !== "unknown" ? "high" : selected.confidence,
        semantic_evidence_refs: evidenceRefs(entries.filter((entry) => entry.source === "semantic" || entry.source === "network")),
        visual_evidence_refs: evidenceRefs(entries.filter((entry) => entry.source === "visual")),
        conflict: false,
        limitations: unique([
          ...entries.flatMap((entry) => entry.limitations ?? []),
          ...(visualOnlyCanvas ? ["Visual-only Canvas values are estimates until corroborated by structured page or network evidence."] : []),
          ...(selected.source === "visual" && category === "semantic_missing" ? ["No stable DOM reference exists; visual evidence cannot authorize interaction."] : [])
        ])
      }));
      continue;
    }

    const resolution = resolutionFor({ inspectionId: input.inspection_id, fact, category, semantic, visual, network, createdAt });
    const refs = evidenceRefs(present);
    const conflict = browserEvidenceConflictSchema.parse({
      version: 1,
      conflict_id: `browser-conflict-${randomUUID()}`,
      inspection_id: input.inspection_id,
      fact,
      type: category,
      semantic_value: (network ?? semantic)?.value ?? null,
      visual_value: visual?.value ?? null,
      resolution: resolution.resolution,
      confidence: resolution.confidence,
      stop_required: resolution.stop,
      limitations: [resolution.limitation],
      evidence_refs: refs,
      created_at: createdAt
    });
    conflicts.push(conflict);
    facts.push(browserFusedFactSchema.parse({
      fact,
      value: resolution.value,
      source: sources,
      confidence: resolution.confidence,
      semantic_evidence_refs: evidenceRefs(entries.filter((entry) => entry.source === "semantic" || entry.source === "network")),
      visual_evidence_refs: evidenceRefs(entries.filter((entry) => entry.source === "visual")),
      conflict: true,
      limitations: unique([...entries.flatMap((entry) => entry.limitations ?? []), resolution.limitation])
    }));
  }

  const multimodal = browserMultimodalEvidenceSchema.parse({
    version: 1,
    evidence_id: `browser-evidence-${randomUUID()}`,
    inspection_id: input.inspection_id,
    semantic_snapshot_id: input.semantic_snapshot_id,
    visual_evidence: input.visual_evidence ?? [],
    facts,
    redacted: true,
    created_at: createdAt
  });
  return { multimodal, facts, conflicts };
}

