# 08 — Integrate Electron transport and service isolation

Status: Not started. Depends on: 05–07. Unlocks: 09.

## Outcome and owners

Native previews retain existing controls while loading service-bound endpoints
through isolated sessions. Electron main manages any local listener/tunnel;
React supplies bounds/visibility and receives snapshots.

Existing owners:
[preview manager](../../../../apps/desktop/electron/browser-preview-manager.ts),
[startup](../../../../apps/desktop/electron/browser-preview-startup.ts),
[window partitioning](../../../../apps/desktop/electron/desktop-window-lifecycle.ts),
[main wiring](../../../../apps/desktop/electron/main.ts),
[IPC](../../../../apps/desktop/electron/ipc.ts),
[preload API](../../../../apps/desktop/electron/preload-api.ts), and
[request auth](../../../../apps/desktop/electron/remote-gateway-request-auth.ts).
Add a proposed `preview-transport-manager.ts` separate from view management.

## Transport selection

For each trusted service attachment, select an advertised, available mode:
validated dedicated preview origin when configured; desktop-local endpoint over
the remote tunnel otherwise; verified direct local endpoint for local services
where the same isolation/policy can be enforced; legacy mode only when selected
as a compatible fallback. Display the effective mode through diagnostics.

Resolve again on epoch/generation change. Never keep navigating to an old
ephemeral port simply because it still accepts connections. Do not automatically
fall back from denied/expired new access to a less constrained legacy route.

## Local listener lifecycle

1. Main creates a loopback-only listener after obtaining a service attachment.
   Use OS-assigned ports and retain ownership of the bound socket; do not
   find a free port, close it, and race to reopen it.
2. Require the scoped local-ingress credential established in step 05. Accept
   HTTP and upgrades only for that service, with bounded connection/header
   handling. Reject arbitrary CONNECT and authority-switching requests.
3. Proxy through the outer tunnel with ordinary app headers preserved and local
   credentials stripped. Map same-service redirects through the active endpoint
   descriptor rather than generic string substitution.
4. Reference-count explicit attachments rather than mounted views. Hide/unmount
   does not close a listener. Closing the last attachment may start a short
   retirement lease; remote server processes remain running.
5. On backend disconnect mark transport unavailable, close broken connections,
   and reconcile before new navigation. Do not replay app writes on reconnect.
6. On window/application shutdown or connection change, cancel owned transport
   resources and await bounded cleanup. Track any external-browser attachment
   separately; the initial external-browser route uses step-10 HTTPS publication.

No background browser request should borrow credentials from whichever backend
is currently selected in some other window. Attachments bind to the owning
window's connection scope and backend identity.

## Session and storage policy

Extend the existing partition key with service identity (which already binds an
environment), using a stable non-sensitive hash. Same-service tabs may share a
session intentionally. Different services within a connection do not. Retain
the existing separation between preview and privileged renderer sessions.

Do not copy all cookies/storage from the old shared preview partition into each
new partition. That would reproduce contamination. Offer a documented fresh
login and targeted reset. Retain old partitions for a bounded rollback period,
then retire through explicit cleanup policy rather than deleting unrelated data.

Endpoint generations and browser origins are different lifetimes. A replaced
container must invalidate transport access, but need not silently erase the
user's same-service login. Conversely, reusing a local listener port for another
service must not reuse its session. Stable local origins across app restarts
are not guaranteed by ephemeral ports; record storage continuity limitations
or implement a proven stable-origin adapter before promising them.

## Native view behavior

Extend attach/navigate IPC to accept a trusted service reference or attachment
ID. Validate the sender and resolve endpoint descriptors in main. Do not accept
arbitrary privileged internal URLs from the renderer. Keep geometry in renderer
CSS pixels and retain existing zoom conversion and overlay visibility behavior.

Keep sandboxing, Node-off, context isolation, restrictive permissions, and
separate preload behavior. Update navigation/history policy to compare service
bindings and authorized origins. Route approved external navigation through a
deliberate action. Blocked navigation should return a useful state message.

Define a subresource/outbound-network policy as well as top-level navigation.
For remote services, unintended client-local loopback/private-network requests
must be denied or explicitly routed through a registered service; they cannot
silently bypass the remote transport. Keep approved public assets/external
flows possible without attaching preview credentials. Test frame-less workers,
redirects, and WS destinations against this policy. Document the supported
native enforcement boundary rather than claiming Chromium sandboxing is a
network firewall.

Reattach returns page state, service reference, and effective transport state.
The renderer cannot infer backend readiness from `did-stop-loading`. Preserve
DevTools, annotations, screenshot size limits, clipboard activation checks,
back/forward, refresh, and open-link-in-new-tab behavior.

## Tests and completion

Run focused main/IPC/partition/manager/auth tests plus isolated Electron tests.
Use two windows on different backends and two services on one backend. Verify
no localStorage/cookie/worker cross-service leakage, no credential borrowing,
and correct cleanup after connection switch or renderer crash.

Hide/unmount the view while HMR progresses, then reattach and verify state.
Recreate the container, rotate access, and reuse the old host port for a decoy.
Test native HTTP and WS credential injection explicitly. Check zoom, overlays,
history, annotations, screenshots, DevTools, and clipboard in a real window.
Exit with stable resource counts across repeated open/hide/close/reconnect cycles
and with no server process tied to React unmount.
