# `Electron backend command registry > defaults a malformed in-container Codex thread limit before shell interpolation` (`tests/unit/electron/commands-registry-servers.test.ts`)

- **ID:** 0010
- **Status:** resolved
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** test timeout after 5 seconds (reported duration: 15.88 s).
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test
  tests/unit/electron/commands-registry-servers.test.ts --only-failures` -> 14
  passed, 0 failed in 5.40 s.
- **Hypothesis:** the aggregate run timed out several unrelated process-heavy
  tests together. The owning file completed when isolated, but its 5.40-second
  file duration leaves little headroom under aggregate contention.
