# Calendar booking consent sync

`node dist/calendar-sync.js CONFIG.json` runs a dry-run. Add `--write` only after
reviewing the dry-run and explicitly authorizing the recurring newsletter adds.
The helper uses Gmail's read-only CLI operations and calls the actual registered
MCP tools through an in-memory MCP connection. No Gmail labels or read states are
modified. Archived booking notices remain eligible for scanning.

Prerequisites: build this repository, install/authenticate `gws`, and configure
Substack credentials as for the MCP server. For a scheduled process, use the
existing encrypted session store from `substack-mcp-login` or an appropriate
secret provider; do not put session tokens in task arguments or this config.

Keep config, state, locks, and output logs outside any shared repository:

```json
{
  "organizer_email": "host@example.org",
  "publication_url": "https://example.substack.com",
  "publication_key": "default",
  "state_path": "/private/calendar-sync-state.json",
  "gws_command": "/path/to/gws",
  "days": 180,
  "max_messages": 200,
  "max_adds": 5,
  "send_welcome_email": false
}
```

On Windows point `gws_command` to the installed native `gws.exe`, not a `.ps1`
or `.cmd` shim. Execution uses an argument array and no shell, preserving Gmail's
JSON query parameters. `publication_key` must match a configured MCP publication
and its URL must match `publication_url`. Each publication/organizer pair needs
one canonical state file and one scheduler; do not run multiple state files for
the same audience. The state contains private email addresses, signup answers,
source message IDs, and timestamps. File modes are best effort on Windows; keep
the parent directory protected by the user's account ACL.

## Processing and recovery

The entire bounded Gmail scan finishes before any add is attempted. It accepts
original `Appointment booked:` notices whose From is the configured organizer
and Sender is Google's Calendar notification address. It reads nested plain-text
MIME, normalizes CRLF, and associates the answer with `Booked by`, not the guest
in the subject. These are structural sender checks, not independent signature
verification; use the organizer's authenticated Gmail account and preserve its
normal spam protections.

Only exact affirmative answers enter the add queue. The latest received answer
wins per email. Negative, ambiguous, duplicate-question, and already-subscribed
answers never trigger an add. A booking No does not remove an existing reader.

An exclusive lock prevents two runs using the same state. Every live attempt is
saved and fsynced before the MCP write. State is then replaced atomically.
Existing, verified, and blocked outcomes are terminal: the helper never re-adds
those addresses even if they later leave the newsletter. Unknown, interrupted,
busy, and retryable outcomes are **read-only reconciliation** on later runs.
The scheduled helper deliberately does not automatically retry even a retryable
MCP result. An operator can investigate and reset an individual attempt only
after establishing that retry is appropriate and no membership was created.

If a process is killed, its `.lock` may remain. Confirm the process is stopped
before removing that lock; preserve the state file. An `attempting` record is
treated as an unknown write, so removing a stale lock does not replay it.
Malformed state, mismatched publication configuration, and a scan exceeding the
message cap stop the run before new writes. Back up state before repairs.

Output is aggregate JSON only. Capture stdout/stderr to private files when
scheduling and monitor the task's exit status. `pending`, `blocked`, and `review`
counts identify records that may need inspection in the private state. Session
expiry, Gmail authentication, or a changed upstream response can stop the job;
there is no unattended login or credential refresh workaround in this helper.
