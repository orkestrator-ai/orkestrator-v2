# Project Coordinator

Status: Living — current product and architecture.

Select a project to open **Coordinator**, the default project page. Coordinator
reads and discusses the configured local checkout, searches the code, and uses
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

What is still missing — mainly provider parity — lives in
[`docs/todo/coordinator-to-implement.md`](../todo/coordinator-to-implement.md).
Engine internals live in [`agent-engines.md`](agent-engines.md). Control MCP
operator detail lives in [`control-mcp.md`](control-mcp.md). Qualification
invariants for agents live in `AGENTS.md` under **Coordinator qualification**.

## Ownership

A coordinator is not a local environment whose `worktreePath` happens to point
at the project root. Existing environment delete, merge, setup, and cleanup
paths assume they own a disposable workspace. Routing the checkout through them
would risk modifying or deleting the user's repository.

The durable owner is `{ kind: "coordinator", projectId, coordinatorId }`.
Provider processes, projections, queues, transcripts, attachments, and mail
use a distinct `coordinator:` runtime namespace
(`coordinator:<id>:<conversation>`). Each conversation gets its own bridge so
its scoped MCP and mail credential cannot be shared with a sibling tab.

One workspace is persisted per project: conversations, selected tab, immutable
`coordinator-read-only` execution policy, repository-context revision, lifecycle
state, and sanitized last startup error. Workflow associations are stored
separately so their lifetime is independent of an open chat tab.

The working directory is the canonical `Project.localPath`. A project without a
valid local path shows a checkout setup state; it does not silently use an
environment worktree, a container, or a temporary clone. Bridge state,
transcripts, attachments, and generated configuration live under application
data. Opening Coordinator does not run project setup scripts, install
dependencies, copy environment files, or load repository hooks.

Unmounting the page or changing projects detaches the view only. Backend-owned
sessions, pending mail, and workflows continue. Closing a conversation settles
live approvals, revokes its credential, and tombstones its mailbox without
deleting provider history or the checkout. Orkestrator does not silently
recreate a tab the user just closed. Removing the project stops Coordinator and
deletes the isolated runtime, never the user's local repository.

At most 16 conversations may be open. Unassigned conversations count toward
that limit.

## Choosing an agent

A conversation has no agent until its first prompt. The composer offers every
platform this machine qualifies, with the repository default preselected, and
the first send binds the conversation to whichever was chosen. That binding is
one-way: the transcript and rollout belong to that platform, so a different one
means a new conversation. Re-assignment is allowed only while the first send has
not yet reached a provider, so a failed start does not strand the conversation.

There is no silent fallback and no silent provider substitution. Control MCP may
be disabled globally; chat remains read-only and usable, while the page shows
that delegation controls are unavailable.

## Provider qualification

Coordinator runs against the project's real checkout, so how strongly a
platform holds the read-only boundary is named rather than flattened to
available/unavailable. The single table is
`apps/backend/src/core/coordinator-providers.ts`. Every gate — workspace
service, runtime resolver, bridge launcher, trusted session input — consults
it.

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks the mutation whatever the agent attempts | Codex; Claude where its command sandbox is available; Pi |
| `provider-configured` | The SDK is told to deny, and exposes no way to verify it | OpenCode, Cursor; Claude when the host has no command sandbox |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this installation will offer. It defaults to `provider-configured`:
`enforced` and `provider-configured` platforms are offered, and `advisory`
stays opt-in.

What each enforced platform actually does:

- **Codex** runs under a permission profile that denies the filesystem and the
  network inside the child process, with `sandbox: read-only`,
  `approvalPolicy: never`, and a private `CODEX_HOME` holding only `auth.json`.
  The bridge refuses to run a turn unless app-server echoes the profile back.
- **Claude** runs with the SDK command sandbox on and `allowUnsandboxedCommands`
  off, `permissionMode: dontAsk`, an allowlist that excludes every writing tool,
  `settingSources: []`, a private `CLAUDE_CONFIG_DIR` holding only the
  credential, and a bridge-owned `PreToolUse` hook. The hook is the real
  boundary for shell: it allows a fixed list of reading commands and refuses
  pipes, redirection, substitution and chaining. On Windows, where there is no
  command sandbox, Claude drops to `provider-configured` automatically.
- **Pi** blocks every tool outside its read-only set in its own `tool_call`
  gate, which runs in the bridge process and cannot be switched off by the
  workspace.

OpenCode denies through its own permission rules and runs its `plan` agent, but
always loads the checkout's project configuration, including any MCP servers it
declares. Cursor applies the sandbox and a tool ban but exposes no approval
callback, and is refused outright if its sandbox cannot be enabled.

The coordinator policy names operations, not one provider's tool strings:
`capabilityPolicy.deny` is `file.write`, `file.patch`, `shell.mutate`, and
`network`. Each bridge translates that list. `toolPolicy` stays Codex-shaped
and is also the user-override surface, so it cannot carry the translation.

Every coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. That is process
authority: the bridge replaces whatever policy a request body or a persisted
record carries, so a permissive record cannot survive a restart and widen a live
conversation.

## Attachments

Pasted images and other prompt attachments are staged under application data, in
a per-conversation directory, never in the checkout a coordinator may not write
to. A bridge otherwise confines an attachment path to its session's workspace,
so each coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT` naming that one directory as a second
readable root; Codex additionally grants it `read` in the conversation's
permission profile. Like the execution policy, this is process configuration —
a request body cannot name a root of its own — and it is scoped to the one
conversation. Deleting the project removes them with the rest of the coordinator
runtime.

## Repository toolbar

The toolbar shows the canonical path, branch, upstream freshness, ahead/behind
state, local changes, and any retained Git error. **Refresh** fetches remote
state. **Sync** performs only a fast-forward pull. Branch switching and sync are
disabled for dirty or conflicted repositories, an ongoing merge or rebase, an
occupied worktree branch, or an active coordinator turn.

These buttons are explicit user actions. The coordinator agent cannot invoke
them. Mutations are serialized by canonical repository root, across windows and
tabs, and hold a lease that also prevents new coordinator turns and mail
injections from starting. After a successful or externally detected branch or
HEAD change, the repository-context revision increments and is supplied before
the next turn so the agent does not assume its old analysis still describes the
checkout.

A chip in the same toolbar shows **Waiting on N workers** when the selected
conversation has open delegations. It is a projection from the snapshot, not
from anything this page observed, so it is correct after a reload.

## Control MCP

Coordinator uses the same Control MCP HTTP endpoint as an ordinary external
client, with a separate backend-issued credential bound to project, workspace,
conversation, mailbox incarnation, and allowed capabilities. The credential is
written only into the trusted bridge runtime; it is not returned to the
renderer or stored in a transcript. Closing the conversation revokes it.
Restart reaps the old bridge and issues a new credential on reattachment.

Role is authenticated server-side. Supplying `role: coordinator`, a sender tab
id, or text in a message cannot gain coordinator privileges. Discovery is
limited to the bound project. Environment and workflow mutations must target a
disposable worker in that project. The credential cannot dispatch arbitrary
backend commands, change application settings, merge or delete the root
checkout, or mint credentials.

Delegation tools return as soon as the resource is reserved and started. Their
JSON result includes `delivery: "async"`, a wake sentence, and
`nextStep: "Finish your turn now. Do not poll."` The same contract is the
exported `COORDINATOR_ASYNC_CONTRACT` used in the coordinator context prompt
and the mailbox poll guard.

Repeated unchanged reads of `read_messages` or `get_message_status` return the
authorized page with `repeatedRead: true` and the contract attached, after
three identical answers inside 120 seconds. The guard never withholds data.
`list_environments` is not covered.

## Worker delegation

Delegation is a round trip. `launch_environment` goes out over MCP, and the
worker's result comes back as agent mail — so a platform needs both an MCP
client and a native mailbox that can pull, ack, and be injected into.
`delegation` on the qualification is derived from those two halves, not
declared per platform.

**Delegation is available on every native platform** that has an MCP client
and `{canPull,canSend,canInject}=true`: Claude, Codex, OpenCode, Pi, Cursor,
and Grok. Cursor and Grok receive a per-tab `agentMcp` on create/prompt;
the process-env token is only the fallback. Grok still needs the host
safety setting to admit `advisory`.

Worker creation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker. A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers.

A coordinator turn ends when it has delegated. It does not wait for the worker,
so the composer stays open. A prompt typed during a turn is queued and runs
before any worker mail. While the turn is running the send button reads **Send
after this turn**.

Each launch, job, or message to a worker opens one **delegation** on the
workflow association (`requestedAt`, `workerTabId`, `state`, `wakeKind`,
`wokenAt`). Each delegation wakes the conversation exactly once, when that
worker's turn ends (`working → idle`). Environment error, stop, or deletion
closes it as `failed` or `stopped` on the periodic sweep. A worker blocked on
an approval or a question has not finished — that needs a person — so
`working → waiting` does not close the delegation.

Nothing the worker does mid-turn wakes the coordinator. Progress mail is stored
and readable, held with reason `delegation-running`, and released together with
the final report. The mail drain claims every ready message for one mailbox,
renders them into a single carrier in send order (bounded at 10 messages and
128 KiB), and settles them together. A worker that finishes without reporting
still wakes its coordinator, with a system notice saying so. A second live
request to the same worker tab is rejected: one turn-end cannot identify which
queued request it completed.

Coordinator sessions participate in the same activity reconciler as environment
sessions, so `idle` is an observed edge. That edge drains mail and the prompt
queue immediately. User prompts queued during a turn still run first.

Pause or mute messaging, or set a mailbox's injection policy to **Off**, to
hold automatic delivery. Stored, injected, acknowledged, and completed remain
distinct states. An injection receipt is not proof that the task finished.

## Complete application actions

Use `launch_multi_review` for an environment's **Multi Review** button. Pass a
stable `requestId`, the environment ID, and the same `reviewers` and `fixModel`
rows accepted by the launch dialog (`agent`, `model`, optional
`reasoningEffort`). `get_launch_options` supplies available model choices.
The caller chooses the rows explicitly; this API does not invent reviewer
defaults. Omitted `targetBranch` and `reviewInstruction` use the repository's
PR base branch (falling back to `main`) and the global review instruction.
An empty instruction explicitly clears the instruction for this launch.

This action has no build-pipeline prerequisite. It reopens an active review
regardless of the new selections, or reserves an immutable workflow ID and
starts one review. It then creates or focuses the root Multi Review tab in the
environment's selected pane. It does not change the global project/environment
navigation: an inactive environment receives the durable tab and selection,
which its renderer adopts when the user returns.

`open_multi_review` reopens/focuses that root without starting work.
`open_multi_review_fix` opens/focuses the authoritative Fix provider session
without sending a turn. `address_multi_review` now opens the root first and
records the backend's idempotent fix handoff; the supervisor publishes and
selects Fix after confirmed dispatch when the foreground action initiated that
attempt. A background retry or backend-restart resume publishes Fix without
changing the current tab or pane. A repeated address call returns the existing
interactive handoff. An unassociated workflow started from the renderer remains
available within its project. When an association exists, these controls require
it to belong to the current coordinator conversation; use `adopt_workflow` for
an orphaned or closed conversation's association before opening it.

Read the result before reporting success:

- `outcome: "opened"` and `ui.status: "opened"` confirm durable presentation;
  `ui` names the tab, pane, and layout revision. `reused` distinguishes reattach
  from a new launch. MCP returns a bounded workflow summary; backend commands
  return the workflow snapshot with controller fences removed.
- `outcome: "pending"` on address confirms a durable intent, not prompt delivery.
  Inspect `get_multi_review` for `addressPromptPending`, `presentationError`, and
  `fixTabId`. Do not send another fix prompt manually.
- `outcome: "partial"` is an MCP error result with the saved workflow and an
  actionable `recovery` message. A new launch whose tab cannot be published
  requests cancellation. Cancellation may still be in progress or unconfirmed;
  the result says which. An already active review is never cancelled because
  reattachment failed. Completed cancellation records are retained as retry and
  recovery evidence.

Retry launches with the same request ID and payload. The durable coordinator
receipt and reserved workflow identity survive backend restarts, including the
gap between workflow persistence and receipt completion. Reusing a key with a
different payload is rejected. If the associated workflow was explicitly
deleted, retry fails instead of silently starting fresh work. Change the key
only when deliberately asking for a new action.

Tab writes recompute their semantic intent against the latest layout after a
CAS conflict. They preserve concurrent pane structure, moves, and tabs, enforce
the tab limit on each attempt, and announce the existing `pane-layout` resource.
Workflow writes announce `multi-review`. Both initial restoration and live
authoritative reconciliation load referenced workflows before installing tabs.

### Exposed-action audit

| Existing control / button family | Durable consequences and disposition |
| --- | --- |
| `start_multi_review` / Multi Review | Backend-only and build-gated; retained for diagnostics/recovery. Its metadata explicitly prefers `launch_multi_review`, which adds root-tab publication, focus, readiness checks, reattachment, and truthful recovery. |
| Multi Review open / Open fix session | Added `open_multi_review` and `open_multi_review_fix`; operate entirely through backend snapshots and pane persistence. No additional provider turn. |
| `address_multi_review` / Address findings | Upgraded to the complete action above. Existing backend handoff already owns session adoption, turn idempotency, and eventual Fix publication; it now selects that tab when published and reports queued/partial outcomes. |
| `start_build_pipeline` / Build | Already complete: `BuildPipelineService` owns environment provisioning, workflow persistence, Kanban/feature ownership, root-tab creation and selection, with supervisor repair. Reuse it; no duplicate wrapper added. |
| `pause_build_pipeline`, `resume_build_pipeline`, `cancel_build_pipeline`, `cancel_multi_review` | Backend transitions already durable; these buttons have no required new pane or tab consequence. |
| `launch_environment` / New environment | Existing backend operation owns creation, startup tab/initial-prompt state, and background start. Its accepted/created/error distinction already reports partial startup. |
| `launch_job` / Agent action | Already creates a durable native tab, binds a provider session, and dispatches an idempotent initial turn. Now requests tab activation, matching the button. Later binding/retry writes preserve focus so slow launch completion cannot steal a user's newer selection. |
| `send_prompt_to_tab` | Existing durable intent dispatcher; targets an existing native tab and creates no additional tab. |
| Start/stop environment, ticket edits, adoption, mail | Existing backend mutations; no renderer-only workflow launch step. Mail preserves separate stored/injected/acknowledged outcomes. |

Terminal/tmux launch already has a backend `launch_terminal_job` command with
stable tabs, process ownership and bootstrap journaling, but it is not currently
exposed by coordinator MCP. Browser launch/navigation, arbitrary pane editing,
custom-fix model switches, reviewer subtabs, looped review and feature-plan
launch are likewise not exposed coordinator controls. Repository checkout
mutation controls remain unavailable to coordinators.

## Tests that exist today

The async and read-only contracts are asserted at the layer that owns each
guarantee, not by one end-to-end scenario replayed per platform:

- coordinator presence and the turn-end edge:
  `native-agent-service-reconciliation.test.ts`
- one-wake invariant and crash recovery: `coordinator-service.test.ts`
- single-turn mail batching: `agent-mail-service.test.ts`
- tool contract and poll guard: `control-mcp-server.test.ts`
- no-waiting-tools boundary and tier table: `coordinator-conformance.test.ts`
- per-bridge activity and policy tests already cover whether a bridge reports
  `idle` at turn end and how it translates `capabilityPolicy`

A live per-provider tree-hash suite is not in the tree. That gap is part of
[`docs/todo/coordinator-to-implement.md`](../todo/coordinator-to-implement.md).
