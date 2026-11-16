# Skill scanning fixture hook exceeds the aggregate deadline

- **ID:** 0212
- **Status:** resolved
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

## Plugin enablement regressions — 2026-10-26

`mise run test:logged -- --name backend-settings-final -- bun test --cwd apps/backend ./tests/portable-inputs.test.ts ./src/core/agent-skills.test.ts ./src/core/environment-agent-skills.test.ts --parallel=3 --only-failures`
reported the same fixture hook timeout (6860.69 ms), with 131 passes and one
failure across three files. Other worktrees' aggregate validations and a Docker
image build were active on the host. Evidence: the host temporary directory's
`orkestrator-test-run.4fBNig/backend-settings-final.log.gz`.

The unchanged owning file passed alone with
`mise run test:logged -- --name agent-skills-isolated -- bun test --cwd apps/backend ./src/core/agent-skills.test.ts --parallel=1 --only-failures`
(exit 0, 3.6 seconds). This matches the existing concurrent fixture-I/O
hypothesis; no deadline, assertion or skip was changed.

## Resolution (2026-11-15)

- **Root cause:** the `beforeEach`/`afterEach` fixture hooks (and, in the recorded runs, the 2,500-file scan case) ran against the default five-second hook budget while the host was saturated with other worktrees' suites.
- **Fix:** `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`) sets the default per-test and per-hook budget to 60 s. The one smaller explicit budget in `apps/backend/src/core/agent-skills.test.ts`, a `20_000` third argument on `bounds entries per root and total skills across plugin roots`, was removed so that case gets the same 60 s watchdog (it creates 2,500 files and has no signal to wait on). No assertion or skip changed.
- **Reproduced:** no. The host load average was 100 to 180 from other workers' runs, so no clean contention run was possible; the class is established from the recorded hook timeouts with the owner passing alone.
- **Stress:** the owner passes unchanged in this tree (with the other changed owners, one `bun test --parallel=3` run).
