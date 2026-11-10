# Agent Mail service aggregate timing cluster

- **ID:** 0150
- **Status:** resolved
- **Date observed:** 2026-09-19
- **Tests:** `AgentMailService > converges the mailbox directory after tabs open
  and close`, `AgentMailService > delivers mail that arrives during a drain
  without retrying a held sibling`, and `AgentMailService > rechecks deferred
  delivery and injects as soon as the recipient is idle`
- **File:** `apps/backend/src/core/agent-mail-service.test.ts:306`
- **Original command:** `mise run test`
- **Worker configuration:** the aggregate workspace group ran package tasks in
  parallel; the backend suite used its normal Bun test runner configuration.
- **Failure:** the directory-convergence case still observed `agent` instead of
  `agent-2` after its fixed wait, the drain case observed zero dispatches, and
  the deferred-delivery case failed with `ENOENT` while renaming a temporary
  `agent-mail.json` in the test storage directory.
- **Isolated rerun:**
  `mise run test:logged -- --name agent-mail-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts --parallel=1 --only-failures`
  passed all owning-file tests unchanged in 2.0 seconds.

## Current assessment

This is a credible aggregate-only failure cluster. The first two symptoms occur
at fixed asynchronous convergence deadlines under aggregate contention. The
temporary-file rename failure may be teardown fallout after the earlier cases
miss those deadlines, but that relationship has not been established. Keep the
case open until the ordering and lifetime of Agent Mail's background writes are
made deterministic or repeated aggregate evidence identifies a narrower cause.

## Recurrence on 2026-10-11

The directory-convergence case timed out at 5001.72 ms during
`mise run test:logged -- --name final-suite -- mise run test`, using the testing
guide's macOS GNU-tool PATH. The workspace group used two slots and the backend
runner used `--parallel=1`; root, bridge, and protocol groups also ran on the
host. The owning file passed unchanged in 2.1 seconds with
`mise run test:logged -- --name agent-mail-final-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts --parallel=1 --only-failures`.
Aggregate evidence is in
`/tmp/orkestrator-test-run.w2YALW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No test was skipped or loosened.

## Recurrence on 2026-10-13 (project navigation validation)

The GNU-tool PATH command `mise run test:logged -- --name full-tests -- mise run test`
failed `AgentMailService > converges the mailbox directory after tabs open and close`
at 695.82 ms: the directory still contained `agent-2` after its removal and the
fixed 325 ms wait. Workspace packages used one Bun worker each with two package
tasks; root, bridge and protocol groups were also active.

Backend totals were 5,875 passed, 15 skipped and 27 failed across 329 files in
442.53 seconds. Twenty-two failures reproduced as tmux cleanup errors on this
host and are separate from this convergence flake.

The owning file passed unchanged, exit 0, in 4.7 seconds with the same PATH:
`mise run test:logged -- --name agent-mail-rerun -- bun --cwd=apps/backend test ./src/core/agent-mail-service.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

Evidence: `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The fixed-wait convergence failure matches this existing aggregate timing case.
No test was skipped or loosened.

Recurrence 2026-10-18: `AgentMailService > upgrade reconciles legacy refused mail (verifying, canonical session=false)` hit the 5000 ms deadline at 5013.63 ms in `mise run test:logged -- --name mcpq-full -- mise run test` on branch `qualify-mcp-inactive-apply-9ec53f801117` (no Agent Mail changes; heavily loaded host). The owning file passed unchanged alone (`bun test src/core/agent-mail-service.test.ts` from `apps/backend`: 39 pass, 0 fail, 2.7 s). Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.O8FSrv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Resolution (2026-11-10)

- **Root cause:** the test, not the product, in two parts.
  1. *Fixed deadlines.* The service synchronizes mailboxes on a 250 ms
     debounce and drains injections in the background. The
     directory-convergence case slept a fixed 325 ms after each layout save.
     The drain case polled at most 50 × 5 ms for the first dispatch and for
     the second message's injection. A worker that runs that background work
     later than those windows produces exactly the recorded symptoms: the
     opened or closed tab not yet converged, and zero dispatches.
  2. *Leaked service.* The drain and deferred-delivery cases called
     `service.shutdown()` inside `try`. When an earlier assertion failed, the
     service, its timers and the held drain kept running after `finally`
     removed the data directory. Their writes then failed in whichever test ran
     next. That is the recorded `ENOENT` on `agent-mail.json`; on today's
     SQLite storage the same orphaned write fails as `SQLITE_IOERR_VNODE`.
- **Fix:** in `apps/backend/src/core/agent-mail-service.test.ts`:
  - A small `eventually` helper polls the observable condition: the mailbox
    present, then absent; the first dispatch; the second message injected.
    It gives up after 4 s, below Bun's 5 s test deadline.
  - The drain and deferred-delivery cases release the held dispatch and shut
    the service down in `finally`.
  - Every assertion is unchanged.
- **Reproduced:** yes. The injected delays were a temporary
  `await Bun.sleep(400)` before each drain pass and before each debounced
  mailbox sync in `agent-mail-service.ts`.
  - Before the fix, all three recorded tests failed (`b39-0150-repro`):
    `Expected to contain: "agent-2"` with `[ "agent" ]`, `Expected: 1,
    Received: 0` dispatches, then `SQLiteError: disk I/O error` attributed to
    the deferred-delivery test.
  - After the fix, with the same delays, all three passed
    (`b39-0150-fixed-delay`).
- **Not covered:** the 2026-10-18 recurrence of a different test, `upgrade
  reconciles legacy refused mail`, at Bun's 5 s deadline. That test runs a
  heavy restart fixture and has no fixed wait; it was not reproduced, and this
  fix does not claim it. Record it as its own case if it recurs.
- **Stress:** `mise run test:logged -- --name b39-0150-stress -- bun scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-mail-service.test.ts --rerun-each=10`
  passed (the whole owner, 10 reruns).
