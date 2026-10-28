# Design canvas Electron journey: graceful quit misses its 30-second deadline

- **ID:** 1131
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `design canvas opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes in Electron`
- **File:** `e2e/agent-testing/design-canvas-electron.spec.ts:137`
- **Failure:** `Error: Owned processes did not exit` from `waitForStopped` (`e2e/process-cleanup.ts:46`), via `closeElectron` (`e2e/agent-testing/design-electron-cleanup.ts:50`). Electron's owned process tree was still alive 30 seconds after `app.quit()`. Forced cleanup then stopped it, but a failed graceful shutdown fails qualification by design.

## Observations

- **Branch `keyboard-shortcuts-8ea8474c65c7-r1` (HEAD `be5fdcf35`), 2026-10-27:**
  `ORKESTRATOR_AGENT_TEST_RUN_ID=shortcuts-r2 bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts -g "shares one backend across independent windows|Run interactive opens a sandboxed host view|design canvas opens, edits, exports|a leaf's workspace opens in the window's central region"`
  gave three passed and one failed (2.0 min). The design journey itself completed, including its keyboard-shortcuts assertions. The only error was the quit deadline above. An earlier run on the same branch (`shortcuts-design-regression`, 02:36 UTC) failed the same way.
- **`origin/main` `863b57821`, 2026-10-27:** in a separate detached worktree (`bun install --frozen-lockfile`, `bun run build` in `apps/desktop`), `ORKESTRATOR_AGENT_TEST_RUN_ID=shortcuts-main-design bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts -g "design canvas opens, edits, exports"` failed with `Journey and cleanup failures`. The journey hit a `locator.click` timeout at `design-canvas-electron.spec.ts:303`, and cleanup hit the same `Owned processes did not exit`.
- **Host:** 18 CPUs, load averages 60–120 from other worktrees' full suites during both runs.

## Assessment

The deadline reproduces on `origin/main`, so it predates the keyboard-shortcuts branch, whose main-process input hooks add no quit-time work. The process table at the deadline was not captured, so we don't yet know which descendant outlived the quit. Host load is a possible cause, not a proven one; [0671](0671-design-electron-preview-group-shutdown.md) is the earlier Vite-group shutdown case for the same spec.

**Next step:** capture `ps -axo pid,ppid,stat,command` for the owned tree when `waitForStopped` times out, then rerun the owner on a quiet host.

## Dialog-width review repair recurrence (2026-10-28)

The required exact rerun of
`mise run test:logged -- --name agent-electron -- mise run test:agent:electron`
(one worker) repeated `Owned processes did not exit` from the same design
journey cleanup path after its UI assertions completed. The suite finished with
33 passed, four failed, one skipped and six not run in 608.9 seconds. The other
failures concerned service-preview HMR, annotation process shutdown, and a
workspace-realm screenshot. No new isolated reproduction or root-cause claim
is made for this recurrence. Compressed evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Fk5GUs/agent-electron.log.gz`.
