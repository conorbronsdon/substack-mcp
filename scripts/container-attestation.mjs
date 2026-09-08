// Builds only validated attestation references. It does not contact GitHub or a registry.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SPDX_PREDICATE_TYPE = 'https://spdx.dev/Document/v2.3';
const expectedImage = 'ghcr.io/conorbronsdon/substack-mcp';
const expectedRepository = 'conorbronsdon/substack-mcp';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;

export function prepareContainerAttestation({ image, digest, revision, workflowRevision, repository, generate }) {
  assert.equal(image, expectedImage, 'Refusing to attest an unexpected container image');
  assert.equal(repository, expectedRepository, 'Refusing to attest from an unexpected source repository');
  assert.match(digest ?? '', digestPattern, 'Expected a SHA-256 image manifest digest');
  assert.match(revision ?? '', revisionPattern, 'Expected the verified release source commit');
  assert.match(workflowRevision ?? '', revisionPattern, 'Expected the workflow source commit');
  assert.ok(typeof generate === 'boolean', 'Expected an explicit attestation generation decision');
  if (generate) assert.equal(workflowRevision, revision, 'Refusing to mint provenance from a workflow commit other than the verified release source');

  const wrongSourceDigest = `${revision.slice(0, -1)}${revision.endsWith('0') ? '1' : '0'}`;
  return {
    subject_name: image,
    manifest_digest: digest,
    image_ref: `${image}@${digest}`,
    subject_ref: `oci://${image}@${digest}`,
    source_digest: revision,
    wrong_source_digest: wrongSourceDigest,
    signer_workflow: `${repository}/.github/workflows/publish.yml`,
    wrong_signer_workflow: `${repository}/.github/workflows/container.yml`,
    generate,
    spdx_predicate_type: SPDX_PREDICATE_TYPE,
  };
}

export function tamperAttestationBundle(contents) {
  const lines = contents.split(/\r?\n/).filter(line => line.trim());
  assert.ok(lines.length > 0, 'Expected at least one Sigstore bundle');
  return `${lines.map(line => {
    const bundle = JSON.parse(line);
    assert.equal(typeof bundle.dsseEnvelope?.payload, 'string', 'Expected a DSSE payload in each Sigstore bundle');
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    assert.equal(typeof statement.predicate, 'object', 'Expected an in-toto predicate in each Sigstore bundle');
    statement.predicate = { ...statement.predicate, _signature_tamper_control: true };
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
    return JSON.stringify(bundle);
  }).join('\n')}\n`;
}

export function githubOutputs(result) {
  return [
    `subject-name=${result.subject_name}`,
    `manifest-digest=${result.manifest_digest}`,
    `image-ref=${result.image_ref}`,
    `subject-ref=${result.subject_ref}`,
    `source-digest=${result.source_digest}`,
    `wrong-source-digest=${result.wrong_source_digest}`,
    `signer-workflow=${result.signer_workflow}`,
    `wrong-signer-workflow=${result.wrong_signer_workflow}`,
    `generate=${result.generate}`,
    `spdx-predicate-type=${result.spdx_predicate_type}`,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'tamper-bundle') {
    try {
      const [, , , source, destination] = process.argv;
      if (!source || !destination) throw new Error('Source and destination bundle paths are required');
      writeFileSync(destination, tamperAttestationBundle(readFileSync(source, 'utf8')), { flag: 'wx' });
    } catch {
      console.error('Could not create the signature-tampering control bundle.');
      process.exitCode = 1;
    }
  } else {
    const {
      IMAGE: image,
      MANIFEST_DIGEST: digest,
      RELEASE_TARGET: revision,
      GITHUB_SHA: workflowRevision,
      GITHUB_REPOSITORY: repository,
      GENERATE_ATTESTATIONS,
      GITHUB_OUTPUT,
    } = process.env;
    try {
      const result = prepareContainerAttestation({
        image,
        digest,
        revision,
        workflowRevision,
        repository,
        generate: GENERATE_ATTESTATIONS === 'true',
      });
      if (!GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required in the release workflow');
      appendFileSync(GITHUB_OUTPUT, githubOutputs(result));
      console.log(JSON.stringify({ subject: result.subject_ref, source: revision }));
    } catch (error) {
      console.error(error instanceof assert.AssertionError ? error.message : 'Could not prepare container attestation inputs.');
      process.exitCode = 1;
    }
  }
}
