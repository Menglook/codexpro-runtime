import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { McpProtocolError } from "../protocolAdapter.js";

export interface RequestStatePayload {
  version: 1;
  requestId: string;
  method: string;
  name?: string;
  argumentsHash: string;
  actorId?: string;
  conversationId?: string;
  workspaceId?: string;
  workspaceGeneration?: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  continuation: Record<string, unknown>;
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function hashMcpArguments(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

export class RequestStateCodec {
  private readonly replayGuard = new Map<string, number>();

  constructor(private readonly secret: string, private readonly defaultTtlMs = 10 * 60_000) {
    if (!secret.trim()) throw new Error("A non-empty MCP request-state secret is required.");
  }

  seal(input: Omit<RequestStatePayload, "version" | "issuedAt" | "expiresAt" | "nonce">, ttlMs = this.defaultTtlMs): string {
    const now = Date.now();
    const payload: RequestStatePayload = {
      version: 1,
      ...input,
      issuedAt: now,
      expiresAt: now + Math.max(1_000, ttlMs),
      nonce: randomUUID()
    };
    const body = encode(JSON.stringify(payload));
    const signature = encode(createHmac("sha256", this.secret).update(body).digest());
    return `${body}.${signature}`;
  }

  open(token: string, expected?: Partial<Pick<RequestStatePayload, "method" | "name" | "actorId" | "conversationId" | "workspaceId" | "workspaceGeneration">>): RequestStatePayload {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) throw new McpProtocolError("Malformed requestState.", -32602);
    const expectedSignature = createHmac("sha256", this.secret).update(body).digest();
    const actualSignature = decode(signature);
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new McpProtocolError("requestState integrity validation failed.", -32602);
    }
    let payload: RequestStatePayload;
    try {
      payload = JSON.parse(decode(body).toString("utf8")) as RequestStatePayload;
    } catch {
      throw new McpProtocolError("requestState payload is invalid.", -32602);
    }
    if (payload.version !== 1 || payload.expiresAt <= Date.now()) {
      throw new McpProtocolError("requestState is expired or unsupported.", -32602);
    }
    this.sweep();
    if (this.replayGuard.has(payload.nonce)) throw new McpProtocolError("requestState replay detected.", -32602);
    for (const [key, value] of Object.entries(expected ?? {})) {
      if (value !== undefined && payload[key as keyof RequestStatePayload] !== value) {
        throw new McpProtocolError(`requestState ${key} binding mismatch.`, -32602);
      }
    }
    this.replayGuard.set(payload.nonce, payload.expiresAt);
    return payload;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.replayGuard) if (expiresAt <= now) this.replayGuard.delete(nonce);
  }
}
