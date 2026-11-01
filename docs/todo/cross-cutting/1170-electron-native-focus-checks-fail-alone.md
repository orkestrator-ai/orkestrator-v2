# Electron native-focus checks that fail alone: realm Agent information and annotation Notes

Two full-app Electron specs check that keyboard focus lands in a native panel,
and both failed even when their owning file ran alone. Found by the 2026-10-25
flake triage in [0030](0030-test-suite-and-ci-health.md) (task 4).

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`; diagnosed and fixed
2026-11-01 against `main` at `93b99bfba` on arktech-mini (macOS, load average
28 to 48, a dozen other builds running).

### Tasks

1. **Workspace realm Agent information focus**: the panel opens but `focused` stays false. Status: done (2026-11-01); cause found and fixed in the app, deterministic regression step added. The in-window native handoff is now checked on every host (task 3); OS window focus is not qualified (see Outstanding work).
2. **Annotation Notes focus**: `pressControl`'s five-second focus check fails in the annotation owner. Status: done (2026-11-01); cause found and fixed in the app. The keyboard test's in-window native handoff is now checked on every host (task 3); OS window focus is not qualified (see Outstanding work).
3. **Native-focus half skipped on arktech-mini**: every run skipped the `windowFocused` assertions. Status: done (2026-11-01); cause found (the console session is locked), and the specs now check which view Chromium focuses without needing an active window.

Neither failure depended on earlier tests or on the window being frontmost.
Both were a focus move the user did not make, landing at a time that depends
on host load: the checks are deterministic once that move is forced, and pass
whenever it lands outside the checked window.

### 1. Workspace realm Agent information focus

**Problem.** `mise run test:agent:electron` could not go green while
`e2e/agent-testing/workspace-realm-electron.spec.ts` failed its Agent
information focus poll (`{ label: "Agent information", focused: false }`).

**Context.** The poll is in the "Keyboard focus crosses the native webContents
boundary" loop; records cite it as line 409. Recorded in
[0790](../../tests/flaky-tests/aggregate-validation-runs/0790-environment-list-main-merge-validation.md),
[0740](../../tests/flaky-tests/aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md),
flake [0840](../../tests/flaky-tests/electron-and-desktop/0840-workspace-realm-panel-dom-focus.md)
(arktech-mini, load about 45, window not key) and the 2026-10-31 full run in
[0950](../previews-and-annotations/0950-source-hint-producer-plugin.md).

**Cause.** A chat composer took DOM focus from the open panel when it
mounted. After the route upgrade reloads the realm, its project coordinator
loads over the leaf link, and the coordinator's `AgentNativeTab` mounts its
composer when `get_project_coordinator` answers. Two paths moved focus into
it whatever was focused at the time:

- `MentionableInput`'s value sync calls `setCursorOffset` on first render and
  on every draft change. In Chromium, placing the selection inside a
  contenteditable focuses it (the focus log's stack ends in
  `setCursorOffset`).
- `useComposerMountFocus` calls `focus()` on mount.

On an idle host the coordinator mounts about one second after the reload,
before the spec opens a panel. On a loaded host it can mount while Agent
information (or Environment process usage, the 0840 full run) is open, and the
panel's close button loses focus for good. Before 2026-10-27 the loop ran
straight after the reload; the shortcut and ⌘K steps added since then (d63225b98,
596efc496) give the coordinator more time, which is why the failure became rarer.

**Investigation.**

- On current `main` the spec passed alone (19.3 s). The desktop session never
  activated Electron (`native-focus` annotation), so only the DOM half ran.
- Without the three throttling switches of `f47398fdc` it still passed 3/3,
  so the switches were not the fix.
- A focus log in the realm showed every panel focus coming from
  `AgentInfoButton`'s effect, and the coordinator composer taking focus 0.9 to
  1.1 s after the reload through `setCursorOffset`.
- Holding the main process's `get_project_coordinator` requests for 10 s, then
  opening the panel, reproduced the record exactly: focused at 6.5 s, then
  `{ label: "Agent information", focused: false }` at 11.2 s when the
  composer mounted.

**Fix.** `isFocusHeldElsewhere` (`apps/web/src/lib/background-focus.ts`):
while focus is inside an open dialog, alert or menu that the composer is not
part of, neither path moves it. A sync that cannot place its caret leaves it
for the editor's next focus. Focus on an ordinary control still yields, so
opening a chat tab from a tab button or sidebar row still lands in its
composer. The spec now holds the coordinator's reads after the reload, opens
Agent information by keyboard, checks the composer is not mounted, releases
the hold, and requires the panel to keep focus once the composer mounts. With
the guard disabled that step fails with the recorded state; with it, the spec
passed 4/4 alone.

**Decisions.**

- **Product or test?**
  - **First decide whether the panel should take focus when opened from the
    realm, from the panel's code, then fix whichever side is wrong (recommended, chosen).**
    The panel is right to take focus (`AgentInfoButton` focuses its first
    button for a remote open); the composer was wrong to take it away.
  - **Drop the focus half of the poll.** Not taken: the assertion caught a
    real focus theft a user would hit on a slow link.

### 2. Annotation Notes focus

**Problem.** The annotation owner (`e2e/agent-testing/web-annotations-electron.spec.ts`)
failed at `pressControl`'s focus check, alone too: `toBeFocused` received
`inactive` for five seconds on the Notes button.

**Context.** Recorded in 0740, 0772, 0789 and 0790, and in the 2026-10-31
source-hint run in [0950](../previews-and-annotations/0950-source-hint-producer-plugin.md),
where `pressControl` gained an explicit return of native focus to the host
(`1fac33ff6`). Todo
[0044](../previews-and-annotations/0044-web-annotation-qualification.md) task 4
covers OS-level native focus, which a shared desktop cannot prove; this is the
in-document focus `pressControl` checks before it sends a key.

**Cause.** A startup notice dismissed by the spec left focus on `<body>`. The
app's startup notices (Docker, no AI CLI, Claude login, GitHub CLI) open on
their own after the renderer starts: Docker after a 1.5 s confirmation, host
tools after 250 ms, each behind backend reads. The spec reloads or relaunches
the renderer in several tests (the source-hint test right before the Notes
test ends with a reload), so a notice can open just after `pressControl` has
focused a control. The notice does not take focus when it opens, but the next
assertion runs the spec's locator handler (`dismissStartupDialogs`), which
clicks "Continue Without …". Radix's modal content then returns focus to its
`DialogTrigger`; these notices have none, so focus fell to `<body>` and the
control never got it back. A user who dismisses the notice loses their place
the same way.

**Investigation.**

- On current `main` the owner passed alone 14/14 (one Docker-only skip), and
  also 2/2 with `pressControl`'s native-focus return removed, so that return
  was not what made it pass. The window was never frontmost.
- Holding the main process's `get_github_cli_status` across a renderer reload,
  focusing the Notes button, then releasing, reproduced the record exactly:
  `expect(locator).toBeFocused() … Received: inactive … Timeout: 5000ms`, focus
  on `<body>` after the handler closed the notice.

**Fix.** The four startup notices in `apps/web/src/App.tsx` spread
`useDialogFocusReturn()` (moved from `lib/chat/rich-markdown/` to
`apps/web/src/lib/dialog-focus.ts`), which remembers the focused element when
the notice opens and focuses it again when it closes. The same reproduction
then kept focus on the Notes button and the check passed. The owner passed
2/2 alone after the fix.

**Decisions.** As task 1: the control should hold focus at that point
(recommended, chosen), so the app is fixed and `pressControl` is unchanged.

### 3. Native-focus half skipped on arktech-mini

**Problem.** Review of the fixes above found the evidence did not cover the
native half of either check: every run recorded `native-focus` (realm) or
`window-focused: false` (annotation keyboard test), so the assertions gated on
`windowFocused` never ran.

**Cause.** arktech-mini's console session is locked. `ioreg` reports
`CGSSessionScreenIsLocked = true` for the console user and `lsappinfo front`
names `loginwindow`. No application becomes active while the session is
locked, so `app.focus({ steal: true })` cannot make Electron frontmost, and
the window is never key. A minimal Electron probe (one window, one
`WebContentsView`) showed `isFocused()` false for the window and both
contents, and `getFocusedWebContents()` null, after `focus()` on either. It is
the host, not the specs or the app.

**Investigation.**

- The same probe showed Chromium still moving focus between the window's
  views: `focus()` on one fires its `focus` event and the other's `blur`, and
  only the focused document reports `document.hasFocus()`.
- Playwright enables focus emulation on every Electron page it attaches to
  (`Emulation.setFocusEmulationEnabled` in `FrameSession._initialize`; Electron
  launches without `noDefaults`), so `document.hasFocus()` is always true in
  the specs. The main process's `focus` and `blur` events are not affected.
- beelink (Linux) could provide focus under Xvfb, as the native menu
  qualification did (flake 1510), but Xvfb is not installed there and
  installing it needs root on the user's desktop and backend host. Not done.
- Checking the preview's return focus after the keyboard shortcuts dialog
  without an active window failed: `KeyboardShortcutsController` restores a
  native view only while the window and its renderer are focused
  (`resolveKeyboardShortcutsTarget`). That is intended (the user may have
  left the window), so that one check stays gated on `windowFocused`.

**Fix.** `e2e/agent-testing/webcontents-focus.ts` records each webContents'
`focus` and `blur` events in the main process. The specs now check, on every
host, which view holds Chromium focus:

- Realm spec: the realm when Agent information opens in the forced-race step
  and still after the coordinator composer mounts; the realm while the
  keyboard shortcuts dialog is open; the window after ⌘K opens its search;
  the realm when each title-bar panel opens and the window after it closes.
- Annotation keyboard test: the window after the spec focuses it, the preview
  once Add note starts selection, and the window again once main hands focus
  back to the note editor.

`isFocused()` and `getFocusedWebContents()` stay gated on `windowFocused`: they
need a key window. With `WorkspaceViews.send` no longer focusing the realm
when a panel opens, the DOM check still passed and the new check failed
(`["host"]` instead of `["realm"]`), so it catches a broken handoff the DOM
half cannot.

**Decisions.**

- **How to cover the native half on a locked host?**
  - **Check the in-window handoff from main-process focus events; keep OS
    window focus gated (recommended, chosen).** Runs everywhere, catches the
    main process failing to move focus between views. Does not prove the OS
    gives the window keyboard focus.
  - **Make arktech-mini activate Electron.** Needs the session unlocked (the
    user's password or physical access) and a desktop no other build
    activates; a dozen builds share it. Not possible from a build.
  - **Run under Xvfb on Linux.** Proves OS focus too, as for the native menu.
    beelink lacks Xvfb and needs root to add it; a CI job is the open
    decision in Outstanding work.

## Current state

Both causes are fixed in the renderer and covered by unit tests
(`background-focus.test.ts`, `useComposerMountFocus.test.tsx`, two
`MentionableInput` cases, and `dialog-focus.test.tsx` with the real Radix
alert dialog). The realm spec forces its race on every run; the annotation
race is forced only by the unit test. Neither spec is in CI
(`test:agent:electron` is not a CI job).

Both specs also check, on every host, which of the window's views holds
Chromium focus (task 3), so the in-window native handoff of both checks now
runs on arktech-mini. Only OS window focus (`isFocused()`,
`getFocusedWebContents()`) is still skipped there, because the console
session is locked.

Evidence on arktech-mini (2026-11-01, load averages 40 to 48), all with the
renderer fixes, before the view-focus checks:

- Realm owner alone: 4/4 passed (53 to 60 s each); with the guard disabled
  the new step failed with `{ label: "Agent information", focused: false }`.
- Annotation owner alone: 2/2 passed (14 passed, one Docker-only skip).
- `mise run test:agent:electron`, first run (`t1170-electron-suite-1`): 45
  passed, 3 skipped, 1 failed. Every annotation case passed. The realm journey
  failed before any focus step: Electron exited with `SIGSEGV` after startup
  (flake [1302](../../tests/flaky-tests/electron-and-desktop/1302-workspace-realm-startup-points.md)),
  and the cleanup's `ENOTEMPTY` (0941) masked that in the report.
- Second run (`t1170-electron-suite-2`): 46 passed, 3 skipped, 0 failed.

With the view-focus checks (2026-11-01, load averages 4 to 31). Every run
recorded `native-focus` (realm) and `window-focused: false` (annotation), and
every view-focus check ran:

- Realm owner alone: 8 of 9 passed (`t1170-r2-realm-2` 1/1,
  `t1170-r2-realm-rep` 2 of 3, `t1170-r3-realm-rep` 5/5). The failed repeat
  crashed before any focus step: Electron's main process exited with
  `SIGSEGV` at the realm-state poll. That is flake
  [1302](../../tests/flaky-tests/electron-and-desktop/1302-workspace-realm-startup-points.md),
  a crash in Electron's Node inspector path that also crashed 1 of 8 runs of
  the owner on `origin/main` code (`t1170-main-realm-rep`).
- Annotation owner alone: 3/3 passed (`t1170-r2-ann-1` to `-3`; 14 passed,
  the Docker-only container case skipped).
- `mise run test:agent:electron`: `t1170-r2-suite-1` 46 passed, 3 skipped
  (Windows/Linux menu, Linux Wayland, Docker container), 0 failed (6.5 min);
  `t1170-r3-suite-2` the same, 46 passed, 3 skipped, 0 failed (6.5 min).
- Negative control (`t1170-r2-realm-neg`): with `WorkspaceViews.send` not
  focusing the realm when a panel opens, the forced-race step's DOM check
  passed and the view check failed with `["host"]`.

## Outstanding work

### Qualification

- Run `mise run test:agent:electron` on a host where `app.focus({ steal: true })`
  makes Electron frontmost (the 0044 limitation): arktech-mini with its
  console session unlocked and no other build activating apps, or Linux under
  Xvfb. Then the OS-focus polls run too: the realm's `nativeFocus` and
  `getFocusedWebContents()` polls (including the preview's return after the
  shortcuts dialog) and the annotation keyboard test's `isFocused()` poll.
  Record the `native-focus` and `window-focused` annotations.
- Decide whether to add that run to CI (see Assumptions and decisions).

## Constraints and rationale

- No skips or weakened focus assertions without a diagnosis
  ([0030](0030-test-suite-and-ci-health.md) constraints). None were made.

## Assumptions and decisions

- 2026-10-31: one file for both, as 0030 recommended: both are native focus
  checks in full-app Electron specs and are likely to share a cause or a host
  requirement.
- 2026-11-01: they share a shape, not a cause: in both a focus move the user
  did not make lands at a time host load decides. Both were fixed in the app,
  as recommended, not in the specs.
- 2026-11-01: the composer guard protects only open dialogs, alerts and menus
  (`role` `dialog`, `alertdialog` or `menu`, not `data-state="closed"` and not
  `aria-hidden="true"`). Also protecting focused text fields was rejected: a
  chat tab opened by shortcut while the user types in another pane's composer
  must still take focus, as it does today. A closing launch dialog does not
  block its new tab's composer.
- 2026-11-01: a draft sync that cannot place its caret places it on the
  editor's next focus, so a late draft still opens with the caret at its end.
- 2026-11-01: the realm spec gained a deterministic step (hold the
  coordinator's reads, open the panel, release) instead of only relying on the
  timing of the existing loop. The annotation spec gained none: its race needs
  a renderer reload with a held backend read, and the real-Radix unit test
  covers the focus return; App's own tests mock the alert dialog.
- 2026-11-01: the native half that skipped on arktech-mini is covered by the
  view that holds Chromium focus, read from main-process `focus` and `blur`
  events, on every host (recommended, chosen). OS window focus stays gated on
  `windowFocused` and is not claimed. Unlocking arktech-mini's session needs
  the user; installing Xvfb on beelink needs root on a live host. Neither was
  done.
- 2026-11-01: the preview's return focus after the keyboard shortcuts dialog
  stays gated on `windowFocused`: `KeyboardShortcutsController` restores a
  native view only while the window and its renderer are focused, which is
  intended (the user may have left the window). Not changed.
- 2026-11-01: no switch was added to fail, rather than skip, when the window
  cannot be focused. A qualifying run reads the `native-focus` and
  `window-focused` annotations. Worth adding with a CI job, if one is added.
- Open: a CI job for the OS-focus half, like `native-application-menu.yml`'s
  Ubuntu/Xvfb job. Pros: repeatable OS-focus evidence on every relevant PR.
  Cons: both specs need the full app, a leaf backend and the Vite renderer
  (several minutes per run), a new source of CI flakes, and Ubuntu runners
  do not prove macOS activation. Recommended: not now; qualify once on an
  unlocked desktop or Xvfb host instead, and add a job only if the realm or
  annotation focus code changes again.

## Open questions

- Answered 2026-11-01: neither fails because the window is not frontmost; both
  are in-document focus thefts. The native-focus halves are still unproven on
  a frontmost host (Outstanding work).
- Answered 2026-11-01: Electron never became frontmost on arktech-mini because
  its console session is locked (task 3).
- Open: should the OS-focus half run in CI under Xvfb (Assumptions and
  decisions)?

## Needs verification

- Whether the OS-focus assertions (`windowFocused` true) pass on a host that
  lets Electron activate. The in-window handoff they also imply is verified.

## Related

- [0030](0030-test-suite-and-ci-health.md), [0044](../previews-and-annotations/0044-web-annotation-qualification.md),
  [0325](0325-keyboard-shortcuts-desktop-gaps.md),
  flake [0840](../../tests/flaky-tests/electron-and-desktop/0840-workspace-realm-panel-dom-focus.md).

## Replaces

- The "not flakes" note in 0030 item 7 for these two checks.
