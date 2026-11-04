# Seeded preview check 2 never finds the moved server's address in the terminal

- **ID:** 4470
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `2. with both servers running each environment opens only its own, and a moved server is offered as a move`
- **File:** `e2e/agent-testing/service-preview-seeded-electron.spec.ts:631`
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=seeded-3230-final mise run test:logged -- --name seeded-electron-final -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts service-preview-seeded-electron.spec.ts`
- **Worker configuration:** Bun 1.4.4 on macOS 27.0 arm64, one Playwright worker, the owning file alone (Electron with a disposable agent-test profile). Other work on the host at the time was not measured.
- **Failure:** after 59.87 s, `the dev server prints http://127.0.0.1:59801/`, `Timeout 60000ms exceeded while waiting on the predicate`, last state `not printed yet`. Suite counts: 1 passed, 1 failed, 4 skipped (serial).
- **Isolated rerun:** the same command on the same commit (`b666f15fc`) then passed five times in a row, 6 passed each. Across that branch's runs with the fix, nine of ten passed.
- **Evidence:** `output/agent-testing/seeded-3230-final/electron/` in the worktree (git-ignored; `results.json`, `error-context.md`, `electron-diagnostics.txt`, trace). The diagnostics hold only environment B's expected `target-unverified` refusals, and no terminal contents, so they do not show what the server printed.
- **Hypothesis (unconfirmed):** `freePortPair` checks that port N+1 is free, then the check presses **Run** much later. N+1 is in macOS's ephemeral range (49152–65535), so something else on the host could take it; the fixture server would then move on to N+2, and the spec, which looks only for N+1, would wait out its 60 s. Alternatively the address was printed but was not in the terminal viewport, the only rows `terminalLinkPoint` reads. Neither was observed.
- **Related change:** found while qualifying [3230](../../../todo/previews-and-annotations/3230-restart-inside-verification-window.md). The failing step is before any restart, and starting a server and reading its terminal do not go through `acquireTarget`, which is the only path that change alters.
