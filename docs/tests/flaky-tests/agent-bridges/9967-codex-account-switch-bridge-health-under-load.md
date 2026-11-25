# Codex account-switch scenarios: the first codex bridge never answered health under backend-shard load

- **ID:** 9967
- **Status:** open
- **Date observed:** 2026-11-16; recurred 2026-11-17, twice on 2026-11-18 and twice on 2026-11-20
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

### Recurrences: 2026-11-18, the port race twice on `main`

- CI push run 44389506740 (`main` at `d7a4bddbc`, PR run 44388794647 on
  #2443 the same way), job "Tests (backend)" 135100499368:
  `a planning turn stays a planning turn when it is resent` failed after
  18,482.73 ms. The codex bridge printed `error: Failed to start server. Is
  port 41103 in use?`, yet the next request failed with `codex session
  creation failed (HTTP 401): Unauthorized`: the backend's unauthenticated
  `/global/health` probe had reached *another process's* bridge on that port
  and reported ours healthy, and the other bridge refused our token.
- CI push run 44397068885 (`main` at `fcfe663f0`), job "Tests (backend)"
  135129703836: `two reviewers on one bridge each continue once, still
  read-only` failed after 135,486.52 ms with `Timed out waiting for both
  reviewers' resends: []`, after the replacement codex bridge printed `Is port
  46777 in use?` and exited (code 1, unrequested).
- `mise run flaky:recurrence -- 9967 --base fcfe663f0` answered "open. Record
  the failure as a recurrence".

### Fix for the port race (branch `fix-ci-failures-96c9e88bb5cb-r1`)

The product fix the recurrence above proposed, in
`apps/backend/src/core/local-server-port-taken.ts` and
`waitForLocalServerStartup`/`startLocalServerUnlocked`
(`apps/backend/src/core/commands-servers.ts`):

- A bridge that prints Bun's `Is port N in use?` (or `EADDRINUSE`) fails its
  start with `LocalServerPortTakenError` at once, including when the exit is
  observed before the line (its output drains for up to 250 ms first).
- A healthy answer is confirmed against the start's own token with
  `/global/auth-check`; an explicit 401 means another server holds the port
  (also a `LocalServerPortTakenError`). Any other answer, including a 404
  from a fake without the route, is accepted as before.
- `startLocalServerUnlocked` retries that error on a freshly allocated port,
  up to three attempts, logging `local-server bridge.port-taken`. Any other
  failure, and any failure during shutdown, is not retried.
- Covered by `apps/backend/src/core/local-server-port-taken.test.ts`. The
  owning file `apps/backend/tests/account-switch-codex-live.test.ts` passed
  alone after the change (28.4 s). Not yet proven under the CI load that
  produced the race; the health-timeout mode from 2026-11-16 is not addressed
  by this fix, so the case stays open.

### Recurrences: 2026-11-20, after the port-race fix

Both recurrences were checked with `mise run flaky:recurrence`, which answered
"open. Record the failure as a recurrence" for base `a01039913` and for base
`918d7caaf`. Both came after the port-race fix merged.

- CI push run 44743899361 (`main` at `a01039913`), job "Tests (backend)"
  136314180655: `two reviewers on one bridge each continue once, still
  read-only` failed after 49,600.33 ms at
  `account-switch-resend-suite.ts:137`. `evidence.bridgePids` had three
  entries where two were expected, so one bridge start too many happened.
  The shard printed no scenario output for it, so it does not show whether
  the extra start was a port-taken retry or a restart. Backend shard: 23,755
  pass, 1 fail. The file passed alone on the same runner (47.8 s).
- CI pull-request run 44783881191 (#2516, `9d821d0f1`, base `918d7caaf`),
  job "Tests (backend)" 136453472421: `a 5-hour refusal continues on the new
  account` failed after 31,033.63 ms with the 2026-11-16 symptom,
  `start_local_codex_server_cmd` failing after 16,041 ms with `Server on port
  33813 did not become healthy`. This time the bridge printed its ready line
  (`Orkestrator bridge listening on port 33813`) before the backend stopped
  it, so it did bind. The output has no timestamps, so it cannot show whether
  the line came early or only just inside the 15 s budget, which
  `waitForLocalServerStartup` counts from spawn, cold start included. The
  boot Docker reachability probes (about 3.4 s and 3.8 s) ran at the same
  time again. The file passed alone on the same runner (58.4 s).

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

## Recurrence: CI on pull request #2541 (2026-11-23)

The "Tests (backend)" job of run 45091972925 (head `f1dee962c`, base
`307d19317`) failed `two tabs stopped together each continue once` and
`another limit moves nothing and resends nothing`. Both reported
`Server on port <n> did not become healthy` after about 16 s
(`start_local_codex_server_cmd ... outcome=failed`). The branch adds
Antigravity's own port and process fields to the local-server code and does
not change how a Codex bridge starts or is health-checked. Run alone on
beelink2 (16 CPUs) the owning file passed:

```sh
env -u NODE_ENV mise run test:logged -- --name account-switch-codex -- \
  bash -c 'cd apps/backend && bun test tests/account-switch-codex-live.test.ts'
```

PASS in 29.1 s. `mise run flaky:recurrence -- 9967` reported the case open.

## Recurrence: CI on pull request #2554 (2026-11-24)

The "Tests (backend)" job 138464329706 of run 45399580419 (head `c4506674d`,
base `9a9b5f8df`) failed `another limit moves nothing and resends nothing`
after 31,219.06 ms: `start_local_codex_server_cmd` failed after 15,508 ms with
`Server on port 34921 did not become healthy`. The boot Docker reachability
check ran at the same time again (probe image pull 1,445 ms, probes 4,403 ms
and 3,793 ms). Rerun alone on the same runner the file passed (59.1 s).
`mise run flaky:recurrence -- 9967 --base 9a9b5f8df --registry-ref origin/main`
answered "open. Record the failure as a recurrence".

Not reproduced on beelink2: the complete owning file passed pinned to two
cores (`taskset -c 12,13`, 10 pass, 48.2 s) and to one (`taskset -c 12`,
10 pass, 83.6 s). CPU starvation of the test process alone therefore does not
produce it, which leaves the shared runner's Docker or disk work. No product
budget was changed.

## Change (2026-11-25, unverified on CI)

Every health-timeout failure recorded here has the boot Docker reachability
check in the same seconds: each of the ten concurrent scenario hosts pulled an
image, created a network and ran two probe containers. Disposable test backends
are meant to turn it off (`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, as the CLI
scenarios do); `stackEnvironment` (`apps/backend/tests/account-switch-stack.ts`)
builds its environment from scratch and did not. It does now. No product budget
changed.

- **Reproduced:** no. This host has no Docker access. CPU starvation alone does
  not produce it: with the Codex owner limited to 60 % and 30 % of one CPU
  (`systemd-run --user --scope -p CPUQuota=`), scenarios ran past their own
  deadlines but no bridge start failed its health wait (the slow ones took
  3.5 to 4.2 s).
- **Verified:** the Codex owner passes with the check off, beside the container
  replacement and checkpointer files (83 pass).
- **Stays open** until the CI backend shard has run with it. A recurrence
  without the check running would point back at the 15 s budget.
