# A modal dialog behind other windows holds the desktop main thread for hours

Checked against `main` at `79f3bc97e` (2026-10-29). Filed from task 4 of
[0741](0741-backend-responsiveness-under-load.md), which has the full
evidence.

On arktech-mini on 2026-10-28 the desktop main thread stopped running
Chromium tasks and Node from about 02:22:56Z to 09:08:17Z. The window, its
IPC, the remote clients it relays and the reader of the backend's stdout all
froze, until someone switched to the app and clicked. The backend no longer
freezes with it (0741 task 1), but everything the desktop process owns still
does.

## Task analysis

Analysed 2026-10-29 against `main` at `79f3bc97e`.

### Tasks

1. **Log every native dialog before it opens**: Status: open.
2. **Never open a modal without a visible parent window**: Status: open.
3. **Stop previewed pages from opening native dialogs**: Status: open.
4. **Record desktop main-thread stalls**: Status: open.
5. **Reproduce on macOS in a disposable profile**: Status: open.

Evidence is labelled **measured** (read from logs or code) or **inferred**
(a conclusion the measurements fit but do not prove).

### 1. Log every native dialog before it opens

**Problem.** No log line names a dialog, so 0741 could narrow the cause only
by elimination.

**Next step.** Route every `dialog.showMessageBox`, `showMessageBoxSync`,
`showErrorBox`, `showOpenDialog` and `showSaveDialog` call in
`apps/desktop/electron/` through one helper. Before opening, it logs
`[Dialog] <source> opening (parent: none | hidden | visible)` and, after,
`closed after N ms`, with no message text (dialogs can carry paths and
errors). Also log web contents' JavaScript dialogs and `will-prevent-unload`
where Electron exposes them.

### 2. Never open a modal without a visible parent window

**Problem.** *Inferred, from Electron's source as remembered and not verified
here:* on macOS a message box with no parent, or with a parent that is not
visible, runs `NSAlert runModal`, an app-modal loop on the main thread. When
the app is not frontmost, macOS refuses to activate it (*measured:*
`CPS: Denying OrkestratorV2 the right to be in front` at 02:22:56.173Z), so
the alert waits behind other windows while Chromium and Node do not run.

*Measured, code:* these call `showMessageBox` without a window, or with one
that may be null:

- `showNonBlockingError` (`main.ts`);
- the toolchain prompt (`main.ts`, startup only);
- the updater, when no window is focused (`auto-update.ts`);
- the remote-update restart confirmation, when there is no window
  (`host-update-executor.ts`).

**Next step.** Show and focus a window first and attach the dialog as a
sheet, or replace the dialog with a system `Notification` and an in-app
banner. The restart and update choices must still be answerable remotely.

### 3. Stop previewed pages from opening native dialogs

**Problem.** *Measured, code:* browser preview views set `safeDialogs: true`
but not `disableDialogs` (`browser-preview-manager.ts`), so a previewed
page's `alert`, `confirm`, `prompt` or `beforeunload` opens a native dialog
whose parent is the main window. Artifact hosts already set
`disableDialogs: true`. *Inferred:* with the window minimized or not drawing,
which WindowServer recorded at 02:22:38Z, such a dialog would be the
`runModal` case of task 2. Agents drive previews unattended, so nobody may be
there to answer.

**Next step.** Decide whether previews need page dialogs at all. If not, set
`disableDialogs: true`. If so, answer them from an in-app prompt through the
preview's preload, or cancel them when the window is not visible.

### 4. Record desktop main-thread stalls

**Problem.** The desktop has no equivalent of the backend's event-loop stall
log (0741 task 2). The 6 h 45 min hold was reconstructed from the power log
and the unified log.

**Next step.** Run the same timer-lateness sampler in the desktop main
process and log `[Desktop] Main thread stalled for N ms, ending <time>`, with
the last dialog from task 1 if one was open.

### 5. Reproduce on macOS in a disposable profile

**Next step.** In an isolated `dev:test` profile (never the production
install):

1. Minimize the window and call `alert()` from a browser preview page, then
   from a windowless `dialog.showMessageBox`.
2. Watch the desktop's timer lateness (task 4) and whether the backend's
   stdout is still read.
3. Repeat with the window visible but behind another app.

This settles the Electron behaviour assumed in task 2 and which of tasks 2
and 3 matters.

## Assumptions and decisions

### All tasks: filed as investigation results, not implemented

- **Chose:** record the fixes as open tasks rather than change desktop code
  in 0741.
- **Why:** 0741 task 4 was read-only. Each fix changes user-visible dialog
  behaviour and needs the macOS reproduction in task 5 first.
