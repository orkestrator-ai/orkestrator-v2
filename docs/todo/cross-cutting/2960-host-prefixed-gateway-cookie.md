# Issue the gateway session cookie under the `__Host-` name over HTTPS

## Task analysis

Analysed 2026-11-03 against `main` at `a1218b081`.

### Tasks

1. **Switch the issued cookie name over HTTPS**: issue `__Host-orkestrator_gateway_auth` instead of `orkestrator_gateway_auth` when the browser reached the gateway over HTTPS. Status: blocked (waits on 7568: 2960 task 2).

### 1. Switch the issued cookie name over HTTPS

**Problem.** Security finding H1 (`docs/reports/2-26-10-27-security.md`)
recommends `Secure` plus the `__Host-` prefix on HTTPS. The H1 fix put an
opaque, expiring session in the cookie and adds `Secure` over HTTPS, but it
kept the plain name. A cookie without the prefix can still be set or
overwritten by a sibling host of the same registrable domain (for example
another machine under the same `<tailnet>.ts.net`) or by a plain-HTTP page,
which allows cookie tossing: forcing a browser onto an attacker's session or
signing it out.

**Context.** The gateway already reads `__Host-orkestrator_gateway_auth`
first and strips it before every proxy hop (`GATEWAY_AUTH_COOKIE_NAMES` in
`apps/backend/src/gateway-support-core.ts`, `getGatewayAuthCookie` in
`apps/backend/src/gateway-sessions.ts`), and logout already expires both
names. Only `gatewaySessionCookie` decides the issued name. The plain name was
kept because the iOS app's native sign-in
(`RemoteWebView.Coordinator.loginCookie`) looked the cookie up by that name,
and `docs/architecture/version-compatibility.md` says that contract only
changes additively.

**Investigation.** The impact of tossing is limited now: a tossed cookie must
still be a live session to authenticate, and minting one needs the durable
token. What remains is forced sign-out and session fixation onto a session
the attacker already holds. HTTPS detection is `requestIsHttps` (TLS socket,
`X-Forwarded-Proto: https`, or a same-host `https:` `Origin`).

**Decisions.**

- **When to switch?**
  - **After task 2, with the plain name still expired on login (recommended).**
    - Pros: no supported iOS build loses sign-in; the old plain cookie is
      removed from browsers on their next login.
    - Cons: waits a full support window.
  - **Now, behind a backend setting.**
    - Pros: users without the iOS app gain the protection at once.
    - Cons: a setting that silently breaks iOS sign-in when turned on; one
      more configuration surface.

## Assumptions and decisions

### Task 2: how to verify (2026-11-05)

- **Chose:** the recommended option's first half, running the tests on macOS,
  through a stand-in build rather than the Xcode scheme. The task stays open
  until a release is recorded in the version-compatibility register.
- **Why:** installing the matching simulator platform is a system change the
  review's brief did not cover. The stand-in compiles the same sources and runs
  the same assertions, so it answers whether the Swift change compiles and
  works; it does not prove the project's own build settings.

## Related

- `docs/reports/2-26-10-27-security.md` (H1)
- `docs/architecture/remote-gateway.md` (Security notes)
- To-do 5601 (retired 2026-11-10): the iOS guarantees it checked are in [renderer security, iOS app](../../architecture/renderer-security.md#ios-app), and its device and signed-release checks are in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, recording the first iOS release that accepts the `__Host-` name and the iOS support window) moved there on 2026-11-10.
