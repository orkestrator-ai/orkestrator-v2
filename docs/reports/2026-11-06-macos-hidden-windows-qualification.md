# macOS hidden-window qualification: live evidence outstanding

Review follow-up, 2026-11-06. Inspected implementation baseline: `fa06f5c1f`
(`fix(desktop): keep agent-test windows hidden on macOS (#1944)`). The working
tree also contains unrelated documentation cleanup; this record does not qualify
those changes.

## Result

**The review coverage gap remains open.** `uname -s` returned `Linux` on the
available execution host. No Mac run, focus observation, Dock observation or
native-sheet observation was performed. No test profile was started, so this
follow-up leaves no profile to stop or reset.

The existing [live qualification procedure](../development/agent-testing.md#live-macos-hidden-profile-qualification)
and [tracking task 8308, task 1](../todo/testing-and-ci/8308-agent-test-electron-off-desktop-live.md)
already cover the requested behavior. Keep that task open until a Mac run
supplies the evidence below.

## Required evidence on a Mac

| Scenario | Required observation | Evidence from this follow-up |
| --- | --- | --- |
| Unattended fixture startup, through readiness | Another app keeps focus; no Dock icon flashes; no main, chooser, progress or DevTools window appears | Not run: Linux host |
| Fresh isolated toolchain bootstrap | Selection and progress states stay hidden; record which states actually executed | Not run: Linux host |
| Browser smoke against the hidden profile | Browser readiness and reload pass while Electron remains hidden | Not run: requires the Mac profile |
| Synthetic uncaught exception, renderer message box and remote-restart dialog | Before main-window creation and with a hidden parent: cancellation result, content-free `hidden-cancelled` event, no native sheet, host window or focus change | Not run: requires instrumented disposable Mac Electron |
| Fresh `--no-headless` fixture from the same unattended shell | Ordinary window and Dock icon appear | Not run: Linux host |
| Cleanup | Every disposable profile is stopped and reset; no owned launcher remains live | No profiles created here |

Follow the linked procedure for profile creation, discovered URLs, login,
instrumentation and cleanup. Record the tested commit, macOS and Electron
versions, profile names, exact commands, each observed result and cleanup outcome.
Capture non-sensitive visual evidence on that host under
`output/visual-previews/`; no macOS screenshot is available from this follow-up.

## Decision

Retain the existing implementation and require live Mac qualification.
Adding injected-`darwin` assertions is portable and useful for checking options
and routing, but cannot observe operating-system focus, Dock transitions or
native sheets. A live Mac run observes those behaviors but requires a Mac and
a disposable profile. It is the required next validation; Linux or mocked
results must not be reported as closing this gap.

No runtime or visual behavior was changed. Existing owner tests are
`apps/desktop/tests/hidden-windows.test.ts`,
`apps/desktop/tests/main-startup-switches.test.ts`, and
`apps/desktop/tests/native-dialogs.test.ts`; their platform simulations remain
distinct from the outstanding live qualification.
