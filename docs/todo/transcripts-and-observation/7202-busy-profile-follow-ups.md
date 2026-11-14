# Busy profile follow-ups

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b` (first analysed 2026-11-06 at
`ee2cc8423`), from the busy-profile run of
[0048](0048-recurring-work-qualification.md) task 1 (see its
[busy profile evidence](0048-recurring-work-qualification.md#busy-profile-2026-11-06-linux)).

### Tasks

1. **Approve a command from the CLI**: `orkestrator session interactions resolve` cannot approve an approval that has no questions. Status: done (2026-11-10).
2. **One Multi Review stalled 3.5 minutes after its plan was accepted**: seen once in the smoke run, not in 33 later reviews nor in 18 more on 2026-11-10; recurred on 2026-11-11 and on 2026-11-14 on macOS (see Assumptions and decisions). Status: open (evidence recorded; read it and close or keep).

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
`public_action` (`result: "applied"`) and its turn finished. Checked on 2026-11-10: the backend validates every resolution against the
interaction (`isAgentInteractionResolution` in
`packages/protocol/src/agent-interactions.ts`), and an `answer` that leaves a
required question unanswered is refused as `invalid-input` (exit 2) before it
reaches the provider. An interaction whose questions are all optional
accepts it, as the renderer does when the user skips them.

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

Rerun on 2026-11-10 (Linux, beelink2, 16 cores, a host shared with other
builds: load average 8 to 20 during the runs, 57 just after), on this
branch's base `04639b12b`, with headless `dev:test` profiles of one local
fixture environment, only the Pi toolchain, no agent credentials, the
reachability check off and every model call on the driver's loopback fake
model:

```bash
env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
  mise exec -- bun scripts/recurring-live-ab.ts --arms candidate --repeats 1 \
  --settle-ms 30000 --window-ms 30000 --sample-ms 30000 --freshness-probes 0 \
  --fixture-environments local --agent-platforms pi --busy-rounds 6 \
  --busy-clients 0 --busy-environments 10 --keep-profiles --profile-prefix q7202f007
# then the original smoke shape: both arms, a fresh profile's first rounds, clients
#   --arms candidate,rollback --busy-rounds 2 --busy-clients 0,1,2 --profile-prefix q7202g007
```

| Run | Reviews to `ready` | Launch to `ready` | Validation plan to `reviewing` | Validation run: queued / command / whole (ms) |
| --- | --- | --- | --- | --- |
| Keyed, 6 rounds, no clients | 6 of 6 | 5.1 to 8.9 s | 2.2 to 6.1 s | 9 to 19 / 13 to 33 / 1104 to 1184 |
| Keyed, 0 to 2 clients | 6 of 6 | 5.0 to 8.7 s | 2.2 to 5.7 s | 7 to 22 / 12 to 18 / 1096 to 1247 |
| Rollback, 0 to 2 clients | 6 of 6 | 14.4 to 19.1 s | 5.3 to 8.6 s | 8 to 22 / 23 to 36 / 1124 to 1179 |

The stall did not recur. Every round kept its obligations (held turn,
queued prompt, approval, mail, review; no duplicated dispatch). Each run
still exited 1, because the driver's `workflow-sample` check failed in every
round on "missing or ambiguous submit_review_preparation -> reviewing" while
every review reached `ready`; that is a sampling mismatch in the driver,
filed as 7558 (retired 2026-11-11): these reruns predate #2063, which
dropped the build-pipeline-only `submit_review_preparation` pairing
(`scripts/recurring-live-ab-busy.ts`, pinned by
`tests/unit/recurring-live-ab-busy.test.ts`); a 150-round busy run on
2026-11-11 at `83731af28` recorded no `workflow-sample` failure in 150
reviews. The first
attempt refused to start the busy phase ("needs the fixture's ready local
environment") only because the worktree had no CLI build
(`packages/cli/dist`); `mise run build:cli` fixed it. All four kept profiles
were reset with `dev:reset` afterwards (no profile process left), and nothing
was inspected in them because nothing stalled.

**Decisions.**

- **How to find the cause?**
  - **Rerun the busy phase with `--keep-profiles` until the stall recurs, then read the validation run's `queuedMs` and the backend log around it (recommended).**
    - Pros: no code change; the driver already records what separates the two causes.
    - Cons: it may not recur; a busy host makes the queue cause likelier, an idle one hides it.
  - **Treat it as the host queue and close it.**
    - Pros: no more runs.
    - Cons: unproved; a missed wake would be a real driver bug.

## Assumptions and decisions

### Task 1: the backend owns the empty-answer check

Chose the recommended option: `session interactions resolve` no longer
refuses `--action answer` without `--choose` or `--text`
(`packages/cli/src/client/commands/session.ts`). The backend check was
confirmed first and is pinned by
`apps/backend/src/core/public-api/public-api-interaction-empty-answer.test.ts`:
an empty answer approves a command approval (`questions: []`) and is refused
as `invalid-input` (exit 2) for an interaction with a required question,
before the provider sees it. `packages/cli/tests/interaction-resolve-command.test.ts`
covers the CLI side. `--choose`/`--text` with any other action is still
refused client-side. The CLI help and
[cli-testing.md](../../development/cli-testing.md#questions-and-approvals)
say how to approve.

### Task 2: rerun, no recurrence, left open

Followed the recommended option (rerun with `--keep-profiles`). 18 more
reviews, both arms, 0 to 2 clients, the first rounds of fresh profiles
included, on a busy host: no stall, every validation run queued under 25 ms.
The task stays open because the cause is still unproved, and closing it as
the host queue is the option the file rejects. What remains: keep rerunning
the busy phase on a loaded host (other worktrees' suites running) until a
review's plan-to-`reviewing` step exceeds about 30 s, then read that
review's `validationRuns` entry and the kept profile's backend log before
resetting it. A large `queuedMs` means the host test queue; a small one
means a missed wake.

### Task 2: a recurrence on 2026-11-11

Recorded during to-do 7562's reproduction run, not a run for this task:
150 busy rounds (0 to 2 clients, 10 environments, 2,500-file bursts) on
beelink2 at `83731af28`, with `--keep-profiles`, on a host shared with other
worktrees' builds. Two of its 150 reviews waited: one review's validation
plan took 627,639 ms to `reviewing` (launch to `ready` 630,810 ms), with that
validation run at 623,450 ms queued, 16 ms of command and 624,533 ms in all;
another run queued 71,309 ms (72,461 ms in all). Every other run queued under
5.1 s, most under 25 ms. The kept profile's backend log had nothing about
the review or its validation run around those rounds (no slow command for
it, one 254 ms main-database commit in the whole run). By this task's own
criterion, a large `queuedMs` means the host test queue: the command waited
behind other worktrees' suites in the host-wide scheduler, and no missed
wake shows. What is left is that judgement: close the task as the host
queue, or keep it for a wake that the queue would hide.

### Task 2: a second recurrence on 2026-11-14 (macOS)

Recorded during to-do 7562 task 5's APFS run (retired 2026-11-14; its
results are in [storage](../../architecture/storage.md#busy-soak-disk-waits-by-filesystem)),
not a run for this task: 40 busy rounds without clients (10 environments,
2,500-file bursts) on mini (macOS 27.2) at `dc90609bf`, while other
worktrees' `bun test` suites ran on the same host. One of its 40 reviews
waited: launch to `ready` 526,638 ms, its validation plan to `reviewing`
524,162 ms, with that validation run at 520,285 ms queued, 18 ms of command
and 521,405 ms in all. The other 39 runs queued 15 to 33 ms (median 17 ms).
The backend log had no slow command and no stall line around it. By this
task's criterion that is the host test queue again, now on a second host and
platform.

## Related

- [0048](0048-recurring-work-qualification.md) task 1: the busy profile run.
- 7558 (retired 2026-11-11): the driver's review-preparation sample, found by the task 2 reruns and already fixed on `main` by #2063.
