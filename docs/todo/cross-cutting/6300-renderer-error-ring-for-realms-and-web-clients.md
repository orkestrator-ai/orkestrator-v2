# Renderer error ring for the web client and iOS

## Task analysis

Analysed 2026-11-07 against unified-federation-b4c9ee65814d at `ae492c20c`. Task 1 is obsolete: plan items 6002 and 6003 deleted workspace realms, and node scopes render every node's workspace in the window's own renderer. Tasks 2 and 3 still apply unchanged.

Previously analysed 2026-11-05 against `main` at `1a66d95c3`. From efficiency report part `0790` (E16), its open question on the remote web client's ring and iOS.

### Tasks

1. **Workspace realms**: decide whose essential log a realm's renderer failures belong in. Status: done (obsolete, 2026-11-07): realms no longer exist (6002, 6003); another node's workspace fails in the window's own renderer, whose ring already goes to the window's backend.
2. **The remote web client**: decide whether a browser tab sends its ring, and to which backend. Status: open.
3. **iOS**: decide whether the iOS shell needs any logging of its own (`os_log`, `isInspectable`). Status: open (depends on 2).

### 1. Workspace realms

Done (obsolete, 2026-11-07).

**Problem.** A workspace realm (another machine's workspace shown inside a desktop window) recorded failures in its own renderer error ring but never sent them, so a realm failure left no trace on any machine.

**Context.** E16 built the ring (`apps/web/src/lib/renderer-error-ring.ts`) and a desktop window's upload (`renderer-error-upload.ts`, started by `startRendererDiagnostics` in `renderer-diagnostics.ts` only when `rendererErrorRoute()` is `window`). Plan items 6002 (web) and 6003 (desktop) deleted the realms, `workspace-realm.ts` included, with the user's approval of 2026-11-07. Another node's workspace now renders in the window's own renderer through its node scope ([node scopes](../../architecture/federation.md#node-scopes-one-scope-per-node-in-the-windows-tree)).

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

**Problem.** A browser tab on the web client keeps its ring in memory only; a failure there leaves nothing once the tab closes.

**Context.** The ring records `route: "browser"` for it. The gateway serves the same `invoke` path, so sending needs no new route, only a decision. The remote web client's ring is one of the report's open questions; E16 recorded it here instead of building it.

**Investigation.** Many tabs on many devices can share one backend; the backend's per-minute bound (30 entries across all clients) and the essential log's per-event budget already limit the total, but one noisy tab could use the whole minute.

**Decisions.**

- **Should a browser tab send its ring?**
  - **Yes, to the backend it is signed in to, with a per-client share of the minute's bound (recommended).**
    - Pros: a web-only user's failures reach the diagnostics bundle; the backend already validates every entry.
    - Cons: needs a per-client limit so one tab cannot use another's budget.
  - **No: keep it in memory and show it in the bug report.**
    - Pros: no new write from the network.
    - Cons: the trace is lost with the tab, which is the problem E16 set out to fix.

### 3. iOS

**Problem.** The iOS shell has no logging at all; it wraps the web client, so its renderer is task 2's, but native failures (the shell's own) leave nothing.

**Context.** The report lists `os_log` and `isInspectable` as considerations. `isInspectable` would allow Safari Web Inspector on a release build, which is the iOS counterpart of task 2 in E16's Help → Open Developer Tools.

**Investigation.** Not investigated beyond the report: whether it matters depends on who debugs the iOS app.

**Decisions.**

- **What to add?**
  - **Nothing until task 2 is settled; then `isInspectable` behind the same per-window switch the web client has (recommended).**
    - Pros: matches the desktop's opt-in DevTools; no new log format.
    - Cons: native shell failures stay unlogged.
  - **`os_log` for the shell plus `isInspectable`.**
    - Pros: covers native failures.
    - Cons: a second logging system with its own privacy review.

## Assumptions and decisions

### Task 1: desktop upload reference

Corrected the upload startup reference to `renderer-diagnostics.ts`, invoked by `renderer-bootstrap.ts`. This documentation correction leaves the three follow-up tasks open.

### Task 1: closed as obsolete (2026-11-07)

Realms were deleted by plan items 6002 and 6003 (node scopes replaced them), so there is no separate realm renderer whose ring could go unsent. Marked done rather than deleted: tasks 2 and 3 keep the file open. The file name keeps "realms" so the links to it (`docs/architecture/logging.md`, 6301) keep working.

## Related

- [Application logging, renderer failures](../../architecture/logging.md#renderer-failures-in-the-essential-log)
