# Project Coordinator

Status: Living — current product and architecture.

Select a project to open **Coordinator**, the default project page. Coordinator
reads and discusses the configured local checkout, searches the code, and uses
Orkestrator controls to delegate implementation to isolated worker environments.
It cannot edit the project checkout itself.

What is still missing — mainly provider parity and live qualification — lives in
[0026-coordinator-read-only-adapters.md](../todo/coordinator-and-multi-review/0026-coordinator-read-only-adapters.md) and
[0024-coordinator-live-conformance.md](../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md);
OpenCode and Grok steer in
[0005-mid-turn-steer-and-interrupt.md](../todo/agent-engines/0005-mid-turn-steer-and-interrupt.md);
worker-surface follow-ups (root changes on other nodes, adopting feature
plans) in
[0395-coordinator-worker-surfaces-follow-ups.md](../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md);
live qualification of the gap tools (`resolve_conflicts`, PR wakes,
`stop_worker_turn`, `get_worker_changes`, `fork_worker`, schedule edits,
worker slash commands, `answer_worker_question`) in
[1021-coordinator-gap-tools-follow-ups.md](../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md).
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
its scoped MCP and mail credential cannot be shared with a sibling tab. The
bridge reads that credential once, at launch, so it lives exactly as long as
the bridge: it is revoked when the process exits, the conversation closes or
the project is removed, every request revalidates its scope, and it has no
clock. An expiry only ever left an idle bridge alive with no Orkestrator tools,
which showed the user "orkestrator MCP authentication required".
A conversation's native session key is the ordinary tab key,
`env-coordinator:<id>:<conversation>:<tabId>`
(`coordinatorConversationSessionKey`), on every path — the renderer, mail
injects, close and the projection checks. Any other key opens a second
provider session on the same bridge, so a mail-woken turn runs where the tab
never shows it. Records with the older `coordinator-<id>:<conversation>` key
migrate when read.

One workspace is persisted per project: conversations, selected tab, immutable
`coordinator-read-only` execution policy, repository-context revision and
lifecycle state. Each conversation holds its own sanitized startup error.
Workflow associations are stored separately so their lifetime is independent of
an open chat tab.

### When a conversation fails to start

Each conversation has its own bridge, so a failed start belongs to that
conversation. `startLocalServerUnlocked` writes `startupError` on it and leaves
the workspace alone. A start that backend shutdown cut short records nothing.

While `startupError` is set (`coordinatorConversationRunnable` answers false),
that conversation has no runtime: `resolveCoordinatorRuntime` answers
`startup-failed`, Control MCP refuses its credential with 409, its mail waits
(`environment_unready`), it cannot send mail, and the registry and mailbox
directory list it as stopped. Every other conversation carries on, because
none of those checks look past the conversation they were asked about.

**When the main fails**, the same rule applies. Its credential and mail are
refused, so mail from workers, side agents and status wakes waits in its
mailbox. Side agents keep running, but no new delegation starts, because only
the main delegates. Retry delivers the waiting mail once its bridge is up.
Closing the failed main works as any close does: the next mail starts a new
main with the default agent, and open delegations move to it.

**No failure is workspace-wide any more.** A new backend never writes
`lifecycleState: "error"`. The value stays readable for a record an older
backend stored, which `ensure` recovers when the panel opens, and for a client
connected to such a backend, which keeps its toolbar banner
([version-compatibility.md](version-compatibility.md#register)). A missing
checkout or a disabled Control MCP is reported as itself, not as a failed start.

The pane shows the failure above its transcript, naming the conversation, with
**Retry**, **Close conversation** and **Copy error**. Retry
(`retry_coordinator_conversation`) only clears the error: the pane then
connects, and connecting is what starts the bridge. A second failure records
itself again. Opening the panel does not clear the error, so a reload cannot
hide it.

### Reading while paused, after a failed start, or with its platform unavailable

A paused coordinator, a conversation that failed to start, or one whose platform
is turned off or below the coordinator safety level can be read but not run.
`sendingHeldReason` on the tab holds sending and tells
`useNativeAgentSession` not to establish a session: it never calls adopt or
ensure, both of which resolve a provider, and that is what starts a bridge. It
still reads, and the backend answers those reads from saved data without
resolving a provider (`heldCoordinatorConversation`): the transcript from the
display tail or a cached view, and discovery as `missing`. State reads consult
an already cached provider for activity; an existing running or blocked turn
stays visible and Stop remains available. Stop uses only that cached provider
while held, so it can interrupt existing work without starting a bridge. No
cached provider means saved idle state. Held reads do not expose interactions
or composer controls. Enter in the composer
says why nothing was sent and keeps the draft. Resume or Retry connects the
same pane without a remount.

An unavailable platform is judged per conversation, by the same check that
refuses its runtime (`coordinatorPlatformAllowed`), so a sibling on another
platform keeps running. Its mail waits as a failed conversation's does.
Turning the platform back on, or changing the safety level, announces a `config`
change; the panel re-reads its snapshot and the pane connects. The waiting mail
goes out on the next delivery pass. While held, the mail banner states the hold
reason and withholds Deliver now. An unavailable platform's reason precedes the
pause reason in the composer, because Resume is refused until that platform is
allowed again.

### Workflow record limit and cleanup

Every project shares one list of at most 2,000 workflow associations
(`MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS`,
`apps/backend/src/core/coordinator-workflow-retention.ts`). Launches,
delegations, review and pipeline runs, graph runs, pull-request follows and
feature-plan requests each add one. When adding a record would go over the limit, the store first removes
a batch of up to 200 of the oldest finished records in the same locked write,
so a store near the limit does not clean up again on every launch. Records are
taken oldest `createdAt` first.

A record is never removed while something still reads it as live:

- a pending reservation (a launch is still creating its resource);
- a delegation that is running (waiting episodes included) or whose
  coordinator wake has not been delivered (`wokenAt` unset), which is what
  `listOpenCoordinatorDelegations`, `listUnwokenCoordinatorDelegations` and the
  reconcile sweep read;
- a review, pipeline or graph run whose persisted local state is active, even
  if a previous attempt already set `terminalNotifiedAt`, or a feature plan
  whose planning exchange is still attached and has not failed; unknown or
  remote resource state is retained conservatively, and so is a record of a
  kind this backend does not know;
- an unreported terminal local resource until 24 hours after its persisted
  `updatedAt`. A confirmed missing local resource can be reclaimed without a
  terminal notification. Missing/unreadable timestamps stay protected;
- a pull-request follow whose end the coordinator has not been told;
- a review that a live pull-request follow points at (`reviewAssociationId`);
- an environment's launch record (it carries `baseCommit`, which makes the
  coordinator the worker's creator for mail routing and puts the worker's
  sign-in prompts in the panel) while that environment exists, and every
  remote (`nodeId`) launch record, since whether a remote environment still
  exists is not known locally. A record whose node was released (see
  [Work on a node that leaves](#work-on-a-node-that-leaves)) counts as local
  work whose environment is gone, so it becomes clearable after its replay
  window;
- the newest delegation record for each worker tab while its environment
  exists, which goal and tab actions read as the coordinator's ownership of
  that tab;
- anything created in the last 24 hours, or with a request alias received in
  the last 24 hours. Alias arrival timestamps are written on review joins,
  reservation merges and PR-follow joins. Legacy aliases without an arrival
  timestamp remain protected because their expiry cannot be established.

If nothing can be removed, the write is refused with an error saying that all
2,000 records are still in use and that deleting finished worker environments
or letting running work finish frees room. Unknown remote state and legacy
aliases can still consume capacity; cleanup never assumes that an unreachable
remote resource has stopped.

**Why the limit is shared, not per project.** Every project's records live in
one store that is rewritten whole on each change, so the store's total size is
what every write costs, and a per-project limit would not bound that total. A
second, lower per-project limit would also refuse a user whose one busy
project needs the room while the store has plenty. The cost is the
noisy-neighbour case: one project holding many live or remote records can
fill the store for every other. Two things soften it. When a refused record
costs a coordinator its wake, `send_message` says so in its `warning`
(below). And the panel says when the store is close to refusing:

**`workflowStore` on the snapshot.** `ok`, `near-limit` or `full`
(`getCoordinatorWorkflowStoreState`), from how many records cleanup could not
clear. `near-limit` starts at `COORDINATOR_WORKFLOW_NEAR_LIMIT`, 1,800 records
in use: from there a cleanup at the limit frees less than one batch of 200, so
new work is refused within fewer than 200 launches unless something finishes
or is deleted. Below it a cleanup at the limit always frees a whole batch and
nobody needs to act. `full` is every record in use, the state in which the
store refuses. Below 1,800 records in total the answer is `ok` with no further
reads; above it the clearable records are counted with cleanup's own rules,
and the answer is reused for a minute while the store is unchanged. The
coordinator panel renders `CoordinatorWorkflowStoreBanner` through
`CoordinatorWorkerPrompts` at `near-limit` (warning) and `full` (alert), saying
that deleting finished worker environments or letting
running work finish frees room. The field is additive: an older renderer ignores it, and a
renderer reading an older backend gets no field and shows no banner.

What removal changes for the user:

- `list_workflows` and `snapshot.workflows` no longer list that old, finished
  history. The coordinator's waiting workers and the worker prompts banner
  come only from records that are kept.
- An old finished review whose record was removed has no owner left, so it
  opens without asking for adoption first, and addressing it records a fresh
  association for the conversation that addresses it. `adopt_workflow` on a removed record reports it was not
  found; there was nothing left to re-deliver.
- A retry of a request older than 24 hours whose record was removed is treated
  as new.

**Request ids.** A coordinator's request ids share one namespace across all of
its conversations (`coordinatorId` + `requestId`), so a retry still replays
after the main conversation is replaced. The context block and the server
instructions therefore say `COORDINATOR_REQUEST_ID_RULE`
(`packages/protocol/src/coordinator.ts`): every mutation needs a new unique
`requestId`; reuse one only to retry the same call. When an id names an
earlier request:

- the same payload replays it, and the launch, build and Multi Review results
  say so with `replayed: true` and `replayNote` (`COORDINATOR_REPLAYED_NOTE`),
  so a replay never reads as fresh work. Surface actions already answered
  `replayed: true`;
- a different payload, worker or tab is refused with
  `COORDINATOR_REQUEST_ID_REUSED_ERROR`, which says the id was used before,
  possibly by an earlier conversation, that nothing was done, and to use a new
  one; an id held by another conversation of the same coordinator says the
  same;
- `send_message` checks before sending: an id this coordinator already used to
  ask another worker is refused, because the message could open no delegation
  and no wake would come back. Any other failure to open the delegation after
  the message is stored, such as a full workflow store, comes back as the
  result's `warning` (`coordinatorDelegationNotOpenedNote`): the message was
  sent, no wake will come, why, and not to resend it. The send itself
  succeeds, because the mail is durable and delivered; failing the call would
  invite a retry under the same id with a surprising result. Mail to a worker
  on another node says the same.

A launch that leaves `agent` out is fingerprinted as "the default agent"
(`coordinatorLaunchIdentity`), so a retry after the user changes their default
still replays, as an omitted build choice already did.

The working directory is the canonical `Project.localPath`. A project without a
valid local path shows a checkout setup state; it does not silently use an
environment worktree, a container, or a temporary clone. Bridge state,
transcripts, attachments, and generated configuration live under application
data. Opening Coordinator does not run project setup scripts, install
dependencies, copy environment files, or load repository hooks.

A control-MCP operator or the CLI addresses a conversation as a public session
through this runtime ID; `apps/backend/src/core/public-api/sessions.ts` resolves
it from the coordinator store, never by creating an environment or pane layout.
See [control-mcp.md](control-mcp.md#coordinator-conversations).

Unmounting the page or changing projects detaches the view only. Backend-owned
sessions, pending mail, and workflows continue. Closing a conversation settles
live approvals, revokes its credential, and tombstones its mailbox without
deleting provider history or the checkout. Removing the project stops
Coordinator and deletes the isolated runtime, never the user's local repository.

### Work on a node that leaves

A node is released when this command node stops controlling it: the user
forgets it (`forgetNode`), or a handover gives it, or the handover target, to
another command node. `NodeService` calls `onNodesReleased` after the registry
write, and `CoordinatorService.nodesReleased` closes the work there in one
store write (`releaseCoordinatorNodeWorkflows`, `coordinator-node-release.ts`):

- each running delegation closes as `stopped` with `wokenAt` set, so no
  per-worker wake follows;
- each unreported workflow or pull-request follow is marked reported, and
  outcome watches end, so nothing on that node is read again;
- every record gets `nodeRelease` (`at`, `reason`), which retention reads as
  "its resources are gone here", so the records become clearable once their
  replay window has passed.

Each coordinator with live work there then hears one notice. A forgotten node's
notice says the work was closed as stopped; a handover's says the node is no
longer controlled here and its work may still be running under the new command
node. A report already held for a closed delegation is released as ordinary
mail on the sweep. A notice that could not be sent stays owed
(`nodeRelease.notifiedAt` unset) and the sweep retries it.

Records that name a node the registry no longer holds are released the same
way on the sweep, with reason `unregistered`: this covers nodes forgotten
before release existed, a release a restart interrupted, and any later path
that removes a node without the hook. The registry read is skipped, never
guessed, when it fails. An older backend ignores `nodeRelease` and keeps those
records as it did before; their delegations are already closed and woken.

**A node that stays unreachable.** An unreachable node is no news: its
delegations stay open, because the worker may finish and collecting its mail on
reconnect still delivers the report. The service keeps a first-unavailable
time per node in memory beside its other maps; any answer from the node ends
the episode. After `NODE_OFFLINE_NOTICE_MS` (24 hours) of failed reads, each
coordinator waiting on the node hears one notice for that episode, saying the
delegation stays open and that forgetting the machine closes it. A restart only
restarts the clock.

## Multiple machines

On a command node ([command-nodes.md](command-nodes.md)) a coordinator also
works across the nodes that node controls:

- `list_nodes` shows the connected nodes, whether each has a copy of this
  project (matched by repository identity) and, for this machine and each
  node, its running version, the commit it was built from and its OS and load
  (see [Choosing a machine](#choosing-a-machine)). A node's `version` comes
  from the hello of its current connection, so a leaf needs no update to report
  it and shows its new version once it reconnects after a restart. It is
  `null`, never a last-known value, while the node is disconnected, disabled
  or reconnecting. A version alone does not identify a commit, since builds of
  one version can hold different code. `buildCommit` does, and follows the same
  rule, reading the optional hello field of the same name. It is also `null`
  for a connected node with no commit to report: one that predates the field,
  or a development, test or modified build
  ([which builds report one](../development/releasing.md#build-commit)). A
  `null` commit means unknown, not that a fix is missing;
  `list_environments` lists the project's environments on them as well.
- Every environment and workflow tool takes an optional `nodeId` and works
  on that node's copy with the same contract as here: launches, jobs,
  prompts and messages open delegations that wake this conversation once,
  and build pipelines and Multi Reviews there send status wakes. See
  [command-nodes.md](command-nodes.md#one-tool-family-every-node).
  The older `*_node_*` forms (`list_node_environments`,
  `launch_node_environment`, `start_node_environment`, `stop_node_environment`,
  `send_prompt_to_node_tab`, `send_node_message`) were removed because they
  did less; `read_node_environment` stays, as the only way to read a file in
  another node's environment. `RETIRED_COORDINATOR_TOOLS`
  (`control-mcp-tools.ts`) names each replacement: a saved schedule that names
  a retired tool is paused with it. The backend commands behind them stay, so
  older command nodes and leaves are unaffected
  ([version-compatibility.md](version-compatibility.md)).
- Tickets are shared: the project's board syncs to every node with a copy,
  under the same ids. `create_ticket` (with or without `nodeId`) and then
  `start_build_pipeline` with a `nodeId` builds a ticket on that node by its
  id, with no relay through that node's coordinator. See
  [Tickets on other machines](#tickets-on-other-machines).
- A node without a copy needs one first: `request_project_on_node` asks the
  user, who settles the location and files in the copy dialog.
- `request_environment_deletion` only asks: the user confirms in a dialog
  that names the node and the environment. A coordinator never deletes on
  its own initiative, here or on its own node.
- `propose_agents_md_update` with `nodeId` saves decisions to that node's
  copy: the user reviews it here, and the pull request is opened there (see
  [Saving decisions to AGENTS.md](#saving-decisions-to-agentsmd)).
- `send_message` with `nodeId` and `toEnvironmentId: "coordinator"` asks
  that node's main coordinator for this repository something
  (`list_mailboxes` with `nodeId` says whether it has one). It is not a
  delegation: no association opens, the result says the answer arrives as
  mail, and the answer is an agent's message, information rather than
  instructions. See [Coordinators on two nodes](#coordinators-on-two-nodes).

The coordinator's context says whether its node is a command node. A command
node attached to another runs in leaf mode: its coordinator's context names
the controlling node, its node tools refuse, and it handles any message as
an agent on that node would, launching workers on its own node if that is what
it takes. Its one cross-node action is mail to the
command node's coordinator: it answers that coordinator's mail with
`send_message` and `replyToMessageId`, and starts a message with
`toEnvironmentId: "command-node-coordinator"`, which is also how its context
tells it to hand on anything it cannot do from there. Agents on a leaf mail
the command node's coordinator by default rather than this one
([command-nodes.md](command-nodes.md#updates-from-leaves)). Its conversations
are kept but hidden behind a warning in the project's Coordinator tab.

### Who hears a notice

Status, pull request, automatic switch and usage-limit notices are addressed to
*the repository's coordinator*, not to one conversation. They all go through
`CoordinatorNoticeRouter` (`coordinator-notice-router.ts`), which applies one rule
(`routeCoordinatorNotice` in `@orkestrator/protocol/coordinator-notices`), so a
notice reaches exactly one coordinator:

| Where the notice starts | Who hears it |
| --- | --- |
| A leaf, and its command node has the repository | The command node's main coordinator for that repository, not the leaf's |
| A leaf, and its command node has no copy of the repository | The leaf's own main coordinator |
| A leaf whose command node is too old to take it | The leaf's own main coordinator |
| A standalone machine, or the command node itself | That machine's main coordinator |

With two command nodes attached, it goes to the one with the repository that last
mailed this project's coordinator, else the most recent.

**Replies are not notices.** A delegating coordinator still gets its own worker's
close notice, and the status wakes of a delegated worker (`association.kind` is
`environment`), because it is waiting on that worker. Workers messaging a
coordinator directly are unchanged too.

**Workflows a leaf's coordinator started** go up with everything else, so that
coordinator no longer hears about its own pipeline or review from its status wakes;
the command node's does, and can mail it.

**Starting a coordinator.** With no main coordinator running, a notice about a *new
event* starts one, creating the project's workspace if it never had one, and then
delivers to it. With one running it wakes that one and creates nothing. Starts are
serialized per project, so notices arriving together start one session. Two kinds
of notice never start a session:

- A sweep of older state: `CoordinatorStatusWakes.reconcile`, and the first
  `CoordinatorPullRequestWatches.sweep` after a start, which compares against a
  reading from before the restart. A status sweep finds nobody and sends the state
  current when one opens; on a leaf the notice waits in the outbox instead.
- A machine-wide notice with no repository, such as an automatic switch, which
  would start one coordinator per project on every switch. It goes only to
  coordinators already open.

Nothing is started while agent messaging is off. A held coordinator stays held:
notices take the normal mail path, so the unattended budget, Pause and mutes apply
as they always did. Status and pull request notices keep their per-resource
budgets.

**Over the node link.** A leaf queues the notice in its durable outbox
([agent-messaging.md](agent-messaging.md#node-mail)), so it survives a link drop and
a restart of the leaf and arrives once on reconnect. A retry whose words changed (an
excerpt, a time) finds the queued notice and keeps its first rendering, so it cannot
fall back to the leaf's coordinator as well. Text a leaf wrote reaches the
command node's coordinator as an agent's untrusted mail; automatic switch and
usage-limit notices are rendered there from checked fields, with every name quoted
as data. A notice does not use the pair budget that bounds two coordinators
talking, so an exhausted budget cannot hold it. An automatic switch reaches the
command node's open coordinators once, and on the leaf only the coordinators of
repositories the command node lacks. With several attached command nodes, each
repository follows its selected controller; recipient filters prevent the
machine-wide destination from also notifying another controller's repositories.

**A command node that stays gone.** A brief drop holds the notice and never falls
back, so nothing is delivered twice. After `NOTICE_HOLD_MAX_MS` (one hour) with no
contact from that command node at all, or as soon as it is detached, the notice
leaves the outbox and the leaf's own coordinator takes it, **only if it has not
been collected**. Collection transfers ownership of the whole batch before any
delivery attempt. Collected items (including deferred or unattempted ones) may
already have reached a mailbox after a lost response, so they never fall back.
On detach or after an hour of silence they are retired with the content-free
`notice.collected-retired` warning. This deliberately accepts possible notice
loss to preserve at-most-once wakes; collection is not delivery confirmation. An hour is short against
limits that reset in hours and long against a restart. A status notice from a sweep
that finds no coordinator open at that point is logged and dropped.

## Usage-limit stop notices

Every session that really stops on a usage limit produces a notice: a user-started
native tab, a delegated worker, a pipeline, review or branch session, and a
coordinator conversation, on any provider. It names the session, machine, repository,
account, the reset time when known (else the provider's words for it) and whether the
session will resend, is waiting, or stays stopped.

"Really stops" means the turn ended failed with a usage limit: the bridge's
structured `failureKind`, or else the error text (`usageLimitFailure`, see
[agent-accounts.md](agent-accounts.md#usage-limit-signal)). A transient limit the provider retries while the session
carries on does not fail the turn, so it sends nothing. Native tabs report from
`NativeAgentUsageLimitResend`, workflows from `provider.usageLimitStop`, and both reach
`AgentAccountAutoSwitcher`, whose `onLimitStop` fires once per stopped turn with the
account the turn ran on, read before any move. A stop that waits counts once, when the
wait starts.

`CoordinatorUsageLimitNotices` (`coordinator-usage-limit-notices.ts`) keeps a durable
ledger (the `coordinator-usage-limit-notices` store):

- **Raising.** A stop has an id derived from its environment and request, recorded in
  `raised`, so a retry or restart raises nothing new.
- **Grouping.** The machine with the receiving coordinator groups stops per project by
  account and reset window, with an hour's tolerance between readings of one reset; an
  unknown reset counts as a five-hour window. A group waits 30 seconds for stops landing
  together, then sends one wake listing them. A later stop in the window is filed
  without a wake (`usage-limit-window-already-notified`). A flush is recorded before it
  is sent, under a fixed request id, so a restart resends it rather than repeating it.
  A group still unsent after a restart can start a coordinator only while its window is
  open: once the window has ended it is older state, and it starts nothing. If the main
  that had the wake has closed, a later stop in the open window starts one and is filed
  there without a wake, so the stop is not lost and the window still costs one turn.
- **Naming a leaf's worker.** A worker this command node delegated to a leaf has its
  delegation here, so the leaf reports it as a tab. `deliverFromLeaf` names it a delegated
  worker when an environment association for that node, environment and tab matches.
- **The coordinator on the limited account.** Accounts compare by provider and email,
  across machines; without an email only the entry on its own machine matches. What is
  compared is the login the coordinator's next turn runs on: an idle bridge launched on
  another account is replaced on its next use, so it counts as already on the machine's
  active account. A coordinator on the limited login has its machine moved off first by
  `moveOffLimitedAccount`, the automatic switcher's own path: it never pins, and every
  entry of the login counts as limited. That move's automatic switch notice skips this
  coordinator, whose own notice says so.
- **No move possible.** With no account with headroom, an explicit pin, or automatic
  switching off, the notice is kept (`coordinator-on-limited-account`), no turn starts,
  and the reason is in the notice and the ledger (`keptReason`). The same happens when the
  coordinator's bridge has live work on that login, which holds it there until the work
  ends (`coordinator-busy`). Nothing retries it; the coordinator reads it on its next
  turn. With status wakes off, a notice is filed without a wake and starts nothing.

**A coordinator's own stop never notifies itself.** A leaf coordinator's goes up to the
command node's coordinator for that repository. With nobody above, it attempts the same
move, and the provider's error in its transcript is what the user sees. A side agent's
stop reaches its main. So a wake that fails on a limit ends there rather than raising
another wake: a notice cannot trigger another notice about the same stop.

To check this live, with real accounts and two machines: attach a leaf to a command node
that has the same repository, run a tab on the leaf until the provider refuses it, and
look for one wake on the command node's coordinator and none on the leaf's. Repeat with
the link down across a leaf restart, and with the command node's coordinator on the same
email as the stopped tab, with and without another included account.

## Coordinators on two nodes

A command node's main coordinator and a leaf's main coordinator for the same
repository exchange ordinary node mail
(`coordinator-node-coordinator-mail.ts`; transport in
[agent-messaging.md](agent-messaging.md#node-mail)):

- **Down.** `send_message` with `nodeId` and `toEnvironmentId: "coordinator"`
  (or a coordinator runtime id from that node, or a reply to mail from that
  node's coordinator) calls the leaf's `deliver_node_mail` with
  `toEnvironmentId: "coordinator"` and the leaf's `projectId`. The leaf
  stores it from a `node` sender with role `coordinator`, so it is
  `same-project`, takes the coordinator route and wakes the leaf's main. The
  address resolves as local mail to `"coordinator"` does: a closed main is
  reopened with the default agent; a project with no coordinator on that
  node is refused, naming it, and the caller can message a worker there
  instead.
- **Up.** The leaf coordinator replies with `replyToMessageId`, which goes
  back to the conversation that asked (the leaf's thread record), or starts
  a message to `"command-node-coordinator"`
  (`COMMAND_NODE_COORDINATOR_MAIL_ADDRESS`), which goes to the command node
  that last mailed this project's coordinator, else the most recent one, for
  its main coordinator of the repository. Both wait in the leaf's outbox
  (`send_coordinator_command_node_mail`) and the command node collects them
  like a worker's report, reopening a closed main as local mail would.
- **Framing.** The leaf coordinator reads it as a request from the
  controlling node's coordinator: it answers, and may act on its own node to
  answer (read state, launch or ask workers there) as it would for an
  agent's message, never across nodes. The command node stores the answer
  from a `node` sender with role `agent`: the carrier keeps an agent's
  untrusted framing and the body says it came from that node's coordinator,
  so content the leaf coordinator forwards from its workers is never
  promoted to coordinator authority (security report M11).
- **Side agents** stay limited to their own main on both nodes: a command
  node side agent cannot send it, a leaf side agent cannot send upward, and
  the address resolves only to the leaf's main.
- **Loops.** The command node's pair budget for the leaf coordinator's mail
  (`nodeMailSenderKey`, the unattended budget and the hourly limit of
  [agent-messaging.md](agent-messaging.md#budgets)) bounds the exchange. Only
  a person resets it: a prompt to the command node's coordinator, or Resume.
  On the leaf each new message from the command node's coordinator starts a
  fresh budget, as a new request to a worker does, so the leaf answers every
  question the command node actually sends; the hourly limit still applies
  there.
- **Older nodes.** A leaf whose hello lacks `node-coordinator-mail` is sent
  nothing; the call is refused with "update that machine", and
  `list_mailboxes` with its `nodeId` reports it unreachable for the same
  reason. A leaf coordinator's mail to a command node that predates
  `node-coordinator-mail` (one whose `collect_node_outbox` does not send
  `coordinatorMail`) is held in the leaf's outbox, not delivered: such a node
  would take it as a worker's report from a runtime id it has no environment
  for, outside the pair budget. `send_coordinator_command_node_mail` still
  answers `placement: "node-outbox"`, and its `deliveryHint` says older command
  nodes keep it queued; the command node collects it once updated. Each
  collect that holds one counts `node-coordinator-mail.older-command-node`
  ([register](version-compatibility.md#register)).

### Choosing a machine

A node the user names always wins. Otherwise a coordinator stays on its own
node unless load or OS gives a clear reason to move; the context line
(`coordinatorNodeContext`) says so, and placement stays its decision: nothing
places work automatically. `list_nodes` gives it what it needs, under `machine`
on `self` and on each node:

```json
{
  "status": "ok",
  "osFamily": "macos",
  "os": "macOS 27.0",
  "arch": "arm64",
  "cpuCores": 18,
  "totalRamGb": 64,
  "latestSampleAgeSeconds": 12,
  "load": [
    { "window": "5m", "windowSeconds": 300, "coveredSeconds": 300, "cpuPercent": 21.4, "ramPercent": 58.2 },
    { "window": "1h", "windowSeconds": 3600, "coveredSeconds": 3600, "cpuPercent": 18.9, "ramPercent": 57.6 },
    { "window": "24h", "windowSeconds": 86400, "coveredSeconds": 7260, "cpuPercent": 17.3, "ramPercent": 55.1 }
  ]
}
```

- **OS name.** `sw_vers` on a Mac (`macOS 27.0`). On Linux, `/etc/os-release`
  (`PRETTY_NAME`, else `NAME`), with `VERSION_ID` added when the name has no
  number of its own and `ID_LIKE` naming what a derivative follows: beelink's
  `PRETTY_NAME` is only `Omarchy`, which reads as `Omarchy 4.0.6 (like arch)`.
  On Windows, `os.version()` (not yet seen on a real Windows backend).
- **Windows.** 5 minutes, 1 hour and 24 hours, named constants in
  `packages/protocol/src/machine-load.ts`. A worker runs for hours, so a
  one-minute figure is mostly noise. `os.loadavg()` is not the source: it is
  zero on Windows, not a percentage, and stops at 15 minutes.
- **Percentages.** Of the whole machine, so a 32-core box and a laptop compare.
  CPU is the `os.cpus()` change between readings, a true average of the time
  between them. RAM is a point reading from the title bar's cached reader:
  `vm_stat` on a Mac (`os.freemem()` there counts cached files as used),
  `os.freemem()` elsewhere (under Bun on Linux that is `MemAvailable`).
- **Coverage.** `coveredSeconds` below `windowSeconds` means the average rests
  on less history than its window, so a 24-hour figure from ten minutes reads
  as ten minutes. Before the first reading the figures are `null`. A gap of more
  than three intervals (a sleeping host) is no history, not a reading. Windows
  end at the newest reading while sampling is on schedule, so a steady machine
  reads as fully covered; `latestSampleAgeSeconds` says how old that reading is.
- **Restarts.** History is in memory (`MachineLoadSampler`,
  `apps/backend/src/core/machine-load.ts`) and starts empty on each start;
  persisting it would add a database write on every machine all day for a
  figure the coverage field already keeps honest. A bucket a minute for the
  shorter windows and one every 15 minutes for the longest bound it to about
  160 buckets, so the 24-hour edge is accurate to 15 minutes. Cost and cadence:
  [recurring-work.md](recurring-work.md) B29.
- **Machines that cannot answer.** One node never fails or holds up the call:
  each is asked in parallel through `invoke_on_node` with a 2 s limit, and its
  `machine` is otherwise `{ "status": "unavailable", "reason", "detail" }` with
  no figures. Reasons: `offline` (not connected, so not asked), `timeout`,
  `older-version` (it answered `Unknown backend command: get_machine_load`,
  matched by `isUnknownCommandError` in
  `packages/protocol/src/unknown-command.ts`) and `error`.
  Last-known figures are never shown. `detail` is fixed wording, so a node's
  error text does not reach the coordinator.
- **Who sees it.** Read-only, for main coordinators and side agents
  (`list_nodes` is under `discovery`). The answer is parsed down to the fields
  above; no hostname, account, path or process detail crosses. The operator
  `list_nodes` over `node.list` and the public action schema are unchanged. A
  coordinator on a leaf gets its usual refusal from `list_nodes`.

### Reaching a leaf's coordinator

A command node's window reaching a leaf's project shows the leaf's
coordinator directly when the sidebar is grouped by machine or project.
Grouped by repository, or in the compact sidebar, it leads to the command node's
coordinator for that repository instead, when the command node has one
([command-nodes.md](command-nodes.md#leaf-mode)).

### Tickets on other machines

The project's Kanban board is the command node's, and every leaf with a copy
of the repository holds a synced copy of it under the same ticket ids
([tickets.md](tickets.md#sync-across-machines)). The ticket tools take an
optional `nodeId` (`coordinator-node-tickets.ts`):

| Tool with `nodeId` | Leaf that syncs tickets | Older leaf (no `ticket-sync`) |
| --- | --- | --- |
| `create_ticket` | Created on this board, then handed to the leaf now; while it is disconnected, `sync.state` is `offline` and it gets the ticket on reconnect. | Created on the leaf only; `sync.state` is `update-required`. |
| `list_tickets`, `get_ticket` | The leaf's board: this board's copies (`syncedFromCommandNode`) and tickets made only there. Disconnected: this board, with a note. | The leaf's board. Disconnected: refused. |
| `update_ticket`, `add_ticket_comment` | A ticket of this board is changed here and synced; a ticket made only on the leaf is changed there. | Changed on the leaf. Disconnected: refused. |

The label tools (`list_ticket_labels`, `create_ticket_label`, `set_ticket_label`)
take no `nodeId`: they act on this board, whose labels sync with the tickets.
To label a ticket that exists only on a leaf, pass `labels` to `update_ticket`
with that `nodeId`.

`start_build_pipeline` with a `nodeId` and a ticket of this board syncs the
leaf first (refusing if that does not finish) and starts the build there
under the same id; the ticket then shows where its build runs (`runsOn` in
ticket reads, a machine chip on the board). An older leaf cannot build a
ticket of this board: the refusal says to update it or to create a ticket
there. Ticket summaries carry `runsOn` for work on another machine.

**Offline.** Ticket changes for a disconnected leaf wait on this board and
reach it in order on reconnect. Launches, builds, Multi Reviews and the other
environment and workflow tools on a disconnected node are refused with a
message saying they are not queued: run hours later, a launch would start
from a stale base commit, and an outcome lost to a disconnect could not be
resolved without risking running it twice. Retry when the node reconnects
(`list_nodes`), or use another machine.

## One main coordinator, and side agents

A project has exactly one **main** coordinator conversation
(`CoordinatorConversation.role`). Every worker reports to it and it owns all
delegation. Any agent reaches it at the mail address `"coordinator"`
(`COORDINATOR_MAIL_ADDRESS`), which resolves to whichever conversation is the
main right now; an address of a conversation that has since closed is
redirected there too.

A conversation's provider is fixed once it has a session, so changing the
coordinator's agent means a new main conversation. **Change agent**, a button
on the assigned main tab and an item in its tab menu, does that after a
confirmation: it closes the main, then opens a fresh, unassigned main in the
same tab group and tab position (`createConversation` with no main open), whose composer offers
every qualified platform. If agent mail arrives before the user picks one, that
new main is given the default agent as described below. Once side agents are
open, the main tab shows a **Main** label, also in its accessible name.
The renderer retains the replacement slot while creation is pending; if creation
fails after a successful close, it publishes the closed snapshot and reports the
error. Tab close actions are unavailable while a conversation action is pending.

Closing the main tab without Change agent asks first, and nothing reopens it on
its own until it is needed: the next agent mail to the coordinator, or a worker's
delegation wake, starts a new main with the repository's default agent
(`CoordinatorService.ensureMainConversation`) and moves onto it the work the
closed one still owed a report for (open delegations, unreported workflows).
A notice about a new event starts one too. A sweep of older state does not: it
waits for the next main, so finished work from long-closed conversations cannot
wake a fresh coordinator after a restart. See
[Who hears a notice](#who-hears-a-notice). With no main open, the toolbar action
reads **Start coordinator**.

Reading a coordinator (`CoordinatorService.get`, so `get_project_coordinator`,
the panel's view and every coordinator `read_messages`) repairs nothing and
writes nothing. The work and mail closed conversations leave behind move to the
main at three points instead (`coordinator-closed-conversations.ts`): when a main
opens, when a conversation closes, and on the 60-second `coordinator-repair`
sweep. Every path that opens a main goes through `ensureMainConversation`: mail,
wakes and notices directly, and a new coordinator in `ensure` and
`createConversation` with no main open through its `opened` form, which keeps
the new main unassigned and leaves open side conversations their own work. The
sweep syncs mailboxes and reads the owed delegations once for every coordinator,
not once each, and re-reads the open delegations only after the store has
changed (`coordinator-open-delegations.ts`). A main that appears any other way
(a legacy record given a role on read, a restored store) takes the mail over on
that sweep, up to a minute later.

An open main that has never run has no agent until its first prompt, so it can
neither read mail nor be woken for it. Mail from an agent in its own project, or
a delegation wake, assigns it the default agent the same way, and mail already
filed for it is delivered. A new notice does too, but a sweep of older state and
a machine-wide notice do not. Until it has an agent, the conversation shows a
banner saying the mail is waiting.

Every other conversation is a **side agent**, named Side 1, Side 2… (the lowest
free number). A side agent reads the project and Orkestrator state (its
credential carries only the `discovery`, `mail` and `schedules` capabilities
(`coordinatorRoleCapabilities` in `control-mcp-tools.ts`), so it launches
nothing, graphs included; `ask_agents` is on `discovery` because a subork is
read-only and answers only its asker), and exchanges mail with the main coordinator only:
the mail store refuses side ↔ worker and side ↔ peer mail in both
directions. The user may still write to it.

Records from before roles migrate when read (`normalizeCoordinatorRoles`): the
selected conversation, else the oldest with an agent, becomes main and the
others become side agents. Nothing is closed. Workers a former conversation
launched belong to the main.

At most 16 conversations may be open, the main included. A new conversation
starts unassigned, so empty composers could fill that limit: **New side agent**
therefore names the unassigned side agents whose composer is empty in this
window (`unusedCoordinatorConversationIds`, which reads the live draft and so
covers text typed in the last few hundred milliseconds), and
`createConversation({ closeUnused })` closes, in the same write, each one the
backend agrees was never used: unassigned, no provider session, no saved draft
with text, mentions, attachments or annotations, no mail and no owned work. The
main coordinator is never closed this way, and a caller that names nothing
(the CLI, an older client) closes nothing.

## Tab groups

Conversation tabs split into tab groups the same way environment panes do:
drag a tab onto another group's strip to move it, or onto a pane edge to open
a new group beside or below it, so a side agent can sit next to the main
coordinator. Dividers resize, and a group closes when its last tab leaves.
Each group has its own **New side agent** action, and a new conversation
joins whichever group is focused. On a phone the action shows only its icon,
because the strip scrolls.

Each strip is a `tablist` of `role="tab"` buttons; the draggable shell around
a tab takes no role or tab stop of its own, and each group's content is the
`tabpanel` its front tab labels. Arrow keys, Home and End move between a
strip's tabs, Enter or Space selects one. The keyboard drag sensor is left out
because it claims Enter and Space, so moving a tab without a pointer goes
through the tab's menu (right-click, the context-menu key or Shift+F10): **Move
to new group** and **Move to group N** call the same layout functions a drop
does (`splitCoordinatorPaneAtEdge`, `moveCoordinatorConversation`).

An environment's strip (`DraggableTabBar`, `DraggableTab`) is also a `tablist`
over a `tabpanel`, built differently: the draggable shell is itself the
`role="tab"` element, with its close button out of the tab order, and it keeps
the keyboard drag sensor. Arrow keys, Home and End move between tabs, Enter
selects, Space picks the tab up to drag it, Delete closes it and the context-menu
key or Shift+F10 opens its menu.

The arrangement is presentation, edited by the renderer
(`apps/web/src/lib/coordinator-pane-layout.ts`) and stored by the backend per
project (`get/save_coordinator_pane_layout`, `@orkestrator/protocol/coordinator-pane-layout`),
so every client shows the same groups. A save is a compare-and-swap on the
record's revision: when another client saved first the save answers `conflict`
with the stored record and the renderer adopts it, which is why a layout change
lost in that race is not retried. Other clients hear `coordinator-pane-layout`
and re-read. A browser's earlier local copy is imported once at revision 0, so it
never replaces a layout already stored, and then deleted; against a backend
without the capability the layout stays in that copy. It never opens or closes a
conversation; on every snapshot it is reconciled against the backend's open set,
dropping closed conversations and placing new ones. Focusing a group selects its front
conversation (`selectCoordinatorConversation`), and a selection made elsewhere
brings that conversation to the front of its group. A press or focus inside a
tab strip does not focus the group first: a tab selects itself, so a click on a
tab in another group writes one selection rather than the group's front tab
and then the clicked one, and every finished drag focuses the group the tab
landed in or started from (`coordinatorDragEndChange`), since a drag does not
click. Only each group's front
conversation is mounted.

## Activity indicator

While a coordinator works, it shows the same spinner an environment row's
marker draws: around the whole **Coordinator** tab in the project navigation,
and around the leading icon of the project's sidebar heading (the coordinator's
own icon when the project has none, shown only while it is active). A
conversation waiting on the user pulses yellow on those same icons instead;
working outranks waiting across a project's open conversations, main and side
agents alike.

The state comes from the backend's activity observer, the same observation
mail delivery and the environment markers read
(`list_coordinator_activity`, `@orkestrator/protocol/coordinator-activity`).
It reads retained observations only, so it never starts, attaches, hydrates
or touches a session. The renderer projection
(`apps/web/src/stores/coordinatorActivityStore.ts`) re-reads it on a
coordinator session's activity transition, a coordinator session record
change (a dispatch), a coordinator workspace change, and the transport's
resync and safety checks, which also recover a missed hint. Other machines'
coordinators are not shown yet.

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
Review, Multi Review, its Address Findings session and Create PR run directly on the main
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
  writes into the checkout it may only read. The one exception is a message,
  which needs a reason and usually the user's approval; see
  [Messaging the project home](#messaging-the-project-home). Its row in a
  coordinator's `list_environments` carries `projectHome: true`, so the model can
  tell it from a worker before acting on it; a worker's row has no such field, and
  operator reads are unchanged.

## Choosing an agent

A conversation has no agent until its first prompt. The composer offers every
platform this machine qualifies, with the repository default preselected, and
the first send binds the conversation to whichever was chosen. That binding is
one-way: the transcript and rollout belong to that platform, so a different one
means a new conversation. Re-assignment is allowed only while the first send has
not yet reached a provider, so a failed start does not strand the conversation.

There is no silent fallback and no silent provider substitution. Control MCP may
be disabled globally; chat remains read-only and usable, while the page shows
that delegation controls are unavailable. Agent messaging may be off too, and
then every wake a delegation would need is held until it returns: the context
tells the coordinator delegation is unavailable, and the toolbar says "Delegation
unavailable: agent messaging is off" from the snapshot's `agentMessaging`
([Delegation round trip](#delegation-round-trip)).

## What the panel explains

The coordinator works unlike any other tab, so the panel says how in the
places the user acts:

- **First-run card.** The empty main composer shows a dismissible card
  (`CoordinatorIntroCard` in `CoordinatorIntro.tsx`): the coordinator reads
  the checkout but never changes it, hands changes to build pipelines and
  prompt environments and is woken when they finish, side agents are extra
  read-only chats, and Change agent switches provider with the workers
  carried over. Dismissal is a per-user view preference in the UI store
  (`coordinatorIntroDismissed`), not per project, since the model does not
  vary by project. The toolbar's **?** shows the same lines as a menu
  whatever the conversation's state.
- **Side agents.** **New side agent**'s tooltip and a side composer's hint
  say that a side agent can read the project and talk to the main but cannot
  launch workers. A side composer has its own placeholder ("Ask a question
  about this project. …") rather than the main's "What would you like to get
  done? …", and no starter prompts.
- **`@` and `!`.** Every coordinator composer's placeholder ends with "Type
  @ to mention a file, or start with ! to run a command yourself.", so the
  guidance shows in the empty box and is out of the way once the user types.
  The main composer has no hint line under it and the panel has no footer:
  where changes run is the toolbar badge's job. A first message cannot be a
  command (see [User `!` commands](#user--commands)); the rule is shown
  inline under the composer, with the text kept, until the text no longer
  starts with `!`.
- **The read-only tier.** The toolbar badge ("Changes run in isolated
  environments") is coloured text with no box around it; only its tier pill
  keeps an outline. It names the selected
  conversation's tier as a pill ("Read-only · Enforced",
  "Read-only · Provider-configured", "Read-only · Advisory"); only an
  `advisory` platform is called advisory. The badge opens a menu, so it
  works by touch and keyboard, with the tier's one-sentence meaning from the
  table below, the checkout path and context revision, and a link to
  **Settings → Coordinator**, where the safety level is set. In the picker,
  each platform's rail row carries a tier-coloured marker and the tier in its
  accessible name and tooltip, and the note for the platform in view starts
  with the same pill followed by the qualification reason as the backend
  wrote it. Nothing appends a second "cannot verify" sentence to the reason.

## Provider qualification

Coordinator runs against the project's real checkout, so how strongly a
platform holds the read-only boundary is named rather than flattened to
available/unavailable. The single table is
`apps/backend/src/core/coordinator-providers.ts`. Every gate — workspace
service, runtime resolver, bridge launcher, trusted session input — consults
it. Its tier and reason come from the shared enforcement matrix
(`agentPolicyEnforcement` in `packages/protocol/src/graphs/capability-enforcement.ts`)
asked about the coordinator's own policy, so a graph node with a read-only
capability profile is rated by exactly the same rules as a coordinator.

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks the mutation whatever the agent attempts | Codex; Claude where its command sandbox can run commands (macOS; Linux whose bubblewrap can nest a user namespace, with `socat` on `PATH`); Pi |
| `provider-configured` | The SDK is told to deny, and exposes no way to verify it | OpenCode (1.x and the OpenCode 2 preview alike; see below), Cursor; Claude where the command sandbox cannot run commands (Windows; Linux without `bwrap` or `socat`, or whose policy refuses the nested namespace, such as Ubuntu's AppArmor `bwrap-userns-restrict`) |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Coordinator → Coordinator safety level** chooses the weakest
tier this installation will offer. It defaults to `provider-configured`:
`enforced` and `provider-configured` platforms are offered, and `advisory`
stays opt-in.

What each enforced platform actually does:

- **Codex** runs under a permission profile that denies the filesystem and the
  network inside the child process, with `sandbox: read-only`,
  `approvalPolicy: never`, and a private `CODEX_HOME` holding only `auth.json`.
  The bridge refuses to run a turn unless app-server echoes the profile back.
  Hosted web search is outside the profile, so its mode is set separately
  (`disabled`, or `cached` when research is on, never `live`), and the bridge
  refuses a thread unless `config/read` reports that mode.
- **Claude** runs with the SDK command sandbox on and `allowUnsandboxedCommands`
  off, a permission mode capped by the deny policy (`plan` while the composer
  is in plan mode, which a fresh coordinator composer selects, otherwise
  `default`; never `bypassPermissions`, see `claudePermissionMode`), with
  `canUseTool` refusing whatever reaches it. Not `dontAsk`: the pinned CLI
  refuses AskUserQuestion outright in `dontAsk`, so a coordinator could not ask
  the user anything. Then an allowlist that excludes every writing tool
  and WebFetch (and WebSearch unless research is on), `settingSources: []`, a private
  `CLAUDE_CONFIG_DIR` holding only the credential, managed settings that run
  no plugin or skill hook and no skill inline shell (see [Skills](#skills)),
  and a bridge-owned `PreToolUse` hook. The hook is the real boundary for
  shell: it allows a fixed
  list of reading commands and refuses pipes, redirection, substitution and
  chaining, writing arguments (`uniq in out`, `sort -o`, `git diff --output`,
  gawk's in-place and program options), path-qualified programs and the
  network-only `gh`, `curl` and `git ls-remote`. The SDK sandbox's default lets
  a command write its working directory, so the coordinator sandbox denies
  writes to the checkout (`filesystem.denyWrite`); before that, `uniq in.txt
  out.txt` wrote the checkout of an `enforced` Claude coordinator.
  `defaultCoordinatorHostCapabilities` decides whether the sandbox can run
  commands: always on macOS, never on Windows, where the pinned CLI's sandbox
  sits behind a vendor flag that is off, and on Linux by running the probe in
  [Claude's sandbox on Linux](#claudes-sandbox-on-linux). Elsewhere Claude is
  `provider-configured`, and the reason the picker shows names the cause. The
  launcher passes the same answer to the bridge as process authority
  (`ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`, `required` or `unavailable`;
  absent reads as `required`). `required` keeps `failIfUnavailable` on, so a
  sandbox that fails to start fails the turn, and the bridge refuses the turn
  up front if its own probe fails. `unavailable` leaves the sandbox off and
  the hook is the boundary: the CLI decides availability from the programs
  alone, so asking for a sandbox the probe found broken would start it and
  fail every command.

  A Claude coordinator also cannot read Orkestrator's data directory, which holds
  the operator credentials (`control-mcp.json`), the provider secrets
  (`config.json` and its backups), the database and every account's login. The
  launcher names the directory in
  `ORKESTRATOR_COORDINATOR_PROTECTED_DATA_DIR`; `coordinatorReadBoundary` turns it
  into `filesystem.denyRead`, with `filesystem.allowRead` carving back what the
  turn is meant to read: that conversation's own Claude home (saved tool results
  and memory; it never holds a login), its attachment directory, the skills
  directory it was given, the checkout, and the managed toolchains (executables
  only, and a shell's `rg` execs the CLI from there). The whole directory is denied
  rather than a list of files, because a list goes stale silently when a store adds
  a secret, while a missing allowance fails loudly. `allowRead` wins over `denyRead`.
  The sandbox reaches commands only, so the read-only hook refuses the same paths
  in `Read`, `Grep` and `Glob`, resolving links and refusing a search rooted above
  the directory. It also refuses a command naming such a path, and, with no sandbox
  behind it, one rooted above the directory. That is proven on the pinned CLI on
  Seatbelt and on bubblewrap (Linux, 2026-11-06), against a fixture directory and
  a scripted model (`conformance-coordinator-read-boundary-live.test.ts`). Under
  bubblewrap a denied path reads as missing (`No such file or directory`): the
  directory is masked, with the allowances bound back in. A read-only review turn
  in a worker bridge gets no boundary, by decision
  ([6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md)
  task 4).
- **Pi** blocks every tool outside its read-only set in its own `tool_call`
  gate, which runs in the bridge process and cannot be switched off by the
  workspace. The same gate refuses a coordinator's `read`, `grep`, `find` and
  `ls` that would reach the data directory (`read-boundary.ts`), resolving
  links, Pi's own path spellings (`@`, `~`, `file://`) and a search rooted above
  the directory (Pi's `grep` searches hidden directories). The checkout and the
  coordinator's attachment directory stay readable. A read-only Pi session has
  no shell, so this covers every built-in read; it is a tool-level check, not an
  OS boundary, which is why Pi stays `provider-configured`.

OpenCode denies through its own permission rules and runs its `plan` agent, but
always loads the checkout's project configuration, including any MCP servers it
declares. Its rules also keep a coordinator out of the data directory: nothing
in them allows `external_directory`, and the data directory is never inside the
checkout. OpenCode judges that from the path as written, so a link in the
checkout pointing into the data directory was read; the coordinator's server
therefore loads `orkestrator-coordinator-read-boundary.js`
(`opencode-read-boundary-plugin.ts`) from the host configuration directory,
which resolves `read`, `grep`, `glob` and `list` paths and refuses the call in
`tool.execute.before`. It is inert in every other server, and absent when the
user sets their own `OPENCODE_CONFIG_DIR`
([7402](../todo/coordinator-and-multi-review/7402-opencode-coordinator-user-config-dir.md)).
Both layers are qualified on the pinned binary with a loopback model
(`opencode-coordinator-read-boundary-live.test.ts`).

Under the OpenCode 2 preview (Settings → OpenCode, "Use OpenCode 2 for new
sessions") a coordinator conversation started from then on runs on OpenCode
2.x; one started earlier stays on 1.x (`opencode2/coordinator.ts`). Its 2.x
server is its own process, keyed by the conversation's runtime id, so the
boundary is held by that process's launch rather than by any session record:

- It is launched with `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`,
  the data directory, the research setting of the moment, and
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so the checkout's `opencode.json`,
  `.opencode/` agents, commands, plugins and MCP servers never load. This is
  the axis 1.x cannot honour; a changed research setting replaces an idle
  server, as it replaces the 1.x one.
- Its configuration directory (`opencode2/coordinator-config` under the data
  directory, never the ordinary one) holds the coordinator guard plugin
  (`coordinator-plugin.ts`). In the server process, on every tool call a
  sub-agent's included, it refuses any tool outside the read-only set, the
  conversation's control tools and the research servers named at launch,
  whatever a session's stored rules say, and refuses a `read`, `grep`, `glob`
  or `list` that would reach the data directory, resolving links (2.2.6, like
  1.x, judges `external_directory` from the path as written). The checkout and
  the conversation's attachment directory stay readable.
- The backend keeps the launch's policy beside the process. The provider built
  for that server ignores a request's policy and a session's stored base:
  create, resume, policy synchronization and every turn write the coordinator
  rules (1.x's, translated) and read them back before the prompt, pin the
  `plan` agent, and refuse provider commands (2.x does not say which agent a
  command runs as). The conversation's Control MCP credential, the one its 1.x
  server was launched with, is registered as the location's `orkestrator`
  server, and the research servers as theirs.

This is qualified against the pinned 2.2.6 binary with a scripted model
(`opencode2-coordinator.live.test.ts`): no write, no command, no read of the
data directory directly, through a link or from a sub-agent, the control and
research tools reached, a session widened behind the backend's back refused
by the server and restated by the next turn, and the project configuration
not loaded where a server without the switch loads it. The tier stays
`provider-configured`: the live coordinator suite has not been run against
OpenCode 2 with a real model, the table rates one tier per platform while
earlier conversations remain on 1.x, and the server process itself runs
unsandboxed (its boundary is OpenCode's rules plus the in-process gate, not an
OS sandbox).

Cursor applies the sandbox
and a tool ban but exposes no approval callback, and is refused outright if its
sandbox cannot be enabled. Its reading tools still reach the data directory
([7400](../todo/coordinator-and-multi-review/7400-cursor-coordinator-data-dir-reads.md)).

Grok deny-policy children load a private agent profile that removes `write`,
`search_replace`, `run_terminal_cmd`, built-in subagents and 1.0.67's `monitor`
waiting tool, with `--no-leader`
so a shared process cannot bypass it. This also covers read-only review turns.
Remaining ACP permission requests, including MCP calls, are refused by choosing
`reject_once`. Other tools that never ask remain advisory, among them xAI's
hosted X search tools (`x_keyword_search`, `x_semantic_search`,
`x_user_search`, `x_thread_fetch`), which neither the profile nor
`--disallowed-tools` removes on 1.0.67. Grok
1.0.52 ends its turn on any answer except allow, so the bridge then sends the
same session a fixed continuation saying the call was refused and must not be
retried (`POLICY_DENIAL_CONTINUATION`, `acp-prompt.ts`). The continuation
counts as part of the same turn, and a turn gets at most eight. Without it, a
Grok coordinator stopped at its first refused tool and never answered.
Grok's own reading tools are among those that never ask, so nothing keeps a
Grok coordinator out of the data directory; the bridge's `fs/read_text_file`
is confined to the workspace already
([7401](../todo/coordinator-and-multi-review/7401-grok-coordinator-data-dir-reads.md)).

The coordinator policy names operations, not one provider's tool strings:
`capabilityPolicy.deny` is `file.write`, `file.patch`, `shell.mutate`, and
`network`. Each bridge translates that list. `capabilityPolicy.allow` carves
exceptions out of it; the only one is `web.search` (see below). `toolPolicy`
stays Codex-shaped and is also the user-override surface, so it cannot carry
the translation.

### Network and web research

A sandbox or firewall on this machine only sees what the agent's own commands
send. Hosted web tools run on the vendor's servers, so they reach the internet
whatever the sandbox says. A live run once showed a Codex coordinator opening
`https://example.com` through hosted search while its permission profile had
the network off. So a `network` denial (`nativeAgentPolicyDeniesNetwork`)
covers hosted tools as well as commands, and each bridge removes them in its
provider's own terms.

**Settings → Coordinator → Coordinator web research** reopens one part of
that on purpose. Commands stay off the network and hosted page fetches stay
off in every mode, because a URL the agent opens can carry data out to
whoever owns the page:

| Mode | Coordinator gets |
| --- | --- |
| Web search and research servers (default) | Hosted web search, plus the remote research MCP servers the user lists (Context7 by default) |
| Web search only | Hosted web search |
| Off | Neither |

The backend passes the setting to each coordinator bridge at launch as process
authority (`ORKESTRATOR_COORDINATOR_WEB_RESEARCH`,
`ORKESTRATOR_COORDINATOR_RESEARCH_MCP`), like the execution policy, so a
change applies when a conversation's agent next starts. Worker bridges never
receive either variable, even one inherited by the backend. The policy carries
the result as `capabilityPolicy.allow: ["web.search"]`; a bridge or a stored
record that predates `allow` ignores it and keeps search off.

Research servers are HTTPS only, named with lowercase letters, digits and
hyphens (`orkestrator*` is reserved), at most eight. A local (stdio) server is
refused: it would be a program running on this machine outside every sandbox.
Orkestrator injects each one itself, never from a file the checkout can edit.

| Platform | Search | Page fetch | Research servers |
| --- | --- | --- | --- |
| Codex | `web_search = "cached"` when allowed, else `"disabled"`; `features.standalone_web_search = false`. The engine reads the mode back through `config/read` once per app-server generation and refuses the thread on any other value. `cached` serves pages only from OpenAI's index: a live run had it refuse a fresh URL with "Cache miss" while `live` opened it. | No separate tool; `live` mode is never used | Process `-c mcp_servers.<name>` overrides, tools approved |
| Claude | WebSearch on the allowlist when allowed, else in `disallowedTools` and refused by the hook | WebFetch denied by name and by the hook | Added to the inline MCP set, `mcp__<name>__*` on the allowlist and the hook |
| OpenCode | `websearch` and `codesearch` allowed by name when allowed, else denied | `webfetch` denied after every allow; `task` subagents inherit it | Registered on the coordinator's own `opencode serve` at launch (`POST /mcp`, replacing any project entry of the same name), before the conversation is ready. OpenCode 1.19.4 lists no MCP tools over HTTP, so the backend lists each server's tools itself and allows exactly `<name>_<tool>`, leaving out an id a project server named `<name>_…` could also produce (`opencode-coordinator-research.ts`) |
| Cursor | `webSearch` joins the read-only allowlist when allowed | `webFetch` never on the allowlist | Hosted in-process as `<name>__<tool>` custom tools beside Orkestrator's, because a sandboxed read-only attach cannot call an HTTP MCP server; published under their own server name (`hostResearchCustomTools`) |
| Grok | Off. On 1.0.67 the hosted `web_search` carries `open_page` and `open_page_with_find`, which open any URL, and neither the agent profile nor `--disallowed-tools` removes them (`scripts/coordinator-probes/grok-web-tools-probe.mjs`), so search there is fetch. `--disable-web-search` removes all three; `GROK_WEB_FETCH=0` removes only the client `web_fetch`. Also `--no-leader`, so a shared leader that ignores the flag is never used | Off | None |
| Pi | No hosted search | None; the read-only gate is a name allowlist, so an extension's web tool is refused | Connected by the bridge-owned MCP client in a coordinator process only (`research` scope, reserved like `orkestrator` so a `mcp.json` entry cannot stand in), and admitted by the gate by exact registered name |

The coordinator context tells the agent which of these it has, that commands
and live page fetches are off, and to report a tool as refused only after a
call was refused. It also says to keep its own work to quick reads and
lookups and to delegate anything more serious to a worker.

The agent information panel reads "no network, web search and web fetch off",
or "no network except hosted web search, web fetch off" when search is
allowed. A `restricted` network without a `network` denial still reads
"restricted network", because hosted tools stay available there.

Every coordinator bridge is launched with
`ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. That is process
authority: the bridge replaces whatever policy a request body or a persisted
record carries, so a permissive record cannot survive a restart and widen a live
conversation.

### Skills

A coordinator can load and invoke the user's own skills and the project's,
the ones a worker sees, so that a procedure such as this repository's
`.claude/skills/release` is followed rather than improvised. A skill is
instructions, but it can also carry parts that run or grant, so each platform
loads skills only where those parts stay inside the boundary.

**Claude.** With `settingSources: []` the pinned CLI (2.1.309) reads no
skills directory at all: not `$CLAUDE_CONFIG_DIR/skills`, not `.claude/skills`,
whatever the `skills` or `additionalDirectories` options say. Turning on the
`user` or `project` source would also load that layer's hooks, permissions,
`env`, MCP servers and CLAUDE.md, so the bridge hands each directory over
through the one channel the CLI still honours, the inline plugin set
(`coordinator-skills.ts`):

- **Two generated plugins.** `user-skills` mirrors the directory a worker on
  the active account reads (`<account home>/skills`, else
  `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`), which the launcher names
  in `ORKESTRATOR_COORDINATOR_CLAUDE_USER_SKILLS_DIR` because the bridge's own
  `CLAUDE_CONFIG_DIR` is the private one. `project-skills` mirrors the
  coordinator's own checkout's `.claude/skills`, the project's main checkout,
  whether or not git tracks it. This repository ignores `.claude/`, so a skill
  there that is not force-tracked reaches the coordinator but not a worker in
  a worktree, which has only tracked files. Their skills are listed as
  `user-skills:<name>` and `project-skills:<name>`. Worker launches never
  inherit the variable, and a read-only review turn in a worker bridge loads
  neither plugin.
- **Mirrored, not linked.** Each `SKILL.md` is rewritten with only `name`,
  `description`, `when_to_use`, `argument-hint`, `arguments`,
  `disable-model-invocation`, `user-invocable` and `version`, parsed with
  Bun's YAML parser and re-serialised as JSON scalars, so nothing of the
  original syntax reaches the CLI's parser. Dropped are `hooks` (registered as
  session hooks when the skill runs; a command hook runs outside the sandbox),
  `allowed-tools` (granted without `canUseTool`), `context`/`agent`, `model`
  and the rest. Frontmatter that does not parse skips the skill. Every other
  file is a symbolic link to the original, so references and scripts stay
  readable.
- **Allowed by name.** The allowlist names each mirrored skill
  (`Skill(project-skills:release)`). A skill from another inline plugin that
  declares hooks or tool grants reached `canUseTool` in the probe, which
  refuses it under the deny policy; the user can still type its slash
  command.
- **Nothing in a skill runs.** Every read-only turn passes `managedSettings:
  { allowManagedHooksOnly: true, disableSkillShellExecution: true }`
  (`claudeManagedSettings`), including the command-discovery probe. That
  closes, for every inline plugin and not only the mirrors, three paths probed
  on 2.1.309 that the `PreToolUse` hook never sees: a plugin's
  `hooks/hooks.json` (its `SessionStart` and `UserPromptSubmit` command hooks
  ran in a coordinator-shaped session), a skill's frontmatter hooks, and a
  skill's `` !`cmd` ``, which runs before the model sees the skill and is
  checked only against that skill's own `allowed-tools`: `allowed-tools:
  Bash(touch:*)` plus `` !`touch x` `` wrote the checkout. The bridge's own
  hooks are SDK callbacks, which `allowManagedHooksOnly` keeps.
- **A grant cannot widen the tool set.** `allowed-tools` (on a typed slash
  command of an unmirrored plugin skill, which skips the Skill tool's
  permission check) grants without `canUseTool`, so a built-in the hook does
  not name would run. The capability translation therefore also denies, by
  name and in the hook, `EnterWorktree` and `ExitWorktree` (`file.write`),
  `PowerShell` (`shell.mutate`: the hook vets Bash commands only) and
  `RemoteTrigger` (`network`). Write and Edit were already denied by name,
  and a granted Bash still goes through the hook, which refuses running a
  skill's script (`bash scripts/x.sh`, `./x.sh` and path-qualified programs).
  A subagent a skill starts runs under the same hooks, deny rules and
  sandbox.
- **Launch identity.** Each mirror is content-addressed
  (`<plugin>-<digest>`), so adding, removing or editing a skill changes the
  plugin path. The launch fingerprint and the discovery cache compare plugin
  paths, so an idle warm CLI is replaced and one that still owes work refuses
  the prompt with a `plugins` conflict until it finishes. The four previous
  mirrors of each source stay for a CLI still running on one.

The proof against the real CLI is
`bun src/services/coordinator-skills.live-probe.ts` (claude-bridge; opt-in,
billed, uses the caller's login), which runs a hostile skill both mirrored and raw, through
the Skill tool and as a typed slash command, and reports that no hook, inline
shell, Write, Bash `touch` or worktree ran while the mirrored skill loaded.

**Other platforms.** Every coordinator loads the user's skills from its own
platform's directories and the project's from the checkout, including the
checkout's `.claude/skills`, so a project that keeps its procedures there (as
this one does) is not invisible to a coordinator on another platform. What
runs in a skill stays inside that platform's read-only boundary.

| Platform | User skills | Project skills | How it holds |
| --- | --- | --- | --- |
| Codex | The account's `CODEX_HOME/skills`, which the launcher names in `ORKESTRATOR_COORDINATOR_CODEX_USER_SKILLS_DIR` because the coordinator's own `CODEX_HOME` is private, added with `skills/extraRoots/set` once per app-server generation; `~/.agents/skills`, which Codex lists from HOME | `.agents/skills` and `.codex/skills`, no longer disabled for a coordinator process (`codexLoadsProjectSkills`); `.claude/skills` as an extra root. The checkout stays pinned untrusted, so its config, hooks and MCP servers stay out | A Codex skill grants nothing; what it asks for runs as a command under the permission profile (no write, no network). The profile reads each user skill root and each skill it links to (`codexCoordinatorSkillReadRoots`): a link target is granted only when it holds a `SKILL.md` and is not HOME, `/` or an ancestor, and the checkout's own links are never followed. `features.skill_mcp_dependency_install` and `skill_env_var_dependency_prompt` are off. Proved by `live-coordinator-skills.test.ts` (no credits): the skills are listed and offered, a user skill is readable from a command, and a neighbouring file, the skill and the checkout stay unreadable or unwritable |
| Cursor | `~/.cursor`, `~/.agents`, `~/.claude`, `~/.codex` and `~/.grok` skills, Cursor's own list | The same five directories under the checkout | The SDK has no skills-only switch (the `user` layer also brings `~/.cursor/mcp.json`), so the bridge hosts one read-only tool, `orkestrator-skills__load` (`coordinator-skills.ts`), beside the Orkestrator and research tools: its description lists the skills, and a call returns a `SKILL.md` or a file inside that skill. A directory counts as a skill only with a `SKILL.md` and not as HOME, `/` or an ancestor; a file outside the skill's own directory is refused. The allowlist and sandbox are unchanged. The list is read at attach |
| OpenCode | OpenCode's own, `~/.claude` and `~/.agents` skills | `.opencode`, `.claude` and `.agents` skills | OpenCode discovers them itself; the `skill` permission is now allowed. On 1.19.4 it only returns the `SKILL.md` and a file list, and a shipped script still needs the denied `bash` |
| Pi | `~/.pi/agent/skills` and `~/.agents/skills` (`noSkills: false` in a coordinator process) | `.pi/skills`, `.agents/skills` and `.claude/skills` as `additionalSkillPaths`, with the project still untrusted, so `.pi/` settings and extensions stay out | A Pi skill is markdown the model reads with `read`; extensions stay off and the read-only gate admits no tool that could run what a skill ships. `coordinator-skills.test.ts` (pi-bridge) runs it against the real SDK |
| Grok | Loaded from `~/.grok`, `~/.claude` and installed plugins; the coordinator has no private home | Gap: only through Grok's own folder trust, which also loads the checkout's hooks and MCP servers. The per-process overlay (`GROK_CONFIG`) applies `models` but drops a `skills` section, so `skills.paths` can be set only in the user's own `~/.grok/config.toml` (probed on 1.0.67) | Advisory tier. A checkout the user trusted in Grok already loads its hooks and MCP servers in the coordinator, a gap that predates skills |

### Claude's sandbox on Linux

The Claude CLI checks only that `bwrap` and `socat` are on `PATH`. It runs each
command under bubblewrap (`--unshare-user --unshare-pid … --proc /proc`) and,
inside that, its embedded `apply-seccomp` helper, which creates a second user
namespace with its own PID and mount namespaces. Ubuntu's AppArmor package
ships `/etc/apparmor.d/bwrap-userns-restrict` (profile `unpriv_bwrap`), which
lets bubblewrap create its namespace but strips capabilities from anything
nested in it. On such a host the sandbox starts and every command then fails
with `apply-seccomp: write /proc/self/setgroups (nested userns is
capability-restricted …): Permission denied`. This was seen on GitHub's Ubuntu
26.04 runner; neither `kernel.apparmor_restrict_unprivileged_userns=0` nor
`kernel.apparmor_restrict_unprivileged_unconfined=0` is enough.

So the probe runs what the CLI needs:
`claudeLinuxSandboxStatus` (`packages/protocol/src/node/claude-linux-sandbox.ts`)
runs `bwrap --new-session --die-with-parent --unshare-user --unshare-pid
--ro-bind / / --dev /dev --proc /proc -- unshare --user --map-root-user --pid
--mount --fork --mount-proc true`, and on failure `bwrap … -- true` to tell the
two stages apart. Each run is bounded at 5 seconds and the answer is reused for
5 minutes, so a host whose policy the user changes is re-read without a
restart. It fails closed: a host without `bwrap`, `socat` or `unshare`, whose
bubblewrap cannot create a user namespace, or whose nested namespace is
refused, is not sandboxed. The reason names the cause, and names
`bwrap-userns-restrict` when AppArmor is enabled and that profile is installed.

Three consumers use it:

- the backend's coordinator table, which reports Claude as
  `provider-configured` with that reason;
- the Claude bridge, which runs the probe where the CLI runs (the host, or
  inside a container) and refuses a turn that requires the sandbox: a session
  whose execution policy sets `sandbox: "provider"`, or a coordinator launched
  as `required`. The prompt route answers 422
  `{ kind: "sandbox-unavailable" }` before anything is journaled, and the
  backend shows the reason as the prompt's error
  (`claudeSandboxRefusal`, `bridges/claude-bridge/src/services/claude-execution-sandbox.ts`); and
- a read-only review turn in an ordinary bridge (a prompt with `readOnly`:
  Multi Review's consolidation and packaged reviewers, plan-mode fan-out
  reviewers), described next.

#### Read-only review turns without a working sandbox

Such a turn runs under `READ_ONLY_TURN_POLICY`, the coordinator's boundary,
but no launcher has qualified the host for it. It used to ask the CLI for a
required sandbox whatever the host, so the pinned CLI refused the whole turn
before any model call where `bwrap` or `socat` is missing (every container:
the image ships neither), and under AppArmor's `bwrap-userns-restrict` the
turn ran and every Bash call failed in `apply-seccomp`.

Now the bridge decides per turn (`claudeReadOnlyCommandSandbox`): a
coordinator process keeps its launcher's answer (absent reads as `required`);
otherwise macOS asks for Seatbelt, Linux follows the probe, and any other
platform has none. Where there is none, the turn runs with
`enabled: false, failIfUnavailable: false`, the way an `unavailable`
coordinator does. Everything else that holds the turn is unchanged: the
PreToolUse command hook, the reading-tool allowlist, the denied tools, the
`deny` approvals, `allowUnsandboxedCommands: false` and the `denyWrite` list
(inert without the sandbox, kept as intent). The turn is never refused for
it. The decision is part of the launch boundary, so a warm CLI launched under
the other answer is not joined.

The boundary is shown, not silent:

- **Agent Info.** While the turn runs, the reported policy says `sandbox:
  "none"` and its note adds `readOnlyCommandSandboxOffNote` with the probe's
  reason (`claudeReportedPolicy`, `readOnlyTurnReportedPolicy`).
- **Multi Review.** `GET /session/:id` carries `readOnlyCommandSandbox:
  { state: "off", reason }` until the next non-read-only turn; the backend
  reads it as `commandSandboxOff` on the session observation and keeps it on
  the reviewer (`ReviewerRecord.commandSandboxOff`) and on the consolidation
  step (`stepRuntimes.consolidate.commandSandboxOff`). The reviewer's and the
  consolidation step's inspector show it as a warning note. A restarted
  reviewer or step starts without it.

Proved by the bridge's session-manager and route tests with an injected probe
answer, and by the `read-only-*` cases of
`conformance-coordinator-sandbox-live.test.ts`, which hide `bwrap` and
`socat` from `PATH` and run the pinned CLI against a scripted endpoint; the
case that pins the CLI's own refusal of a required sandbox runs only on Linux.
Not yet run: a real Multi Review in a container environment and on stock
Ubuntu
([0190](../todo/agent-engines/0190-claude-read-only-turns-without-working-sandbox.md)).

Orkestrator never changes AppArmor policy and does not ship a profile. To get
`enforced` on such a host, an administrator chooses one of:

- **A local profile for bubblewrap that allows nested namespaces.** For
  example a profile in `/etc/apparmor.d/` attached to `/usr/bin/bwrap` that
  keeps `userns` and capabilities for its children instead of
  `bwrap-userns-restrict`'s capability-free `unpriv_bwrap`. This keeps the
  restriction for every other program. It also widens what any bubblewrap
  user (Flatpak, other sandboxes) may do inside its namespace, and the
  profile has to be kept in step with Ubuntu's own across upgrades.
- **Removing `bwrap-userns-restrict` (and `unprivileged_userns`) on a
  dedicated host**, with `apparmor_parser --remove`. CI does this, and sets
  both sysctls above to 0, on its disposable runner
  (`.github/workflows/ci.yml`); that is the tested combination. It removes Ubuntu's mitigation against unprivileged user
  namespace exploits for every program on the host, and the profiles return on
  the next boot unless they are disabled in `/etc/apparmor.d/disable/`.

Otherwise Claude still works as a `provider-configured` coordinator, with the
hook as its boundary, and an interactive session can run without the provider
sandbox.

Not yet run: stock Ubuntu 24.04 and 26.04 desktops, Debian with AppArmor,
Fedora (SELinux) and Docker containers
([0145](../todo/agent-engines/0145-claude-linux-sandbox-apparmor-nested-userns.md)).

### Changing qualification

Do not reintroduce a platform literal at any of the gates listed above — that
is what previously let a platform be half-qualified, allowed to hold a
conversation but refused a bridge.

Change a tier in the read-only boundary of `capability-enforcement.ts`, never
in `coordinator-providers.ts`: the coordinator and graph nodes share it, and
`coordinator-providers.test.ts` fails if the two disagree.

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
Only a live run shows that the provider holds it. `coordinator-conformance.test.ts`
fails if a platform the coordinator offers, enforced ones included, is missing
from the live suite's platform list (`COORDINATOR_LIVE_PLATFORMS`).

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

A bridge turns an image attachment into inline image content, so the model sees
the picture but no path. Each coordinator turn with an image therefore carries a
marked block naming where it is saved
(`coordinatorPromptWithAttachmentPaths`); it goes to the provider only, and
transcripts remove it and draw the file.

### Passing a pasted image on

A coordinator is read-only, so it cannot save a pasted image somewhere another
agent can read it. It names the image instead, and the backend does the copying
(`coordinator-mail-attachments.ts`, `mail-attachments.ts`). There is no new write
access, tool permission or sandbox change on the coordinator's side.

- **`send_message` takes `attachments`**: the paths it was given (a bare file
  name works too). It reaches anything `send_message` reaches, on any connected
  node: agent tabs, build pipeline workers by address, containers, the project
  home, side agents and coordinators. With a `nodeId` it goes across the node
  link; a leaf's coordinator sends it upward through its outbox
  ([command-nodes.md](command-nodes.md#images-between-nodes)).
- **`transfer_files` takes `from: { nodeId, attachments: true }`**, with the same
  checks and landing place and its normal receipt of sizes and hashes, for a
  copy with no message. `toDirectory` is refused; a worker can copy the file out
  of the Git-excluded folder if it belongs in the tree.
- **Only this conversation's own files.** A reference must be a bare name or an
  absolute path directly in the calling conversation's attachment directory.
  Another conversation's file, `..`, a relative path, a symlink or a directory
  is refused. The scope comes from the credential, never from the tool input.
- **Images only, by content.** PNG, JPEG, GIF and WebP (what the paste flow
  accepts), recognised from their bytes on the sending side and again on the
  receiving side. At most 8 images a message, 8 MiB each, 32 MiB together
  (`AGENT_MAIL_MAX_ATTACHMENTS` and its neighbours).
- **The copy comes first.** A refused or failed copy means no message, and the
  caller is told why, so a message never points at a missing file. A message
  refused after its copy (a worker that has just ended, say) leaves the file in
  the same ignored place, with nothing pointing at it.
- **Retries are safe.** A message's files have one fixed place, derived from the
  sender and `requestId`. A retry finds them, skips the copy and replays the
  mail. The same `requestId` with another image is `idempotency-conflict`.

Where a file lands:

| Recipient | Location | Removed |
| --- | --- | --- |
| Environment (worktree) | `<worktree>/.orkestrator/mail-attachments/<batch>/` | With the worktree |
| Environment (container) | `/workspace/.orkestrator/mail-attachments/<batch>/` | With its storage |
| Project home | `<dataDir>/project-home-mail-attachments/<environmentId>/<batch>/`, outside the user's checkout, copied only once the user approves the message | With the project home (environment deletion, or the next maintenance pass once its record is gone, as when the project is removed), or once past configured mail retention (14 days by default) |
| Coordinator or side agent | That conversation's attachment directory, the root its read-only rules can read | With the conversation's retention or the project |

`.orkestrator` is Git-excluded in every environment, and the copy first proves
that for the location (`ensureWorkspaceArtifactIsGitExcluded`) and fails if it
cannot, so a sent image does not reach a commit or pull request through normal
staging. The project home is the user's own checkout, which Orkestrator never
cleans, so nothing is written into it: its images stay in the data directory
(`projectHomeMailAttachmentDir`, `apps/backend/src/core/mail-attachments.ts`),
where no repository can stage them. `deleteEnvironment` removes that directory
with the project home, and every backend's 30-second node maintenance pass
(`NodeFiles.sweepMailAttachments`) removes the directory of a project home whose
record is gone and any batch older than mail retention, by which time no
message names it. A failed record read keeps the files. A stopped container is refused rather than queued: there is nothing to
write into until it starts.

The message records each file as `attachments` (`AgentMailAttachment`: name,
path on the recipient's filesystem, media type, size, hash). Its carrier and
`read_message` give the recipient those paths, and the body stays the sender's
own words. The mail tile shows each name and size, never the path. It draws no
thumbnail, because the path is often on another machine or in a container the
viewer cannot read from.

Workers cannot send images: `send_message` on a worker's Agent Tools has no
`attachments`, and every check here is about a coordinator conversation's own
directory.

How it is verified, with no provider turn:

- `coordinator-mail-attachments.test.ts` and
  `coordinator-mail-attachments-nodes.test.ts` run the real send commands, mail
  store, transfer framework and Git worktrees, for every recipient kind and both
  node directions; containers there are a fake `docker exec` running the real
  writer script.
- `coordinator-mail-attachments-docker.test.ts` sends into a real container
  (opt-in: `ORKESTRATOR_TEST_DOCKER_IMAGE=orkestrator-v2:latest`; it runs with
  `--network none`). It checks the image's `node` user can read the file, that
  Git ignores it even after `git add -A`, and that a retry adds nothing.
- `bun scripts/qa-coordinator-image-mail.ts` starts two real backends from
  source, each blind to the other's files, links them over the real gateway and
  runs every route with no agent
  ([command-nodes.md](command-nodes.md#images-between-nodes)).
- `coordinator-mail-attachments-read-live.test.ts` (slow tier) has the
  recipient's own agent open the file. It sends through the real commands and
  injection drain, then hands the exact delivered prompt to the pinned Claude
  CLI and the pinned Codex CLI, each pointed at a scripted loopback model. The
  model takes the path from the prompt it received and calls the CLI's own tool
  (`Read`, `view_image`); the test checks the CLI returned the same bytes as
  image content. It covers a worker in its worktree and a side agent in its
  attachment directory, which is outside its working directory: Claude reads
  there only because the bridge approves `Read` up front for every session,
  read-only coordinators included (`session-manager-prompt-query.ts`). No
  provider is called.
- Not covered: Cursor, Pi and Grok recipients, and an agent reading inside a
  container
  ([todo 4420](../todo/coordinator-and-multi-review/4420-coordinator-image-mail-live-qualification.md)).

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

Each change is also recorded as a repository context event
(`repositoryContextEvents`, the newest 32) with the branch and commit it moved
from and its source: `upstream` for a fast-forward, `switch` for the branch
picker, `external` for anything Orkestrator did not do itself. A conversation's
first turn after the checkout moved gets a **checkout update** notice inside its
context block (`coordinator-checkout-update.ts`), whatever started the turn (a
typed message, mail, a timer): what moved it, the old and new commit, and up to
20 new commits (subject lines) and 40 changed paths from
`ProjectGitService.checkoutChanges`, with totals. It tells the coordinator its
earlier reads may be stale and to check whether the changes bear on the
request. "Since its previous turn" is the revision the conversation's newest
dispatched turn carried (`repositoryContextRevisionAcknowledged`), so the
notice is shown once, is repeated if that turn was refused, and is not shown on
a conversation's first turn. When the starting commit is no longer known (the
event was evicted, or written by an older release) the notice still says the
checkout moved and where it is now. Commit subjects and paths are repository
content, so each is kept to one line and cannot close the context block.

### Keeping the checkout on its upstream

The coordinator reads the project's own checkout, so the backend keeps it on
its upstream whenever Git can fast-forward it cleanly. Nobody is asked. The
rule lives in `@orkestrator/protocol/coordinator-upstream-merge`
(`decideUpstreamMergeOffer`): an upstream is configured, `behind > 0`, and
nothing blocks a fast-forward (no local commits, no uncommitted changes, no
unfinished repository operation). Nothing is ever merged under a running
coordinator or project-home turn, because the backend refuses to change the
checkout then. It happens at three moments.

**Before each message to the main coordinator**, its first prompt included,
the panel asks the backend (`check_coordinator_upstream_merge`, waited on for
at most five seconds). The backend answers without fetching while the
checkout cannot change, and otherwise runs the cooldown-bound fetch and
answers a mergeable checkout `{ offer: true, automatic: true }`. The panel
then fast-forwards with `syncProjectGit` and sends. The backend waits for the
fetch for at most three seconds (`coordinator-message-upstream.ts`). When it
is slower, or fails, the backend fast-forwards the checkout itself to the
upstream commit it has already fetched (`fastForwardToFetchedUpstream`, a
local `git merge --ff-only` under the same rules) and answers
`{ offer: false, reason: "fast-forwarded" }`; the panel refreshes and sends.
That merge does not wait in the checkout's Git queue, where the slow fetch
is, and turn admission waits for it as for a merge sync. The late fetch only
refreshes the status. Every check logs `checkout.message-check` with its
outcome, how the fetch went and `durationMs`. A fast-forward that fails
anyway (the remote moved, the network dropped) is reported in the toolbar's
error and the message is still sent, since there is no question left from
which to choose to skip it. Side agents and `!` commands do not merge, and
neither does a blocked checkout; the toolbar already says why that one cannot
sync. Against a backend without the check, the renderer applies the same
protocol rule to its own fetch. Any offer, including one without `automatic`
from an older backend that would have asked, is merged.

**Before agent mail wakes the main coordinator** (a worker's report, a side
agent's question, a status notice), the backend does the same itself, since no
client is involved (`coordinator-mail-upstream.ts`, the `beforeMailInject`
hook of `NativeAgentService.dispatchMailInject`). It runs before the mail turn
enters the session's dispatch fence, so the coordinator context block of that
turn names the merged commit. Independent environments drain mail concurrently
from a snapshot of at most 100 pending entries; each environment retains serial
delivery and batching. A slow coordinator fetch therefore does not block worker
mail in the same pass. Mail attempts have a 60-second per-project backoff,
including failed and timed-out attempts, separate from the successful-fetch
cooldown. Mail held because the checkout was busy (a running turn) does not
count as an attempt, so its redelivery when the turn ends still tries. The
fetch is cooldown-bound and the wait for it is capped at five seconds: past
that the late fetch does not start a fast-forward afterwards, and the
checkout is fast-forwarded instead to the upstream commit it already has, as
it is after a failed fetch or sync (`checkout.mail-follow`
`outcome=fast-forwarded-fetched`), the same rule as a typed message. A fast-forward
that has begun is finished first, because the turn's admission
(`beginTurnAfterMergeSync`) waits for it. A running turn, a blocked checkout,
a side agent, a paused coordinator and a steered message (one taken into a
running turn) are all left alone, and a failure is logged
(`checkout.mail-follow`) and never holds the mail.

**When an environment's pull request merges**, the backend fetches (past the
cooldown) and fast-forwards the project's checkout
(`project-checkout-merge-follow.ts`, owned by the PR monitor runtime). Every
merge path reaches it: the merge button and every other backend merge command
(`runStoredEnvironmentMerge`, once GitHub confirms the merge), auto-merge, and
a merge made on GitHub that the PR monitor observes
(`resumeTerminalEffects`). Only projects with a coordinator or a project home
are touched, since nothing else reads that checkout, and the project home's
own PR is not followed (its checkout is the PR's branch, not the base it
merged into). A merge observed while a turn holds the checkout is retried
every 30 seconds for up to 30 minutes; after that the next coordinator message,
typed or mailed, merges it instead. Merges of one project coalesce, and each PR is followed
once per backend process. The work belongs to the backend: no client has to
be open.

Earlier releases asked *"Merge N upstream commits?"*, remembered declines
(`decline_coordinator_upstream_merge`, store `coordinator-upstream-declines`)
and offered an **Always merge** setting
(`get/set_coordinator_upstream_auto_merge`, store
`coordinator-upstream-auto-merge`). The backend still answers those commands
for older clients, but neither a decline nor the setting changes the check,
and `coordinatorUpstreamAutoMerge` is no longer advertised, so a client that
knows it hides its toggle. A browser's own copy of the declines is deleted on
the first check.

### Branch switch and Sync while a turn runs

The backend refuses to change the checkout while any turn holds it: a turn in
any open conversation or in the project home
(`findCoordinatorCheckoutTurn`, `coordinator-checkout-turn.ts`). The toolbar
disables the branch picker and Sync for the same reason and names who holds it
("Coordinator is running a turn…", or "Home"), so a user with a side agent
focused is not refused only after confirming a discard. Refresh stays enabled,
because a fetch does not touch the checkout.

The panel cannot work this out alone. Only the front tab of each group is
mounted, and only a mounted tab keeps its projection current, so a stored
projection misses a turn that started behind another tab and keeps saying
`running` after one that finished there. The panel therefore asks the backend
(`get_coordinator_checkout_turn`), which answers from the activity observer
with no liveness touch or hydration, and adds the projections of the
conversations it has mounted, which can be ahead of the observer
(`useCoordinatorActiveTurn`). It reads again on every mount, on an activity or
session hint for those conversations or the home, on a resync or safety check,
and every 30 seconds while a turn is held. Against a backend without the
command, or before its first answer, it goes by every projection it has.

The panel's Git actions and conversation actions keep separate busy flags
(`useCoordinatorActions`), since the backend serializes Git per repository root
and conversations per project: a fetch does not disable New side agent, and
closing a conversation does not disable Refresh.

## Workers' waiting prompts

The coordinator panel has no list of its work. A **Work** side panel listed
every worker, build, Multi Review, graph run and followed pull request with
Open, Stop and Clear actions; it was removed on 2026-11-05 because it did not
earn its space, and the conversation now takes the full width. The coordinator
itself still sees its work through `list_workflows` and its wakes, and the user
through mail tiles, the workers' prompts banner below, and each environment.

What the panel used stays in the backend, unchanged, for the coordinator and
for an older renderer still running against this backend: `hide_coordinator_work`
and `workHiddenAt`, `stop_coordinator_worker_turn` with `stoppedBy: "user"`, and
the delegation request summary (`normalizeCoordinatorDelegationRequest`). No
renderer in this release calls the first two. A device that had folded a
section of the panel kept that choice as `collapsedWorkBuckets` in the persisted
`uiStore`; the store now drops the field when it loads, and the next write
leaves it out.

Conversation-specific mail, startup failures, provider notices and the agent's
own waiting prompts use an independent `FloatingNoticeLayer` anchored inside
that conversation pane. Each pane measures its own transcript gutter; a hidden
mobile pane therefore also hides its notices and their live regions. Panel-wide
notices (pause, action errors, workflow capacity and worker prompts) use the area
stack, which is collapsible and makes no assumption about a shared transcript
column across splits. Stacks and cards scroll within the measured pane height,
and pills stay within the pane width. Collapsed status and alert notices retain
live summaries; opening a card returns announcements to its full content.

`HumanPromptBanner`, floating at the top right of the conversation area with the
coordinator's other notices (`CoordinatorWorkerPrompts`), shows the prompts of
this coordinator's workers, with an **Open** that goes to the waiting tab. Local
workers are read from this backend. Workers on another node, while a
request to them is open, are read with `list_human_prompts` through that node's
link (`useRemoteHumanPrompts`), on the node's `human-prompt` hint, on its resync,
whenever its summaries refresh, and on resync and safety checks.

The link and code do cross nodes, checked against what node summaries omit.
Summaries carry no prompts because every client receives them and the command
node keeps them as last-known state; this read does neither, since the answer
lives only in the banner's React state and `invoke_on_node` logs no arguments or
results. It widens nothing: `list_human_prompts` is not in
`NODE_ROUTING_EXCLUDED_COMMANDS` and is a `workspace` command, a window opened on that
node already shows the same banner, and `get_native_agent_projection` crosses the
same link with the tool output the prompt was detected in. A remote answer is
still untrusted, so `normalizeRemoteHumanPromptEntry` bounds every field, drops
any link that fails `isSignInLink` (a node cannot put an arbitrary "Open link"
here) and drops `userCommandId`, because a remote command cannot be answered from
this banner. Entries for other environments and more than 32 per node are
dropped. A node that predates the command, or fails a read, shows nothing new; a
failed read keeps the last reading until the node is reported unavailable, when
its prompts drop out. A remote worker's prompt still does not produce a notice to
the coordinator: `noteWorkerHumanPrompt` is local. Two real nodes have not
exercised this:
[4942](../todo/coordinator-and-multi-review/4942-c7-live-checks.md).

### Mail tiles and the report cue

A workflow notice about a worker (an `agent-tab` or `environment` resource) gets
an **Open** beside its Open conversation button, through the same
`openCoordinatorWorkTarget` as the prompts banner. `notice.resource.nodeId` names the node
of a worker elsewhere; it is additive, and a notice without it means this machine.
`workerTabTarget` resolves the worker against this client's own stores, so a
deleted environment, one being deleted, a node that is not connected, or an older
notice about another node's worker (an id no local store knows) offers no action.
The tile renders in any transcript, not only a coordinator's.

The "Coordinator report" cue (`coordinatorReport` in the sound settings, on by
default; a config without it gets the default) plays when a delegation's wake was
delivered: `CoordinatorService` raises `coordinator-wake-attention`, which
`installStorageEventFanout` sends to every client. It is presentation only, like
`environment-attention`: content-free, with a fixed id per wake so a client acts
once, not replayed to a client that was away, and quiet while that coordinator's
page is on screen in a visible window. A worker's "agent stopped" cue and its wake
within 500 ms are one sound. A backend that predates the event never sends it, and
an older client ignores it. A desktop notification is a wider feature:
[4941](../todo/coordinator-and-multi-review/4941-coordinator-report-desktop-notification.md).

## User `!` commands

A message that starts with `!` in a coordinator conversation's composer runs
the command as the user in the project's checkout on this node, with the
user's own environment, and shows its output, the prompt it waits on (link,
code, ENTER), an input line and Cancel in the conversation. The coordinator's
agent is told what ran, and what it printed, at the start of its next turn.
The mechanism is the same as in any agent tab; see
[user-commands.md](user-commands.md). The composer's hint line mentions them
([What the panel explains](#what-the-panel-explains)).

**Why this does not break the read-only boundary.** The read-only policy is a
limit on the *agent*: the bridge's tool hooks, the shell allowlist and the
sandbox decide what the coordinator model may do, and none of them changes.
A `!` command is the person at the keyboard acting, exactly as if they typed
it in a terminal in that checkout, and the backend runs it outside the agent
entirely:

- only the composer can start one (`run_user_command` is not a Control MCP or
  agent tool, and the backend never treats a leading `!` in prompt text as a
  command), so the coordinator model cannot use it to escape its policy, and
  neither can mail, a workflow or a scheduled prompt;
- the agent receives the command and its output as text in its next prompt,
  not as a tool it can call again;
- it may write to the checkout, as the user's own terminal may. It does not
  take the coordinator-turn lease, so a long-running command (`npm login`
  waiting on a browser) does not block Sync or branch switching; the
  repository toolbar notices a branch or HEAD change it makes as it would any
  other external change.

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

`list_workflows` carries each worker association's `delegation`: its `state`,
`bucket` (`needs-you`, `running` or `finished`), `workerTabId`, `requestedAt`,
`completedAt`, `waitingSince` and `stopRequestedAt`. With `openOnly` it lists only
the workers still being waited on, filtered before the 200-row cap, so it answers
"what am I waiting on?" without polling `list_environments` and `list_agents`.
`coordinatorDelegationBucket` (`packages/protocol/src/coordinator.ts`) is the one
definition of a delegation's bucket.

The poll guard (`apps/backend/src/core/control-mcp-poll-guard.ts`) covers
`read_messages`, `get_message_status`, `list_environments`, `list_agents`,
`get_environment`, `get_tab_state`, `get_tab_transcript`, `get_build_pipeline`,
`get_multi_review` and `list_workflows`. After three identical answers, the
next one still returns the whole authorized result, with `repeatedRead: true`
and the contract attached; the guard never withholds data. Two rules decide
what is identical:

- **The key is the question.** Each read is keyed on the tool, its target and
  the filters that change what is asked (`status`, `unreadOnly`, `openOnly`),
  never on paging or size (`limit`, `offset`), so asking for a different page
  size does not reset the count.
- **The fingerprint is the state a poll watches.** For `list_environments` and
  `get_environment`, lifecycle, setup, activity and PR state for every listed
  environment (and every other node's rows), leaving out `lastActivityAt`, so
  re-listing while a worker is still `working` counts as the same answer. PR
  state there is the whole reading below: a PR that starts conflicting, has a
  check finish or fail, or becomes ready to merge is a different answer.
  `list_agents` compares each tab's state and goal; `get_tab_state` the
  connection, turn phase and error, open interactions and goal, not the
  streaming revision; `get_tab_transcript` its newest row (a row is one model
  response), whatever `limit` asked for; a workflow its summary without
  timestamps and revisions; `list_workflows` each association's delegation,
  follow and resource state.

The window slides: each identical read extends it by 120 seconds, so slow
polling is caught too. Entries are bounded (256) and dropped with the
conversation's credential.

A coordinator's `get_environment` and `list_environments` rows for a worker
with a pull request carry, besides `prUrl` and `prState`,
`prHasMergeConflicts`, `prMergeability` (`clean`, `blocked`, `dirty`,
`behind`, `unstable`, `unknown`, `unavailable`), `prChecks` (`passed`,
`failed`, `pending` and `total` counts, plus `requiredFailed`, or null) and `prReadyToMerge` with
`prNotReadyReason` when false (`coordinator-pr-status.ts`). Readiness is
`evaluatePrMergeReadiness` (`packages/protocol/src/pr-merge-readiness.ts`),
the rule behind the sidebar's shimmer, with checks always required (the
coordinator ignores the auto-merge setting) and the PR monitor's confirmation as
its freshness: this node's announced monitor state
(`get_environment_pr_health`, which never asks GitHub), or for another
node's rows the health its summaries relay while that node is connected and
current. Other nodes' rows carry `prState` and these fields but never a URL,
since summaries do not. They are states and counts only, never check names
or logs. Operator reads are unchanged.

`requiredFailed` is GitHub's `isRequired`, which the PR monitor asks only
when its rollup shows a failing check, cached per PR head and failing set
(`pr-required-checks.ts`). A PR whose only failing checks are not required
stays quiet: no `pr-checks-failed` wake, and still not ready to merge. When
GitHub does not answer, or an older node does not relay the count, it is
null and every failing check counts; that notice says the check may not be
required.

## Worker delegation

### Routing

The main coordinator's context carries a short routing section,
`COORDINATOR_ROUTING_RULE` (`packages/protocol/src/coordinator.ts`):

| Work | Route |
| --- | --- |
| Fully specified: it can be written up as a ticket with acceptance criteria | `create_ticket`, then `start_build_pipeline` for it |
| Smaller or interactive | An idle worker that already fits, through `send_prompt_to_tab` or `launch_job`; otherwise `launch_environment` with a prompt, then back and forth with that worker |
| Anything that would run in the project home | Exceptional circumstances only, after telling the user why an environment will not do |

All work runs in an environment with its own worktree or container. The
project home is the user's own checkout, and an agent working there conflicts
with the user's own work in it. The role line says the coordinator gets the
project's work done through workers and never alters the checkout itself.

Whether a real model follows the table is checked by the live coordinator
suite's `routing` scenario (`mise run test:agent:coordinator --scenario
routing`; see "Live coordinator suite" in
[`agent-testing.md`](../development/agent-testing.md)).

### The context block

Every coordinator turn, including mail wakes, starts with a context block built
by the pure `buildCoordinatorContext`
(`packages/protocol/src/coordinator-context.ts`). The service does the reads
(`coordinator-context-reads.ts` and the existing helpers) and passes the answers
in, so a test can check the block's content and size without a service. A test
holds a main coordinator's block, before the research, node and checkout lines,
under 9,300 characters (including a 300-character increase for pattern-spotting
AGENTS.md guidance): it is paid on every turn, so raising that limit is a
decision about cost.

The block names the project (`Project: <name> at <checkout> (id <id>)`), falling
back to the id when the project cannot be read. A main coordinator that can
delegate gets a last line, omitted when nothing is open: `Waiting on 5 workers:
"a", "b", "c" and 2 more.`. It is what a model that has lost its history through
compaction has left of what it launched. It counts each worker once, reads one
environment per name it spells out (never more than
`COORDINATOR_WAITING_ON_NAMES`), and costs the turn nothing when a read fails.
It sits last so the changing line does not disturb the cached text ahead of it.
Names, paths and titles from outside the backend go through
`inlineCoordinatorContextText`, so none can add a line or close the block.

### Which environments a coordinator may act on

Worker mail is untrusted, so an injected worker can ask its coordinator to have
some other environment run something, which that environment would then do
under its own, possibly looser, policy. A coordinator therefore sends work only
to environments it created. The setting **Let the coordinator use environments
it did not create** (Project Settings, Coordinator;
`coordinatorOtherEnvironments` on the repository record, absent meaning off)
widens that, per project and for as long as it is on. A coordinator cannot
change it: `update_repository_config` and `patch_repository_settings` are on the
invoker's refused list. The refusal
(`COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL`) names the setting, so the coordinator
can tell the user what to do.

The answer comes from `coordinatorCreatedEnvironment`
(`coordinator-environment-scope.ts`), and it is per coordinator, not per
conversation: every worker belongs to the main coordinator, so a takeover from a
side agent, a new main after a closed one and an adopted workflow all keep their
workers. An environment counts when this coordinator has, on the same node
(`nodeId`), a settled record of:

- an `environment` launch (it carries `baseCommit`; a `delegation:` record does
  not, because asking an environment something does not make it yours);
- a `build-pipeline` or local `graph-run` with `createdEnvironmentId` naming
  the environment it actually created. The completion write records this only
  for a new environment. Pipeline reservations also retain `createsEnvironment`
  when requesting creation: a reclaimed admission may return before provisioning.
  Local provisioning saves repair the receipt, including when provisioning wins
  the race with association completion. For a remote pipeline, the next authority
  lookup reads the node's pipeline and persists its environment ID; retention
  keeps the unresolved remote creation intent until then. This marker alone
  never grants access. Deferred graph provisioning records its environment when
  published. Retention keeps the creation receipt while that local
  environment exists, and keeps remote creation receipts conservatively.

Workflow membership alone grants no authority. A review, a pipeline targeting
an existing environment, or an existing-environment graph launched under the
opt-in does not adopt that environment. Turning the setting off revokes access.
Legacy workflow records without creation evidence fail closed; use the setting
for those environments. Creation receipts remain sufficient even after the
pipeline or graph history itself is removed.

An environment with no such record, an older one included, is treated as not
this coordinator's. Nothing distinguishes it from one the user made by hand, so
allowing it would leave the check nothing to refuse. It takes the safe, explicit
outcome [version-compatibility.md](version-compatibility.md) allows for a field
an old version never wrote: the refusal, with the setting as the way out.

What the check covers is listed tool by tool in
`control-mcp-coordinator-environment-scope.ts`, and a test fails on an
environment- or workflow-taking tool that is in no list:

- **Checked:** `send_message` (`toEnvironmentId`, in its commands, because a
  reply's destination is resolved inside the tool; replies get no exception),
  `send_prompt_to_tab`, `launch_job`, `launch_terminal`, `stop_worker_turn`,
  `run_worker_command`, `set_worker_goal`, `pause_worker_goal`,
  `clear_worker_goal`, `fork_worker`, `start_environment`, `stop_environment`,
  `open_worker_browser`, `edit_worker_tab`, `create_pr`, `resolve_conflicts`,
  `launch_multi_review`, `start_build_pipeline` (`existingEnvironmentId`),
  pipeline resume, restart, pause and cancel (resolved through `pipelineId`),
  `launch_graph` (`environment.environmentId`), and `transfer_files` (its
  destination). Standard and custom review addressing always take the check,
  including reviews already followed by this coordinator, since addressing
  starts an agent in that environment.
- **Not checked, reads:** they send nothing and start nothing, including
  `get_tab_transcript`, `get_worker_changes` and `list_worker_commands`.
- **Not checked, user-approved requests:** `answer_worker_question`,
  `request_root_changes`, `request_environment_deletion`,
  `request_project_file_update`, `request_env_value_reveal`. The user is already
  the one deciding.
- **The project home** keeps its own rule below, which ends in the user's approval.

Addresses that are coordinators (`"coordinator"`, a side agent, a node's main
coordinator, the command node's) are not environments and are not checked.

### Messaging the project home

Every other coordinator action refuses the project home (see
[Project home](#project-home)). `send_message` to it is allowed but gated by
`send_coordinator_agent_mail` (`apps/backend/src/core/coordinator-worker-mail.ts`):

- **A reason is required.** Without `projectHomeReason` (why an isolated
  environment will not do) the call is refused with an error that names
  `start_build_pipeline` and `launch_environment`, and nothing is sent or held.
  Held messages also validate optional delivery fields; malformed tab IDs,
  subjects or reply IDs are refused rather than silently dropped.
- **Within 3 hours of a sent message** to that project home from this
  coordinator (`COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS`), the message is
  sent at once if it carries text only, and the tool result carries a `warning`
  that this is discouraged. Messages with images always need their own approval,
  even within this window, before their files are given to the project home
  (outside the checkout; see [Passing a pasted image on](#passing-a-pasted-image-on)).
- **Otherwise the message is held** as a `message-project-home` node action
  request, shown in the same approval dialog as `request_environment_deletion`
  and `answer_worker_question` (`ProjectHomeMessageApprovalDialog`), with the
  message and the coordinator's reason. The tool result says nothing was sent
  and that the coordinator is woken by mail. Approving sends the message as
  written, from the conversation that asked, under its own `requestId`
  (`send_approved_project_home_message`, which the coordinator's invoker and
  the node link both refuse); declining sends nothing, and the outcome mail
  says so.
- **Replay.** The approval request id is derived from the coordinator and its
  `requestId`, so a retry with the same `requestId` returns the same request
  (pending, declined, or the sent mail once approved) rather than creating a
  second one. The same `requestId` with a different message is a conflict.

Only sent mail opens the window: it is read from the mail store
(`latestCoordinatorMailTo`), counting this coordinator's messages to that
environment that were not bounced or undeliverable, whether sent directly or
after an approval. The user's own work in the Home tab is not coordinator mail
and does not count. A declined or expired request opens nothing.

A connected node's project home cannot be messaged at all: `send_message` with
`nodeId` (and a reply routed back to another node) goes through
`coordinatorNodeTarget().environment()`, which refuses the node's project
checkout as not a worker environment. That refusal is unchanged.

### Mail from a turn the user did not start

A coordinator's turn can begin with a worker's untrusted message, and whatever it
then sends would otherwise reach its recipient as "an authenticated delegation".
When the sending conversation's `lastTurnOrigin` is anything but `user`, the mail
actor carries `turnOrigin: "mail"`, and the carrier adds
`COORDINATOR_MAIL_ORIGIN_NOTE`: the request arose from agent mail, not from the
user's instruction. Mail from a turn the user started is unchanged, byte for byte.

The mark is coarse by design, the same line as the account-switch grant: it also
marks a delegation that merely happened during such a turn, and a later user turn
clears it even if the content carried over. An agent's reasoning cannot be traced
to specific input, so tracking provenance per message would only look more
precise. Two limits: a message the user approved
(`send_approved_project_home_message`) is not marked, since they read it; and a
leaf without `node-mail-turn-origin` frames mail as it always did.

`coordinatorCallTurnOrigin` (`@orkestrator/protocol/coordinator`) is the one
rule every path reads: only a turn the user started is unmarked, and an unknown
origin counts as mail.

### Delegated prompts from a turn the user did not start

The same mark reaches prompts, which are not mail
([6080](../todo/coordinator-and-multi-review/6080-x1-coordinator-trust-boundary-follow-ups.md)
task 5):

- A launch's delegation frame (`launch_environment`, `launch_job`,
  `fork_worker`, and a launch or fork on another node) ends with
  `COORDINATOR_MAIL_ORIGIN_NOTE` as its last line, after the instruction
  (`createCoordinatorDelegatedPrompt` with `turnOrigin: "mail"`). A frame from
  the user's turn is unchanged, byte for byte.
- `send_prompt_to_tab` from such a turn wraps the prompt in a frame holding
  only the note (`createCoordinatorMailOriginPrompt`). The worker already has
  its launch's frame, so the metadata and instruction are not repeated. A
  prompt from the user's turn is sent as written. This later prompt has no
  stored presentation, so the worker's transcript shows the frame as text.
- A remote fork sends the note inside the instruction text
  (`coordinatorDelegationInstruction`), which the node copies into the frame it
  builds. A node from before the note writes the same frame without knowing
  about it. The frame grammar is unchanged (opening line at offset zero, closing
  line, blank line), so an older backend or renderer parses a marked frame and
  accepts its stored presentation.
- The Control MCP tools read the origin through `get_project_coordinator`
  (`coordinatorScopeTurnOrigin`). The registry commands read it from the
  coordinator store (`coordinatorCallerTurnOrigin`). A read that fails marks the
  prompt rather than sending it as the user's.

A scheduled fire is framed from the turn that set the schedule, not from
whichever turn the conversation ran last. A coordinator schedule's owner
records `turnOrigin` (`user` or `mail`) when it is created. An `update_schedule`
or `resume_schedule` from a turn the user did not start sets it to `mail`, and
nothing clears it. The executor puts it on the fire's `CoordinatorControlScope`,
which only the backend's scheduler sets, and `send_message`,
`send_prompt_to_tab` and the launches read it in place of the newest turn. A
schedule created before the field has no `turnOrigin` and reads the newest turn,
as it did before.

### Delegation round trip

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

**It also needs agent messaging on.** `coordinatorDelegationAvailable`
(`coordinator-context-reads.ts`) reads the setting on each turn. With it off, no
surface promises a wake: the context prompt drops the delegation rules and says
why (`COORDINATOR_MESSAGING_OFF_NOTE`), the Control MCP instructions carry that
note instead of the contract, and `withoutWakePromise` replaces the `wake` field
and `nextStep` of any coordinator tool result, and the poll guard's restated
contract, with the same note. The tools themselves stay listed and still run; a
wake they earn is held until messaging returns. Tool descriptions are static and
may still mention being woken.

Worker creation records an explicit base branch and commit. Uncommitted root
changes are not copied, stashed, or committed into a worker, unless the user
approves a `request_root_changes` request (see
[Worker surfaces](#worker-surfaces)). A container worker
can start only from a commit published to a remote branch; unpublished commits
remain available to local workers.

Workers come in two kinds. A **prompt environment** runs one prompt
(`launch_environment`, or "With a prompt" in the New Environment dialog); its
review and PR are started by hand or by the coordinator. A **pipeline
environment** is one a build pipeline created and runs in
(`start_build_pipeline`, a ticket's Build button, or "A feature" in the New
Environment dialog); the pipeline runs build, review, fix, verify, PR and
conflict resolution itself.

The main coordinator chooses between them by `COORDINATOR_ENVIRONMENT_CHOICE_RULE`
(`packages/protocol/src/coordinator.ts`), carried in its context, in the
Control MCP instructions, and in short form in the `launch_environment` and
`start_build_pipeline` descriptions. It applies to every project:

- A pipeline environment is the default. The coordinator starts one with
  `start_build_pipeline` whenever the whole spec is known: a ticket, or what is
  being built has been settled with the user.
- A prompt environment is for investigation, or for interactive work that may
  stop, raise many questions or need back-and-forth with the user.
- With a prompt environment the coordinator owns the rest of the lifecycle.
  When it judges the work ready it launches Multi Review, then sees it through
  the fix, the PR and conflict resolution, as below. Investigation with no code
  change ends with the worker's report.

A worker never raises a pull request; a **PR tab** does, after review. In a
prompt environment the flow is build → review or Multi Review → fix → PR →
resolve conflicts:

- A Multi Review with auto-fix and auto-PR opens the PR tab itself (see
  [Status wakes](#status-wakes)).
- Otherwise the coordinator calls `create_pr` (see
  [Worker surfaces](#worker-surfaces)) once it has been told the review and
  its fix finished. Pass `nodeId` for a worker on a connected node; that node
  validates its project and worker and uses its own PR base branch and agent
  defaults. Retries reuse the same PR job on that node.
- A pipeline environment (one a build pipeline runs, whether started by
  `start_build_pipeline`, a ticket's Build button or a feature from the New
  Environment dialog) has its own PR step;
  `create_pr` refuses its own worker while the pipeline can still raise the PR.
  Forks and workers left by a removed, failed, cancelled or completed pipeline
  can use `create_pr`.
- Once raised, the coordinator follows the PR: it is woken when it opens,
  conflicts with its base, fails a check, becomes ready to merge, merges or
  closes (see [Status wakes](#status-wakes)). On a conflict it calls
  `resolve_conflicts`, which opens the worker's Resolve tab (the Resolve
  Conflicts button) and wakes it once that tab finishes, with the refreshed
  state. It never merges; the user does.

The main coordinator's context carries this, the PR wakes and
`resolve_conflicts` included, as `COORDINATOR_PR_RULE`
(`packages/protocol/src/coordinator.ts`), also in the Control MCP
instructions, and `launch_environment`, `launch_job` and `send_prompt_to_tab`
repeat it in their descriptions. Every delegation frame tells the worker the
same (`COORDINATOR_WORKER_NO_PR_INSTRUCTION` in
`packages/protocol/src/review-evidence-frames.ts`): commit and report, and do
not open a pull request even if the prompt asks for one.

Full validation follows the same split. Multi Review and build pipelines start
by running it once against the committed branch
([review preparation](review-preparation.md)), so a full pass just before them
repeats the work on the same commit. `COORDINATOR_VALIDATION_RULE` tells the main
coordinator to ask for focused checks when review comes next, in the same places
as the PR rule (the tool descriptions in short form). A full run is still right
when the user asks for one or its result is what the coordinator needs to
learn. The coordinator states whether review follows in every worker prompt;
when none follows, it must explicitly request all repository-required validation
before handoff. Every delegation frame (`COORDINATOR_WORKER_VALIDATION_INSTRUCTION`)
defers full passes only when the prompt says review follows, yielding to an
explicit full-run request. Otherwise the worker follows repository validation
requirements and reports any required full validation it did not run. A follow-up
sent as mail or to an existing tab does not carry that instruction, so there the
coordinator's rule is the only guard.

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
answer on the worker's behalf. For a question it may propose an answer with
`answer_worker_question`, which the user confirms, edits or declines in
Orkestrator (see [Worker surfaces](#worker-surfaces)); approvals stay with the
person in the worker's tab.

Whether a delegation has finished is decided in one place, `decideDelegation`
(`coordinator-delegation-decision.ts`), for the turn-end edge, the sweep and
workers on other nodes alike. Its comment has the table and says why those three
differ where they do.

The wake pass walks every closed delegation not yet woken. A failure costs only
that delegation: it is logged, throttled, under the delegation's id, and the rest
of the pass still runs, as do the later steps of the sweep. A call made while a
pass runs starts one more pass after it, so a worker that closes during another's
wake reports at once rather than on the next sweep. If the user closes the main
while its wake is on the way, the delegation stays unwoken, the next main adopts
it, and the mail already placed moves across with the rest of the closed
conversation's inbox. Closing, selecting and pausing wait their turn with
creating and assigning on the project's queue. A slow mail send does not hold
that queue. Wake-kind selection shares the project queue with close: it checks
the main is open, looks up held reports, and persists the kind together, so a
closed mailbox cannot make a real report look missing.

A delegation the backend closes (`closeOnDecision`) records its wake kind in the
same write when a main is open, chosen under the coordinator store lock so the
main cannot close in between. Retained closed mains do not prevent this batching
unless one still holds this worker's report. With no main open, or with a report
waiting for closed-main repair, the wake pass chooses and writes the kind
separately as above. Otherwise a wake is two coordinator writes, close with kind and then
`wokenAt`, with the mail write between them and one change announcement after
the last. A wake that stops short of `wokenAt` (it failed, or is held) announces
the close once after its attempt.

A wake that fails 10 passes across at least 10 minutes is given up on. Passes also
run on turn ends, so the time bound stops a short fault retiring every wake owed.
The selection of retirement (`wakeRetirement`, including the attempt count and
error kind) is persisted before sending its notice. Retries, including after a
restart or a failed receipt write, resume that path instead of sending an ordinary
completion notice. The retirement notice must reach the mail store before the
final receipt. If sending fails or no main is open, the wake stays owed for a later
pass or main. After storing the notice,
the pass rechecks that the main is still open before stamping retirement. A report
still held is released as ordinary mail on the next sweep, and the delegation
records `wakeFailedAt` with `wokenAt`, keeping `state` as the
worker's own outcome. Before retirement is selected, the count is in memory, so a
restart restarts it. Messaging
turned off, or no room for a new main under the conversation limit, is a state the
user can change rather than a fault: such a wake is held, not counted, and goes out
once that changes.

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
turn-end edge cannot hold its report until those tasks finish. A worker that
ended its turn **without** a report while that background work (a shell,
sub-agents) still runs is paused, not finished: its delegation stays open until
the work reports and a later turn ends, for at most two minutes per pause,
after which the notice says background work may still resume the worker. The
short bound limits notice latency for servers and watchers, which share the
same raw activity signal as awaited tasks. Observing the worker working again
resets the pause budget. The timeout reason and duration are stored with the
delegation's close, so failed wake writes and backend restarts preserve that
qualification. Remote workers use the same bounded hold when their node
reports `backgroundWorkPending` through `get_worker_request_state`; older
nodes retain their previous turn-only settlement behavior. A report is always
released immediately, even if background work continues. So is a turn end
while a command in the worker's environment is waiting on the user (a sign-in
link, a code, a password; see [user-commands.md](user-commands.md)): that turn
ended to hand something to a person, and the coordinator is woken at once. A
command an agent runs in a worker that starts waiting on the user also sends
the main conversation one workflow notice with the link and code, whether or
not the worker's turn has ended, and the panel shows it until it clears.

A worker started by `launch_environment`, or forked with a prompt by
`fork_worker`, receives its request as the startup tab's initial prompt. That prompt counts as an undelivered request until the
provider accepts it (`pendingAgentLaunch` is cleared), exactly like
uninjected mail, so the startup session reading idle during setup, before the
delegated turn starts, cannot settle the delegation. A report held
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
which resolves to the tab it is waiting on or the environment's agent tab. A
pipeline environment never resolves that way: each of its workers has its own
mailbox (see [Pipeline worker mailboxes](#pipeline-worker-mailboxes)).

### Pipeline worker mailboxes

Every agent session a build pipeline runs is a background worker with its own
durable mailbox: build, package preparation, each reviewer of a multi-reviewer
review, consolidation, address, verify, fix, PR and conflict resolution, in
every round. There is no pane tab for any of them; the mailbox is the worker.

- **Address.** The pipeline environment plus the tab id
  `pipeline-worker:<sessionKey>` (`pipelineWorkerTabId`,
  `packages/protocol/src/pipeline-worker-mail.ts`). The session key is minted
  before the session starts and never reused, so one address names exactly
  one worker instance; three parallel reviewers have three addresses.
- **Discovery.** `pipelineWorkers(pipeline)` derives the list from the
  pipeline record alone. The mailbox directory
  (`storage-agent-mail-directory.ts`) publishes one mailbox of kind
  `pipeline` per worker of a running pipeline, with `pipelineWorker`: step
  (`build`, `preparation`, `review`, `consolidation`, `address`, `verify`,
  `fix`, `pr`, `resolve-conflicts`), round, reviewer slot, label, model and
  status (`running`, `idle`, `finished`, `failed`, `cancelled`).
  `list_mailboxes` with `environmentId` lists them (with `nodeId` too, on a
  leaf), and `get_build_pipeline` carries the same list as `workers`
  (`control-workflow-summary.ts`), so a command node reading a leaf's pipeline
  lists the same workers. A worker gets its mailbox the moment its session
  starts: a send checks the pipeline's workers before it resolves the address
  (`ensureAgentMailDirectoryFresh`), and the mail service resynchronizes when a
  pipeline's worker set changes.
- **No implicit routing.** A send naming only a pipeline environment is
  refused with every worker's address, step, round and status. Mail is never
  re-routed: a worker that has finished, failed or been cancelled refuses new
  mail with that state (`recipient-not-found`), and mail still queued when its
  worker ends is marked `expired` with reason `worker-<status>`; each sender is
  told by a workflow notice (`state: "mail-expired"`; a command node's
  coordinator through the node outbox). Nothing goes to the next session of
  the same step.
- **Delivery.** The existing model: queued, steered, acked and replied to
  like any mail. While the worker's turn runs, mail waits. When the turn ends,
  the supervisor hands everything queued for that worker to it as one turn,
  before the pipeline advances (`dispatchWorkerMailTurn`,
  `build-pipeline-worker-mail.ts`), journaled as the pending prompt attempt
  like a queued user message, so it is delivered at most once; the attempt's
  request id is kept on the session (`mailDeliveries`) so a claim interrupted
  by a restart is reconciled against it. `deliverNow` steers into the running
  turn through the pipeline (`BuildPipelineWorkerMail.steer`, under the
  pipeline lock) and reports `steered`; an agent that cannot steer reports
  `unsupported, queued`; a worker between turns reports `queued until idle`.
  Fan-out reviewers and consolidation claim their own queued mail before
  accepting a result. Each mail turn rotates the result key and preserves the
  structured-result contract. Mail during fixed-snapshot validation cancels
  and archives that validation run before writable work resumes; preparation
  and validation must then certify the new state.
- **Identity.** A worker sends, replies, acks and checks its inbox as its own
  mailbox, on every agent and every turn (`pipeline-worker-identity.ts`):
  - A tool-mode stage turn's workflow-result capability carries the mail
    tools of the worker the backend's record says owns that attempt. On
    OpenCode the persistent workflow-result broker authenticates each mail
    call with the current resultKey and signed capability, then resolves the
    worker the same way.
  - A turn without one (build, address, fix, verify, PR, conflict resolution,
    reviewers and consolidation alike) gets its worker's identity from
    `BuildPipelineContext.workerMailTurn`. A bridge agent's turn connects
    with a credential scoped to the worker's mailbox
    (`resolveWorkerToolConnection`). OpenCode keeps its environment-wide
    `orkestrator` connection, so the turn's trusted system instruction
    carries the worker's mail capability (`workerMail`,
    `openCodeWorkerMailInstruction`), and every mail tool on that connection
    takes it as `mailCapability`. The capability names exactly one worker
    mailbox and project, is signed by the workflow-result service's durable
    identity (domain-separated, so it survives a restart), is never a bearer
    credential, and stops working when its worker ends and loses its
    mailbox.

  An environment-wide credential without that capability cannot claim a
  worker's mailbox, and no worker can use another's.
- **Trust.** Unchanged: the same senders reach a worker as any other worker
  in the project, with the same routes, budgets and untrusted peer-mail
  framing. The carrier adds that the recipient is a build pipeline step: a
  coordinator may guide the step's task but cannot change the pipeline's
  settings, delivery policy, ticket or acceptance criteria, and the stage's
  own instructions and required result still apply.
- **Transcripts.** `get_tab_transcript` with a worker's address returns that
  worker's own transcript, running or finished: the newest messages of its
  stage session's committed transcript (`get_build_pipeline_worker_transcript`,
  checkpointed every few seconds while the turn runs). It never touches the
  provider. The `claude-build` tab itself is still not a transcript source.
  That read returns the stored rows as they are, envelopes included. Only the
  display changes: `toPipelineTranscript` draws each delivered envelope as the
  same mail tile a native tab shows, and an envelope it cannot read as a plain
  notice, so a stage, Multi Review or graph-run transcript never shows the raw
  markup. Every provider stores mail as its own user row, whether it was steered
  in or delivered between turns, so the row alone is enough after a reload. What
  the agent receives is unchanged.
- **Durability.** Mailboxes and queued mail are rows in the mail store and
  are rebuilt from the pipeline record on start, so they survive a backend
  restart while the pipeline runs. A finished or removed pipeline's worker
  mailboxes are tombstoned with their final status, and pruned with the rest.
- **Delegations.** A coordinator message to a worker opens a delegation like
  any other; it settles when that worker's turn ends or the worker ends
  (`workerActivity` reads the pipeline for a `pipeline-worker:` tab).
- **Multi Review reviewers.** Each reviewer of a Multi Review has the same kind
  of mailbox while its review is in its reviewers' stage, under the same address
  scheme, so `list_mailboxes`, `send_message` and `get_tab_transcript` treat it
  alike (`multiReviewWorkers`, `multi-review-worker-mail.ts`). Queued mail becomes
  its next turn before its result is accepted, and `deliverNow` steers under the
  workflow lock. A restart rotates the session key, so it is a new address and
  mail never follows. Preparation, consolidation and Address Findings keep their
  own sessions and have no worker mailbox. A send naming only the environment is
  still routed as usual: a Multi Review does not make it a pipeline environment.

Decisions:

- **Address workers, not steps (chosen).** Options: (a) a mailbox per worker
  instance, named by its session key; (b) one mailbox per step that follows
  whichever session runs it; (c) the environment, routed to the running
  session. (b) and (c) deliver to a worker the sender did not choose when the
  running session changes between send and delivery, and cannot address one
  of several parallel reviewers. Con of (a): a sender must re-read the list
  after a round moves on.
- **Turn end, not idle (chosen).** A pipeline worker going idle is what
  advances the pipeline, so idle injection would always lose the race; the
  supervisor's own turn-end step delivers instead.
- **Expire, never re-route (chosen).** Mail to a worker that ended expires
  and the sender is told, rather than going to its successor.

### Course corrections with deliverNow

Mail to a busy worker normally waits for its turn to end. A coordinator that
must correct a worker mid-turn ("add this to your task", "stop, the
requirement changed") sets `deliverNow: true` on `send_message` (also when it
replies with `replyToMessageId`; the coordinator has no separate
`reply_message`). The tool description says to keep it for course
corrections, not routine follow-ups.

`send_coordinator_agent_mail` passes `steer` to `sendAgentMail`, which marks
the message's pending entry `steerRequested`: the same flag as the mail UI's
**Deliver now**, so the steer itself, its single attempt and the journal
verification of an unanswered steer are that path
([`agent-messaging.md`](agent-messaging.md), "Deliver now into a running
turn"). The flag is set only when the message is placed `pending-inject`, so
mutes, inject policy, the unattended budget, the hourly limit and
`mayInjectMessage` decide delivery exactly as before; `deliverNow` only lets
an admitted message skip the wait for idle. The command then waits for one
drain pass (outside the worker admission lock, as `retry_agent_mail_inject`
does) and returns `deliverNow` with a `deliverNowNote`
(`coordinator-deliver-now.ts`):

| `deliverNow` | Meaning |
| --- | --- |
| `steered` | Landed in the worker's running turn (`injectedVia: "steer"` on the message). |
| `delivered` | The worker was idle, so it went out as a new turn. |
| `queued until idle` | The steer did not happen (refused, too large, busy gate); it is delivered when the turn ends. |
| `unsupported, queued` | The agent cannot take mail mid-turn (a tmux agent, which also gets the `steer-unsupported` hold note, or a provider without `steer`); delivered when the turn ends. |
| `verifying` | The steer was handed off without an answer. It is checked against the steer journal and never offered twice. |
| `not queued` | The message was bounced, stored, held by a budget, or blocked by paused messaging or an unavailable environment; the note names the reason. |

The result includes the post-drain placement, reason and injection provenance.
Replaying a completed request ID returns its persisted success without another
drain or delivery. An unused steer request expires after this one pass, including
when messaging is paused or the environment is stopped or unready; later turns
can receive the mail at idle but are never steered by that expired request.

A steered message counts as delivered, so the delegation it opened or joined
settles when the running turn ends and the coordinator is woken once, as for
any delegation.

Decisions:

- **Coordinator-only.** Worker `send_message` and `reply_message` have no
  `deliverNow`, and `sendAgentMail` ignores `steer` for any sender that is not
  a coordinator (on this node, or a command node's coordinator whose mail the
  node link delivered): a worker steering its coordinator would bypass the
  delegation hold.
- **Never into a coordinator conversation.** Main ↔ side mail ignores the
  flag. Scheduled mail reports `queued until idle`; bounced, stored or
  budget-held mail reports `not queued`, so a side agent cannot cut into the
  main's turn with the user.
- **Across a node link, through a leaf that advertises it.** For mail to a
  worker on another node (`send_message` with `nodeId`, or a reply to mail
  from one), `send_coordinator_node_mail` adds `steer: true` to
  `deliver_node_mail` only when that leaf's hello advertises
  `node-mail-steer`. The leaf marks the pending entry as a local coordinator's
  would be, runs the same single delivery pass (`settleCoordinatorDeliverNow`),
  and answers with its own `deliverNow`, `deliverNowNote`, post-drain
  placement and `injectedVia`; its mutes, budgets and steer eligibility
  decide. Mail already injected by that pass still opens or joins the
  delegation. An older leaf would refuse the unknown field and the whole
  message, so it is sent nothing new and the result is worked out here:
  `unsupported, queued` for scheduled pending mail, `not queued` with the
  leaf's placement and reason otherwise. A lost answer is the ordinary
  outcome-unknown error with no `deliverNow` claim; retrying the same
  `requestId` replays on the leaf.
  Live qualification is in
  [0740](../todo/coordinator-and-multi-review/0740-coordinator-deliver-now-live-qualification.md).

`list_agents` (discovery) returns every agent tab in the project and what each
is doing — see [`agent-registry.md`](agent-registry.md).

Pause or mute messaging, or set a mailbox's injection policy to **Off**, to
hold automatic delivery. Stored, injected, acknowledged, and completed remain
distinct states. An injection receipt is not proof that the task finished.

### Stopping a worker's turn

`stop_worker_turn` ends a runaway or wrong-direction turn in one worker tab
(see [Worker surfaces](#worker-surfaces)); `deliverNow` is for correcting a
turn that should go on. When the coordinator is waiting on that tab, the stop
records `stopRequestedAt` on each open delegation for it before the provider
is asked, then the turn end settles the delegation as any other: the
coordinator is woken once, with the worker's held report if it sent one, or
with a notice that says it stopped the turn itself ("… stopped because you
stopped its turn with stop_worker_turn, before it sent a report") and the
worker's last message. A stop sent with `stoppedBy: "user"` (from the removed
Work panel; no renderer in this release sends one) records
`stopRequestedBy: "user"` as well,
and the notice says "the user stopped its turn from the Work panel" instead;
the tool's schema is strict, so a coordinator cannot claim that. On this node a stop the agent confirms settles the
delegation at once rather than on the next edge or sweep, so the tab takes a
`send_prompt_to_tab` straight away, in that turn or the next; an unconfirmed
one settles on the turn end. For a worker on another node, after any stop
that reached a running turn (confirmed or not), the command node asks that
node for the worker's state at once, and the usual remote rules (seen
working, or the idle grace period) decide when it settles. The notice keeps
the stop note however the delegation closes: a turn end, or an environment
that failed or stopped meanwhile ("… failed after you stopped its turn with
stop_worker_turn"). The background-work hold above is skipped for a
stopped turn. A stop that finds the tab idle marks nothing. A follow-up the
worker has not read yet still keeps the delegation open, as it does for any
turn end, so the worker's next turn answers it.

Decisions:

- **Settle on the turn end, and say who stopped it (chosen).** Options:
  (a) settle as usual with a stop-aware notice; (b) close the delegation as
  `stopped` at once with no wake, since the coordinator knows what it did;
  (c) leave the delegation untouched, so the notice says the worker finished
  without a report. (a) keeps the one-wake-per-request contract and releases
  whatever the worker had sent, which (b) would leave held or drop; (c) tells
  the coordinator something false. Con of (a): a report the worker sent
  before the stop is released as the wake without the stop note; the
  coordinator called the tool, so it knows.
- **Mark before the stop, unmark if nothing stopped.** Marking after the stop
  could lose the race with the turn-end edge and its wake. A stop that fails,
  or that a node answers with "idle", removes the mark; a lost node answer
  keeps it, because the stop may have landed.

### Restarting a failed pipeline step

`restart_build_pipeline_step` lets a coordinator carry on a build pipeline
that stopped for a passing reason (a usage limit, an unreachable agent)
without the user. It is the UI's step Restart, and with `selection` its
"Restart in…", through `BuildPipelineService.restartForCoordinator`
(`build-pipeline-restart-targets.ts` resolves the step inside the pipeline
lock).

- **Which step.** Omit `stepId` to restart the step a failed pipeline failed
  in (the session its `failureContext` names, or a fresh run of that step
  when it failed before its session existed), or the current step of a
  paused, stalled or running pipeline. Name another with its worker
  `address` from `get_build_pipeline` (a session key or provider session ID
  also works).
- **What it keeps.** The pipeline rewinds to that step's own round: earlier
  rounds stay as they are, the worktree is not reset, and the step's old
  session and any after it stay readable as a previous attempt. `selection`
  (agent, model, optional `reasoningEffort` and `fastMode`) becomes the
  step's selection from then on, as the UI's does.
- **Refusals.** A cancelled or completed pipeline, a failure in environment
  setup (before any step), a failure with no step, an unknown step and a
  pipeline of another project are refused before anything changes. The
  cancelled refusal (and `resume_build_pipeline`'s) says the cancel is the
  user's decision unless the coordinator made it, and not to start another
  build for the ticket unasked; it used to say "start a new build if the work
  is still wanted", which a Codex coordinator followed after the user
  cancelled (to-do 7545 task 4). `get_build_pipeline` shows `cancelledAt`
  on a cancelled build, whose phase reads `failed`. A
  refused request leaves no receipt, so the same `requestId` can be sent
  again once the cause is fixed.
- **Once per request.** The command node keeps a coordinator receipt
  (`restart-pipeline-step`), so retrying a `requestId` replays the first
  answer with `replayed: true`. With `nodeId` the leaf restarts the step
  through its node-link-only `restart_controller_build_pipeline_step` under
  its own receipt keyed from that one, so a retry after a lost answer
  replays there rather than restarting twice. A node without that command is
  refused with "update it, then retry" (see
  [version-compatibility.md](version-compatibility.md)).
- **How the coordinator hears.** A failed pipeline's follow had already sent
  its terminal notice and stopped observing. The restart reopens this
  coordinator's follows of the pipeline (clearing the terminal mark and the
  last notice), so its next completion, failure or pause wakes the
  coordinator as usual. The result says whether a follow exists and tells
  the coordinator to finish its turn. A step that fails again at once comes
  back in the result as `phase: "failed"` with the error.

`resume_build_pipeline` resumes a paused pipeline only. On any other phase
it refuses, naming the phase. Failed pipelines get restart guidance; active
pipelines are told they are already running and need no action. A failed pipeline's
status wake lists `restart_build_pipeline_step` when the failure belongs to
a step.

Decisions:

- **A new tool rather than widening resume (chosen).** Resume continues the
  paused session; a failed step needs a fresh session and a rewind to its
  round. Keeping them apart keeps resume's contract and makes the refusal
  point at the right call.
- **Code rewind and skipping a step stay the user's.** Both discard or
  bypass work, so they are not offered to a coordinator.
- **A completed pipeline is refused** even though the UI can restart its
  steps: redoing finished work, possibly reopening a pull request, is the
  user's call.
- **Durable restart identity.** The pipeline stores hashed request identity,
  intent, and resolved step with the restart intent under its mutation lock.
  Retries reconcile this record before resolving an omitted step, including
  after a backend crash or follow-update failure. The journal retains up to
  1024 entries; at capacity new requests are refused rather than evicting
  evidence of an earlier restart.

## Scheduled wakes and actions

A coordinator turn cannot wait, so a coordinator that needs to act later
(after a usage window resets, before a deadline) schedules it:
`create_schedule` with `at: "03:12"` and `action: {type: "send_message",
toEnvironmentId: "coordinator", body}` arrives at 03:12 as a reminder that
starts a turn, even if the conversation's provider was swapped meanwhile.
Schedules can also send a worker mail, prompt a worker tab, launch a worker
(resolving the base branch's newest commit when it fires) or call another of
the coordinator's own tools, with `nodeId` where the tool takes one. Each
fire runs the coordinator's own tool under its current scope, so read-only
rules and project boundaries apply unchanged. Main schedules follow the next
main conversation; a side agent's schedules end with it.
`list_schedules`, `cancel_schedule`, `pause_schedule`, `resume_schedule` and
`update_schedule` manage them: each conversation sees only its own (the main
also its side agents'), and `update_schedule` checks a new action exactly as
`create_schedule` does, so a side agent cannot reschedule into a tool it
cannot call. See [scheduled-jobs.md](scheduled-jobs.md).

### Self-timers and provider accounts

`create_schedule` with action type `remind_me` is a **self-timer**: its body
comes back to the conversation that set it (the main coordinator's address,
or the side agent's own runtime id) as a reminder that starts a new turn, and
one that fires mid-turn waits, like mail, until the turn ends. `at: "+2h"`
and `at: "14:30"` are both accepted; absolute times are read in this
machine's local zone (the user's) unless `timeZone` is given, and the result
names the zone (`timeZoneUsed`) and the local time (`nextFireLocal`).

For "check in 2 hours and switch accounts if the workers hit a usage limit"
the main coordinator has four tools (capability `accounts`, plus
`get_usage_limits` under `environments`; side agents get none):

- `get_usage_limits` lists the agent tabs whose newest recorded turn failed
  with a provider usage limit, and the active accounts' cached quota windows.
  It reads storage and caches only.
- `list_provider_accounts` lists the Claude and Codex logins on this machine
  or another (`nodeId`), the active one per provider, and each one's plan
  usage with `hasAllocationLeft`.
- `switch_provider_account` changes the active login through
  `set_active_agent_account`, the Settings switch, machine-wide. Without
  permission it creates a `switch-agent-account` request the user approves
  in the same dialog as `request_environment_deletion`. With the `scheduleId`
  of a self-timer that carries the user's permission it switches at once, and
  so it does when the user ticked "Let coordinators switch accounts without
  asking" for that provider in Settings on the coordinator's machine (within
  an hourly limit, never to a signed-out or used-up account; see
  [agent-accounts.md](agent-accounts.md#switching-without-asking)). The result's
  `state` says which happened, and the coordinator rule tells the coordinator
  never to ask the user to approve a switch that already ran. Either way it
  pins the account if automatic switching is on.
- `set_account_auto_switch` changes the automatic-switching ticks, with no
  approval, because the backend then does the switching. On a leaf it refuses the
  shared ticks, which its command node holds, and can still end that leaf's pin. Each
  automatic switch sends the open main coordinators a notice, following
  [Who hears a notice](#who-hears-a-notice). See
  [agent-accounts.md](agent-accounts.md#automatic-switching).

A session stopping on a usage limit also tells a coordinator by itself; see
[Usage-limit stop notices](#usage-limit-stop-notices).

A self-timer carries that permission only when the main coordinator sets it
with `authorizeAccountSwitch` in a turn the user started with their own
message: the backend records each conversation's `lastTurnOrigin` (`user` or
`mail`) at dispatch, and mail, status wakes and fired timers count as `mail`.
The permission names the providers and any other machines, holds the user's
words, and lasts two hours after the timer fires.
[agent-accounts.md](agent-accounts.md#coordinator-switching) and
[scheduled-jobs.md](scheduled-jobs.md#self-timers) have the details.

## Status wakes

Besides the delegation wake, a coordinator is woken when other work it started
or prompted **settles**, so it can keep track and respond without polling
(`apps/backend/src/core/coordinator-status-wakes.ts`).

**Ownership.** Only resources with a coordinator workflow association: the
durable record written at launch or prompt time with the coordinator and
conversation ids (`launch_multi_review`,
`start_build_pipeline`, `launch_graph` (a `graph-run` association),
`create_pr` and `resolve_conflicts` (a `pull-request` association),
`launch_feature_plan` (a `feature-plan` association per message), and the
delegations `launch_environment`,
`launch_job`, `send_prompt_to_tab` and `send_message` open). A Multi Review or
build the user started in the UI has no association and never wakes a
coordinator. A pull request the user raised is not followed either, but on a
worker the coordinator owns its merge or close still reaches it, as a
[worker outcome](#worker-outcomes). Notices go to the main coordinator that
[should hear them](#who-hears-a-notice), like every other report. With no main running,
a new event starts one. A sweep starts nothing: it waits, and sends the state current
when one opens. The one exception is the backfill rule, for work older than status
wakes: a non-terminal status with no earlier notice, unchanged for over 24 hours, on
an association over 14 days old is recorded without a wake
(`coordinator-status-backfill.ts`), so a project idle for longer than that does lose
such a notice.

**What wakes it.** Each resource is reduced to one settled status with a
stable key; a key is sent once, recorded on the association
(`statusNotice`).

| Resource | Status | Setting that sends it |
| --- | --- | --- |
| Multi Review | consolidation `ready` (finding counts by severity, coverage gaps, verdict) | `settled` |
| Multi Review | interactive fix turn finished (`fix-done`, with the reason when auto-PR started no PR) or failed (`fix-failed`) | `settled` |
| Multi Review | auto-PR: PR session started (`pr-started`), its pull request open (`pr-opened`, with the URL) or already `pr-closed`, `pr-merged` or `pr-unknown`, or the launch failed (`pr-failed`) | `settled` |
| Multi Review | a reviewer, consolidation or Address Findings session `stalled` | `settled` |
| Multi Review | `completed` (fix summary, files changed), `failed` (error), `cancelled` (stopped on purpose; a cancel the coordinator did not make is the user's decision, so it does not launch it again unasked) | always |
| Multi Review | all reviewers finished and consolidation started (`reviews-finished`) | `stages` |
| Build pipeline | `paused` by the supervisor on an error (a requested pause is not news) | `settled` |
| Build pipeline | a stage `stalled` (`stallWarning`) | `settled` |
| Build pipeline | `completed` (task, last verification, acceptance criteria, delivery), `failed` (error, acceptance criteria) | always |
| Build pipeline | `cancelled` (task; the error only when stopping every agent could not be confirmed), keyed per cancel. Never reported as `failed`: it says the build was stopped on purpose, that a cancel the coordinator did not make itself is the user's decision, and not to restart, resume or rebuild it or start another build for the ticket unless the user asks. It offers only `get_build_pipeline` (to-do 7545 task 4) | always |
| Build pipeline | a stage completed (`stage-completed`: build, review, address, verification) | `stages` |
| Graph run | waiting for a person (`waiting`): an open human-node wait or an agent's `ask_human` question (`graphRunPendingInteractions`), keyed by the newest open wait, describing up to six waits by node and form, never the question's text | `settled` |
| Graph run | ended: `completed` (agent sessions and tokens), `failed` (the run's error), `cancelled`, keyed `complete`, `failed` or `cancelled` | always |
| Feature plan | the planning reply to the coordinator's message is ready (`ready`; tone `attention` while the planner asks a question or for confirmation, `success` once it has stories), keyed `ready`, once | always |
| Feature plan | planning `failed` (the failure's code and bounded message), keyed per failure, so a retry's own failure or reply is reported too | always |
| Pull request | opened (`pr-opened`, with the URL), conflicts with its base (`pr-conflicts`), a required check failed (`pr-checks-failed`; any failing check when GitHub does not say which are required), ready to merge (`pr-ready`), merged (`pr-merged`) or closed (`pr-closed`); keyed per state and PR URL | `settled` |
| Pull request | its Resolve tab finished (`resolve-finished`), with the PR's state after the PR monitor's recheck | `settled` |
| Worker outcome | a worker the coordinator owns: its PR merged (`pr-merged`) or closed (`pr-closed`), naming the deletion when the environment is going too, or the environment deleted (`deleted`, resource `environment`) with its PR still open or without one; once per worker, unless a PR follow reports the merge or close | `settled` |
| Delegated tab | `waiting` for 20 s: on an approval, a question, or both when its pending interactions say which (otherwise "input or an approval"), with its last message; for a question, a line that the coordinator may propose an answer with `answer_worker_question` for the user to confirm. Reading idle, working or stopped ends the episode, so a later wait is sent again; an unreadable state does not | `settled` |
| Delegated tab | turn ended: the worker's report, or `completed`/`failed`/`stopped` with its last message | always (the delegation wake) |

A graph run is reduced to two statuses only (`graphRunCoordinatorStatus` in
`graph-run-coordinator-status.ts`): it ended, or it waits for a person.
Anything else, nodes finishing included, is progress. A wait's key is
`waiting:<openedAt>:<id>` of the newest open wait, and a wait is sent only when
it opened after the one last reported (`graphRunWaitNoticeIsNew`). So one wait
staying open while another is answered, a backend restart or a second observer
sends nothing again, and every new wait (a later node, a restarted one) sends
one. Graph waits have no 20-second debounce: the 2-second save debounce is the
only delay. `launch_graph` takes no `nodeId`, and the observer skips a
`graph-run` association that has one.

A feature plan is reduced by `featurePlanCoordinatorStatus`
(`coordinator-feature-plan-status.ts`). A `feature-plan` association names
one planning exchange (`featurePlan.operationId`); the plan takes many
messages from the user and the coordinator. Launch reserves a pending follow
before starting the planner, then activates it after startup succeeds or an
existing operation is found. Reconciliation leaves a pending follow alone
until its operation is attached; it can activate an attached exchange after a
backend restart. A confirmed pre-start refusal releases the reservation, so a
same-request retry can reserve it again. A successful exchange detaches
its planning record, so the reply is found on the plan: an applied assistant
message after the exchange's own user message (whose id is the operation id),
before the next user message. Plan saves announce the project id, so a save
observes that project's `feature-plan` associations after the usual 2-second
debounce. A cancelled exchange, a deleted plan, or a reply whose state block
never applied (its failure was already reported) ends the association without
a wake. Details are content-free: the plan's title, status and story count and
the failure message, never the reply or the user's message;
`get_feature_plan` reads those. Feature plans are this node's only.

**Criteria and the handoff.** A completed or failed build's notice
(`coordinator-build-pipeline-status.ts`) says how its newest live Verify judged
the acceptance criteria and on which commit: a tally ("Acceptance criteria:
4/5 passed, 1 failed; Verify judged commit abc1234."), then each failed or
not-checked criterion's id and text, within the eight-line detail cap and
before the delivery line, with a closing line naming how many more did not
pass. Passed criteria are only counted. The facts come from the pipeline's own
Verify session (`build-pipeline-criteria-report.ts`), not the ticket, so a
Linear or GitHub build reports them too; a criterion Verify reported nothing
for counts as not checked, and a session without a recorded baseline says
"commit not recorded". `get_build_pipeline` returns the same report in full as
`criteria` (every criterion with its evidence, failed first, bounded to 48 KiB)
beside `verificationResult`. A terminal build or Multi Review notice ends with
`COORDINATOR_HANDOFF_RULE` (`packages/protocol/src/coordinator.ts`) in place of
"acknowledge it and finish the turn": close the work for the user in one message
with Delivered, Criteria (on which commit), Open and Needs you, never letting
"ready for review", "all criteria verified" and "merged" stand for one another.
It rides on the wake rather than in the per-turn context block because it
applies only then, and the block's budget is held by
`coordinator-context.test.ts`. Criterion text and evidence reach the
coordinator's mail and tool results, which already carry the ticket, and never
logs or metrics.

**Kinds a reader does not know.** A data directory can be shared by backends
of two versions, and the coordinator store reader keeps an association of any
kind (it checks only `id`, `projectId` and `coordinatorId`). Every reader
skips a kind it does not know rather than failing or treating it as another
kind: status wakes do not observe it, `list_workflows` lists it with a null
`resource`, and cleanup keeps it until its resource state can be read. So a
backend older than `feature-plan` keeps and writes back those records, lists
them without a resource, and never wakes anyone for them; the newer backend
does. A new kind must not add a new receipt `action`: the receipt reader drops
an unknown one (`isActionReceipt`), and the next save loses it.

Individual reviewers finishing never wakes anyone: that is progress, and a
seven-reviewer panel would otherwise be seven turns. A relaunched fix, a second
consolidation, or a new stall or waiting episode has a new key and is sent
again. Nothing is sent for elapsed time alone (no "still running after N
hours"): every wake is an observed state change, the toolbar chip already
shows the wait, and the 20-second waiting debounce only suppresses waits too
short to matter.

A review with auto-fix and auto-PR advances on its own, so a state it is about
to leave is not reported. Consolidation with findings goes straight to Address Findings
handoff and never reaches `ready`. A finished Address Findings that queued its PR is held
until the PR launch settles, and the coordinator hears `pr-started` instead of
a `fix-done` it would be expected to act on. `pr-opened` follows once the
environment records `prUrl` with `prState: open`; the PR monitor sets them, and
the next workflow save or the 60-second sweep reports it. A retained URL whose
state is closed, merged or unknown is reported as that state, never as open.
Each PR launch records the identity of Address Findings attempt that authorized it
(`autoPrLaunch.fixIdentity`, a hash of the Address Findings session key and start time). A
later Address Findings, for example after a reviewer restart, is reported as `fix-done`,
noting that the earlier PR does not confirm it includes the new changes. A
launched record without an identity, from before this change, is treated the
same way. A failed or stopped Address Findings reports `fix-failed`
or `fix-done` with "No PR session started"; the review stops there. A
consolidation with nothing to fix and auto-PR on queues the PR straight away
(`autoPrLaunch.basis: clean-review`), is held the same way, and reports
`pr-started`, `pr-opened` or `pr-failed` headed "found nothing to fix"; a
skipped launch, such as one for an environment that already has a pull
request, reports `ready` with the reason. Without auto-PR it reports `ready`
with a line saying no Address Findings or PR started. An Address Findings run started later is not covered by
the clean report's PR. A legacy structured Address Findings holds `completed` until its PR launch settles,
then lists the PR outcome in its details.

**Pull requests.** A `pull-request` association (`resourceId` the worker,
`pullRequest` the follow) is the coordinator's claim on one worker's PR,
reduced by `pullRequestStatus` in `coordinator-pr-status.ts`. It is written by
`create_pr` when the PR tab launched (a skipped one raised nothing), by
`resolve_conflicts` (pinned to the PR it resolves), and by the review
observer once a coordinator-launched review with auto-PR has reported
`pr-opened` (seeded as already told, so it is not repeated) or `pr-unknown`,
or completed with its PR session started. From then on the review records
its own PR states silently and the follow reports them. One live follow per
coordinator, worker and node: `create_pr`, a later `resolve_conflicts` and a
review's handoff share it. A request that joins a live follow is kept as a
request alias (`requestAliases`), so the review still finds its handoff and
stays silent, and its `pr-opened` seeds the shared follow unless that follow
already reported the PR. The follow pins the first PR URL it sees; another URL on the
worker, the worker disappearing, a merge or a close ends it
(`terminalNotifiedAt`), so a reopened PR is not reported. Merge and Cleanup
writes `merged` and deletes the worker straight away, before any
observation can run, so deleting a worker first keeps its last PR reading
on its follows (`pullRequest.final`, `captureFinalPullRequest` in
`deleteEnvironment`): a follow whose worker is gone still reports a merge
or close it had not reported, once, then ends. The owning node also retains the
last 1,000 terminal PR readings in `environment-final-pr.json` before deleting
a worker. Remote follows read those tombstones through `get_environment` with
`includeFinalPrState`, recovering a merge even after missed events or restart.
A `create_pr` follow stores the publication tab identity and reports
`pr-not-created` once if its turn ends without a URL, with a transcript link
and instructions to retry. Pending dispatches and unavailable node reads
keep publication and Resolve attempts pending beyond their start grace.
Owning-node action receipts replay completed launches and slash commands
before mutable PR or busy-session checks. `list_workflows` shows a
follow with what started it, its PR URL, whether it is still followed, the
last state reported and a Resolve tab's progress, and the worker with its PR
fields.

Every key ends with a hash of the PR URL. `pr-opened` is sent once per PR;
a first reading that already conflicts, fails or is ready sends that instead,
with the URL. An open PR with nothing to act on (checks running, review
required, behind) is recorded without a wake, so the next conflict or
failure after a fix is news again, while a reading that cannot tell (GitHub
recomputing mergeability, the monitor not confirming it) changes nothing.
Because the same state recurs with the same key, each recorded state counts
an episode (`pullRequest.notices`), and a notice's mail request id includes
the episode it opens: conflicts, then a fix, then conflicts again is two
messages, while a retry of one episode (a restart, a second observer, a
crash before the bookkeeping landed) reuses its request id and replays.
Conflicts are the monitor's `hasMergeConflicts` or `dirty` mergeability.
"Failed" is the check rollup reporting a failed check: it counts every
check, so required ones are not told apart. "Ready to merge" is the
sidebar's rule (`pr-merge-readiness.ts`) with the monitor's confirmation, so
it needs this node's monitor (or a connected node's current summaries) to
vouch for the reading.

A Resolve tab is followed through its turn: seen working, then idle or gone
(or so a minute after launch, for a turn too short to see), then held until
the PR monitor's recheck lands (the Resolve completion action is disarmed,
or this node's monitor answered after the turn ended) or one more minute
passes, then reported once as `resolve-finished` with the state it left the
PR in. While it runs, the PR's own changes are not sent, and the report's
state is recorded so it is not sent again. Workers on a connected node are
followed the same way, through that node's `get_environment`, its relayed
summaries and its relayed `environment` and `environment-pr-health` changes;
an unreachable node is no news.

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
`get_build_pipeline`, `resume_build_pipeline`, `restart_build_pipeline_step`,
`get_graph_run`,
`get_tab_state`, `get_tab_transcript`, `get_environment`,
`resolve_conflicts` — written out with their arguments. In the transcript it
is a mail tile toned by the notice.

**No wake storms.**

- Dedupe: one notice per status key, recorded durably; the mail request id is
  fixed by association, conversation and key (for a followed pull request,
  key and episode), so a crash between placing a notice and recording it
  cannot send it twice.
- Coalescing: a status notice is held 10 seconds (`coalesceMs`); notices
  arriving while the window is open join it, so reviews settling together are
  one wake, and the drain batches them into one carrier (at most 10 messages,
  128 KiB). A coordinator mid-turn gets everything that settled meanwhile in
  its next wake. A held notice never starts a turn itself, but when the drain
  dispatches other mail to the same coordinator (a worker's report, say) the
  held notices ride along in that batch (`includeCoalescing`,
  `joinCoalescing`) rather than wake it again when their hold ends.
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
store's. Workflow saves, and environment and PR-health changes of a followed
worker, wake an observation within seconds; the
`coordinator-repair` maintenance job (every 60 s, and at startup) re-reads
every owned workflow, followed pull request and open delegation, which
recovers a missed save, a timer lost to a restart, or bookkeeping that never
landed.
`launch_multi_review`, `address_multi_review`,
`start_build_pipeline` and `launch_graph` return `delivery: "async"` with
`COORDINATOR_WORKFLOW_STATUS_WAKE`, so the model is told it will be woken
rather than left to poll `get_multi_review`; `create_pr` (when it launched)
and `resolve_conflicts` return `COORDINATOR_PR_STATUS_WAKE`.

### Worker outcomes

A coordinator also hears when a worker it owns is merged, closed or deleted,
whoever did it: a pipeline environment's PR the user merged, a PR the user
raised on a launched worker, Merge and Cleanup, or a plain deletion
(`apps/backend/src/core/coordinator-worker-outcomes.ts`). The notice is for
awareness. It says what happened and ends with a line that nothing is
expected of the coordinator unless it affects work it is tracking: dependent
tasks, tickets, branches built on the worker, or work it meant to send there.

**Ownership.** The earliest `environment` association (a launch or any
delegation) or `build-pipeline` association that names the worker, per
coordinator, worker and node. The watch lives on that association
(`workerOutcome`), so it adds no records; a build pipeline's worker is read
from the pipeline once and kept there. Several delegations to one worker
are one watch.

**What it reports.** One notice, then the watch ends:

- The PR merged or closed: `pr-merged` or `pr-closed` (resource
  `pull-request`). When the environment is being deleted or is gone, the
  headline says so ("was merged and its environment deleted"), so Merge and
  Cleanup is one notice, not two.
- The environment deleted with its PR still open, or with no PR: `deleted`
  (resource `environment`), naming the PR's last state.

A deletion still in progress waits until the record is gone, unless the PR
already merged or closed. A merge or close that a live PR follow of the same
coordinator will report, or already reported, ends the watch silently, so
the coordinator hears each outcome once; a follow's own merge and close
notices name the deletion and carry the same awareness line. After a merge
or close the watch is over: a later deletion is not reported.

**Old news.** The first observation of a worker records its state. A worker
already merged, closed or gone then (one from before this watch existed)
ends silently. A deletion captured as it happens always reports:
`deleteEnvironment` keeps the worker's last PR reading and name on its
watches (`captureFinalPullRequest`) just before the record is removed. A
worker on a connected node is read through that node's `get_environment`,
and a worker the node no longer has counts as deleted, with the last reading
the watch kept.

Change events for a watched worker are observed within seconds, like a
followed PR; the 60-second sweep finds everything else, writing all its
bookkeeping in one store write. *Finished work only* ends watches without a
notice.

### Watched pull requests

A coordinator also hears, for awareness only, when a pull request it has
merely *shown* changes state (`apps/backend/src/core/coordinator-pr-watches.ts`).
This covers pull requests nobody asked it to follow: one the user pasted, one
a worker mentioned, one it linked in its own reply.

**What joins the watch.** A link to a pull request of the project's own
GitHub repository rendered anywhere in the coordinator panel (its transcript
and its mail tiles), or opened from there. `MarkdownLink` reports it through
`useCoordinatorPullRequestLink` (`apps/web/src/lib/coordinator-pull-request-watch.tsx`,
under `CoordinatorPullRequestWatchProvider` in `CoordinatorPanel`), which calls
`watch_coordinator_pull_request { projectId, owner, repo, number, source }`.
A window reports a rendered link once per 15 minutes; an opened one every
time. The backend answers `watched: false` for another repository, a project
with no GitHub repository or no coordinator, an already-associated PR, and a rendered pull request that settled
in the last week. Explicit opens clear settlement memory and revalidate on the next sweep. Failed renderer reports retry up to five times with bounded backoff; only successful reports enter the dedupe cache. The store (`coordinator-watched-pull-requests`, one row per
project) keeps at most 100, the least recently seen leaving first, and goes
with the project.

**Polling.** Independently guarded polling starts beside `coordinator-repair` (every 60 s), reading at most 15 due
pull requests per pass, each at most every 2 minutes, never-read first, through
the GitHub REST client and its conditional cache
(`getGitHubPullRequestStatus`: the pull request, its head commit's checks and
its reviews; an unchanged pull request costs only 304s). It needs the Settings
GitHub credential; without one nothing is read. A rate limit ends the pass.

**What is news.** A reading is its state (open, draft, merged, closed), check
rollup (passing, failing, running, neutral/skipped, none), merge conflicts and review decision
(approved, changes requested, none). The first reading is the baseline and
sends nothing; an unknown mergeability keeps the last known conflict state.
The first known conflict state is silent. Every later change sends one notice naming what changed. A merge or close
is reported once and ends the watch; a pull request already
settled at its first reading ends silently. *Finished work only* (`off`)
records changes without notices, and with no main conversation open the change
is recorded without a notice, as for other status notices. Disabled messaging also records changes quietly.
**Deleted pull requests.** A 404 alone cannot tell a deleted pull request
from a credential that lost access, so a 404 or 410 from the status read is
confirmed (`confirmGitHubPullRequestDeleted`): with the same credential the
repository must be readable (and have issues turned on, since otherwise the
issue endpoint answers 410 for every number) and the number must answer 410 or
an issue that is not a pull request. An issue-endpoint 404 stays ambiguous even
when repository metadata is readable, because scoped credentials can hide issues.
A confirmed deletion sends one
`pr-gone` notice ("deleted from GitHub") when a baseline exists, then ends the
watch like a merge or close. An unconfirmed 404 keeps the watch and its
baseline and records `missingSince`; a successful reading clears it, and after
seven days of unbroken "not found" the watch is dropped quietly
(`pr-watch.removed`, reason `unreadable`). An explicit open watches it again.
Other read failures, including 403s, keep the watch and back off. A failed mail delivery advances the polling timestamp while retaining the comparison baseline for retry. GitHub polling never holds the coordinator repair promise.

**Message.** A workflow notice (resource `watched-pull-request`, id
`owner/repo#number`, label the title, states `pr-updated`, `pr-checks-failed`,
`pr-conflicts`, `pr-changes-requested`, `pr-merged`, `pr-closed`, `pr-gone`),
subject `PR #12 updated: <title>`, and a body that says no action is expected
unless it affects tracked work. It is budgeted per pull request
(`statusBudgetKey`) and coalesced like other status notices. The transcript
draws it as one quiet line (`PullRequestUpdateNotice`): `PR #12 updated ·
<title> · <what changed>`, the number opening the pull request in the app,
instead of a mail tile.

## Launch defaults

Coordinator-launched work runs the user's saved defaults unless the user asks
for something else. Coordinators used to copy a model and effort from
`get_launch_options` into every call, so each worker silently ran a more
expensive selection than the configured default. The rule is now stated in
three places that agree:

- `COORDINATOR_LAUNCH_DEFAULTS_RULE` (`packages/protocol/src/coordinator.ts`)
  is a single line in the coordinator context prompt and the Control MCP server
  instructions.
- The descriptions of `launch_environment`, `launch_job`, `launch_multi_review`
  and `start_build_pipeline`, and of each model, effort and agent field, say
  that omitting the field uses the saved default. `agent` is optional on
  `launch_environment` and `launch_job` too.
- `get_launch_options` returns `defaults` (`agent`, per-agent
  `byAgent[agent] = { modelId, reasoningId }`, `guidance`) and marks each
  agent's default catalogue row with `isDefault: true`.

What an omitted choice resolves to:

| Tool | Omitted | Resolves to |
| --- | --- | --- |
| `launch_environment`, `launch_job` | `agent` | The saved default agent (environment → repository → app settings; a job reads its environment's tier) when it is enabled, else the first enabled platform: `defaults.agent` from `get_launch_options` (`defaultLaunchAgent`, `control-shared-actions.ts`). A launch on another node resolves on that node |
| `launch_environment`, `launch_job` | `modelId`, `reasoningId`, `fastMode` | The platform column across environment → repository → app settings, else the agent's own default (`defaultReasoningId` for effort) |
| `launch_multi_review` | `reviewers`, `reviewModel`, `fixModel` | The Multi Review button's rows: Review, Review 2, saved extra reviewers and reviewer count, each reviewer with its position's saved focus (`multiReview.reviewerLenses`); Review preparation and Address Findings review issues, each falling back to Review |
| `launch_multi_review` | `autoFix`, `autoPr` | The saved app-level Auto-fix and Auto-PR, which the button reads; a requested `autoPr: true` turns an omitted `autoFix` on |
| `start_build_pipeline` | `agentType`, `steps`, `reviewers`, `reviewPreparation` | `buildPipelineConfiguredDefaults` (`packages/protocol/src/build-pipeline-defaults.ts`), the resolver the Build button uses |

Every one of these can be overridden. A coordinator is told to override only
when the user has asked for a specific model, agent, effort or reviewer set.
A build's delivery is not among them: `start_build_pipeline` has no override, and
the build follows the ticket's delivery policy when Verify passes
([tickets](tickets.md#delivery)). A build that ends without a pull request says
so in `get_build_pipeline` (`delivery`) and its completion notice, which also
name each criterion's result and the commit Verify judged
([status wakes](#status-wakes)).

**A build is linked to its ticket.** `start_build_pipeline`'s `taskId` must be a
ticket in the project; the build starts with
`source: { type: "kanban", taskId }`, exactly like a Build button launch, so
Verify's per-criterion results and evidence, the ticket's status, PR URL and
state, the environment link and the delivery policy's "too late" comment all
reach the ticket. A `taskId` that is not a ticket in the project is refused
with an error telling the coordinator to create it with `create_ticket` first;
the build is never started unlinked. The check and the link are made by the
backend that runs the build (`coordinatorBuildTicketSource` in
`build-pipeline-launch.ts`, called by `start_coordinator_build_pipeline` and,
for a build on a connected node, by that node's
`start_controller_build_pipeline` against its own copy of the project). The
command node also sends the source with a node build, so a node too old to
check still links it. Builds started before this rule carry no source and keep
their old behaviour.
Overrides layer the way the launchers do. For `start_build_pipeline`:

- A named step replaces only that step, and a step that names only an agent runs
  that agent's saved model.
- A step, or `reviewPreparation`, may carry `instructions` (at most 16 KiB of
  UTF-8; [per-stage instructions](build-pipeline-view.md#per-stage-instructions)).
  One that names only `instructions`, without an agent, keeps its saved
  selection: the pipeline agent for `build`, the saved row for the others, and
  the saved preparation model (Address's when the saved review has one
  reviewer) for `reviewPreparation`. Reviewer rows always name their agent and
  may carry their own `instructions` and a `lens`.
- `steps.build.agent` decides the pipeline agent.
- Explicit `reviewers` replace the saved rows; otherwise an explicit
  `steps.review` becomes Reviewer 1.
- `maxIterations` is optional, from 1 to `MAX_BUILD_PIPELINE_ITERATIONS` (10),
  the limit the protocol accepts; the tool schema refuses a larger value
  before anything starts. Omitted, the pipeline's default applies.

Each Multi Review row field is replaced independently.

A reviewer row, in `launch_multi_review` or
`start_build_pipeline`'s `reviewers`, may carry `lens: { label, instruction }`:
the reviewer's focus, a label of at most 64 characters and an instruction of at
most 4 KiB ([reviewer lenses](review-preparation.md#reviewer-lenses)). The
tools refuse a longer or blank one, and `reviewModel`, `fixModel` and
`reviewPreparation` take none. Explicit rows replace the saved rows and their
saved focus. The coordinator is told to set a lens only when the user asks for
a focus.

Multi Review rows resolve in `apps/backend/src/core/coordinator-launch-defaults.ts`
over the worker's model catalogue through `resolveLaunchSelection`
(`packages/protocol/src/launch-selection.ts`), the resolver the launch dialogs
call too, which documents the rules: an unset or
stale saved model falls back to the connected model a tab with no model would
start on (the catalogue row marked `sessionDefault`, which the Pi bridge sets
on Pi's saved default), else to the first connected catalogue model, and an
effort or speed is kept only when the chosen model offers it. A Pi catalogue
that marks no connected row (a cache written before the mark existed, or a
login with no saved default) leaves the row `default`, so the session picks. When a platform has no catalogue,
the saved model id is kept. The request hash covers the caller's payload, not
the resolved rows, so retrying with the same `requestId` after the user edits
their defaults replays the original work.

Every launch reports what will run. `launch_environment` and `launch_job` return
`selection: { agent, model, reasoning, source }`, where `source` is `requested`
if the call set `modelId` or `reasoningId` and `default` otherwise. `model` is
null when no tier pins one and the agent picks its own. The Multi Review result
reports its rows the same way, plus `autoFix` and `autoPr` with a source of
`default`, `requested` or `implied` (auto-fix turned on by a requested auto-PR).
`start_build_pipeline` reports the pipeline's
`agentType`, `steps`, `reviewers` and `reviewPreparation`, with a per-step and
per-field `source`; a step's stored instructions are reported as
`instructionsBytes`, not echoed. A reviewer's lens is reported in every
`selection` as `{ label, instructionBytes }`.

A local worker's tab marks an override ("requested"). It reads
`delegation.request.source` by one rule
(`coordinatorTabLaunchRequest`, `@orkestrator/protocol/coordinator-launch-overrides`):
the newest of that tab's requests that states a source. Only a launch states one,
so mail sent to the worker afterwards does not clear the marker, and a tab the
coordinator only messaged has none. There is no field on the environment record.

The tab reads `list_coordinator_launch_overrides`, which answers from the
coordinator store alone, across every project, with only the overridden tabs. The
renderer holds one projection of it
(`apps/web/src/stores/coordinatorLaunchOverrideStore.ts`): the first agent tab
mounted reads, every other tab shares the answer, and it re-reads on a coordinator
store change and on the transport's resync and safety checks. A tab with no
delegation is absent from the answer, so it shows nothing and adds no read of its
own, and a tab that cannot be a worker (a terminal, a file) never asks. Against a
backend without the command nothing is shown. A delegation that retention has
removed takes its marker with it.

A worker on another node has no marker on its tab. Its delegation is kept on the
command node, while its tab renders in that node's workspace, on its node scope,
and reads that node's backend, which holds no such record. The gap is
[6580](../todo/coordinator-and-multi-review/6580-launch-override-marker-on-another-node.md).

## Complete application actions

Use `launch_multi_review` for an environment's **Multi Review** button. Pass a
stable `requestId` and the environment ID. Omitted `reviewers`, `reviewModel`
and `fixModel` use the saved Multi Review defaults exactly as the button does
(see [Launch defaults](#launch-defaults)); explicit rows (`agent`, `model`,
optional `reasoningEffort`) replace them one field at a time. Omitted
`targetBranch` and `reviewInstruction` use the repository's PR base branch
(falling back to `main`) and the global review instruction. An empty
instruction explicitly clears the instruction for this launch. The result's
`selection` lists the rows and auto-actions the saved review runs and, per
field, whether they were `requested`, `default` or `implied`. A reused active
review keeps its own rows and auto-actions.

Optional `autoFix` and `autoPr` match the launch dialog's **Auto-fix after
consolidation** and **Auto-PR after fix or clean review** checkboxes, which open on the saved
app-level settings. Omitted, they use those settings. With both on, the review
runs end to end through the button's own code path in `MultiReviewService`:

1. Consolidation with findings saves the report and the default Address Findings handoff in
   one save (`queueDefaultFix`). The supervisor delivers it like
   `address_multi_review`.
2. When the interactive Address Findings turn finishes on its own as the conversation's last
   turn, the same save that settles it records `autoPrLaunch: pending`
   (`queueAutoPr`).
3. The supervisor launches the ordinary `PR` tab: the Create PR prompt and the
   `pr` action default, under the stable request id `multi-review-pr:<id>`.

Consolidation with nothing to fix skips Address Findings: with `autoPr` on, the save
that settles it at `ready` records `autoPrLaunch: { basis: "clean-review",
state: "pending" }` (`queueCleanReviewAutoPr`) and step 3 follows, whatever
`autoFix` says.

The PR intent is only ever recorded with proof that an Address Findings run completed or that
there was nothing to fix, so the PR cannot come before an Address Findings run. A failed, stopped, superseded or unconfirmed Address Findings records
`skipped` with a reason or nothing at all, and no PR starts. A custom Address Findings never
starts a PR. An Address Findings run handoff that cannot be delivered fails the review after its
bounded retries. The PR launch retries three times before `failed`. Each step
is durable, so a restart resumes at the step it reached. Nothing in this flow
merges.

`autoPr: true` with `autoFix` omitted also turns auto-fix on, because a
coordinator asking for an automatic PR wants the whole flow. An explicit
`autoFix: false` with `autoPr: true` keeps the button's meaning: the PR follows a
Address Findings started with `address_multi_review`. `get_multi_review` reports
`automation: { autoFix, autoPr, prLaunch?, next }`, where `next` says in one
sentence what runs next and whether the coordinator has to act.

This action has no build-pipeline prerequisite. It reopens an active review
regardless of the new selections, or reserves an immutable workflow ID and
starts one review. It then creates or focuses the root Multi Review tab in the
environment's selected pane. It does not change the global project/environment
navigation: an inactive environment receives the durable tab and selection,
which its renderer adopts when the user returns.

`open_multi_review` reopens/focuses that root without starting work.
`open_multi_review_fix` opens/focuses the authoritative Address Findings provider session
without sending a turn. `address_multi_review` now opens the root first and
records the backend's idempotent fix handoff; the supervisor publishes and
selects Address Findings after confirmed dispatch when the foreground action initiated that
attempt. A background retry or backend-restart resume publishes Address Findings without
changing the current tab or pane. A repeated address call returns the existing
interactive handoff. An unassociated workflow started from the renderer remains
available to open within its project, but addressing it starts an agent in its
environment, so it takes the
[origin check](#which-environments-a-coordinator-may-act-on). When an association
exists, these controls require it to belong to the current coordinator
conversation; use `adopt_workflow` for an orphaned or closed conversation's
association before opening it. A side agent cannot adopt: the
`adopt_coordinator_workflow` command refuses it, since every worker reports to the
main. The backend's own takeover (`force`) calls the store directly and is unaffected.

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
| `start_multi_review` / Multi Review | Backend-only and build-gated. No longer offered to coordinators (`RETIRED_COORDINATOR_TOOLS`); `launch_multi_review` adds root-tab publication, focus, readiness checks, reattachment, and truthful recovery. Operator credentials keep their own `start_multi_review` over `review.launch`. |
| Multi Review open / Open Address Findings session | Added `open_multi_review` and `open_multi_review_fix`; operate entirely through backend snapshots and pane persistence. No additional provider turn. |
| `address_multi_review` / Address findings | Upgraded to the complete action above. Existing backend handoff already owns session adoption, turn idempotency, and eventual Address Findings publication; it now selects that tab when published and reports queued/partial outcomes. |
| `start_build_pipeline` / Build | Already complete: `BuildPipelineService` owns environment provisioning, workflow persistence, Kanban/feature ownership, root-tab creation and selection, with supervisor repair. Reuse it; no duplicate wrapper added. |
| `pause_build_pipeline`, `resume_build_pipeline`, `cancel_build_pipeline`, `cancel_multi_review` | Backend transitions already durable; these buttons have no required new pane or tab consequence. Resume refuses a pipeline that is not paused. |
| Step Restart / Restart in… | Added `restart_build_pipeline_step`; see [Restarting a failed pipeline step](#restarting-a-failed-pipeline-step). Rewind code and Skip stay user actions. |
| `launch_environment` / New environment | Existing backend operation owns creation, startup tab/initial-prompt state, and background start. Its accepted/created/error distinction already reports partial startup. |
| `launch_job` / Agent action | Already creates a durable native tab, binds a provider session, and dispatches an idempotent initial turn. Now requests tab activation, matching the button. Later binding/retry writes preserve focus so slow launch completion cannot steal a user's newer selection. |
| `send_prompt_to_tab` | Existing durable intent dispatcher; targets an existing native tab and creates no additional tab. |
| `/goal` (composer) | Added `set_worker_goal`, `get_worker_goal`, `pause_worker_goal`, `clear_worker_goal`; see [Worker goals](#worker-goals). The goal service owns the loop and its limits, and the tools add ownership, a required limit, and one wake. |
| `/subork` (composer) | Added `ask_agents`, the same tool every native tab has, on the `discovery` capability so side agents have it too. Its suborks are read-only and run in the project home (the conversation's own checkout); the answers come back as one mail to the conversation. See [suborks.md](suborks.md). |
| Start/stop environment, ticket edits, adoption, mail | Existing backend mutations; no renderer-only workflow launch step. Mail preserves separate stored/injected/acknowledged outcomes. |

Repository checkout mutation controls remain unavailable to coordinators.
The worker surfaces below were added with their own authority and
idempotency design.

### Worker surfaces

The main coordinator can also drive a worker's own surfaces, as the user
would in that worker's window. Every one targets a disposable worker
environment of the bound project: the backend command
(`coordinator-surface-actions.ts`) revalidates the credential's scope and
refuses the project home, the checkout the coordinator may only read. Side
agents have none of them (their capabilities are `discovery`, `mail` and
`schedules`), except `get_worker_changes`, which only reads and is
`discovery`: a side agent asked to review or discuss a worker's work can read
that work. It does not widen the checkout boundary; the checkout itself is
read directly, and `get_worker_changes` refuses the project home.

`launch_terminal`, `open_worker_browser`, `edit_worker_tab`, `create_pr`,
`resolve_conflicts`, `get_worker_changes`, `fork_worker`, `stop_worker_turn`,
`list_worker_commands`, `run_worker_command`, `custom_fix_multi_review` and
`open_multi_review` (with or without `reviewerId`) also take `nodeId` for a
worker on a connected node. The
receipt, any adoption of the review, and a PR follow stay on the command node; the node
that owns the worker checks its project and refuses its checkout, then runs
the work through a controller command (`launch_controller_terminal`,
`open_controller_browser`, `edit_controller_worker_tab`, `create_controller_pr`,
`resolve_controller_conflicts`, `get_controller_worker_changes`,
`fork_controller_environment`, or the `reviewer` and `custom-fix` surfaces of `controller_multi_review_surface`
in `commands-registry-controller-workflows.ts`; `stop_controller_worker_turn`,
`list_controller_worker_commands` and `run_controller_worker_command` in
`coordinator-worker-turn-actions.ts`). Those are node-link only,
never reachable with a workspace grant. Job, tab and navigation IDs on that
node derive from the command node's receipt key. So when the node link loses
an answer, the tool returns outcome-unknown and asks for a retry with the same
`requestId`, and the retry reattaches to what the first attempt made; nothing
is resent automatically. A remote custom fix that is already past its handoff
when the retry arrives is reported, with its Address Findings tab, rather than refused as
not ready. A node from before these commands answers "update that node".
`request_root_changes` stays on this node; see
[0395-coordinator-worker-surfaces-follow-ups.md](../todo/coordinator-and-multi-review/0395-coordinator-worker-surfaces-follow-ups.md).
`answer_worker_question` also takes `nodeId`; its request stays on the command
node and only the approved answer crosses the link
(`answer_controller_worker_question`).

| Tool | What it does | Retry with the same `requestId` | What the user sees and can undo |
| --- | --- | --- | --- |
| `launch_terminal` | A terminal tab in the worker running one command (`plain`), an agent CLI with an optional prompt (`claude`, `codex`, `grok`, `opencode`, `pi`), or Claude under tmux (`claude-tmux`), through `launch_terminal_job`. | Replays the receipt; the job and tab IDs derive from the request, so a retry after a crash reattaches to the same PTY. | The tab opens selected, like one the user opened; closing it ends the PTY. |
| `open_worker_browser` | A browser tab at a loopback `http(s)` address of a service the worker runs, or navigates an existing browser tab. The address is stored as an `agent-link` preview intent, so it resolves to the worker's own service, local or container. | Replays; the new tab's ID and the write's `navigationRequestId` derive from the request. | A browser tab; the address bar and back button work as usual. The open web is refused: the coordinator's research tools are the policy-gated way out. |
| `edit_worker_tab` | Focus, move (to a pane from `list_tabs`) or close one tab. | No receipt: each edit states the end state, so a retry is a no-op. Closing a tab that is gone succeeds. | Closing never deletes a conversation (`teardown_tab`'s retain-history close). It is refused while a native agent tab's turn is running or waiting on a person, and while a coordinator waits on that tab's report. A terminal tab closes with whatever its process is doing. |
| `stop_worker_turn` | The tab's **Stop** button: stops the running turn of one native agent tab, never the environment (that is `stop_environment`). Runs `session.stop`'s own stop (`stopSessionTurn` in `public-api/session-turn-stop.ts`), so the tab's active public run settles as cancelled. An idle tab answers `stopped: false`, not an error; terminal and tmux tabs are refused. | Replays the receipt, so a retry never stops a later turn. A lost answer from a node is outcome-unknown and says to check `get_tab_state` first: a retry with the same `requestId` stops whatever turn is running then. | The turn ends as if the user pressed Stop; the tab and its conversation stay. A delegation on that tab still wakes the coordinator once (below). |
| `list_worker_commands` | The tab's `/` menu: `session.commands` for one native tab, without commands that act on a running turn (`/steer`). `refresh` re-reads the agent's list. | A read. | Nothing. |
| `run_worker_command` | Picks one row of that menu: `session.command`'s resolution and every refusal it has (missing, ambiguous, unavailable, changed since listed, wrong arguments, busy tab, parked dispatch), dispatched as a selection, never as prompt text. `/steer` is refused. A command that starts a provider turn opens a delegation, as `send_prompt_to_tab` does, and is refused while one is open on that tab; one that answers without a turn (`bridge-local`, an Orkestrator session action such as `/compact`) opens none and says to read its output with `get_tab_transcript`. | Replays the receipt; the dispatch request ID derives from it, so a retry after a lost answer replays on the node that owns the worker. | The command runs in the tab as if the user picked it. |
| `open_multi_review` with `reviewerId` | Opens one reviewer's read-only transcript subtab (`multi-review:<id>:reviewer:<reviewer>`). | Focuses the same tab. | Same tab the reviewer node opens in the review. A reviewer without a session yet returns `partial` with the reason. |
| `custom_fix_multi_review` | The review tab's **Custom fix prompt**: a fix with the caller's instruction and, optionally, another model (`MultiReviewService.customFix`). | Replays the outcome and re-reads the workflow; while the handoff is pending the service itself also replays. | The Address Findings tab, as for `address_multi_review`; a custom fix never starts an automatic PR. Status wakes follow as for a default fix. |
| `create_pr` | The **Create PR** button: the worker's `PR` tab, with the Create PR prompt and the `pr` action default, against `targetBranch` or the repository's PR base branch (`launchPrAgent` in `multi-review-auto-pr.ts`, shared with auto-PR). Pass `nodeId` for a remote worker, using that node's repository and agent defaults. Refused while the worker's pipeline still owns publication; skipped when the worker already has a PR. | Replays; the native-agent job's request ID derives from the request, so a retry joins the same PR agent. | The `PR` tab, opened without taking focus. A launched PR is followed: status wakes when it opens, conflicts, fails a check, is ready to merge, merges or closes ([Status wakes](#status-wakes)). |
| `resolve_conflicts` | The **Resolve Conflicts** button: the worker's `Resolve` tab, with the Resolve Conflicts prompt, the `resolve` action default and the button's completion action (the PR monitor rechecks the PR when the agent finishes), against `targetBranch`, else the PR's own base branch, else the repository's PR base branch, else `main`, as `pr.resolve` does (`launchWorkerResolve` in `coordinator-pr.ts`, `launchResolveConflictsAgent` in `multi-review-auto-pr.ts`). The button's precondition applies: refused when the worker has no PR, when it is merged or closed, or when GitHub reports no conflicts (an unknown mergeability is allowed), and while the worker's pipeline owns it. Pass `nodeId` for a remote worker. | Replays; the native-agent job's request ID derives from the request, so a retry joins the same Resolve agent. | The `Resolve` tab, opened without taking focus. One status wake when it finishes, with the refreshed PR state; the PR stays followed. |
| `launch_feature_plan`, `get_feature_plan` | **New feature** and **Send** on the Features board: a planning agent in its own environment turns the message into a summary and stories. Building from a plan stays the user's Build button. | Replays; a retry after a crash finds the plan that attempt created. | The plan on the Features board. A `feature-plan` association, written before planning starts: status wakes when the reply is ready and when planning fails ([Status wakes](#status-wakes)); `list_workflows` lists it. |
| `request_root_changes` | Asks the user to apply some of the checkout's uncommitted changes to a worker (below). | Replays the same approval request. | An approval dialog listing the checkout's changed files. |
| `get_worker_changes` | Reads what a worker changed, local or container, without fetching its branch (below). Read-only, capability `discovery`. | No receipt: a read. | Nothing; it changes nothing. |
| `fork_worker` | The sidebar's **Fork** for a worker: a new worker on its own branch from the worker's last commit, with an optional prompt for its agent (below). Main coordinator only (`environments`). | Replays the receipt; the fork's record carries a control request ID derived from the request, so a retry after a crash finds the same fork, and its association and delegation are idempotent. | A new environment in the sidebar, started in the background. Deleting it is the user's. |
| `answer_worker_question` | Proposes an answer to a question a worker is waiting on, for the user to confirm (below). Takes `nodeId` for a worker on a connected node. | Replays the same approval request. | An approval dialog with the worker, its tab, the question, its options and the proposed answer, which the user may change. Declining leaves the question waiting in the worker's tab. |

**Worker slash commands.** `list_worker_commands` and `run_worker_command`
share `session.commands` and `session.command`'s code (`listSessionCommands`
and `resolveSessionCommand` in `public-api/actions-session-commands.ts`), so a
command a coordinator runs is checked, journaled and refused exactly as one
the CLI runs ([native-agent-commands.md](native-agent-commands.md)). Two
choices are the coordinator's own:

- **No live-turn commands.** `/steer` (and any row whose `busy` is
  `running`) is neither listed nor run. Options: expose it as a command; refuse
  it and point at `send_message` with `deliverNow`. Chosen: refuse. The mail
  path already steers a running turn and carries what a raw steer would skip:
  mutes, inject policy, budgets, joining the open delegation and the steer
  journal's single-attempt verification.
- **Which commands are delegations.** Options: every command; none; by
  execution kind. Chosen: by execution kind. `bridge-local` commands (Codex
  `/help`, `/models`) and Orkestrator session actions (`/compact`) answer
  without a provider turn, so a delegation would only wake the coordinator
  with a "finished without a report" notice for nothing; every other kind
  starts a turn and opens one, refused like `send_prompt_to_tab` while one is
  already open on that tab. Con: a provider command that happens to answer
  locally (some Claude built-ins) still opens one and wakes once.

Receipts live in the coordinator store (`actionReceipts`, bounded at 2,000,
oldest completed dropped first). A receipt is admitted before the action has
any effect and bound to a hash of the caller's payload; reusing a
`requestId` with a different payload is refused. Concurrent identical calls
in one backend share one run. A failed run drops its pending receipt so the
same request can be retried; a pending receipt whose backend process died is
reclaimed by the next retry, which reattaches as the table says.

**Reading a worker's changes.** `get_worker_changes` answers from backend
change tracking, through the same `changes_*` commands the Changes panel and
the public `changes.view` read (`coordinator-worker-changes.ts`), so it works
for container workers the coordinator cannot fetch from. It returns the
worker's branch and base (`createdFromCommit`, or the user's chosen diff base),
the commits since the base (a bounded log of `<base>..HEAD` through the
checkout's Git runner the base picker uses, local or `docker exec`),
`sinceBase` (the `environment-net` measurement: base to working tree,
committed and uncommitted together, each file with status and line counts and
`uncommitted: true` when it also has uncommitted changes, `committed: true`
when its commits changed it), `committed` (the `committed-net` measurement,
base to `HEAD`), `uncommitted` (the `uncommitted-net` measurement, `HEAD` to
working tree with untracked files), and `diffs`: backend-rendered hunks of the
listed `sinceBase` files as unified text (`changes_resolve_live_detail` and
`changes_get_diff`, the Diff tab's path). `diffScope` picks other diffs over
the same path: `committed` (`committedDiffs`, base to `HEAD`), `uncommitted`
(`uncommittedDiffs`, `HEAD` to working tree) or `split` (both, halving the
byte budget), so a file changed both ways shows which lines are committed. Every part is bounded: 100 files by default (at most 500), 5,000 rows
scanned per measurement, 50 commits (at most 200), diffs of 20 files (at most
50), 16 KiB per file and 64 KiB in total (at most 256 KiB). A cut part says
`truncated`, and the result names the arguments that page or narrow it:
`offset` (`sinceBase.nextOffset`), `paths` (files or directories) and `file`,
which renders one file's whole diff up to the total budget. A stopped
container worker answers what change tracking last measured, with its commits
unavailable and each diff `null` with the reason; a measurement still being taken says `pending`. Without `diffScope`
the diff is base to working tree, as before, so older callers are unchanged; an
older node that ignores `diffScope` answers with that diff and the result says
`diffScopeUnsupported`. With `nodeId` the node owning the worker reads it
(`get_controller_worker_changes`) and applies its own bounds.

**Forking a worker.** `fork_worker` runs what the sidebar's Fork runs
(`forkEnvironmentRecord` in `commands-environment-fork.ts`): the worker's
committed `HEAD` becomes the fork's base on a new branch, with its agent
settings, network mode, allowed domains and ports. Its uncommitted changes and
its conversation are not copied, so the description tells the coordinator to
have the worker commit first. A container fork needs the commit on a remote,
as for the sidebar. The fork becomes a coordinator worker exactly as a
`launch_environment` worker does: a durable `environment` association with
its base branch and commit (`requestId` `fork:<requestId>`) and, with a
prompt, the delegated startup prompt (`pendingAgentLaunch`, see
[Worker delegation](#worker-delegation)) and one delegation on the
`startup-agent` tab, opened only once the start succeeded. Without a prompt
the fork starts with no agent turn and no delegation. Omitted, the agent is
the fork's own startup agent (the worker's, from its copied settings) and the
model and effort resolve as for `launch_environment`; the result reports
`selection` the same way. The fork does not keep the worker's
`buildPipelineId`: deleting an environment deletes its linked pipeline and the
supervisor finds a pipeline's environment by that ID, so a fork that kept it
would appear to own the pipeline. `create_pr` therefore treats a fork as an
ordinary worker. (The sidebar's Fork still keeps the link.) With `nodeId` the
receipt, association and delegation stay on the command node, and the node
owning the worker forks it (`fork_controller_environment`) under a control
request ID derived from the receipt.

**Uncommitted changes in a worker.** Workers start from a commit, so work the
user has not committed never reaches one on its own. When the user wants it
to, `request_root_changes` creates an `apply-root-changes` node action
request (the same approval flow as `request_project_on_node`). The user sees
the checkout's changed files (`list_project_root_changes`: `git status`
without optional locks), with the files the coordinator suggested ticked,
and picks the files. Only the approval runs `apply_project_root_changes`,
which the coordinator's command invoker refuses by name. It builds a binary
patch from `HEAD` to the working tree for exactly those files, against a
scratch copy of the index and a scratch object store in front of the real
one, so the checkout's index, objects, refs and files are untouched. It then
runs `git apply --check` and `git apply` in the worker (a local worktree, or
`docker exec` in a running container): the patch applies whole or not at
all. Paths the checkout no longer reports as changed are refused. The
outcome is mailed to the conversation as a system notice, which wakes it.
The coordinator never sees the patch.

**Answering a worker's question.** A delegated worker waiting on a question
needs a person, and the coordinator cannot answer for them, but it can save
the user a trip to the worker's window. It reads the question in
`get_tab_state` (`state.interactions`: id, kind, questions and options) and
calls `answer_worker_question` with the interaction id, the answer in the
question's own shape (each `questionId` with its `optionIds` and/or
`freeText`) and a short reason. The backend command
(`request_coordinator_worker_answer` in `worker-question-relay.ts`) reads the
pending interaction from the tab, on this node or through the node link,
and refuses anything that is not a `question`: command, file, plan and tool
approvals, MCP forms and links, terminal selections and any question asking
for a secret stay in the worker's tab. It checks the proposal against the
question and creates an `answer-worker-question` node action request holding
a bounded copy of the question, its revision and the proposed answer; it
answers nothing. The user sees the worker, its tab, the question, its
options with the proposal preselected and the reason, may change the answer,
and approves or declines. Only the approval runs
`answer_project_worker_question` (or, for a worker on another node,
`answer_controller_worker_question` over the node link), which the
coordinator's command invoker refuses by name, as it does
`resolve_native_agent_interaction`. It re-reads the worker's pending
interactions where the worker lives and answers only the revision the
request named, through `resolve_native_agent_interaction`, the command the
worker's tab uses, with the answer as the user approved it. A question
answered in the tab meanwhile, replaced, expired, or gone because the turn
ended or the tab closed settles the request `stale` and nothing is sent.
Malformed answers fail without reaching the worker; an approval that times
out (24 hours) expires; a node that disconnects fails the request, and an
answer lost on the node link settles it outcome-unknown, never resent. A
schedule's tool action for `answer_worker_question` runs the same tool, so it
too only creates a request. Answered, stale, declined and failed requests
each mail the conversation a system notice, which wakes it; the notice,
receipt and logs name the worker and tab only, never the question or the
answer.

### Worker goals

A coordinator can give a worker tab a goal, and is woken once when it stops
(`plans/goals/403`). The tools sit on the same service as `/goal` and
`session goal`, so its rules apply: one goal per session, an iteration cap, and no change to the permission mode.
Coordinator tools cannot configure shell checks; a person configures checks
through the composer or public API. A coordinator goal ends as an unverified claim.

| Tool | What it does | Retry | Capability |
| --- | --- | --- | --- |
| `set_worker_goal` | Sets the goal from structured fields. `maxIterations` is **required**, bounded by `NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit`, with no default; `tokenBudget` is optional. Shell checks are refused; a done report ends as `claimed`. | Same `requestId` replays the receipt. The goal's ID derives from the request, so a retry after a lost receipt finds the goal instead of starting another. | `jobs` |
| `get_worker_goal` | Status, reason, what the status means, iterations and limit, the last check's result, and recent ended goals. | Read | `environments` |
| `pause_worker_goal` | Stops the loop. A turn already running finishes. | States an end: a goal that already stopped answers `alreadyStopped`. | `jobs` |
| `clear_worker_goal` | Removes the goal in any status. It stays in the goal history. | States an end: no goal answers `cleared: false`. | `jobs` |

**Ownership.** Every tool refuses a tab this coordinator did not launch or prompt.
The durable delegation record says so, the same ownership status wakes use, and
it outlasts the delegation that made it. A tab a person opened in the same worker
stays theirs until the coordinator delegates to it, under the existing rules. The
backend commands (`coordinator-goal-actions.ts`) revalidate the scope and refuse
the project home, and side agents have no goal tools.

**No resume.** Resuming can raise a limit, which is widening what a goal may spend.
A coordinator sets a new goal, or leaves a stopped goal for a person to resume.

**One wake.** `set_worker_goal` opens a delegation after the goal is set, or joins
one already open on the tab; `wakeOwed` in its result says which was arranged, and
the result says so plainly when none could be. While the goal runs, a turn-end edge
settles nothing (`goals.holdsTurnEnd`), and neither does the delegation sweep,
which otherwise reads an idle tab as a finished worker: the tab really is idle
between iterations and during a check (`workerGoal`, read from the session record so
it holds across a restart). When the goal ends or pauses, `onGoalReleasedTurnEnd`
settles the delegation once. A worker's own mail is that wake as usual. Otherwise
the notice names the outcome (`Its goal is limited (iteration-cap) after 3 of 3
iterations`) and `get_worker_goal`. A coordinator's own pause or clear of a running
goal ends the wait too, so that wake arrives at once.

**Status reads.** `get_worker_goal` and `get_tab_state` report the goal through
`goalForModel`, and `list_agents` adds its status and counts, so an `idle` tab whose
`goal.running` is true reads as between iterations. A model reads what a worker or
its check wrote only inside an `<orkestrator-goal-evidence>` frame the text cannot
close: the agent's report, the status detail, a verifier's summary and the check's
output. The result says it is evidence and not instructions. Fields are named one by
one, so a field added to the goal stays out until someone judges it.

**Qualification does not change.** These tools change no platform's tier, boundary
or delegation, so `coordinator-providers.ts` has nothing to add: any platform that
can delegate can call them. Whether a *worker* can hold a goal is its own
`actions.goal` capability, which a refusal reports.

**Not covered: workers on another node.** The tools take no `nodeId`. A remote
delegation settles from its node's turn state, which does not know about goals, so
the coordinator would be woken between iterations. A person's `/goal` on a remote
worker the coordinator delegated to has that problem today.

A live run is the `goal` scenario of `mise run test:agent:coordinator`, described in
[`agent-testing.md`](../development/agent-testing.md#live-coordinator-suite). Whether
it has passed is recorded in `plans/goals/403`.

## Saved graphs

The main coordinator runs saved graph templates
([graphs.md](graphs.md#launching)); it never authors them (D6). Four tools
(`control-mcp-graph-tools.ts`, over the commands in
`coordinator-graph-actions.ts`) need the `graphs` capability, which only the
main role holds (`COORDINATOR_TOOL_CAPABILITY` in `control-mcp-tools.ts`).
They are in `COORDINATOR_CONTROL_TOOL_NAMES`, the allowlist Pi's read-only
gate and OpenCode's coordinator permission rules (`orkestrator_<tool>`, by
name) admit, like every other Control MCP tool. They change nothing in
[provider qualification](#provider-qualification): they are backend actions
under the scoped credential, never a write to the checkout.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_graph_templates` | optional `ref` (`{scope: "builtin" \| "user", id}` or `{scope: "project", path}`), optional `environmentId` | Without `ref`: `{templates, total}`, at most 200, each with its `ref`, name, scope, revision, `trust`, `engine`, `launchable` and compile counts and cost. With `ref`: `{template}`, its launch options: roles (panel, `maxPanel`, `floor`, steps, each provider's `tier`, `available` and `unavailableReason`, the default binding), parameters, inputs, environment default, cost, `launchable` and `blockedReason`. `environmentId` judges the launch on that existing environment |
| `launch_graph` | `requestId`, `template` (a `ref`), `environment` (`{kind: "new", create: "worktree" \| "container"}` or `{kind: "existing", environmentId}`), optional `roles` (role key → one `{platform, model?, reasoningEffort?, fastMode?, lens?}` or a panel list of up to 32), `params`, `inputs` (value inputs only), `ticket: {taskId, input?}` | `{runId, launch, delivery: "async", wake, nextStep}` |
| `get_graph_run` | `runId` | `{run, waitingFor, failed, terminal}`: the run summary, plus up to 16 steps waiting for a person and 16 failed steps (`activationKey`, `nodeId`, a failed step's error cut to 400 characters) |
| `cancel_graph_run` | `runId` | The same view with `cancelled`; a run that already ended or is cancelling answers `cancelled: false`. Steps stop; the record and artifacts are kept |

Every result is content-free: ids, states, counts and template metadata,
never prompts, input values or artifact payloads. Runs and environments of
another project, and the project home, are refused. A refusal's error text
starts with its stable code (`GRAPH_LAUNCH_ERROR_CODES` in
`packages/protocol/src/graphs/launch.ts`, such as `untrusted:` or
`engine-template:`), else `graph-error:`.

**No authoring.** No tool creates, saves, edits, duplicates, imports,
deletes, trusts or describes a template. "Describe a graph"
(`graph_describe_*`) are app commands only: neither a coordinator
credential, the operator profile nor a public action reaches them
(`graph-describe-coordinator.test.ts`, `control-mcp-graph-tools.test.ts`).

**Launching.** `launch_graph` goes through the same `GraphRunLaunchService`
as the app and the CLI, recorded as `requestedBy: "coordinator"`. Omitted
roles and parameters use the defaults saved for the template in the project,
then the Settings defaults. It admits before it acts: the launch's own
idempotency key is `coordinator:<coordinatorId>:<requestId>`, the run id is
derived from that key (`graphLaunchRunId`), and a `graph-run` workflow
association holding that run id, the `requestId` and the payload hash is
reserved before the launch service is called. A retry with the same
`requestId` returns the same run (`repeated: true`), answers `conflict` while
the first attempt is still in flight, and is refused when the payload
differs. A launch the service refused outright (a launch code and no run)
releases the reservation, so the same `requestId` can carry a corrected
request. The association is what gives the conversation its
[status wakes](#status-wakes): one per wait for a person and one when the
run ends. To launch later, schedule the tool itself (`create_schedule` with
`action: {type: "tool", tool: "launch_graph", arguments}`); the operator-only
`graph` schedule action is refused for a coordinator.

## Saving decisions to AGENTS.md

Users settle durable decisions in coordinator conversations: how workers
behave, safety rules, conventions ("never touch ports 34121/34122", "commit
flaky-test records in the same change"). The main coordinator can save them to
a dedicated `## Orkestrator` section of the project's root `AGENTS.md`, which
every agent reads, through a pull request, without a worker environment.

**When it offers.** The main coordinator's per-turn context
(`COORDINATOR_AGENTS_MD_RULE` in
`packages/protocol/src/agents-md-orkestrator.ts`) tells it to notice durable decisions the user settles,
repeated steering of the same regular behaviour (corrections or instructions),
and an explicit standing preference meant to outlast the current task. For
example, correcting it twice to group related work, repeatedly forbidding
environments on a given machine, or saying "from now on, answer status questions
without a plan" qualifies. Asking to group just today's three tasks, choosing
a machine for one run, or giving a one-off status request does not.

At a natural pause, outside urgent work, it asks once, briefly, whether to save the
guidance, naming the pattern it noticed and quoting the exact proposed entries,
one plain line each within the tool's limits. It asks at most one such question
per turn and batches several suggestions into one question and one call. It
calls the tool only after the user agrees, using any wording the user changed;
the coordinator writes nothing itself. It skips one-off task details and does
not re-suggest entries already in the section, left unanswered or declined in the same
conversation unless the user raises them. The decline mail repeats the rule
against re-asking after a decline. Side agents are not told and cannot call the
tool.

**The tool.** `propose_agents_md_update` (main only: capability
`environments`) takes a `requestId`, a `reason`, an optional `nodeId` for the
project's copy on another node, and 1 to 20 `changes`, each
`{action: "add" | "replace" | "remove", text, replaces?}` (`replaces` names the
existing entry for a `replace`). Each entry is one plain line of at most 500
characters. It cannot start another Markdown block (a heading, quote, list,
fence, table, HTML or thematic break) or contain a line break, an HTML comment,
a control character or a bidirectional override, so it cannot escape the
section; there is no path parameter and unknown fields are refused. Two
changes may not touch the same entry. The tool creates an `update-agents-md`
node action request and returns at once (`delivery: "async"`); it writes
nothing. A retry with the same `requestId` returns the same request with its
current `state` and, once opened, `prUrl`.

**The review.** The request opens `AgentsMdApprovalDialog` in every window of
the command node. It reads the section from the freshly fetched base branch on
the node owning the project copy (`preview_agents_md_update` →
`read_project_agents_md_section`) and shows the change as a line diff,
computed by the same merge the backend runs. The user can edit each entry's
text or drop it, and approves or declines. Approval stays disabled until the
preview has loaded and the merge succeeded; a failed read offers a retry and
still permits declining. A replacement whose original is no longer in the section shows as a conflict and blocks approval until it is
dropped; a proposal the section already satisfies says no pull request is
needed. Nothing happens without approval; the outcome is mailed to the
coordinator, which wakes it.

**The pull request** (`apps/backend/src/core/agents-md-pr.ts`, run by
`open_project_agents_md_pr` on the owning node, which coordinator credentials
are refused by name):

1. `gh auth status` first; a missing or signed-out `gh` fails with what to run
   (`gh auth login` on that machine, or a token under Settings).
2. A pull request for the request's branch (`orkestrator/agents-md-<key>`, the
   key derived from the request) is returned if it is open. A closed or merged
   pull request produces a clear status and URL instead of an open-PR success.
3. `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>`, the
   base being the repository's PR base branch, else its default branch.
4. The entries are re-applied to `AGENTS.md` at the fetched `origin/<base>`.
   Additions already present and removals already gone are no-ops; a
   replacement whose original is gone is a conflict and nothing is pushed.
5. If an earlier attempt already pushed the branch, it must change only
   `AGENTS.md` and its file must match that fresh merge byte for byte. A
   mismatch is a conflict; recovery never force-pushes. Otherwise, with
   nothing left to change, there is no pull request.
6. A temporary worktree inside a fresh private mode-0700 system temp directory,
   detached and without a checkout, gets the new file's exact bytes through
   `hash-object --no-filters` and `update-index`, so line-ending conversion,
   clean filters and LFS cannot alter the rest of the file. It commits with
   `core.hooksPath=/dev/null`, checks the commit changes only `AGENTS.md`, and
   pushes the branch, never forced. A lost push reply is accepted only if
   origin holds that exact commit. The PR body also lives in the private directory.
7. `gh pr create` with a body listing the changes and the reason, ending with
   the generated-by line. The worktree is removed in every case.

The user's checkout (its branch, index, working tree and stash) is never
touched; only `origin/<base>` is fetched and the shared object store gains
the new objects. Nothing merges.

**The section.** `mergeOrkestratorSection` copies everything outside the
section byte for byte (CRLF kept, a byte-order mark kept, invalid UTF-8
refused). A missing section is created at the end of the file, opening with a
note that it holds coordinator-approved operating decisions every agent must
follow; a missing file is created with just the section. Entries are compared
ignoring case, spacing and a final full stop, stay de-duplicated (existing
duplicates collapse to the first when the section changes), keep their order,
and new ones go after the last entry. ATX and Setext level-one and level-two
headings end the section; a first-line BOM does not hide its heading. Headings
inside fenced code are not headings, and two `## Orkestrator` sections are
refused as ambiguous. Invisible Unicode format characters are refused in new
entries and ignored in comparison keys; compatibility normalization also
prevents visually equivalent block markers from bypassing validation.

**Durability.** The request (with the user's edited entries once approved)
is in the node action request store. An approval a backend restart
interrupted is run again after node links and portal storage start
(`resumeInterrupted`); with steps 2–5 above that finds the pull request or pushed branch the earlier run left
rather than opening a second. An unavailable target keeps the request approved
with the user's edits intact; reconnects and a 30-second reconciliation sweep
retry it. On another node the routed call is retried if its answer is lost (the node link times out after 60 seconds); each retry
joins the run still going there using the same routed request key. A successful
answer clears earlier unknown-outcome notices for that run. After five lost
answers the request ends `outcome-unknown`, naming the branch to check, with one
routed outcome record. Remote failures retain their error code and message.

## Tests that exist today

The async and read-only contracts are asserted at the layer that owns each
guarantee, not by one end-to-end scenario replayed per platform:

- coordinator presence and the turn-end edge:
  `native-agent-service-reconciliation.test.ts`
- one-wake invariant and crash recovery: `coordinator-service.test.ts`
- the workflow record limit (cleanup when full, protected records, batch
  removal, recent-request replay, the all-in-use refusal, the `workflowStore`
  state, released-node records, the shared request-alias lookup):
  `coordinator-workflow-retention.test.ts`; its banner:
  `CoordinatorWorkflowStoreBanner.test.tsx`; the `send_message` warning:
  `coordinator-worker-mail.test.ts`, `control-mcp-server-messaging.test.ts`
- work on a forgotten, handed-over, unregistered or long-unreachable node:
  `coordinator-node-release.test.ts`; the release hooks:
  `nodes/node-service.test.ts`, `nodes/node-handover.test.ts`
- status wakes (ownership, one wake per settled transition per resource kind,
  coalescing, budgets, restart, bounds): `coordinator-status-wakes.test.ts`;
  graph runs: `graph-run-coordinator-status.test.ts`,
  `coordinator-status-wakes-graph.test.ts`; feature plans and kinds a reader
  does not know: `coordinator-status-wakes-feature-plan.test.ts`,
  `control-mcp-feature-plan-workflows.test.ts`; pull requests (the reducer and
  environment PR fields: `coordinator-pr-status.test.ts`; follows, Resolve
  tabs, review handoff: `coordinator-status-wakes-pr.test.ts`; a remote
  worker's Resolve tab and follow: `coordinator-pr-remote.test.ts`)
- the workers' prompts banner, local and remote, and Open from it
  (`CoordinatorPanel.test.tsx`, `CoordinatorPanel.render-cost.test.tsx`);
  `workerTabTarget` (`apps/web/src/lib/coordinator-work-items.test.ts`); Open
  navigation (`coordinator-work-navigation.test.ts`); `graph_run_get` as a
  routed read (`packages/protocol/src/command-nodes.test.ts`)
- `create_pr` and `resolve_conflicts` admission, preconditions and follows:
  `coordinator-surface-actions.test.ts`
- `restart_build_pipeline_step`: step resolution, kept rounds, selection and
  refusals at the service (`build-pipeline-service-coordinator-restart.test.ts`);
  local and remote restarts, receipts and replays, the older-node refusal,
  follow reopening and the `resume_build_pipeline` refusal
  (`coordinator-pipeline-step-actions.test.ts`)
- saved graphs: the four tools and no authoring tool, admission before
  launch, refusal codes, project scoping and scheduling
  (`control-mcp-graph-tools.test.ts`); no describe or authoring tool for a
  coordinator, the operator profile or a public action
  (`graph-describe-coordinator.test.ts`)
- single-turn mail batching: `agent-mail-service.test.ts`
- build pipeline worker mailboxes (one per worker and per parallel reviewer,
  discovery, delivery at turn end, `deliverNow`, the environment-only and
  ended-worker refusals, expiry and its notice, worker replies, leaf-side node
  delivery, transcripts, result-key identity, restart):
  `pipeline-worker-mail.test.ts`; the coordinator tools for them, here and on a
  leaf: `control-mcp-pipeline-workers.test.ts`; worker derivation and carrier
  framing: `packages/protocol/src/pipeline-worker-mail.test.ts`; each worker's
  own mail identity (result server, OpenCode broker, and the environment-wide
  connection with `mailCapability`: send, reply, ack, forged, foreign and
  ended-worker refusals, restart): `agent-tools-pipeline-worker-mail.test.ts`;
  stage turns carrying it (`build-pipeline-worker-mail.test.ts`), each
  reviewer and the consolidation (`build-pipeline-review-fanout-worker-mail.test.ts`)
  and OpenCode's system field (`opencode-provider-dispatch.test.ts`)
- tool contract and poll guard: `control-mcp-server-reads.test.ts` and
  `control-mcp-server-messaging.test.ts`
- the answer relay: questions only, the proposal checked and stored, stale and
  malformed answers never sent, end to end on this node
  (`worker-question-relay.test.ts`) and on a connected node
  (`worker-question-relay-remote.test.ts`), the approval executor
  (`node-worker-answer.test.ts`), and the approval dialog
  (`WorkerQuestionApprovalDialog.test.tsx`)
- project-home messages: a reason required, held outside the 3-hour window,
  approve, decline, replay, the window opened only by sent mail, and ordinary
  workers unchanged (`coordinator-worker-mail.test.ts`); the tool result
  shapes (`control-mcp-server-messaging.test.ts`); the dialog
  (`node-action-requests.test.tsx`)
- no-waiting-tools boundary, tier table, hosted network tools removed on
  every platform, and search without fetch when research is on:
  `coordinator-conformance.test.ts`
- hosted web search against the real pinned Codex, read from the model request
  on a loopback endpoint (gated on `RUN_LIVE_CODEX_APP_SERVER=1`), plus a
  canary that proves `cached` refuses a fresh page `live` opens and that a
  research server is callable (`RUN_LIVE_CODEX_WEB_SEARCH_CANARY=1`):
  `live-network-lock.test.ts`
- per-bridge activity and policy tests already cover whether a bridge reports
  `idle` at turn end and how it translates `capabilityPolicy`
- the Claude coordinator sandbox against the pinned CLI with a scripted local
  model: the default sandbox writes the working directory, the coordinator
  sandbox refuses it and still reads, and the hook refuses `uniq in out`:
  `conformance-coordinator-sandbox-live.test.ts` (claude-bridge)
- research servers on the pinned OpenCode, with a real `opencode serve` and a
  local MCP server: `opencode-coordinator-research-live.test.ts`
- a coordinator on the OpenCode 2 preview, against the pinned 2.x binary with a
  scripted model (`RUN_LIVE_OPENCODE2=1`): no write, command or data-directory
  read, control and research tools reached, a widened session refused by the
  server's guard and restated, project configuration off:
  `opencode2-coordinator.live.test.ts`; the guard's source in
  `coordinator-plugin.test.ts`, the rules, launch and routing in
  `coordinator.test.ts`, `opencode2-host-server.test.ts` and
  `native-agent-opencode-protocol.test.ts`
- coordinator skills on Codex against the real pinned app-server with a
  loopback model (`RUN_LIVE_CODEX_APP_SERVER=1`): `live-coordinator-skills.test.ts`
  (codex-bridge); the extra roots, read grants and project-skill rule in
  `codex-config.test.ts`, `app-server-engine.test.ts` and
  `app-server-runtime-prompt.test.ts`; Pi's loader against the real SDK
  (`coordinator-skills.test.ts`, pi-bridge); Cursor's hosted skill tool
  (`coordinator-skills.test.ts`, `agent-session.test.ts`, cursor-bridge)
- coordinator skills: the mirror and its frontmatter allowlist
  (`coordinator-skills.test.ts`), the options a coordinator, a worker and a
  worker's read-only review pass and the launch conflict a changed skill set
  causes (`session-manager-coordinator-skills.test.ts`), the hook refusing
  granted tools and skill scripts (`read-only-policy.test.ts`), all in
  claude-bridge; the launcher naming the account's skills directory
  (`agent-accounts-active.test.ts`, `commands-servers-coordinator.test.ts`)

- the same contracts against real providers: `mise run
  test:agent:coordinator` runs its scenarios per platform in a disposable
  profile. `read-only` attempts every class of mutation and checks that the
  checkout digest is unchanged and that read and discovery tools still answer.
  `async` launches real workers and checks the async launch result, that a
  queued prompt runs before pending worker mail, one carrier per delegation, one
  notice for a silent worker and the poll guard. `family` runs a two-worker
  exchange of sixteen messages, including a follow-up to a busy worker, with
  nobody answering anything. `status` checks that a coordinator-launched
  Multi Review wakes it once when ready and once when its Address Findings turn finishes
  (with `address_multi_review` in between), and that a delegated worker held
  on an approval wakes it once after the 20-second debounce. `peer` has two
  ordinary environments exchange ten messages with Wake peers on and no
  coordinator involved. `goal` has a coordinator set a worker a two-turn goal with a
  claim, then checks one wake and its read of the result. Every scenario with mail also runs the renderer's
  carrier parser over each echoed carrier row and requires one toned tile per
  delivered message and no raw carrier text. It is opt-in
  and never runs in `mise run test` or CI. See "Live coordinator suite" in
  [`agent-testing.md`](../development/agent-testing.md).
- AGENTS.md decisions: parsing, merging, injection and the diff
  (`agents-md-orkestrator.test.ts`, protocol); the pull request against a real
  local `origin` with a fake `gh`, including a fresh base, a missing section
  or file, retries, a restart after the push, upstream conflicts, missing
  `gh` sign-in, hooks and line-ending filters (`agents-md-pr.test.ts`); main
  versus side, validation and replay (`agents-md-commands.test.ts`); approval,
  decline, remote routing and restart (`node-coordination-agents-md.test.ts`);
  the dialog (`AgentsMdApprovalDialog.test.tsx`, web, and
  `e2e/AgentsMdApproval.spec.ts` in a real browser)
- worker surfaces (terminal, browser, tab edits, feature plans, custom fix, reviewer tabs, the root-changes request and receipts):
  `coordinator-surface-actions.test.ts`; the patch and the untouched
  checkout against real Git repositories: `root-changes.test.ts`; the
  approval dialog: `node-action-requests.test.tsx` (web); scope forwarding
  and side agents: `control-mcp-server-coordinator-workflows.test.ts`
- `get_worker_changes` bounds, paging, path filters, uncommitted marks and
  diff rendering over fake `changes_*` answers:
  `coordinator-worker-changes.test.ts`; `fork_worker`'s base, association,
  delegation, receipt replay, pipeline unlinking and project-home refusal
  against a real Git checkout: `coordinator-fork-worker.test.ts` (slow tier)
- worker turns (`stop_worker_turn`, `list_worker_commands`,
  `run_worker_command`) over the real registry, native-agent service and
  delegations: the stopped run settling as cancelled, the one stop-aware wake,
  a later prompt not refused, idle and terminal tabs, the project home,
  `session.command`'s refusals and side agents (`coordinator-worker-turns.test.ts`);
  on a connected node, with lost answers (`coordinator-worker-turns-remote.test.ts`)

- worker goals: the tools, the schema limit pinned to the constant, refusals for
  tabs the coordinator does not own, replay and framing:
  `control-mcp-coordinator-goals.test.ts`; many iterations, one wake, for each way a
  goal stops, and the sweep's hold: `coordinator-goal-wake.test.ts`
- an OpenCode coordinator keeps its scoped Control MCP credential on its server
  through every later reconcile, and does not start until it is connected:
  `commands-servers-coordinator-opencode.test.ts`

The runs that qualify each platform, and the scenarios still to add, are in
[0024-coordinator-live-conformance.md](../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md).

### Build admission provenance

A coordinator's pipeline reservation ID is persisted as `coordinatorLaunchId`
on the pipeline at initial admission, through a backend-only start argument.
Admission reuse preserves the original identity. A new-environment coordinator
launch refuses an admission belonging to another caller and grants no workflow
or environment authority. Completion and delayed provisioning repair require
that identity to match the reservation; requesting a new environment alone is
not evidence of creation. Leaves must advertise `node-coordinator-build-origin` before a new-environment
start is sent. Missing capability refuses before launch; missing or mismatched
identity in a response also fails closed.

Background workflow reconciliation also records late creation or settles missing
and terminal pipelines, even after a status notice was delivered. Remote
receipt repair checks at most 16 cooled-down records per origin check,
rotating oldest checks first with a 60-second cooldown. Explicit project opt-in
skips repair. Confirmed missing or terminal pipelines without an environment,
and foreign admissions, receive `environmentCreationSettledAt`; they stop being
polled and can be reclaimed after the 24-hour replay window. Transport errors
remain unresolved. Existing creation receipts remain immediately authoritative.

## Conversation Actions panel

Coordinator conversations (including side conversations) show an Actions panel
in the pane's existing floating-notice stack. It shares the mail banner's gutter
measurement: with at least 14rem beside the 56rem transcript column it docks
there, below the notices; otherwise it folds to an icon with a waiting count.

The panel's header ("Actions", the waiting count and a minimise mark) is a
button labelled "Collapse actions" with `aria-expanded`. Clicking it, or Enter
or Space on it, folds the panel into the icon at the same top-right position,
and focus moves to the icon.

- **Wide panes (docked).** The panel is sticky. Folded, it stays folded until
  the icon is clicked (hover and focus do not open it); open, it stays open
  through clicks elsewhere, card clicks, pointer leave, focus leave and Escape,
  until its header is clicked again. Opening from the icon moves focus to the
  header. The choice is a local UI preference
  (`coordinator-actions-preference.ts`, localStorage key
  `orkestrator.coordinator-actions.docked`), shared by every coordinator
  conversation and every window of the origin; other windows follow it through
  the `storage` event. It is open by default.
- **Narrow panes (overlay).** Hover or keyboard focus opens the overlay, a
  160ms grace period allows pointer travel, and leaving both pointer and focus
  closes it. Escape closes it immediately; touch clicks toggle it. A click or
  tap outside the overlay and its icon closes it at once, and so does its
  header. The overlay's open state is transient and never touches the
  preference.
- **Resizing.** Crossing the breakpoint starts each mode in its own state:
  going narrow shows the folded icon, and going wide restores the remembered
  docked choice rather than carrying over the overlay's open state.

Showing and hiding animate a short contraction toward the icon; reduced motion
shows and hides without a transition in both modes.

The panel never scrolls. It shows only the newest whole cards (at most ten)
that fit between its top and the pane's bottom margin, dropping the oldest
first; no card is cut part-way. The floating-notice layer passes its measured
available height to the panel (`FloatingNoticeSlot`'s `heightPx`). Each change
of cards, width, available height or the panel's position in the stack (a
notice above it appearing or resizing) renders every card once, measures it
and hides the oldest that do not fit, before the browser paints. Scroll sync
still decides which cards are eligible; the height fit then trims that set.
The header and its waiting count always show, and the count includes cards
trimmed for height.

Cards represent structured PR status notices, question tools and asynchronous
questions, and explicit topic/question marks. Merged or closed PRs and answered
questions retain their original card and show a muted tick. Topics do not count
as waiting. A PR's later notices revise its original card rather than moving it.
PR notices carry bounded URL, number and title metadata, preserved by mail
normalization and transcript carriers. Status wakes use the host's existing
conditional GitHub reader, including for remote workers; watched notices use
their existing status reading. Cards show `#number title`, accept later title
improvements and keep the last known title when a terminal notice omits it.
If GitHub metadata is unavailable, the URL still supplies the PR number.

The coordinator tools `mark_topic { title }` and `mark_question { title }` return
a versioned mark, saved with the successful tool call in the provider's
conversation rollout. Titles are bounded to 120 characters. Per-turn guidance
asks for at most one topic mark per user message, only for a new subject.
Transcript replay derives topic anchors from the preceding actual user message
and question anchors from the message holding the tool call; mail and automatic
prompts do not start user subjects. The next actual user message handles a
marked plain-text question. No additional model call or renderer persistence
store is used for cards; the only renderer persistence is the docked panel's
open or folded preference above.

The panel replays historical action evidence together with the loaded transcript in order, then shows the newest ten
cards whose anchor is at or above the viewport bottom. The virtual list measures
visible rows on scroll and row resizing, excluding its render overscan. Cards navigate through
the node-qualified conversation scroll target, loading history pages while an
anchor is missing and briefly highlighting the destination. The existing target
expiry bounds missing-anchor recovery. All reads and targets follow the
conversation's node scope; worker tabs do not enable the panel.

Coordinator tabs independently scan history pages on mount to recover action
metadata beyond the rendered window, including after reload or in another client.
The scan strips prose and unrelated tool outputs, reads one byte-bounded page at
a time, and refuses changed epochs, incomplete history, repeated cursors or more
than 10,000 pages / 8 MiB of evidence. Unavailable history leaves live cards usable;
providers must expose complete history for complete historical recovery. The scan
is cancelled on session replacement/unmount and never expands the renderer's
retained message budget. Live structured question interactions join replayed
question tools by request ID; terminal interactions and deleted PRs are done.
Only bare native tool names and explicit Orkestrator server prefixes create marks.
Workflow-to-PR replay reconciles the structured PR URL or, for
older notices, the PR URL carried by status notice bodies; older URL-free notices fall back to a node-qualified environment identity.
Publication-started and publication-failed notices do not create PR cards.
