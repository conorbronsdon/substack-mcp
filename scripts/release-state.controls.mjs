import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { decideRelease, inspectRelease, lookupJson, releaseManifest, verifyStage, releaseErrorMessage, verifyWithPolling } from './release-state.mjs';

const pkg = { name: '@conorbronsdon/substack-mcp', mcpName: 'io.github.conorbronsdon/substack-mcp', version: '0.9.0' };
// Synthetic credential used only to assert auth scoping; never a real value.
const fixtureAuth = 'example-token';
const sha = 'a'.repeat(40), newerSha = 'b'.repeat(40);
const manifest = { name: pkg.mcpName, version: pkg.version, packages: [{ registryType: 'npm', identifier: pkg.name, version: pkg.version }] };
const state = () => ({
  latest: { name: pkg.name, version: pkg.version },
  npm: { name: pkg.name, version: pkg.version, gitHead: sha, dist: { integrity: 'sha512-YWJj' } },
  registry: { server: structuredClone(manifest), _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
  release: { tag_name: 'v0.9.0', draft: false, prerelease: false, published_at: '2026-09-07T20:00:00Z' },
  tagSha: sha,
});

test('plans no-op and independent npm, Registry and GitHub recovery', () => {
  const s = state();
  assert.deepEqual(decideRelease(pkg, newerSha, s), { version: '0.9.0', target: sha, npm: false, registry: false, github: false });
  assert.equal(decideRelease(pkg, sha, { ...s, latest: { name: pkg.name, version: '0.8.0' }, npm: null }).npm, true);
  assert.deepEqual(decideRelease(pkg, newerSha, { ...s, registry: null }), { version: '0.9.0', target: sha, npm: false, registry: true, github: false });
  assert.deepEqual(decideRelease(pkg, newerSha, { ...s, release: null, tagSha: null }), { version: '0.9.0', target: sha, npm: false, registry: false, github: true });
  assert.deepEqual(decideRelease(pkg, sha, { latest: null, npm: null, registry: null, release: null, tagSha: null }), { version: '0.9.0', target: sha, npm: true, registry: true, github: true });
});

test('rejects stale versions, mismatched identities and incomplete metadata', () => {
  assert.throws(() => decideRelease(pkg, sha, {
    latest: { name: pkg.name, version: '1.0.0' }, npm: null, registry: null, release: null, tagSha: null,
  }), /non-monotonic/);
  const mutations = [
    s => { s.latest.version = '1.0.0'; },
    s => { s.latest.name = 'other'; },
    s => { s.npm.version = '0.8.0'; },
    s => { s.npm.name = 'other'; },
    s => { delete s.npm.gitHead; },
    s => { delete s.npm.dist; },
    s => { s.npm = null; },
    s => { s.latest = null; },
    s => { s.tagSha = newerSha; },
    s => { s.tagSha = null; },
    s => { s.release.draft = true; },
    s => { s.release.prerelease = true; },
    s => { s.release.published_at = null; },
    s => { s.release.tag_name = 'v0.8.0'; },
    s => { s.registry.server.name = 'other'; },
    s => { s.registry.server.packages[0].identifier = 'other'; },
    s => { s.registry.server.packages[0].version = '0.8.0'; },
    s => { s.registry._meta['io.modelcontextprotocol.registry/official'].status = 'deleted'; },
    s => { s.registry._meta['io.modelcontextprotocol.registry/official'].status = 'deprecated'; },
  ];
  for (const mutate of mutations) { const s = state(); mutate(s); assert.throws(() => decideRelease(pkg, sha, s)); }
  assert.throws(() => decideRelease({ ...pkg, version: '0.9.0-beta.1' }, sha, state()));
});

test('404 is absent, valid JSON is present, all other failures remain unknown', async () => {
  assert.equal(await lookupJson('https://example.invalid', { fetchImpl: async () => new Response('', { status: 404 }) }), null);
  assert.deepEqual(await lookupJson('https://example.invalid', { fetchImpl: async () => new Response('{"present":true}') }), { present: true });
  for (const status of [204, 301, 401, 403, 429, 500, 503]) {
    await assert.rejects(lookupJson('https://example.invalid', { fetchImpl: async () => new Response(null, { status }) }), /Release lookup failed/);
  }
  for (const body of ['private invalid JSON', 'null', '[]']) {
    await assert.rejects(lookupJson('https://example.invalid', { fetchImpl: async () => new Response(body) }), error => !error.message.includes('private'));
  }
  await assert.rejects(lookupJson('https://example.invalid', { fetchImpl: async () => { throw Error('private authorization'); } }), error => !error.message.includes('private'));
});

test('response bounds include streamed bytes and slow headers/body/cancellation', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '9999' }]) {
    await assert.rejects(lookupJson('https://example.invalid', { maxBytes: 2, fetchImpl: async () => new Response('{} ', { headers }) }), /exceeds limit/);
  }
  let cancelled = 0;
  await assert.rejects(lookupJson('https://example.invalid', { timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } })) }), /timed out/);
  assert.equal(cancelled, 1);
  let finish;
  await assert.rejects(lookupJson('https://example.invalid', { timeoutMs: 10, fetchImpl: () => new Promise(resolve => { finish = resolve; }) }), /timed out/);
  finish(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await Promise.resolve();
  assert.equal(cancelled, 2);
});

test('lookup requests reject redirects and preserve provided auth only for that call', async () => {
  await lookupJson('https://example.invalid', { headers: { Authorization: fixtureAuth }, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, fixtureAuth);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('{}');
  } });
});

test('uses exact encoded identities, handles annotated tags and scopes GitHub auth', async () => {
  const s = state(), calls = [];
  const lookup = async (url, options) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) assert.equal(options.headers.Authorization, `Bearer ${fixtureAuth}`);
    else assert.equal(options, undefined);
    if (url.endsWith('/latest')) return s.latest;
    if (url.startsWith('https://registry.npmjs.org/')) return s.npm;
    if (url.startsWith('https://registry.modelcontextprotocol.io/')) return s.registry;
    if (url.includes('/releases/tags/')) return s.release;
    if (url.includes('/git/ref/')) return { ref: 'refs/tags/v0.9.0', object: { type: 'tag', sha: newerSha } };
    return { sha: newerSha, object: { type: 'commit', sha } };
  };
  assert.equal((await inspectRelease(pkg, newerSha, { token: fixtureAuth, lookup })).target, sha);
  assert.ok(calls.includes('https://registry.npmjs.org/%40conorbronsdon%2Fsubstack-mcp/0.9.0'));
  assert.ok(calls.includes('https://registry.modelcontextprotocol.io/v0.1/servers/io.github.conorbronsdon%2Fsubstack-mcp/versions/0.9.0?include_deleted=true'));
  assert.equal(calls.length, 6);
});

test('never returns a publication plan after any lookup failure', async () => {
  for (let failAt = 0; failAt < 5; failAt++) {
    let count = 0;
    await assert.rejects(inspectRelease(pkg, sha, { lookup: async () => {
      if (count++ === failAt) throw Error('unavailable');
      return null;
    } }), /unavailable/);
    assert.equal(count, failAt + 1);
  }
});

test('recovery manifest comes from verified original commit, not development HEAD', () => {
  const commands = [];
  const git = args => { commands.push(args); return args[0] === 'merge-base' ? '' : JSON.stringify(args[1].endsWith('package.json') ? pkg : manifest); };
  assert.deepEqual(releaseManifest(pkg, sha, newerSha, git), manifest);
  assert.deepEqual(commands, [['merge-base', '--is-ancestor', sha, newerSha], ['show', `${sha}:package.json`], ['show', `${sha}:server.json`]]);
  assert.throws(() => releaseManifest(pkg, sha, newerSha, () => { throw Error('private git failure'); }), /Fetch full history/);
  assert.throws(() => releaseManifest(pkg, sha, newerSha, args => args[0] === 'merge-base' ? '' : JSON.stringify({ ...pkg, version: '0.8.0' })), /identity mismatch/);
});

test('renders precise trusted diagnostics without exposing external error details', async () => {
  try { decideRelease(pkg, sha, { ...state(), tagSha: newerSha }); assert.fail('must reject mismatched tag'); }
  catch (error) { assert.equal(releaseErrorMessage(error), 'Existing release tag points to a different commit'); }
  assert.ok(!releaseErrorMessage(new Error('private external error')).includes('private'));
  try {
    await lookupJson('https://example.invalid', { fetchImpl: async () => { throw Error('Release lookup private forged message'); } });
    assert.fail('must reject failed lookup');
  } catch (error) { assert.equal(releaseErrorMessage(error), 'Release lookup failed; state is unknown'); }
});

test('workflow separates recovery gates and verifies each publication', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8').replaceAll('\r\n', '\n');
  for (const command of ['plan', 'verify-npm', 'verify-registry', 'verify']) assert.ok(workflow.includes(`node scripts/release-state.mjs ${command}\n`));
  assert.ok(workflow.includes("if: steps.registry.outputs.github == 'true'"));
  assert.ok(workflow.includes('mcp-publisher publish "$RELEASE_MANIFEST"'));
  assert.ok(workflow.includes('fetch-depth: 0'));
  assert.ok(!workflow.slice(workflow.indexOf('    env:'), workflow.indexOf('    steps:')).includes('runner.'));
  assert.ok(workflow.includes('RELEASE_MANIFEST=$RUNNER_TEMP/release-server.json'));
  assert.ok(!workflow.includes('|| echo none'));
  assert.ok(!workflow.includes('REGISTRY_VERSION=unknown'));
});

test('verification stages reject partial publication and changed release targets', () => {
  const complete = decideRelease(pkg, sha, state());
  for (const command of ['plan', 'verify-npm', 'verify-registry', 'verify']) {
    verifyStage(complete, command, sha);
    assert.throws(() => verifyStage(complete, command, newerSha), /target changed/);
  }
  verifyStage({ ...complete, registry: true, github: true }, 'verify-npm', sha);
  verifyStage({ ...complete, github: true }, 'verify-registry', sha);
  assert.throws(() => verifyStage({ ...complete, npm: true }, 'verify-npm', sha), /npm publication/);
  assert.throws(() => verifyStage({ ...complete, registry: true }, 'verify-registry', sha), /Registry publication/);
  assert.throws(() => verifyStage({ ...complete, github: true }, 'verify', sha), /GitHub release/);
  assert.throws(() => verifyStage(complete, 'unknown', sha), /Unknown/);
});

test('missing npm gitHead has an explicit integrity-bound manual recovery path', () => {
  const missing = state(); delete missing.npm.gitHead;
  const options = { reconciledCommit: sha, reconciledIntegrity: missing.npm.dist.integrity };
  assert.equal(decideRelease(pkg, newerSha, missing, options).target, sha);
  assert.throws(() => decideRelease(pkg, newerSha, missing), /manual reconciliation/);
  assert.throws(() => decideRelease(pkg, newerSha, missing, { ...options, reconciledIntegrity: 'sha512-b3RoZXI=' }), /integrity does not match/);
  assert.throws(() => decideRelease(pkg, newerSha, missing, { ...options, reconciledCommit: 'main' }), /both commit\/integrity/);
  assert.throws(() => decideRelease(pkg, newerSha, missing, { reconciledCommit: sha }), /both commit\/integrity/);
  assert.throws(() => decideRelease(pkg, newerSha, state(), options), /without valid gitHead/);
  assert.throws(() => decideRelease(pkg, newerSha, { ...missing, npm: null, latest: null }, options), /existing npm version/);
  assert.throws(() => decideRelease(pkg, newerSha, missing, { ...options, reconciledCommit: newerSha }), /tag points/);
});

test('verification tolerates propagation with bounded read-only polling', async () => {
  const complete = decideRelease(pkg, sha, state()), waits = [];
  let reads = 0;
  assert.deepEqual(await verifyWithPolling(async () => {
    reads++;
    return reads < 3 ? { ...complete, npm: true } : complete;
  }, 'verify-npm', sha, async ms => waits.push(ms)), complete);
  assert.equal(reads, 3); assert.deepEqual(waits, [1000, 3000]);
  reads = 0;
  await assert.rejects(verifyWithPolling(async () => { reads++; return { ...complete, registry: true }; }, 'verify-registry', sha, async () => {}), /not yet verified/);
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(verifyWithPolling(async () => { reads++; return complete; }, 'verify', newerSha, async () => assert.fail('must not retry target mismatch')), /target changed/);
  assert.equal(reads, 1);
});

test('only verification polls transient lookups, never auth failures or the initial plan', async () => {
  for (const [command, status, expectedReads] of [['plan', 503, 1], ['verify', 503, 3], ['verify', 429, 3], ['verify', 403, 1]]) {
    let reads = 0;
    await assert.rejects(verifyWithPolling(async () => {
      reads++;
      return lookupJson('https://example.invalid', { fetchImpl: async () => new Response('', { status }) });
    }, command, sha, async () => {}), /Release lookup failed/);
    assert.equal(reads, expectedReads);
  }
});
