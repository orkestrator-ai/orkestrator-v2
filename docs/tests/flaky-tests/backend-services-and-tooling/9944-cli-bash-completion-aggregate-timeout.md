# CLI bash completion execution exceeds the aggregate deadline

- **ID:** 9944
- **Status:** open
- **Date observed:** 2026-11-11
- **Observing base:** `498b68766` (`main`), with the uncommitted renderer error ring changes of branch `renderer-error-ring-e3a48fce2746-r1` (to-dos 6300 and 6301; no CLI, completion or shell code changed).
- **Test:** `shell completion > bash completion completes command words across IDs and flags per command`
- **Owning file:** `packages/cli/tests/command-surface.test.ts`
- **Original command:** `ORKESTRATOR_TEST_SKIP_GUARDS=1 mise run test:changed` (the guard stage was skipped for a pre-existing `ServiceBrowserTab.test.tsx` baseline finding), on mini (macOS arm64, Bun 1.4.4), shared with other worktrees' work.
- **Failure:** `this test timed out after 5000ms` at 5003.74 ms, inside `bashCompletions` (`command-surface.test.ts:348`), which spawns `bash` for each completion.
- **Aggregate:** the workspace group failed with this CLI case and three backend cases (two `maintenance.lock` copies recorded under [9936](9936-checkout-template-copy-races-git-maintenance-lock.md), one whole-tree scan deadline under [6150](../aggregate-validation-runs/6150-egress-review-aggregate-timing.md)); CLI 523 pass, 2 skip, 1 fail; backend 18326 pass, 200 skip, 3 fail; web, desktop, protocol, web-public and toolchain passed; root, bridges and the Codex protocol lockfile groups passed.
- **Owning-file rerun:** the runner's own isolated rerun of `packages/cli/tests/command-surface.test.ts` passed unchanged in 1.5 s.
- **Evidence:** `orkestrator-test-run.PS6O8Y/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.

Related: [0955](0955-cli-fish-completion-aggregate-timeout.md), the fish case in the same file with the same five-second deadline and process-per-completion shape. Host load is the likely cause, not a confirmed diagnosis. No test, timeout, assertion or skip changed.
