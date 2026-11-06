# Empty process-group probe can report a live member

- **ID:** 7271
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `groupHasLiveMember > sees a running member and ignores an empty group`
- **File:** `packages/protocol/src/node/shell-process-state.test.ts:96`
- **Original command:** `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** protocol workspace tests in the concurrent default aggregate; the workspace group reserved six worker slots alongside root and bridge groups.
- **Failure:** `groupHasLiveMember(2 ** 22 + 1)` returned `true` instead of `false`, after 542.77 ms.
- **Suite counts:** the enclosing default aggregate failed in 1,265.2 s; its root group reported 3,738 passed and 12 failed. Workspace and root groups failed; bridge and protocol-regeneration groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.PCIx5Q/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log` (compressed on finalization); outer directory `orkestrator-test-run.WDOGkE`.
- **Isolated rerun:** `mise run test:logged -- --name repair-shell-state-alone -- bun test --cwd packages/protocol ./src/node/shell-process-state.test.ts --parallel=1 --only-failures` passed, exit 0, in 1.7 s. Passing output was deleted by the logged runner; individual assertion counts were not retained.
- **Scope:** this transcript-restoration branch changes neither the process-state implementation nor its tests. No test or timeout was loosened.
- **Hypothesis:** none established. The isolated pass establishes intermittent behavior, not its cause.
