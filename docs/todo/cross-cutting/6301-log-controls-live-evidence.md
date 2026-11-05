# Log controls: live evidence

## Task analysis

Analysed 2026-11-05 against `main` at `1a66d95c3`. From efficiency report part `0790` (E16), tasks 2 and 3, and part `0890` task 2.

### Tasks

1. **Help → Open Developer Tools in a packaged app**: see the item appear, open and disappear on macOS, Windows and Linux. Status: open.
2. **A desktop window's own error ring reaching the essential log**: one real renderer failure, end to end. Status: done.
3. **A raised setting reverting on the timer in a running app**: the one-minute check, not only the start check. Status: open.

### 1. Help → Open Developer Tools in a packaged app

**Problem.** The menu is built from a template that unit tests check on all three platforms, but no native menu was seen.

**Context.** `createApplicationMenuTemplate` (`apps/desktop/electron/application-menu.ts`) adds Help on every platform (the system Help menu on macOS) and **Open Developer Tools** only while `RendererDebugTools` (`renderer-debug-tools.ts`) holds a renderer that reported debug logging on through `orkestrator:window:set-renderer-debug`. The renderer reports at start (`reportRendererDebugLogging`, `renderer-entry.tsx`). See `docs/architecture/logging.md`, "The renderer".

**Investigation.** Tests: `application-menu.test.ts` (each platform, with and without the item), `renderer-debug-tools.test.ts`, `main-ipc.test.ts` (trusted sender, boolean only) and `preload-api.test.ts`. The E16 build ran a headless `dev:test` profile, where the native menu cannot be seen, and had no packaged build, Mac or Windows machine.

**Decisions.**

- **How to check?**
  - **Run a packaged build on each platform: turn Renderer Debug Logging on, confirm Help shows the item and that it opens DevTools for the focused window; turn it off and confirm the item goes (recommended).**
    - Pros: the claim is about a packaged app's native menu, and only that shows it.
    - Cons: needs three platforms and a packaged build of each.
  - **Rely on the template tests.**
    - Pros: nothing to do.
    - Cons: says nothing about Electron's rendering of an empty macOS Help menu or of a rebuilt menu.

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

**Investigation.** Live: with `logDetailExpiresAt` set in the past while the profile was stopped, the next start reverted `bridge=debug` to `info`, removed the expiry, left `debugLogging` alone and wrote `[logging] policy.detail-expired`. The timer path is covered by `log-detail-expiry.test.ts` with a real `StorageService` and bridge delivery, but a 24-hour expiry was not waited out in a running app.

**Decisions.**

- **How to check?**
  - **A test-only hook that sets a short expiry through the config write in a running profile, then watching for the revert and the bridge push (recommended).**
    - Pros: minutes; exercises the timer, the config announcement and the desktop's re-read.
    - Cons: a new hook; a hand edit of `config.json` may not be seen, because the backend reads the config through a cache.
  - **Rely on the integration test.**
    - Pros: already passes.
    - Cons: not a running app.

## Related

- [Application logging, live settings](../../architecture/logging.md#live-settings)
- [Renderer failures in the essential log](../../architecture/logging.md#renderer-failures-in-the-essential-log)
- [6300](6300-renderer-error-ring-for-realms-and-web-clients.md)

## Assumptions and decisions

### Task 2: automated Electron evidence

The existing renderer-log-boundary Electron spec now mounts a throwing React
component inside a boundary using the production root error callbacks. It waits
for the normal scheduled uploader and checks the isolated profile's essential
file for all five metadata fields and the absence of synthetic message and stack
text. This exercises the selected transport, backend recorder and desktop relay.
Task 1 still requires packaged native-menu checks on all three operating systems.
