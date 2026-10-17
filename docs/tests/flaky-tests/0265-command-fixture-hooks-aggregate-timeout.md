# Command fixture hook timeouts during merge validation

- **ID:** 0265
- **Status:** open

## Observation — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **File:** `apps/backend/tests/commands-integration.test.ts`.
- **Failures:** `clears retained setup state when the environment is deleted` hit a beforeEach/afterEach hook timeout after 35003.48 ms; `omits CURSOR_API_KEY from Docker argv when no key is configured or inherited` hit a hook timeout after 5603.72 ms. The later `new environments use an updated project remote when created and started` case could not read its fake Docker log (`ENOENT`). Two diff-statistics timeouts in the same file are recorded in 0162.
- **Owning-file rerun:** `mise run test:logged -- --name merge-commands-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed the entire unchanged owning file (exit 0) in 19.0 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** intermittent fixture timing under aggregate validation. A late hook or cleanup may explain the missing fake Docker log, but this is unconfirmed. No implementation, assertion, timeout or skip changed.
