# Efficiency upgrade milestones

This directory turns `docs/efficiency-plan.md` into independently deliverable
iterations. Complete the milestones in order unless a milestone explicitly
marks work as optional.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [0](milestone-0.md) | Baseline, instrumentation, and rollout controls | Not started |
| [1](milestone-1.md) | Static delivery and initial bundle improvements | Not started |
| [2](milestone-2.md) | Dynamic body, event-stream, and proxy compression | Not started |
| [3](milestone-3.md) | Repeated payload and polling reduction | Implemented; manual verification pending |
| [4](milestone-4.md) | Gateway replay and revision-aware synchronization | In progress — replay transport implemented |
| [5](milestone-5.md) | Multiplexed terminal WebSocket | Not started |
| [6](milestone-6.md) | Large payloads and optional connection brokerage | Not started |

## Working convention

For each milestone:

1. Record the baseline evidence before changing behavior.
2. Implement the checklist in small, reviewable commits.
3. Run focused tests while iterating and the milestone verification suite before
   completion.
4. Exercise the inactive-environment path manually.
5. Record results, decisions, and deferred items in the milestone's evidence
   section.
6. Change its status to `Complete` only after every required exit criterion
   passes.

The invariants in `AGENTS.md` and `docs/efficiency-plan.md` apply to every
milestone.
