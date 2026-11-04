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
