// Runs the real release publisher against a throwaway loopback registry, never GHCR.
// The Container workflow uses it so a runner Docker change that breaks the
// publisher's identity checks fails a pull request instead of a release.
// Usage: node scripts/publish-container.local-registry.mjs <local-image> <revision> <registry-host:port>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { publishContainer } from './publish-container.mjs';

const [source, revision, registry] = process.argv.slice(2);
assert.ok(source && revision && /^(localhost|127\.0\.0\.1):\d+$/.test(registry ?? ''), 'Provide a local image, revision and a loopback registry host:port');
const release = 'ghcr.io/conorbronsdon/substack-mcp';
const local = `${registry}/substack-mcp`;
const rewrite = arg => arg.startsWith(release) ? local + arg.slice(release.length) : arg;
const run = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
// Same command sequence as the release job; only the image name is rewritten,
// and the plain-HTTP loopback registry needs --insecure for manifest reads.
const docker = (...args) => {
  const mapped = args.map(rewrite);
  const at = mapped.indexOf('manifest');
  if (at >= 0 && mapped[at + 1] === 'inspect') mapped.splice(at + 2, 0, '--insecure');
  return run(...mapped);
};
const temp = mkdtempSync(join(tmpdir(), 'publish-container-local-'));
try {
  run('tag', source, `${local}:build`);
  // The first pass publishes a missing version; the second takes the existing-release recovery path.
  for (const [attempt, path] of [['1', 'new version'], ['2', 'existing version']]) {
    const result = publishContainer({ version: pkg.version, revision, run: '1', attempt, temp }, {
      docker, makeDirectory: dir => mkdirSync(dir, { recursive: true }),
      verifyImage: (image, sha) => execFileSync(process.execPath, ['scripts/test-container.mjs', rewrite(image), sha], { stdio: 'inherit', timeout: 120000 }),
    });
    assert.equal(result.provenance_eligible, true, `${path}: the published digest must match the verified candidate`);
    console.log(`${path}: ${JSON.stringify(result)}`);
  }
} catch (error) {
  // Loopback registry only: no credentials exist here, so the full message is safe to print.
  console.error(`Local registry publication failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
