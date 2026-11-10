# Multi Review progress tail: a result can wait for the observation pass

## Task analysis

Analysed 2026-11-10 against main at 04639b12b.

Found by [0048](0048-recurring-work-qualification.md) task 2 (2026-11-10, Linux): the busy
profile's client review views timed "workflow progress after a result" on
the keyed Multi Review driver, and about one review in four took 3.7 to
4.3 s from its consolidated result to `ready`, against a ≤ 3 s budget
([recurring-work.md](../../architecture/recurring-work.md#latency-budgets)).

### Tasks

1. **Find why a consolidated result sometimes waits for the observation pass**: reproduce the 3.7 to 4.1 s backend tail deterministically and name the wake that is lost. Status: open.
2. **Fix it or accept it in the budget table**: make the result's own wake advance the workflow, or record the tail as accepted. Status: open (depends on 1).

### 1. Find why a consolidated result sometimes waits for the observation pass

**Problem.** In two live busy-profile runs (12 progress samples each, six
Multi Reviews, every slot on the loopback fake model), the
consolidated-review result reached `ready` in 94 to 216 ms in nine reviews
of twelve, but in 3705, 4083 and 3877 ms in the other three. The client's
review view showed `ready` about 200 ms after the backend (3902, 4273 and
4201 ms), so the client adds nothing material; the tail is backend-side. The
validation plan's row is bimodal the same way: about 2.4 s or about 6 s
from its result to `reviewing`, with each validation run taking 1.13 to
1.19 s and queueing under 20 ms (the one 14.9 s queue in the first run was
the host-wide test scheduler).

**Context.** 3.7 to 4.1 s is the Multi Review driver's observation interval:
`DEFAULT_OBSERVATION_MS` (3 s, `multi-review-service.ts`) plus
`stableJitterMs` of up to a third of it. A result the workflow consumed
through its own wake lands in about 100 to 200 ms. The keyed supervisor
(`workflow-supervisor.ts`) treats `result-accepted` as a dirty wake (one
trailing pass if it arrives mid-pass), but `provider-transition` and
`environment-change` are hints that are dropped while the key's pass runs.
The host ran other builds at load average 38 to 52 on 16 cores during both
runs.

**Investigation.** Not done; this file records the finding. Hypothesis, not
verified: advancing to `ready` needs both the accepted result and the end of
the consolidation session's turn. The result's dirty wake runs a pass that
sees the turn still open; the turn-end `provider-transition` hint arrives
while that pass runs and is dropped, so nothing runs until the observation
pass. A deterministic test on a manual clock (`ManualTime`) can check it:
accept the result, hold the pass, deliver the provider transition, and see
whether a trailing pass follows. The busy profile reproduces it live:
`scripts/recurring-live-ab.ts --arms candidate --busy-rounds 3
--busy-clients 1,2` (the exact command is in 0048's
[workflow client visibility evidence](0048-recurring-work-qualification.md#workflow-client-visibility-2026-11-10-linux)).

**Decisions.**

- **How to find the lost wake?**
  - **A manual-clock test of the keyed Multi Review driver that orders a result, a running pass and a turn-end transition (recommended).**
    - Pros: deterministic; becomes the regression test for task 2.
    - Cons: has to model the order the provider reports in, which the live run only implies.
  - **Instrument the live run with per-workflow wake and pass timings.**
    - Pros: shows the real order on a real stack.
    - Cons: adds diagnostics to a hot path, and the tail shows in one review of four, so it needs several runs.

### 2. Fix it or accept it in the budget table

**Problem.** The budget row "Workflow progress after a result" (≤ 3 s, p95)
is missed on the keyed driver whenever the tail occurs: p95 4.08 s (backend)
and 4.27 s (client) over 12 samples.

**Context.** The rule in [recurring-work.md](../../architecture/recurring-work.md#latency-budgets)
is that exceeding a budget must be accepted explicitly. The keyed design
drops hints mid-pass deliberately, so that a key's own writes cannot sustain
an immediate-rerun chain.

**Investigation.** Depends on task 1.

**Decisions.**

- **What to change?**
  - **Make the wake that completes a result's obligation a dirty wake, so it gets one trailing pass (recommended, if task 1 confirms the hypothesis).**
    - Pros: keeps the 3 s observation interval for idle work, and puts the tail back near 200 ms.
    - Cons: one extra pass per such transition; the supervisor's hint/dirty split has to stay bounded.
  - **Shorten the observation interval.**
    - Pros: a one-line change.
    - Cons: more provider reads for every running review, all the time, to fix a race.
  - **Accept the tail in the budget table.**
    - Pros: no code change.
    - Cons: a review sits idle for up to 4 s after its result one time in four, which the user sees.

## Related

- [0048](0048-recurring-work-qualification.md) task 2 (the measurement) and
  task 13 (Multi Review's rollback removal; its 2026-11-06 rollback timings
  were withdrawn, so this run has no rollback arm to compare against).
- [7202](7202-busy-profile-follow-ups.md) task 2: a 210 s stall after a
  validation plan, seen once and unexplained, a different symptom.
