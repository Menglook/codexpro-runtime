import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const TASK_ACTION_NONCE_TTL_MS = 5 * 60 * 1_000;

export type ConfirmedTaskAction = "resume" | "cancel" | "retry_step";

export interface TaskActionNonceBinding {
  project_id: string;
  task_id: string;
  action: ConfirmedTaskAction;
  expected_status: string;
  step_id?: string | null;
  session_binding: string;
}

interface TaskActionNonceClaims {
  version: 1;
  nonce_id: string;
  project_id: string;
  task_id: string;
  action: ConfirmedTaskAction;
  expected_status: string;
  step_id: string | null;
  session_binding_hash: string;
  issued_at_ms: number;
  expires_at_ms: number;
}

export class TaskActionConfirmationError extends Error {
  constructor(readonly code: "nonce_invalid" | "nonce_expired" | "nonce_binding_mismatch" | "nonce_reused", message: string) {
    super(message);
    this.name = "TaskActionConfirmationError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signature(secret: string, encodedClaims: string): string {
  return createHmac("sha256", secret).update(encodedClaims).digest("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function expectedClaims(binding: TaskActionNonceBinding): Omit<TaskActionNonceClaims, "version" | "nonce_id" | "issued_at_ms" | "expires_at_ms"> {
  return {
    project_id: binding.project_id,
    task_id: binding.task_id,
    action: binding.action,
    expected_status: binding.expected_status,
    step_id: binding.step_id?.trim() || null,
    session_binding_hash: digest(binding.session_binding)
  };
}

export function issueTaskActionNonce(
  secret: string,
  binding: TaskActionNonceBinding,
  options: { now_ms?: number; ttl_ms?: number } = {}
): { action_nonce: string; expires_at: string } {
  const nowMs = options.now_ms ?? Date.now();
  const ttlMs = Math.max(1_000, options.ttl_ms ?? TASK_ACTION_NONCE_TTL_MS);
  const claims: TaskActionNonceClaims = {
    version: 1,
    nonce_id: randomUUID(),
    ...expectedClaims(binding),
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + ttlMs
  };
  const encoded = encode(claims);
  return {
    action_nonce: `${encoded}.${signature(secret, encoded)}`,
    expires_at: new Date(claims.expires_at_ms).toISOString()
  };
}

export function verifyTaskActionNonce(
  secret: string,
  token: string,
  binding: TaskActionNonceBinding,
  nowMs = Date.now()
): TaskActionNonceClaims {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra || !sameSecret(signature(secret, encoded), suppliedSignature)) {
    throw new TaskActionConfirmationError("nonce_invalid", "Task action confirmation nonce is invalid.");
  }
  let claims: TaskActionNonceClaims;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TaskActionNonceClaims;
  } catch {
    throw new TaskActionConfirmationError("nonce_invalid", "Task action confirmation nonce payload is invalid.");
  }
  if (claims.version !== 1 || !claims.nonce_id || !Number.isFinite(claims.expires_at_ms)) {
    throw new TaskActionConfirmationError("nonce_invalid", "Task action confirmation nonce payload is incomplete.");
  }
  if (nowMs > claims.expires_at_ms) {
    throw new TaskActionConfirmationError("nonce_expired", "Task action confirmation nonce has expired.");
  }
  const expected = expectedClaims(binding);
  if (
    claims.project_id !== expected.project_id
    || claims.task_id !== expected.task_id
    || claims.action !== expected.action
    || claims.expected_status !== expected.expected_status
    || claims.step_id !== expected.step_id
    || claims.session_binding_hash !== expected.session_binding_hash
  ) {
    throw new TaskActionConfirmationError("nonce_binding_mismatch", "Task action confirmation nonce does not match this task action.");
  }
  return claims;
}

export async function consumeTaskActionNonce(
  consumedDir: string,
  secret: string,
  token: string,
  binding: TaskActionNonceBinding
): Promise<{ nonce_id_hash: string; expires_at: string }> {
  const claims = verifyTaskActionNonce(secret, token, binding);
  const nonceIdHash = digest(claims.nonce_id);
  const consumedPath = path.join(consumedDir, `${nonceIdHash}.json`);
  await fsp.mkdir(consumedDir, { recursive: true });
  try {
    const handle = await fsp.open(consumedPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        version: 1,
        nonce_id_hash: nonceIdHash,
        project_id: claims.project_id,
        task_id: claims.task_id,
        action: claims.action,
        expected_status: claims.expected_status,
        step_id: claims.step_id,
        consumed_at: new Date().toISOString(),
        expires_at: new Date(claims.expires_at_ms).toISOString()
      }, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TaskActionConfirmationError("nonce_reused", "Task action confirmation nonce has already been consumed.");
    }
    throw error;
  }
  return { nonce_id_hash: nonceIdHash, expires_at: new Date(claims.expires_at_ms).toISOString() };
}
