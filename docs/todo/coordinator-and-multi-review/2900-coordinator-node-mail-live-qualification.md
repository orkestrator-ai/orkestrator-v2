# Coordinator-to-coordinator node mail: live qualification and follow-ups

## Task analysis

Analysed 2026-11-10 against `main` at `c98b20e6f`. First analysed
2026-11-02 against `main` at `82598d869`, on the branch that built the feature
(`two-way-mail-d1337e612600-r1`).

The round trip and the loop bound now have live evidence between two
`dev:test` profiles on one host with a scripted loopback model
(`mise run test:agent:coordinator:node-mail-fake`). The run found that
replacing the command node's main released mail the loop budget held; that is
fixed. What is left needs two real machines or billed turns, both of which
need the user's approval.

### Tasks

1. **Live two-node round trip**: a command node's main coordinator asks a leaf's main coordinator a question and gets its answer, on two real backends. Status: open (passed 2026-11-10 between two `dev:test` profiles on one host with a loopback model; two real machines, a tailnet or an SSH-forwarded link remain and need the user's approval).
2. **Live loop bound**: two live coordinators told to keep asking each other stop at the command node's unattended budget. Status: open (passed 2026-11-10 on the same two profiles with a scripted model, and the hold now survives replacing the main; how a real model behaves at the bound needs billed turns, which need the user's approval).
3. **Reachability in `list_nodes`**: whether `list_nodes` should also say which nodes have a reachable coordinator, not only `list_mailboxes` with `nodeId`. Status: done (kept on `list_mailboxes` with `nodeId`; see below).

### 1. Live two-node round trip

**Problem.** Mail between a command node's coordinator and a leaf's coordinator has only deterministic evidence: two in-process mail worlds joined by a fake node link (`coordinator-node-coordinator-mail.test.ts`) and a fake-invoker Control MCP test (`control-mcp-coordinator-node-mail.test.ts`).

**Context.** The command node's `send_message` with `nodeId` and `toEnvironmentId: "coordinator"` calls the leaf's `deliver_node_mail` with the leaf's `projectId`; the leaf coordinator answers with `replyToMessageId`, or writes to `"command-node-coordinator"`, through its outbox, which the command node's collector drains ([coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)).

**Investigation.** Run live on 2026-11-10 between two `dev:test --fixture --headless --no-agent-credentials --agent-platforms pi` profiles on beelink (Linux), with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`. `mise run test:agent:coordinator:node-mail-fake` starts both (the second as a companion profile of the isolated runner), runs `e2e/agent-testing/coordinator-node-mail-fake.spec.ts`, then stops and resets both. The spec:

- adds a checkout of the same repository (`https://github.com/orkestrator-qa/node-mail.git`) to each profile, because the fixture projects' origins are local paths, which have no repository hint to match on;
- has the command node ("desk") attach the leaf with `add_node` over the leaf's real gateway origin and its gateway token, read in memory from the leaf's auth file and never printed, and waits until the desk lists it as connected and the leaf reports `mode: "leaf"`;
- points each profile's isolated Pi `models.json` at `coordinator-node-mail-fake-model.ts` (one server, `/desk/v1` and `/leaf/v1`), so each main coordinator is a real Pi bridge and SDK session with the real coordinator context, policy and Control MCP; only the model's choices are scripted (`coordinator-node-mail-fake-model-script.ts`).

Observed, from the content-free summary (`output/agent-testing/<run>/coordinator-node-mail-fake/summary.json`):

- The desk's coordinator called `list_mailboxes` with the leaf's `nodeId`, which answered `coordinator.reachable: true`, then `send_message` with `nodeId` and `toEnvironmentId: "coordinator"`.
- The leaf stored the question from a `node` sender with role `coordinator`, trust `same-project`, and injected it. The leaf coordinator's prompt framed it as "From the main coordinator on …, the command node that controls this node".
- The leaf coordinator answered with `send_message`, `toEnvironmentId: "command-node-coordinator"` and `replyToMessageId`. The desk collected it from the leaf's outbox and stored it from a `node` sender with role `agent`, trust `same-project`, from the leaf's `nodeId`. It woke the desk's coordinator, whose prompt framed it as "From the coordinator for this project on node …" and "This answers your message …".
- Exactly one call of each tool on each side; the fake model refused no request.

Not observed: two kernels, a slow, SSH-forwarded or dropped link, reconnect collection, and a real model choosing its own calls. The spec passed three times on 2026-11-10: twice on two profiles started by hand (the second reusing them), then end to end through the mise task on fresh profiles (73 s of test time). Two earlier attempts failed before the fix: the first on the spec's own assumption about mailbox order (the mailbox lists newest first), the second on the problem recorded under task 2.

**Decisions.**

- **Where to run it?**
  - **Two disposable `dev:test` profiles on one host, one attached as the other's leaf (recommended).**
    - Pros: no real machines touched; the same profiles drive both UIs for screenshots of the mail tiles.
    - Cons: one host cannot show a cross-machine path or an SSH-forwarded link.
  - **Two real machines (for example arktech-mini commanding beelink).**
    - Pros: exercises the real link and reconnect collection.
    - Cons: touches the user's real installations; needs the user's approval.

### 2. Live loop bound

**Problem.** The loop bound is proved only in the in-process scenario (budget 3, with the agents simulated). Live agents may choose to send new messages rather than replies, or batch differently.

**Context.** The command node's pair budget for the leaf coordinator's mail (`nodeMailSenderKey`) is never reset by the leaf; each new command-node message starts a fresh leaf-side budget, as a new request to a worker does.

**Investigation.** Run live on 2026-11-10 in the same spec and profiles as task 1, with `autonomousWakeBudget` set to 3 on both. The desk's coordinator was prompted to keep asking; on every answer the fake model asked a new numbered question as a new message (not a reply), the way task 2's problem says a live agent might. The leaf answered each question with a reply.

- Three answers woke the desk's coordinator (answers 0, 1 and 2). The fourth was `inject-held` with `loop-budget-exhausted`.
- The desk's coordinator got exactly one "Worker mail held: loop budget" notice. It reached the model ("Sending another request does not reset this budget"), and the fake asked nothing more.
- The leaf was woken four times, once per question: each new question from the command node is a fresh request on the leaf.
- Then nothing: neither profile's Pi called the model for 15 s.

**Found and fixed: replacing the main released held mail.** The second run on reused profiles showed a brand-new desk main woken, with no prompt, by the answer the first run's budget had held. Closing a main tombstoned its mailbox, which turned `inject-held` mail into `undeliverable`/`tab-closed` and dropped the budget reason. Then `moveClosedCoordinatorMail` made everything it moved to the next main `pending-inject`. The budget rule is that only the user's Resume or prompt releases held mail, and the release let the exchange restart in the new main with a fresh budget. Now a closed main's budget-held mail (loop budget or hourly limit) keeps its hold when the mailbox is tombstoned (`storage-agent-mail-directory.ts`), and the move keeps it held (`storage-agent-mail-injects.ts`). The hourly drain already skips tombstoned mailboxes, and Resume on the new main releases it as before. Covered by `coordinator-node-coordinator-mail.test.ts` ("a held answer stays held when the user replaces the command node's main"), which failed before the fix, and by step 3 of the live spec: after the loop it closes the desk's main and opens a new one, the held answer arrives there still held, and neither model is called. A further run on the reused profiles found the earlier run's held answer carried into the new main, still held, with no wake.

Not observed: a real model at the bound. The fake always asks again and always stops on the notice, so whether a real coordinator replies instead of starting new messages, batches, or obeys the notice needs billed turns.

**Decisions.**

- **How to provoke the loop?**
  - **Prompt both coordinators to keep asking each other, with the unattended budget lowered to 3 in both profiles (recommended).**
    - Pros: a short, cheap run; the held message and the budget notice are visible in the command node's UI.
    - Cons: needs billed turns on both nodes.
  - **Leave the default budget of 16.**
    - Pros: the shipped setting.
    - Cons: sixteen billed round trips for the same evidence.

### 3. Reachability in `list_nodes`

**Problem.** A command node's coordinator learns whether a node has a coordinator for its project only by asking `list_mailboxes` with that `nodeId`, one node at a time.

**Context.** `list_nodes` already lists every node with `hasProject`; adding a coordinator field would cost one routed `get_node_project_coordinator` per node per call, on top of the machine-load reads it already makes.

**Investigation.** The ticket allowed either `list_mailboxes` with `nodeId` or `list_nodes`; the build chose `list_mailboxes` with `nodeId` only. The live run (task 1) needed one `list_mailboxes` call to learn the leaf's coordinator was reachable over a real node link before sending. One node gives no evidence that the per-node ask is a burden, so the recommended option stands and the question is closed. Reopen it as a new to-do if a coordinator run with several nodes shows coordinators making one call per node to get an overview.

**Decisions.**

- **Add a coordinator field to `list_nodes`?**
  - **Keep it on `list_mailboxes` with `nodeId` until a coordinator run shows the per-node ask is a burden (recommended).**
    - Pros: no extra calls on every `list_nodes`; the answer is fetched when the coordinator is about to mail.
    - Cons: one call per node when a coordinator wants an overview.
  - **Add it to `list_nodes`.**
    - Pros: one call shows every reachable coordinator.
    - Cons: a routed call per node on every `list_nodes`, slowing a read coordinators make often.

## Assumptions and decisions

### Tasks 1 and 2: two `dev:test` profiles and a scripted loopback model

Ran the recommended option: two disposable `dev:test` profiles on one host, one attached as the other's leaf. The ticket ruled out billed turns and real logins, so each profile's Pi points at a scripted loopback model (the pattern of `coordinator-routing-fake.spec.ts`) rather than a provider. Pi was chosen because its bridge reads a per-profile `models.json`, so neither profile touches `~/.pi`. Both profiles run with no agent credentials and `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, use only ephemeral ports, and are stopped and reset afterwards. A pass proves the product's plumbing (both backends, the node link, Control MCP, framing, outbox, collector, budgets), not a real model's choices.

### Tasks 1 and 2: a companion profile in the isolated runner

Gave `runIsolatedBrowser` a `companionProfiles` option rather than writing a second launcher for the leaf. Companions start one after another, after the main profile is ready, with the same flags. A profile exiting fails the run. Every started companion is stopped and reset with the main profile, and one that never started is not touched. Covered by `isolated-browser.test.ts`.

### Tasks 1 and 2: a shared repository rather than the fixture projects

Added a checkout with a common `https://github.com/...` origin to each profile. The fixture projects' origins are local bare paths, and `repositoryHint` (how a command node finds a leaf's copy) returns nothing for a path.

### Task 2: keep a budget hold through a main replacement

Kept loop-budget and hourly-limit holds when a main is closed and its mail moves to the next main. The alternative, re-judging the moved mail against the new main's budget, would always release it, because a new main is a new pair with no routed history. That is the behaviour the run caught. Only main mailboxes keep the hold on tombstoning, because only they move to a successor. A side conversation's mail still becomes `undeliverable` as before. The new main gets no fresh budget notice for mail it took over: the held message is in its inbox with the hold shown, and the user's Resume releases it.

### Task 3: no `list_nodes` change

Closed with the recommended option (keep reachability on `list_mailboxes` with `nodeId`); see task 3's investigation.

## Related

- [0740](0740-coordinator-deliver-now-live-qualification.md): `deliverNow` across a node link, the other node-mail capability gate.
- [1021](1021-coordinator-gap-tools-follow-ups.md): the `nodeId` paths of the coordinator tools on two nodes.
