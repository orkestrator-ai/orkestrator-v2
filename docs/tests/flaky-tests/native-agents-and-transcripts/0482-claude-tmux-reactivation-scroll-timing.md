# Claude tmux reactivation reads the scroll call before it arrives

- **ID:** 0482
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `ClaudeTmuxChatTab > jumps to the bottom when reactivated after an environment switch`
- **File:** `tests/unit/components/ClaudeTmuxChatTab.test.tsx:999`
- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name merge-tests -- mise run test`, merging `c85ab60a` into `5d588218`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; root used one isolated Bun worker, alongside browser validation and other worktrees.
- **Failure:** the expected `scrollTo` call was `undefined` after the `scrollToIndex` wait passed (632.80 ms).
- **Root counts:** 3082 passed, one skipped and two failed across 3085 tests in 142 files (959.23 s). The other failure was Pi runtime vendoring (0178).
- **Owning-file rerun:** `mise run test:logged -- --name merge-claude-tmux-owner -- bun test ./tests/unit/components/ClaudeTmuxChatTab.test.tsx --parallel=1 --only-failures` passed unchanged, exit 0, in 15.6 s.
- **Evidence:** `orkestrator-test-run.Yk2l1H/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent observation; delayed effect or scroll delivery under shared-host load is a hypothesis. No source, assertion, timeout or skip changed.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-tests -- mise run test` reproduced the undefined `scrollTo` call at `tests/unit/components/ClaudeTmuxChatTab.test.tsx:1001` (594.29 ms) with workspace/root/bridges/protocol worker reservations 4/1/2/1. The root group reported 3179 passed, one skipped and one failed across 3181 tests in 151 files (505.03 s). Browser and Electron checks also ran on the shared host.
- The unchanged owning file passed: `mise run test:logged -- --name merge-tmux-owner -- bun test ./tests/unit/components/ClaudeTmuxChatTab.test.tsx --parallel=1 --only-failures` (exit 0, 10.9 s logged).
- Evidence: `orkestrator-test-run.4IXzMM/root-and-agent-support-tests.log.gz` in the host temporary directory. Delayed effect or scroll delivery remains a hypothesis. No source, assertion, timeout or skip changed.
