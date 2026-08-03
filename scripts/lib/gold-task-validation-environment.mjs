export function goldTaskValidationEnvironment({
  baseEnv = process.env,
  worktree,
  sessionDirectory,
  descriptor
}) {
  if (!worktree) throw new Error('Gold Task validation worktree is required.');
  if (!sessionDirectory) throw new Error('Gold Task validation session directory is required.');
  if (!descriptor?.suite_run_id) throw new Error('Gold Task validation suite run id is required.');
  if (!descriptor?.task_id) throw new Error('Gold Task validation task id is required.');

  return {
    ...baseEnv,
    CI: '1',
    NO_COLOR: '1',
    CODEXPRO_ROOT: worktree,
    CODEXPRO_ALLOWED_ROOTS: worktree,
    CODEXPRO_GOLD_TASK_SESSION_DIR: sessionDirectory,
    CODEXPRO_GOLD_TASK_SESSION_ID: descriptor.suite_run_id,
    CODEXPRO_GOLD_TASK_ID: descriptor.task_id,
    CODEXPRO_CODEX_ADAPTER: 'off'
  };
}
