# Host GitHub credential fixture probe times out in the root suite

- **ID:** 0190
- **Status:** resolved
- **Date observed:** 2026-10-11
- **Test:** `Electron backend command registry > reports whether the selected host GitHub CLI credential is available`.
- **File:** `apps/backend/tests/commands-registry-tools.test.ts`.
- **Original command:** `mise run test:logged -- --name root-isolated-final -- bun test ./tests/unit --parallel=3 --only-failures`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** three isolated Bun workers.
- **Failure:** the five-second deadline expired (reported duration 6026.48 ms), with a pending fixture probe reporting `available: false` after its process was killed. The root run reported 4968 passed, 24 skipped, 1 failed and 1 unhandled error across 250 files in 160.02 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.SEv856/root-isolated-final.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name tooling-isolation -- bun test ./apps/backend/tests/commands-registry-tools.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed (exit 0, 0.5 seconds).
- **Hypothesis:** fixture process startup or scheduling was delayed in the root suite. The owning-file pass establishes intermittent behavior without identifying the exact wait. No timeout was raised and no test was skipped or loosened.

## Resolution (2026-11-15)

- **Root cause:** The GitHub CLI credential probe runs a fake `gh` subprocess; Bun's 5 s default was exhausted under root-suite load.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The file's `setDefaultTimeout(30_000)` now sets `DEFAULT_TEST_TIMEOUT_MS` (60 s) explicitly, because in a run without `--parallel`/`--isolate` Bun applies a preload's `setDefaultTimeout` to the first test file only.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
