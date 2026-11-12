# Collapsing finished Notes loses the graph's horizontal pan in the browser aggregate

- **ID:** 9946
- **Status:** open
- **Date observed:** 2026-11-12
- **Base:** `acc3d6834cafd02e76729958b25078c7337253b0` (`main`).
- **Observed head:** `83984fd3d` on branch `fix-flaky-tests-400972eda2c6-r1`.
  The branch changes transcript code (`VirtualizedMessageList.tsx`,
  `useNativeAgentSession.ts`, `useAutoLoadEarlier.ts`), the ToolGroupFold and
  TranscriptPaging specs, backend and CLI tests, and documentation; nothing
  the pipeline flow view or its fixture imports.
- **Test:** `collapsing finished Notes preserves the reader's pan and panel position`
  (`e2e/PipelineFlow.spec.ts:1069`)
- **Browser:** Chromium, `desktop-chromium` project.

## Symptom

After the Pipeline section is collapsed and reopened, the poll for the flow
viewport's `scrollLeft` read 2503 instead of 0 for its whole 5 s budget
(line 1090). The overview's `scrollTop` (40) had already been restored on the
line before.

## Runs

macOS host, 18 cores, shared with other worktrees (load average 11 to 14
during the run):

- `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name browser -- mise run test:browser`
  (default workers): 1,726 passed, 154 skipped, 2 failed (this case and
  [9947](../environments-and-containers/9947-github-cli-setup-poll-alert-under-load.md)),
  20.9 min. Evidence:
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.1lmH9a/browser.log.gz`.
- `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name pipelineflow-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/PipelineFlow.spec.ts --retries=0`:
  the complete owning file passed (61.6 s).

## Hypothesis

Unconfirmed. 2503 px looks like the graph's own initial scroll toward its
active or final stage, landing after the test set `scrollLeft = 0`, so on a
loaded page the reopened graph re-applied its initial placement instead of
the reader's pan. Not investigated further in the change that observed it.
