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
bun run dev:ios
```

Choose another installed simulator by name with:

```bash
bun run dev:ios --device "iPhone 17 Pro Max"
```

Alternatively:

1. Open `OrkestratorMobile.xcodeproj` in Xcode.
2. Select your development team under **Signing & Capabilities**.
3. Choose an iPhone or simulator and run the `OrkestratorMobile` scheme.
4. Enter only the HTTPS origin, for example `https://workstation.tailnet.ts.net`, and the gateway token.

The first successful connection is saved with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so it is unavailable while the device is locked and is not migrated through backups. The token is never written to `UserDefaults`, local storage, or JavaScript. Each app process creates an ephemeral WebKit session and exchanges the Keychain token for the backend's HttpOnly session cookie.

Saved servers appear in the existing server switcher inside Orkestrator's mobile sidebar. Adding or switching there is routed back through the native Keychain store.

If the active server is offline or its credential has expired, use **Switch saved server** on the native failure screen to reach another Keychain-backed connection without re-entering its token.

Run the native unit tests on an installed simulator with:

```bash
bun run test:ios
```

Plain HTTP and invalid TLS certificates are intentionally rejected. Use Tailscale Serve HTTPS as described in the repository root README.
