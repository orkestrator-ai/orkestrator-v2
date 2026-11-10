# Live check that coordinators route requests to the right workflow

From a reassessment on 2026-11-08 of the product note "Making Coordinator
intuitive and effective" (2026-10-17, written against `4abf26e4`; not in
the repository). Its routing recommendation has been built as prompt rules;
the repair round below now supplies a complete Cursor routing pass and a
live Pi review pass, with other provider findings still open.

## Task analysis

Analysed 2026-11-08 against `main` at `02f55ea9b`. Task 1 was built on
2026-11-08 against `main` at `30bce6895`. Task 4 was built on 2026-11-10
against `main` at `04639b12b`.

### Tasks

1. **Add a `routing` scenario to the live coordinator suite**: four plain requests, each checked for the workflow the coordinator chose. Status: done.
2. **Run it on the main platforms and record the result here**: Claude and Codex at least. Status: done (all five main platforms exercised and recorded below; Cursor qualified, other provider findings remain open).
3. **Decide what "review this branch" should start**: both platforms reviewed the diff themselves instead of launching a Multi Review. Status: open (the user's decision).
4. **Stop a coordinator restarting a build the user cancelled**: Codex restarted case 1's cancelled build. Status: done (the cancel notice and refusals now say it is the user's decision, the routing scenario checks the wake, and a loopback fake-model run passed; the backend test failures the full suite tied to it were repaired); whether Codex now obeys needs a billed run (Needs verification).

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

**Investigation.** Run on 2026-11-08 against `main` at `30bce6895` plus
this change, with
`mise run test:agent:coordinator --credential-source <platform> --scenario routing`
(one disposable profile each, stopped and reset by the runner). Results from
each summary's checks and tool-call names (`output/agent-testing/<profile>/coordinator/<platform>-routing.json`):

| Case | Claude (`qa-coordinator-claude-b6c52667`, 5.5 min) | Codex 0.167.0 (`qa-coordinator-codex-b8dab28b`, 6.5 min) |
| --- | --- | --- |
| `build` | Passed: `create_ticket`, then `start_build_pipeline` on that ticket, no overrides | Passed, same calls |
| `investigate` | Passed: one `launch_environment` | Passed: one `launch_environment` |
| `review` | **Failed**: `list_environments`, `get_worker_changes`, then an answer; no Multi Review | **Failed**: `list_environments`, `get_worker_changes`, `launch_job`; no Multi Review |
| `delivery` | Passed: build `complete` under `commit-only`, no PR session, no `create_pr` | Routing passed; **build failed** in its review stage ("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account"), which is [7546](7546-build-review-row-pins-unoffered-codex-model.md), not routing |

No interaction reached the harness on either platform, and every mail-tile
check passed. The first Codex attempt (23:18 UTC) produced no verdict:
`test:logged`'s five-minute no-output watchdog stopped it, because the
scenario printed only from inside a wait longer than a minute. It now prints
a content-free line at each case's start and end.

Codex's run also showed task 4: after the harness cancelled case 1's build,
the coordinator's wake turn called `get_build_pipeline`,
`restart_build_pipeline_step` and then `start_build_pipeline` again. The
restarted build ran beside case 4 until cleanup and failed on the same
review model.

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

### 3. Decide what "review this branch" should start

**Problem.** Asked to "review the work on the branch … and tell me what needs
attention", both Claude and Codex read the change themselves
(`get_worker_changes`), and Codex also ran a `launch_job` on the environment.
Neither launched a Multi Review. The case was written expecting one.

**Context.** No rule says a user's review request is a Multi Review.
`COORDINATOR_ENVIRONMENT_CHOICE_RULE` mentions Multi Review only as the
coordinator's own next step for a prompt environment's finished work, and
the Scope line keeps short reads with the coordinator, which
[4900](4900-coordinator-over-delegation-and-read-rule.md) considers
softening further. The reviewed change was one uncommitted file, which a
coordinator can read in one call. Task 2's rule ("change the rule text only
if two platforms misroute the same case") is met, but only if the case's
expectation is right, which is a product choice.

**Investigation.** Evidence in task 2. Not tried: a larger change, which
might be routed differently.

**Decisions.**

- **What should a plain review request start?**
  - **A Multi Review, stated as a rule (recommended).**
    - Pros: the user gets the reviewer panel, consolidation and Fix they configured, and the result is a durable workflow they can see; matches the case as written.
    - Cons: one more sentence in a context every turn pays for (the main block is held under 9,000 characters), and more expense for a request a single read could answer.
    - Text to add to `COORDINATOR_ENVIRONMENT_CHOICE_RULE`: "When the user asks for a review of a branch or an environment's work, launch_multi_review on that environment rather than reviewing it yourself."
  - **Leave the rule; let the coordinator choose by size.**
    - Pros: no prompt change; a one-file read stays cheap.
    - Cons: the user gets a different kind of review depending on the model; the `review` case would have to accept a coordinator's own review and lose its assertion.

### 4. Stop a coordinator restarting a build the user cancelled

**Problem.** A build the user cancels wakes its coordinator, and Codex's
coordinator started it again. A user cancel should end the work.

**Context.** The cancel came from `cancel_build_pipeline`, the same command
the pipeline's Cancel button sends. A coordinator can send it too, and the
pipeline records only `cancelledAt` and the error `Build cancelled`, not who
cancelled.

**Investigation.** Seen once, on Codex (task 2). Not seen on Claude. Read on
2026-11-10 at `04639b12b`: the wake was not a cancel at all.
`buildPipelineStatus` reported a cancelled build as `failed` (headline
"failed", detail "Error: Build cancelled"), the same notice as a crash, closed
with the handoff rule. It did leave out the restart tool. But the coordinator's
own `restart_build_pipeline_step` refused a cancelled build with "This build
pipeline was cancelled, so it cannot be restarted. Start a new build if the
work is still wanted." Codex's sequence (`get_build_pipeline`,
`restart_build_pipeline_step`, `start_build_pipeline`) is that refusal
followed literally. `get_build_pipeline` showed phase `failed` and the error,
with nothing marking it as a cancel.

**Decisions.**

- **Where to stop it?**
  - **Word the cancelled notice as the user's decision and tell the coordinator not to restart it unless asked (recommended).**
    - Pros: one place, every platform; keeps a coordinator able to restart a build that failed on its own.
    - Cons: still a prompt, so a model can ignore it.
  - **Refuse `start_build_pipeline` and `restart_build_pipeline_step` from a coordinator on a ticket whose last build the user cancelled.**
    - Pros: holds whatever the model does.
    - Cons: needs a way for the user to lift it, and blocks a coordinator the user then asks to retry.

## Assumptions and decisions

### How far each case runs (task 1)

Chose the recommended option: cases 1 and 3 judge the first workflow call
and the records it made, then the harness cancels the build or review; case
4 runs its build to the end. Case 2 is the one deviation: its worker is let
run to its report instead of being stopped. The fixture worker's turn is one short
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
run? Someone has to actually run the fixture command (bun run check) to find out." A question
answerable by reading (what `/health` returns) would let a coordinator
answer from `server.ts`, which is correct behaviour and proves nothing about
routing. A Codex coordinator might still run the fixture command `bun run check` in its own
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

### Not changing the rule text yet (task 2)

Both platforms misrouted the `review` case, which task 2's rule says
justifies a rule change. The rule was left as it is because the case's
expectation is itself a product choice (task 3): a coordinator reading a
one-file change is what the Scope line allows.

### Review repairs: delegation evidence and case boundaries (task 1)

Chose a successful worker tool call plus exactly one backend delegation request
whose environment, tab and request timestamp were absent before the case.
For a reused tab, the call must name that delegation's environment and tab.
Waiting on that request's completed state, wake and idle worker prevents a
late report crossing the case boundary. The observer reads the delegation's
actual tab. The alternative, counting new environment associations, is simpler
but cannot prove a reused worker started a new investigation.

Chose stable message IDs and per-poll accumulation for case transcripts,
including delivery wakes and revisions. Collection fails on a projection gap,
missing identity or exceeded budget; the alternative, slicing by a prior row
count, loses evidence once the bounded projection rolls. Instant turns also
use new message IDs as evidence of progress. The regression transport exercises
failed launches, delayed reports on reused tabs and rolling 200-row windows.

### Repair-round live qualification (task 2, 2026-11-09)

Ran the routing scenario through the repository-owned isolated runner with
Claude, Codex, Pi, OpenCode and Cursor selected. The command is
`mise run test:logged -- --name routing-live -- mise run test:agent:coordinator --credential-source claude --credential-source codex --credential-source pi --credential-source opencode --credential-source cursor --scenario routing`.
Each platform owns a disposable fixture profile; results below refer only to
observed checks, not the case-edge progress messages.

- Claude (`qa-coordinator-claude-0100c814`, 359,737 ms): build, investigation
  delegation/report/wake and commit-only delivery passed. Review failed
  `review-launched` and `review-auto-actions-off`: no Multi Review was
  launched. The profile was stopped and reset by the runner.
- Codex (`qa-coordinator-codex-8dd0e54b`, 423,156 ms): build and investigation
  passed. Review launched a job rather than Multi Review, failing all three
  review verdicts. Delivery failed because its review session selected
  `gpt-5.4`, unsupported for the ChatGPT account (7546). The profile was
  stopped and reset by the runner.
- Pi (`qa-coordinator-pi-13f29ccd`, 651,088 ms): build, investigation and all
  three review verdicts passed. Exactly one Multi Review was associated with
  the named environment, with auto-fix and auto-PR absent/off. This supplies
  the previously missing live review evidence. Delivery failed because its
  review returned no required structured result. The profile was stopped
  and reset by the runner.

- OpenCode (`qa-coordinator-opencode-3b006570`, 186,467 ms): no ticket,
  pipeline, worker delegation or Multi Review was created. All four cases
  failed their required workflow checks; delivery could not start. The
  content-free tool summary contains reads, environment/tab listings and a
  diff read, with no workflow mutations. The profile was stopped and reset.

- Cursor standalone rerun (`qa-coordinator-cursor-a44ee894`, 497,015 ms):
  **passed every routing check**, including the real Multi Review with
  auto-actions off, investigation report/wake, and commit-only delivery with
  no PR stage or coordinator PR. The logged command exited 0 in 504.6 s.
  The profile was stopped and reset. Its content-free verdict is
  `output/agent-testing/qa-coordinator-cursor-a44ee894/coordinator/cursor-routing.json`.

The five-platform logged command exited 1 after its 1,800,000 ms group
deadline interrupted Cursor's first build case. All five profiles were
stopped and reset. That initial Cursor attempt
(`qa-coordinator-cursor-36b75697`) wrote no scenario verdict and is
incomplete. The failure log is
`/tmp/orkestrator-test-run.gPhh9i/routing-live.log.gz`; the aggregate is
`output/agent-testing/qa-coordinator-2026-11-09T00-48-57-179Z/summary.json`.
Cursor was then rerun alone with
`mise run test:logged -- --name routing-cursor-live -- mise run test:agent:coordinator --credential-source cursor --scenario routing`
so the other platforms did not consume its outer deadline. For future billed
qualification, use one platform per logged command: the live runner budgets
individual scenarios, but the outer logged group has one shared deadline.

Claude began before the repair commit and Codex before the clean rebase;
their loaded code included the repaired collector and delegation-request
checks. The branch was rebased to `1000c335a` while the runner progressed
to Pi; later profiles built from that tree.
The repair's deterministic validation passed: the exact failed default
command (`mise run test`, via `test:logged`, 542.2 s), focused routing and
shared orchestration/observer suites, scripts typechecking, changed-file
lint and repository format check. No passing full static suite was repeated.

### Where the cancel is stopped (task 4)

Chose the recommended option, the wording, in three places a coordinator reads
on the way to a restart:

- The status wake (`coordinator-build-pipeline-status.ts`): a cancelled build
  is its own `cancelled` notice (tone `info`, keyed per `cancelledAt`, so a
  build restarted from the UI and cancelled again is news again), never
  `failed`. Its detail says the build was stopped on purpose, that a cancel the
  coordinator did not make itself is the user's decision, and not to restart,
  resume or rebuild it or start another build for the ticket unless the user
  asks. It offers only `get_build_pipeline`. The error line stays only when
  stopping every agent could not be confirmed. A cancelled Multi Review's
  notice says the same about launching it again.
- The refusals: `restart_build_pipeline_step` and `resume_build_pipeline` on a
  cancelled build say the same, instead of inviting a new build.
- `get_build_pipeline` (and every workflow summary) shows `cancelledAt`.

The other option, refusing `start_build_pipeline` and restarts on a ticket
whose last build the user cancelled, holds whatever a model does, but needs a
way for the user to lift it and blocks a coordinator the user then asks to
retry; it also cannot tell a user's cancel from the coordinator's own. Left
for a later decision if the billed run shows a model ignoring the wording.

### Who cancelled (task 4)

The notice does not name who cancelled: the pipeline does not record it, and
recording it means a new argument on `cancel_build_pipeline`'s backend
contract (a protocol change) or an in-memory mark that a restart or another
node would lose. The wording instead tells the coordinator how to tell: if it
did not cancel the build itself, the user did. That is true whoever sent the
cancel, and costs no contract change.

### How the cancel is checked (task 4)

The routing scenario's `build` case already cancelled its build; it now also
judges the wake that follows. `build-cancel-notice` requires one `cancelled`
notice per cancelled build, injected and carried into a transcript row after
the cancel; `build-cancel-respected` requires no `start_build_pipeline`,
`restart_build_pipeline_step` or `resume_build_pipeline` call in the rows after
the cancel, no new build association, and the build still cancelled. Neither
runs when the case started no build (`build-pipeline-started` has failed
already). The scripted-transport test covers a coordinator that restarts and
rebuilds, and a notice that never arrives.

Live evidence uses a loopback fake model, as the ticket requires (no billed
turns, no logins): `mise run test:agent:coordinator:routing-fake` runs that
same case, through `runRoutingScenario`, with a Pi coordinator on a scripted
model on a credential-free profile. The fake answers a wake with one line
whatever it says, and counts what the wake said. So the run proves the real
backend sends the new notice into the coordinator model's prompt and that
nothing in the product restarts the build; it cannot prove a real model obeys.

Run on 2026-11-10 on this branch (`f7d993111` plus the fake-model harness),
each through `mise run test:logged`, on beelink (Linux, headless, no Docker):

- `mise run test:agent:coordinator:routing-fake`, profile
  `qa-coordinator-routing-fake-9891a106`: **passed** (logged command exit 0,
  52.6 s; the case 39.6 s; Playwright 1 expected, 0 skipped). Every check
  passed: the five `build-*` routing checks, `build-cancel-notice` ("1
  cancelled notices (1 carried into a wake)") and `build-cancel-respected`
  ("no workflow calls after the cancel; 0 new builds; 1 of 1 still
  cancelled"), `build-finished` and `no-user-action`. The tier reported for
  Pi was `enforced`. The fake served 6 completions, refused none, called
  `get_launch_options`, `create_ticket` and `start_build_pipeline` once each,
  parked the build's Pi turn once and saw it aborted by the cancel, and saw
  exactly one wake: cancelled, the user's decision, no rebuild, no restart
  offered. Summary:
  `output/agent-testing/qa-coordinator-routing-fake-9891a106/coordinator-routing-fake/pi-routing-build.json`.
- Control, the same command with only the five backend files of this change
  put back to `main` (`04639b12b`) for the run and restored afterwards,
  profile `qa-coordinator-routing-fake-30c201cf`: **failed as expected**
  (exit 1). `build-cancel-notice` failed with "0 cancelled notices (0 carried
  into a wake), other states: failed", and the fake's one wake carried none of
  the cancel wording. `build-cancel-respected` passed there too, because the
  fake never restarts; that check's value is on a real model.

The runner stopped and removed both profiles (`dev:status` reports them
`missing`). At the first profile's teardown its headless Electron dumped core
(`core.<pid>`, 1 GB, written to the worktree root at 01:36 UTC, after the case
had passed); the file was deleted and the crash was not investigated.

### Full-suite failures repaired with task 4 (task 4, 2026-11-10)

The branch's `mise run test:full` failed in backend tests that triage tied
to this change through the backend files it touches. Each failure reproduced
on its own, and none came from task 4's wording; all four causes were already
on `main`. They were repaired here rather than left, because the ticket could
not close with them open:

- Environment deletion and merged-PR cleanup (`commands-integration`,
  `commands-registry-environments`, `commands-registry-pr`): deletion calls
  `storage.deleteAutoPipelineDraftsByEnvironment` (#2000), which the shared
  storage fake in `apps/backend/tests/command-fixtures.ts` did not have. The
  fake now has it. Production storage already did.
- `index.test.ts`, "runs the activity bundle as named due jobs": every
  backend `init()` started a new shared-usage sync timer (#2023) without
  clearing the last, so a repeated init leaked a 60 s interval. `init` now
  starts it once, the way node coordination's timers already are, and the test
  names that timer and requires exactly one.
- `opencode2-host-server.test.ts`: an agent-test start reconciles OpenCode
  2.x logins from `$XDG_DATA_HOME/opencode/auth.json`. The test isolated
  `XDG_CONFIG_HOME` only, so on a host that sets `XDG_DATA_HOME` (beelink
  does) it read the developer's real credential store and its fake server,
  which had no credential route, failed the start. The test now points
  `XDG_DATA_HOME` at its own empty directory and the fake answers the
  credential list.
- Pi bridge `http.test.ts` (slow tier), "a new tab lists its templates and
  skills before the first turn": since #2022 every Pi policy excludes
  extensions, so the pre-attach catalogue is the whole inventory and is
  published `ready`. The test still expected the earlier `stale` with
  `attachPending`; it now expects the current contract.

The other recorded failures were checked where they could be on this node:
every `apps/backend/tests/commands-registry-*.test.ts` file, the backend's
model-catalogue tests (Pi seeding included) and the Pi bridge's default tier
pass. A WebKit failure was environmental (the host lacks WebKit's libraries)
and is not repaired. A direct `bun test` from a shell that inherits
`NODE_ENV=production` fails the local-bridge tests with "bridge directory not
found"; `mise run test` strips that variable, so those are not real failures.

## Needs verification

- Pi supplied a live pass for `review-auto-actions-off` on 2026-11-09.
  Claude and Codex still did not route the review to Multi Review.
- Pi's delivery review returned no required structured result; full delivery
  qualification remains open on Pi.
- Codex's `delivery` outcome, after [7546](7546-build-review-row-pins-unoffered-codex-model.md).
- Cursor fully qualified on 2026-11-09; OpenCode still needs evidence of
  actual workflow routing rather than read-only answers.
- Task 4 on a real model: rerun
  `mise run test:agent:coordinator --credential-source codex --scenario routing`
  (billed, needs the Codex login) and read `build-cancel-respected`. Codex is
  the platform that restarted; the fake-model run proves only that the notice
  reaches the model with the new wording. Not run here: this node's build
  forbids billed turns and logins. Until then, whether a real model obeys is
  unproven, and refusing the restart (the other option in task 4) stays
  available.

## Related

- [4900-coordinator-over-delegation-and-read-rule.md](4900-coordinator-over-delegation-and-read-rule.md),
  the opposite risk (a worker launched for a read).
- [4920-coordinator-tool-surface-live-follow-ups.md](4920-coordinator-tool-surface-live-follow-ups.md)
  task 3, launches that leave defaults alone.
- [7544-criterion-evidence-commit-and-completion-handoff.md](7544-criterion-evidence-commit-and-completion-handoff.md)
- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md),
  the live suite.
- [7546-build-review-row-pins-unoffered-codex-model.md](7546-build-review-row-pins-unoffered-codex-model.md),
  found by this scenario's Codex run.
- [Routing](../../architecture/coordinator.md#routing)
