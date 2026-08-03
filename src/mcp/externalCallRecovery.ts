import {
  createExternalCallRetry,
  externalCallRetryDecision,
  markExternalCallDeliveryUnknown,
  updateExternalCallConnection,
  type ExternalCallConnectionState,
  type ExternalCallRecordV1
} from "../runtime/externalCallContract.js";
import {
  appendExternalCallRecord,
  latestExternalCallRecord,
  type ExternalCallLedgerAppendResult
} from "../runtime/externalCallLedger.js";

export type McpRecoveryTrigger =
  | "idle"
  | "transport_interrupted"
  | "server_restart"
  | "wake"
  | "reconnect"
  | "capability_renegotiated";

export type McpRecoveryAction =
  | "none"
  | "wait_for_connection"
  | "renegotiate_capabilities"
  | "retry_idempotent"
  | "manual_intervention"
  | "resume_observation";

export interface McpExternalCallRecoveryContext {
  trigger: McpRecoveryTrigger;
  connection_state: ExternalCallConnectionState;
  available_capabilities?: readonly string[];
  now?: string;
  transport_session_id?: string | null;
}

export interface McpExternalCallRecoveryPlan {
  action: McpRecoveryAction;
  reason: string;
  automatic: boolean;
  record: ExternalCallRecordV1;
  retry_record: ExternalCallRecordV1 | null;
}

function capabilityAvailable(record: ExternalCallRecordV1, capabilities: readonly string[] | undefined): boolean {
  if (!capabilities) return true;
  return capabilities.includes(record.operation) || capabilities.includes("*");
}

function uncertainAfterInterruption(record: ExternalCallRecordV1, trigger: McpRecoveryTrigger): boolean {
  return ["sending", "acknowledged", "executing"].includes(record.delivery_state)
    && ["transport_interrupted", "server_restart", "wake", "reconnect"].includes(trigger);
}

export function planMcpExternalCallRecovery(
  source: ExternalCallRecordV1,
  context: McpExternalCallRecoveryContext
): McpExternalCallRecoveryPlan {
  let record = source;
  if (record.connection_state !== context.connection_state) {
    record = updateExternalCallConnection(record, context.connection_state, {
      now: context.now,
      metadata: context.transport_session_id
        ? { transport_session_id: context.transport_session_id }
        : undefined
    });
  }

  if (["transport_interrupted", "server_restarting", "waking", "reconnecting", "unavailable"].includes(context.connection_state)) {
    return {
      action: "wait_for_connection",
      reason: `MCP connection is not ready: ${context.connection_state}.`,
      automatic: false,
      record,
      retry_record: null
    };
  }

  if (!capabilityAvailable(record, context.available_capabilities)) {
    return {
      action: "renegotiate_capabilities",
      reason: `MCP capability is not currently available: ${record.operation}.`,
      automatic: false,
      record: updateExternalCallConnection(record, "capability_renegotiating", { now: context.now }),
      retry_record: null
    };
  }

  if (uncertainAfterInterruption(record, context.trigger)) {
    record = markExternalCallDeliveryUnknown(record, {
      now: context.now,
      connection_state: context.connection_state,
      reason: `${context.trigger}_after_possible_delivery`
    });
  }

  if (record.delivery_state === "delivery_unknown") {
    const decision = externalCallRetryDecision(record);
    if (decision.safe_to_retry) {
      return {
        action: "retry_idempotent",
        reason: decision.reason,
        automatic: true,
        record,
        retry_record: createExternalCallRetry(record, context.now)
      };
    }
    return {
      action: "manual_intervention",
      reason: decision.reason,
      automatic: false,
      record,
      retry_record: null
    };
  }

  if (record.delivery_state === "completed" || record.delivery_state === "failed") {
    return {
      action: "none",
      reason: `External call is already terminal: ${record.delivery_state}.`,
      automatic: false,
      record,
      retry_record: null
    };
  }

  if (record.delivery_state === "not_sent") {
    const decision = externalCallRetryDecision(record);
    if (decision.safe_to_retry) {
      return {
        action: "retry_idempotent",
        reason: decision.reason,
        automatic: true,
        record,
        retry_record: createExternalCallRetry(record, context.now)
      };
    }
  }

  return {
    action: "resume_observation",
    reason: "Connection and capability are restored; continue observing the persisted call fact.",
    automatic: false,
    record,
    retry_record: null
  };
}

export interface PersistedMcpRecoveryResult extends McpExternalCallRecoveryPlan {
  persisted: ExternalCallLedgerAppendResult[];
}

export async function recoverMcpExternalCall(
  projectRoot: string,
  source: ExternalCallRecordV1,
  context: McpExternalCallRecoveryContext
): Promise<PersistedMcpRecoveryResult> {
  const latest = await latestExternalCallRecord(projectRoot, source.call_id);
  const plan = planMcpExternalCallRecovery(latest ?? source, context);
  const persisted: ExternalCallLedgerAppendResult[] = [];
  if (!latest || plan.record.revision > latest.revision) {
    persisted.push(await appendExternalCallRecord(projectRoot, plan.record));
  }
  if (plan.retry_record) persisted.push(await appendExternalCallRecord(projectRoot, plan.retry_record));
  return { ...plan, persisted };
}

export class McpExternalCallRecoveryCoordinator {
  constructor(readonly projectRoot: string) {}

  plan(record: ExternalCallRecordV1, context: McpExternalCallRecoveryContext): McpExternalCallRecoveryPlan {
    return planMcpExternalCallRecovery(record, context);
  }

  recover(record: ExternalCallRecordV1, context: McpExternalCallRecoveryContext): Promise<PersistedMcpRecoveryResult> {
    return recoverMcpExternalCall(this.projectRoot, record, context);
  }
}

export const decideMcpExternalCallRecovery = planMcpExternalCallRecovery;
export const recoverExternalCallAfterReconnect = recoverMcpExternalCall;
