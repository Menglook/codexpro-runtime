#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runManagedProcessSync } from '../shared/execution-kernel.mjs';

const cliFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(cliFile), '..');
const legacyLauncher = path.join(projectRoot, 'scripts', 'codexpro.mjs');
const EXEC_SUBCOMMANDS = new Set(['run', 'status', 'resume', 'cancel', 'review', 'hooks-replay']);
const BOOLEAN_OPTIONS = new Set([
  'help',
  'dry-run',
  'full',
  'full-logs',
  'debug',
  'no-review',
  'review',
  'raw-goal',
  'skip-git-repo-check',
  'codex-hooks'
]);
const REPEATABLE_OPTIONS = new Set(['command', 'constraint', 'acceptance']);

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function camelKey(key) {
  return key.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function parseCommandArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      positionals.push(raw);
      continue;
    }

    const option = raw.slice(2);
    const equalsIndex = option.indexOf('=');
    const rawKey = equalsIndex >= 0 ? option.slice(0, equalsIndex) : option;
    const key = camelKey(rawKey);
    if (BOOLEAN_OPTIONS.has(rawKey)) {
      options[key] = equalsIndex >= 0 ? option.slice(equalsIndex + 1) !== 'false' : true;
      continue;
    }

    const inlineValue = equalsIndex >= 0 ? option.slice(equalsIndex + 1) : undefined;
    const next = argv[index + 1];
    const value = inlineValue ?? next;
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    if (inlineValue === undefined) index += 1;
    if (REPEATABLE_OPTIONS.has(rawKey)) {
      const previous = options[key];
      options[key] = Array.isArray(previous) ? [...previous, value] : previous ? [previous, value] : [value];
    } else {
      options[key] = value;
    }
  }
  return { options, positionals };
}

function numberArg(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got: ${value}`);
  return parsed;
}

function stringArray(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function stableIdempotencyKey(value) {
  return `exec:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function printTaskHelp() {
  console.log(`CodexPro task commands

Exec Runner v1:
  codexpro task run --objective "implement the fix" --idempotency-key fix-123
  codexpro task status --task-id <task-id>
  codexpro task status --goal-id <goal-id> --raw-goal
  codexpro task resume --goal-id <goal-id> --prompt "continue with this input"
  codexpro task cancel --goal-id <goal-id>
  codexpro task review --goal-id <goal-id>
  codexpro task hooks-replay --goal-id <goal-id>

Exec options:
  --root <dir>                 Workspace root. Default: current directory.
  --objective <text>           Goal objective. --task is accepted as an alias.
  --idempotency-key <key>      Stable key. Defaults to a deterministic request hash.
  --task-id <task-id>          Unified task id for status, for example goal-<goal-id>.
  --raw-goal                   Keep status output in the legacy GoalInspection shape.
  --sandbox <mode>             read-only or workspace-write. Default: workspace-write.
  --constraint <text>          Repeatable Goal constraint.
  --acceptance <text>          Repeatable acceptance description.
  --model <model>              Optional Codex model override.
  --reasoning-effort <level>   minimal, low, medium, high, or xhigh.
  --timeout-ms <n>             Exec process timeout.
  --review-timeout-ms <n>      Read-only Review timeout.
  --max-parallel <n>           Exec concurrency limit. Default: 1.
  --resource-wait-timeout-ms <n> Resource/Exec slot wait timeout.
  --no-review                  Skip the automatic read-only Review step.
  --skip-git-repo-check        Forward the safe Codex repo-check override.
  --codex-executable <path>    Codex executable or a test-compatible wrapper.
  --codex-hooks                Enable Hook Bridge for this command.
  --codex-hook-kit-root <dir>  Path to codexpro-hook-kit.
  --codex-hook-profile <name>  Explicit Hook Kit project profile.
  --codex-hook-project <name>  Project name shown in notifications.
  --codex-hook-worklog-dir <dir> Shared context-card worklog directory.

Task templates (backward compatible):
  codexpro task bugfix --dry-run
  codexpro task ui-fix --task "fix header alignment"
  codexpro task release-check

Template options:
  --template <name>            Template name; positional name is also accepted.
  --goal <text>                Detailed template goal.
  --command <cmd>              Repeatable validation command.
  --acceptance-profile <name>  Override acceptance profile.
  --dry-run                    Plan without running commands or writing snapshots.
  --run-id <id>                Stable local report id.
  --tail-lines <n>             Validation output tail lines.
  --full                       Return and archive the full report.
  --full-logs                  Persist complete command logs even on success.
  --debug                      Enable full diagnostic report/log persistence.
  --bash <safe|full|off>       Bash mode for template commands. Default: safe.
`);
}

function requireBuild(relativeEntry) {
  const entry = path.join(projectRoot, relativeEntry);
  if (!fs.existsSync(entry)) {
    throw new Error('Build artifacts are missing. Run npm run build before using codexpro task.');
  }
  return entry;
}

async function loadWorkspace(root, options) {
  const [{ loadConfig }, { PathGuard, WorkspaceManager }] = await Promise.all([
    import('../dist/config.js'),
    import('../dist/guard.js')
  ]);
  const configArgs = [
    '--root', root,
    '--allow-root', root,
    '--bash', options.bash ?? 'safe',
    '--write', 'workspace',
    '--tool-mode', 'full'
  ];
  if (options.codexExecutable) configArgs.push('--codex-executable', options.codexExecutable);
  if (options.codexHooks) configArgs.push('--codex-hooks');
  if (options.codexHookKitRoot) configArgs.push('--codex-hook-kit-root', options.codexHookKitRoot);
  if (options.codexHookProfile) configArgs.push('--codex-hook-profile', options.codexHookProfile);
  if (options.codexHookProject) configArgs.push('--codex-hook-project', options.codexHookProject);
  if (options.codexHookWorklogDir) configArgs.push('--codex-hook-worklog-dir', options.codexHookWorklogDir);
  const config = loadConfig(configArgs);
  const guard = new PathGuard(config);
  const manager = new WorkspaceManager(config);
  const workspace = manager.defaultWorkspace();
  return { config, guard, workspace };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function nullish(value, fallback = null) {
  return value === undefined ? fallback : value;
}

function budgetUsed(loop) {
  if (!loop) return null;
  return {
    iteration: loop.iteration,
    repair_rounds: loop.repair_rounds,
    tool_calls: loop.tool_calls,
    full_validation_runs: loop.full_validation_runs,
    browser_reconnects: loop.browser_reconnects,
    same_failure_repeats: loop.same_failure_repeats
  };
}

function leaseProjection(liveness) {
  if (liveness?.lease) return liveness.lease;
  return {
    evidence: 'none',
    active: liveness?.lease_active ?? null,
    stale: liveness?.state === 'stale' ? true : null,
    expired: liveness?.heartbeat_fresh === null || liveness?.heartbeat_fresh === undefined ? null : !liveness.heartbeat_fresh,
    holder_pid: null,
    managed_pid: null,
    run_id: liveness?.execution_id ?? null,
    heartbeat_at: liveness?.heartbeat_at ?? null,
    ttl_ms: null
  };
}

async function formatTaskProjection(service, projection) {
  let recovery = null;
  try {
    recovery = await service.getRecovery(projection.identity.task_id);
  } catch (error) {
    recovery = {
      mode: 'blocked',
      action: 'none',
      side_effect_level: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const lastEvidence = projection.progress.last_evidence
    ?? projection.acceptance.evidence_paths?.[0]
    ?? projection.evidence_paths?.[0]
    ?? null;
  return {
    task_id: projection.identity.task_id,
    contract_version: projection.contract?.contract_version ?? null,
    objective: projection.identity.title,
    status: projection.status,
    domain_status: projection.domain_status,
    executor: projection.executor ?? {
      kind: projection.identity.kind,
      provider: null,
      model: null,
      sandbox_mode: null,
      execution_id: projection.liveness.execution_id ?? null,
      source: 'unknown'
    },
    execution_id: projection.liveness.execution_id ?? projection.executor?.execution_id ?? null,
    owner_pid: projection.liveness.owner_pid ?? null,
    supervisor_pid: projection.liveness.supervisor_pid ?? null,
    watcher_pid: projection.liveness.watcher_pid ?? null,
    lease: leaseProjection(projection.liveness),
    heartbeat: {
      at: projection.liveness.heartbeat_at ?? null,
      fresh: nullish(projection.liveness.heartbeat_fresh),
      age_ms: nullish(projection.liveness.heartbeat_age_ms),
      last_output_at: projection.liveness.last_output_at ?? null,
      state: projection.liveness.state,
      reason: projection.liveness.reason
    },
    last_completed_step: recovery?.last_completed_step_id ?? null,
    current_action: projection.progress.current_action ?? null,
    wait_reason: projection.progress.wait_reason ?? null,
    acceptance_status: projection.acceptance.status,
    recovery_mode: recovery?.mode ?? 'unknown',
    side_effect_level: recovery?.side_effect_level ?? 'unknown',
    budget_used: budgetUsed(projection.loop),
    budget_remaining: projection.loop?.budget_remaining ?? null,
    last_evidence: lastEvidence,
    next_admissible_action: recovery?.action ?? 'unknown',
    recovery_reason: recovery?.reason ?? null,
    updated_at: projection.updated_at
  };
}

async function printProjectedTaskStatus(config, guard, workspace, options, positionals) {
  requireBuild('dist/tasks/taskProjectionService.js');
  const { TaskProjectionService } = await import('../dist/tasks/taskProjectionService.js');
  const service = new TaskProjectionService(config, guard, workspace);
  const goalId = String(options.goalId ?? '').trim();
  const taskId = String(options.taskId ?? (goalId ? `goal-${goalId}` : positionals[0] ?? '')).trim();
  if (!taskId) {
    const statuses = await service.listStatuses(numberArg(options.limit) ?? 100);
    const tasks = [];
    for (const projection of statuses) tasks.push(await formatTaskProjection(service, projection));
    printJson({ tasks });
    return;
  }
  printJson(await formatTaskProjection(service, await service.getStatus(taskId)));
}

function setExitCodeForGoal(goal) {
  if (goal.status === 'failed' || goal.status === 'blocked' || goal.status === 'cancelled') process.exitCode = 1;
  else if (goal.status === 'waiting_input' || goal.status === 'waiting_approval') process.exitCode = 2;
}

export async function runExecTask(command, argv) {
  const { options, positionals } = parseCommandArgs(argv);
  if (options.help) {
    printTaskHelp();
    return;
  }
  const root = realDir(options.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const { config, guard, workspace } = await loadWorkspace(root, options);

  if (command === 'status' && !options.rawGoal) {
    await printProjectedTaskStatus(config, guard, workspace, options, positionals);
    return;
  }

  requireBuild('dist/workflow/execRunner.js');
  const { ExecRunner } = await import('../dist/workflow/execRunner.js');
  const runner = new ExecRunner(config, guard, workspace, {
    executable: options.codexExecutable,
    timeout_ms: numberArg(options.timeoutMs),
    review_timeout_ms: numberArg(options.reviewTimeoutMs),
    max_parallel: numberArg(options.maxParallel),
    resource_wait_timeout_ms: numberArg(options.resourceWaitTimeoutMs),
    review_enabled: !options.noReview
  });

  if (command === 'run') {
    const objective = String(options.objective ?? options.task ?? positionals.join(' ')).trim();
    if (!objective) throw new Error('task run requires --objective <text> or a positional objective.');
    const sandbox = options.sandbox ?? 'workspace-write';
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
      throw new Error('Exec Runner only supports --sandbox read-only or workspace-write.');
    }
    const request = {
      objective,
      constraints: stringArray(options.constraint),
      acceptance: stringArray(options.acceptance),
      sandbox_mode: sandbox,
      model: options.model,
      reasoning_effort: options.reasoningEffort,
      skip_git_repo_check: Boolean(options.skipGitRepoCheck)
    };
    const idempotencyKey = String(options.idempotencyKey ?? stableIdempotencyKey({ root, ...request }));
    const inspection = await runner.run({ ...request, idempotency_key: idempotencyKey });
    printJson(inspection);
    setExitCodeForGoal(inspection.goal);
    return;
  }

  const goalId = String(options.goalId ?? positionals[0] ?? '').trim();
  if (command === 'status' && !goalId) {
    printJson({ goals: await runner.list() });
    return;
  }
  if (!goalId) throw new Error(`task ${command} requires --goal-id <goal-id>.`);

  if (command === 'status') {
    const inspection = await runner.status(goalId);
    printJson(inspection);
    return;
  }
  if (command === 'resume') {
    const prompt = String(options.prompt ?? positionals.slice(1).join(' ')).trim();
    if (!prompt) throw new Error('task resume requires --prompt <text>.');
    const inspection = await runner.resume({
      goal_id: goalId,
      prompt,
      ...(options.idempotencyKey ? { idempotency_key: String(options.idempotencyKey) } : {})
    });
    printJson(inspection);
    setExitCodeForGoal(inspection.goal);
    return;
  }
  if (command === 'cancel') {
    const inspection = await runner.cancel(goalId);
    printJson(inspection);
    return;
  }
  if (command === 'review') {
    const report = await runner.review(goalId);
    printJson(report);
    if (report.review && report.review.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'hooks-replay') {
    const inspection = await runner.replayHooks(goalId);
    printJson(inspection);
    setExitCodeForGoal(inspection.goal);
  }
}

export async function runTaskTemplate(argv) {
  const { options, positionals } = parseCommandArgs(argv);
  if (options.help) {
    printTaskHelp();
    return;
  }
  requireBuild('dist/workflow/taskTemplateEngine.js');
  const template = options.template ?? positionals[0] ?? 'bugfix';
  const task = options.task ?? positionals.slice(1).join(' ');
  const root = realDir(options.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const [{ runTaskTemplate: executeTemplate }, { config, guard, workspace }] = await Promise.all([
    import('../dist/workflow/taskTemplateEngine.js'),
    loadWorkspace(root, options)
  ]);
  const result = await executeTemplate(config, guard, workspace, {
    template,
    task,
    goal: options.goal,
    commands: stringArray(options.command),
    acceptance_profile: options.acceptanceProfile,
    dry_run: Boolean(options.dryRun),
    run_id: options.runId,
    output_mode: options.full ? 'full' : 'compact',
    tail_lines: numberArg(options.tailLines),
    save_full_logs: options.fullLogs ? true : undefined,
    debug: Boolean(options.debug)
  });
  console.log(result.text);
  if (result.status === 'failed') process.exitCode = 1;
}

export function runNotification(argv) {
  const { options, positionals } = parseCommandArgs(argv);
  if (options.help) {
    console.log(`CodexPro notification command

Usage:
  codexpro notify --status success --title "CodexPro 任务完成：Stage 9A" --body "任务已完成。" --project example-project-a --next-step "查看结果。"

Options:
  --status <status>      success, failed, waiting, start, or info. Default: info.
  --title <text>         Notification title.
  --body <text>          Notification result/body.
  --project <name>       Project name. Defaults to the workspace directory name.
  --next-step <text>     Suggested next action.
  --root <dir>           Target workspace root. Default: current directory.
`);
    return;
  }

  const root = realDir(options.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const status = String(options.status ?? positionals[0] ?? 'info').trim().toLowerCase();
  if (!['success', 'failed', 'waiting', 'start', 'info'].includes(status)) {
    throw new Error(`Unsupported notification status: ${status}`);
  }
  const projectName = String(options.project ?? path.basename(root) ?? 'codexpro-project').trim() || 'codexpro-project';
  const title = String(options.title ?? 'CodexPro 通知').trim() || 'CodexPro 通知';
  const body = String(options.body ?? '任务状态已更新。').trim() || '任务状态已更新。';
  const nextStep = String(options.nextStep ?? '查看 CodexPro 输出。').trim() || '查看 CodexPro 输出。';
  const scriptPath = path.join(projectRoot, 'scripts', 'notifications', 'notify-common.sh');
  if (!fs.existsSync(scriptPath)) throw new Error(`Bundled notification script is missing: ${scriptPath}`);

  const result = runManagedProcessSync('bash', [scriptPath, status, title, body, projectName, nextStep], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEXPRO_TARGET_ROOT: root,
      CODEXPRO_PROJECT_ROOT: root,
      CODEXPRO_PROJECT_NAME: projectName
    },
    stdio: 'inherit',
    domain: 'notification',
    operation: 'cli_notify',
    sideEffectLevel: 'external_write',
    riskLevel: 'low',
    recordRoot: root
  });
  if (result.spawnError) throw new Error(result.stderr || result.errorClass || 'notification spawn failed');
  if ((result.exitCode ?? 1) !== 0) process.exitCode = result.exitCode ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'notify') {
    runNotification(argv.slice(1));
    return;
  }
  if (argv[0] === 'task') {
    const subcommand = argv[1];
    if (EXEC_SUBCOMMANDS.has(subcommand)) await runExecTask(subcommand, argv.slice(2));
    else await runTaskTemplate(argv.slice(1));
    return;
  }
  if (argv[0] === 'run-task-template') {
    await runTaskTemplate(argv.slice(1));
    return;
  }
  const result = runManagedProcessSync(process.execPath, [legacyLauncher, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    domain: 'shell',
    operation: 'codexpro_cli_legacy_launcher',
    sideEffectLevel: 'local_write',
    riskLevel: 'medium',
    recordRoot: process.cwd()
  });
  if (result.spawnError) throw new Error(result.stderr || result.errorClass || 'legacy launcher spawn failed');
  process.exit(result.exitCode ?? 1);
}

function isDirectCliInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(cliFile);
  } catch {
    return path.resolve(entry) === cliFile;
  }
}

if (isDirectCliInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
