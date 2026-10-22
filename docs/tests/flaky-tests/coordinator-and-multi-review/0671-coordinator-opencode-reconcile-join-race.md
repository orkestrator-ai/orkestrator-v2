# Coordinator OpenCode reconcile counted a joined reconcile as a new POST

- **ID:** 0671
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `Coordinator OpenCode server > starts only once its Control MCP is connected, and keeps it on every later reconcile`
- **File:** `apps/backend/src/core/commands-servers-coordinator-opencode.test.ts`
- **Original command:** CI `main` run 39701903157 (`c66604e2`), job "Unit and integration tests", `mise run test` on `ubuntu-latest` (four cores; one Bun worker per package).
- **Failure:** `expect(urls.length).toBeGreaterThanOrEqual(3)` received 2, after 2,392 ms (the test polled 200 × 10 ms for a third MCP POST).
- **Isolated rerun:** not a load flake. The unchanged case failed alone on macOS:
  `bun test --preload ../../tests/setup-node.ts src/core/commands-servers-coordinator-opencode.test.ts -t "starts only once its Control MCP" --rerun-each 15`
  (from `apps/backend`) failed 3 of 15, each after the full 2 s poll with 2 POSTs.
- **Root cause:** with the memo windows set to 0, both the healthy-reuse path of
  `startLocalServerUnlocked` and `readLocalServerStatus` schedule
  `scheduleOpenCodeAgentToolsConfiguration` without waiting. When the status read
  arrives while the reuse path's reconcile is still in flight with the same
  fingerprint, it joins that task instead of POSTing again. That is the intended
  behaviour; the test's "at least three POSTs" depended on the first reconcile
  finishing before the status read.
- **Fix:** `fix(ci): stop the Linux watcher crash and two fixture races keeping
  main red`. `commandTesting.openCodeAgentToolsConfigurationSettled(key)` awaits
  the key's in-flight reconcile; the test settles the reuse path's reconcile
  before the status read and the status read's afterwards, then asserts exactly
  three POSTs, all on the scoped Control MCP URL. The fake server records each
  POST before answering, so a settled task is a complete signal.
- **Verification:** the same `--rerun-each` command passed 40 of 40; the owning
  file passed (6 of 6, 5.5 s).
