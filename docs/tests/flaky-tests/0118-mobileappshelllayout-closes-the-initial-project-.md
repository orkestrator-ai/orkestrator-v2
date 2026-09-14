# `MobileAppShellLayout > closes the initial project drawer from its close button and restores trigger focus` (`apps/web/src/components/layout/MobileAppShellLayout.test.tsx`)

- **ID:** 0118
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun test --cwd apps/web src --parallel 2>&1 | tee /tmp/ork-review-web-suite.log`
- **Worker configuration:** The web package ran `bun test src --parallel` (18 workers) while two suites owned by other sessions ran concurrently in the same checkout: another full `bun test --cwd apps/web --parallel` and a root `bun test ./tests ... --parallel=4` observed at roughly 348% CPU.
- **Failure:** `this test timed out after 5000ms` (duration: 6,623.04 ms). No assertion failure was reported.
- **Suite counts:** Web package: 4,865 total, 4,862 passed, 1 skipped, 2 failed across 213 files with 15,071 assertions in 174.66 seconds. The other failure in that run, `AgentNativeTab > capability-driven parity > does not render a context wheel when the provider reports no maximum`, is not a flake and is deliberately not recorded here: it reproduces in isolation and is a real `expect(received).toBeNull()` failure present at commit `989f6c9d` but absent on `origin/main` at `f5961ebc`, so it is a branch-is-behind-main gap rather than nondeterminism.
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/MobileAppShellLayout.test.tsx` -> 24 passed, 0 failed; the affected case passed. A later full-suite run of the same tree also passed this case.
- **Pre-existing:** Unrelated to the reviewed PR-dialog change, which touches no drawer or sidebar code.
- **Hypothesis:** This case is the close-and-restore half of the split described in the resolved `MobileAppShellLayout > opens the project drawer on initial mobile entry and keeps workspace content mounted` entry above. That split gave each focus transition its own budget, and it held until three parallel suites shared one machine. The recurrence therefore looks like the same asynchronous Radix focus-restore boundary exceeding a 5,000 ms wall-clock budget under extreme contention rather than a return of the original shared-budget cause. Before raising the timeout, establish whether the restore awaits more than one animation frame.
