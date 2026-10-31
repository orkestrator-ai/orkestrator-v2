# Codex title runner > the pinned Codex parser accepts the production argument shape and secured catalog (apps/backend/src/core/session-title-runners.test.ts)

- **ID:** 1460
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Original command:** `mise run test:logged -- --name 0006-default-rerun -- mise run test`
- **Worker configuration:** default `mise run test` groups on an arm64 Mac, with a just-copied `binaries/codex`
- **Failure:** `spawnSync` status `null` instead of `0` at the bun test's default 5 s limit, with `killed 1 dangling process` (duration: 5001.96 ms)
- **Suite counts:** one failure in the backend package of the workspace group; web in the same group had 10874 passed, 10 skipped, 0 failed
- **Isolated rerun:** `bun test ./src/core/session-title-runners.test.ts` in `apps/backend`, three times → passed each time (10 pass, about 2 s)
- **Hypothesis:** The first exec of a newly placed binary is slow on macOS. Timing `codex exec --help` on a fresh copy of the same verified binary gave 4.75 s for the first run and 0.01 s for the second. The test makes two spawns under the default 5 s limit, so the first test run after an install can overrun it, more easily under suite load.
- **Root cause:** A test that waits on a real 268 MB executable used the default 5 s timeout, which the first exec of a new file nearly fills on its own.
- **Fix:** Gave the test an explicit 30 s timeout in the branch for to-do 0006, as the repository's other real-process tests have. The assertions are unchanged.
- **Verification:** Replaced `binaries/codex` with a fresh copy and ran the owning file: 10 pass, 0 fail. A full `mise run test` on the same branch is recorded in the to-do 0006 report.
