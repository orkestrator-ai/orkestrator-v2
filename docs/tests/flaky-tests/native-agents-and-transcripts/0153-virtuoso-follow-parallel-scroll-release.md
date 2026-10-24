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
