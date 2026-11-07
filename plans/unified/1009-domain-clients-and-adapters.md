---
id: 1009
title: "Domain clients, version adapters and legacy adapters"
phase: 1
plan: "§11.2 Client adapters and §11.4"
status: not-started
depends_on: [1002, 1004]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1009 · Domain clients, version adapters and legacy adapters

- **Report:** [§11.2 Client adapters](../../docs/reports/unified-federation.md#112-design), [§11.4 Transition](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Decisions:** 13.6 (both sides adapt), 13.9 (per domain)
- **Depends on:** [1002](1002-contract-primitives.md), [1004](1004-hello-domains.md)
- **Blocks:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [2011](2011-scope-domain-negotiation.md)
- **Size:** M
- **Track:** C (contract)

## Goal

Callers use `domainClient(...).method(...)` and never see a version. The highest version both sides support is chosen once per connection generation. A node without `domains` uses a version-0 legacy adapter that packages today's capability gating.

## Work

- [ ] `packages/protocol/src/contract/client.ts` (shape from [1002](1002-contract-primitives.md)):
  - `createDomainClient(def, { call, domains })`, where `call(def, args, envelope)` is the transport and `domains` is the negotiated map or `null` for pre-contract nodes;
  - it selects the adapter with `pickVersion`, caches the choice per `domains` identity, and throws a coded `unsupported-version` when there is no overlap.
- [ ] The version-0 rule: a pre-contract node always uses adapter `0`. Each domain's adapter 0 may consult the existing per-domain capability command (the 8 `*_capabilities` commands) or the hello `capabilities`.
- [ ] An adapter registry that lists (domain, version) pairs for the CI job ([1008](1008-contract-ci-job.md)). Write `packages/protocol/contracts/adapters.json`, with a check mode.
- [ ] Content-free usage counters per (domain, adapter version):
  - backend side: the existing compatibility-path counters;
  - renderer side: a new bounded counter ring next to `renderer-error-ring.ts`, uploaded with the existing client metrics.
- [ ] Retirement rule in code comments and docs: adapter `v` is deleted when the floor passes the first Stable release with `v + 1`.

## Tests

- [ ] Selection across ranges; pre-contract selects 0; no overlap gives a coded error; the cache is invalidated when `domains` changes (a new connection generation).
- [ ] Counters are bounded and contain names and numbers only.

## Done when

- [ ] A test domain with versions 0, 1 and 2 works against fake backends advertising each range.

## Notes

- The per-domain capability commands that exist today: `design_capabilities`, `web_annotations_capabilities`, `get_preview_capabilities`, `changes_get_capabilities`, `transcript_artifact_capabilities`, `get_native_agent_sync_capabilities`, `get_agent_handoff_capabilities`, `get_client_state_capabilities`. That is 8, not "about ten". Each is folded into its domain version during Phase 7.
