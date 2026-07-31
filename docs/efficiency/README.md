# Efficiency upgrade milestones

This directory turns `docs/efficiency-plan.md` into independently deliverable
iterations. Complete the milestones in order unless a milestone explicitly
marks work as optional.

This table mirrors the `Status:` line of each milestone document. That document
is the source of truth; update it first, then this table.

| Milestone | Outcome | Status |
| --- | --- | --- |
| [0](milestone-0.md) | Baseline, instrumentation, and rollout controls | In progress |
| [1](milestone-1.md) | Static delivery and initial bundle improvements | Not started (see note) |
| [2](milestone-2.md) | Dynamic body, event-stream, and proxy compression | Implementation complete; real-device rollout evidence pending |
| [3](milestone-3.md) | Repeated payload and polling reduction | Implemented; manual verification pending |
| [4](milestone-4.md) | Gateway replay and revision-aware synchronization | In progress — gateway replay transport implemented |
| [5](milestone-5.md) | Multiplexed terminal WebSocket | In progress — protocol and HTTP input batching implemented |
| [6](milestone-6.md) | Large payloads and optional connection brokerage | Not started |

No milestone is `Complete`. Every one still carries unmet exit criteria, and
most of those are the manual, real-device, and constrained-link measurements
that no milestone has yet recorded.

Two documents are known to understate what has shipped, and neither checklist
has been reconciled against the code:

- Milestone 1 reads `Not started` with no checklist item ticked, but
  `perf(app): optimize loading and static delivery (#225)` landed
  `apps/web/scripts/precompress.ts`, encoding-aware static delivery with ETags
  and conditional requests, and a self-hosted lazily loaded Monaco chunk. The
  commit never touched the milestone document.
- Milestone 3 records a full evidence section and a passing verification run,
  yet none of its 67 checklist items are ticked.

Reconcile both against the code before reading either status as accurate.

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
