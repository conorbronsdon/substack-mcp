# Subscriber API contract

Validated September 2026 against a publication with a custom domain using the
existing session-cookie client. These are unofficial endpoints and can change.

## Read

`POST /api/v1/subscriber-stats` accepts `{filters, limit, offset}`. Exact email
lookup uses `filters.user_email_address_string_is`; a top-level search is not
equivalent. The MCP checks returned addresses and counts, failing closed if a
filter appears ignored. Live exact-email queries against a publication with
over a thousand subscribers returned filtered `count: 1` for a listed address
and `count: 0` for an absent one. Both paths were exercised through the built
MCP tools. Pages are bounded to 50 records and default to 10.

Case behavior was also checked live: a mixed-case stored address matched both
its original spelling and a lower-case query, and an upper-case query matched
another existing member. The exact filter is case-insensitive in these checks.

The response includes `subscribers`, `count`, and a potentially stale
`lastSync`. Membership is established by an exact row with a subscription ID.
The field `is_subscribed` represents paid-content access, **not** free newsletter
membership, and is intentionally omitted from tool output.

## Write

`POST /api/v1/subscriber/add` uses:

```json
{"email":"reader@example.org","subscription":false,"sendEmail":false}
```

The field names are shown in the publisher's [working request screenshots](https://substack.com/@huryn/note/c-181571328).
The [subscriber-query implementation](https://github.com/marcomoauro/substack-mcp/blob/main/src/api/substack/SubscriberQuery.js)
documents the exact filter encoding and paid-access field semantics.

A real opted-in address absent from the membership query received HTTP 400:
`No valid emails found. This could be because an email previously unsubscribed.`
The tool reports `blocked`; it does not infer that an unsubscribe definitely
occurred, attempt another endpoint, or offer a force-resubscribe option.

Three earlier UI additions were reconciled through exact API lookups. The
dashboard had initially not shown them. This establishes why immediate absence
is not a failed-write signal. The new add tool's successful-write sequence is
covered with mocked API responses; production verification must state separately
which paths were exercised live. No invented subscriber is added as a test.

## Automation contract

Only an explicit newsletter opt-in authorizes an addition. A booking or contact
address by itself does not. For calendar integrations, bind the answer to the
`Booked by` email, use the latest answer per address, and exclude negative,
ambiguous, or already-subscribed answers. A later booking No blocks a new add;
it is not an instruction to remove an existing subscriber.

Live adds require `consent_evidence` containing a nonempty `source` reference
and an ISO `recorded_at` timestamp. The tool echoes this attestation and the
publication key for caller audit logs; it cannot independently authenticate a
caller's evidence. Retain the underlying record privately.

Persist an attempt before calling a live add, keyed by publication and email.
Unknown outcomes require read-only reconciliation, including after a process
crash. Do not use inbox/unread status as processing state: booking notices may
already be archived. Never use approximate audience counts to verify an add.
