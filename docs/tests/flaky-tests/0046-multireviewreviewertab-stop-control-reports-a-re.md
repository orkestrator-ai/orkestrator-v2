# `MultiReviewReviewerTab stop control > reports a refused stop without pretending the reviewer settled` (`apps/web/src/components/review/MultiReviewTab.test.tsx:921`)

- **ID:** 0046
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name fix-full-tests -- bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace, root/agent-support, bridges, and protocol-lockfile groups concurrently; the web workspace suite used its normal parallel runner.
- **Failure:** Testing Library timed out waiting for `Multi review reviewer not found` after the refused stop; the DOM had already returned to the ordinary running reviewer state (duration: 1,072.24 ms).
- **Suite counts:** web workspace: 5,103 passed, 1 skipped, 1 failed; 5,105 tests across 222 files in 108.69 seconds. The root/agent-support, bridges, and protocol-lockfile groups passed.
- **Isolated rerun:** `bun run test:logged -- --name fix-web-review-tests-rerun -- bun --cwd=apps/web test src/components/review/MultiReviewTab.test.tsx --only-failures` → passed in 5.2 seconds before the aggregate run.
- **Hypothesis:** Aggregate scheduling allowed the transcript poll to finish after the stop rejection and clear the component's shared error state before the assertion observed it.
- **Root cause:** Transcript reads and reviewer actions shared one `error` state. Any successful poll cleared a stop-action failure even though the action had not succeeded.
- **Fix:** Track transcript-read and action failures separately; transcript polling clears only transcript failures, while the action failure remains visible until another action or tab identity change. The one exception is a gone workflow or reviewer, which is terminal for the view and displaces the stale action failure rather than hiding why polling stopped. The regression test now forces a successful refresh after the rejected stop and asserts the action error remains; a sibling test pins the gone-workflow exception.
- **Verification:** The owning component test and the web typecheck were rerun for this change, followed by the aggregate suite. A real-browser pass over the reviewer tab has not been run against this fix and is still outstanding.
