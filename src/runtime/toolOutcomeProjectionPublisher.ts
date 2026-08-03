import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { PathGuard, type Workspace } from "../guard.js";
import { createWorkspaceMessageStore, type DurableMessageEnvelope } from "../messages/messageStore.js";
import { RuntimeActivityEventStore } from "./activityEventStore.js";
import { PublicToolOutcomeStore } from "./publicToolOutcomeStore.js";
import { upgradePublicToolOutcomeV1, type OfficeProjectionReceiptV1, type PublicToolOutcomeV1 } from "./publicToolOutcome.js";
import { TaskReportEventStore } from "../tasks/taskReportEventStore.js";
import type { TaskReportEventKind, TaskReportSeverity } from "../tasks/taskReportTypes.js";

const MESSAGE_TYPE = "office.tool_result_projection";
const CONSUMER = "office_tool_result_projection";

function taskReportMapping(outcome: PublicToolOutcomeV1): { eventKind: TaskReportEventKind; severity: TaskReportSeverity } | null {
  if (!outcome.task_id || outcome.actor_role === "observer") return null;
  if (outcome.security_status === "denied"
    || outcome.execution_status === "failed"
    || outcome.execution_status === "cancelled"
    || outcome.validation_status === "failed"
    || outcome.validation_status === "incomplete"
    || outcome.delivery_status === "failed") return { eventKind: "warning", severity: "warning" };
  if (outcome.findings.length) return { eventKind: outcome.findings.some((item) => item.kind === "warning") ? "warning" : "finding", severity: outcome.findings.some((item) => item.kind === "warning") ? "warning" : "info" };
  if (["write", "validation", "browser", "git", "report"].includes(outcome.tool_category)) return { eventKind: outcome.evidence_refs.length && outcome.tool_category === "browser" ? "artifact_created" : "progress", severity: "info" };
  return null;
}

export class ToolOutcomeProjectionPublisher {
  private readonly guard: PathGuard;
  private readonly messageStore;
  private readonly outcomeStore: PublicToolOutcomeStore;
  private readonly runtimeStore: RuntimeActivityEventStore;
  private readonly reportStore: TaskReportEventStore;

  constructor(private readonly config: CodexProConfig, private readonly workspace: Workspace) {
    this.guard = new PathGuard(config);
    this.messageStore = createWorkspaceMessageStore(workspace.root);
    this.outcomeStore = new PublicToolOutcomeStore(workspace);
    this.runtimeStore = new RuntimeActivityEventStore(this.guard, workspace);
    this.reportStore = new TaskReportEventStore(this.guard, workspace);
  }

  async publish(outcome: PublicToolOutcomeV1, options: { wait_for_projection?: boolean } = {}): Promise<OfficeProjectionReceiptV1> {
    const projectionEnabled = !["0", "false", "no", "off", "none"].includes(String(process.env.CODEXPRO_OFFICE_TOOL_OUTCOME_PROJECTION ?? "1").trim().toLowerCase());
    const queued: OfficeProjectionReceiptV1 = {
      version: 1,
      event_id: outcome.event_id,
      projection_status: "queued",
      result_digest: outcome.result_digest,
      sequence: null,
      state_authority_changed: false
    };
    if (!projectionEnabled) return { ...queued, projection_status: "degraded" };
    let message;
    try {
      message = await this.messageStore.append({
        message_type: MESSAGE_TYPE,
        producer: "mcp_tool_registration",
        consumer: CONSUMER,
        task_id: outcome.task_id,
        run_id: outcome.run_id,
        dedupe_key: `${outcome.event_id}:${outcome.result_digest}`,
        payload: { outcome },
        max_attempts: 5,
        audit: { state_authority_changed: false, actor_role: outcome.actor_role, tool_name: outcome.tool_name }
      });
    } catch {
      return await this.outcomeStore.markDegraded(outcome).catch(() => ({ ...queued, projection_status: "degraded" }));
    }
    const queuedReceipt = await this.outcomeStore.markQueued(outcome).catch(() => queued);
    const dispatch = async (): Promise<OfficeProjectionReceiptV1> => {
      const result = await this.messageStore.dispatchById(message.message_id, CONSUMER, async (claimed) => await this.consume(claimed), {
        owner_id: `${CONSUMER}:${process.pid}`,
        observe_component: false
      });
      if (result.ack) {
        let projected = await this.outcomeStore.receipt(outcome.event_id);
        if (projected && projected.projection_status !== "projected") projected = await this.outcomeStore.markProjected(outcome.event_id);
        if (!options.wait_for_projection) void this.drainPending(2);
        return projected ?? { ...queued, projection_status: "projected" };
      }
      const receipt = await this.outcomeStore.receipt(outcome.event_id);
      return receipt ?? queuedReceipt;
    };
    if (options.wait_for_projection) return await dispatch();
    void dispatch().catch(() => undefined);
    return queuedReceipt;
  }

  async drainPending(limit = 10): Promise<number> {
    let handled = 0;
    for (let index = 0; index < Math.max(0, Math.min(100, limit)); index += 1) {
      const result = await this.messageStore.dispatchOne(CONSUMER, async (message) => await this.consume(message), {
        owner_id: `${CONSUMER}:recovery:${process.pid}`,
        observe_component: false
      }).catch(() => null);
      if (!result?.message) break;
      if (result.ack) {
        const payload = this.outcomeFromMessage(result.message);
        if (payload) {
          const receipt = await this.outcomeStore.receipt(payload.event_id);
          if (receipt && receipt.projection_status !== "projected") await this.outcomeStore.markProjected(payload.event_id).catch(() => undefined);
        }
        handled += 1;
      }
    }
    return handled;
  }

  private outcomeFromMessage(message: DurableMessageEnvelope): PublicToolOutcomeV1 | null {
    const payload = message.payload && typeof message.payload === "object" ? message.payload as Record<string, unknown> : {};
    return upgradePublicToolOutcomeV1(payload.outcome);
  }

  private async consume(message: DurableMessageEnvelope): Promise<{ event_id: string; sequence: number; result_digest: string }> {
    if (message.message_type !== MESSAGE_TYPE) throw new Error(`Unsupported projection message type: ${message.message_type}`);
    const outcome = this.outcomeFromMessage(message);
    if (!outcome) throw new Error("Projection message does not contain PublicToolOutcomeV1.");
    const [persisted] = await Promise.all([
      this.outcomeStore.append(outcome, { projection_status: "projected" }),
      this.runtimeStore.append({
        event_id: `runtime:${outcome.event_id}`,
        kind: "tool.result_projected",
        objective_id: outcome.objective_id,
        attempt_id: outcome.attempt_id,
        run_id: outcome.run_id,
        actor_id: outcome.actor_id,
        actor_role: outcome.actor_role,
        occurred_at: outcome.completed_at,
        payload: {
          public_event_id: outcome.event_id,
          correlation_id: outcome.correlation_id,
          tool_name: outcome.tool_name,
          tool_category: outcome.tool_category,
          outcome: outcome.status,
          security_status: outcome.security_status,
          resource_status: outcome.resource_status,
          execution_status: outcome.execution_status,
          recovery_status: outcome.recovery_status,
          validation_status: outcome.validation_status,
          delivery_status: outcome.delivery_status,
          permission_decision_id: outcome.permission_decision_id,
          effective_side_effect_level: outcome.effective_side_effect_level,
          resource_lease_id: outcome.resource_lease_id,
          workspace_baseline_id: outcome.workspace_baseline_id,
          confirmation_receipt_id: outcome.confirmation_receipt_id,
          tool_schema_digest: outcome.tool_schema_digest,
          retryable: outcome.retryable,
          reason_code: outcome.reason_code,
          public_summary: outcome.public_summary,
          result_metrics: outcome.result_metrics,
          result_digest: outcome.result_digest,
          evidence_refs: outcome.evidence_refs,
          state_authority_changed: false
        }
      }).catch(() => undefined),
      this.projectTaskReport(outcome).catch(() => undefined)
    ]);
    return { event_id: persisted.event.event_id, sequence: persisted.event.sequence, result_digest: persisted.event.result_digest };
  }

  private async projectTaskReport(outcome: PublicToolOutcomeV1): Promise<void> {
    const mapping = taskReportMapping(outcome);
    if (!mapping || !outcome.task_id) return;
    const existingEvidence: string[] = [];
    for (const candidate of outcome.evidence_refs) {
      try {
        const resolved = this.guard.resolve(this.workspace, candidate);
        if ((await fsp.stat(resolved.absPath)).isFile()) existingEvidence.push(candidate);
      } catch {
        // Unsafe or missing evidence is excluded from the explanatory projection.
      }
    }
    let eventKind = mapping.eventKind;
    if (eventKind === "finding" && existingEvidence.length === 0) eventKind = "progress";
    if (eventKind === "artifact_created" && existingEvidence.length === 0) eventKind = "progress";
    await this.reportStore.append({
      idempotency_key: `tool-outcome-${outcome.event_id}`,
      project_id: outcome.project_id,
      objective_key: outcome.objective_id ?? `tool:${outcome.task_id}`,
      task_id: outcome.task_id,
      run_id: outcome.run_id,
      attempt_id: outcome.attempt_id,
      stage_key: outcome.phase || null,
      stage_title: null,
      event_kind: eventKind,
      severity: mapping.severity,
      title: outcome.public_title,
      summary: outcome.public_summary,
      detail_markdown: null,
      evidence_paths: existingEvidence,
      source_kind: "tool",
      source_ref: `office-tool-outcome:${outcome.event_id}`,
      occurred_at: outcome.completed_at
    });
  }
}
