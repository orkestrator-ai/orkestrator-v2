# The desktop's main process still takes every relayed event

## Task analysis

Analysed 2026-11-05 against `main` at `1e6d56391`.

### Tasks

1. **Scope the desktop main process's relayed events**: stop main receiving relayed events no window watches. Status: open.

### 1. Scope the desktop main process's relayed events

**Problem.** Efficiency report 0280 (E18) part `0370` task 1 wanted clients that watch no node, or another node, to stop receiving the bytes. Renderers on the gateway transport now do. The desktop's main process does not: it opens one stream per connection (`BackendHttpClient`, `apps/desktop/electron/backend-process.ts`) and asks for every relayed event under the old name (`relayedEvents=legacy`).

**Context.** Main forwards events to windows without knowing what they watch (`desktop-window-contexts.ts`). It serves two cases: a workspace realm's portal (`createPortalApi`, `orkestrator:portal-event`) and a local window with `localWindowGatewayTransport` off. These frames no longer use the main replay window, so a busy leaf cannot make main's stream reconcile; on a reconnect main receives a `resync` per node. What remains is the bytes, usually over loopback, and the old-name code, which cannot retire while main uses it (see the [register](../../architecture/version-compatibility.md#register)).

**Investigation.** Read from the code on 2026-11-05. The preload's `listen` keeps its listeners in the renderer, so main is not told which events a window wants. A renderer on the IPC path already calls `portalListen` for the per-node name, which never fires there, and receives the old name instead. Moving main to the per-node stream without knowing the watches would need a reconcile signal that names no node, since it could not list them. This was left out of E18 because the desktop's IPC surface is the E26 lane's code and the remaining cost is small.

**Decisions.**

- **How should main take relayed events?**
  - **Have windows tell main which per-node events they listen to, and let main run one filtered stream with its own cursor (recommended).**
    - Pros: the same behaviour as the browser; lets the old-name code retire once the window has passed.
    - Cons: a new IPC message, and a stream per connection to manage in main.
  - **A second stream in main for the whole `relayed-node-event:` prefix.**
    - Pros: no new IPC; separates the replay state.
    - Cons: main still receives every node's bytes, and a gap has no list of nodes to resync.
  - **Leave it until the relay rollback and realms move to a direct portal.**
    - Pros: no work now.
    - Cons: the old-name path stays with no end date.

## Related

- [5840](5840-relayed-events-live-evidence.md): live checks of the per-node path.
- [1202 task 11](1202-efficiency-review-follow-ups.md) and task 12 (local desktop transport)
- [Command nodes](../../architecture/command-nodes.md)
