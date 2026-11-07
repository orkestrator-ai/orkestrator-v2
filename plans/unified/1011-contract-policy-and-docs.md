---
id: 1011
title: "Contract policy, ratchet and documentation"
phase: 1
plan: "§12 Phase 1.6 and §14 (new commands)"
status: not-started
depends_on: [1006]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 1011 · Contract policy, ratchet and documentation

- **Report:** [§12 Phase 1](../../docs/reports/unified-federation.md#12-migration-plan), [§14 Risks](../../docs/reports/unified-federation.md#14-risks) ("Long migration collides with ~16 new commands a day")
- **Depends on:** [1006](1006-contract-manifest-generator.md)
- **Blocks:** Phase 7
- **Size:** S
- **Track:** C (contract)

## Goal

From this item on, every new command uses `defineCommand`, and the untyped surface only shrinks. Agents can find the rules.

## Work

- [ ] Ratchet: the manifest generator records the count of `untyped` commands per domain in `contracts/untyped-baseline.json`. `contract:check` fails when any count rises, and the baseline can be regenerated only downward. Follow the shrink-only model of `tests/source-guards/baseline.ts` (`compareWithBaseline`).
- [ ] New section "Domain contracts" in `docs/architecture/version-compatibility.md`. It covers:
  - domains and versions, and when to bump;
  - tolerant reader and critical fields;
  - typed errors;
  - adapters and their retirement;
  - the manifest, snapshots and CI job;
  - how to add a command.
- [ ] Add a row to the root `AGENTS.md` "Read before changing these areas" table: "Backend commands (`commands-registry*.ts`, `packages/protocol/src/contract/**`) → version-compatibility.md#domain-contracts".
- [ ] Add a short note in the backend command registry file header pointing to the same section.

## Done when

- [ ] A PR that adds a string-registered command fails `contract:check` with a message pointing to the docs.
