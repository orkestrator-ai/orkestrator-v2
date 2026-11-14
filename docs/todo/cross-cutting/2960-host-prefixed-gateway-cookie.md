# Issue the gateway session cookie under the `__Host-` name over HTTPS

## Task analysis

Analysed 2026-11-03 against `main` at `a1218b081`.
Updated 2026-11-14 for the user's legacy-retirement decision.

### Tasks

1. **Switch the issued cookie name over HTTPS**: issue `__Host-orkestrator_gateway_auth` instead of `orkestrator_gateway_auth` when the browser reached the gateway over HTTPS. Status: open (2026-11-14: task 2, the iOS release and support-window record, closed under the user's legacy-retirement decision; see Assumptions and decisions).

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
  - **After task 2, with the plain name still expired on login (recommended until 2026-11-14).**
    - Pros: no supported iOS build loses sign-in; the old plain cookie is
      removed from browsers on their next login.
    - Cons: waits a full support window.
  - **Now, behind a backend setting.**
    - Pros: users without the iOS app gain the protection at once.
    - Cons: a setting that silently breaks iOS sign-in when turned on; one
      more configuration surface.
  - **Now, unconditionally (recommended since 2026-11-14, the user's
    legacy-retirement decision).** The wait on task 2 and the iOS support window no longer
    applies: the iOS app updates together with every other client, and every
    current iOS build looks up `__Host-orkestrator_gateway_auth` first
    (`RemoteWebView.swift`, commit `4f9cf3b32`). Over plain HTTP the plain
    name stays, because a `__Host-` cookie needs `Secure`.

## Assumptions and decisions

### Task 2: how to verify (2026-11-05)

- **Chose:** the recommended option's first half, running the tests on macOS,
  through a stand-in build rather than the Xcode scheme. The task stays open
  until a release is recorded in the version-compatibility register.
- **Why:** installing the matching simulator platform is a system change the
  review's brief did not cover. The stand-in compiles the same sources and runs
  the same assertions, so it answers whether the Swift change compiles and
  works; it does not prove the project's own build settings.

### Task 2: the iOS support window no longer gates task 1 (user decision, 2026-11-14)

The user decided on 2026-11-14 that legacy support retires now across the
repository (one sweep; all machines and clients update together), so the wait
on task 2 (recording the first iOS release that accepts the `__Host-` name,
and how long older iOS builds stay supported) no longer blocks task 1. Task 2
closes without that record: no older iOS build has to keep signing in, so
there is no support window to wait out. Task 1 can be built now, issuing
`__Host-orkestrator_gateway_auth` over HTTPS with no backend setting and no
older-version adapter for the plain name.

The plain-name expiry on login was recommended only to clear the old cookie
from browsers on their next login. Nothing in this file says a current client
needs it: the gateway reads `__Host-orkestrator_gateway_auth` first, and
logout already expires both names. So it may go; the task 1 worker may keep
it as cheap cleanup, and records the choice either way. The plain name itself
stays readable and is still issued over plain HTTP, where `__Host-` cannot be
set. The comment above `gatewaySessionCookie` in
`apps/backend/src/gateway-sessions.ts` that gives the iOS reason for the
plain name changes with the switch.

## Related

- `docs/reports/2-26-10-27-security.md` (H1)
- `docs/architecture/remote-gateway.md` (Security notes)
- To-do 5601 (retired 2026-11-10): the iOS guarantees it checked are in [renderer security, iOS app](../../architecture/renderer-security.md#ios-app), and its device and signed-release checks are in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (task 2, recording the first iOS release that accepts the `__Host-` name and the iOS support window) moved there on 2026-11-10; task 2 closed on 2026-11-14 under the user's legacy-retirement decision, so that item goes.
- [8108](8108-legacy-retirement-sweep.md): the 2026-11-14 legacy-retirement sweep.
