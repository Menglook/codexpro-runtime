import type { BrowserBridgeStatus } from "../adapters/playwright-adapter.js";
import type { PlatformSkillRunResult } from "../browser/platform-skill-runtime.js";
import type { CodexNormalizedEvent } from "../codex/types.js";
import type { GoalRecord } from "../goals/types.js";
import {
  appendUsageEntrySync,
  recordUsageLedgerWarningSync,
  type UsageLedgerAppendInput
} from "./usageLedger.js";

function usageField(...parts: string[]): string {
  return parts.join("_");
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function durationBetween(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}

export function recordGoalModelUsage(
  workspaceRoot: string,
  adapterProvider: string,
  goal: GoalRecord,
  codexRunId: string,
  event: CodexNormalizedEvent
): void {
  try {
    const rawUsage = event.data?.usage;
    const usage = rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? rawUsage as Record<string, unknown>
      : {};
    const inputTokens = token(usage[usageField("input", "tokens")]);
    const cachedInputTokens = token(usage[usageField("cached", "input", "tokens")]);
    const outputTokens = token(usage[usageField("output", "tokens")]);
    const reasoningOutputTokens = token(usage[usageField("reasoning", "output", "tokens")]);
    const measured = [inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens].some((value) => value !== null);
    const providerRun = goal.checkpoint?.provider_run;
    const latency = goal.checkpoint?.latency?.breakdown;
    const startedAt = providerRun?.started_at ?? goal.created_at;
    const lastProgressMs = providerRun?.last_progress_at ? Date.parse(providerRun.last_progress_at) : Number.NaN;
    const eventMs = Date.parse(event.timestamp);
    const silentDuration = Number.isFinite(lastProgressMs) && Number.isFinite(eventMs)
      ? Math.max(0, eventMs - lastProgressMs)
      : null;
    const provider = typeof event.data?.provider === "string" ? event.data.provider : adapterProvider;
    const cacheHit = typeof event.data?.cache_hit === "boolean" ? event.data.cache_hit : null;
    const modelEntry: UsageLedgerAppendInput = {
      source_event_id: `codex:${goal.goal_id}:${codexRunId}:${event.sequence}`,
      task_id: goal.goal_id,
      run_id: goal.run_id,
      execution_id: codexRunId,
      component: "model",
      provider,
      model: goal.checkpoint?.execution_options?.model ?? null,
      started_at: startedAt,
      finished_at: event.timestamp,
      wall_duration_ms: durationBetween(startedAt, event.timestamp),
      queue_duration_ms: latency?.queue_ms ?? null,
      active_duration_ms: latency?.model_total_ms ?? null,
      silent_duration_ms: silentDuration,
      process_count: 0,
      retry_count: goal.loop_state.repair_rounds,
      cache_hit: cacheHit,
      outcome: event.type === "task.succeeded" ? "succeeded" : event.type === "task.cancelled" ? "cancelled" : "failed",
      verified_completion: false,
      evidence: event
    };
    Reflect.set(modelEntry, usageField("input", "tokens"), inputTokens);
    Reflect.set(modelEntry, usageField("cached", "input", "tokens"), cachedInputTokens);
    Reflect.set(modelEntry, usageField("output", "tokens"), outputTokens);
    Reflect.set(modelEntry, usageField("reasoning", "output", "tokens"), reasoningOutputTokens);
    Reflect.set(modelEntry, usageField("token", "measurement"), measured ? "measured" : "unavailable");
    appendUsageEntrySync(workspaceRoot, modelEntry);
  } catch (error) {
    recordUsageLedgerWarningSync(workspaceRoot, "goal_model_usage", error, {
      goal_id: goal.goal_id,
      codex_run_id: codexRunId,
      event_sequence: event.sequence
    });
  }
}

export function recordGoalTerminalUsage(
  workspaceRoot: string,
  adapterProvider: string,
  goal: GoalRecord
): void {
  try {
    const latency = goal.checkpoint?.latency?.breakdown;
    const activeDuration = latency
      ? latency.task_compile_ms
        + latency.lane_decision_ms
        + latency.provider_probe_ms
        + latency.snapshot_ms
        + latency.context_prepare_ms
        + latency.model_total_ms
        + latency.tool_execution_ms
        + latency.validation_ms
        + latency.review_ms
        + latency.browser_ms
        + latency.report_ms
      : null;
    const proofSummaries = [
      goal.checkpoint?.agent_completion_proofs?.subagents,
      goal.checkpoint?.agent_completion_proofs?.review
    ].filter((value) => Boolean(value));
    const proofsVerified = proofSummaries.every((proof) => proof?.verified === true);
    const acceptanceVerified = goal.review_result?.acceptance_evaluation?.blocking_passed === true
      || goal.validation_result?.acceptance_evaluation?.blocking_passed === true;
    const verifiedCompletion = goal.status === "succeeded" && acceptanceVerified && proofsVerified;
    appendUsageEntrySync(workspaceRoot, {
      source_event_id: `goal:${goal.goal_id}:${goal.run_id}:${goal.status}`,
      task_id: goal.goal_id,
      run_id: goal.run_id,
      execution_id: goal.checkpoint?.codex_run_id ?? goal.run_id,
      component: "agent",
      provider: goal.checkpoint?.execution_provider ?? adapterProvider,
      model: goal.checkpoint?.execution_options?.model ?? null,
      started_at: goal.created_at,
      finished_at: goal.updated_at,
      wall_duration_ms: latency?.total_ms ?? durationBetween(goal.created_at, goal.updated_at),
      queue_duration_ms: latency?.queue_ms ?? null,
      active_duration_ms: activeDuration,
      silent_duration_ms: latency?.orchestration_overhead_ms ?? null,
      process_count: 0,
      retry_count: goal.loop_state.repair_rounds,
      outcome: goal.status,
      verified_completion: verifiedCompletion,
      recovery_count: goal.loop_state.iteration,
      review_duration_ms: latency?.review_ms ?? null,
      evidence: {
        acceptance_evaluation: goal.review_result?.acceptance_evaluation ?? goal.validation_result?.acceptance_evaluation ?? null,
        completion_proofs: goal.checkpoint?.agent_completion_proofs ?? null,
        evidence: goal.evidence.map((item) => ({
          evidence_id: item.evidence_id,
          hash: item.hash ?? null,
          path: item.path ?? null,
          trustworthy: item.trustworthy
        })),
        validation_report: goal.validation_result?.report_path ?? null,
        status: goal.status
      }
    });
  } catch (error) {
    recordUsageLedgerWarningSync(workspaceRoot, "goal_terminal_usage", error, {
      goal_id: goal.goal_id,
      run_id: goal.run_id,
      status: goal.status
    });
  }
}

export function recordBrowserSkillUsage(input: {
  workspace_root: string;
  result: PlatformSkillRunResult;
  started_at: string;
  finished_at: string;
  before_status: BrowserBridgeStatus;
  after_status: BrowserBridgeStatus;
}): void {
  try {
    const reconnectCount = Math.max(0, input.after_status.reconnectAttempts - input.before_status.reconnectAttempts);
    const rebindCount = input.before_status.authorizationId !== input.after_status.authorizationId
      || input.before_status.authorizationBoundAt !== input.after_status.authorizationBoundAt
      ? 1
      : 0;
    appendUsageEntrySync(input.workspace_root, {
      source_event_id: `browser-skill:${input.result.task_id}:${input.result.run_id}:${input.result.skill_id}`,
      task_id: input.result.task_id,
      run_id: input.result.run_id,
      execution_id: input.result.current_page.session_id,
      component: "browser",
      provider: input.result.platform,
      tool: "browser_business_run_skill",
      started_at: input.started_at,
      finished_at: input.finished_at,
      wall_duration_ms: durationBetween(input.started_at, input.finished_at),
      active_duration_ms: durationBetween(input.started_at, input.finished_at),
      process_count: 0,
      retry_count: 0,
      outcome: input.result.status === "completed"
        ? input.result.verification.status === "verified" ? "verified" : "unknown"
        : "failed",
      verified_completion: input.result.status === "completed" && input.result.verification.status === "verified",
      skill_id: input.result.skill_id,
      refresh_count: 0,
      rebind_count: rebindCount,
      reconnect_count: reconnectCount,
      recovery_count: reconnectCount,
      evidence: {
        task_contract_hash: input.result.task_contract_hash,
        verification: input.result.verification,
        browser_report_refs: input.result.browser_report_refs,
        evidence_refs: input.result.evidence_refs,
        executed_steps: input.result.executed_steps,
        deferred_steps: input.result.deferred_steps
      }
    });
  } catch (error) {
    recordUsageLedgerWarningSync(input.workspace_root, "browser_business_skill", error, {
      task_id: input.result.task_id,
      run_id: input.result.run_id,
      skill_id: input.result.skill_id
    });
  }
}
