# Host GitHub credential fixture probe times out in the root suite

- **ID:** 0190
- **Status:** open
- **Date observed:** 2026-10-11
- **Test:** `Electron backend command registry > reports whether the selected host GitHub CLI credential is available`.
- **File:** `apps/backend/tests/commands-registry-tools.test.ts`.
- **Original command:** `mise run test:logged -- --name root-isolated-final -- bun test ./tests/unit --parallel=3 --only-failures`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** three isolated Bun workers.
- **Failure:** the five-second deadline expired (reported duration 6026.48 ms), with a pending fixture probe reporting `available: false` after its process was killed. The root run reported 4968 passed, 24 skipped, 1 failed and 1 unhandled error across 250 files in 160.02 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.SEv856/root-isolated-final.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name tooling-isolation -- bun test ./apps/backend/tests/commands-registry-tools.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed (exit 0, 0.5 seconds).
- **Hypothesis:** fixture process startup or scheduling was delayed in the root suite. The owning-file pass establishes intermittent behavior without identifying the exact wait. No timeout was raised and no test was skipped or loosened.
