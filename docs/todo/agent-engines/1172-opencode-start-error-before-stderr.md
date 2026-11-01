# OpenCode server start decides its error before stderr has arrived

When a local OpenCode server exits during startup, the backend decides on the
child's `exit` event whether the exit was the shared database being locked
(which it retries) or a plain failure. stderr can still be arriving then, so
under load a locked-database exit is reported as a plain failure and is not
retried. Found as flake
[0723](../../tests/flaky-tests/backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md)'s
likely cause by the 2026-10-25 triage in
[0030](../cross-cutting/0030-test-suite-and-ci-health.md) (task 4).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`.

### Tasks

1. **Decide the startup error after stdio has ended**. Status: done
   (2026-11-01) in code and offline tests; 0723's aggregate recurrence check
   is still open.

### 1. Decide after stdio has ended

**Problem.** A second OpenCode server started while another holds the shared
database exits with `database is locked` on stderr. If `exit` fires before that
stderr chunk is read, the start fails with "opencode server exited before
becoming healthy" instead of waiting and retrying.

**Context.** `waitForLocalServerStartup` (`apps/backend/src/core/commands-servers.ts:298`)
collects `stderrTail` from `data` events and decides in `onExit` (`:326`)
through `openCodeStderrReportsLockedDatabase`. The retry loop is
`startLocalServer…` at `:674`, keyed on `isOpenCodeDatabaseLockedError`. Node
and Bun emit `close` after the child's streams end; `exit` can come first.

**Investigation.** Rechecked 2026-11-01 against `main` at `93b99bfba`: still
present, `onExit` decided the error synchronously from the stderr read so far.
Still present on 2026-10-31. Flake 0723 recurred three
times with exactly this shape: received "exited before becoming healthy (code
1)" right after the child printed `database is locked`, where the test
expected the retry path's "shutting down".

**Decisions.**

- **How?**
  - **Decide on `close` (stdio ended) instead of `exit`, with a short bound
    after `exit` in case a grandchild keeps the pipe open (recommended).**
    - Pros: the standard fix; stderr is complete when the decision is made.
    - Cons: needs the bound and a test for a held pipe.
  - **Wait a fixed grace after `exit` for more stderr.**
    - Pros: smallest change.
    - Cons: a timing heuristic, which the repository's timer rules discourage.

## Current state

Fixed 2026-11-01. `waitForLocalServerStartup` (`commands-servers.ts`) now
decides an OpenCode exit on the child's `close`, once stdio has ended, or
after `OPENCODE_STARTUP_STDIO_CLOSE_BOUND_MS` (1 s, `opencode-host-start.ts`)
following `exit`, whichever comes first, using the stderr read by then. A
health result that lands after `exit` is ignored. Other server kinds still
decide on `exit`, since only OpenCode's stderr is read. Tests in
`opencode-host-start.test.ts` (`waitForLocalServerStartup on an OpenCode
exit`) drive a fake child that emits `exit` before the `database is locked`
chunk, with and without a `close`; the first two fail on the old code. 0723
stays open until an aggregate run shows it gone.

## Outstanding work

### Code

1. ~~The `close`-based decision with a bound, and a test that delivers `exit`
   before the `database is locked` chunk.~~ Done 2026-11-01.
2. Rerun 0723's owner in an aggregate and resolve the case if it holds.

## Constraints and rationale

- The retry must stay limited to the locked-database case and stop on
  shutdown, as now.

## Assumptions and decisions

- 2026-10-31: filed here, not in 0030, because it is a product bug (a missed
  retry and a wrong error), not test health.
- 2026-11-01: took the recommended option, decide on `close` with a bound
  after `exit`, not a fixed grace after `exit`. A normal exit decides as soon
  as stdio closes, with no added wait.
- 2026-11-01: the bound is 1 s. A real exiting OpenCode closes its pipes at
  once, so the bound only matters when a surviving grandchild holds stderr
  open. It is longer than any stderr flush we expect and short against the
  start budget, and the start keeps the host turn for at most that much
  longer. Tests pass a shorter bound.
- 2026-11-01: only OpenCode waits for `close`. The other kinds' failure text
  does not depend on stderr, so they keep deciding on `exit` and gain no
  delay.
- 2026-11-01: once `exit` has fired, a later health success or failure does
  not decide the start. An exited server is a failed start, as before.

## Open questions

- None.

## Needs verification

- That users hit it: a second OpenCode tab starting while another starts.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md), flake 0723.

## Replaces

- The 0723 note in 0030 item 7.
