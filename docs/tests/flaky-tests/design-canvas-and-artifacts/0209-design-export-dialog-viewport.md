# Design export dialog disappears after viewport resize

- **ID:** 0209
- **Status:** resolved

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

## Recurrence: 2026-10-15

- Original command: `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`.
- Worker configuration: one Playwright worker; the complete non-iOS repository suite was also active on the host.
- Failure: the same `locator.boundingBox` timeout after 15000ms at line 127, waiting for the export dialog after resizing to 390 × 844.
- Suite result: 21 passed, 12 skipped, 1 failed; Playwright duration 5.7 minutes, wrapper duration 346.2 seconds.
- Evidence: `output/agent-testing/qa-browser-a84af326-ba4/browser/artifacts/design-canvas-real-gateway-ef5b9-ates-another-client-s-edits/`; bounded log `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.fpevdT/`.
- Owning-spec rerun: `mise run test:logged -- --name design-browser-rerun -- mise run test:agent:design:isolated` also failed at the same assertion: 1 passed, 1 failed, one worker; Playwright duration 36.5 seconds, wrapper duration 39.6 seconds. The aggregate had finished before this rerun.
- Rerun evidence: `output/agent-testing/qa-browser-20ab5799-6e4/browser/artifacts/design-canvas-real-gateway-ef5b9-ates-another-client-s-edits/`; bounded log `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.bOw5IB/`.
- Both invocations stopped and reset their disposable profiles. The owning spec was unchanged. This recurrence also fails alone, so it is not additional evidence of aggregate-only flakiness; the earlier passing-rerun history remains above. The cause is still unconfirmed. The current production change only wraps the GitHub clone helper in the Add Project dialog.

## Resolution (2026-10-15)

- **Root cause:** not load. Below 768px `AppShell` (`apps/web/src/components/layout/AppShell.tsx`)
  swaps the desktop tree for `MobileAppShellLayout`, so React remounts every
  pane under it, including `DesignCanvasTab`, which owns the dialog's open
  state. The resize therefore always closes the export dialog. The spec
  measured `boundingBox()` straight after `setViewportSize`, which passed only
  when it won the race against the media-query re-render. When it lost, it
  either timed out (the original observation) or got `null` (`TypeError:
  Cannot read properties of null (reading 'x')` at line 128). The second form
  reproduced on the first `mise run test:agent:design:isolated` run of
  2026-10-15. Its failure screenshot shows the mobile file panel with no
  dialog.
- **Fix:** the spec cancels the dialog, hides the file panel, resizes to
  390 × 844, closes the mobile projects drawer and opens the export dialog
  again in the phone layout before it checks the bounds. The fit assertion is
  unchanged.
- **Verification:** `ORKESTRATOR_AGENT_TEST_PROFILE=d4538-qa mise run test:agent:browser -- e2e/agent-testing/design-canvas.spec.ts --workers=1`
  passed both design specs (47.4 s) on a fresh `dev:test --fixture
  --no-agent-credentials --agent-platforms codex` profile.
- **Product fix (same day):** `AppShell` now keeps its content mounted across
  the breakpoint, so the dialog stays open. The spec keeps it open, waits for
  the phone layout (by CSS, since the modal hides the rest of the page from
  role queries) and measures. It passed on a fresh profile and in a full
  `test:agent:browser:isolated` run (21 passed, 12 skipped, 1 failed: the
  doc 02 move case).
