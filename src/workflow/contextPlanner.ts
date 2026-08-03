import path from "node:path";
import type { CompiledTask } from "./taskCompiler.js";

export type ContextSource = "rule" | "memory" | "plan" | "file" | "diff" | "test" | "browser" | "user";

export interface ContextNode {
  id: string;
  source: ContextSource;
  path?: string;
  relevance: number;
  confidence: number;
  freshness?: string;
  token_cost: number;
  required: boolean;
  summary?: string;
  conflicts_with?: string[];
  content?: string;
  tags?: string[];
}

export interface ContextPlannerOptions {
  max_nodes?: number;
  max_token_cost?: number;
  previous_topic?: string;
  now?: string;
  summarize_below_relevance?: number;
}

export interface ContextPlannerDecision {
  version: 1;
  planned_at: string;
  task_intent: string;
  selected: ContextNode[];
  summarized: ContextNode[];
  skipped: Array<ContextNode & { skip_reason: string }>;
  uncovered_required: ContextNode[];
  total_token_cost: number;
  max_token_cost: number;
  max_nodes: number;
  topic_switch_detected: boolean;
  topic_overlap: number;
  conflicts: Array<{ node_id: string; conflicts_with: string[] }>;
  deduplicated_node_ids: string[];
  selection_reasons: Record<string, string[]>;
}

const SOURCE_PRIORITY: Record<ContextSource, number> = {
  user: 1,
  rule: 0.96,
  plan: 0.92,
  diff: 0.9,
  test: 0.84,
  file: 0.78,
  browser: 0.72,
  memory: 0.66
};

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "from", "by", "is", "are",
  "this", "that", "it", "be", "as", "at", "into", "after", "before", "task", "stage", "开始", "继续", "执行",
  "需要", "进行", "一个", "这个", "以及", "然后", "通过", "完成", "项目", "代码"
]);

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function terms(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !STOP_WORDS.has(item)))];
}

function overlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const common = left.filter((item) => rightSet.has(item)).length;
  return common / Math.max(1, Math.min(left.length, right.length));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathAffinity(nodePath: string | undefined, task: CompiledTask): number {
  if (!nodePath) return 0;
  const candidate = normalizePath(nodePath).toLowerCase();
  let score = 0;
  for (const scoped of task.scope) {
    const scope = normalizePath(scoped).toLowerCase();
    if (candidate === scope) score = Math.max(score, 1);
    else if (candidate.startsWith(`${scope}/`) || scope.startsWith(`${candidate}/`)) score = Math.max(score, 0.9);
    else if (path.basename(candidate) === path.basename(scope)) score = Math.max(score, 0.82);
  }
  const taskTerms = terms([task.intent, ...task.deliverables, ...task.scope].join(" "));
  const pathTerms = terms(candidate.replace(/[/.\-_]+/g, " "));
  return Math.max(score, overlap(taskTerms, pathTerms));
}

function agePenalty(freshness: string | undefined, source: ContextSource, nowMs: number): number {
  if (!freshness) return 0;
  const parsed = Date.parse(freshness);
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, nowMs - parsed) / 86_400_000;
  const threshold = source === "browser" ? 1 : source === "test" || source === "diff" ? 14 : source === "memory" ? 180 : 365;
  if (ageDays <= threshold) return 0;
  return Math.min(0.35, ((ageDays - threshold) / threshold) * 0.18);
}

function nodeText(node: ContextNode): string {
  return [node.path, node.summary, ...(node.tags ?? [])].filter(Boolean).join(" ");
}

function scoredNode(node: ContextNode, task: CompiledTask, nowMs: number): { node: ContextNode; score: number; reasons: string[] } {
  const reasons: string[] = [];
  const taskTerms = terms([task.intent, ...task.deliverables, ...task.scope, ...task.constraints].join(" "));
  const nodeTerms = terms(nodeText(node));
  const lexical = overlap(taskTerms, nodeTerms);
  const affinity = pathAffinity(node.path, task);
  const sourceWeight = SOURCE_PRIORITY[node.source];
  const freshnessPenalty = agePenalty(node.freshness, node.source, nowMs);
  const declared = clamp(node.relevance);
  let score = declared * 0.36 + lexical * 0.22 + affinity * 0.24 + sourceWeight * 0.18 - freshnessPenalty;
  if (node.required) {
    score = Math.max(score, 1.2);
    reasons.push("required context");
  }
  if (affinity >= 0.8) reasons.push("matches explicit task scope");
  else if (affinity >= 0.35) reasons.push("path is related to task terms");
  if (lexical >= 0.35) reasons.push("summary/tags overlap task intent");
  if (node.source === "rule") reasons.push("project rule priority");
  if (node.source === "diff") reasons.push("current diff priority");
  if (node.source === "test") reasons.push("validation evidence priority");
  if (freshnessPenalty > 0) reasons.push("freshness penalty applied");
  if (!reasons.length) reasons.push("ranked by declared relevance and source priority");
  return { node: { ...node, relevance: Number(clamp(score, 0, 1).toFixed(3)) }, score, reasons };
}

function dedupeKey(node: ContextNode): string {
  if (node.path) return `${node.source}:${normalizePath(node.path).toLowerCase()}`;
  return `${node.source}:${(node.summary ?? node.id).trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function deduplicate(nodes: ContextNode[]): { nodes: ContextNode[]; removed: string[] } {
  const byKey = new Map<string, ContextNode>();
  const removed: string[] = [];
  for (const node of nodes) {
    const key = dedupeKey(node);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...node, token_cost: Math.max(1, Math.floor(node.token_cost)) });
      continue;
    }
    const keepIncoming = node.required && !existing.required
      || (node.required === existing.required && node.relevance > existing.relevance)
      || (node.required === existing.required && node.relevance === existing.relevance && node.confidence > existing.confidence);
    if (keepIncoming) {
      removed.push(existing.id);
      byKey.set(key, { ...node, token_cost: Math.max(1, Math.floor(node.token_cost)) });
    } else {
      removed.push(node.id);
    }
  }
  return { nodes: [...byKey.values()], removed };
}

function summaryNode(node: ContextNode): ContextNode {
  const summary = node.summary?.trim() || (node.path ? `Context from ${node.path}` : `Context node ${node.id}`);
  return {
    ...node,
    content: undefined,
    summary: summary.slice(0, 600),
    token_cost: Math.max(24, Math.min(node.token_cost, Math.ceil(summary.length / 4) + 12))
  };
}

export function planContext(task: CompiledTask, inputNodes: ContextNode[], options: ContextPlannerOptions = {}): ContextPlannerDecision {
  const plannedAt = options.now ?? new Date().toISOString();
  const nowMs = Number.isFinite(Date.parse(plannedAt)) ? Date.parse(plannedAt) : Date.now();
  const maxNodes = Math.max(1, Math.min(options.max_nodes ?? 24, 200));
  const maxTokenCost = Math.max(100, Math.min(options.max_token_cost ?? 45_000, 500_000));
  const summarizeThreshold = clamp(options.summarize_below_relevance ?? 0.62);
  const deduped = deduplicate(inputNodes);
  const inputOrder = new Map(deduped.nodes.map((node, index) => [node.id, index]));
  const ranked = deduped.nodes
    .map((node) => scoredNode(node, task, nowMs))
    .sort((left, right) => {
      if (left.node.required !== right.node.required) return left.node.required ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      if (right.node.confidence !== left.node.confidence) return right.node.confidence - left.node.confidence;
      return (inputOrder.get(left.node.id) ?? Number.MAX_SAFE_INTEGER) - (inputOrder.get(right.node.id) ?? Number.MAX_SAFE_INTEGER);
    });

  const selected: ContextNode[] = [];
  const summarized: ContextNode[] = [];
  const skipped: Array<ContextNode & { skip_reason: string }> = [];
  const selectionReasons: Record<string, string[]> = {};
  let totalCost = 0;

  const trySelect = (node: ContextNode, reasons: string[], summarize: boolean): boolean => {
    const candidate = summarize ? summaryNode(node) : node;
    if (selected.length + summarized.length >= maxNodes) return false;
    if (totalCost + candidate.token_cost > maxTokenCost) return false;
    (summarize ? summarized : selected).push(candidate);
    totalCost += candidate.token_cost;
    selectionReasons[node.id] = [...reasons, summarize ? "summary selected to preserve budget" : "full node selected"];
    return true;
  };

  for (const item of ranked.filter((item) => item.node.required)) {
    if (trySelect(item.node, item.reasons, false)) continue;
    if (trySelect(item.node, item.reasons, true)) continue;
    skipped.push({ ...item.node, skip_reason: "required node exceeded the hard context budget" });
  }

  for (const item of ranked.filter((item) => !item.node.required)) {
    const node = item.node;
    const shouldSummarize = node.relevance < summarizeThreshold || node.token_cost > Math.max(2000, maxTokenCost * 0.2);
    if (trySelect(node, item.reasons, shouldSummarize)) continue;
    if (!shouldSummarize && trySelect(node, item.reasons, true)) continue;
    skipped.push({ ...node, skip_reason: selected.length + summarized.length >= maxNodes ? "max node count reached" : "context token budget exhausted" });
  }

  const selectedIds = new Set([...selected, ...summarized].map((node) => node.id));
  const uncoveredRequired = ranked.filter((item) => item.node.required && !selectedIds.has(item.node.id)).map((item) => item.node);
  const conflicts = [...selected, ...summarized]
    .filter((node) => node.conflicts_with?.some((id) => selectedIds.has(id)))
    .map((node) => ({ node_id: node.id, conflicts_with: node.conflicts_with!.filter((id) => selectedIds.has(id)) }));
  const currentTerms = terms([task.intent, ...task.scope, ...task.deliverables].join(" "));
  const previousTerms = terms(options.previous_topic ?? "");
  const topicOverlap = previousTerms.length ? overlap(currentTerms, previousTerms) : 1;
  const topicSwitchDetected = previousTerms.length > 0 && topicOverlap < 0.2;

  return {
    version: 1,
    planned_at: plannedAt,
    task_intent: task.intent,
    selected,
    summarized,
    skipped,
    uncovered_required: uncoveredRequired,
    total_token_cost: totalCost,
    max_token_cost: maxTokenCost,
    max_nodes: maxNodes,
    topic_switch_detected: topicSwitchDetected,
    topic_overlap: Number(topicOverlap.toFixed(3)),
    conflicts,
    deduplicated_node_ids: deduped.removed,
    selection_reasons: selectionReasons
  };
}

export interface FileContextNodeOptions {
  source?: ContextSource;
  required?: boolean;
  relevance?: number;
  confidence?: number;
  freshness?: string;
  bytes?: number;
  summary?: string;
  tags?: string[];
}

export function fileContextNode(filePath: string, options: FileContextNodeOptions = {}): ContextNode {
  const normalized = normalizePath(filePath);
  const bytes = Math.max(0, options.bytes ?? 4_000);
  return {
    id: `file:${normalized}`,
    source: options.source ?? "file",
    path: normalized,
    relevance: clamp(options.relevance ?? 0.5),
    confidence: clamp(options.confidence ?? 0.9),
    ...(options.freshness ? { freshness: options.freshness } : {}),
    token_cost: Math.max(64, Math.ceil(bytes / 4)),
    required: options.required === true,
    summary: options.summary ?? `Workspace file ${normalized}`,
    ...(options.tags?.length ? { tags: [...options.tags] } : {})
  };
}

export function formatContextPlan(plan: ContextPlannerDecision): string {
  return [
    `Selected full nodes: ${plan.selected.length}`,
    `Selected summaries: ${plan.summarized.length}`,
    `Skipped nodes: ${plan.skipped.length}`,
    `Required nodes uncovered: ${plan.uncovered_required.length}`,
    `Token cost: ${plan.total_token_cost}/${plan.max_token_cost}`,
    `Topic switch detected: ${plan.topic_switch_detected}`,
    `Conflicts: ${plan.conflicts.length}`,
    `Selected paths: ${[...plan.selected, ...plan.summarized].map((node) => node.path ?? node.id).join(", ") || "none"}`,
    `Skipped paths: ${plan.skipped.map((node) => `${node.path ?? node.id} (${node.skip_reason})`).join(", ") || "none"}`
  ].join("\n");
}
