import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubOutputs as attestationOutputs, prepareContainerAttestation, SPDX_PREDICATE_TYPE, tamperAttestationBundle } from './container-attestation.mjs';
import { githubOutputs, publishContainer } from './publish-container.mjs';
import pkg from '../package.json' with { type: 'json' };
const input = { version: pkg.version, revision: 'a'.repeat(40), run: '1', attempt: '1', temp: '/temporary' };
const image = 'ghcr.io/conorbronsdon/substack-mcp';
function fixture(mode) {
  const calls = []; let verified = 0, versionLookups = 0;
  const manifest = { config: { digest: 'sha256:' + 'b'.repeat(64) } };
  const differentManifest = { config: { digest: 'sha256:' + 'c'.repeat(64) } };
  const registryDigest = 'sha256:' + 'e'.repeat(64);
  const differentRegistryDigest = 'sha256:' + 'd'.repeat(64);
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
    'anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26',
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
