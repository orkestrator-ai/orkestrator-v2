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
