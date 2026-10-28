# Tool-group overflow follows an appended call in the aggregate

- **ID:** 0747
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `a waiting group that fits its cap follows appended calls as it starts overflowing`
- **Owning file:** `e2e/ToolGroupFold.spec.ts:245` (mobile Chromium).
- **Original command:** `ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-components-bounded -- bunx playwright test --config e2e/playwright.config.ts --workers=2`.
- **Failure:** the inner group's `scrollTop` was 704 instead of zero at the five-second poll (`:274`).
- **Suite counts:** 682 total, 575 passed, 102 skipped, five failed (1188.3 s logged).
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-tool-group-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/merge-tool-group-owner` passed (68.3 s logged). Its `.last-run.json` reports `passed` and no failed tests.
- **Evidence:** host temporary artifact `orkestrator-test-run.Qvr7ev/merge-components-bounded.log.gz`; original browser artifacts under `output/playwright/test-results/`; passing owner output under `output/playwright/merge-tool-group-owner/`.
- **Context:** merge parents `3b5f889149d8c3603c869cd15b51d67af39c9aa6` and `0014505caeed69395b3cc996dd541fcc6df12c23`. Renderer and owning spec match `origin/main`.
- **Hypothesis:** browser timing or follow-state interaction under shared-host load; no cause has been established. The initial nine-worker run also suffered widespread navigation timeouts at host load average 160 and was interrupted before this bounded run. No assertion, timeout or skip changed.

## Multi Review inspector validation recurrence, 2026-10-24

- `mise run test:logged -- --name browser-suite -- mise run test:browser`
  ran 690 component cases with nine workers: 585 passed, 102 skipped and
  three failed (317.2 s). This case failed on desktop Chromium with the same
  `scrollTop` mismatch: 704 instead of zero at `:274`. The other two failures
  were the previously recorded native branch-suggestion cases in
  `e2e/AgentLaunchDialog.spec.ts`; all Multi Review cases passed.
- Both complete unchanged owners were rerun sequentially with
  `mise run test:logged -- --name browser-failure-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts e2e/AgentLaunchDialog.spec.ts --workers=1`.
  All sixteen ToolGroupFold cases passed. Both native branch-suggestion cases
  reproduced (`release/2.0` expected, `rel` received), leaving the combined
  rerun at eighteen passes and two failures (40.7 s). No assertions, skips or
  timeouts changed.
- Evidence: host temporary artifacts
  `orkestrator-test-run.3eBrrh/browser-suite.log.gz` and
  `orkestrator-test-run.r0ASNK/browser-failure-owners.log.gz`.
  The separate public-site browser suite passed (11.1 s).

## Transcript arrival validation — 2026-10-25

- `ORKESTRATOR_E2E_PORT=1462 mise run test:logged -- --name arrival-final-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptArrival.spec.ts e2e/ToolGroupFold.spec.ts --workers=2 --output output/playwright/arrival-final`
  ran 62 cases: 61 passed and this mobile case failed in 105.9 s. At
  `ToolGroupFold.spec.ts:471`, inner `scrollTop` was 704 instead of zero after
  the reader left the end of the virtualized body. All 24 arrival cases passed.
- The complete unchanged owning file passed all 38 cases in 116.1 s:
  `ORKESTRATOR_E2E_PORT=1462 mise run test:logged -- --name fold-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/fold-owner`.
- Evidence: host temporary artifacts `orkestrator-test-run.A2vguk/arrival-final-browser.log.gz`
  and `orkestrator-test-run.sbeXTO/summary.json`; browser failure artifacts are
  under `output/playwright/arrival-final/`. Repository and isolated application
  suites were also running. Timing or follow-state interaction under load
  remains a hypothesis. No owner assertion, timeout or skip changed.

## Resume cleanup coverage validation — 2026-10-25

The desktop waiting-group case received inner scrollTop 704 instead of zero in the five-worker component run and again in the complete unchanged one-worker owner rerun. No new owner pass was established; both results remain failed.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** three recurrences (two-worker, nine-worker, and two-worker on 2026-10-25), each with `scrollTop` 704 instead of zero and a passing one-worker owner rerun. The resume-cleanup recurrence above also failed in the unchanged one-worker owner, so this case does not always pass in isolation. The test is now at `ToolGroupFold.spec.ts:442` after #1227. [0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md) also reported a painted-gap failure at `ToolGroupFold.spec.ts:79` in the same file.
- **Next step:** record the group's follow state and inner `scrollTop` on each frame during the append, so the next failure shows whether follow was lost or never set.


## Hidden-resume review recurrence — 2026-10-26

- **Failure:** Desktop `a waiting group that fits its cap follows appended calls as it starts overflowing` retained inner scrollTop 704 instead of zero at five seconds.
- **Complete unchanged owner:** `mise run test:logged -- --name tool-group-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/resume-tool-group-owner` passed (100.3 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.

## Title-tooltip (todo 0202) validation recurrence — 2026-10-27

- **Failure:** Mobile `a waiting group that fits its cap follows appended calls as it starts overflowing` retained inner scrollTop 704 instead of zero (`ToolGroupFold.spec.ts:471`) in `mise run test:browser` with nine Playwright workers (774 passed, 103 skipped, three failed).
- **Complete unchanged owner:** `mise run test:logged -- --name toolgroupfold -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts` passed (23.9 s logged).
- **Aggregate evidence:** [1155](../aggregate-validation-runs/1155-webkit-title-tooltip-0202-validation.md). The branch changes only `MobileAppShellLayout` and its tests, which this spec does not render.
- **Assessment:** intermittent recurrence; no owning source, assertion, deadline or skip changed.


## AGENTS.md review-fix validation recurrence — 2026-10-27

- **Failure:** Desktop `a waiting group that fits its cap follows appended calls
  as it starts overflowing` retained inner scrollTop 704 instead of zero at
  `ToolGroupFold.spec.ts:471` after five seconds.
- **Aggregate:** `mise run test:logged -- --name agents-md-browser-full -- mise run test:browser`,
  nine Playwright workers; 858 passed, 105 skipped, three failed (493.0 s).
  Both other failures were the native branch picker. All ten AGENTS.md approval
  browser cases passed.
- **Complete unchanged owner:**
  `mise run test:logged -- --name agents-md-baseline-fold -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts`
  passed (exit 0, 19.6 s).
- **Evidence:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ypVY2E/agents-md-browser-full.log.gz`;
  the original Playwright trace is under
  `output/playwright/test-results/ToolGroupFold-a-waiting-gr-d43b9-ls-as-it-starts-overflowing-desktop-chromium/trace.zip`.
- **Assessment:** intermittent recurrence during concurrent repository and
  browser validation. No owning code, assertion, deadline or skip changed;
  status remains open. Case 1220 records the complete validation run.


## Structured-ticket main merge recurrence — 2026-10-28

- **Aggregate:** `mise run test:logged -- --name merge-browser -- mise run test:browser`,
  nine Playwright workers; 896 passed, 105 skipped and three failed (591.5 s).
  The mobile waiting-group case at `ToolGroupFold.spec.ts:471` received inner
  `scrollTop` 704 instead of zero after five seconds. Both other failures were
  the existing native branch-suggestion cases in `AgentLaunchDialog.spec.ts`.
- **Complete unchanged owner:**
  `mise run test:logged -- --name merge-tool-group-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1 --output=output/playwright/merge-tool-group-owner`
  passed all 38 cases (85.2 s).
- **Evidence:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.K0vppX/merge-browser.log.gz`;
  rerun output is under `output/playwright/merge-tool-group-owner/`.
- **Context:** merge parents `265bc5719507a52fd47758a528e05a807ff8b2db`
  and `72a5d8a1fcdce5e6d877ff11e962e158d4835708`. The conflict resolution
  changes ticket-dialog width classes; this owner and its implementation were
  unchanged. The default repository suite, static checks, public-site browser
  suite and 12 actual ticket-dialog viewport checks passed.
- **Assessment:** confirmed intermittent recurrence; no root cause established
  and no owning implementation, assertion, deadline or skip changed.
- **Native branch owner:**
  `mise run test:logged -- --name merge-native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output=output/playwright/merge-native-branch-owner`
  retained both native suggestion failures (`rel` instead of `release/2.0`);
  both manual-entry cases passed (23.4 s). Evidence:
  `orkestrator-test-run.vucbt3/merge-native-branch-owner.log.gz` under the same
  host temporary directory. This remains the known non-green native picker
  limitation, not a new confirmed flake.

## Coordinator PR-tab validation, 2026-10-28

- **Recurrence:** with nine workers and five repetitions, detached
  `origin/main` `4588fa511` failed this case three times (mobile and desktop,
  704 instead of 0 at line 471); the merged branch
  `pr-review-process-8b9b35a14ee2-r1`, which changes no web or fixture code,
  failed it twice the same way.
- **Evidence:** `.orkestrator/fix-validation/r2/baseline-toolgroupfold.log`
  and `branch-toolgroupfold.log` in that checkout.
- **Assessment:** pre-existing on the target branch; no assertion, deadline or
  skip changed.


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` repeated mobile inner `scrollTop` 704 instead
of zero at line 471. `mise run test:browser` ran 1,006 cases using nine
workers, alongside the repository tests: 897 passed, 105 skipped and four
failed (478.7 s). Evidence:
`.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-05.stdout.txt`.

The complete unchanged tool-group, pane and native branch owners ran
sequentially with one worker (133.8 s):

```sh
mise run test:logged -- --name recorded-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts PaneBreakpoint.spec.ts ToolGroupFold.spec.ts --workers=1
```

All tool-group and pane cases passed; the run reported 49 passed, one skipped
and only the two established native branch-suggestion failures. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.t9A9Lw/recorded-browser-owners.log.gz`.
No tool-group implementation, assertion, deadline or skip changed. The
aggregate timing cause remains unproven.


The exact original browser command was rerun after the queue fixes:

```sh
mise run test:logged -- --name review-repair-browser -- mise run test:browser
```

It reported 904 passed, 105 skipped and three failed in 490.7 s with nine
workers: both known native branch-suggestion cases and the desktop waiting
tool-group overflow case (704 instead of zero). All new queue regressions
passed in both viewports; the pane owner passed. The public-site stage was
not reached because the component suite failed. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.my4kyi/review-repair-browser.log.gz`.

After that final aggregate recurrence, the complete unchanged owner passed
again (exit 0, 79.0 s):

```sh
mise run test:logged -- --name tool-group-final-owner -- bunx playwright test --config e2e/playwright.config.ts ToolGroupFold.spec.ts --workers=1
```

The passing logged runner discarded its detailed output. The known native
branch-suggestion failures remain unrepaired; no unrelated implementation,
assertion, deadline or skip was changed.
