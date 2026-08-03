import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import { type PathGuard, type Workspace } from "../guard.js";
import type { AgentsRuleFile, AgentsRulesSummary } from "./types.js";

const RULE_FILE_CANDIDATES = [
  "AGENTS.md",
  ".agent.md",
  ".codexpro/AGENTS.md",
  ".codexpro/rules.md",
  "CLAUDE.md",
  ".cursor/rules"
];

const HIGH_RISK_HINTS = [
  ".env",
  "mysql",
  "mysql-data",
  "db_data",
  "uploads",
  "wp-config.php",
  "docker-compose.yml",
  "credentials",
  "secrets"
];

async function exists(absPath: string): Promise<boolean> {
  return fsp.access(absPath).then(() => true, () => false);
}

async function collectRulePaths(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of RULE_FILE_CANDIDATES) {
    const resolved = guard.resolve(workspace, candidate);
    if (!(await exists(resolved.absPath))) continue;
    const stat = await fsp.stat(resolved.absPath);
    if (stat.isFile()) found.push(resolved.relPath);
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(resolved.absPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const rel = path.posix.join(resolved.relPath.split(path.sep).join("/"), entry.name);
        if (!guard.isBlockedRelativePath(rel)) found.push(rel);
      }
    }
  }
  return [...new Set(found)].slice(0, 20);
}

function titleFromText(text: string, fallback: string): string {
  const firstHeading = text.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return firstHeading ? firstHeading.replace(/^#\s+/, "").trim().slice(0, 120) : fallback;
}

function cleanRuleLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (/^#{1,6}\s+/.test(trimmed)) return trimmed.replace(/^#{1,6}\s+/, "");
  if (/^[-*]\s+/.test(trimmed)) return trimmed.replace(/^[-*]\s+/, "");
  return undefined;
}

function uniqueLimited(values: string[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function extractRules(files: AgentsRuleFile[]): Omit<AgentsRulesSummary, "files"> {
  const lines = files.flatMap((file) => file.text.split(/\r?\n/).map((line) => cleanRuleLine(line)).filter((line): line is string => Boolean(line)));
  const rules = lines.filter((line) => /(must|never|always|prefer|avoid|forbid|禁止|不要|必须|只允许|优先|验收|提交|测试|风险)/i.test(line));
  const highRiskPaths = lines
    .filter((line) => HIGH_RISK_HINTS.some((hint) => line.toLowerCase().includes(hint.toLowerCase())))
    .map((line) => line.replace(/^.*?(\.env[^\s，。；,;]*|mysql[^\s，。；,;]*|mysql-data[^\s，。；,;]*|db_data[^\s，。；,;]*|uploads[^\s，。；,;]*|wp-config\.php|docker-compose\.yml|credentials[^\s，。；,;]*|secrets[^\s，。；,;]*).*$/i, "$1"));
  const testCommands = lines.filter((line) => /(npm run|pnpm|yarn|pytest|php -l|composer|docker compose|go test|cargo test|验收|测试|build|lint)/i.test(line));
  const commitRules = lines.filter((line) => /(commit|push|git add|提交|推送|不要自动提交|不自动提交|验收通过)/i.test(line));
  const warnings = files.length ? [] : ["No explicit AGENTS/rules files found." ];
  return {
    rules: uniqueLimited(rules, 40),
    high_risk_paths: uniqueLimited(highRiskPaths, 30),
    test_commands: uniqueLimited(testCommands, 30),
    commit_rules: uniqueLimited(commitRules, 20),
    warnings
  };
}

export async function readAgentsRules(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<AgentsRulesSummary> {
  const paths = await collectRulePaths(config, guard, workspace);
  const files: AgentsRuleFile[] = [];
  for (const relPath of paths) {
    const resolved = guard.resolve(workspace, relPath);
    await guard.assertTextFile(resolved.absPath, Math.min(config.maxReadBytes, 120_000));
    const text = await fsp.readFile(resolved.absPath, "utf8");
    files.push({
      path: resolved.relPath,
      title: titleFromText(text, resolved.relPath),
      text: text.length > 20_000 ? `${text.slice(0, 20_000)}\n...[rules truncated]` : text,
      bytes: Buffer.byteLength(text, "utf8")
    });
  }
  return { files, ...extractRules(files) };
}

export function formatAgentsRules(summary: AgentsRulesSummary): string {
  return [
    "# Project Rules Files",
    "",
    "## Files",
    summary.files.length ? summary.files.map((file) => `- ${file.path}: ${file.title} (${file.bytes} bytes)`).join("\n") : "- none",
    "",
    "## Extracted rules",
    summary.rules.length ? summary.rules.map((rule) => `- ${rule}`).join("\n") : "- none",
    "",
    "## High-risk paths mentioned",
    summary.high_risk_paths.length ? summary.high_risk_paths.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Test / validation hints",
    summary.test_commands.length ? summary.test_commands.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Commit rules",
    summary.commit_rules.length ? summary.commit_rules.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Warnings",
    summary.warnings.length ? summary.warnings.map((item) => `- ${item}`).join("\n") : "- none"
  ].join("\n");
}
