# Transcript repair browser validation: intermittent owner failures

- **ID:** 7272
- **Status:** open
- **Date observed:** 2026-11-06
- **Original command:** `ORKESTRATOR_E2E_PORT=14827 mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** Playwright config defaults, both Chromium viewport projects; isolated owner commands used separate fixture ports and artifact directories.
- **Aggregate counts:** 1,510 passed, 135 skipped, nine failed in 1,403.5 s. Public-site checks after the component suite were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hIh8H2/browser.log.gz`.

## Failures whose complete owning file passed alone

| Owning file and exact test | Aggregate failure | Isolated owner result |
| --- | --- | --- |
| `e2e/PullRequestTranscriptPane.spec.ts:117`: delayed failure retains a user-activated browser escape after a blocked popup | Desktop: Open on GitHub button missing after 15 s | Exit 0, 25.0 s |
| `e2e/ReadCoordinator.spec.ts:25`: hidden documents stop coordinated reads and resume reconciles critical reads first | Desktop: session reconciliation order differed | Exit 0, 16.8 s |
| `e2e/RemoteMachineTree.spec.ts:30`: drag optimistically reorders within a project, preserves home slots, and reconciles with the summary | Desktop: environment row order differed after 5 s | Exit 0, 39.4 s |
| `e2e/RemoteMachineTree.spec.ts:60`: Unknown rolls back the drag and names the command in the notice | Desktop: environment row order differed after 5 s | Same complete owner pass |
| `e2e/SidebarMotion.spec.ts:26`: real panels restore width, bound reversal pins and release once | Desktop: three content sizes instead of the bound of two | Exit 0, 38.1 s |

Each owning file ran separately with both viewport projects, using:

```sh
ORKESTRATOR_E2E_PORT=<port> mise run test:logged -- --name repair-<owner>-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-<owner>-alone e2e/<owner>.spec.ts
```

Owners/ports were `PullRequestTranscriptPane`/14842, `ReadCoordinator`/14843,
`RemoteMachineTree`/14844 and `SidebarMotion`/14845. Passing logs were deleted
by the logged runner. No spec, assertion, timeout or skip changed. The cause
is unconfirmed; the prior network-change case 4291 is not this assertion.

The other intermittent failures update their existing records:
[1310](../previews-annotations-and-gateway/1310-data-saving-gateway-browser-timeout.md)
and [4350](4350-suborks-branch-browser-validation.md). `TabLaunchOverride`
failed both viewports in the aggregate and again in the seven-owner rerun
(54 passed, two failed in 1.1 min); it is not classified as a flake. That
failure is left to the verifier rather than changing unrelated launch UI.
