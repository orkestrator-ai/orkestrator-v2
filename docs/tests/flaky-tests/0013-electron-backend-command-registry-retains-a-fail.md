# `Electron backend command registry > retains a failed pending rename so a later backend start can retry it` (`tests/unit/electron/commands-environment.test.ts`)

- **ID:** 0013
- **Status:** open
  standalone command that reproduced it
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** `Timed out waiting for failed pending rename to settle` (reported
  duration: 15.92 s).
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test tests/unit/electron/commands-environment.test.ts
  --only-failures` -> 8 passed, 0 failed in 0.78 s.
- **Hypothesis:** the polling deadline expired during the same aggregate run
  that starved several unrelated process-heavy tests. The isolated case settled
  promptly; no product-code relationship to transcript annotations was found.
