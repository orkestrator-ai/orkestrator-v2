---
id: 7011
title: "Typed backend events in the contract"
phase: 7
plan: "§11.1 events and §11.2 defineEvent"
status: not-started
depends_on: [1002, 1006]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 7011 · Typed backend events in the contract

- **Report:** [§11.1](../../docs/reports/unified-federation.md#111-where-skew-actually-is), [§11.2](../../docs/reports/unified-federation.md#112-design), [§6.4](../../docs/reports/unified-federation.md#64-events-must-carry-their-node)
- **Depends on:** [1002](1002-contract-primitives.md), [1006](1006-contract-manifest-generator.md)
- **Parallel with:** all other Phase 7 items and Phases 2-6
- **Size:** M
- **Track:** C (contract)

## Goal

Every backend event has one definition with a payload schema and a domain, is listed in the manifest, and is received through a typed `listen(def, handler)`.

## Current state (verified 2026-11-07)

- `BackendEmit = (event: string, payload: unknown) => void` (`commands-context.ts:23`).
- There is no central list of event names. About 29 literal `emit("…")` names exist, plus constants (for example `BACKEND_PROFILE_CHANGED_EVENT`, `ENVIRONMENT_ATTENTION_EVENT`). The report's ~45 includes dynamic names; recount from the manifest.
- `RESOURCE_KINDS` (`packages/protocol/src/resource-events.ts:12-97`, 28 kinds) is already a tolerant reader.
- Relay rules: `UNRELAYABLE_EVENT_PREFIXES` (`packages/protocol/src/node-events.ts:39`).

## Work

- [ ] `defineEvent` for each event, starting with `resource-changed`, `environment-attention` and the native agent activity events.
- [ ] Typed `emit(def, payload)` on the backend, validating in development and tests only. Dynamic names (for example per-terminal `terminal-output-<key>`) are defined as event families with a name pattern.
- [ ] Add events to the manifest. The untyped-events count joins the shrink-only baseline from [1011](1011-contract-policy-and-docs.md).
- [ ] `NodeClient.listen(def, handler)` gives typed payloads; the web side uses it in scoped stores.

## Done when

- [ ] Every emitted event is defined, and `BackendEmit` accepts only definitions (string emits removed).
