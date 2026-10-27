# Keyboard shortcuts: Monaco startup under parallel browser load

- **ID:** 0792
- **Status:** resolved
- **Date:** 2026-10-25
- **Owner:** `e2e/KeyboardShortcuts.spec.ts`, `Meta shortcut wins over Monaco Delete Line`.
- **Revision:** `9ebb6ee6f`.

`ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name shortcuts-browser-verified -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=2 --output output/playwright/shortcuts-verified` reported 27 passed and one failed (54.7 seconds logged), alongside the repository and component browser suites. The mobile Meta case could not find Monaco's `Editor content` textbox within five seconds. Its accessibility snapshot contained the initial file value but no editor, so the failure preceded the shortcut interaction.

The complete unchanged owner passed all 28 mobile/desktop cases with one worker (95.4 seconds logged): `ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name shortcuts-browser-serial -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=1 --output output/playwright/shortcuts-serial`. Both Cmd/Ctrl collision assertions, focus round trips, terminal typing and viewport checks passed. No assertions, timeouts, skips or application behavior changed between these runs.

Failure evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.OsCV6b/shortcuts-browser-verified.log.gz` and `output/playwright/shortcuts-verified/KeyboardShortcuts-Meta-shortcut-wins-over-Monaco-Delete-Line-mobile-chromium/`. Passing screenshots are under `output/playwright/shortcuts-serial/`. The owning-file pass establishes intermittence; host contention is a possible cause, not a proven root cause.

## Resume cleanup coverage validation — 2026-10-25

The mobile Meta/Monaco case found no editor textbox at the five-second startup deadline in the five-worker component run. All unchanged owner cases passed in the sequential one-worker rerun.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the initial observation and the resume-cleanup recurrence above both missed the mobile Monaco textbox startup deadline, then passed in complete unchanged one-worker owner reruns. The only later change to the spec (#1240, 2a06be4a6) waits for the terminal textarea in two other tests, not for Monaco.
- **Next step:** check a failure trace for whether Monaco's lazy chunk was still loading; if so, wait for the editor with the longer startup budget the suite uses elsewhere.

## Keyboard shortcuts menu branch — 2026-10-27

- **Recurrence:** the branch `keyboard-shortcuts-8ea8474c65c7-r1` verification ran `e2e/KeyboardShortcuts.spec.ts` beside other suites and again missed the mobile Monaco `Editor content` textbox at the five-second `toBeAttached` deadline; the same case failed on an `origin/main` comparison run. Every other shortcut case passed with one worker.
- **Owner reruns:** `bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --repeat-each=3` passed 102/102 (nine workers, 1.0 min). `... e2e/KeyboardShortcuts.spec.ts e2e/MonacoRuntime.spec.ts --project=mobile-chromium --repeat-each=8 --workers=16` passed 136, skipped 8 (1.4 min).
- **Fix:** every recorded failure happened before the shortcut was pressed, while Monaco's lazy chunk was still loading. The editor-startup wait now has a 30-second budget, like other startup waits in `e2e/`. The shortcut, Delete Line, focus-return and typing assertions keep the default deadline, so a shortcut regression still fails quickly.
- **Disposition:** resolved by the startup budget. Reopen this case if the failure comes back after the editor is attached.
