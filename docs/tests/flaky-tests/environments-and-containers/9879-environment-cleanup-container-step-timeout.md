# Environment deletion container-step aggregate timeout

- **ID:** 9879
- **Status:** resolved
- **Date observed:** 2026-10-22
- **Test:** `delete_environment host cleanup > runs the verified container step during deletion`
- **Owner:** `apps/backend/src/core/commands/environment-cleanup.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers on a shared host.
- **Failure:** five-second timeout (5002.08 ms), followed by an unhandled `ContainerLifecycleError:daemon-unavailable` from the pending ownership check.
- **Suite counts:** backend 9918 passed, 80 skipped, three failed and two between-test errors across 10001 tests in 572 files (757.16 s); aggregate exit 1 after 822.1 s. The other backend failures were the move submodule timeout (0248) and Mermaid watchdog elapsed bound (0512). Root had five firewall fixture timeouts (0192); all other workspace packages, bridges and protocol regeneration passed.
- **Isolated rerun:** `mise run test:logged -- --name environment-cleanup-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands/environment-cleanup.test.ts --parallel=1 --only-failures` passed the complete unchanged file (exit 0, 4.6 s logged).
- **Evidence:** `orkestrator-test-run.jhZR27/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Hypothesis:** host scheduling delayed the fixture's container ownership check; host load exceeded 50 during validation, and the unchanged owner passed alone. The run does not establish a root cause. No implementation, assertion, timeout or skip changed.

## Resolution (2026-11-15)

- **Root cause:** The deletion container step runs fake Docker; it exceeded Bun's 5 s default, and the ownership-check error followed from the cut-off test.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The owning file sets no smaller file, test or hook budget, and the failing test has no inner wall-clock deadline of its own.
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-b -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 13 --burners 6 -- bun test --preload ../../tests/setup-node.ts <seventeen container, pipeline, move, worktree and native-agent owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 1,139 passed, 1 failed — `git fsmonitor > fixture repositories inherit fsmonitor off from the test preload` on its second rerun, which fails the same way without contention and with the unchanged file (`git-fsmonitor.test.ts` is not rerun-safe).
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
