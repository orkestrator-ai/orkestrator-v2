# Design export dialog disappears after viewport resize

- **ID:** 0207
- **Status:** open

Observed: 2026-10-14

- Test: `real gateway saves a design and rehydrates another client's edits`
- Owner: `e2e/agent-testing/design-canvas.spec.ts:9`
- Original command: `mise run test:logged -- --name design-browser -- mise run test:agent:design:isolated`
- Worker configuration: one Playwright worker; repository suites were also active on the host.
- Failure: `locator.boundingBox` timed out after 15000ms waiting for the `Export design to repository` dialog at line 127, immediately after resizing to 390 × 844. The failure snapshot showed the coordinator view, with no export dialog.
- Result: one failed and one passed test; Playwright duration 1.1 minutes, wrapper duration 86.3 seconds.
- Evidence: `output/agent-testing/qa-browser-a7317903-197/browser/artifacts/design-canvas-real-gateway-ef5b9-ates-another-client-s-edits/` contains the screenshot, error context and trace. The bounded log is `/tmp/orkestrator-test-run.hYX2F7/`.
- Owning-spec rerun: `mise run test:logged -- --name design-browser-rerun -- mise run test:agent:design:isolated` passed unchanged (both tests, one worker; wrapper duration 54.1 seconds). Each invocation stopped and reset its disposable profile.

Hypothesis: responsive layout switching can temporarily remount or redirect the active pane around the resize, losing the dialog. The snapshot supports a pane change, but the cause is not established. This change touches backend persistence only; no renderer code or browser assertions were changed or skipped.
