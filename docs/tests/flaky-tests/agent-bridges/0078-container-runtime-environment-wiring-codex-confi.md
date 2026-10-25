# `container runtime environment wiring > Codex configuration copy inspection failures warn and skip the entry` (`tests/unit/runtime-env-wiring.test.ts`)

- **ID:** 0078
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests-native-consolidation.log`
- **Worker configuration:** Bun's 18-worker parallel pool for the root group.
- **Failure:** `this test timed out after 5000ms` at 5,508.54 ms.
- **Suite counts:** 3,634 total, 3,631 passed, 1 skipped, and 2 failed across 143 files; the other failure was the install-script flake above.
- **Isolated rerun:** `bun test ./tests/unit/runtime-env-wiring.test.ts` -> 53 passed, 0 failed, 419 assertions in 5.87 seconds; the affected test passed in 1,194.03 ms. Evidence: `/tmp/orkestrator-runtime-env-wiring-isolated.log`.
- **Root cause:** The case deliberately launches four complete shell harnesses to force independent `wc`, `find`, `du`, and malformed-output inspection failures. The default five-second outer test budget covered all four processes together and was exhausted under aggregate process-startup contention; each fail-closed assertion passed in isolation.
- **Fix:** Give this multi-process integration case a 15-second outer budget. The production commands, failure behavior, and every copy-rejection assertion are unchanged.
- **Verification:** `bun test ./tests/unit/runtime-env-wiring.test.ts --test-name-pattern 'Codex configuration copy inspection failures' --rerun-each 10` passed 10/10 in 7.13 seconds, with individual executions at 690.82-734.65 ms. The final `bun run test` aggregate passed the root group with 3,638 tests and no failures. Evidence: `/tmp/orkestrator-runtime-copy-flake-fix-stress.log` and `/tmp/orkestrator-native-consolidation-full-final.log`.
