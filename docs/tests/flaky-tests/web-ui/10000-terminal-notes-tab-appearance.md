# Terminal Notes tab did not appear in the aggregate run

- **ID:** 10000
- **Status:** resolved
- **Date observed:** 2026-11-18
- **Base:** `259e88d90c9cb3e6e24de95d8333dbc5a12cbef2`.
- **Observed branch:** `sol-availability-issue-178b6467a4b3-r1`, reviewing `2ee6bc84b29bf761282c9c08b0a78a1d940f99a9` with the catalogue changes applied in `0df400360`.
- **File:** `apps/web/src/components/terminal/TerminalContainer.notes.test.tsx:84`
- **Test:** `Notes activation creates and renders a real pane tab, and reopening reuses it`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`. The workspace group was granted six worker slots, with Bun running the web package at `--parallel=2`.
- **Failure:** The first `findByRole("tab", { name: /^Notes/ })` threw `Unable to find role="tab" and name /^Notes/` after 1,281.72 ms. The test had yet to activate the Notes tab.
- **Suite counts:** The web package reported 15,161 passed, 10 skipped and 4 failed across 1,059 files.
- **Isolated rerun:** `mise run test:logged -- --name notes-owning-test -- bun --cwd=apps/web test src/components/terminal/TerminalContainer.notes.test.tsx --parallel=1 --only-failures` passed its one test in 4.6 s (command wall time). The aggregate runner also passed the owning file in 4.3 s.
- **Aggregate evidence:** `orkestrator-test-run.BtAXFZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` in the host temporary directory.

The cause is unconfirmed. The test failed while waiting for the pipeline's Notes control to appear. Reproduce under contention and verify whether the pipeline graph can lose its first render before adjusting the test.

## Recurrence on 2026-11-22

- **Branch and base:** `move-tmux-domain-32f62767dcd1-r1` at `02023f1a03bf72a0d8fac833bd0a2056aeacf597`, base `81a501415eab64566939eb76afe1d59432330e32`. The registry recurrence check confirmed case 10000 was open.
- **Original command:** `mise run test:full`, with the web package using Bun `--parallel=2`.
- **Failure:** The first Notes tab lookup again reported `Unable to find role="tab" and name /\^Notes/` after 1,433.77 ms.
- **Suite counts:** 16,137 passed, 10 skipped and 1 failed across 1,147 web test files.
- **Isolated rerun:** The aggregate runner ran `bun test ./src/components/terminal/TerminalContainer.notes.test.tsx --only-failures --parallel=1` from `apps/web`. Its one test passed in 1.34 s.
- **Aggregate evidence:** `orkestrator-test-run.slc14y/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.slc14y/rerun-apps-web-src-components-terminal-terminalcontainer-notes-test-tsx.log.gz` in the host temporary directory. The cause remains unconfirmed.

## Resolution (2026-11-25)

- **Root cause:** Testing Library's one-second default. The pipeline graph's
  lazy modules and React Flow mount come before its Notes node, which takes
  longer than that on a starved worker; the node then appears.
- **Fix:** the file uses `useAsyncUtilHangWatchdog()` (30 s), the repository's
  helper for waits on a state the component will reach. No assertion changed.
- **Reproduced:** yes. Twelve fresh processes of the file under
  `bun scripts/test-under-contention.ts --core 14 --burners 10` failed 12 of 12
  with the recorded error (1.8 to 2.2 s); with the fix 12 of 12 passed.
- **Stress:** the command above.
