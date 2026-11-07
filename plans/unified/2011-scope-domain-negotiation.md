---
id: 2011
title: "Negotiated domains and typed invoke on every NodeClient"
phase: 2
plan: "§6.1 domains and §11.2 Negotiation"
status: not-started
depends_on: [2010, 1009]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 2011 · Negotiated domains and typed invoke on every NodeClient

- **Report:** [§6.1](../../docs/reports/unified-federation.md#61-the-nodeclient-contract), [§11.2](../../docs/reports/unified-federation.md#112-design)
- **Depends on:** [2010](2010-command-scope-wiring.md), [1009](1009-domain-clients-and-adapters.md). **This is where the two tracks join.**
- **Blocks:** web-side work in Phase 7, [5006](5006-fleet-currency.md)
- **Size:** S
- **Track:** S and C (join)

## Goal

`scope.client.domains` holds the hello's negotiated ranges for the current connection generation. `scope.domain(client)` returns a version-adapted domain client, and `client.invoke(def, args)` is typed.

## Work

- [ ] Read the hello once per connection generation for each node client (browser: the probe already fetches it; desktop: main includes the parsed `domains` in `orkestrator:nodes:gateway`). Expose `domains: ReadableSignal<NegotiatedDomains | null>`, where `null` means pre-contract.
- [ ] `NodeClient.invoke(def, args)` sends the envelope (`domain`, `version`, `critical`) and returns `ResultOf<C>`. `invokeRaw` stays for migration.
- [ ] `scope.domain(def)`: `createDomainClient` over the scope client, cached per `domains` value and rebuilt on a new generation.
- [ ] The command scope reads its own hello too (the renderer currently never parses the hello for the command node).

## Tests

- [ ] A generation change (reconnect to an upgraded backend) rebuilds domain clients; a pre-contract node gets version-0 adapters.

## Done when

- [ ] A scoped component can call `scope.domain(nodeMail)` (the pilot) against both a current and a pre-contract fake node.
