import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubOutputs as attestationOutputs, prepareContainerAttestation, SPDX_PREDICATE_TYPE, tamperAttestationBundle } from './container-attestation.mjs';
import { describeFailure, githubOutputs, publishContainer } from './publish-container.mjs';
import pkg from '../package.json' with { type: 'json' };
import ts from 'typescript';
const input = { version: pkg.version, revision: 'a'.repeat(40), run: '1', attempt: '1', temp: '/temporary' };
const image = 'ghcr.io/conorbronsdon/substack-mcp';
function fixture(mode) {
  const calls = []; let verified = 0, versionLookups = 0;
  const manifest = { config: { digest: 'sha256:' + 'b'.repeat(64) } };
  const differentManifest = { config: { digest: 'sha256:' + 'c'.repeat(64) } };
  const registryDigest = 'sha256:' + 'e'.repeat(64);
  const differentRegistryDigest = 'sha256:' + 'd'.repeat(64);
  // What `docker manifest inspect` returns once BuildKit attaches its own attestation manifest.
  const imageIndex = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: registryDigest, platform: { architecture: 'amd64', os: 'linux' } },
    { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + '9'.repeat(64), platform: { architecture: 'unknown', os: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } },
  ] };
  const usesExistingRelease = ref => mode === 'existing_different' && (ref === `${image}:${pkg.version}` || ref === `${image}:latest` || ref.startsWith(`${image}:sha-`));
  const docker = (...args) => {
    calls.push(args);
    if (args[0] === '--config') {
      if (mode === 'private') throw new Error('unauthorized');
      return JSON.stringify(usesExistingRelease(args[4]) ? differentManifest : manifest);
    }
    if (args[0] === 'image') return JSON.stringify([{
      Id: (mode === 'race' && args[2] === `${image}:${pkg.version}`) || (mode === 'candidate_race' && args[2].includes(':build-')) ? 'sha256:' + 'd'.repeat(64) : mode === 'existing_different' && args[2] === `${image}:${pkg.version}` ? differentManifest.config.digest : manifest.config.digest,
      Config: { Labels: { 'org.opencontainers.image.version': pkg.version, 'org.opencontainers.image.revision': mode === 'mismatch' ? 'c'.repeat(40) : input.revision } },
    }]);
    if (args[0] === 'manifest') {
      if (args[2] === '--verbose') {
        const ref = args[3];
        if (mode === 'missing_digest') return JSON.stringify({ Descriptor: {} });
        if (mode === 'conflicting_digests') return JSON.stringify({ Descriptor: { digest: registryDigest }, Digest: 'sha256:' + 'f'.repeat(64) });
        if (mode === 'manifest_list') return JSON.stringify([{ Descriptor: { digest: registryDigest } }]);
        return JSON.stringify({ Descriptor: { digest: usesExistingRelease(ref) ? differentRegistryDigest : registryDigest } });
      }
      if (mode === 'image_index') return JSON.stringify(imageIndex);
      if (args[2] === `${image}:${pkg.version}` && ++versionLookups === 1 && ['absent', 'unknown'].includes(mode)) throw Object.assign(new Error('lookup failed'), { stderr: mode === 'absent' ? 'manifest unknown' : 'unauthorized' });
      return JSON.stringify(usesExistingRelease(args[2]) ? differentManifest : manifest);
    }
    return '';
  };
  return { calls, run: () => publishContainer(input, { docker, verifyImage: () => { verified++; }, makeDirectory: () => {} }), verified: () => verified };
}
test('new version publishes after an explicit missing-manifest response', () => {
  const f = fixture('absent'); const result = f.run(); assert.equal(result.public, true);
  assert.equal(result.manifest_digest, 'sha256:' + 'e'.repeat(64));
  assert.equal(result.subject_name, image); assert.equal(result.provenance_eligible, true); assert.equal(f.verified(), 1);
  assert.ok(f.calls.some(args => args[0] === 'push' && args[1] === `${image}:${pkg.version}`));
});
test('existing matching version is tested and preserved on recovery', () => {
  const f = fixture('existing'); assert.equal(f.run().public, true); assert.equal(f.verified(), 1);
  assert.ok(!f.calls.some(args => args[0] === 'push' && args[1] === `${image}:${pkg.version}`));
});
test('a preserved existing image with different bytes cannot receive new provenance', () => {
  const f = fixture('existing_different'); const result = f.run();
  assert.equal(result.manifest_digest, 'sha256:' + 'd'.repeat(64));
  assert.equal(result.candidate_digest, 'sha256:' + 'e'.repeat(64));
  assert.equal(result.provenance_eligible, false);
  assert.ok(!f.calls.some(args => args[0] === 'push' && args[1] === `${image}:${pkg.version}`));
});
for (const mode of ['unknown', 'mismatch', 'race', 'candidate_race']) test(`${mode} identity never moves release aliases`, () => {
  const f = fixture(mode); assert.throws(f.run);
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
});
for (const mode of ['missing_digest', 'conflicting_digests', 'manifest_list']) test(`${mode} stops before release aliases move`, () => {
  const f = fixture(mode); assert.throws(f.run, /manifest descriptor digest/);
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
});
test('an image index candidate stops before release aliases move and names the failed check', () => {
  const f = fixture('image_index'); let failure;
  assert.throws(f.run, error => { failure = error; return /single-platform image manifest/.test(error.message); });
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
  assert.ok(!f.calls.some(args => args[0] === 'push' && args[1] !== `${image}:build-1-1`), 'Only the candidate may be pushed');
  assert.equal(describeFailure(failure), 'Container identity mismatch; publication stopped: Expected a single-platform image manifest');
});
test('failure output names only fixed messages', () => {
  const generic = 'Container publication failed unexpectedly; inspect the release stage and reconcile before retrying.';
  let generated;
  try { assert.deepEqual({ config: { digest: 'sha256:' + 'b'.repeat(64) } }, { config: { digest: 'sha256:' + 'c'.repeat(64) } }); } catch (error) { generated = error; }
  assert.equal(generated.generatedMessage, true);
  assert.equal(describeFailure(generated), 'Container identity mismatch; publication stopped.');
  assert.equal(describeFailure(new Error('Command failed: docker push secret-bearing-args')), 'Container command failed; inspect the release stage and reconcile before retrying.');
  // JSON.parse quotes the start of its input, which here would be a registry or daemon body.
  let parse;
  try { JSON.parse('registry-body-fragment'); } catch (error) { parse = error; }
  assert.ok(parse.message.includes('registry'), 'Expected the parser message to quote its input');
  for (const error of [parse, new TypeError('Cannot read properties of undefined (reading body)'), new Error('unlisted message'), 'thrown string', undefined]) {
    assert.equal(describeFailure(error), generic);
  }
  // The publisher's own fixed stop messages are still named.
  let stop;
  assert.throws(fixture('private').run, error => { stop = error; return true; });
  assert.equal(describeFailure(stop), `Anonymous access failed for ${image}:build-1-1. Verify the GHCR package is public, then rerun Publish; inspect existing tags before retrying.`);
  let unknown;
  assert.throws(fixture('unknown').run, error => { unknown = error; return true; });
  assert.equal(describeFailure(unknown), 'Cannot determine existing container release; stop without moving version tags.');
});

// The message argument position for each assert method the publisher may use.
const messageArgument = { ok: 1, equal: 2, notEqual: 2, strictEqual: 2, notStrictEqual: 2, deepEqual: 2, notDeepEqual: 2, deepStrictEqual: 2, notDeepStrictEqual: 2, match: 2, doesNotMatch: 2, throws: 2, doesNotThrow: 2, rejects: 2, doesNotReject: 2, fail: 0 };
// For these, a string literal second argument is the message (no error validator given).
const optionalValidator = new Set(['throws', 'doesNotThrow', 'rejects', 'doesNotReject']);
// Names that may be interpolated into a printed message: image references built from the
// fixed image name and validated tags. Nothing here can hold a registry or daemon body.
const printableNames = new Set(['ref', 'alias']);
function isFixedMessage(node) {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  return ts.isTemplateExpression(node) && node.templateSpans.every(span => ts.isIdentifier(span.expression) && printableNames.has(span.expression.text));
}
// Every printed message source in the publisher: assertions and PublicationStop.
function assertionsWithoutMessages(source) {
  const file = ts.createSourceFile('publisher.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const missing = []; let count = 0;
  const visit = node => {
    let message, checked = false;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = ts.isIdentifier(callee) && callee.text === 'assert' ? 'ok'
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'assert' ? callee.name.text : undefined;
      if (method) {
        checked = true;
        const second = node.arguments[1];
        const at = optionalValidator.has(method) && second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second) || ts.isTemplateExpression(second)) ? 1 : messageArgument[method];
        message = at === undefined ? undefined : node.arguments[at];
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'PublicationStop') {
      checked = true;
      message = node.arguments?.[0];
    }
    if (checked) {
      count++;
      if (!isFixedMessage(message)) missing.push(node.getText(file).replace(/\s+/g, ' '));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { count, missing };
}
test('every publisher assertion carries a fixed message', () => {
  const { count, missing } = assertionsWithoutMessages(readFileSync('scripts/publish-container.mjs', 'utf8'));
  assert.ok(count >= 20, `Expected the publisher's assertions to be found, saw ${count}`);
  assert.deepEqual(missing, [], 'Every assertion and stop needs a fixed message so a failure names the check without echoing data');
  // The check sees two calls on one line, calls split across lines, bare assert(), unlisted methods,
  // string messages to throws(), and rejects interpolations other than allowlisted reference names.
  const probe = assertionsWithoutMessages([
    "assert.equal(a, b, 'fixed'); assert.ok(c);",
    'assert.deepEqual(',
    '  a,',
    '  b',
    ');',
    'assert.strictEqual(a, b, `fixed ${ref}`);',
    'assert(c);',
    "assert.ifError(c, 'unlisted');",
    "assert.throws(fn, 'fixed');",
    "assert.throws(fn, /pattern/, 'fixed');",
    'assert.throws(fn, /pattern/);',
    'assert.equal(a, b, `Manifest ${body} differs`);',
    'assert.equal(a, b, `Alias ${alias.body} differs`);',
    'throw new PublicationStop(`Anonymous access failed for ${alias}`);',
    'throw new PublicationStop(`Lookup failed: ${error.stderr}`);',
  ].join('\n'));
  assert.equal(probe.count, 13);
  assert.deepEqual(probe.missing, [
    'assert.ok(c)', 'assert.deepEqual( a, b )', 'assert(c)', "assert.ifError(c, 'unlisted')", 'assert.throws(fn, /pattern/)',
    'assert.equal(a, b, `Manifest ${body} differs`)', 'assert.equal(a, b, `Alias ${alias.body} differs`)', 'new PublicationStop(`Lookup failed: ${error.stderr}`)',
  ]);
});

// Every shell command a workflow runs, with backslash continuations joined.
function workflowCommands(path) {
  const lines = readFileSync(path, 'utf8').replaceAll('\r\n', '\n').split('\n');
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^(\s*)(?:- )?run: \|\s*$/);
    const single = lines[i].match(/^\s*(?:- )?run: (.+)$/);
    if (block) {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > block[1].length)) body.push(lines[++i]);
      scripts.push(body.join('\n'));
    } else if (single) scripts.push(single[1]);
  }
  return scripts.join('\n').replace(/\\\n\s*/g, ' ').split('\n').map(line => line.trim()).filter(Boolean);
}
test('release and pull-request builds produce a single image manifest, without in-image attestations', () => {
  for (const path of ['.github/workflows/publish.yml', '.github/workflows/container.yml']) {
    const commands = workflowCommands(path);
    // Count builds, not lines: two builds chained on one line must not hide an unflagged one.
    const occurrences = commands.join('\n').match(/\bdocker (?:buildx )?build\b/g) ?? [];
    assert.equal(occurrences.length, 1, `Expected exactly one docker build in ${path}`);
    const builds = commands.filter(command => /\bdocker (?:buildx )?build\b/.test(command));
    // BuildKit's default provenance turns the pushed tag into an OCI index on the containerd image
    // store, which the publisher rejects. The attest job signs provenance instead.
    assert.match(builds[0], / --provenance=false(?: |$)/, `docker build must disable in-image provenance: ${path}`);
    assert.match(builds[0], / --sbom=false(?: |$)/, `docker build must disable in-image SBOM: ${path}`);
  }
});

function containerJob(path) {
  const workflow = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const job = workflow.split('\n  container:\n')[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(job, 'Expected a container job in ' + path);
  return job;
}
function stepScript(job, name) {
  const step = job.split('\n      - name: ' + name + '\n')[1]?.split('\n      - ')[0];
  assert.ok(step, 'Expected step ' + name);
  return step.split('        run: |\n')[1].replace(/^          /gm, '');
}
const buildSteps = [['.github/workflows/publish.yml', 'Verify original source and build'], ['.github/workflows/container.yml', 'Build versioned image']];
test('container builds run on the classic image store runner behind a guard', () => {
  for (const [path, name] of buildSteps) {
    const job = containerJob(path);
    // ubuntu-latest became ubuntu-26.04, whose containerd image store breaks the publisher's identity checks.
    assert.match(job, /^    runs-on: ubuntu-24\.04$/m, 'Container jobs must stay on the classic-store runner: ' + path);
    const script = stepScript(job, name);
    const guard = script.indexOf("docker info --format '{{.Driver}}'");
    assert.ok(guard >= 0 && guard < script.indexOf('docker build '), 'The image-store guard must run before the build: ' + path);
  }
});
// Execute each guard as the runner does (bash -e) with a synthetic docker. Only the
// classic overlay2 store may pass; anything else, including a docker error, must stop.
for (const [path, name] of buildSteps) {
  for (const [scenario, status] of [['classic', 0], ['containerd', 1], ['unknown-driver', 1], ['docker-error', 1]]) {
    test(`${path} image-store guard: ${scenario}`, { skip: process.platform === 'win32' }, () => {
      const script = stepScript(containerJob(path), name).split('\n');
      const guard = script.slice(script.findIndex(line => line.includes('docker info')), script.findIndex(line => line.startsWith('docker build '))).join('\n');
      const mock = `
        docker() {
          [ "$SCENARIO" = docker-error ] && return 1
          case "$*" in
            *DriverStatus*) case "$SCENARIO" in classic) echo '[["Backing Filesystem","extfs"]]' ;; containerd) echo '[["driver-type","io.containerd.snapshotter.v1"]]' ;; *) echo '[]' ;; esac ;;
            *Driver*) case "$SCENARIO" in classic) echo overlay2 ;; containerd) echo overlayfs ;; *) echo vfs ;; esac ;;
          esac
        }
      `;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', mock + guard + '\necho guard-passed'], { encoding: 'utf8', env: { ...process.env, SCENARIO: scenario } });
      assert.ifError(result.error);
      assert.equal(result.status === 0 ? 0 : 1, status, `${scenario}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout.includes('guard-passed'), status === 0);
      // Every refusal, including a failed docker info, must explain itself in the job log.
      if (status !== 0) assert.match(result.stdout, /::error::/, `${scenario} must print an ::error:: annotation`);
    });
  }
}
// The loopback publisher check must stop when the registry never answers, and must use IPv4 loopback.
for (const scenario of ['ready', 'never-ready']) {
  test(`loopback registry step handles ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const script = stepScript(containerJob('.github/workflows/container.yml'), 'Exercise the release publisher against a loopback registry');
    const directory = mkdtempSync(join(tmpdir(), 'loopback-control-'));
    const calls = join(directory, 'calls');
    try {
      const mock = `
        docker() { return 0; }
        sleep() { return 0; }
        curl() { printf 'curl %s\\n' "$*" >> "$CALLS"; [ "$SCENARIO" = ready ]; }
        node() { printf 'node %s\\n' "$*" >> "$CALLS"; }
      `;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', mock + script], { encoding: 'utf8', env: { ...process.env, SCENARIO: scenario, CALLS: calls } });
      assert.ifError(result.error);
      const invocations = readFileSync(calls, 'utf8').trim().split('\n');
      const publisher = invocations.filter(call => call.startsWith('node scripts/publish-container.local-registry.mjs'));
      if (scenario === 'ready') {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(invocations[0].includes('http://127.0.0.1:5000/v2/'), invocations[0]);
        // Each probe needs its own deadline, or one hung connection outlasts the 30-attempt bound.
        assert.match(invocations[0], /--max-time [1-5](?: |$)/, 'Each readiness probe needs a short --max-time');
        assert.equal(publisher.length, 1);
        assert.ok(publisher[0].endsWith(' 127.0.0.1:5000'), publisher[0]);
      } else {
        assert.notEqual(result.status, 0, 'An unready registry must fail the step');
        assert.equal(publisher.length, 0, 'The publisher must not run against an unready registry');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
test('private package cannot report a successful public release', () => {
  const f = fixture('private'); assert.throws(f.run, /Anonymous access failed/);
  assert.ok(!f.calls.some(args => args[0] === 'tag' && /:(latest|sha-|[0-9]+\.)/.test(args[2])));
});
test('workflow outputs expose immutable registry digests and provenance eligibility', () => {
  const result = fixture('absent').run();
  assert.equal(githubOutputs(result), `image=${image}:${pkg.version}\nsubject-name=${image}\nmanifest-digest=sha256:${'e'.repeat(64)}\ncandidate-digest=sha256:${'e'.repeat(64)}\nprovenance-eligible=true\n`);
  assert.ok(!githubOutputs(result).includes(manifestConfigDigest()));
});
function manifestConfigDigest() { return 'sha256:' + 'b'.repeat(64); }

test('attestation subject is the immutable manifest digest from the verified source', () => {
  const digest = 'sha256:' + 'e'.repeat(64);
  const result = prepareContainerAttestation({
    image, digest, revision: input.revision, workflowRevision: input.revision,
    repository: 'conorbronsdon/substack-mcp', generate: true,
  });
  assert.equal(result.subject_ref, `oci://${image}@${digest}`);
  assert.equal(result.image_ref, `${image}@${digest}`);
  assert.equal(result.spdx_predicate_type, SPDX_PREDICATE_TYPE);
  assert.equal(result.source_digest, input.revision);
  assert.notEqual(result.wrong_source_digest, result.source_digest);
  assert.equal(result.signer_workflow, 'conorbronsdon/substack-mcp/.github/workflows/publish.yml');
  assert.equal(result.wrong_signer_workflow, 'conorbronsdon/substack-mcp/.github/workflows/container.yml');
  assert.match(attestationOutputs(result), new RegExp(`manifest-digest=${digest}`));
});

test('attestation generation rejects a different workflow source commit', () => {
  assert.throws(() => prepareContainerAttestation({
    image, digest: 'sha256:' + 'e'.repeat(64), revision: input.revision,
    workflowRevision: 'f'.repeat(40), repository: 'conorbronsdon/substack-mcp', generate: true,
  }), /workflow commit other than the verified release source/);
});

test('attestation preparation rejects malformed digests and unexpected identities', () => {
  const valid = { image, digest: 'sha256:' + 'e'.repeat(64), revision: input.revision, workflowRevision: input.revision, repository: 'conorbronsdon/substack-mcp', generate: true };
  assert.throws(() => prepareContainerAttestation({ ...valid, digest: manifestConfigDigest().slice(0, -1) }), /manifest digest/);
  assert.throws(() => prepareContainerAttestation({ ...valid, image: 'ghcr.io/attacker/image' }), /unexpected container image/);
  assert.throws(() => prepareContainerAttestation({ ...valid, repository: 'attacker/repository' }), /unexpected source repository/);
});

test('historical recovery may verify existing attestations but cannot mint new provenance', () => {
  const result = prepareContainerAttestation({
    image, digest: 'sha256:' + 'e'.repeat(64), revision: input.revision,
    workflowRevision: 'f'.repeat(40), repository: 'conorbronsdon/substack-mcp', generate: false,
  });
  assert.equal(result.subject_ref, `oci://${image}@sha256:${'e'.repeat(64)}`);
  assert.equal(result.generate, false);
});

test('signature tamper control changes signed DSSE payload but preserves its signature', () => {
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicate: { buildDefinition: {} } };
  const bundle = { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64'), payloadType: 'application/vnd.in-toto+json', signatures: [{ sig: 'signed-value' }] } };
  const tampered = JSON.parse(tamperAttestationBundle(`${JSON.stringify(bundle)}\n`).trim());
  const tamperedStatement = JSON.parse(Buffer.from(tampered.dsseEnvelope.payload, 'base64').toString('utf8'));
  assert.equal(tamperedStatement.predicate._signature_tamper_control, true);
  assert.notEqual(tampered.dsseEnvelope.payload, bundle.dsseEnvelope.payload);
  assert.deepEqual(tampered.dsseEnvelope.signatures, bundle.dsseEnvelope.signatures);
});

test('publish workflow pins generation and verification to digest, source and signer', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8').replaceAll('\r\n', '\n');
  for (const required of [
    'anchore/sbom-action@66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c',
    'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6',
    "needs.container.outputs.provenance_eligible == 'true'",
    '--bundle-from-oci', '--source-digest "$SOURCE_DIGEST"', '--signer-workflow "$SIGNER_WORKFLOW"',
    'artifact-metadata: write',
  ]) assert.ok(workflow.includes(required), `Missing release attestation control: ${required}`);
  const downloadedBundleVerification = workflow.indexOf('gh attestation verify "$SUBJECT_REF" --bundle "$provenance_bundle"');
  const bundleTamper = workflow.indexOf('tamper-bundle "$provenance_bundle"');
  assert.ok(downloadedBundleVerification > 0 && bundleTamper > downloadedBundleVerification, 'The real bundle must pass before the tampered copy is rejected');
  for (const identity of ['--source-digest "$WRONG_SOURCE_DIGEST"', '--signer-workflow "$WRONG_SIGNER_WORKFLOW"']) {
    assert.ok(workflow.split('\n').some(line => line.includes('--bundle "$provenance_bundle"') && line.includes(identity)), 'Generation must test the known verified bundle against each wrong identity');
  }
});

test('attestation actions share isolated registry credentials without changing other steps HOME', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8').replaceAll('\r\n', '\n');
  const job = workflow.split('\n  attest:\n')[1]?.split(/\n  [\w-]+:\n/)[0];
  assert.ok(job, 'Expected the attest job');
  // Include unnamed uses steps as well as named steps.
  const steps = job.split('\n      - ').slice(1);
  const isolation = steps.find(step => step.startsWith('name: Isolate registry authentication in the runner temporary directory\n'));
  assert.ok(isolation, 'Expected isolated registry authentication');
  const config = isolation.match(/printf 'DOCKER_CONFIG=%s([^']+)\\n' "(\$RUNNER_TEMP)" >> "\$GITHUB_ENV"/);
  assert.ok(config, 'Isolation must write DOCKER_CONFIG under $RUNNER_TEMP to GITHUB_ENV');
  const normalizeTemp = value => value.replace(/\$\{\{\s*runner\.temp\s*\}\}|\$RUNNER_TEMP/g, '<runner-temp>');
  const dockerConfig = normalizeTemp(config[2] + config[1]);
  assert.match(dockerConfig, /^<runner-temp>\/(?:[\w-]+\/)+\.docker$/, 'DOCKER_CONFIG must be an isolated directory ending in /.docker under $RUNNER_TEMP');
  const expectedHome = dockerConfig.slice(0, -'/.docker'.length);
  const attestSteps = steps.filter(step => /^(?:uses:|        uses:) actions\/attest@/m.test(step));
  assert.ok(attestSteps.length > 0, 'Expected actions/attest steps');
  let outsideAttestSteps = workflow;
  for (const step of attestSteps) {
    const env = step.match(/^        env:\n((?:          [^\n]*\n)*)/m)?.[1];
    const home = env?.match(/^          HOME: (.+)$/m)?.[1];
    assert.ok(home, `${step.split('\n')[0]} must set HOME in its own env`);
    assert.equal(normalizeTemp(home.trim()), expectedHome, 'Attestation HOME must be the parent of DOCKER_CONFIG');
    outsideAttestSteps = outsideAttestSteps.replace(step, '');
  }
  assert.doesNotMatch(outsideAttestSteps, /\bHOME\s*[:=]/, 'Only actions/attest steps may set HOME, including workflow/job env and GITHUB_ENV writes');
});

test('attestation verification is gated so a recovery run can never be permanently stuck', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8').replaceAll('\r\n', '\n');
  const steps = new Map(workflow.split('\n      - name: ').slice(1).map(block => [block.split('\n')[0], block]));
  const minting = steps.get('Verify provenance, SBOM and rejection controls');
  const recovery = steps.get('Verify preserved attestations without minting provenance');
  assert.ok(minting && recovery, 'Expected separate minting and recovery verification steps');
  // Only the run that minted attestations may require them; a recovery run
  // rebuilds a different image and can never produce them for this digest.
  assert.match(minting, /^\s+if: steps\.subject\.outputs\.generate == 'true'$/m);
  assert.match(recovery, /^\s+if: steps\.subject\.outputs\.generate != 'true'$/m);
  assert.ok(minting.includes('tamper-bundle'), 'The tamper control belongs to the minting run');
  assert.ok(!recovery.includes('tamper-bundle'));
  // Absent attestations are reported, but a wrong identity is never accepted.
  assert.ok(recovery.includes('::warning::No verifiable $predicate attestation'));
  for (const control of ['$WRONG_SOURCE_DIGEST', '$WRONG_SIGNER_WORKFLOW']) {
    assert.ok(minting.includes(control) && recovery.includes(control), `Both runs must reject ${control}`);
  }
});

// Execute the actual recovery shell with synthetic gh results. Production runs
// on Ubuntu; no registry access or credentials are involved in these controls.
for (const scenario of ['valid', 'missing-provenance', 'missing-sbom', 'unavailable', 'wrong-source', 'wrong-signer']) {
  test(`recovery shell handles ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const workflow = readFileSync('.github/workflows/publish.yml', 'utf8').replaceAll('\r\n', '\n');
    const block = workflow.split('      - name: Verify preserved attestations without minting provenance\n')[1].split('      - name: ')[0];
    const shell = block.split('        run: |\n')[1].replace(/^          /gm, '');
    const directory = mkdtempSync(join(tmpdir(), 'attestation-control-'));
    const summary = join(directory, 'summary');
    const calls = join(directory, 'calls');
    try {
      const mock = `
        gh() {
          printf '%s\\n' "$*" >> "$CALLS"
          case "$SCENARIO:$*" in
            unavailable:*) return 1 ;;
            missing-provenance:*https://slsa.dev/provenance/v1*) return 1 ;;
            missing-sbom:*https://spdx.dev/Document/v2.3*) return 1 ;;
          esac
          case "$*" in
            *wrong-source*) [ "$SCENARIO" = wrong-source ]; return $? ;;
            *wrong-signer*) [ "$SCENARIO" = wrong-signer ]; return $? ;;
          esac
          return 0
        }
      `;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', mock + shell], {
        encoding: 'utf8',
        env: { ...process.env, SCENARIO: scenario, CALLS: calls, GITHUB_STEP_SUMMARY: summary,
          SUBJECT_REF: 'oci://example-image@sha256:example-digest', GITHUB_REPOSITORY: 'example/repository',
          SOURCE_DIGEST: 'example-source', WRONG_SOURCE_DIGEST: 'wrong-source',
          SIGNER_WORKFLOW: 'example-signer', WRONG_SIGNER_WORKFLOW: 'wrong-signer',
          SPDX_PREDICATE_TYPE: SPDX_PREDICATE_TYPE },
      });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.startsWith('wrong-') ? 1 : 0, result.stderr);
      const invocations = readFileSync(calls, 'utf8').trim().split('\n');
      if (!scenario.startsWith('wrong-')) {
        assert.ok(invocations.some(call => call.includes(SPDX_PREDICATE_TYPE)), 'SBOM must be checked even without provenance');
        assert.equal(invocations.length, scenario === 'valid' ? 6 : scenario === 'unavailable' ? 2 : 4);
      }
      if (scenario.startsWith('missing-') || scenario === 'unavailable') {
        assert.match(result.stdout, /::warning::/);
        assert.match(readFileSync(summary, 'utf8'), /Attestation UNVERIFIED/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
