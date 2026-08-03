import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { CodexProError, normalizeRelPath, type PathGuard, type Workspace } from "../guard.js";
import { writeTextFile } from "../fsOps.js";
import { redactMemoryCandidateText, redactSensitiveText } from "../redact.js";
import { assertProjectMemoryPath, PROJECT_MEMORY_DIR } from "../project/projectMemory.js";
import {
  appendGovernedMemoryRecord,
  MEMORY_GOVERNANCE_FILE,
  parseGovernedMemoryRecord
} from "../project/memoryGovernance.js";

export const MEMORY_CANDIDATE_FILE = "memory-candidate.md";

export interface MemoryCandidateInput {
  snapshotId: string;
  snapshotDir: string;
  taskName: string;
  notes?: string;
  changedFiles: string[];
  diffStats: { additions: number; deletions: number };
  stagedDiffStats: { additions: number; deletions: number };
  untrackedFiles: string[];
}

export interface MemoryCandidateResult {
  path: string;
  text: string;
  changed: boolean;
}

export interface MemoryUpdateProposalResult {
  path?: string;
  target_file?: string;
  text: string;
  proposed_content: string;
}

export interface AppendProjectMemoryResult {
  path: string;
  bytes: number;
  sha256: string;
  appended_content: string;
  text: string;
}

function safeLines(value: string | undefined, fallback: string): string[] {
  const lines = (value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
  return lines.length ? lines : [fallback];
}

function bulletList(items: string[], fallback: string): string {
  return items.length ? items.map((item) => `- ${redactMemoryCandidateText(item)}`).join("\n") : `- ${fallback}`;
}

function safePathForCandidate(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  if (/(^|\/)\.env(?:\.|$)/i.test(normalized)) return "[REDACTED_SENSITIVE_PATH]";
  if (/(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$/i.test(normalized)) return "[REDACTED_SENSITIVE_PATH]";
  if (/(?:secret|credential|token|password)/i.test(normalized)) return normalized.replace(/[^/]+$/u, "[REDACTED_SENSITIVE_FILE]");
  return normalized;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function extractVerificationCommands(notes: string | undefined): string[] {
  const candidates = uniqueSorted((notes ?? "").match(/\b(?:npm|pnpm|yarn|bun)\s+run\s+[a-z0-9:_-]+(?:\s+--\s+[^\n`]+)?|\b(?:npm|pnpm|yarn|bun)\s+test\b|\bnpm\s+exec\s+[^\n`]+/gi) ?? []);
  return candidates.slice(0, 12).map((command) => command.trim());
}

function candidateSection(title: string, lines: string[]): string[] {
  return [`## ${title}`, "", ...lines, ""];
}

export function buildMemoryCandidate(input: MemoryCandidateInput): string {
  const notes = redactMemoryCandidateText(input.notes ?? "").trim();
  const noteLines = safeLines(notes, "No finish notes were recorded. Add manual detail before promoting anything to long-term memory.");
  const verificationCommands = extractVerificationCommands(notes);
  const changedFiles = uniqueSorted(input.changedFiles.map(safePathForCandidate));
  const untrackedFiles = uniqueSorted(input.untrackedFiles.map(safePathForCandidate));

  const lines = [
    "# Memory Candidate",
    "",
    `Snapshot: ${redactMemoryCandidateText(input.snapshotId)}`,
    `Task: ${redactMemoryCandidateText(input.taskName)}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "This is a candidate memory file generated from the session archive. It is not long-term project memory until a human explicitly appends selected low-risk facts to `.codexpro/memory/`.",
    "",
    ...candidateSection("What changed / what was fixed", [
      ...noteLines.map((line) => `- ${line}`),
      `- Worktree diff stats at finish: +${input.diffStats.additions} / -${input.diffStats.deletions}.`,
      `- Staged diff stats at finish: +${input.stagedDiffStats.additions} / -${input.stagedDiffStats.deletions}.`
    ]),
    ...candidateSection("Likely root cause", [
      "- Not automatically inferred. Confirm from the finish notes, code review, and acceptance output before promoting this candidate."
    ]),
    ...candidateSection("Changed files", [bulletList(changedFiles, "No tracked changed files detected at snapshot finish.")]),
    ...candidateSection("Untracked files", [bulletList(untrackedFiles, "No untracked files detected at snapshot finish.")]),
    ...candidateSection("Pitfalls to remember next time", [
      "- Review this candidate before writing durable memory; keep only stable project facts.",
      "- Do not promote raw logs, credentials, local-only absolute paths, or temporary task chatter.",
      "- Keep implementation details tied to specific files concise and reversible."
    ]),
    ...candidateSection("Effective verification commands", verificationCommands.length ? verificationCommands.map((command) => `- \`${redactMemoryCandidateText(command)}\``) : [
      "- Not recorded in finish notes. Add the build/smoke/release commands that actually passed before promoting this candidate."
    ]),
    ...candidateSection("Rollback", [
      `- Review \`${input.snapshotDir}/rollback.patch\` before applying it.`,
      "- Apply only from the same branch and workspace state that produced this snapshot.",
      "- Re-run the relevant verification commands after rollback."
    ]),
    ...candidateSection("Low-risk facts suitable for long-term memory", [
      "- Candidate only: select and rewrite durable facts manually before calling `append_project_memory`.",
      "- Good targets are stable project rules, accepted decisions, glossary entries, known pitfalls, and verified standard commands.",
      "- Bad targets are raw diffs, secrets, full logs, one-off speculation, and transient task status."
    ]),
    "## Safety filter",
    "",
    "- Secret-looking values were redacted before writing this candidate.",
    "- Sensitive file paths are masked where practical.",
    "- Full diffs and full logs are intentionally not embedded in this candidate."
  ];

  return redactMemoryCandidateText(lines.join("\n"));
}

export async function writeMemoryCandidate(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  input: MemoryCandidateInput
): Promise<MemoryCandidateResult> {
  const text = buildMemoryCandidate(input);
  const relPath = `${input.snapshotDir}/${MEMORY_CANDIDATE_FILE}`;
  const result = await writeTextFile(config, guard, workspace, relPath, text.endsWith("\n") ? text : `${text}\n`, { createDirs: true, overwrite: true });
  return { path: result.path, text, changed: result.diff.changed };
}

function candidatePathFromOptions(options: { snapshotId?: string; candidatePath?: string }, config: CodexProConfig): string {
  if (options.candidatePath) return normalizeRelPath(options.candidatePath);
  if (!options.snapshotId) throw new CodexProError("Either snapshot_id or candidate_path is required.");
  const safeId = normalizeRelPath(options.snapshotId).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${config.contextDir}/task-snapshots/${safeId}/${MEMORY_CANDIDATE_FILE}`;
}

function assertMemoryCandidatePath(relPath: string, config: CodexProConfig): void {
  const normalized = normalizeRelPath(relPath);
  const prefix = `${config.contextDir}/task-snapshots/`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(`/${MEMORY_CANDIDATE_FILE}`)) {
    throw new CodexProError(`Not a memory candidate path: ${relPath}`);
  }
}

async function readCandidateText(config: CodexProConfig, guard: PathGuard, workspace: Workspace, relPath: string): Promise<string> {
  assertMemoryCandidatePath(relPath, config);
  const resolved = guard.resolve(workspace, relPath);
  await guard.assertTextFile(resolved.absPath, Math.min(config.maxReadBytes, 120_000));
  const raw = await fsp.readFile(resolved.absPath, "utf8");
  return raw.slice(0, 120_000);
}

function extractLowRiskSection(candidateText: string): string {
  const normalized = candidateText.replace(/\r\n/g, "\n");
  const match = normalized.match(/## Low-risk facts suitable for long-term memory\n\n([\s\S]*?)(?:\n## |$)/);
  if (!match) return "- Review the candidate and write a concise durable fact here.";
  const content = match[1].trim();
  return content || "- Review the candidate and write a concise durable fact here.";
}

export async function proposeMemoryUpdate(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { snapshotId?: string; candidatePath?: string; targetFile?: string }
): Promise<MemoryUpdateProposalResult> {
  const candidatePath = candidatePathFromOptions({ snapshotId: options.snapshotId, candidatePath: options.candidatePath }, config);
  const candidateText = redactMemoryCandidateText(await readCandidateText(config, guard, workspace, candidatePath));
  const targetFile = options.targetFile ? normalizeRelPath(options.targetFile) : undefined;
  if (targetFile) assertProjectMemoryPath(targetFile);
  const proposedContent = redactMemoryCandidateText(extractLowRiskSection(candidateText));
  const text = [
    "# Proposed Project Memory Update",
    "",
    `Source candidate: ${candidatePath}`,
    `Target memory file: ${targetFile ?? "not selected"}`,
    "",
    "This is a proposal only. It has not been written to long-term project memory.",
    "",
    "## Proposed content",
    "",
    proposedContent,
    "",
    "## Next step",
    "",
    targetFile
      ? `Call \`append_project_memory\` with target_file=${targetFile} after editing the proposed content.`
      : `Choose a specific file under ${PROJECT_MEMORY_DIR}/, then call \`append_project_memory\` with edited content.`
  ].join("\n");
  return { path: candidatePath, target_file: targetFile, text, proposed_content: proposedContent };
}

export async function appendProjectMemory(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { targetFile: string; content: string; heading?: string }
): Promise<AppendProjectMemoryResult> {
  const targetFile = normalizeRelPath(options.targetFile);
  assertProjectMemoryPath(targetFile);
  if (targetFile === PROJECT_MEMORY_DIR || targetFile.endsWith("/")) {
    throw new CodexProError("target_file must be a specific project memory file, not the memory directory.");
  }
  const content = redactMemoryCandidateText(options.content ?? "").trim();
  if (!content) throw new CodexProError("content is required and must not be empty.");
  if (targetFile === MEMORY_GOVERNANCE_FILE) {
    const governed = await appendGovernedMemoryRecord(config, guard, workspace, {
      record: parseGovernedMemoryRecord(content),
      approved: true
    });
    return {
      path: governed.path,
      bytes: governed.bytes,
      sha256: governed.sha256,
      appended_content: content,
      text: governed.text
    };
  }
  if (!/\.(md|markdown|txt)$/i.test(targetFile)) {
    throw new CodexProError(`target_file must be a markdown/text file or ${MEMORY_GOVERNANCE_FILE}.`);
  }

  const resolved = guard.resolve(workspace, targetFile, { forWrite: true });
  let existing = "";
  try {
    await guard.assertTextFile(resolved.absPath, Math.max(config.maxReadBytes, config.maxWriteBytes));
    existing = await fsp.readFile(resolved.absPath, "utf8");
  } catch (error) {
    if (error instanceof CodexProError && error.message.startsWith("Not a file")) throw error;
    existing = "";
  }

  const heading = redactSensitiveText(options.heading ?? "Accepted memory update").trim() || "Accepted memory update";
  const entry = [`## ${heading}`, "", `Date: ${new Date().toISOString().slice(0, 10)}`, "", content, ""].join("\n");
  const nextContent = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${entry}`;
  const result = await writeTextFile(config, guard, workspace, targetFile, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`, { createDirs: true, overwrite: true });
  const text = [
    "# Append Project Memory",
    "",
    `Target file: ${result.path}`,
    `Bytes: ${result.bytes}`,
    "",
    "Long-term project memory was updated only because append_project_memory was called with an explicit target file and content."
  ].join("\n");
  return { path: result.path, bytes: result.bytes, sha256: result.sha256, appended_content: entry.trimEnd(), text };
}
