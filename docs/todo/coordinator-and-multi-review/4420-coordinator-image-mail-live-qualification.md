# Coordinator image mail: live qualification and follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, on the branch that built the
feature (`forward-pasted-images-b87833dd9152-r1`).

### Tasks

1. **Live two-node run**: a coordinator on a real command node sends a pasted image to a worker on a leaf, and a leaf's coordinator sends one back up. Status: done (transport and placement on two real backends; an agent opening it is task 3).
2. **Live container run**: a containerized worker opens a mailed image inside a real container. Status: done (real container, read as the agent's user; no agent turn).
3. **Reading it on every coordinator provider**: a recipient agent opens a mailed image with its own read tool. That means a worker in its worktree or container on any provider, and a coordinator on Claude, Codex, Cursor, Pi and Grok from its own attachment directory. Status: open (needs billed turns).
4. **Clearing images from the project home**: mailed images stay in the user's own checkout until someone removes them. Status: open.

### 1. Live two-node run

**Problem.** Image mail across a node link has only deterministic evidence: two in-process mail worlds joined by a fake link, moving real bytes between two data directories.

**Context.** `send_coordinator_node_mail` pushes the batch with the transfer framework, and `deliver_node_mail` places it before storing the mail. Upward, `send_coordinator_command_node_mail` spools the batch for the outbox and the collector fetches it (`coordinator-mail-attachments.ts`, `nodes/node-coordination.ts`). Tests: `coordinator-mail-attachments-nodes.test.ts`.

**Investigation.** The transport needs no agent, so it was run on two real backends started from source (`scripts/qa-coordinator-image-mail.ts`, 27/27 checks). One is a command node; the other is a leaf it attaches over the real gateway. Not observed: an 8 MiB image on a slow or SSH-forwarded link, and a reconnect during a transfer. A recipient agent opening the image is a billed turn, which is task 3.

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

**Investigation.** `coordinator-mail-attachments-docker.test.ts` runs the real send against a real `orkestrator-v2:latest` container (`--network none`, opt-in through `ORKESTRATOR_TEST_DOCKER_IMAGE`). The image is written as the image's default user, `node`, which is also the agent's user, with mode `0644`. `sha256sum` as `node` reads it back. Git ignores it even after `git add -A`, and a retry leaves one file and one message. Not covered: an Orkestrator-created container with its egress gateway, and an agent's own read tool.

**Decisions.**

- **How to prove it?**
  - **Add a case to `mise run test:agent:docker` that sends an image and reads it back with `docker exec`.**
    - Pros: no provider turn; runs in a container Orkestrator itself created.
    - Cons: that suite needs a full `dev:test` profile and builds a workspace image; does not show an agent opening it.
  - **An opt-in backend test against a plain container of the image (recommended; done).**
    - Pros: no provider turn, no profile, no network or firewall change; the same `docker exec` writer and Git proof.
    - Cons: the container is not one Orkestrator created, so its entrypoint and egress gateway are not involved.
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

## Assumptions and decisions

### Task 1: run the transport on two real backends, without the UI

Chose a script, `scripts/qa-coordinator-image-mail.ts`, over two `dev:test` profiles. It follows `qa-command-nodes.ts` and shares its harness (`qa-command-nodes-support.ts`). It needs no Electron and no browser, which on beelink would open on the user's desktop, and it uses no fixed port and no real data directory. It calls the same backend commands the Control MCP tools call, with the coordinator's scope. The MCP layer on top is covered by `control-mcp-server-messaging.test.ts` and `control-mcp-node-files.test.ts`. Each backend runs with an isolated `HOME` and no toolchain, so the agent tabs the script creates can make no provider request.

### Task 2: a plain container, not the Docker agent suite

Chose an opt-in backend test with `--network none` over a `test:agent:docker` case. It touches no Docker network or firewall, which this build was not allowed to change, and it still runs the real `docker exec` writer and the Git-exclusion proof inside the container.

## Related

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#passing-a-pasted-image-on)
- [`docs/architecture/command-nodes.md`](../../architecture/command-nodes.md#images-between-nodes)
