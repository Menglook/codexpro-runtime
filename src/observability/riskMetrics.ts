import type {
  RiskArgumentRole,
  RiskToolCapability,
  UnifiedRiskBaselineObservation,
  UnifiedRiskDecision
} from "../security/riskGate.js";
import type { ExecutionLane } from "../workflow/executionLane.js";

export interface RiskMetricRecordInput {
  decision: UnifiedRiskDecision;
  risk_decision_ms: number;
  tool_class: RiskToolCapability;
  argument_roles: RiskArgumentRole[];
  execution_lane?: ExecutionLane | "unknown";
}

export interface RiskMetricSnapshot {
  risk_gate_decisions_total: number;
  risk_gate_blocks_total: number;
  risk_gate_false_positive_confirmed_total: number;
  risk_gate_decision_ms: {
    count: number;
    p50: number;
    p95: number;
    max: number;
    average: number;
  };
  tool_class: Record<string, number>;
  argument_role: Record<string, number>;
  matched_signal: Record<string, number>;
  matched_argument_path: Record<string, number>;
  execution_lane: Record<string, number>;
  reason_code: Record<string, number>;
  repeated_blocks: Array<{ fingerprint: string; count: number }>;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function blockFingerprint(decision: UnifiedRiskDecision): string {
  return [
    decision.reason_code,
    [...decision.matched_signals].sort().join(","),
    [...decision.matched_argument_paths].sort().join(",")
  ].join("|");
}

export class RiskGateMetrics {
  private decisions = 0;
  private blocks = 0;
  private falsePositives = 0;
  private readonly durations: number[] = [];
  private readonly toolClasses = new Map<string, number>();
  private readonly argumentRoles = new Map<string, number>();
  private readonly matchedSignals = new Map<string, number>();
  private readonly matchedArgumentPaths = new Map<string, number>();
  private readonly executionLanes = new Map<string, number>();
  private readonly reasonCodes = new Map<string, number>();
  private readonly repeatedBlocks = new Map<string, number>();

  record(input: RiskMetricRecordInput): void {
    this.decisions += 1;
    if (!input.decision.allowed) {
      this.blocks += 1;
      increment(this.repeatedBlocks, blockFingerprint(input.decision));
    }
    const duration = Number.isFinite(input.risk_decision_ms) ? Math.max(0, input.risk_decision_ms) : 0;
    this.durations.push(duration);
    if (this.durations.length > 2_048) this.durations.splice(0, this.durations.length - 2_048);
    increment(this.toolClasses, input.tool_class);
    for (const role of new Set(input.argument_roles)) increment(this.argumentRoles, role);
    for (const signal of new Set(input.decision.matched_signals)) increment(this.matchedSignals, signal);
    for (const path of new Set(input.decision.matched_argument_paths)) increment(this.matchedArgumentPaths, path);
    increment(this.executionLanes, input.execution_lane ?? "unknown");
    increment(this.reasonCodes, input.decision.reason_code);
  }

  confirmFalsePositive(): void {
    this.falsePositives += 1;
  }

  snapshot(): RiskMetricSnapshot {
    const sum = this.durations.reduce((total, value) => total + value, 0);
    return {
      risk_gate_decisions_total: this.decisions,
      risk_gate_blocks_total: this.blocks,
      risk_gate_false_positive_confirmed_total: this.falsePositives,
      risk_gate_decision_ms: {
        count: this.durations.length,
        p50: percentile(this.durations, 0.5),
        p95: percentile(this.durations, 0.95),
        max: this.durations.length ? Math.max(...this.durations) : 0,
        average: this.durations.length ? sum / this.durations.length : 0
      },
      tool_class: sortedRecord(this.toolClasses),
      argument_role: sortedRecord(this.argumentRoles),
      matched_signal: sortedRecord(this.matchedSignals),
      matched_argument_path: sortedRecord(this.matchedArgumentPaths),
      execution_lane: sortedRecord(this.executionLanes),
      reason_code: sortedRecord(this.reasonCodes),
      repeated_blocks: [...this.repeatedBlocks.entries()]
        .filter(([, count]) => count > 1)
        .map(([fingerprint, count]) => ({ fingerprint, count }))
        .sort((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
    };
  }

  resetForTests(): void {
    this.decisions = 0;
    this.blocks = 0;
    this.falsePositives = 0;
    this.durations.splice(0, this.durations.length);
    this.toolClasses.clear();
    this.argumentRoles.clear();
    this.matchedSignals.clear();
    this.matchedArgumentPaths.clear();
    this.executionLanes.clear();
    this.reasonCodes.clear();
    this.repeatedBlocks.clear();
  }
}

export const riskGateMetrics = new RiskGateMetrics();

export function recordRiskObservation(
  observation: UnifiedRiskBaselineObservation,
  executionLane?: ExecutionLane | "unknown"
): void {
  riskGateMetrics.record({
    decision: observation.decision,
    risk_decision_ms: observation.risk_decision_ms,
    tool_class: observation.tool_class,
    argument_roles: observation.argument_roles,
    execution_lane: executionLane
  });
}
