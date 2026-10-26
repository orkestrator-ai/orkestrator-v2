# Live transcript follow releases on scroll-up (e2e/VirtuosoFollow.spec.ts)

- **ID:** 0153
- **Status:** open
- **Date observed:** 2026-09-21
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** Playwright full browser suite with 9 workers across the mobile and desktop Chromium projects
- **Failure:** `distanceFromBottom(scroller)` was expected to become greater than 50 after scroll release but remained 0 until the 5-second poll expired (suite duration: 21.2s)
- **Suite counts:** 114 total, 71 passed, 42 skipped, 1 failed
- **Isolated rerun:** `mise run test:logged -- --name virtuoso-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts` → passed both projects in 2.5s
- **Hypothesis:** The failure is sensitive to the full suite's parallel browser load: the owning file passed unchanged and promptly in isolation, while the aggregate desktop project observed the virtual scroller remain pinned to the bottom after the release action. The current evidence does not distinguish a delayed input/measurement update from an application follow-state race.


## Latest-main refresh of per-machine accounts — 2026-10-24

- **Parents:** merge `e25b6123` and main `553da7f54`.
- **Original command:** `mise run test:logged -- --name update-main-browser -- mise run test:browser`, nine component workers alongside repository and isolated-browser validation.
- **Failures:** both desktop cases retained `false` instead of `auto` after returning to the bottom and appending a message (`VirtuosoFollow.spec.ts:43` and `:86`), exceeding the five-second assertion deadline. The suite reported 576 passed, 102 skipped and four failed across 682 cases (325.0 s logged); the other failures were the already-recorded native branch suggestions.
- **Complete unchanged owner:** `mise run test:logged -- --name update-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1` passed both desktop cases with two mobile skips (3.7 s logged), run sequentially after the branch owner.
- **Evidence:** `orkestrator-test-run.NzXlM1/update-main-browser.log.gz` under the host temporary directory; original browser artifacts under `output/playwright/test-results/`.
- **Assessment:** confirms an intermittent recurrence in follow re-engagement, rather than the original scroll-release symptom. The cause is not established. No owning implementation, assertion, timeout or skip changed during resolution.


## Mixed-version compatibility main merge — 2026-10-24

Both desktop follow cases retained false instead of auto in the aggregate and the first one-worker owner. The exact main-parent baseline passed both follow cases, and the final unchanged merged owner passed in 4.0 s on port 61245. This confirms intermittent behavior; the first isolated failure is retained in the evidence. Full commands, worker configuration, original failures and artifacts are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#mixed-version-compatibility-main-merge--2026-10-24). No assertion, timeout or skip changed.

## Runtime-state ownership main merge — 2026-10-24

`ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-components-bounded -- bunx playwright test --config e2e/playwright.config.ts --workers=2` reported 575 passed, 102 skipped and five failed across 682 cases (1188.3 s logged). The desktop small-wheel case retained `false` rather than `auto` after returning to bottom and appending (`:86`, five seconds). Evidence: host temporary artifact `orkestrator-test-run.Qvr7ev/merge-components-bounded.log.gz`.

The complete unchanged owner, on its own newly allocated fixture port, also failed: `ORKESTRATOR_E2E_PORT=56474 mise run test:logged -- --name merge-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/merge-follow-owner` reported two failed desktop cases and two mobile skips (23.2 s logged). Both `:43` and `:86` retained `false` at five seconds. Evidence: host temporary artifact `orkestrator-test-run.pqBwTh/merge-follow-owner.log.gz` and `output/playwright/merge-follow-owner/`. The renderer and spec match main `0014505ca`; no assertion, timeout or skip changed. This recurrence remains non-green in isolation and is not newly classified as intermittent.


## Agent accounts main merge — 2026-10-24

`mise run test:logged -- --name merge-browser-fixed -- mise run test:browser`
(nine workers) reported 577 passed, 102 skipped and seven failed in 694.4 s.
The complete unchanged owner passed in the sequential one-worker command
`mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts DesignCanvas.spec.ts PaneBreakpoint.spec.ts AgentLaunchDialog.spec.ts MonacoRuntime.spec.ts VirtuosoFollow.spec.ts --workers=1`.
That combined command reported twenty passed, four skipped and two failures
(127.0 s), both in AgentLaunchDialog; this owner had no failures. Evidence:
`orkestrator-test-run.BIyzun/merge-browser-fixed.log.gz` and
`orkestrator-test-run.ngoXeT/merge-browser-owners.log.gz` below the host temporary
directory. No assertion, timeout, skip or implementation changed in this owner.

The desktop follow-release case failed in the aggregate.

## GitHub HTML main merge — 2026-10-24

- **Parents:** feature `66dd560f9b4414ed57e3450237c2a2735ca4cdc1` and main `d723429d58c52d8290c951fa113625431ad3c3fb`.
- **Original command:** `ORKESTRATOR_E2E_PORT=55498 mise run test:logged -- --name merge-browser -- mise run test:browser`, nine component workers alongside repository, Electron and isolated-browser validation.
- **Failure:** the desktop follow-release case at `VirtuosoFollow.spec.ts:43` retained `false` instead of `auto` after five seconds. The complete component suite reported 581 passed, 102 skipped and three failed across 686 cases (366.8 s logged); the other two failures were the recorded native branch suggestions.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=52522 mise run test:logged -- --name merge-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/merge-follow-owner` passed both desktop cases with two mobile skips (5.2 s logged).
- **Evidence:** `orkestrator-test-run.l09gNo/merge-browser.log.gz` under the host temporary directory; passing owner summary in `orkestrator-test-run.4PLw6Z/summary.json`.
- **Assessment:** confirms an intermittent recurrence of follow re-engagement on the merged tree. Host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Selected-machine settings validation — 2026-10-24

The nine-worker command
`ORKESTRATOR_E2E_PORT=15374 ORKESTRATOR_PUBLIC_E2E_PORT=15375 mise run test:logged -- --name settings-browser-components -- mise run test:browser`
repeated the desktop follow-release failure at line 43: the decision remained
`false` rather than `auto` after five seconds. The aggregate reported 584 passed,
102 skipped and six failed in 546.9 s logged; other repository/browser checks
were active on the host.

The complete unchanged owner passed both desktop cases, with both mobile cases
skipped as already configured, in 4.2 s:
`ORKESTRATOR_E2E_PORT=15377 mise run test:logged -- --name settings-follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/settings-follow-owner`.
Original evidence: host temporary directory
`orkestrator-test-run.xfA2Oh/settings-browser-components.log.gz` and
`output/playwright/test-results/VirtuosoFollow-live-transc-300c0-up-and-re-engages-at-bottom-desktop-chromium/`.
No follow implementation, assertion, timeout or skip changed.

## Transcript arrival validation — 2026-10-25

- Original command: `mise run test:logged -- --name browser-suite -- mise run test:browser`.
  Nine component workers ran 760 cases: 655 passed, 102 skipped and three
  failed in 424.9 s. Desktop follow re-engagement at `VirtuosoFollow.spec.ts:43`
  retained `false` instead of `auto` after five seconds; the other two failures
  were the already recorded native branch suggestions.
- The complete unchanged owner passed both desktop cases, with two existing
  mobile skips, in 4.0 s:
  `ORKESTRATOR_E2E_PORT=1462 mise run test:logged -- --name follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/follow-owner`.
- Evidence: `orkestrator-test-run.A0y1lR/browser-suite.log.gz` in the host
  temporary directory and `output/playwright/follow-owner/.last-run.json`.
  Repository and isolated application validation were active during the
  aggregate. Host contention remains a hypothesis; no owning spec, assertion,
  timeout or skip changed.


## Hidden-resume review recurrence — 2026-10-26

- **Failure:** Desktop `a small wheel release stays unfollowed through growth inside the bottom band` retained `false` instead of `auto` at five seconds.
- **Complete unchanged owner:** `mise run test:logged -- --name follow-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/resume-follow-owner` passed (4.2 s logged).
- **Aggregate command, workers, counts and evidence:** [hidden-resume review validation](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). The backend used two Bun workers; the component suite used nine Playwright workers. Concurrent worktree validation was active.
- **Assessment:** confirmed intermittent recurrence; no owning source, assertion, deadline or skip changed. The original aggregate remains failed; no root cause was established.
