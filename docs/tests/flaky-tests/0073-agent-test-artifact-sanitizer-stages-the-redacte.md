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
