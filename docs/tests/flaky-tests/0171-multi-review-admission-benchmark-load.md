# Multi Review admission benchmark exceeds its limit under aggregate load

- **ID:** 0171
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `Multi Review control-plane benchmark > one slow reviewer does not serialize the rest of the panel`
- **File:** `apps/backend/src/core/multi-review-efficiency.bench.test.ts:444`
- **Original command:** `mise run test`, while other worktrees were also testing on the host.
- **Failure:** `result.admissionMs` was 330 ms; the assertion required less than 310 ms.
- **Isolated rerun:** `mise run test:logged -- --name backend-multi-review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures` passed.
- **Second aggregate run:** `mise run test` passed all four groups, including the workspace group.

## Current assessment

The benchmark is sensitive to host load. The backend code did not change in this task. Investigate the timing budget and host contention before changing the limit.

## Recurrence (2026-10-01)

During validation of the design-prompt paste fixes on `140f6cb1` plus the
working changes, `mise run test` again failed this assertion: admission took
428 ms against the unchanged 310 ms limit (the case ran for 1514 ms).
The aggregate used workspace 2, root 3, bridges 2 and protocol 1 worker slots.
Its web package passed 8023 tests with 11 skipped and no failures; the aggregate
also had unrelated host/tooling failures.

The owning file passed unchanged when rerun with:

```bash
mise run test:logged -- --name backend-multi-review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures
```

The isolated run completed in 2.3 seconds. Aggregate failure evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FrGJ2w/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
This supports the existing host-contention hypothesis; no benchmark assertion
or backend behavior was changed.
