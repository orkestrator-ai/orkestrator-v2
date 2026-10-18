# Skill scanning fixture hook exceeds the aggregate deadline

- **ID:** 0212
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `scanAgentSkills > bounds entries per root and total skills across plugin roots`
- **Owning file:** `apps/backend/src/core/agent-skills.test.ts`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`, with the testing guide's macOS GNU-tool PATH.
- **Worker configuration:** workspace group reserved four worker slots; root used one worker, bridges two, and protocol one. Other validations were active on the host.
- **Failure:** a beforeEach/afterEach hook timed out; the case reported 6856.51 ms.
- **Evidence:** `/tmp/orkestrator-test-run.BYvvBs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Aggregate counts:** backend 7712 passed, 39 skipped, 5 failed across 424 files in 518.91 seconds; root 2945 passed, 1 skipped, 1 failed. Bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name agent-skills-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-skills.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 4.2 seconds).

Concurrent fixture I/O is a possible cause, not a confirmed diagnosis. The
OpenCode auth-status change does not touch skill scanning. No test deadline,
assertion or skip was changed.

## CLI matrices second main merge — 2026-10-18

Original command: `mise run test:logged -- --name merge2-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1 alongside component and isolated browser validation. The same skill-bound test hook timed out (8071.13 ms). Its unchanged owner passed in the four-file one-worker `merge2-late-backend-owners` rerun (exact command and overall 163-pass/one-failure result in 0442).
Aggregate result: `merge2-tests` exited 1 after 1132.1 seconds logged. Backend reported 9081 passed, 41 skipped and 11 failed across 9133 tests in 485 files (1118.57 seconds). Every other workspace package passed; root/support passed 3084 tests with one skip, and protocol regeneration passed. Evidence: `orkestrator-test-run.0J1rem/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.

The unchanged owner pass confirms intermittence. No implementation, assertion, timeout or skip changed.
