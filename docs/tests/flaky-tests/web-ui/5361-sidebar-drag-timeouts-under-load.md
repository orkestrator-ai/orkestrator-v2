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
