# Restore preflight container batch timeout

- **ID:** 9911
- **Status:** open
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
