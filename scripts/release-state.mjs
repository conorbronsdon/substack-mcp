import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import semver from 'semver';
import { classifyRelease } from './check-release-order.mjs';

const repository = 'conorbronsdon/substack-mcp';
const officialKey = 'io.modelcontextprotocol.registry/official';
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
class ReleaseStateError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}
const requireState = (condition, message, retryable = false) => { if (!condition) throw new ReleaseStateError(message, retryable); };
export const releaseErrorMessage = error => error instanceof ReleaseStateError
  ? error.message
  : 'Release state could not be verified. Inspect metadata and local history before retrying; no lookup failure authorizes publication.';

/** Only a confirmed HTTP 404 is absence. Errors never authorize publication. */
export async function lookupJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = 10000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  let rejectTimeout;
  const expired = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { rejectTimeout(new ReleaseStateError('Release lookup timed out', true)); controller.abort(); }, timeoutMs);
  let response, reader;
  const discard = value => { void value?.body?.cancel().catch(() => {}); };
  try {
    const pending = fetchImpl(url, { headers, redirect: 'error', signal: controller.signal });
    void pending.then(value => { if (controller.signal.aborted) discard(value); }, () => {});
    response = await Promise.race([pending, expired]);
    if (response.status === 404) { discard(response); return null; }
    requireState(response.status === 200, `Release lookup failed (HTTP ${response.status})`, response.status === 429 || response.status >= 500);
    const length = response.headers.get('content-length');
    requireState(!length || !/^\d+$/.test(length) || Number(length) <= maxBytes, 'Release lookup body exceeds limit');
    requireState(response.body, 'Release lookup returned an empty body');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      requireState(size <= maxBytes, 'Release lookup body exceeds limit');
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireState(result && typeof result === 'object' && !Array.isArray(result), 'Release lookup returned invalid metadata');
    return result;
  } catch (error) {
    // Do not echo response bodies, authorization headers, or fetch error causes.
    if (error instanceof ReleaseStateError) throw error;
    throw new ReleaseStateError('Release lookup failed; state is unknown', !(error instanceof SyntaxError));
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else discard(response);
  }
}

export function validateManifest(manifest, pkg) {
  requireState(manifest?.name === pkg.mcpName && manifest?.version === pkg.version, 'Release manifest identity mismatch');
  requireState(Array.isArray(manifest.packages) && manifest.packages.length === 1 &&
    manifest.packages[0].registryType === 'npm' && manifest.packages[0].identifier === pkg.name &&
    manifest.packages[0].version === pkg.version, 'Release manifest package mismatch');
}

/** Pure decisions over validated lookups. No command here publishes anything. */
export function decideRelease(pkg, sha, { latest, npm, registry, release, tagSha }, { reconciledCommit, reconciledIntegrity } = {}) {
  requireState(pkg.name === '@conorbronsdon/substack-mcp' && pkg.mcpName === 'io.github.conorbronsdon/substack-mcp', 'Unexpected release identity');
  requireState(isSha(sha), 'Invalid release commit');
  requireState(semver.valid(pkg.version) === pkg.version && !semver.prerelease(pkg.version), 'Only canonical stable releases are supported');
  if (latest) requireState(latest.name === pkg.name && semver.valid(latest.version) === latest.version, 'npm latest identity mismatch');
  try { classifyRelease(pkg.version, latest?.version ?? 'none'); }
  catch { throw new ReleaseStateError('Refusing non-monotonic release: local version is older than npm latest'); }
  const manual = Boolean(reconciledCommit || reconciledIntegrity);
  if (manual) requireState(npm && !isSha(npm.gitHead) && isSha(reconciledCommit) && typeof reconciledIntegrity === 'string', 'Manual reconciliation requires an existing npm version without valid gitHead and both commit/integrity inputs');
  if (npm) {
    requireState(npm.name === pkg.name && npm.version === pkg.version, 'npm version identity mismatch');
    requireState(isSha(npm.gitHead) || manual, 'npm release commit is missing or invalid; manual reconciliation required');
    requireState(typeof npm.dist?.integrity === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(npm.dist.integrity), 'npm artifact integrity is missing or invalid');
    if (manual) requireState(npm.dist.integrity === reconciledIntegrity, 'Reconciled npm integrity does not match the published artifact');
    requireState(latest?.version === pkg.version, 'npm latest and exact version disagree; wait for propagation, then reconcile dist-tags if persistent', true);
  } else requireState(latest?.version !== pkg.version, 'npm latest exists but exact version is absent; wait for propagation', true);
  const target = npm ? (manual ? reconciledCommit : npm.gitHead) : sha;
  if (tagSha !== null) requireState(isSha(tagSha) && tagSha === target, 'Existing release tag points to a different commit');
  if (release) {
    requireState(release.tag_name === `v${pkg.version}` && release.draft === false && release.prerelease === false &&
      typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'GitHub release is incomplete or mismatched');
    requireState(tagSha === target, 'Published GitHub release has no matching tag');
  }
  if (registry) {
    validateManifest(registry.server, pkg);
    requireState(registry._meta?.[officialKey]?.status === 'active', 'Registry entry is not active; manual reconciliation required');
  }
  return { version: pkg.version, target, npm: npm === null, registry: registry === null, github: release === null };
}

export async function inspectRelease(pkg, sha, { token, lookup = lookupJson, reconciledCommit, reconciledIntegrity } = {}) {
  const npmBase = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
  const api = `https://api.github.com/repos/${repository}`;
  const ghOptions = { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'substack-mcp-release-check', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } };
  const latest = await lookup(`${npmBase}/latest`);
  const npm = await lookup(`${npmBase}/${encodeURIComponent(pkg.version)}`);
  const registry = await lookup(`https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(pkg.mcpName)}/versions/${encodeURIComponent(pkg.version)}?include_deleted=true`);
  const release = await lookup(`${api}/releases/tags/${encodeURIComponent(`v${pkg.version}`)}`, ghOptions);
  const tag = await lookup(`${api}/git/ref/tags/${encodeURIComponent(`v${pkg.version}`)}`, ghOptions);
  let tagSha = null;
  if (tag) {
    requireState(tag.ref === `refs/tags/v${pkg.version}`, 'GitHub tag identity mismatch');
    let object = tag.object, depth = 0;
    while (object?.type === 'tag') {
      requireState(isSha(object.sha) && depth++ < 5, 'Invalid or deeply nested annotated release tag');
      const annotated = await lookup(`${api}/git/tags/${object.sha}`, ghOptions);
      requireState(annotated?.sha === object.sha, 'Annotated release tag is absent or mismatched');
      object = annotated.object;
    }
    requireState(object?.type === 'commit' && isSha(object.sha), 'Release tag does not resolve to a commit');
    tagSha = object.sha;
  }
  return decideRelease(pkg, sha, { latest, npm, registry, release, tagSha }, { reconciledCommit, reconciledIntegrity });
}

export function releaseManifest(pkg, target, head, git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  // The package's recorded commit must exist in this checkout's history. Never
  // attach an old npm version to the current development HEAD during recovery.
  try { git(['merge-base', '--is-ancestor', target, head]); }
  catch { throw new ReleaseStateError('Release commit is not in checkout history. Fetch full history and reconcile the npm commit before retrying.'); }
  const sourcePackage = JSON.parse(git(['show', `${target}:package.json`]));
  requireState(sourcePackage.name === pkg.name && sourcePackage.version === pkg.version && sourcePackage.mcpName === pkg.mcpName, 'Release commit package identity mismatch');
  const manifest = JSON.parse(git(['show', `${target}:server.json`]));
  validateManifest(manifest, pkg);
  return manifest;
}

export function verifyStage(plan, command, expectedTarget) {
  requireState(['plan', 'verify-npm', 'verify-registry', 'verify'].includes(command), 'Unknown release-state command');
  if (expectedTarget) requireState(plan.target === expectedTarget, 'Release target changed during publication');
  if (command !== 'plan') requireState(!plan.npm, 'npm publication is not yet verified; wait and rerun', true);
  if (['verify-registry', 'verify'].includes(command)) requireState(!plan.registry, 'MCP Registry publication is not yet verified; wait and rerun', true);
  if (command === 'verify') requireState(!plan.github, 'GitHub release is not yet verified; wait and rerun', true);
}

export async function verifyWithPolling(inspect, command, expectedTarget, sleep = delay) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plan = await inspect();
      verifyStage(plan, command, expectedTarget);
      return plan;
    } catch (error) {
      if (command === 'plan' || !(error instanceof ReleaseStateError) || !error.retryable || attempt === 2) throw error;
      await sleep(attempt === 0 ? 1000 : 3000);
    }
  }
}

export async function main(command = 'plan') {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (process.env.GITHUB_SHA) requireState(process.env.GITHUB_SHA === sha, 'Checkout and workflow commit disagree');
  if (process.env.GITHUB_REPOSITORY) requireState(process.env.GITHUB_REPOSITORY === repository, 'Unexpected workflow repository');
  const plan = await verifyWithPolling(() => inspectRelease(pkg, sha, {
    token: process.env.GH_TOKEN,
    reconciledCommit: process.env.RECONCILED_RELEASE_COMMIT,
    reconciledIntegrity: process.env.RECONCILED_NPM_INTEGRITY,
  }), command, process.env.RELEASE_TARGET);
  const manifest = releaseManifest(pkg, plan.target, sha);
  if (process.env.RELEASE_MANIFEST) writeFileSync(process.env.RELEASE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(releaseErrorMessage(error)); process.exitCode = 1; });
}
