---
id: 401
title: "Verifier session"
phase: 4
plan: "P4.1"
status: not-started
depends_on: [106]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 401 · Verifier session

- **Plan:** [P4.1 Verifier session](../goals.md#p41-verifier-session)
- **Decisions:** D7
- **Depends on:** [106](106-done-check.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A goal with no check command can still be judged by something other than the agent doing the work.

## Work

- [ ] Decide how to reuse `AgentBranchRunner` and the graph `verification-verdict@1` kind. Record the decision.
- [ ] Per-goal setting: verifier provider and model, shown with its cost.
- [ ] A failed verdict continues the loop with the reasons in an evidence frame. A verifier that cannot run pauses the goal.
- [ ] Verifier spend counts toward the token budget.

## Tests

- [ ] Pass, fail, crash and restart with fake providers.
- [ ] Verifier is read-only on every provider that enforces it.

## Done when

- [ ] A goal can end `complete` from a verdict, and the UI says which proof it had.

## Notes

This is a design change if the maintainer wants it in the first release. Change D7 in the plan first.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
