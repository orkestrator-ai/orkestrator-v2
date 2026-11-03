# UI performance probe Chromium startup timeout

- **ID:** 2711
- **Status:** open
- **Observed:** 2026-11-02, merging `d7054dace` into logger branch `8f174e4db`.
- **Test:** `in-page deadlines > (unnamed)` (the suite's `beforeAll` launches Chromium).
- **File:** `tests/unit/multi-environment-ui-perf.integration.test.ts`.
- **Original command:** `mise run test:logged -- --name merge-default-tests -- mise run test`.
- **Workers:** default scheduler; workspace five slots, root one, bridges two,
  protocol one.

The root group reported the hook timeout at 5021.91 ms against its 5000 ms
budget. It finished with 3417 pass and five failures; the other four failures
were an account-marker assertion and three Claude terminal-routing assertions
that still failed alone. The workspace also contained known shifted-link
failures and the merge's duplicate logger declarations, since fixed.

The complete unchanged owner passed alone through
`mise run test:logged -- --name merge-rerun-ui-perf -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures`
(exit 0, 4.7 s). No timeout or assertion was loosened.

Hypothesis: Chromium startup exceeded the hook budget during concurrent test
groups. The aggregate report identifies only the unnamed hook; it does not
establish a specific browser failure or a root cause.

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.0XP13L/root-and-agent-support-tests.log.gz`.


The corrected merge's second aggregate (`merge-default-tests-recheck`) repeated
the same unnamed hook timeout at 5001.94 ms (root 3417 pass, five fail).
Evidence is `orkestrator-test-run.LvO7CJ/root-and-agent-support-tests.log.gz`
below the same host temporary directory. The aggregate exited 1 in 282.9 s.

## Pipeline restart/delivery main merge recurrence, 2026-11-02

Merging `508995a94` into `8b44911fb` repeated the unnamed startup-hook
failure at 5003.24 ms in
`mise run test:logged -- --name remerge-default -- mise run test`.
The root group used one worker under the default aggregate scheduler.
The complete unchanged owner passed alone, exit 0 in 5.1 seconds:
`mise run test:logged -- --name remerge-perf-alone -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures`.
No test, assertion or timeout was changed. This remains consistent with the
existing host-load hypothesis without establishing a cause.

Aggregate evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.GuWhdd/root-and-agent-support-tests.log.gz`.

The completed aggregate root group reported 3,441 pass and 5 fail; the full
aggregate exited 1 after 294.0 seconds.

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
