# Local named-pipe line-count aggregate timeout

- **ID:** 0151
- **Status:** open
- **Date observed:** 2026-09-21
- **Test:** `Electron backend command registry > does not block local untracked scanning on a named pipe` (`tests/unit/electron/commands-files.test.ts:158`)
- **Original command:** `mise run test:changed`
- **Worker configuration:** root and agent-support group, Bun 1.4.2, `3x PARALLEL`, changed selection of 76/203 files
- **Failure:** `countLocalFileLines(worktree, "waiting.pipe")` did not resolve before Bun's 5,000 ms outer timeout; the case was reported at 5,006.15 ms.
- **Suite counts:** 2,201 total, 2,198 passed, 2 skipped, 1 failed, 1 error
- **Isolated rerun:** `mise run test:logged -- --name commands-files-isolated -- bun test ./tests/unit/electron/commands-files.test.ts --parallel=1 --only-failures` → passed (1.1 s for the owning file)
- **Hypothesis:** The failure currently correlates with aggregate host load and the generic five-second outer budget. The unchanged owning file completed quickly in isolation, so there is not yet evidence that the named-pipe guard itself blocks deterministically.
