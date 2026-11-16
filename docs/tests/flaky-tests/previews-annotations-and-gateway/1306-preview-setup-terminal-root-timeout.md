# Preview setup-terminal process-root aggregate timeout

- **ID:** 1306
- **Status:** resolved
- **Date observed:** 2026-10-29 (macOS, Bun 1.4.4).
- **Test:** `preview terminal process roots > the spawned local setup terminal is a managed root until it exits`.
- **Owning file:** `apps/backend/src/core/preview-terminal-roots.test.ts`.
- **Original command:** `mise run test:logged -- --name review-fix-full-tests -- mise run test:full`.
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; the backend used two parallel Bun workers. Groups waited about 533 seconds for host scheduler admission.
- **Failure:** the test timed out at 20,003.12 ms against its 20,000 ms deadline. The aggregate retained no more specific failing await.
- **Backend counts:** 12,955 passed, 123 skipped, one failed across 13,079 tests in 797 files (713.07 s). The full command remained failed on this timeout, the CLI setup-failure scenario, and pre-existing diagnostic-bounds violations.
- **Complete unchanged owner:** `mise run test:logged -- --name review-fix-preview-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-terminal-roots.test.ts --parallel=1 --only-failures` passed (exit 0, 2.9 s).
- **Evidence:** host temporary artifact `orkestrator-test-run.ePdIio/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `orkestrator-test-run.4IEsqs/review-fix-full-tests.log.gz`. The passing logged owner discarded its detailed output.
- **Assessment:** confirmed aggregate-only failure in this run; cause unestablished. Concurrent worktree validation was observed. PTY/process scheduling under contention is a hypothesis, not a diagnosis. No owning implementation, assertion, timeout or skip changed.
- **Next step:** capture which setup completion, PTY termination or fixture cleanup await is pending when the deadline expires.

- **Register repair (2026-10-29):** renumbered from the colliding 1304 to 1306; the original failure evidence and status are unchanged.

## Investigation — 2026-11-10

Still open; not reproduced. Phase timings captured with a temporary probe:
spawn 0.16–0.93 s, setup completion 0.01–0.41 s after it, and
`pty.terminate()` 2.1–4.3 s. The terminate step always waits out the full
2 s SIGTERM grace (`PTY_TERMINATE_GRACE_MS`) before the SIGKILL, because the
final `exec /bin/sh -l` on a PTY is an interactive shell, which ignores
SIGTERM. Under 18 unpinned burners at host load about 57 the whole test
took at most about 3.1 s
(`mise run test:logged -- --name b39-1306-contention -- bun scripts/test-under-contention.ts --burners 18 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/preview-terminal-roots.test.ts --parallel=1 --rerun-each=5`,
passed), far from 20 s, so the aggregate stall that hit the deadline is
still unidentified.

## Resolution (2026-11-15)

- **Class:** explicit budget smaller than the new default (A).
- **Root cause:** the test carried its own 20 s third-argument budget; measured phases are spawn ≤0.93 s, setup ≤0.41 s and `pty.terminate()` 2.1–4.3 s (the 2 s SIGTERM grace), so 20 s was exceeded only by a stalled host.
- **Fix:** the third argument is removed from `apps/backend/src/core/preview-terminal-roots.test.ts`, so `tests/default-test-timeout.ts` (a 60 s per-test and hook hang watchdog in both shared preloads, replacing Bun's 5 s default) applies.
- **Reproduced:** no — the unchanged code passed under the same contention; the evidence is the removed deadline, not a reproduced failure, which is weaker. A stall longer than 60 s would still fail, and would then be a real hang.
- **Stress:** `mise run test:logged -- --name b-cont -- bun scripts/test-under-contention.ts --core 2 --burners 6 -- bash -c 'cd apps/backend && bun test src/preview-tunnel-server.test.ts src/preview-publication.test.ts src/core/preview-local-discovery.test.ts src/core/preview-terminal-roots.test.ts --preload ../../tests/setup-node.ts --parallel=1 --rerun-each=3'` passed (59.7 s).
