# PR status wake for an ended follow times out under the aggregate suite

- **ID:** 9975
- **Status:** open
- **Date observed:** 2026-11-11
- **Base commit:** 498b68766f5c9f357a3a86782406d1e9e0977559, branch opencode-event-stream-a3166ed90bb0-r1 (head 05c350cae).
- **Test:** `pull request status wakes > a follow that already ended still records the merge when its worker is deleted`.
- **File:** apps/backend/src/core/coordinator-status-wakes-pr.test.ts:380.
- **Original command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:logged -- --name default-tests-skip-guards -- mise run test` (guards skipped because of an unrelated guard finding in `apps/web/src/components/browser/ServiceBrowserTab.test.tsx`).
- **Worker configuration:** the default aggregate plan (`scripts/test-all.ts`); the backend group ran `--parallel=${ORKESTRATOR_BACKEND_TEST_WORKERS:-${ORKESTRATOR_TEST_WORKERS:-2}}` beside the root, bridge and workspace groups on Linux x64 (beelink2).
- **Failure:** `this test timed out after 5000ms` at 5,000.59 ms. Backend counts: 18,378 pass, 150 skip, 1 fail, 18,529 tests across 1,278 files (152.46 s). Every other workspace package passed.
- **Isolated rerun:** the runner's own rerun of the owning file alone passed: 16 pass, 0 fail, 96 expect() calls, 6.99 s.
- **Hypothesis:** unconfirmed. The test creates a coordinator world, follows two workers through four monitor updates and two settles, advances the controlled clock two hours and captures two final pull requests, all inside the default 5 s budget; under the aggregate's load that sequence may simply run past it. Not yet reproduced, so a product race (a settle that waits on work the clock advance does not release) is not ruled out.
- **Disposition:** open. Reproduce under load (for example `bun test apps/backend/src/core/coordinator-status-wakes-pr.test.ts --rerun-each=20` beside a busy suite) before changing the test or its budget.
