# Closing a window during a request throws in the main process

## Task analysis

Analysed 2026-11-05 against `main` at `251f772d6`. Found running `renderer-log-boundary-electron.spec.ts` for E16. Task 1 acted on 2026-11-06 against `main` at `e6c3da899`, for flake 0622 (to-do 0042 task 11).

### Tasks

1. **Stop the throw when a window closes during a request**: a request still in flight after its window's scope is released should not raise an uncaught exception. Status: done (2026-11-06, `03cbf0191`).
2. **See what happens with a display**: whether a user gets the error dialog, and whether the app then exits cleanly. Status: blocked (waits on 7568: 6303 task 2, a host with a disposable display). The throw that led here is gone, so this now concerns any other uncaught exception: whether the sheet with no parent window crashes Electron (SIGTRAP), with and without a display.

### 1. Stop the throw when a window closes during a request

**Problem.** Closing the app while its window was still starting raised an uncaught `The requesting window is no longer available.` in the main process. The main process then tried to show an error dialog, and Electron died before the essential log recorded `essential.stopped` and `shutdown.finished`.

**Context.** `ConnectionManager.getRendererRequestAuthorization` (`apps/desktop/electron/connection-manager.ts:1030`) calls `remoteForScope`, which calls `connectionIdForScope`. That throws when the scope has no binding and is not the default scope (`:1711-1716`), and `release` removes the binding (`:1265-1267`). The function has four callers: `apps/desktop/electron/main.ts:343`, `:723` and `:961`, and `window-workspace-target.ts:93`. The caller at `main.ts:961` is passed to `installRemoteGatewayRequestAuth`, which calls it synchronously from Electron's `onBeforeSendHeaders` and `onHeadersReceived` callbacks (`remote-gateway-request-auth.ts:120`), where a throw has no handler to reach. `installUncaughtExceptionDialog` (`native-dialogs.ts:226`) logs an uncaught exception and shows the dialog.

**Investigation.** Seen on 2026-11-05 on beelink, in 4 of 4 runs of the spec at `525c3c589` before its rebase. Every run had **no display**: Electron on headless Ozone with the display variables removed. The spec reloaded the window and closed the app as soon as a poll of the essential log passed, so the page was still starting. One run's output had, in this order: `quit.stopping-backend`, `shutdown.finished code=0`, the `uncaught-exception` line, `[desktop.dialog] opening source=uncaught-exception parent=none`, then SIGTRAP. The other three were checked for the last three of those, and each had them.

Waiting for the page to finish starting before closing, or leaving out the reload, passed 2 of 2 runs each, on the same code. The spec now waits, which removes this trigger from the test and leaves the throw in the app.

Two things are not established:

- **The caller is unconfirmed.** The saved stack is cut off straight after `getRendererRequestAuthorization`. The request hook at `main.ts:961` is the likeliest because a request from a window that is still starting fits the timing, but no frame shows it.
- **SIGTRAP coming from the error dialog is inference.** It came straight after the dialog log line, and showing a dialog with no display could plausibly crash. Nothing showed the dialog was the cause.

`connection-manager.ts` and `remote-gateway-request-auth.ts` are unchanged by E16's branch, so this was already possible; E16's added reload is what made the spec hit it.

**Decisions.**

- **Where to stop the throw?**
  - **`getRendererRequestAuthorization` returns `null` for a released scope (recommended).**
    - Pros: covers all four callers in one place; attaches no credential, which is the safe answer for a request with no window; `window-workspace-target.ts` and the request hook already handle `null`.
    - Cons: the throw stays in `connectionIdForScope` for other callers, so the new check has to run before it.
  - **Catch it in `installRemoteGatewayRequestAuth`.**
    - Pros: small, and also protects the hook from any other throw.
    - Cons: needs a catch in both callbacks, each still calling Electron's `callback`; the other callers can still throw.
  - **Release the scope only after the window's requests finish.**
    - Pros: no request ever sees a released scope.
    - Cons: Electron gives no signal that requests have drained, so this needs tracking that a close could wait on indefinitely.

### 2. See what happens with a display

**Problem.** The failure has only been seen with no display, so what a user would see is unknown.

**Context.** With a display, `dialog.showMessageBox` should be able to open, so the app might show the error box during quit instead of dying. `.github/workflows/native-application-menu.yml` now runs the spec under Xvfb, but with the spec's wait in place it no longer triggers this.

**Investigation.** Not run. beelink has no disposable display (no Xvfb), and test runs must not use the signed-in desktop. A run of the earlier spec under Xvfb, without the wait, would reproduce the timing.

**Decisions.**

- **How to check?**
  - **Run the earlier spec once under Xvfb, before fixing task 1 (recommended).**
    - Pros: shows the real outcome, repeatably, and gives the fix a failing case.
    - Cons: needs a host with Xvfb; providing one is in the manual-test checklist (7568: 6303 task 2).
  - **Close a real window by hand during startup.**
    - Pros: needs no harness.
    - Cons: the timing is hard to hit, so a clean close would prove little.

## Assumptions and decisions

### Task 1: both recommended changes, and the caller confirmed (2026-11-06)

Chose the recommended option, `getRendererRequestAuthorization` returning
`null` for a released scope, and also the second one: both callbacks of
`installRemoteGatewayRequestAuth` now always call back, sending a request with
no credential when the lookup throws. The first removes the known throw in
that lookup for all four callers; the window hook's local gateway fallback
also needs the nonthrowing bound-scope lookup, added during review on
2026-11-06 with composed authorization and origin callback coverage. The
second keeps any other throw from leaving a request unanswered and now emits
a debug event naming the hook phase, without request or exception content. The trade-offs are in to-do 0042, decision D22.

The caller is now confirmed. Flake 0622's multi-backend Electron test hit the
same exception when its second window closed under CPU contention (5 of 10
runs), with the same `[desktop.dialog] opening source=uncaught-exception
parent=none` line and SIGTRAP. A temporary probe (not committed) in the window
hook (`main.ts:965`) and the preview views' hook (`main.ts:729`) fired
only in the window hook, for Vite renderer modules whose headers arrived 8 ms
after the window's `closed`. With the fix the same load passed 10 of 10 with
no `uncaught-exception` line. Tests: `apps/desktop/tests/connection-manager.test.ts`
and `apps/desktop/tests/remote-gateway-request-auth.test.ts` (the cases named
0622), both failing without the source change.

Task 2 stays open: SIGTRAP following the sheet is still not explained, and no
disposable display was available.

## Related

- 6301 (retired 2026-11-11; `git show 498b68766:docs/todo/cross-cutting/6301-log-controls-live-evidence.md`): its renderer log controls are described in [Application logging, the renderer](../../architecture/logging.md#the-renderer)
- [Flake 2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)
- [Flake 0622](../../tests/flaky-tests/previews-annotations-and-gateway/0622-service-preview-window-close-remote-release.md),
  [to-do 0042](../previews-and-annotations/0042-service-preview-rollout.md) (task 11, D22),
  every webRequest listener answering (to-do 7060, done 2026-11-10:
  [renderer-security.md](../../architecture/renderer-security.md#webrequest-listeners))
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: providing a host with a disposable display) moved there on 2026-11-10.
