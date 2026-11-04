# S4: Gateway login

This file combines 3 reports into one batch to build together. Both change `gateway-auth.ts`. `0260` tests the result in browsers. `0260` task 2 needs real Docker daemons and can run separately.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0010](#0010-finish-the-gateway-cookie-hardening-and-settle-what-a-leaked-session-still-allows) | High | H1: the `__Host-` name, and the session that still reaches other ports |
| [0150](#0150-check-the-gateways-host-header-and-throttle-login) | Low | L10: Host allowlist and login throttling |
| [0260](#0260-run-the-outstanding-dynamic-security-checks) | Medium | §8: dynamic checks of H1, M1, M2 and H3 |

## 0010: Finish the gateway cookie hardening and settle what a leaked session still allows

### Task analysis

#### Tasks

1. **Issue the `__Host-` cookie name over HTTPS**: the last item in the report's fix list. Status: open.
2. **Decide on the session that still reaches other ports**: an opaque session still goes to every port on the host and authenticates until it ends. Status: open.

#### 1. Issue the `__Host-` cookie name over HTTPS

**Problem.** The report asks for `Secure` and the `__Host-` prefix on HTTPS. `Secure` is in; the prefix is not.

**Context.** Tracked in full by [todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md), including the wait for an iOS release that accepts the name.

**Investigation.** `gatewaySessionCookie` still issues the plain name (`apps/backend/src/gateway-sessions.ts:73-75`). The `__Host-` name is read and stripped (`apps/backend/src/gateway-support-core.ts:192-194`).

**Decisions.** None here: todo 2960 holds the options and its recommendation.

#### 2. Decide on the session that still reaches other ports

**Problem.** The report's scenario was a container dev server receiving the cookie on `127.0.0.1:<published port>`, then calling the gateway with it. The cookie now holds a session, not the durable token, but cookies still ignore ports. That server still receives a credential that can call `POST /__orkestrator/invoke` until the session ends. The `__Host-` prefix does not change this, because a `__Host-` cookie is still sent to every port.

**Context.** `docs/architecture/remote-gateway.md:426-430` states the exposure and says the session limits it. The report's H1 status says the same in one sentence, but its table says "Fixed". No document records whether this residue was accepted or left for later.

**Investigation.** `requestCredentialMatches` accepts a cookie that holds a live session (`apps/backend/src/gateway-auth.ts:117-127`), and nothing binds a session to the client that signed in (`apps/backend/src/gateway-sessions.ts:144-149`). A session idles out after 12 hours (`apps/backend/src/gateway-support-core.ts:214`), with the 7-day cap the architecture document gives, and is ended by logout, rotation or a restart. Reaching the gateway from a container is narrower than the report assumed: restricted mode allows the host only on named service ports (`docker/init-firewall.sh:266-273`), so the path needs `full` network mode, a tailnet address the container can reach, or a host that forwards loopback. See Needs verification.

**Decisions.**

- **What to do about a leaked session?**
  - **Accept it, and record that in the report and `remote-gateway.md` (recommended).** Revisit this if the check under Needs verification shows that a restricted container can reach the gateway.
    - Pros: no new moving parts; the session cannot read or rotate the token, and it ends.
    - Cons: for up to a session's lifetime, an agent with a reachable path can still act as the user, including opening host terminals.
  - **Bind each session to the peer address that signed in, and refuse it from another.**
    - Pros: a session stolen by a container is useless from the Docker bridge address.
    - Cons: behind Tailscale Serve every peer is loopback, so it does nothing there; a client that changes address signs in again; hosts that forward loopback to containers may defeat it.

### Current state

Done, so not in Tasks: the opaque in-memory session (`apps/backend/src/gateway-sessions.ts`, commit `4f9cf3b32`), `Secure` over HTTPS (`requestIsHttps`, `:48`), refusal and expiry of a cookie that holds the durable token (`apps/backend/src/gateway-auth.ts:520-531`), revocation on logout and rotation, and bearer-only `gateway-settings` (`:135-138`, `:587-592`).

### Open questions

- Should the report's table keep saying "Fixed" for H1? Task 1 and task 2 both say that it is not finished.

### Needs verification

Nothing was run for this file.

- Whether a container on Docker Desktop reaches a gateway bound to the host's loopback through `host.docker.internal`, in `full` and in restricted mode, and which peer address the gateway then sees.
- Whether a `full` mode container on Linux Engine reaches a gateway on a Tailscale address.

## 0150: Check the gateway's Host header and throttle login

### Task analysis

#### Tasks

1. **Add a Host allowlist**: the gateway accepts any `Host`, and treats an `Origin` matching it as allowed. Status: open.
2. **Throttle failed logins**: nothing slows guessing of a weak token. Status: open.

#### 1. Add a Host allowlist

**Problem.** A DNS-rebinding page can reach the gateway, because the same-host rule compares the request's own two headers, and an attacker's rebinding name passes.

**Context.** The impact is limited. A browser session cookie is scoped to the real host, so a rebound page holds no session. What it can reach is the login form and unauthenticated routes. The desktop preview ingress already checks `Host` against rebinding (`docs/architecture/browser-previews.md:184`).

**Investigation.** `isOriginAllowed` returns true when `origin.host === request.headers.host` (`apps/backend/src/gateway-auth.ts:205-214`). No `Host` check was found in `apps/backend/src/gateway*.ts`.

**Decisions.**

- **What goes on the list?**
  - **Loopback names, the bind address, this machine's Tailscale names, and hosts from `allowedOrigins` (recommended).**
    - Pros: all known at startup (`apps/backend/src/gateway-context.ts:181-182`); needs no new setting in normal use.
    - Cons: a user reaching the gateway through another name, under `--allow-non-tailscale-bind` or a reverse proxy, must add it to `ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS`.
  - **Only refuse names that resolve to a public address.**
    - Pros: no list.
    - Cons: needs a lookup per request, and misses private rebinding targets.

#### 2. Throttle failed logins

**Problem.** The default 256-bit token cannot be guessed, but a user-chosen one can be as short as 16 characters.

**Context.** `GATEWAY_TOKEN_MIN_LENGTH` is 16 (`packages/protocol/src/gateway-token.ts:1`).

**Investigation.** `handleLogin` compares the token and answers 401 at once, with no delay or counter (`apps/backend/src/gateway-auth.ts:764-771`). The same comparison also serves bearer requests (`:117-121`, `:167-172`), which a login throttle alone would not cover.

**Decisions.**

- **How to throttle?**
  - **A global in-memory backoff after repeated failures, for login and bearer alike (recommended).**
    - Pros: simple; behind Tailscale Serve every peer looks like loopback, so per-address counting would not work anyway.
    - Cons: a guesser can slow the real user's sign-in; existing sessions and valid bearers must stay exempt.
  - **Raise the minimum token length instead.**
    - Pros: no state; removes the premise.
    - Cons: an existing short token needs a migration, and `version-compatibility.md`-style contracts may hold clients to the old minimum.

## 0260: Run the outstanding dynamic security checks

### Task analysis

#### Tasks

1. **H1, M1 and M2 in Chromium and Safari**: the browser behaviour the fixes depend on. Status: open.
2. **H3 on rootful and rootless Docker**: the seed-file path against real daemons. Status: open.

#### 1. H1, M1 and M2 in Chromium and Safari

**Problem.** The report marked these as depending on browser rules it did not exercise, and its §8 keeps that open: cookie scope across ports, `SameSite=Strict` on a typed navigation, the sandbox header on a top-level load, and credentials on `Origin: null`.

**Context.** The fixes have backend tests that go through a real gateway (`apps/backend/tests/gateway-preview.test.ts`, `apps/backend/tests/gateway-proxy.test.ts`), but those do not show what a browser does with the headers.

**Investigation.** Playwright specs touch these areas: `e2e/preview/vite-page-load.spec.ts:151` and `e2e/preview/upstream-pool.spec.ts:96` load legacy URLs, and `e2e/preview/private-origin.spec.ts:387-393` and `:480` log in and check that the cookie does not reach a preview. Not read in full: whether any of them asserts an opaque origin on a top-level legacy load, or sends the cookie to another port. Safari remains blocked on hardware in [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) task 3.

**Decisions.**

- **How to record the result?**
  - **Add one Playwright spec per property, and run it in Chromium and WebKit (recommended).**
    - Pros: repeatable; the suite already has fixtures for the gateway and legacy URLs.
    - Cons: WebKit is not shipping Safari, so a manual Safari pass is still needed.
  - **A one-off manual pass, recorded in the report.**
    - Pros: quick; exact browsers.
    - Cons: no regression guard.

#### 2. H3 on rootful and rootless Docker

**Problem.** The original concern was how a daemon resolves a symlinked bind source. The fix no longer binds those files, so the question becomes whether seed files arrive correctly and refusals hold on real daemons.

**Context.** `readProjectSeedFiles` refuses links in the host process (`apps/backend/src/core/container-project-seed-files.ts:66-110`) and files then go in by `docker cp`. The refusal itself does not depend on Docker.

**Investigation.** `apps/backend/tests/container-project-seed-docker.test.ts` exists as a live test. Whether it has been run on rootless was not established from the code.

**Decisions.** None: run the existing test on both daemon types, and record the result in `docs/development/container-qualification.md`.

### Needs verification

All of this file is by nature unobserved: nothing was run for it.

## Related

- [Security report, H1](../2-26-10-27-security.md#h1-the-gateway-auth-cookie-is-the-durable-token-and-is-sent-to-every-port-on-the-host)
- [Todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md): the `__Host-` name
- [0260](#0260-run-the-outstanding-dynamic-security-checks): browser testing of the cookie
- `docs/architecture/remote-gateway.md`, Security notes
- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L10)
- [Security report, §8](../2-26-10-27-security.md#8-not-covered--follow-up)
- [0010](#0010-finish-the-gateway-cookie-hardening-and-settle-what-a-leaked-session-still-allows), [0020](0020-m1-isolated-preview-default.md)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), task 3
