# Workflow progress with no wake: graph-run results and Multi Review validation runs

## Task analysis

Analysed 2026-11-10 against main at c98b20e6f.

Found while fixing [7557](../../architecture/recurring-work.md#latency-budgets)
(retired 2026-11-10): Multi Review's consolidated result waited a whole
observation pass, 3 s plus jitter, about one review in four, because a result
accepted through a tool call always lands before the turn that submitted it
can end, and that turn's end raises no wake. Multi Review now polls an
accepted result's turn end on a 250 ms cadence. Graph runs read the same
kind of turn the same way and were not changed. The recorded run that proved
the fix also showed a second, smaller gap of the same kind in Multi Review:
a validation run's completion raises no wake either.

### Tasks

1. **Measure whether graph runs show the same tail**: time an agent node's accepted result to its activation completing on a busy profile, with the loopback fake model. Status: open.
2. **Fix it or accept it**: follow an accepted result's turn end on a short cadence in the graph run pass, as Multi Review does, or accept the tail in the budget table. Status: open (depends on 1).
3. **Wake a Multi Review when its validation run finishes**: the step from a validation plan to `reviewing` waits for the next observation pass after the validation commands finish. Status: open.

### 1. Measure whether graph runs show the same tail

**Problem.** A graph run's agent node may finish up to about 4 s after its
model submitted the node's last required output, against the ≤ 3 s budget
"Workflow progress after a result"
([recurring-work.md](../../architecture/recurring-work.md#latency-budgets)).
Graph-engine Multi Reviews project their run, so they would show the same
tail.

**Context.** The graph run service wakes only the run that owns an accepted
slot (`graph-run-service.ts`, `resultAccepted`). The agent branch runner
returns from a pass while the provider reports the turn running
(`agent-branch-runner.ts`, the `status === "running"` branch) and reads the
result only after the turn ends (`host.readResult`). An observing run's next
pass is `GRAPH_RUN_OBSERVATION_MS` (3 s, `graph-run-pass.ts`) plus a stable
spread of up to a third of it. Workflow sessions are not native agent
sessions, so the activity sweep never raises `provider-transition` for their
turn ends; 7557 established this for Multi Review, and graph runs create
their sessions through the same provider path.

**Investigation.** Code reading only; nothing was run. The order that
produced Multi Review's tail (acceptance, a pass that reads the turn still
running, then a silent turn end) is possible here too. Whether it shows
depends on how often that pass reads the turn before it ends, which on
Multi Review was about one result in four on a loaded host.

**Decisions.**

- **How to measure it?**
  - **A deterministic test first, on the shape of `multi-review-result-settle.test.ts`: a graph run with one agent node, a loopback provider whose turn ends silently after the output is accepted, and an observation interval longer than the wait (recommended).**
    - Pros: proves the order exists without a live run; becomes the regression test for task 2.
    - Cons: shows the tail can happen, not how often.
  - **A busy-profile run that times graph node results.**
    - Pros: gives the real frequency on a loaded host.
    - Cons: `scripts/recurring-live-ab.ts` drives no graph runs today, so it needs a new busy step.

### 2. Fix it or accept it

**Problem.** Depends on task 1.

**Context.** Multi Review's fix is in `nextDelayMs`
(`multi-review-service.ts`): while a result slot it observes is accepted
but not consumed, and for one observation interval after the acceptance, the
next pass comes after 250 ms; past that window the ordinary cadence applies,
so a model that keeps working after submitting cannot hold the fast cadence.

**Investigation.** Depends on task 1.

**Decisions.**

- **What to change if task 1 confirms the tail?**
  - **The same bounded settle cadence in the graph run pass's next-delay computation (recommended).**
    - Pros: matches Multi Review; one or two extra provider reads per result.
    - Cons: the graph run pass computes its delay from activations and memory, not from a stored record, so the accepted slots have to be found there.
  - **Raise a turn-end wake for workflow sessions (bridge or observation change).**
    - Pros: fixes every workflow owner at once, with no polling.
    - Cons: workflow sessions would have to join the native observation broker or each bridge would need a workflow-facing turn-end signal; a much larger change.
  - **Accept the tail in the budget table.**
    - Pros: no code change.
    - Cons: a graph node sits idle up to 4 s after its result some of the time.

### 3. Wake a Multi Review when its validation run finishes

**Problem.** In the recorded busy run of 2026-11-10 (Linux, loopback fake
model, after 7557's fix; command in
[0048](0048-recurring-work-qualification.md#workflow-client-visibility-2026-11-10-linux))
the validation plan's submission reached `reviewing` in 2312 to 2671 ms in
four reviews of six and in 5060 and 5069 ms in the other two, while each
validation run took 1132 to 1180 ms and queued for 7 to 17 ms. The row has
no latency budget, but every review pays it before any reviewer starts.

**Context.** While `validationRun.status` is `running`, `supervisionDemand`
(`multi-review-scheduling.ts`) answers `observe`, so the next pass is the
observation interval (3 s) plus a stable spread of up to 1 s. The pass reads
the run with `status_review_validation` (`advanceValidation`,
`multi-review-service.ts`); nothing wakes the workflow when the commands
finish. Whether a review lands on 2.4 s or 5 s depends on where the run ends
relative to that cadence.

**Investigation.** Code reading plus the run above; no test reproduces it
yet.

**Decisions.**

- **What to change?**
  - **Wake the workflow's key when the backend's validation run settles (recommended).**
    - Pros: event-driven like the other wakes; no extra polling.
    - Cons: the validation runner lives behind a backend command, so it needs a completion callback or event that reaches the Multi Review owner.
  - **Poll a running validation run on the 1 s fast cadence.**
    - Pros: a one-line change in `supervisionDemand`.
    - Cons: a command read every second for the whole run; validation plans that run minutes pay for it throughout.
  - **Leave it.**
    - Pros: no change; the row has no budget.
    - Cons: up to 4 s added to every review's start, a third of the time.

## Related

- 7557 (retired 2026-11-10; its finding and fix are recorded in
  [recurring-work.md](../../architecture/recurring-work.md#latency-budgets)).
- [0048](0048-recurring-work-qualification.md) task 2, which measured the
  Multi Review tail.
