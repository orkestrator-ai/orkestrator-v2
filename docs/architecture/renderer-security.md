# Renderer security

Status: Living.

The renderer shows attacker-influenced Markdown, Mermaid, SVG and transcripts,
and script running in it reaches the host through `window.orkestrator`. Three
layers sit behind the sanitisers: a Content Security Policy, an OS sandbox and a
default-deny permission policy. Each one must hold on its own.

## Content Security Policy

The text lives in `packages/protocol/src/renderer-content-security-policy.ts`.
`script-src 'self'` is the part that matters: no source in it may ever allow
inline script or eval.

| Surface | Delivery | Policy |
| --- | --- | --- |
| Electron `file://` renderer | `<meta>` written by `apps/web/vite-plugin-renderer-security.ts` | `RENDERER_CONTENT_SECURITY_POLICY` |
| Gateway-served renderer | The same `<meta>`, plus a header from `serveStatic` that adds `frame-ancestors 'self'` | `GATEWAY_RENDERER_CONTENT_SECURITY_POLICY` |
| Gateway login page | Header (`loginPageResponse`) | `GATEWAY_LOGIN_CONTENT_SECURITY_POLICY` |
| Design frame document | Its own `<meta>`, pinned to the script's hash, plus a `sandbox allow-scripts` header on the gateway | `designFrameDocument` |
| Static HTML frame document | The same form as the design frame document | `staticHtmlFrameDocument` |
| Renderer dev server | None | Vite's React preamble is an inline script |
| Hosted client | `apps/web-public/vercel.json` | Separate and stricter |

What to keep in mind when changing it:

- **A `<meta>` policy only reaches a production build.** Dev profiles and the
  `dev:test` browser suites never enforce it. To check a change, serve the
  output of `vite build`, or run `mise run test:package:security`, whose spec
  asserts the policy on the packaged `file://` renderer.
- **A document with both a `<meta>` and a header obeys both**, so widening the
  header alone changes nothing.
- **`frame-ancestors` is `'self'`, not `'none'`.** It was chosen for the
  browser client's workspace realms, same-origin iframes of the app that the
  renderer framed. Realms are deleted (plan item 6002), and no client frames
  the renderer document now; `'self'` still admits only the gateway's own
  origin, so no other site can embed it. Tightening it to `'none'` is a
  separate policy change, not made here. The design and static HTML frame
  documents keep `frame-ancestors 'self'` for their own reason: the renderer
  frames them.
- **A CSP source cannot name an IPv6 host.** Chromium reports `http://[::1]:*` as
  invalid and ignores it. A plain-HTTP `[::1]` backend is allowed by the desktop
  app, so `connect-src` opens the `http:` and `ws:` schemes. `https:` already lets
  a script that does run send data anywhere, so this adds no new channel.
- **Packaged file requests are confined to the real renderer web root.**
  `installRendererFilePolicy` runs on renderer sessions before load,
  resolves symlinks and refuses paths outside that root. CSP file-origin
  `self` alone is not a directory boundary.
- **Only `index.html` and the two frame documents get a policy.** Worker
  scripts have none, so the highlighter's Oniguruma WebAssembly needs no
  `'wasm-unsafe-eval'` in the document's `script-src`.

### Design frames

A `srcdoc` iframe inherits its parent's policy, including through
`sandbox="allow-scripts"`, so `script-src 'self'` refuses the design runtime's
inline bootstrap. A production build therefore emits the bootstrap as
`design-frame.html`, and `designFrameSource` loads that instead, resolving it
from the gateway root on nested SPA routes and beside the packaged index. A file cannot
carry a fresh nonce, so its policy pins the script's SHA-256; authored code still
cannot execute. A dev server and the hosted client keep the nonce-bearing `srcdoc`.

### Static HTML frames

The transcript's static document presentation loads the same way
(`static-html-frame.html`, `staticHtmlFrameSource`), and adds `media-src 'none'`.
A file has no per-mount nonce to carry, so the host appends one as the URL
fragment; no server sees it, and it confers no authority beyond matching the
frame's `ready` to this mount. The frame is always opaque, so the host checks the
sender window and that identity rather than `event.origin`. Adding another frame
document means updating `vite-plugin-renderer-security.ts`,
`staticDocumentContentSecurityPolicy` in `gateway-proxy.ts` and the probes in
`packaged-security-electron.spec.ts`. The hosted client emits no frame documents
and its policy refuses a `srcdoc` bootstrap, so its build declares the static view
unavailable (`staticHtmlPresentationSupported`) and shows saved previews.

## OS sandbox

Every window and view with a preload runs `sandbox: true`: the main window
and the two toolchain bootstrap windows.

Sandboxed Chromium evaluates a preload as a CommonJS function body. Since
Electron 45 its `require` loads only `electron`, and `Buffer`, `setImmediate` and
`clearImmediate` are not in scope. `bundleElectron` therefore builds preloads
separately from the ESM main process, with `format: "cjs"` and everything but
`electron` inlined. `electron-bundle.test.ts` fails if a preload gains another
import or one of those globals, so a new dependency in `preload-api.ts` must work
in a browser context.

## Permissions

`installRendererPermissionPolicy` replaces Electron's default handlers, which
grant everything, on renderer sessions. It runs before the document
loads. Only the renderer's own main frame gets anything, and only:

- `clipboard-sanitized-write`, for `navigator.clipboard.writeText`
- `fullscreen`, for the `<video controls>` button
- `notifications`, for the desktop notification raised when an agent asks a
  question (the user's setting decides whether one is shown)

Clipboard reads and images go through IPC. A refused permission fails silently in
the page, so the first refusal of each kind on a session logs
`desktop.permissions denied` with the permission's name. Look there first when a
browser feature stops working in the desktop app. Previews and the artifact host
have their own, stricter handlers.

## webRequest listeners

Main installs its network policy as session `webRequest` listeners: the
renderer's file boundary (`renderer-file-policy.ts`), the gateway credential
hooks (`remote-gateway-request-auth.ts`), the artifact host's admission policy
and redirect observer (`artifact-host-session.ts`) and the service-preview
partition hooks (`preview-transport-manager.ts`). Electron keeps one listener
per event per session, and a session outlives its window, so a listener can run
after whatever it looks up for that window is gone: a destroyed
`WebContents`'s getters throw, as can an option callback.

A listener that throws before it calls Electron's callback leaves the request
unanswered and gives main an uncaught exception. On 2026-10-21 that opened a
blocking error box that stopped main before a closed window released its
preview attachments (flake 0622). So every listener is installed through
`answering(name, decide, failClosed)` or, for an event with no callback,
`observing(name, observe, onFailure)` (`webrequest-listener.ts`):

- `decide` returns the response, or a promise of one. If it throws or rejects,
  the listener answers `failClosed(details)`; if that throws too, it cancels.
  The callback is called exactly once.
- Each listener chooses what failing closed means for it: the renderer file
  policy and the artifact host cancel; the gateway hook sends the request
  without any ambient credential; the preview header hook strips the ingress
  credential, and its request hook cancels a request whose local-network check
  could not run. A redirect observer that throws still makes the redirect fatal
  to the artifact host.
- A failure logs `desktop.webrequest listener.failed-closed` (or
  `observer.failed`, `callback.failed`), throttled, scoped by the listener's
  static name. The error's message is never logged: it may hold a URL or a
  credential.

The `raw-webrequest-listener` source guard
([linting.md](../development/linting.md#source-guards)) fails on a
`webRequest.on*(...)` call in `apps/desktop/electron` whose listener is not
wrapped in one of the two (or `null`, which removes a listener).

## Node scopes

One renderer per window shows every node the window works with: the command
node's workspace and any other node's, each on its own node scope in the
same React tree ([federation.md](federation.md#node-scopes-one-scope-per-node-in-the-windows-tree)).
The separate per-node documents of earlier releases (workspace realms: a
`WebContentsView` per node on the desktop, a same-origin iframe in a browser
or the iOS app) are deleted (plan items 6002 and 6003). What that changes:

| Property | Realms (earlier releases) | Node scopes |
| --- | --- | --- |
| Who can reach which node | A realm's `window.orkestrator` reached only its node, but its portal channel had unrestricted command-node invoke, which reaches every node | The renderer can name any node its command node knows; main (desktop) or the node's client (browser and iOS) routes the call |
| Credentials in the renderer | Desktop: none. Browser: each realm's grant in the tab's `sessionStorage` | Desktop: none; main holds every grant and attaches the bearer at the network layer per scope (`window-request-authorization.ts`). Browser and iOS: each grant in memory only, in the node-client registry's closures (`lib/node-scope/node-clients.ts`), never in storage or a URL |
| Process isolation | Desktop: a renderer per realm. Browser and iOS: none | None on any host |
| Storage isolation | Desktop: a partition per realm. Browser: namespaced keys | Namespaced keys everywhere (`nodeStorageKey`); the desktop realm partitions are removed at startup |
| Correctness isolation | Separate heaps | Per-node store instances reached only through a provider or a named scope (no store statics, plan item 3018), node-tagged events and the shrink-only source guards |

**The net change in authority is nil.** The window renderer already held
full command-node authority and showed the same untrusted transcripts, and
realms could already reach every node through their portal channel. Script
injected into the window can name a leaf directly now, but it could reach
the same leaf through the command node before. The boundary that matters is
server-side and stays:

- Workspace grants are bound to the controller that asked for them, last at
  most 15 minutes per issue or renewal, are kept as hashes in memory, are
  revoked with their controller, and revoking one closes the sockets it
  authorised (`apps/backend/src/core/nodes/client-grants.ts`).
- A grant or the relay admits only commands defined with
  `access: "workspace"`, failing closed (below).
- On the desktop main refuses machine administration for a leaf scope
  (`node-admin-refused`, `DesktopNodeIpc.adminScope`), keyed by the node id
  the renderer names.

What gets worse is failure isolation, not authority: one renderer means one
out-of-memory takes the whole window, which the window's tier budgets bound
([federation.md, Budgets](federation.md#budgets)).

## Decisions

- **Trusted Types: not adopted.** A report-only run over login, an environment,
  a terminal, the design canvas, Monaco and Mermaid flagged six sinks, including
  React's `innerHTML` setter, Radix and ProseMirror style injection, Mermaid's
  SVG and Monaco's worker construction. Enforcing it would need a default policy
  that passes those through, which adds little to `script-src 'self'`.
- **A local window's gateway credential stays in main.** On the direct transport
  ([remote-gateway.md](remote-gateway.md)) main adds the bearer at the network
  layer, for that backend's origin and its `invoke` and `events` routes only. This
  grants nothing `orkestrator:invoke` did not, and the page cannot read the token.
- **No allowlist on `orkestrator:invoke`.** The renderer is the application's main
  client and legitimately uses most of the registry, terminals included, so a
  second list per command would remove little of what injected script could do.
- **A leaf scope's commands are allow-listed by the leaf.** What a window sends
  to another machine through a workspace grant, or through the relay, runs only
  if its definition declares `access: "workspace"`; everything else is refused
  server-side, failing closed (plan item 7012,
  [command-nodes.md](command-nodes.md#security)). This bounds injected script in
  a leaf's node scope to that leaf's workspace: never its settings,
  credentials, host updates, node registry or link plumbing. The window's own
  backend still answers its renderer's full command set.
