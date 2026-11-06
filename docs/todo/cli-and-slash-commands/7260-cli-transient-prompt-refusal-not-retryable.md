# A CLI prompt refused as temporarily unavailable looks like a permanent failure

Found on 2026-11-06 during to-do 0726 task 5, the live container run of the
Claude preference lock
([container-qualification.md](../../development/container-qualification.md#claude-preference-lock-with-a-reused-pid-docker-desktop-2026-11-06)).

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab74`.

### Tasks

1. **Mark a transient prompt refusal as retryable in the public API**: a prompt a bridge refused with 503 (nothing sent) should say so in the CLI envelope, so a script can tell "try again" from "this will never work". Status: open.

### 1. Mark a transient prompt refusal as retryable in the public API

**Problem.** When a bridge refuses a prompt with 503 before dispatch, `orkestrator
session prompt --wait` exits 1 with `error.code` `operation-failed`, no
`retryable` field, receipt `state: "failed"` and `dispatch: "rejected"`. The
message is the bridge's own ("The session's preferences are busy, so the
prompt was not sent. Try again."), but a script reads codes, not messages. The
same request key replays that failure (`replayed: true`, exit 1), as the
contract says it must, so the only way to retry is a new key, and nothing in
the envelope tells the script that a new key is safe and useful here.

**Context.** The public contract
([public-cli.md](../../architecture/public-cli.md#output-and-exit-codes))
makes `retryable` optional on `error` and lists `busy` under exit 8. A rejected
dispatch is not ambiguous, so a new key cannot run a prompt twice; AGENTS.md
forbids a new key only for ambiguous work. The renderer already shows a Retry
for the same refusal (0726, decision 6), so this is CLI-only.

**Investigation.**
- Seen live on 2026-11-06: a Claude container session with a preference lock
  held by a matching live owner (case E of the qualification above). The
  bridge answered 503 after its 5 s wait; the backend raised
  `ProviderUnavailableError` from `promptDispatchUnavailableError`
  (`apps/backend/src/core/http-bridge-transport.ts:507-518`). The session was
  not parked: once the lock was gone, a prompt under a new key ran at once.
- `dispatchIntentInternal` and `dispatchIntentUnderIntent`
  (`apps/backend/src/core/native-agent-service.ts:2000-2040` and after) return
  `{ outcome: "rejected", error }` with only a message, so the public API cannot
  tell this refusal from a closed tab or a parked dispatch.
- `dispatchOutcome` (`apps/backend/src/core/public-api/actions-sessions.ts:150-194`)
  maps every outcome other than `accepted` and `unknown` to `operation-failed`
  with no `retryable`. `session.prompt`, `session.start` and
  `session.command` (`actions-session-commands.ts:371-383`) all use it.
- `execute` in `public-api/dispatch.ts:390-423` already copies an outcome's
  `retryable` into the error, so only the outcome needs to carry it.
- Not checked: which other bridges answer 503 on prompt dispatch, and whether
  the mail and queue paths (which already map `ProviderUnavailableError` to
  `held: busy` in `dispatchMailInject`) need anything.

**Decisions.**

- **How does a transient refusal reach the CLI?**
  - **Add a `transient: true` marker to the `rejected` outcome when the cause is `ProviderUnavailableError` with no pending dispatch, and have `dispatchOutcome` return `retryable: true` for it, keeping `operation-failed` and exit 1 (recommended).**
    - Pros: additive and within the contract (`retryable` is already optional); no exit-code change for existing scripts; reuses the copy in `execute`.
    - Cons: scripts still need to read `retryable`; a new field on an internal outcome type.
  - **Map it to `busy` (exit 8).**
    - Pros: matches the exit table's "busy" row and the busy-session refusal.
    - Cons: changes the exit code a released CLI already returns for this case; `busy` means "a turn is running" elsewhere in the contract, which this is not.
  - **Leave it and document that the message says "Try again".**
    - Pros: no change.
    - Cons: scripts must parse a message, which the CLI guide tells them not to do.

## Constraints and rationale

- Never mark an ambiguous dispatch (`unknown`) or a refusal after journaling
  as safe for a new key: that could run a prompt twice.
- Receipts and errors stay content-free: the bridge's fixed reason is fine, a
  prompt is not.

## Related

- [0726 qualification record](../../development/container-qualification.md#claude-preference-lock-with-a-reused-pid-docker-desktop-2026-11-06).
- [public-cli.md](../../architecture/public-cli.md) (envelope and exit codes).
- [agent-engines.md](../../architecture/agent-engines.md#claude-code) (the 503 refusal).
