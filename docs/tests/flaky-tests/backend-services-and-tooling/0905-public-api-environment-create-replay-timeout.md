# Public API environment-create replay test timed out under aggregate load

- **ID:** 0905
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `environment creation > replays converge; a changed payload under the same key conflicts`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts`
- **Change under test:** todo 0009 (`StorageService` split into repositories over one `StorageContext`). The storage code it exercises (projects, environments, public operations) was moved, not changed; the per-store write analysis is identical to `main`.
- **Original command:** `mise run test` on the 0009 branch while another worktree's full suite and a live Docker suite held most of the host's worker slots (the run queued for capacity first).
- **Aggregate result:** the test timed out at 5,000 ms (5,870.02 ms observed). Backend workspace totals: 11,530 tests across 680 files, 9 failed; the other 8 were tests that patched facade methods and were fixed in the same change.
- **Unchanged owner rerun:** `bun test src/core/public-api/public-api-projects.test.ts` (with four other owners) from `apps/backend` passed: 255 pass, 0 fail.
- **Hypothesis:** three `environment.create` calls, each creating a local worktree, did not finish inside five seconds on a saturated host. Unproven; no implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** the default five-second Bun test/hook budget was spent while the process was starved of CPU on a loaded host; the body is milliseconds to seconds of work when the host is idle and waits on no signal that could be made explicit.
- **Fix:** `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`) now sets the default per-test and per-hook budget to 60 s, a hang watchdog that a slow host does not trip. `apps/backend/src/core/public-api/public-api-projects.test.ts` has no smaller explicit budget (no `setDefaultTimeout`, third-argument or hook timeout, and no wall-clock deadline of its own), so the new default applies to it. No assertion, skip or production code changed.
- **Reproduced:** no. Not reproduced here (the host load average was 100 to 180 from other workers' runs, and a contention run of the owner did not finish); the class is established from the recorded timeouts at the 5 s default with the owner passing alone, not from a local failure.
- **Stress:** none specific to this case; the owner passes unchanged in this tree.
