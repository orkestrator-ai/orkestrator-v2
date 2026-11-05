# Check the iOS app's security behaviour on real hardware and a signed build

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **Run the suite through Xcode's own scheme**: `mise run test:ios` could not start on the review's Mac. Status: open.
2. **Repeat the WebKit checks against a real gateway on a device**: the review's probes used a simulator and a stand-in scheme. Status: open.
3. **Check Keychain behaviour on a device**: lock, restart, backup and reinstall. Status: open.
4. **Check Password AutoFill on the token field**: whether iOS offers to save the gateway token. Status: open.
5. **Inspect a signed release build**: entitlements and debugging flags of what actually ships. Status: open.

### 1. Run the suite through Xcode's own scheme

**Problem.** The tests passed through a stand-in, not through the project's scheme, so its build settings and its hosted test run are unproven.

**Context.** `scripts/test-ios.ts` runs `xcodebuild test` on the project. On 2026-11-05 on a Mac with Xcode 26.6 (SDK iOS 26.5) and simulator runtimes 17.5, 18.2 and 26.2, `xcodebuild` found no eligible destination ("iOS 26.5 is not installed"), and a target build failed at the asset catalog for the same reason.

**Investigation.** The review compiled the app's sources and tests with `swiftc` against the simulator SDK, skipping the asset catalog, and ran them in a throwaway ad-hoc-signed host app with `simctl`. All 66 tests in `OrkestratorMobileTests` passed on iOS 17.5, 18.2 and 26.2. That includes the Keychain tests and those that drive a real `WKWebView`, and it is the first time the H1 sign-in change ([2960](2960-host-prefixed-gateway-cookie.md) task 2) has been compiled. The stand-in is not in the repository.

**Decisions.**

- **How to close this?**
  - **Install the simulator platform matching the Xcode in use, then run `mise run test:logged -- --name ios-tests -- mise run test:ios` (recommended).**
    - Pros: the documented path; proves the project's real settings and the asset catalog.
    - Cons: a multi-gigabyte download and a system change on that Mac, which is why the review did not do it.
  - **Commit the `swiftc` stand-in as a fallback runner.**
    - Pros: runs without the matching platform.
    - Cons: a second way to build the app, which would drift from the project file.

### 2. Repeat the WebKit checks against a real gateway on a device

**Problem.** What the review saw in WebKit was on simulators with a stand-in `WKURLSchemeHandler` scheme. The real path is TLS to a gateway, through Tailscale, on hardware.

**Context.** The sign-in is `RemoteWebView.Coordinator.loginCookie`, and the navigation and bridge rules are `navigationDisposition` and `isTrustedBridgeOrigin` in `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`. [Todo 0042](../previews-and-annotations/0042-service-preview-rollout.md) task 3 needs the iOS service-preview handoff on the same hardware.

**Investigation.** Seen with a throwaway probe on the iOS 18.2 simulator on 2026-11-05: a CSP-sandboxed main frame reports an empty origin (the bridge refuses it now that its crash is fixed); subframes are refused; a cross-origin iframe setting `top.location` gets a `SecurityError`, with or without `sandbox`; `window.open` without a gesture never reaches the app. A main-frame `location.href` to another origin with no gesture does reach the navigation policy, which opens it in Safari; only script at the gateway's own origin can do that. A committed test pins, on all three runtimes, that the session cookie keeps `HttpOnly`, `Secure` and `SameSite=Strict` in `WKHTTPCookieStore` under both names and stays out of `document.cookie`. Not seen: the cookie actually being sent on real requests, a real legacy preview opened at the top level, or a real preview iframe. The real `check()` refusing a redirect was seen on the simulator against a local server, over HTTP.

**Decisions.**

- **What counts as done?**
  - **One device run against an isolated `dev:test` profile behind Tailscale Serve: sign in, open a legacy preview at the top level and call the bridge from it, open a service preview, and tap an external link (recommended).**
    - Pros: covers the whole real path; can share a run with 0042 task 3.
    - Cons: needs an iPhone, a signed development build and a tailnet.
  - **Accept the simulator evidence.**
    - Pros: no hardware.
    - Cons: real TLS, cookie sending and device WebKit stay unproven.

### 3. Check Keychain behaviour on a device

**Problem.** `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` promises the token is unreadable while locked and never leaves the device. A simulator cannot show either.

**Context.** `apps/ios/OrkestratorMobile/Security/KeychainCredentialStore.swift:44`. The editor's security note and `apps/ios/README.md` both repeat the promise.

**Investigation.** The accessibility class and the absence of `kSecAttrSynchronizable` were read from the code on 2026-11-05. The item also outlives an uninstall, which is ordinary iOS behaviour and is not mentioned to users.

**Decisions.**

- **How to check?**
  - **On a device: launch while locked, restart, restore an encrypted backup to confirm the vault does not return, and reinstall to see what remains (recommended).**
    - Pros: tests the promises as written; also tests [5602](5602-ios-session-and-privacy-hardening.md) task 3.
    - Cons: needs a spare device, because a restore is destructive.
  - **Rely on Apple's documentation of the accessibility class.**
    - Pros: no hardware.
    - Cons: leaves the reinstall behaviour and the app's own handling unobserved.

### 4. Check Password AutoFill on the token field

**Problem.** The token's `SecureField` uses `.textContentType(.password)`. If iOS offers to save it, the token could enter iCloud Keychain, against what the app tells the user.

**Context.** `apps/ios/OrkestratorMobile/Views/ConnectionEditorView.swift`. The app has no associated domains, which normally stops the save prompt, but that was not observed.

**Investigation.** Read from the code only; the prompt depends on device settings.

**Decisions.**

- **What should the field declare?**
  - **Check on a device, and remove the content type if a save prompt appears (recommended).**
    - Pros: changes behaviour only on evidence; keeps paste and AutoFill for users who rely on them.
    - Cons: needs a device.
  - **Remove it now.**
    - Pros: no prompt can appear.
    - Cons: may take away AutoFill from users who keep the token in a password manager, with no evidence of a problem.

### 5. Inspect a signed release build

**Problem.** The source shows no entitlements, URL schemes or inspector flag, but what ships is the archive.

**Context.** `apps/ios/OrkestratorMobile/Info.plist` has `NSAllowsArbitraryLoads` set to false and no URL types; the project has no entitlements file and no packages. `isInspectable` is never set. Building an archive needs the signing identity, which this work was not allowed to use.

**Investigation.** Source and project file read on 2026-11-05. No build was signed or archived.

**Decisions.**

- **How to inspect it?**
  - **Run `codesign -d --entitlements -` and read `Info.plist` on the next release archive (recommended).**
    - Pros: a few minutes; checks `get-task-allow` is false and no entitlement was added at signing.
    - Cons: waits for a maintainer with the signing identity.
  - **Trust the project settings.**
    - Pros: no work.
    - Cons: signing and distribution can change entitlements.

## Current state

The unit suite passes on three simulator runtimes through a stand-in build. Nothing has run on a device or from a signed build.

## Constraints and rationale

- Use an isolated `dev:test` profile for the gateway side, never a production instance.
- Screenshots and notes from these runs must not contain the gateway token.

## Related

- [5600-ios-bridge-user-consent.md](5600-ios-bridge-user-consent.md)
- [5602-ios-session-and-privacy-hardening.md](5602-ios-session-and-privacy-hardening.md)
- [2960-host-prefixed-gateway-cookie.md](2960-host-prefixed-gateway-cookie.md)
- [Todo 0042](../previews-and-annotations/0042-service-preview-rollout.md), task 3

## Replaces

Part of the iOS review, security report part `0270` (batch S-0270), whose chosen method left device checks for what the code review flagged. Its file was deleted when the review was done; it is in the history, ending with the outcome table, at the commit before the deletion.
