# Make the isolated preview transport the default and retire the legacy route

## Task analysis

Analysed 2026-11-04 against `main` at `4e3caa079`.

### Tasks

1. **Turn the isolated transport on by default**: the second half of the report's fix. Status: done on the branch (2026-11-04), without the two-machine run.
2. **Retire the legacy route**: remove `browser/loopback` once nothing needs it. Status: open (blocked on the support window).

### 1. Turn the isolated transport on by default

**Problem.** Service previews ran through legacy loopback URLs on the gateway origin unless a user turned the isolated transports on.

**Context.** Tracked as [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) task 7, whose gates were the two-machine run, Windows and thresholds.

**Investigation.** `DEFAULT_PREVIEW_SETTINGS` now has `transport: true` and `relay: true` (`apps/backend/src/core/storage-preview-services.ts`). Installs with saved settings keep them. The web client without private origins is unchanged: it still loads URL tabs through the legacy route.

**Decisions.** See Assumptions and decisions below; the detail is D18 to D21 in todo 0042.

### 2. Retire the legacy route

**Problem.** While the route exists, its isolation rests on one response header and on the port scoping that M2 added.

**Context.** Tracked as todo 0042 task 8. The removal condition is in [`version-compatibility.md`](../../architecture/version-compatibility.md): the floor must reach the first Stable release with the new default, which is at least 60 days after that release is published.

**Investigation.** The route is still served (`apps/backend/src/gateway-handlers.ts:426`, `apps/backend/src/gateway-auth.ts:505`). Stored URL tabs that match one service now migrate on the desktop. `localhost` tabs never match, so they and web clients still need an answer before removal.

**Decisions.** None here: todo 0042 owns the support-window question.

## Current state

Done, so not in Tasks: every `browser/loopback` response carries `Content-Security-Policy: sandbox ...` in place of the upstream policy, on proxied responses (`apps/backend/src/gateway-proxy.ts:231`) and on the route's own answers (`apps/backend/src/gateway-auth.ts:305`). The value is `BROWSER_PREVIEW_SANDBOX_CSP` (`apps/backend/src/gateway-support-core.ts:229-230`). A preview opened top-level is therefore an opaque origin.

## Needs verification

- Browser behaviour of the sandbox header in shipping Safari; see [todo 5500](../../todo/previews-and-annotations/5500-shipping-safari-gateway-security-checks.md). Chromium, Firefox and WebKit pass `e2e/preview/gateway-browser-security.spec.ts`.
- The two-machine run the default flipped without: [todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) tasks 1 and 6. It needs SSH to mbp3, which refused connections on port 22 on 2026-11-04.

## Related

- [Security report, M1](../2-26-10-27-security.md#m1-legacy-loopback-previews-run-agent-html-on-the-gateway-origin-isolated-only-by-the-clients-iframe-sandbox)
- [Todo 0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md), tasks 1, 6, 7 and 8

## Assumptions and decisions

### Task 1: flip on the maintainer's sign-off

The maintainer chose on 2026-11-04 to flip now rather than after an opt-in Stable release, and put Windows out of scope. They also asked for the two-machine run on mbp3, which could not start, so the run stays open as evidence for the flip rather than a gate on it.

### Task 2: this file stays until the route is gone

The request was to delete this file when the work was complete. Task 2 cannot complete before the support window passes, so the file stays, reduced to what is left.
