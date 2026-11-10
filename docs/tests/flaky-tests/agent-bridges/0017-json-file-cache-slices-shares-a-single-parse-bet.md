# `json file cache > slices > shares a single parse between concurrent cold readers` (`bridges/claude-bridge/src/services/json-file-cache.test.ts:132`)

- **ID:** 0017
- **Status:** resolved
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

## Resolution (2026-11-10)

- **Status:** resolved, as a duplicate of
  [0146](0146-json-file-cache-concurrent-cold-readers.md), the same test and
  assertion recorded a week later and resolved on 2026-09-18.
- **Root cause:** a real cache race (from 0146's resolution). Each cold
  reader joined the in-flight parse only after its own `stat`. When the first
  reader's parse finished and dropped the shared promise before a slower
  reader's `stat` returned, that reader parsed the unchanged file again,
  which is the count of 2 recorded here.
- **Fix:** `42933c4b1` (`fix: stabilize clipboard, fork fallback, and
  json-file-cache races`, #786). `readJsonSliceCachedWithDigest` in
  `bridges/claude-bridge/src/services/json-file-cache.ts` joins a per-file
  read cohort before its first await, and the parsed promise stays shared
  until every overlapping reader leaves. No change in this sweep.
- **Reproduced:** no — not re-run against the pre-fix code, because that
  version lacks the `setJsonFileCacheBeforeStatForTesting` seam the
  deterministic test uses. That test, `keeps a completed parse for concurrent
  readers whose metadata is delayed`, came with the fix: it holds the later
  readers' `stat` until the first parse has completed. No recurrence since
  2026-09-11.
- **Stress:** `mise run test:logged -- --name claude-json-cache-0017 -- bun test --cwd bridges/claude-bridge --preload ../../tests/setup-node.ts ./src/services/json-file-cache.test.ts --parallel=1 --rerun-each=100`
  passed (exit 0).
