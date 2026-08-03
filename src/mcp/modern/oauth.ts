import { createHash, timingSafeEqual } from "node:crypto";
import { McpProtocolError } from "../protocolAdapter.js";
import type { McpHeaderMap } from "./requestContext.js";

function header(headers: McpHeaderMap, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}

function audienceValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

export interface ModernOAuthPolicy {
  resource: string;
  audience?: string;
  authorizationServers: string[];
  scopesSupported: string[];
  dpopRequired: boolean;
}

export interface ModernOAuthTokenClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  client_id?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  scope?: string;
}

export class ModernOAuthReplayGuard {
  private readonly seen = new Map<string, number>();

  assertFresh(jti: string | undefined, expiresAtSeconds: number | undefined): void {
    if (!jti) return;
    this.sweep();
    if (this.seen.has(jti)) throw new McpProtocolError("OAuth token replay detected.", -32001);
    this.seen.set(jti, (expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 300) * 1000);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(jti);
  }
}

export function protectedResourceMetadata(policy: ModernOAuthPolicy): Record<string, unknown> {
  return {
    resource: policy.resource,
    authorization_servers: policy.authorizationServers,
    scopes_supported: policy.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256", "ES256"],
    code_challenge_methods_supported: ["S256"],
    ...(policy.dpopRequired ? { dpop_signing_alg_values_supported: ["ES256", "EdDSA"] } : {})
  };
}

export function validateModernOAuthHeaders(headers: McpHeaderMap, policy: ModernOAuthPolicy): void {
  const resource = header(headers, "mcp-resource");
  const audience = header(headers, "mcp-audience");
  if (resource && resource !== policy.resource) {
    throw new McpProtocolError("OAuth protected resource mismatch.", -32001, { expected: policy.resource });
  }
  if (policy.audience && audience !== policy.audience) {
    throw new McpProtocolError("OAuth token audience binding is missing or invalid.", -32001, { expected: policy.audience });
  }
  if (policy.dpopRequired && !header(headers, "dpop")) {
    throw new McpProtocolError("DPoP proof is required for this MCP resource.", -32001);
  }
}

export function validateModernOAuthClaims(
  claims: ModernOAuthTokenClaims,
  policy: ModernOAuthPolicy,
  options: {
    clientId?: string;
    requiredScopes?: string[];
    clockSkewSeconds?: number;
    replayGuard?: ModernOAuthReplayGuard;
  } = {}
): void {
  const now = Math.floor(Date.now() / 1000);
  const skew = Math.max(0, options.clockSkewSeconds ?? 60);
  if (policy.authorizationServers.length > 0 && (!claims.iss || !policy.authorizationServers.includes(claims.iss))) {
    throw new McpProtocolError("OAuth issuer is not trusted.", -32001);
  }
  const expectedAudience = policy.audience ?? policy.resource;
  if (!audienceValues(claims.aud).includes(expectedAudience)) {
    throw new McpProtocolError("OAuth token audience claim is invalid.", -32001, { expected: expectedAudience });
  }
  if (claims.exp === undefined || claims.exp < now - skew) {
    throw new McpProtocolError("OAuth token is expired or has no expiry.", -32001);
  }
  if (claims.nbf !== undefined && claims.nbf > now + skew) {
    throw new McpProtocolError("OAuth token is not active yet.", -32001);
  }
  if (claims.iat !== undefined && claims.iat > now + skew) {
    throw new McpProtocolError("OAuth token issued-at claim is in the future.", -32001);
  }
  if (options.clientId) {
    const boundClient = claims.azp ?? claims.client_id;
    if (boundClient !== options.clientId) {
      throw new McpProtocolError("OAuth client binding is invalid.", -32001, { expected: options.clientId });
    }
  }
  const grantedScopes = new Set(String(claims.scope ?? "").split(/\s+/).filter(Boolean));
  for (const required of options.requiredScopes ?? []) {
    if (!grantedScopes.has(required)) throw new McpProtocolError("OAuth token scope is insufficient.", -32001, { required });
  }
  options.replayGuard?.assertFresh(claims.jti, claims.exp);
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const expectedBuffer = Buffer.from(expectedChallenge);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function validateRedirectUriExact(actual: string, registered: string[]): void {
  if (!registered.includes(actual)) throw new McpProtocolError("OAuth redirect URI is not registered exactly.", -32001);
}

export function validateOAuthState(actual: string | undefined, expected: string): void {
  if (!actual) throw new McpProtocolError("OAuth state is missing.", -32001);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new McpProtocolError("OAuth state validation failed.", -32001);
  }
}
