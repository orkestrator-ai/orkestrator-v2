# `json file cache > slices > shares a single parse between concurrent cold readers` (`bridges/claude-bridge/src/services/json-file-cache.test.ts:132`)

- **ID:** 0017
- **Status:** open
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the bridge group used six Bun workers.
- **Failure:** `getJsonFileParseCount()` was expected to be `1` but was `2` after
  the three concurrent readers returned their expected values (duration: 0.49
  ms).
- **Suite counts:** bridge group — 3,192 total, 3,180 passed, 11 skipped, 1
  failed across 120 files in 56.91 s.
- **Isolated rerun:** `bun --cwd=bridges/claude-bridge test
  src/services/json-file-cache.test.ts` -> 12 passed, 0 failed; the target
  passed in 0.32 ms.
- **Hypothesis:** the parse counter and cache are module-global test
  instrumentation, and the failure occurred only while the bridge worker was
  running the aggregate file set. The evidence establishes interference or
  scheduling sensitivity around that shared state, but does not identify which
  other reader or hook caused the second parse. A recurrence should capture the
  file path and fingerprint for each counted parse before changing the
  assertion.

### Recurrence — 2026-09-11

- **Command:** `mise run test` (full suite); `scripts/test-all.ts` ran four
  groups concurrently and the bridge group ran `claude-bridge:test:bridge`.
- **Failure:** the same assertion — `getJsonFileParseCount()` expected `1`,
  received `2` (duration: 0.91 ms).
- **Suite counts:** `claude-bridge:test:bridge` — 866 total, 1 failed, 1
  skipped across 30 files in 22.11 s; every other group passed.
- **Isolated rerun:** `bun --cwd=bridges/claude-bridge test
  src/services/json-file-cache.test.ts` -> 12 passed, 0 failed in 43 ms against
  the same tree.
- **Evidence artifact:** `/tmp/orkestrator-test-run.S0YCMv/bridges.log.gz`.
- **Note:** the working tree at recurrence time touched only the new global
  plan-usage read surface (`bridges/claude-bridge/src/index.ts`,
  `session-manager-catalog.ts` and their peers); `json-file-cache.ts` and its
  test were untouched, matching the aggregate-only timing shape of the original
  observation.
