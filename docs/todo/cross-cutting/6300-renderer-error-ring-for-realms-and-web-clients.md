# Renderer error ring for the web client and iOS

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`. Tasks 2 and 3 are done: a browser tab (the iOS app's web view included) now sends its ring to the backend it is signed in to, under its own share of the minute's bound, and the iOS shell opens its web view to Safari's Web Inspector only while the page's renderer debug logging is on. What is left is running the new iOS unit tests on a simulator (task 4), which this host cannot do; looking at a real iPhone is in 7568 (6300 task 3).

Previously analysed 2026-11-07 against unified-federation-b4c9ee65814d at `ae492c20c` (task 1 obsolete), and 2026-11-05 against `main` at `1a66d95c3`. From efficiency report part `0790` (E16), its open question on the remote web client's ring and iOS.

### Tasks

1. **Workspace realms**: decide whose essential log a realm's renderer failures belong in. Status: done (obsolete, 2026-11-07): realms no longer exist (6002, 6003); another node's workspace fails in the window's own renderer, whose ring already goes to the window's backend.
2. **The remote web client**: decide whether a browser tab sends its ring, and to which backend. Status: done (2026-11-11): it sends to the backend it is signed in to, with a per-client share of the minute.
3. **iOS**: decide whether the iOS shell needs any logging of its own (`os_log`, `isInspectable`). Status: done (2026-11-11): `isInspectable` behind the page's renderer debug switch, no `os_log`; the look on a real iPhone is in 7568 (6300 task 3).
4. **Run the iOS inspector tests on a simulator**: `WebInspectorTests` compiles but has not run. Status: open.

### 1. Workspace realms

Done (obsolete, 2026-11-07).

**Problem.** A workspace realm (another machine's workspace shown inside a desktop window) recorded failures in its own renderer error ring but never sent them, so a realm failure left no trace on any machine.

**Context.** E16 built the ring (`apps/web/src/lib/renderer-error-ring.ts`) and a desktop window's upload (`renderer-error-upload.ts`, started by `startRendererDiagnostics` in `renderer-diagnostics.ts`). Plan items 6002 (web) and 6003 (desktop) deleted the realms, `workspace-realm.ts` included, with the user's approval of 2026-11-07. Another node's workspace now renders in the window's own renderer through its node scope ([node scopes](../../architecture/federation.md#node-scopes-one-scope-per-node-in-the-windows-tree)).

**Investigation.** Checked on the branch: `rendererErrorRoute()` answers only `window` or `browser`, and no client code sends `route: "realm"`; the protocol keeps the value so older renderers' reports still parse (`RENDERER_ERROR_ROUTES`, `packages/protocol/src/renderer-errors.ts`). A failure in a leaf's workspace is caught by the window renderer's boundaries and recorded in that renderer's ring, which the window uploads to its own backend, the command node ([logging](../../architecture/logging.md#renderer-failures-in-the-essential-log)). That is the outcome the recommended option below asked for, with no realm-to-shell message.

**Decisions.**

- **Where do a realm's entries go?** Settled by the realms' removal: to the window's command node, in the window's own ring.
  - **To the window's command node, through the window's shell renderer, which already sends its own ring (recommended, and now what happens).**
    - Pros: one machine's log holds everything that window showed; no workspace client gains a write on a remote machine's log.
    - Cons: a failure is logged away from the node it concerns.
  - **To the realm's own node, by allowing the command for workspace grants.**
    - Pros: the entry sits beside that node's other logs.
    - Cons: lets a workspace client write to another machine's always-on log, which the grant scope deliberately refuses; still rate-bound and content-free, but a new surface.

### 2. The remote web client

Done (2026-11-11).

**Problem.** A browser tab on the web client kept its ring in memory only; a failure there left nothing once the tab closed.

**Context.** The ring records `route: "browser"` for it. The gateway serves the same `invoke` path, so sending needed no new route. The backend's bound was 30 entries a minute across all clients, so one noisy tab could use the whole minute.

**Investigation.** A browser tab installs its gateway (`installBrowserGatewayApi`, `web-gateway.ts`) only when `renderer-entry.tsx` loads, after `startRendererDiagnostics` has run, so at that point the tab had no transport and `rendererErrorRoute()` answered `window` for it. `record_renderer_errors` handlers in v2.36.5-beta and v2.36.6-beta checked the argument keys by hand (`assertOnlyKeys(args, ["entries"])`, `git show 3cdfd98d2:apps/backend/src/core/commands-registry-system.ts`), so a new argument fails there; since #1983 (v2.37.0-alpha) the command is defined with a tolerant schema. Live on a headless `dev:test` profile on mini (2026-11-11), `e2e/agent-testing/renderer-error-ring-browser.spec.ts` passed: an uncaught `TypeError` thrown in the signed-in tab became one `renderer-errors` `error.recorded` line in the profile's `logs/essential/essential.jsonl` with `route: "browser"`, `boundary: "window"` and only the five fields; the error text did not reach the file; a second batch of ten from one `client` was answered `{ accepted: 0, dropped: 10 }`, and the client id was not in the file.

**Decisions.**

- **Should a browser tab send its ring?**
  - **Yes, to the backend it is signed in to, with a per-client share of the minute's bound (recommended, implemented).**
    - Pros: a web-only user's failures reach the diagnostics bundle; the backend already validates every entry.
    - Cons: needs a per-client limit so one tab cannot use another's budget.
  - **No: keep it in memory and show it in the bug report.**
    - Pros: no new write from the network.
    - Cons: the trace is lost with the tab, which is the problem E16 set out to fix.
- **How does the backend tell renderers apart?**
  - **A random id the renderer sends as an optional `client` argument (recommended, implemented).**
    - Pros: no transport change; works the same over the gateway and Electron IPC; an older backend ignores it.
    - Cons: self-declared, so a sender can mint ids; bounded by tracking 64 ids a minute, with later ids sharing one more share, and by the unchanged total.
  - **Derive the caller from the transport (the gateway session or IPC sender).**
    - Pros: cannot be forged.
    - Cons: command handlers receive no caller identity today; threading one through every transport is a much larger change, and every signed-in client is already an admin client.

### 3. iOS

Done (2026-11-11).

**Problem.** The iOS shell had no logging at all. It wraps the web client, so its renderer is task 2's, but nothing let a developer inspect the page on a release build.

**Context.** The report listed `os_log` and `isInspectable` as considerations. `isInspectable` (iOS 16.4; the app targets iOS 17) allows Safari Web Inspector on a release build, the iOS counterpart of the desktop's Help → Open Developer Tools. The shell's web view uses a non-persistent data store, so the page's `orkestrator:debug` preference lasts only as long as the web view.

**Investigation.** With task 2 done, the shell's renderer failures already reach the backend as `route: "browser"`. The shell exposes `window.orkestratorNativeShell.setWebInspectable` from its document-start bridge script; the renderer reports its debug state at every start (`reportWebInspectable`, `apps/web/src/lib/debug-log.ts`); the native `set-inspectable` action sets `isInspectable`, accepts only a boolean, and runs only for the trusted main frame like every bridge action; every committed navigation sets it back to false. Settings → Renderer Debug Logging names Safari's Web Inspector in the app. The app and its tests build (`xcodebuild build-for-testing`, generic iOS Simulator destination, `TEST BUILD SUCCEEDED`, 2026-11-11 on mini, Xcode 27.2); the tests have not run (task 4).

**Decisions.**

- **What to add?**
  - **`isInspectable` behind the same per-window switch the web client has (recommended, implemented).**
    - Pros: matches the desktop's opt-in DevTools; no new log format; inspection ends with the page or the web view.
    - Cons: native shell failures stay unlogged.
  - **`os_log` for the shell plus `isInspectable`.**
    - Pros: covers native failures.
    - Cons: a second logging system with its own privacy review, for a shell whose own code is connection handling.

### 4. Run the iOS inspector tests on a simulator

**Problem.** `apps/ios/OrkestratorMobileTests/WebInspectorTests.swift` (the bridge action turns inspection on and off, refuses a non-boolean, and a new document starts uninspectable) compiles but has never run.

**Context.** `mise run test:ios` (`scripts/test-ios.ts`) needs an available iOS simulator. No CI workflow runs the iOS tests.

**Investigation.** On mini on 2026-11-11, `xcrun simctl list devices available` lists no devices, so `test:ios` cannot run there. Installing a simulator runtime is a multi-gigabyte change to the host, outside this work.

**Decisions.**

- **Where to run it?**
  - **On a Mac that already has a simulator runtime, with `mise run test:ios` (recommended).**
    - Pros: the suite's own runner; covers every iOS test at once.
    - Cons: needs such a host.
  - **Install a runtime on mini.**
    - Pros: the command node could run it from then on.
    - Cons: a large host change nobody asked for.

## Assumptions and decisions

### Task 1: desktop upload reference

Corrected the upload startup reference to `renderer-diagnostics.ts`, invoked by `renderer-bootstrap.ts`. This documentation correction leaves the three follow-up tasks open.

### Task 1: closed as obsolete (2026-11-07)

Realms were deleted by plan items 6002 and 6003 (node scopes replaced them), so there is no separate realm renderer whose ring could go unsent. Marked done rather than deleted: tasks 2 and 3 keep the file open. The file name keeps "realms" so the links to it keep working.

### Task 2: a share of 10 entries a minute per client

Each `client` may write at most 10 of the minute's 30 entries (`RENDERER_ERROR_ENTRIES_PER_CLIENT`, `renderer-error-recorder.ts`), so three noisy renderers are needed to use the whole minute. A write without `client` (a renderer from before this change) keeps the old behaviour, the total alone, so an older desktop window loses nothing. A malformed `client` refuses the write, like a malformed entry. The id is never logged.

### Task 2: the id lives in session storage

The renderer keeps its id in the tab's session storage (`renderer-error-client.ts`), so a crash-reloading tab keeps one share instead of taking a new one each load; a new tab gets a new id.

### Task 2: a tab sends before its gateway exists

`startRendererDiagnostics` starts the browser upload at bootstrap and resolves the gateway at each send: a send before the gateway is installed fails and is retried (the uploader's usual backoff), and the session-storage journal keeps the counts for the tab's next load if its application never loads. `rendererErrorRoute` now treats a page with no desktop API, served over HTTP to something other than Electron, as `browser` before its gateway is installed. Domain adapter counts (plan item 1009) stay desktop-only; that was not part of this task.

### Task 2: older backends that refuse the new argument

The renderer retries a batch without `client` when the backend answers "Unexpected arguments field: client" (v2.36.5-beta, v2.36.6-beta) and leaves it out for that load. Recorded in the [register](../../architecture/version-compatibility.md#register).

### Task 3: isInspectable resets on navigation

The shell turns inspection off on every committed navigation and the page turns it back on at start only when its debug logging is on, so switching servers or reloading with the switch off cannot leave the web view inspectable.

## Related

- [Application logging, renderer failures](../../architecture/logging.md#renderer-failures-in-the-essential-log)
- [Application logging, the renderer](../../architecture/logging.md#the-renderer)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): 6300 task 3 (user part), Safari's Web Inspector on a real iPhone.
