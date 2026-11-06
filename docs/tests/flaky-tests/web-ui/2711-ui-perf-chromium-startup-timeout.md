# UI performance probe Chromium startup timeout

## R6a review repair recurrence — 2026-11-04

Preparation at `720ef1bed740706a65bd311e9e74f8bf78e77b2b` ran
`mise run test:logged -- --name review-default-tests -- mise run test`.
`in-page deadlines > (unnamed)` failed in a lifecycle hook at 5004.94 ms;
root/support totals were 3,529 passed and one failed. The scheduler selected
the worker configuration. Original output is preserved at
`.orkestrator/review-artifacts/review-validation-6f788315-ee40-4537-8a7a-e80b8b9652b4/validation-04.stderr.txt`
(lines 610–612). The package marked this `undetermined`, with reasons
`known-flaky` and `test-file-unknown`; the output identifies the owner above.

The complete unchanged owner passed alone, exit 0 in 5.3 s:

```sh
mise run test:logged -- --name fix-ui-deadlines-owner -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

No browser hook, timeout, assertion or performance probe was changed. This
remains an intermittent failure without a demonstrated cause; the historical
target-branch reproductions below do not establish this occurrence's cause.
The aggregate rerun result is recorded separately in this round's fix result.

The first exact aggregate rerun passed in 313.1 s after the logging fixes.
After the coordinator test-ordering repair, the same command at
`315d6953c72e238ea85281abb5cd2f800b32f2e3` failed in 325.6 s with this
unnamed lifecycle-hook timeout at 5005.63 ms. Root/support again reported
3,529 passed and one failed. Backend passed (14,069 passed, 102 skipped);
web had a separate grouping-delivery failure (case 1531). Scheduler grants
were five workspace slots, one root slot and two bridge slots.

Final aggregate evidence:
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.Cj4lpa/review-default-tests.log.gz`
(lines 2956–2958); inner group evidence is under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.kVPV5d/`.

The complete unchanged owner passed again, exit 0 in 5.1 s:

```sh
mise run test:logged -- --name fix-final-ui-deadlines-owner -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

The owner and performance probe have no diff in `origin/main...HEAD`.
The preparation triage remains `undetermined`; neither the isolated pass
nor the earlier green aggregate establishes a cause. No unrelated hook or
timeout was changed. The final failed aggregate remains a verifier limitation.

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

## R4 round 3 review repair — 2026-11-03

Preparation at `8d022cf9b` repeated the unnamed 5000 ms hook timeout at
5018.17 ms (`mise run test`, one root worker). Original evidence:
`.orkestrator/review-artifacts/review-validation-00bb3ca2-3d93-47b8-a736-2f3fd4bf7ab4/validation-04.stdout.txt`.
The owning test and imported performance probe have no diff in
`origin/main...HEAD`.

A detached `origin/main` worktree at `5161688cf`, with independently installed
frozen dependencies, reproduced the same hook timeout at 5001.64 ms in the
third repetition (18 passed, one failed, 23.28 s total).

```sh
mise run test:logged -- --name r4-main-ui-round3 -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --rerun-each=3 --only-failures
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.81RZZF/r4-main-ui-round3.log.gz`.
This confirms the target-branch recurrence without establishing its cause.
No unrelated implementation, timeout, assertion or skip changed.

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

## Security branch main merge — 2026-11-04

While merging `56ff6101a` into `b8bf951e1`, the logged default aggregate
(`mise run test:logged -- --name merge-tests -- mise run test`, one root worker)
reported `in-page deadlines > (unnamed)` at 5001.34 ms. The root group finished
with 3534 pass and 1 fail across 175 files in 275.29 s.

The unchanged owner passed alone:

```sh
mise run test:logged -- --name merge-root-failure -- bun test ./tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

The rerun exited 0 in 4.2 s. Aggregate evidence is
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.GQY0uW/root-and-agent-support-tests.log.gz`.
This is another aggregate-only timeout observation; the cause remains unproven.
No timeout, assertion or skip changed.

## Coordinator transcript review recurrence — 2026-11-06

At commit `decf86b98`, `mise run test:logged -- --name review-default-tests -- mise run test`
ran the root group with one worker alongside five workspace and two bridge
slots; a nine-worker component-browser suite was also active. The in-page deadlines startup hook exceeded 5 s at 5003.64 ms.
The root group finished with 3,638 passed, 10 failed and two errors across
185 files in 821.36 s. Its other failures are not attributed to this case.
Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.JSZUOY/root-and-agent-support-tests.log`
(compressed when the aggregate finishes).

The unchanged complete owner passed alone with exit 0 in 18.3 s:

```sh
mise run test:logged -- --name review-ui-perf-owner -- bun test tests/unit/multi-environment-ui-perf.integration.test.ts --parallel=1 --only-failures
```

Passing output was deleted by the logged runner, so individual passing case
counts were not retained. This branch changes neither this owner nor its
implementation. No assertion, timeout or skip changed. The isolated pass
establishes intermittence; it does not establish the underlying cause.
