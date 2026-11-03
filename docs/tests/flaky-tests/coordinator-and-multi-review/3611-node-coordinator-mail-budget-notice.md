# Coordinator mail loop-budget notice missing under aggregate load

- **ID:** 3611
- **Status:** open
- **Date observed:** 2026-11-03
- **Test:** `command node coordinator ↔ leaf coordinator > budgets stop two coordinators from waking each other endlessly`
- **Owning file:** `apps/backend/src/core/coordinator-node-coordinator-mail.test.ts:613`.
- **Original command:** `mise run test:logged -- --name fix-round-root -- mise run test`, during Coordinator Work panel review repair. Workspace grant six slots; backend four isolated workers and web two, alongside root/support (one) and bridges (two).
- **Failure:** `notice?.body` was not a string at the assertion looking for `Sending another request does not reset this budget` (269.98 ms). Backend: 13,838 passed, 102 skipped, one failed. Web: 11,610 passed, ten skipped, zero failed. Root/support, bridges and protocol passed. Aggregate exit 1 after 347.2 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.oLpm6Y/fix-round-root.log.gz`; group evidence `/tmp/orkestrator-test-run.bOl78I/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Complete unchanged owner:** `mise run test:logged -- --name mail-budget-owner -- bun --cwd=apps/backend test ./src/core/coordinator-node-coordinator-mail.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 1.8 s). Two root-directory attempts found no matching tests because of root discovery exclusions; they did not execute the owner.
- **Assessment:** credible aggregate-only flake; asynchronous notice publication is a hypothesis, not a confirmed cause. This branch changes renderer code and renderer tests, plus documentation; the backend owner and its backend/protocol imports are unchanged. The aggregate remains failed for verifier assessment. No assertion, timeout or implementation changed to conceal it.
