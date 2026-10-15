# Host picker (narrow): "Repository settings" never became visible after "Open tools" (`e2e/agent-testing/browser-gateway.spec.ts`)

- **ID:** 0224
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `host path browsing › host picker creates and browses folders through the authenticated gateway above fullscreen settings (narrow)`
- **Owning file:** `e2e/agent-testing/browser-gateway.spec.ts:147`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=d4538-shell bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/design-canvas.spec.ts e2e/agent-testing/browser-gateway.spec.ts e2e/agent-testing/native-draft-attachments.spec.ts --grep "design|private canvases|project Home|host picker|capped file tree|attachment" --workers=1`
  on a fresh `dev:test --fixture --no-agent-credentials --agent-platforms codex,opencode,cursor,grok`
  profile. This case ran second, straight after its desktop variant.
- **Failure:** `locator.click: Timeout 15000ms exceeded` on
  `getByRole('button', { name: 'Repository settings', exact: true })` at line
  238: the element resolved but stayed "not visible". The screenshot shows the
  phone layout with the tools popover closed.
- **Suite counts:** 9 passed, 2 skipped, 1 failed.
- **Reruns:** the narrow case alone passed three times (8.2 s, 8.4 s,
  8.3 s), the desktop and narrow pair passed three times, and the following full
  `mise run test:agent:browser:isolated --agent-platforms codex,opencode,cursor,grok`
  passed it (21 passed, 12 skipped, 1 failed: the doc 02 move case).
- **Evidence:** the failure's trace was overwritten by the passing reruns; only
  the log at `/tmp/ork-d4538-shell-run.log` on the observing host remained.
- **Hypothesis:** `MobileAppShellLayout` closes the tools popover on every
  selected project or environment change. The spec picks the fixture project
  from the drawer and opens the tools at once, so a selection change that
  lands after the click (for example the project's Home environment being
  selected) closes the popover again. The run also carried the `AppShell`
  change that keeps content mounted across the mobile breakpoint, but this case
  loads at 390 px and never crosses it. Not confirmed.

## Messaging review revalidation (2026-10-15)

Reproduced the same hidden "Repository settings" button while validating the
mail fixes on branch `agent-mail-coordination-f5d292441f98-r1`:

- `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
  on profile `qa-browser-48efe423-6ef`: 22 passed, 14 skipped, 1 failed. The
  changed mail flow (inactive recipient, reload and one-message release without
  changing inherited Off) passed. Failure log:
  `/tmp/orkestrator-test-run.a97rK1/isolated-browser.log.gz`.
- Reran the entire owning file separately with
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-mail-review-1015 mise run test:logged -- --name browser-gateway-rerun -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`:
  10 passed, 5 skipped, 1 failed at the same click. Failure log:
  `/tmp/orkestrator-test-run.D8U732/browser-gateway-rerun.log.gz`.
- Both runs used fixture profiles with no agent credentials and Codex enabled.
  Screenshots and traces are under
  `output/agent-testing/<profile>/browser/artifacts/` on the observing host.

The isolated owning-file failure means this recurrence is still reproducible;
this validation does not establish a new flaky classification or resolve the
existing hypothesis. The mail changes do not alter the tools popover or project
selection. No assertions were skipped or weakened.

## Terminal transport recovery revalidation (2026-10-15)

The same hidden "Repository settings" button recurred while validating terminal
transport recovery on branch `terminal-input-issue-ccc06ff4761a-r1`:

- `mise run test:logged -- --name browser-recovery -- mise run test:agent:browser:isolated`
  on fixture profile `qa-browser-3a4ddc8d-34b`: 24 passed, 14 skipped, 1 failed
  at the existing narrow host-picker click. Both new terminal-only SSE and
  WebSocket recovery cases passed, including automatic shell replacement,
  inactive-environment output and reload. Failure log:
  `/tmp/orkestrator-test-run.I32g1i/browser-recovery.log.gz`.
- The terminal owning file separately passed all three cases on credential-free
  fixture profile `qa-terminal-review-1015` using
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-terminal-review-1015 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-terminal-review-1015-terminal-final mise run test:logged -- --name terminal-browser-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/terminal-input-resume.spec.ts --workers=1`.

- The full unchanged browser-gateway owning file passed alone: 11 passed,
  5 opt-in skips, including the narrow host-picker case, using
  `ORKESTRATOR_AGENT_TEST_PROFILE=qa-terminal-review-1015 ORKESTRATOR_AGENT_TEST_RUN_ID=qa-terminal-review-1015-gateway mise run test:logged -- --name browser-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`.
  Sanitized browser evidence is under
  `output/agent-testing/qa-terminal-review-1015-gateway/browser/`.

The terminal changes do not modify project selection or the tools popover.
No existing assertions were skipped or weakened.
