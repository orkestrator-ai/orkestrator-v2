# Keyboard shortcuts: Monaco startup under parallel browser load

- **ID:** 0792
- **Status:** open
- **Date:** 2026-10-25
- **Owner:** `e2e/KeyboardShortcuts.spec.ts`, `Meta shortcut wins over Monaco Delete Line`.
- **Revision:** `9ebb6ee6f`.

`ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name shortcuts-browser-verified -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=2 --output output/playwright/shortcuts-verified` reported 27 passed and one failed (54.7 seconds logged), alongside the repository and component browser suites. The mobile Meta case could not find Monaco's `Editor content` textbox within five seconds. Its accessibility snapshot contained the initial file value but no editor, so the failure preceded the shortcut interaction.

The complete unchanged owner passed all 28 mobile/desktop cases with one worker (95.4 seconds logged): `ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name shortcuts-browser-serial -- bunx playwright test --config e2e/playwright.config.ts e2e/KeyboardShortcuts.spec.ts --workers=1 --output output/playwright/shortcuts-serial`. Both Cmd/Ctrl collision assertions, focus round trips, terminal typing and viewport checks passed. No assertions, timeouts, skips or application behavior changed between these runs.

Failure evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.OsCV6b/shortcuts-browser-verified.log.gz` and `output/playwright/shortcuts-verified/KeyboardShortcuts-Meta-shortcut-wins-over-Monaco-Delete-Line-mobile-chromium/`. Passing screenshots are under `output/playwright/shortcuts-serial/`. The owning-file pass establishes intermittence; host contention is a possible cause, not a proven root cause.


## Resume cleanup coverage validation — 2026-10-25

The mobile Meta/Monaco case found no editor textbox at the five-second startup deadline in the five-worker component run. All unchanged owner cases passed in the sequential one-worker rerun.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.
