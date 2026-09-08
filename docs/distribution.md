# Distribution inventory

Maintainer: Conor Bronsdon. Inventory checked September 8, 2026 UTC; this is a dated
status record, not a promise that third-party indexes have refreshed. npm remains
the canonical package. Release artifacts are verified by the Publish workflow;
directory admission and social publication are tracked separately in
[#56](https://github.com/conorbronsdon/substack-mcp/issues/56) and
[#68](https://github.com/conorbronsdon/substack-mcp/issues/68).

| Destination / identity | Current status | Update or verification route |
| --- | --- | --- |
| [npm: @conorbronsdon/substack-mcp](https://www.npmjs.com/package/@conorbronsdon/substack-mcp) | Published; canonical install | Publish workflow; verify version, integrity and installed package |
| MCP Registry: `io.github.conorbronsdon/substack-mcp` | Published; version updates automated | Publish workflow; query registry identity/version after release |
| [GitHub releases](https://github.com/conorbronsdon/substack-mcp/releases) | Published; automated version releases | Verify tag source and release notes |
| GHCR: `ghcr.io/conorbronsdon/substack-mcp` | Required 1.0 artifact; inspect release job for availability | Publish workflow, package visibility and anonymous digest check; [guide](containers.md) |
| Docker Hub | No image advertised; follow-up destination | Maintainer must choose namespace and verify publication before listing an image |
| [Product documentation](https://github.com/conorbronsdon/substack-mcp#readme) | Maintained with source | README, [workflow tutorial](workflow.md), demo and compatibility checks |
| [Glama](https://glama.ai/mcp/servers/conorbronsdon/substack-mcp) | Existing listing; cached tool/setup copy needs refresh | Request repository reindex through listing management/support; verify resulting copy |
| [MCP Market](https://mcpmarket.com/server/substack-4) | Existing listing; release refresh unverified | Listing correction/submission route; verify owner, package and version |
| PulseMCP | Listing identity unverified | Check registry ingestion and directory submission process; retain accepted URL |
| MCP.so | Listing identity unverified | Verify exact repository; use directory submission process if needed |
| LobeHub | Listing identity unverified | Verify repository/package match and supported local configuration before submission |
| Smithery | Listing identity unverified | Evaluate local configuration and secret handling before an authorized submission |
| mcpservers.org | Listing identity unverified | Verify exact repository and current submission route |
| Curated lists | Coverage reconciliation pending | Search exact repository URL, check list contribution rules and existing entries before proposing additions |
| Claude Code | Repository marketplace and plugin available | [Plugin installation](plugins.md); synchronized manifest and connection check |
| Codex | Repository plugin manifest and direct MCP configuration available | Validate manifest and direct client tool call; app installation remains a separate check |
| Hosted ChatGPT | No hosted connector advertised | Separate authenticated HTTPS service design; [#69](https://github.com/conorbronsdon/substack-mcp/issues/69) |
| MCPB | Evaluated and deferred | Revisit when desktop installation needs justify a separately tested bundle |
| PyPI | Intentionally excluded | Avoid a redundant language wrapper around the canonical Node package |
| Homebrew / JSR | Deferred | Evaluate maintenance and upgrade needs after 1.0 |

Search failures do not establish that a listing is absent. Before marking any
destination current, verify the exact repository/package, supported transport,
credential instructions and accepted public URL. Automated aggregators can lag
several releases. Do not copy unverified capability counts or compatibility
claims from their cached descriptions.

For launch measurement, record weekly npm downloads, stars/forks and voluntarily
reported installation outcomes in the release issue. Compare consistent date
windows at 7 and 28 days. Keep user identities and private feedback out of public
records unless the contributor has authorized disclosure.
