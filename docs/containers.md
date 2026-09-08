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
OCI signing/SBOM attestations and build-tag retention are follow-ups; labels are
identity metadata, not cryptographic attestations. Per-run build tags remain for diagnostics; they are not supported release tags.

GHCR package visibility is separate from repository visibility. The first publish
can create a private package. Set the project's GHCR package to public, then rerun
Publish. The candidate is checked through an empty Docker configuration before
release aliases are promoted, and the selected version is checked again. A successful authenticated push alone is not a public release.
The workflow uses only its scoped GitHub token and removes its Docker login on exit.

Reference: https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility
