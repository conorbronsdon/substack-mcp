export function probeEnabled(env, args) {
  return env.SUBSTACK_CONTRACT_PROBE === '1' && args.length === 1 && args[0] === '--read-only';
}
export function selectProbePublication(publications, key) {
  const selected = key !== undefined ? publications.find(p => p.key === key) : publications.length === 1 ? publications[0] : undefined;
  if (!selected || selected.missing.length) throw new Error('Invalid publication selection');
  return selected;
}
/** The live probe's dedicated process never forwards a non-GET fetch. */
export function readOnlyProbeFetch(fetch, counters) {
  return async (input, init) => {
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') { counters.blocked++; throw new Error('Probe blocked a non-GET request'); }
    counters.reads++;
    return fetch(input, init);
  };
}
