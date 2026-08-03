import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { ensureAiBridge, writeTextFile } from "../fsOps.js";
import { redactMemoryCandidateText } from "../redact.js";
import { gitCurrentBranch, gitDiff, gitHeadSha, gitReverseDiff, gitStatus, gitUntrackedFiles } from "../gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "../guard.js";
import type { TaskCompletionStateV1 } from "../runtime/taskOutcome.js";
import { assertActiveSkillCurrent } from "../skills/skillUsage.js";
import type { ActiveSkillRecord } from "../skills/types.js";
import { statusChangedFiles, diffStats } from "./dirtyGuard.js";
import { writeMemoryCandidate } from "./memoryCandidate.js";

export interface TaskSnapshotResult {
  snapshot_id: string;
  snapshot_dir: string;
  files: string[];
  text: string;
}

export interface StartTaskSnapshotOptions {
  taskName: string;
  notes?: string;
  activeSkill?: ActiveSkillRecord;
  objective?: string;
  acceptedScope?: string[];
  excludedScope?: string[];
  taskId?: string;
  taskRuleSummary?: string;
  initialOwner?: string;
  initialPlan?: string;
}

export interface FinishTaskSnapshotOptions {
  snapshotId: string;
  notes?: string;
  validationRefs?: string[];
  browserReportRefs?: string[];
  commitSha?: string;
  pushRemoteState?: {
    status: "not_requested" | "completed" | "failed" | "unknown";
    remote?: string;
    branch?: string;
    remote_sha?: string;
    ahead?: number | null;
    behind?: number | null;
  };
  deploymentEvidence?: string[];
  remainingIssues?: string[];
  memoryCandidates?: string[];
  finalCompletionState?: TaskCompletionStateV1;
  terminalReason?: string;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "task";
}

function snapshotId(taskName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase();
  return `${stamp}-${slugify(taskName)}`;
}

async function writeSnapshotFile(config: CodexProConfig, guard: PathGuard, workspace: Workspace, relPath: string, content: string): Promise<string> {
  const result = await writeTextFile(config, guard, workspace, relPath, content.endsWith("\n") ? content : `${content}\n`, { createDirs: true, overwrite: true });
  return result.path;
}

function summaryMarkdown(options: {
  title: string;
  phase: "start" | "finish";
  branch: string;
  status: string;
  stagedDiff: string;
  diff: string;
  untracked: string;
  notes?: string;
  activeSkill?: ActiveSkillRecord;
}): string {
  const changed = statusChangedFiles(options.status);
  const stats = diffStats(options.diff);
  const stagedStats = diffStats(options.stagedDiff);
  const safeNotes = options.notes ? redactMemoryCandidateText(options.notes).trim() : "";
  return [
    `# Task Snapshot ${options.phase === "start" ? "Started" : "Finished"}`,
    "",
    `Task: ${options.title}`,
    `Updated: ${new Date().toISOString()}`,
    `Branch: ${options.branch || "n/a"}`,
    ...(options.activeSkill ? [
      "",
      "## Active Skill",
      `- ${options.activeSkill.name} @ ${options.activeSkill.source_commit}`,
      `- ${options.activeSkill.digest}`
    ] : []),
    "",
    "## Changed files",
    changed.length ? changed.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "## Untracked files",
    options.untracked.trim() && options.untracked.trim() !== "(no output)" ? options.untracked.split("\n").map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "## Diff stats",
    `- Worktree additions: ${stats.additions}`,
    `- Worktree deletions: ${stats.deletions}`,
    `- Staged additions: ${stagedStats.additions}`,
    `- Staged deletions: ${stagedStats.deletions}`,
    "",
    safeNotes ? `## Notes\n\n${safeNotes}\n` : ""
  ].filter(Boolean).join("\n");
}

export async function startTaskSnapshot(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: StartTaskSnapshotOptions
): Promise<TaskSnapshotResult> {
  await ensureAiBridge(config, guard, workspace);
  const activeSkill = options.activeSkill ? await assertActiveSkillCurrent(config, options.activeSkill) : undefined;
  const id = snapshotId(options.taskName);
  const dir = `${config.contextDir}/task-snapshots/${id}`;
  const branch = gitCurrentBranch(config, workspace);
  const headSha = gitHeadSha(config, workspace).trim();
  const status = gitStatus(config, workspace);
  const diff = gitDiff(config, guard, workspace);
  const stagedDiff = gitDiff(config, guard, workspace, undefined, true);
  const untracked = gitUntrackedFiles(config, workspace);
  const meta = {
    snapshot_id: id,
    task_name: options.taskName,
    task_id: options.taskId ?? null,
    objective: redactMemoryCandidateText(options.objective ?? options.taskName),
    accepted_scope: [...new Set(options.acceptedScope ?? [])],
    excluded_scope: [...new Set(options.excludedScope ?? [])],
    workspace_root: workspace.root,
    workspace_binding: {
      workspace_id: workspace.id,
      workspace_root: workspace.root,
      workspace_generation: workspace.workspaceGeneration ?? null,
      source_conversation_id: workspace.conversationId ?? null
    },
    branch,
    before_head_sha: headSha,
    before_status: status,
    before_diff_ref: `${dir}/before.patch`,
    task_rule_summary: redactMemoryCandidateText(options.taskRuleSummary ?? ""),
    initial_owner: redactMemoryCandidateText(options.initialOwner ?? workspace.activatedBySessionId ?? workspace.conversationId ?? "unknown"),
    initial_plan_hash: options.initialPlan ? `sha256:${createHash("sha256").update(options.initialPlan).digest("hex")}` : null,
    started_at: new Date().toISOString(),
    status: "started",
    ...(activeSkill ? { active_skill: activeSkill } : {}),
    notes: redactMemoryCandidateText(options.notes ?? "")
  };
  const files = [
    await writeSnapshotFile(config, guard, workspace, `${dir}/meta.json`, JSON.stringify(meta, null, 2)),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before-branch.txt`, branch),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before-head-sha.txt`, headSha),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before-status.txt`, status),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before.patch`, diff),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before-staged.patch`, stagedDiff),
    await writeSnapshotFile(config, guard, workspace, `${dir}/before-untracked.txt`, untracked),
    await writeSnapshotFile(config, guard, workspace, `${dir}/summary.md`, summaryMarkdown({ title: options.taskName, phase: "start", branch, status, stagedDiff, diff, untracked, notes: options.notes, activeSkill }))
  ];
  return {
    snapshot_id: id,
    snapshot_dir: dir,
    files,
    text: [`# Task Snapshot Started`, "", `Snapshot: ${id}`, `Directory: ${dir}`, "", files.map((file) => `- ${file}`).join("\n")].join("\n")
  };
}

export async function finishTaskSnapshot(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: FinishTaskSnapshotOptions
): Promise<TaskSnapshotResult> {
  await ensureAiBridge(config, guard, workspace);
  const safeId = slugify(options.snapshotId).replace(/^-+|-+$/g, "");
  const dir = `${config.contextDir}/task-snapshots/${safeId}`;
  const branch = gitCurrentBranch(config, workspace);
  const headSha = gitHeadSha(config, workspace).trim();
  const status = gitStatus(config, workspace);
  const diff = gitDiff(config, guard, workspace);
  const stagedDiff = gitDiff(config, guard, workspace, undefined, true);
  const rollback = gitReverseDiff(config, guard, workspace);
  const untracked = gitUntrackedFiles(config, workspace);
  const changed = statusChangedFiles(status);
  const stats = diffStats(diff);
  const stagedStats = diffStats(stagedDiff);
  const metaPath = guard.resolve(workspace, `${dir}/meta.json`);
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await fsp.readFile(metaPath.absPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new CodexProError(`Task snapshot start boundary is missing or invalid: ${dir}/meta.json`);
  }
  const verifyEvidence = async (values: string[] | undefined, label: string): Promise<string[]> => {
    const normalized = [...new Set((values ?? []).map((item) => item.trim()).filter(Boolean))];
    for (const value of normalized) {
      const resolved = guard.resolve(workspace, value);
      const stat = await fsp.stat(resolved.absPath).catch(() => null);
      if (!stat?.isFile()) throw new CodexProError(`${label} evidence does not exist as a workspace file: ${value}`);
    }
    return normalized;
  };
  const validationRefs = await verifyEvidence(options.validationRefs, "Validation");
  const browserReportRefs = await verifyEvidence(options.browserReportRefs, "Browser report");
  const deploymentEvidence = await verifyEvidence(options.deploymentEvidence, "Deployment");
  const completion = options.finalCompletionState;
  if (completion?.validation_status === "passed" && validationRefs.length === 0) throw new CodexProError("A passed validation state requires at least one existing validation evidence file.");
  if (completion?.browser_acceptance_status === "passed" && browserReportRefs.length === 0) throw new CodexProError("A passed browser acceptance state requires at least one existing browser report file.");
  if (completion?.git_commit_status === "completed" && !/^[a-f0-9]{40,64}$/i.test(options.commitSha ?? "")) throw new CodexProError("A completed Git commit state requires an exact commit SHA.");
  if (completion?.git_push_status === "completed" && !/^[a-f0-9]{40,64}$/i.test(options.pushRemoteState?.remote_sha ?? "")) throw new CodexProError("A completed Git push state requires a verified remote SHA.");
  if (options.pushRemoteState?.status === "completed" && !/^[a-f0-9]{40,64}$/i.test(options.pushRemoteState.remote_sha ?? "")) throw new CodexProError("A completed push remote state requires remote_sha.");
  if (completion?.deployment_status === "completed" && deploymentEvidence.length === 0) throw new CodexProError("A completed deployment state requires an existing deployment evidence file.");
  const taskName = typeof meta.task_name === "string" ? meta.task_name : safeId;
  const activeSkill = meta.active_skill ? await assertActiveSkillCurrent(config, meta.active_skill) : undefined;
  const finishedMeta = {
    ...meta,
    finished_at: new Date().toISOString(),
    finished_branch: branch,
    after_head_sha: headSha,
    status: "finished",
    changed_files: changed,
    diff_stats: stats,
    staged_diff_stats: stagedStats,
    untracked_files: untracked.trim() && untracked.trim() !== "(no output)" ? untracked.split("\n").filter(Boolean) : [],
    validation_refs: validationRefs,
    browser_report_refs: browserReportRefs,
    commit_sha: options.commitSha ?? null,
    push_remote_state: options.pushRemoteState ?? { status: "not_requested" },
    deployment_evidence: deploymentEvidence,
    remaining_issues: [...new Set(options.remainingIssues ?? [])],
    memory_candidates: [...new Set(options.memoryCandidates ?? [])],
    final_completion_state: completion ?? null,
    terminal_reason: options.terminalReason?.trim() || completion?.terminal_reason || null,
    notes: redactMemoryCandidateText(options.notes ?? "")
  };
  const untrackedFiles = untracked.trim() && untracked.trim() !== "(no output)" ? untracked.split("\n").filter(Boolean) : [];
  const changedFilesMd = changed.length ? changed.map((file) => `- ${file}`).join("\n") : "- none";
  const memoryCandidate = await writeMemoryCandidate(config, guard, workspace, {
    snapshotId: safeId,
    snapshotDir: dir,
    taskName,
    notes: options.notes,
    changedFiles: changed,
    diffStats: stats,
    stagedDiffStats: stagedStats,
    untrackedFiles
  });
  const files = [
    await writeSnapshotFile(config, guard, workspace, `${dir}/meta.json`, JSON.stringify(finishedMeta, null, 2)),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after-branch.txt`, branch),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after-head-sha.txt`, headSha),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after-status.txt`, status),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after.patch`, diff),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after-staged.patch`, stagedDiff),
    await writeSnapshotFile(config, guard, workspace, `${dir}/after-untracked.txt`, untracked),
    await writeSnapshotFile(config, guard, workspace, `${dir}/task-diff.patch`, diff),
    await writeSnapshotFile(config, guard, workspace, `${dir}/changed-files.md`, `# Changed Files\n\n${changedFilesMd}`),
    await writeSnapshotFile(config, guard, workspace, `${dir}/rollback.patch`, rollback),
    await writeSnapshotFile(config, guard, workspace, `${dir}/summary.md`, summaryMarkdown({ title: taskName, phase: "finish", branch, status, stagedDiff, diff, untracked, notes: options.notes, activeSkill })),
    memoryCandidate.path
  ];
  return {
    snapshot_id: safeId,
    snapshot_dir: dir,
    files,
    text: [`# Task Snapshot Finished`, "", `Snapshot: ${safeId}`, `Directory: ${dir}`, "", files.map((file) => `- ${file}`).join("\n")].join("\n")
  };
}
