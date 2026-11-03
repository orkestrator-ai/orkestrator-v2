# Coordinator-to-coordinator node mail: live qualification and follow-ups

## Task analysis

Analysed 2026-11-02 against `main` at `82598d869`, on the branch that built
the feature (`two-way-mail-d1337e612600-r1`).

### Tasks

1. **Live two-node round trip**: a command node's main coordinator asks a leaf's main coordinator a question and gets its answer, on two real backends. Status: open.
2. **Live loop bound**: two live coordinators told to keep asking each other stop at the command node's unattended budget. Status: open (depends on 1).
3. **Reachability in `list_nodes`**: whether `list_nodes` should also say which nodes have a reachable coordinator, not only `list_mailboxes` with `nodeId`. Status: open.

### 1. Live two-node round trip

**Problem.** Mail between a command node's coordinator and a leaf's coordinator has only deterministic evidence: two in-process mail worlds joined by a fake node link (`coordinator-node-coordinator-mail.test.ts`) and a fake-invoker Control MCP test (`control-mcp-coordinator-node-mail.test.ts`).

**Context.** The command node's `send_message` with `nodeId` and `toEnvironmentId: "coordinator"` calls the leaf's `deliver_node_mail` with the leaf's `projectId`; the leaf coordinator answers with `replyToMessageId`, or writes to `"command-node-coordinator"`, through its outbox, which the command node's collector drains ([coordinator.md](../../architecture/coordinator.md#coordinators-on-two-nodes)).

**Investigation.** Not run live. A live run needs two isolated `dev:test` profiles, one attached to the other as its leaf, both with a copy of the same repository and a coordinator, and a billed turn on each coordinator. The build step that added the feature was told not to run billed turns or connect real machines.

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

**Investigation.** Not run live.

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

**Investigation.** The ticket allowed either `list_mailboxes` with `nodeId` or `list_nodes`; the build chose `list_mailboxes` with `nodeId` only.

**Decisions.**

- **Add a coordinator field to `list_nodes`?**
  - **Keep it on `list_mailboxes` with `nodeId` until a coordinator run shows the per-node ask is a burden (recommended).**
    - Pros: no extra calls on every `list_nodes`; the answer is fetched when the coordinator is about to mail.
    - Cons: one call per node when a coordinator wants an overview.
  - **Add it to `list_nodes`.**
    - Pros: one call shows every reachable coordinator.
    - Cons: a routed call per node on every `list_nodes`, slowing a read coordinators make often.

## Related

- [0740](0740-coordinator-deliver-now-live-qualification.md): `deliverNow` across a node link, the other node-mail capability gate.
- [1021](1021-coordinator-gap-tools-follow-ups.md): the `nodeId` paths of the coordinator tools on two nodes.
