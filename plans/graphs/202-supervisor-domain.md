---
id: 202
title: "Supervisor domain"
phase: 2
plan: "P2.2"
status: not-started
depends_on: [201]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 202 · Supervisor domain

- **Plan:** [P2.2 Supervisor domain](../composable-graphs.md#p22-supervisor-domain)
- **Decisions:** none
- **Depends on:** [201](201-run-record-and-storage.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Graph runs are driven by the keyed workflow supervisor like the other workflow domains.

## Work

- [ ] Add `graph-run` to `KEYED_SCHEDULING_DOMAINS` (`workflow-supervisor.ts`), covered by `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`.
- [ ] An obligation classifier for run records; one key per run.
- [ ] Wake on the existing reasons; `result-accepted` wakes only the owning run.
- [ ] Safety discovery registers runs a wakeup missed.

## Tests

- [ ] Discovery registers a run whose wakeup was lost.
- [ ] An accepted result wakes only its run.
- [ ] The rollback switch disables the domain.

## Done when

- [ ] Runs advance after backend restarts without a renderer.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
