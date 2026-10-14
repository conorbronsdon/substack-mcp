# Evaluation: reader-account sessions (#147)

Status: **evaluated, not implemented.** Reader subscriptions and the reader inbox
stay unsupported ([compatibility](compatibility.md)). This page records what
supporting them would take, so the decision can be revisited with evidence. The
September 23, 2026 probe is the only live evidence. Everything else here comes
from this repository's code and is marked as inference where it goes further.

## What was asked

Reader-account features would answer "what do I subscribe to?" and "what is new
in my inbox?" for the person running the server, as opposed to the publication
they manage. Two routes were probed:

| Route | Purpose | Result with the publication session |
| --- | --- | --- |
| `GET substack.com/api/v1/subscriptions/all/v2` | Publications the account subscribes to | HTTP 401 |
| `GET substack.com/api/v1/reader/posts` | Reader inbox feed | HTTP 401 |

Response shapes, pagination and rate limits were never observed. They are
unknown, not just unverified.

## Feasibility

**Technically feasible, not yet justified.** Everything the server would need
already exists in some form:

- a browser login that captures a session cookie per host (`src/login.ts`);
- profile storage in the session directory or the OS keychain (`src/auth/`);
- bounded, redirect-rejecting JSON requests (`src/api/request.ts`);
- host-allowlisted, credential-free public reads (`src/api/public-reader.ts`).

What is missing is a second kind of credential and a client that can only talk to
`substack.com`. That is a new authentication surface, not a new tool. It needs
its own design review, live probes and release gate. Nothing in #147 shows the
demand that would justify that cost.

## Auth model

### Option A: reuse the publication session. **Rejected.**

The publication client sends `connect.sid` and `substack.sid` only to the
configured publication origin (`src/auth/validate-credentials.ts`). Forwarding
those cookies to `substack.com` would break the rule that a cookie never leaves
the host it was captured for. The 401 shows the forwarded publication session is
not accepted there anyway. Why it is rejected (cookie name, cookie scope or
account state) was not investigated, and this evaluation does not guess.

### Option B: a separate, opt-in reader profile. **The only acceptable design.**

- **Login:** a distinct command, e.g. `substack-mcp login --reader`, that captures
  only the `substack.com` session cookie and stores it as a reader profile. It
  never writes the publication profile, and the publication login never writes a
  reader profile.
- **Storage:** the same backends as publication profiles (`0600` files in
  `SUBSTACK_MCP_HOME` or the OS keychain), under a distinct reader key. A
  publication lookup never falls back to a reader profile, or the reverse.
- **Host routing:** a dedicated reader client whose only allowed origin is
  `https://substack.com`. It rejects redirects, as JSON calls already do. The
  publication and public-reader clients never receive the reader cookie. Tests
  must assert all three directions: reader to publication, publication to reader,
  and reader to the public-reader client.
- **Tools:** read-only, separately registered, and absent unless a reader profile
  exists *and* an explicit enable flag is set. The output is projected: titles,
  publication names, URLs and dates, never post bodies.
- **Revocation:** `logout --reader` deletes only the reader profile. There is no
  refresh: an expired or revoked session returns `authentication` with a static
  message, and the user logs in again. Substack's own sign-out from all devices
  invalidates the cookie upstream. That is inferred from standard session-cookie
  behaviour and has not been verified.

### Option C: anonymous public reads. **Already shipped, and does not cover this.**

The 1.3 public-reader tools read public profiles, archives and posts with no
credential. A subscription list and an inbox are private to an account, so no
anonymous route can serve them.

## Risks

1. **Privilege, not just privacy (inference, unverified).** A `substack.com`
   session most likely belongs to the whole Substack account, not to a reading
   role. If the reader and the publication owner are the same account, a stored
   reader cookie may carry the same authority as the publication session. Calling
   it "read-only" would then describe the tools, not the credential. This must be
   checked before any design that treats the reader credential as low-risk.
2. **Sensitive personal data.** What someone subscribes to and reads reveals
   interests, politics, health and employment. Unlike subscriber data, this is the
   operator's own data, but it still flows into an assistant's context and
   transcripts.
3. **Paid content from other publications.** Inbox entries can include paywalled
   posts the account has paid for. Returning bodies to an assistant could breach
   those publications' terms. Hence titles and links only.
4. **A second credential to leak.** Every stored session doubles the impact of a
   compromised `SUBSTACK_MCP_HOME` or keychain. Cross-host forwarding bugs are the
   most likely way to leak one, which is why the routing tests above are a
   precondition, not a nice-to-have.
5. **Unofficial, unobserved API.** Shapes, pagination and limits are unknown. The
   whole feature would rest on undocumented endpoints that Substack can change.
6. **Maintenance cost.** Two login flows, two profile kinds and two failure
   surfaces for the operator CLI, doctor and docs.

## Recommendation

**Do not implement now. Keep both routes documented as unsupported.** Revisit
only when all of these hold:

1. A concrete use case that the public-reader tools cannot meet, raised by more
   than the maintainer (an issue or discussion with real requests).
2. A maintainer-approved, read-only live probe on a disposable reader account
   records the response shapes, pagination and status codes. It must also answer
   risk 1: does a reader session also grant publication-admin routes? No values
   from that account go into the repository.
3. A design PR for Option B that includes the cross-host routing tests before any
   tool code.

No code ships with this evaluation. #145 (hosted remote MCP) and #146 (community
writes) are separate decisions and are not affected.
