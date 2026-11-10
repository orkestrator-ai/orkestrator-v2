# Sidebar drag spec timed out across both viewports under host load

- **ID:** 5361
- **Status:** open
- **Date observed:** 2026-11-05
- **Tests:** 13 cases of `e2e/SidebarDrag.spec.ts` across `mobile-chromium` and `desktop-chromium`, including `local project header drop reorders expanded projects and survives reload`, `machine name keyboard reorder persists and restores focus` and `keyboard machine reorder from Self visits adjacent unequal-height sections`
- **File:** `e2e/SidebarDrag.spec.ts`

On branch `multi-select-investigation-adeb403aeba1-r1`, this file ran together with
`e2e/SidebarCrossMachineSelect.spec.ts` on the config's default worker count:

```sh
ORKESTRATOR_E2E_PORT=14923 mise run test:logged -- --name e2e-cross-machine -- bunx playwright test --config e2e/playwright.config.ts SidebarCrossMachineSelect SidebarDrag
```

That run: 49 passed, 15 failed, 3.2 minutes. Two of the failures were a defect in
the new spec's own assertion and are not part of this case. The 13 here failed with
`Test timeout of 30000ms exceeded.`, mostly at `page.reload`, or with a fixture row
or repository group not found. None reported a wrong order or position. The failing
set differed between the two viewports. The host load average was 87 shortly
afterwards.

The owning file then passed alone in the same worktree with no change to it:

```sh
ORKESTRATOR_E2E_PORT=14923 mise run test:logged -- --name e2e-drag -- bunx playwright test --config e2e/playwright.config.ts SidebarDrag --workers=2
```

That run passed in 378.4 s. Host load is the likely cause but is not confirmed. No
assertion, timeout or retry was changed for it.

## Auto-pipeline address validation — 2026-11-10

Observed on `autopipeline-text-boxes-7182fc46ef5e-r1` at `944b37af1`, based on
`8d0ae2764e0a5875144d15ee0f526608e6c1c1e8`. The reviewed commit `02f72782c` remains in history.

- **Original command:** `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`.
- **Aggregate result:** incomplete at the 1,800 s runner deadline; 69 named failures,
  last progress 1,194/1,814, with no final pass/skip totals. Public-site tests were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15189 mise run test:logged -- --name address-sidebar-drag-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-sidebar-drag-alone e2e/SidebarDrag.spec.ts`; exit 0, 333.4 s, one worker and both viewport projects.
- **Recurrence check:** `mise run flaky:recurrence -- 5361 --base 8d0ae2764e0a5875144d15ee0f526608e6c1c1e8 --registry-ref origin/main` reported `open`.

| Project | Location | Exact test |
| --- | --- | --- |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | local folder drag shifts expanded target as one block before release |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | local folder drag shifts collapsed target as one block before release |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | merged folder drag shifts expanded target as one block before release |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:83` | merged folder drag shifts collapsed target as one block before release |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:136` | merged project header drop reorders expanded projects and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop rule reorders expanded groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop above rule reorders expanded groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop above rule reorders collapsed groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop below rule reorders expanded groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop rule reorders collapsed groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:256` | machine name pointer reorder persists and restores focus |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:216` | repository drop below rule reorders collapsed groups and survives reload |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:256` | machine name keyboard reorder persists and restores focus |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:346` | machine released in empty space below collapsed sections moves to the end |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:381` | keyboard machine reorder from Self visits adjacent unequal-height sections |
| mobile-chromium | `e2e/SidebarDrag.spec.ts:381` | keyboard machine reorder from Remote visits adjacent unequal-height sections |

The owning spec and its implementation were unchanged. No assertion, deadline,
retry or skip was changed. This establishes intermittency, not its cause.
The full run and remaining undetermined failures are recorded in
[9920](../aggregate-validation-runs/9920-auto-pipeline-fix-browser-owners.md).
