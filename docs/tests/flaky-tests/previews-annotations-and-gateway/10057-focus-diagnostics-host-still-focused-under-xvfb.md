# Focus-loss diagnostics: the host window still read as focused under Xvfb

- **ID:** 10057
- **Status:** open
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
