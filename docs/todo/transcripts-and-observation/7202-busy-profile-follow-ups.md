# Busy profile follow-ups

## Task analysis

Analysed 2026-11-06 against `main` at `ee2cc8423`, from the busy-profile run of
[0048](0048-recurring-work-qualification.md) task 1 (see its
[busy profile evidence](0048-recurring-work-qualification.md#busy-profile-2026-11-06-linux)).

### Tasks

1. **Approve a command from the CLI**: `orkestrator session interactions resolve` cannot approve an approval that has no questions. Status: open.
2. **One Multi Review stalled 3.5 minutes after its plan was accepted**: seen once in the smoke run, not in 33 later reviews. Status: open (needs reproduction).

### 1. Approve a command from the CLI

**Problem.** A pending command approval (Pi under an `ask` execution policy,
`kind: "command-approval"`, `actions: ["answer", "deny", "cancel"]`,
`questions: []`) can be denied or cancelled from the CLI but not approved.
`session interactions resolve --action answer` is refused with "--action
answer needs --choose or --text", and an approval has no question to choose
for. The public action itself accepts it: `session.interaction.resolve` with
`action: "answer"` and no answers approves ("answer approves an approval or
answers questions", `packages/protocol/src/public-api-inputs.ts`), which is
how the busy phase answers its approvals.

**Context.** The check is client-side, in the `resolve` command's `run`
(`packages/cli/src/client/commands/session.ts`, "`--action answer needs
--choose or --text`"). `approve-for-session` is only offered when a rule can
be remembered, so for a plain command approval `answer` is the only approving
action. A CLI user, an agent driving the CLI, or a script without gateway
access has no way to let a parked command run.

**Investigation.** Found while writing the busy phase; reproduced on a
disposable profile on 2026-11-06: the CLI refused `--action answer` for a
Pi command approval, and the same interaction was approved through
`public_action` (`result: "applied"`) and its turn finished. Not checked: how
the backend answers `answer` with no answers for an interaction that does
have questions (whether it refuses, or submits an empty answer).

**Decisions.**

- **How should the CLI approve?**
  - **Let `answer` go without answers and leave validation to the backend, after checking the backend refuses an empty answer to a question (recommended).**
    - Pros: one rule, owned by the backend, which knows the interaction's questions; matches the public action's own description.
    - Cons: needs the backend check first; a mistyped command on a question interaction is refused by the server rather than the client.
  - **Read the interaction first and allow an empty `answer` only when it has no questions.**
    - Pros: the client keeps its early, specific error.
    - Cons: an extra read per resolve, and a race with a replaced interaction (the revision check covers it).
  - **Add an `--action approve` alias that sends `answer` with no answers.**
    - Pros: reads naturally.
    - Cons: a CLI-only action name the public contract does not have.

### 2. One Multi Review stalled 3.5 minutes after its plan was accepted

**Problem.** In the first smoke run of the busy phase (one round per client
count, on the branch that added the phase), the first round's Multi Review took 213 s from
launch to `ready`, 210 s of it between the fake model getting its validation
plan's result back and the review leaving `preparing`. Every later review
(the other two of that run, two in a repro, 17 in the recorded run and 12 in
its client run, both arms) took 4.7 to 9.5 s on the keyed drivers and 14 to
18 s on the rollback drivers, with at most 8.3 s for the same step.

**Context.** That step includes the validation run, which runs the plan's one
read-only command (`git rev-parse HEAD`) through the review validation worker.
The worker queues commands in the host-wide test scheduler
(`packages/protocol/src/node/host-test-scheduler.ts`, a SQLite queue under the
temporary directory shared by every worktree on the host), and this host was
running other worktrees' test suites (three running jobs in that queue soon
after). In the recorded run every validation run's command queued 4 to 5 ms
and the run took about 1.1 s.

**Investigation.** The smoke run's profile was reset by the driver before its
logs or its validation records were read, so the cause is unknown: a queue
wait behind another worktree's tests fits the size of the gap, but a missed
wake recovered by a slower path would look the same from outside. The driver
now records each validation run's queue, command and whole-run times
(`validationRuns` in the busy result), so a recurrence can be told apart.

**Decisions.**

- **How to find the cause?**
  - **Rerun the busy phase with `--keep-profiles` until the stall recurs, then read the validation run's `queuedMs` and the backend log around it (recommended).**
    - Pros: no code change; the driver already records what separates the two causes.
    - Cons: it may not recur; a busy host makes the queue cause likelier, an idle one hides it.
  - **Treat it as the host queue and close it.**
    - Pros: no more runs.
    - Cons: unproved; a missed wake would be a real driver bug.

## Related

- [0048](0048-recurring-work-qualification.md) task 1: the busy profile run.
