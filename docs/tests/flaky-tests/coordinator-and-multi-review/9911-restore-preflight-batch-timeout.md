# Restore preflight container batch timeout

- **ID:** 9911
- **Status:** resolved
- **Date observed:** 2026-11-09

Test: `restore preflight deadline > covers multiple container batches beyond the floor`
in `apps/backend/src/core/change-tracking/restore-preflight.test.ts`.

Observed on `project-scheduling-ac146edab2ff-r1`, base
`3cf3dd7994cb36954f0670430216a71c7b6505d9`. No existing group index entry
matches this test; this is a new observation, not a counted recurrence.

Original command: `mise run test:logged -- --name address-full-tests -- mise run test`.
The workspace group had five slots alongside root (one), bridges (two), protocol
(one), and a five-worker browser suite. The test exceeded its 30,000 ms deadline
at 32,848.47 ms. Late work then raised `expected a preview, got disabled` at
line 174. Other independent checks also failed; no complete aggregate count
was available when the owner was rerun. Evidence: the workspace log under
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.mX02WE/`.

The unchanged owning file passed with
`mise run test:logged -- --name restore-preflight-isolated -- bun --cwd=apps/backend test src/core/change-tracking/restore-preflight.test.ts --parallel=2 --only-failures`
(exit 0, 23.5 s). The logged runner removed passing output, so no isolated
count is claimed. The test constructs 5,001 files and exercises multiple
container transport batches; that work and concurrent host activity were
observed, but no cause has been established. No deadline, assertion or
implementation changed. The isolated pass does not replace the failed
aggregate or establish an environmental exemption.

## Resolution (2026-11-15)

- **Class:** the test's own budget and deadline (B).
- **Root cause:** `apps/backend/src/core/change-tracking/restore-preflight.test.ts` gave the `test.each` a third-argument budget of 30,000 ms, below the 60 s default, for a case that creates 5,001 real files, captures them and describes them in two 5,000-path batches; the product's preflight deadline for that case was also real time (`40 + 10 ms x 5,001` = about 50 s). The recorded `expected a preview, got disabled` at line 174 is the product's preflight deadline expiring (or the late work after the 30 s test timeout) on a slow host.
- **Fix:** the third-argument budget is removed (the file inherits `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets Bun's default per-test and hook budget to 60 s); the per-path budget of the multi-batch case is raised to 100 ms per path and its ceiling to 600 s, and the sibling `a plan that outlasts the floor still previews` case's per-path budget to 5,000 ms (ceiling 600 s). What is asserted is unchanged: the deadline grows past the 40 ms floor with the plan and covers every batch, and a batch that exceeds a deadline with no per-path allowance is refused (`perPathMs` 0 and a 70 ms batch against 40 ms, unchanged). No product constant changed.
- **Reproduced:** no. The failing aggregate load was not reproduced on this host.
- **Verified after the fix:** the complete owner passed `--core 14 --burners 6 --rerun-each=3` (75.0 s) and, after the sibling case's per-path value was raised, once more under the same contention (28.8 s).
