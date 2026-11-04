# Issue the gateway session cookie under the `__Host-` name over HTTPS

## Task analysis

Analysed 2026-11-03 against `main` at `a1218b081`.

### Tasks

1. **Switch the issued cookie name over HTTPS**: issue `__Host-orkestrator_gateway_auth` instead of `orkestrator_gateway_auth` when the browser reached the gateway over HTTPS. Status: open (depends on 2).
2. **Wait for an iOS release that accepts the name**: the iOS app's native sign-in must accept the `__Host-` name in every supported build before the backend issues it. Status: open.

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

### 2. Wait for an iOS release that accepts the name

**Problem.** An iOS build older than the H1 change rejects a login response
that carries only the `__Host-` cookie ("did not create a secure web
session").

**Context.** The H1 change made `loginCookie` accept either name, preferring
`__Host-`, with an XCTest case. It was written on Linux and not compiled or
run there.

**Investigation.** Tried on 2026-11-04 on a Mac with Xcode 27.2, without a
result. `mise run test:ios` printed nothing while `xcodebuild -runFirstLaunch`
ran; it was stopped after 15 minutes, so the Swift change has still never been
compiled. Complete Xcode's first launch by hand first, because it installs
system components. The commit with the change (`4f9cf3b32`) is in the tags
`v2.35.5-beta`, `v2.36.0` and `v2.36.1`. Whether an iOS build has shipped from
them, and how long the iOS support window is, were not established.

**Decisions.**

- **How to verify?**
  - **Run `OrkestratorMobileTests` on macOS, then record the first release
    that contains it in the version-compatibility register (recommended).**
    - Pros: the switch in task 1 can then cite a concrete minimum build.
    - Cons: needs a Mac with Xcode.
  - **Rely on code review.**
    - Pros: no hardware.
    - Cons: the Swift change has never been compiled.

## Related

- `docs/reports/2-26-10-27-security.md` (H1)
- `docs/architecture/remote-gateway.md` (Security notes)
