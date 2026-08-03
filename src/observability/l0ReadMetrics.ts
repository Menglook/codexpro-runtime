export type L0ReadObservationOutcome = "success" | "fallback" | "slow";

export interface L0ReadMetricReceiptV1 {
  version: 1;
  mode: "in_memory_aggregate";
  outcome: L0ReadObservationOutcome;
  sampled: boolean;
  slow: boolean;
  batch_due: boolean;
}

export interface L0ReadMetricBucketV1 {
  total: number;
  success: number;
  fallback: number;
  slow: number;
  sampled: number;
  duration_ms_total: number;
  duration_ms_max: number;
}

export interface L0ReadMetricsSnapshotV1 extends L0ReadMetricBucketV1 {
  version: 1;
  sample_every: number;
  batch_every: number;
  slow_threshold_ms: number;
  pending_since_batch: number;
  by_tool: Record<string, L0ReadMetricBucketV1>;
}

const SAMPLE_EVERY = 100;
const BATCH_EVERY = 1_000;
const SLOW_THRESHOLD_MS = 100;

function emptyBucket(): L0ReadMetricBucketV1 {
  return { total: 0, success: 0, fallback: 0, slow: 0, sampled: 0, duration_ms_total: 0, duration_ms_max: 0 };
}

const aggregate: L0ReadMetricsSnapshotV1 = {
  version: 1,
  sample_every: SAMPLE_EVERY,
  batch_every: BATCH_EVERY,
  slow_threshold_ms: SLOW_THRESHOLD_MS,
  pending_since_batch: 0,
  by_tool: {},
  ...emptyBucket()
};

function cleanToolName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "unknown";
}

function update(bucket: L0ReadMetricBucketV1, outcome: L0ReadObservationOutcome, durationMs: number, sampled: boolean, slow: boolean): void {
  bucket.total += 1;
  if (outcome === "fallback") bucket.fallback += 1;
  else bucket.success += 1;
  if (slow) bucket.slow += 1;
  if (sampled) bucket.sampled += 1;
  bucket.duration_ms_total += durationMs;
  bucket.duration_ms_max = Math.max(bucket.duration_ms_max, durationMs);
}

export function recordL0ReadObservation(input: { tool_name: string; duration_ms: number; outcome: "success" | "fallback" }): L0ReadMetricReceiptV1 {
  const durationMs = Math.max(0, Math.floor(input.duration_ms));
  const slow = durationMs >= SLOW_THRESHOLD_MS;
  const effectiveOutcome: L0ReadObservationOutcome = input.outcome === "fallback" ? "fallback" : slow ? "slow" : "success";
  const sampled = input.outcome === "fallback" || slow || (aggregate.total + 1) % SAMPLE_EVERY === 0;
  const bucket = aggregate.by_tool[cleanToolName(input.tool_name)] ??= emptyBucket();
  update(aggregate, input.outcome, durationMs, sampled, slow);
  update(bucket, input.outcome, durationMs, sampled, slow);
  aggregate.pending_since_batch += 1;
  const batchDue = aggregate.pending_since_batch >= BATCH_EVERY;
  if (batchDue) aggregate.pending_since_batch = 0;
  return Object.freeze({ version: 1, mode: "in_memory_aggregate", outcome: effectiveOutcome, sampled, slow, batch_due: batchDue });
}

export function snapshotL0ReadMetrics(): L0ReadMetricsSnapshotV1 {
  return structuredClone(aggregate);
}

export function resetL0ReadMetricsForTests(): void {
  Object.assign(aggregate, emptyBucket(), { pending_since_batch: 0, by_tool: {} });
}
