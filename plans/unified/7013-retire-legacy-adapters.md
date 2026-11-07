---
id: 7013
title: "Retire legacy adapters and capability commands when the floor allows"
phase: 7
plan: "§11.2 Client adapters (retirement) and §11.4"
status: not-started
depends_on: [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-11-07
---

# 7013 · Retire legacy adapters and capability commands when the floor allows

- **Report:** [§11.2](../../docs/reports/unified-federation.md#112-design), [§11.4](../../docs/reports/unified-federation.md#114-transition-pre-contract-nodes)
- **Depends on:** every Phase 7 domain item. It is also **date-gated**: it starts only when the support floor passes the first Stable release that advertises `domains`, which is at least 60 days after that release ships.
- **Size:** S per domain (rolling)
- **Track:** C (contract)

## Goal

Compatibility code leaves on schedule. Each removal is counted and justified by the register.

## Work

- [ ] When the floor passes the first Stable release with `domains`, delete every version-0 legacy adapter and the client-side capability gating it packaged. Record the release and date in Notes.
- [ ] Remove the per-domain `*_capabilities` commands when their register rows retire (counter at zero over the window, or the floor past every caller).
- [ ] From then on, apply the standing rule: adapter `v` goes when the floor passes the first Stable release with `v + 1`. Contract CI ([1008](1008-contract-ci-job.md)) flags any adapter that is now unreachable.
- [ ] Move each retired row to the register's "Retired" table.

## Done when

- [ ] No version-0 adapter remains. After that, the item stays as a standing rule; mark it `done` with a note that the CI job owns future retirements.
