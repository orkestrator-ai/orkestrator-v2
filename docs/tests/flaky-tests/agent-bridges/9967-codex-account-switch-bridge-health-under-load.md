# Codex account-switch scenarios: the first codex bridge never answered health under backend-shard load

- **ID:** 9967
- **Status:** open
- **Date observed:** 2026-11-16; recurred 2026-11-17
- **Test:** `automatic switching on the pinned codex > a planning turn stays a planning turn when it is resent`;
  `automatic switching on the pinned codex > two reviewers on one bridge each continue once, still read-only`;
  `automatic switching on the pinned codex > another limit moves nothing and resends nothing`
- **File:** `apps/backend/tests/account-switch-codex-live.test.ts` (scenarios in
  `apps/backend/tests/account-switch-resend-suite.ts:70`, runner
  `apps/backend/tests/account-switch-resend-runner.ts:89`)
- **Observed from:** branch `fix-ci-failures-7ca9b83095c2-r1`, base `4139b0fbf`.

## Failures

- CI pull-request run 43840522607 (#2329, `f811fa0c4`), job "Tests (backend)"
  133207717294: the planning-turn scenario failed after 31,528.69 ms;
  22,161 passed, 2 failed (the other was `pty.test.ts`, fixed in #2316).
- CI pull-request run 43840231380 (#2322, `ba12523d4`), job "Tests (backend)"
  133206777383: the two-reviewer scenario failed after 132,801.22 ms;
  22,162 passed, 1 failed.

Both runs show the same sequence in the scenario host's output: the backend
spawns the first codex bridge (`[local-server] bridge.started key=codex:...`)
while its boot-time Docker reachability check is pulling the probe image and
creating a probe network; the bridge prints nothing and never answers
`/global/health`; about 17.6–18 s later `start_local_codex_server_cmd` fails
with `Server on port N did not become healthy` and the backend stops the
bridge (`signal=SIGTERM requested=true`). In the first run the scenario exits
on that error; in the second the reviewers' resends never happen and the host
times out with `Timed out waiting for both reviewers' resends: []`.

The aggregate runner then reran `account-switch-codex-live.test.ts` alone on
the same runner and it passed both times (62.1 s and 63.9 s), so it is
classified as a load flake.

### Recurrence: 2026-11-17, the bridge could not bind its port

- CI pull-request run 44066977649 (#2370, `73e0ff7a9`, base `20824e14b`),
  job "Tests (backend)" 133983063644:
  `automatic switching on the pinned codex > another limit moves nothing and
  resends nothing` failed after 21,629.01 ms; 22,311 passed, 3 failed (the
  other two were the Multi Review `stepRuntimes.fix` assertions fixed on
  branch `fix-ci-failures-1ff35fad9dfc-r1`). Rerun alone on the same runner,
  `account-switch-codex-live.test.ts` passed in 51.2 s.
  `mise run flaky:recurrence -- 9967 --base 20824e14b` answered "open. Record
  the failure as a recurrence".
- This time the bridge did print: `error: Failed to start server. Is port
  37729 in use?`, then `codex server exited before becoming healthy (code 1)`
  from `start_local_codex_server_cmd` after 8.6 s. So in this recurrence the
  bridge never bound its port, which answers the open question above for at
  least one failure.
- Evidence-backed hypothesis for this failure: `allocateLocalPort()`
  (`apps/backend/src/core/commands-servers.ts`) binds port 0, reads the
  port, closes the listener and only then spawns the bridge on it. Another
  process on the host (a parallel test worker's server) can take the port in
  that gap. The same time-of-check race was fixed in the OpenCode 2 live tests
  (case 9974) with an OS-chosen port and `retryOnAddressInUse`. A user starting
  several local servers at once could hit it too, so the fix belongs in the
  product: retry the bridge start once on a fresh port when it exits with the
  port-in-use line, before the health wait.

## Investigation so far

- The codex bridge's `/global/health` (`bridges/codex-bridge/src/index.ts`)
  answers without waiting for app-server; it answers 503 only when the engine
  state is `failed` or its circuit is open. The backend's budget for a codex
  bridge is `LOCAL_SERVER_HEALTH_ATTEMPTS` (75 polls at 200 ms, about 15 s,
  `apps/backend/src/core/commands-server-health.ts`), against 120 polls for
  Cursor, Grok and Pi and 300 for OpenCode.
- The scenario output carries no bridge log lines for the failed start, so
  it cannot yet tell a bridge that had not bound its port from one that
  bound it and answered 503.
- The Claude half of the suite (`account-switch-claude-live.test.ts`) did not
  fail in the same runs.

## Hypothesis (unconfirmed)

A slow bridge cold start (bundle load plus app-server spawn) on a runner
saturated by the backend shard, overlapping the Docker probe, exceeds the
15 s codex health budget. A user on a slow or busy machine would hit the same
failed start, so the fix belongs in the product (a budget like the other
bridges', or health diagnostics in the failure) rather than in the test.

## Next steps

Reproduce under load first (four concurrent copies pinned to two cores, as
case 9901 did), capturing the bridge's stdout and the `/global/health` status
code per poll; then decide between a longer codex health budget and fixing
whatever keeps the bridge from answering.
