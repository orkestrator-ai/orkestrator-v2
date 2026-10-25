# OpenCode agent-tool background reconcile still pending after 150 ms

- **ID:** 0320
- **Status:** open
- **Date observed:** 2026-10-17
- **File:** `apps/backend/src/core/commands-agent-tools.test.ts`.
- **Test:** `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation`.
- **Original command:** `mise run test` on a shared 18-slot host (other environments held every slot at start; workspace/root/bridges/protocol reserved 4/1/2/1), with an isolated `dev:test` profile running a live Grok check.
- **Failure:** after a real `setTimeout(150)` (line 173), `__testing.openCodeAgentToolsConfigurationCount()` was still 1, not 0 (line 174), at 174.00 ms. The background reconcile had not settled within the fixed wait.
- **Suite result:** backend reported four failures; the other three were known five-second timeouts (0162, 0165, 0211). Bridges and protocol passed; root had the Pi staging timeout (0178).
- **Owning-file rerun:** `bun test src/core/commands-agent-tools.test.ts` (from `apps/backend`) passed unchanged: 20 passed in 2.44 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ZPvgI1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** the case waits on a real 150 ms timer for background work, which the testing guide's controlled-timer rule forbids; under host load the reconcile can take longer. A fix would await the reconcile (or drive it with a controlled clock) instead of sleeping. The change under test (closing the session a resume replaces) does not touch agent-tool configuration. No implementation, assertion, timeout or skip changed.

## Local preview discovery review — 2026-10-25

`mise run test:logged -- --name preview-repository -- mise run test` repeated the fixed-wait failure at `commands-agent-tools.test.ts:195`: configuration count was one instead of zero after the 150 ms wait (212.06 ms test duration). The backend used two isolated Bun workers alongside other repository/browser validation on the shared host. The complete unchanged owner passed separately with `mise run test:logged -- --name preview-agent-tools-owner -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures` (exit 0, 2.2 s). No agent-tool implementation, assertion, wait, or skip changed. Evidence: `orkestrator-test-run.0vNQwf/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
