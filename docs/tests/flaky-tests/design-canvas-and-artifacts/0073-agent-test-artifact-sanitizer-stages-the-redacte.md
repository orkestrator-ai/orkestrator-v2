# `agent-test artifact sanitizer > stages the redacted trace beside the original so the swap cannot cross filesystems` (`e2e/agent-testing/artifact-sanitizer.test.ts`)

- **ID:** 0073
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-tests.log`
- **Worker configuration:** the root and agent-support group ran as `bun test ./tests ./e2e/agent-testing ./apps/desktop/electron ./apps/desktop/scripts/dev --parallel=4` (`4x PARALLEL`).
- **Failure:** expected the staged archive basename to be `trace.zip`, but received an empty string (duration: 27.44 ms).
- **Suite counts:** root and agent-support group: 3,639 total, 3,637 passed, 1 skipped, 1 failed; the other validation groups passed.
- **Isolated rerun:** `bun test ./e2e/agent-testing/artifact-sanitizer.test.ts` -> 3 passed, 0 failed in 91 ms.
- **Hypothesis:** the owning file passes from a clean process, so the failure depends on aggregate execution state or scheduling. The available assertion does not identify which shared condition produced the empty basename; no more specific root cause is established yet.

## 2026-09-22 recurrence and fix

- **Original command:** `mise run test` (root and agent-support group, `3x PARALLEL`).
- **Failure:** the same test exceeded Bun's default five-second timeout (5,010 ms); cleanup then raced the unfinished sanitizer, causing `unzip` to return 9. The group had 4,411 passed, 2 skipped, and 2 failed across 207 files.
- **Isolated rerun:** `mise run test:logged -- --name artifact-sanitizer-isolated -- bun test ./e2e/agent-testing/artifact-sanitizer.test.ts --parallel=1 --only-failures` passed.
- **Root cause:** the test invokes external `zip` and `unzip` processes and performs archive sanitization; under aggregate load these steps can exceed the generic five-second test budget. The earlier empty-basename assertion remains unexplained.
- **Fix:** give the two archive-processing tests a 20-second outer budget in `e2e/agent-testing/artifact-sanitizer.test.ts`.
- **Verification:** isolated file passed after the change; the next `mise run test` passed all four groups.
