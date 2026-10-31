# Native menu keys arrive before Electron moves focus

- **ID:** 1510
- **Status:** resolved
- **Date observed:** 2026-10-28 (CI); reproduced 2026-10-31
- **Test:** `built application menu resolves native roles and dispatches callbacks`
- **File:** `e2e/agent-testing/application-menu-electron.spec.ts`
- **Original command:** `.github/workflows/native-application-menu.yml`, Linux job: `xvfb-run -a mise run test:logged -- --name native-menu-linux -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts application-menu-electron.spec.ts` with `ORKESTRATOR_NATIVE_MENU_INPUT=1` on `ubuntu-latest`, one worker.
- **Failure:** the Linux job failed in 9 of the 13 runs listed on 2026-10-31 and passed in four (40847845862, 40886618114, 40983822524, 41004644462). Every failure was the resumed-typing step after the About panel: `expect(page.getByRole("textbox")).toHaveValue("a")` received `""` (`application-menu-electron.spec.ts:209`, later `:215`). The failure screenshot of run 40997662556 shows the textbox focused, with an empty value; that run took 7.4 s.
- **Local reproduction:** on Arch (Omarchy) with a private Xvfb display and no window manager, the unchanged spec failed 2 of 25 runs, both at the first menu-navigation step (`expect.poll(events).toEqual(["shortcuts:open"])` received `[]`). With xdotool's key delay set to 0, it failed 10 of 10 runs at that step. The CI symptom (resumed typing) did not reproduce here.
- **Cause:** confirmed locally for menu navigation: Electron's Windows/Linux menu bar takes keyboard focus only after the page reports a lone Alt as unhandled, which is a renderer round trip, so the keys xdotool sent after Alt (Right, Right, Down, End, Return) could reach the page first. Inferred, not reproduced, for the CI step: the `a` was sent as soon as xdotool had given the window X focus, and Chromium activates the window and refocuses its web contents asynchronously after the focus event, so a key processed in between has no focused view. The screenshot (textbox focused afterwards) fits that.
- **Fix:** the spec waits for each focus move before sending the next keys: the page loses focus after the lone Alt, and regains it after the window regains native focus following the About panel. No assertion was loosened. `nativeMenuWindows` also skips a menu popup destroyed between `xdotool search` and `getwindowname`; the zero-delay stress run exposed that.
- **Initial verification:** 35 of 35 local runs passed after the fix, including 20 with xdotool's key delay at 0. The workflow had not run that fix yet.

## Review qualification, 2026-10-31

[Run 41219984351](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41219984351)
tested `032b92456422f66e1ab4a324f54e5b1dc241e64d`, with one worker,
`ORKESTRATOR_NATIVE_MENU_INPUT=1`, `--repeat-each=5 --retries=0`, and both
`application-menu-electron.spec.ts` and `electron-cleanup.spec.ts`.
The local Linux/Xvfb run passed all ten cases in 15.7 s. The Ubuntu runner
passed nine of ten in 18.5 s; the first menu iteration lost the `a` after About
again, even after `webContents.isFocused()` returned true. All five cleanup
iterations passed. The failed run's [Linux artifact](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41219984351/artifacts/13050125215)
retains the trace and screenshot.

The spec now also observes `document.hasFocus()` and the textbox's DOM focus
before sending the single native `a`. This checks Chromium's restoration of the active element after
native-view focus; it does not call the textbox's `focus()` or retry typing.
Windows must regain native-view focus without an explicit foreground request;
Linux/Xvfb still supplies the native-window focus a window manager would give.

The workflow also runs deterministic Windows process-table cases on both
platforms, and five real blocked-shutdown cleanup iterations. The cleanup
fixture uses Electron in Node mode instead of the Unix-only `sleep` command.
Successful menu runs attach the observed events, dismissal, page focus and
textbox value; cleanup runs attach the owned process tree and stopped helper.

The same run passed all five Windows menu iterations (Electron 45.0.0). Each
reported two `shortcuts:open` events, two `new-window` events, About dismissed,
page focus restored and the textbox containing `a`. Each Windows cleanup
iteration reported its helper included in the owned tree and all owned PIDs
stopped, then failed removing Chromium's SQLite profile file with `EBUSY`.
Profile deletion now uses bounded filesystem retries after shutdown checks.
