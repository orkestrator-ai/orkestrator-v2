# Gateway terminal socket: agent-test session expiry closed before the test listened

- **ID:** 9937
- **Status:** open
- **Date observed:** 2026-11-11

Test: `gateway terminal WebSocket > closes a cookie-authenticated terminal socket when its agent-test session expires`
in `apps/backend/tests/gateway-events.test.ts`.

The group's only other row for this file, 6064 (resolved), covers different
tests; this records a new case, not a counted recurrence.

## Observation

- **Branch:** `tmux-loop-graph-54120f5545fd-r1`, base `498b68766` (`main`).
  The branch changes recurring backend work (graph-run and Multi Review
  cadence, the tmux tab poll loop, change-evidence pulls, agent-mail
  presence) and nothing in the gateway, its browser sessions or the terminal
  WebSocket server. The test reaches changed modules only because the gateway
  imports the backend app.
- **Original command:**
  `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name default-tests-skip-guards -- mise run test`
  (default tier, all groups concurrently on the local Linux host; guards were
  skipped because a source guard on an untouched file fails on `main`).
- **Failure:** `this test timed out after 5000ms` (5,009.56 ms).
- **Counts:** backend 18,384 passed, 150 skipped, 1 failed; 18,535 tests
  across 1,278 files in 397.34 s, beside the web package's 1,001-file run.
  Evidence:
  `orkestrator-test-run.WNJnWU/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  under the host temporary directory.

## Isolated rerun

The aggregate runner's automatic rerun of the unchanged owner passed alone:
104 pass, 0 fail, 4.99 s (one worker).

## Assessment

Hypothesis, unconfirmed: the test shortens the session deadline to
`Date.now() + 40` ms, then opens the socket and awaits the `ready` frame
before it attaches its `close` listener. If opening and authenticating take
longer than the 40 ms on a loaded host, the expiry timer closes the socket
before the listener exists, and the `once("close")` promise never settles.
No budget, assertion or retry was changed for this record.

## Next evidence

If it recurs, attach the close listener before awaiting `ready` (or derive
the deadline from the moment the socket authenticated) and check whether the
socket had already closed when the listener was added.
