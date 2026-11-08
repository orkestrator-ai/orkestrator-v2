# Live check that coordinators route requests to the right workflow

From a reassessment on 2026-11-08 of the product note "Making Coordinator
intuitive and effective" (2026-10-17, written against `4abf26e4`; not in
the repository). Its routing recommendation has been built as prompt rules;
no live run has shown a real coordinator following them.

## Task analysis

Analysed 2026-11-08 against `main` at `02f55ea9b`.

### Tasks

1. **Add a `routing` scenario to the live coordinator suite**: four plain requests, each checked for the workflow the coordinator chose. Status: open.
2. **Run it on the main platforms and record the result here**: Claude and Codex at least. Status: open (depends on 1).

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

## Needs verification

All of it: no live run yet.

## Related

- [4900-coordinator-over-delegation-and-read-rule.md](4900-coordinator-over-delegation-and-read-rule.md),
  the opposite risk (a worker launched for a read).
- [4920-coordinator-tool-surface-live-follow-ups.md](4920-coordinator-tool-surface-live-follow-ups.md)
  task 3, launches that leave defaults alone.
- [7544-criterion-evidence-commit-and-completion-handoff.md](7544-criterion-evidence-commit-and-completion-handoff.md)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md),
  the live suite.
- [Routing](../../architecture/coordinator.md#routing)
