# 11 — Enable external browser, web, and iOS clients

Status: Partly implemented (`b608828c`): top-level only; embedded modes unadvertised. Depends on: 09–10. Unlocks: cross-client completion.

## Outcome and owners

Replace the current all-or-nothing desktop-only restriction with negotiated
support. Ship top-level external previews first, then embed only modes that
pass actual browser privacy/framing tests.

Inspect [gateway support checks](../../../../apps/web/src/lib/gateway-url.ts),
[BrowserTab](../../../../apps/web/src/components/browser/BrowserTab.tsx),
[native API](../../../../apps/web/src/lib/native/browser-preview.ts),
[external opening](../../../../apps/desktop/electron/browser-preview-main-adapters.ts),
[iOS RemoteWebView](../../../../apps/ios/OrkestratorMobile/Views/RemoteWebView.swift),
and [iOS tests](../../../../apps/ios/OrkestratorMobileTests/OrkestratorMobileTests.swift).

## Top-level external preview

1. “Open externally” requests an attachment for the selected service, resolves
   its publication capability, and obtains the short-lived trusted handoff.
2. Trigger a user-gesture-associated browser/tab opening so popup blockers do
   not silently lose the action. Use the step-01 proven POST/handoff mechanism;
   `shell.openExternal` with a raw backend localhost URL is insufficient.
3. Complete bootstrap at the trusted origin and navigate to the clean app URL.
   Disconnect the opener where appropriate; do not give the app an authenticated
   message bridge back to the control page.
4. Handle expired/replayed grants, missing tailnet connectivity, and failed
   publication with actionable errors. Retrying bootstrap obtains fresh access,
   never resubmits an application form automatically.
5. Give external-browser access an explicit lease independent of the original
   React tab. Closing the source tab does not immediately kill a user-opened
   external preview; revocation/service stop still does.

“Copy preview link” copies a clean private service URL, not a bootstrap grant.
Explain whether another client must sign in and join the tailnet. Link copying
does not grant another user access or create a public share.

## Embedded web preview

Choose the surface from backend publication capability plus client support, not
just the presence/absence of Electron APIs. A remote preview origin must differ
from the privileged control origin before restoring ordinary origin behavior.
Retain a deliberately minimal iframe sandbox and permission policy, tested
against supported app workflows. Do not globally drop sandboxing or override
the application's framing policy.

If the app forbids framing, third-party cookies are unavailable, or bootstrap
cannot establish a usable embedded session, offer the top-level path. Detection
must not be a vague indefinite spinner. Browser iframe `load` does not prove
successful application readiness; use trusted backend status and carefully
scoped bootstrap completion signals. Do not require injecting privileged
JavaScript into arbitrary application pages to monitor them.

Any cross-window message protocol validates exact origin, source window,
one-use nonce, schema, and size. It carries readiness/attachment acknowledgments,
not reusable credentials into app context. App content must not be able to
spoof backend-ready or request privileged actions.

Treat partitions/third-party-cookie APIs as optional capabilities supported by
evidence. They do not guarantee that an application's own OAuth/cookie behavior
works embedded. Do not advertise annotations/native DevTools in browsers unless
a separate safe implementation exists; report per-surface capabilities honestly.

## iOS/WKWebView

Read current WebKit documentation when implementing native changes. Keep the
existing control WebView's nonpersistent store and privileged message handlers
separate from preview content. Never load a preview into a view that exposes
the control connection bridge to that page.

First support the proven external/top-level flow. If adding an in-app native
preview view, use a dedicated data store/session policy, no control scripts,
restricted navigation delegates, and appropriate lifetime ownership. App
backgrounding can suspend client activity; leases/reconnect must tolerate this
without pretending the remote server stopped. Rehydrate on foreground entry.

Define link opening, download/file selection, back navigation, and handoff
behavior on iPhone and iPad. Do not expand unrelated native functionality just
to match every desktop control in this step.

## Tests and completion

Run actual Chromium, Firefox, Safari, and supported WKWebView versions; desktop
WebKit emulation alone is not iOS evidence. Cover hosted-client and backend-served
client origins, top-level and iframe modes, normal/private browsing, blocked
third-party cookies, denied popups, framed CSP denial, OAuth redirect flows,
and certificate/tailnet failure.

Test malicious postMessage, opener access, grant leakage into history/referrer,
worker interception, cross-service cookies, and request auth separation. Switch
environment, reload the client, background/foreground iOS, expire/rotate access,
and ensure the supported fallback remains usable.

Exit with a versioned support matrix. Advertise only passing modes; leave the
existing unsupported notice, updated with useful fallback actions, for the rest.
No promise of universal embedded-web compatibility is required to ship a working
top-level browser preview.

## Implementation record (2026-09-23)

Desktop **Open in browser** uses a one-use loopback POST handoff. The web client opens the
preview top-level with a form POST. iOS receives a one-use, host-bound session URL. Embedded
(iframe) modes are not advertised. Top-level bootstrap passes in Chromium. **Not run:** Firefox,
Safari, WKWebView, and iOS devices. See [evidence](evidence.md).
