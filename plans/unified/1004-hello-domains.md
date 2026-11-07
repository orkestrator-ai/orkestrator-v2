---
id: 1004
title: "Advertise and parse domain ranges in the hello"
phase: 1
plan: "§11.2 Negotiation and §12 Phase 1.2"
status: not-started
depends_on: [1002, 1003]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1004 · Advertise and parse domain ranges in the hello

- **Report:** [§11.2 Negotiation](../../docs/reports/unified-federation.md#112-design), [Appendix F](../../docs/reports/unified-federation.md#appendix-f-existing-versioned-protocols-to-learn-from)
- **Depends on:** [1002](1002-contract-primitives.md), [1003](1003-backend-register-overload.md)
- **Blocks:** [1009](1009-domain-clients-and-adapters.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [2011](2011-scope-domain-negotiation.md), [5006](5006-fleet-currency.md)
- **Size:** S
- **Track:** C (contract)

## Goal

Every backend advertises `domains: Record<string, {min, max}>`. Every parser of the hello keeps it. A node without the field is identified as pre-contract.

## Current state (verified 2026-11-07)

- The emitter is `apps/backend/src/gateway-auth.ts:589-626` (`handleHello`).
  - Capabilities are set at :595-611; the node-only ones only when `identity.nodeMode` is set.
  - `nodeMode` and `buildCommit` are added at :624-625.
- The parser is `packages/protocol/src/backend-profile.ts:279-351` (`parseBackendHello`).
  - It requires `schemaVersion === 1`, and checks `clientApi` bounds.
  - Capabilities: at most 64 names (`MAX_CAPABILITIES`), each matching `/^[a-z][a-z0-9-]*$/` and ≤ 64 characters, each value an integer from 0 to 1e6.
  - It **rebuilds the object field by field**, so unknown keys are dropped rather than passed through. The report's "old parsers ignore unknown keys" is right in effect: older peers will not see `domains`. New code must parse it explicitly.
- Capabilities: there are 13 names, not 12. Three are not node-related: `backendProfile`, `loopbackClientGateway`, `summaryReads`.
- Consumers of the hello:
  - web: `apps/web/src/lib/portal/workspaces.ts:61`, identity only;
  - backend and desktop: `packages/protocol/src/node/node-link/backend-hello.ts:117-118`, through `node-link.ts`, `node-service.ts`, `apps/desktop/electron/backend-hello.ts` and `node-workspaces.ts`;
  - `apps/desktop/electron/connection-summaries.ts:130` also reads capability names.

## Work

- [ ] Add `domains?: Record<DomainName, {min, max}>` to `BackendHello`. Parse it with bounds: at most 64 domains, names matching the capability pattern, integer versions with 0 ≤ min ≤ max ≤ 1000, and unknown domain names kept. A malformed `domains` makes the hello `domains: undefined` and logs a content-free event; the hello itself is not refused.
- [ ] Compute the advertised ranges from the registry's `contracts` map ([1003](1003-backend-register-overload.md)): `max` is the domain's current version, and `min` is the oldest version the backend still accepts, declared next to the domain.
- [ ] Emit `domains` from `handleHello`. Never bump `schemaVersion`, and never put domains in `capabilities`.
- [ ] Expose `domainRange(hello, name)` and `isPreContract(hello)` helpers.

## Tests

- [ ] Parser: valid, absent, malformed, over-bound, and unknown domain names.
- [ ] Round trip of the emitted hello through `parseBackendHello`.
- [ ] A hello from the floor release (a fixture captured from a published version) still parses, with `domains` undefined.

## Done when

- [ ] The hello carries `domains` for the domains defined so far (none until [1010](1010-pilot-node-mail-and-ticket-sync.md), so an empty object), and all parsers keep it.
