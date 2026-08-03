export type CommandCategory = "frontend_test" | "backend_test" | "build" | "safe" | "unknown";

export interface CommandSegmentIR {
  raw: string;
  argv: string[];
  executable?: string;
  testFiles: string[];
}

export interface CommandIR {
  raw: string;
  normalized: string;
  segments: CommandSegmentIR[];
  shellOperators: string[];
  testFiles: string[];
}

const TEST_FILE_PATTERN = /(?:^|[/\\])[^\s]+\.(?:test|spec)\.[A-Za-z0-9]+$/i;

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function pushToken(tokens: string[], token: string): string {
  if (token.length) tokens.push(token);
  return "";
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (isWhitespace(char)) {
      token = pushToken(tokens, token);
      continue;
    }
    token += char;
  }

  if (escaped) token += "\\";
  pushToken(tokens, token);
  return tokens;
}

function splitCommandSegments(command: string): { segments: string[]; operators: string[] } {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushSegment = (operator: string): void => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    operators.push(operator);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\r" || char === "\n" || char === ";") {
      pushSegment(char === ";" ? ";" : "newline");
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushSegment(`${char}${next}`);
      index += 1;
      continue;
    }
    if (char === "|" || char === "&") {
      pushSegment(char);
      continue;
    }
    if (char === "<" || char === ">" || char === "`") {
      operators.push(char);
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);
  return { segments, operators };
}

function extractTestFiles(argv: string[]): string[] {
  return argv.filter((token) => TEST_FILE_PATTERN.test(token));
}

export function parseCommandToIR(command: string): CommandIR {
  const normalized = normalizeCommand(command);
  const split = splitCommandSegments(command);
  const segmentInputs = split.segments.length ? split.segments : normalized ? [normalized] : [];
  const segments = segmentInputs.map((segment): CommandSegmentIR => {
    const argv = tokenizeCommand(segment);
    return {
      raw: segment,
      argv,
      executable: argv[0],
      testFiles: extractTestFiles(argv)
    };
  });
  const testFiles = segments.flatMap((segment) => segment.testFiles);
  return {
    raw: command,
    normalized,
    segments,
    shellOperators: split.operators,
    testFiles
  };
}
