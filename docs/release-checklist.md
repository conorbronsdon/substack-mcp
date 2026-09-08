# Release checklist

Use this checklist for each release. Record exact source revisions, command
results, client versions and public artifact identities in the release issue.
Keep credentials, subscriber data and private drafts out of evidence packs.

## Prepare and review

- [ ] Resolve release-blocking findings and dependency advisories, or record a scoped reason to defer.
- [ ] Update the changelog and compatibility limits. Use `npm version <version> --no-git-tag-version` to synchronize manifests.
- [ ] Run `npm run build`, `node scripts/workflow-demo.mjs --write` and `python scripts/render-workflow-demo.py`; inspect the rendered demo and pin the README image to its committed revision. Preserve that revision in default-branch ancestry with a merge commit, or pin an already retained revision; do not leave the image dependent on a discarded branch commit.
- [ ] Run `npm run lint`, `npm test`, `npm run test:release`, `npm run test:package`, and the cloud checks used by CI. Inspect the packed file list and both installed binaries.
- [ ] Run independent reviews against the final commit. Verify findings against source; repeat affected reviews after structural changes. Keep the review receipt and meaningful negative controls.
- [ ] Verify configured named clients can initialize and call a read tool. Label fixture checks separately from live account checks.
- [ ] When a live probe is authorized, use a clean built checkout and the explicit opt-in `SUBSTACK_CONTRACT_PROBE=1 npm run probe:contract`. Record the sanitized report and coverage limits. Do not substitute fixture success for live access.
- [ ] Require all CI and container verification checks before merging the release PR.

## Publish and verify

- [ ] Watch Publish after the merged version change. Confirm npm version, `gitHead`, integrity and a clean installation agree with the intended source.
- [ ] Confirm the GitHub tag/release targets the same source, and MCP Registry identity/version is active.
- [ ] Confirm GHCR version, source revision, ownership labels and anonymous access. Record the manifest digest; run the container transport checks against the published artifact.
- [ ] If the first GHCR package is private, make this project's package public and rerun Publish. A candidate push is not a finished container release.
- [ ] Confirm `latest` and source aliases agree with the selected verified version. Never overwrite an existing mismatched version or force-move a release tag.
- [ ] Recheck product links and client commands against the published package. Update the release issue with receipts and retain broader follow-up issues.

The workflow can recover missing artifacts from the original npm release commit.
Rerun Publish for partial publication; do not bump a version merely to bypass an
unexplained identity mismatch. For a defective published version, document the
problem and ship a reviewed patch. Users can pin a previously verified npm
version or container digest while investigating. Never automatically retry a
Substack write whose outcome is unknown.

## Launch and follow up

- [ ] Prepare the announcement and workflow demonstration for maintainer review; publish or schedule only with applicable authorization.
- [ ] Work through the [distribution inventory](distribution.md), recording accepted URLs separately from submitted or unverified destinations.
- [ ] Capture a dated baseline of npm downloads and GitHub stars/forks. Downloads include automation and repeat installs, so they are not active-user counts.
- [ ] Recheck at 7 and 28 days. Record installation failures, voluntarily reported use and issue turnaround without adding default product telemetry.
- [ ] Incorporate newsletter-user feedback as it arrives. Optional directory admission and uncollected testimonials do not block an otherwise verified release.
