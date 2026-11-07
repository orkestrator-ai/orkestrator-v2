---
id: 7006
title: "Convert git, GitHub, pull requests and changes"
phase: 7
plan: "§12 Phase 7 and Appendix E"
status: not-started
depends_on: [1008, 1010, 1011]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 7006 · Convert git, GitHub, pull requests and changes

- **Report:** [§12 Phase 7](../../docs/reports/unified-federation.md#12-migration-plan), [Appendix E](../../docs/reports/unified-federation.md#appendix-e-command-surface-by-domain), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** [1008](1008-contract-ci-job.md), [1010](1010-pilot-node-mail-and-ticket-sync.md), [1011](1011-contract-policy-and-docs.md)
- **Recommended before the web side:** [3002](3002-lib-backend-client-parameter.md) and [2011](2011-scope-domain-negotiation.md). Until they land, the domain's `lib/backend` file calls the domain client bound to the command scope.
- **Parallel with:** the other Phase 7 domain items, and all of Phases 2-6
- **Size:** L
- **Track:** C (contract)

## Domains

`git`, `pull-requests` (including the changes ledger).

## Current state (verified 2026-11-07)

- 81 registered, 54 web-referenced.
- Capability command: `changes_get_capabilities` (`commands-registry-changes.ts:190`); client cache at `lib/backend/changes.ts:129`.

## Work

Apply the conversion checklist from [1011](1011-contract-policy-and-docs.md)'s "Domain contracts" docs to every command in the domains above:

- [ ] Define each domain at version 1 (min 1) in `packages/protocol/src/contract/domains/`.
- [ ] `defineCommand` for every command, with:
  - `args` and `result` schemas;
  - `access` (workspace, admin or internal), seeded from [0006](0006-grant-scope-live-evidence.md)'s observed list and today's deny-lists;
  - `read`, checked against `isNodeReadCommand`;
  - `critical` fields, with a one-line reason each in Notes.
- [ ] Switch handlers to `register(def, handler)`.
  - Lenient handlers stay tolerant.
  - Strict (`assertOnlyKeys`) handlers become tolerant-with-critical.
  - Hand-written `commands-validation.ts` parsing is replaced by the schema where it is equivalent; keep user-facing error text.
- [ ] Fold the domain's capability command (if any) into the domain version. Keep the command registered for pre-contract clients until its register row retires.
- [ ] Web side:
  - a domain client in `apps/web/src/lib/node-scope/domains/<domain>.ts`, with a version-1 adapter and a version-0 legacy adapter that keeps today's capability gating;
  - the domain's `lib/backend` functions call it;
  - typed results replace `invoke<T>` casts.
- [ ] Move the domain's shared types from `apps/backend/src/core/models.ts` and `apps/web/src/types/index.ts` to inferred protocol types where they match (see [7010](7010-converge-models.md)).
- [ ] Classify the register rows for these domains: retired, mechanical (adapter), or unaffected. Update `version-compatibility.md`.
- [ ] Add a scenario module to [1012](1012-mixed-version-qualification.md)'s script for the domain's main flows.
- [ ] Regenerate the manifest and the adapters list; the untyped baseline falls.


## Tests

- [ ] Each converted handler passes its existing tests unchanged, apart from tests that asserted rejection of unknown keys, which now assert stripping (or the critical-field refusal).
- [ ] A domain-client test for each adapter version against fakes.
- [ ] Contract CI stage 2 ([1008](1008-contract-ci-job.md)) accepts every in-window snapshot's arguments.

## Done when

- [ ] Every command in these domains is defined, the untyped count for them is zero, and the web uses domain clients for them.
