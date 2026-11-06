# Terminal history backward paging misses a request in the aggregate

- **ID:** 0513
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `TerminalHistoryPanel > keeps the page cache bounded during repeated backward paging`
- **Owning file:** `apps/web/src/components/terminal/TerminalHistoryPanel.test.tsx`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
  on `fix-agent-test-host-home-writes-c7337a6ddd7f`, based on `a8128980`,
  with credential snapshot and OpenCode preference fixes. The renderer owner
  was unchanged. Workspace/root/bridges/protocol reserved 4/1/2/1 slots;
  the web suite used two isolated Bun workers.
- **Failure:** `toHaveBeenCalledTimes` expected 18 calls and observed 17;
  the case failed after 1307.84 ms.
- **Suite counts:** web reported 8,531 passed, ten skipped and one failed
  across 8,542 tests in 515 files (252.18 seconds).
- **Isolated rerun:** `mise run test:logged -- --name terminal-history-rerun --
  bun test --cwd apps/web ./src/components/terminal/TerminalHistoryPanel.test.tsx
  --parallel=1 --only-failures` passed the entire unchanged owning file,
  exit 0, in 1.6 seconds.
- **Evidence:** `orkestrator-test-run.9G1j25/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  below the host temporary directory; outer log in `orkestrator-test-run.TM4iwl`.
- **Aggregate outcome:** exit 1 after 735.0 seconds. The other failing test
  was the unchanged submodule-move owner, recorded in [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md).
  All other workspace packages, root/support, bridges and protocol regeneration passed.
- **Hypothesis:** asynchronous page-request completion may have exceeded the
  assertion's polling window under shared host load; not established.
- **Changes:** evidence only; no implementation, assertion, timeout or skip changed.

### Resolution — 2026-11-06

**Root cause.** `TerminalHistoryPanel` ignores "Load earlier" while a page is
loading (the button is disabled and `loadingRef` guards it). For pages 19–5
the test waited for the page's text before the next press. From page 4 on it
only waited for the request count, so the next press could arrive while that
page was still loading. The press was then dropped, and the count stayed one
short (expected 18, received 17, as reported).

**Reproduction.** A copy of the unchanged owner whose page mock resolves after
30 ms reproduced the exact failure (expected 18 calls, received 17).

**Fix.** `apps/web/src/components/terminal/TerminalHistoryPanel.test.tsx`:
before each press, the test waits until "Load earlier" is enabled again (the
previous page has landed). No assertion changed.

**Verification.** The 30 ms-delay copy passes with the fix. Then
`mise run test:logged -- --name web-0513-stress -- bun --cwd=apps/web test src/components/terminal/TerminalHistoryPanel.test.tsx --rerun-each=20`
passed (exit 0).
