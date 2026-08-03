export function isAllowedReadOnlyBridgeEntry(value, options = {}) {
  const entry = String(value).replaceAll('\\', '/');
  const additionalAllowed = new Set(options.additionalAllowed ?? []);
  if (additionalAllowed.has(entry)) return true;
  if (entry === 'execution-components' || entry === 'execution-components/state.json') return true;
  if (entry === 'execution-components/state.json.lock' || entry === 'execution-components/state.json.lock/owner.json') return true;
  if (/^execution-components\/state\.json\.tmp-\d+-[0-9a-f]{8}$/.test(entry)) return true;
  if (entry === 'usage' || entry === 'usage/aggregates' || entry === 'usage/daily') return true;
  // Startup recovery may initialize the resource-governor lock parent, but a
  // read-only path must still never persist resource state or lock contents.
  if (entry === 'resource-governor') return true;
  if (entry === 'usage/.lock' || entry === 'usage/entries.jsonl' || entry === 'usage/warnings.jsonl') return true;
  if (/^usage\/index\.json(?:\.tmp-\d+-\d+)?$/.test(entry)) return true;
  if (/^usage\/aggregates\/latest\.json(?:\.tmp-\d+-\d+)?$/.test(entry)) return true;
  return /^usage\/daily\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry);
}
