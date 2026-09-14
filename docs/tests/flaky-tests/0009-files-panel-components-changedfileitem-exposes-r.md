# `Files panel components > ChangedFileItem exposes revert and delete context actions` (`tests/unit/components/FilesPanel.test.tsx`)

- **ID:** 0009
- **Status:** resolved
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** test timeout after 5 seconds (reported duration: 15.80 s).
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test tests/unit/components/FilesPanel.test.tsx
  --only-failures` -> 23 passed, 0 failed in 0.36 s.
- **Hypothesis:** the same aggregate run produced several unrelated five-second
  timeouts at approximately 16 seconds. The fast isolated pass supports host or
  worker starvation, but the source of that starvation is not yet identified.
