# `web-public install.sh > uses the installed bun when the install leaves no bunx` (`tests/unit/install-script.test.ts`)

- **ID:** 0121
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test ./tests --parallel 2>&1 | tee /tmp/rev-root-tests.log` at `36a4d95cc7b56e8ae1c725670d932e8a2bdd8299` on an 18-worker macOS host
- **Worker configuration:** Root-only suite, `--parallel` (18 workers).
- **Failure:** timed out after 5,000 ms (reported duration 5,000.60 ms), and additionally reported `Expected: 0 / Received: 143` at `install-script.test.ts:161:29` — a non-zero shell exit from the script under test alongside the timeout.
- **Suite counts:** Root group: 3,645 total, 3,638 passed, 1 skipped, 6 failed, 4 between-test errors across 143 files in 212.53 s.
- **Isolated rerun:** `bun test ./tests/unit/install-script.test.ts --parallel` -> 11 passed, 0 failed, exit 0. Evidence: `/tmp/rev-isolated-install-script.log`.
- **Related:** a different case in the same file, `runs on both supported platforms`, is recorded separately above with two timeouts of its own. Both cases shell out to the real install script, so the file — not either individual case — is the likely unit of contention.
- **Hypothesis:** `143` is `128 + 15`, the conventional shell encoding of SIGTERM, which is consistent with the harness killing the spawned script when the 5,000 ms budget expired rather than with the script genuinely failing. On that reading the exit-code assertion is a downstream symptom of the timeout, not a second defect. This has not been confirmed by capturing the signal directly, and should be before the assertion is changed.
- **Recurrence in a sibling case (shared native-agent capability table, 2026-08-16):** `bun run test:logged -- --name full-suite -- bun run test` at `8136e45aea7db854a29338e4ce0b78513668e3ae` reported the same `Expected: 0 / Received: 143` signature for a third case in this file, `defaults BUN_INSTALL to ~/.bun` (`install-script.test.ts:168`), as an unhandled error between tests rather than as a reported case failure. The immediate re-run of the identical command did not reproduce it. This strengthens the "the file, not any individual case, is the unit of contention" reading in the **Related** note above: three separate cases in `install-script.test.ts` have now produced the SIGTERM exit code under aggregate load.
