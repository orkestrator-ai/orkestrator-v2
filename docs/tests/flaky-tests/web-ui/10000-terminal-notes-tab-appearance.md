# Terminal Notes tab did not appear in the aggregate run

- **ID:** 10000
- **Status:** open
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
