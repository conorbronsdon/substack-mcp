# Subscriber reads and Substack's "Confirm it's you" step-up

Since about 2026-10-08, subscriber reads (`POST /api/v1/subscriber-stats`, which
backs `list_subscribers`, `get_subscriber`, `search_subscribers`, `add_subscriber`'s
membership checks and the calendar opt-in sync) can fail with:

```json
HTTP 403 {"error":"For your security, please sign out and sign back in to do this.","type":"reauthentication_required"}
```

#190 makes this show up as `auth_reason: "reauthentication_required"` and sync reason
`substack_reauthentication_required`. This page covers why it happens and how
`substack-mcp login --subscriber-access` attempts the step-up and verifies the resulting access before saving.

## What Substack checks

Despite the wording, signing out and back in is not enough. A brand-new
`substack-mcp login` session is refused too. Substack's public dashboard bundle
(`substackcdn.com/bundle/static/js/18890.*.js`, inspected 2026-11-03 without
signing in) shows the real mechanism:

1. A sensitive API call returns 403 with `type: "reauthentication_required"`.
   A shared wrapper in the web app catches it and opens a modal titled
   **"Confirm it's you"**.
2. The modal calls `POST /api/v1/reauthenticate/start` on the **current origin**,
   which is the publication's own domain for the dashboard. The response's
   `method` is `"email"` ("We've sent a code to <your email>") or `"totp"`
   ("Enter the code from your authenticator app"). If there's no `method`, the
   session already qualifies.
3. The person enters the code. The app sends
   `POST /api/v1/reauthenticate/complete {"code": "..."}` and retries the
   original request once.

This is consistent with a step-up requirement associated with the signed-in
session. The bundle does not establish its lifetime or all server-side checks,
and this change has not verified the flow against a live account.

The independent open-source client in [Kilo-Org/cloud#7481](https://github.com/Kilo-Org/cloud/pull/7481)
uses the same `start`/`complete` sequence, retried once and only after this
exact 403. It also carries forward any `Set-Cookie` rotation.

## The fix: `login --subscriber-access`

```bash
npx substack-mcp login https://yourpublication.com --verify-identity --profile work --subscriber-access
```

After the usual sign-in and drafts check, login:

1. probes `subscriber-stats` with the reserved address
   `subscriber-access-probe@example.invalid`, which should not match a real
   subscriber. If the upstream service ignores the filter, its response could
   nevertheless contain subscriber data; unexpected nonempty responses fail closed;
2. on `reauthentication_required`, calls `reauthenticate/start` and asks in the
   terminal for the code Substack emailed you or your authenticator app shows
   (three tries; a blank answer cancels);
3. sends it to `reauthenticate/complete`, keeps any rotated session cookie,
   and probes again;
4. saves the session **only if** subscriber reads now succeed. The output adds
   `"subscriber_access":"verified"` and `"step_up":"email"|"totp"|"not_required"`.

Without the flag, login behaves exactly as before and makes no subscriber request.
The code is sent for verification and is not stored or logged; the prompt suppresses echo on a TTY. Other input environments may echo it.

## What cannot be automated

The step-up needs a code that only the account owner receives, so it **cannot be
done unattended**. Two shortcuts exist, and this project rejects both:

- **Storing the authenticator (TOTP) secret** so the code can be generated
  automatically, as Kilo does. That puts the account's second factor on the same
  disk as its session, which defeats the purpose of 2FA and widens what one leaked
  file can do. If this is ever wanted, it needs its own design review. This change
  does not add it.
- **Reading the emailed code from the inbox** through Gmail tooling. That
  silently turns mailbox access into Substack admin access, so it's rejected for
  the same reason.

## How long a step-up lasts: unknown

Substack's bundle does not reveal how long a completed step-up stays valid, or
whether it is tied to the session or to time since sign-in. No live measurement
has been made for this change. Treat every expiry claim as unverified until it
is observed.

## Operating the scheduled sync

The least-bad cadence, given the above:

1. Re-run `login --subscriber-access` for the sync's profile (with `--force` to
   replace it) when the sync reports `substack_reauthentication_required`. #190's
   local alert already names this reason, so there is no need for a fixed
   schedule that might re-prompt when nothing is wrong.
2. Don't add retries or loops around a `reauthentication_required` failure. The
   session will not recover by itself, and repeated `start` calls send repeated
   email codes.
3. Record each re-login date privately. After two or three cycles that gives the
   real step-up lifetime, and that number should replace "unknown" above.

## Unverified items

- Whether the publication-origin `start`/`complete` calls behave the same on
  `*.substack.com` publications as on custom domains (the web app calls them on
  whatever origin the dashboard is served from).
- Whether `complete` rotates the session cookie. Both cases are handled and tested.
- The exact rollout date. 2026-10-08 is when this repository's sync started failing.
