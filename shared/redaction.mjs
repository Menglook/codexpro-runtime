import {
  createSecretPatternRules,
  findSensitiveAssignmentCandidates,
  isPlaceholderSecretValue,
  isPlausibleSecretLiteral
} from './security-rule-metadata.mjs';

const REDACTION_RULES = createSecretPatternRules('write');

function redactDirectSecretPatterns(value) {
  let text = value;
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args) => {
      const match = String(args[0] ?? '');
      if (isPlaceholderSecretValue(match)) return match;
      if (rule.replacement === 'prefix') return `${String(args[1] ?? '')}[REDACTED_SECRET]`;
      return '[REDACTED_SECRET]';
    });
  }
  return text;
}

function redactSensitiveAssignments(value) {
  const candidates = findSensitiveAssignmentCandidates(value)
    .filter((candidate) => candidate.kind === 'literal' && isPlausibleSecretLiteral(candidate.literalValue, candidate.name))
    .filter((candidate) => !isPlaceholderSecretValue(candidate.raw))
    .sort((left, right) => right.rhsStart - left.rhsStart);
  let text = value;
  for (const candidate of candidates) {
    text = `${text.slice(0, candidate.rhsStart)}[REDACTED_SECRET]${text.slice(candidate.rhsEnd)}`;
  }
  return text;
}

export function redactSensitiveText(value) {
  const text = String(value ?? '');
  return redactSensitiveAssignments(redactDirectSecretPatterns(text));
}

export function redactStructured(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactStructured(item, depth + 1);
  return out;
}

export function redactEnvironmentObject(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)/i.test(key)
      ? '<redacted>'
      : redactSensitiveText(String(value));
  }
  return out;
}
