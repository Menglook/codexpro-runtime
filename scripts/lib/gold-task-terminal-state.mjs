function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function authoritativeTerminalResult(input, defaults = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const finishedAt = validTimestamp(source.finished_at)
    ? source.finished_at
    : validTimestamp(defaults.finished_at)
      ? defaults.finished_at
      : new Date().toISOString();
  const stopReason = String(source.stop_reason ?? defaults.stop_reason ?? '').trim();
  if (!stopReason) throw new Error('Terminal supervision result requires a stop_reason.');
  const supervisorTerminated = source.supervisor_terminated ?? defaults.supervisor_terminated;
  const treeTerminated = source.tree_terminated ?? defaults.tree_terminated;
  if (typeof supervisorTerminated !== 'boolean' || typeof treeTerminated !== 'boolean') {
    throw new Error('Terminal supervision result requires boolean supervisor_terminated and tree_terminated fields.');
  }
  return {
    ...defaults,
    ...source,
    stop_reason: stopReason,
    finished_at: finishedAt,
    supervisor_terminated: supervisorTerminated,
    tree_terminated: treeTerminated
  };
}

export function terminalProgressRecord(progress, terminalInput) {
  const terminal = authoritativeTerminalResult(terminalInput);
  const existing = progress && typeof progress === 'object' ? progress : {};
  return {
    version: 1,
    ...existing,
    active: false,
    current_step: 'finished',
    updated_at: terminal.finished_at,
    finished_at: terminal.finished_at,
    stop_reason: terminal.stop_reason,
    failure_classification: terminal.failure_classification ?? existing.failure_classification ?? null,
    supervisor_terminated: terminal.supervisor_terminated,
    tree_terminated: terminal.tree_terminated
  };
}

export function assertTerminalResultMatches(authoritative, observed, label = 'terminal result') {
  const expected = authoritativeTerminalResult(authoritative);
  for (const field of ['stop_reason', 'finished_at', 'supervisor_terminated', 'tree_terminated']) {
    if (observed?.[field] !== expected[field]) {
      throw new Error(`${label} field ${field} disagrees with supervision-result.json.`);
    }
  }
  return expected;
}
