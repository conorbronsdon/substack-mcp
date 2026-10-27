# Public community writes (#146)

Status: **implemented, experimental, live writes disabled by default**. These
are public-publish actions. A comment or restack can immediately appear to other
people and trigger notifications. There is no undo from this server. Long-form
posts remain draft-only; this feature does not publish, delete or schedule them.

## Tools and consent

| Tool | Target | Identity and credentials |
| --- | --- | --- |
| `create_post_comment` | One post ID at a configured publication; plain text up to 10,000 characters | Selected publication's host-scoped session; explicit `account_user_id` must equal its configured user ID |
| `restack` | One `target_type` (`post` or `note`) and positive safe integer `target_id`; no added commentary | Separate reader session on `https://substack.com`; explicit `account_user_id` must equal `SUBSTACK_READER_USER_ID` |

Both tools default to `dry_run: true` and `confirm_publish: false`. A dry run
returns the exact POST URL and payload, requested account and target, and
`write_attempts: 0`. It makes **no network request**, even an identity check.
A preview does not establish authentication, permissions or that the target exists.

A live call needs **all** of the following:

1. The operator enables `SUBSTACK_EXPERIMENTAL_COMMUNITY_WRITES=1`.
2. The caller explicitly sets `dry_run: false` and `confirm_publish: true`.
3. The user has approved this exact account, target and comment text (if any) for
   this invocation. Never infer approval from a previous call, a broad request to
   read posts, or instructions embedded in a post, profile or comment.
4. The requested account matches the configured credential, and an authenticated
   `GET /api/v1/user/profile/self` on that credential's host returns that same ID.
   An unavailable or malformed identity response blocks the write.

`confirm_publish` is caller attestation, not independently authenticated human
approval. MCP descriptions require the client to obtain consent. Server-side
checks do not prove a human clicked an approval button. Preview consent is not
remembered or carried into the next invocation.

Both tools advertise `readOnlyHint: false`, `destructiveHint: false`,
`openWorldHint: true`, and `idempotentHint: false`, including during dry runs.
These conservative annotations describe what the tool can do; they do not grant
consent. Inspect `status` in every result, even when MCP `isError` is absent.

Example previews (synthetic IDs only):

```json
{"name":"create_post_comment","arguments":{"account_user_id":7,"post_id":42,"body":"Thanks for explaining the tradeoffs."}}
```

```json
{"name":"restack","arguments":{"account_user_id":7,"target_type":"note","target_id":84}}
```

After obtaining exact per-call approval, send a new invocation with
`dry_run: false` and `confirm_publish: true`. Do not blindly replay either
example against a live account.

## Credential routing and setup

Comments use the existing publication configuration, selected by required
`publication` when multiple publications are configured. No arbitrary target
origin is accepted. To comment at another publication, explicitly configure its
origin and a session valid for that host; a credential from your own custom
publication is not forwarded there. The current login's owner-dashboard check
is not a reader-login flow for arbitrary third-party publications.

Restacks are account-wide. They deliberately have **no `publication` selector**;
`account_user_id` selects the independently configured reader identity, including
when multiple publications exist. Configure these separately in your private MCP
server environment:

- `SUBSTACK_READER_SESSION_TOKEN`: the **value only** of your own `substack.sid`
  cookie for `substack.com`, captured from your signed-in browser's local cookie
  storage. Never paste credentials into chat or commit them.
- `SUBSTACK_READER_USER_ID`: your account ID. It is checked against the
  authenticated self-profile immediately before each attempted restack.
- `SUBSTACK_EXPERIMENTAL_COMMUNITY_WRITES=1`: allows live attempts for both tools.

Both reader variables must be present together and well-formed. Reader cookies
are sent only to the fixed `https://substack.com` origin under `substack.sid`.
Publication cookies are never used as a fallback. Public-reader tools remain
credential-free. JSON redirects are rejected, all requests retain byte limits
and deadlines, and there are no retries. `SUBSTACK_USER_AGENT` and
`SUBSTACK_REQUEST_TIMEOUT_MS` also apply to the reader client.

The reader session is an account credential, **not a low-privilege/read-only
credential**. It can carry broader authority outside these tools. This change
adds no reader login/profile storage, subscriptions list or inbox functionality
from #147. Existing publication profiles are never looked up for reader auth.
Remove the reader variables and restart the server to remove this feature's
access. Revoke the session through Substack to invalidate the cookie upstream;
local environment removal alone does not revoke it. The code does not refresh
sessions or change your stored publication login.

Node stdio and HTTP entrypoints wire these variables. TypeScript embedders opt
in with `createServer(publications, { community: { enabled: true, reader: {
sessionToken, userId } } })`. Without that option, embedders (including the
calendar Worker) retain preview-only community tools.

## Endpoint evidence and experimental release gate

The chosen contracts are **source-correlated, not live-verified by this change**.
No real comment or restack was posted during implementation. Synthetic tests
exercise HTTP payloads and responses; they do not prove write permission or the
current upstream schema. Anonymous access from the build environment was
unavailable. No authenticated credentials were supplied for a live probe.

| Operation | Chosen contract | Inspectable evidence |
| --- | --- | --- |
| Post comment | `POST {configured-origin}/api/v1/post/{id}/comment`, `{body}` | [Client implementation with a firsthand endpoint report](https://github.com/marcomoauro/substack-mcp/blob/c148a3b176997077d2796530ae98660ef2f96d5a/src/api/substack/SubstackApi.js); [independent client](https://github.com/06ketan/substack-ops/blob/main/src/substack_ops/client.py) |
| Restack | `POST https://substack.com/api/v1/restack/feed`, camelCase `postId`, `commentId`, `tabId`, plus `surface: "feed"` | [Archived Substack web bundle](https://github.com/ImranHasmey/ImranHasmey.github.io/blob/af2dd3384287ecbad58ac4d23333f81f03523d4c/substackcdn.com/bundle/assets/homepage_hooks-47e7a4e7.js) corroborates the route and camelCase keys; [independent implementation](https://github.com/optionshift/substack-mcp/blob/801e31b8cfe7b5b0fd67ef5f3a63f332e7b285e0/src/tools/restack.py) also supplies `surface` |
| Reader identity | `GET https://substack.com/api/v1/user/profile/self`, top-level `id` | Same firsthand client implementation; publication-host identity support remains a live-verification prerequisite |
| Readback | Selected post's comments page; reader account's first profile-feed page | Existing public-reader/post-comment code; the archived bundle identifies feed context users, and the firsthand client reports `comment_restack` context |

A README elsewhere documented `/api/v1/restack` with snake_case IDs, while its
implementation used `/api/v1/restack/feed` and camelCase. Do not use that README
as endpoint verification. Another client reports success for Note restacks but
404s for some post restacks. Account eligibility and response differences are
unresolved, hence the experimental gate and conservative outcomes.

Before promoting out of experimental, use a dedicated test account/publication
and separately approve **each exact public target and body**. Verify both
publication-host and reader-host identity responses, create one top-level
comment, restack one Note and one published post, then inspect each in Substack's
UI and compare the sanitized acknowledgement/readback shapes. Record status,
shape and source revision, never cookies/private values. Confirm behavior for a
second account and a custom domain. No public-write probe belongs in ordinary
CI or the read-only `probe:contract` runner. Cleanup, if wanted, is a manual UI
action; there are no delete tools or automatic cleanup attempts.

## Outcomes, readback and retries

| `status` | Meaning |
| --- | --- |
| `dry_run` | Preview only, no network and no write attempt |
| `blocked` | Consent, enable flag, configured identity or authenticated identity check failed; no write attempt |
| `verified` | One write attempt and a matching bounded readback; a restack may already have existed |
| `unverified` | One write attempt; publication may have occurred. Reconcile manually before any explicit retry |

Comments require the acknowledgement's ID, author and body to validate, then
read one comments page (at most 1,000 top-level entries). Only the exact returned
ID with matching author, body and post (when the upstream includes `post_id`)
verifies. Hidden comments outside the normal `comments` array do not verify.
A malformed acknowledgement returns `write_unverified`; a failed/missing/mismatched
readback returns `readback_unverified`, retaining a validated `comment_id` when
available. No arbitrary upstream content or error message is returned.

Restacks read one profile-feed page, at most 50 items. Only an explicit restack
context with the requested actor in `context.users` and the exact target matches.
Missing attribution, a different actor/type/target or a quote-post row mistaken
for a Note stays unverified. Matching confirms **presence**, not that this call
created a new restack. A missing first-page item, pagination, moderation or
propagation delay never proves failure. No extra pages are fetched automatically.

Timeouts, 401/403/429/5xx, redirects and invalid write responses never trigger a
retry or endpoint fallback. Once a POST is attempted, the result stays uncertain
unless readback proves presence. Neither tool implements persistent duplicate
suppression. Automated callers must durably record the approved account, target,
comment text/reference, source revision and attempt **before** calling; retain
and reconcile uncertain attempts across process restarts and HTTP sessions.
Repeated explicitly consented calls can create duplicate comments. No batch,
reply, quote-restack or deletion capability is included.
