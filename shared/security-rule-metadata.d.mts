export type SecretRuleContext = 'audit' | 'write';
export type SharedExpressionKind = 'double_quoted_literal' | 'single_quoted_literal' | 'template_literal' | 'concatenation' | 'call_expression' | 'reference' | 'pattern';

export interface SecretRulePattern {
  source: string;
  flags: string;
  replacement?: 'whole' | 'prefix';
}

export interface SecretRuleMetadata {
  rule: string;
  version: string;
  confidence: 'low' | 'medium' | 'high';
  severity: 'info' | 'warn' | 'error';
  message: string;
  audit?: SecretRulePattern;
  write?: SecretRulePattern;
}

export interface SecretPatternRule extends SecretRuleMetadata {
  pattern: RegExp;
  replacement: 'whole' | 'prefix';
}

export interface SensitiveExpressionClassification {
  kind: 'literal' | 'dynamic' | 'empty' | 'unknown';
  expressionKind: SharedExpressionKind;
  literalValue?: string;
}

export interface SensitiveAssignmentCandidate extends SensitiveExpressionClassification {
  name: string;
  start: number;
  end: number;
  rhsStart: number;
  rhsEnd: number;
  raw: string;
  rhs: string;
}

export const CONTROLLED_TEST_VECTOR_DIRECTIVE: string;
export const CONTROLLED_EXECUTABLE_TEST_VECTOR_DIRECTIVE: string;
export const SYNTHETIC_TEST_MARKERS: readonly string[];
export const SENSITIVE_IDENTIFIER_PATTERN_SOURCE: string;
export const SENSITIVE_ASSIGNMENT_PREFIX_SOURCE: string;
export const SECRET_RULE_METADATA: readonly SecretRuleMetadata[];
export const SENSITIVE_ASSIGNMENT_RULE_METADATA: Readonly<{
  rule: 'secret_assignment_literal';
  version: string;
  confidence: 'high';
  severity: 'error';
  message: string;
}>;

export function createSecretPatternRules(context: SecretRuleContext): SecretPatternRule[];
export function isPlaceholderSecretValue(value: unknown): boolean;
export function isPlausibleSecretLiteral(value: unknown, identifier?: string): boolean;
export function isSecurityTestOrFixturePath(filePath: string | undefined): boolean;
export function isControlledSyntheticTestVector(input: {
  filePath?: string;
  matchedText: string;
  currentLine: string;
  previousLine?: string;
}): boolean;
export function parseStaticStringExpression(input: unknown): { value: string; expressionKind: SharedExpressionKind } | undefined;
export function classifySensitiveExpression(input: unknown): SensitiveExpressionClassification;
export function findSensitiveAssignmentCandidates(text: unknown): SensitiveAssignmentCandidate[];
