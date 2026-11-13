# Design Electron journey: export file name read early, Expand click lost to a startup dialog

- **ID:** 9969
- **Status:** resolved
- **Date observed:** 2026-11-13
- **Test:** `the packaged app's file:// renderer opens, edits, exports, downloads, takes shortcuts and opens a host .orkdes`
- **File:** `e2e/agent-testing/design-canvas-packaged-electron.spec.ts:60`, failing in the shared journey `e2e/agent-testing/design-canvas-electron-journey.ts`
- **Base commit:** `17d28238c` (`git merge-base HEAD origin/main` on branch `20261113-000850-4a57ed16412c`, to-do 0036 tasks 3 and 6).
- **Original command:** `ORKESTRATOR_AGENT_TEST_RUN_ID=design-packaged-mac-repeat mise run test:logged -- --name design-packaged-mac-repeat -- bunx playwright test --config e2e/agent-testing/playwright.packaged-electron.config.ts design-canvas-packaged-electron.spec.ts --repeat-each=8`, one worker (the config's), against an unsigned (ad-hoc) macOS packaged-test bundle from `mise run package:mac:unpacked:test`, with hidden agent-test windows, on an Apple M5 Pro (18 cores) shared with nine other builds (load averages 44 to 96 during the run).
- **Failures:** 4 of 8.
  - Two runs: `expect(received).toMatch(expected)`, expected `/\.orkdes$/`, received `""`, where the export step read **File name** (7.3 s and 11.9 s in).
  - Two runs: `locator.click: Timeout 30000ms exceeded` waiting for the environment's row (`getByText('design-electron')`), after the startup-dialog handlers had closed **Continue Without Docker** and **Continue Without GitHub CLI** (32.4 s and 33.5 s).
- **Caveat:** this run's spec and journey files were being edited while it ran, and Playwright starts a fresh worker after a failure, so later repeats loaded later file versions. Both failures are at lines those edits did not touch.
- **Isolated rerun:** the first run of the same spec alone, just before (`--name design-packaged-mac`), passed (31.0 s).

## Root cause

Both are test races, not product defects.

1. **File name.** The export dialog sets **Folder** to `designs` at once,
   but fills **File name** only when the backend's export preview answers
   (`runPreview` in `apps/web/src/components/design/DesignExportDialog.tsx`;
   the field reads "Checking the repository…" until then). The journey waited
   for **Folder** and then read **File name** at once, so on a loaded host it
   read the empty field.
2. **Expand.** After the reload the journey saw **Expand project …**,
   checked it was visible and clicked it. On a fresh profile the backend
   opens the Docker and GitHub CLI startup dialogs a moment later. When one
   opened between that check and the click, the click landed on the modal
   overlay. The locator handler then closed the dialog, but the project stayed
   collapsed and the environment row never appeared.

## Fix

In `design-canvas-electron-journey.ts`, used by both Electron design specs and
the 0036 renderer-pairing spec:

- the export step now waits for **File name** to hold a `.orkdes` name (up to
  30 s) before reading it;
- Expand is retried inside `toPass` until the environment row shows (2 s per
  try, 30 s in all).

No timeout of a passing step was raised and no assertion was loosened.

## Verification

After the fix, `--repeat-each=8` of the same spec on the same bundle passed
8 of 8 (20.3–30.3 s each, load averages 41 to 46): `mise run test:logged --
--name design-packaged-mac-repeat2 -- bunx playwright test --config
e2e/agent-testing/playwright.packaged-electron.config.ts
design-canvas-packaged-electron.spec.ts --repeat-each=8`.

Open case [4250](4250-design-electron-reachability-dialog-race.md) is about the
Vite-served spec under Linux headless runs, where a startup dialog also
appears in the failures. This fix may also help there; that has not been
checked, so 4250 stays open.
