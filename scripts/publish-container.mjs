// Runs only in the verified release job. Never prints credentials or registry bodies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { pathToFileURL } from 'node:url';
export function publishContainer({ version, revision, run, attempt, temp }, { docker, verifyImage, makeDirectory }) {
const image = 'ghcr.io/conorbronsdon/substack-mcp';
assert.equal(version, pkg.version); assert.match(version, /^\d+\.\d+\.\d+$/);
assert.match(revision ?? '', /^[a-f0-9]{40}$/); assert.match(run ?? '', /^\d+$/); assert.match(attempt ?? '', /^\d+$/); assert.ok(temp);
const candidate = `${image}:build-${run}-${attempt}`;
const versioned = `${image}:${version}`;
// A fresh candidate establishes package ownership before missing-manifest checks.
docker('tag', `${image}:build`, candidate); docker('push', candidate);
let exists = true;
try { docker('manifest', 'inspect', versioned); }
catch (error) {
  if (!/manifest unknown|no such manifest/i.test(String(error.stderr))) throw new Error('Cannot determine existing container release; stop without moving version tags.');
  exists = false;
}
if (exists) {
  docker('pull', versioned);
  const info = JSON.parse(docker('image', 'inspect', versioned))[0];
  assert.equal(info.Config.Labels['org.opencontainers.image.version'], version);
  assert.equal(info.Config.Labels['org.opencontainers.image.revision'], revision);
  verifyImage(versioned, revision);
} else {
  docker('tag', candidate, versioned); docker('push', versioned);
}
const manifest = JSON.parse(docker('manifest', 'inspect', versioned));
assert.ok(manifest.config?.digest, 'Expected a single-platform image manifest');
// Full-SHA and latest aliases point to the same already-verified version image.
for (const tag of [`sha-${revision}`, 'latest']) { docker('tag', versioned, `${image}:${tag}`); docker('push', `${image}:${tag}`); }
// Public discovery is a release gate. This isolated config has no auth helpers.
const anonymous = join(temp, `docker-anonymous-${run}-${attempt}`); makeDirectory(anonymous);
let publicManifest;
try { publicManifest = JSON.parse(docker('--config', anonymous, 'manifest', 'inspect', versioned)); }
catch { throw new Error('Image published but anonymous access failed. Verify the GHCR package is public, then rerun Publish; existing version images are preserved.'); }
assert.deepEqual(publicManifest, manifest);
return { image: versioned, revision, architecture: 'linux/amd64', public: true, config_digest: manifest.config.digest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { VERSION: version, RELEASE_TARGET: revision, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, RUNNER_TEMP: temp } = process.env;
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    console.log(JSON.stringify(publishContainer({ version, revision, run, attempt, temp }, {
      docker, makeDirectory: path => mkdirSync(path, { recursive: true }),
      verifyImage: (image, sha) => execFileSync(process.execPath, ['scripts/test-container.mjs', image, sha], { stdio: 'inherit', timeout: 120000 }),
    })));
  } catch (error) { console.error(error instanceof assert.AssertionError ? 'Container identity mismatch; publication stopped.' : error.message.startsWith('Command failed') ? 'Container command failed; inspect the release stage and reconcile before retrying.' : error.message); process.exitCode = 1; }
}
