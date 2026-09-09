# Container distribution

Starting with 1.0, GHCR releases use `ghcr.io/conorbronsdon/substack-mcp:<version>`
and a `sha-<full-source-commit>` alias. `latest` follows the verified current
release. The initial published image supports Linux amd64; the pinned base image
being multi-platform does not establish support for other server architectures.
Inspect the GHCR package and release job before assuming a version is available.
Docker Hub is a separate distribution follow-up; no Docker Hub image is advertised.

The image runs as the non-root `node` user. Source, version, revision and license
are recorded in OCI labels. Release CI builds the original verified npm release
commit, checks those labels and exercises stdio and authenticated HTTP using
synthetic configuration. These checks do not validate a user's Substack session.
Version recovery preserves an existing image only when its source/version match
and its transport checks pass. Unknown registry lookup failures stop publication.
For immutable deployment selection, use the registry's image manifest digest.

## Run

Provide `SUBSTACK_PUBLICATION_URL`, `SUBSTACK_SESSION_TOKEN` and
`SUBSTACK_USER_ID` in a private environment file outside the repository. Use
restrictive file permissions and never commit the file. Named environment
publications are supported too. All credentials must be well-formed before the
server starts. Machine-bound sessions from a different host are not portable;
the image does not bundle Playwright or a browser login flow.

```sh
docker run -i --rm --env-file ./substack.env ghcr.io/conorbronsdon/substack-mcp:1.0.0
```

The existing image command remains `node dist/index.js`. For an offline status
check, explicitly select the Node entrypoint:

```sh
docker run --rm --env-file ./substack.env --entrypoint node ghcr.io/conorbronsdon/substack-mcp:1.0.0 dist/index.js status --json
```

For persistent HTTP, also configure a strong `MCP_HTTP_TOKEN` in the environment
file, bind the host port to loopback, and allow the exact host/port clients use:

```sh
docker run --rm --env-file ./substack.env -p 127.0.0.1:8080:8080 -e MCP_TRANSPORT=http -e MCP_HTTP_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080 ghcr.io/conorbronsdon/substack-mcp:1.0.0
```

Clients send `Authorization: Bearer <your MCP_HTTP_TOKEN>` to
`http://127.0.0.1:8080/mcp`. This token protects access to your Substack session;
it is separate from the Substack cookie. See the README for Origin policy and
remote deployment requirements. Local HTTP is not a hosted ChatGPT connector.

## Release verification and recovery

The Publish workflow verifies npm, MCP Registry and GitHub identities first,
then builds and tests the container from that original release commit. Older
releases without container verification scripts are skipped. A failed container
stage can be retried through Publish without republishing an existing npm release.
Releases whose source contains attestation support also publish signed GitHub
build provenance and an SPDX 2.3 SBOM for the immutable image manifest digest.
The provenance generation step runs only when the workflow commit is the verified
release source commit and the published digest equals the candidate built in that
run. Historical recovery may verify an existing attestation, but it cannot mint
new provenance from a different workflow commit or a different preserved image.
Rebuilds are not guaranteed to be byte-identical, so a later Publish run cannot
reliably attest a digest an earlier run left unattested. Recover a failed attest job with "Re-run
failed jobs" on that original Publish run, which reuses the already verified
candidate digest. A recovery run checks provenance and SBOM independently and reports unverifiable
attestations as warnings and UNVERIFIED entries in the job summary instead of
blocking release recovery. This includes missing or invalid evidence and service
errors; a green recovery run does not certify that the image has valid
attestations. Inspect the verification errors and require both consumer checks
below to pass before treating the image as attested.
Images built before this support may not have attestations. npm provenance is a
separate attestation for the npm package and does not verify the container.

GHCR package visibility is separate from repository visibility. The first publish
can create a private package. Set the project's GHCR package to public, then rerun
Publish. The candidate is checked through an empty Docker configuration before
release aliases are promoted, and the selected version is checked again. A successful authenticated push alone is not a public release.
The workflow uses only its scoped GitHub token and removes its Docker login on exit.

## Verify container attestations

Use the digest recorded by the release workflow, not a mutable tag, and require
this repository as the signer identity. GitHub CLI verification for GHCR uses the
Docker credential store, so authenticate to `ghcr.io` first if needed.

```sh
IMAGE=ghcr.io/conorbronsdon/substack-mcp
DIGEST=sha256:<64-hex-character-manifest-digest>
SOURCE_COMMIT=<40-hex-character-release-commit>
SIGNER_WORKFLOW=conorbronsdon/substack-mcp/.github/workflows/publish.yml

docker login ghcr.io
gh attestation verify "oci://$IMAGE@$DIGEST" \
  --bundle-from-oci \
  --repo conorbronsdon/substack-mcp \
  --source-digest "$SOURCE_COMMIT" \
  --signer-workflow "$SIGNER_WORKFLOW"
gh attestation verify "oci://$IMAGE@$DIGEST" \
  --bundle-from-oci \
  --repo conorbronsdon/substack-mcp \
  --source-digest "$SOURCE_COMMIT" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --predicate-type https://spdx.dev/Document/v2.3
```

The first command verifies registry-resident SLSA build provenance and constrains
the signing certificate to the exact source commit and Publish workflow. The
second verifies the signed SPDX SBOM predicate for the same image manifest digest
and identity. To inspect the provenance statement as additional evidence, add
`--format json` and review
`verificationResult.statement.predicate.buildDefinition.resolvedDependencies`.
Publish also downloads a real signed provenance bundle, alters its DSSE payload
without changing its signature and requires verification to fail. Wrong source
commit and wrong signer-workflow controls must fail against that same positively
verified downloaded bundle. These test identity constraints on a known bundle,
not rejection of a separate artifact signed by a competing workflow. Recovery
uses registry-based negative controls for each predicate that verifies.

Reference: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

## Build-tag retention

Supported release identities are the semantic version tag, every supported
release's `sha-<full-source-commit>` alias and its immutable manifest digest.
`latest` is a convenience alias and is never the identity used for retention or
attestation verification. These identities and their attestations must not be
removed by candidate cleanup.

Per-run `build-<run-id>-<attempt>` tags are publication receipts. An unpromoted
candidate may become cleanup-eligible after 30 days. A promoted candidate points
at the same manifest as release tags, so it is retained for as long as any
supported release alias references that manifest. GHCR's package-version delete
operation can remove a shared manifest and all of its tags; deleting such a
version merely to hide one build tag is prohibited.

Automated deletion remains disabled until a staging package proves tag/version
semantics end to end. Any future cleanup must run in a dedicated least-privilege
job, inventory digest-to-tag relationships immediately before deletion, limit
itself to unpromoted build-only versions older than 30 days, re-read the candidate
before deleting it and stop on unknown API responses. It must have regression
controls showing version, source and attestation-bearing digests are preserved.

Reference: https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility
