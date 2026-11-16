# Local named-pipe line-count aggregate timeout

- **ID:** 9852
- **Status:** resolved
- **Date observed:** 2026-09-21
- **Test:** `Electron backend command registry > does not block local untracked scanning on a named pipe` (`apps/backend/tests/commands-files.test.ts:158`)
- **Original command:** `mise run test:changed`
- **Worker configuration:** root and agent-support group, Bun 1.4.2, `3x PARALLEL`, changed selection of 76/203 files
- **Failure:** `countLocalFileLines(worktree, "waiting.pipe")` did not resolve before Bun's 5,000 ms outer timeout; the case was reported at 5,006.15 ms.
- **Suite counts:** 2,201 total, 2,198 passed, 2 skipped, 1 failed, 1 error
- **Isolated rerun:** `mise run test:logged -- --name commands-files-isolated -- bun test ./apps/backend/tests/commands-files.test.ts --parallel=1 --only-failures` → passed (1.1 s for the owning file)
- **Hypothesis:** The failure currently correlates with aggregate host load and the generic five-second outer budget. The unchanged owning file completed quickly in isolation, so there is not yet evidence that the named-pipe guard itself blocks deterministically.

## Resolution (2026-11-15)

- **Root cause:** The named-pipe scan runs in a `node` child through `spawnSync` with a 2 s timeout, and the test had Bun's 5 s budget; a loaded host spent both starting processes.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only. The `spawnSync` timeout in `apps/backend/tests/commands-files.test.ts` is now 30 s and documented as a hang watchdog only: a scanner that opened the pipe blocks forever, so any finite bound still separates it from one that skips the pipe. The test budget is `ASYNC_TEST_BUDGET_MS` (60 s, `apps/backend/tests/command-fixtures.ts`).
- **Reproduced:** no — the recorded deadline was Bun's default budget on a loaded host; the failing body is fast alone, and a 5 s exhaustion was not re-created per case here.
- **Stress:** `mise run test:logged -- --name ec-stress-a -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --core 15 --burners 6 -- bun test --preload ../../tests/setup-node.ts <the twelve commands-* owners, this one included> --rerun-each=2 --parallel=1'` at host load about 80: 736 passed, 2 failed, both `serves the Files panel from the scan the badge already ran`, which stays open in [9854](9854-electron-diff-statistics-aggregate-timeout.md); no other case failed.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).
