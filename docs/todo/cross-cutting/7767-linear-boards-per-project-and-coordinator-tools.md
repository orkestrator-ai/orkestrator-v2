# Linear: one board per project, a connection on every machine, and coordinator tools

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Connect Linear on several machines at once**: the connect dialog asks which machines to connect and sends the key to each one's backend. Status: done (2026-11-11).
2. **Copy a connection from a machine this window cannot reach**: a laptop's own window cannot reach its command node. Status: done (2026-11-11).
3. **Disconnect everywhere**: a disconnect clears the key on every machine that holds the same one, including machines that were offline. Status: done (2026-11-11).
4. **Link a project to one Linear board**: a team, optionally narrowed to one Linear project; the Linear tab and builds see only that board. Status: done (2026-11-11).
5. **Keep board links the same on every machine**: synced by repository, in both directions. Status: done (2026-11-11).
6. **Extend the Linear client**: create and update issues, read workflow states, labels and members, and list a board with filters. Status: done (2026-11-11).
7. **Give the coordinator full Linear tools**: list, read, create, update, comment and labels, scoped to the project's board. Status: done (2026-11-11).
8. **Keep Kanban first**: the coordinator prompt and tool order treat Kanban as the default board and Linear as a linked one. Status: done (2026-11-11).
9. **Document the model**: Linear in `tickets.md`, the key path in `command-nodes.md`. Status: done (2026-11-11).
10. **Check it live on two linked machines**: two `dev:test` profiles, one attached to the other, with a real Linear key. Status: open.

### 1. Connect Linear on several machines at once

**Problem.** A Linear connection is one personal API key per backend (`linear-auth.json`, `storage-kanban.ts:1164`). Connecting on a leaf does nothing for the command node, so a command node coordinator has no Linear access even when every leaf does. The user wants to connect once and choose which machines get it.

**Context.** `command-nodes.md` ("Settings") says credentials and API keys never travel between machines, and no credential has ever crossed a node link. The user chose (2026-11-11) to keep it that way: "when you first connect, you should be asked which machines to connect to … keep the keys on each separate machine that needs them". The window already sends the key to its own backend (`connect_linear`, `commands-registry-linear.ts`). A window reaches another node through that node's scope, with a workspace grant (`access: "workspace"`, which every Linear command has), or else through the command node's `invoke_on_node` (`federation.md`, "One machine by node id").

**Investigation.** Read from the code on 2026-11-11. `connect_linear` verifies the key against Linear's `viewer` query before it stores it, and no handler ever returns it. Machine-aware renderer calls go through `invokeOnMachine` (`lib/portal/machine-scope.ts`). On the `invoke_on_node` path the key passes through the command node's backend in memory, but nothing there stores or logs command arguments.

**Decisions.**

- **How does the key reach the other machines?**
  - **The window calls `connect_linear` on each machine the user ticks, through `invokeOnMachine` (recommended).**
    - Pros: no backend ever sends a credential to another backend, so the rule stays as written; each machine verifies the key itself; each machine keeps working alone afterwards.
    - Cons: the window can only offer machines it can reach (see task 2); on the relay path the key transits the command node in memory.
  - **The backend that was connected pushes the key over the node link.**
    - Pros: it reaches machines the window cannot.
    - Cons: it breaks the "credentials never travel" rule the user chose to keep; leaves cannot call their command node anyway.
- **What does the dialog show?**
  - **One checkbox per reachable machine, with that machine's current Linear status (signed in as whom, and whether it is the same key) (recommended).** "Same key" compares a truncated SHA-256 fingerprint of the key, which each backend reports alongside `viewer`. The fingerprint is not a credential.
    - Pros: the user can see which machines already have it and avoid replacing a different account by accident.
    - Cons: adds a `keyFingerprint` field to the connection status.
  - **Checkboxes only.**
    - Pros: smaller.
    - Cons: silently replaces another account's key on a machine that had one.
- **What if one machine fails?** Report per machine (connected, rejected key, unreachable) and keep the ones that worked (recommended). Rolling back the successes has nothing to gain: each connection stands alone.

### 2. Copy a connection from a machine this window cannot reach

**Problem.** A command node dials its leaves, and a leaf never reaches its command node (`command-nodes.md`, ticket sync). A laptop's own window is the laptop's command scope, so it cannot offer the home server in the task 1 dialog. A connection made there never reaches the home server.

**Context.** The closest precedent for moving a secret is a project's `.env` copy, which moves content node to node "without passing through the model", approved by the user and compared by fingerprint (`command-nodes.md`, project copy).

**Investigation.** Read from the docs on 2026-11-11. The command node already reads each leaf's status through the link, so it can learn that a leaf is connected (viewer name and key fingerprint, no key) without moving a secret.

**Decisions.**

- **How does the home server get the laptop's connection?**
  - **Show "Linear is connected on <machine>" in the command node's Linear tab with a Use it here button. On click, the command node collects the key from that leaf over the link once, verifies it and stores it (recommended).**
    - Pros: one click; each copy is a choice the user makes, like the `.env` copy; the key still lives separately on each machine, as the user asked.
    - Cons: it is a second key path to test, and a documented exception to "credentials never travel" (user-initiated, one-shot, link only).
  - **Show the notice but ask the user to paste the key again.**
    - Pros: no backend ever moves a key.
    - Cons: the user has to find the key again, which is what they wanted to avoid.

### 3. Disconnect everywhere

**Problem.** The user chose (2026-11-11) that disconnecting on one machine disconnects every machine.

**Context.** A disconnect carries no secret, so it can travel as ordinary state. Machines can be offline when it happens.

**Investigation.** Not started. `NodeTicketSync` already moves records in both directions with cursors and an outbox, and so does `sync_controller_settings` (command node to leaf only).

**Decisions.**

- **How does a disconnect reach a machine that is offline?**
  - **A revocation record (key fingerprint, `revokedAt`) that syncs like board links (task 5). A machine clears its key when the fingerprint matches and its key was connected before `revokedAt` (recommended).**
    - Pros: reaches every machine eventually; a later reconnect with the same key still works; a different key on another machine is left alone.
    - Cons: needs the fingerprint from task 1.
  - **The window disconnects only the machines it can reach.**
    - Pros: no new state.
    - Cons: an offline machine keeps a key the user believes is gone.
- Board links (task 4) survive a disconnect, so reconnecting restores everything (recommended).

### 4. Link a project to one Linear board

**Problem.** `listLinearIssues` (`linear.ts:297`) lists every issue the key can see, across every team, and every project's Linear tab shows that same list. The user wants exactly one board per project, never shared.

**Context.** Linear has no board object: each team has a board, and a Linear project groups issues within or across teams. The user chose (2026-11-11) a team, optionally narrowed to one Linear project in that team. The `Project` type has no integration fields (`projects/models.ts:35-54`), and repository settings stay on each machine (`command-nodes.md`), so neither is a fit for a link that has to sync.

**Investigation.** Read from the code on 2026-11-11. Linear's GraphQL API filters `issues` by `team.id` and `project.id`. Build pipelines started from a Linear issue already record `source: { type: "linear", issueId }`.

**Decisions.**

- **Where does the link live?**
  - **A new kanban-domain store, `linear-board-links`, keyed by project id and also holding the repository hint (`repositoryHint(gitUrl)`) and `updatedAt` (recommended).**
    - Pros: owned by `KanbanRepository` next to Linear auth; the repository hint is what sync pairs on (task 5).
    - Cons: one more store and migration.
  - **A field in `config.repositories[projectId]`.**
    - Pros: no new store.
    - Cons: repository settings deliberately stay on each machine, and Electron reads `config.json`.
- **Can two projects link the same board?** No: refuse the second link on a machine, naming the project that holds it (recommended), since the user said a board is never shared.
- **What does an unlinked project's Linear tab show?** A board picker (team, then an optional project), instead of every issue (recommended).

### 5. Keep board links the same on every machine

**Problem.** Board links must match on the laptop and the home server so either one's coordinator sees the same board.

**Context.** Projects are matched across machines by `repositoryHint` (`node-summaries.ts:242-268`), and `NodeTicketSync.pairs()` already pairs projects that way (`nodes/node-ticket-sync.ts:267-302`). It sends a leaf's changes up through an outbox before sending the board down.

**Investigation.** Read from the code on 2026-11-11. The link record holds no secret, so the "credentials never travel" rule does not apply.

**Decisions.**

- **Which channel carries it?**
  - **Add board links (and the task 3 revocations) to `NodeTicketSync` as a third record kind beside tickets and comments, with the newer `updatedAt` winning (recommended).**
    - Pros: reuses the pairing, cursors, outbox and acks, and both directions already work.
    - Cons: widens a busy subsystem; ticket-sync contract versions need a capability so an older leaf ignores the new kind.
  - **A separate link-sync service.**
    - Pros: isolated.
    - Cons: duplicates the pairing and outbox machinery.

### 6. Extend the Linear client

**Problem.** `linear.ts` can only check the connection, list every issue, read one issue with its comments, and post comments. A coordinator that keeps Linear current needs to create and update issues and pick valid states, labels and assignees.

**Context.** Linear's API offers `issueCreate`, `issueUpdate`, `team.states`, `team.labels` and `team.members`, plus `issues(filter:)`.

**Investigation.** Not started beyond reading `linear.ts`. Every call goes through `linearGraphql` and `sanitizeLinearError`, which strips the key from errors.

**Decisions.**

- **Split the file?** `linear.ts` is 566 lines. Put the new writes in `linear-issue-writes.ts` and the team reads in `linear-team.ts`, keeping one `linearGraphql` (recommended).
- **Idempotency for creates.** Linear's `issueCreate` takes no idempotency key. Record each `requestKey` and the issue it created in a bounded store before answering, and answer a retry from it (recommended). Retrying blindly would create duplicate issues.

### 7. Give the coordinator full Linear tools

**Problem.** No coordinator tool touches Linear. The Kanban tools (`control-mcp/ticket-tools.ts`) are the only ticket tools, so a coordinator cannot use Linear as a source of truth.

**Context.** The Kanban tools take `projectId`, an optional `nodeId` and a `requestKey` on writes. They reach another node through `coordinator_node_ticket` and `portal.invokeOnNode`, reporting a lost answer as `outcome-unknown`.

**Investigation.** Not started. After tasks 1–5 every machine has its own key and the same board links, so a coordinator can call Linear directly from its own node for any project linked there.

**Decisions.**

- **Which tools?** `list_linear_issues` (state, assignee, label, text, cursor), `get_linear_issue` (id or identifier like `ENG-123`, with comments), `create_linear_issue`, `update_linear_issue` (title, description, state, priority, assignee, estimate, labels added or removed), `add_linear_comment` and `list_linear_board_options` (states, labels, members). They go in a new `control-mcp/linear-tools.ts` (recommended).
- **Scope.** Every call names a project and is refused when the issue is not on that project's linked board (recommended). Otherwise a coordinator could change any team the key can see.
- **Where do calls run?**
  - **On the coordinator's own node with its own key; `nodeId` only for a project that exists only on a leaf, through `invoke_on_node` (recommended).**
    - Pros: Linear is the shared store, so there is nothing to route in the common case.
    - Cons: a node with no connection answers "Linear is not connected on <machine>", pointing at task 1.
  - **Always on the node that owns the project.**
    - Pros: mirrors the Kanban tools.
    - Cons: an extra hop and an `outcome-unknown` case for no gain.

### 8. Keep Kanban first

**Problem.** The user wants local Kanban to stay the priority while Linear is fully usable.

**Context.** The coordinator prompt and tool list present the Kanban tools today.

**Investigation.** Not started.

**Decisions.**

- **How is "Kanban first" expressed?**
  - **The prompt names Kanban as the default board, offers the Linear tools only for a project with a linked board, and says to use Linear when the user names a Linear issue or the project is run from Linear (recommended).**
    - Pros: a coordinator without a link sees no Linear noise; Kanban behaviour is unchanged.
    - Cons: a prompt rule needs a live check that models follow it.
  - **A per-project "source of truth" setting (Kanban or Linear).**
    - Pros: explicit.
    - Cons: one more setting; see Open questions.

### 9. Document the model

**Problem.** `tickets.md` mentions Linear only in passing, and the task 2 copy is an exception to a written rule in `command-nodes.md`.

**Context.** The docs are under `docs/architecture/`, which `instruction-links.test.ts` checks.

**Investigation.** Not started.

**Decisions.** Add a "Linear" section to `tickets.md` (account per machine, board per project, sync, tools), and amend `command-nodes.md` "Settings" to name the one user-initiated Linear key copy (recommended).

### 10. Check it live on two linked machines

**Problem.** Every path is covered by tests with real storage and a faked Linear API and node link, but no run has used two real backends and a real Linear key.

**Context.** `docs/development/agent-testing.md` describes linked `dev:test` profiles; to-do 1030 (retired) task 2 used the same set-up, through the mixed-version runner ([Choosing a machine](../../architecture/coordinator.md#choosing-a-machine)).

**Investigation.** Not run. The steps: connect on the leaf profile, link a board, attach the leaf to a command profile, wait for a sync pass, and check the command profile's Linear tab shows the same board and offers Use it here; then disconnect on one and check the other clears.

**Decisions.**

- **Which key?** A throwaway Linear workspace's personal key (recommended), so a bug cannot touch real issues. A real workspace key would also work but writes to real issues.

## Assumptions and decisions

### Board links are keyed by repository (tasks 4 and 5)

The user asked (2026-11-11) that connecting by machine work "by repo: if the same repo is also registered on the other machine, then it attaches to that repo's project". A link is stored under `repo:<repositoryHint>`, the same identity Kanban sync pairs projects by, so it needs no pairing step and reaches a project on a machine that adds the repository later. A project with no Git remote is keyed `project:<id>` and stays on its machine.

### Kanban and Linear stay separate (Open questions)

The user said (2026-11-11) a ticket is one or the other, so no Kanban ticket links to a Linear issue.

### Board-link sync is a small service of its own (task 5)

`NodeLinearSync` swaps the whole (small) state each pass instead of joining `NodeTicketSync`'s cursors and outbox: a machine has one link per repository, so a full read is cheaper to reason about than a third record kind in the ticket protocol. It reuses the same triggers. The cost is that a leaf's change waits for the command node's next pass (at most a minute) instead of an outbox announcement.

### A synced link names no project (task 5)

A link arriving from another machine drops `projectId`, because project ids differ between machines; lookups go by key.

### A status read keeps when the key was connected (task 3)

`get_linear_connection` used to rewrite `connectedAt` on every read. It now keeps it, because a disconnect elsewhere is compared with `connectedAt`; rewriting it would let any status read undo a disconnect.

### The coordinator tools are not offered to operator credentials (task 7)

The operator tools go through public actions, which have no Linear surface; the tools are registered for coordinator credentials only.

### `add_linear_comment` is not idempotent (task 7)

Linear's `commentCreate` takes no idempotency key and the completion-comment marker trick would leave a visible marker in every comment. The tool says a retry posts again; `create_linear_issue`, where a duplicate costs more, records its request key.

### Kanban first is said in the tool descriptions, not the context prompt (task 8)

Each Linear tool's description says Kanban (`list_tickets`) stays the default board and to use Linear when the user works from Linear or names an issue, and the backend answers an unlinked project with "no Linear board linked". The context prompt is unchanged: a context line would cost every coordinator turn for projects that never use Linear. If live runs show coordinators reaching for Linear unasked, a prompt line is the next step.

## Constraints and rationale

- The key never reaches a renderer response, a log, a metric, a transcript or the model (invariant 12). Errors go through `sanitizeLinearError`.
- Only non-secret state syncs: board links, revocations, status and fingerprint.
- Each machine keeps working with Linear when it is cut off from the others.
- One pipeline for tasks 1–9: they share the store, the sync kind and the docs.

## Open questions

- Is a per-project "Linear is the source of truth" switch wanted beyond task 8's tool descriptions? Not asked; nothing depends on it.

## Related

- `apps/backend/src/core/linear.ts`, `commands-registry-linear.ts`, `control-mcp/ticket-tools.ts`, `nodes/node-ticket-sync.ts`.
- `docs/architecture/tickets.md` (ticket sync), `docs/architecture/command-nodes.md` ("Settings").
