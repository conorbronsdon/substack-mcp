# Client plugins

The Claude Code and Codex packages launch the same exact-version npm server over
stdio and share `skills/substack-creator-workflow/SKILL.md`. Credentials are not
packaged. Configure environment credentials or the server's stored session/profile
selection before launching your client; see the README. Long-form posts remain
draft-only. Notes publish immediately when called with your authorization.

## Claude Code

After this packaging change is released, add the repository marketplace and
install the plugin:

```text
/plugin marketplace add conorbronsdon/substack-mcp
/plugin install substack-mcp@substack-mcp
```

This is the project's self-hosted marketplace, not a claim of admission to
Anthropic's curated directory. The root `.mcp.json` is discovered by Claude Code;
the versioned launcher is synchronized by `npm run sync:release`. The shared skill
is available as `/substack-mcp:substack-creator-workflow`. Avoid enabling duplicate
manual and plugin server entries for the same publication.

For development, use `claude --plugin-dir /path/to/substack-mcp`; the MCP launcher
still uses the manifest's exact published npm version. A local plugin manifest
validation is not proof that an unpublished server version is installable.
Verify publication context and a bounded draft list before attempting a requested
private draft workflow. Existing replacement requires a plan receipt. Never use
a public Note as an installation test.

Reference: https://code.claude.com/docs/en/plugins-reference
Marketplace installation: https://code.claude.com/docs/en/plugin-marketplaces

## Codex

The existing `.codex-plugin/plugin.json` includes the same MCP configuration and
shared skill directory. Load the repository plugin through your Codex client's
supported local/plugin installation flow. The server can also be configured
directly as an MCP server using the README's stdio command and credentials. Plugin
manifest validation does not establish public-directory acceptance.

## ChatGPT and hosted access

This release's local stdio plugins are not a hosted ChatGPT connector. There is
no shared maintainer-account endpoint or multi-tenant session service. A public
ChatGPT distribution route needs a separate reviewed HTTPS/authentication design,
per-user publication isolation, revocation, privacy disclosures and actual client
verification. The existing optional HTTP transport alone does not establish those
properties. Track the remote distribution follow-up in issue #69; do not describe
a prepared local plugin as an accepted ChatGPT listing.

## Packaging decision

MCPB is deferred for 1.0. The npm/stdio route already supplies the shared runtime;
a desktop bundle would add a second installation/update path and would not solve
hosted ChatGPT access. Browser login's optional Playwright dependency and
machine-bound stored sessions also need explicit bundle lifecycle testing before
advertising an MCPB. This decision does not prevent adding one later.
