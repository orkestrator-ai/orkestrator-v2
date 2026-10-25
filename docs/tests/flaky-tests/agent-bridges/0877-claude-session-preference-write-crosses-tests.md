# Claude session preference write from one test lands in the next

- **ID:** 0877
- **Status:** resolved
- **Date observed:** 2026-10-25
- **Test:** `renameSessionDurably and deleteSessionDurably > keeps a deleted rollout absent when preference cleanup fails and lets retry finish cleanup`
- **File:** `bridges/claude-bridge/src/services/session-manager-persistence.test.ts:2087`
- **Original command:** CI `main` run 40179151374 (#1249, 2026-10-25), job "Unit and integration tests", `mise run test:full`.
- **Failure:** `EEXIST: file already exists, mkdir '…/session-preferences/11111111-2222-4333-8444-555555555555.json'` (1.89 ms). The test had just removed that path with `rm({ recursive: true, force: true })`.
- **Occurrences:** 1 of the 44 failing `main` CI runs from 2026-10-23 to 2026-10-25.
- **Root cause:** `updateSessionPreferences` and `deleteSessionPreferences` (`session-preferences.ts`) run in a per-session promise chain that callers often do not await. The shared `afterEach` in `session-manager-test-harness.ts` did not wait for it, so a write the previous test started could rename its temporary file onto the path after this test's `rm` and before its `mkdir`. Instrumenting `afterEach` on 2026-10-25 showed 11 tests in the owning file ending with a write still pending, almost all for `11111111-2222-4333-8444-555555555555`, the id in the failure.
- **Fix:** on branch `todo-0030-test-suite-ci-health-e11a519267e2`, `settleSessionPreferenceWritesForTesting()` (exported from `session-preferences.ts`) waits until no write or deletion is pending, and the shared `afterEach` awaits it last.
- **Verification:** `bun test src/services --preload ../../tests/setup-node.ts --parallel=1` from `bridges/claude-bridge` passed 3 of 3 runs (1,274 pass each).
