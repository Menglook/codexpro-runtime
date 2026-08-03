export type GitPushReconciliationAction = "record_success" | "verify_remote" | "manual_retry_allowed" | "manual_review";

export interface GitPushReconciliationInput {
  expected_sha: string;
  remote_sha?: string | null;
  response_received: boolean;
  explicit_retry_authorization?: boolean;
  remote_lookup_completed: boolean;
}

export interface GitPushReconciliationResult {
  action: GitPushReconciliationAction;
  successful: boolean;
  automatic_retry_allowed: false;
  reason: string;
  expected_sha: string;
  remote_sha: string | null;
}

function sha(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(normalized) ? normalized : null;
}

export function reconcileGitPush(input: GitPushReconciliationInput): GitPushReconciliationResult {
  const expected = sha(input.expected_sha);
  if (!expected) throw new Error("A valid expected Git SHA is required for push reconciliation.");
  const remote = sha(input.remote_sha);
  if (!input.remote_lookup_completed) {
    return {
      action: "verify_remote",
      successful: false,
      automatic_retry_allowed: false,
      reason: "Push outcome is uncertain. Query the remote ref before any retry.",
      expected_sha: expected,
      remote_sha: remote
    };
  }
  if (remote === expected || (remote && expected.startsWith(remote)) || (remote && remote.startsWith(expected))) {
    return {
      action: "record_success",
      successful: true,
      automatic_retry_allowed: false,
      reason: "The remote ref already contains the expected SHA; record the original push as successful and do not repeat it.",
      expected_sha: expected,
      remote_sha: remote
    };
  }
  if (remote && input.explicit_retry_authorization === true) {
    return {
      action: "manual_retry_allowed",
      successful: false,
      automatic_retry_allowed: false,
      reason: "The remote ref is known and differs from the expected SHA. A new manually authorized push attempt may be created as a separate execution.",
      expected_sha: expected,
      remote_sha: remote
    };
  }
  return {
    action: "manual_review",
    successful: false,
    automatic_retry_allowed: false,
    reason: input.response_received
      ? "The push did not produce the expected remote SHA. Inspect rejection or branch protection details before a new attempt."
      : "The response was lost and the remote SHA is absent or different. Do not retry without explicit reconciliation and authorization.",
    expected_sha: expected,
    remote_sha: remote
  };
}

export type DatabaseOperationKind = "read_only" | "local_write" | "external_write" | "destructive_write" | "unknown";

export interface DatabaseRecoveryDecision {
  operation_kind: DatabaseOperationKind;
  automatic_retry_allowed: boolean;
  manual_reconciliation_required: boolean;
  reason: string;
}

export function databaseRecoveryDecision(operationKind: DatabaseOperationKind): DatabaseRecoveryDecision {
  if (operationKind === "read_only") {
    return {
      operation_kind: operationKind,
      automatic_retry_allowed: true,
      manual_reconciliation_required: false,
      reason: "The interrupted database operation is read-only and may be retried from a new execution. Preserve any inspection artifacts already produced."
    };
  }
  return {
    operation_kind: operationKind,
    automatic_retry_allowed: false,
    manual_reconciliation_required: true,
    reason: operationKind === "destructive_write"
      ? "A destructive database operation must never be replayed automatically. Verify database state, backup state, and the original transaction outcome manually."
      : "Database write outcome may be uncertain. Verify external state and create a separately authorized execution instead of replaying the interrupted step."
  };
}
