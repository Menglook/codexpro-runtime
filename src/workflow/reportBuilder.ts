export interface ReportSection {
  title: string;
  lines: string[];
}

export interface StableReportInput {
  title: string;
  runId?: string;
  sections: ReportSection[];
  footer?: string[];
}

function cleanLine(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeLines(lines: string[], fallback = "无"): string[] {
  const cleaned = lines.map(cleanLine).filter(Boolean);
  return cleaned.length ? cleaned : [fallback];
}

function formatBullets(lines: string[]): string[] {
  return lines.map((line) => (line.startsWith("-") || line.startsWith("`") ? line : `- ${line}`));
}

export function buildStableReport(input: StableReportInput): string {
  const out = [`# ${input.title}`];
  if (input.runId?.trim()) out.push("", `run_id: ${input.runId.trim()}`);

  for (const section of input.sections) {
    out.push("", `## ${section.title}`, "", ...formatBullets(normalizeLines(section.lines)));
  }

  const footer = normalizeLines(input.footer ?? [], "");
  if (footer.length && footer[0]) out.push("", ...footer);
  return `${out.join("\n")}\n`;
}
