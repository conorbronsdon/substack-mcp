import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEnabled, selectProbePublication, readOnlyProbeFetch } from './probe-helpers.mjs';
test('explicit probe opt-in and read-only argument are both required', () => {
  assert.equal(probeEnabled({ SUBSTACK_CONTRACT_PROBE: '1' }, ['--read-only']), true);
  for (const [env, args] of [[{}, ['--read-only']], [{ SUBSTACK_CONTRACT_PROBE: '0' }, ['--read-only']], [{ SUBSTACK_CONTRACT_PROBE: '1' }, []], [{ SUBSTACK_CONTRACT_PROBE: '1' }, ['--write']], [{ SUBSTACK_CONTRACT_PROBE: '1' }, ['--read-only', '--write']]]) assert.equal(probeEnabled(env, args), false);
});
test('publication selection never silently falls back', () => {
  const a = { key: 'a', missing: [] }, b = { key: 'b', missing: [] };
  assert.equal(selectProbePublication([a]), a); assert.equal(selectProbePublication([a,b], 'b'), b);
  for (const [publications,key] of [[[a,b],undefined], [[a],'missing'], [[a],''], [[],undefined], [[{key:'a',missing:['sessionToken']}], 'a']]) assert.throws(() => selectProbePublication(publications,key));
});
test('probe forwards GET and blocks all non-GET requests before transport', async () => {
  let forwarded = 0; const counters = { reads: 0, blocked: 0 };
  const guarded = readOnlyProbeFetch(async () => { forwarded++; return Response.json({ok:true}); }, counters);
  await guarded('https://example.invalid'); await guarded(new Request('https://example.invalid'));
  assert.equal(forwarded, 2);
  for (const method of ['POST','PUT','PATCH','DELETE']) {
    await assert.rejects(guarded('https://example.invalid', {method}), /blocked/);
    await assert.rejects(guarded(new Request('https://example.invalid', {method})), /blocked/);
  }
  assert.equal(forwarded, 2); assert.deepEqual(counters, { reads: 2, blocked: 8 });
});
