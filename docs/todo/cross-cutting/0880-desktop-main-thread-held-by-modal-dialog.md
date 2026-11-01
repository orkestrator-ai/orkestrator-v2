# A modal dialog behind other windows holds the desktop main thread for hours

## Task analysis

Analysed 2026-10-31 against `main` at `931e55417`, Electron 45.0.0, macOS 27.0.
Filed from task 4 of [0741](0741-backend-responsiveness-under-load.md), which
has the full evidence of the incident.

On arktech-mini on 2026-10-28 the desktop main thread stopped running Chromium
tasks and Node from about 02:22:56Z to 09:08:17Z. The window, its IPC, the
remote clients it relays and the reader of the backend's stdout all froze, until
someone switched to the app and clicked. The backend no longer freezes with it
(0741 task 1), but everything the desktop process owns did.

Evidence is labelled **measured** (read from logs, code or a live run) or
**inferred** (a conclusion the measurements fit but do not prove).

### Tasks

1. **Log every native dialog before it opens**: Status: done (2026-10-31).
2. **Never open a modal without a visible parent window**: Status: done (2026-10-31). A parent is enough; it need not be visible (see Investigation).
3. **Stop previewed pages from opening native dialogs**: Status: done (2026-10-31).
4. **Record desktop main-thread stalls**: Status: done (2026-10-31).
5. **Reproduce on macOS in a disposable profile**: Status: done (2026-10-31).

### 1. Log every native dialog before it opens

**Problem.** No log line named a dialog, so 0741 could narrow the cause only by
elimination.

**Context.** The app called `dialog.showMessageBox` from `main.ts` for the
backend error, the toolchain prompt, the updater and the remote restart, and
`dialog.showErrorBox` for a startup failure. It called no other `dialog` method.

**Investigation.** *Measured, Electron source:* Electron has no event for a web
page's JavaScript dialog. Its own `web-contents.ts` calls
`dialog.showMessageBox`, and its default uncaught-exception handler
(`lib/browser/init.ts`) calls `dialog.showErrorBox`. Both look the method up on
the `dialog` object when they run, so replacing the method catches them.
*Measured, live:* a renderer's `window.confirm` then logged
`[Dialog] unrouted opening (parent: visible)`.

*Measured, code:* the desktop log writer appends through an asynchronous chain
(`application-logging.ts`), so a line logged just before a blocking modal does
not reach the file until the modal closes. Task 2 removes the blocking modal, so
this no longer loses the line on macOS.

**Decisions.**

- **How to cover dialogs the app does not open itself?**
  - **Replace `showMessageBox` and `showErrorBox` on the `dialog` object (recommended).**
    - Pros: covers JavaScript dialogs and Electron's own boxes, which have no other hook; also lets task 2 protect them.
    - Cons: relies on Electron calling through the object. If that changes, only those callers lose the protection, and the live run would catch it.
  - **Log only the app's own calls.**
    - Pros: no patching.
    - Cons: misses the likeliest source named by 0741.
- **Wrap the other `dialog` methods too?**
  - **No, and have a test forbid direct calls (recommended).**
    - Pros: nothing calls them, so there is nothing to route; `native-dialogs.test.ts` fails if someone adds one.
    - Cons: a dependency calling `showOpenDialog` would not be logged. None does today.
  - **Wrap all of them.**
    - Pros: complete.
    - Cons: code with no callers.

### 2. Never open a modal without a visible parent window

**Problem.** A windowless message box on macOS holds the main thread until
someone answers it, and macOS may keep it behind other apps.

**Context.** The file assumed this also applied to a parent that is not visible,
and listed four windowless call sites.

**Investigation.** *Measured, Electron 45 source (`message_box_mac.mm`):*
`ShowMessageBox` runs `[alert runModal]` only when there is no window. With any
window it calls `beginSheetModalForWindow`, which returns at once. The
"parent not visible" branch is only in `ShowMessageBoxSync`, which nothing here
calls. `ShowErrorBox` always runs `runModal`. *Measured, live:* see task 5.

Corrections to the earlier analysis, checked against the code:

- `confirmRestartWithCountdown` (`host-update-executor.ts`) never opened a
  windowless box: without a window it already notifies and counts down. It still
  had the plain `getAllWindows()[0]` fallback, now shared with the others.
- `showErrorBox` at startup failure and Electron's uncaught-exception box were
  not listed, and are windowless. The desktop had no `uncaughtException` handler,
  so an uncaught exception opened a blocking box and logged nothing. That fits the
  incident's silent log as well as a page dialog does (*inferred*).
- From the code, `showErrorBox` at startup failure would also hang an agent-test
  launcher, which waits for the process to exit.

**Decisions.**

- **What must a dialog have so it cannot hold the thread?**
  - **Any parent window, whatever its state (recommended).**
    - Pros: measured sufficient; a sheet on a minimized or hidden window restores it, so it can be answered.
    - Cons: a sheet blocks input to that one window until answered.
  - **A visible parent, waiting until one is visible.**
    - Pros: matches the original wording.
    - Cons: not needed, and `isVisible()` cannot tell: it stayed true for a fully covered window.
- **What if no window is open?**
  - **Open a small host window for the dialog, closed afterwards (recommended).**
    - Pros: one path; the question appears when it did before, without blocking; toolchain and startup prompts have nothing else to attach to.
    - Cons: a window can appear when someone had closed them all, for example for a downloaded update.
  - **Wait for the next window, with a notification.**
    - Pros: never opens a window unasked.
    - Cons: queued state, and startup prompts would wait for a window that nothing will create.
  - **Replace dialogs with notifications and an in-app banner.**
    - Pros: no modal at all.
    - Cons: a much larger change, across renderer and remote clients, for no further reduction in holds.
- **Which platforms?**
  - **macOS only for the parent rule; every platform for `showErrorBox` (recommended).**
    - Pros: elsewhere a windowless `showMessageBox` does not hold the thread, and adding a parent would newly block that window. `showErrorBox` is synchronous on Linux too (`restart-prompt.ts`).
    - Cons: Linux and Windows keep windowless boxes, not re-measured here.
  - **The same rule everywhere.**
    - Pros: simpler.
    - Cons: changes behaviour where nothing is known to be wrong.
- **How does someone away from the app find out?**
  - **System notification and dock bounce when the parent is not focused (recommended).**
    - Pros: a sheet behind other apps no longer goes unnoticed; clicking restores the window. Remote restart still acts on its own countdown, and the update prompt stays answerable with "install on next quit" as its effect if ignored.
    - Cons: one more notification. Skipped in agent-test profiles, because that desktop is the user's.
  - **No notification.**
    - Pros: quieter.
    - Cons: a prompt can wait unseen for hours, though without freezing anything.

### 3. Stop previewed pages from opening native dialogs

**Problem.** A previewed page's `alert` or `confirm` opened a native dialog that
nobody may be there to answer.

**Context.** Agents drive previews unattended. Artifact hosts already set
`disableDialogs: true`.

**Investigation.** *Measured, Electron source:* the preference is read when the
dialog would open, and there is no API to change it afterwards, so "cancel only
when the window is not visible" is not available. `prompt()` always throws in
Electron. `beforeunload` never opens a dialog: unhandled, `will-prevent-unload`
silently cancels the navigation, so the file's claim that it opens one was wrong.
*Measured, live, real preview:* `alert` returned `undefined` and `confirm`
returned `false` in 1 ms with no dialog; a page's `beforeunload` no longer
stopped a reload. *Measured, live:* `window.print()` from a preview opens a
separate Print window and did not hold the main thread, with the parent visible
or minimized, so this task does not cover it.

**Decisions.**

- **Do previews need page dialogs?**
  - **No: set `disableDialogs` (recommended).**
    - Pros: one line, the same as artifact hosts; nothing can wait on an answer.
    - Cons: a page under test whose action is behind `confirm()` silently takes the "Cancel" path, which can confuse someone testing their own app by hand.
  - **Answer them in an in-app prompt.**
    - Pros: pages behave as in a browser.
    - Cons: Electron has no public hook, so it needs page-script injection that misses some frames; a large change. Worth doing only if the cost above shows up.
- **What about `beforeunload`?**
  - **Always allow the unload and log it (recommended).**
    - Pros: same as artifact hosts; an agent's navigation cannot silently hang.
    - Cons: a page's unsaved-changes guard does nothing in a preview.
  - **Leave Electron's default.**
    - Pros: no change.
    - Cons: navigation is silently cancelled.

### 4. Record desktop main-thread stalls

**Problem.** The 6 h 45 min hold had to be reconstructed from the power log and
the unified log.

**Context.** The backend already had a sampler (0741 task 2).

**Investigation.** *Measured, live:* a forced 2.9 s and a 10.2 s stall logged
`[Desktop] Main thread stalled for N ms, ending <time>`, the second with
`; dialog unrouted (parent: visible) was open`. Over about 3 minutes, including
while covered, no other stall reached the 1 s threshold, and the highest idle
lateness was 809 ms, around a minimize.

**Decisions.**

- **Share or copy the sampler?**
  - **Move it to `@orkestrator/protocol`, with a per-process log line (recommended).**
    - Pros: one implementation and its tests; the backend's line and diagnostics are unchanged.
    - Cons: touches `packages/protocol` and three backend imports.
  - **Copy it into the desktop.**
    - Pros: no shared-package change.
    - Cons: two copies to keep in step.
- **Record the hold while it is happening?**
  - **No: log when it ends, as the file asked (recommended).**
    - Pros: small, and task 2 removes the known cause.
    - Cons: a hold that ends in a kill leaves no line. A worker-thread watchdog would catch that, and is worth adding only if a hold recurs.
  - **Add a worker-thread watchdog now.**
    - Pros: records even if never released.
    - Cons: more code for a case task 2 should have removed.
- **Separate host sleep from a stall?**
  - **No, the same as the backend (recommended).**
    - Pros: consistent; the power log tells them apart.
    - Cons: a sleeping host reads as a stall.
  - **Watch `powerMonitor`.**
    - Pros: a clearer line.
    - Cons: extra state for something the incident did not need.

### 5. Reproduce on macOS in a disposable profile

**Problem.** Task 2 rested on remembered Electron behaviour.

**Context.** Two disposable `dev:test` profiles on this Mac, with no agent
credentials, the first on unchanged `main` and the second with the fix. Both are
reset. Scenarios ran through the main process's inspector (`SIGUSR1`), with a
sampler writing a heartbeat file every 100 ms, read from outside the process. The
"covered" cases used a separate disposable Electron window over the test window.

**Investigation.** *Measured, before the fix:*

| Scenario                                    | Result                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| Windowless box, app not frontmost           | **Held 107,349 ms**, alert behind other apps            |
| Windowless box, window minimized            | **Held 11,625 ms** (until dismissed)                    |
| Windowless box, window covered              | **Held 6,722 ms** (until dismissed)                     |
| `alert()`, view with no owner window        | **Held over 57 s** (process stopped while still held)   |
| Box with parent: visible, minimized         | No hold; sheet                                          |
| `alert()` in attached view: minimized       | No hold; sheet, and the window restored itself          |
| `alert()` in attached view: covered, hidden | No hold; sheet                                          |

During each hold the inspector stopped answering, and the backend kept answering
HTTP. With the window minimized and held, pausing the profile's own backend made
it write a stall line ending 02:27:01Z. `electron.log` did not grow during the
hold, and the line appeared after the release at 02:27:04Z: the stdout reader is
held too.

*Measured, after the fix:* no scenario held the thread. Windowless box, covered
window, `showErrorBox` and an uncaught exception each opened a sheet. The
ownerless `alert()` opened a sheet on the current window. With no window open, a
host window parented the box and closed afterwards (`parent: host`).

So: **task 2 matters for windowless boxes**, and task 3 is about unattended
answers rather than holds, for a page attached to a window.

*Inferred:* the incident's dialog was windowless, so it was not a preview page
attached to its window. The likely sources are an uncaught main-process
exception, or a page in web contents with no owner window. The new logs will name
it if anything like it recurs.

**Decisions.**

- **Where should the reproduction live?**
  - **In this file, with no committed probe (recommended).**
    - Pros: it relies on the inspector and a shared desktop, so it does not belong in a test tier.
    - Cons: the next person rebuilds the small harness.
  - **A committed script.**
    - Pros: repeatable.
    - Cons: needs a GUI session and drives real windows.

## Outstanding work

None of the five tasks. What remains is evidence only a production install can
give; see Needs verification.

## Open questions

- Whether a preview page's `confirm()` silently taking "Cancel" bothers anyone
  testing by hand. If so, build the in-app prompt rejected in task 3.

## Needs verification

- The notification and dock bounce (`requestDialogAttention`) never ran live:
  agent-test profiles skip them on purpose. Check on a production install.
- The real updater, remote restart, toolchain and startup-failure prompts were
  not triggered live. Each has unit coverage of its route, and the same code path
  ran live through `dialog.showMessageBox`.
- Linux and Windows were not run.
- The incident's real source. Search production logs for
  `[Desktop] Main thread stalled`, `[Dialog]` and `[Desktop] Uncaught exception`
  (`[desktop] main-thread.stalled`, `[desktop.dialog]` and
  `[desktop] uncaught-exception` in builds on the shared logger).

## Related

- [0741](0741-backend-responsiveness-under-load.md): the incident and the backend's stall monitor.

## Assumptions and decisions

### All tasks: no options were marked in this file

- **Chose:** the options marked (recommended) above, which this worker wrote after
  the code and the live runs, because the file offered none.
- **Why:** the earlier analysis pre-dated the measurements, and parts of it were
  wrong.

### Task 1: patch the `dialog` object

- **Chose:** replace `showMessageBox` and `showErrorBox`, labelling callers outside
  the helper as `unrouted`.
- **Why:** nothing else reaches Electron's own callers, and a live run confirmed
  it works on Electron 45.

### Task 2: any parent is enough, and a host window when there is none

- **Chose:** on macOS, always attach to a window, opening a small one if none
  exists. If that fails, the dialog is refused as cancelled rather than opened
  windowless.
- **Why:** measured sufficient. A prompt nobody sees is better than a frozen app.

### Task 2: handle uncaught exceptions

- **Chose:** add an `uncaughtException` handler that logs the error and shows one
  sheet at a time.
- **Why:** not asked for by name, but Electron's default was a blocking, unlogged
  box, and a candidate for the incident.

### Task 2: agent-test startup failures do not open a dialog

- **Chose:** log and quit.
- **Why:** the box would hang the launcher, the same reason the toolchain prompt
  already skips these profiles.

### Task 3: disable preview dialogs and allow unloads

- **Chose:** `disableDialogs: true`, and always allow `beforeunload`, with a log line.
- **Why:** matches artifact hosts. Agents drive previews unattended.

### Task 4: move the sampler to `@orkestrator/protocol`

- **Chose:** one shared monitor with a `formatStall` option.
- **Why:** the file asked for the same sampler, and the backend's output is unchanged.

### Task 5: live runs on the shared desktop

- **Chose:** drive two disposable profiles on this Mac, then reset them.
- **Why:** the coordinator asked for this host. One stray click during the first
  run landed on blank space in another worker's disposable window, because the
  alert was behind it; nothing changed there, and later input targeted exact windows.
