# Review the iOS app

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Do the review the report left out**: `apps/ios` was outside its scope. Status: open.

### 1. Do the review the report left out

**Problem.** The app holds the gateway token and shows the whole web client, and has never had a security review.

**Context.** The H1 fix changed the app's sign-in (`RemoteWebView.Coordinator.loginCookie`), written on Linux and not compiled there ([todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md) task 2).

**Investigation.** This was a search, not a review. Credentials go to the Keychain (`apps/ios/OrkestratorMobile/Security/KeychainCredentialStore.swift:44`). No `NSAllowsArbitraryLoads` turned up. The places to start from are the navigation policy and scripts in `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift` (`:71-78`, `:347`, `:424`, `:451`, `:663-680`).

**Decisions.**

- **How to review it?**
  - **A code review first, with device checks only for what it flags (recommended).**
    - Pros: does not need hardware to begin; can follow the report's method and format.
    - Cons: cannot prove runtime behaviour such as cookie handling in `WKWebView`.
  - **Wait for a Mac and a device, and do both at once.**
    - Pros: complete in one pass.
    - Cons: blocked on hardware, as todo 0042's Safari and iOS task is.

## Related

- [Security report, §8](../2-26-10-27-security.md#8-not-covered--follow-up)
- [Todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), task 3

## Outcome

Checked item by item on 2026-11-05 against base commit `69a3b4ca5`. Every line reference in the file still held at that commit. Tests: all 66 in `OrkestratorMobileTests` passed on the iOS 17.5, 18.2 and 26.2 simulators, built with `swiftc` and run in a throwaway ad-hoc-signed host app, because `xcodebuild` found no destination without the iOS 26.5 simulator platform.

| Item in this file | Outcome | Evidence |
| --- | --- | --- |
| Task 1: do the review the report left out | Done, with the remainder carried to to-dos | Code review of every Swift file in `apps/ios`, plus simulator runs. Three defects fixed (the three rows below); what is left is in to-dos 5600, 5601 and 5602. |
| Finding: a CSP-sandboxed main-frame page crashes the app through the bridge | Fixed and tested | The page reports an empty origin, and `isTrustedBridgeOrigin` assigned it to `URLComponents`, which raises. Crash report on iOS 18.2; `testBridgeRefusesTheEmptyOriginOfASandboxedDocumentWithoutCrashing` fails without the guard. |
| Finding: the status check accepts an answer from a redirect target | Fixed and tested | `GatewayRedirectBlocker` in `check()`; `testCheckDoesNotAcceptAnAnswerFromARedirectTarget`. The real `check()` against a local redirecting server now answers HTTP 302 and the target receives nothing. The gateway never redirects this route (`apps/backend/src/gateway-auth.ts:360`, `:478`). |
| Finding: sign-in refuses a token containing `+` | Fixed and tested | `loginFormBody`; `testLoginExchangeEscapesEveryFormReservedCharacterInTheToken`. The gateway reads the form with `URLSearchParams`, where a bare `+` is a space. |
| Suspected: the bearer token follows a redirect to another origin | Does not hold | Probe on macOS and on iOS 17.5 and 26.2: `URLSession` dropped `Authorization` on cross-origin redirects, and on the iOS runtimes on a same-origin one too. |
| Finding: a page can add, switch and forget saved servers with no prompt | Carried to to-do 5600 task 1 | Needs a decision and native UI. No token can be read back or steered to another server. |
| Finding: a token typed into the mobile sidebar passes through the current server's page | Carried to to-do 5600 task 2 | `ServerConnectionSwitcher.tsx`. The README's claim is corrected. |
| Findings: session outlives `forget`, app switcher snapshot, failed Keychain read can overwrite the vault | Carried to to-do 5602 | Read from the code; low impact, and each has a design choice. |
| Context: H1 changed `loginCookie`, written on Linux and never compiled | Done; recording a release stays open | Compiled and run; both cookie names pass. To-do 2960 task 2 updated. |
| Investigation: credentials go to the Keychain (`KeychainCredentialStore.swift:44`) | Holds | `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, no `kSecAttrSynchronizable`. Device behaviour is in to-do 5601 task 3. |
| Investigation: no `NSAllowsArbitraryLoads` turned up | Corrected, same conclusion | The key exists and is `false` (`Info.plist:27-28`), with no exception domains. No URL schemes, entitlements file or packages; no logging, `UserDefaults` or pasteboard use; `isInspectable` never set. |
| Investigation: navigation policy (`RemoteWebView.swift:424`, `:451`) | Reviewed, no defect | Tested policy; the web store is non-persistent. On the iOS 18.2 simulator a cross-origin iframe setting `top.location` got `SecurityError` and `window.open` without a gesture never reached the app. A main-frame script at the gateway origin can open Safari with no gesture; recorded in to-do 5601 task 2. |
| Investigation: scripts (`RemoteWebView.swift:71-78`, `:347`, `:663-680`) | Reviewed, no defect beyond the crash above | Injected values and bridge replies go through JSON encoding; replies carry no token. Subframes and sandboxed frames are refused at native on the iOS 18.2 simulator. |
| Decision: code review first, device checks only for what it flags | Taken as recommended | Simulator runs were added because the tools were there. Device checks are in to-do 5601. |
| Con of that decision: cannot prove runtime cookie handling in `WKWebView` | Partly settled | `testSessionCookieKeepsItsProtectionsInTheWebViewStore` on three simulator runtimes. Cookies on real requests over real TLS are in to-do 5601 task 2. |
| Device, App Store or signed-build work | Not implemented, carried to to-do 5601 | Nothing was signed, notarised, uploaded or published, and no signing certificate was used. |
| Related: to-do 0042 task 3 | Unchanged, still open | Its iOS handoff needs the same hardware; to-do 5601 task 2 points at it. |
