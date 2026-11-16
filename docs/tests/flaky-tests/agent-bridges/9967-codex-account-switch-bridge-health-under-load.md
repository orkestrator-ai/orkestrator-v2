# Codex account-switch scenarios: the first codex bridge never answered health under backend-shard load

- **ID:** 9967
- **Status:** open
- **Date observed:** 2026-11-16
- **Test:** `automatic switching on the pinned codex > a planning turn stays a planning turn when it is resent`;
  `automatic switching on the pinned codex > two reviewers on one bridge each continue once, still read-only`
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
