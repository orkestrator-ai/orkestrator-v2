# Unrendered-frame keyboard journey misses the layer-tree row

- **ID:** 1249
- **Status:** open
- **Date observed:** 2026-10-28
- **Test:** `Enter on a layer of an unrendered frame announces the wait and selects once it renders`
- **File:** `e2e/DesignCanvasAccessibility.spec.ts:594`
- **Project:** `mobile-chromium`

## Evidence

Review preparation on `dialog-default-width-f9e00713408e` (`86fb722e0`) ran
`mise run test:logged -- --name browser -- mise run test:browser`, with nine
Playwright workers. The component suite finished with 884 passed, 105 skipped,
and three failed in 10.6 minutes. This test timed out after five seconds at
line 613 waiting for the `plans (h2)` treeitem to be attached to the Layers
tree after pressing End. The other two failures were the known native branch
suggestion cases. Preparation evidence is in
`.orkestrator/review-artifacts/review-validation-3ee65e3a-f5b5-400d-801a-999c83116e4a/validation-06.stderr.txt`.

The same mobile attachment assertion failed during the required complete browser
rerun after the dialog test repairs (`22f7041f7`); this spec and its production
components were unchanged in that repair.

The complete unchanged owner passed all 14 cases across both viewport projects
with one worker in 419.7 seconds:

```sh
mise run test:logged -- --name design-accessibility-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1 --output output/playwright/design-accessibility-owner
```

That owner ran alongside the complete browser qualification on the shared host;
this is a single-file rerun, not evidence from an idle host.

## Assessment

The failure precedes opening the dialog in this journey. The expected layer row
is absent after the keyboard navigation; whether rendering, focus, or layer
loading is responsible remains unproven. Capture the active treeitem and frame
loading state at the failed End key before changing the timeout or assertion.


## Uniform app shortcuts review recurrence — 2026-10-28

The nine-worker component aggregate reported this case again (both 30-second
DesignCanvas deadlines for 0174, and mobile unrendered-frame selection for
1249). The complete unchanged DesignCanvas, DesignCanvasAccessibility and
SetupRecovery owners passed sequentially with one worker: 20 passed, exit 0,
77.0 seconds. Command:

```sh
mise run test:logged -- --name design-and-layer-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DesignCanvasAccessibility.spec.ts e2e/SetupRecovery.spec.ts --workers=1
```

No assertion, timeout or skip changed. The cause remains unestablished; this
case stays open. Aggregate counts and artifact paths are recorded in
[0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#uniform-app-shortcut-review-repairs--2026-10-28).

## Remote project-search review recurrence — 2026-10-28

The exact recorded browser command was rerun after fixing search assertions:

```sh
mise run test:logged -- --name review-repair-browser -- mise run test:browser
```

With nine workers it reported 930 passed, 105 skipped, and three failed
(exit 1, 565.0 seconds). The mobile unrendered-frame case again could not
find `plans (h2)` at line 613 within five seconds. Both other failures were
the established native branch-suggestion cases. All 22 search cases passed.
Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ciI5We/review-repair-browser.log.gz`.

The complete unchanged accessibility owner passed all 14 cases with one worker
(exit 0, 60.7 seconds):

```sh
mise run test:logged -- --name design-accessibility-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1
```

The repository default suite passed all four groups (369.4 seconds), and the
public-site browser stage that the component failure prevented from running
passed separately (16.8 seconds):

```sh
mise run test:logged -- --name public-site-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts
```

No design-canvas implementation, assertion, deadline, or skip changed; the
cause remains unestablished and this case stays open.

The complete unchanged native branch-picker owner retained both established
suggestion failures (`release/2.0` expected, `rel` received); both manual-entry
cases passed (two passed, two failed; 23.3 seconds):

```sh
mise run test:logged -- --name native-branch-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output output/playwright/search-review-native-branch
```

Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.W9Ohup/native-branch-owner.log.gz`.
This remains an unrelated non-green native picker limitation, not a newly
confirmed flake. No owning source or tests changed.

## Markdown diagram review validation — 2026-10-29

The exact `mise run test:browser` rerun, logged as `review-browser-rerun`,
reported 949 passed, 106 skipped and three failed in 457.0 seconds with nine
workers. The mobile unrendered-layer case repeated the missing `plans (h2)`
treeitem at `DesignCanvasAccessibility.spec.ts:613`. Both other failures were
the established native branch-suggestion cases in `AgentLaunchDialog.spec.ts`
(`release/2.0` expected, `rel` received). All Markdown diagram regressions
passed. The component-stage failure prevented the public-site stage from
running.

Aggregate evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.TMNeJB/review-browser-rerun.log.gz`.
No design-canvas or native branch-picker implementation, assertion, deadline
or skip changed.


Complete unchanged owners ran sequentially with one worker:

```sh
mise run test:logged -- --name review-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts e2e/AgentLaunchDialog.spec.ts --workers=1 --output output/playwright/markdown-review-owners
```

The accessibility owner passed ten cases with four existing skips, including
the previously failing mobile unrendered-layer case. The native picker retained
both suggestion failures; its two manual-entry cases passed. Combined result:
12 passed, four skipped, two failed (183.4 s). Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.c9s5wV/review-browser-owners.log.gz`.
The native picker remains an unrelated non-green limitation; the accessibility
failure remains intermittent. Neither suite's assertions or skips changed.

## Provider-upgrade review — 2026-10-30

Preparation and the exact `mise run test:browser` repeat both failed the
mobile `plans (h2)` attachment assertion after End. The latter run had
981 passes, 106 skips and five failures (8.4 min); its evidence is
`orkestrator-test-run.x5T4jf/review-browser-suite.log.gz` under the host
temporary directory. The complete unchanged accessibility owner then passed
alone (59.7 s), with one worker:

```sh
mise run test:logged -- --name review-browser-canvas-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1
```

No source, assertion, timeout or skip in this owner changed. The earlier
combined picker/accessibility rerun had a different mobile keyboard-journey
failure; it is not the isolated pass used for this classification.

## Session-import review validation — 2026-11-01

`mise run test:logged -- --name review-fixes-component-browser -- mise run test:browser`
on the branch based on `15f22fc6d` reproduced the same mobile `plans (h2)`
attachment deadline at line 613. The nine-worker component run had 1,052 passed,
108 skipped and six failed (629.1 seconds); the remaining failures were the
Claude route-disposal case and four Cursor retention fixtures.

The complete unchanged owner was rerun with
`mise run test:logged -- --name design-accessibility-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1 --output=output/playwright/session-import-review-design-owner`.
It retained the same failure: nine passed, four skipped, one failed, 64.9 seconds.
This recurrence has no isolated pass and is not newly classified as flaky. The
historical open status remains; no assertion, timeout or skip was changed.

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.P117Rf/review-fixes-component-browser.log.gz`
and `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.wI7nDh/design-accessibility-owner.log.gz`.

## Launch override review recurrence — 2026-11-05

The required browser rerun on repair commit `c63d42e7a` repeated the missing
plans (h2) treeitem attachment at line 613 in mobile Chromium. The command was
`ORKESTRATOR_E2E_PORT=54487 mise run test:logged -- --name browser -- mise run test:browser`,
with five Playwright workers on the shared host. Its output is retained at
`/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.EQqosx/browser.log.gz`.
The broad run was still active when this owner rerun finished; its eventual
result is recorded separately in the Address Findings validation result.

The complete unchanged mobile owner passed with one worker (exit 0,
123.2 seconds):

```sh
ORKESTRATOR_E2E_PORT=54487 mise run test:logged -- --name browser-design-a11y-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --project=mobile-chromium --workers=1 --output=output/playwright/design-a11y-address
```

Passing output was deleted by the bounded runner, so no per-test totals were
retained. This owner reused the broad run's fixture server; it was a
single-file rerun, not an idle-host qualification. No owner assertion, timeout,
skip or fixture logic changed. The cause of the intermittent observation
remains unestablished.


### Broad rerun outcome

The bounded runner stopped the broad command at its 1,800 s absolute deadline
(exit 1), after the reporter started case 856 of 1,596. It named three failed
cases but emitted no closing component totals; the public-site phase did not
run. `summary.json` alongside the compressed log records `timeoutReason:
"absolute"`. The broad check remains incomplete; passing this owner does not
waive that timeout or establish a green browser suite.

## Coordinator unavailable-platform review — 2026-11-06

The mobile unrendered-frame case could not attach the plans (h2) treeitem within 5 s.

The browser repeat used five workers and a free fixture port. It named nine failures and stopped at the 1800000 ms group deadline after starting 708 of 1596 cases; complete pass totals were not available. Original command: `ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name browser -- mise run test:browser`.

The unchanged complete owner passed alone, exit 0, in 179.2 s:

```sh
ORKESTRATOR_E2E_PORT=61386 mise run test:logged -- --name review-design-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts --workers=1 --output output/agent-testing/review-address-owners/design
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.8yBzhf/browser.log.gz`. Passing
output was deleted by the logged runner, so individual rerun counts were not
retained. This establishes intermittence, not its cause. No assertion, timeout
or implementation was changed to hide the failure; the broad check remains
non-green.

## Unified federation PR validation — 2026-11-07

`mise run test:logged -- --name federation-browser -- mise run test:browser`
ran the component browser suite with its default worker count. It reported
1,550 passed, 151 skipped and three failed in 993.8 seconds. This case again
failed in mobile Chromium: after pressing End, the `plans (h2)` treeitem did
not attach within the five-second assertion at line 613. The other two failures
were in `SidebarCrossMachineSelect.spec.ts`; the component failure prevented
the public-site stage from running. Evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.B1KWJt/federation-browser.log.gz`.

The complete unchanged owner passed alone in 22.0 seconds:

```sh
mise run test:logged -- --name design-canvas-accessibility-recheck -- env ORKESTRATOR_REVIEW_VALIDATION=1 bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvasAccessibility.spec.ts
```

The run was based on `main` at `7329d2490b05113bcc3c47fdb49812552b8bb4ea`;
`mise run flaky:recurrence -- 1249 --base 7329d2490b05113bcc3c47fdb49812552b8bb4ea`
reported the case open. No test or product source changed. This is another
aggregate-only observation; the cause remains unestablished.
