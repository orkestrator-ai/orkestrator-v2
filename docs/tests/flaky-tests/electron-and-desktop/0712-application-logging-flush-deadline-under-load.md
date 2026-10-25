# Application logging shutdown deadline fails under load

- **ID:** 0712
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `application logging shutdown > quits anyway when the flush outlives its deadline`
- **File:** `apps/desktop/electron/application-logging.test.ts`
- **Original command:** the workspace group of `mise run test` (`bunx turbo run build test:workspace … --concurrency=3`, `ORKESTRATOR_TEST_WORKERS=3`), run directly while other worktrees held the machine at a load average of about 70.
- **Failure:** failed after 68 ms; `fixture tree digest > names every class of change a coordinator could make` (0258) also timed out in the same run.
- **Isolated rerun:** `bun test ./electron/application-logging.test.ts` from `apps/desktop`: 25 pass, 0 fail.
- **Assessment:** a deadline-based test sensitive to scheduler delay; unconfirmed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 1.4 s: `mise run test:logged -- --name design-links-owner-desktop-logging -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.


## Container resource budget review — 2026-10-25

The workspace group of `mise run test:logged -- --name resource-tests -- mise run test` failed `application logging shutdown > holds the quit open until the flush completes, then quits once` after 36.02 ms: `app.quitCount` was still zero after resolving the pending flush and waiting five milliseconds (line 429). The complete unchanged owner passed with the aggregate's Node preload: `mise run test:logged -- --name application-logging-owner-node -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures` (exit 0, 0.2 seconds logged). Evidence: host temporary artifact `orkestrator-test-run.9oxrhT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`, compressed after aggregate finalization. This confirms an intermittent flush-completion timing failure in the same shutdown owner; shared-host contention remains a hypothesis. No desktop implementation, assertion, deadline or skip changed.
