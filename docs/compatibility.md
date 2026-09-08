# 1.0 compatibility and validation

The 1.x commitment covers this project's documented tool and CLI interfaces.
Substack's underlying endpoints remain undocumented and can change independently.
See the [output contract](tool-contract.md) and [draft update migration](draft-changes.md).

## Accounts and publications

This server imposes no Bestseller requirement or paid-plan check. Use an account
with the permissions needed for the requested publication operation. Having a
Substack account alone does not grant access to another publication's drafts,
analytics or subscribers. Account tier coverage has not been independently
verified across every Substack plan.

The opt-in live read probe at source revision
`601b9b53315d0814a76cf45fbf4eae8d093ce93e` (PR #88, before the 1.0 version bump)
passed publication metadata, draft-list and subscriber-count checks against one
custom-domain publication on September 8, 2026 at 05:19 UTC. It made five read
requests and no writes. This establishes authenticated
read access for that configuration; it does not verify account identity, tier,
every endpoint or a different publication. Automated fixtures cover malformed
responses, expired authentication, publication isolation and bounded failures.

## Client coverage

| Surface | Verification for the 1.0 release | Limit |
| --- | --- | --- |
| Claude Code | Local marketplace installation and MCP connection; model-driven `list_drafts` call with synthetic data | Does not establish Claude Desktop GUI setup |
| Codex CLI 0.153.4 | Configured stdio server, model-driven `list_drafts` call and checked tool result with synthetic data | Codex app plugin installation is not independently verified |
| MCP SDK | Installed npm package initialization, complete catalog, object/text results and read-only probe | A protocol check does not establish every client UI |
| Streamable HTTP | Container initialization/catalog and missing/wrong bearer rejection | Deployment must provide its own access controls and TLS where appropriate |
| Session profiles | Legacy migration, rollback and explicit multi-publication selection tests | Machine-bound files are not portable; manual browser-login UI remains an integration limit |

Use the [README setup](../README.md#setup) and [plugin guide](plugins.md).
Local stdio plugins are not hosted ChatGPT connectors. A hosted service with
per-user authentication and session custody requires separate work. MCPB is
deferred: npm, the CLI and local plugins share one maintained installation path;
a desktop bundle needs its own packaging and upgrade verification first.

## Analytics decision

1.0 retains per-post analytics and subscriber counts, including their CLI read
commands. Aggregate dashboards, post ranking, segmentation and bulk subscriber
export remain in [#52](https://github.com/conorbronsdon/substack-mcp/issues/52).
Prioritize additions against concrete creator questions and verifiable endpoint
behavior as feedback arrives. Newsletter-user feedback is a post-release input,
not a prerequisite for the stability release.

## Supported boundaries

Long-form posts remain draft-only. Draft replacement requires a reviewed plan
and remains subject to the documented residual race and readback limitations.
Notes publish immediately; image uploads can expose a public URL. Subscriber
additions require consent and default to dry-run. These are distinct side effects
and need appropriate authorization in the calling application.

Remote image fetching, community interactions, an OS keychain backend, MCPB and
hosted multi-tenant operation are outside 1.0. Container support starts with Linux
amd64; see [containers](containers.md) for public-artifact verification and the
separate OCI attestation follow-up.
