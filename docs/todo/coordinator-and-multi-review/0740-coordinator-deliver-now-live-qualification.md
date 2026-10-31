# Coordinator `deliverNow`: live qualification and follow-ups

Checked against `main` at `cd7bbe3e` (2026-10-30).

A coordinator's `send_message` takes `deliverNow: true` to have a busy worker
receive the message as a steer into its running turn instead of at turn end.
It reuses the Deliver now path (`steerRequested` on the pending entry), so the
steer, its journal verification and the terminal-agent hold note are the same
code a person's Deliver now runs. It now reaches workers on other nodes too.
What is left is the billed live run of the scenario built for it.

## Task analysis

Analysed 2026-10-30 against `main` at `cd7bbe3e`.

Nothing in this file had merged before this pass: since #1385 (`cc869af0`)
no commit touched the deliverNow path, the node mail commands or the live
suite's scenario list (`git log` on `coordinator-deliver-now.ts`,
`commands-registry-nodes.ts`, `commands-registry-coordinator-nodes.ts` and
`coordinator-live.ts`). This pass built task 3 and the harness for tasks 1
and 2; their live runs are still open.

### Tasks

1. **Live steer into a busy native worker**: the `deliver-now` scenario of the live coordinator suite, one run per steering provider (Claude, Codex, Pi, Cursor). Status: open (scenario built and tested with a scripted transport; needs billed live runs).
2. **Live terminal worker**: a tmux Claude worker reports `unsupported, queued` and gets the mail at turn end, as the Claude-only second part of the same scenario. Status: open (built with task 1; needs a billed Claude run).
3. **`deliverNow` across a node link**: carry the flag to the leaf so a remote busy worker can be steered. Status: done (this branch).

### 1. Live steer into a busy native worker

**Problem.** The steer path has MailWorld evidence only. Nobody has seen a real
provider take a coordinator's correction mid-turn.

**Context.** `send_coordinator_agent_mail` turns `deliverNow` into `steer` and
settles the result after one drain pass (`settleCoordinatorDeliverNow` in
`apps/backend/src/core/coordinator-deliver-now.ts`). A recipient can be
steered only if it is a native tab whose agent has the `steer` action: Claude,
Codex, Pi and Cursor (`packages/protocol/src/native-agent.ts`). Grok and
OpenCode have no steer, so they report `unsupported, queued`. The settle step
reports `not queued` with `environment-unready` for an environment whose setup
has not finished, so a correction sent to a brand-new environment is not a
steer test.

**Investigation.** The scenario now exists:
`apps/desktop/scripts/dev/coordinator-live-deliver-now.ts` (prompts and
verdict), `coordinator-live-deliver-now-orchestration.ts` (the run, on the
shared delegation watch), a `deliver-now` case in
`e2e/agent-testing/coordinator-live.spec.ts`, and `deliver-now` in
`COORDINATOR_LIVE_SCENARIOS` between `status` and `peer` (peer stays last
because it changes the messaging defaults). The worker `touch`es a start file
and parks on a gate file; the harness asks for the correction only once the
start file exists and the worker reads as working, so the environment is ready
and the turn is running, and opens the gate only after the correction is
injected. The verdict is tested on fixtures
(`coordinator-live-deliver-now.test.ts`) and the orchestration over a scripted
command transport (`coordinator-live-deliver-now-orchestration.test.ts`),
including a correction that only lands at idle, which fails. No live run has
been made.

**Decisions.** See "Assumptions and decisions" below for what was chosen.

- **Where should the run live?**
  - **A `deliver-now` scenario in `mise run test:agent:coordinator` (recommended).**
    - Pros: disposable profiles, credential handling and teardown already exist; it can be rerun after changes to the steer path.
    - Cons: one more scenario in an opt-in suite that costs real tokens per platform.
  - **A one-off manual run in a `dev:test` profile.**
    - Pros: no harness code.
    - Cons: no repeatable evidence; the next change to the steer path needs another manual run.
- **What counts as a pass?**
  - **The worker's turn is held busy on a gate. The correction must return `steered`, the message must show `injectedVia: "steer"` and appear in the worker's transcript before that turn ends, the worker's final report must reflect the correction, and the coordinator must be woken exactly once, at turn end (recommended).**
    - Pros: tests the outcome, the transcript and the single wake; the gate removes the race where the turn ends before the drain.
    - Cons: `verifying` (steer handed off, not confirmed) counts as a fail even though it is a correct outcome, so a slow provider may need a rerun.
  - **Accept `steered` or `verifying`.**
    - Pros: fewer reruns.
    - Cons: `verifying` does not prove the mail reached the running turn.
- **Which providers, in which order?**
  - **Claude and Codex first, then Pi and Cursor with the disposable-profile credentials the live suite already uses (recommended).**
    - Pros: the two main providers are signed in on this host; Pi and Cursor follow without new setup.
    - Cons: Pi and Cursor wait for a second run.

### 2. Live terminal worker

**Problem.** A tmux Claude worker cannot take mail mid-turn; that it says so
and still gets the mail at turn end has deterministic evidence only.

**Context.** A terminal recipient is not `native`, so `canSteer` is false and
the result is `unsupported, queued`. The mail service gives the message the
`steer-unsupported` hold note (`apps/backend/src/core/agent-mail-service.ts`).
The deterministic case is in `coordinator-deliver-now.test.ts`. The mail
service's view of whether a tmux turn is busy lives only in its memory; no
command reads it.

**Investigation.** On Claude the `deliver-now` scenario has a second part: the
coordinator calls `launch_terminal` with `tabType: "claude-tmux"` in the
worker's environment, with a start-file-then-gate task, and corrects that tab
once the start file exists. Because there is no presence read, the start file
is what shows the tmux turn is running. No live run has been made; `tmux` is
installed on this host (`/opt/homebrew/bin/tmux`).

**Decisions.**

- **How should it be run?**
  - **As a second case of the `deliver-now` scenario, Claude only (recommended).** The coordinator starts a `claude-tmux` worker with a long task, sends a `deliverNow` correction, and the case passes when the result is `unsupported, queued`, the message carries the `steer-unsupported` hold, and it is delivered after the turn ends.
    - Pros: shares the scenario's setup; tmux exists only for Claude.
    - Cons: depends on tmux being installed on the host that runs the suite.
  - **A separate manual run.**
    - Pros: no harness work.
    - Cons: no repeatable evidence.

### 3. `deliverNow` across a node link

**Problem.** A coordinator on a command node could not correct a busy worker on
a leaf mid-turn.

**Context.** `send_message` with `nodeId` (or a reply to mail that came from
another node) sends through `send_coordinator_node_mail`, which calls the
leaf's `deliver_node_mail`. That command accepts a fixed set of keys and
rejects any other (`assertOnlyKeys`), so a new key would make an older leaf
refuse the whole message. Backends advertise features through hello
capabilities (`BACKEND_CAPABILITIES`,
`packages/protocol/src/backend-profile.ts`). `send_node_message` has no
`deliverNow` parameter at all (`apps/backend/src/core/control-mcp-nodes.ts`),
so only `send_message` is affected.

**Investigation.** Built on this branch:

- A `node-mail-steer` hello capability, advertised with the other node
  capabilities in `apps/backend/src/gateway-auth.ts`.
- `send_coordinator_node_mail` takes `deliverNow` and adds `steer: true` to
  `deliver_node_mail` only when the leaf's hello advertises it
  (`CoordinatorNodeTarget.supports`). Mail the leaf's pass already injected
  still opens or joins the delegation. The leaf's `deliverNow`,
  `deliverNowNote` and `injectedVia` are passed through.
- The leaf's `deliver_node_mail` accepts `steer`; `NodeCoordination.deliverIncoming`
  passes it to `sendAgentMail`, which now honours `steer` for a `node` sender
  whose role is `coordinator` as well as a local coordinator. The command then
  runs `settleCoordinatorDeliverNow`, the same single delivery pass and expiry
  as a local correction, and answers with the settled placement and outcome.
- `send_message` forwards `deliverNow` to `send_coordinator_node_mail` and
  reports the leaf's outcome; without one (an older leaf) it reports what it
  did before: `unsupported, queued` for scheduled pending mail, `not queued`
  otherwise.
- A lost leaf answer stays the existing outcome-unknown error, with no
  `deliverNow` claim and no delegation opened.

Tests: `commands-registry-coordinator-nodes.test.ts` (capable leaf gets
`steer` and its outcome is reported, older leaf gets no field and no claim, no
`deliverNow` means no field, a lost answer), `nodes/node-coordination.test.ts`
(a leaf over the real mail store: busy native worker steered, idle worker
delivered, terminal worker `unsupported, queued` and delivered at turn end,
no `steer` leaves the mail pending, other unknown keys still refused) and
`control-mcp-server.test.ts` (leaf outcomes `steered` and `verifying` passed
through, older-leaf outcomes unchanged, `deliverNow` forwarded).

**Decisions.**

- **How should the flag reach the leaf?**
  - **A `steer` field on `deliver_node_mail`, sent only to leaves that advertise a new hello capability (recommended).** The leaf sets `steerRequested` when it places the message `pending-inject`, runs one drain pass as the local command does, and returns the `deliverNow` outcome in its answer.
    - Pros: an older leaf keeps working and reports `unsupported, queued` as before; the leaf applies its own mutes, budgets and steer eligibility.
    - Cons: a new capability name to maintain; the command node waits for the leaf's drain pass before answering.
  - **Always send the field.**
    - Pros: simpler.
    - Cons: an older leaf rejects the message (`Unexpected arguments field: steer`), so mail is lost to an upgrade gap.
  - **Keep it unsupported.**
    - Pros: no change.
    - Cons: remote workers can never be corrected mid-turn.
- **What does the coordinator see when the leaf's answer is lost?**
  - **The existing outcome-unknown result for the mail, with no `deliverNow` claim (recommended).**
    - Pros: never promises a steer that may not have happened; the retry with the same `requestId` replays on the leaf.
    - Cons: the coordinator cannot tell a steer from an idle delivery in that case.
  - **Report `verifying`.**
    - Pros: matches the local unconfirmed-steer wording.
    - Cons: the command node cannot check the leaf's steer journal, so nothing would ever resolve it.

## Assumptions and decisions

### Task 1: the run lives in the live suite

Chose the recommended `deliver-now` scenario in `mise run test:agent:coordinator`.
The suite's delegation watch, gate pattern and summaries already did most of
the work, and the scripted-transport test pattern from the `status` scenario
let the orchestration be tested without a provider.

### Task 1: the pass criteria, and how "busy" is guaranteed

Chose the recommended criteria, with a gate file in place of a fixed one-minute
`sleep`: the worker stays in its turn until the harness opens the gate, and
the harness opens it only once the correction is injected (or after a quarter
of a step budget, so a correction that never lands still produces a verdict).
That removes the timing race the `sleep` was meant to reduce rather than
shortening it. `verifying` fails, as recommended. "Woken exactly once" is
checked as: the delegation completed and woke the coordinator after the gate
opened, and the coordinator started exactly one turn between the end of the
correction turn and 30 seconds after its wake turn ended.

### Task 1: wait for a running turn, not a new environment

The 2026-10-28 format pass found that a correction to a brand-new environment
returns `not queued` with `environment-unready`. That is the documented
outcome (`deliverNow` never bypasses readiness), not a defect, so nothing in
the product changed. The scenario sends the correction only after the worker
has created its start file and reads as working, which implies a ready
environment.

### Task 1: provider order

Chose the recommended order (Claude and Codex first, then Pi and Cursor). On
Grok and OpenCode, which have no steer, the case is skipped with that reason
(`deliverNowApplies`), so a full-suite run does not fail on a correct
`unsupported, queued`; their outcome is covered by the deterministic tests.

### Task 2: a Claude-only second part of the same scenario

Chose the recommended option. The current code showed one gap the analysis did
not mention: nothing reads whether a tmux turn is busy (the mail service keeps
presence in memory only). The terminal task therefore `touch`es its own start
file before its gate, and the harness waits for that file. If the tmux Claude
stops on a permission prompt before `touch`, the part times out and fails
rather than passing.

### Task 3: capability-gated `steer` field

Chose the recommended `steer` field behind a `node-mail-steer` hello
capability, and the recommended outcome-unknown result for a lost answer. One
addition the analysis did not spell out: after the leaf's delivery pass, a
correction can already be `injected` when the command node sees it, so the
command node now treats `injected` as scheduled when it asked for a steer.
Otherwise a steered correction to a remote worker would open no delegation and
the coordinator would never be woken by that turn's end. A late-opened remote
delegation still settles, because remote settlement reads the worker's idle
state and pending mail after the grace period, not a turn-end event.

### Task 3: `send_node_message`

Left without `deliverNow`, as the analysis found: it is the older generic node
tool, and the coordinator's `send_message` with `nodeId` is the path that
carries coordinator delegations.

## Current state

- Described in
  [`coordinator.md`, "Course corrections with deliverNow"](../../architecture/coordinator.md#course-corrections-with-delivernow)
  (now including the node link) and
  [`agent-messaging.md`](../../architecture/agent-messaging.md)
  ("Deliver now into a running turn").
- `send_coordinator_agent_mail` passes `steer` to `sendAgentMail`, waits for
  one drain pass and reports `deliverNow` (`coordinator-deliver-now.ts`).
- `send_coordinator_node_mail` passes `steer` to a leaf advertising
  `node-mail-steer`; the leaf's `deliver_node_mail` settles it the same way.
- The live suite has a `deliver-now` scenario
  ([`agent-testing.md`, "Live coordinator suite"](../../development/agent-testing.md#live-coordinator-suite));
  it has not been run live.
- Tests: `coordinator-deliver-now.test.ts` (MailWorld),
  `commands-registry-coordinator-nodes.test.ts`, `nodes/node-coordination.test.ts`,
  `control-mcp-server.test.ts`, `coordinator-live-deliver-now.test.ts` and
  `coordinator-live-deliver-now-orchestration.test.ts`.

## Outstanding work

### Qualification (billed provider turns)

Run from a shell signed in to the provider, outside any Orkestrator data
directory in use. Each command starts and resets its own disposable
`dev:test --fixture` profile. The summary is written to
`output/agent-testing/<run>/coordinator/<platform>-deliver-now.json`.

1. **Claude** (tasks 1 and 2; needs `tmux` on `PATH`):

   ```bash
   mise run test:logged -- --name coordinator-deliver-now-claude -- \
     mise run test:agent:coordinator --credential-source claude --scenario deliver-now
   ```

2. **Codex** (task 1):

   ```bash
   mise run test:logged -- --name coordinator-deliver-now-codex -- \
     mise run test:agent:coordinator --credential-source codex --scenario deliver-now
   ```

3. **Pi and Cursor** (task 1), after 1 and 2 pass:

   ```bash
   mise run test:logged -- --name coordinator-deliver-now-pi-cursor -- \
     mise run test:agent:coordinator --credential-source pi --credential-source cursor --scenario deliver-now
   ```

A run qualifies when the summary's verdict is `passed`. Record each run's date,
provider version and verdict here, and mark tasks 1 and 2 done when all four
providers have passed. A `correction-steered` failure whose detail says
`verifying` is a slow handoff: rerun once before treating it as a product
failure. A `terminal-*` failure with `the terminal worker to start its gated
step` in `finished` means the tmux Claude never ran its first command (most
likely a permission prompt in the pane); check the pane before filing it.

### Not covered by a live run

`deliverNow` across a node link has deterministic evidence only. A live check
needs a command node and a leaf both on this branch, a worker on the leaf
parked on a gate, and a coordinator on the command node sending it a
`deliverNow` correction with `nodeId`; the result should say `steered`. No
harness exists for two live nodes, so this stays a manual check.

## Constraints and rationale

- Coordinator-only: worker `send_message` and `reply_message` have no
  `deliverNow`, and `sendAgentMail` ignores `steer` for any sender that is not
  a coordinator (local, or a command node's coordinator through the node
  link). A worker interrupting its coordinator mid-turn would undo the
  delegation hold.
- Coordinator conversations (main ↔ side) are never steered, so a side agent
  cannot cut into the main's turn with the user.
- `steer` is sent only to a leaf advertising `node-mail-steer`: an older leaf
  rejects unknown `deliver_node_mail` fields and would refuse the message.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md)

## Replaces

None.
