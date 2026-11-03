# Renderer diagnostics a user can turn on

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Settings switch for renderer debug**: sets `orkestrator:debug` and reloads. Status: open.
2. **Open Developer Tools from the menu**: in the packaged app, opt-in. Status: open.
3. **A persisted, content-free error ring**: renderer failures leave a trace. Status: open.

### 1. Settings switch for renderer debug

**Problem.** Raising the renderer's level needs `localStorage["orkestrator:debug"]`, and a packaged app has no DevTools to set it with.

**Context.** The R1 renderer slice made this more pressing: `console.debug` sites now write nothing unless the key is set, and Verbose in DevTools no longer shows them. `logging.md:755-761` records that it "has no setting or UI".

**Investigation.** `apps/web/src/lib/debug-log.ts:16` names the key and `:44` reads it once at startup. Live policy excludes renderer areas (`packages/protocol/src/log-policy.ts:141`). `LogDetailSettings` lists only live areas.

**Decisions.**

- **Where does the setting live?**
  - **Per window in `localStorage`, as today, with a switch that writes it and reloads (recommended).**
    - Pros: the report's design; a level belongs to this browser, not the host; one small component.
    - Cons: a remote client must set it separately, and reload loses nothing durable but does interrupt the view.
  - **Add renderer areas to live policy.**
    - Pros: no reload; one control for everything.
    - Cons: a host setting would change every client's console, and `log-policy.ts` excludes them on purpose.

### 2. Open Developer Tools from the menu

**Problem.** In a packaged app, DevTools never opens, so errors from `MessageRenderBoundary` and `RichBlockFrame` cannot be seen.

**Context.** The report wants this in Help, enabled while debug logging is on. Note Help exists only off macOS (`application-menu.ts:202-213`).

**Investigation.** `apps/desktop/electron/window.ts:133-135` opens DevTools only when `isDev`. `application-menu.ts` has no toggle. The artifact host disables DevTools (`artifact-host-session.ts:53`), and previews have their own (`browser-preview-manager.ts:860`). `docs/reports/2-26-10-27-security.md:426` notes that secrets in renderer memory are visible in DevTools.

**Decisions.**

- **Where and when is it offered?**
  - **In a Help menu added on every platform, shown only while renderer debug logging is on (recommended).**
    - Pros: explicit opt-in, matching the report's trade-off; invisible by default.
    - Cons: adds a Help menu on macOS.
  - **A button in Settings → Debug only.**
    - Pros: no menu change; sits next to the switch.
    - Cons: if the settings page is what is broken, it cannot be reached.

### 3. A persisted, content-free error ring

**Problem.** Renderer errors are deliberately not saved, so a user's report of a renderer bug leaves nothing behind.

**Context.** `logging.md:747` says whether more may be saved is undecided. A bug report already includes `recentRendererErrors` (`apps/web/src/lib/bug-report/renderer-errors.ts`, at most 30, in memory), but those hold messages and are redacted by the agent, so they are not this.

**Investigation.** Only seven exact `[DesktopStartup]` markers cross to the log (`apps/desktop/electron/renderer-diagnostics.ts:59`). Boundaries already log a component name, an allowlisted error type and a fingerprint (the `RichBlockFrame` change in the R1 renderer addendum).

**Decisions.**

- **What does an entry hold?**
  - **Error class, boundary name, route pattern, count and fingerprint, about 100 entries (recommended).**
    - Pros: the report's list plus the existing fingerprint, which tells failures apart; holds no message or stack.
    - Cons: identifies less than a stack would.
  - **Include bounded stack frames.**
    - Pros: far more useful for a fix.
    - Cons: frames hold paths and function names, and the report says the ring must not include stacks to stay within the privacy rule.
- **Where is it kept?**
  - **Sent to the backend, into the essential log (recommended; depends on [0750](0750-r6-essential-event-log.md)).**
    - Pros: survives a renderer crash and appears in the export.
    - Cons: a new client-to-backend write that must be rate-bound and validated.
  - **`localStorage` only.**
    - Pros: no backend path.
    - Cons: lost with the profile; a renderer that never loads cannot read it.

## Current state

Done, so not tasks here:

- Lifecycle trace logs moved to `debug` through `rendererDebugLog`'s gate (`#1592`; the 14 sites are in the report's [renderer addendum](../2026-10-29-logging-and-database-efficiency.md#addendum-renderer-levels-changed-by-r1)).
- Per-keystroke warnings are throttled (`apps/web/src/hooks/useTerminal.ts:1125`, `:1139`).

Still true but minor: every renderer `console.*` raises a `console-message` event in main to be compared and dropped (`renderer-diagnostics.ts:59`). Lower volume now, since `debug` sites write nothing.

## Constraints and rationale

- The renderer never uses the `desktop.startup` area, and tests scan for it (`docs/architecture/logging.md:736-740`). An error ring must not route through the marker path.

## Open questions

- The report leaves the remote web client's ring and iOS (`os_log`, `isInspectable`) as considerations. The iOS shell has no logging at all. Whether either matters depends on who debugs those clients.

## Related

- [Logging and database report, R8](../2026-10-29-logging-and-database-efficiency.md#r8-renderer-diagnostics-a-user-can-actually-turn-on-l7) and [L7](../2026-10-29-logging-and-database-efficiency.md#l7-renderer-diagnostics-are-unreachable-in-the-packaged-app-high-for-supportability)
- [Application logging](../../architecture/logging.md#the-renderer)
- [0890](0890-controls-presets-and-auto-revert.md)
