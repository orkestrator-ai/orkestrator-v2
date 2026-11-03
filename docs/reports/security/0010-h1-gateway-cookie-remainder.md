# Finish the gateway cookie hardening and settle what a leaked session still allows

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Issue the `__Host-` cookie name over HTTPS**: the last item in the report's fix list. Status: open.
2. **Decide on the session that still reaches other ports**: an opaque session still goes to every port on the host and authenticates until it ends. Status: open.

### 1. Issue the `__Host-` cookie name over HTTPS

**Problem.** The report asks for `Secure` and the `__Host-` prefix on HTTPS. `Secure` is in; the prefix is not.

**Context.** Tracked in full by [todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md), including the wait for an iOS release that accepts the name.

**Investigation.** `gatewaySessionCookie` still issues the plain name (`apps/backend/src/gateway-sessions.ts:73-75`). The `__Host-` name is read and stripped (`apps/backend/src/gateway-support-core.ts:192-194`).

**Decisions.** None here: todo 2960 holds the options and its recommendation.

### 2. Decide on the session that still reaches other ports

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

## Current state

Done, so not in Tasks: the opaque in-memory session (`apps/backend/src/gateway-sessions.ts`, commit `4f9cf3b32`), `Secure` over HTTPS (`requestIsHttps`, `:48`), refusal and expiry of a cookie that holds the durable token (`apps/backend/src/gateway-auth.ts:520-531`), revocation on logout and rotation, and bearer-only `gateway-settings` (`:135-138`, `:587-592`).

## Open questions

- Should the report's table keep saying "Fixed" for H1? Task 1 and task 2 both say that it is not finished.

## Needs verification

Nothing was run for this file.

- Whether a container on Docker Desktop reaches a gateway bound to the host's loopback through `host.docker.internal`, in `full` and in restricted mode, and which peer address the gateway then sees.
- Whether a `full` mode container on Linux Engine reaches a gateway on a Tailscale address.

## Related

- [Security report, H1](../2-26-10-27-security.md#h1-the-gateway-auth-cookie-is-the-durable-token-and-is-sent-to-every-port-on-the-host)
- [Todo 2960](../../todo/cross-cutting/2960-host-prefixed-gateway-cookie.md): the `__Host-` name
- [0260](0260-s8-dynamic-browser-and-docker-tests.md): browser testing of the cookie
- `docs/architecture/remote-gateway.md`, Security notes
