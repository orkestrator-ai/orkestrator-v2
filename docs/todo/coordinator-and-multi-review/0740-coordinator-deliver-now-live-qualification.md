# Coordinator `deliverNow`: live qualification and follow-ups

Checked against `main` at `7e3ceb7c` (2026-10-28).

A coordinator's `send_message` takes `deliverNow: true` to have a busy worker
receive the message as a steer into its running turn instead of at turn end.
It reuses the Deliver now path (`steerRequested` on the pending entry), so the
steer, its journal verification and the terminal-agent hold note are the same
code a person's Deliver now runs. It has deterministic evidence only.

## Task analysis

Analysed 2026-10-28 against `main` at `79f3bc97`.

Nothing in the file is done. The feature landed in #1385 (`cc869af0`) and
nothing has changed it since.

### Tasks

1. **Live steer into a busy native worker**: one run per steering provider (Claude, Codex, Pi, Cursor), added as a scenario of the live coordinator suite. Status: open (needs live providers).
2. **Live terminal worker**: a tmux Claude worker reports `unsupported, queued` and gets the mail at turn end. Status: open (needs a live provider).
3. **`deliverNow` across a node link**: carry the flag to the leaf so a remote busy worker can be steered. Status: open.

### 1. Live steer into a busy native worker

**Problem.** The steer path has MailWorld evidence only. Nobody has seen a real
provider take a coordinator's correction mid-turn.

**Context.** `send_coordinator_agent_mail` turns `deliverNow` into `steer`
(`apps/backend/src/core/commands-registry-coordinator.ts:359`) and settles the
result after one drain pass (`:486`, `settleCoordinatorDeliverNow` in
`apps/backend/src/core/coordinator-deliver-now.ts:80-146`). A recipient can be
steered only if it is a native tab whose agent has the `steer` action
(`coordinator-deliver-now.ts:114-115`). That is Claude, Codex, Pi and Cursor
(`packages/protocol/src/native-agent.ts:1119`, `:1145`, `:1202`, `:1214`);
Grok and OpenCode have no steer, so they report `unsupported, queued`. The
live suite's scenarios are `read-only`, `async`, `family`, `status` and `peer`
(`apps/desktop/scripts/dev/coordinator-live.ts:56-62`).

**Investigation.** No live scenario sends `deliverNow`. The deterministic tests
cover more than the file listed: steered, idle, terminal, unconfirmed steer,
default, muted, side agent, worker sender, same-request replay, replies,
blockers, budget holds, inject policies, unknown remote placement, and a
worker finishing during admission or during the steer
(`apps/backend/src/core/coordinator-deliver-now.test.ts:28-399`), plus the
`send_message` schema and result test
(`apps/backend/src/core/control-mcp-server.test.ts:2724`).

**Decisions.**

- **Where should the run live?**
  - **A `deliver-now` scenario in `mise run test:agent:coordinator` (recommended).**
    - Pros: disposable profiles, credential handling and teardown already exist; it can be rerun after changes to the steer path.
    - Cons: one more scenario in an opt-in suite that costs real tokens per platform.
  - **A one-off manual run in a `dev:test` profile.**
    - Pros: no harness code.
    - Cons: no repeatable evidence; the next change to the steer path needs another manual run.
- **What counts as a pass?**
  - **The worker is given a task that keeps its turn busy for at least a minute (a shell `sleep` it must wait on, then a short write-up). The correction must return `steered`, the message must show `injectedVia: "steer"` and appear in the worker's transcript before that turn ends, the worker's final report must reflect the correction, and the coordinator must be woken exactly once, at turn end (recommended).**
    - Pros: tests the outcome, the transcript and the single wake, which are the three things the file asked for; a long, fixed wait removes the race where the turn ends before the drain.
    - Cons: `verifying` (steer handed off, not confirmed) counts as a fail here even though it is a correct outcome, so a slow provider may need a rerun.
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
the result is `unsupported, queued` (`coordinator-deliver-now.ts:62-67`). The
mail service gives the message the `steer-unsupported` hold note
(`apps/backend/src/core/agent-mail-service.ts:627`, `:762`). The deterministic
case is `coordinator-deliver-now.test.ts:76`.

**Investigation.** No live run. A coordinator can start the worker itself with
`launch_terminal` and `tabType: "claude-tmux"`.

**Decisions.**

- **How should it be run?**
  - **As a second case of the `deliver-now` scenario, Claude only (recommended).** The coordinator starts a `claude-tmux` worker with a long task, sends a `deliverNow` correction, and the case passes when the result is `unsupported, queued`, the message carries the `steer-unsupported` hold, and it is delivered after the turn ends.
    - Pros: shares the scenario's setup; tmux exists only for Claude.
    - Cons: depends on tmux being installed on the host that runs the suite.
  - **A separate manual run.**
    - Pros: no harness work.
    - Cons: no repeatable evidence.

### 3. `deliverNow` across a node link

**Problem.** A coordinator on a command node cannot correct a busy worker on a
leaf mid-turn.

**Context.** `send_message` with `nodeId` (or a reply to mail that came from
another node) sends through `send_coordinator_node_mail` and, when
`deliverNow` is set, reports `coordinatorDeliverNowResult(summary, {
unsupported: true })` (`apps/backend/src/core/control-mcp-tools.ts:1849-1864`).
That gives `unsupported, queued` only when the leaf placed the mail
`pending-inject`; stored, bounced and budget-held mail reports `not queued`.
The leaf's `deliver_node_mail` accepts a fixed set of keys and rejects any
other (`apps/backend/src/core/commands-registry-nodes.ts:232-248`,
`assertOnlyKeys`). Backends advertise features to each other through hello
capabilities (`BACKEND_CAPABILITIES`,
`packages/protocol/src/backend-profile.ts:176-189`).

**Investigation.** The file named `send_node_message` too; that older tool has
no `deliverNow` parameter at all
(`apps/backend/src/core/control-mcp-nodes.ts:488-524`), so only `send_message`
is affected. Adding a `steer` key to the envelope without a capability check
would make an older leaf refuse the whole message.

**Decisions.**

- **How should the flag reach the leaf?**
  - **A `steer` field on `deliver_node_mail`, sent only to leaves that advertise a new hello capability (recommended).** The leaf sets `steerRequested` when it places the message `pending-inject`, runs one drain pass as the local command does, and returns the `deliverNow` outcome in its answer.
    - Pros: an older leaf keeps working and reports `unsupported, queued` as today; the leaf applies its own mutes, budgets and steer eligibility.
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

## Current state

- Described in
  [`coordinator.md`, "Course corrections with deliverNow"](../../architecture/coordinator.md#course-corrections-with-delivernow)
  and
  [`agent-messaging.md`](../../architecture/agent-messaging.md)
  ("Releasing one message" and "Deliver now into a running turn", `agent-messaging.md:271-277`).
- `send_coordinator_agent_mail` passes `steer` to `sendAgentMail`, waits for
  one drain pass and reports `deliverNow` (`coordinator-deliver-now.ts`).
- Tests: `coordinator-deliver-now.test.ts` (MailWorld: steered, idle, terminal,
  unconfirmed steer, default, muted, side agent, worker sender, replay,
  replies, blockers, budgets, inject policies, remote placement, and
  completion races) and the `send_message` schema/result test in
  `control-mcp-server.test.ts`.

## Outstanding work

### Qualification

1. **Live steer from a coordinator into a busy worker.** One run per steering
   provider (Claude, Codex, Pi, Cursor): delegate a long task, then send a
   `deliverNow` correction mid-turn; check the result says `steered`, the
   worker's transcript shows the mail inside the running turn, and the
   coordinator is woken once, when that turn ends. Add it as a scenario of
   the opt-in coordinator live suite (0024). See task 1.
2. **Live terminal worker.** A tmux Claude worker: the result says
   `unsupported, queued` and the mail arrives at turn end. See task 2.

### Code

3. **Across a node link.** `deliverNow` on mail to a worker on another node
   (`send_message` with `nodeId`, through `send_coordinator_node_mail`) is
   reported as `unsupported, queued` and delivered at idle. Carrying the flag
   needs a field on the node mail envelope and the leaf to set
   `steerRequested`. See task 3.

## Constraints and rationale

- Coordinator-only: worker `send_message` and `reply_message` have no
  `deliverNow`, and `sendAgentMail` ignores `steer` for any sender that is not
  a coordinator. A worker interrupting its coordinator mid-turn would undo the
  delegation hold.
- Coordinator conversations (main ↔ side) are never steered, so a side agent
  cannot cut into the main's turn with the user.

## Related

- [0024-coordinator-live-conformance.md](0024-coordinator-live-conformance.md)
- [0005-mid-turn-steer-and-interrupt.md](../agent-engines/0005-mid-turn-steer-and-interrupt.md)

## Replaces

None.
