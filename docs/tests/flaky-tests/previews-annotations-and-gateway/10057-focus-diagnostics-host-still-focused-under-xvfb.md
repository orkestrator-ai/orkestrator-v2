# Focus-loss diagnostics: the host window still read as focused under Xvfb

- **ID:** 10057
- **Status:** resolved
- **Date observed:** 2026-11-23
- **Base:** `a2609f28b` (`main`, scheduled Electron qualification run
  45196609459).
- **Test:** `focus-loss diagnostics recognise another window in the same
  Electron main process`
  (`e2e/agent-testing/web-annotations-electron.spec.ts:2453`).
- **Failure:** `toMatchObject` at line 2479: `windowFocused: true`, expected
  `false`, right after the other window's `isFocused()` polled true.
- **Original command:** `xvfb-run -a mise run test:agent:electron` in
  `.github/workflows/electron-qualification.yml` (88 tests, one worker).
- **Isolated rerun:** not run. The case needs native window focus and this
  host has no Xvfb.

## Assessment (2026-11-24)

On X11 one window's focus and another's blur arrive as separate events, so for
a moment both can say they are focused. The test read the host once. It now
polls the host's `isFocused()` for false before it reads the facts. If Xvfb,
which runs no window manager, never delivers that blur, the poll still fails
and the next run will show it.

## Recurrence (2026-11-25)

- **Recurrence check:** `mise run flaky:recurrence -- 10057 --base c20a4b37a18423eec9201ac5bb83dcf1bbc90cc8 --registry-ref origin/main`: open.
- **Observed on CI:** Electron qualification run 45517819970 (pull request
  #2558, head `a371c9e9d`, base `c20a4b37a`), with the poll above in place:
  74 passed, 1 failed, 6 skipped, 7 did not run. The poll saw the host's
  `isFocused()` false, and the read right after it still said
  `windowFocused: true`. So the blur was not late.

## Resolution (2026-11-25)

- **Root cause:** not a race. `readWindowFocus`
  (`e2e/agent-testing/window-focus-loss.ts`) took
  `BrowserWindow.getAllWindows()[0]` for the host. That list has no creation
  order: on Linux (Electron 45.4.1) six windows created in turn were listed
  `[6, 5, 4, 3, 2, 1]`, so the read answered for the test's second window,
  which is the focused one.
- **Fix:** `readWindowFocus` and `explainLostFocus` take the host's page and
  resolve its own window through `app.browserWindow(page)`.
  `window-focus-loss.test.ts` runs the real main-process function against an
  app that lists a newer window first.
- **Reproduced:** yes. Ubuntu 24.04 container (Playwright image), Xvfb, uid 1000,
  one worker, `--repeat-each=3`, `-g "focus-loss|keyboard alone"`: the case
  failed 3 of 3 on unchanged code with the recorded diff.
- **Verification:** the same command with the fix and `--repeat-each=5` passed
  15 of 15. The whole owning file then passed there (20 passed, 2 opt-in
  container cases skipped) and headless on Linux (19 passed, 3 skipped).
- The poll for the host's blur stays: X11 does report the two events
  separately.
