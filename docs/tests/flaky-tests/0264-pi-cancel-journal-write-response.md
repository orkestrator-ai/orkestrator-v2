# Pi cancellation journal-write response differs in the aggregate

- **ID:** 0264
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `cancel during the mandatory journal write > a write failure after a cancel releases the claim and its intent`
- **File:** `bridges/pi-bridge/src/http-cancel-startup.test.ts:526`.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  with the testing guide's GNU-tool directories preferred in PATH, while merging
  `origin/main` at `44471e25` into `todo-design-flake-ordering-a295739d3dc2`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; bridges used two package tasks with one isolated Bun worker each.
  Another worktree was validating on the same host.
- **Failure:** after cancellation and rejection of the held journal write, the
  prompt response was HTTP 202 instead of the expected HTTP 500 (6.23 ms).
- **Suite counts:** Pi reported 531 passed, one skipped and one failed across
  533 tests in 25 files (7.62 seconds). The other four bridge packages passed;
  the bridge group exited 1 after 88.1 seconds. Workspace, root and protocol
  groups passed; the aggregate exited 1 after 382.8 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-pi-cancel-isolated -- bun test --cwd bridges/pi-bridge --preload ../../tests/setup-node.ts ./src/http-cancel-startup.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (exit 0, 0.5 seconds).
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.xklZLk/bridges.log.gz`;
  outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.H2hdLx/merge-tests.log.gz`.
- **Disposition:** intermittent failure confirmed by the owning-file pass.
  The cause is unconfirmed. No product code, assertion, timeout or skip changed
  to address this observation.
