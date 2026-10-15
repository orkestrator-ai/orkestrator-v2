# Design operation replay event count under aggregate load

- **ID:** 0215
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `design operations: prepare, execute, status and cancel > a lost execute response is answered by status and a repeated execute changes nothing`.
- **File:** `apps/backend/src/core/design-operations.test.ts:268`.
- **Failure:** expected `harness.events.length` to remain 3, received 4; case duration 59.98 ms.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers.
- **Aggregate counts:** backend reported 7,731 passed, 39 skipped and 3 failed across 424 files; the root, bridge and protocol groups passed. The shutdown cleanup failure also reproduced alone and is not classified as a flake.
- **Evidence:** `/tmp/orkestrator-test-run.yeOzQY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-design-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-operations.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 3.6 seconds.
- **Hypothesis:** asynchronous event delivery may race the event-count observation under aggregate load. The cause remains unconfirmed; neither the owning test nor design-operation code changed in this merge. No assertion, timeout or skip was changed.

## OpenCode model-selection validation — 2026-10-15

`mise run test:logged -- --name repository-tests -- mise run test` failed
with an event count of 4 instead of 3, after 42.95 ms. The owning source and
test were unchanged by the OpenCode model-selection fixes.

The unchanged owning file passed alone in 7.4 seconds with:

```bash
mise run test:logged -- --name design-operations-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-operations.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The extra event's source is not established. No assertions, timeouts, or
production behavior were changed to hide this failure.
