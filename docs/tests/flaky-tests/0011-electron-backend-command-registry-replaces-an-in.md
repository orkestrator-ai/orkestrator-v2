# `Electron backend command registry > replaces an in-container Codex bridge that has no usable persisted token` (`tests/unit/electron/commands-registry-servers.test.ts`)

- **ID:** 0011
- **Status:** resolved
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** an unhandled bridge-startup rejection reached the real Docker
  executable and reported `No such container: container-codex-legacy`
  (reported duration: 0.52 s).
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test
  tests/unit/electron/commands-registry-servers.test.ts --only-failures` -> 14
  passed, 0 failed in 5.40 s.
- **Hypothesis:** this followed a timeout in the same owning file, and the
  missing fake-Docker interception is consistent with cleanup or fixture state
  being disrupted by that timeout. Isolation did not reproduce the escape.
