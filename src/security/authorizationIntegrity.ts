import { hashAgentValue } from "../agents/completionProof.js";

export type AuthorizationPayloadFindingCode =
  | "bidi_control"
  | "zero_width_character"
  | "invisible_separator"
  | "nonstandard_quote"
  | "nonstandard_dash"
  | "unicode_compatibility_change"
  | "mixed_script_identifier"
  | "normalized_key_collision"
  | "non_json_scalar";

export type AuthorizationPayloadFindingSeverity = "warning" | "manual_confirmation";

export interface AuthorizationPayloadFinding {
  code: AuthorizationPayloadFindingCode;
  severity: AuthorizationPayloadFindingSeverity;
  path: string;
  code_points: string[];
  message: string;
}

export interface AuthorizationPayloadIntegrityV1 {
  version: 1;
  raw_hash: string;
  normalized_hash: string;
  normalized_payload: unknown;
  unicode_findings: AuthorizationPayloadFinding[];
  changed: boolean;
  requires_warning: boolean;
  requires_manual_confirmation: boolean;
}

export interface AuthorizationPayloadBindingV1 {
  version: 1;
  binding_id: string;
  payload_version: number;
  scope: string;
  raw_hash: string;
  normalized_hash: string;
  approved_payload_hash: string;
  executed_payload_hash: string | null;
  approved_by: string;
  approved_at: string;
  manual_confirmation: boolean;
  finding_codes: AuthorizationPayloadFindingCode[];
}

export interface AuthorizationPayloadVerification {
  valid: boolean;
  reasons: string[];
  integrity: AuthorizationPayloadIntegrityV1;
}

export const AUTHORIZATION_PAYLOAD_INTEGRITY_V1_FIELDS = [
  "version",
  "raw_hash",
  "normalized_hash",
  "normalized_payload",
  "unicode_findings",
  "changed",
  "requires_warning",
  "requires_manual_confirmation"
] as const satisfies readonly (keyof AuthorizationPayloadIntegrityV1)[];

export const AUTHORIZATION_PAYLOAD_BINDING_V1_FIELDS = [
  "version",
  "binding_id",
  "payload_version",
  "scope",
  "raw_hash",
  "normalized_hash",
  "approved_payload_hash",
  "executed_payload_hash",
  "approved_by",
  "approved_at",
  "manual_confirmation",
  "finding_codes"
] as const satisfies readonly (keyof AuthorizationPayloadBindingV1)[];

const BIDI_CONTROLS = new Set([
  0x061c,
  0x200e,
  0x200f,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069
]);

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const INVISIBLE_SEPARATORS = new Set([
  0x00a0,
  0x1680,
  0x180e,
  0x2000,
  0x2001,
  0x2002,
  0x2003,
  0x2004,
  0x2005,
  0x2006,
  0x2007,
  0x2008,
  0x2009,
  0x200a,
  0x2028,
  0x2029,
  0x202f,
  0x205f,
  0x3000
]);

const QUOTE_REPLACEMENTS = new Map<string, string>([
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", "\""],
  ["”", "\""],
  ["„", "\""],
  ["‟", "\""],
  ["＇", "'"],
  ["＂", "\""]
]);

const DASH_REPLACEMENTS = new Map<string, string>([
  ["‐", "-"],
  ["‑", "-"],
  ["‒", "-"],
  ["–", "-"],
  ["—", "-"],
  ["―", "-"],
  ["−", "-"],
  ["﹘", "-"],
  ["﹣", "-"],
  ["－", "-"]
]);

function codePointLabel(value: number): string {
  return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function pathFor(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(key)}]`;
}

function finding(
  findings: AuthorizationPayloadFinding[],
  code: AuthorizationPayloadFindingCode,
  severity: AuthorizationPayloadFindingSeverity,
  path: string,
  codePoints: number[],
  message: string
): void {
  const labels = unique(codePoints.map(codePointLabel));
  const key = `${code}:${path}:${labels.join(",")}`;
  if (findings.some((item) => `${item.code}:${item.path}:${item.code_points.join(",")}` === key)) return;
  findings.push({ code, severity, path, code_points: labels, message });
}

function mixedScriptCodePoints(value: string): number[] {
  const risky: number[] = [];
  const tokens = value.match(/[\p{Letter}\p{Number}._:/@-]+/gu) ?? [];
  for (const token of tokens) {
    const hasLatin = /\p{Script=Latin}/u.test(token);
    const hasCyrillic = /\p{Script=Cyrillic}/u.test(token);
    const hasGreek = /\p{Script=Greek}/u.test(token);
    if (!hasLatin || (!hasCyrillic && !hasGreek)) continue;
    risky.push(...[...token]
      .map((char) => char.codePointAt(0) ?? 0)
      .filter((point) => {
        const char = String.fromCodePoint(point);
        return /\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Greek}/u.test(char);
      }));
  }
  return risky;
}

function normalizeString(value: string, path: string, findings: AuthorizationPayloadFinding[]): string {
  const codePoints = [...value].map((char) => char.codePointAt(0) ?? 0);
  const bidi = codePoints.filter((point) => BIDI_CONTROLS.has(point));
  const zeroWidth = codePoints.filter((point) => ZERO_WIDTH.has(point));
  const invisible = codePoints.filter((point) => INVISIBLE_SEPARATORS.has(point));
  const quotes = [...value].filter((char) => QUOTE_REPLACEMENTS.has(char)).map((char) => char.codePointAt(0) ?? 0);
  const dashes = [...value].filter((char) => DASH_REPLACEMENTS.has(char)).map((char) => char.codePointAt(0) ?? 0);
  if (bidi.length) finding(findings, "bidi_control", "manual_confirmation", path, bidi, "Bidirectional control characters can change the visual order of an authorization payload.");
  if (zeroWidth.length) finding(findings, "zero_width_character", "manual_confirmation", path, zeroWidth, "Zero-width characters can conceal changes inside commands, URLs, paths, or identifiers.");
  if (invisible.length) finding(findings, "invisible_separator", "warning", path, invisible, "Non-standard invisible separators were normalized for comparison.");
  if (quotes.length) finding(findings, "nonstandard_quote", "warning", path, quotes, "Non-standard quotation marks were normalized for comparison.");
  if (dashes.length) finding(findings, "nonstandard_dash", "warning", path, dashes, "Non-standard dash or hyphen characters were normalized for comparison.");

  const mixed = mixedScriptCodePoints(value);
  if (mixed.length) {
    finding(findings, "mixed_script_identifier", "manual_confirmation", path, mixed, "Latin mixed with Cyrillic or Greek characters can create a homoglyph identifier.");
  }

  const compatibilityNormalized = value.normalize("NFKC");
  if (compatibilityNormalized !== value) {
    const changedPoints = codePoints.filter((point, index) => String.fromCodePoint(point) !== [...compatibilityNormalized][index]);
    finding(
      findings,
      "unicode_compatibility_change",
      "warning",
      path,
      changedPoints.length ? changedPoints : codePoints,
      "Unicode compatibility normalization changes this value; the difference must remain visible to the approver."
    );
  }

  let normalized = compatibilityNormalized.replace(/\r\n?/g, "\n");
  normalized = [...normalized].map((char) => {
    const point = char.codePointAt(0) ?? 0;
    if (BIDI_CONTROLS.has(point) || ZERO_WIDTH.has(point)) return "";
    if (INVISIBLE_SEPARATORS.has(point)) return " ";
    return QUOTE_REPLACEMENTS.get(char) ?? DASH_REPLACEMENTS.get(char) ?? char;
  }).join("");
  return normalized;
}

function normalizePayloadNode(
  value: unknown,
  path: string,
  findings: AuthorizationPayloadFinding[],
  seen: WeakSet<object>
): unknown {
  if (typeof value === "string") return normalizeString(value, path, findings);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    finding(findings, "non_json_scalar", "manual_confirmation", path, [], "Non-JSON scalar was converted to a string for authorization comparison.");
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`Authorization payload contains a cycle at ${path}.`);
    seen.add(value);
    const normalized = value.map((item, index) => normalizePayloadNode(item, pathFor(path, index), findings, seen));
    seen.delete(value);
    return normalized;
  }
  if (value instanceof Date) return normalizeString(value.toISOString(), path, findings);
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error(`Authorization payload contains a cycle at ${path}.`);
    seen.add(value);
    const output: Record<string, unknown> = {};
    const normalizedKeys = new Map<string, string>();
    for (const [rawKey, item] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      const normalizedKey = normalizeString(rawKey, `${path}.$key(${JSON.stringify(rawKey)})`, findings);
      const previous = normalizedKeys.get(normalizedKey);
      if (previous && previous !== rawKey) {
        finding(
          findings,
          "normalized_key_collision",
          "manual_confirmation",
          path,
          [...rawKey, ...previous].map((char) => char.codePointAt(0) ?? 0),
          "Two object keys collapse to the same normalized key."
        );
      }
      normalizedKeys.set(normalizedKey, rawKey);
      output[normalizedKey] = normalizePayloadNode(item, pathFor(path, normalizedKey), findings, seen);
    }
    seen.delete(value);
    return output;
  }
  return value;
}

export function analyzeAuthorizationPayload(payload: unknown): AuthorizationPayloadIntegrityV1 {
  const findings: AuthorizationPayloadFinding[] = [];
  const normalizedPayload = normalizePayloadNode(payload, "$", findings, new WeakSet());
  const rawHash = hashAgentValue(payload);
  const normalizedHash = hashAgentValue(normalizedPayload);
  return {
    version: 1,
    raw_hash: rawHash,
    normalized_hash: normalizedHash,
    normalized_payload: normalizedPayload,
    unicode_findings: findings,
    changed: rawHash !== normalizedHash,
    requires_warning: findings.length > 0,
    requires_manual_confirmation: findings.some((item) => item.severity === "manual_confirmation")
  };
}

export interface AuthorizationPayloadBindingOptions {
  payloadVersion?: number;
  scope: string;
  approvedBy: string;
  approvedAt?: string;
  manualConfirmation?: boolean;
}

export function authorizationPayloadRawHash(payload: unknown): string {
  return hashAgentValue(payload);
}

export function createAuthorizationPayloadBindingFromIntegrity(
  integrity: AuthorizationPayloadIntegrityV1,
  options: AuthorizationPayloadBindingOptions
): AuthorizationPayloadBindingV1 {
  const approvedAt = options.approvedAt ?? new Date().toISOString();
  const unsigned = {
    version: 1 as const,
    payload_version: Math.max(1, Math.floor(options.payloadVersion ?? 1)),
    scope: String(options.scope ?? "").trim(),
    raw_hash: integrity.raw_hash,
    normalized_hash: integrity.normalized_hash,
    approved_payload_hash: integrity.raw_hash,
    executed_payload_hash: null,
    approved_by: String(options.approvedBy ?? "").trim(),
    approved_at: approvedAt,
    manual_confirmation: options.manualConfirmation === true,
    finding_codes: unique(integrity.unicode_findings.map((item) => item.code)).sort()
  };
  if (!unsigned.scope) throw new Error("Authorization payload binding requires scope.");
  if (!unsigned.approved_by) throw new Error("Authorization payload binding requires approvedBy.");
  const bindingHash = hashAgentValue(unsigned);
  return {
    ...unsigned,
    binding_id: `authbind_${bindingHash.slice("sha256:".length, "sha256:".length + 24)}`
  };
}

export function createAuthorizationPayloadBinding(
  payload: unknown,
  options: AuthorizationPayloadBindingOptions
): AuthorizationPayloadBindingV1 {
  return createAuthorizationPayloadBindingFromIntegrity(analyzeAuthorizationPayload(payload), options);
}

export function verifyAuthorizationPayloadBindingWithIntegrity(
  integrity: AuthorizationPayloadIntegrityV1,
  binding: AuthorizationPayloadBindingV1,
  options: { requireManualConfirmation?: boolean } = {}
): AuthorizationPayloadVerification {
  const reasons: string[] = [];
  if (binding.version !== 1) reasons.push("unsupported_binding_version");
  if (!binding.binding_id) reasons.push("binding_id_missing");
  if (binding.raw_hash !== integrity.raw_hash) reasons.push("raw_hash_mismatch");
  if (binding.normalized_hash !== integrity.normalized_hash) reasons.push("normalized_hash_mismatch");
  if (binding.approved_payload_hash !== integrity.raw_hash) reasons.push("approved_payload_hash_mismatch");
  if (binding.executed_payload_hash !== null && binding.executed_payload_hash !== integrity.raw_hash) reasons.push("executed_payload_hash_mismatch");
  const expectedCodes = unique(integrity.unicode_findings.map((item) => item.code)).sort();
  if (hashAgentValue(binding.finding_codes) !== hashAgentValue(expectedCodes)) reasons.push("finding_codes_mismatch");
  if (options.requireManualConfirmation !== false && integrity.requires_manual_confirmation && binding.manual_confirmation !== true) reasons.push("manual_confirmation_required");
  const { binding_id: _bindingId, ...unsigned } = binding;
  const bindingHash = hashAgentValue(unsigned);
  const expectedId = `authbind_${bindingHash.slice("sha256:".length, "sha256:".length + 24)}`;
  if (binding.binding_id !== expectedId) reasons.push("binding_id_mismatch");
  return { valid: reasons.length === 0, reasons, integrity };
}

export function verifyAuthorizationPayloadBinding(
  payload: unknown,
  binding: AuthorizationPayloadBindingV1,
  options: { requireManualConfirmation?: boolean } = {}
): AuthorizationPayloadVerification {
  return verifyAuthorizationPayloadBindingWithIntegrity(analyzeAuthorizationPayload(payload), binding, options);
}

export function bindExecutedAuthorizationPayloadFromIntegrity(
  integrity: AuthorizationPayloadIntegrityV1,
  binding: AuthorizationPayloadBindingV1,
  options: { requireManualConfirmation?: boolean } = {}
): AuthorizationPayloadBindingV1 {
  const verification = verifyAuthorizationPayloadBindingWithIntegrity(integrity, binding, options);
  if (!verification.valid) throw new Error(`Authorization payload binding failed: ${verification.reasons.join(", ")}.`);
  const updated: AuthorizationPayloadBindingV1 = {
    ...binding,
    executed_payload_hash: verification.integrity.raw_hash
  };
  const { binding_id: _bindingId, ...unsigned } = updated;
  const bindingHash = hashAgentValue(unsigned);
  return {
    ...updated,
    binding_id: `authbind_${bindingHash.slice("sha256:".length, "sha256:".length + 24)}`
  };
}

export function bindExecutedAuthorizationPayload(
  payload: unknown,
  binding: AuthorizationPayloadBindingV1,
  options: { requireManualConfirmation?: boolean } = {}
): AuthorizationPayloadBindingV1 {
  return bindExecutedAuthorizationPayloadFromIntegrity(analyzeAuthorizationPayload(payload), binding, options);
}

export function authorizationDecisionPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Authorization decision must be an object.");
  const payload = { ...(value as Record<string, unknown>) };
  delete payload.payload_binding;
  return payload;
}

export function authorizationPayloadAuditSummary(integrity: AuthorizationPayloadIntegrityV1): Record<string, unknown> {
  return {
    version: integrity.version,
    raw_hash: integrity.raw_hash,
    normalized_hash: integrity.normalized_hash,
    changed: integrity.changed,
    requires_warning: integrity.requires_warning,
    requires_manual_confirmation: integrity.requires_manual_confirmation,
    findings: integrity.unicode_findings.map((item) => ({
      code: item.code,
      severity: item.severity,
      path: item.path,
      code_points: item.code_points
    }))
  };
}
