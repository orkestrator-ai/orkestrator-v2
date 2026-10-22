# Embedded service previews

Checked against `main` at `2459b05c` (2026-10-15).

Today the web and iOS clients can open a service preview only top-level: a
separate browser tab, or Safari. The plan to embed a preview inside the hosted
or gateway-served web client (an iframe) or inside the iOS app (a dedicated
`WKWebView`) was never started. The capability is already in the contract and
is reported as unavailable. Embedding is optional. Do it only if it is worth
the cost, and advertise it per platform only after that platform passes real
browser privacy tests.

## Current state

- `PreviewRuntime.capabilities` (`apps/backend/src/core/preview-runtime.ts`)
  hard-codes `browserEmbedded: { available: false, platforms: [] }`, with the
  reason "Embedded browser previews have not passed real-browser privacy
  tests". Settings → Previews shows that reason
  (`apps/web/src/components/settings/PreviewSettings.tsx`).
- `PreviewAccessService` (`apps/backend/src/core/preview-access.ts`) refuses
  `surface: "browser-embedded"` with `unsupported`.
- The types already exist: `"browser-embedded"` in `PREVIEW_SURFACES`
  (`packages/protocol/src/preview-access.ts`), and
  `PreviewCapabilities.surfaces.browserEmbedded` with a `platforms` list
  (`packages/protocol/src/preview-services.ts`).
- On the web client, `ServiceBrowserTab` chooses `"top-level"` when
  `browserTopLevel` is available and `"unsupported"` otherwise. It opens through
  `openServiceExternally` and `submitPreviewBootstrap`
  (`apps/web/src/lib/preview-external.ts`), using a pre-opened window and a
  form POST.
- The iframes in `BrowserTab` and the compatibility iframe in
  `ServiceBrowserTab` (sandbox `allow-forms allow-pointer-lock
  allow-presentation allow-scripts`) are for direct loopback and the legacy
  route. They are not a preview-origin surface. `isGatewayBrowserPreviewSupported`
  (`apps/web/src/lib/gateway-url.ts`) still limits gateway-routed previews to
  desktop.
- iOS has no Swift preview code. `RemoteWebView`
  (`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`) hands cross-origin
  main-frame navigations to Safari (`UIApplication.shared.open`). The handoff
  URL comes from `create_preview_handoff_url`, and the contract is pinned by
  "iOS preview isolation" in `tests/unit/ios-mobile-contracts.test.ts`.
- The annotation panel lists, replies to, requests and reviews on web and iOS,
  but capture is hidden there (`canCapture` in
  `apps/web/src/components/browser/annotations/AnnotationPanel.tsx`).

## Outstanding work

### Code

1. Web iframe surface.
   - Choose it from the backend capability plus client support, never from
     whether Electron APIs are present.
   - Use a minimal sandbox and permission policy, tested against the app
     workflows the surface claims to support.
   - Honour the application's CSP and framing headers. Do not override framing
     globally.
   - When framing is denied, third-party cookies are blocked, or bootstrap
     cannot establish an embedded session, detect it and offer the top-level
     path instead of an endless spinner.
   - Take readiness from trusted backend status and a scoped bootstrap
     completion signal. An iframe `load` event does not prove the application
     is ready.
   - Any `postMessage` protocol checks the exact origin, the source window, a
     one-use nonce, the schema and the size. It carries acknowledgements only,
     never credentials, and app content cannot spoof readiness or request
     privileged actions.
2. Investigate partitioned (CHIPS) cookies for the `__Host-orkestrator-preview`
   transport cookie only. They do not fix the application's own login cookies
   or OAuth flows when embedded.
3. Optional iOS in-app preview, as a dedicated `WKWebView`:
   - its own data store, with no control scripts and no message handlers;
   - restricted navigation delegates;
   - lease and reconnect handling across background and foreground, with
     rehydration on foreground entry;
   - defined behaviour for links, downloads, file pickers and back navigation
     on iPhone and iPad.

   Never load a preview into the control WebView.
4. Report capabilities per surface. Do not advertise annotation capture or
   native DevTools on browser surfaces unless a separate, safe implementation
   exists (see the non-desktop capture item in
   [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md)).
5. When a platform passes, add it to `browserEmbedded.platforms` and set
   `available`. Lift the `browser-embedded` refusal in `PreviewAccessService`
   only for advertised platforms.

### Qualification

- Real Chromium, Firefox and Safari, plus `WKWebView` on real iPhone and iPad
  devices. WebKit on Linux and desktop emulation are not iOS evidence.
- Both hosted and backend-served client origins.
- Normal and private browsing, third-party cookies blocked, popups denied, a
  framed-CSP denial, and OAuth redirect flows.
- Malicious `postMessage`, opener access, and grant leakage into history or
  `Referer`. Worker interception, cross-service cookies, and request-auth
  separation.
- Environment switch, client reload, iOS background and foreground, expiry and
  rotation of access. The top-level fallback must keep working in each case.
- Record results in the evidence log of
  [0042-service-preview-rollout.md](0042-service-preview-rollout.md), as a versioned
  support matrix per platform.

## Constraints and rationale

- The preview origin must differ from the privileged control origin before
  any ordinary origin behaviour is restored.
- Never add `allow-same-origin` to an iframe that shares the control origin.
- The top-level preview stays the supported fallback, and shipping it needs no
  promise of embedded compatibility.
- Privacy policy can block an embedded tailnet origin's cookies even when TLS
  and CORS are correct. Treat partition and third-party-cookie APIs as optional
  capabilities, advertised only on evidence.
- Keep the iOS control WebView's nonpersistent store and privileged handlers
  separate from preview content.
- The threat boundaries in
  [browser-previews.md](../../architecture/browser-previews.md) §"Security
  boundaries" apply unchanged: application code gets no control authority and
  no access to other services.

## Open questions

- Is embedding worth the cost, given that top-level previews work? It was
  always planned as optional.
- If only some browsers pass, is a per-platform embedded mode acceptable, or
  should the product stay top-level everywhere for consistency?
- Should the iOS in-app view come before or after the web iframe?

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (top-level Firefox,
  Safari and iOS runs, and the evidence log).
- [0047-web-annotation-extensions.md](0047-web-annotation-extensions.md) (non-desktop
  capture needs a trusted inspection path on the same surfaces).
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md)
  (Safari and iOS batching).
- [browser-previews.md](../../architecture/browser-previews.md) §"Private HTTPS
  origins" and §"Known limitations".

## Replaces

- `docs/improvements/browser/plan/11-web-external-and-ios-clients.md`
  (embedded web preview and iOS/WKWebView sections)
- `docs/improvements/browser/plan/01-architecture-and-fixtures.md` (hosted
  embedding and Safari/WKWebView prototype row)
- `docs/improvements/browser/plan/01-decision-record.md` (embedded modes stay
  unadvertised until real-browser privacy tests pass)
- `docs/improvements/browser/proposal.md` §3 (hosted-client embedding,
  partitioned cookies)
