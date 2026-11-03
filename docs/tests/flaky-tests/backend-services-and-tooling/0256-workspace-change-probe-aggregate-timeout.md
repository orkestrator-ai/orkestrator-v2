# Workspace change probe exceeds its aggregate deadline

- **ID:** 0256
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `WorkspaceChangeProbe > measures tracked edits, new files and deletions made during the window`
- **Owning file:** `packages/protocol/src/node/workspace-change-probe.test.ts`
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH, while merging `origin/main` at `59bd3aac` into `coordinator-launch-defaults`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; protocol and backend package tests each used two isolated Bun workers. Another worktree's aggregate suite was active on the host.
- **Failure:** the unchanged test exceeded its 5000 ms deadline at 5123.49 ms.
- **Suite counts:** protocol 1,517 passed and one failed. Backend 8,413 passed, 40 skipped, five failed and one between-tests error across 8,458 tests in 450 files (364.58 seconds). Other workspace packages, root, bridges and protocol lockfile verification passed. The aggregate exited 1 after 453.6 seconds.
- **Isolated rerun:** `mise run test:logged -- --name merge-probe-owner -- bun test --cwd packages/protocol --preload ../../tests/setup-node.ts ./src/node/workspace-change-probe.test.ts --parallel=1 --only-failures` passed the entire unchanged owning file (exit 0, 3.2 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.H7G9oK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/tmp/orkestrator-test-run.e7nGed/merge-tests.log.gz`.
- **Hypothesis:** Git fixture operations slowed under concurrent host load; the cause is unconfirmed. Neither branch changed the owning file or probe implementation.
- **Changes:** recorded evidence only; no implementation, assertion, timeout or skip changed.

## Recurrence — 2026-10-24

- **Original command:** `mise run test` on `leaf-node-signin-0abcb230a0c9-r1` while validating account routing and coordinator credential fixes.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; the protocol package used two isolated Bun workers. The isolated browser suite was also running on this host.
- **Failure:** the same test exceeded its 5000 ms deadline at 5140.28 ms.
- **Suite counts:** protocol 1,831 passed and one failed across 1,832 tests in 118 files (16.33 seconds). The aggregate also encountered independently reproducible OpenCode version assertions (`1.19.0` expected, `1.19.4` installed) and account test expectations corrected in this change.
- **Isolated rerun:** `mise run test:logged -- --name probe-isolated -- bun --cwd=packages/protocol test --preload ../../tests/setup-node.ts ./src/node/workspace-change-probe.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 2.9 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.i0pmeY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis and changes:** concurrent Git fixture work remains the suspected cause; no probe implementation, assertion, deadline or skip changed.


## Recurrence — 2026-11-03

- **Original command:** `mise run test:logged -- --name fix-protocol-mail -- bun --cwd packages/protocol test ./src/pipeline-worker-mail.test.ts --parallel=1 --only-failures`. The leading --cwd selected the package test script, which ran the protocol package rather than only the intended file.
- **Worker configuration:** one isolated protocol worker; other worktrees had aggregate suites active.
- **Failure:** the same test timed out at 5238.43 ms (5000 ms limit).
- **Suite counts:** 4503 passed, 2 skipped, 1 failed across 240 files; 120.65 seconds.
- **Isolated rerun:** `mise run test:logged -- --name workspace-change-probe-isolated -- bun test --cwd=packages/protocol ./src/node/workspace-change-probe.test.ts --parallel=1 --only-failures` passed unchanged (exit 0; 7.0 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Ulh9Q7/fix-protocol-mail.log.gz`.
- **Changes:** recurrence recorded; probe implementation and tests are unchanged. Host contention remains a hypothesis.
