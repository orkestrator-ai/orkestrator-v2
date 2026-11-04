# Make the isolated preview transport the default and retire the legacy route

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Turn the isolated transport on by default**: the second half of the report's fix. Status: open.
2. **Retire the legacy route**: remove `browser/loopback` once nothing needs it. Status: open (depends on 1).

### 1. Turn the isolated transport on by default

**Problem.** Service previews still run through legacy loopback URLs on the gateway origin unless a user turns the isolated transports on.

**Context.** Tracked as [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) task 7, which is blocked on its two-machine, Windows and threshold gates.

**Investigation.** `docs/architecture/remote-gateway.md:559` still says both isolated transports are off by default.

**Decisions.** None here: todo 0042 owns the gates and the sign-off.

### 2. Retire the legacy route

**Problem.** While the route exists, its isolation rests on one response header and on the port scoping that M2 added.

**Context.** Tracked as todo 0042 task 8, blocked on task 7 and the support window.

**Investigation.** The route is still served (`apps/backend/src/gateway-handlers.ts:426`, `apps/backend/src/gateway-auth.ts:505`).

**Decisions.** None here: todo 0042 owns the support-window question.

## Current state

Done, so not in Tasks: every `browser/loopback` response carries `Content-Security-Policy: sandbox ...` in place of the upstream policy, on proxied responses (`apps/backend/src/gateway-proxy.ts:231`) and on the route's own answers (`apps/backend/src/gateway-auth.ts:305`). The value is `BROWSER_PREVIEW_SANDBOX_CSP` (`apps/backend/src/gateway-support-core.ts:229-230`). A preview opened top-level is therefore an opaque origin.

## Needs verification

- Browser behaviour of the sandbox header in Chromium and Safari; see [0260](0010-s4-gateway-login.md#0260-run-the-outstanding-dynamic-security-checks).

## Related

- [Security report, M1](../2-26-10-27-security.md#m1-legacy-loopback-previews-run-agent-html-on-the-gateway-origin-isolated-only-by-the-clients-iframe-sandbox)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), tasks 7 and 8
