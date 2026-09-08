# 0.9 validation scope

The 0.9 release joins publication context, tag reads, AST authoring, draft export
and reviewed updates. `update_draft` now requires a plan receipt and the same
proposed input. See [migration and outcomes](draft-changes.md).

## Evidence

| Surface | Verification | Limit |
| --- | --- | --- |
| Publication, tag and archive reads | Focused contracts and independent reviews in #70, #72 and #73; read-only live samples | One publication; draft-tag live evidence covers empty responses |
| Markdown authoring | Golden fixtures, output bounds, seven mutation controls and live editor/readback evidence in #80 | Unsupported constructs are reported; no general embed or callout fidelity claim |
| Export | Source preservation, conversion-loss and file-overwrite controls, twelve mutation controls, live synthetic draft in #81 | Markdown does not retain every native editor detail |
| Guarded updates | SDK stdio-core/HTTP and CLI tests, eight mutation controls and exact-SHA reviews in #82 | Receipt is unsigned; separate GET/PUT requests are not atomic |
| Live writes | Dedicated unpublished synthetic draft: title update/restoration and body update/restoration with exact body readback | One publication and content sample; no Notes or long-form publication performed |
| Demo | Seven offline steps through actual MCP handlers; recorded JSON checked by package verification | Fixture evidence, not a live API or browser recording |
| Packaging | Clean tarball install, both binaries, version handshake and all 24 catalog entries | Named-client onboarding matrix remains in the 1.0 plan |

Core tests, release controls and package verification run on Linux and Windows,
Node 22 and 24. The Linux Node 22 job also checks cloud types, tests and build.
Final commit-bound results are recorded in the release PR and Actions runs.

## Known limits and follow-ups

- The tested upstream endpoint accepted a changed title despite a deliberately
  nonmatching `If-Match`; conditional-write support is not established.
- Missing scheduling fields are reported as uncertainty. Avoid concurrent
  editing and review the current draft in Substack before and after applying.
- `request_status: "unknown"` is conservative. More detailed safe failure
  classes and shared conversion/readback constants are tracked in #65.
- Production dependency audit is clean at release preparation. The development
  toolchain retains one low-severity esbuild advisory, GHSA-g7r4-m6w7-qqqr,
  through tsx's `~0.27.0` constraint. The compatible audit-fix dry run proposed
  no changes. This is tracked in #65; esbuild is not shipped in the npm runtime.
- The server imposes no Bestseller-status check. Account permissions still
  govern access; an end-to-end non-Bestseller account matrix remains in #66.
- Updated social preview artwork is included. Uploading the repository setting
  is a separate UI action, not evidence that a new package is published.

The full 1.0 scope remains in #62, distribution and launch execution in #68,
and Claude Code/ChatGPT packaging in #69. This release does not claim those
integrations or pending directory submissions are complete.
