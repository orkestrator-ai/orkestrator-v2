# Log controls: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `1a66d95c3`. From efficiency report part `0790` (E16), tasks 2 and 3, and part `0890` task 2.

### Tasks

1. **Help → Open Developer Tools in a packaged app**: packaged Linux seen; packaged macOS and real Windows Electron not yet recorded from `native-application-menu.yml`. Status: open (looking at a drawn menu bar on a real Mac and Linux desktop is in 7568: 6301 task 1).
2. **A desktop window's own error ring reaching the essential log**: one real renderer failure, end to end. Status: done.
3. **A raised setting reverting on the timer in a running app**: the one-minute check, not only the start check. Status: done.

### 1. Help → Open Developer Tools in a packaged app

**Problem.** The packaged app's Help item was proven on Linux only, and read from Electron's `Menu` object rather than from a drawn menu bar. Nothing has been seen on macOS or Windows.

**Context.** `createApplicationMenuTemplate` (`apps/desktop/electron/application-menu.ts`) adds Help on every platform (the system Help menu on macOS) and **Open Developer Tools** only while `RendererDebugTools` (`renderer-debug-tools.ts`) holds a renderer that reported debug logging on through `orkestrator:window:set-renderer-debug`. The renderer reports at start (`reportRendererDebugLogging`, `renderer-bootstrap.ts`). See `docs/architecture/logging.md`, "The renderer". `package.json` has `mac` and `linux` build targets and no `win` one, and `docs/development/releasing.md` says Windows releases are not yet covered, so no packaged Windows app exists to check; Windows can only be checked on real Electron until a target is added.

**Investigation.** Observed on 2026-11-05 on this Linux host: `log-controls-packaged-electron.spec.ts` against `release/packaged-test/linux-unpacked/` (`app.isPackaged` true, disposable profile, headless): the item is absent at start, the real Settings switch writes `orkestrator:debug` and reloads, the item appears, using it opens DevTools, and turning the switch off removes the item. `application-menu-electron.spec.ts`, "Help offers Open Developer Tools only while a renderer has debug logging on", passed on real Electron here, also headless. This host has no macOS or Windows machine and no disposable display (no Xvfb), so nothing here draws a native menu bar.

`.github/workflows/native-application-menu.yml` now runs the Electron test on `ubuntu-latest` (under Xvfb), `windows-latest` and `macos-15`, and the packaged spec on `ubuntu-latest` and `macos-15`. Linux also runs `renderer-log-boundary-electron.spec.ts` under Xvfb, the first real-window evidence for that spec. Its path filter triggers it on the pull request. **None of those runs has happened yet, and the macOS package step (`mise run package:mac:unpacked:test`) has never been run.**

Seen 2026-11-06: from #1873 on, `ubuntu-latest` failed every run on `renderer-log-boundary-electron.spec.ts` alone (run 42224936288, 10 of 10 repeats), for two reasons the spec, not the app, had. Its bare-spawned lifecycle fixture lacked the `--no-sandbox` Playwright adds on Linux, so Chromium aborted on the runner's non-root `chrome-sandbox`. And the real-window case's profile had no agent platform: CI never builds the bridges, so the blocking "AI CLI Required" alert covered the window. The spec now passes `--no-sandbox` to its own spawn on Linux and builds the local bridges first, as `dev:test` does. The other Electron and packaged jobs passed on all three systems.

**Decisions.**

- **How to finish the check?**
  - **Read the workflow's results on the pull request, then look once at a real menu bar on a Mac and on Linux (recommended).**
    - Pros: the workflow gives repeatable macOS and Windows evidence; one look covers what no test draws.
    - Cons: needs a person with a Mac for the last step.
    - Agent part: read and record the workflow's macOS, Windows and Linux results here; the look at a drawn menu bar is in the manual-test checklist (7568: 6301 task 1).
  - **Accept the workflow's results alone.**
    - Pros: nothing manual.
    - Cons: says nothing about how an otherwise empty macOS Help menu is drawn.
- **Windows packaged evidence?**
  - **Keep to real Electron on Windows until the repository has a Windows package target (recommended).**
    - Pros: claims only what exists.
    - Cons: a future Windows package needs this check again.
  - **Add a Windows target for this check.**
    - Pros: a real package.
    - Cons: a release decision far outside log controls.

### 2. A desktop window's own error ring reaching the essential log

**Problem.** The original checks did not join the renderer ring to the essential log in a real Electron window.

**Context.** `startRendererErrorUpload` runs only in a desktop window's own renderer (`rendererErrorRoute()` is `window`), sending `record_renderer_errors` every 10 seconds. The desktop main process owns the essential log in the app and receives the backend's entry over the relay.

**Investigation.** Live on a headless `dev:test` profile: `record_renderer_errors` called through the signed-in browser wrote `renderer-errors` `error.recorded` with the five fields to the profile's `logs/essential/essential.jsonl`, and a write with a `message` was refused and left nothing. A browser tab does not upload (its route is `browser`), so the renderer-to-backend leg in Electron was not exercised.

**Decisions.**

- **How to check?**
  - **An Electron agent-testing spec that throws inside a `MessageRenderBoundary` in the real window and reads the profile's essential log within a minute (recommended).**
    - Pros: repeatable; covers the IPC transport and the relay.
    - Cons: a new Electron spec needs a display (see agent-testing.md).
  - **A manual check on a packaged build.**
    - Pros: no new harness.
    - Cons: not repeatable.

### 3. A raised setting reverting on the timer in a running app

**Problem.** The start-time revert was seen live; the one-minute timer was only tested.

**Context.** `LogPolicyService.startExpiryChecks` runs `reconcileLogDetailExpiry` at start and every 60 seconds.

**Investigation.** Closed on 2026-11-05 by `log-controls-packaged-electron.spec.ts`, "reverts raised log detail on the timer", in the running packaged Linux app: raising detail stored an expiry, the stored expiry was moved into the past while the app ran (the config read follows the file's fingerprint, so no hook was needed), and within the minute's check `logDetail` went back to `info`, the expiry was removed, `debugLogging` stayed on, `[logging] policy.detail-expired` reached the desktop's output and `get_config` returned the reverted value. No bridge was running, so the push to a live bridge remains covered only by `log-detail-expiry.test.ts`.

**Decisions.** None left.

## Related

- [Application logging, live settings](../../architecture/logging.md#live-settings)
- [Renderer failures in the essential log](../../architecture/logging.md#renderer-failures-in-the-essential-log)
- [6303](6303-window-close-during-request-throws.md)
- [6300](6300-renderer-error-ring-for-realms-and-web-clients.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: looking once at the drawn Help menu on a real Mac and a Linux desktop) moved there on 2026-11-10.

## Assumptions and decisions

### Task 2: automated Electron evidence

The existing renderer-log-boundary Electron spec now mounts a throwing React
component inside a boundary using the production root error callbacks. It waits
for the normal scheduled uploader and checks the isolated profile's essential
file for all five metadata fields and the absence of synthetic message and stack
text. This exercises the selected transport, backend recorder and desktop relay.
Task 1 still requires packaged native-menu checks on all three operating systems.

### Task 3: no test-only hook

Moving the stored expiry in `config.json` replaced the recommended hook. The
earlier note that a hand edit might not be seen was wrong for this path:
`loadJsonCached` re-reads when the file's fingerprint changes. This adds no
production code.

### Task 1: extend the existing workflow

The checks went into `native-application-menu.yml`, which already qualifies this
menu on real desktops, rather than a new workflow. Windows stays on real Electron
because the repository has no Windows package target.
