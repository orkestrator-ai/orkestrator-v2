---
id: 1004
title: "Advertise and parse domain ranges in the hello"
phase: 1
plan: "§11.2 Negotiation and §12 Phase 1.2"
status: done
depends_on: [1002, 1003]
blocked_by: ""
owner: claude-worker
branch: unified-federation-b4c9ee65814d
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

- [x] Add `domains?: Record<DomainName, {min, max}>` to `BackendHello`. Parse it with bounds: at most 64 domains, names matching the capability pattern, integer versions with 0 ≤ min ≤ max ≤ 1000, and unknown domain names kept. A malformed `domains` makes the hello `domains: undefined` and logs a content-free event; the hello itself is not refused.
- [x] Compute the advertised ranges from the registry's `contracts` map ([1003](1003-backend-register-overload.md)): `max` is the domain's current version, and `min` is the oldest version the backend still accepts, declared next to the domain.
- [x] Emit `domains` from `handleHello`. Never bump `schemaVersion`, and never put domains in `capabilities`.
- [x] Expose `domainRange(hello, name)` and `isPreContract(hello)` helpers.

## Tests

- [x] Parser: valid, absent, malformed, over-bound, and unknown domain names.
- [x] Round trip of the emitted hello through `parseBackendHello`.
- [x] A hello from the floor release (a fixture captured from a published version) still parses, with `domains` undefined.

## Done when

- [x] The hello carries `domains` for the domains defined so far (none until [1010](1010-pilot-node-mail-and-ticket-sync.md), so an empty object), and all parsers keep it.

## Notes

### Decisions (2026-11-07)

- **Hand-written parser, not Effect Schema.** Tried `Schema.Record(DomainNameSchema, Struct({ min, max }))` with `isMaxProperties(64)`: Effect 4.1.2 *silently drops* a record key that fails the key schema (`{ "Bad": … }` decodes to `{}`), which contradicts the all-or-nothing rule below, and the count check runs only after every entry is decoded. `parseHelloDomains` is a plain bounded loop in the style of the rest of `parseBackendHello`, reusing 1002's `isDomainNameShape` and `MAX_DOMAIN_VERSION` so the bounds have one source. Effect is not used anywhere in this item; nothing here needs services, scopes or fibers.
- **All or nothing.** A malformed `domains` (not an object, more than 64 entries, a name outside the capability pattern or over 64 characters, a range that is not `{ min, max }` integers with `0 <= min <= max <= 1000`) drops the whole field: the hello parses with `domains` absent, so the peer is treated as pre-contract (the safe legacy path), and a `contract hello.domains-malformed` warn is logged with `reason` (`not-object` | `too-many` | `invalid-name` | `invalid-range`) only. Keeping the valid part of a list we cannot trust would advertise ranges the peer may not have meant. Unknown domain names are kept; unknown keys inside a range are dropped (tolerant reader). The hello is never refused for `domains`.
- **New log area `contract`** (`packages/protocol/src/log-vocabulary/contract.ts`, registered in the index): the parser runs in the web, desktop and backend, so no existing per-process area fits. Later contract items (1005, 1009 usage counters) can add their events to it.
- **Types.** `BackendHello.domains?: NegotiatedDomains` (the `Readonly<Record<string, NegotiatedDomainRange>>` from `node-client.ts`), string-keyed rather than `Record<DomainName, …>` because unknown names are kept. Exports from `backend-profile.ts`: `parseHelloDomains(value)` (returns `{ ok, domains } | { ok: false, problem }`), `MAX_HELLO_DOMAINS`, `HelloDomainsProblem`, `domainRange(hello, name)` (own keys only, so `constructor` never reads the prototype; `undefined` when not advertised) and `isPreContract(hello)` (true for `null`/`undefined`, i.e. a legacy backend with no hello, and for a hello without `domains`).
- **Advertised ranges** come from the registry: `CommandRegistry.helloDomains()` (added next to 1003's `domainRanges`, in `commands-registry-contracts.ts`) returns `{ [domain]: { min: domain.min, max: domain.version } }` sorted by name. `BackendHelloIdentity.domains` carries it from `backendHelloIdentity()` (`core/index.ts`) to `handleHello`, which always sends `domains` (`{}` when no command is defined yet, or when an embedded gateway's identity gives none), so a current backend is distinguishable from a pre-contract one. `schemaVersion` stays 1 and nothing is added to `capabilities`.
- **Every parser keeps it**: all hello consumers (web `portal/workspaces.ts`, desktop `connection-manager.ts`/`backend-process.ts`, backend `node-link.ts`/`node-service.ts`) go through `parseBackendHello` via `checkBackendRoute` and pass the parsed object on, so no other site needed a change.
- **Floor-release fixture.** The support floor v2.21.0 has **no hello route at all** (the hello arrived in #1127, first published in v2.25.0-alpha; first Stable with it is v2.36.0). *(2026-11-07, orchestrator, completeness check: correction: v2.25.0-alpha was an unpublished draft, not a published release ([1007](1007-release-snapshots-and-backfill.md) Notes lists it among the drafts); the hello's code is in that tag, so the hello computed from its `handleHello` still stands as a fixture, but the first published release that can carry it is a later one (the next published release is v2.26.2-beta; npm, which 1007 only cross-checked, does carry 2.25.0-alpha).)* So the "floor hello" test drives `checkBackendRoute` against v2.21.0's behaviour reconstructed from its source at the tag (an unknown `/__orkestrator/*` path falls through to `serveStatic`: the SPA's HTML or 404; `/__orkestrator/status` answers `{ ok: true }`): the outcome is `legacy` and `isPreContract(null)` holds. In addition, the hellos emitted by v2.25.0-alpha and v2.36.0 were computed from each tag's `handleHello` (`gateway-auth.ts:558-582` and `:550-580`) and parse with `domains` undefined. No old binary was run.
- **docs/architecture/federation.md** gained a `domains` bullet in the hello field list (outside the strict file set; one bullet).
- Aggregate suite left to review preparation.

## Work log

- 2026-11-07 (claude-worker): `domains` on `BackendHello` with `parseHelloDomains`, `domainRange`, `isPreContract` (`packages/protocol/src/backend-profile.ts`), the `contract` log area, `CommandRegistry.helloDomains()`, `BackendHelloIdentity.domains` and emission from `handleHello`. Tests: `packages/protocol/src/backend-hello-domains.test.ts` (parser cases, bounds, own-key lookup, published-release hellos and the v2.21.0 legacy outcome), gateway round trip in `apps/backend/tests/gateway-hello.test.ts` (registry ranges through the HTTP hello and `parseBackendHello`; empty object without defined commands). Also did 1003's node-link envelope box: `NodeLink.invokeCommand(def, args)` and `contractEnvelopeFor(hello, def, args)` send the envelope only when the peer's hello advertises the domain (`node-link.test.ts`). Protocol and backend typecheck, oxlint and `bun fmt` clean.
- 2026-11-07 (orchestrator, completeness check): corrected the Notes' "first published in v2.25.0-alpha": 1007 found v2.25.0-alpha was an unpublished draft.
