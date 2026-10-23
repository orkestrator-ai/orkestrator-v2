# `web-public install.sh > runs on both supported platforms` (`tests/unit/install-script.test.ts`)

- **ID:** 0077
- **Status:** resolved
- **Date observed:** 2026-08-13
- **Original command:** `bun test tests --parallel`
- **Worker configuration:** Bun's default parallel worker pool for the root group, run on its own (no other test group running concurrently).
- **Failure:** `(fail) web-public install.sh > runs on both supported platforms [5001.03ms]` — `this test timed out after 5000ms`. The suite reported 2 failures for that run; the other was the deterministic `packages/cli` release-version drift, which is unrelated. The same command was run four times in total on the same commit: three runs reported `3900 pass, 1 skip, 1 fail` (the version drift alone) in 109.9s–111.9s, and one reported `2 fail`, so the observed rate is roughly one in four.
- **Suite counts:** Failing run: 2 fail across 3902 tests in 148 files. Passing runs: 3900 pass, 1 skip, 1 fail, 16906 expect() calls, 3902 tests across 148 files.
- **Isolated rerun:** `bun test tests/unit/install-script.test.ts` -> 10 pass, 0 fail, 25 assertions in 2.38 seconds.
- **Recurrence (2026-08-14):** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/orkestrator-root-tests-native-consolidation.log` again timed out at 5,001.03 ms. The root suite reported 3,631 passed, 1 skipped, and 2 failed across 143 files; the other failure was the separate runtime-copy timeout below. An immediate isolated rerun passed all 10 tests with 25 assertions in 4.43 seconds; the target completed in 734.37 ms. Evidence: `/tmp/orkestrator-install-script-isolated.log`.
- **Root cause:** The case coupled two independent process-spawning platform checks to one five-second outer budget. Under root-suite worker contention, the combined shell and stub-launcher startup latency could exhaust that shared budget even though each supported platform behaved correctly.
- **Fix:** Give Darwin and Linux independent test cases and independent budgets. Both still execute the real installer harness and retain the same exit-code assertion.
- **Verification:** `bun test ./tests/unit/install-script.test.ts --test-name-pattern 'runs on supported platform' --rerun-each 10` passed 20/20 platform cases in 7.04 seconds. The final `bun run test` aggregate passed the root group with 3,638 tests and no failures. Evidence: `/tmp/orkestrator-install-script-flake-fix-stress.log` and `/tmp/orkestrator-native-consolidation-full-final.log`.
