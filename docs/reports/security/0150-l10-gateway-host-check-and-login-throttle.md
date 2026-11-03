# Check the gateway's Host header and throttle login

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Add a Host allowlist**: the gateway accepts any `Host`, and treats an `Origin` matching it as allowed. Status: open.
2. **Throttle failed logins**: nothing slows guessing of a weak token. Status: open.

### 1. Add a Host allowlist

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

### 2. Throttle failed logins

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

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L10)
