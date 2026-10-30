# Embedded service previews

Checked against `main` at `2459b05c` (2026-10-15); task 1 decided against
`cd7bbe3e` (2026-10-30).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; rechecked 2026-10-30 against
`main` at `cd7bbe3e`.

### Tasks

1. **Go or no-go on embedding**: answer the three open questions (worth it at
   all, per-platform or uniform, iOS or web first) before any code. Status:
   done 2026-10-30. Decided to defer until top-level Safari and iOS pass
   ([0042](0042-service-preview-rollout.md) task 3, still blocked). If built:
   per-platform, web first. See "Assumptions and decisions".
2. **Web iframe surface**: code item 1 plus the CHIPS investigation (item 2).
   Status: deferred (not started; on 0042 task 3 per task 1, and then on the
   framed-entry decision below).
3. **iOS in-app preview view**: code item 3, a dedicated `WKWebView`. Status:
   deferred (not started; on 0042 task 3 per task 1, and second after task
   2).
4. **Per-surface capabilities and advertisement**: code items 4 and 5, report
   capabilities per surface and lift the refusal per passing platform. Status:
   blocked (on tasks 2, 3 and 5).
5. **Embedded privacy qualification**: the real-browser and real-device matrix.
   Status: blocked (on tasks 2 and 3; needs Safari, Firefox, iPhone and iPad).

### 1. Go or no-go on embedding

**Problem.** Web and iOS users can open a preview only in a separate tab or in
Safari. Nobody has decided whether an embedded preview is worth its privacy,
cookie and test cost, so the file sits open with no owner.

**Context.** The plan always called embedding optional. The top-level path is
the supported fallback and is itself still being qualified on Safari and iOS
in [0042](0042-service-preview-rollout.md). Third-party-cookie blocking can
break an embedded tailnet origin even with correct TLS and CORS.

**Investigation.** Nothing has started. The contract already carries the
surface: `"browser-embedded"` in `PREVIEW_SURFACES`
(`packages/protocol/src/preview-access.ts:21`) and
`surfaces.browserEmbedded` with `platforms`
(`packages/protocol/src/preview-services.ts:352`). The backend hard-codes it off
with the documented reason (`apps/backend/src/core/preview-runtime.ts:326-331`)
and refuses the surface (`apps/backend/src/core/preview-access.ts:179-184`).
Settings shows the reason (`apps/web/src/components/settings/PreviewSettings.tsx:237`).
The file's description is still accurate.

Rechecked 2026-10-30 at `cd7bbe3e`. Nothing in the 125 commits since
`863b5782` touches the embedded surface. 0042 task 3 (shipping Safari and the
iOS handoff, top-level) is still blocked on hardware, with no Safari or iOS
evidence-log entry, so the condition for revisiting has not been met. Since
the analysis, code on `main` also shows that the backend refuses framing on
purpose. The cross-service read defense
(`crossServiceReadViolation`, `packages/protocol/src/preview-header-policy.ts:290-303`,
applied at `apps/backend/src/preview-publication.ts:462`) refuses every
cookie-authenticated `GET` whose `Sec-Fetch-Site` is not `same-origin` or
`none`, unless it is a top-level document navigation. A preview iframe in the
web client sends `Sec-Fetch-Dest: iframe` with `cross-site` or `same-site`, so
it gets `403`. `apps/backend/src/preview-publication.test.ts:276` pins this.
The bootstrap and session responses also carry `X-Frame-Options: DENY` and
`frame-ancestors 'none'` (`preview-publication.ts:50-56`). The preview cookie
is `SameSite=Lax` (`preview-publication.ts:528`), and 0042's 2026-10-23
evidence records Firefox and WebKit omitting it on a framed cross-site entry.
So the web iframe now needs a backend policy change as well as client work
(see task 2).

**Decisions.**

- **Build embedded previews at all?**
  - **Defer until top-level Safari and iOS pass in 0042 (recommended).** Keep
    the file, revisit once the top-level matrix exists.
    - Pros: no work on an optional path while the default path is unproved; the
      0042 runs will show how often top-level handoff actually hurts.
    - Cons: the file stays open indefinitely; web users keep switching tabs.
  - **Build now.**
    - Pros: a single-window experience on web and iOS.
    - Cons: large security surface (sandbox, `postMessage`, cookies) for a
      feature that may only pass on Chromium.
  - **Retire the file and drop the contract fields.**
    - Pros: removes dead capability plumbing and an unowned todo.
    - Cons: reintroducing the surface later means a protocol change; loses the
      recorded constraints.
- **If built, per-platform or uniform?**
  - **Per-platform, advertised on evidence (recommended).** `platforms` already
    exists for this.
    - Pros: Chromium users benefit even if Safari never passes; matches the
      contract shape.
    - Cons: behaviour differs by browser, which support has to explain.
  - **Uniform: embed only if every platform passes.**
    - Pros: one behaviour everywhere.
    - Cons: Safari's cookie policy likely blocks it forever, so nobody gets it.
- **Which surface first?**
  - **Web iframe first (recommended).**
    - Pros: testable with the existing Playwright stack on Linux; benefits
      every hosted and gateway web client.
    - Cons: harder cookie story (third-party context).
  - **iOS `WKWebView` first.**
    - Pros: first-party data store, no third-party-cookie problem.
    - Cons: needs real devices for every run; no Swift preview code exists yet.

### 2. Web iframe surface

**Problem.** There is no preview-origin iframe; the iframes that exist are not
a preview surface.

**Context.** Code items 1 and 2. The surface must be chosen from the backend
capability, honour app CSP and framing, detect framing denial and fall back,
and use a strict `postMessage` protocol. CHIPS can at best help the
`__Host-orkestrator-preview` transport cookie, never the app's own cookies.

**Investigation.** `ServiceBrowserTab` picks its mode at
`apps/web/src/components/browser/ServiceBrowserTab.tsx:258-265`, and today the
branch keys on `nativeBrowserPreview` (Electron presence); an embedded mode
must not follow that pattern. The existing iframes (`ServiceBrowserTab.tsx:907`,
`apps/web/src/components/browser/BrowserTab.tsx:795`) serve loopback and the
legacy route. `isGatewayBrowserPreviewSupported`
(`apps/web/src/lib/gateway-url.ts:62`) still limits gateway-routed previews to
desktop. Top-level opening is `openServiceExternally` and
`submitPreviewBootstrap` (`apps/web/src/lib/preview-external.ts:15`, `:52`). No
`Partitioned` cookie attribute is set anywhere in the backend (rechecked
2026-10-30).

Since the cross-service read defense landed (0054, on `main` by 2026-10-23),
the gateway refuses any framed preview navigation from another site or
service before it is forwarded (`preview-header-policy.ts:290-303`; test
`preview-publication.test.ts:276`). The bootstrap and session pages are
`frame-ancestors 'none'`. For a `GET` navigation the browser sends no `Origin`,
and `Sec-Fetch-Site` reads `same-site` or `cross-site` for both the control
client and a sibling service. The gateway therefore cannot tell from the
headers whether the frame's parent is Orkestrator or another published
service. A `Partitioned` cookie alone does not get a framed entry past this
rule.

**Decisions.**

- **How does a framed entry get past the cross-service read defense?**
  - **A one-use, attachment-scoped frame-entry grant (recommended).** The
    control client mints a grant per frame load. The gateway admits exactly
    one `Sec-Fetch-Dest: iframe` navigation that carries it, and adds
    `frame-ancestors` naming the control origin to that response only.
    Every other framed request keeps the 403.
    - Pros: siblings still cannot frame a service with the user's cookie, so
      the 0054 guarantee holds; it reuses the bootstrap grant machinery.
    - Cons: every reload of the frame needs a new grant. A framed cross-site
      return, such as OAuth back into the frame, stays refused and must fall
      back to top-level.
  - **Admit `iframe` destinations for sessions minted on the embedded
    surface.**
    - Pros: simple; reloads just work.
    - Cons: any sibling service can then frame that service with the user's
      session. This reopens the cross-service read hole 0054 closed.

- **How does the embedded session get its transport cookie?**
  - **Bootstrap inside the iframe with a `Partitioned` transport cookie, fall
    back to top-level on failure (recommended).**
    - Pros: works in Chromium's third-party mode; failure is detectable and has
      a known fallback.
    - Cons: Safari ignores CHIPS, so Safari likely never qualifies.
  - **Storage Access API prompt.**
    - Pros: supported in Safari and Firefox.
    - Cons: needs a user gesture per origin; awkward UX; still no help for app
      login cookies.
- **How is readiness signalled?**
  - **Backend status plus a one-use nonce acknowledgement from the bootstrap
    page (recommended).**
    - Pros: app content cannot spoof it; matches the file's constraint.
    - Cons: needs a new message schema and tests.
  - **Iframe `load` event.**
    - Pros: trivial.
    - Cons: explicitly ruled out by the file; does not prove the app is ready.

### 3. iOS in-app preview view

**Problem.** iOS hands every preview to Safari, leaving the app.

**Context.** Code item 3: a dedicated `WKWebView` with its own data store, no
scripts or handlers, restricted navigation, lease handling across background
and foreground. Never load a preview into the control WebView.

**Investigation.** The control view uses `.nonPersistent()`
(`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift:16`) and opens
cross-origin navigations externally (`RemoteWebView.swift:464`, `:555`). The
isolation contract is pinned by `tests/unit/ios-mobile-contracts.test.ts:262`.
There is no Swift preview view.

**Decisions.**

- **Which data store should the preview view use?**
  - **A separate persistent store per backend (recommended).**
    - Pros: app logins survive between opens; still separate from the control
      view's non-persistent store.
    - Cons: needs explicit clearing on sign-out or environment removal.
  - **Non-persistent per open.**
    - Pros: nothing left behind.
    - Cons: every open logs the user out of the previewed app.
- **Use `SFSafariViewController` instead of a custom `WKWebView`?**
  - **Custom `WKWebView` (recommended, as the file plans).**
    - Pros: lease and reconnect control; defined back and download behaviour.
    - Cons: more Swift code and device testing.
  - **`SFSafariViewController`.**
    - Pros: Safari's cookies and privacy for free; little code.
    - Cons: no lease or rehydration hooks; behaves like the current handoff.

### 4. Per-surface capabilities and advertisement

**Problem.** Capture and DevTools must not appear on browser surfaces, and the
embedded flag must flip only per qualified platform.

**Context.** Code items 4 and 5; non-desktop capture is deferred in
[0047](0047-web-annotation-extensions.md).

**Investigation.** Capture is already hidden off desktop through `canCapture`
(`apps/web/src/components/browser/annotations/AnnotationPanel.tsx:70`). The
refusal to lift is `preview-access.ts:183`; the flag to set is
`preview-runtime.ts:326`. A fixture copy lives in
`packages/protocol/src/testing/preview-contract-fixtures.ts:110`.

**Decisions.**

- **Where does the platform list come from?**
  - **A static, versioned table in the backend updated with evidence
    (recommended).**
    - Pros: reviewable; matches "advertise only on evidence".
    - Cons: the client must report its platform, which is self-declared.
  - **Runtime feature detection in the client.**
    - Pros: adapts to new browser versions.
    - Cons: detection cannot prove privacy properties; contradicts the rule.

### 5. Embedded privacy qualification

**Problem.** No embedded surface may be advertised without real-browser
privacy evidence.

**Context.** The Qualification list: Chromium, Firefox, Safari, real iPhone and
iPad, hosted and backend-served origins, private browsing, blocked cookies,
malicious `postMessage`, lifecycle. Results go in 0042's evidence log.

**Investigation.** Nothing to run until tasks 2 and 3 exist. The browser
preview suites (`mise run test:preview:browser`) cover top-level origins and
are the natural place for the Chromium and Firefox cases.

**Decisions.**

- **Where should the automated part live?**
  - **Extend the preview browser suite with an embedded project (recommended).**
    - Pros: reuses fixtures and origins; runs on Linux CI for Chromium and
      Firefox.
    - Cons: Safari and iOS still need manual runs batched in 0031.
  - **A separate embedded-only suite.**
    - Pros: isolates a flaky new surface.
    - Cons: duplicates origin and fixture setup.

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
- The publication gateway refuses framed preview navigations from any other
  site or service (`crossServiceReadViolation` in
  `packages/protocol/src/preview-header-policy.ts`). Its bootstrap and session
  pages send `X-Frame-Options: DENY` and `frame-ancestors 'none'`
  (`apps/backend/src/preview-publication.ts`).
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

Answered 2026-10-30 in task 1 (see "Assumptions and decisions"): defer until
0042 task 3 passes; per-platform if built; web iframe first. Reopen them at
that point with the top-level Safari and iOS evidence in hand.

- Is embedding worth the cost, given that top-level previews work? It was
  always planned as optional.
- If only some browsers pass, is a per-platform embedded mode acceptable, or
  should the product stay top-level everywhere for consistency?
- Should the iOS in-app view come before or after the web iframe?

## Assumptions and decisions

### Task 1: defer embedding until top-level Safari and iOS pass

Chose the recommended **defer**. The recommendation's trigger is 0042 task 3
(shipping Safari and the iOS handoff, top-level), which is still blocked on
macOS Safari and iOS hardware at `cd7bbe3e`, with no entry in 0042's evidence
log. Current code supports deferring rather than contradicting it. The gateway
now refuses framed preview navigations on purpose
(`preview-header-policy.ts:290-303`, test `preview-publication.test.ts:276`).
Building the web iframe now would mean changing a freshly qualified security
rule for an optional surface whose fallback is still unproved on Safari and
iOS. Retiring the file was rejected: the protocol fields cost almost nothing,
and the constraints recorded here would be lost. No code was written.

### Task 1: per-platform if built

Chose the recommended **per-platform, advertised on evidence**. The contract
already carries `browserEmbedded.platforms`
(`packages/protocol/src/preview-services.ts:352`). The 2026-10-23 evidence also
shows engines diverging on framed cross-site entries (Chromium sends iframe
metadata and gets `403`; Firefox and WebKit drop the `Lax` cookie and get
`401`). A uniform rule would likely mean nobody ever gets the surface.

### Task 1: web iframe first if built

Chose the recommended **web iframe first**. It can be tested with the existing
Playwright preview stack (`playwright.preview.config.ts`, Chromium, Firefox
and WebKit projects). iOS needs a real device for every run, and no Swift
preview code exists. This Mac's simulator did not respond on 2026-10-30
(`xcrun simctl list devices booted` timed out after 20 s), so iOS work could
not be started here in any case.

### Task 2: add the framed-entry decision

Added a decision to task 2 because its earlier recommendation (bootstrap in
the frame with a `Partitioned` transport cookie) no longer works alone: the
cross-service read defense refuses the framed navigation before cookies come
into it. Recommended a one-use, attachment-scoped frame-entry grant so that
siblings still cannot frame each other. Not implemented, since task 1
defers.

### File accuracy

Updated the line citations that moved since 2026-10-27
(`preview-access.ts:179-184`, `ServiceBrowserTab.tsx:907`,
`BrowserTab.tsx:795`). Rechecked that no backend code sets `Partitioned`.
Every other citation in the Task analysis and Current state still matches
`cd7bbe3e`. No follow-up todo was created: the new finding belongs in task 2,
and the revisit trigger is already tracked as 0042 task 3.

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
