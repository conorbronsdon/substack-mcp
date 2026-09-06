# Always-on Calendar newsletter sync

The optional Worker runs the registered MCP subscriber tools through an in-memory
MCP connection. A Cloudflare Cron Trigger starts a scan at minute 5 of every hour;
the user's computer and coding assistant can be off. This is polling, not a
webhook. Normal propagation and job failures can delay processing.

One SQLite Durable Object per publication stores the imported consent ledger,
run history, and report delivery claims. Every subscriber attempt is **awaited in
durable storage before the external request**. Overlapping jobs in the same
object are rejected. A restart does not erase recorded attempts. The helper
never automatically retries blocked or uncertain additions, including requests
that may already have sent a welcome email.

`SEND_WELCOME_EMAIL=true` requests Substack's welcome email for new additions.
The general MCP tool defaults `send_welcome_email` to false; the cloud example
opts in. Existing members never receive another request. Membership verification
does not independently establish welcome-email delivery.

## Configure and migrate

Use the supplied Wrangler config as a template. Set `ORGANIZER_EMAIL`,
`PUBLICATION_URL`, and `REPORT_TIMEZONE` for the intended publication. Keep
deployment-specific config outside public source control. Set the required
secrets through Cloudflare's secret manager: `ADMIN_TOKEN` (at least 32 random
characters), `GOOGLE_CREDENTIALS` (authorized-user client ID, client secret,
refresh token), `SUBSTACK_SESSION_TOKEN`, and `SUBSTACK_USER_ID`. The Google
authorization needs Gmail read and send access; the profile must match the
organizer. Refresh tokens renew short-lived Google access tokens; revoked
authorization still requires operator intervention. Substack sessions can expire.

1. Build/test and deploy while the local scheduler still owns the ledger. The
   cloud job refuses live execution before initialization and explicit activation.
2. Stop the local scheduler, verify no local run is active, and back up its state.
3. POST that existing JSON state to `/initialize` with the admin bearer token.
   Import checks the publication/organizer and refuses to overwrite existing
   cloud state. A new installation must explicitly initialize an empty v1 state.
4. POST `{"dry_run":true}` to `/run`. Verify Gmail identity, subscriber API access,
   scan results, and retained blocked/uncertain attempts. All admin routes require
   the bearer token. `/status` returns aggregate job information, not addresses.
5. POST to `/activate`, then `/run` with `{"dry_run":false}`. Verify the result
   before considering cutover complete. Keep the local scheduler disabled.

Do not roll back by enabling the old local scheduler with stale state. Pause the
cloud job and reconcile its newer attempt history first. Never reset cloud state
to solve a credential or lock problem. `/pause` disables new live runs.

## Weekly email check

A separate cron invocation checks whether it is Monday at 09:20 in the configured
time zone. It emails the organizer a seven-day summary: successful and failed
runs, estimated missed hourly runs, newly verified additions, and current blocked,
uncertain, and ambiguous records. Historical terminal statuses are not summed as
new additions. Stale success, failures, missing runs, uncertain attempts, or a
paused job mark the report as needing attention. An authenticated POST `/report`
sends an initial test report with a separate delivery claim from the weekly run.

Report attempts are recorded before Gmail sends. An ambiguous send is not
automatically repeated; check the sent mailbox before manually resetting a
report claim. If Google authorization itself fails, the report cannot email its
own failure. Cloudflare job errors/logs remain the independent diagnostic surface.
This is an automation health report, not a general weekly work review.

The weekly report checks execution records and stored membership verification.
It does not prove recipient email delivery or re-subscribe anyone who later left.
The bounded 180-day scan stops before additions if it exceeds 500 messages.
Each run submits at most five new additions; pending eligible contacts remain in
state for later scans. Template changes or ambiguous answers can require review.

## Validation

Run `npm run lint`, `npm test`, `npm run lint:cloud`, `npm run test:cloud`,
`npm run build`, and `npm run build:cloud`. Cloud checks use generated Workers
types and the actual Workers runtime. No production secrets are needed for tests.

The state contains private contact information. Never commit it, include it in a
review packet, or put credentials in shell arguments. Logs/report bodies contain
aggregate outcomes only. Provider-level outages can affect both sync and its
monitor; this deployment is not an independent external uptime-monitoring service.
