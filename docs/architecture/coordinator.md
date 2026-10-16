# Project Coordinator

Status: Living — current product and architecture.

Select a project to open **Coordinator**, the default project page. Coordinator
reads and discusses the configured local checkout, searches the code, and uses
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

What is still missing — mainly provider parity — lives in
[coordinator-read-only-adapters.md](../todo/coordinator-read-only-adapters.md),
[coordinator-live-conformance.md](../todo/coordinator-live-conformance.md) and
[coordinator-consistency-gaps.md](../todo/coordinator-consistency-gaps.md).
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
A conversation's native session key is the ordinary tab key,
`env-coordinator:<id>:<conversation>:<tabId>`
(`coordinatorConversationSessionKey`), on every path — the renderer, mail
injects, close and the projection checks. Any other key opens a second
provider session on the same bridge, so a mail-woken turn runs where the tab
never shows it. Records with the older `coordinator-<id>:<conversation>` key
migrate when read.

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
deleting provider history or the checkout. Removing the project stops
Coordinator and deletes the isolated runtime, never the user's local repository.

## One main coordinator, and side agents

A project has exactly one **main** coordinator conversation
(`CoordinatorConversation.role`). Every worker reports to it and it owns all
delegation. Any agent reaches it at the mail address `"coordinator"`
(`COORDINATOR_MAIL_ADDRESS`), which resolves to whichever conversation is the
main right now; an address of a conversation that has since closed is
redirected there too.

Closing the main tab is how its provider is changed. Nothing reopens it on its
own until it is needed: the next agent mail to the coordinator, or a worker's
delegation wake, starts a new main with the repository's default agent
(`CoordinatorService.ensureMainConversation`) and moves onto it the work the
closed one still owed a report for (open delegations, unreported workflows).
A build-pipeline or review notice does not start one by itself — it waits for
the next main — so finished work from long-closed conversations cannot wake a
fresh coordinator. With no main open, the toolbar action reads **Start
coordinator**.

Every other conversation is a **side agent**, named Side 1, Side 2… (the lowest
free number). A side agent reads the project and Orkestrator state (its
credential carries only the `discovery` and `mail` capabilities, so it launches
nothing), and exchanges mail with the main coordinator only: the mail store
refuses side ↔ worker and side ↔ peer mail in both directions. The user may
still write to it.

Records from before roles migrate when read (`normalizeCoordinatorRoles`): the
selected conversation, else the oldest with an agent, becomes main and the
others become side agents. Nothing is closed. Workers a former conversation
launched belong to the main.

At most 16 conversations may be open, the main included.

## Tab groups

Conversation tabs split into tab groups the same way environment panes do:
drag a tab onto another group's strip to move it, or onto a pane edge to open
a new group beside or below it, so a side agent can sit next to the main
coordinator. Dividers resize, and a group closes when its last tab leaves.
Each group has its own **New side agent** action, and a new conversation
joins whichever group is focused.

The arrangement is renderer presentation only
(`apps/web/src/lib/coordinator-pane-layout.ts`, persisted per project in
`coordinatorPaneLayoutStore`). It never opens or closes a conversation; on
every snapshot it is reconciled against the backend's open set, dropping
closed conversations and placing new ones. Focusing a group selects its front
conversation (`selectCoordinatorConversation`), and a selection made elsewhere
brings that conversation to the front of its group. Only each group's front
conversation is mounted.

## Project home

The files pane works on the project board too. With a project selected and no
environment, the toggle (⌘E) opens the pane on **All files** for the project's
own checkout (`Project.localPath`); reads go straight to that path. A file
dropped, moved, created, reverted or deleted there is applied to the checkout
itself, never to a worktree, and appears under **Changes** like any edit.

Every file mutation and every session needs an environment record, so the
checkout is represented by one **project home** environment per project
(`projectHome: true`, `apps/backend/src/core/project-home-environment.ts`). It
is a local environment whose `worktreePath` is the canonical repository root.
`ensure_project_home_environment` creates it on first use and re-reads the
checkout's current branch on every call. It has no sidebar row: selecting a
project with a checkout activates its home (`useProjectHomeActivation`). The
toolbar then shows the ordinary environment controls, acting on the home, so
Review, Multi Review, its Fix session and Create PR run directly on the main
checkout. The project tabs sit on a row beneath: **Home** shows the home's own
tabs, and Coordinator, Kanban, GitHub, Linear and Features cover them with a
board panel. The home's tabs stay mounted under the board, so a tab launched
from the toolbar while a board panel is showing switches the page to **Home**.
The PR prompt branches off the base branch before committing when the checkout
is on it, and the stored branch follows the checkout after each agent turn.

The project home is a writable environment, not a coordinator, and is never a
disposable workspace. These invariants are enforced by the backend:

- `projectHome` is set only at creation; `updateEnvironment` cannot set it.
- Start never creates a worktree for it and setup scripts never run against it.
- A rename changes the display name only, never the checked-out branch.
- Deleting it removes the record and runtime state; the cleanup entry schedules
  neither the worktree nor the branch step.
- A coordinator credential cannot target it (scoped invoker, Multi Review
  launch, and address), because that would let a read-only coordinator delegate
  writes into the checkout it may only read.

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

### Changing qualification

Do not reintroduce a platform literal at any of the gates listed above — that
is what previously let a platform be half-qualified, allowed to hold a
conversation but refused a bridge.

Moving a platform to `enforced` is a claim that the provider or the OS blocks
the mutation whatever the agent attempts. It requires both:

- a translation of `capabilityPolicy` into that provider's own vocabulary, in
  the bridge, applied on create, resume, config and every turn; and
- `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only` honoured as
  process authority, so a request body or a persisted record cannot widen a
  live conversation across a restart.

`toolPolicy` cannot carry that translation: its strings are Codex's tool names,
so the same list means "Write, Edit" on one bridge and nothing at all on
another. Use `capabilityPolicy`, which names the operation rather than the tool.

Before moving a platform to `enforced`, run the live read-only suite for it
(`mise run test:agent:coordinator --credential-source <platform>`) and keep the
summary it writes. The unit tests show that the bridge translates the policy.
Only a live run shows that the provider holds it.

Where a platform cannot honour an axis, report it in the policy's `note` and
leave the tier at `provider-configured`. Do not silently drop the axis, and do
not claim a boundary the bridge is not holding — the tier is shown to the user
next to the platform they are choosing.

`delegation` is derived, not declared per platform. It is an MCP client *and* an
injectable native mailbox, because `launch_environment` goes out over MCP while
the worker's reply comes back as agent mail. Native Claude, Codex, OpenCode,
Pi, Cursor, and Grok all have both. Cursor and Grok consume per-tab
`agentMcp` the same way Claude and Pi do; the process-env token is only the
fallback. Deriving delegation from the outbound half alone is what would
let the coordinator prompt promise workers whose mailbox cannot receive the
answer.

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
disabled for conflicted repositories, an ongoing merge or rebase, an occupied
worktree branch, or an active coordinator turn. A dirty checkout blocks sync,
but the branch picker remains available and asks the user to confirm discarding
tracked and untracked changes before switching. A branch without an upstream is
a valid local-only state and does not block branch switching; refresh fetches
all configured remotes in that state so their branches remain discoverable.

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
`working → waiting` does not close the delegation. Once the wait has lasted
20 seconds the coordinator does get one status notice saying so (see
[Status wakes](#status-wakes)), so it can tell the user; it still cannot
answer on the worker's behalf.

Nothing the worker does mid-turn wakes the coordinator. Progress mail is stored
and readable, held with reason `delegation-running`, and released together with
the final report. The mail drain claims every ready message for one mailbox,
renders them into a single carrier in send order (bounded at 10 messages and
128 KiB), and settles them together. A worker that finishes without reporting
still wakes its coordinator, with a system notice saying so.

In the coordinator's transcript every delivered message — a worker's report,
a peer's mail or a workflow notice — is a collapsed mail tile rather than the
full text, so a long report no longer takes over the view. The tile's icon and
tone come from the carrier's structured `kind` and `notice`, never from the
prose, and a batched wake shows one tile per message (see
[`agent-messaging.md`](agent-messaging.md#how-a-message-moves), "Carrier").

A follow-up message to a worker that is still on an earlier request joins that
delegation instead of opening a second one: the open delegation does not close
while the follow-up is undelivered, so the worker reads it in its next turn and
the coordinator is woken once, after both. (`send_prompt_to_tab` and
`launch_job` still refuse a second live request to the same tab.)

"Finished" is read from the turn, not the process: a worker whose turn ended
while background tasks still run counts as idle on the sweep, so a missed
turn-end edge cannot hold its report until those tasks finish. A report held
for a delegation that closed and was woken without it (a race with the
"finished without a report" notice) is released on the next sweep.

Mail for a stopped worker waits in its inbox. A stopped **local** worker is
started (at most once every five minutes) and the mail is delivered once it
runs; a stopped **container** is never started behind the user's back — the
coordinator gets one notice per worker per hour asking it to call
`start_environment` or ask the user. The coordinator's `send_message` result
carries a `deliveryNote` saying which. Peer mail never starts an environment.

When a new main starts after the old one was closed, unhandled mail from the
old main's inbox moves to it — a report still owed to a delegation stays held
for that delegation, anything else is delivered.

Coordinator sessions participate in the same activity reconciler as environment
sessions, so `idle` is an observed edge. That edge drains mail and the prompt
queue immediately. User prompts queued during a turn still run first.

A launched worker wakes only the main coordinator: mail it sends to a sibling
worker or an ordinary environment is stored without a wake (route `isolated`,
see [`agent-messaging.md`](agent-messaging.md#routes)), and mail to a side
agent is refused. Mail between the main and its workers wakes whatever the
default inject policy is. Workers are told to report with `send_message` to
`"coordinator"`; the coordinator may message a worker by environment id alone,
which resolves to the tab it is waiting on or the environment's agent tab.

`list_agents` (discovery) returns every agent tab in the project and what each
is doing — see [`agent-registry.md`](agent-registry.md).

Pause or mute messaging, or set a mailbox's injection policy to **Off**, to
hold automatic delivery. Stored, injected, acknowledged, and completed remain
distinct states. An injection receipt is not proof that the task finished.

## Status wakes

Besides the delegation wake, a coordinator is woken when other work it started
or prompted **settles**, so it can keep track and respond without polling
(`apps/backend/src/core/coordinator-status-wakes.ts`).

**Ownership.** Only resources with a coordinator workflow association: the
durable record written at launch or prompt time with the coordinator and
conversation ids (`launch_multi_review`, `start_multi_review`,
`start_build_pipeline`, and the delegations `launch_environment`,
`launch_job`, `send_prompt_to_tab` and `send_message` open). A Multi Review or
build the user started in the UI has no association and never wakes a
coordinator. Notices go to the main coordinator, like every other report, and
do not start one: with no main open they wait, and the sweep sends the state
current when one opens.

**What wakes it.** Each resource is reduced to one settled status with a
stable key; a key is sent once, recorded on the association
(`statusNotice`).

| Resource | Status | Setting that sends it |
| --- | --- | --- |
| Multi Review | consolidation `ready` (finding counts by severity, coverage gaps, verdict) | `settled` |
| Multi Review | interactive fix turn finished (`fix-done`) or failed (`fix-failed`) | `settled` |
| Multi Review | a reviewer, consolidation or fix session `stalled` | `settled` |
| Multi Review | `completed` (fix summary, files changed), `failed` (error), `cancelled` | always |
| Multi Review | all reviewers finished and consolidation started (`reviews-finished`) | `stages` |
| Build pipeline | `paused` by the supervisor on an error (a requested pause is not news) | `settled` |
| Build pipeline | a stage `stalled` (`stallWarning`) | `settled` |
| Build pipeline | `completed` (task, last verification), `failed` (error) | always |
| Build pipeline | a stage completed (`stage-completed`: build, review, address, verification) | `stages` |
| Delegated tab | `waiting` on input or an approval for 20 s (with its last message) | `settled` |
| Delegated tab | turn ended: the worker's report, or `completed`/`failed`/`stopped` with its last message | always (the delegation wake) |

Individual reviewers finishing never wakes anyone: that is progress, and a
seven-reviewer panel would otherwise be seven turns. A relaunched fix, a second
consolidation, or a new stall or waiting episode has a new key and is sent
again.

**Setting.** **Settings → Messaging → Coordinator status updates**
(`coordinatorStatusWakes`): *Finished work only* (`off`, what woke a
coordinator before status wakes), *Decisions and problems* (`settled`, the
default) and *Every build stage too* (`stages`). It applies to coordinator-
created resources only; there is no per-resource opt-in.

**Message.** An ordinary workflow notice (`from.kind: "system"`) with a
structured `notice` (resource kind and ids, state, tone), a subject such as
"Multi Review api-fix is ready to address", a bounded Markdown body (at most
eight 400-character detail lines) and the calls that read more or act —
`get_multi_review`, `address_multi_review`, `open_multi_review_fix`,
`get_build_pipeline`, `resume_build_pipeline`, `get_tab_state`,
`get_tab_transcript` — written out with their arguments. In the transcript it
is a mail tile toned by the notice.

**No wake storms.**

- Dedupe: one notice per status key, recorded durably; the mail request id is
  fixed by association, conversation and key, so a crash between placing a
  notice and recording it cannot send it twice.
- Coalescing: a status notice is held 10 seconds (`coalesceMs`); notices
  arriving while the window is open join it, so reviews settling together are
  one wake, and the drain batches them into one carrier (at most 10 messages,
  128 KiB). A coordinator mid-turn gets everything that settled meanwhile in
  its next wake.
- Debounce: workflow saves are observed at most every 2 seconds per resource;
  a waiting episode must last 20 seconds before it is reported, so an approval
  answered at once wakes nobody.
- Budget: each resource's notices are budgeted as one routed pair with the
  coordinator (`statusBudgetKey`), so the unattended budget and the hourly
  limit hold them exactly as they hold a chatty worker. The user prompting the
  coordinator, or **Resume**, starts a new budget.
- Upgrade: a workflow first seen in a non-terminal settled state it reached
  more than a day ago is recorded without a wake.

**Delivery.** The durable mailbox and the existing drain: presence-gated
injection, ack/read semantics, retry and restart recovery are the mail
store's. Workflow saves wake an observation within seconds; the
`coordinator-repair` maintenance job (every 60 s, and at startup) re-reads
every owned workflow and open delegation, which recovers a missed save, a
timer lost to a restart, or bookkeeping that never landed.
`launch_multi_review`, `address_multi_review`, `start_multi_review` and
`start_build_pipeline` return `delivery: "async"` with
`COORDINATOR_WORKFLOW_STATUS_WAKE`, so the model is told it will be woken
rather than left to poll `get_multi_review`.

## Launch defaults

Coordinator-launched work runs the user's saved defaults unless the user asks
for something else. Coordinators used to copy a model and effort from
`get_launch_options` into every call, so each worker silently ran a more
expensive selection than the configured default. The rule is now stated in
three places that agree:

- `COORDINATOR_LAUNCH_DEFAULTS_RULE` (`packages/protocol/src/coordinator.ts`)
  is a single line in the coordinator context prompt and the Control MCP server
  instructions.
- The descriptions of `launch_environment`, `launch_job`, `launch_multi_review`,
  `start_multi_review` and `start_build_pipeline`, and of each model, effort and
  agent field, say that omitting the field uses the saved default.
- `get_launch_options` returns `defaults` (`agent`, per-agent
  `byAgent[agent] = { modelId, reasoningId }`, `guidance`) and marks each
  agent's default catalogue row with `isDefault: true`.

What an omitted choice resolves to:

| Tool | Omitted | Resolves to |
| --- | --- | --- |
| `launch_environment`, `launch_job` | `modelId`, `reasoningId`, `fastMode` | The platform column across environment → repository → app settings, else the agent's own default (`defaultReasoningId` for effort) |
| `launch_multi_review`, `start_multi_review` | `reviewers`, `reviewModel`, `fixModel` | The Multi Review button's rows: Review, Review 2, saved extra reviewers and reviewer count; Review preparation and Fix review issues, each falling back to Review |
| `launch_multi_review`, `start_multi_review` | auto-fix and auto-PR (not exposed) | The saved Multi Review settings |
| `start_build_pipeline` | `agentType`, `steps`, `reviewers`, `reviewPreparation` | `buildPipelineConfiguredDefaults` (`packages/protocol/src/build-pipeline-defaults.ts`), the resolver the Build button uses |

Every one of these can be overridden. A coordinator is told to override only
when the user has asked for a specific model, agent, effort or reviewer set.
Overrides layer the way the launchers do. For `start_build_pipeline`:

- A named step replaces only that step, and a step that names only an agent runs
  that agent's saved model.
- `steps.build.agent` decides the pipeline agent.
- Explicit `reviewers` replace the saved rows; otherwise an explicit
  `steps.review` becomes Reviewer 1.

Each Multi Review row field is replaced independently.

Multi Review rows resolve in `apps/backend/src/core/coordinator-launch-defaults.ts`
over the worker's model catalogue, mirroring the launch dialog: a stale saved
model falls back to the first connected catalogue model, and an effort or speed
is kept only when the chosen model offers it. When a platform has no catalogue,
the saved model id is kept. The request hash covers the caller's payload, not
the resolved rows, so retrying with the same `requestId` after the user edits
their defaults replays the original work.

Every launch reports what will run. `launch_environment` and `launch_job` return
`selection: { agent, model, reasoning, source }`, where `source` is `requested`
if the call set `modelId` or `reasoningId` and `default` otherwise. `model` is
null when no tier pins one and the agent picks its own. The Multi Review result
reports its rows the same way. `start_build_pipeline` reports the pipeline's
`agentType`, `steps`, `reviewers` and `reviewPreparation`, with a per-step and
per-field `source`. The environment and tab UI do not show a marker
for overrides yet; that is a tracked follow-up.

## Complete application actions

Use `launch_multi_review` for an environment's **Multi Review** button. Pass a
stable `requestId` and the environment ID. Omitted `reviewers`, `reviewModel`
and `fixModel` use the saved Multi Review defaults exactly as the button does
(see [Launch defaults](#launch-defaults)); explicit rows (`agent`, `model`,
optional `reasoningEffort`) replace them one field at a time. Omitted
`targetBranch` and `reviewInstruction` use the repository's PR base branch
(falling back to `main`) and the global review instruction. An empty
instruction explicitly clears the instruction for this launch. The result's
`selection` lists the rows the saved review runs and, per field, whether they
were `requested` or `default`.

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
- status wakes (ownership, one wake per settled transition per resource kind,
  coalescing, budgets, restart, bounds): `coordinator-status-wakes.test.ts`
- single-turn mail batching: `agent-mail-service.test.ts`
- tool contract and poll guard: `control-mcp-server.test.ts`
- no-waiting-tools boundary and tier table: `coordinator-conformance.test.ts`
- per-bridge activity and policy tests already cover whether a bridge reports
  `idle` at turn end and how it translates `capabilityPolicy`

- the read-only boundary against real providers: `mise run
  test:agent:coordinator` runs one live coordinator turn per platform in a
  disposable profile. Each turn attempts every class of mutation, then the
  suite checks that the checkout digest is unchanged and that read and
  discovery tools still answer. It is opt-in and never runs in `mise run test`
  or CI. See "Live coordinator suite" in
  [`agent-testing.md`](../development/agent-testing.md).

The live async and mail scenarios, and the runs that qualify each platform, are
in [coordinator-live-conformance.md](../todo/coordinator-live-conformance.md).
