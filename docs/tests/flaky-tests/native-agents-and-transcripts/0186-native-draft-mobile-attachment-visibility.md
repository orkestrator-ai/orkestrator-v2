# Cursor image-draft chips disappear during mobile checks in the full browser suite

- **ID:** 0186
- **Status:** open
- **Date observed:** 2026-10-08
- **Tests:** `a saved image draft survives reload and the autosave after it (assigned cursor tab)` and `a saved image draft survives reload and the autosave after it (pre-session picker with cursor selected, attachment only)`
- **File:** `e2e/agent-testing/native-draft-attachments.spec.ts:104`
- **Original command:** `mise run test:logged -- --name agent-browser -- mise run test:agent:browser:isolated`
- **Worker configuration:** One Playwright worker against a disposable fixture profile; the repository aggregate was also running.
- **Failure:** The `Remove draft-image.png` chip was absent at the narrow-viewport visibility/in-viewport assertions (lines 347–348), after the 5000 ms assertion deadline.
- **Suite counts:** Full browser run: 17 passed, 4 failed, 10 skipped (31 total). The other failures concerned file-tree test navigation (subsequently fixed) and design export (also fails alone).
- **Isolated rerun:** All six cases in the owning file passed in 137.0 seconds, exit 0:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=qa-file-tree-708a-review \
ORKESTRATOR_AGENT_TEST_RUN_ID=qa-file-tree-drafts-rerun \
  mise run test:logged -- --name drafts-rerun -- \
  mise run test:agent:browser -- e2e/agent-testing/native-draft-attachments.spec.ts
```

The rerun used a separate credential-free fixture profile provisioned with Codex,
matching the one-shot profile's agent selection. It ran no model turns.

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.3MDFmC/agent-browser.log.gz`.

Both failures occurred after switching to the mobile layout. The isolated pass
establishes intermittent behavior, but does not identify whether a delayed mount,
a draft-state update or another interaction caused the chip to disappear. No
assertion, timeout or skip was changed.

## Recurrence 2026-10-13 (Vite 8 upgrade)

- **Test:** `a saved image draft survives reload and the autosave after it (pre-session picker with cursor selected, attachment only)`
- **Original command:** `mise run test:logged -- --name agent-browser-isolated -- mise run test:agent:browser:isolated`
  on the Vite 8.3.4 / `@vitejs/plugin-react` 6.1.2 branch, one Playwright worker, no
  repository aggregate running.
- **Failure:** Same as above: `expect(chip).toBeInViewport({ ratio: 1 })` at line 348
  found no element within 5000 ms after the switch to the mobile layout.
- **Suite counts:** 17 passed, 4 failed, 13 skipped (34 total). The other failures were
  the Codex-recovery and CLI specs (the fresh worktree had no built bridge `dist/` or
  CLI; both passed once built) and design export, which also fails alone on the
  Vite 7.3.6 baseline.
- **Isolated rerun:** On a fresh `--fixture --no-agent-credentials --agent-platforms codex`
  profile the owning file's six cases had no failures: 4 passed (including the
  failing pre-session case, which has no skip path) and 2 assigned-tab cases took
  the spec's own "bridge did not connect" skip:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=vite8-rerun ORKESTRATOR_AGENT_TEST_RUN_ID=vite8-rerun \
  mise run test:logged -- --name agent-rerun-4 -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts \
  e2e/agent-testing/browser-gateway.spec.ts:784 e2e/agent-testing/cli-ui.spec.ts:169 \
  e2e/agent-testing/design-canvas.spec.ts:9 \
  e2e/agent-testing/native-draft-attachments.spec.ts --workers=1
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.E7kROr/agent-browser-isolated.log.gz`.
The recurrence on an unrelated bundler change is consistent with an app-side
timing issue rather than a toolchain regression. No assertion, timeout or skip was
changed.

## Transcript arrival validation — 2026-10-25

A different failure in the same owner occurred during
`mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`
(one browser worker, alongside repository and component checks). The assigned
Grok draft case timed out at `native-draft-attachments.spec.ts:304` waiting for
the app shell after a reload. Its screenshot was entirely blank, without the
startup-error banner. This does not establish the same cause as the older
mobile chip failure or the recorded dev-module-fetch errors.

The full application run reported 28 passed, 55 opt-in skips and two failures
in 550.1 s. The other failure was the previously recorded narrow Repository
Settings picker (0224). The unchanged native-draft owner finished with four passes and two existing
assigned-tab skips in 182.4 s in a fresh credential-free Codex fixture profile, using the existing
`runIsolatedBrowser` lifecycle with a temporary config selecting only
`native-draft-attachments.spec.ts` and one worker. Both profiles were stopped
and reset, and the temporary config was removed. No assertion, timeout or skip
changed. Renderer startup or reload timing under concurrent validation remains
an unproven hypothesis.

Evidence: host temporary artifacts
`orkestrator-test-run.Fnh8OD/isolated-browser.log.gz` and
`orkestrator-test-run.bL02my/summary.json`; browser reports under
`output/agent-testing/qa-browser-7e580128-dac/browser/` and
`output/agent-testing/qa-browser-27da3a8d-f8d/browser/`.

Exact isolated owner command (the temporary config extended the normal browser
config with `testMatch: "native-draft-attachments.spec.ts"`):

```bash
mise run test:logged -- --name draft-owner -- bun --eval 'import { runIsolatedBrowser } from "./apps/desktop/scripts/dev/isolated-browser.ts"; process.exitCode = await runIsolatedBrowser({ suite: { label: "draft attachment owner", config: "e2e/agent-testing/playwright.arrival-owner.tmp.config.ts" } });'
```
