import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { Workspace } from "../guard.js";
import { projectGoalProgress } from "../jobs/progressProjection.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess } from "../runtime/processWrapper.js";
import type { GoalHookEventType, GoalRecord } from "../goals/types.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_CAPTURE_BYTES = 24_000;

export interface HookBridgeEvent {
  type: GoalHookEventType;
  goal: GoalRecord;
  source_event_type?: string;
  manual_replay?: boolean;
}

export interface HookBridgeStepResult {
  step: "task_state" | "context_card" | "notification";
  command: string;
  ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface HookBridgeDeliveryResult {
  ok: boolean;
  skipped: boolean;
  event_type: GoalHookEventType;
  profile: string | null;
  project: string;
  target_root: string;
  notification_required: boolean;
  notification_sent: boolean;
  context_card_required: boolean;
  context_card_written: boolean;
  task_state_updated: boolean;
  steps: HookBridgeStepResult[];
  errors: string[];
}

export interface HookBridgeLike {
  readonly enabled: boolean;
  deliver(event: HookBridgeEvent): Promise<HookBridgeDeliveryResult>;
}

export interface HookBridgeOptions {
  enabled?: boolean;
  hook_kit_root?: string;
  profile?: string;
  project_name?: string;
  worklog_dir?: string;
  timeout_ms?: number;
  environment?: NodeJS.ProcessEnv;
  python_executable?: string;
  bash_executable?: string;
}

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function boundedText(value: string, max = 1_000): string {
  return redactSensitiveText(value.replace(/[\u0000\r]+/g, " ").trim()).slice(0, max);
}

function taskName(goal: GoalRecord): string {
  const objective = boundedText(goal.objective, 120) || "CodexPro Goal";
  return `${objective} [${goal.goal_id.slice(0, 8)}]`;
}

function goalProgressText(goal: GoalRecord): string {
  const progress = projectGoalProgress(goal);
  const wait = progress.wait_reason ? ` wait=${boundedText(progress.wait_reason, 300)}` : "";
  return `phase=${boundedText(progress.phase, 120)}; action=${boundedText(progress.current_action, 180)}; state=${progress.execution_state}; heartbeat=${progress.heartbeat_at}; event=${goal.last_event_sequence}.${wait}`;
}

export function hookBridgeStatusText(event: HookBridgeEvent): string {
  let message: string;
  switch (event.type) {
    case "task.started":
      message = "Goal started and entered the running state.";
      break;
    case "task.checkpointed":
      message = `Goal checkpoint updated${event.source_event_type ? `: ${event.source_event_type}` : "."}`;
      break;
    case "task.waiting_input":
      message = "Goal is waiting for owner input.";
      break;
    case "task.waiting_approval":
      message = "Goal is waiting for owner approval.";
      break;
    case "task.succeeded":
      message = "Goal completed successfully.";
      break;
    case "task.failed":
      message = event.goal.status === "blocked"
        ? `Goal was blocked${event.goal.failure?.message ? `: ${boundedText(event.goal.failure.message, 500)}` : "."}`
        : `Goal failed${event.goal.failure?.message ? `: ${boundedText(event.goal.failure.message, 500)}` : "."}`;
      break;
    case "task.cancelled":
      message = "Goal was cancelled. No completion notification is emitted.";
      break;
  }
  return `${message} ${goalProgressText(event.goal)}`;
}

function nextStep(event: HookBridgeEvent): string {
  switch (event.type) {
    case "task.waiting_input":
      return "Provide the requested input, then resume the Goal.";
    case "task.waiting_approval":
      return "Review the pending action and approve or cancel the Goal.";
    case "task.succeeded":
      return "Review the Goal result and decide whether to commit or continue.";
    case "task.failed":
      return "Inspect the Goal failure and Hook delivery record before retrying.";
    case "task.cancelled":
      return "Start a new Goal only if the cancelled work is still required.";
    default:
      return "Continue monitoring the Goal state.";
  }
}

function stateArgument(type: GoalHookEventType): "start" | "waiting" | "success" | "failed" | null {
  if (type === "task.started" || type === "task.checkpointed") return "start";
  if (type === "task.waiting_input" || type === "task.waiting_approval") return "waiting";
  if (type === "task.succeeded") return "success";
  if (type === "task.failed") return "failed";
  return null;
}

function isTerminalNotification(type: GoalHookEventType): boolean {
  return type === "task.succeeded" || type === "task.failed";
}

function needsContextCard(type: GoalHookEventType): boolean {
  return type === "task.succeeded" || type === "task.failed";
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<CommandResult> {
  const result = await runProcess(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    killGraceMs: 500,
    maxOutputBytes: MAX_CAPTURE_BYTES,
    domain: "hook",
    operation: path.basename(command),
    sideEffectLevel: "external_write",
    riskLevel: "medium"
  });
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: boundedText(result.stdout, MAX_CAPTURE_BYTES),
    stderr: boundedText(result.stderr, MAX_CAPTURE_BYTES),
    ...(result.spawnError ? { error: boundedText(result.stderr || result.errorClass || "spawn failed", 2_000) } : {})
  };
}

export class CodexProHookBridge implements HookBridgeLike {
  readonly enabled: boolean;
  private readonly hookKitRoot: string;
  private readonly profile?: string;
  private readonly projectName: string;
  private readonly worklogDir: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pythonExecutable: string;
  private readonly bashExecutable: string;

  constructor(
    config: CodexProConfig,
    readonly workspace: Workspace,
    options: HookBridgeOptions = {}
  ) {
    this.enabled = options.enabled ?? config.codexHooksEnabled;
    this.hookKitRoot = path.resolve(options.hook_kit_root ?? config.codexHookKitRoot);
    this.profile = options.profile ?? config.codexHookProfile;
    this.projectName = options.project_name ?? config.codexHookProjectName ?? path.basename(workspace.root);
    this.worklogDir = path.resolve(options.worklog_dir ?? config.codexHookWorklogDir);
    this.timeoutMs = Math.max(1_000, Math.min(options.timeout_ms ?? config.codexHookTimeoutMs, 60_000));
    this.environment = { ...process.env, ...(options.environment ?? {}) };
    this.pythonExecutable = options.python_executable ?? "python3";
    this.bashExecutable = options.bash_executable ?? "bash";
  }

  async deliver(event: HookBridgeEvent): Promise<HookBridgeDeliveryResult> {
    const base: HookBridgeDeliveryResult = {
      ok: true,
      skipped: !this.enabled,
      event_type: event.type,
      profile: this.profile ?? null,
      project: this.projectName,
      target_root: this.workspace.root,
      notification_required: isTerminalNotification(event.type) || event.type === "task.waiting_input" || event.type === "task.waiting_approval",
      notification_sent: false,
      context_card_required: needsContextCard(event.type),
      context_card_written: false,
      task_state_updated: false,
      steps: [],
      errors: []
    };
    if (!this.enabled) return base;

    try {
      await this.assertReady();
    } catch (error) {
      const message = boundedText(error instanceof Error ? error.message : String(error), 2_000);
      return { ...base, ok: false, skipped: false, errors: [message] };
    }

    const env: NodeJS.ProcessEnv = {
      ...this.environment,
      CODEXPRO_TARGET_ROOT: this.workspace.root,
      CODEXPRO_PROJECT_ROOT: this.workspace.root,
      CODEXPRO_PROJECT_NAME: this.projectName,
      CODEXPRO_PROFILE: this.profile,
      CODEXPRO_WORKLOG_DIR: this.worklogDir
    };
    const name = taskName(event.goal);
    const message = hookBridgeStatusText(event);
    const next = nextStep(event);
    const hooksDir = path.join(this.hookKitRoot, "hooks");

    const execute = async (
      step: HookBridgeStepResult["step"],
      command: string,
      args: string[]
    ): Promise<HookBridgeStepResult> => {
      const result = await runCommand(command, args, { cwd: this.workspace.root, env, timeoutMs: this.timeoutMs });
      const ok = result.exitCode === 0 && !result.timedOut && !result.error;
      const stepResult: HookBridgeStepResult = {
        step,
        command: `${path.basename(command)} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
        ok,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.error ? { error: result.error } : {})
      };
      base.steps.push(stepResult);
      if (!ok) {
        const reason = result.error || result.stderr || `exit code ${String(result.exitCode)}`;
        base.errors.push(`${step}: ${boundedText(reason, 2_000)}`);
      }
      return stepResult;
    };

    const state = stateArgument(event.type);
    if (state) {
      const result = await execute("task_state", this.pythonExecutable, [
        path.join(hooksDir, "task-state.py"),
        state,
        "--task", name,
        "--message", message,
        "--next-step", next,
        "--profile", this.profile!,
        "--project", this.projectName,
        "--target-root", this.workspace.root
      ]);
      base.task_state_updated = result.ok;
    }

    if (needsContextCard(event.type)) {
      const contextArgs = [
        path.join(hooksDir, "write-context-card.py"),
        "--profile", this.profile!,
        "--project", this.projectName,
        "--target-root", this.workspace.root,
        "--task", name,
        "--stage", boundedText(String(event.goal.checkpoint?.phase ?? "Goal"), 120),
        "--status", event.goal.status,
        "--goal", boundedText(event.goal.objective, 1_000),
        "--done", message,
        "--conclusion", event.goal.failure?.message
          ? boundedText(event.goal.failure.message, 1_000)
          : boundedText(event.goal.checkpoint?.final_response ?? message, 1_000),
        "--next", next,
        "--do-not", "Do not automatically commit, push, merge, publish, or replay non-idempotent work.",
        "--worklog-dir", this.worklogDir
      ];
      for (const changedFile of event.goal.changed_files.slice(0, 50)) {
        contextArgs.push("--file", boundedText(changedFile, 500));
      }
      for (const constraint of event.goal.constraints.slice(0, 20)) {
        contextArgs.push("--rule", boundedText(constraint, 500));
      }
      if (event.goal.failure) contextArgs.push("--risk", boundedText(event.goal.failure.message, 1_000));
      const result = await execute("context_card", this.pythonExecutable, contextArgs);
      base.context_card_written = result.ok;
    }

    let notificationScript: string | undefined;
    if (event.type === "task.succeeded") notificationScript = "notify-task-finished.sh";
    else if (event.type === "task.failed") notificationScript = "notify-task-failed.sh";
    else if (event.type === "task.waiting_input" || event.type === "task.waiting_approval") notificationScript = "notify-waiting-input.sh";

    if (notificationScript) {
      const result = await execute("notification", this.bashExecutable, [
        path.join(hooksDir, notificationScript),
        name,
        message,
        next,
        this.projectName
      ]);
      base.notification_sent = result.ok;
    }

    base.skipped = false;
    base.ok = base.errors.length === 0;
    return base;
  }

  private async assertReady(): Promise<void> {
    if (!this.profile || !PROFILE_PATTERN.test(this.profile)) {
      throw new Error("Hook Bridge requires an explicit CODEXPRO_CODEX_HOOK_PROFILE when enabled.");
    }
    if (!PROFILE_PATTERN.test(this.projectName)) {
      throw new Error(`Invalid Hook Bridge project name: ${this.projectName}`);
    }
    const expected = [
      "hooks/task-state.py",
      "hooks/write-context-card.py",
      "hooks/notify-task-finished.sh",
      "hooks/notify-task-failed.sh",
      "hooks/notify-waiting-input.sh",
      "hooks/notify-common.sh"
    ];
    for (const relative of expected) {
      await fsp.access(path.join(this.hookKitRoot, relative));
    }
  }
}

export function createHookBridge(
  config: CodexProConfig,
  workspace: Workspace,
  options: HookBridgeOptions = {}
): HookBridgeLike | undefined {
  const enabled = options.enabled ?? config.codexHooksEnabled;
  return enabled ? new CodexProHookBridge(config, workspace, options) : undefined;
}
