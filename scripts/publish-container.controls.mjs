import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishContainer } from './publish-container.mjs';
import pkg from '../package.json' with { type: 'json' };
const input = { version: pkg.version, revision: 'a'.repeat(40), run: '1', attempt: '1', temp: '/temporary' };
const image = 'ghcr.io/conorbronsdon/substack-mcp';
function fixture(mode) {
  const calls = []; let verified = 0, versionLookups = 0;
  const manifest = { config: { digest: 'sha256:' + 'b'.repeat(64) } };
  const docker = (...args) => {
    calls.push(args);
    if (args[0] === '--config') {
      if (mode === 'private') throw new Error('unauthorized');
      return JSON.stringify(manifest);
    }
    if (args[0] === 'image') return JSON.stringify([{ Id: mode === 'race' && args[2] === `${image}:${pkg.version}` ? 'sha256:' + 'd'.repeat(64) : manifest.config.digest, Config: { Labels: { 'org.opencontainers.image.version': pkg.version, 'org.opencontainers.image.revision': mode === 'mismatch' ? 'c'.repeat(40) : input.revision } } }]);
    if (args[0] === 'manifest') {
      if (args[2] === `${image}:${pkg.version}` && ++versionLookups === 1 && ['absent', 'unknown'].includes(mode)) throw Object.assign(new Error('lookup failed'), { stderr: mode === 'absent' ? 'manifest unknown' : 'unauthorized' });
      return JSON.stringify(manifest);
    }
    return '';
  };
  return { calls, run: () => publishContainer(input, { docker, verifyImage: () => { verified++; }, makeDirectory: () => {} }), verified: () => verified };
}
test('new version publishes after an explicit missing-manifest response', () => {
  const f = fixture('absent'); assert.equal(f.run().public, true);
  assert.ok(f.calls.some(args => args[0] === 'push' && args[1] === `${image}:${pkg.version}`));
});
test('existing matching version is tested and preserved on recovery', () => {
  const f = fixture('existing'); assert.equal(f.run().public, true); assert.equal(f.verified(), 1);
  assert.ok(!f.calls.some(args => args[0] === 'push' && args[1] === `${image}:${pkg.version}`));
});
for (const mode of ['unknown', 'mismatch', 'race']) test(`${mode} identity never moves release aliases`, () => {
  const f = fixture(mode); assert.throws(f.run);
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
});
test('private package cannot report a successful public release', () => {
  const f = fixture('private'); assert.throws(f.run, /anonymous access failed/);
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
});
