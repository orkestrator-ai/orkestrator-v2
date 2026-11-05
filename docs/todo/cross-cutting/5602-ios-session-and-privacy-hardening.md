# Smaller iOS session and privacy hardening

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`. Claims re-checked and built on 2026-11-05 against `main` at `6e796ca32`; the recommended option was taken for all three tasks.

### Tasks

1. **End the session when a server is forgotten**: forgetting a server now deletes its known session cookies and makes a best-effort logout only to their recorded issuing origin; unknown ownership never causes a logout request. Status: done.
2. **Hide the app in the app switcher**: an opaque cover now shows whenever the scene is not active. Status: done; the device check is [5601](5601-ios-runtime-security-checks.md) task 6.
3. **Do not overwrite the vault after a failed read**: a failed read is remembered, read again before any write, and every write but the malformed-data recovery is refused. Status: done; how often it happens on a device is [5601](5601-ios-runtime-security-checks.md) task 3.

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

## Assumptions and decisions

### Task 1: The coordinator ends the session, after the forget has succeeded

`RemoteWebView.Coordinator` owns the web store, so the bridge's `forget` action starts the work once `ConnectionModel.forget` has returned, and replies without waiting for it. A forget that fails to write leaves the session alone. The work deletes the host's cookies first, then sends `POST /__orkestrator/logout` with only the gateway session cookie, because the gateway revokes the session that cookie names. `GatewayLogoutClient` carries the cookie by hand and has a 5 second limit, so the logout does not need a page to run in, which matters when the last server is forgotten and the web view is dismantled. It refuses the gateway's redirect to its login page, so the cookie goes only to the forgotten address.

### Task 1: Cookies shared with a saved server on the same host

Cookies ignore ports, so the saved list cannot identify the issuer of a host cookie. The review found that successive forgets could preserve A's cookie and later send it to B on another port. Native cookie installation now records the issuing origin and cookie value independently of that list. Cleanup sends a cookie only to its recorded issuer. Unknown cookies are preserved while a saved sibling on the host remains; once none remains, they are deleted locally without logout. Known sibling cookies are preserved. Unknown or unreachable sessions rely on backend expiry, avoiding credential disclosure at the cost of best-effort revocation.

### Task 1: Keep the ephemeral data store alive through cleanup

The review's stronger teardown test releases the `WKWebView` after calling its real dismantle path. It exposed that retaining `WKHTTPCookieStore` alone does not keep the nonpersistent cookie jar alive: no logout cookie remained to read. The cleanup task now retains `WKWebsiteDataStore` until deletion finishes. The test verifies that the web view is actually released and the recorded session is still logged out.

### Task 1: Only cookies for the exact host

A cookie belongs to the host when its domain equals the host, ignoring case and a leading dot. Parent-domain and subdomain cookies are not deleted, because other hosts share or own them. Service preview cookies on another host therefore stay until the process ends, which is also when the store goes.

### Task 1: A sign-in in flight

Forgetting the server being signed in cancels that sign-in and invalidates its generation. Native cookie installation and deletion share a serialized queue: an insertion already in WebKit finishes before deletion, and a newly selected same-host server installs its cookie after deletion. Logout runs outside this queue, so an unreachable gateway cannot stall the next sign-in. A session the gateway has already minted for the cancelled attempt runs to its expiry, like the one each cold launch already leaves behind.

### Task 2: An overlay on the root view and on the sheet

`PrivacyCover` is an overlay, so the web view underneath keeps its page and session and the app shows normally on return. A SwiftUI overlay does not reach a sheet, and the connection editor is one, so the sheet has its own. Two limits are left to [5601](5601-ios-runtime-security-checks.md) task 6, because neither can be settled here: views WebKit presents itself, such as a file picker or a link preview, sit above SwiftUI and are not covered, and the keyboard is in its own window. A separate cover window at alert level would cover those but is more code than the analysis asked for, and is the change to make if the device check shows it matters.

The cover's image comes from the asset catalog, which could not be compiled on this machine (see [Current state](#current-state)), so the tests run the cover without its mark. Its layout with the mark was seen once in a throwaway build that loaded the image from a loose file.

### Task 3: The guard covers every write, not only `connect`

The analysis named the save in `connect`. The re-check found a worse path: `forget` on an unread vault saw an empty list and called `delete()`, which removed the whole item, even for an id it had never heard of. `connect`, `use`, `rename` and `forget` all read again first. In `connect` the read happens after the network check, right before the new vault is built, so the device can lock during the check without harm.

### Task 3: What the messages say

A failed read now tells the user the servers have not been removed and will come back. A refused save says nothing was saved and why, and leaves the draft token in the editor so it need not be typed again. A malformed vault keeps its existing message and recovery: connecting again replaces it. A successful foreground retry clears those messages but leaves an unrelated error, such as a rejected token, in place.

### Task 3: Recovery keeps the reachable launch draft

A failed launch read displays the inline editor with `isShowingConnectionEditor == false`. When the read recovers with an unfinished draft, the saved-server picker returns underneath a presented editor holding the same address and token. Connecting retries the draft; choosing a saved server instead clears its token. This keeps the original launch selection requirement while preserving the promised recovery path.

### All tasks: Test runner on this machine

`mise run test:ios` cannot run here, because the iOS 26.5 simulator runtime that Xcode's SDK requires for the asset catalog is not installed, and the constraints for this work rule out changing Xcode's state. The project's own scheme was run with per-command overrides that leave the catalog out. Nothing in the suite needs the catalog. Test command and result are in [Current state](#current-state).

## Current state

All three are built. Review corrections record cookie issuers, serialize login-cookie writes with forget cleanup, preserve the refused draft through foreground recovery, and bound the hung-logout test. Regression coverage includes sequential same-host forgets, a held native login response, a delayed real WK cookie write, release of the dismantled WKWebView, and the privacy cover over a synthetic remote page.

On 2026-11-05 the project's `OrkestratorMobile` scheme passed **98 tests, 0 failed, 0 skipped** (the 66 existing ones and 32 new), read from the Xcode result summary, with Xcode 26.6 on an isolated iPhone 17 Pro simulator with iOS 26.2. The command, with `<udid>` that simulator's id, was:

```bash
xcodebuild -project apps/ios/OrkestratorMobile.xcodeproj -scheme OrkestratorMobile -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=<udid>" -destination-timeout 180 \
  -derivedDataPath "$PWD/output/agent-testing/5602/derived-data" \
  EXCLUDED_SOURCE_FILE_NAMES=Assets.xcassets ASSETCATALOG_COMPILER_APPICON_NAME= \
  ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME= test
```

Xcode's destination lookup also failed intermittently on that loaded machine, exiting 70 before building anything, and that same command then succeeded on a later attempt (the 98-test run took eight). The unmodified `mise run test:ios` exited 70 at that lookup, and with the lookup past and the catalog left in, the build stopped at the catalog ("No simulator runtime version ... available"). So the asset catalog and app icon were not compiled in this work.

Removing each safeguard in turn made its tests fail, then the change was restored: no cover (3 cover tests), no cover on the sheet (the sheet test), no read before the save in `connect` (6 vault tests), and `forget` waiting for the logout (the hung-logout test).

The tests use fakes throughout: a failing credential store, a fake logout sender, and a fake gateway on loopback over HTTP. Nothing here has run on a device or against a real gateway; those checks are [5601](5601-ios-runtime-security-checks.md) tasks 2, 3 and 6.

Review fixes on 2026-11-05 passed **104 hosted tests, 0 failures, 0 skipped** in `output/agent-testing/5602-review-fixes/tests-4.xcresult`. The same scheme command above ran through `test:logged`, using derived data under `output/agent-testing/5602-review-fixes/derived-data` and a new result bundle per attempt. A subsequent focused `PrivacyCoverTests` run passed **6 tests**, with an explicit ready-page assertion and screenshots in `output/agent-testing/5602-review-fixes/privacy-final.xcresult`. These runs still exclude the asset catalog. The first and third destination attempts exited 70 because Xcode reported the missing iOS 26.5 platform; successful retries used the installed iOS 26.2 runtime without changing Xcode state.

The initial correction run compiled and ran 103 tests, exposing the data-store lifetime bug above and two remote-page test setup assertions; those were corrected before the 104-test pass. Temporarily omitting logout delivery made the bounded hung-logout test fail in **3.345 seconds**, rather than spin forever (`hung-negative-2.xcresult`); the original source was restored automatically, and the final focused `SessionEndTests` run passed **12 tests** in `session-final.xcresult`. The first negative-test attempt also stopped at destination lookup. The synthetic remote page is covered in inactive and background phases, returns unchanged when active, and survives a fresh root mount. A refused draft is also rendered before and after foreground recovery. The focused todo-index check passed.

The preparation package's broader failed checks were inspected, not rerun: its TypeScript error names unchanged `scripts/benchmark-change-tracking.ts:682`; its browser fixture on port 1422 belonged to another checkout (HTTP 403); its aggregate test failures concern unchanged backend, protocol, web tests and the web-ui flake register. The flake-index failure was tagged related through the changed todo index, but the actual assertion checks a missing `ID: 5701` in the unchanged web-ui case. The remaining aggregate failures have undetermined triage and no identified link to this iOS diff, so they are left for verification rather than repaired in unrelated code. The original review package and artifacts remain intact.

## Constraints and rationale

- Never treat a failed Keychain read as an empty vault when deciding what to write.
- A logout attempt must not delay or block forgetting a server.

## Related

- [5600-ios-bridge-user-consent.md](5600-ios-bridge-user-consent.md)
- [5601-ios-runtime-security-checks.md](5601-ios-runtime-security-checks.md)

## Replaces

Part of the iOS review, security report part `0270` (batch S-0270). Its file was deleted when the review was done; it is in the history, ending with the outcome table, at the commit before the deletion.
