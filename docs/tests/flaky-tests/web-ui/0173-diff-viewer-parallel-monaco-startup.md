# Diff viewer Monaco startup misses visibility checks in the parallel browser suite

- **ID:** 0173
- **Status:** open
- **Date observed:** 2026-09-28
- **Tests:** `the diff header fits a phone and the editor uses the full width`; `the new file state renders accessibly on a phone`; `the deleted file state renders accessibly on a phone` (observed across the two runs)
- **File:** `e2e/DiffViewerMobile.spec.ts`
- **Original command:** `mise run test:logged -- --name markdown-browser-suite -- mise run test:browser` (150 tests, six Playwright workers), while the repository suite and other worktrees were running.
- **Failure:** `.monaco-diff-editor` was missing or hidden at the five-second visibility deadline.
- **Isolated rerun:** `mise run test:logged -- --name browser-diff-viewer-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` passed.
- **Second parallel run:** Both cases passed in a repeat of the full browser suite.
- **Additional run:** A separate six-worker browser run alongside the repository suite timed out on all three mobile cases; 97 passed, 48 skipped, and 5 failed across 150 cases. The owning file passed with two workers. In a later browser suite run without the repository suite, every Diff Viewer case passed.

## Current assessment

The fixture uses the real Monaco editor, whose startup may take longer under parallel load. The diff viewer code did not change in this task.

## 2026-10-16 recurrence

`mise run test:browser` on `overnight-opencode-skew-guard-854f012a1bb0` (browser
fixture-server ownership guard; no diff viewer code changed) failed the two
mobile cases `the diff header fits a phone and the editor uses the full width`
and `the new file state renders accessibly on a phone`, with 254 passed, 61
skipped and 3 failed across 318 cases (2.8 m); the third failure was case 0249.
The failure text was not kept. `bunx playwright test --config
e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/MultiReviewFlow.spec.ts
--workers=1` passed (21 passed, 5 skipped), and a repeat of the full browser
suite passed (257 passed, 61 skipped).


## Mobile layout follow-up main merge recurrence — 2026-10-16

- **Original command:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser -- mise run test:browser`
  while merging `origin/main` into `mobile-layout-gaps`.
- **Worker configuration:** nine Playwright workers alongside the repository
  suite and other validations on the shared host.
- **Suite counts:** 310 passed, 69 skipped and three failed across 382 cases
  (5.2 minutes). The other failures are recorded in 0174.
- **Failure:** The desktop cases `the mounted diff switches exactly at the mobile breakpoint` (line 134) and `the desktop diff keeps its mode controls and full-ref tooltip` (line 161) found no `.monaco-diff-editor` within 5000 ms.
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DiffViewerMobile.spec.ts --workers=1`
  passed both unchanged owning files (exit 0, 51.6 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.r2KR91/merge-latest-browser.log.gz`.
- **Disposition:** parallel-only recurrence matching the existing case. Host
  contention remains a hypothesis; no assertion, timeout or skip changed.

## Unread-toast main merge recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine Playwright workers alongside the full non-iOS suite and isolated browser checks.
- **Failure:** The mobile `the diff header fits a phone and the editor uses the full width` case found no `.monaco-diff-editor` within 5000 ms.
- **Suite counts:** 320 passed, 69 skipped, three failed across 392 cases (294.6 s).
- **Owning-file rerun:** `mise run test:logged -- --name merge-diff-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` passed the unchanged file in 17.1 s (exit 0).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.o1XC99/merge-browser.log.gz`.
- **Disposition:** confirmed recurrence. Earlier overlapping focused browser invocations shared an output directory and are discarded as invalid evidence; the successful rerun ran sequentially. Host contention remains an unconfirmed hypothesis.

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`; nine Playwright workers alongside the non-iOS suite.
- **Failure:** The mobile `the new file state renders accessibly on a phone` case found no `.monaco-diff-editor` within 5000 ms.
- **Suite counts:** 323 passed, 69 skipped, four failed across 396 cases (247.6 seconds). The native branch-picker failure also failed alone and is not classified as a flake.
- **Owning-file rerun:** `mise run test:logged -- --name merge-diff-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` passed the unchanged file (exit 0) in 12.3 seconds. Browser reruns ran sequentially.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2CnKQx/merge-browser.log.gz`.
- **Assessment:** intermittent under the aggregate browser run; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Agent-test credential review recurrence — 2026-10-17

The nine-worker `mise run test:browser` run found no `.monaco-diff-editor`
within five seconds in the unchanged mobile header case (335 passed, 80 skipped,
five failures across 420 cases).
`mise run test:logged -- --name browser-diff-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1`
then passed the owning file in 25.7 seconds. Browser reruns ran sequentially.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iMEuX0/browser.log.gz`.

## Pending Resolve review recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name resolve-browser -- mise run test:browser`, nine Playwright workers alongside repository and isolated-browser validation.
- **Failure:** The mobile `the diff header fits a phone and the editor uses the full width` case found no `.monaco-diff-editor` within 5000 ms.
- **Suite counts:** 338 passed, 80 skipped, two failed across 420 cases in 291.7 seconds. The other failure is case 0342.
- **Owning-file rerun:** `mise run test:logged -- --name resolve-browser-owner-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts --workers=1` passed both unchanged files (exit 0, 42.1 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NgqDST/resolve-browser.log.gz`.
- **Assessment:** Matches the existing startup symptom. Host contention and overlapping Vite updates remain possible contributors; no diff-viewer code or test changed.

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name browser -- mise run test:browser` ran 432
cases with nine workers: 348 passed, 80 skipped and four failed in 329.2 s.
`the diff header fits a phone and the editor uses the full width` could not find `.monaco-diff-editor` within five seconds.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kKsMFU/browser.log.gz`.

The unchanged owning files passed sequentially with one worker:
`mise run test:logged -- --name browser-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts e2e/CloseRetention.spec.ts --workers=1`
(exit 0, 96.6 s logged). Other worktrees and real-stack checks were active on
the host. Startup contention remains an unconfirmed hypothesis; no assertion
or timeout changed.

## Public landing-page review observation — 2026-10-18

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser` on macOS arm64, while the full unit suite and other worktrees were also validating.
- **Failure:** the mobile `the diff header fits a phone and the editor uses the full width` case could not find `.monaco-diff-editor` within 5000 ms.
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=1443 mise run test:logged -- --name diff-viewer-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` repeated the same failure (four passed, five skipped, one failed; 49.6 seconds logged).
- **Evidence:** aggregate `orkestrator-test-run.OwH8yL/browser.log.gz` and isolated `orkestrator-test-run.StTZ0J/diff-viewer-rerun.log.gz` under the host temporary directory.
- **Assessment:** this occurrence does not independently establish a flake because the unchanged owning file also failed alone. Monaco initialization remains an unresolved validation limitation; no diff-viewer source, assertion, timeout, or skip changed. All eight production public-site smoke checks passed separately.


## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `the diff header fits a phone and the editor uses the full width`
- `the new file state renders accessibly on a phone`
- `the deleted file state renders accessibly on a phone`
- `the mounted diff switches exactly at the mobile breakpoint`
- `the desktop diff keeps its mode controls and full-ref tooltip`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## Electron preview main merge observation — 2026-10-18

The nine-worker component suite failed this owner, and its one-worker rerun still could not find `.monaco-diff-editor` for the mobile header case. The unchanged owner therefore remains an unresolved validation limitation for this occurrence. Counts, commands and artifacts are in [0382](0382-component-browser-parallel-load.md). No implementation, assertion, timeout or skip changed.

## CLI matrices main merge observation — 2026-10-18

- **Original command:** `ORKESTRATOR_E2E_PORT=49371 ORKESTRATOR_PUBLIC_E2E_PORT=49372 mise run test:logged -- --name merge-browser -- mise run test:browser`, nine workers alongside the full non-iOS suite.
- **Result:** 351 passed, 80 skipped and one failed across 432 component cases (258.5 seconds logged). The failure was mobile `the diff header fits a phone and the editor uses the full width`: `.monaco-diff-editor` was absent at the 5000 ms deadline.
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=49371 mise run test:logged -- --name merge-diff-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1` repeated the same failure (4 passed, 5 skipped, 1 failed; 40.3 seconds logged).
- **Evidence:** `orkestrator-test-run.lReU9r/merge-browser.log.gz` and `orkestrator-test-run.WoFi5z/merge-diff-owner.log.gz` under the host temporary directory.
- **Assessment:** unresolved validation limitation, matching the earlier public landing-page review observation; this occurrence does not establish intermittence. No diff-viewer implementation, assertion, timeout or skip changed.
- **Public-site validation:** the component failure short-circuited the combined task, so `ORKESTRATOR_PUBLIC_E2E_PORT=49372 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts` ran separately and passed all eight production smoke cases (28.9 seconds logged), including desktop/mobile login, reload, lazy loading and clipboard feedback. Playwright stopped its owned servers; no application profile was created.

## CLI matrices second main merge — 2026-10-18

The aggregate desktop breakpoint-switching case failed to find `.monaco-diff-editor`; the one-worker owning-file rerun passed that case but failed the mobile editor check. This observation remains unresolved because the whole unchanged owner did not pass. Full commands, 339-pass/80-skip/13-failure aggregate and 96-pass/15-skip/three-failure focused counts, and evidence paths are in [0382](0382-component-browser-parallel-load.md). No implementation, assertion, timeout or skip changed.

## Async question prefix review recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=18471 ORKESTRATOR_PUBLIC_E2E_PORT=18472 mise run test:logged -- --name browser-suite-isolated-ports -- mise run test:browser`
reported 357 passed, 80 skipped and three failed with nine workers alongside
repository and real-stack validation. The mobile header case found no Monaco
diff editor at its five-second startup deadline. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Yj5dRp/browser-suite-isolated-ports.log.gz`.

`ORKESTRATOR_E2E_PORT=18473 mise run test:logged -- --name browser-failed-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts --workers=1`
passed both unchanged owning files sequentially (35.4 seconds logged). This
confirms intermittence; no assertion, timeout or skip changed.

## Agent-mail review validation recurrence — 2026-10-19

- `mise run test:logged -- --name browser -- mise run test:browser` ran five browser workers alongside repository and isolated-browser validation. The mobile header and new-file cases did not find `.monaco-diff-editor` within five seconds. The suite finished with 346 passed, 80 skipped and six failed in 7.5 minutes.
- The unchanged owning file passed alone: `mise run test:logged -- --name browser-diff-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts --workers=1 --output output/playwright/mail-review-diff` (exit 0, 18.6 seconds).
- Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.xmUT5O/browser.log.gz`.
- No timeout, assertion or skip changed. Host load was high; causality remains unconfirmed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.
