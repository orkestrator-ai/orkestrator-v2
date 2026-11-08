# Live check that coordinators route requests to the right workflow

From a reassessment on 2026-11-08 of the product note "Making Coordinator
intuitive and effective" (2026-10-17, written against `4abf26e4`; not in
the repository). Its routing recommendation has been built as prompt rules;
no live run has shown a real coordinator following them.

## Task analysis

Analysed 2026-11-08 against `main` at `02f55ea9b`. Task 1 was built on
2026-11-08 against `main` at `30bce6895`.

### Tasks

1. **Add a `routing` scenario to the live coordinator suite**: four plain requests, each checked for the workflow the coordinator chose. Status: done.
2. **Run it on the main platforms and record the result here**: Claude and Codex at least. Status: open.

### 1. Add a `routing` scenario to the live coordinator suite

**Problem.** Every main coordinator is told that a Build pipeline is the
default once the spec is known, that investigation goes to a prompt
environment, and that "review only" leaves auto-fix and auto-PR off unless
asked. Whether a real model does this decides whether a user's request
starts the right work without them naming a workflow. Nothing has checked
it on a real provider.

**Context.** The rules are `COORDINATOR_ENVIRONMENT_CHOICE_RULE` (#1631),
`COORDINATOR_ROUTING_RULE` and `COORDINATOR_LAUNCH_DEFAULTS_RULE` in
`packages/protocol/src/coordinator.ts`, sent in every main coordinator's
context. `start_build_pipeline` needs a `taskId` and refuses an unknown one
with "Create the ticket with create_ticket first"
(`build-pipeline-launch.ts`). A passed Verify acts on the ticket's delivery
policy in `deliverVerifiedWork`
(`build-pipeline-service-recovery.ts`): `commit-only` completes without a
PR. The live suite is `mise run test:agent:coordinator`
(`apps/desktop/scripts/dev/coordinator-live.ts`, spec
`e2e/agent-testing/coordinator-live.spec.ts`), with scenarios `read-only`,
`async`, `family`, `status`, `deliver-now`, `goal` and `peer`; none sends a
request that leaves the choice of workflow to the model.

**Investigation.** Confirmed by reading `main` at `02f55ea9b`; nothing was
run. Proposed cases, each a fresh user turn on the fixture project with no
workflow named:

1. A small, fully specified change to the fixture with a stated done
   condition (for example "add X; done when Y and the tests pass"). Expect `create_ticket`
   with acceptance criteria, then `start_build_pipeline` with that ticket and
   no `agentType`, `steps` or `reviewers`.
2. A question about the fixture that needs a run to answer, with "don't
   change anything". Expect `launch_environment` (or a job on an idle
   worker), and no Build or Multi Review.
3. "Review the branch `<fixture branch>` and tell me what needs attention."
   Expect `launch_multi_review` with `autoFix` and `autoPr` absent or false.
4. Case 1 with the ticket's delivery set to `commit-only`. Expect the Build
   to complete with no PR stage started (an end-to-end run, so slower and
   billed; see the decision below).

Assertions read the coordinator's tool calls from its transcript and the
backend snapshot (`get_project_coordinator` associations), never the
model's wording.

**Decisions.**

- **How far should each case run?**
  - **Assert the first workflow call and its arguments, then cancel; run case 4 to completion only (recommended).**
    - Pros: cases 1 to 3 cost one coordinator turn each; case 4 is the only one that needs a finished Build to prove the delivery policy.
    - Cons: cases 1 to 3 do not prove the chosen workflow then succeeds; the `status` scenario and 0742 cover that.
  - **Run every case to completion.**
    - Pros: one scenario proves routing and outcome together.
    - Cons: three extra full Builds or reviews per platform; many minutes and billed turns for little extra evidence.
- **One scenario or four?**
  - **One `routing` scenario with four ordered cases (recommended).**
    - Pros: one profile boot; matches how 1021 and 0395 plan their scenarios.
    - Cons: an early failure hides later cases unless each case records its own result first.
  - **Four scenarios.**
    - Pros: independent failures.
    - Cons: four profile boots per platform.

### 2. Run it on the main platforms and record the result here

**Problem.** A rule followed on one provider may be ignored on another.

**Context.** Platforms are run one at a time by the suite with
`--credential-source <platform>`. Grok has no login on the usual hosts
([0024](0024-coordinator-live-conformance.md) task 1).

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **Which platforms?**
  - **Claude and Codex first, the rest batched with their next full run (recommended).**
    - Pros: covers most real use for two billed runs.
    - Cons: Pi, OpenCode and Cursor stay unproved until their next run.
  - **Every platform at once.**
    - Pros: complete evidence.
    - Cons: needs every login and is billed six times.
- **What if a platform misroutes?**
  - **Record the transcript evidence here, then change the rule text only if two platforms misroute the same case (recommended).**
    - Pros: avoids tuning a shared prompt to one model's habit.
    - Cons: a single-platform misroute stays until its own fix.
  - **Add a platform-specific instruction at once.**
    - Pros: fixes that platform quickly.
    - Cons: platform-specific prompt text is what the qualification rules avoid.

## Assumptions and decisions

### How far each case runs (task 1)

Chose the recommended option: cases 1 and 3 judge the first workflow call
and the records it made, then the harness cancels the build or review; case
4 runs its build to the end. Case 2 is the one deviation: its worker is let
run to its report instead of being stopped. The worker's turn is one short
`bun run check`, and a worker stopped mid-turn still ends with a wake that
the coordinator reacts to at an unknown time, which could land inside the
next case's rows. Between cases the harness waits until the coordinator has
been idle, with nothing queued or held for it, for 20 seconds, so the wake
from a cancelled build or review is spent before the next request.

### One scenario (task 1)

Chose the recommended option: one `routing` scenario
(`apps/desktop/scripts/dev/coordinator-live-routing.ts`, orchestration in
`coordinator-live-routing-orchestration.ts`), placed before `peer` in
`COORDINATOR_LIVE_SCENARIOS` because `peer` must stay last. Each case
records its checks, plus a `<case>-finished` check, before the next starts.
A case that throws (a failed turn, a timeout) is recorded and the next still
runs; only a coordinator that never settles afterwards stops the rest, each
recorded as not run.

### Who sets `commit-only` in case 4 (task 1)

The harness sets it: once the coordinator's build has started, the harness
patches the new ticket's `sections.delivery.policy` to `commit-only`, and
Verify reads the live ticket minutes later (`currentDeliveryPolicy`). The
other option was to say "commit only, don't push or open a PR" in the
request and expect the coordinator to set the policy on `create_ticket`.
That tests a different claim (the model mapping words onto a delivery
policy, which the ticket dropdown does not even offer for `commit-only`),
and the todo's case 4 is "case 1 with the ticket's delivery set to
`commit-only`". Case 4 also checks that the coordinator, woken by the
finished build, makes no `create_pr` call (`COORDINATOR_PR_RULE`).

### What case 2 asks (task 1)

"Does this project's test suite pass right now, and how many tests does it
run? Someone has to actually run it (bun run check) to find out." A question
answerable by reading (what `/health` returns) would let a coordinator
answer from `server.ts`, which is correct behaviour and proves nothing about
routing. A Codex coordinator might still run `bun run check` in its own
read-only sandbox; that fails `investigate-delegated`, and the check's
detail names the workflow calls it made, which is the evidence task 2 needs.

### "Go ahead without checking with me" (task 1)

Every request ends with that line. Without it a coordinator may end its turn
asking which workflow to use, which is no routing choice, and nobody is
there to answer. The line names no workflow and no tool; a unit test fails
if any request mentions a pipeline, ticket, Multi Review, launch tool,
`autoFix`, `autoPr` or pull request.

### Saved defaults for the run (task 1)

As in `status`: every step and reviewer on the platform under test (the
profile is authorised for one credential) with the fewest reviewers a panel
allows, plus the Multi Review `autoFix` and `autoPr` defaults set to off.
With saved defaults off, the review workflow's own `autoFix`/`autoPr` show
what the coordinator asked for, so the case judges the record as well as the
call. The project's `coordinatorOtherEnvironments` opt-in is on only from
case 3, because the reviewed environment is the harness's. Settings,
tickets, environments and live builds and reviews are restored or removed in
cleanup.

## Needs verification

Task 2: no live run has been recorded yet. Every check of task 1 is
exercised over a scripted command transport
(`coordinator-live-routing-orchestration.test.ts`), which cannot show that
the backend commands the harness reads (`get_kanban_tasks`,
`get_build_pipeline`, `list_multi_review_workflows`) answer in the shapes
it unwraps on a real profile.

## Related

- [4900-coordinator-over-delegation-and-read-rule.md](4900-coordinator-over-delegation-and-read-rule.md),
  the opposite risk (a worker launched for a read).
- [4920-coordinator-tool-surface-live-follow-ups.md](4920-coordinator-tool-surface-live-follow-ups.md)
  task 3, launches that leave defaults alone.
- [7544-criterion-evidence-commit-and-completion-handoff.md](7544-criterion-evidence-commit-and-completion-handoff.md)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md),
  the live suite.
- [Routing](../../architecture/coordinator.md#routing)
