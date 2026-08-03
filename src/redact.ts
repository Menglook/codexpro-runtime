import { createHash } from "node:crypto";
import {
  redactSensitiveText as sharedRedactSensitiveText,
  redactStructured as sharedRedactStructured
} from "../shared/redaction.mjs";
import {
  CONTROLLED_EXECUTABLE_TEST_VECTOR_DIRECTIVE,
  CONTROLLED_TEST_VECTOR_DIRECTIVE,
  SENSITIVE_ASSIGNMENT_PREFIX_SOURCE,
  SENSITIVE_ASSIGNMENT_RULE_METADATA,
  SYNTHETIC_TEST_MARKERS,
  createSecretPatternRules,
  findSensitiveAssignmentCandidates,
  isControlledSyntheticTestVector,
  isPlaceholderSecretValue,
  isPlausibleSecretLiteral,
  isSecurityTestOrFixturePath
} from "../shared/security-rule-metadata.mjs";

export {
  CONTROLLED_EXECUTABLE_TEST_VECTOR_DIRECTIVE,
  CONTROLLED_TEST_VECTOR_DIRECTIVE,
  SYNTHETIC_TEST_MARKERS,
  isControlledSyntheticTestVector,
  isSecurityTestOrFixturePath
} from "../shared/security-rule-metadata.mjs";

const SENSITIVE_LITERAL_PREFIX_PATTERN = new RegExp("(" + SENSITIVE_ASSIGNMENT_PREFIX_SOURCE + ")$", "i");

export interface SecretValueFinding {
  rule: string;
  line: number;
  column: number;
  message: string;
}

export interface SecretValueCheckOptions {
  path?: string;
}

interface SecretPatternRule {
  rule: string;
  pattern: RegExp;
  message: string;
}

const SECRET_PATTERN_RULES: SecretPatternRule[] = createSecretPatternRules("write").map((metadata) => ({
  rule: metadata.rule,
  pattern: metadata.pattern,
  message: metadata.message
}));

function lineBounds(text: string, matchIndex: number): { line: number; column: number; lineStart: number; lineEnd: number } {
  const before = text.slice(0, matchIndex);
  const line = before.split(/\r?\n/).length;
  const lastNewline = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r"));
  const lineStart = lastNewline + 1;
  const nextNewline = text.indexOf("\n", matchIndex);
  const lineEnd = nextNewline >= 0 ? nextNewline : text.length;
  return { line, column: matchIndex - lineStart + 1, lineStart, lineEnd };
}

function isControlledSyntheticTestVectorMatch(text: string, match: RegExpExecArray, options: SecretValueCheckOptions): boolean {
  const bounds = lineBounds(text, match.index);
  const currentLine = text.slice(bounds.lineStart, bounds.lineEnd);
  const previousLineEnd = Math.max(0, bounds.lineStart - 1);
  const previousLineStart = bounds.lineStart === 0
    ? 0
    : Math.max(text.lastIndexOf("\n", previousLineEnd - 1), text.lastIndexOf("\r", previousLineEnd - 1)) + 1;
  const previousLine = bounds.lineStart === 0 ? "" : text.slice(previousLineStart, previousLineEnd);
  return isControlledSyntheticTestVector({
    filePath: options.path,
    matchedText: match[0],
    currentLine,
    previousLine
  });
}

interface SecretValueMatch {
  finding: SecretValueFinding;
  fingerprint: string;
}

function secretValueFingerprint(rule: string, matchedText: string): string {
  return createHash("sha256").update(`${rule}\u0000${matchedText}`).digest("hex");
}

function scanDirectSecretValueMatches(text: string, options: SecretValueCheckOptions = {}): SecretValueMatch[] {
  const matches: SecretValueMatch[] = [];
  for (const rule of SECRET_PATTERN_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      if (isPlaceholderSecretValue(match[0]) || isControlledSyntheticTestVectorMatch(text, match, options)) {
        if (!rule.pattern.global) break;
        continue;
      }
      const location = lineBounds(text, match.index);
      matches.push({
        finding: { rule: rule.rule, line: location.line, column: location.column, message: rule.message },
        fingerprint: secretValueFingerprint(rule.rule, match[0])
      });
      if (!rule.pattern.global) break;
    }
  }

  for (const candidate of findSensitiveAssignmentCandidates(text)) {
    if (candidate.kind !== "literal" || !isPlausibleSecretLiteral(candidate.literalValue, candidate.name)) continue;
    if (isPlaceholderSecretValue(candidate.raw)) continue;
    const syntheticMatch = Object.assign([candidate.raw] as unknown as RegExpExecArray, { index: candidate.start, input: text });
    if (isControlledSyntheticTestVectorMatch(text, syntheticMatch, options)) continue;
    const location = lineBounds(text, candidate.start);
    matches.push({
      finding: {
        rule: SENSITIVE_ASSIGNMENT_RULE_METADATA.rule,
        line: location.line,
        column: location.column,
        message: SENSITIVE_ASSIGNMENT_RULE_METADATA.message
      },
      fingerprint: secretValueFingerprint(SENSITIVE_ASSIGNMENT_RULE_METADATA.rule, candidate.raw)
    });
  }
  return matches;
}

function decodeJavascriptLiteral(literal: string): string {
  const body = literal.slice(1, -1);
  return body.replace(
    /\\u\{([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([\\"'bfnrtv0])/g,
    (_match, braced: string | undefined, unicode: string | undefined, hex: string | undefined, escaped: string | undefined) => {
      const codePoint = braced ?? unicode ?? hex;
      if (codePoint) {
        const numeric = Number.parseInt(codePoint, 16);
        return Number.isFinite(numeric) && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : "";
      }
      const simple: Record<string, string> = {
        "\\": "\\",
        "\"": "\"",
        "'": "'",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "0": "\0"
      };
      return simple[escaped ?? ""] ?? escaped ?? "";
    }
  );
}

interface JavascriptStringLiteral {
  start: number;
  end: number;
  raw: string;
  decoded: string;
}

function javascriptStringLiterals(text: string): JavascriptStringLiteral[] {
  const literals: JavascriptStringLiteral[] = [];
  let index = 0;
  while (index < text.length) {
    const quote = text[index];
    if (quote !== "\"" && quote !== "'") {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    let closed = false;
    while (index < text.length) {
      const character = text[index];
      if (character === "\r" || character === "\n") break;
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === quote) {
        closed = true;
        break;
      }
    }
    if (!closed) continue;
    const raw = text.slice(start, index);
    literals.push({ start, end: index, raw, decoded: decodeJavascriptLiteral(raw) });
  }
  return literals;
}

function obfuscatedCandidate(text: string, matchIndex: number, decodedValue: string): string {
  const bounds = lineBounds(text, matchIndex);
  const prefix = text.slice(bounds.lineStart, matchIndex).match(SENSITIVE_LITERAL_PREFIX_PATTERN)?.[1] ?? "";
  return `${prefix}${JSON.stringify(decodedValue)}`;
}

function scanObfuscatedSecretValueMatches(text: string, options: SecretValueCheckOptions): SecretValueMatch[] {
  const matches: SecretValueMatch[] = [];
  const seen = new Set<string>();
  const recordDecoded = (matchIndex: number, rawText: string, decodedValue: string) => {
    if (decodedValue === rawText || !decodedValue) return;
    const candidate = obfuscatedCandidate(text, matchIndex, decodedValue);
    const directMatches = scanDirectSecretValueMatches(candidate, options);
    for (const direct of directMatches) {
      const key = `${matchIndex}\u0000${direct.fingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const location = lineBounds(text, matchIndex);
      matches.push({
        finding: {
          rule: `obfuscated_${direct.finding.rule}`,
          line: location.line,
          column: location.column,
          message: `${direct.finding.message} after decoding an escaped or concatenated literal`
        },
        fingerprint: direct.fingerprint
      });
    }
  };

  const literals = javascriptStringLiterals(text);
  for (let index = 0; index < literals.length; index += 1) {
    let endIndex = index;
    while (endIndex + 1 < literals.length) {
      const gap = text.slice(literals[endIndex].end, literals[endIndex + 1].start);
      if (!/^\s*\+\s*$/.test(gap)) break;
      endIndex += 1;
    }
    if (endIndex > index) {
      const raw = text.slice(literals[index].start, literals[endIndex].end);
      const decoded = literals.slice(index, endIndex + 1).map((literal) => literal.decoded).join("");
      recordDecoded(literals[index].start, raw, decoded);
      index = endIndex;
    }
  }
  for (const literal of literals) {
    if (!/\\(?:u\{|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2})/.test(literal.raw)) continue;
    recordDecoded(literal.start, literal.raw, literal.decoded);
  }
  return matches;
}

function scanSecretValueMatches(text: string, options: SecretValueCheckOptions = {}): SecretValueMatch[] {
  return [
    ...scanDirectSecretValueMatches(text, options),
    ...scanObfuscatedSecretValueMatches(text, options)
  ];
}

export function findSecretValues(text: string, options: SecretValueCheckOptions = {}): SecretValueFinding[] {
  return scanSecretValueMatches(text, options).map((match) => match.finding);
}

export function findIntroducedSecretValues(
  before: string,
  after: string,
  options: SecretValueCheckOptions = {}
): SecretValueFinding[] {
  const existingCounts = new Map<string, number>();
  for (const match of scanSecretValueMatches(before, options)) {
    existingCounts.set(match.fingerprint, (existingCounts.get(match.fingerprint) ?? 0) + 1);
  }
  const introduced: SecretValueFinding[] = [];
  for (const match of scanSecretValueMatches(after, options)) {
    const remaining = existingCounts.get(match.fingerprint) ?? 0;
    if (remaining > 0) {
      existingCounts.set(match.fingerprint, remaining - 1);
    } else {
      introduced.push(match.finding);
    }
  }
  return introduced;
}

export function hasSecretValue(text: string, options: SecretValueCheckOptions = {}): boolean {
  return findSecretValues(text, options).length > 0;
}

export function redactSensitiveText(text: string): string {
  return sharedRedactSensitiveText(text);
}

export function redactStructured<T>(value: T, depth = 0): T {
  return sharedRedactStructured(value, depth);
}

const SENSITIVE_MEMORY_LINE_PATTERN = /\b(?:token|secret|password|private[_\s-]?key|api[_\s-]?key|authorization|cookie|cloudflare)\b/i;
const ENV_STYLE_ASSIGNMENT_PATTERN = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH|COOKIE)[A-Za-z0-9_]*\s*=/i;

export function redactMemoryCandidateText(text: string, maxChars = 40_000): string {
  const redacted = redactSensitiveText(text).slice(0, maxChars);
  return redacted
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (ENV_STYLE_ASSIGNMENT_PATTERN.test(line)) return "[REDACTED_SECRET_LINE]";
      if (line.includes("[REDACTED_SECRET]")) return line;
      if (SENSITIVE_MEMORY_LINE_PATTERN.test(line) && /[:=]\s*\S{8,}/.test(line)) {
        return line.replace(/([:=]\s*)\S.*$/u, "$1[REDACTED_SECRET]");
      }
      return line;
    })
    .join("\n");
}

