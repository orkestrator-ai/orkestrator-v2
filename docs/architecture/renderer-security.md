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
- **`frame-ancestors` is `'self'`, not `'none'`.** A browser client's realm iframe
  embeds the same gateway origin.
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
