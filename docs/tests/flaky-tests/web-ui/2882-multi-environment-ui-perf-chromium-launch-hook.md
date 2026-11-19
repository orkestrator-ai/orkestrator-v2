# Multi-environment UI perf: Chromium launch hook times out in the aggregate run

- **ID:** 2882
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `in-page deadlines > (unnamed)`, the `beforeAll` hook in
  `tests/unit/multi-environment-ui-perf.integration.test.ts` that calls
  `chromium.launch`.
- **Original command:** `mise run test`, on the renderer logger migration branch
  (`353f208b5`), with other worktrees' work on the same host.
- **Failure:** the hook failed at 5004.71 ms, which is Bun's default 5 s test timeout,
  while the group ran in parallel. The root group reported 3423 pass, 4 fail; the other
  3 failures are the deterministic terminal link tests, which also fail on `main`.
- **Isolated rerun:** `bun test tests/unit/multi-environment-ui-perf.integration.test.ts`,
  three times: 6 pass, 0 fail each, in about 4 s.
- **Hypothesis:** launching Chromium takes over 5 s while the aggregate run loads the
  host. Not reproduced under controlled load, and the changes on that branch do not
  touch this file or anything it loads, so this is unproven. If so, an explicit hook
  timeout would be the fix.

## CI recurrence and fix applied, 2026-11-03

GitHub Actions CI ("Unit and integration tests", `ubuntu-latest`, 4 cores) hit
this in four of six runs checked between `d6040915c` and `b0dcf1660` (for
example run 41549578197). There the first case's `browser.newPage()` ran past
Bun's 5 s test timeout (5000.39 ms), and the next two cases then failed at once
with "Target page, context or browser has been closed".

Branch `debug-ci-failures-a629816c8619-r1` gives the
`beforeAll` hook a 60 s budget and opens and closes a warm-up page inside it,
so Chromium's start-up cost is paid there, and gives each case a 30 s budget.
No assertion was changed. The timeout could not be reproduced locally: with
32 busy-loop processes on a 16-core host, both the old and new file passed
3 of 3 runs. Mark this resolved once CI on that change shows the file green.

## Sub-agent model setting — 2026-11-04

Recurred in `mise run test:logged -- --name full-test -- mise run test` on branch
`sub-agent-models-ed8b12224ab5-r1`, which does not touch this test or its
fixture: `in-page deadlines > (unnamed)` failed at 5001.58 ms (root group 3529
pass, 1 fail, 860.9 s) with the host at load average 83–96. Artifact:
`orkestrator-test-run.z5S1lI`. `bun test
./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1` passed
the unchanged file twice alone (5.4 s and 5.6 s).

### Resolution — 2026-11-06

Same failure and fix as [2711](2711-ui-perf-chromium-startup-timeout.md#resolution--2026-11-06):
the unnamed hook that kept timing out at five seconds after the 60 s
`beforeAll` budget landed is the `afterAll` that closes Chromium, which had no
budget of its own. It now has a 60 s budget. Verified with
`mise run test:logged -- --name web-ui-perf-afterall -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --rerun-each=5`
(exit 0).

## CI recurrence, reopened — 2026-11-19

- **Run:** GitHub Actions CI, job "Tests (root-bridges)" (`mise run test:full`,
  root and bridge groups, `ubuntu-latest`) on PR #2478
  (`fix-ci-failures-14e69818d3bd-r1`), run 44572759113, job 135732014471.
- **Base commit:** `5e9835d0a6`.
  `mise run flaky:recurrence -- 2882 --base 5e9835d0a6 --registry-ref origin/main`
  answered "resolved, and the base contains its fix (`ee2cc84234`). This is a
  real recurrence", so the case is open again.
- **Failure:** `in-page deadlines > (unnamed)` failed at 60000.28 ms: an unnamed
  hook of the describe block (the `beforeAll` that launches Chromium or the
  `afterAll` that closes it, both budgeted at 60 s) ran out its whole budget.
  The root group reported 5613 pass and this one failure in 450.4 s. The
  runner had just reported `killed 1 dangling process` for the previous file.
- **Isolated rerun:** the runner's own rerun of the unchanged file passed alone
  in 10.0 s.
- **Hypothesis:** unlike the earlier five-second failures, a full minute is
  not start-up cost under load: Chromium's launch or close hung rather than ran
  slowly. Not reproduced; no evidence yet says which hook it was. A next step
  is to bound `chromium.launch` and `browser.close` with their own shorter
  timeouts and name the hook in the failure, so a recurrence says which of
  the two hung.
