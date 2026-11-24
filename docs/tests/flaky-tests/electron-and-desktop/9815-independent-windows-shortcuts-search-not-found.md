# Independent windows: the keyboard shortcuts search box was not found (`electron-main.spec.ts`)

- **ID:** 9815
- **Status:** open
- **Date observed:** 2026-11-16
- **Base:** `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Observed head:** branch `legacy-retirement-8d61cbbc6765-r1` at
  `110e89020`. The branch does not change the spec or
  `KeyboardShortcutsDialog.tsx`; it does change desktop connection code
  (`connection-manager.ts`, `connection-route-selection.ts`), which this
  test's two windows use.
- **Test:** `real Electron main process shares one backend across
  independent windows` in `e2e/agent-testing/electron-main.spec.ts` (line
  928; the failing step is in `testIndependentWindows`, line 613).
- **Failure:** after the Keyboard Shortcuts menu item was clicked,
  `expect(shortcutsDialog).toBeVisible()` passed, then
  `expect(getByRole('textbox', { name: 'Search keyboard shortcuts' })).toBeFocused()`
  failed after 5 s with "element(s) not found".
- **Original command:** `mise run test:agent:electron` with
  `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, one worker, on a Linux host
  shared with other worktrees (72 passed, 3 failed, 5 skipped, 1 did not run;
  the other two failures were flake 9813 and the headless-only remote
  terminal link case described in
  [9811](../previews-annotations-and-gateway/9811-crashed-service-renderer-view-hidden-after-reload.md#note-on-headless-runs)).

## Observations

- 2026-11-16: failed once as above.
- 2026-11-16, same commit and mode, the test alone with
  `--repeat-each=3`: 3 passed.
- No earlier `test:agent:electron` log under `/tmp/orkestrator-test-run.*`
  on this host contains this assertion's failure. The review preparation run
  and the round 2 rerun on this branch passed it.

The failing run's screenshots and trace were overwritten by the alone rerun,
so what the dialog showed at the timeout is not known.

## Hypothesis (unproven)

The dialog's frame was visible before its contents (the search box) were in
the accessibility tree, and under the full suite's load that took longer
than the 5 s assertion budget. Nothing points at the shared backend or the
connection code, but the next failure should keep its trace before that is
ruled out.

## Recurrence and cause (2026-11-24)

The Electron qualification failed the same step on `main` at `a2609f28b` (run
45196609459, 2026-11-23; also in run 43840642859). `mise run flaky:recurrence
-- 9815 --base a2609f28b --registry-ref origin/main` answered "open".

The run's log and screenshot answer the hypothesis above: the search box is
drawn and holds the caret, but the "GitHub CLI not found" alert was open too.
An alert dialog hides the rest of the page from role queries, so the box was
"not found". The startup-dialog handler did run ("found ... Continue without
GitHub CLI, intercepting action"), but the shortcuts dialog's overlay covers
that button, so its click never landed and Playwright waited for it to hide
for the rest of the 30 s.

## Fix (2026-11-24)

`dismissStartupDialogsOnPage` (`e2e/agent-testing/electron-startup-dialogs.ts`)
falls back to a dispatched click when the pointer click does not land.

- **Reproduced:** no (the alert's timing against the menu item); the handler's
  fallback is covered by `electron-startup-dialogs.test.ts`.
- **Stays open** until the Electron qualification passes the step.
