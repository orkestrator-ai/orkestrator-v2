# Public API environment-create replay test timed out under aggregate load

- **ID:** 0905
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `environment creation > replays converge; a changed payload under the same key conflicts`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts`
- **Change under test:** todo 0009 (`StorageService` split into repositories over one `StorageContext`). The storage code it exercises (projects, environments, public operations) was moved, not changed; the per-store write analysis is identical to `main`.
- **Original command:** `mise run test` on the 0009 branch while another worktree's full suite and a live Docker suite held most of the host's worker slots (the run queued for capacity first).
- **Aggregate result:** the test timed out at 5,000 ms (5,870.02 ms observed). Backend workspace totals: 11,530 tests across 680 files, 9 failed; the other 8 were tests that patched facade methods and were fixed in the same change.
- **Unchanged owner rerun:** `bun test src/core/public-api/public-api-projects.test.ts` (with four other owners) from `apps/backend` passed: 255 pass, 0 fail.
- **Hypothesis:** three `environment.create` calls, each creating a local worktree, did not finish inside five seconds on a saturated host. Unproven; no implementation, assertion, timeout or skip changed.
