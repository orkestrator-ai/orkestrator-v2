# Design Electron preview process-group shutdown

- **ID:** 0671
- **Status:** open
- **Date observed:** 2026-10-22
- **Test:** `design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron` in `e2e/agent-testing/design-canvas-electron.spec.ts`.
- **Original command:** `mise run test:logged -- --name review-electron -- mise run test:agent:electron`.
- **Worker configuration:** one Playwright worker on macOS, alongside the repository suite and isolated design qualification.
- **Failure:** the UI journey completed, but cleanup's `SIGKILL` to the detached Vite process group returned `EPERM`. Full suite duration: 151.5 seconds.
- **Suite counts:** 31 total; 25 passed, two failed, one skipped, three did not run. The other failure was an unchanged Notes focus assertion.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=design-review-shutdown-rerun mise run test:logged -- --name review-design-electron -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts design-canvas-electron.spec.ts` passed (16.8 seconds). Only error-message context had changed before this rerun.
- **Evidence:** initial bounded failure log at `orkestrator-test-run.al9Dk3/review-electron.log.gz` under the host temporary directory. The Notes owner also failed alone, so that observation is not classified as a flake.
- **Hypothesis:** probing a process group with signal zero may observe a group with no live members during shutdown. The original process table was not captured, so the cause remains unconfirmed. A standalone `bun run dev` shutdown diagnostic did not reproduce the failure.
- **Mitigation:** cleanup now enumerates the exact owned group's live members, excludes zombies, checks membership before signaling, and waits for the runtime to reap the leader. `EPERM` is accepted only after enumeration proves that no live group member remains. Errors with live members still fail qualification and prevent profile removal.
- **Verification:** the owning Electron scenario passed three repetitions (50.7 seconds) after the membership check. `tests/unit/design-qualification-processes.test.ts` also covers an exited group whose mocked kernel signal probe would report it present, as well as live descendants, early exit, forced termination and repeated cleanup. Retain this case open until the original `EPERM` condition is directly characterized.
