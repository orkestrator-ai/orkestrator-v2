# `Electron backend command registry > renames the live local git branch and advances stored branch on success` (`tests/unit/electron/commands-registry-environments.test.ts`)

- **ID:** 0012
- **Status:** resolved
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** test timeout after 5 seconds (reported duration: 16.35 s), followed
  by a late assertion observing `old-branch` instead of `review-oauth-flow`.
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test
  tests/unit/electron/commands-registry-environments.test.ts --only-failures` ->
  129 passed, 0 failed in 16.64 s.
- **Hypothesis:** the full owning file already takes longer than the per-test
  timeout and launches many fake Git/Docker processes. Aggregate contention
  delayed this case past its timeout; the late assertion is a timeout cascade.
