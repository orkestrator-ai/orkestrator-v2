# Orkestrator for iOS

The iOS app is a SwiftUI shell around the responsive Orkestrator web interface served by the remote backend. It validates remote credentials natively, stores all saved connection profiles in iOS Keychain, signs the `WKWebView` in through the gateway's existing HttpOnly cookie flow, and keeps that web session ephemeral.

## Requirements

- Xcode 26 or newer
- iOS 17 or newer
- Tailscale connected on the iPhone and remote machine
- Orkestrator **Settings > Web client > Allow web access** enabled
- The tailnet HTTPS origin and gateway token shown by Orkestrator

## Run

From the repository root, build, install, and launch the default iPhone simulator with:

```bash
mise run dev:ios
```

Choose another installed simulator by name with:

```bash
mise run dev:ios --device "iPhone 17 Pro Max"
```

Alternatively:

1. Open `OrkestratorMobile.xcodeproj` in Xcode.
2. Select your development team under **Signing & Capabilities**.
3. Choose an iPhone or simulator and run the `OrkestratorMobile` scheme.
4. Enter only the HTTPS origin, for example `https://workstation.tailnet.ts.net`, and the gateway token.

The first successful connection is saved with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so it is unavailable while the device is locked and is not migrated through backups. A saved token is never written to `UserDefaults` or local storage and is never handed to JavaScript. Each app process creates an ephemeral WebKit session and exchanges the Keychain token for the backend's HttpOnly session cookie.

On every cold launch, the native app asks which saved server to open. Returning to an app that is already running keeps the current server. Saved servers also appear in the existing server switcher inside Orkestrator's mobile sidebar, which works through the native Keychain store. **New connection** there opens this app's own editor, so the token for another machine is typed into the app and never into the current server's page. When a page asks to add, replace, switch to or forget a saved server, the app asks first with a native alert that names the server and its address; Cancel, no answer within a minute, or the page navigating away refuses the request. Forms in **Settings > Machines** still take a token in the page ([to-do 8000](../../docs/todo/cross-cutting/8000-ios-settings-token-entry.md)), and each of their saves asks the same way. The rules are in [renderer security, iOS app](../../docs/architecture/renderer-security.md#ios-app).

If the active server is offline or its credential has expired, use **Switch saved server** on the native failure screen to reach another Keychain-backed connection without re-entering its token.

Forgetting a server deletes its known session cookie and makes a best-effort logout request only to the origin that issued it. Cookie ownership is recorded during native login, independently of saved servers, because cookies ignore ports. An unknown cookie is never sent to a logout endpoint; it is removed locally when no saved server on that host needs it. A known cookie from another port is preserved. A slow or failed logout does not delay forgetting; a session that cannot be revoked ends at the backend's own expiry.

If the Keychain cannot be read, for example while the device is locked, the app shows an empty list and says the saved servers have not been removed. It reads again when it returns to the foreground and before any save, and it refuses to save while the read still fails, because a save replaces the whole vault. Only malformed data can be replaced: connecting again overwrites it. If a draft was refused, foreground recovery keeps its address and token in the editor so it can be retried. Selecting a saved server instead clears the draft token.

An opaque cover shows whenever the scene is not active, so the snapshot iOS keeps for the app switcher should not show the screen. It also appears during brief interruptions such as Control Center. The device check is in the [manual-test checklist](../../docs/todo/manual-test/7568-manual-test-checklist.md) (from to-do 5601, retired 2026-11-10).

Run the native unit tests on an installed simulator with:

```bash
mise run test:logged -- --name ios-tests -- mise run test:ios
```

If the runner reports that the Xcode license has not been accepted, it stops before Swift compilation and no test assertions execute. Open Xcode, review and accept its license, and complete first-launch setup before rerunning the command. An exit caused by this prerequisite leaves iOS validation incomplete; it is not an assertion failure.

If `xcodebuild` finds no eligible destination ("iOS 26.5 is not installed"), the simulator platform matching your Xcode's SDK is missing, even when older simulator runtimes are installed. Install it under **Xcode > Settings > Components**. This too leaves iOS validation incomplete.

On an Apple silicon Mac, the equivalent command-line setup is:

```bash
xcodebuild -downloadPlatform iOS -architectureVariant arm64
mise run test:logged -- --name ios-tests -- mise run test:ios
```

The download is several gigabytes. Check `xcrun simctl runtime match list` if a downloaded runtime still does not satisfy Xcode: its build number must satisfy the SDK's runtime mapping, and `xcrun simctl runtime scan-and-mount` can reconcile an installed image that is not mounted. See [Apple's component installation guide](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

This runs the repository's shared `OrkestratorMobile` scheme, including its app host and asset catalog; a separate `swiftc` host does not validate those project settings. On 2026-11-05 the scheme passed all 66 tests on iOS 26.2, built with Xcode 26.6. To-do 5601, task 1 (retired 2026-11-10; `git show 53340356c:docs/todo/cross-cutting/5601-ios-runtime-security-checks.md`) records the runtime setup, command and result bundle. Device and signed-release checks are in the [manual-test checklist](../../docs/todo/manual-test/7568-manual-test-checklist.md). To-do 5602 (deleted 2026-11-06) recorded a later run of 98 tests with the catalog left out, on a Mac without the iOS 26.5 runtime; it does not validate the catalog. On 2026-11-13 the scheme, with `BridgeConsentTests` and `WebInspectorTests`, built for testing with Xcode 27.2 (`xcodebuild build-for-testing -destination 'generic/platform=iOS Simulator'`), but that Mac had no simulator runtime, so no test ran; the run is in the [manual-test checklist](../../docs/todo/manual-test/7568-manual-test-checklist.md) (6300 task 4 and 5600 tasks 1–2, both retired).

Plain HTTP and invalid TLS certificates are intentionally rejected. Use Tailscale Serve HTTPS as described in the repository root README.
