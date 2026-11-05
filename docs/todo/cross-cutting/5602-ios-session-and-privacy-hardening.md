# Smaller iOS session and privacy hardening

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **End the session when a server is forgotten**: forgetting a server leaves its web session alive. Status: open.
2. **Hide the app in the app switcher**: iOS keeps a snapshot of whatever the app showed. Status: open.
3. **Do not overwrite the vault after a failed read**: a Keychain read failure can lead to saved servers being lost. Status: open.

### 1. End the session when a server is forgotten

**Problem.** `forget` removes the saved token, but the gateway session the app signed in with stays valid, and its cookie stays in the running web view's store. The app never logs out.

**Context.** `ConnectionModel.forget` (`apps/ios/OrkestratorMobile/Models/ConnectionModel.swift`). Sessions live in the backend's memory, expire after 12 idle hours and 7 days at most, and the store holds at most 64 (`GATEWAY_SESSION_IDLE_TTL_MS`, `GATEWAY_SESSION_MAX_LIFETIME_MS`, `MAX_BROWSER_SESSIONS` in `apps/backend/src/gateway-support-core.ts`). The gateway's `/__orkestrator/logout` revokes the session named by the request's cookie (`apps/backend/src/gateway-auth.ts`). Every cold launch also mints a new session, and the old one waits for its expiry.

**Investigation.** Read from the code on 2026-11-05. The web store is `.nonPersistent()`, so the cookie goes when the process does, and it is not sent to any other host. So the leftover is a session nobody can reach through this app after a restart; the exposure is a device taken while the app is still running.

**Decisions.**

- **What should `forget` do?**
  - **Delete the host's cookies from the web store and make a best-effort logout request (recommended).**
    - Pros: matches what "forget" suggests; bounded and small; a failed request changes nothing else.
    - Cons: the logout needs the cookie, so it has to run from the web view or carry the cookie by hand; the request can fail silently offline.
  - **Leave it to expiry.**
    - Pros: no work; the window is bounded by the backend.
    - Cons: up to 7 days of a session the user believes they ended.

### 2. Hide the app in the app switcher

**Problem.** iOS snapshots the screen when the app leaves the foreground and stores the image on disk. For this app that can show code, terminal output and transcripts.

**Context.** `apps/ios/OrkestratorMobile/Views/RootView.swift` has no `scenePhase` handling, and the snapshot behaviour itself cannot be observed in a unit test.

**Investigation.** Read from the code on 2026-11-05. The data protection class of the snapshot and whether a cover reaches it in time were not observed.

**Decisions.**

- **Add a privacy cover?**
  - **Show an opaque cover when `scenePhase` is not `.active`, and check it on a device (recommended).**
    - Pros: a few lines in `RootView`; common practice for apps that show private material.
    - Cons: the cover also appears during brief interruptions such as Control Center, and it may annoy someone using the switcher to compare windows.
  - **Leave as is.**
    - Pros: the switcher stays useful; a device that is unlocked already gives access to the running app.
    - Cons: a sensitive screen stays on disk after the app is closed.

### 3. Do not overwrite the vault after a failed read

**Problem.** If the Keychain read fails when the app starts, `ConnectionModel.init` falls back to an empty vault. The next successful connection saves a vault holding only that server, replacing every other saved server.

**Context.** `ConnectionModel.init` and `connect` (`apps/ios/OrkestratorMobile/Models/ConnectionModel.swift`), and `KeychainCredentialStore.save`. The item is `WhenUnlocked`, so a read while locked fails with `errSecInteractionNotAllowed`. Malformed data has its own error, whose message tells the user to remove the connection and connect again.

**Investigation.** Read from the code on 2026-11-05. Nothing leaks, but saved tokens can be lost and must be re-entered. Whether iOS ever starts this app's model while the device is locked (prewarming, for example) was not established, so how often this happens is unknown. This needs a device; see [5601](5601-ios-runtime-security-checks.md) task 3.

**Decisions.**

- **How to protect the saved list?**
  - **Remember that the read failed, read again before any save, and refuse to save on anything but malformed data (recommended).**
    - Pros: a temporary failure can no longer erase the list; malformed data keeps its documented recovery; straightforward to test with a failing credential store.
    - Cons: needs a message for the refused save, and a retry when the app returns to the foreground so the list reappears.
  - **Only retry the read when the app comes to the foreground.**
    - Pros: smaller; repairs the common case.
    - Cons: a save during the failure still overwrites the vault.

## Current state

None of these three is built. None exposes a token to anyone but the user's own device.

## Constraints and rationale

- Never treat a failed Keychain read as an empty vault when deciding what to write.
- A logout attempt must not delay or block forgetting a server.

## Related

- [5600-ios-bridge-user-consent.md](5600-ios-bridge-user-consent.md)
- [5601-ios-runtime-security-checks.md](5601-ios-runtime-security-checks.md)

## Replaces

Part of the iOS review, security report part `0270` (batch S-0270). Its file was deleted when the review was done; it is in the history, ending with the outcome table, at the commit before the deletion.
