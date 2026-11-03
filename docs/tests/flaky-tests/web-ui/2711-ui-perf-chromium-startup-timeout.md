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

## R4 diagnostics review recurrence — 2026-11-03

Preparation ran `mise run test` at `ced9dbce70ca0cab52b304fb548b58e15af716c2`
with four backend workers and one root worker. The unnamed in-page deadlines hook exceeded 5000 ms (5004.61 ms).
Backend totals: 13,378 passed, 99 skipped, two failed. Root totals: 3,451 passed,
two failed, one error. Evidence: `.orkestrator/review-artifacts/review-validation-305987e4-d185-4d3f-bd05-a72e0c7df530/validation-04.stdout.txt`.

The unchanged complete owner passed alone (exit 0, 5.1 s):

```sh
mise run test:logged -- --name ui-deadlines-rerun -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

This establishes intermittent behavior, not a root-cause fix. No assertion,
timeout, skip, or unrelated implementation changed.

## R4 round 2 review preparation and main reproduction — 2026-11-03

Preparation at `3aa4546421145ebee86ecc8890e545a08825b9ef` repeated the same
unnamed hook timeout after 5004.65 ms in `mise run test` (one root worker).
Backend/root/web totals were 28,256 passed, two failed and 109 skipped; the other
failure was the preview idle socket assertion tracked in case 3101. Evidence:
`.orkestrator/review-artifacts/review-validation-0e5ecfc3-eaa5-4f5a-910f-d4fcb012f586/validation-04.stdout.txt`.

The owner and its imported performance probe have no diff in
`origin/main...HEAD`. A detached worktree at `origin/main` commit `b58d401e1`,
with its own frozen dependency install, first passed the unchanged owner alone
(exit 0, 8.9 s):

```sh
mise run test:logged -- --name r4-main-ui-deadlines-round2 -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

A repetition of that same owner on the detached main worktree reproduced the
same unnamed 5000 ms hook timeout in nine of ten runs (5000.62–5015.62 ms):

```sh
mise run test:logged -- --name r4-main-ui-deadlines-repeat -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --rerun-each=10 --only-failures
```

Totals: 60 passed, nine failed, 69 tests, 86.69 s. Evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.6VxcFo/r4-main-ui-deadlines-repeat.log.gz`.
This independently establishes the target-branch recurrence; its cause remains
unproven. No timeout, assertion, skip or unrelated code changed. The temporary
worktree was removed.
