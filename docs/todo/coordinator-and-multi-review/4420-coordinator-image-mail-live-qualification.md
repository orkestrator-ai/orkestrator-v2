# Coordinator image mail: live qualification and follow-ups

## Task analysis

Analysed 2026-11-04 against `main` at `96ee1eb3e`, on the branch that built the
feature (`forward-pasted-images-b87833dd9152-r1`).

### Tasks

1. **Live two-node run**: a coordinator on a real command node sends a pasted image to a worker on a leaf, and a leaf's coordinator sends one back up. Status: done (two real backends that share no files; a slow or dropped link is not covered).
2. **Live container run**: a containerized worker opens a mailed image inside a real container. Status: done (real container, read as the agent's user; no agent turn).
3. **Reading it on every coordinator provider**: a recipient agent opens a mailed image with its own read tool. That means a worker in its worktree or container on any provider, and a coordinator on Claude, Codex, Cursor, Pi and Grok from its own attachment directory. Status: open (Claude and Codex done offline for a worktree and a conversation directory; left here: Pi against a loopback model, the Codex bridge's app-server, and an agent inside a container. Cursor and Grok need signed-in turns and moved to the manual-test checklist).
4. **Clearing images from the project home**: mailed images used to stay in the user's own checkout until someone removed them. Status: done (they now live in the data directory and go with the project home or after mail retention).

### 1. Live two-node run

**Problem.** Image mail across a node link has only deterministic evidence: two in-process mail worlds joined by a fake link, moving real bytes between two data directories.

**Context.** `send_coordinator_node_mail` pushes the batch with the transfer framework, and `deliver_node_mail` places it before storing the mail. Upward, `send_coordinator_command_node_mail` spools the batch for the outbox and the collector fetches it (`coordinator-mail-attachments.ts`, `nodes/node-coordination.ts`). Tests: `coordinator-mail-attachments-nodes.test.ts`.

**Investigation.** The transport needs no agent, so it was run on two real backends started from source (`scripts/qa-coordinator-image-mail.ts`, 29/29 checks). One is a command node; the other is a leaf it attaches over the real gateway. Each runs in its own unprivileged mount namespace in which the other's directory is an empty tmpfs, and the script checks through `/proc/<pid>/root` that neither can see the other's files, so every image that arrived crossed the link. Not observed: an 8 MiB image on a slow or SSH-forwarded link, a reconnect during a transfer, or two kernels. A recipient agent opening the image is task 3.

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

**Investigation.** `apps/backend/src/core/coordinator-mail-attachments-read-live.test.ts` (slow tier, 4 passing) needs no billed turn. It sends through the real commands and injection drain, then gives the exact delivered prompt to the pinned Claude CLI (2.1.314) and Codex CLI (0.166.0), each pointed at a scripted loopback model. The model takes the path from the prompt the CLI sent it and calls `Read` or `view_image`; both CLIs returned the same bytes as image content, for a worker in its Git worktree and for a side agent in its own attachment directory. Claude reads the attachment directory, which is outside its working directory, only because `Read` is approved up front, as the bridge does for every session (`session-manager-prompt-query.ts`); without that the CLI refused the read pending a grant. The Codex case uses `codex exec`, not the bridge's app-server. Cursor, Pi and Grok have no scripted model fixture in this repository and were not run; neither was an agent reading inside a container. If a provider cannot read it, the image cannot reach that coordinator's model by path, though the mail and the tile still arrive. Left here (2026-11-10): Pi, which can run against the loopback model the Auto-pipeline Pi check uses (`auto-pipeline-fake-model.ts`), the Codex bridge's app-server, and an agent reading inside a container. Cursor's model is hosted and Grok needs a login, so their signed-in runs are on the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

**Decisions.**

- **What if a provider cannot read the directory?**
  - **Grant it the root in that bridge's read-only configuration (recommended).**
    - Pros: the same rule as Codex; the directory holds only this conversation's own images.
    - Cons: one more provider-specific grant to keep correct, and it needs its own live check.
  - **Deliver mailed images as prompt attachments on the mail turn.**
    - Pros: the model sees the image with no read tool at all.
    - Cons: rendering in the model's input was out of scope for this ticket, and mail turns carry text only today.

### 4. Clearing images from the project home

**Problem.** A mailed image the user approved stayed in `<checkout>/.orkestrator/mail-attachments/` indefinitely: the project home is never deleted the way an environment is, and the ticket requires a sent image to be removed with its environment.

**Context.** Other environments lose theirs with the workspace. The project home is the user's own checkout, and Orkestrator never cleans it (`project-home-environment.ts`).

**Investigation.** No retention ran on that directory. A file a message names is needed only while the message exists; mail retention is 14 days (`AGENT_MAIL_DEFAULT_RETENTION_DAYS`). The project home's agents run on the host and read outside their checkout (the Claude bridge approves `Read` up front; the read-live test shows Claude and Codex reading from the data directory).

**Decisions.**

- **Where a project home's images live, and when they go.**
  - **The data directory, removed with the project home and after mail retention (recommended, done).**
    - Pros: nothing is written into the user's checkout, so no image can be staged there; one place to remove on deletion; a sweep there never touches user files.
    - Cons: the recipient reads a path outside its checkout.
  - **The checkout, pruned after mail retention.**
    - Pros: the path is inside the agent's working directory.
    - Cons: a sweep writing inside the user's own checkout, and nothing removes the files when the project goes.
  - **Leave them, and document it.**
    - Pros: nothing can delete a file in use.
    - Cons: fails the ticket's "removed with the environment" criterion.

## Assumptions and decisions

### Task 1: run the transport on two real backends, without the UI

Chose a script, `scripts/qa-coordinator-image-mail.ts`, over two `dev:test` profiles. It follows `qa-command-nodes.ts` and shares its harness (`qa-command-nodes-support.ts`). It needs no Electron and no browser, which on beelink would open on the user's desktop, and it uses no fixed port and no real data directory. It calls the same backend commands the Control MCP tools call, with the coordinator's scope. The MCP layer on top is covered by `control-mcp/server-messaging.test.ts` and `control-mcp/node-files.test.ts`. Each backend runs with an isolated `HOME` and no toolchain, so the agent tabs the script creates can make no provider request.

### Task 2: a plain container, not the Docker agent suite

Chose an opt-in backend test with `--network none` over a `test:agent:docker` case. It touches no Docker network or firewall, which this build was not allowed to change, and it still runs the real `docker exec` writer and the Git-exclusion proof inside the container.

### Task 1: hide each node's files from the other

Ran each QA backend in an unprivileged user and mount namespace (`unshare`) with the other node's directory covered by an empty tmpfs, rather than moving the leaf into a container. It shows the two share no files, so an image on the other node came over the link, without a Docker network, a firewall change or rewriting every on-disk check for `docker exec`. The two still share a kernel and loopback.

### Task 3: a scripted loopback model instead of a billed turn

Pointed the pinned Claude and Codex CLIs at a local scripted model, the pattern `tests/conformance/execution-policy/scripted-anthropic.ts` and `session-title-codex-live.test.ts` already use, rather than spending a provider turn. The CLI's own tool still opens the real file and returns its bytes; only the model's choice of call is scripted. `scriptedAnthropicEndpoint` now passes the first request to the script and records request bodies so the test can find the path and the returned image.

### Task 4: project home images outside the checkout

Placed a project home's images in `<dataDir>/project-home-mail-attachments/<environmentId>/<batch>/` instead of `<checkout>/.orkestrator/mail-attachments/`, so the user's checkout is never written to. `deleteEnvironment` removes the directory with the project home, and the node maintenance pass (`NodeFiles.sweepMailAttachments`, every 30 seconds on every backend) removes it once the project home's record is gone, which covers a removed project, and drops batches older than mail retention. A failed record read keeps the files. Chose retention equal to mail retention because after that no message names the file. Covered by `mail-attachments.test.ts`, `coordinator-worker-mail.test.ts` (nothing in the checkout, not even ignored files; removed after the record goes) and `commands-environment-cleanup.test.ts` (removed on delete, checkout kept).

### Task 4: configured retention and atomic private publication (review repair)

The maintenance pass now reads the effective global mail retention instead of
hard-coding 14 days. Private recipient copies finish in a unique sibling file
and are published with an exclusive hard link: interrupted writes leave no
partial final file, and a concurrent matching winner succeeds without overwrite.
Regression tests cover short/long retention, partial-write retry, concurrent
conversation copies and upward outbox retry.

### Task 3: remaining live evidence (review repair)

Still open: Cursor, Pi, Grok, Codex bridge app-server and an agent opening the
image inside a real container. Existing scripted qualification covers only
Claude and Codex CLI tools; it must not be presented as app-server or other
provider evidence. This repair does not spend provider turns, as prohibited by
the ticket, or claim that a filesystem/hash check qualifies an agent tool.

## Related

- [`docs/architecture/coordinator.md`](../../architecture/coordinator.md#passing-a-pasted-image-on)
- [`docs/architecture/command-nodes.md`](../../architecture/command-nodes.md#images-between-nodes)
- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 3: Cursor and Grok coordinators reading a mailed image) moved there on 2026-11-10.
