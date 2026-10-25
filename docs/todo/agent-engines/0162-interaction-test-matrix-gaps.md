# Interaction test matrix gaps

Checked against `main` at `00a0cb82` (2026-10-25).

Found by the "Needs verification" item of
[0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md),
which asked whether every bridge has per-kind tests for park, render, resolve
and fail-closed timeout. The audit on 2026-10-25 found tests for most cells;
these are the cells without one. No behaviour is known to be broken: every
gap below shares code with a kind that is tested.

## Current state

- There is no interaction conformance suite. Each bridge tests its own
  kinds, and `apps/backend/src/core/agent-provider-interactions.test.ts`
  covers the backend mapping and resolve paths.
- The backend never enforces a deadline; each bridge denies on its own
  timer (`native-agent-interaction-tracker.ts`).
- OpenCode publishes no deadline at all (`opencode-interactions.ts`), so an
  unanswered OpenCode question or permission waits until the user answers,
  the session closes or the turn is aborted. It never approves.
- OpenCode's capability row claimed `command-approval` and `file-approval`,
  which its mapper never emits; corrected to `question` and `permission` on
  2026-10-25.

## Outstanding work

### Code

1. **Timeouts for every kind on a shared timer.** Add expiry tests for the
   kinds whose timer is tested only through another kind: Claude
   `file-approval` and `permission` (the Bash test in
   `session-manager-parked-interactions.test.ts`), Codex `file-approval` and
   `permission` (`server-request-router.test.ts`), Grok `command-approval`
   and `file-approval` with detail (`acp-request-expiry.test.ts`), and Pi
   `file-approval` (`interactions-gate.test.ts`).
2. **`mcp-url` expiry** on Claude and Codex; only form mode has an expiry
   test.
3. **Backend mapping fixtures** for Claude `file-approval`, Grok's generic
   `permission`, and a Pi-shaped approval (Pi goes through the Codex mappers
   with no Pi fixture).
4. **Bridge-route coverage**: Claude `mcp-url`, `file-approval` and
   `permission` listed through `GET /session/:id/interactions`; Grok
   plan-approval resolved through its HTTP route and a positive Grok
   file-approval resolve; Pi `file-approval` parked and resolved through
   `requestToolApproval`.
5. **OpenCode abort**: a test that aborting a turn rejects its pending
   permissions and questions, as closing the session already does
   (`opencode-provider-close.test.ts`).

### Qualification

- None; these are unit tests.

## Constraints and rationale

- Approvals fail closed: a timeout, disconnect or malformed answer denies
  (AGENTS.md invariant 10).

## Open questions

- Should OpenCode get a backend-enforced deadline, so an unattended OpenCode
  session cannot wait forever on a permission? Today the owner's policy
  answers it at once, so only an interactive tab waits.

## Needs verification

- None.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
  ("Needs verification").

## Replaces

- The first "Needs verification" item of 0001.
