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
