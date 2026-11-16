# Gateway terminal socket: agent-test session expiry closed before the test listened

- **ID:** 9975
- **Status:** resolved
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

## Same run: unnumbered web observation

The same aggregate also failed one web test once. Its pipeline's ticket
reserved a single flake number (this case's), so that observation is kept
here rather than as a case of its own. Give it its own number in the
native-agents-and-transcripts group if it recurs. It recurred on 2026-11-11
and is now case
[9983](../native-agents-and-transcripts/9983-conversation-scroll-target-repeat-jump-highlight.md).

- **Test:** `useConversationScrollTarget > a repeat jump to the same message restarts the highlight; another moves it`
  in `apps/web/src/components/native-agent/useConversationScrollTarget.test.tsx`.
  No index entry matched this test or file, so it is not a counted
  recurrence of anything.
- **Failure:** line 88, `expect(result.current?.messageId).toBe("u-2")`
  received `undefined` (396.98 ms). The branch's changes do not reach the
  test's import graph.
- **Counts:** web 14,468 passed, 10 skipped, 1 failed; 14,479 tests across
  1,001 files in 478.67 s, same evidence log as above.
- **Isolated rerun:** the aggregate runner's automatic rerun of the unchanged
  owner passed alone: 11 pass, 0 fail, 2.17 s (one worker).
- **Hypothesis, unconfirmed:** the test runs a 200 ms highlight on wall-clock
  time. After the repeat jump it waits for the new generation and then sleeps
  a fixed 120 ms before checking the highlight is still shown; on a loaded
  host the `waitFor` plus the sleep can overrun the restarted 200 ms period.
  Nothing in the test was changed.
- **Next evidence:** if it recurs, drive the highlight timer with
  `installControlledTimeout` (`tests/helpers/controlled-timeout.ts`) instead
  of fixed sleeps, as the `sleep-before-negative-assertion` guard advises.

## Resolution (2026-11-15)

- **Class:** the test's own deadline (B).
- **Root cause:** confirmed by reading the code: the test set the session to expire at `Date.now() + 40` ms and only then opened, upgraded and authenticated the socket and attached its `close` listener after the `ready` frame. Any host slower than 40 ms there let the server's expiry timer close the socket first, so `once("close")` never settled.
- **Fix:** `apps/backend/tests/gateway-events.test.ts` gives the session a one-hour deadline, captures the server's expiry `setTimeout` (scheduled inside that window) while the socket opens, attaches the `close` listener before awaiting `ready`, asserts exactly one expiry timer was armed, then expires the session and fires that timer by hand. The close code assertion is unchanged.
- **Reproduced:** no — the unchanged test passed 30 of 30 under 10 pinned burners (`-t "agent-test session expires" --rerun-each=30`); the race is shown by the code, not by a forced failure.
- **Stress:** `mise run test:logged -- --name gw-cont3 -- bun scripts/test-under-contention.ts --core 4 --burners 6 -- bash -c 'cd apps/backend && bun test tests/gateway-events.test.ts tests/gateway-proxy.test.ts tests/gateway-sse-gzip-routes.test.ts --preload ../../tests/setup-node.ts --parallel=1'` passed (65.9 s); each file also passed alone with `--rerun-each=2` (208, 66 and 190 tests).
