# Coordinator image mail: live qualification and follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, on the branch that built the
feature (`forward-pasted-images-b87833dd9152-r1`).

### Tasks

1. **Live two-node run**: a coordinator on a real command node sends a pasted image to a worker on a leaf, and a leaf's coordinator sends one back up. Status: open.
2. **Live container run**: a containerized worker opens a mailed image inside a real container. Status: open.
3. **Reading it on every coordinator provider**: a coordinator on Cursor, Pi and Grok opens a mailed image from its own attachment directory with its own read tool. Status: open (depends on 1).
4. **Clearing images from the project home**: mailed images stay in the user's own checkout until someone removes them. Status: open.

### 1. Live two-node run

**Problem.** Image mail across a node link has only deterministic evidence: two in-process mail worlds joined by a fake link, moving real bytes between two data directories.

**Context.** `send_coordinator_node_mail` pushes the batch with the transfer framework, and `deliver_node_mail` places it before storing the mail. Upward, `send_coordinator_command_node_mail` spools the batch for the outbox and the collector fetches it (`coordinator-mail-attachments.ts`, `nodes/node-coordination.ts`). Tests: `coordinator-mail-attachments-nodes.test.ts`.

**Investigation.** Not run live. The build ran with no billed provider turns, and a recipient agent opening the image is a billed turn. The transport itself needs no agent, but real link behaviour on an 8 MiB image (chunking, link timeouts, reconnect during a transfer) has not been observed.

**Decisions.**

- **Where to run it?**
  - **Two disposable `dev:test` profiles on one host, one attached as the other's leaf (recommended).**
    - Pros: no real machine touched; both UIs available to screenshot the mail tile.
    - Cons: one host cannot show a cross-machine path or an SSH-forwarded link.
  - **Two real machines.**
    - Pros: exercises the real link, including reconnect collection.
    - Cons: touches the user's real installations and needs their approval.

### 2. Live container run

**Problem.** The container path is tested through a fake `docker exec` that runs the real writer script against a temporary checkout, not a real container.

**Context.** `containerEnvironmentSink` writes with `CONTAINER_PINNED_ATTACHMENT_WRITE`, the writer initial-prompt attachments and external file copies already use in containers. A recipient agent reads `/workspace/.orkestrator/mail-attachments/<batch>/<name>`.

**Investigation.** Not run against real Docker. The writer runs as the image's default user, as the existing attachment writes do, and the file is mode `0644`.

**Decisions.**

- **How to prove it?**
  - **Add a case to `mise run test:agent:docker` that sends an image and reads it back with `docker exec` (recommended).**
    - Pros: no provider turn; runs with the existing opt-in Docker suite.
    - Cons: does not show an agent opening it, only that the agent's user can.
  - **A billed turn in the live coordinator suite.**
    - Pros: end to end, including the agent's own read tool.
    - Cons: billed, and adds little over the file-level check.

### 3. Reading it on every coordinator provider

**Problem.** A coordinator recipient gets the file in its own attachment directory. Whether its read tool can open that path has been read from the code for Claude and Codex, and not exercised on any provider.

**Context.** `ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT` names the directory. Codex's permission profile grants it read (`codex-config.ts`). Claude's read-only turn allows `Read` as a tool, whose reach outside the checkout is the CLI's own rule. The Cursor, Pi and Grok bridges use the root to confine prompt attachments (`prompt-attachments.ts`); their read tools were not traced.

**Investigation.** Not run: each check is a billed turn. If a provider cannot read it, the image cannot reach that coordinator's model by path, though the mail and the tile still arrive.

**Decisions.**

- **What if a provider cannot read the directory?**
  - **Grant it the root in that bridge's read-only configuration (recommended).**
    - Pros: the same rule as Codex; the directory holds only this conversation's own images.
    - Cons: one more provider-specific grant to keep correct, and it needs its own live check.
  - **Deliver mailed images as prompt attachments on the mail turn.**
    - Pros: the model sees the image with no read tool at all.
    - Cons: rendering in the model's input was out of scope for this ticket, and mail turns carry text only today.

### 4. Clearing images from the project home

**Problem.** A mailed image the user approved stays in `<checkout>/.orkestrator/mail-attachments/` indefinitely: the project home is never deleted the way an environment is.

**Context.** It is Git-excluded and only follows an approval, so it is clutter rather than a risk. Other environments lose theirs with the workspace.

**Investigation.** No retention runs on this directory. Mail retention (14 days) could drive one, but deleting a file an agent is still using would be a worse failure than a few stale images.

**Decisions.**

- **Should it be swept?**
  - **Leave it until a user reports it, and mention it in the docs (recommended).**
    - Pros: nothing can delete a file in use; approval already makes these rare.
    - Cons: images accumulate in the user's checkout, unnoticed.
  - **Prune batches older than the mail retention window.**
    - Pros: bounded.
    - Cons: another sweep writing inside the user's own checkout.

## Related

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#passing-a-pasted-image-on)
- [`docs/architecture/command-nodes.md`](../../architecture/command-nodes.md#images-between-nodes)
