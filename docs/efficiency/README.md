# Efficiency upgrade milestones

This directory turns `docs/efficiency-plan.md` into independently deliverable
iterations. Complete the milestones in order unless a milestone explicitly
marks work as optional.

This table mirrors the `Status:` line of each milestone document. That document
is the source of truth; update it first, then this table.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [0](milestone-0.md) | Baseline, instrumentation, and rollout controls | In progress |
| [1](milestone-1.md) | Static delivery and initial bundle improvements | Implemented; manual verification pending |
| [2](milestone-2.md) | Dynamic body, event-stream, and proxy compression | Implementation complete; real-device rollout evidence pending |
| [3](milestone-3.md) | Repeated payload and polling reduction | Implemented; manual verification pending |
| [4](milestone-4.md) | Gateway replay and revision-aware synchronization | Implemented; manual soak verification pending |
| [5](milestone-5.md) | Multiplexed terminal WebSocket | In progress — protocol and HTTP input batching implemented |
| [6](milestone-6.md) | Large payloads and optional connection brokerage | Not started |

No milestone is `Complete`. Every one still carries unmet exit criteria, and
most of those are the manual, real-device, and constrained-link measurements
that no milestone has yet recorded.

Milestones 1 and 3 were reconciled against PRs #225 and #237 and current main on
July 31, 2026. Their implemented behavior and automated checks are now marked in
the milestone documents. Device, Tailscale, visual, inactive-environment, and
other explicitly manual verification remain open; Milestone 1 also awaits final
full-suite signoff, and Milestone 3 still needs its terminal decoding CPU
comparison.

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
