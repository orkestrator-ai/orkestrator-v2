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

1. **Decide the startup error after stdio has ended**. Status: open.

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

**Investigation.** Still present on 2026-10-31. Flake 0723 recurred three
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

Race present; 0723 open.

## Outstanding work

### Code

1. The `close`-based decision with a bound, and a test that delivers `exit`
   before the `database is locked` chunk (a fake child can order them).
2. Then rerun 0723's owner in an aggregate and resolve the case if it holds.

## Constraints and rationale

- The retry must stay limited to the locked-database case and stop on
  shutdown, as now.

## Assumptions and decisions

- 2026-10-31: filed here, not in 0030, because it is a product bug (a missed
  retry and a wrong error), not test health.

## Open questions

- None.

## Needs verification

- That users hit it: a second OpenCode tab starting while another starts.

## Related

- [0030](../cross-cutting/0030-test-suite-and-ci-health.md), flake 0723.

## Replaces

- The 0723 note in 0030 item 7.
