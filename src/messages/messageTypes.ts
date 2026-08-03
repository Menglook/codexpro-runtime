export type MessageDeliveryStatus =
  | "pending"
  | "claimed"
  | "delivered"
  | "acked"
  | "retry_wait"
  | "dead_letter";

export interface MessageEnvelopeV1 {
  version: 1;
  message_id: string;
  message_type: string;
  producer: string;
  consumer: string;
  task_id: string | null;
  run_id: string | null;
  dedupe_key: string;
  payload_ref: string | null;
  payload: Record<string, unknown> | null;
  payload_hash: string;
  created_at: string;
  available_at: string;
  attempt: number;
  max_attempts: number;
  owner_id: string | null;
  fencing_token: number | null;
  lease_expires_at: string | null;
  status: MessageDeliveryStatus;
  last_error: string | null;
  replay_of?: string | null;
  audit?: Record<string, unknown>;
}

export type MessageAckOutcome = "applied" | "duplicate" | "rejected";

export interface MessageAckV1 {
  version: 1;
  ack_id: string;
  message_id: string;
  message_type: string;
  consumer: string;
  dedupe_key: string;
  received_at: string;
  applied_at: string;
  outcome: MessageAckOutcome;
  resulting_state_version: number | null;
  resulting_state_hash: string | null;
}

export const MESSAGE_ENVELOPE_V1_FIELDS = [
  "version",
  "message_id",
  "message_type",
  "producer",
  "consumer",
  "task_id",
  "run_id",
  "dedupe_key",
  "payload_ref",
  "payload",
  "payload_hash",
  "created_at",
  "available_at",
  "attempt",
  "max_attempts",
  "owner_id",
  "fencing_token",
  "lease_expires_at",
  "status",
  "last_error",
  "replay_of",
  "audit"
] as const satisfies readonly (keyof MessageEnvelopeV1)[];

export const MESSAGE_ENVELOPE_V1_REQUIRED_FIELDS = [
  "version",
  "message_id",
  "message_type",
  "producer",
  "consumer",
  "task_id",
  "run_id",
  "dedupe_key",
  "payload_ref",
  "payload",
  "payload_hash",
  "created_at",
  "available_at",
  "attempt",
  "max_attempts",
  "owner_id",
  "fencing_token",
  "lease_expires_at",
  "status",
  "last_error"
] as const satisfies readonly (keyof MessageEnvelopeV1)[];

export const MESSAGE_ACK_V1_FIELDS = [
  "version",
  "ack_id",
  "message_id",
  "message_type",
  "consumer",
  "dedupe_key",
  "received_at",
  "applied_at",
  "outcome",
  "resulting_state_version",
  "resulting_state_hash"
] as const satisfies readonly (keyof MessageAckV1)[];
