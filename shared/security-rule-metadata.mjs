export const CONTROLLED_TEST_VECTOR_DIRECTIVE = 'codexpro-secret-scan: allow-test-vector';
export const CONTROLLED_EXECUTABLE_TEST_VECTOR_DIRECTIVE = 'codexpro-secret-scan: allow-executable-test-vector';
export const SYNTHETIC_TEST_MARKERS = Object.freeze(['fake', 'test', 'example', 'dummy', 'placeholder', 'synthetic']);

export const SENSITIVE_IDENTIFIER_PATTERN_SOURCE = String.raw`[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|AUTH|COOKIE)[A-Za-z0-9_]{0,64}`;
export const SENSITIVE_ASSIGNMENT_PREFIX_SOURCE = String.raw`(?<![A-Za-z0-9_$])["']?(${SENSITIVE_IDENTIFIER_PATTERN_SOURCE})["']?\s*[:=]\s*`;

export const SECRET_RULE_METADATA = Object.freeze([
  {
    rule: 'private_key_block',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'private key material pattern detected',
    audit: { source: String.raw`-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`, flags: 'i' }
  },
  {
    rule: 'openai_api_key',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'OpenAI-style API key pattern detected',
    audit: { source: String.raw`\bsk-[A-Za-z0-9_-]{20,}\b`, flags: 'g' },
    write: { source: String.raw`\bsk-[A-Za-z0-9_-]{10,}\b`, flags: 'g', replacement: 'whole' }
  },
  {
    rule: 'github_token',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'GitHub token pattern detected',
    audit: { source: String.raw`\b(?:gh[opsru]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b`, flags: 'g' },
    write: { source: String.raw`\b(?:gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`, flags: 'g', replacement: 'whole' }
  },
  {
    rule: 'npm_token',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'npm token pattern detected',
    audit: { source: String.raw`\bnpm_[A-Za-z0-9_-]{20,}\b`, flags: 'g' },
    write: { source: String.raw`\bnpm_[A-Za-z0-9_-]{20,}\b`, flags: 'g', replacement: 'whole' }
  },
  {
    rule: 'aws_access_key_id',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'AWS access key id pattern detected',
    audit: { source: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: 'g' },
    write: { source: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: 'g', replacement: 'whole' }
  },
  {
    rule: 'google_api_key',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'Google API key pattern detected',
    audit: { source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, flags: 'g' },
    write: { source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, flags: 'g', replacement: 'whole' }
  },
  {
    rule: 'bearer_token_literal',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'Bearer token literal detected',
    audit: { source: String.raw`\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}`, flags: 'gi' },
    write: { source: String.raw`\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}`, flags: 'gi', replacement: 'prefix' }
  },
  {
    rule: 'database_url_credentials',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'database URL with inline credentials detected',
    audit: { source: String.raw`\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@`, flags: 'gi' },
    write: { source: String.raw`\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@`, flags: 'gi', replacement: 'whole' }
  },
  {
    rule: 'cli_token_literal',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'CLI token literal detected',
    write: {
      source: String.raw`((?:\bngrok\s+config\s+add-authtoken|\bcloudflared\s+service\s+install|--(?:token|access-token|auth-token|api[_-]?key|authtoken))(?:=|\s+))[A-Za-z0-9._~+/=-]{8,}`,
      flags: 'gi',
      replacement: 'prefix'
    }
  },
  {
    rule: 'query_token_literal',
    version: '1',
    confidence: 'high',
    severity: 'error',
    message: 'token-like query parameter detected',
    write: {
      source: String.raw`([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'\x60<>]{8,}`,
      flags: 'gi',
      replacement: 'prefix'
    }
  }
]);

export const SENSITIVE_ASSIGNMENT_RULE_METADATA = Object.freeze({
  rule: 'secret_assignment_literal',
  version: '4',
  confidence: 'high',
  severity: 'error',
  message: 'sensitive assignment appears to contain a literal value'
});

export function createSecretPatternRules(context) {
  return SECRET_RULE_METADATA.flatMap((metadata) => {
    const specification = metadata[context];
    if (!specification) return [];
    return [{
      ...metadata,
      pattern: new RegExp(specification.source, specification.flags),
      replacement: specification.replacement ?? 'whole'
    }];
  });
}

export function isPlaceholderSecretValue(value) {
  const normalized = String(value ?? '').toLowerCase();
  const genericPlaceholder = /(?:^|[=:/?&\s"'`])<\s*(?:(?:your|example|placeholder)[_ -][^>]{0,32}?)?(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|token|secret|password|passwd|private[_ -]?key)(?:[_ -]*(?:here|value))?\s*>(?:$|[&\s"'`])/i.test(normalized);
  return (
    genericPlaceholder ||
    normalized.includes('[redacted_secret]') ||
    normalized.includes('[redacted') ||
    normalized.includes('redacted_secret') ||
    normalized.includes('replace-me') ||
    normalized.includes('replace-with') ||
    normalized.includes('keep-this-codexpro-token-stable') ||
    normalized.includes('keep-this-stable-token') ||
    normalized.includes('your-ngrok-token') ||
    normalized.includes('your-token') ||
    normalized.includes('your-api-key') ||
    normalized.includes('your-secret') ||
    normalized.includes('your-password') ||
    normalized.includes('<openai_api_key>') ||
    normalized.includes('process.env.') ||
    normalized.includes('import.meta.env.') ||
    normalized.includes('os.environ') ||
    normalized.includes('getenv(') ||
    normalized.includes('<redacted>') ||
    normalized === 'sk-...' ||
    normalized.endsWith('=sk-...')
  );
}

const BENIGN_SENSITIVE_LITERAL_VALUES = new Set([
  'unavailable',
  'unknown',
  'measured',
  'estimated',
  'derived',
  'provider_reported',
  'not_applicable',
  'not_available',
  'disabled',
  'enabled',
  'present',
  'absent',
  'optional',
  'required',
  'access_token',
  'refresh_token',
  'bearer_token',
  'authorization_code'
]);

function hasStrongSensitiveIdentifier(identifier) {
  const segmented = String(identifier ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return /(?:^|_)(?:api_?key|token|secret|password|passwd|credential|private_?key|cookie)(?:_|$)/.test(segmented);
}

export function isPlausibleSecretLiteral(value, identifier = '') {
  const raw = String(value ?? '').trim();
  if (raw.length < 8 || isPlaceholderSecretValue(raw)) return false;
  const normalized = raw.toLowerCase();
  const normalizedIdentifier = String(identifier ?? '').trim().toLowerCase();
  if (
    (normalizedIdentifier === 'authority' || normalizedIdentifier.endsWith('_authority'))
    && /^[a-z0-9_.:/~<>-]+$/i.test(raw)
    && !/(?:api[_-]?key|token|secret|password|passwd|credential|cookie|private[_-]?key)/i.test(raw)
  ) return false;
  if (BENIGN_SENSITIVE_LITERAL_VALUES.has(normalized)) return false;
  if (/^(?:https?|socks5?):\/\/[^\s/:]+:[^\s@/]+@/i.test(raw)) return true;
  if (/\b(?:credential|secret|password|passwd|private[_-]?key)\b/i.test(raw)) return true;
  if (/\s/.test(raw)) return false;
  const identifierLike = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(raw);
  const sensitiveWord = /(?:^|[_-])(?:api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|cookie)(?:$|[_-])/i.test(raw);
  if (identifierLike && !sensitiveWord) return false;
  if (hasStrongSensitiveIdentifier(identifier)) return true;
  const classes = [/[a-z]/.test(raw), /[A-Z]/.test(raw), /\d/.test(raw), /[^A-Za-z0-9]/.test(raw)].filter(Boolean).length;
  if (raw.length >= 20 && classes >= 2) return true;
  if (raw.length >= 12 && classes >= 3) return true;
  return false;
}

export function isSecurityTestOrFixturePath(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => ['test', 'tests', '__tests__', 'fixture', 'fixtures', 'benchmarks', 'evaluators'].includes(segment))) return true;
  const base = segments.at(-1) ?? '';
  return /(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(base);
}

function isExecutableSecurityTestHarnessPath(filePath) {
  const normalized = String(filePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  if (!normalized.startsWith('scripts/')) return false;
  const base = normalized.split('/').at(-1) ?? '';
  return base === 'smoke.mjs' || base === 'stress.mjs' || /(?:^|[-_.])smoke(?:[-_.]|$)/.test(base);
}

export function isControlledSyntheticTestVector(input) {
  const normalizedMatch = String(input.matchedText ?? '').toLowerCase();
  const currentLine = String(input.currentLine ?? '').toLowerCase();
  const previousLine = String(input.previousLine ?? '').toLowerCase();
  const nearbyText = `${previousLine}\n${currentLine}`;
  if (isSecurityTestOrFixturePath(input.filePath)) {
    if (!SYNTHETIC_TEST_MARKERS.some((marker) => normalizedMatch.includes(marker))) return false;
    return nearbyText.includes(CONTROLLED_TEST_VECTOR_DIRECTIVE);
  }
  if (!isExecutableSecurityTestHarnessPath(input.filePath)) return false;
  return nearbyText.includes(CONTROLLED_EXECUTABLE_TEST_VECTOR_DIRECTIVE);
}

function decodeEscapes(value) {
  return value.replace(
    /\\u\{([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\x([0-9A-Fa-f]{2})|\\([\\"'bfnrtv0])/g,
    (_match, braced, unicode, hex, escaped) => {
      const codePoint = braced ?? unicode ?? hex;
      if (codePoint) {
        const numeric = Number.parseInt(codePoint, 16);
        return Number.isFinite(numeric) && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : '';
      }
      const simple = {
        '\\': '\\',
        '"': '"',
        "'": "'",
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
        v: '\v',
        '0': '\0'
      };
      return simple[escaped ?? ''] ?? escaped ?? '';
    }
  );
}

function readQuotedLiteral(expression, start) {
  const quote = expression[start];
  if (quote !== '"' && quote !== "'" && quote !== '\x60') return undefined;
  let index = start + 1;
  let rawBody = '';
  while (index < expression.length) {
    const character = expression[index];
    if (character === '\\') {
      rawBody += character;
      index += 1;
      if (index < expression.length) rawBody += expression[index];
      index += 1;
      continue;
    }
    if (quote === '\x60' && character === '$' && expression[index + 1] === '{') return undefined;
    if (character === quote) {
      return { end: index + 1, decoded: decodeEscapes(rawBody), quote };
    }
    if (character === '\r' || character === '\n') return undefined;
    rawBody += character;
    index += 1;
  }
  return undefined;
}

export function parseStaticStringExpression(input) {
  const expression = String(input ?? '').trim().replace(/\s+as\s+const\s*$/i, '').trim();
  if (!expression) return undefined;
  let index = 0;
  const parts = [];
  let literalCount = 0;
  let firstQuote = '';
  while (index < expression.length) {
    while (/\s/.test(expression[index] ?? '')) index += 1;
    const literal = readQuotedLiteral(expression, index);
    if (!literal) return undefined;
    if (!firstQuote) firstQuote = literal.quote;
    parts.push(literal.decoded);
    literalCount += 1;
    index = literal.end;
    while (/\s/.test(expression[index] ?? '')) index += 1;
    if (index >= expression.length) break;
    if (expression[index] !== '+') return undefined;
    index += 1;
  }
  return {
    value: parts.join(''),
    expressionKind: literalCount > 1
      ? 'concatenation'
      : firstQuote === '"'
        ? 'double_quoted_literal'
        : firstQuote === "'"
          ? 'single_quoted_literal'
          : 'template_literal'
  };
}

export function classifySensitiveExpression(input) {
  const expression = String(input ?? '').trim().replace(/\s+(?:as\s+const|satisfies\s+[^,;]+)\s*$/i, '').trim();
  if (!expression) return { kind: 'empty', expressionKind: 'pattern' };
  const typeExpression = /^(?:readonly\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^;]+>|(?:\[\])+)(?:\s*[|&]\s*[^;]+)*$/u.test(expression)
    || /^(?:string|number|boolean|unknown|never|object|symbol|bigint)(?:\s*[|&]\s*[^;]+)+$/u.test(expression);
  if (typeExpression) return { kind: 'dynamic', expressionKind: 'reference' };

  const staticString = parseStaticStringExpression(expression);
  if (staticString) {
    return {
      kind: 'literal',
      expressionKind: staticString.expressionKind,
      literalValue: staticString.value
    };
  }

  if (/^(?:null|undefined|true|false|NaN|Infinity|-?\d+(?:\.\d+)?n?)$/i.test(expression)) {
    return { kind: 'dynamic', expressionKind: 'reference' };
  }
  if (/^(?:\+\+|--)[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]]+\])*$/u.test(expression)) {
    return { kind: 'dynamic', expressionKind: 'reference' };
  }
  if (/^(?:process\??\.env|import\.meta\.env|Deno\.env|Bun\.env|os\.environ|ENV|env)\b/i.test(expression)) {
    return { kind: 'dynamic', expressionKind: /\(/.test(expression) ? 'call_expression' : 'reference' };
  }
  if (/^(?:getenv|env|getEnv|readEnv|resolveEnv|Number|String|Boolean|parseInt|parseFloat)\s*\(/i.test(expression)) {
    return { kind: 'dynamic', expressionKind: 'call_expression' };
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:!?\??\.)[A-Za-z_$][A-Za-z0-9_$]*|!|\[[^\]]+\])*\s*\(/.test(expression)) {
    return { kind: 'dynamic', expressionKind: 'call_expression' };
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:!?\??\.)[A-Za-z_$][A-Za-z0-9_$]*|!|\[[^\]]+\])*$/.test(expression)) {
    return { kind: 'dynamic', expressionKind: 'reference' };
  }
  if (/^(?:new\s+|await\s+|\{\s*|\[\s*)/.test(expression) || /(?:\?\?|\|\||&&|=>|\?[^:]*:)/.test(expression)) {
    return { kind: 'dynamic', expressionKind: /\(/.test(expression) ? 'call_expression' : 'reference' };
  }

  const bare = expression.replace(/\s*(?:\/\/|#).*$/, '').trim();
  if (/^[^\s,;{}]+$/.test(bare) && bare.length >= 12) {
    return { kind: 'literal', expressionKind: 'pattern', literalValue: bare };
  }
  return { kind: 'unknown', expressionKind: 'pattern' };
}

function expressionEnd(text, start) {
  let quote = '';
  let escaped = false;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '\x60') {
      quote = character;
      continue;
    }
    if (character === '(') roundDepth += 1;
    else if (character === ')') roundDepth = Math.max(0, roundDepth - 1);
    else if (character === '[') squareDepth += 1;
    else if (character === ']') squareDepth = Math.max(0, squareDepth - 1);
    else if (character === '<') angleDepth += 1;
    else if (character === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (character === '{') curlyDepth += 1;
    else if (character === '}') {
      if (curlyDepth === 0 && roundDepth === 0 && squareDepth === 0 && angleDepth === 0) return index;
      curlyDepth = Math.max(0, curlyDepth - 1);
    } else if ((character === ',' || character === ';' || character === '\r' || character === '\n') && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0 && angleDepth === 0) {
      return index;
    }
  }
  return text.length;
}

function isInsideQuotedRange(text, index) {
  let quote = '';
  let escaped = false;
  for (let cursor = 0; cursor < Math.min(index, text.length); cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '\x60' && text.slice(cursor, cursor + 3) === '\x60\x60\x60') {
      while (text[cursor + 1] === '\x60') cursor += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '\x60') quote = character;
  }
  return Boolean(quote);
}

export function findSensitiveAssignmentCandidates(text) {
  const value = String(text ?? '');
  const pattern = new RegExp(SENSITIVE_ASSIGNMENT_PREFIX_SOURCE, 'gi');
  const results = [];
  let match;
  while ((match = pattern.exec(value)) !== null) {
    if (isInsideQuotedRange(value, match.index)) {
      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
      continue;
    }
    const rhsStart = pattern.lastIndex;
    const rhsEnd = expressionEnd(value, rhsStart);
    const rhs = value.slice(rhsStart, rhsEnd).trim();
    let classification = classifySensitiveExpression(rhs);
    const lineStart = value.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1;
    const leadingText = value.slice(lineStart, match.index).trim();
    const standaloneAssignment = leadingText === '' || /^export$/i.test(leadingText) || /^\d+\s*\|$/.test(leadingText);
    const bareRhs = rhs.replace(/\s*(?:\/\/|#).*$/, '').trim();
    const separator = match[0].includes(':') ? ':' : '=';
    const colonLiteralEvidence = separator !== ':'
      || bareRhs.length >= 20
      || /\d|[^A-Za-z0-9_$]/.test(bareRhs);
    if (
      classification.kind === 'dynamic'
      && classification.expressionKind === 'reference'
      && standaloneAssignment
      && hasStrongSensitiveIdentifier(match[1] ?? '')
      && /^[^\s,;{}]{8,}$/.test(bareRhs)
      && !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(bareRhs)
      && colonLiteralEvidence
    ) {
      classification = { kind: 'literal', expressionKind: 'pattern', literalValue: bareRhs };
    }
    results.push({
      name: match[1] ?? '',
      start: match.index,
      end: rhsEnd,
      rhsStart,
      rhsEnd,
      raw: value.slice(match.index, rhsEnd),
      rhs,
      ...classification
    });
    if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
  }
  return results;
}
