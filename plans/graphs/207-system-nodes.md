---
id: 207
title: "System nodes, version 1"
phase: 2
plan: "P2.7"
status: not-started
depends_on: [201, 203]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 207 · System nodes, version 1

- **Plan:** [P2.7 System nodes, version 1](../composable-graphs.md#p27-system-nodes-version-1)
- **Decisions:** D12, D20
- **Depends on:** [201](201-run-record-and-storage.md), [203](203-scheduling.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Side effects run in the backend, idempotently, so no agent node needs push or GitHub access.

## Work

- [ ] `prepare-environment`, reusing Build Pipeline provisioning.
- [ ] `run-validation-and-seal`, reusing the review validation service and `generate_looped_review_package`.
- [ ] `push-branch`: idempotent per commit; force-with-lease only after a code rewind.
- [ ] `open-pull-request`: pushes, then opens, updates or reopens the PR; idempotent per run and branch.
- [ ] `wait-for-checks` (D20): reads the PR monitor's `checkSummary`, waits within a bound (default 60 minutes, at most 6 hours) without polling of its own, outputs `check-summary@1`.
- [ ] `update-ticket`: column moves, comments, criteria results (`record_kanban_criteria_checks`).
- [ ] `notify`: agent mail to the coordinator or a tab.

## Tests

- [ ] Retries and restarts never repeat a side effect.
- [ ] Force-with-lease only after a code rewind.
- [ ] `wait-for-checks` returns passed, failed and pending-at-timeout.
- [ ] Ticket updates match today's pipeline lifecycle.

## Done when

- [ ] Every version 1 system node works and is idempotent.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
